"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ffmpeg = require("./ffmpeg");

/*
    ============================================================
    REMUX EXECUTION  (Task 9)
    ============================================================

    When the Task 6 decision engine returns `remux`, this module
    produces a completed, stream-copied file in a dedicated,
    application-controlled cache directory, which server.js then
    serves through the hardened Task 3 serveDirectPlay() path (so
    HTTP Range / 206 / 416 all work).

    It contains NO capability / codec / container decision rules --
    the caller passes in the target container that Task 6 already
    chose. It only:
      * derives a deterministic cache identity,
      * de-duplicates concurrent jobs for the same source+target,
      * runs ffmpeg -c:v copy -c:a copy (no shell interpolation),
      * finalises atomically (.tmp -> rename) so a failed / killed
        job never leaves a partial file presented as complete,
      * kills the job only when the LAST waiting request goes away.

    Output lives in `remuxed/` -- a sibling of `videos/` and
    `transcoded/`, never mixed with transcode output.
*/

const REMUX_DIR = path.join(__dirname, "remuxed");

try {
    fs.mkdirSync(REMUX_DIR, { recursive: true });
} catch (error) {
    // created lazily per-job as well
}

// How long a request will wait for a first-time remux before it
// gives up and falls back (the job keeps running to populate the
// cache for the next request).
const REMUX_WAIT_TIMEOUT_MS = 45000;

// source + target -> in-flight job. { promise, proc, waiters }
const inFlight = new Map();


function targetExtension(container) {
    return container === "webm" ? "webm" : "mp4";
}

/*
    Task 13: the absolute ffprobe index of the audio stream the user
    picked, or null when no explicit selection was made. Only a
    non-negative integer counts; anything else -> null so the cache
    identity and the ffmpeg argv are byte-identical to the pre-Task-13
    "first audio stream" behaviour.
*/
function normalizeAudioStreamIndex(value) {
    return (typeof value === "number" && Number.isInteger(value) && value >= 0)
        ? value
        : null;
}

/*
    Deterministic cache identity: source relative_path + size +
    modification time + the "remux" mode + target container. The
    modification time is kept at FULL fs.Stats.mtimeMs precision (no
    second/whole-number truncation) so an in-place edit or a rapid
    replacement with the same size still produces a different key and
    can never be served from the stale remux.
*/
function remuxCacheKey(relativePath, size, mtimeMs, container, audioStreamIndex) {

    const selected = normalizeAudioStreamIndex(audioStreamIndex);

    // The audio-selection segment is appended ONLY when a track was
    // explicitly chosen, so an unselected remux keeps its historical key.
    const audioSegment = selected === null ? "" : ("␟audio:" + selected);

    return crypto
        .createHash("sha1")
        .update(
            String(relativePath) + "␟" +
            String(size) + "␟" +
            String(mtimeMs) + "␟" +
            "remux" + "␟" +
            targetExtension(container) +
            audioSegment
        )
        .digest("hex");
}

function remuxCachePathFor(key, container) {
    return path.join(REMUX_DIR, key + "." + targetExtension(container));
}

/*
    Where the finished remux for this source+container WOULD live.
    Exposed so callers/tests can assert cache identity and reuse
    without launching a job.
*/
function resolveRemuxTarget(sourcePath, relativePath, container, audioStreamIndex) {

    let stat;
    try {
        stat = fs.statSync(sourcePath);
    } catch (error) {
        return null;
    }

    if (!stat.isFile()) {
        return null;
    }

    const key = remuxCacheKey(
        relativePath, stat.size, stat.mtimeMs, container, audioStreamIndex
    );

    return {
        key: key,
        container: targetExtension(container),
        cachePath: remuxCachePathFor(key, container),
        exists: fs.existsSync(remuxCachePathFor(key, container))
    };
}


/*
    Ensure a completed remux of `sourcePath` into `container` exists.

    params:
      sourcePath    absolute, already CONTAINED by the caller (Task 2)
      relativePath  the library relative_path (cache-identity input)
      container     "mp4" | "webm"  (chosen by Task 6)
      signal        optional AbortSignal -- when the last waiting
                    request aborts, the ffmpeg job is killed and its
                    partial output removed
    options:
      run           override ffmpeg.remuxToFile (tests)
      timeoutMs     how long to wait before returning { ok:false,
                    timedOut:true } while leaving the job running

    Returns:
      { ok:true,  path, key, container, reused }
      { ok:false, error?, timedOut? }
*/
async function ensureRemux(params, options) {

    params = params || {};
    options = options || {};

    const sourcePath = params.sourcePath;
    const relativePath = params.relativePath;
    const container = params.container === "webm" ? "webm" : "mp4";
    const audioStreamIndex = normalizeAudioStreamIndex(params.audioStreamIndex);
    const signal = params.signal;

    const run =
        typeof options.run === "function" ? options.run : ffmpeg.remuxToFile;

    const timeoutMs =
        typeof options.timeoutMs === "number" ? options.timeoutMs : REMUX_WAIT_TIMEOUT_MS;

    const target = resolveRemuxTarget(
        sourcePath, relativePath, container, audioStreamIndex
    );

    if (!target) {
        return { ok: false, error: "source not readable" };
    }

    if (target.exists) {
        return { ok: true, path: target.cachePath, key: target.key, container: target.container, reused: true };
    }

    let entry = inFlight.get(target.key);

    if (!entry) {

        entry = { proc: null, waiters: 0, cancelled: false, promise: null };

        // If the last waiter has ALREADY gone by the time ffmpeg
        // registers its process, kill it immediately -- this closes
        // the abort-before-onProcessStart race.
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

                fs.mkdirSync(REMUX_DIR, { recursive: true });

                // remuxToFile writes "<cachePath>.tmp" and renames it
                // to cachePath only on a clean exit; on failure/kill
                // it removes its own .tmp. The inFlight map guarantees
                // just one job per key, so the fixed .tmp name is safe.
                await run(sourcePath, target.cachePath, {
                    container: container,
                    audioStreamIndex: audioStreamIndex,
                    onProcessStart: (proc) => { entry.proc = proc; entry.killIfDoomed(); }
                });

                if (!fs.existsSync(target.cachePath)) {
                    return { ok: false, error: "remux produced no output" };
                }

                return { ok: true, path: target.cachePath, key: target.key, container: target.container, reused: false };

            }
            catch (error) {

                // Defensive: the cache path is only ever created by an
                // atomic rename, so it is whole or absent -- just make
                // sure no stale .tmp is left.
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
    REMUX_DIR,
    remuxCacheKey,
    resolveRemuxTarget,
    ensureRemux,
    _activeJobCount
};
