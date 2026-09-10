"use strict";

/*
    Media-root containment tests for Baseflicks playback.

    Two layers:
      1. Unit  -- media-path.js resolveMediaFilePath() / isStrictlyInside()
                  exercised directly against a throwaway directory tree.
      2. Route -- a real `node server.js` booted in an isolated runtime
                  directory (the pattern the QA smoke test uses), with
                  traversal payloads fired at BOTH /video/:filename and
                  /watch/:filename.

    No production baseflix.db / videos/ / transcoded/ state is touched.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");

const {
    resolveMediaFilePath,
    isStrictlyInside
} = require(path.join(REPO_ROOT, "media-path.js"));


function tmpTree(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}


// ============================================================
// LAYER 1 -- UNIT
// ============================================================

test("media-path.js containment (unit)", async (t) => {

    const work = tmpTree("bf-mediapath-");
    const root = path.join(work, "videos");

    fs.mkdirSync(path.join(root, "Movies", "Movie A"), { recursive: true });
    fs.mkdirSync(path.join(root, "TV", "Show", "Season 01"), { recursive: true });
    fs.writeFileSync(path.join(root, "Movies", "Movie A", "movie.mkv"), "MOVIE_BYTES");
    fs.writeFileSync(path.join(root, "TV", "Show", "Season 01", "episode.mkv"), "EPISODE_BYTES");

    fs.mkdirSync(path.join(work, "videos_backup"));
    fs.writeFileSync(path.join(work, "videos_backup", "secret.mkv"), "PREFIX_SIBLING_SECRET");
    fs.writeFileSync(path.join(work, "outside-secret.txt"), "OUTSIDE_SECRET");

    t.after(() => fs.rmSync(work, { recursive: true, force: true }));

    const realRoot = fs.realpathSync(root);
    const inside = (p) => p !== null && isStrictlyInside(realRoot, p);

    await t.test("PASS - legitimate file", () => {
        const r = resolveMediaFilePath(root, "Movies/Movie A/movie.mkv");
        assert.equal(r, fs.realpathSync(path.join(root, "Movies", "Movie A", "movie.mkv")));
    });

    await t.test("PASS - deeply nested legitimate file", () => {
        const r = resolveMediaFilePath(root, "TV/Show/Season 01/episode.mkv");
        assert.ok(inside(r), "nested path must resolve inside the media root");
    });

    await t.test("PASS - missing file inside root returns a contained path (caller 404s)", () => {
        const r = resolveMediaFilePath(root, "Movies/Movie A/not-here.mkv");
        assert.ok(r !== null, "a plain miss inside the root is not a containment failure");
        assert.ok(isStrictlyInside(path.resolve(root), r));
    });

    await t.test("BLOCK - parent traversal", () => {
        assert.equal(resolveMediaFilePath(root, "../outside-secret.txt"), null);
        assert.equal(resolveMediaFilePath(root, "../../outside-secret.txt"), null);
        assert.equal(resolveMediaFilePath(root, "../../../../../../etc/hosts"), null);
        assert.equal(resolveMediaFilePath(root, "Movies/../../outside-secret.txt"), null);
    });

    await t.test("BLOCK - backslash traversal never escapes", () => {
        // Windows: '\' is a separator -> must be null.
        // POSIX:   '\' is a literal char -> a contained (missing) path is fine,
        //          but it must never resolve OUTSIDE the root.
        const r = resolveMediaFilePath(root, "..\\outside-secret.txt");
        assert.ok(r === null || isStrictlyInside(path.resolve(root), r));
        const r2 = resolveMediaFilePath(root, "..\\..\\outside-secret.txt");
        assert.ok(r2 === null || isStrictlyInside(path.resolve(root), r2));
    });

    await t.test("BLOCK - absolute path escape", () => {
        assert.equal(resolveMediaFilePath(root, path.join(work, "outside-secret.txt")), null);
        assert.equal(resolveMediaFilePath(root, "/etc/passwd"), null);
        if (process.platform === "win32") {
            assert.equal(resolveMediaFilePath(root, "C:\\Windows\\win.ini"), null);
        }
    });

    await t.test("BLOCK - prefix-collision sibling directory", () => {
        assert.equal(resolveMediaFilePath(root, "../videos_backup/secret.mkv"), null);
        assert.equal(
            isStrictlyInside(
                path.resolve(work, "videos"),
                path.resolve(work, "videos_backup", "secret.mkv")
            ),
            false,
            "videos_backup must not count as inside videos"
        );
    });

    await t.test("BLOCK - NUL byte / malformed input", () => {
        assert.equal(resolveMediaFilePath(root, "Movies/Movie A/movie.mkv\u0000.txt"), null);
        assert.equal(resolveMediaFilePath(root, ""), null);
        assert.equal(resolveMediaFilePath(root, null), null);
        assert.equal(resolveMediaFilePath(root, "."), null);
    });

    await t.test("BLOCK - symlink / junction escape (real filesystem target)", () => {
        const outsideDir = path.join(work, "escape-target");
        fs.mkdirSync(outsideDir);
        fs.writeFileSync(path.join(outsideDir, "loot.txt"), "SYMLINK_LOOT");

        let made = true;
        try {
            fs.symlinkSync(outsideDir, path.join(root, "breakout"), "junction");
        } catch (error) {
            made = false;
            t.diagnostic("symlink/junction not creatable in this environment: " + (error && error.code));
        }

        if (made) {
            assert.equal(
                resolveMediaFilePath(root, "breakout/loot.txt"),
                null,
                "a reparse point inside the root that targets outside must be rejected"
            );
        } else {
            t.diagnostic("symlink/junction escape: NOT TESTED (cannot create link here)");
        }
    });
});


// ============================================================
// LAYER 2 -- ROUTE (/video/:filename and /watch/:filename)
// ============================================================

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

const CLIP_BYTES = "CLIP_BYTES_0123456789_ABCDEFGHIJ";
const NESTED_BYTES = "NESTED_EPISODE_BYTES";
const PARENT_SECRET = "PARENT_SECRET_MARKER_9f1c";
const PREFIX_SECRET = "PREFIX_SECRET_MARKER_9f1c";
const JUNCTION_LOOT = "JUNCTION_LOOT_MARKER_9f1c";

const BASE = "http://127.0.0.1:4000";

function get(urlPath, opts) {
    return fetch(BASE + urlPath, { signal: AbortSignal.timeout(5000), ...(opts || {}) });
}

async function waitForServer(child, log) {
    // Wait for THIS child's own startup banner -- not just any HTTP 200
    // on port 4000, which could come from an unrelated server already
    // holding the port (in which case this child would have died with
    // EADDRINUSE and the tests would run against the wrong process).
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(
                "server process exited before it was ready (port 4000 already in " +
                "use by another process?):\n" + log.join("")
            );
        }
        if (log.join("").includes("running on port 4000")) {
            // Banner printed inside the listen() callback -- the socket
            // is accepting now.
            return;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("server did not become ready within 20s:\n" + log.join(""));
}

test("media containment on /video and /watch routes (integration)", async (t) => {

    const rt = tmpTree("bf-media-routes-");

    for (const file of APP_FILES) {
        fs.copyFileSync(path.join(REPO_ROOT, file), path.join(rt, file));
    }

    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>bf test</title>");

    fs.mkdirSync(path.join(rt, "videos", "sub"), { recursive: true });
    fs.writeFileSync(path.join(rt, "videos", "clip.mkv"), CLIP_BYTES);
    fs.writeFileSync(path.join(rt, "videos", "sub", "ep.mkv"), NESTED_BYTES);

    fs.mkdirSync(path.join(rt, "videos_backup"));
    fs.writeFileSync(path.join(rt, "videos_backup", "secret.mkv"), PREFIX_SECRET);

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

        // Create the reparse point AFTER boot so the one-time library
        // scan never walks it.
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

        // ---------- /video ----------

        await t.test("/video PASS - legitimate file", async () => {
            const r = await get("/video/clip.mkv");
            assert.equal(r.status, 200);
            assert.equal(await r.text(), CLIP_BYTES);
        });

        await t.test("/video PASS - nested legitimate file", async () => {
            const r = await get("/video/sub%2Fep.mkv");
            assert.equal(r.status, 200);
            assert.equal(await r.text(), NESTED_BYTES);
        });

        await t.test("/video REGRESSION - Range request still served", async () => {
            const r = await get("/video/clip.mkv", { headers: { Range: "bytes=0-3" } });
            assert.equal(r.status, 206);
            assert.equal(await r.text(), CLIP_BYTES.slice(0, 4));
            assert.match(r.headers.get("content-range") || "", /^bytes 0-3\/\d+$/);
        });

        await t.test("/video BLOCK - parent traversal", async () => {
            for (const p of [
                "/video/..%2Fsecret.txt",
                "/video/..%2F..%2Fsecret.txt",
                "/video/..%2F..%2F..%2F..%2F..%2Fsecret.txt"
            ]) {
                const r = await get(p);
                assert.equal(r.status, 404, p);
                assert.ok(!(await r.text()).includes(PARENT_SECRET), "leaked via " + p);
            }
        });

        await t.test("/video BLOCK - encoded-dot traversal (%2e%2e%2f)", async () => {
            const r = await get("/video/%2e%2e%2fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("/video BLOCK - backslash traversal (..%5C)", async () => {
            const r = await get("/video/..%5Csecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("/video BLOCK - absolute path", async () => {
            const abs = path.join(rt, "secret.txt");
            const r1 = await get("/video/" + encodeURIComponent(abs));
            assert.equal(r1.status, 404);
            assert.ok(!(await r1.text()).includes(PARENT_SECRET));

            const r2 = await get("/video/" + encodeURIComponent("/etc/passwd"));
            assert.equal(r2.status, 404);
        });

        await t.test("/video BLOCK - prefix-collision sibling (videos_backup)", async () => {
            const r = await get("/video/..%2Fvideos_backup%2Fsecret.mkv");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PREFIX_SECRET));
        });

        await t.test("/video BLOCK - junction escape", async () => {
            if (!junctionMade) {
                t.diagnostic("junction escape on /video: NOT TESTED");
                return;
            }
            const r = await get("/video/breakout%2Floot.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(JUNCTION_LOOT));
        });

        await t.test("/video PASS - missing file returns controlled 404", async () => {
            const r = await get("/video/nope-not-real.mkv");
            assert.equal(r.status, 404);
        });

        // ---------- /watch ----------

        await t.test("/watch PASS - legitimate file", async () => {
            const r = await get("/watch/clip.mkv");
            assert.equal(r.status, 200);
            assert.match(await r.text(), /\/video\/clip\.mkv/);
        });

        await t.test("/watch BLOCK - parent traversal", async () => {
            const r = await get("/watch/..%2F..%2Fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("/watch BLOCK - encoded-dot traversal", async () => {
            const r = await get("/watch/%2e%2e%2fsecret.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("/watch BLOCK - absolute path", async () => {
            const r = await get("/watch/" + encodeURIComponent(path.join(rt, "secret.txt")));
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(PARENT_SECRET));
        });

        await t.test("/watch BLOCK - prefix-collision sibling", async () => {
            const r = await get("/watch/..%2Fvideos_backup%2Fsecret.mkv");
            assert.equal(r.status, 404);
        });

        await t.test("/watch BLOCK - junction escape", async () => {
            if (!junctionMade) {
                t.diagnostic("junction escape on /watch: NOT TESTED");
                return;
            }
            const r = await get("/watch/breakout%2Floot.txt");
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes(JUNCTION_LOOT));
        });

        await t.test("/watch PASS - missing file returns controlled 404", async () => {
            const r = await get("/watch/nope-not-real.mkv");
            assert.equal(r.status, 404);
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
