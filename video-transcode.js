"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ffmpeg = require("./ffmpeg");

/*
    ============================================================
    VIDEO TRANSCODE EXECUTION  (Task 12)
    ============================================================

    The final layer of the Task 6 hierarchy
    (DIRECT_PLAY -> REMUX -> AUDIO_TRANSCODE -> VIDEO_TRANSCODE).
    When the decision engine returns `video_transcode`, this module
    produces a completed file whose video AND audio are re-encoded to
    the codecs Task 6 chose, which server.js then serves through the
    hardened Task 3 serveDirectPlay() path (Range / 206 / 416).

    NO capability / codec decision rules live here -- the caller passes
    the target container, video codec and audio codec that the
    decision engine selected. It only:
      * derives a deterministic cache identity,
      * de-duplicates concurrent jobs for the same source + target,
      * runs ffmpeg -c:v <enc> -c:a <enc> (no shell interpolation),
      * finalises atomically (.tmp -> rename),
      * follows the waiter lifecycle standard from Tasks 10 / 11.

    Output lives in the EXISTING `transcoded/` directory, but under a
    hash filename (not the scanner's mirror-structure name), so a
    Task 12 transcode and a scanner background conversion of the same
    source cannot collide, and neither is mixed with remuxed/ or
    audio_transcoded/.
*/

const VIDEO_TRANSCODE_DIR = path.join(__dirname, "transcoded");

try {
    fs.mkdirSync(VIDEO_TRANSCODE_DIR, { recursive: true });
} catch (error) {
    // created lazily per-job as well
}

const WAIT_TIMEOUT_MS = 45000;

// The targets this executor can run. Task 6's VIDEO_TRANSCODE only
// asks for h264 video + aac audio today; anything outside these sets
// is refused so the caller falls back instead of guessing.
const SUPPORTED_VIDEO_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);
const SUPPORTED_AUDIO_CODECS = new Set(["aac", "opus", "mp3", "vorbis", "ac3", "eac3", "flac"]);

// source + full target -> in-flight job.
const inFlight = new Map();


function targetExtension(container) {
    return container === "webm" ? "webm" : "mp4";
}

/*
    Deterministic cache identity: source relative_path + size + FULL
    fs.Stats.mtimeMs (no truncation) + the "video_transcode" mode +
    target container + target video codec + target audio codec.
    A same-size in-place source edit, or any change of target, yields
    a different key -- a stale transcode can never be served.
*/
function videoTranscodeCacheKey(relativePath, size, mtimeMs, container, videoCodec, audioCodec) {

    return crypto
        .createHash("sha1")
        .update(
            String(relativePath) + "␟" +
            String(size) + "␟" +
            String(mtimeMs) + "␟" +
            "video_transcode" + "␟" +
            targetExtension(container) + "␟" +
            String(videoCodec) + "␟" +
            String(audioCodec)
        )
        .digest("hex");
}

function cachePathFor(key, container) {
    return path.join(VIDEO_TRANSCODE_DIR, "vt-" + key + "." + targetExtension(container));
}

/*
    Where the finished video-transcode for this source + full target
    WOULD live. Exposed for cache-identity / reuse assertions without
    launching a job.
*/
function resolveVideoTranscodeTarget(sourcePath, relativePath, container, videoCodec, audioCodec) {

    let stat;
    try {
        stat = fs.statSync(sourcePath);
    } catch (error) {
        return null;
    }

    if (!stat.isFile()) {
        return null;
    }

    const key = videoTranscodeCacheKey(
        relativePath, stat.size, stat.mtimeMs, container, videoCodec, audioCodec
    );

    return {
        key: key,
        container: targetExtension(container),
        videoCodec: videoCodec,
        audioCodec: audioCodec,
        cachePath: cachePathFor(key, container),
        exists: fs.existsSync(cachePathFor(key, container))
    };
}


