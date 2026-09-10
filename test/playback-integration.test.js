"use strict";

/*
    Playback decision integration boundary tests (Task 7).

    Layer 1 (unit) -- playback-integration.js orchestration only:
      readClientCapabilities / buildLightweightProbe /
      decideFromLibraryRow / probeAndDecide / summarizeProbe.
      Each of the four playback modes is shown reaching the boundary.

    Layer 2 (route) -- a real `node server.js` booted in an isolated
      runtime dir:
        * POST /api/playback/decision  -- the capability intake + the
          diagnostic boundary (containment, 404s, 400, no-crash).
        * GET /video/:filename         -- the advisory
          X-Baseflix-Playback-Mode header, driven end-to-end by the
          Task 4->5->6 chain, WITHOUT changing how bytes are served
          (Task 2 containment + Task 3 range still verified).
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
// LAYER 1 -- unit
// ============================================================

test("readClientCapabilities: header JSON / header base64 / query / junk", () => {

    const caps = { video: { h264: true } };
    const json = JSON.stringify(caps);
    const b64 = Buffer.from(json).toString("base64");

    assert.deepEqual(
        integration.readClientCapabilities({ headers: { "x-baseflix-client-capabilities": json } }),
        caps
    );
    assert.deepEqual(
        integration.readClientCapabilities({ headers: { "x-baseflix-client-capabilities": b64 } }),
        caps
    );
    assert.deepEqual(
        integration.readClientCapabilities({ headers: {}, query: { caps: json } }),
        caps
    );

    assert.equal(integration.readClientCapabilities({ headers: {} }), undefined);
    assert.equal(integration.readClientCapabilities({ headers: { "x-baseflix-client-capabilities": "not json !!" } }), undefined);
    assert.equal(integration.readClientCapabilities({ headers: { "x-baseflix-client-capabilities": "x".repeat(50000) } }), undefined);
    assert.equal(integration.readClientCapabilities(null), undefined);
});

test("buildLightweightProbe: media-probe-shaped, degraded, from scanner columns", () => {

    const probe = integration.buildLightweightProbe("/library/Movie.mkv", {
        video_codec: "h264", audio_codec: "aac", width: 1920, height: 1080, size: 12345
    });

    assert.equal(probe.ok, true);
    assert.equal(probe.degraded, true);
    assert.equal(probe.file.path, "/library/Movie.mkv");
    assert.equal(probe.file.size, 12345);
    assert.equal(probe.video.length, 1);
    assert.deepEqual(
        { c: probe.video[0].codec, w: probe.video[0].width, h: probe.video[0].height, p: probe.video[0].profile },
        { c: "h264", w: 1920, h: 1080, p: null }
    );
    assert.equal(probe.audio.length, 1);
    assert.equal(probe.audio[0].codec, "aac");

    // no codecs stored yet -> not usable
    const empty = integration.buildLightweightProbe("/x.mp4", { video_codec: null, audio_codec: null });
    assert.equal(empty.ok, false);

    // no row at all -> not usable, no throw
    assert.equal(integration.buildLightweightProbe("/x.mp4", null).ok, false);
});

test("decideFromLibraryRow: each of the four modes reaches the boundary", () => {

    const FULL = {
        video: { h264: true, hevc: true }, audio: { aac: true, ac3: true },
        containers: { mp4: true, webm: true, mkv: true }
    };

    // DIRECT_PLAY  -- mp4 + h264 + aac, all supported
    assert.equal(
        integration.decideFromLibraryRow("/lib/a.mp4", { video_codec: "h264", audio_codec: "aac", width: 1280, height: 720 }, FULL).mode,
        MODES.DIRECT_PLAY
    );

    // REMUX  -- mkv container not supported, streams are
    assert.equal(
        integration.decideFromLibraryRow("/lib/a.mkv", { video_codec: "h264", audio_codec: "aac" }, Object.assign({}, FULL, { containers: { mp4: true, mkv: false } })).mode,
        MODES.REMUX
    );

    // AUDIO_TRANSCODE  -- mp4 + h264 ok, ac3 not supported
    assert.equal(
        integration.decideFromLibraryRow("/lib/a.mp4", { video_codec: "h264", audio_codec: "ac3" }, Object.assign({}, FULL, { audio: { aac: true, ac3: false } })).mode,
        MODES.AUDIO_TRANSCODE
    );

    // VIDEO_TRANSCODE  -- hevc not supported
    assert.equal(
        integration.decideFromLibraryRow("/lib/a.mp4", { video_codec: "hevc", audio_codec: "aac" }, Object.assign({}, FULL, { video: { h264: true, hevc: false } })).mode,
        MODES.VIDEO_TRANSCODE
    );
});

test("decideFromLibraryRow: missing capabilities -> conservative video_transcode", () => {

    const r = integration.decideFromLibraryRow("/lib/a.mp4", { video_codec: "h264", audio_codec: "aac" }, undefined);
    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.match(r.reason, /unknown/i);
});

test("decideFromLibraryRow: malformed capabilities -> no throw, conservative", () => {

    for (const bad of [null, "garbage", 5, [], { video: "x" }]) {
        const r = integration.decideFromLibraryRow("/lib/a.mp4", { video_codec: "h264", audio_codec: "aac" }, bad);
        assert.equal(r.mode, MODES.VIDEO_TRANSCODE, JSON.stringify(bad));
        assert.ok(Object.isFrozen(r));
    }
});

test("probeAndDecide: full-probe chain, injected describe, reaches each mode", async () => {

    const fixture = (over) => Object.assign({
        ok: true,
        file: { path: "/lib/x.mp4", size: 10 },
        container: { format: "mov,mp4,m4a,3gp,3g2,mj2", duration: 1, bitrate: 1 },
        video: [{ index: 0, codec: "h264", profile: "High", width: 1280, height: 720, pixelFormat: "yuv420p", frameRate: 24, bitrate: null }],
        audio: [{ index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrate: null, language: "eng" }],
        subtitles: []
    }, over || {});

    const FULL = { video: { h264: true }, audio: { aac: true, ac3: true }, containers: { mp4: true } };

    const dp = await integration.probeAndDecide("/lib/x.mp4", FULL, { describe: async () => fixture() });
    assert.equal(dp.decision.mode, MODES.DIRECT_PLAY);
    assert.equal(dp.probe.ok, true);

    const at = await integration.probeAndDecide("/lib/x.mp4", { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } },
        { describe: async () => fixture({ audio: [{ index: 1, codec: "ac3", channels: 6 }] }) });
    assert.equal(at.decision.mode, MODES.AUDIO_TRANSCODE);

    const fail = await integration.probeAndDecide("/lib/x.mp4", FULL, { describe: async () => ({ ok: false, error: "probe_failed" }) });
    assert.equal(fail.decision.mode, MODES.VIDEO_TRANSCODE);
});

test("summarizeProbe: never leaks the raw ffprobe shape", () => {

    const ok = integration.summarizeProbe({
        ok: true, degraded: false,
        container: { format: "matroska,webm", duration: 100 },
        video: [{ index: 0, codec: "h264", width: 1920, height: 1080, profile: "High", pixelFormat: "yuv420p" }],
        audio: [{ index: 1, codec: "aac", channels: 2, language: "eng", sampleRate: 48000 }],
        subtitles: []
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.container, "matroska,webm");
    assert.equal(ok.videoStreams, 1);
    assert.deepEqual(Object.keys(ok.video[0]).sort(), ["codec", "height", "index", "width"]);
    assert.equal(integration.summarizeProbe({ ok: false, error: "not_found" }).ok, false);
    assert.equal(integration.summarizeProbe(null).ok, false);
});


// ============================================================
// LAYER 2 -- route integration
// ============================================================

const APP_FILES = [
    "server.js", "database.js", "scanner.js", "ffmpeg.js", "poster.js",
    "media-path.js", "media-probe.js", "playback-decision.js",
    "client-capabilities.js", "playback-integration.js"
];

const BASE = "http://127.0.0.1:4000";
const CLIP = Buffer.alloc(4000);
for (let i = 0; i < CLIP.length; i++) CLIP[i] = i & 0xff;

function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(5000) });
}
function postDecision(body) {
    return fetch(BASE + "/api/playback/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000)
    });
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

test("integration: decision endpoint + /video advisory header (booted server)", async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t7-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos"));
    fs.writeFileSync(path.join(rt, "videos", "clip.mkv"), CLIP);
    fs.writeFileSync(path.join(rt, "videos", "clip.mp4"), CLIP);
    fs.writeFileSync(path.join(rt, "secret.txt"), "PARENT_SECRET_T7");

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

        // Give the two clip rows real codecs so the chain produces
        // distinguishable decisions (ffprobe cannot read the fakes).
        const db = new Database(path.join(rt, "baseflix.db"));
        // wait for the scan to have inserted the rows
        for (let i = 0; i < 40 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 2; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        db.prepare("UPDATE videos SET video_codec='h264', audio_codec='aac', width=1280, height=720, needs_transcode=0 WHERE relative_path IN ('clip.mkv','clip.mp4')").run();
        db.close();

        const FULL_MP4 = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };
        const FULL_ALL = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } };

        // ---- POST /api/playback/decision ----
        await t.test("POST decision: containment 404 on traversal path", async () => {
            const r = await postDecision({ path: "../secret.txt", client: FULL_ALL });
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("PARENT_SECRET_T7"));
        });

        await t.test("POST decision: 404 for a path not in the library", async () => {
            assert.equal((await postDecision({ path: "videos/nope.mp4", client: FULL_ALL })).status, 404);
        });

        await t.test("POST decision: 400 when path missing", async () => {
            assert.equal((await postDecision({ client: FULL_ALL })).status, 400);
        });

        await t.test("POST decision: returns a well-formed decision (ffprobe fails on fake media -> conservative)", async () => {
            const r = await postDecision({ path: "clip.mkv", client: FULL_ALL });
            assert.equal(r.status, 200);
            const j = await r.json();
            assert.ok(Object.values(MODES).includes(j.decision.mode));
            assert.equal(j.decision.mode, MODES.VIDEO_TRANSCODE);   // probe of fake bytes fails
            assert.equal(j.media.ok, false);
            assert.equal(typeof j.decision.reason, "string");
            assert.ok("directPlay" in j.decision && "remux" in j.decision);
        });

        await t.test("POST decision: garbage client does not crash the endpoint", async () => {
            const r = await postDecision({ path: "clip.mp4", client: "garbage" });
            assert.equal(r.status, 200);
            assert.equal((await r.json()).decision.mode, MODES.VIDEO_TRANSCODE);
        });

        // ---- GET /video advisory header, driven by the lightweight chain ----
        await t.test("/video: advisory header present, bytes unchanged", async () => {
            const r = await get("/video/clip.mp4");
            assert.equal(r.status, 200);
            assert.ok(r.headers.get("x-baseflix-playback-mode"));
            assert.equal(r.headers.get("x-baseflix-playback-decision"), "advisory");
            assert.equal(r.headers.get("accept-ranges"), "bytes");
            assert.equal(r.headers.get("content-type"), "video/mp4");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP));
        });

        await t.test("/video: no client caps -> conservative video_transcode advisory", async () => {
            const r = await get("/video/clip.mp4");
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
        });

        await t.test("/video: client caps header -> chain yields direct_play (mp4) / remux (mkv)", async () => {
            const mp4Caps = Buffer.from(JSON.stringify(FULL_MP4)).toString("base64");

            const mp4 = await get("/video/clip.mp4", { "x-baseflix-client-capabilities": mp4Caps });
            assert.equal(mp4.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);

            const mkv = await get("/video/clip.mkv", { "x-baseflix-client-capabilities": mp4Caps });
            assert.equal(mkv.headers.get("x-baseflix-playback-mode"), MODES.REMUX);

            const allCaps = Buffer.from(JSON.stringify(FULL_ALL)).toString("base64");
            const mkvDirect = await get("/video/clip.mkv", { "x-baseflix-client-capabilities": allCaps });
            assert.equal(mkvDirect.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
        });

        // ---- Task 2 + Task 3 regressions on /video ----
        await t.test("regression: Task 2 traversal still blocked on /video", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("PARENT_SECRET_T7"));
        });

        await t.test("regression: Task 3 Range handling intact on /video", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=0-9" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 0-9/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), "10");
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(CLIP.subarray(0, 10)));
            assert.ok(r.headers.get("x-baseflix-playback-mode"));   // advisory header on 206 too
        });

        await t.test("regression: Task 3 unsatisfiable range -> 416", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=999999-" });
            assert.equal(r.status, 416);
            assert.equal(r.headers.get("content-range"), `bytes */${CLIP.length}`);
        });

        await t.test("regression: /watch still serves + still blocks traversal", async () => {
            assert.equal((await get("/watch/clip.mp4")).status, 200);
            assert.equal((await get("/watch/..%2F..%2Fsecret.txt")).status, 404);
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
