"use strict";

const path = require("path");

const {
    STATES,
    normalizeClientCapabilities,
    capabilityOf,
    canonicalFormat
} = require("./client-capabilities");

/*
    ============================================================
    CAPABILITY-BASED PLAYBACK DECISION ENGINE  (Task 6)
    ============================================================

    Pure. No filesystem, no ffmpeg, no network, no server coupling.
    Given:
      - media   : media-probe.js describeMedia() output (Task 4)
      - client  : client-capabilities.js model, OR any raw object
                  (it is normalised internally, so a malformed /
                  partial client model degrades to "unknown")
    it returns a deterministic decision:

        DIRECT_PLAY  ->  REMUX  ->  AUDIO_TRANSCODE  ->  VIDEO_TRANSCODE

    evaluated strictly in that order; the first mode that is
    `possible` wins. VIDEO_TRANSCODE is always possible (the
    universal fallback).

    --------------------------------------------------------------
    Conservative rule (non-negotiable)
    --------------------------------------------------------------
    A capability state of "unknown" is NEVER treated as support.
    DIRECT_PLAY / REMUX / AUDIO_TRANSCODE each require the relevant
    capability to be explicitly "supported". So:

        client.video.h264 = "unknown"
        media.video.codec = "h264"
        =>  NOT direct_play   (video codec support is unknown)

    --------------------------------------------------------------
    What each mode requires
    --------------------------------------------------------------
    DIRECT_PLAY      container "supported"
                     + (no video OR: video codec "supported",
                        not a high-bit-depth / non-4:2:0 config,
                        resolution within the client limit)
                     + (no audio OR: audio codec "supported")

    REMUX            container is NOT already direct-playable
                     + every stream can be COPIED as-is
                       (video "supported" + not exotic + within
                        resolution limit; audio "supported")
                     + there is a client-"supported" target
                       container (mp4/webm) that can carry those
                       exact codecs without re-encoding

    AUDIO_TRANSCODE  video can be COPIED (as REMUX)
                     + there is a client-"supported" audio codec to
                       re-encode to
                     + there is a client-"supported" target container

    VIDEO_TRANSCODE  always possible. Full re-encode to the
                     maximally-compatible H.264 / AAC / MP4.

    --------------------------------------------------------------
    Result contract (frozen)
    --------------------------------------------------------------
      {
        mode: "direct_play"|"remux"|"audio_transcode"|"video_transcode",
        reason: <string, why THIS mode was chosen>,

        source: {
          container,
          video: { index, codec, profile, width, height, exotic } | null,
          audio: { index, codec, channels } | null,
          videoStreamCount, audioStreamCount, subtitleStreamCount
        },
        client: { name, source, containerState, videoState, audioState, maxResolution },

        directPlay:     { possible, blockers: [] },
        remux:          { possible, blockers: [], target: "mp4"|"webm"|null },
        audioTranscode: { possible, blockers: [], target, audioCodec },
        videoTranscode: { possible: true, target: "mp4",
                          videoCodec: "h264", audioCodec: "aac", note },

        warnings: [ ...client-model warnings + engine notes ]
      }

    NOTE: this engine is NOT wired into the live /video route. That
    is a later integration task.
*/


const MODES = {
    DIRECT_PLAY: "direct_play",
    REMUX: "remux",
    AUDIO_TRANSCODE: "audio_transcode",
    VIDEO_TRANSCODE: "video_transcode"
};

// Codecs each browser-friendly container can carry WITHOUT
// re-encoding. Data, not branching.
const CONTAINER_CODECS = {
    mp4: {
        video: ["h264", "hevc", "vp9", "av1"],
        audio: ["aac", "ac3", "eac3", "mp3", "opus", "flac"]
    },
    webm: {
        video: ["vp8", "vp9", "av1"],
        audio: ["opus", "vorbis"]
    }
};

// File extension / ffprobe format token -> canonical container.
const CONTAINER_TOKEN = {
    "mp4": "mp4", "m4v": "mp4", "m4a": "mp4", "mov": "mov", "qt": "mov",
    "mkv": "mkv", "matroska": "mkv",
    "webm": "webm",
    "avi": "avi"
};

// Preference order when we must pick an audio codec to transcode to.
const AUDIO_TARGET_PREFERENCE = ["aac", "opus", "mp3", "vorbis", "ac3", "eac3", "flac"];


// ---- small utilities -----------------------------------------

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(obj) {
    if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        Object.keys(obj).forEach(function (k) { deepFreeze(obj[k]); });
    }
    return obj;
}


