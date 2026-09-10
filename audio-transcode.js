"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ffmpeg = require("./ffmpeg");

/*
    ============================================================
    AUDIO TRANSCODE EXECUTION  (Task 10)
    ============================================================

    When the Task 6 decision engine returns `audio_transcode`, this
    module produces a completed file whose VIDEO is copied untouched
    and whose AUDIO is re-encoded to the target codec Task 6 already
    chose. server.js then serves that finished file through the
    hardened Task 3 serveDirectPlay() path (Range / 206 / 416).

    It contains NO capability / codec decision rules -- the caller
    passes in the target container AND target audio codec that the
    decision engine selected. It only:
      * derives a deterministic cache identity (source state + both
        target parameters),
      * de-duplicates concurrent jobs for the same source+target,
      * runs ffmpeg -c:v copy -c:a <codec> (no shell interpolation),
      * finalises atomically (.tmp -> rename) so a failed / killed
        job never leaves a partial file presented as complete,
      * kills the job only when the LAST waiting request goes away.

    Output lives in `audio_transcoded/` -- a sibling of `videos/`,
    `transcoded/` and `remuxed/`, never mixed with remux output.

    This deliberately mirrors remux.js rather than sharing a job
    manager, so Task 9's implementation is left exactly as-is.
*/

const AUDIO_TRANSCODE_DIR = path.join(__dirname, "audio_transcoded");

try {
    fs.mkdirSync(AUDIO_TRANSCODE_DIR, { recursive: true });
} catch (error) {
    // created lazily per-job as well
}

const WAIT_TIMEOUT_MS = 45000;

// The target audio codecs this executor can actually run -- exactly
// Task 6's AUDIO_TARGET_PREFERENCE. If Task 6 ever hands us something
// outside this set we fall back rather than invent a substitute.
const SUPPORTED_TARGET_CODECS = new Set([
    "aac", "opus", "mp3", "vorbis", "ac3", "eac3", "flac"
]);

// source + both target params -> in-flight job.
const inFlight = new Map();


function targetExtension(container) {
    return container === "webm" ? "webm" : "mp4";
}

/*
    Task 13: absolute ffprobe index of the audio stream the user
    picked, or null when there was no explicit selection. Only a
    non-negative integer counts; anything else -> null so the cache
    identity and the ffmpeg argv stay byte-identical to the
    pre-Task-13 "first audio stream" behaviour.
*/
function normalizeAudioStreamIndex(value) {
    return (typeof value === "number" && Number.isInteger(value) && value >= 0)
        ? value
        : null;
}

/*
    Deterministic cache identity: source relative_path + size + FULL
    fs.Stats.mtimeMs precision + the "audio_transcode" mode + target
    container + target audio codec. Changing the source (even a
    same-size in-place edit) or either target parameter yields a
    different key, so a stale result can never be served.
*/
function audioTranscodeCacheKey(relativePath, size, mtimeMs, container, audioCodec, audioStreamIndex) {

    const selected = normalizeAudioStreamIndex(audioStreamIndex);

    // Appended ONLY when a track was explicitly chosen, so an
    // unselected audio-transcode keeps its historical key.
    const audioSegment = selected === null ? "" : ("␟audio:" + selected);

    return crypto
        .createHash("sha1")
        .update(
            String(relativePath) + "␟" +
            String(size) + "␟" +
            String(mtimeMs) + "␟" +
            "audio_transcode" + "␟" +
            targetExtension(container) + "␟" +
            String(audioCodec) +
            audioSegment
        )
        .digest("hex");
}

function cachePathFor(key, container) {
    return path.join(AUDIO_TRANSCODE_DIR, key + "." + targetExtension(container));
}

/*
    Where the finished audio-transcode for this source + container +
    audio codec WOULD live. Exposed for cache-identity / reuse
    assertions without launching a job.
*/
function resolveAudioTranscodeTarget(sourcePath, relativePath, container, audioCodec, audioStreamIndex) {

    let stat;
    try {
        stat = fs.statSync(sourcePath);
    } catch (error) {
        return null;
    }

    if (!stat.isFile()) {
        return null;
    }

    const key = audioTranscodeCacheKey(
        relativePath, stat.size, stat.mtimeMs, container, audioCodec, audioStreamIndex
    );

    return {
        key: key,
        container: targetExtension(container),
        audioCodec: audioCodec,
        cachePath: cachePathFor(key, container),
        exists: fs.existsSync(cachePathFor(key, container))
    };
}


