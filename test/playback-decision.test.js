"use strict";

/*
    Capability-based playback decision engine tests (Task 6).

    Pure module -- fixtures only, no filesystem / ffmpeg / server.
    Media fixtures mimic media-probe.js describeMedia() output;
    clients are raw objects (the engine normalises internally).
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const engine = require(path.join(REPO_ROOT, "playback-decision.js"));
const { decidePlayback, MODES, resolveContainer, isExoticVideoConfig } = engine;


// ---- fixture builders ---------------------------------------

function v(over) {
    return Object.assign({
        index: 0, codec: "h264", profile: "High",
        width: 1920, height: 1080, frameRate: 24,
        pixelFormat: "yuv420p", bitrate: null
    }, over || {});
}

function a(over) {
    return Object.assign({
        index: 1, codec: "aac", channels: 2,
        sampleRate: 48000, bitrate: 128000, language: "eng"
    }, over || {});
}

function media(over) {
    return Object.assign({
        ok: true,
        file: { path: "/library/Movie.mp4", size: 1000000 },
        container: { format: "mov,mp4,m4a,3gp,3g2,mj2", duration: 100, bitrate: 5000000 },
        video: [v()],
        audio: [a()],
        subtitles: []
    }, over || {});
}

const FULL_CLIENT = {
    client: "browser",
    video: { h264: true, hevc: true, vp8: true, vp9: true, av1: true },
    audio: { aac: true, mp3: true, opus: true, vorbis: true, ac3: true, eac3: true, flac: true },
    containers: { mp4: true, webm: true, mkv: true, mov: true, avi: true }
};

function clientWithout(kind, name) {
    const c = JSON.parse(JSON.stringify(FULL_CLIENT));
    c[kind][name] = false;
    return c;
}


// ============================================================
// Required decision-hierarchy cases
// ============================================================

test("fully supported MP4 / H.264 / AAC -> DIRECT_PLAY", () => {

    const r = decidePlayback(media(), FULL_CLIENT);

    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.directPlay.possible, true);
    assert.deepEqual(r.directPlay.blockers, []);
    assert.match(r.reason, /^Direct play/);
    assert.equal(r.source.container, "mp4");
    assert.equal(r.source.video.codec, "h264");
    assert.equal(r.source.audio.codec, "aac");
    assert.ok(Object.isFrozen(r));
});

test("unsupported video codec -> VIDEO_TRANSCODE", () => {

    const r = decidePlayback(
        media({ video: [v({ codec: "hevc" })] }),
        clientWithout("video", "hevc")
    );

    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.equal(r.directPlay.possible, false);
    assert.equal(r.remux.possible, false);
    assert.equal(r.audioTranscode.possible, false);
    assert.ok(r.directPlay.blockers.some(b => /video codec 'hevc' is not supported/.test(b)));
    assert.equal(r.videoTranscode.possible, true);
});

test("unsupported audio, supported video + container -> AUDIO_TRANSCODE", () => {

    const r = decidePlayback(
        media({ audio: [a({ codec: "ac3" })] }),
        clientWithout("audio", "ac3")
    );

    assert.equal(r.mode, MODES.AUDIO_TRANSCODE);
    assert.equal(r.directPlay.possible, false);
    assert.equal(r.audioTranscode.possible, true);
    assert.equal(r.audioTranscode.audioCodec, "aac");
    assert.equal(r.audioTranscode.target, "mp4");
    assert.ok(r.directPlay.blockers.some(b => /audio codec 'ac3' is not supported/.test(b)));
});

test("unsupported container, compatible streams -> REMUX", () => {

    const r = decidePlayback(
        media({ file: { path: "/library/Movie.mkv", size: 10 }, container: { format: "matroska,webm" } }),
        clientWithout("containers", "mkv")
    );

    assert.equal(r.mode, MODES.REMUX);
    assert.equal(r.remux.possible, true);
    assert.equal(r.remux.target, "mp4");
    assert.equal(r.directPlay.possible, false);
    assert.ok(r.directPlay.blockers.some(b => /container 'mkv' is not supported/.test(b)));
});

test("REMUX picks webm when only webm can carry the codecs", () => {

    const r = decidePlayback(
        media({
            file: { path: "/library/Movie.mkv", size: 10 },
            container: { format: "matroska,webm" },
            video: [v({ codec: "vp8" })],
            audio: [a({ codec: "vorbis" })]
        }),
        { video: { vp8: true }, audio: { vorbis: true }, containers: { webm: true } }
    );

    assert.equal(r.mode, MODES.REMUX);
    assert.equal(r.remux.target, "webm");
});

test("unsupported container + unsupported video -> VIDEO_TRANSCODE", () => {

    const client = clientWithout("containers", "mkv");
    client.video.hevc = false;

    const r = decidePlayback(
        media({
            file: { path: "/library/Movie.mkv", size: 10 },
            container: { format: "matroska,webm" },
            video: [v({ codec: "hevc" })]
        }),
        client
    );

    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.equal(r.remux.possible, false);
    assert.equal(r.audioTranscode.possible, false);
});


// ============================================================
// Conservative "unknown" handling
// ============================================================

test("unknown client capability -> conservative VIDEO_TRANSCODE, not DIRECT_PLAY", () => {

    // media is fully standard; client says nothing.
    const r = decidePlayback(media(), {});

    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.equal(r.directPlay.possible, false);
    assert.match(r.reason, /unknown/i);
    assert.equal(r.client.videoState, "unknown");
    assert.equal(r.client.audioState, "unknown");
    assert.equal(r.client.containerState, "unknown");
});

test("conservative rule: h264 media + h264 capability 'unknown' must NOT Direct Play", () => {

    const r = decidePlayback(
        media(),
        { containers: { mp4: true }, audio: { aac: true } }   // video section absent -> h264 unknown
    );

    assert.notEqual(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.directPlay.possible, false);
    assert.ok(r.directPlay.blockers.some(b => /video codec 'h264' support is unknown/.test(b)));
});

test("partial client: container + audio known, video unknown -> not Direct Play", () => {

    const r = decidePlayback(
        media(),
        { containers: { mp4: true }, audio: { aac: true }, video: { hevc: true } }
    );

    assert.notEqual(r.mode, MODES.DIRECT_PLAY);
    assert.ok(r.directPlay.blockers.some(b => /video codec 'h264' support is unknown/.test(b)));
});


// ============================================================
// Resolution / profile constraints
// ============================================================

test("resolution above client limit -> cannot Direct Play (or Remux) -> VIDEO_TRANSCODE", () => {

    const client = JSON.parse(JSON.stringify(FULL_CLIENT));
    client.maxResolution = { width: 1920, height: 1080 };

    const r = decidePlayback(media({ video: [v({ width: 3840, height: 2160 })] }), client);

    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.ok(r.directPlay.blockers.some(b => /3840x2160 exceeds the client limit 1920x1080/.test(b)));
    assert.equal(r.remux.possible, false);
});

test("resolution within limit -> Direct Play still allowed", () => {

    const client = JSON.parse(JSON.stringify(FULL_CLIENT));
    client.maxResolution = { width: 3840, height: 2160 };

    const r = decidePlayback(media({ video: [v({ width: 1920, height: 1080 })] }), client);
    assert.equal(r.mode, MODES.DIRECT_PLAY);
});

test("high-bit-depth / non-4:2:0 video blocks Direct Play even if codec is supported", () => {

    for (const cfg of [
        { profile: "Main 10", pixelFormat: "yuv420p10le" },
        { profile: "High 4:4:4 Predictive", pixelFormat: "yuv444p" },
        { profile: "High", pixelFormat: "yuv422p10le" }
    ]) {
        const r = decidePlayback(media({ video: [v(Object.assign({ codec: "hevc" }, cfg))] }), FULL_CLIENT);
        assert.equal(r.mode, MODES.VIDEO_TRANSCODE, JSON.stringify(cfg));
        assert.ok(
            r.directPlay.blockers.some(b => /high-bit-depth|non-4:2:0/.test(b)),
            JSON.stringify(cfg)
        );
        assert.equal(r.source.video.exotic, true);
    }
});

test("isExoticVideoConfig: common 8-bit 4:2:0 is not exotic", () => {
    assert.equal(isExoticVideoConfig({ pixelFormat: "yuv420p", profile: "High" }), false);
    assert.equal(isExoticVideoConfig({ pixelFormat: "yuvj420p", profile: "Constrained Baseline" }), false);
    assert.equal(isExoticVideoConfig({ pixelFormat: "nv12", profile: "Main" }), false);
    assert.equal(isExoticVideoConfig({ pixelFormat: null, profile: null }), false);
    assert.equal(isExoticVideoConfig({ pixelFormat: "yuv420p10le", profile: "Main 10" }), true);
});


// ============================================================
// Stream-count handling
// ============================================================

test("audio-only media (m4a/aac) -> DIRECT_PLAY when client supports mp4 + aac", () => {

    const r = decidePlayback(
        media({ video: [], file: { path: "/library/Song.m4a", size: 10 }, audio: [a({ index: 0 })] }),
        FULL_CLIENT
    );

    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.source.video, null);
    assert.equal(r.source.audio.codec, "aac");
    assert.equal(r.videoTranscode.videoCodec, null);
});

test("audio-only media in an unmodelled container with unknown client -> a transcode mode, no throw", () => {

    const r = decidePlayback(
        media({ video: [], file: { path: "/library/Song.flac", size: 10 }, container: { format: "flac" }, audio: [a({ index: 0, codec: "flac" })] }),
        {}
    );

    assert.ok([MODES.AUDIO_TRANSCODE, MODES.VIDEO_TRANSCODE].includes(r.mode));
    assert.equal(r.source.video, null);
});

test("video-only media -> DIRECT_PLAY when video + container supported", () => {

    const r = decidePlayback(media({ audio: [] }), FULL_CLIENT);
    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.source.audio, null);
    assert.equal(r.source.audioStreamCount, 0);
});

test("multiple audio streams: decision uses the FIRST stream, count is reported", () => {

    const supported = decidePlayback(
        media({ audio: [a({ index: 1, codec: "aac" }), a({ index: 2, codec: "ac3", language: "fra" }), a({ index: 3, codec: "eac3" })] }),
        FULL_CLIENT
    );
    assert.equal(supported.mode, MODES.DIRECT_PLAY);
    assert.equal(supported.source.audioStreamCount, 3);
    assert.ok(supported.warnings.some(w => /3 audio streams present/.test(w)));

    const firstBad = decidePlayback(
        media({ audio: [a({ index: 1, codec: "ac3" }), a({ index: 2, codec: "aac" })] }),
        clientWithout("audio", "ac3")
    );
    assert.equal(firstBad.mode, MODES.AUDIO_TRANSCODE);
    assert.equal(firstBad.source.audio.codec, "ac3");
    assert.equal(firstBad.source.audioStreamCount, 2);
});

test("multiple video streams: decision uses the FIRST stream, count is reported", () => {

    const r = decidePlayback(
        media({ video: [v({ index: 0 }), v({ index: 1, codec: "mjpeg", avg_frame_rate: "0/0" })] }),
        FULL_CLIENT
    );
    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.source.videoStreamCount, 2);
    assert.ok(r.warnings.some(w => /2 video streams present/.test(w)));
});


// ============================================================
// Malformed / incomplete inputs
// ============================================================

test("malformed / incomplete media probe -> VIDEO_TRANSCODE, no throw", () => {

    for (const bad of [
        null, undefined, "garbage", 42, [],
        { ok: false, error: "probe_failed" },
        { ok: true },
        { ok: true, video: [], audio: [] },
        { ok: true, video: "nope", audio: null }
    ]) {
        const r = decidePlayback(bad, FULL_CLIENT);
        assert.equal(r.mode, MODES.VIDEO_TRANSCODE, JSON.stringify(bad));
        assert.equal(r.directPlay.possible, false);
        assert.equal(r.remux.possible, false);
        assert.equal(r.audioTranscode.possible, false);
        assert.equal(r.videoTranscode.possible, true);
        assert.ok(Object.isFrozen(r));
    }
});

test("malformed / incomplete client model -> normalised to unknown -> conservative, no throw", () => {

    for (const bad of [null, undefined, "nope", 7, [], { video: "x" }, { video: { h264: "weird" } }, { containers: [1, 2] }]) {
        const r = decidePlayback(media(), bad);
        assert.equal(r.mode, MODES.VIDEO_TRANSCODE, JSON.stringify(bad));
        assert.equal(r.directPlay.possible, false);
        assert.ok(Object.isFrozen(r));
    }
});

test("engine output is deterministic (same inputs -> deep-equal result)", () => {

    const m = media({ file: { path: "/library/X.mkv" }, container: { format: "matroska,webm" }, audio: [a({ codec: "ac3" })] });
    const c = clientWithout("audio", "ac3");
    assert.deepEqual(decidePlayback(m, c), decidePlayback(m, c));
});


// ============================================================
// resolveContainer helper
// ============================================================

test("resolveContainer: extension wins, ffprobe format is the fallback", () => {

    assert.equal(resolveContainer({ file: { path: "/a/b.mkv" }, container: { format: "matroska,webm" } }), "mkv");
    assert.equal(resolveContainer({ file: { path: "/a/b.webm" }, container: { format: "matroska,webm" } }), "webm");
    assert.equal(resolveContainer({ file: { path: "/a/b.mp4" }, container: { format: "mov,mp4,m4a,3gp,3g2,mj2" } }), "mp4");
    assert.equal(resolveContainer({ file: { path: "/a/b.mov" }, container: { format: "mov,mp4,m4a,3gp,3g2,mj2" } }), "mov");
    assert.equal(resolveContainer({ file: { path: "/a/b.m4v" }, container: { format: "" } }), "mp4");
    assert.equal(resolveContainer({ file: { path: "/a/b.avi" }, container: { format: "avi" } }), "avi");
    assert.equal(resolveContainer({ file: { path: "/a/b" }, container: { format: "matroska,webm" } }), "mkv");
    assert.equal(resolveContainer({ file: { path: "/a/b.xyz" }, container: { format: "unknownfmt" } }), null);
});


// ============================================================
// Regression: Tasks 2-5 untouched
// ============================================================

test("regression: Task 2-5 modules load and keep their contracts", () => {

    const ffmpeg = require(path.join(REPO_ROOT, "ffmpeg.js"));
    assert.equal(typeof ffmpeg.probeRaw, "function");
    assert.equal(ffmpeg.checkPlayability({ videoCodec: "h264", audioCodec: "aac" }).canDirectPlay, true);
    assert.equal(ffmpeg.checkPlayability({ videoCodec: "hevc", audioCodec: "aac" }).canDirectPlay, false);

    const mediaProbe = require(path.join(REPO_ROOT, "media-probe.js"));
    assert.equal(typeof mediaProbe.describeMedia, "function");

    const cc = require(path.join(REPO_ROOT, "client-capabilities.js"));
    assert.equal(cc.capabilityOf(cc.defaultCapabilities(), "video", "h264"), cc.STATES.UNKNOWN);

    const mp = require(path.join(REPO_ROOT, "media-path.js"));
    assert.equal(typeof mp.resolveMediaFilePath, "function");

    // engine must not pull the listening server into the require graph
    const pulledServer = Object.keys(require.cache).filter(k => k.endsWith(path.sep + "server.js"));
    assert.deepEqual(pulledServer, []);
});

test("regression: end-to-end media-probe -> client-capabilities -> decision", () => {

    const mediaProbe = require(path.join(REPO_ROOT, "media-probe.js"));
    const cc = require(path.join(REPO_ROOT, "client-capabilities.js"));

    const probed = mediaProbe.normalizeProbe(
        {
            format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10", size: "999", bit_rate: "800000" },
            streams: [
                { index: 0, codec_type: "video", codec_name: "h264", profile: "High", width: 1280, height: 720, pix_fmt: "yuv420p", r_frame_rate: "24/1" },
                { index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }
            ]
        },
        { path: "/library/clip.mp4", size: 999 }
    );
    assert.equal(probed.ok, true);

    const client = cc.normalizeClientCapabilities({
        client: "browser",
        video: { h264: "probably" },
        audio: { aac: true },
        containers: { mp4: true }
    });

    const decision = decidePlayback(probed, client);
    assert.equal(decision.mode, MODES.DIRECT_PLAY);
    assert.equal(decision.source.video.width, 1280);
});