// ---- media interpretation -----------------------------------

// A browser <video> generally cannot decode >8-bit or non-4:2:0
// video even when it "supports" the codec name. Deterministic
// heuristic -- profile/level are not fully modelled yet.
function isExoticVideoConfig(video) {

    const pf = (typeof video.pixelFormat === "string" ? video.pixelFormat : "").toLowerCase();
    const profile = (typeof video.profile === "string" ? video.profile : "").toLowerCase();

    if (/(?:^|[^0-9])(?:10|12|14|16)(?:le|be)(?:$|[^0-9])/.test(pf)) return true;
    if (/^p0(?:10|12|16)/.test(pf)) return true;
    if (/(?:^|[^0-9])(?:422|440|444)(?:$|[^0-9p])/.test(pf) || pf.indexOf("422p") !== -1 || pf.indexOf("444p") !== -1) return true;
    if (pf.indexOf("gbr") === 0) return true;

    if (/(?:^|[^a-z])(?:high|main)\s?(?:10|12|422|444|4:2:2|4:4:4)(?:[^a-z0-9]|$)/.test(profile)) return true;
    if (/(?:10|12)\s?-?\s?bit/.test(profile)) return true;
    if (profile.indexOf("444") !== -1 || profile.indexOf("422") !== -1) return true;

    return false;
}

function resolveContainer(media) {

    const filePath =
        (media.file && typeof media.file.path === "string") ? media.file.path : "";

    const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");

    if (CONTAINER_TOKEN[ext]) {
        return CONTAINER_TOKEN[ext];
    }

    const fmt =
        (media.container && typeof media.container.format === "string")
            ? media.container.format.toLowerCase()
            : "";

    if (fmt) {

        const parts = fmt.split(",");

        for (let i = 0; i < parts.length; i++) {
            const token = parts[i].trim();
            const canon = CONTAINER_TOKEN[token] || canonicalFormat("containers", token);
            if (canon) {
                return canon;
            }
        }

        // ffmpeg muxer-group names.
        if (fmt.indexOf("mp4") !== -1 || fmt.indexOf("mov") !== -1) return "mp4";
        if (fmt.indexOf("matroska") !== -1) return "mkv";
        if (fmt.indexOf("webm") !== -1) return "webm";
        if (fmt.indexOf("avi") !== -1) return "avi";
    }

    return null;
}

function resolutionExceedsLimit(video, maxResolution) {

    if (!isObject(maxResolution)) {
        return null;
    }

    const w = video.width;
    const h = video.height;

    if (typeof w !== "number" || typeof h !== "number") {
        return null;   // unknown resolution -> cannot check
    }

    if (w > maxResolution.width || h > maxResolution.height) {
        return { width: w, height: h, limit: maxResolution };
    }

    return null;
}


// ---- target selection ---------------------------------------

function containerCanCarry(target, videoCodec, hasVideo, audioCodec, hasAudio) {

    const spec = CONTAINER_CODECS[target];
    if (!spec) return false;

    if (hasVideo && spec.video.indexOf(videoCodec) === -1) return false;
    if (hasAudio && spec.audio.indexOf(audioCodec) === -1) return false;

    return true;
}

// A client-"supported" container that can carry the given codecs
// without re-encoding. Prefers mp4.
function pickContainer(caps, videoCodec, hasVideo, audioCodec, hasAudio) {

    const candidates = ["mp4", "webm"];

    for (let i = 0; i < candidates.length; i++) {
        const target = candidates[i];
        if (capabilityOf(caps, "containers", target) !== STATES.SUPPORTED) continue;
        if (containerCanCarry(target, videoCodec, hasVideo, audioCodec, hasAudio)) {
            return target;
        }
    }

    return null;
}

// The best client-"supported" audio codec to transcode to, or null.
function pickAudioTarget(caps) {

    for (let i = 0; i < AUDIO_TARGET_PREFERENCE.length; i++) {
        const codec = AUDIO_TARGET_PREFERENCE[i];
        if (capabilityOf(caps, "audio", codec) === STATES.SUPPORTED) {
            return codec;
        }
    }

    return null;
}


// ---- per-mode evaluation ------------------------------------

