"use strict";

/*
    Client capability model tests (Task 5).

    Pure module -- no filesystem, no subprocess, no server. Browser
    APIs (canPlayType, MediaCapabilities) are injected as fakes so the
    detection paths are exercised deterministically in Node.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");

const cc = require(path.join(REPO_ROOT, "client-capabilities.js"));
const {
    STATES,
    REGISTRY,
    normalizeClientCapabilities,
    capabilityOf,
    defaultCapabilities,
    detectFromCanPlayType,
    detectBrowserCapabilities,
    describeBrowserClient,
    canonicalFormat
} = cc;

const ALL_KEYS = []
    .concat(REGISTRY.video.map(k => ["video", k]))
    .concat(REGISTRY.audio.map(k => ["audio", k]))
    .concat(REGISTRY.containers.map(k => ["containers", k]));


// ============================================================
// 1. capability model creation
// ============================================================

test("model creation: defaultCapabilities() knows nothing", () => {

    const model = defaultCapabilities();

    assert.equal(model.source, "default");
    assert.equal(model.client, "unknown");
    assert.equal(model.maxResolution, null);
    assert.ok(Array.isArray(model.warnings));
    assert.ok(Object.isFrozen(model), "model must be frozen");

    for (const [kind, key] of ALL_KEYS) {
        assert.equal(model[kind][key], STATES.UNKNOWN, `${kind}.${key}`);
    }
});

test("model creation: every registry key is always present", () => {

    const model = normalizeClientCapabilities({ video: { h264: true } });

    for (const kind of ["video", "audio", "containers"]) {
        assert.deepEqual(
            Object.keys(model[kind]).sort(),
            REGISTRY[kind].slice().sort()
        );
    }
});

test("model creation: client name is taken from input or options, sanitised", () => {

    assert.equal(normalizeClientCapabilities({ client: "browser" }).client, "browser");
    assert.equal(normalizeClientCapabilities({}, { client: "roku" }).client, "roku");
    assert.equal(normalizeClientCapabilities({ client: 123 }).client, "unknown");
    assert.equal(normalizeClientCapabilities({ client: "  x  " }).client, "x");
    assert.equal(normalizeClientCapabilities({ client: "a".repeat(200) }).client.length, 64);
});


// ============================================================
// 2. supported formats
// ============================================================

test("supported formats: booleans / 1 / 'supported' / 'probably' -> supported", () => {

    const model = normalizeClientCapabilities({
        video: { h264: true, vp9: 1, av1: "supported", hevc: "probably" },
        audio: { aac: true },
        containers: { mp4: true, webm: "supported" }
    });

    assert.equal(capabilityOf(model, "video", "h264"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "video", "vp9"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "video", "av1"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "video", "hevc"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "audio", "aac"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "containers", "mp4"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "containers", "webm"), STATES.SUPPORTED);
});


// ============================================================
// 3. unsupported formats
// ============================================================

test("unsupported formats: false / 0 / 'unsupported' / '' -> unsupported", () => {

    const model = normalizeClientCapabilities({
        video: { hevc: false, av1: 0, vp8: "unsupported" },
        audio: { ac3: "", eac3: false }
    });

    assert.equal(capabilityOf(model, "video", "hevc"), STATES.UNSUPPORTED);
    assert.equal(capabilityOf(model, "video", "av1"), STATES.UNSUPPORTED);
    assert.equal(capabilityOf(model, "video", "vp8"), STATES.UNSUPPORTED);
    assert.equal(capabilityOf(model, "audio", "ac3"), STATES.UNSUPPORTED);
    assert.equal(capabilityOf(model, "audio", "eac3"), STATES.UNSUPPORTED);
});


// ============================================================
// 4. unknown formats
// ============================================================

test("unknown formats: names outside the registry are ignored, not accepted", () => {

    const model = normalizeClientCapabilities({
        video: { theora: true, wmv1: true, h264: true },
        containers: { flv: true, ogg: true }
    });

    assert.equal(capabilityOf(model, "video", "h264"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "video", "theora"), STATES.UNKNOWN);
    assert.equal(capabilityOf(model, "containers", "flv"), STATES.UNKNOWN);
    assert.ok(model.warnings.some(w => w.includes("theora")));
    assert.ok(model.warnings.some(w => w.includes("flv")));
});

test("unknown formats: querying an unknown kind or name -> unknown, no throw", () => {

    const model = defaultCapabilities();
    assert.equal(capabilityOf(model, "video", "definitely-not-a-codec"), STATES.UNKNOWN);
    assert.equal(capabilityOf(model, "subtitles", "srt"), STATES.UNKNOWN);
    assert.equal(capabilityOf(model, "video", 42), STATES.UNKNOWN);
    assert.equal(capabilityOf(null, "video", "h264"), STATES.UNKNOWN);
});


// ============================================================
// 5. partial capability information
// ============================================================

test("partial info: unmentioned formats stay unknown (never inferred)", () => {

    const model = normalizeClientCapabilities({ video: { h264: true } });

    assert.equal(capabilityOf(model, "video", "h264"), STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "video", "hevc"), STATES.UNKNOWN);
    assert.equal(capabilityOf(model, "video", "vp9"), STATES.UNKNOWN);
    assert.equal(capabilityOf(model, "audio", "aac"), STATES.UNKNOWN);
    assert.equal(capabilityOf(model, "containers", "mp4"), STATES.UNKNOWN);
});

test("partial info: a missing whole section -> that section all unknown", () => {

    const model = normalizeClientCapabilities({ audio: { aac: true } });

    for (const key of REGISTRY.video) {
        assert.equal(model.video[key], STATES.UNKNOWN);
    }
    assert.equal(model.audio.aac, STATES.SUPPORTED);
});


// ============================================================
// 6. invalid input
// ============================================================

test("invalid input: non-objects never throw and never claim support", () => {

    for (const bad of [null, undefined, "garbage", 42, true, [], NaN]) {
        const model = normalizeClientCapabilities(bad);
        assert.equal(model.source, "default");
        for (const [kind, key] of ALL_KEYS) {
            assert.equal(model[kind][key], STATES.UNKNOWN, `${JSON.stringify(bad)} ${kind}.${key}`);
        }
    }
});

test("invalid input: bad section / bad value shapes are tolerated", () => {

    const model = normalizeClientCapabilities({
        video: "not-an-object",
        audio: [1, 2, 3],
        containers: { mp4: { nested: "object" }, webm: "yes", mkv: 99 }
    });

    assert.equal(model.video.h264, STATES.UNKNOWN);
    assert.equal(model.audio.aac, STATES.UNKNOWN);
    assert.equal(model.containers.mp4, STATES.UNKNOWN);   // object value -> unknown
    assert.equal(model.containers.webm, STATES.UNKNOWN);  // "yes" not a recognised token
    assert.equal(model.containers.mkv, STATES.UNKNOWN);   // 99 -> unknown
    assert.ok(model.warnings.length > 0);
});

test("invalid input: maxResolution garbage -> null", () => {

    assert.equal(normalizeClientCapabilities({ maxResolution: "4k" }).maxResolution, null);
    assert.equal(normalizeClientCapabilities({ maxResolution: { width: -1, height: 10 } }).maxResolution, null);
    assert.equal(normalizeClientCapabilities({ maxResolution: { width: 1920.5, height: 1080 } }).maxResolution, null);
    assert.deepEqual(
        normalizeClientCapabilities({ maxResolution: { width: 3840, height: 2160 } }).maxResolution,
        { width: 3840, height: 2160 }
    );
});


// ============================================================
// 7. browser API unavailable / fallback behavior
// ============================================================

test("fallback: detectFromCanPlayType with no function -> all unknown + warning", () => {

    const report = detectFromCanPlayType(undefined);
    const model = normalizeClientCapabilities(report, { source: "detected" });

    for (const [kind, key] of ALL_KEYS) {
        assert.equal(model[kind][key], STATES.UNKNOWN, `${kind}.${key}`);
    }
    assert.ok(report.warnings.some(w => w.includes("canPlayType unavailable")));
});

test("fallback: detectBrowserCapabilities({}) -> all unknown, notes missing APIs", () => {

    const report = detectBrowserCapabilities({});
    assert.ok(report.warnings.some(w => w.includes("canPlayType unavailable")));
    assert.ok(report.warnings.some(w => w.includes("mediaCapabilities unavailable")));

    const model = describeBrowserClient({});
    for (const [kind, key] of ALL_KEYS) {
        assert.equal(model[kind][key], STATES.UNKNOWN);
    }
});

test("fallback: canPlayType that throws is caught -> unknown, not a crash", () => {

    const report = detectFromCanPlayType(() => { throw new Error("boom"); });
    for (const key of REGISTRY.video) {
        assert.equal(report.video[key], STATES.UNKNOWN);
    }
});

test("detection: canPlayType 'probably' -> supported, '' -> unsupported, 'maybe' -> unknown", () => {

    const canPlayType = (mime) => {
        if (mime.includes("avc1")) return "probably";        // h264
        if (mime.includes("vp9") || mime.includes("vp09")) return "maybe"; // vp9
        if (mime.includes("av01")) return "";                // av1 - definite no
        return "";
    };

    const report = detectFromCanPlayType(canPlayType);

    assert.equal(report.video.h264, STATES.SUPPORTED);
    assert.equal(report.video.vp9, STATES.UNKNOWN);
    assert.equal(report.video.av1, STATES.UNSUPPORTED);
    assert.equal(report.video.hevc, STATES.UNSUPPORTED);
});

test("detection: MediaCapabilities results override / refine canPlayType", () => {

    const canPlayType = () => "";   // canPlayType says no to everything

    const report = detectBrowserCapabilities({
        canPlayType: canPlayType,
        mediaCapabilities: {},   // present
        mediaCapabilitiesResults: [
            { kind: "video", format: "av01", supported: true },
            { kind: "audio", format: "opus", supported: true },
            { kind: "video", format: "hev1", supported: false }
        ]
    });

    assert.equal(report.video.av1, STATES.SUPPORTED);
    assert.equal(report.audio.opus, STATES.SUPPORTED);
    assert.equal(report.video.hevc, STATES.UNSUPPORTED);
    assert.ok(!report.warnings.some(w => w.includes("mediaCapabilities unavailable")));
});

test("detection: screen + devicePixelRatio -> maxResolution", () => {

    const model = describeBrowserClient({
        videoElement: { canPlayType: () => "probably" },
        screen: { width: 1920, height: 1080 },
        devicePixelRatio: 2
    });

    assert.deepEqual(model.maxResolution, { width: 3840, height: 2160 });
});


// ============================================================
// 8. normalization of capability values
// ============================================================

test("normalization: value tokens map to the three states", () => {

    const cases = [
        [true, STATES.SUPPORTED],
        [1, STATES.SUPPORTED],
        ["supported", STATES.SUPPORTED],
        ["SUPPORTED", STATES.SUPPORTED],
        ["probably", STATES.SUPPORTED],
        [false, STATES.UNSUPPORTED],
        [0, STATES.UNSUPPORTED],
        ["unsupported", STATES.UNSUPPORTED],
        ["", STATES.UNSUPPORTED],
        ["maybe", STATES.UNKNOWN],
        ["unknown", STATES.UNKNOWN],
        [undefined, STATES.UNKNOWN],
        [null, STATES.UNKNOWN],
        ["yes", STATES.UNKNOWN],
        [{}, STATES.UNKNOWN],
        [2, STATES.UNKNOWN]
    ];

    for (const [value, expected] of cases) {
        const model = normalizeClientCapabilities({ video: { h264: value } });
        assert.equal(capabilityOf(model, "video", "h264"), expected, JSON.stringify(value));
    }
});

test("normalization: alias spellings collapse onto the canonical key", () => {

    assert.equal(canonicalFormat("video", "avc1"), "h264");
    assert.equal(canonicalFormat("video", "H.264"), "h264");
    assert.equal(canonicalFormat("video", "hev1"), "hevc");
    assert.equal(canonicalFormat("audio", "ec-3"), "eac3");
    assert.equal(canonicalFormat("audio", "MP4A"), "aac");
    assert.equal(canonicalFormat("containers", "x-matroska"), "mkv");
    assert.equal(canonicalFormat("containers", "quicktime"), "mov");
    assert.equal(canonicalFormat("video", "theora"), null);

    const model = normalizeClientCapabilities({
        video: { avc1: true },
        audio: { "ec-3": true },
        containers: { "x-matroska": true }
    });
    assert.equal(model.video.h264, STATES.SUPPORTED);
    assert.equal(model.audio.eac3, STATES.SUPPORTED);
    assert.equal(model.containers.mkv, STATES.SUPPORTED);
    assert.equal(capabilityOf(model, "video", "avc1"), STATES.SUPPORTED);
});

test("normalization: duplicate / conflicting entries for one canonical key", () => {

    // agree -> that value
    const agree = normalizeClientCapabilities({ video: { h264: true, avc1: "supported", "H.264": 1 } });
    assert.equal(agree.video.h264, STATES.SUPPORTED);
    assert.ok(agree.warnings.some(w => w.includes("multiple entries for video.h264")));

    // disagree -> unknown (never guess)
    const conflict = normalizeClientCapabilities({ video: { h264: true, avc1: false } });
    assert.equal(conflict.video.h264, STATES.UNKNOWN);

    // explicit + unknown -> explicit wins
    const mixed = normalizeClientCapabilities({ audio: { aac: true, mp4a: "maybe" } });
    assert.equal(mixed.audio.aac, STATES.SUPPORTED);
});

test("normalization: model and its nested objects are deeply frozen", () => {

    const model = normalizeClientCapabilities({ video: { h264: true } });
    assert.throws(() => { model.video.h264 = STATES.UNSUPPORTED; });
    assert.throws(() => { model.warnings.push("x"); });
    assert.equal(model.video.h264, STATES.SUPPORTED);
});

test("normalization: raw is a detached frozen copy, not the contract", () => {

    const input = { video: { h264: true }, note: "audit" };
    const model = normalizeClientCapabilities(input);

    assert.deepEqual(model.raw, { video: { h264: true }, note: "audit" });
    assert.ok(Object.isFrozen(model.raw));
    input.video.h264 = false;
    assert.equal(model.raw.video.h264, true, "raw must not alias the caller's object");
});


// ============================================================
// 9. regression against Task 4 media-probe model
// ============================================================

test("regression: every codec media-probe can emit is a known client-capability key", () => {

    // media-probe.js -> stream.codec is ffmpeg's codec_name. These are
    // the ones relevant to the playback model; each must canonicalise.
    const probeVideoCodecs = ["h264", "hevc", "vp8", "vp9", "av1"];
    const probeAudioCodecs = ["aac", "mp3", "opus", "vorbis", "ac3", "eac3", "flac"];

    for (const c of probeVideoCodecs) {
        assert.equal(canonicalFormat("video", c), c, "video " + c);
    }
    for (const c of probeAudioCodecs) {
        assert.equal(canonicalFormat("audio", c), c, "audio " + c);
    }

    // media-probe still loads and behaves.
    const mp = require(path.join(REPO_ROOT, "media-probe.js"));
    assert.equal(typeof mp.describeMedia, "function");
    assert.equal(typeof mp.normalizeProbe, "function");
    const probed = mp.normalizeProbe(
        { format: { format_name: "mp4" }, streams: [{ index: 0, codec_type: "video", codec_name: "hevc" }] },
        { path: "/x.mp4", size: 10 }
    );
    assert.equal(probed.ok, true);
    // A future engine would ask: can the client play this probed codec?
    assert.equal(
        capabilityOf(defaultCapabilities(), "video", probed.video[0].codec),
        STATES.UNKNOWN
    );
});


// ============================================================
// 10. existing playback behavior remains unchanged
// ============================================================

test("regression: Task 1-3 modules and ffmpeg contract untouched", () => {

    const ffmpeg = require(path.join(REPO_ROOT, "ffmpeg.js"));
    assert.equal(typeof ffmpeg.probeFile, "function");
    assert.equal(typeof ffmpeg.probeRaw, "function");
    assert.equal(typeof ffmpeg.checkPlayability, "function");
    assert.equal(ffmpeg.checkPlayability({ videoCodec: "h264", audioCodec: "aac" }).canDirectPlay, true);
    assert.equal(ffmpeg.checkPlayability({ videoCodec: "hevc", audioCodec: "aac" }).canDirectPlay, false);

    const mediaPath = require(path.join(REPO_ROOT, "media-path.js"));
    assert.equal(typeof mediaPath.resolveMediaFilePath, "function");

    // client-capabilities must not drag server.js (a listening process)
    // into the require graph.
    const pulledServer = Object.keys(require.cache)
        .filter(k => k.endsWith(path.sep + "server.js"));
    assert.deepEqual(pulledServer, []);
});
