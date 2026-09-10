"use strict";

/*
    Audio Transcode execution integration tests (Task 10).

    Part A -- audio-transcode.js job manager (injected runner):
      cache identity (incl. target codec + full mtime precision),
      reuse, concurrent de-dup, failure cleanup, abort/kill, timeout,
      unsupported-codec refusal, own cache dir.
    Part B -- resolvePlaybackMode() surfaces the Task 6 audio target.
    Part C -- real `node server.js` + real ffmpeg: an `audio_transcode`
      decision copies the video (-c:v copy) and re-encodes only the
      audio to the codec Task 6 chose; the finished file is served
      through the hardened Task 3 path (Range/206/416). Direct Play
      and Remux still win; video_transcode still falls back.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const at = require(path.join(REPO_ROOT, "audio-transcode.js"));
const remux = require(path.join(REPO_ROOT, "remux.js"));
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));
const APP_FILES = require("./_app-files");

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }


// ============================================================
// PART A
// ============================================================

function srcFile(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-at-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes || Buffer.alloc(256));
    return p;
}

test("audio-transcode cache identity: path + size + FULL mtime + mode + container + audio codec", () => {
    const base = 1_700_000_000_000;
    const k = (over) => at.audioTranscodeCacheKey(
        over.p ?? "A.mkv", over.s ?? 1000, over.m ?? base, over.c ?? "mp4", over.a ?? "aac"
    );
    const ref = k({});
    assert.equal(ref, k({}));
    assert.notEqual(ref, k({ p: "B.mkv" }));
    assert.notEqual(ref, k({ s: 1001 }));
    assert.notEqual(ref, k({ c: "webm" }));
    assert.notEqual(ref, k({ a: "opus" }), "target audio codec is part of the identity");
    assert.notEqual(ref, k({ m: base + 1 }), "1 ms mtime difference must change the key");
    assert.notEqual(ref, k({ m: base + 0.4 }), "sub-millisecond mtime difference must change the key");
});

test("audio-transcode cache identity differs from a remux identity for the same source+container", () => {
    assert.notEqual(
        at.audioTranscodeCacheKey("A.mkv", 1, 2, "mp4", "aac"),
        remux.remuxCacheKey("A.mkv", 1, 2, "mp4")
    );
});

test("audio-transcode output lives in its own directory, never remuxed/ or transcoded/", () => {
    assert.equal(path.basename(at.AUDIO_TRANSCODE_DIR), "audio_transcoded");
    assert.notEqual(at.AUDIO_TRANSCODE_DIR, remux.REMUX_DIR);
    const src = srcFile("m.mkv");
    const t = at.resolveAudioTranscodeTarget(src, "m.mkv", "mp4", "aac");
    assert.equal(path.dirname(t.cachePath), at.AUDIO_TRANSCODE_DIR);
    assert.equal(path.extname(t.cachePath), ".mp4");
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: runs once, then reuses; opus target -> .webm and a different job", async () => {
    const src = srcFile("reuse.mkv", Buffer.alloc(400));
    let calls = 0;
    const run = async (i, o, op) => { calls++; await new Promise(r => setTimeout(r, 15)); fs.writeFileSync(o, "AT:" + op.container + ":" + op.audioCodec); };

    const a1 = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "reuse.mkv", container: "mp4", audioCodec: "aac" }, { run });
    assert.equal(a1.ok, true); assert.equal(a1.reused, false); assert.equal(a1.audioCodec, "aac");
    const a2 = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "reuse.mkv", container: "mp4", audioCodec: "aac" }, { run });
    assert.equal(a2.reused, true); assert.equal(calls, 1);
    assert.equal(a1.path, a2.path);

    const w = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "reuse.mkv", container: "webm", audioCodec: "opus" }, { run });
    assert.equal(w.ok, true); assert.equal(calls, 2);
    assert.equal(path.extname(w.path), ".webm");
    assert.notEqual(w.path, a1.path);

    fs.rmSync(a1.path, { force: true }); fs.rmSync(w.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: two concurrent requests share ONE job", async () => {
    const src = srcFile("conc.mkv", Buffer.alloc(600));
    let calls = 0;
    const run = async (i, o, op) => { calls++; await new Promise(r => setTimeout(r, 70)); fs.writeFileSync(o, "X"); };
    const [a, b] = await Promise.all([
        at.ensureAudioTranscode({ sourcePath: src, relativePath: "conc.mkv", container: "mp4", audioCodec: "aac" }, { run }),
        at.ensureAudioTranscode({ sourcePath: src, relativePath: "conc.mkv", container: "mp4", audioCodec: "aac" }, { run })
    ]);
    assert.equal(calls, 1);
    assert.equal(a.path, b.path);
    fs.rmSync(a.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: runner failure -> { ok:false }, no cache file, no .tmp", async () => {
    const src = srcFile("fail.mkv", Buffer.alloc(64));
    const run = async (i, o, op) => { fs.writeFileSync(o + ".tmp", "partial"); throw new Error("ffmpeg blew up"); };
    const r = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "fail.mkv", container: "mp4", audioCodec: "aac" }, { run });
    assert.equal(r.ok, false);
    assert.match(r.error, /blew up/);
    const t = at.resolveAudioTranscodeTarget(src, "fail.mkv", "mp4", "aac");
    assert.equal(fs.existsSync(t.cachePath), false);
    assert.equal(fs.existsSync(t.cachePath + ".tmp"), false);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: last-waiter abort kills the job and cleans up", async () => {
    const src = srcFile("abort.mkv", Buffer.alloc(64));
    let killed = false;
    const run = (i, o, op) => new Promise((_, reject) => {
        op.onProcessStart({ exitCode: null, killed: false, kill() { killed = true; this.killed = true; reject(new Error("killed")); } });
        fs.writeFileSync(o + ".tmp", "partial");
    });
    const ac = new AbortController();
    const p = at.ensureAudioTranscode({ sourcePath: src, relativePath: "abort.mkv", container: "mp4", audioCodec: "aac", signal: ac.signal }, { run, timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 25));
    ac.abort();
    const r = await p;
    assert.equal(killed, true);
    assert.equal(r.ok, false);
    const t = at.resolveAudioTranscodeTarget(src, "abort.mkv", "mp4", "aac");
    assert.equal(fs.existsSync(t.cachePath + ".tmp"), false);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: slow request times out but the job keeps running for the next", async () => {
    const src = srcFile("slow.mkv", Buffer.alloc(64));
    const run = async (i, o, op) => { await new Promise(r => setTimeout(r, 120)); fs.writeFileSync(o, "DONE"); };
    const first = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "slow.mkv", container: "mp4", audioCodec: "aac" }, { run, timeoutMs: 40 });
    assert.equal(first.ok, false);
    assert.equal(first.timedOut, true);
    await new Promise(r => setTimeout(r, 150));
    const second = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "slow.mkv", container: "mp4", audioCodec: "aac" }, { run, timeoutMs: 40 });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    fs.rmSync(second.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: a target codec outside Task 6's set is refused, not substituted", async () => {
    const src = srcFile("dts.mkv", Buffer.alloc(64));
    const r = await at.ensureAudioTranscode({ sourcePath: src, relativePath: "dts.mkv", container: "mp4", audioCodec: "dts" }, { run: async () => { throw new Error("should not run"); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /unsupported target audio codec/);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("ensureAudioTranscode: a same-size in-place source edit invalidates the cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-at-edit-"));
    const src = path.join(dir, "m.mkv");
    fs.writeFileSync(src, Buffer.alloc(2048, 1));
    const before = at.resolveAudioTranscodeTarget(src, "m.mkv", "mp4", "aac").key;
    await new Promise(r => setTimeout(r, 15));
    fs.writeFileSync(src, Buffer.alloc(2048, 2));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(src, future, future);
    const after = at.resolveAudioTranscodeTarget(src, "m.mkv", "mp4", "aac").key;
    assert.notEqual(before, after);
    fs.rmSync(dir, { recursive: true, force: true });
});


// ============================================================
// PART B
// ============================================================

test("resolvePlaybackMode: audio_transcode decision carries container + audio codec", async () => {
    integration._clearDecisionCache();
    const r = await integration.resolvePlaybackMode({
        filePath: "/lib/Movie.mkv",
        row: { video_codec: "h264", audio_codec: "ac3" },
        needsTranscode: false,
        clientCapabilities: { video: { h264: true }, audio: { aac: true, ac3: false }, containers: { mp4: true } }
    });
    assert.equal(r.mode, MODES.AUDIO_TRANSCODE);
    assert.equal(r.target, "mp4");
    assert.equal(r.audioCodec, "aac");
});


// ============================================================
// PART C -- real ffmpeg route
// ============================================================

const BASE = "http://127.0.0.1:4000";

function makeMedia(dest, audioCodec) {
    execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=128x72:r=10",
        "-f", "lavfi", "-i", "sine=f=440:d=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", audioCodec || "aac",
        "-shortest", "-y", dest
    ], { stdio: "ignore" });
}
function ffprobeStreams(file) {
    const out = execFileSync("ffprobe", [
        "-v", "error", "-print_format", "json", "-show_streams", file
    ]).toString();
    return JSON.parse(out).streams;
}
function videoStreamMd5(file) {
    return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"])
        .toString().trim();
}
function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(25000) });
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

test("Task 10 route: AUDIO_TRANSCODE executes; Direct Play / Remux still win; video_transcode falls back",
    { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t10-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos", "Show", "S01"), { recursive: true });

    const src = path.join(rt, "videos", "movie.mkv");
    makeMedia(src, "ac3");
    makeMedia(path.join(rt, "videos", "concurrent.mkv"), "ac3");
    makeMedia(path.join(rt, "videos", "Show", "S01", "ep.mkv"), "ac3");
    makeMedia(path.join(rt, "videos", "remuxable.mkv"), "aac");
    makeMedia(path.join(rt, "videos", "dp.mkv"), "aac");
    fs.writeFileSync(path.join(rt, "videos", "broken.mkv"), Buffer.alloc(4000));
    fs.writeFileSync(path.join(rt, "videos", "vt.mkv"), Buffer.alloc(4000));
    fs.writeFileSync(path.join(rt, "secret.txt"), "T10_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    const AXCODE = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };
    const outDir = path.join(rt, "audio_transcoded");

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 60 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 7; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const set = db.prepare("UPDATE videos SET video_codec=?, audio_codec=?, width=128, height=72, needs_transcode=0 WHERE relative_path=?");
        set.run("h264", "ac3", "movie.mkv");
        set.run("h264", "ac3", "concurrent.mkv");
        set.run("h264", "ac3", "broken.mkv");
        set.run("h264", "aac", "remuxable.mkv");
        set.run("h264", "aac", "dp.mkv");
        set.run("hevc", "aac", "vt.mkv");
        const nestedRel = db.prepare("SELECT relative_path FROM videos WHERE relative_path LIKE '%ep.mkv'").get().relative_path;
        set.run("h264", "ac3", nestedRel);
        db.close();

        const isMp4 = (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp";

        await t.test("AUDIO_TRANSCODE -> ffmpeg runs; video copied, audio -> aac, container mp4", async () => {
            const r = await get("/video/movie.mkv", caps(AXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "audio-transcode");
            assert.equal(r.headers.get("x-baseflix-playback-target"), "mp4/aac");
            assert.equal(r.headers.get("content-type"), "video/mp4");
            const body = Buffer.from(await r.arrayBuffer());
            assert.ok(isMp4(body));

            const outFile = fs.readdirSync(outDir).map(f => path.join(outDir, f)).find(f => f.endsWith(".mp4"));
            assert.ok(outFile, "an audio_transcoded/*.mp4 was produced");

            const outStreams = ffprobeStreams(outFile);
            const srcStreams = ffprobeStreams(src);
            const outV = outStreams.find(s => s.codec_type === "video");
            const outA = outStreams.find(s => s.codec_type === "audio");
            const srcA = srcStreams.find(s => s.codec_type === "audio");

            assert.equal(srcA.codec_name, "ac3", "source audio is ac3");
            assert.equal(outA.codec_name, "aac", "output audio was transcoded to aac");
            assert.equal(outV.codec_name, "h264", "output video codec unchanged");
            assert.equal(videoStreamMd5(outFile), videoStreamMd5(src), "video stream is a bit-identical copy");
        });

        await t.test("audio-transcoded output: Range -> 206", async () => {
            const full = Buffer.from(await (await get("/video/movie.mkv", caps(AXCODE))).arrayBuffer());
            const r = await get("/video/movie.mkv", { ...caps(AXCODE), Range: "bytes=10-109" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 10-109/${full.length}`);
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(full.subarray(10, 110)));
        });

        await t.test("audio-transcoded output: unsatisfiable Range -> 416", async () => {
            const r = await get("/video/movie.mkv", { ...caps(AXCODE), Range: "bytes=99999999-" });
            assert.equal(r.status, 416);
            assert.match(r.headers.get("content-range") || "", /^bytes \*\/\d+$/);
        });

        await t.test("completed output is reused (one artefact, identical bytes)", async () => {
            const a = Buffer.from(await (await get("/video/movie.mkv", caps(AXCODE))).arrayBuffer());
            const b = Buffer.from(await (await get("/video/movie.mkv", caps(AXCODE))).arrayBuffer());
            assert.ok(a.equals(b));
            assert.equal(fs.readdirSync(outDir).filter(f => f.endsWith(".mp4")).length, 1);
        });

        await t.test("two simultaneous requests -> one artefact", async () => {
            const before = fs.readdirSync(outDir).length;
            const [r1, r2] = await Promise.all([
                get("/video/concurrent.mkv", caps(AXCODE)),
                get("/video/concurrent.mkv", caps(AXCODE))
            ]);
            assert.equal(r1.status, 200);
            assert.equal(r2.status, 200);
            assert.ok(Buffer.from(await r1.arrayBuffer()).equals(Buffer.from(await r2.arrayBuffer())));
            assert.equal(fs.readdirSync(outDir).length - before, 1);
        });

        await t.test("nested source path", async () => {
            const r = await get("/video/" + encodeURIComponent(nestedRel), caps(AXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "audio-transcode");
            assert.ok(isMp4(Buffer.from(await r.arrayBuffer())));
        });

        await t.test("traversal cannot escape", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt", caps(AXCODE));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T10_SECRET"));
        });

        await t.test("source change invalidates the cache -> a new artefact", async () => {
            const before = fs.readdirSync(outDir).filter(f => f.endsWith(".mp4")).length;
            makeMedia(src, "ac3");   // rewrite: new content + new mtime
            const r = await get("/video/movie.mkv", caps(AXCODE));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "audio-transcode");
            assert.equal(fs.readdirSync(outDir).filter(f => f.endsWith(".mp4")).length, before + 1);
        });

        await t.test("ffmpeg failure -> safe fallback, no partial, not reported as audio-transcode", async () => {
            const r = await get("/video/broken.mkv", caps(AXCODE));
            assert.equal(r.status, 200);   // nt=0 fallback serves the original
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            const tgt = at.resolveAudioTranscodeTarget(path.join(rt, "videos", "broken.mkv"), "broken.mkv", "mp4", "aac");
            assert.equal(fs.existsSync(tgt.cachePath), false);
            assert.equal(fs.existsSync(tgt.cachePath + ".tmp"), false);
        });

        await t.test("Direct Play still wins", async () => {
            const r = await get("/video/dp.mkv", caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } }));
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.equal(r.headers.get("content-type"), "video/x-matroska");
        });

        await t.test("Remux still wins over Audio Transcode", async () => {
            const r = await get("/video/remuxable.mkv", caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
        });

        await t.test("video_transcode decision does NOT execute audio transcode", async () => {
            const r = await get("/video/vt.mkv", caps({ video: { h264: true, hevc: false }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
        });

        await t.test("client disconnect during an audio-transcode request does not crash the server", async () => {
            const ac = new AbortController();
            const pending = fetch(BASE + "/video/" + encodeURIComponent(nestedRel), { headers: caps(AXCODE), signal: ac.signal }).catch(() => null);
            setTimeout(() => ac.abort(), 5);
            await pending;
            assert.equal((await get("/api/videos")).status, 200);
        });

        await t.test("regression: Task 2 + Task 3 + Task 9 still hold", async () => {
            assert.equal((await get("/video/..%2F..%2Fsecret.txt")).status, 404);
            const rr = await get("/video/movie.mkv", { ...caps(AXCODE), Range: "bytes=-16" });
            assert.equal(rr.status, 206);
            const rx = await get("/video/remuxable.mkv", caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(rx.headers.get("x-baseflix-playback"), "remux");
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