function evalCopyVideo(ctx) {

    // Can the primary video stream be passed through untouched?
    const blockers = [];

    if (!ctx.hasVideo) {
        return { ok: true, blockers: blockers };
    }

    if (!ctx.videoCodec) {
        blockers.push("video codec '" + ctx.rawVideoCodec + "' is not recognised by the model");
    } else if (ctx.videoState === STATES.UNSUPPORTED) {
        blockers.push("video codec '" + ctx.videoCodec + "' is not supported by the client");
    } else if (ctx.videoState !== STATES.SUPPORTED) {
        blockers.push("video codec '" + ctx.videoCodec + "' support is unknown");
    }

    if (ctx.exoticVideo) {
        blockers.push("video uses a high-bit-depth / non-4:2:0 configuration ("
            + (ctx.videoProfile || ctx.videoPixelFormat || "unknown")
            + ") that browsers generally cannot decode");
    }

    if (ctx.resolutionBlock) {
        blockers.push("video resolution "
            + ctx.resolutionBlock.width + "x" + ctx.resolutionBlock.height
            + " exceeds the client limit "
            + ctx.resolutionBlock.limit.width + "x" + ctx.resolutionBlock.limit.height);
    }

    return { ok: blockers.length === 0, blockers: blockers };
}

function evalCopyAudio(ctx) {

    const blockers = [];

    if (!ctx.hasAudio) {
        return { ok: true, blockers: blockers };
    }

    if (!ctx.audioCodec) {
        blockers.push("audio codec '" + ctx.rawAudioCodec + "' is not recognised by the model");
    } else if (ctx.audioState === STATES.UNSUPPORTED) {
        blockers.push("audio codec '" + ctx.audioCodec + "' is not supported by the client");
    } else if (ctx.audioState !== STATES.SUPPORTED) {
        blockers.push("audio codec '" + ctx.audioCodec + "' support is unknown");
    }

    return { ok: blockers.length === 0, blockers: blockers };
}

function evalDirectPlay(ctx) {

    const blockers = [];

    if (!ctx.container) {
        blockers.push("container could not be identified");
    } else if (ctx.containerState === STATES.UNSUPPORTED) {
        blockers.push("container '" + ctx.container + "' is not supported by the client");
    } else if (ctx.containerState !== STATES.SUPPORTED) {
        blockers.push("container '" + ctx.container + "' support is unknown");
    }

    const video = evalCopyVideo(ctx);
    const audio = evalCopyAudio(ctx);

    return {
        possible: blockers.length === 0 && video.ok && audio.ok,
        blockers: blockers.concat(video.blockers, audio.blockers)
    };
}

function evalRemux(ctx) {

    const blockers = [];

    // Remux is only meaningful when the container is the obstacle.
    if (ctx.containerState === STATES.SUPPORTED) {
        blockers.push("container '" + ctx.container + "' is already client-supported; remuxing would not resolve the remaining blockers");
    }

    const video = evalCopyVideo(ctx);
    const audio = evalCopyAudio(ctx);

    blockers.push.apply(blockers, video.blockers);
    blockers.push.apply(blockers, audio.blockers);

    let target = null;

    if (video.ok && audio.ok) {
        target = pickContainer(ctx.caps, ctx.videoCodec, ctx.hasVideo, ctx.audioCodec, ctx.hasAudio);
        if (!target) {
            blockers.push("no client-supported container (mp4/webm) can carry these codecs without re-encoding");
        }
    }

    return {
        possible: blockers.length === 0 && target !== null,
        blockers: blockers,
        target: target
    };
}

function evalAudioTranscode(ctx) {

    const blockers = [];

    const video = evalCopyVideo(ctx);
    blockers.push.apply(blockers, video.blockers);

    let audioCodec = null;
    let target = null;

    if (video.ok) {

        audioCodec = pickAudioTarget(ctx.caps);

        if (!audioCodec) {
            blockers.push("client does not confirm support for any audio codec to transcode to");
        } else {
            target = pickContainer(ctx.caps, ctx.videoCodec, ctx.hasVideo, audioCodec, ctx.hasAudio);
            if (!target) {
                blockers.push("no client-supported container can hold the copied video plus re-encoded audio");
            }
        }
    }

    return {
        possible: blockers.length === 0 && audioCodec !== null && target !== null,
        blockers: blockers,
        target: target,
        audioCodec: audioCodec
    };
}


// ---- reason strings ----------------------------------------

function describeStreams(ctx) {
    const parts = [];
    if (ctx.hasVideo) parts.push("video " + (ctx.videoCodec || ctx.rawVideoCodec));
    if (ctx.hasAudio) parts.push("audio " + (ctx.audioCodec || ctx.rawAudioCodec));
    return parts.join(" / ") || "no A/V streams";
}

