"use strict";

/*
    Remux execution integration tests (Task 9).

    Part A -- remux.js job manager, with an INJECTED runner: cache
      identity, reuse, concurrent de-duplication, failure cleanup,
      abort/kill, timeout-keeps-running.
    Part B -- resolvePlaybackMode() surfaces the Task 6 remux target.
    Part C -- a real `node server.js` (real ffmpeg) proving that a
      `remux` decision runs an ffmpeg stream-copy into the chosen
      container, that the completed file is served through the
      hardened Task 3 path (Range/206/416), Direct Play still wins,
      and audio_transcode / video_transcode decisions do NOT remux.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const remux = require(path.join(REPO_ROOT, "remux.js"));
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }


// ============================================================
// PART A -- remux.js job manager (injected runner)
// ============================================================

function srcFile(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-rx-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes || Buffer.alloc(256));
    return p;
}

test("remux cache identity is deterministic and container-specific", () => {
    const k1 = remux.remuxCacheKey("Movies/A.mkv", 1000, 5000, "mp4");
    const k2 = remux.remuxCacheKey("Movies/A.mkv", 1000, 5000, "mp4");
    const k3 = remux.remuxCacheKey("Movies/A.mkv", 1000, 5000, "webm");
    const k4 = remux.remuxCacheKey("Movies/A.mkv", 1001, 5000, "mp4");
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
    assert.notEqual(k1, k4);
});

test("remux output lives in its own directory, never the transcode dir", () => {
    assert.equal(path.basename(remux.REMUX_DIR), "remuxed");
    const src = srcFile("m.mkv");
    const t = remux.resolveRemuxTarget(src, "m.mkv", "mp4");
    assert.equal(path.dirname(t.cachePath), remux.REMUX_DIR);
    assert.equal(path.extname(t.cachePath), ".mp4");
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureRemux: runs the job once, then reuses the cached file", async () => {
    const src = srcFile("reuse.mkv", Buffer.alloc(500));
    let calls = 0;
    const run = async (input, output, opts) => {
        calls++;
        await new Promise(r => setTimeout(r, 20));
        fs.writeFileSync(output, "REMUXED:" + opts.container);
    };

    const r1 = await remux.ensureRemux({ sourcePath: src, relativePath: "reuse.mkv", container: "mp4" }, { run });
    assert.equal(r1.ok, true);
    assert.equal(r1.reused, false);
    assert.equal(calls, 1);
    assert.ok(fs.existsSync(r1.path));

    const r2 = await remux.ensureRemux({ sourcePath: src, relativePath: "reuse.mkv", container: "mp4" }, { run });
    assert.equal(r2.ok, true);
    assert.equal(r2.reused, true);
    assert.equal(calls, 1, "cached remux must not re-run ffmpeg");
    assert.equal(r1.path, r2.path);

    fs.rmSync(r1.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureRemux: two concurrent requests share ONE job", async () => {
    const src = srcFile("concurrent.mkv", Buffer.alloc(700));
    let calls = 0;
    const run = async (i, o, op) => { calls++; await new Promise(r => setTimeout(r, 80)); fs.writeFileSync(o, "X"); };

    const [a, b] = await Promise.all([
        remux.ensureRemux({ sourcePath: src, relativePath: "concurrent.mkv", container: "webm" }, { run }),
        remux.ensureRemux({ sourcePath: src, relativePath: "concurrent.mkv", container: "webm" }, { run })
    ]);

    assert.equal(calls, 1, "one ffmpeg job for two simultaneous requests");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.path, b.path);
    assert.equal(path.extname(a.path), ".webm");

    fs.rmSync(a.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureRemux: runner failure -> { ok:false }, no cache file, no .tmp left", async () => {
    const src = srcFile("fail.mkv", Buffer.alloc(64));
    const run = async (i, o, op) => {
        fs.writeFileSync(o + ".tmp", "partial output");   // simulate ffmpeg's own temp
        throw new Error("ffmpeg exploded");
    };

    const r = await remux.ensureRemux({ sourcePath: src, relativePath: "fail.mkv", container: "mp4" }, { run });
    assert.equal(r.ok, false);
    assert.match(r.error, /exploded/);

    const t = remux.resolveRemuxTarget(src, "fail.mkv", "mp4");
    assert.equal(fs.existsSync(t.cachePath), false);
    assert.equal(fs.existsSync(t.cachePath + ".tmp"), false);

    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureRemux: when the LAST waiter aborts, the job is killed and cleaned", async () => {
    const src = srcFile("abort.mkv", Buffer.alloc(64));

    let killed = false;
    const run = (i, o, op) => new Promise((resolve, reject) => {
        const fakeProc = {
            exitCode: null, killed: false,
            kill() { this.killed = true; killed = true; this.exitCode = null; reject(new Error("killed")); }
        };
        op.onProcessStart(fakeProc);
        fs.writeFileSync(o + ".tmp", "partial");
        // never resolves on its own
    });

    const ac = new AbortController();
    const p = remux.ensureRemux({ sourcePath: src, relativePath: "abort.mkv", container: "mp4", signal: ac.signal }, { run, timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 30));
    ac.abort();
    const r = await p;

    assert.equal(killed, true, "ffmpeg process killed when the last waiter left");
    assert.equal(r.ok, false);
    const t = remux.resolveRemuxTarget(src, "abort.mkv", "mp4");
    assert.equal(fs.existsSync(t.cachePath), false);
    assert.equal(fs.existsSync(t.cachePath + ".tmp"), false);

    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureRemux: a slow first request times out but leaves the job running for the next", async () => {
    const src = srcFile("slow.mkv", Buffer.alloc(64));
    let finished = false;
    const run = async (i, o, op) => {
        await new Promise(r => setTimeout(r, 120));
        fs.writeFileSync(o, "DONE");
        finished = true;
    };

    const first = await remux.ensureRemux({ sourcePath: src, relativePath: "slow.mkv", container: "mp4" }, { run, timeoutMs: 40 });
    assert.equal(first.ok, false);
    assert.equal(first.timedOut, true);

    await new Promise(r => setTimeout(r, 150));
    assert.equal(finished, true, "the job kept running after the request gave up");

    const second = await remux.ensureRemux({ sourcePath: src, relativePath: "slow.mkv", container: "mp4" }, { run, timeoutMs: 40 });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);

    fs.rmSync(second.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});


// ============================================================
// PART B -- resolvePlaybackMode surfaces the remux target
// ============================================================

test("resolvePlaybackMode: remux decision carries the Task 6 target container", async () => {
    integration._clearDecisionCache();
    const r = await integration.resolvePlaybackMode({
        filePath: "/lib/Movie.mkv",
        row: { video_codec: "h264", audio_codec: "aac" },
        needsTranscode: false,
        clientCapabilities: { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } }
    });
    assert.equal(r.mode, MODES.REMUX);
    assert.equal(r.target, "mp4");
});


// ============================================================
// PART C -- /video route, real ffmpeg
// ============================================================

const APP_FILES = [
    "server.js", "database.js", "scanner.js", "ffmpeg.js", "poster.js",
    "media-path.js", "media-probe.js", "playback-decision.js",
    "client-capabilities.js", "playback-integration.js", "remux.js"
];
const BASE = "http://127.0.0.1:4000";

function makeMedia(dest) {
    execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=128x72:r=10",
        "-f", "lavfi", "-i", "sine=f=440:d=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        "-y", dest
    ], { stdio: "ignore" });
}

function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(20000) });
}
function capsHeader(obj) {
    return { "x-baseflix-client-capabilities": Buffer.from(JSON.stringify(obj)).toString("base64") };
}
async function waitForServer(child, log) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("server exited early:\n" + log.join(""));
        if (log.join("").includes("running on port 4000")) return;
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error("server not ready:\n" + log.join(""));
}

test("Task 9 route: REMUX decision executes an ffmpeg stream-copy; other modes do not", { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t9-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos", "Show", "S01"), { recursive: true });

    makeMedia(path.join(rt, "videos", "movie.mkv"));
    makeMedia(path.join(rt, "videos", "concurrent.mkv"));
    makeMedia(path.join(rt, "videos", "Show", "S01", "ep.mkv"));
    fs.writeFileSync(path.join(rt, "videos", "broken.mkv"), Buffer.alloc(4000));   // not real media
    fs.writeFileSync(path.join(rt, "videos", "ac3.mkv"), Buffer.alloc(4000));
    fs.writeFileSync(path.join(rt, "videos", "hevc.mkv"), Buffer.alloc(4000));
    fs.writeFileSync(path.join(rt, "secret.txt"), "T9_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 50 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 5; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const set = db.prepare("UPDATE videos SET video_codec=?, audio_codec=?, width=128, height=72, needs_transcode=0 WHERE relative_path=?");
        set.run("h264", "aac", "movie.mkv");
        set.run("h264", "aac", "concurrent.mkv");
        set.run("h264", "aac", "broken.mkv");
        set.run("h264", "ac3", "ac3.mkv");
        set.run("hevc", "aac", "hevc.mkv");
        const nestedRel = db.prepare("SELECT relative_path FROM videos WHERE relative_path LIKE '%ep.mkv'").get().relative_path;
        set.run("h264", "aac", nestedRel);
        db.close();

        const MP4_ONLY = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };
        const WITH_MKV = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } };

        const isMp4 = (buf) => buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp";

        await t.test("REMUX decision -> ffmpeg stream-copy into mp4, served completed", async () => {
            const r = await get("/video/movie.mkv", capsHeader(MP4_ONLY));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.equal(r.headers.get("x-baseflix-playback-target"), "mp4");
            assert.equal(r.headers.get("content-type"), "video/mp4");
            assert.equal(r.headers.get("accept-ranges"), "bytes");
            const body = Buffer.from(await r.arrayBuffer());
            assert.ok(isMp4(body), "served body is a real MP4");
            assert.ok(fs.readdirSync(path.join(rt, "remuxed")).some(f => f.endsWith(".mp4")));
        });

        await t.test("remuxed playback supports Range -> 206", async () => {
            const full = Buffer.from(await (await get("/video/movie.mkv", capsHeader(MP4_ONLY))).arrayBuffer());
            const r = await get("/video/movie.mkv", { ...capsHeader(MP4_ONLY), Range: "bytes=0-99" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 0-99/${full.length}`);
            assert.equal(r.headers.get("content-length"), "100");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(full.subarray(0, 100)));
        });

        await t.test("remuxed playback: unsatisfiable Range -> 416", async () => {
            const r = await get("/video/movie.mkv", { ...capsHeader(MP4_ONLY), Range: "bytes=99999999-" });
            assert.equal(r.status, 416);
            assert.match(r.headers.get("content-range") || "", /^bytes \*\/\d+$/);
        });

        await t.test("existing completed remux is reused (same bytes, no second job)", async () => {
            const a = Buffer.from(await (await get("/video/movie.mkv", capsHeader(MP4_ONLY))).arrayBuffer());
            const b = Buffer.from(await (await get("/video/movie.mkv", capsHeader(MP4_ONLY))).arrayBuffer());
            assert.ok(a.equals(b));
            const mp4s = fs.readdirSync(path.join(rt, "remuxed")).filter(f => f.endsWith(".mp4"));
            assert.equal(mp4s.length, 1, "exactly one cached remux for this source+target");
        });

        await t.test("two simultaneous requests -> one remux artefact", async () => {
            const before = fs.readdirSync(path.join(rt, "remuxed")).length;
            const [r1, r2] = await Promise.all([
                get("/video/concurrent.mkv", capsHeader(MP4_ONLY)),
                get("/video/concurrent.mkv", capsHeader(MP4_ONLY))
            ]);
            assert.equal(r1.status, 200);
            assert.equal(r2.status, 200);
            const b1 = Buffer.from(await r1.arrayBuffer());
            const b2 = Buffer.from(await r2.arrayBuffer());
            assert.ok(isMp4(b1) && isMp4(b2));
            assert.ok(b1.equals(b2));
            const added = fs.readdirSync(path.join(rt, "remuxed")).length - before;
            assert.equal(added, 1, "the two concurrent requests produced exactly one remux file");
        });

        await t.test("nested source path remuxes", async () => {
            const r = await get("/video/" + encodeURIComponent(nestedRel), capsHeader(MP4_ONLY));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.ok(isMp4(Buffer.from(await r.arrayBuffer())));
        });

        await t.test("traversal cannot escape into a remux", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt", capsHeader(MP4_ONLY));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T9_SECRET"));
            assert.equal(r.headers.get("x-baseflix-playback"), null);
        });

        await t.test("Direct Play still wins over Remux", async () => {
            const r = await get("/video/movie.mkv", capsHeader(WITH_MKV));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            // original matroska, not the remux
            assert.equal(r.headers.get("content-type"), "video/x-matroska");
        });

        await t.test("ffmpeg failure -> safe fallback, no partial output, not reported as remux", async () => {
            const r = await get("/video/broken.mkv", capsHeader(MP4_ONLY));
            assert.equal(r.status, 200);                       // nt=0 fallback serves the original
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");   // NOT "remux"
            const t = remux.resolveRemuxTarget(path.join(rt, "videos", "broken.mkv"), "broken.mkv", "mp4");
            assert.equal(fs.existsSync(t.cachePath), false);
            assert.equal(fs.existsSync(t.cachePath + ".tmp"), false);
        });

        await t.test("audio_transcode decision does NOT execute remux", async () => {
            const r = await get("/video/ac3.mkv", capsHeader({ video: { h264: true }, audio: { aac: true, ac3: false }, containers: { mp4: true } }));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
        });

        await t.test("video_transcode decision does NOT execute remux", async () => {
            const r = await get("/video/hevc.mkv", capsHeader({ video: { h264: true, hevc: false }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
        });

        await t.test("client disconnect during a remux request does not crash the server", async () => {
            const ac = new AbortController();
            const pending = fetch(BASE + "/video/" + encodeURIComponent(nestedRel), {
                headers: capsHeader(MP4_ONLY), signal: ac.signal
            }).catch(() => null);
            setTimeout(() => ac.abort(), 5);
            await pending;
            // server still answers
            const ok = await get("/api/videos");
            assert.equal(ok.status, 200);
        });

        await t.test("regression: Task 2 + Task 3 still hold on /video", async () => {
            assert.equal((await get("/video/..%2F..%2Fsecret.txt")).status, 404);
            const rr = await get("/video/movie.mkv", { ...capsHeader(WITH_MKV), Range: "bytes=-20" });
            assert.equal(rr.status, 206);
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
