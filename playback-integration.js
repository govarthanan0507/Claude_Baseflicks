"use strict";

const fs = require("fs");
const path = require("path");

const { describeMedia } = require("./media-probe");
const { decidePlayback, MODES } = require("./playback-decision");

/*
    ============================================================
    PLAYBACK DECISION INTEGRATION BOUNDARY  (Task 7)
    ============================================================

        media file
           -> media probe            (media-probe.js, Task 4)
           -> client capabilities    (client-capabilities.js, Task 5)
           -> decidePlayback()       (playback-decision.js, Task 6)
           -> playback decision      (this module hands it back)
           -> existing playback layer

    This module ONLY orchestrates that chain. It contains NO
    playback rules -- every judgement lives in playback-decision.js.
    server.js calls the two entry points below and never touches the
    decision logic itself.

    Task 7 deliberately does NOT act on the decision: the /video
    route still streams exactly as before. The decision is computed
    and surfaced (a response header / a diagnostic endpoint) so a
    later task can wire it into Remux / Transcode execution.

    --------------------------------------------------------------
    Two entry points, by cost:

    1. decideFromLibraryRow(row, clientCapabilities)
       Synchronous, NO ffprobe. Builds a *lightweight* probe from
       the columns the scanner already stored (codec / width /
       height / size), so it is cheap enough for the hot /video
       path. Missing fields (profile, level, frame rate, pixel
       format, container format string) are simply absent -- the
       decision engine treats absent capability inputs
       conservatively, and treats absent *media* detail as
       "not exotic / unconstrained".

    2. probeAndDecide(filePath, clientCapabilities, options)
       Async, runs a FULL ffprobe via media-probe.describeMedia().
       For the diagnostic endpoint where the extra latency is fine.
       options.describe overrides describeMedia() (tests).
*/


// ---- client capability intake ------------------------------

/*
    Pull client-reported capabilities off a request without ever
    throwing. Accepts:
      - header  X-Baseflix-Client-Capabilities : <JSON> or <base64 JSON>
      - query   ?caps=<JSON or base64 JSON>
    Anything missing / unparsable / not an object -> undefined, which
    the decision engine normalises to an all-"unknown" (conservative)
    client.
*/
function readClientCapabilities(req) {

    if (!req || typeof req !== "object") {
        return undefined;
    }

    const headers = req.headers || {};
    const query = req.query || {};

    let raw =
        headers["x-baseflix-client-capabilities"] ||
        query.caps;

    if (Array.isArray(raw)) {
        raw = raw[0];
    }

    if (typeof raw !== "string" || raw.length === 0 || raw.length > 20000) {
        return undefined;
    }

    let text = raw.trim();

    // If it does not already look like JSON, try base64 first.
    if (text[0] !== "{" && text[0] !== "[") {
        try {
            text = Buffer.from(raw, "base64").toString("utf8").trim();
        } catch (error) {
            return undefined;
        }
    }

    try {
        const parsed = JSON.parse(text);
        return (parsed !== null && typeof parsed === "object") ? parsed : undefined;
    } catch (error) {
        return undefined;
    }
}


// ---- lightweight probe from stored scanner columns ---------

/*
    row: the videos-table row the /video route already loads
         { video_codec, audio_codec, width, height, size, ... }
    filePath: the CONTAINED absolute path (its extension is how the
              decision engine identifies the container).

    Returns a media-probe-shaped object. `ok` is true whenever we
    have at least a codec to reason about; otherwise false so the
    engine falls back conservatively.
*/
function buildLightweightProbe(filePath, row) {

    const safeRow = (row && typeof row === "object") ? row : {};

    const videoCodec =
        typeof safeRow.video_codec === "string" && safeRow.video_codec
            ? safeRow.video_codec
            : null;

    const audioCodec =
        typeof safeRow.audio_codec === "string" && safeRow.audio_codec
            ? safeRow.audio_codec
            : null;

    const toNum = function (value) {
        return typeof value === "number" && Number.isFinite(value) ? value : null;
    };

    const video = videoCodec ? [{
        index: 0,
        codec: videoCodec,
        profile: null,          // not stored by the scanner
        width: toNum(safeRow.width),
        height: toNum(safeRow.height),
        frameRate: null,
        pixelFormat: null,
        bitrate: null
    }] : [];

    const audio = audioCodec ? [{
        index: video.length,
        codec: audioCodec,
        channels: null,
        sampleRate: null,
        bitrate: null,
        language: null
    }] : [];

    return {
        ok: video.length > 0 || audio.length > 0,
        degraded: true,          // signals "no profile/level/fps detail"
        file: {
            path: typeof filePath === "string" ? filePath : null,
            size: toNum(safeRow.size)
        },
        container: { format: null, duration: null, bitrate: null },
        video: video,
        audio: audio,
        subtitles: []
    };
}


