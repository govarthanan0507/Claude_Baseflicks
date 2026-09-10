"use strict";

const fs = require("fs");
const ffmpeg = require("./ffmpeg");

/*
    ============================================================
    STRUCTURED MEDIA CAPABILITY PROBE
    ============================================================

    Given a media file, produce a reliable, stable description of its
    container and of EVERY video / audio / subtitle stream it holds --
    the input a future playback decision engine needs in order to
    reason about Direct Play / Remux / Transcode.

    This is NOT the decision engine. It makes no playability judgement
    and does not touch checkPlayability(), the scanner, the database,
    the routes, or metadata.

    Design points:
      - Built on ffmpeg.probeRaw() (the existing ffprobe boundary);
        no new dependency, no second ffprobe invocation style.
      - describeMedia() owns the filesystem + subprocess side and the
        failure handling; normalizeProbe() is a pure function over a
        raw ffprobe document so it is fully unit-testable with
        fixtures.
      - The raw ffprobe JSON never leaves this module -- callers only
        ever see the normalized shape below, so ffprobe's field names
        are not an application contract.

    Result shape
    ------------
    Success:
      {
        ok: true,
        file:      { path, size },
        container: { format, duration, bitrate },
        video: [
          { index, codec, profile, width, height,
            frameRate, pixelFormat, bitrate }
        ],
        audio: [
          { index, codec, channels, sampleRate, bitrate, language }
        ],
        subtitles: [
          { index, codec, language, type }   // type: "text" | "image" | null
        ]
      }

    Failure:
      { ok: false, error: "not_found" | "probe_failed",
        file: { path, size: <number|null> } }

    Every numeric field is a real Number or null (never a string,
    never NaN). Every string field is a non-empty string or null.
    video / audio / subtitles are always arrays (possibly empty --
    e.g. an audio-only file has video: []).
*/


// ---- numeric / string normalizers -------------------------------

// ffprobe reports most numbers as strings ("48000", "8000000",
// "1.416000") and absent values as the literal "N/A" or by omission.
function toNumberOrNull(value) {

    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    const text = String(value).trim();

    if (text === "" || text.toLowerCase() === "n/a") {
        return null;
    }

    const parsed = Number(text);

    return Number.isFinite(parsed) ? parsed : null;

}

function toIntOrNull(value) {

    const parsed = toNumberOrNull(value);

    return parsed === null ? null : Math.trunc(parsed);

}

// Frame rate arrives as a rational string ("24000/1001", "30/1",
// or "0/0" meaning unknown). Return frames-per-second to 3 dp.
function parseFrameRate(value) {

    if (typeof value !== "string") {
        return toNumberOrNull(value);
    }

    const fraction =
        value.trim().match(/^(\d+)\s*\/\s*(\d+)$/);

    if (fraction) {

        const numerator = Number(fraction[1]);
        const denominator = Number(fraction[2]);

        if (denominator === 0) {
            return null;
        }

        return Math.round((numerator / denominator) * 1000) / 1000;

    }

    return toNumberOrNull(value);

}

function nonEmptyStringOrNull(value) {

    if (typeof value !== "string") {
        return null;
    }

    const text = value.trim();

    return text.length > 0 ? text : null;

}

function streamTags(stream) {
    return (stream && stream.tags && typeof stream.tags === "object")
        ? stream.tags
        : {};
}

function streamLanguage(stream) {

    const tags = streamTags(stream);

    return (
        nonEmptyStringOrNull(tags.language) ||
        nonEmptyStringOrNull(tags.LANGUAGE) ||
        nonEmptyStringOrNull(tags.lang) ||
        null
    );

}

// The human-facing track name, if the muxer stored one.
function streamTitle(stream) {

    const tags = streamTags(stream);

    return (
        nonEmptyStringOrNull(tags.title) ||
        nonEmptyStringOrNull(tags.TITLE) ||
        nonEmptyStringOrNull(tags.handler_name) ||
        null
    );

}

// ffprobe -show_streams reports { disposition: { default: 0|1,
// forced: 0|1, ... } }. Return a strict boolean; absent -> false.
function streamDisposition(stream, key) {

    const disposition =
        (stream && stream.disposition && typeof stream.disposition === "object")
            ? stream.disposition
            : {};

    return disposition[key] === 1 || disposition[key] === true;

}

// Rough text-vs-bitmap classification for subtitle codecs -- enough
// for the decision engine to know whether a sub can be passed through
// as text or has to be burned in / converted.
const IMAGE_SUBTITLE_CODECS = new Set([
    "dvd_subtitle",
    "hdmv_pgs_subtitle",
    "dvb_subtitle",
    "dvb_teletext",
    "xsub"
]);

