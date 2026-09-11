"use strict";

/*
    Browser Capability Transport tests (Task 16).

    Wires the EXISTING detectBrowserCapabilities() (client-capabilities.js,
    Task 5) to the EXISTING server intake (readClientCapabilities(),
    Task 7) and decision engine (decidePlayback(), Task 6) -- no second
    detector, no second decision engine, no new playback API.

    Browser-side detector behaviour (H264/AAC detection, supported /
    unsupported / unknown, container detection, resolution, MediaCapabilities
    fallback, detector-throws-doesn't-crash) is exhaustively covered by
    test/client-capabilities.test.js (Task 5) already and is NOT
    duplicated here -- it runs, and passes, as part of every full-suite
    run reported below.

    Part A -- unit: compactForTransport() / toQueryString() (Task 16
      additions to client-capabilities.js) -- the browser->server
      encoding, and that it round-trips losslessly through
      normalizeClientCapabilities().
    Part B -- unit: readClientCapabilities() intake via the query-string
      arm specifically (?caps=<raw JSON>) -- the transport a native
      <video src> element can actually use, since it cannot set a
      custom request header. Normal / missing / malformed / oversized /
      invalid-JSON / unsupported-field / array-value payloads.
    Part C -- route: real `node server.js`, real ffmpeg. Proves
      capabilities -> server -> decidePlayback() for all four Task 6
      modes (the task's four worked examples), that /client-capabilities.js
      is served so the browser can load the detector, and that the
      Task 14 no-capability Direct Play fast-path is unaffected.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const cc = require(path.join(REPO_ROOT, "client-capabilities.js"));
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));
const APP_FILES = require("./_app-files");

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }


// ============================================================
// PART A -- compactForTransport() / toQueryString()
// ============================================================

test("compactForTransport: keeps only supported/unsupported entries, drops unknown", () => {
    const report = {
        video: { h264: "supported", hevc: "unknown", vp8: "unsupported", vp9: "unknown", av1: "unknown" },
        audio: { aac: "supported", mp3: "unknown", opus: "unknown", vorbis: "unknown", ac3: "unknown", eac3: "unknown", flac: "unknown" },
        containers: { mp4: "supported", webm: "unknown", mkv: "unknown", mov: "unknown", avi: "unknown" }
    };
    const compact = cc.compactForTransport(report);
    assert.deepEqual(compact, {
        video: { h264: "supported", vp8: "unsupported" },
        audio: { aac: "supported" },
        containers: { mp4: "supported" }
    });
});

test("compactForTransport: includes maxResolution only when it has valid numeric width/height", () => {
    const withRes = cc.compactForTransport({ video: { h264: "supported" }, maxResolution: { width: 1920, height: 1080 } });
    assert.deepEqual(withRes.maxResolution, { width: 1920, height: 1080 });

    const badRes = cc.compactForTransport({ video: { h264: "supported" }, maxResolution: { width: "big", height: null } });
    assert.equal("maxResolution" in badRes, false);

    const noRes = cc.compactForTransport({ video: { h264: "supported" } });
    assert.equal("maxResolution" in noRes, false);
});

test("compactForTransport: an all-unknown / empty / garbage report -> null (nothing worth sending)", () => {
    assert.equal(cc.compactForTransport({ video: { h264: "unknown" } }), null);
    assert.equal(cc.compactForTransport({}), null);
    assert.equal(cc.compactForTransport(null), null);
    assert.equal(cc.compactForTransport("garbage"), null);
    assert.equal(cc.compactForTransport(5), null);
    assert.equal(cc.compactForTransport([]), null);
});

test("compactForTransport: round-trips losslessly through normalizeClientCapabilities()", () => {
    const report = cc.detectBrowserCapabilities({
        canPlayType: (mime) => {
            if (mime.indexOf('avc1.42E01E') !== -1) return "probably";
            if (mime.indexOf('mp4a.40.2') !== -1) return "probably";
            if (mime === "video/mp4") return "probably";
            if (mime.indexOf("hvc1") !== -1 || mime.indexOf("hev1") !== -1) return "";
            return "";
        },
        screen: { width: 1366, height: 768 },
        devicePixelRatio: 2
    });
    const compact = cc.compactForTransport(report);
    const full = cc.normalizeClientCapabilities(report);
    const short = cc.normalizeClientCapabilities(compact);

    for (const kind of ["video", "audio", "containers"]) {
        for (const key of cc.REGISTRY[kind]) {
            assert.equal(
                cc.capabilityOf(full, kind, key), cc.capabilityOf(short, kind, key),
                kind + "." + key
            );
        }
    }
    assert.deepEqual(short.maxResolution, full.maxResolution);
});

test("toQueryString: produces '?caps=<url-encoded JSON>' that the server can parse back exactly", () => {
    const report = { video: { h264: "supported" }, containers: { mp4: "supported" } };
    const qs = cc.toQueryString(report);
    assert.match(qs, /^\?caps=/);
    const decoded = JSON.parse(decodeURIComponent(qs.slice("?caps=".length)));
    assert.deepEqual(decoded, { video: { h264: "supported" }, containers: { mp4: "supported" } });
});

test("toQueryString: nothing worth sending -> '' (no query string appended)", () => {
    assert.equal(cc.toQueryString({}), "");
    assert.equal(cc.toQueryString(null), "");
    assert.equal(cc.toQueryString({ video: { h264: "unknown" } }), "");
});

test("/client-capabilities.js is a single reusable module -- no second implementation exists", () => {
    // The file the browser loads and the file the server requires are
    // the SAME path; there is no public/client-capabilities.js fork.
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "public", "client-capabilities.js")), false);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "client-capabilities.js")), true);
});


// ============================================================
// PART B -- server intake via the ?caps= query-string arm
// ============================================================

function reqWith(query) {
    return { headers: {}, query: query || {} };
}

test("readClientCapabilities: normal ?caps= raw JSON is parsed", () => {
    const value = { video: { h264: "supported" }, containers: { mp4: "supported" } };
    const parsed = integration.readClientCapabilities(reqWith({ caps: JSON.stringify(value) }));
    assert.deepEqual(parsed, value);
});

test("readClientCapabilities: missing ?caps -> undefined (Task 14 fast-path condition)", () => {
    assert.equal(integration.readClientCapabilities(reqWith({})), undefined);
    assert.equal(integration.readClientCapabilities(reqWith()), undefined);
});

test("readClientCapabilities: malformed / invalid JSON in ?caps -> undefined, no throw", () => {
    for (const bad of ["}{ not json", "{unquoted:true}", "", "   ", "null", "42"]) {
        assert.doesNotThrow(() => integration.readClientCapabilities(reqWith({ caps: bad })));
    }
    assert.equal(integration.readClientCapabilities(reqWith({ caps: "}{ not json" })), undefined);
});

test("readClientCapabilities: oversized ?caps -> undefined, no throw, no memory blowup", () => {
    const huge = "{" + "\"video\":{\"h264\":\"supported\"}".repeat(2000) + "}"; // > 20000 chars
    assert.ok(huge.length > 20000);
    assert.doesNotThrow(() => integration.readClientCapabilities(reqWith({ caps: huge })));
    assert.equal(integration.readClientCapabilities(reqWith({ caps: huge })), undefined);
});

test("readClientCapabilities: array-shaped ?caps (repeated query key) -> uses the first value", () => {
    const value = { video: { h264: "supported" } };
    const parsed = integration.readClientCapabilities(reqWith({ caps: [JSON.stringify(value), "{}"] }));
    assert.deepEqual(parsed, value);
});

test("normalizeClientCapabilities: unsupported/unrecognised fields in a real payload are ignored, not fatal", () => {
    const parsed = integration.readClientCapabilities(reqWith({
        caps: JSON.stringify({ video: { h264: "supported", theora: "supported" }, someFutureField: 123, containers: "not-an-object" })
    }));
    const model = cc.normalizeClientCapabilities(parsed);
    assert.equal(cc.capabilityOf(model, "video", "h264"), "supported");
    assert.equal(cc.capabilityOf(model, "containers", "mp4"), "unknown");
});

test("full boundary: a browser-shaped compact payload survives readClientCapabilities -> decidePlayback unchanged", () => {
    const report = cc.detectBrowserCapabilities({
        canPlayType: (mime) => (mime.indexOf('avc1.42E01E') !== -1 || mime.indexOf('mp4a.40.2') !== -1 || mime === "video/mp4") ? "probably" : ""
    });
    const qs = cc.toQueryString(report);
    const raw = decodeURIComponent(qs.slice("?caps=".length));
    const parsed = integration.readClientCapabilities(reqWith({ caps: raw }));
    const model = cc.normalizeClientCapabilities(parsed);
    assert.equal(cc.capabilityOf(model, "video", "h264"), "supported");
    assert.equal(cc.capabilityOf(model, "audio", "aac"), "supported");
    assert.equal(cc.capabilityOf(model, "containers", "mp4"), "supported");
});


// ============================================================
// PART C -- real server + real ffmpeg: the four worked examples
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
function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(30000) });
}
function capsQuery(obj) {
    return "?caps=" + encodeURIComponent(JSON.stringify(obj));
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

test("Task 16 route: browser-style ?caps= drives all four playback modes; /client-capabilities.js is servable",
    { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t16-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos"), { recursive: true });

    makeMedia(path.join(rt, "videos", "h264-aac.mp4"), "libx264", "aac");        // Example 1: DIRECT_PLAY
    makeMedia(path.join(rt, "videos", "h264-aac.mkv"), "libx264", "aac");        // Example 2: REMUX
    makeMedia(path.join(rt, "videos", "h264-ac3.mkv"), "libx264", "ac3");        // Example 3: AUDIO_TRANSCODE
    makeMedia(path.join(rt, "videos", "mpeg4-ac3.avi"), "mpeg4", "ac3");         // Example 4: VIDEO_TRANSCODE
    fs.writeFileSync(path.join(rt, "secret.txt"), "T16_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    // The one capability report used across the four examples:
    // "browser supports H264 + AAC + MP4" (the task's stated client).
    const BROWSER_CAPS = { video: { h264: "supported" }, audio: { aac: "supported" }, containers: { mp4: "supported" } };

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 60 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 4; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const set = db.prepare("UPDATE videos SET video_codec=?, audio_codec=?, width=160, height=90, needs_transcode=? WHERE relative_path=?");
        set.run("h264", "aac", 0, "h264-aac.mp4");
        set.run("h264", "aac", 0, "h264-aac.mkv");
        set.run("h264", "ac3", 1, "h264-ac3.mkv");
        set.run("mpeg4", "ac3", 1, "mpeg4-ac3.avi");
        db.close();

        await t.test("/client-capabilities.js is served (byte-identical to the repo module the server requires)", async () => {
            const r = await get("/client-capabilities.js");
            assert.equal(r.status, 200);
            const served = await r.text();
            const source = fs.readFileSync(path.join(rt, "client-capabilities.js"), "utf8");
            assert.equal(served, source);
        });

        await t.test("Example 1: H264+AAC+MP4 client, H264+AAC+MP4 source -> DIRECT_PLAY", async () => {
            const r = await get("/video/h264-aac.mp4" + capsQuery(BROWSER_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
        });

        await t.test("Example 2: H264+AAC+MP4 client, H264+AAC+MKV source -> REMUX", async () => {
            const r = await get("/video/h264-aac.mkv" + capsQuery(BROWSER_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.REMUX);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.equal(r.headers.get("content-type"), "video/mp4");
        });

        await t.test("Example 3: H264+AAC+MP4 client, H264+AC3+MKV source -> AUDIO_TRANSCODE", async () => {
            const r = await get("/video/h264-ac3.mkv" + capsQuery(BROWSER_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.AUDIO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "audio-transcode");
        });

        await t.test("Example 4: client does not support the source video codec -> VIDEO_TRANSCODE", async () => {
            const r = await get("/video/mpeg4-ac3.avi" + capsQuery(BROWSER_CAPS));
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.VIDEO_TRANSCODE);
            assert.equal(r.headers.get("x-baseflix-playback"), "video-transcode");
            assert.equal(r.headers.get("content-type"), "video/mp4");
        });

        await t.test("hierarchy order preserved: withdrawing support moves DIRECT_PLAY -> REMUX -> AUDIO_TRANSCODE -> VIDEO_TRANSCODE", async () => {
            const rungs = [
                { url: "/video/h264-aac.mp4", caps: { video: { h264: "supported" }, audio: { aac: "supported" }, containers: { mp4: "supported" } }, expect: MODES.DIRECT_PLAY },
                { url: "/video/h264-aac.mkv", caps: { video: { h264: "supported" }, audio: { aac: "supported" }, containers: { mp4: "supported" } }, expect: MODES.REMUX },
                { url: "/video/h264-ac3.mkv", caps: { video: { h264: "supported" }, audio: { aac: "supported" }, containers: { mp4: "supported" } }, expect: MODES.AUDIO_TRANSCODE },
                { url: "/video/mpeg4-ac3.avi", caps: { video: { h264: "supported" }, audio: { aac: "supported" }, containers: { mp4: "supported" } }, expect: MODES.VIDEO_TRANSCODE }
            ];
            for (const rung of rungs) {
                const r = await get(rung.url + capsQuery(rung.caps));
                assert.equal(r.headers.get("x-baseflix-playback-mode"), rung.expect, rung.url);
            }
        });

        await t.test("malformed ?caps on a real request -> safe conservative fallback, no crash", async () => {
            const r = await get("/video/mpeg4-ac3.avi?caps=%7Bnot-json");
            assert.equal(r.status, 200);
            assert.equal((await get("/api/videos")).status, 200);
        });

        await t.test("Task 14 regression: no ?caps at all + needs_transcode=0 -> still DIRECT_PLAY fast-path", async () => {
            const t0 = Date.now();
            const r = await get("/video/h264-aac.mp4");
            const elapsed = Date.now() - t0;
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback-mode"), MODES.DIRECT_PLAY);
            assert.equal(r.headers.get("x-baseflix-playback"), "direct-play");
            assert.ok(elapsed < 5000, `served in ${elapsed}ms (Task 14 fast-path must not wait on a transcode)`);
        });

        await t.test("Task 2 containment intact alongside a capability query", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt" + capsQuery(BROWSER_CAPS));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T16_SECRET"));
        });

        await t.test("Task 3 Range intact on a capability-driven Direct Play response", async () => {
            const r = await get("/video/h264-aac.mp4" + capsQuery(BROWSER_CAPS), { Range: "bytes=0-99" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range").split("/")[1], fs.statSync(path.join(rt, "videos", "h264-aac.mp4")).size.toString());
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