// ---- entry points -----------------------------------------

function decideFromLibraryRow(filePath, row, clientCapabilities) {

    const probe = buildLightweightProbe(filePath, row);
    const decision = decidePlayback(probe, clientCapabilities);

    return decision;
}

async function probeAndDecide(filePath, clientCapabilities, options) {

    options = options || {};

    const describe =
        typeof options.describe === "function" ? options.describe : describeMedia;

    const probe = await describe(filePath);
    const decision = decidePlayback(probe, clientCapabilities);

    return { probe: probe, decision: decision };
}


// ---- Direct Play execution gate (Task 8) -------------------

/*
    Small bounded, TTL'd, in-memory cache so a viewing session's many
    Range requests for the same file do not re-run ffprobe. This is a
    *decision* cache, not the transcoding cache -- it holds only the
    resolved playback mode string.
*/
const DECISION_CACHE = new Map();
const DECISION_CACHE_MAX = 500;
const DECISION_CACHE_TTL_MS = 5 * 60 * 1000;

function decisionCacheGet(key) {
    const entry = DECISION_CACHE.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
        DECISION_CACHE.delete(key);
        return null;
    }
    return entry.value;
}

function decisionCacheSet(key, value) {
    if (DECISION_CACHE.size >= DECISION_CACHE_MAX) {
        DECISION_CACHE.delete(DECISION_CACHE.keys().next().value);
    }
    DECISION_CACHE.set(key, { value: value, expires: Date.now() + DECISION_CACHE_TTL_MS });
}

function stableCapabilityKey(clientCapabilities) {
    try {
        return JSON.stringify(clientCapabilities) || "none";
    } catch (error) {
        return "unserialisable";
    }
}


// ---- audio / subtitle track selection (Task 13) -------------

/*
    Pull a track selection off a request WITHOUT ever throwing. It is
    read from the query string of a <video src> URL:
      ?audio=<stream index>
      ?subtitle=<stream index> | off | none | disabled
    Anything missing / non-integer / out of shape -> null (meaning
    "use the default"). subtitle "off" is a distinct, explicit value.

    Returns { audio: <number|null>, subtitle: <number|"off"|null> }.
*/
function readStreamSelection(req) {

    const query = (req && req.query && typeof req.query === "object") ? req.query : {};

    const toIndex = (raw) => {
        if (Array.isArray(raw)) raw = raw[0];
        if (typeof raw !== "string" || raw.trim() === "") return null;
        const n = Number(raw);
        return (Number.isInteger(n) && n >= 0) ? n : null;
    };

    let subtitleRaw = query.subtitle;
    if (Array.isArray(subtitleRaw)) subtitleRaw = subtitleRaw[0];

    let subtitle = null;
    if (typeof subtitleRaw === "string") {
        const token = subtitleRaw.trim().toLowerCase();
        if (token === "off" || token === "none" || token === "disabled") {
            subtitle = "off";
        } else {
            subtitle = toIndex(subtitleRaw);
        }
    }

    return { audio: toIndex(query.audio), subtitle: subtitle };
}

function hasExplicitSelection(selection) {
    return !!selection && (
        typeof selection.audio === "number" ||
        selection.subtitle === "off" ||
        typeof selection.subtitle === "number"
    );
}

