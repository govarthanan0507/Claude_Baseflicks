"use strict";

/*
    ============================================================
    TASK 15 -- FINAL PLAYBACK ACCEPTANCE (consolidated matrix +
    hierarchy-precedence regression)
    ============================================================

    Tasks 1-14 already have per-task suites (direct-play-*,
    remux-execution, audio-transcode-execution, video-transcode-
    execution, audio-subtitle-handling, media-path-containment,
    no-capability-playback, ...). This file does NOT re-prove what
    those already prove exhaustively (cache identity, waiter/abort
    lifecycle, per-mode HTTP hardening, Task 13 stream selection,
    Task 14's undefined-header fast path). It proves the ONE thing no
    existing suite proves directly: that the full

        DIRECT_PLAY -> REMUX -> AUDIO_TRANSCODE -> VIDEO_TRANSCODE

    hierarchy holds end-to-end, on the SAME source file, as client
    capability support is withdrawn one rung at a time, with a real
    server and real ffmpeg -- and that at every rung, every
    LOWER-priority executor produced zero artefacts.

    Fixture: one h264 (video) + ac3 (audio) file inside an .mkv
    container. mp4 can carry both h264 and ac3 without re-encoding, so
    the same source can legitimately land on any of the four modes
    depending only on what the client claims to support:

      rung 1  containers:{mkv}          video:{h264}          audio:{ac3}         -> DIRECT_PLAY
      rung 2  containers:{mp4}          video:{h264}          audio:{ac3}         -> REMUX        (mkv unsupported; copy into mp4)
      rung 3  containers:{mp4}          video:{h264}          audio:{ac3:false,aac} -> AUDIO_TRANSCODE (ac3 now refused; copy video, re-encode audio)
      rung 4  containers:{mp4}          video:{h264:false}    audio:{aac}         -> VIDEO_TRANSCODE (video now refused; universal fallback)
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));
const APP_FILES = require("./_app-files");

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }

const BASE = "http://127.0.0.1:4000";

function makeMedia(dest) {
    execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=160x90:r=12",
        "-f", "lavfi", "-i", "sine=f=440:d=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "ac3", "-shortest",
        "-y", dest
    ], { stdio: "ignore" });
}

function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(30000) });
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
function countFiles(dir, pred) {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(pred || (() => true)).length;
}
function probeStreams(file) {
    return JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file]).toString()
    ).streams;
}
function probeFormat(file) {
    return JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", file]).toString()
    ).format;
}


test("TASK 15: DIRECT_PLAY > REMUX > AUDIO_TRANSCODE > VIDEO_TRANSCODE -- one fixture, four capability rungs",
    { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t15-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos"), { recursive: true });

    makeMedia(path.join(rt, "videos", "ladder.mkv"));
    fs.writeFileSync(path.join(rt, "secret.txt"), "T15_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    const remuxedDir = path.join(rt, "remuxed");
    const audioDir = path.join(rt, "audio_transcoded");
    const videoDir = path.join(rt, "transcoded");
    const vtOnly = f => f.startsWith("vt-") && !f.endsWith(".tmp");

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 60 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 1; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        db.prepare(
            "UPDATE videos SET video_codec='h264', audio_codec='ac3', width=160, height=90, needs_transcode=0 WHERE relative_path='ladder.mkv'"
        ).run();
        db.close();

        // ---- rung 1/4 -- DIRECT_PLAY ------------------------------
        await t.test("rung 1/4 DIRECT_PLAY: mkv + h264 + ac3 all client-supported", async () => {
            const caps = { containers: { mkv: true }, video: { h264: true }, audio: { ac3: true } };

            const r = await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.equal(r.headers.get("content-type"), "video/x-matroska");
            assert.equal(r.headers.get("accept-ranges"), "bytes");

            const original = fs.readFileSync(path.join(rt, "videos", "ladder.mkv"));
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(original), "original bytes served verbatim -- no artefact substituted");

            const range = await get("/video/ladder.mkv", { ...capsHeader(caps), Range: "bytes=0-49" });
            assert.equal(range.status, 206, "Range still works on the direct-play path");
            assert.equal(range.headers.get("content-length"), "50");

            const bad = await get("/video/ladder.mkv", { ...capsHeader(caps), Range: "bytes=99999999-" });
            assert.equal(bad.status, 416, "unsatisfiable Range still returns 416");
            assert.match(bad.headers.get("content-range") || "", /^bytes \*\/\d+$/);

            assert.equal(countFiles(remuxedDir), 0, "REMUX must NOT run when Direct Play is possible");
            assert.equal(countFiles(audioDir), 0, "AUDIO_TRANSCODE must NOT run when Direct Play is possible");
            assert.equal(countFiles(videoDir, vtOnly), 0, "VIDEO_TRANSCODE must NOT run when Direct Play is possible");
        });

        // ---- rung 2/4 -- REMUX -------------------------------------
        await t.test("rung 2/4 REMUX: same file, mkv support withdrawn, mp4 offered", async () => {
            const caps = { containers: { mp4: true }, video: { h264: true }, audio: { ac3: true } };

            const r = await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.equal(r.headers.get("x-baseflix-playback-target"), "mp4");
            assert.equal(r.headers.get("content-type"), "video/mp4");

            assert.equal(countFiles(remuxedDir), 1, "exactly one remux artefact produced");
            assert.equal(countFiles(remuxedDir, f => f.endsWith(".tmp")), 0, "remux finalised atomically -- no .tmp left");
            assert.equal(countFiles(audioDir), 0, "AUDIO_TRANSCODE must NOT run when Remux is possible");
            assert.equal(countFiles(videoDir, vtOnly), 0, "VIDEO_TRANSCODE must NOT run when Remux is possible");

            const out = path.join(remuxedDir, fs.readdirSync(remuxedDir)[0]);
            const streams = probeStreams(out);
            assert.equal(streams.find(s => s.codec_type === "video").codec_name, "h264", "video stream-copied, not re-encoded");
            assert.equal(streams.find(s => s.codec_type === "audio").codec_name, "ac3", "audio stream-copied, not re-encoded");

            // cache reuse: a second identical request must not add a file
            const again = await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(again.status, 200);
            assert.equal(countFiles(remuxedDir), 1, "second request reused the cached remux, no second job");

            // Range on the remuxed output
            const full = Buffer.from(await (await get("/video/ladder.mkv", capsHeader(caps))).arrayBuffer());
            const range = await get("/video/ladder.mkv", { ...capsHeader(caps), Range: "bytes=0-19" });
            assert.equal(range.status, 206);
            assert.ok(Buffer.from(await range.arrayBuffer()).equals(full.subarray(0, 20)));
        });

        // ---- rung 3/4 -- AUDIO_TRANSCODE ----------------------------
        await t.test("rung 3/4 AUDIO_TRANSCODE: same file, ac3 refused, aac offered", async () => {
            const caps = { containers: { mp4: true }, video: { h264: true }, audio: { ac3: false, aac: true } };

            const r = await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "audio-transcode");
            assert.equal(r.headers.get("x-baseflix-playback-target"), "mp4/aac");

            assert.equal(countFiles(audioDir), 1, "exactly one audio-transcode artefact produced");
            assert.equal(countFiles(audioDir, f => f.endsWith(".tmp")), 0, "audio transcode finalised atomically -- no .tmp left");
            assert.equal(countFiles(videoDir, vtOnly), 0, "VIDEO_TRANSCODE must NOT run when Audio Transcode is possible");

            const out = path.join(audioDir, fs.readdirSync(audioDir)[0]);
            const streams = probeStreams(out);
            assert.equal(streams.find(s => s.codec_type === "video").codec_name, "h264", "video remains copied, not re-encoded");
            assert.equal(streams.find(s => s.codec_type === "audio").codec_name, "aac", "audio re-encoded to the Task 6 target codec");

            // cache reuse
            await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(countFiles(audioDir), 1, "second request reused the cached audio-transcode");
        });

        // ---- rung 4/4 -- VIDEO_TRANSCODE ----------------------------
        await t.test("rung 4/4 VIDEO_TRANSCODE: same file, h264 also refused -> universal fallback", async () => {
            const caps = { containers: { mp4: true }, video: { h264: false }, audio: { aac: true } };

            const r = await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "video-transcode");
            assert.equal(r.headers.get("x-baseflix-playback-target"), "mp4/h264/aac");

            const vtFiles = fs.readdirSync(videoDir).filter(vtOnly);
            assert.equal(vtFiles.length, 1, "exactly one video-transcode artefact produced");
            assert.equal(countFiles(videoDir, f => f.startsWith("vt-") && f.endsWith(".tmp")), 0, "video transcode finalised atomically -- no .tmp left");

            const out = path.join(videoDir, vtFiles[0]);
            const streams = probeStreams(out);
            assert.equal(streams.find(s => s.codec_type === "video").codec_name, "h264", "output video codec matches the Task 6 target");
            assert.equal(streams.find(s => s.codec_type === "audio").codec_name, "aac", "output audio codec matches the Task 6 target");
            assert.match(probeFormat(out).format_name, /mp4/, "output container matches the Task 6 target");

            // cache reuse
            await get("/video/ladder.mkv", capsHeader(caps));
            assert.equal(fs.readdirSync(videoDir).filter(vtOnly).length, 1, "second request reused the cached video-transcode");
        });

        await t.test("regression: media-root containment still holds after all four rungs ran", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T15_SECRET"));
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