function subtitleType(codecName) {

    if (!codecName) {
        return null;
    }

    return IMAGE_SUBTITLE_CODECS.has(codecName) ? "image" : "text";

}


// ---- per-stream mappers ----------------------------------------

function mapVideoStream(stream) {

    // Prefer avg_frame_rate; fall back to r_frame_rate. "0/0" on
    // avg means ffprobe could not average it.
    const rateSource =
        (typeof stream.avg_frame_rate === "string" &&
            stream.avg_frame_rate !== "0/0")
            ? stream.avg_frame_rate
            : stream.r_frame_rate;

    return {
        index: toIntOrNull(stream.index),
        codec: nonEmptyStringOrNull(stream.codec_name),
        profile: nonEmptyStringOrNull(stream.profile),
        width: toIntOrNull(stream.width),
        height: toIntOrNull(stream.height),
        frameRate: parseFrameRate(rateSource),
        pixelFormat: nonEmptyStringOrNull(stream.pix_fmt),
        bitrate: toIntOrNull(stream.bit_rate)
    };

}

function mapAudioStream(stream) {

    return {
        index: toIntOrNull(stream.index),
        codec: nonEmptyStringOrNull(stream.codec_name),
        channels: toIntOrNull(stream.channels),
        sampleRate: toIntOrNull(stream.sample_rate),
        bitrate: toIntOrNull(stream.bit_rate),
        language: streamLanguage(stream),
        title: streamTitle(stream),
        default: streamDisposition(stream, "default")
    };

}

function mapSubtitleStream(stream) {

    const codec =
        nonEmptyStringOrNull(stream.codec_name);

    return {
        index: toIntOrNull(stream.index),
        codec: codec,
        language: streamLanguage(stream),
        title: streamTitle(stream),
        default: streamDisposition(stream, "default"),
        forced: streamDisposition(stream, "forced"),
        type: subtitleType(codec)
    };

}


/*
    Pure: raw ffprobe document -> stable media description.
    No filesystem, no subprocess.
*/
function normalizeProbe(raw, fileInfo) {

    const file = {
        path: (fileInfo && fileInfo.path) || null,
        size:
            (fileInfo && typeof fileInfo.size === "number")
                ? fileInfo.size
                : null
    };

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "probe_failed", file };
    }

    const hasFormat =
        raw.format && typeof raw.format === "object" && !Array.isArray(raw.format);

    const hasStreams =
        Array.isArray(raw.streams);

    // A document with neither a format block nor a streams array is
    // not a usable ffprobe result (empty object, wrong JSON, etc).
    if (!hasFormat && !hasStreams) {
        return { ok: false, error: "probe_failed", file };
    }

    const format = hasFormat ? raw.format : {};

    const streams =
        (hasStreams ? raw.streams : [])
            .filter(stream => stream && typeof stream === "object");

    if (file.size === null) {
        file.size = toIntOrNull(format.size);
    }

    return {
        ok: true,
        file,
        container: {
            format: nonEmptyStringOrNull(format.format_name),
            duration: toNumberOrNull(format.duration),
            bitrate: toIntOrNull(format.bit_rate)
        },
        video: streams
            .filter(stream => stream.codec_type === "video")
            .map(mapVideoStream),
        audio: streams
            .filter(stream => stream.codec_type === "audio")
            .map(mapAudioStream),
        subtitles: streams
            .filter(stream => stream.codec_type === "subtitle")
            .map(mapSubtitleStream)
    };

}


/*
    Probe a media file and return its structured description.

    options.probe -- override the ffprobe call (tests pass fixtures).
                     Must return the raw ffprobe JSON document, or
                     null. May be sync or async; a throw is treated
                     as a probe failure.
*/
async function describeMedia(filePath, options) {

    options = options || {};

    const probe =
        typeof options.probe === "function"
            ? options.probe
            : ffmpeg.probeRaw;

    // ---- missing / not a regular file ----
    let size;

    try {

        const stat = fs.statSync(filePath);

        if (!stat.isFile()) {
            return {
                ok: false,
                error: "not_found",
                file: { path: filePath, size: null }
            };
        }

        size = stat.size;

    }
    catch (error) {
        return {
            ok: false,
            error: "not_found",
            file: { path: filePath, size: null }
        };
    }

    // ---- ffprobe failure / malformed output ----
    let raw;

    try {
        raw = await probe(filePath);
    }
    catch (error) {
        raw = null;
    }

    if (raw === null || raw === undefined) {
        return {
            ok: false,
            error: "probe_failed",
            file: { path: filePath, size: size }
        };
    }

    return normalizeProbe(raw, { path: filePath, size: size });

}


module.exports = {
    describeMedia,
    normalizeProbe
};