/*
    Given a full probe (media-probe describeMedia() output) and a
    selection, work out which streams the playback pipeline should
    actually use. NEVER assumes audio:0 -- when nothing is selected it
    honours the `default` disposition, then the first audio stream.
    Subtitles stay OFF unless one is explicitly selected or a `forced`
    subtitle exists (conservative).

    Safe with: no audio, many audio, no subtitles, many subtitles,
    missing language, and incomplete stream metadata.
*/
function resolveSelectedStreams(probe, selection) {

    selection = selection || {};

    const audioStreams =
        (probe && Array.isArray(probe.audio)) ? probe.audio.filter(s => s && typeof s === "object") : [];
    const subtitleStreams =
        (probe && Array.isArray(probe.subtitles)) ? probe.subtitles.filter(s => s && typeof s === "object") : [];

    // ---- audio ----
    let audioStream = null;
    let audioReason = "none";

    if (audioStreams.length > 0) {
        if (typeof selection.audio === "number") {
            audioStream = audioStreams.find(s => s.index === selection.audio) || null;
            audioReason = audioStream ? "selected" : "selected-missing";
        }
        if (!audioStream) {
            audioStream =
                audioStreams.find(s => s.default === true) ||
                audioStreams[0];
            audioReason = (audioReason === "selected-missing") ? "fallback-default" : "default";
        }
    }

    // ---- subtitle ----
    let subtitleStream = null;
    let subtitleReason = "off";

    if (selection.subtitle === "off") {
        subtitleReason = "off";
    } else if (subtitleStreams.length > 0) {
        if (typeof selection.subtitle === "number") {
            subtitleStream = subtitleStreams.find(s => s.index === selection.subtitle) || null;
            // an invalid explicit index -> stay off (conservative)
            subtitleReason = subtitleStream ? "selected" : "off";
        } else {
            subtitleStream = subtitleStreams.find(s => s.forced === true) || null;
            subtitleReason = subtitleStream ? "forced" : "off";
        }
    }

    return {
        audioStream: audioStream,
        audioStreamIndex: audioStream ? audioStream.index : null,
        audioReason: audioReason,
        subtitleStream: subtitleStream,
        subtitleStreamIndex: subtitleStream ? subtitleStream.index : null,
        subtitleReason: subtitleReason,
        audioTracks: audioStreams,
        subtitleTracks: subtitleStreams
    };
}