function directPlayReason(ctx) {
    let r = "Direct play: container " + ctx.container;
    if (ctx.hasVideo) {
        r += ", video " + ctx.videoCodec;
        if (typeof ctx.primaryVideo.width === "number" && typeof ctx.primaryVideo.height === "number") {
            r += " " + ctx.primaryVideo.width + "x" + ctx.primaryVideo.height;
        }
    }
    if (ctx.hasAudio) {
        r += (ctx.hasVideo ? " and audio " : ", audio ") + ctx.audioCodec;
    }
    r += " are all explicitly supported by the client; no processing required.";
    return r;
}

function remuxReason(ctx, target) {
    return "Remux: the streams (" + describeStreams(ctx)
        + ") are client-supported but the "
        + (ctx.container || "source") + " container is not (state: " + ctx.containerState
        + "); repackage into " + target + " without re-encoding.";
}

function audioTranscodeReason(ctx, decision) {
    return "Audio transcode: video " + ctx.videoCodec
        + " is client-supported and will be copied, but audio "
        + (ctx.audioCodec || ctx.rawAudioCodec) + " (state: " + ctx.audioState
        + ") is not; re-encode audio to " + decision.audioCodec
        + " in " + decision.target + ".";
}

function videoTranscodeReason(ctx, directPlay) {

    const everythingUnknown =
        ctx.caps.source === "default" ||
        (ctx.containerState !== STATES.SUPPORTED &&
            ctx.containerState !== STATES.UNSUPPORTED &&
            (!ctx.hasVideo || ctx.videoState === STATES.UNKNOWN) &&
            (!ctx.hasAudio || ctx.audioState === STATES.UNKNOWN));

    if (everythingUnknown) {
        return "Video transcode: the client's capabilities are unknown, so the only safe choice is a full re-encode to a maximally-compatible H.264 / AAC MP4.";
    }

    const primary = directPlay.blockers[0] || "the media cannot be played as-is";

    let r = "Video transcode: " + primary + "; a full re-encode to H.264 / AAC MP4 is required.";

    if (!ctx.hasVideo) {
        r = "Video transcode (audio only): " + primary + "; re-encode audio to a compatible codec.";
    }

    return r;
}


// ---- entry point ------------------------------------------

