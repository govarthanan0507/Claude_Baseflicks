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
    Deterministic cache identity: source relative_path + size +
    mtime (whole seconds) + the "remux" mode + target container.
    Changing any of those -> a different file, so an in-place source
    edit can never be served from a stale remux.
*/
function remuxCacheKey(relativePath, size, mtimeMs, container) {

    return crypto
        .createHash("sha1")
        .update(
            String(relativePath) + "␟" +
            String(size) + "␟" +
            String(Math.floor(mtimeMs / 1000)) + "␟" +
            "remux" + "␟" +
            targetExtension(container)
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
function resolveRemuxTarget(sourcePath, relativePath, container) {

    let stat;
    try {
        stat = fs.statSync(sourcePath);
    } catch (error) {
        return null;
    }

    if (!stat.isFile()) {
        return null;
    }

    const key = remuxCacheKey(relativePath, stat.size, stat.mtimeMs, container);

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
    const signal = params.signal;

    const run =
        typeof options.run === "function" ? options.run : ffmpeg.remuxToFile;

    const timeoutMs =
        typeof options.timeoutMs === "number" ? options.timeoutMs : REMUX_WAIT_TIMEOUT_MS;

    const target = resolveRemuxTarget(sourcePath, relativePath, container);

    if (!target) {
        return { ok: false, error: "source not readable" };
    }

    if (target.exists) {
        return { ok: true, path: target.cachePath, key: target.key, container: target.container, reused: true };
    }

    let entry = inFlight.get(target.key);

    if (!entry) {

        entry = { proc: null, waiters: 0, promise: null };

        entry.promise = (async () => {

            try {

                fs.mkdirSync(REMUX_DIR, { recursive: true });

                // remuxToFile writes "<cachePath>.tmp" and renames it
                // to cachePath only on a clean exit; on failure/kill
                // it removes its own .tmp. The inFlight map guarantees
                // just one job per key, so the fixed .tmp name is safe.
                await run(sourcePath, target.cachePath, {
                    container: container,
                    onProcessStart: (proc) => { entry.proc = proc; }
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

    entry.waiters += 1;

    const onAbort = () => {
        entry.waiters -= 1;
        if (entry.waiters <= 0 && entry.proc && entry.proc.exitCode === null && !entry.proc.killed) {
            entry.proc.kill("SIGKILL");
        }
    };

    if (signal) {
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
    });

    try {
        return await Promise.race([entry.promise, timeoutPromise]);
    }
    finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
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