/*
    Decide how the /video route should serve a file.

    Returns { mode, basis } where basis is:
      "lightweight" -> decided from the scanner columns only (no ffprobe)
      "full-probe"  -> a DIRECT_PLAY candidate for a file the scanner
                       had flagged for transcode was re-checked against
                       a real ffprobe before being trusted
      "fallback"    -> the decision could not be computed; caller must
                       use its existing behaviour

    Conservative rule (Task 6) is preserved end to end:
      * missing / unknown capabilities never yield DIRECT_PLAY
      * a DIRECT_PLAY from the DEGRADED lightweight probe is only
        trusted directly for files the scanner already vetted as
        browser-mainstream (needs_transcode !== 1). For a file the old
        whitelist rejected, DIRECT_PLAY must survive a full ffprobe
        (which can see profile / bit depth / pixel format) or it is
        downgraded and the caller falls back.

    options.describe overrides describeMedia() (tests).
    options.now overrides Date.now for cache tests.
*/
async function resolvePlaybackMode(params, options) {

    params = params || {};
    options = options || {};

    const filePath = params.filePath;
    const row = params.row || null;
    const needsTranscode = params.needsTranscode === true;
    const clientCapabilities = params.clientCapabilities;
    const selection = params.selection || null;

    // ---- explicit audio / subtitle selection (Task 13) ----
    // When the request asks for a specific track we need REAL per-stream
    // information, so we take the full probe here and re-run the Task 6
    // decision over a probe whose primary audio stream IS the selected
    // one. Task 6 stays the sole decision authority -- it just sees the
    // media as the user asked to play it. No selection -> unchanged.
    if (hasExplicitSelection(selection)) {

        // A viewing session issues many Range requests for the same
        // URL; cache the resolved selection so ffprobe runs once. Keyed
        // on file + mtime + capabilities + the exact selection.
        let selMtime = 0;
        try { selMtime = fs.statSync(filePath).mtimeMs; } catch (error) { selMtime = 0; }

        const selKey =
            "sel | " + filePath + " | " + selMtime + " | " +
            stableCapabilityKey(clientCapabilities) + " | " +
            JSON.stringify({ a: selection.audio, s: selection.subtitle });

        const selCached = selMtime ? decisionCacheGet(selKey) : null;
        if (selCached) {
            return Object.assign({ cached: true }, selCached);
        }

        let probe;
        try {
            const describe =
                typeof options.describe === "function" ? options.describe : describeMedia;
            probe = await describe(filePath);
        } catch (error) {
            return { mode: null, basis: "fallback", error: error.message };
        }

        if (!probe || probe.ok !== true) {
            // Cannot see the streams -> ignore the selection, fall back
            // to the ordinary (lightweight) path below.
        } else {

            const chosen = resolveSelectedStreams(probe, selection);

            // Re-order so decidePlayback's "primary audio" is the
            // selected stream.
            const orderedAudio = chosen.audioStream
                ? [chosen.audioStream].concat(
                    probe.audio.filter(s => s !== chosen.audioStream))
                : (Array.isArray(probe.audio) ? probe.audio : []);

            const view = Object.assign({}, probe, { audio: orderedAudio });
            const full = decidePlayback(view, clientCapabilities);
            const tp = transformParams(full);

            const result = {
                mode: full.mode,
                basis: "full-probe",
                target: tp.target,
                videoCodec: tp.videoCodec,
                audioCodec: tp.audioCodec,
                audioStreamIndex: chosen.audioStreamIndex,
                subtitleReason: chosen.subtitleReason,
                subtitleStreamIndex: chosen.subtitleStreamIndex,
                tracks: {
                    audio: chosen.audioTracks,
                    subtitles: chosen.subtitleTracks
                }
            };

            if (selMtime) {
                decisionCacheSet(selKey, result);
            }

            return result;
        }
    }

    let light;
    try {
        light = decideFromLibraryRow(filePath, row, clientCapabilities);
    } catch (error) {
        return { mode: null, basis: "fallback", error: error.message };
    }

    // ---- no-capability fast-path (Task 14 regression fix) ----
    // The scanner's own ffprobe-backed checkPlayability() has already
    // vetted this file's codecs as browser-mainstream (needs_transcode
    // === 0). When the caller supplies NO capability object at all
    // (clientCapabilities === undefined -- a genuinely absent header,
    // per readClientCapabilities()), the degraded library-row probe
    // carries no information that could legitimately override the
    // scanner's verdict, and the conservative engine would otherwise
    // fall all the way to VIDEO_TRANSCODE. That used to be a harmless
    // advisory string; since Task 12 wired an executor to it, it starts
    // a full FFmpeg re-encode of a natively-playable file and stalls
    // playback for ~45s. Route such a request straight to Direct Play,
    // exactly as the pre-playback-pipeline /video handler did.
    //
    // This is deliberately `=== undefined` (no object supplied), NOT a
    // general "falsy / unusable capabilities" test: a caller that hands
    // us an actual object -- even an empty or malformed one -- is left
    // on the conservative path unchanged.
    if (!needsTranscode && clientCapabilities === undefined) {
        return {
            mode: MODES.DIRECT_PLAY,
            basis: "lightweight",
            target: null,
            videoCodec: null,
            audioCodec: null
        };
    }

    if (light.mode !== MODES.DIRECT_PLAY) {
        return Object.assign(
            { mode: light.mode, basis: "lightweight", audioStreamIndex: null },
            transformParams(light)
        );
    }

    if (!needsTranscode) {
        // Scanner already confirmed browser-mainstream codecs; the
        // degraded probe is sufficient to route this to Direct Play.
        return { mode: MODES.DIRECT_PLAY, basis: "lightweight", target: null, videoCodec: null, audioCodec: null };
    }

    // DIRECT_PLAY for a file the OLD whitelist rejected -> confirm with
    // a real probe (cached) before the caller serves the original. The
    // caller already verified existence; a stat race here just skips
    // the cache (mtime 0) -- a failed probe below still falls back.
    let mtime = 0;
    try {
        mtime = fs.statSync(filePath).mtimeMs;
    } catch (error) {
        mtime = 0;
    }

    const cacheKey =
        filePath + " | " + mtime + " | " + stableCapabilityKey(clientCapabilities);

    const cached = decisionCacheGet(cacheKey);
    if (cached) {
        return {
            mode: cached.mode, basis: "full-probe",
            target: cached.target, videoCodec: cached.videoCodec,
            audioCodec: cached.audioCodec, cached: true
        };
    }

    let full;
    try {
        const describe =
            typeof options.describe === "function" ? options.describe : describeMedia;
        const probe = await describe(filePath);
        full = decidePlayback(probe, clientCapabilities);
    } catch (error) {
        // Could not verify -> do NOT claim Direct Play.
        return { mode: null, basis: "fallback", error: error.message };
    }

    const resolved = Object.assign({ mode: full.mode }, transformParams(full));
    decisionCacheSet(cacheKey, resolved);
    return {
        mode: resolved.mode, basis: "full-probe",
        target: resolved.target, videoCodec: resolved.videoCodec, audioCodec: resolved.audioCodec
    };
}

