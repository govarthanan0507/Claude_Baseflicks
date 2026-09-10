"use strict";

/*
    Direct Play execution integration tests (Task 8).

    Part A -- unit: playback-integration.resolvePlaybackMode(), the
      gate that decides whether /video routes onto serveDirectPlay().
    Part B -- route: a real `node server.js` in an isolated runtime,
      asserting that ONLY an explicit DIRECT_PLAY decision reaches the
      direct byte-streaming path, that REMUX / AUDIO_TRANSCODE /
      VIDEO_TRANSCODE decisions fall back to the pre-existing
      behaviour (no new execution), and that Task 2 / Task 3 still hold.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));


// ============================================================
// PART A -- resolvePlaybackMode() gate
// ============================================================

const FULL = {
    video: { h264: true, hevc: true }, audio: { aac: true, ac3: true },
    containers: { mp4: true, mkv: true }
};

function tmpFile(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-dpe-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes || Buffer.alloc(64));
    return p;
}

test("gate: needs_transcode=0 + DIRECT_PLAY decision -> direct_play (lightweight, no ffprobe)", async () => {
    integration._clearDecisionCache();
    const r = await integration.resolvePlaybackMode({
        filePath: "/lib/a.mp4",
        row: { video_codec: "h264", audio_codec: "aac", width: 1920, height: 1080 },
        needsTranscode: false,
        clientCapabilities: FULL
    });
    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.basis, "lightweight");
    assert.equal(r.target, null);
});

test("gate: needs_transcode=0 + missing capabilities -> NOT direct_play (conservative)", async () => {
    const r = await integration.resolvePlaybackMode({
        filePath: "/lib/a.mp4",
        row: { video_codec: "h264", audio_codec: "aac" },
        needsTranscode: false,
        clientCapabilities: undefined
    });
    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.notEqual(r.mode, MODES.DIRECT_PLAY);
});

test("gate: needs_transcode=0 + malformed capabilities -> NOT direct_play, no throw", async () => {
    for (const bad of [null, "garbage", 5, [], { video: "x" }]) {
        const r = await integration.resolvePlaybackMode({
            filePath: "/lib/a.mp4",
            row: { video_codec: "h264", audio_codec: "aac" },
            needsTranscode: false,
            clientCapabilities: bad
        });
        assert.notEqual(r.mode, MODES.DIRECT_PLAY, JSON.stringify(bad));
    }
});

test("gate: needs_transcode=1 + DIRECT_PLAY(lightweight) -> confirmed by a full ffprobe", async () => {
    integration._clearDecisionCache();
    const file = tmpFile("a.mkv");

    const cleanProbe = async () => ({
        ok: true, file: { path: file, size: 64 },
        container: { format: "matroska,webm" },
        video: [{ index: 0, codec: "hevc", profile: "Main", width: 1920, height: 1080, pixelFormat: "yuv420p" }],
        audio: [{ index: 1, codec: "ac3", channels: 6 }],
        subtitles: []
    });

    const r = await integration.resolvePlaybackMode(
        { filePath: file, row: { video_codec: "hevc", audio_codec: "ac3" }, needsTranscode: true, clientCapabilities: FULL },
        { describe: cleanProbe }
    );
    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.basis, "full-probe");

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("gate: needs_transcode=1 + full ffprobe reveals 10-bit -> downgraded, NOT direct_play", async () => {
    integration._clearDecisionCache();
    const file = tmpFile("b.mkv");

    const tenBit = async () => ({
        ok: true, file: { path: file, size: 64 },
        container: { format: "matroska,webm" },
        video: [{ index: 0, codec: "hevc", profile: "Main 10", width: 1920, height: 1080, pixelFormat: "yuv420p10le" }],
        audio: [{ index: 1, codec: "ac3", channels: 6 }],
        subtitles: []
    });

    const r = await integration.resolvePlaybackMode(
        { filePath: file, row: { video_codec: "hevc", audio_codec: "ac3" }, needsTranscode: true, clientCapabilities: FULL },
        { describe: tenBit }
    );
    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.equal(r.basis, "full-probe");

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("gate: needs_transcode=1 + ffprobe failure -> fallback, never claims direct_play", async () => {
    integration._clearDecisionCache();
    const file = tmpFile("c.mkv");
    const r = await integration.resolvePlaybackMode(
        { filePath: file, row: { video_codec: "hevc", audio_codec: "ac3" }, needsTranscode: true, clientCapabilities: FULL },
        { describe: async () => { throw new Error("ffprobe not found"); } }
    );
    assert.equal(r.mode, null);
    assert.equal(r.basis, "fallback");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("gate: full-probe result is cached (no repeated ffprobe during seeking)", async () => {
    integration._clearDecisionCache();
    const file = tmpFile("d.mkv");
    let calls = 0;
    const counting = async () => {
        calls++;
        return { ok: true, file: { path: file, size: 64 }, container: { format: "matroska,webm" },
            video: [{ index: 0, codec: "hevc", profile: "Main", width: 1280, height: 720, pixelFormat: "yuv420p" }],
            audio: [{ index: 1, codec: "ac3", channels: 6 }], subtitles: [] };
    };
    const params = { filePath: file, row: { video_codec: "hevc", audio_codec: "ac3" }, needsTranscode: true, clientCapabilities: FULL };
    await integration.resolvePlaybackMode(params, { describe: counting });
    const second = await integration.resolvePlaybackMode(params, { describe: counting });
    assert.equal(calls, 1);
    assert.equal(second.cached, true);
    assert.equal(second.mode, MODES.DIRECT_PLAY);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("gate: non-DIRECT_PLAY lightweight decisions pass straight through (no ffprobe)", async () => {
    integration._clearDecisionCache();
    let called = false;
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/a.mkv", row: { video_codec: "h264", audio_codec: "aac" }, needsTranscode: true,
          clientCapabilities: Object.assign({}, FULL, { containers: { mp4: true, mkv: false } }) },
        { describe: async () => { called = true; return { ok: false }; } }
    );
    assert.equal(r.mode, MODES.REMUX);
    assert.equal(r.basis, "lightweight");
    assert.equal(called, false);
});


// ============================================================
// PART B -- /video route
// ============================================================

const APP_FILES = require("./_app-files");

const BASE = "http://127.0.0.1:4000";
const CLIP = Buffer.alloc(6000);
for (let i = 0; i < CLIP.length; i++) CLIP[i] = (i * 7) & 0xff;
const MKV = Buffer.alloc(5000);
for (let i = 0; i < MKV.length; i++) MKV[i] = (i * 3 + 1) & 0xff;

function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(5000) });
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

test("Task 8 route: DIRECT_PLAY decision controls /video; other modes fall back", async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t8-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos", "Show", "S01"), { recursive: true });
    fs.writeFileSync(path.join(rt, "videos", "clip.mp4"), CLIP);
    fs.writeFileSync(path.join(rt, "videos", "ac3clip.mp4"), CLIP);
    fs.writeFileSync(path.join(rt, "videos", "hevcclip.mp4"), CLIP);
    fs.writeFileSync(path.join(rt, "videos", "movie.mkv"), MKV);
    fs.writeFileSync(path.join(rt, "videos", "Show", "S01", "ep.mp4"), CLIP);
    fs.writeFileSync(path.join(rt, "secret.txt"), "T8_PARENT_SECRET");

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
        for (let i = 0; i < 40 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 5; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        // Give rows deterministic codecs. All needs_transcode = 0 so the
        // *existing* fallback for every one of them is a direct serve of
        // the original -- which lets us prove Task 8 changed the ROUTING
        // (headers + which branch) without changing bytes, and that no
        // remux/transcode is executed.
        const set = db.prepare("UPDATE videos SET video_codec=?, audio_codec=?, width=1280, height=720, needs_transcode=0 WHERE relative_path=?");
        set.run("h264", "aac", "clip.mp4");
        set.run("h264", "ac3", "ac3clip.mp4");
        set.run("hevc", "aac", "hevcclip.mp4");
        set.run("h264", "aac", "movie.mkv");
        // the scanner decides the separator style for nested paths
        const nestedRel = db.prepare("SELECT relative_path FROM videos WHERE relative_path LIKE '%ep.mp4'").get().relative_path;
        set.run("h264", "aac", nestedRel);
        db.close();

        const MP4_CAPS = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };
        const MKV_CAPS = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } };

        // ---- explicit Direct Play ----
        await t.test("explicit DIRECT_PLAY -> original file served via direct path", async () => {
            const r = await get("/video/clip.mp4", caps(MP4_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.equal(r.headers.get("content-type"), "video/mp4");
            assert.equal(r.headers.get("accept-ranges"), "bytes");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));
        });

        await t.test("DIRECT_PLAY with Range -> 206 + exact bytes", async () => {
            const r = await get("/video/clip.mp4", { ...caps(MP4_CAPS), Range: "bytes=100-199" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.equal(r.headers.get("content-range"), `bytes 100-199/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), "100");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP.subarray(100, 200)));
        });

        await t.test("DIRECT_PLAY unsatisfiable Range -> 416", async () => {
            const r = await get("/video/clip.mp4", { ...caps(MP4_CAPS), Range: "bytes=999999-" });
            assert.equal(r.status, 416);
            assert.equal(r.headers.get("content-range"), `bytes */${CLIP.length}`);
        });

        await t.test("DIRECT_PLAY correct MIME for .mkv (video/x-matroska)", async () => {
            const r = await get("/video/movie.mkv", caps(MKV_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.equal(r.headers.get("content-type"), "video/x-matroska");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(MKV));
        });

        await t.test("DIRECT_PLAY nested media path", async () => {
            const r = await get("/video/" + encodeURIComponent(nestedRel), caps(MP4_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));
        });

        await t.test("DIRECT_PLAY: traversal still blocked (Task 2)", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt", caps(MKV_CAPS));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T8_PARENT_SECRET"));
            assert.equal(r.headers.get("x-baseflix-playback"), null);
        });

        // ---- conservative: no / bad caps must NOT claim Direct Play ----
        await t.test("missing capabilities -> NOT direct-play, existing fallback still serves", async () => {
            const r = await get("/video/clip.mp4");
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));
        });

        await t.test("malformed capabilities -> NOT direct-play, no crash", async () => {
            const r = await get("/video/clip.mp4", { "x-baseflix-client-capabilities": "}{ not json" });
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));
        });

        // ---- other modes must NOT execute ----
        await t.test("REMUX decision does not execute Remux (mkv served as-is, not repackaged)", async () => {
            const r = await get("/video/movie.mkv", caps(MP4_CAPS));   // mkv not in caps
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            assert.equal(r.headers.get("content-type"), "video/x-matroska");   // NOT video/mp4
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(MKV));         // original bytes
        });

        await t.test("AUDIO_TRANSCODE decision does not execute (audio untouched)", async () => {
            const r = await get("/video/ac3clip.mp4", caps({ video: { h264: true }, audio: { aac: true, ac3: false }, containers: { mp4: true } }));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));   // original, ac3 not re-encoded
        });

        await t.test("VIDEO_TRANSCODE decision does not execute (needs_transcode=0 file served as-is)", async () => {
            const r = await get("/video/hevcclip.mp4", caps({ video: { h264: true, hevc: false }, audio: { aac: true }, containers: { mp4: true } }));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "fallback");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));
        });

        // ---- regressions ----
        await t.test("existing fallback behaviour intact: /watch serves + blocks traversal", async () => {
            assert.equal((await get("/watch/clip.mp4")).status, 200);
            assert.equal((await get("/watch/..%2F..%2Fsecret.txt")).status, 404);
        });

        await t.test("Task 3 regression: fallback-served file keeps full Range semantics", async () => {
            const r206 = await get("/video/clip.mp4", { Range: "bytes=-50" });   // suffix, no caps -> fallback
            assert.equal(r206.status, 206);
            assert.equal(r206.headers.get("content-range"), `bytes ${CLIP.length - 50}-${CLIP.length - 1}/${CLIP.length}`);
            assert.ok(Buffer.from(await r206.arrayBuffer()).equals(CLIP.subarray(CLIP.length - 50)));

            const r200 = await get("/video/clip.mp4", { Range: "bytes=0-10,20-30" });   // multi-range -> 200
            assert.equal(r200.status, 200);
            assert.equal(r200.headers.get("content-range"), null);
        });

        await t.test("chain: probe(row) -> capabilities -> decidePlayback -> Task7 boundary -> Task8 gate", async () => {
            // same file, three capability inputs, three routed outcomes
            const none = await get("/video/movie.mkv");
            const mp4only = await get("/video/movie.mkv", caps(MP4_CAPS));
            const withMkv = await get("/video/movie.mkv", caps(MKV_CAPS));
            assert.deepEqual(
                [none.headers.get("x-baseflix-playback"), mp4only.headers.get("x-baseflix-playback"), withMkv.headers.get("x-baseflix-playback")],
                ["fallback", "fallback", "direct-play"]
            );
            assert.deepEqual(
                [none.headers.get("x-baseflix-playback-mode"), mp4only.headers.get("x-baseflix-playback-mode"), withMkv.headers.get("x-baseflix-playback-mode")],
                [MODES.VIDEO_TRANSCODE, MODES.REMUX, MODES.DIRECT_PLAY]
            );
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