/*
    Ensure a completed video-transcode of `sourcePath` exists (video
    -> videoCodec, audio -> audioCodec, in container).

    params:
      sourcePath    absolute, already CONTAINED by the caller (Task 2)
      relativePath  the library relative_path (cache-identity input)
      container     "mp4" | "webm"        (chosen by Task 6)
      videoCodec    "h264" | ...           (chosen by Task 6)
      audioCodec    "aac" | ... | null     (chosen by Task 6; null -> no audio)
      signal        optional AbortSignal
    options:
      run           override ffmpeg.videoTranscodeToFile (tests)
      timeoutMs     wait before returning { ok:false, timedOut:true }

    Returns:
      { ok:true,  path, key, container, videoCodec, audioCodec, reused }
      { ok:false, error?, timedOut?, aborted? }
*/
async function ensureVideoTranscode(params, options) {

    params = params || {};
    options = options || {};

    const sourcePath = params.sourcePath;
    const relativePath = params.relativePath;
    const container = params.container === "webm" ? "webm" : "mp4";
    const videoCodec = params.videoCodec;
    const audioCodec =
        (params.audioCodec === null || params.audioCodec === undefined) ? null : params.audioCodec;
    const signal = params.signal;

    if (!SUPPORTED_VIDEO_CODECS.has(videoCodec)) {
        return { ok: false, error: `unsupported target video codec '${videoCodec}'` };
    }
    if (audioCodec !== null && !SUPPORTED_AUDIO_CODECS.has(audioCodec)) {
        return { ok: false, error: `unsupported target audio codec '${audioCodec}'` };
    }

    const run =
        typeof options.run === "function" ? options.run : ffmpeg.videoTranscodeToFile;

    const timeoutMs =
        typeof options.timeoutMs === "number" ? options.timeoutMs : WAIT_TIMEOUT_MS;

    const target = resolveVideoTranscodeTarget(
        sourcePath, relativePath, container, videoCodec, audioCodec
    );

    if (!target) {
        return { ok: false, error: "source not readable" };
    }

    if (target.exists) {
        return {
            ok: true, path: target.cachePath, key: target.key,
            container: target.container, videoCodec: videoCodec,
            audioCodec: audioCodec, reused: true
        };
    }

    let entry = inFlight.get(target.key);

    if (!entry) {

        entry = { proc: null, waiters: 0, cancelled: false, promise: null };

        // Kill the process the instant it registers if the last
        // waiter already left -- closes the abort-before-onProcessStart
        // race.
        entry.killIfDoomed = () => {
            if (
                entry.cancelled &&
                entry.proc &&
                entry.proc.exitCode === null &&
                !entry.proc.killed
            ) {
                entry.proc.kill("SIGKILL");
            }
        };

        entry.promise = (async () => {

            try {

                fs.mkdirSync(VIDEO_TRANSCODE_DIR, { recursive: true });

                await run(sourcePath, target.cachePath, {
                    container: container,
                    videoCodec: videoCodec,
                    audioCodec: audioCodec,
                    onProcessStart: (proc) => { entry.proc = proc; entry.killIfDoomed(); }
                });

                if (!fs.existsSync(target.cachePath)) {
                    return { ok: false, error: "video transcode produced no output" };
                }

                return {
                    ok: true, path: target.cachePath, key: target.key,
                    container: target.container, videoCodec: videoCodec,
                    audioCodec: audioCodec, reused: false
                };

            }
            catch (error) {

                try { fs.unlinkSync(target.cachePath + ".tmp"); } catch (e) { /* ignore */ }
                return { ok: false, error: error && error.message };

            }
            finally {
                inFlight.delete(target.key);
            }

        })();

        inFlight.set(target.key, entry);
    }

    // ---- waiter lifecycle (Tasks 10 / 11 standard) -----------
    entry.waiters += 1;

    let released = false;

    const release = () => {

        if (released) {
            return;
        }
        released = true;

        entry.waiters -= 1;

        if (entry.waiters <= 0) {
            entry.cancelled = true;
            entry.killIfDoomed();
        }
    };

    let onAbort = null;

    const abortPromise = new Promise((resolve) => {

        if (!signal) {
            return;
        }

        onAbort = () => {
            release();
            resolve({ ok: false, aborted: true });
        };

        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });

    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });

    try {
        return await Promise.race([entry.promise, timeoutPromise, abortPromise]);
    }
    finally {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        release();
    }
}


function _activeJobCount() {
    return inFlight.size;
}


module.exports = {
    VIDEO_TRANSCODE_DIR,
    SUPPORTED_VIDEO_CODECS,
    SUPPORTED_AUDIO_CODECS,
    videoTranscodeCacheKey,
    resolveVideoTranscodeTarget,
    ensureVideoTranscode,
    _activeJobCount
};