// The container + video/audio codec target the decision engine
// ALREADY chose for a transformation mode -- surfaced verbatim so the
// caller can hand them to the remux / audio-transcode / video-transcode
// executor WITHOUT re-deriving any capability logic.
function transformParams(decision) {
    if (!decision || typeof decision !== "object") {
        return { target: null, videoCodec: null, audioCodec: null };
    }
    if (decision.mode === MODES.REMUX && decision.remux) {
        return { target: decision.remux.target || null, videoCodec: null, audioCodec: null };
    }
    if (decision.mode === MODES.AUDIO_TRANSCODE && decision.audioTranscode) {
        return {
            target: decision.audioTranscode.target || null,
            videoCodec: null,
            audioCodec: decision.audioTranscode.audioCodec || null
        };
    }
    if (decision.mode === MODES.VIDEO_TRANSCODE && decision.videoTranscode) {
        return {
            target: decision.videoTranscode.target || null,
            videoCodec: decision.videoTranscode.videoCodec || null,
            audioCodec: decision.videoTranscode.audioCodec || null
        };
    }
    return { target: null, videoCodec: null, audioCodec: null };
}

function _clearDecisionCache() {
    DECISION_CACHE.clear();
}


// A compact, contract-stable view of a probe for API responses --
// never leak the raw media-probe object shape beyond what callers
// need, and never the ffprobe document.
function summarizeProbe(probe) {

    if (!probe || typeof probe !== "object" || probe.ok !== true) {
        return {
            ok: false,
            error: (probe && probe.error) || "probe_failed"
        };
    }

    return {
        ok: true,
        degraded: probe.degraded === true,
        container: probe.container ? probe.container.format : null,
        duration: probe.container ? probe.container.duration : null,
        videoStreams: Array.isArray(probe.video) ? probe.video.length : 0,
        audioStreams: Array.isArray(probe.audio) ? probe.audio.length : 0,
        subtitleStreams: Array.isArray(probe.subtitles) ? probe.subtitles.length : 0,
        video: Array.isArray(probe.video) ? probe.video.map(function (v) {
            return { index: v.index, codec: v.codec, width: v.width, height: v.height };
        }) : [],
        // Enough for a future player UI to render an "Audio Track" /
        // "Subtitle Track" / "Off" picker. Never the raw ffprobe shape.
        audio: Array.isArray(probe.audio) ? probe.audio.map(function (a) {
            return {
                index: a.index, codec: a.codec, channels: a.channels,
                sampleRate: a.sampleRate, bitrate: a.bitrate,
                language: a.language, title: a.title, default: a.default === true
            };
        }) : [],
        subtitles: Array.isArray(probe.subtitles) ? probe.subtitles.map(function (s) {
            return {
                index: s.index, codec: s.codec, language: s.language,
                title: s.title, type: s.type,
                default: s.default === true, forced: s.forced === true
            };
        }) : []
    };
}


module.exports = {
    MODES: MODES,
    readClientCapabilities: readClientCapabilities,
    readStreamSelection: readStreamSelection,
    resolveSelectedStreams: resolveSelectedStreams,
    buildLightweightProbe: buildLightweightProbe,
    decideFromLibraryRow: decideFromLibraryRow,
    probeAndDecide: probeAndDecide,
    resolvePlaybackMode: resolvePlaybackMode,
    summarizeProbe: summarizeProbe,
    _clearDecisionCache: _clearDecisionCache
};