function decidePlayback(media, client) {

    const caps = normalizeClientCapabilities(client);
    const warnings = caps.warnings.slice();

    // ---- unusable probe -> conservative full transcode ----
    const hasAnyStream =
        isObject(media) && media.ok === true && (
            (Array.isArray(media.video) && media.video.some(isObject)) ||
            (Array.isArray(media.audio) && media.audio.some(isObject))
        );

    if (!isObject(media) || media.ok !== true || !hasAnyStream) {

        warnings.push(
            (!isObject(media) || media.ok !== true)
                ? "media probe is unavailable or failed"
                : "media probe reported no audio or video streams"
        );

        return deepFreeze({
            mode: MODES.VIDEO_TRANSCODE,
            reason: "Video transcode: the media probe is unavailable, failed, or reported no verifiable audio/video streams; a full re-encode to a maximally-compatible H.264 / AAC MP4 is required.",
            source: {
                container: null,
                video: null,
                audio: null,
                videoStreamCount: 0,
                audioStreamCount: 0,
                subtitleStreamCount: 0
            },
            client: {
                name: caps.client,
                source: caps.source,
                containerState: STATES.UNKNOWN,
                videoState: STATES.UNKNOWN,
                audioState: STATES.UNKNOWN,
                maxResolution: caps.maxResolution
            },
            directPlay: { possible: false, blockers: ["media probe unavailable"] },
            remux: { possible: false, blockers: ["media probe unavailable"], target: null },
            audioTranscode: { possible: false, blockers: ["media probe unavailable"], target: null, audioCodec: null },
            videoTranscode: { possible: true, target: "mp4", videoCodec: "h264", audioCodec: "aac", note: "media unverified" },
            warnings: warnings
        });
    }

    const videoStreams = Array.isArray(media.video) ? media.video.filter(isObject) : [];
    const audioStreams = Array.isArray(media.audio) ? media.audio.filter(isObject) : [];
    const subtitleStreams = Array.isArray(media.subtitles) ? media.subtitles.filter(isObject) : [];

    const primaryVideo = videoStreams[0] || null;
    const primaryAudio = audioStreams[0] || null;
    const hasVideo = primaryVideo !== null;
    const hasAudio = primaryAudio !== null;

    const container = resolveContainer(media);
    const containerState = container
        ? capabilityOf(caps, "containers", container)
        : STATES.UNKNOWN;

    const rawVideoCodec = hasVideo ? primaryVideo.codec : null;
    const videoCodec = hasVideo ? canonicalFormat("video", rawVideoCodec) : null;
    const videoState = hasVideo
        ? (videoCodec ? capabilityOf(caps, "video", videoCodec) : STATES.UNKNOWN)
        : null;

    const rawAudioCodec = hasAudio ? primaryAudio.codec : null;
    const audioCodec = hasAudio ? canonicalFormat("audio", rawAudioCodec) : null;
    const audioState = hasAudio
        ? (audioCodec ? capabilityOf(caps, "audio", audioCodec) : STATES.UNKNOWN)
        : null;

    const exoticVideo = hasVideo ? isExoticVideoConfig(primaryVideo) : false;
    const resolutionBlock = hasVideo
        ? resolutionExceedsLimit(primaryVideo, caps.maxResolution)
        : null;

    if (videoStreams.length > 1) {
        warnings.push(videoStreams.length + " video streams present; the decision is based on the first one (index " + primaryVideo.index + ")");
    }
    if (audioStreams.length > 1) {
        warnings.push(audioStreams.length + " audio streams present; the decision is based on the first one (index " + primaryAudio.index + ")");
    }

    const ctx = {
        caps: caps,
        container: container,
        containerState: containerState,
        hasVideo: hasVideo,
        hasAudio: hasAudio,
        primaryVideo: primaryVideo || {},
        primaryAudio: primaryAudio || {},
        rawVideoCodec: rawVideoCodec,
        videoCodec: videoCodec,
        videoState: videoState,
        videoProfile: hasVideo ? primaryVideo.profile : null,
        videoPixelFormat: hasVideo ? primaryVideo.pixelFormat : null,
        exoticVideo: exoticVideo,
        resolutionBlock: resolutionBlock,
        rawAudioCodec: rawAudioCodec,
        audioCodec: audioCodec,
        audioState: audioState
    };

    const directPlay = evalDirectPlay(ctx);
    const remux = evalRemux(ctx);
    const audioTranscode = evalAudioTranscode(ctx);

    let mode;
    let reason;

    if (directPlay.possible) {
        mode = MODES.DIRECT_PLAY;
        reason = directPlayReason(ctx);
    } else if (remux.possible) {
        mode = MODES.REMUX;
        reason = remuxReason(ctx, remux.target);
    } else if (audioTranscode.possible) {
        mode = MODES.AUDIO_TRANSCODE;
        reason = audioTranscodeReason(ctx, audioTranscode);
    } else {
        mode = MODES.VIDEO_TRANSCODE;
        reason = videoTranscodeReason(ctx, directPlay);
    }

    const videoTranscode = {
        possible: true,
        target: "mp4",
        videoCodec: hasVideo ? "h264" : null,
        audioCodec: hasAudio ? "aac" : null,
        note: hasVideo ? null : "no video stream; audio would be re-encoded / repackaged only"
    };

    return deepFreeze({
        mode: mode,
        reason: reason,

        source: {
            container: container,
            video: hasVideo ? {
                index: primaryVideo.index,
                codec: videoCodec || rawVideoCodec,
                profile: primaryVideo.profile,
                width: primaryVideo.width,
                height: primaryVideo.height,
                exotic: exoticVideo
            } : null,
            audio: hasAudio ? {
                index: primaryAudio.index,
                codec: audioCodec || rawAudioCodec,
                channels: primaryAudio.channels
            } : null,
            videoStreamCount: videoStreams.length,
            audioStreamCount: audioStreams.length,
            subtitleStreamCount: subtitleStreams.length
        },

        client: {
            name: caps.client,
            source: caps.source,
            containerState: containerState,
            videoState: videoState,
            audioState: audioState,
            maxResolution: caps.maxResolution
        },

        directPlay: directPlay,
        remux: remux,
        audioTranscode: audioTranscode,
        videoTranscode: videoTranscode,

        warnings: warnings
    });
}


module.exports = {
    MODES: MODES,
    CONTAINER_CODECS: CONTAINER_CODECS,
    decidePlayback: decidePlayback,
    // exported for focused unit tests
    resolveContainer: resolveContainer,
    isExoticVideoConfig: isExoticVideoConfig
};
