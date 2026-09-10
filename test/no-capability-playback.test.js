"use strict";

/*
    No-Capability Playback Regression tests (Task 14).

    Regression: on `feature/playback`, a browser request carries no
    `X-Baseflix-Client-Capabilities` header, so resolvePlaybackMode()
    fell to the conservative VIDEO_TRANSCODE mode for EVERY file --
    including h264/aac files the scanner had already cleared
    (needs_transcode = 0). Since Task 12 wired an executor to that mode,
    the /video request launched a full FFmpeg re-encode and stalled
    playback ~45s before falling through to a direct serve.

    Fix (playback-integration.js only): when needs_transcode === 0 AND
    the caller supplied NO capability object (clientCapabilities ===
    undefined), route straight to Direct Play.

    Part A -- unit: resolvePlaybackMode() boundary behaviour for
      Cases A / B / C (+ the "an actual object stays conservative"
      contract).
    Part B -- route: real `node server.js` + real ffmpeg. A real,
      decodable h264/aac file with needs_transcode = 0 and NO
      capability header is served immediately via Direct Play, FFmpeg
      is never invoked, and Range / containment / 416 still hold.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));
const APP_FILES = require("./_app-files");

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }

const ROW_H264_AAC = { video_codec: "h264", audio_codec: "aac", width: 1280, height: 534 };
const CAPS_MP4_ONLY = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };
const CAPS_ALL = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } };


// ============================================================
// PART A -- resolvePlaybackMode() boundary
// ============================================================

test("A/unit: needs_transcode=0 + NO capability object -> DIRECT_PLAY, no ffprobe", async () => {
    integration._clearDecisionCache();
    let probed = false;
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: ROW_H264_AAC, needsTranscode: false, clientCapabilities: undefined },
        { describe: async () => { probed = true; return { ok: false }; } }
    );
    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.basis, "lightweight");
    assert.equal(r.target, null);
    assert.equal(r.videoCodec, null);
    assert.equal(r.audioCodec, null);
    assert.equal(probed, false, "the no-capability fast-path must not run ffprobe");
});

test("B/unit: needs_transcode=0 + supplied capabilities -> capability decision is NOT bypassed", async () => {
    integration._clearDecisionCache();

    // mp4 container + mp4-capable client -> DIRECT_PLAY
    const mp4 = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mp4", row: ROW_H264_AAC, needsTranscode: false, clientCapabilities: CAPS_MP4_ONLY });
    assert.equal(mp4.mode, MODES.DIRECT_PLAY);

    // mkv container + mp4-only client -> REMUX (capability engine still in charge)
    const mkv = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: ROW_H264_AAC, needsTranscode: false, clientCapabilities: CAPS_MP4_ONLY });
    assert.equal(mkv.mode, MODES.REMUX);
    assert.equal(mkv.target, "mp4");
});

test("MKV -> MP4 remux for an MP4-only client still works (needs_transcode=0)", async () => {
    integration._clearDecisionCache();
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/show.mkv", row: ROW_H264_AAC, needsTranscode: false, clientCapabilities: CAPS_MP4_ONLY });
    assert.equal(r.mode, MODES.REMUX);
    assert.equal(r.target, "mp4");
});

test("C/unit: needs_transcode=1 + NO capabilities -> fast-path does NOT apply (unchanged)", async () => {
    integration._clearDecisionCache();

    // A flagged file with no capabilities: the conservative lightweight
    // decision (VIDEO_TRANSCODE) passes straight through exactly as
    // before Task 14 -- the no-capability Direct Play shortcut is gated
    // on needs_transcode === 0 and must never fire here.
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/x.mkv", row: { video_codec: "hevc", audio_codec: "aac" }, needsTranscode: true, clientCapabilities: undefined },
        { describe: async () => ({ ok: false, error: "probe_failed" }) });
    assert.notEqual(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);

    // And a flagged file whose lightweight guess IS Direct Play is still
    // re-checked by a full ffprobe before it can be trusted (probe
    // unusable here -> not Direct Play), never fast-pathed.
    const guess = await integration.resolvePlaybackMode(
        { filePath: "/lib/y.mp4", row: ROW_H264_AAC, needsTranscode: true, clientCapabilities: CAPS_MP4_ONLY },
        { describe: async () => ({ ok: false, error: "probe_failed" }) });
    assert.equal(guess.basis, "full-probe", "flagged DIRECT_PLAY guess goes through the full ffprobe re-check");
    assert.notEqual(guess.mode, MODES.DIRECT_PLAY);
});

test("contract: an ACTUAL capability object (even empty / malformed) stays on the conservative path", async () => {
    integration._clearDecisionCache();
    for (const supplied of [{}, { video: "x" }, [], "garbage", 5, null]) {
        const r = await integration.resolvePlaybackMode(
            { filePath: "/lib/movie.mkv", row: ROW_H264_AAC, needsTranscode: false, clientCapabilities: supplied });
        assert.notEqual(r.mode, MODES.DIRECT_PLAY, JSON.stringify(supplied));
    }
});


// ============================================================
// PART B -- real server + real ffmpeg
// ============================================================

const BASE = "http://127.0.0.1:4000";

function makeMedia(dest) {
    execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=160x90:r=12",
        "-f", "lavfi", "-i", "sine=f=300:d=2",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest",
        "-y", dest
    ], { stdio: "ignore" });
}
function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(30000) });
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

test("Task 14 route: real h264/aac + needs_transcode=0 + NO caps -> instant Direct Play, FFmpeg never invoked",
    { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t14-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos", "Movies"), { recursive: true });

    makeMedia(path.join(rt, "videos", "native.mp4"));
    makeMedia(path.join(rt, "videos", "Movies", "native.mkv"));
    fs.writeFileSync(path.join(rt, "secret.txt"), "T14_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    const transcodedDir = path.join(rt, "transcoded");
    const remuxedDir = path.join(rt, "remuxed");
    const derivedCount = () =>
        (fs.existsSync(transcodedDir) ? fs.readdirSync(transcodedDir).filter(f => f.startsWith("vt-") || f.endsWith(".tmp")).length : 0) +
        (fs.existsSync(remuxedDir) ? fs.readdirSync(remuxedDir).length : 0);

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 60 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 2; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const set = db.prepare("UPDATE videos SET video_codec='h264', audio_codec='aac', width=160, height=90, needs_transcode=0 WHERE relative_path=?");
        set.run("native.mp4");
        const mkvRel = db.prepare("SELECT relative_path FROM videos WHERE relative_path LIKE '%native.mkv'").get().relative_path;
        set.run(mkvRel);
        db.close();

        const before = derivedCount();

        await t.test("1+2+4: no header -> direct-play, fast, original bytes, no transcode artefact", async () => {
            const t0 = Date.now();
            const r = await get("/video/native.mp4");
            const elapsed = Date.now() - t0;

            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.equal(r.headers.get("content-type"), "video/mp4");
            assert.ok(elapsed < 5000, `served in ${elapsed}ms (must not wait on a 45s transcode)`);

            const body = Buffer.from(await r.arrayBuffer());
            const original = fs.readFileSync(path.join(rt, "videos", "native.mp4"));
            assert.ok(body.equals(original), "original bytes, unmodified");

            assert.equal(derivedCount(), before, "no remux / video-transcode artefact was produced");
        });

        await t.test("2: no ffmpeg child process was spawned for the request", async () => {
            // one more no-caps request, then confirm still no artefacts and
            // the server is responsive (would be blocked mid-transcode otherwise)
            await get("/video/" + encodeURIComponent(mkvRel));
            assert.equal(derivedCount(), before);
            assert.equal((await get("/api/videos")).status, 200);
        });

        await t.test("3+9: Range on the no-caps Direct Play path -> 206 exact bytes; unsatisfiable -> 416", async () => {
            const original = fs.readFileSync(path.join(rt, "videos", "native.mp4"));
            const r206 = await get("/video/native.mp4", { Range: "bytes=100-199" });
            assert.equal(r206.status, 206);
            assert.equal(r206.headers.get("content-range"), `bytes 100-199/${original.length}`);
            assert.ok(Buffer.from(await r206.arrayBuffer()).equals(original.subarray(100, 200)));

            const r416 = await get("/video/native.mp4", { Range: "bytes=99999999-" });
            assert.equal(r416.status, 416);
            assert.match(r416.headers.get("content-range") || "", /^bytes \*\/\d+$/);
        });

        await t.test("5+6: a client that DOES report caps still gets the capability decision", async () => {
            const capHeader = (o) => ({ "x-baseflix-client-capabilities": Buffer.from(JSON.stringify(o)).toString("base64") });

            const dp = await get("/video/native.mp4", capHeader(CAPS_MP4_ONLY));
            assert.equal(dp.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);

            const remux = await get("/video/" + encodeURIComponent(mkvRel), capHeader(CAPS_MP4_ONLY));
            assert.equal(remux.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
        });

        await t.test("8: Task 2 containment intact with and without a selection query", async () => {
            const a = await get("/video/..%2F..%2Fsecret.txt");
            assert.equal(a.status, 404);
            assert.ok(!(await a.text()).includes("T14_SECRET"));
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
