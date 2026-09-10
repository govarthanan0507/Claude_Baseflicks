"use strict";

/*
    Direct-play HTTP range + MIME hardening tests (Task 3).

    Boots a real `node server.js` in an isolated runtime directory (the
    same pattern the QA smoke test and the Task 2 containment test use)
    and asserts ACTUAL HTTP response behaviour -- status line,
    Content-Range, Content-Length, Content-Type, Accept-Ranges and the
    response bytes -- for every range form the task requires, plus the
    extension-aware MIME mapping, plus a Task 2 containment regression
    check against the same server.

    No production baseflix.db / videos/ / transcoded/ state is touched.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");

const APP_FILES = [
    "server.js",
    "database.js",
    "scanner.js",
    "ffmpeg.js",
    "poster.js",
    "media-path.js",
    // server.js requires these transitively (Task 4-7 modules).
    "media-probe.js",
    "playback-decision.js",
    "client-capabilities.js",
    "playback-integration.js",
    "remux.js"
];

const BASE = "http://127.0.0.1:4000";

// 10 000 bytes of known content: byte i === i & 0xff.
const CLIP = Buffer.alloc(10000);
for (let i = 0; i < CLIP.length; i++) {
    CLIP[i] = i & 0xff;
}

const PARENT_SECRET = "PARENT_SECRET_MARKER_task3";
const JUNCTION_LOOT = "JUNCTION_LOOT_MARKER_task3";

function get(urlPath, headers) {
    return fetch(BASE + urlPath, {
        headers: headers || {},
        signal: AbortSignal.timeout(5000)
    });
}

async function body(res) {
    return Buffer.from(await res.arrayBuffer());
}

async function waitForServer(child, log) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(
                "server exited before ready (port 4000 already in use?):\n" +
                log.join("")
            );
        }
        if (log.join("").includes("running on port 4000")) {
            return;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("server not ready within 20s:\n" + log.join(""));
}


test("direct-play range + MIME hardening (integration)", async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-range-"));

    for (const file of APP_FILES) {
        fs.copyFileSync(path.join(REPO_ROOT, file), path.join(rt, file));
    }

    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");

    // Known-content clip for the range assertions.
    fs.mkdirSync(path.join(rt, "videos", "Movies", "A"), { recursive: true });
    fs.writeFileSync(path.join(rt, "videos", "clip.mp4"), CLIP);
    fs.writeFileSync(path.join(rt, "videos", "Movies", "A", "nested.mp4"), CLIP);

    // One small file per supported extension (+ unknown + uppercase).
    const mimeDir = path.join(rt, "videos", "mime");
    fs.mkdirSync(mimeDir);
    const MIME_CASES = [
        ["sample.mp4", "video/mp4"],
        ["sample.m4v", "video/x-m4v"],
        ["sample.webm", "video/webm"],
        ["sample.mkv", "video/x-matroska"],
        ["sample.mov", "video/quicktime"],
        ["sample.avi", "video/x-msvideo"],
        ["sample.bin", "application/octet-stream"],
        ["UPPER.MKV", "video/x-matroska"]
    ];
    for (const [name] of MIME_CASES) {
        fs.writeFileSync(path.join(mimeDir, name), "SMALLDATA");
    }

    // Task 2 regression fixtures.
    fs.writeFileSync(path.join(rt, "secret.txt"), PARENT_SECRET);
    fs.mkdirSync(path.join(rt, "escape-target"));
    fs.writeFileSync(path.join(rt, "escape-target", "loot.txt"), JUNCTION_LOOT);

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: {
            ...process.env,
            NODE_PATH: process.env.NODE_PATH
                ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}`
                : NODE_MODULES
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", (c) => log.push(c.toString()));
    child.stderr.on("data", (c) => log.push(c.toString()));

    let junctionMade = true;

    try {
        await waitForServer(child, log);

        try {
            fs.symlinkSync(
                path.join(rt, "escape-target"),
                path.join(rt, "videos", "breakout"),
                "junction"
            );
        } catch (error) {
            junctionMade = false;
            t.diagnostic("junction not creatable here: " + (error && error.code));
        }

        // ---------------------------------------------------------
        // FULL-FILE RESPONSE (no Range)
        // ---------------------------------------------------------
        await t.test("no Range -> 200 full file", async () => {
            const r = await get("/video/clip.mp4");
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("content-length"), String(CLIP.length));
            assert.equal(r.headers.get("content-type"), "video/mp4");
            assert.equal(r.headers.get("accept-ranges"), "bytes");
            assert.ok((await body(r)).equals(CLIP));
        });

        // ---------------------------------------------------------
        // EXPLICIT RANGE
        // ---------------------------------------------------------
        await t.test("bytes=0-99 -> 206 exact bytes", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=0-99" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 0-99/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), "100");
            assert.equal(r.headers.get("accept-ranges"), "bytes");
            assert.ok((await body(r)).equals(CLIP.subarray(0, 100)));
        });

        // ---------------------------------------------------------
        // OPEN-ENDED RANGE
        // ---------------------------------------------------------
        await t.test("bytes=1000- -> 206 through EOF", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=1000-" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 1000-9999/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), "9000");
            assert.ok((await body(r)).equals(CLIP.subarray(1000)));
        });

        // ---------------------------------------------------------
        // SUFFIX RANGE
        // ---------------------------------------------------------
        await t.test("bytes=-500 -> 206 last 500 bytes", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=-500" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 9500-9999/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), "500");
            assert.ok((await body(r)).equals(CLIP.subarray(9500)));
        });

        await t.test("bytes=-999999 (suffix > size) -> 206 whole file as a range", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=-999999" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 0-9999/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), String(CLIP.length));
            assert.ok((await body(r)).equals(CLIP));
        });

        // ---------------------------------------------------------
        // END BEYOND EOF -> CLAMP
        // ---------------------------------------------------------
        await t.test("bytes=9000-999999999 -> 206 clamped to EOF", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=9000-999999999" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 9000-9999/${CLIP.length}`);
            assert.equal(r.headers.get("content-length"), "1000");
            assert.ok((await body(r)).equals(CLIP.subarray(9000)));
        });

        // ---------------------------------------------------------
        // UNSATISFIABLE -> 416
        // ---------------------------------------------------------
        await t.test("bytes=10000- (start == size) -> 416", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=10000-" });
            assert.equal(r.status, 416);
            assert.equal(r.headers.get("content-range"), `bytes */${CLIP.length}`);
            assert.equal((await body(r)).length, 0);
        });

        await t.test("bytes=999999-1000000 (fully past EOF) -> 416", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=999999-1000000" });
            assert.equal(r.status, 416);
            assert.equal(r.headers.get("content-range"), `bytes */${CLIP.length}`);
        });

        await t.test("bytes=500-100 (start > end) -> 416", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=500-100" });
            assert.equal(r.status, 416);
            assert.equal(r.headers.get("content-range"), `bytes */${CLIP.length}`);
        });

        await t.test("bytes=-0 (zero-length suffix) -> 416", async () => {
            const r = await get("/video/clip.mp4", { Range: "bytes=-0" });
            assert.equal(r.status, 416);
            assert.equal(r.headers.get("content-range"), `bytes */${CLIP.length}`);
        });

        // ---------------------------------------------------------
        // MULTIPLE RANGES + LIST SYNTAX -> safe 200 full file
        // (a comma-shaped header must NEVER become a 206, even when
        //  only one element is actually valid: "bytes=0-99," etc.)
        // ---------------------------------------------------------
        for (const listHeader of [
            "bytes=0-99,200-299",   // genuine multi-range
            "bytes=0-99,",          // trailing comma
            "bytes=,0-99",          // leading comma
            "bytes=0-99,,",         // double trailing comma
            "bytes=0-99 ,",         // whitespace + trailing comma
            "bytes=0-99,abc"        // one valid + one junk element
        ]) {
            await t.test(`list-shaped "${listHeader}" -> 200 full file, never 206`, async () => {
                const r = await get("/video/clip.mp4", { Range: listHeader });
                assert.equal(r.status, 200);
                assert.equal(r.headers.get("content-length"), String(CLIP.length));
                assert.equal(r.headers.get("accept-ranges"), "bytes");
                assert.equal(r.headers.get("content-range"), null);
                const b = await body(r);
                assert.equal(b.length, CLIP.length);
                assert.ok(b.equals(CLIP));
            });
        }

        // ---------------------------------------------------------
        // MALFORMED / UNSUPPORTED -> safe 200 full file
        // ---------------------------------------------------------
        for (const bad of ["bytes=abc", "bytes=", "bytes=-", "bytes=1-2-3", "items=0-100", "bytes=xyz-"]) {
            await t.test(`malformed "${bad}" -> 200 full file, no malformed 206`, async () => {
                const r = await get("/video/clip.mp4", { Range: bad });
                assert.equal(r.status, 200);
                assert.equal(r.headers.get("content-length"), String(CLIP.length));
                assert.equal(r.headers.get("content-range"), null);
                const b = await body(r);
                assert.equal(b.length, CLIP.length);
                assert.ok(b.equals(CLIP));
            });
        }

        // ---------------------------------------------------------
        // MIME MAPPING
        // ---------------------------------------------------------
        for (const [name, expected] of MIME_CASES) {
            await t.test(`MIME ${name} -> ${expected}`, async () => {
                const r = await get("/video/mime%2F" + encodeURIComponent(name));
                assert.equal(r.status, 200);
                assert.equal(r.headers.get("content-type"), expected);
                assert.equal(r.headers.get("accept-ranges"), "bytes");
            });
        }

        await t.test("MIME is applied on 206 responses too (.mkv)", async () => {
            const r = await get("/video/mime%2Fsample.mkv", { Range: "bytes=0-3" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-type"), "video/x-matroska");
        });

        // ---------------------------------------------------------
        // NESTED FILE STILL WORKS
        // ---------------------------------------------------------
        await t.test("nested path served (range + full)", async () => {
            const full = await get("/video/Movies%2FA%2Fnested.mp4");
            assert.equal(full.status, 200);
            assert.ok((await body(full)).equals(CLIP));

            const part = await get("/video/Movies%2FA%2Fnested.mp4", { Range: "bytes=-10" });
            assert.equal(part.status, 206);
            assert.equal(part.headers.get("content-range"), `bytes 9990-9999/${CLIP.length}`);
            assert.ok((await body(part)).equals(CLIP.subarray(9990)));
        });

        // ---------------------------------------------------------
        // TASK 2 CONTAINMENT REGRESSION
        // ---------------------------------------------------------
        await t.test("REGRESSION: parent traversal still blocked", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("REGRESSION: encoded-dot traversal still blocked", async () => {
            const r = await get("/video/%2e%2e%2f%2e%2e%2fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("REGRESSION: absolute-path escape still blocked", async () => {
            const r = await get("/video/" + encodeURIComponent(path.join(rt, "secret.txt")));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("REGRESSION: junction escape still blocked", async () => {
            if (!junctionMade) {
                t.diagnostic("junction escape regression: NOT TESTED (cannot create link)");
                return;
            }
            const r = await get("/video/breakout%2Floot.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(JUNCTION_LOOT));
        });

        await t.test("REGRESSION: /watch traversal still blocked, legit still works", async () => {
            const blocked = await get("/watch/..%2F..%2Fsecret.txt");
            assert.equal(blocked.status, 404);

            const ok = await get("/watch/clip.mp4");
            assert.equal(ok.status, 200);
            assert.match(await ok.text(), /\/video\/clip\.mp4/);
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }
            child.once("exit", resolve);
            setTimeout(resolve, 4000);
        });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
