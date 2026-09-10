"use strict";

/*
    Structured media-probe tests (Task 4).

    media-probe.js is pure normalisation over a raw ffprobe document
    plus thin filesystem/subprocess handling, so these tests use
    controlled ffprobe-output fixtures (and an injectable probe fn)
    rather than real media -- the assertions stay exact regardless of
    whether ffprobe is installed on the test host.

    Also asserts the Task 4 "do not disturb existing behaviour"
    contract: ffmpeg.probeFile / checkPlayability are untouched.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const { describeMedia, normalizeProbe } = require(path.join(REPO_ROOT, "media-probe.js"));
const ffmpeg = require(path.join(REPO_ROOT, "ffmpeg.js"));


// ---- fixture builders -----------------------------------------

function videoStream(over) {
    return Object.assign({
        index: 0,
        codec_name: "h264",
        codec_type: "video",
        profile: "High",
        width: 1920,
        height: 1080,
        pix_fmt: "yuv420p",
        r_frame_rate: "24000/1001",
        avg_frame_rate: "24000/1001",
        bit_rate: "8000000",
        tags: { language: "und" }
    }, over || {});
}

function audioStream(over) {
    return Object.assign({
        index: 1,
        codec_name: "aac",
        codec_type: "audio",
        channels: 2,
        sample_rate: "48000",
        bit_rate: "128000",
        tags: { language: "eng" }
    }, over || {});
}

function subtitleStream(over) {
    return Object.assign({
        index: 2,
        codec_name: "subrip",
        codec_type: "subtitle",
        tags: { language: "eng" }
    }, over || {});
}

function ffprobeDoc(streams, formatOver) {
    return {
        streams: streams,
        format: Object.assign({
            filename: "fixture.mkv",
            format_name: "matroska,webm",
            duration: "1418.123000",
            size: "1500000000",
            bit_rate: "8460000"
        }, formatOver || {})
    };
}

const FILE_INFO = { path: "/library/fixture.mkv", size: 1500000000 };


// ============================================================
// NORMALISATION -- happy paths / stream modelling
// ============================================================

test("normalizeProbe: single video + single audio", async (t) => {

    const result = normalizeProbe(
        ffprobeDoc([videoStream(), audioStream()]),
        FILE_INFO
    );

    await t.test("ok + file + container", () => {
        assert.equal(result.ok, true);
        assert.deepEqual(result.file, { path: "/library/fixture.mkv", size: 1500000000 });
        assert.equal(result.container.format, "matroska,webm");
        assert.equal(result.container.duration, 1418.123);
        assert.equal(result.container.bitrate, 8460000);
    });

    await t.test("video stream fully described + numeric", () => {
        assert.equal(result.video.length, 1);
        const v = result.video[0];
        assert.deepEqual(v, {
            index: 0,
            codec: "h264",
            profile: "High",
            width: 1920,
            height: 1080,
            frameRate: 23.976,
            pixelFormat: "yuv420p",
            bitrate: 8000000
        });
        assert.equal(typeof v.width, "number");
        assert.equal(typeof v.frameRate, "number");
    });

    await t.test("audio stream fully described + numeric", () => {
        assert.equal(result.audio.length, 1);
        assert.deepEqual(result.audio[0], {
            index: 1,
            codec: "aac",
            channels: 2,
            sampleRate: 48000,
            bitrate: 128000,
            language: "eng",
            title: null,
            default: false
        });
        assert.equal(typeof result.audio[0].sampleRate, "number");
    });

    await t.test("no subtitles -> empty array", () => {
        assert.deepEqual(result.subtitles, []);
    });
});


test("normalizeProbe: multiple audio streams are all kept, indexes preserved", () => {

    const doc = ffprobeDoc([
        videoStream({ index: 0 }),
        audioStream({ index: 1, channels: 6, codec_name: "eac3", tags: { language: "eng" } }),
        audioStream({ index: 2, channels: 2, codec_name: "ac3", tags: { language: "jpn" } }),
        audioStream({ index: 3, channels: 2, codec_name: "aac", tags: { language: "eng", title: "Commentary" } })
    ]);

    const result = normalizeProbe(doc, FILE_INFO);

    assert.equal(result.audio.length, 3);
    assert.deepEqual(result.audio.map(a => a.index), [1, 2, 3]);
    assert.deepEqual(result.audio.map(a => a.language), ["eng", "jpn", "eng"]);
    assert.deepEqual(result.audio.map(a => a.channels), [6, 2, 2]);
    assert.deepEqual(result.audio.map(a => a.codec), ["eac3", "ac3", "aac"]);
    assert.equal(result.video.length, 1);
});


test("normalizeProbe: multiple subtitle streams + text/image typing", () => {

    const doc = ffprobeDoc([
        videoStream({ index: 0 }),
        audioStream({ index: 1 }),
        subtitleStream({ index: 2, codec_name: "subrip", tags: { language: "eng" } }),
        subtitleStream({ index: 3, codec_name: "ass", tags: { language: "jpn" } }),
        subtitleStream({ index: 4, codec_name: "hdmv_pgs_subtitle", tags: { language: "eng" } }),
        subtitleStream({ index: 5, codec_name: "dvb_subtitle", tags: {} })
    ]);

    const result = normalizeProbe(doc, FILE_INFO);

    assert.equal(result.subtitles.length, 4);
    assert.deepEqual(result.subtitles.map(s => s.index), [2, 3, 4, 5]);
    assert.deepEqual(result.subtitles.map(s => s.codec), ["subrip", "ass", "hdmv_pgs_subtitle", "dvb_subtitle"]);
    assert.deepEqual(result.subtitles.map(s => s.type), ["text", "text", "image", "image"]);
    assert.deepEqual(result.subtitles.map(s => s.language), ["eng", "jpn", "eng", null]);
});


test("normalizeProbe: multiple video streams (e.g. attached cover art)", () => {

    const doc = ffprobeDoc([
        videoStream({ index: 0, codec_name: "hevc", profile: "Main 10", pix_fmt: "yuv420p10le" }),
        videoStream({ index: 1, codec_name: "mjpeg", width: 600, height: 900, avg_frame_rate: "0/0", r_frame_rate: "90000/3753" }),
        audioStream({ index: 2 })
    ]);

    const result = normalizeProbe(doc, FILE_INFO);

    assert.equal(result.video.length, 2);
    assert.equal(result.video[0].codec, "hevc");
    assert.equal(result.video[0].profile, "Main 10");
    assert.equal(result.video[1].codec, "mjpeg");
    assert.deepEqual(result.video.map(v => v.index), [0, 1]);
});


test("normalizeProbe: media with NO video stream is ok, not an error", () => {

    const doc = ffprobeDoc([
        audioStream({ index: 0, codec_name: "flac", channels: 2 })
    ], { format_name: "flac" });

    const result = normalizeProbe(doc, { path: "/library/song.flac", size: 40000000 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.video, []);
    assert.equal(result.audio.length, 1);
    assert.equal(result.audio[0].codec, "flac");
    assert.deepEqual(result.subtitles, []);
});


test("normalizeProbe: stream indexes preserved when non-contiguous / reordered", () => {

    const doc = ffprobeDoc([
        audioStream({ index: 3, codec_type: "audio" }),
        videoStream({ index: 0 }),
        subtitleStream({ index: 7 }),
        audioStream({ index: 5, tags: { language: "fra" } })
    ]);

    const result = normalizeProbe(doc, FILE_INFO);

    assert.deepEqual(result.video.map(v => v.index), [0]);
    assert.deepEqual(result.audio.map(a => a.index), [3, 5]);
    assert.deepEqual(result.subtitles.map(s => s.index), [7]);
});


// ============================================================
// NORMALISATION -- numeric field normalisation
// ============================================================

test("normalizeProbe: numeric fields normalised to Number or null (never string/NaN)", () => {

    const doc = ffprobeDoc([
        videoStream({
            index: 0,
            width: "1280",              // string
            height: "720",              // string
            bit_rate: "N/A",            // literal N/A
            r_frame_rate: "30/1",
            avg_frame_rate: "0/0",      // unknown -> fall back to r_frame_rate
            profile: undefined
        }),
        audioStream({
            index: 1,
            channels: 6,                // number
            sample_rate: "44100",       // string
            bit_rate: undefined         // missing
        })
    ], {
        duration: undefined,            // missing container duration
        bit_rate: "N/A",
        size: "1500000000"
    });

    const result = normalizeProbe(doc, { path: "/x.mkv", size: null });

    // container
    assert.equal(result.container.duration, null);
    assert.equal(result.container.bitrate, null);

    // file.size falls back to ffprobe format.size when caller had none
    assert.equal(result.file.size, 1500000000);

    // video
    const v = result.video[0];
    assert.equal(v.width, 1280);
    assert.equal(v.height, 720);
    assert.equal(v.bitrate, null);
    assert.equal(v.frameRate, 30);
    assert.equal(v.profile, null);
    for (const key of ["width", "height", "frameRate"]) {
        assert.equal(typeof v[key], "number", key + " should be a number");
        assert.ok(!Number.isNaN(v[key]), key + " not NaN");
    }

    // audio
    const a = result.audio[0];
    assert.equal(a.channels, 6);
    assert.equal(a.sampleRate, 44100);
    assert.equal(a.bitrate, null);
});


test("normalizeProbe: frameRate rational parsing + unknown handling", () => {

    const mk = (avg, r) => normalizeProbe(
        ffprobeDoc([videoStream({ avg_frame_rate: avg, r_frame_rate: r })]),
        FILE_INFO
    ).video[0].frameRate;

    assert.equal(mk("24000/1001", "24000/1001"), 23.976);
    assert.equal(mk("30/1", "30/1"), 30);
    assert.equal(mk("0/0", "25/1"), 25);        // avg unknown -> r
    assert.equal(mk("0/0", "0/0"), null);       // both unknown
    assert.equal(mk("60/1", "0/0"), 60);
});


test("normalizeProbe: language tag fallbacks", () => {

    const lang = (tags) => normalizeProbe(
        ffprobeDoc([videoStream({ index: 0 }), audioStream({ index: 1, tags })]),
        FILE_INFO
    ).audio[0].language;

    assert.equal(lang({ language: "eng" }), "eng");
    assert.equal(lang({ LANGUAGE: "ger" }), "ger");
    assert.equal(lang({ language: "" }), null);
    assert.equal(lang({}), null);
    assert.equal(lang(undefined), null);
});


// ============================================================
// NORMALISATION -- malformed / missing ffprobe output
// ============================================================

test("normalizeProbe: malformed documents -> { ok:false, error:'probe_failed' }", () => {

    for (const bad of [null, undefined, "not json", 123, [], {}, { foo: 1 }, { format: [] }]) {
        const r = normalizeProbe(bad, FILE_INFO);
        assert.equal(r.ok, false, JSON.stringify(bad));
        assert.equal(r.error, "probe_failed", JSON.stringify(bad));
        assert.deepEqual(r.file, { path: "/library/fixture.mkv", size: 1500000000 });
    }
});

test("normalizeProbe: document with only streams (no format block) still normalises", () => {

    const r = normalizeProbe(
        { streams: [videoStream({ index: 0 }), audioStream({ index: 1 })] },
        { path: "/x.ts", size: 500 }
    );

    assert.equal(r.ok, true);
    assert.equal(r.container.format, null);
    assert.equal(r.container.duration, null);
    assert.equal(r.video.length, 1);
    assert.equal(r.audio.length, 1);
});

test("normalizeProbe: non-object stream entries are skipped, not fatal", () => {

    const r = normalizeProbe(
        ffprobeDoc([videoStream({ index: 0 }), null, "junk", 5, audioStream({ index: 1 })]),
        FILE_INFO
    );

    assert.equal(r.ok, true);
    assert.equal(r.video.length, 1);
    assert.equal(r.audio.length, 1);
});


// ============================================================
// describeMedia -- filesystem + probe wiring + failures
// ============================================================

test("describeMedia: missing file -> not_found", async () => {

    const r = await describeMedia(path.join(os.tmpdir(), "definitely-not-here-" + Date.now() + ".mkv"));
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_found");
    assert.equal(r.file.size, null);
});

test("describeMedia: a directory is not a media file -> not_found", async () => {

    const r = await describeMedia(os.tmpdir());
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_found");
});

test("describeMedia: ffprobe returns null -> probe_failed (with real file size)", async () => {

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-probe-")), "clip.mkv");
    fs.writeFileSync(tmp, Buffer.alloc(4096));

    try {
        const r = await describeMedia(tmp, { probe: async () => null });
        assert.equal(r.ok, false);
        assert.equal(r.error, "probe_failed");
        assert.equal(r.file.path, tmp);
        assert.equal(r.file.size, 4096);
    } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
});

test("describeMedia: ffprobe throwing is treated as probe_failed, not a crash", async () => {

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-probe-")), "clip.mkv");
    fs.writeFileSync(tmp, Buffer.alloc(10));

    try {
        const r = await describeMedia(tmp, {
            probe: async () => { throw new Error("spawn ffprobe ENOENT"); }
        });
        assert.equal(r.ok, false);
        assert.equal(r.error, "probe_failed");
    } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
});

test("describeMedia: happy path with injected probe uses real file size", async () => {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-probe-"));
    const tmp = path.join(dir, "movie.mkv");
    fs.writeFileSync(tmp, Buffer.alloc(123456));

    try {
        const r = await describeMedia(tmp, {
            probe: async () => ffprobeDoc([videoStream(), audioStream(), subtitleStream()])
        });
        assert.equal(r.ok, true);
        assert.equal(r.file.path, tmp);
        assert.equal(r.file.size, 123456);          // from statSync, not fixture
        assert.equal(r.video.length, 1);
        assert.equal(r.audio.length, 1);
        assert.equal(r.subtitles.length, 1);
        assert.equal(r.video[0].frameRate, 23.976);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});


// ============================================================
// REGRESSION -- Task 1..3 behaviour must be undisturbed
// ============================================================

test("regression: ffmpeg.js existing contract is intact", () => {

    assert.equal(typeof ffmpeg.probeFile, "function");
    assert.equal(typeof ffmpeg.checkPlayability, "function");
    assert.equal(typeof ffmpeg.probeRaw, "function", "probeRaw is the only addition");
    assert.equal(typeof ffmpeg.transcodeToMp4Stream, "function");
    assert.equal(typeof ffmpeg.getTranscodedRelativePath, "function");

    // checkPlayability semantics unchanged.
    assert.equal(
        ffmpeg.checkPlayability({ videoCodec: "h264", audioCodec: "aac" }).canDirectPlay,
        true
    );
    assert.equal(
        ffmpeg.checkPlayability({ videoCodec: "hevc", audioCodec: "aac" }).canDirectPlay,
        false
    );
    assert.equal(ffmpeg.checkPlayability(null).canDirectPlay, false);
});

test("regression: Task 2 media-path guard still exports its API; media-probe has no require cycle", () => {

    const mediaPath = require(path.join(REPO_ROOT, "media-path.js"));
    assert.equal(typeof mediaPath.resolveMediaFilePath, "function");
    assert.equal(typeof mediaPath.isStrictlyInside, "function");

    // media-probe only depends on ffmpeg.js -- it must not drag
    // server.js (which listens on a port) into the require graph.
    const probeDeps = Object.keys(require.cache)
        .filter(k => k.endsWith(path.sep + "server.js"));
    assert.deepEqual(probeDeps, [], "media-probe must not require server.js");

    assert.doesNotThrow(() => {
        delete require.cache[require.resolve(path.join(REPO_ROOT, "media-probe.js"))];
        require(path.join(REPO_ROOT, "media-probe.js"));
    });
});
