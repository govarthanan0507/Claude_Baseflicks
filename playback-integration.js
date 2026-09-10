"use strict";

const path = require("path");

const { describeMedia } = require("./media-probe");
const { decidePlayback } = require("./playback-decision");

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
        audio: Array.isArray(probe.audio) ? probe.audio.map(function (a) {
            return { index: a.index, codec: a.codec, channels: a.channels, language: a.language };
        }) : []
    };
}


module.exports = {
    readClientCapabilities: readClientCapabilities,
    buildLightweightProbe: buildLightweightProbe,
    decideFromLibraryRow: decideFromLibraryRow,
    probeAndDecide: probeAndDecide,
    summarizeProbe: summarizeProbe
};
