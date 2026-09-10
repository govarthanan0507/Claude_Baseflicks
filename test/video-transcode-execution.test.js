"use strict";

/*
    Video Transcode execution integration tests (Task 12).

    Part A -- video-transcode.js job manager (injected runner):
      cache identity (all 3 targets + full mtime), reuse, concurrent
      de-dup, failure / cancelled cleanup, unsupported-codec refusal,
      source-edit invalidation, and the full Tasks-10/11 waiter
      lifecycle.
    Part B -- resolvePlaybackMode() surfaces the Task 6 video-transcode
      target (container + video codec + audio codec).
    Part C -- real `node server.js` + real ffmpeg: a `video_transcode`
      decision re-encodes video + audio to the Task 6 target and the
      finished file is served through the hardened Task 3 path. Direct
      Play / Remux / Audio Transcode still win.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const vt = require(path.join(REPO_ROOT, "video-transcode.js"));
const at = require(path.join(REPO_ROOT, "audio-transcode.js"));
const remux = require(path.join(REPO_ROOT, "remux.js"));
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));
const APP_FILES = require("./_app-files");

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }

const tick = () => new Promise(r => setTimeout(r, 15));

function srcFile(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-vt-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes || Buffer.alloc(256));
    return p;
}

function controllableRun(opts) {
    opts = opts || {};
    const handle = { proc: null, register: null, finish: null, calls: 0, lastOpts: null };
    handle.run = (input, output, op) => new Promise((resolve, reject) => {
        handle.calls += 1;
        handle.lastOpts = op;
        handle.proc = {
            exitCode: null, killed: false,
            kill() { this.killed = true; this.exitCode = null; reject(new Error("killed")); }
        };
        handle.register = () => op.onProcessStart(handle.proc);
        handle.finish = () => { fs.writeFileSync(output, "DONE"); handle.proc.exitCode = 0; resolve(); };
        if (opts.autoRegister !== false) handle.register();
    });
    return handle;
}


// ============================================================
// PART A -- cache + job manager
// ============================================================

test("video-transcode cache identity: path + size + FULL mtime + mode + container + video + audio codec", () => {
    const base = 1_800_000_000_000;
    const pick = (o, key, dflt) => (key in o ? o[key] : dflt);
    const k = (o) => vt.videoTranscodeCacheKey(
        pick(o, "p", "A.mkv"), pick(o, "s", 1000), pick(o, "m", base),
        pick(o, "c", "mp4"), pick(o, "v", "h264"), pick(o, "a", "aac")
    );
    const ref = k({});
    assert.equal(ref, k({}));
    assert.notEqual(ref, k({ p: "B.mkv" }));
    assert.notEqual(ref, k({ s: 1001 }));
    assert.notEqual(ref, k({ c: "webm" }));
    assert.notEqual(ref, k({ v: "hevc" }), "target video codec is part of the identity");
    assert.notEqual(ref, k({ a: "opus" }), "target audio codec is part of the identity");
    assert.notEqual(ref, k({ a: null }), "no-audio target differs");
    assert.notEqual(ref, k({ m: base + 1 }), "1 ms mtime difference must change the key");
    assert.notEqual(ref, k({ m: base + 0.3 }), "sub-millisecond mtime difference must change the key");
});

test("video-transcode identity differs from remux and audio-transcode identities", () => {
    const vk = vt.videoTranscodeCacheKey("A.mkv", 1, 2, "mp4", "h264", "aac");
    assert.notEqual(vk, remux.remuxCacheKey("A.mkv", 1, 2, "mp4"));
    assert.notEqual(vk, at.audioTranscodeCacheKey("A.mkv", 1, 2, "mp4", "aac"));
});

test("video-transcode output lives in transcoded/ under a hashed name, not the scanner mirror name", () => {
    assert.equal(path.basename(vt.VIDEO_TRANSCODE_DIR), "transcoded");
    const src = srcFile("m.mkv");
    const t = vt.resolveVideoTranscodeTarget(src, "Movies/m.mkv", "mp4", "h264", "aac");
    assert.equal(path.dirname(t.cachePath), vt.VIDEO_TRANSCODE_DIR);
    assert.match(path.basename(t.cachePath), /^vt-[0-9a-f]{40}\.mp4$/);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureVideoTranscode: runs once, then reuses", async () => {
    const src = srcFile("reuse.mkv", Buffer.alloc(400));
    let calls = 0;
    const run = async (i, o, op) => { calls++; await tick(); fs.writeFileSync(o, "VT:" + op.videoCodec + ":" + op.audioCodec); };
    const a1 = await vt.ensureVideoTranscode({ sourcePath: src, relativePath: "reuse.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" }, { run });
    assert.equal(a1.ok, true); assert.equal(a1.reused, false);
    assert.equal(a1.videoCodec, "h264"); assert.equal(a1.audioCodec, "aac");
    const a2 = await vt.ensureVideoTranscode({ sourcePath: src, relativePath: "reuse.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" }, { run });
    assert.equal(a2.reused, true); assert.equal(calls, 1);
    fs.rmSync(a1.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureVideoTranscode: two concurrent requests share ONE job", async () => {
    const src = srcFile("conc.mkv", Buffer.alloc(600));
    let calls = 0;
    const run = async (i, o, op) => { calls++; await new Promise(r => setTimeout(r, 70)); fs.writeFileSync(o, "X"); };
    const [a, b] = await Promise.all([
        vt.ensureVideoTranscode({ sourcePath: src, relativePath: "conc.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" }, { run }),
        vt.ensureVideoTranscode({ sourcePath: src, relativePath: "conc.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" }, { run })
    ]);
    assert.equal(calls, 1);
    assert.equal(a.path, b.path);
    fs.rmSync(a.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureVideoTranscode: runner failure -> { ok:false }, no cache file, no .tmp; registry cleaned", async () => {
    const src = srcFile("fail.mkv", Buffer.alloc(64));
    const run = async (i, o, op) => { fs.writeFileSync(o + ".tmp", "partial"); throw new Error("ffmpeg blew up"); };
    const r = await vt.ensureVideoTranscode({ sourcePath: src, relativePath: "fail.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" }, { run });
    assert.equal(r.ok, false);
    assert.match(r.error, /blew up/);
    const t = vt.resolveVideoTranscodeTarget(src, "fail.mkv", "mp4", "h264", "aac");
    assert.equal(fs.existsSync(t.cachePath), false);
    assert.equal(fs.existsSync(t.cachePath + ".tmp"), false);
    assert.equal(vt._activeJobCount(), 0);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureVideoTranscode: a failed job allows a fresh retry", async () => {
    const src = srcFile("retry.mkv", Buffer.alloc(64));
    const params = { sourcePath: src, relativePath: "retry.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" };
    const r1 = await vt.ensureVideoTranscode({ ...params }, { run: async () => { throw new Error("boom"); } });
    assert.equal(r1.ok, false);
    const h = controllableRun();
    const p2 = vt.ensureVideoTranscode({ ...params }, { run: h.run, timeoutMs: 2000 });
    await tick();
    assert.equal(h.calls, 1, "a fresh ffmpeg job after the failure");
    h.finish();
    const r2 = await p2;
    assert.equal(r2.ok, true);
    fs.rmSync(r2.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureVideoTranscode: unsupported target video / audio codec is refused, not substituted", async () => {
    const src = srcFile("u.mkv", Buffer.alloc(64));
    const badV = await vt.ensureVideoTranscode({ sourcePath: src, relativePath: "u.mkv", container: "mp4", videoCodec: "theora", audioCodec: "aac" }, { run: async () => { throw new Error("should not run"); } });
    assert.equal(badV.ok, false); assert.match(badV.error, /unsupported target video codec/);
    const badA = await vt.ensureVideoTranscode({ sourcePath: src, relativePath: "u.mkv", container: "mp4", videoCodec: "h264", audioCodec: "dts" }, { run: async () => { throw new Error("should not run"); } });
    assert.equal(badA.ok, false); assert.match(badA.error, /unsupported target audio codec/);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureVideoTranscode: a same-size in-place source edit invalidates the cache (full mtime precision)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-vt-edit-"));
    const src = path.join(dir, "m.mkv");
    fs.writeFileSync(src, Buffer.alloc(2048, 1));
    const before = vt.resolveVideoTranscodeTarget(src, "m.mkv", "mp4", "h264", "aac").key;
    await tick();
    fs.writeFileSync(src, Buffer.alloc(2048, 2));
    const future = new Date(Date.now() + 2500);
    fs.utimesSync(src, future, future);
    const after = vt.resolveVideoTranscodeTarget(src, "m.mkv", "mp4", "h264", "aac").key;
    assert.notEqual(before, after);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---- waiter / abort lifecycle -------------------------------

test("vt lifecycle: abort BEFORE onProcessStart -> killed the instant ffmpeg registers", async () => {
    const src = srcFile("pre.mkv");
    const h = controllableRun({ autoRegister: false });
    const ac = new AbortController();
    const p = vt.ensureVideoTranscode(
        { sourcePath: src, relativePath: "pre.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac", signal: ac.signal },
        { run: h.run, timeoutMs: 2000 }
    );
    await tick();
    ac.abort();
    await tick();
    assert.equal(h.proc.killed, false);
    h.register();
    await tick();
    assert.equal(h.proc.killed, true);
    assert.equal((await p).ok, false);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("vt lifecycle: ALL waiters abort before ffmpeg starts -> one job, killed on arrival", async () => {
    const src = srcFile("allgone.mkv");
    const h = controllableRun({ autoRegister: false });
    const ac1 = new AbortController(), ac2 = new AbortController();
    const params = { sourcePath: src, relativePath: "allgone.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" };
    const p1 = vt.ensureVideoTranscode({ ...params, signal: ac1.signal }, { run: h.run, timeoutMs: 2000 });
    const p2 = vt.ensureVideoTranscode({ ...params, signal: ac2.signal }, { run: h.run, timeoutMs: 2000 });
    await tick();
    assert.equal(h.calls, 1);
    ac1.abort(); ac2.abort();
    await tick();
    h.register();
    await tick();
    assert.equal(h.proc.killed, true);
    await Promise.all([p1, p2]);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("vt lifecycle: two waiters, ONE aborts, the other remains -> ffmpeg continues", async () => {
    const src = srcFile("stay.mkv");
    const h = controllableRun();
    const ac1 = new AbortController();
    const params = { sourcePath: src, relativePath: "stay.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" };
    const p1 = vt.ensureVideoTranscode({ ...params, signal: ac1.signal }, { run: h.run, timeoutMs: 2000 });
    const p2 = vt.ensureVideoTranscode({ ...params }, { run: h.run, timeoutMs: 2000 });
    await tick();
    ac1.abort();
    await tick();
    assert.equal(h.proc.killed, false);
    h.finish();
    const r2 = await p2;
    assert.equal(r2.ok, true);
    assert.equal(h.proc.killed, false);
    fs.rmSync(r2.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("vt lifecycle: timeout releases the waiter; job dies once the real last waiter leaves", async () => {
    const src = srcFile("phantom.mkv");
    const h = controllableRun();
    const acB = new AbortController();
    const params = { sourcePath: src, relativePath: "phantom.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" };
    const pA = vt.ensureVideoTranscode({ ...params }, { run: h.run, timeoutMs: 30 });
    const pB = vt.ensureVideoTranscode({ ...params, signal: acB.signal }, { run: h.run, timeoutMs: 5000 });
    assert.equal((await pA).timedOut, true);
    await tick();
    assert.equal(h.proc.killed, false);
    acB.abort();
    await tick();
    assert.equal(h.proc.killed, true);
    await pB;
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("vt lifecycle: timeout as the LAST waiter cancels the ffmpeg job", async () => {
    const src = srcFile("tolast.mkv");
    const h = controllableRun();
    const r = await vt.ensureVideoTranscode(
        { sourcePath: src, relativePath: "tolast.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" },
        { run: h.run, timeoutMs: 30 }
    );
    assert.equal(r.timedOut, true);
    await tick();
    assert.equal(h.proc.killed, true);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("vt lifecycle: successful completion leaves no stale in-flight state; next request reuses", async () => {
    const src = srcFile("norm.mkv");
    const h = controllableRun();
    const params = { sourcePath: src, relativePath: "norm.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac" };
    const p = vt.ensureVideoTranscode({ ...params }, { run: h.run, timeoutMs: 2000 });
    await tick();
    h.finish();
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(h.proc.killed, false);
    assert.equal(vt._activeJobCount(), 0);
    const again = await vt.ensureVideoTranscode({ ...params }, { run: h.run, timeoutMs: 2000 });
    assert.equal(again.reused, true);
    assert.equal(h.calls, 1);
    fs.rmSync(r.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});


// ============================================================
// PART B
// ============================================================

test("resolvePlaybackMode: video_transcode decision carries container + video + audio codec", async () => {
    integration._clearDecisionCache();
    const r = await integration.resolvePlaybackMode({
        filePath: "/lib/Movie.avi",
        row: { video_codec: "mpeg4", audio_codec: "ac3" },
        needsTranscode: false,
        clientCapabilities: { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } }
    });
    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.equal(r.target, "mp4");
    assert.equal(r.videoCodec, "h264");
    assert.equal(r.audioCodec, "aac");
});


// ============================================================
// PART C -- real ffmpeg route
// ============================================================

const BASE = "http://127.0.0.1:4000";

function makeMedia(dest, vcodec, acodec) {
    execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=160x90:r=12",
        "-f", "lavfi", "-i", "sine=f=300:d=2",
        "-c:v", vcodec, "-c:a", acodec, "-pix_fmt", "yuv420p", "-shortest",
        "-y", dest
    ], { stdio: "ignore" });
}
function ffprobeStreams(file) {
    return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file]).toString()).streams;
}
function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(30000) });
}
function caps(obj) {
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

test("Task 12 route: VIDEO_TRANSCODE executes; higher-priority modes still win",
    { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t12-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos", "Show", "S01"), { recursive: true });

    const src = path.join(rt, "videos", "movie.avi");
    makeMedia(src, "mpeg4", "ac3");                              // needs full transcode
    makeMedia(path.join(rt, "videos", "concurrent.avi"), "mpeg4", "ac3");
    makeMedia(path.join(rt, "videos", "Show", "S01", "ep.avi"), "mpeg4", "ac3");
    makeMedia(path.join(rt, "videos", "shell & $name.avi"), "mpeg4", "ac3");   // shell-metachar path
    makeMedia(path.join(rt, "videos", "remuxable.mkv"), "libx264", "aac");     // remux candidate
    makeMedia(path.join(rt, "videos", "dp.mkv"), "libx264", "aac");            // direct-play candidate
    makeMedia(path.join(rt, "videos", "audioonly.mkv"), "libx264", "ac3");     // audio-transcode candidate
    fs.writeFileSync(path.join(rt, "videos", "broken.avi"), Buffer.alloc(4000));
    fs.writeFileSync(path.join(rt, "secret.txt"), "T12_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    const VXCODE = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };
    const outDir = path.join(rt, "transcoded");

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 60 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 8; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const set = db.prepare("UPDATE videos SET video_codec=?, audio_codec=?, width=160, height=90, needs_transcode=0 WHERE relative_path=?");
        set.run("mpeg4", "ac3", "movie.avi");
        set.run("mpeg4", "ac3", "concurrent.avi");
        set.run("mpeg4", "ac3", "broken.avi");
        set.run("mpeg4", "ac3", "shell & $name.avi");
        set.run("h264", "aac", "remuxable.mkv");
        set.run("h264", "aac", "dp.mkv");
        set.run("h264", "ac3", "audioonly.mkv");
        const nestedRel = db.prepare("SELECT relative_path FROM videos WHERE relative_path LIKE '%ep.avi'").get().relative_path;
        set.run("mpeg4", "ac3", nestedRel);
        db.close();

        const vtFiles = () => fs.readdirSync(outDir).filter(f => f.startsWith("vt-"));
        const isMp4 = (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp";

        await t.test("VIDEO_TRANSCODE -> ffmpeg runs; video -> h264, audio -> aac, container mp4", async () => {
            const r = await get("/video/movie.avi", caps(VXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "video-transcode");
            assert.equal(r.headers.get("x-baseflix-playback-target"), "mp4/h264/aac");
            assert.equal(r.headers.get("content-type"), "video/mp4");
            assert.ok(isMp4(Buffer.from(await r.arrayBuffer())));

            const outFile = vtFiles().map(f => path.join(outDir, f))[0];
            assert.ok(outFile);
            const outS = ffprobeStreams(outFile);
            const srcS = ffprobeStreams(src);
            assert.equal(srcS.find(s => s.codec_type === "video").codec_name, "mpeg4");
            assert.equal(srcS.find(s => s.codec_type === "audio").codec_name, "ac3");
            assert.equal(outS.find(s => s.codec_type === "video").codec_name, "h264", "video re-encoded to h264");
            assert.equal(outS.find(s => s.codec_type === "audio").codec_name, "aac", "audio re-encoded to aac");
        });

        await t.test("completed output supports Range -> 206", async () => {
            const full = Buffer.from(await (await get("/video/movie.avi", caps(VXCODE))).arrayBuffer());
            const r = await get("/video/movie.avi", { ...caps(VXCODE), Range: "bytes=5-64" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 5-64/${full.length}`);
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(full.subarray(5, 65)));
        });

        await t.test("unsatisfiable Range -> 416", async () => {
            const r = await get("/video/movie.avi", { ...caps(VXCODE), Range: "bytes=99999999-" });
            assert.equal(r.status, 416);
            assert.match(r.headers.get("content-range") || "", /^bytes \*\/\d+$/);
        });

        await t.test("completed output is reused (one artefact, identical bytes)", async () => {
            const a = Buffer.from(await (await get("/video/movie.avi", caps(VXCODE))).arrayBuffer());
            const b = Buffer.from(await (await get("/video/movie.avi", caps(VXCODE))).arrayBuffer());
            assert.ok(a.equals(b));
            assert.equal(vtFiles().length, 1);
        });

        await t.test("two simultaneous requests -> exactly one ffmpeg job / artefact", async () => {
            const before = vtFiles().length;
            const [r1, r2] = await Promise.all([
                get("/video/concurrent.avi", caps(VXCODE)),
                get("/video/concurrent.avi", caps(VXCODE))
            ]);
            assert.equal(r1.status, 200);
            assert.equal(r2.status, 200);
            assert.ok(Buffer.from(await r1.arrayBuffer()).equals(Buffer.from(await r2.arrayBuffer())));
            assert.equal(vtFiles().length - before, 1);
        });

        await t.test("nested source path", async () => {
            const r = await get("/video/" + encodeURIComponent(nestedRel), caps(VXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "video-transcode");
            assert.ok(isMp4(Buffer.from(await r.arrayBuffer())));
        });

        await t.test("ffmpeg invoked without a shell (shell-metachar source path still transcodes)", async () => {
            const r = await get("/video/" + encodeURIComponent("shell & $name.avi"), caps(VXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "video-transcode");
            const outS = ffprobeStreams(vtFiles().map(f => path.join(outDir, f)).sort().slice(-1)[0]);
            assert.ok(isMp4(Buffer.from(await r.arrayBuffer())));
        });

        await t.test("source change invalidates the cache -> a new artefact", async () => {
            const before = vtFiles().length;
            makeMedia(src, "mpeg4", "ac3");
            const r = await get("/video/movie.avi", caps(VXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "video-transcode");
            assert.equal(vtFiles().length, before + 1);
        });

        await t.test("ffmpeg failure -> safe fallback, not reported as video-transcode, no partial", async () => {
            const r = await get("/video/broken.avi", caps(VXCODE));
            assert.equal(r.status, 200);   // nt=0 -> fallback serves original
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            const tgt = vt.resolveVideoTranscodeTarget(path.join(rt, "videos", "broken.avi"), "broken.avi", "mp4", "h264", "aac");
            assert.equal(fs.existsSync(tgt.cachePath), false);
            assert.equal(fs.existsSync(tgt.cachePath + ".tmp"), false);
        });

        await t.test("Direct Play still wins", async () => {
            const r = await get("/video/dp.mkv", caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } }));
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
        });

        await t.test("Remux still wins", async () => {
            const r = await get("/video/remuxable.mkv", caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
        });

        await t.test("Audio Transcode still wins", async () => {
            const r = await get("/video/audioonly.mkv", caps({ video: { h264: true }, audio: { aac: true, ac3: false }, containers: { mp4: true } }));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "audio-transcode");
        });

        await t.test("traversal cannot escape", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt", caps(VXCODE));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T12_SECRET"));
        });

        await t.test("client disconnect during a video-transcode request does not crash the server", async () => {
            const ac = new AbortController();
            const pending = fetch(BASE + "/video/" + encodeURIComponent(nestedRel), { headers: caps(VXCODE), signal: ac.signal }).catch(() => null);
            setTimeout(() => ac.abort(), 5);
            await pending;
            assert.equal((await get("/api/videos")).status, 200);
        });

        await t.test("regression: Task 2 + Task 3 + Task 9 + Task 10 still hold", async () => {
            assert.equal((await get("/video/..%2F..%2Fsecret.txt")).status, 404);
            const rr = await get("/video/movie.avi", { ...caps(VXCODE), Range: "bytes=-12" });
            assert.equal(rr.status, 206);
            const rx = await get("/video/remuxable.mkv", caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(rx.headers.get("x-baseflix-playback"), "remux");
            const at2 = await get("/video/audioonly.mkv", caps({ video: { h264: true }, audio: { aac: true, ac3: false }, containers: { mp4: true } }));
            assert.equal(at2.headers.get("x-baseflix-playback"), "audio-transcode");
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