/*
    Ensure a completed audio-transcode of `sourcePath` (video copied,
    audio -> `audioCodec`, in `container`) exists.

    params:
      sourcePath    absolute, already CONTAINED by the caller (Task 2)
      relativePath  the library relative_path (cache-identity input)
      container     "mp4" | "webm"           (chosen by Task 6)
      audioCodec    "aac" | "opus" | ...      (chosen by Task 6)
      signal        optional AbortSignal -- when the last waiting
                    request aborts, the ffmpeg job is killed and its
                    partial output removed
    options:
      run           override ffmpeg.audioTranscodeToFile (tests)
      timeoutMs     wait before returning { ok:false, timedOut:true }
                    while leaving the job running

    Returns:
      { ok:true,  path, key, container, audioCodec, reused }
      { ok:false, error?, timedOut? }
*/
async function ensureAudioTranscode(params, options) {

    params = params || {};
    options = options || {};

    const sourcePath = params.sourcePath;
    const relativePath = params.relativePath;
    const container = params.container === "webm" ? "webm" : "mp4";
    const audioCodec = params.audioCodec;
    const audioStreamIndex = normalizeAudioStreamIndex(params.audioStreamIndex);
    const signal = params.signal;

    if (!SUPPORTED_TARGET_CODECS.has(audioCodec)) {
        return { ok: false, error: `unsupported target audio codec '${audioCodec}'` };
    }

    const run =
        typeof options.run === "function" ? options.run : ffmpeg.audioTranscodeToFile;

    const timeoutMs =
        typeof options.timeoutMs === "number" ? options.timeoutMs : WAIT_TIMEOUT_MS;

    const target = resolveAudioTranscodeTarget(
        sourcePath, relativePath, container, audioCodec, audioStreamIndex
    );

    if (!target) {
        return { ok: false, error: "source not readable" };
    }

    if (target.exists) {
        return {
            ok: true, path: target.cachePath, key: target.key,
            container: target.container, audioCodec: audioCodec, reused: true
        };
    }

    let entry = inFlight.get(target.key);

    if (!entry) {

        entry = { proc: null, waiters: 0, cancelled: false, promise: null };

        // If the last waiter has ALREADY gone by the time ffmpeg
        // registers its process, kill it immediately -- this closes
        // the abort-before-onProcessStart race.
        const killIfDoomed = () => {
            if (
                entry.cancelled &&
                entry.proc &&
                entry.proc.exitCode === null &&
                !entry.proc.killed
            ) {
                entry.proc.kill("SIGKILL");
            }
        };

        entry.killIfDoomed = killIfDoomed;

        entry.promise = (async () => {

            try {

                fs.mkdirSync(AUDIO_TRANSCODE_DIR, { recursive: true });

                await run(sourcePath, target.cachePath, {
                    container: container,
                    audioCodec: audioCodec,
                    audioStreamIndex: audioStreamIndex,
                    onProcessStart: (proc) => { entry.proc = proc; killIfDoomed(); }
                });

                if (!fs.existsSync(target.cachePath)) {
                    return { ok: false, error: "audio transcode produced no output" };
                }

                return {
                    ok: true, path: target.cachePath, key: target.key,
                    container: target.container, audioCodec: audioCodec, reused: false
                };

            }
            catch (error) {

                // The cache path is only ever created by an atomic
                // rename, so it is whole or absent -- just clear any
                // stale .tmp.
                try { fs.unlinkSync(target.cachePath + ".tmp"); } catch (e) { /* ignore */ }

                return { ok: false, error: error && error.message };

            }
            finally {
                inFlight.delete(target.key);
            }

        })();

        inFlight.set(target.key, entry);
    }

    // ---- waiter lifecycle ------------------------------------
    // A request is a "waiter" from here until it aborts, times out,
    // or completes. It increments the count EXACTLY once and
    // decrements it EXACTLY once -- `release()` is guarded so the
    // abort listener and the finally block can never double-count.
    // When the count hits zero (last waiter left, for ANY reason) the
    // ffmpeg job is cancelled: killed if it is running, or armed so
    // onProcessStart kills it the instant it appears.
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
            return;   // stays pending forever -> never wins the race
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
        // Normal-completion and timeout exits release here; an abort
        // has already released via onAbort, so this is then a no-op.
        release();
    }
}


function _activeJobCount() {
    return inFlight.size;
}


module.exports = {
    AUDIO_TRANSCODE_DIR,
    SUPPORTED_TARGET_CODECS,
    audioTranscodeCacheKey,
    resolveAudioTranscodeTarget,
    ensureAudioTranscode,
    _activeJobCount
};
