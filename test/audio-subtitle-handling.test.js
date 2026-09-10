"use strict";

/*
    Audio / Subtitle Handling tests (Task 13).

    Baseflicks must discover, preserve, select and expose audio /
    subtitle streams across Direct Play, Remux, Audio Transcode and
    Video Transcode -- WITHOUT ever assuming `audio:0` is the track the
    user wants, without a second decision engine, and without changing
    the Task 6 priority.

    Part A -- media-probe.js exposes the per-stream metadata (pure,
              fixture-driven).
    Part B -- playback-integration.resolveSelectedStreams(): default vs
              explicit track selection, conservative subtitles.
    Part C -- playback-integration.resolvePlaybackMode(): an explicit
              selection is carried to the execution layer; the Task 6
              priority (Direct Play > Remux > Audio > Video) is
              unchanged; ffprobe runs once per viewing session.
    Part D -- remux.js / audio-transcode.js / video-transcode.js:
              audioStreamIndex is part of the cache identity ONLY when
              a track was explicitly chosen, and is passed to ffmpeg.
    Part E -- ffmpeg.primaryMapArgs(): -map targets the selected audio
              stream and stays shell-safe (argv, integers only).
    Part F -- real `node server.js` + real ffmpeg: `?audio=<n>` selects
              a non-first audio stream that actually reaches the remux
              output; Range + path containment intact; no selection ->
              byte-identical to the pre-Task-13 path.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.join(__dirname, "..");
const { normalizeProbe } = require(path.join(REPO_ROOT, "media-probe.js"));
const integration = require(path.join(REPO_ROOT, "playback-integration.js"));
const ffmpeg = require(path.join(REPO_ROOT, "ffmpeg.js"));
const remux = require(path.join(REPO_ROOT, "remux.js"));
const at = require(path.join(REPO_ROOT, "audio-transcode.js"));
const vt = require(path.join(REPO_ROOT, "video-transcode.js"));
const { MODES } = require(path.join(REPO_ROOT, "playback-decision.js"));
const APP_FILES = require("./_app-files");

let FFMPEG = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
catch (e) { FFMPEG = false; }

const tick = () => new Promise(r => setTimeout(r, 15));


// ---- fixture builders ----------------------------------------

function vStream(over) {
    return Object.assign({
        index: 0, codec_name: "h264", codec_type: "video",
        profile: "High", width: 1920, height: 1080, pix_fmt: "yuv420p",
        avg_frame_rate: "24/1", r_frame_rate: "24/1"
    }, over || {});
}
function aStream(over) {
    return Object.assign({
        index: 1, codec_name: "aac", codec_type: "audio",
        channels: 2, sample_rate: "48000", bit_rate: "128000"
    }, over || {});
}
function sStream(over) {
    return Object.assign({
        index: 2, codec_name: "subrip", codec_type: "subtitle"
    }, over || {});
}
function doc(streams, fmt) {
    return {
        streams: streams,
        format: Object.assign({ format_name: "matroska,webm", duration: "60.0", size: "1000" }, fmt || {})
    };
}
const FI = { path: "/lib/movie.mkv", size: 1000 };

function probe(streams, fmt) {
    return normalizeProbe(doc(streams, fmt), FI);
}


// ============================================================
// PART A -- media-probe exposes audio / subtitle metadata
// ============================================================

test("A1 single audio stream: index, codec, channels, sampleRate, bitrate, language, title, default", () => {
    const r = probe([
        vStream(),
        aStream({ index: 1, channels: 6, bit_rate: "384000", sample_rate: "48000",
                  tags: { language: "eng", title: "Main" }, disposition: { default: 1 } })
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.audio[0], {
        index: 1, codec: "aac", channels: 6, sampleRate: 48000, bitrate: 384000,
        language: "eng", title: "Main", default: true
    });
});

test("A2 multi audio: every stream kept, index + language + title + default per track", () => {
    const r = probe([
        vStream({ index: 0 }),
        aStream({ index: 1, codec_name: "eac3", tags: { language: "eng" }, disposition: { default: 1 } }),
        aStream({ index: 2, codec_name: "ac3", tags: { language: "jpn" } }),
        aStream({ index: 3, codec_name: "aac", tags: { language: "eng", title: "Commentary" } })
    ]);
    assert.equal(r.audio.length, 3);
    assert.deepEqual(r.audio.map(a => a.index), [1, 2, 3]);
    assert.deepEqual(r.audio.map(a => a.language), ["eng", "jpn", "eng"]);
    assert.deepEqual(r.audio.map(a => a.title), [null, null, "Commentary"]);
    assert.deepEqual(r.audio.map(a => a.default), [true, false, false]);
});

test("A3 audio with no language tag -> language:null, schema intact", () => {
    const r = probe([vStream(), aStream({ index: 1, tags: {} })]);
    assert.equal(r.audio[0].language, null);
    assert.equal(r.audio[0].title, null);
    assert.equal(r.audio[0].default, false);
    // untouched keys still present
    for (const k of ["index", "codec", "channels", "sampleRate", "bitrate"]) {
        assert.ok(k in r.audio[0], k);
    }
});

test("A4 no audio stream -> audio: []", () => {
    const r = probe([vStream()], { format_name: "matroska,webm" });
    assert.deepEqual(r.audio, []);
});

test("A5 single subtitle: index, codec, language, title, default, forced, type", () => {
    const r = probe([
        vStream(), aStream({ index: 1 }),
        sStream({ index: 2, codec_name: "subrip",
                  tags: { language: "eng", title: "Full" },
                  disposition: { default: 1, forced: 0 } })
    ]);
    assert.deepEqual(r.subtitles[0], {
        index: 2, codec: "subrip", language: "eng", title: "Full",
        default: true, forced: false, type: "text"
    });
});

test("A6 multi subtitles kept; image vs text typing; missing language -> null", () => {
    const r = probe([
        vStream(), aStream({ index: 1 }),
        sStream({ index: 2, codec_name: "subrip", tags: { language: "eng" } }),
        sStream({ index: 3, codec_name: "hdmv_pgs_subtitle", tags: {} }),
        sStream({ index: 4, codec_name: "ass", tags: { language: "jpn" }, disposition: { forced: 1 } })
    ]);
    assert.equal(r.subtitles.length, 3);
    assert.deepEqual(r.subtitles.map(s => s.index), [2, 3, 4]);
    assert.deepEqual(r.subtitles.map(s => s.type), ["text", "image", "text"]);
    assert.deepEqual(r.subtitles.map(s => s.language), ["eng", null, "jpn"]);
    assert.deepEqual(r.subtitles.map(s => s.forced), [false, false, true]);
});

test("A7 default + forced subtitle dispositions surfaced independently", () => {
    const r = probe([
        vStream(), aStream({ index: 1 }),
        sStream({ index: 2, disposition: { default: 1, forced: 0 } }),
        sStream({ index: 3, disposition: { default: 0, forced: 1 } })
    ]);
    assert.deepEqual(r.subtitles.map(s => [s.default, s.forced]), [[true, false], [false, true]]);
});

test("A8 no subtitles -> subtitles: []", () => {
    const r = probe([vStream(), aStream({ index: 1 })]);
    assert.deepEqual(r.subtitles, []);
});

test("A9 existing probe schema is NOT broken (video stream shape unchanged)", () => {
    const r = probe([vStream(), aStream({ index: 1 })]);
    assert.deepEqual(Object.keys(r).sort(), ["audio", "container", "file", "ok", "subtitles", "video"]);
    assert.deepEqual(r.video[0], {
        index: 0, codec: "h264", profile: "High", width: 1920, height: 1080,
        frameRate: 24, pixelFormat: "yuv420p", bitrate: null
    });
});


// ============================================================
// PART B -- resolveSelectedStreams()
// ============================================================

const rss = integration.resolveSelectedStreams;

test("B1 no selection, single audio -> that stream, reason 'default'", () => {
    const p = probe([vStream(), aStream({ index: 1 })]);
    const c = rss(p, {});
    assert.equal(c.audioStreamIndex, 1);
    assert.equal(c.audioReason, "default");
});

test("B2 no selection, multi audio with a default disposition -> the default one", () => {
    const p = probe([
        vStream({ index: 0 }),
        aStream({ index: 1 }),
        aStream({ index: 2, disposition: { default: 1 } }),
        aStream({ index: 3 })
    ]);
    assert.equal(rss(p, {}).audioStreamIndex, 2);
});

test("B3 no selection, multi audio, NO default -> the first audio stream (never assumes 0)", () => {
    const p = probe([
        vStream({ index: 0 }),
        aStream({ index: 4 }),
        aStream({ index: 5 })
    ]);
    const c = rss(p, {});
    assert.equal(c.audioStreamIndex, 4);
    assert.equal(c.audioReason, "default");
});

test("B4 explicit selection of a non-first audio stream is honoured", () => {
    const p = probe([vStream(), aStream({ index: 1 }), aStream({ index: 2 }), aStream({ index: 3 })]);
    const c = rss(p, { audio: 3 });
    assert.equal(c.audioStreamIndex, 3);
    assert.equal(c.audioReason, "selected");
});

test("B5 explicit selection of a missing index -> falls back to default, does not crash", () => {
    const p = probe([vStream(), aStream({ index: 1, disposition: { default: 1 } }), aStream({ index: 2 })]);
    const c = rss(p, { audio: 99 });
    assert.equal(c.audioStreamIndex, 1);
    assert.equal(c.audioReason, "fallback-default");
});

test("B6 no audio streams -> audioStreamIndex null, reason 'none'", () => {
    const c = rss(probe([vStream()], { format_name: "matroska,webm" }), { audio: 2 });
    assert.equal(c.audioStreamIndex, null);
    assert.equal(c.audioReason, "none");
});

test("B7 subtitles OFF by default (conservative)", () => {
    const p = probe([vStream(), aStream({ index: 1 }), sStream({ index: 2 }), sStream({ index: 3 })]);
    const c = rss(p, {});
    assert.equal(c.subtitleStreamIndex, null);
    assert.equal(c.subtitleReason, "off");
});

test("B8 a FORCED subtitle is auto-selected when nothing explicit is asked", () => {
    const p = probe([
        vStream(), aStream({ index: 1 }),
        sStream({ index: 2 }),
        sStream({ index: 3, disposition: { forced: 1 } })
    ]);
    const c = rss(p, {});
    assert.equal(c.subtitleStreamIndex, 3);
    assert.equal(c.subtitleReason, "forced");
});

test("B9 explicit subtitle index is honoured; explicit 'off' beats a forced track", () => {
    const p = probe([
        vStream(), aStream({ index: 1 }),
        sStream({ index: 2 }),
        sStream({ index: 3, disposition: { forced: 1 } })
    ]);
    assert.equal(rss(p, { subtitle: 2 }).subtitleStreamIndex, 2);
    assert.equal(rss(p, { subtitle: "off" }).subtitleStreamIndex, null);
    assert.equal(rss(p, { subtitle: "off" }).subtitleReason, "off");
});

test("B10 an invalid explicit subtitle index stays OFF (conservative), no throw", () => {
    const p = probe([vStream(), aStream({ index: 1 }), sStream({ index: 2 })]);
    const c = rss(p, { subtitle: 88 });
    assert.equal(c.subtitleStreamIndex, null);
    assert.equal(c.subtitleReason, "off");
});

test("B11 readStreamSelection parses the query string without throwing", () => {
    const read = integration.readStreamSelection;
    assert.deepEqual(read({ query: { audio: "2", subtitle: "3" } }), { audio: 2, subtitle: 3 });
    assert.deepEqual(read({ query: { subtitle: "off" } }), { audio: null, subtitle: "off" });
    assert.deepEqual(read({ query: { audio: "-1" } }), { audio: null, subtitle: null });
    assert.deepEqual(read({ query: { audio: "x" } }), { audio: null, subtitle: null });
    assert.deepEqual(read({}), { audio: null, subtitle: null });
    assert.deepEqual(read(undefined), { audio: null, subtitle: null });
});


// ============================================================
// PART C -- resolvePlaybackMode carries the selection
// ============================================================

const CAPS_DP = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true, mkv: true } };
const CAPS_REMUX = { video: { h264: true }, audio: { aac: true }, containers: { mp4: true } };

function describeFixture(p) {
    return async () => p;
}

test("C1 selected non-first audio stream reaches the execution layer (audioStreamIndex)", async () => {
    integration._clearDecisionCache();
    const p = probe([
        vStream(), aStream({ index: 1, tags: { language: "eng" } }),
        aStream({ index: 2, tags: { language: "fra" } })
    ]);
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: { video_codec: "h264", audio_codec: "aac" },
          needsTranscode: false, clientCapabilities: CAPS_REMUX, selection: { audio: 2 } },
        { describe: describeFixture(p) }
    );
    assert.equal(r.basis, "full-probe");
    assert.equal(r.audioStreamIndex, 2, "the selected absolute stream index is surfaced");
    assert.equal(r.mode, MODES.REMUX);
});

test("C2 Direct Play still wins when the selected track is client-supported", async () => {
    integration._clearDecisionCache();
    const p = probe([
        vStream(), aStream({ index: 1, codec_name: "aac", tags: { language: "eng" } }),
        aStream({ index: 2, codec_name: "aac", tags: { language: "fra" } })
    ]);
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: { video_codec: "h264", audio_codec: "aac" },
          needsTranscode: false, clientCapabilities: CAPS_DP, selection: { audio: 2 } },
        { describe: describeFixture(p) }
    );
    assert.equal(r.mode, MODES.DIRECT_PLAY);
    assert.equal(r.audioStreamIndex, 2);
});

test("C3 Remux still wins (container is the only blocker) with a selection", async () => {
    integration._clearDecisionCache();
    const p = probe([vStream(), aStream({ index: 1 }), aStream({ index: 2 })]);
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: {}, needsTranscode: false,
          clientCapabilities: CAPS_REMUX, selection: { audio: 2 } },
        { describe: describeFixture(p) }
    );
    assert.equal(r.mode, MODES.REMUX);
    assert.equal(r.target, "mp4");
});

test("C4 Audio Transcode wins when the SELECTED track is an unsupported codec", async () => {
    integration._clearDecisionCache();
    const p = probe([
        vStream(),
        aStream({ index: 1, codec_name: "aac", tags: { language: "eng" } }),
        aStream({ index: 2, codec_name: "ac3", tags: { language: "fra" } })
    ]);
    // client supports aac but NOT ac3; picking the ac3 track must
    // downgrade the decision to audio_transcode (Task 6 re-decides).
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: {}, needsTranscode: false,
          clientCapabilities: { video: { h264: true }, audio: { aac: true, ac3: false }, containers: { mp4: true, mkv: true } },
          selection: { audio: 2 } },
        { describe: describeFixture(p) }
    );
    assert.equal(r.mode, MODES.AUDIO_TRANSCODE);
    assert.equal(r.audioStreamIndex, 2);
    assert.equal(r.audioCodec, "aac");
});

test("C5 Video Transcode still reachable with a selection present", async () => {
    integration._clearDecisionCache();
    const p = probe([
        vStream({ codec_name: "mpeg4" }),
        aStream({ index: 1 }), aStream({ index: 2 })
    ], { format_name: "avi" });
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.avi", row: {}, needsTranscode: false,
          clientCapabilities: CAPS_REMUX, selection: { audio: 2 } },
        { describe: describeFixture(p) }
    );
    assert.equal(r.mode, MODES.VIDEO_TRANSCODE);
    assert.equal(r.audioStreamIndex, 2);
});

test("C6 no explicit selection -> unchanged lightweight path, audioStreamIndex null", async () => {
    integration._clearDecisionCache();
    let probed = false;
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: { video_codec: "h264", audio_codec: "aac" },
          needsTranscode: false, clientCapabilities: CAPS_REMUX },
        { describe: async () => { probed = true; return probe([vStream(), aStream({ index: 1 })]); } }
    );
    assert.equal(probed, false, "no ffprobe without an explicit selection");
    assert.equal(r.basis, "lightweight");
    assert.equal(r.audioStreamIndex, null);
    assert.equal(r.mode, MODES.REMUX);
});

test("C7 selection branch runs ffprobe only once per viewing session (cached)", async () => {
    integration._clearDecisionCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t13-cache-"));
    const fp = path.join(dir, "movie.mkv");
    fs.writeFileSync(fp, Buffer.alloc(2048));
    let calls = 0;
    const describe = async () => { calls++; return probe([vStream(), aStream({ index: 1 }), aStream({ index: 2 })]); };
    const params = { filePath: fp, row: {}, needsTranscode: false, clientCapabilities: CAPS_REMUX, selection: { audio: 2 } };
    const a = await integration.resolvePlaybackMode({ ...params }, { describe });
    const b = await integration.resolvePlaybackMode({ ...params }, { describe });
    assert.equal(calls, 1, "second Range request reuses the resolved selection");
    assert.equal(a.audioStreamIndex, 2);
    assert.equal(b.audioStreamIndex, 2);
    assert.equal(b.cached, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("C8 an unreadable probe makes the selection a no-op (safe fallback)", async () => {
    integration._clearDecisionCache();
    const r = await integration.resolvePlaybackMode(
        { filePath: "/lib/movie.mkv", row: { video_codec: "h264", audio_codec: "aac" },
          needsTranscode: false, clientCapabilities: CAPS_REMUX, selection: { audio: 2 } },
        { describe: async () => ({ ok: false, error: "probe_failed" }) }
    );
    // falls through to the lightweight decision, selection ignored
    assert.equal(r.basis, "lightweight");
    assert.equal(r.audioStreamIndex, null);
});


// ============================================================
// PART D -- cache identity + ffmpeg threading in the executors
// ============================================================

test("D1 remux cache key: audioStreamIndex only participates when explicitly set", () => {
    const base = remux.remuxCacheKey("A.mkv", 100, 5, "mp4");
    assert.equal(base, remux.remuxCacheKey("A.mkv", 100, 5, "mp4", null), "null -> historical key");
    assert.equal(base, remux.remuxCacheKey("A.mkv", 100, 5, "mp4", -1), "invalid -> historical key");
    assert.equal(base, remux.remuxCacheKey("A.mkv", 100, 5, "mp4", 1.5), "non-integer -> historical key");
    assert.notEqual(base, remux.remuxCacheKey("A.mkv", 100, 5, "mp4", 0), "explicit 0 changes the key");
    assert.notEqual(base, remux.remuxCacheKey("A.mkv", 100, 5, "mp4", 2), "explicit 2 changes the key");
    assert.notEqual(
        remux.remuxCacheKey("A.mkv", 100, 5, "mp4", 1),
        remux.remuxCacheKey("A.mkv", 100, 5, "mp4", 2),
        "different selected tracks -> different cache files"
    );
});

test("D2 audio-transcode cache key: same rule", () => {
    const base = at.audioTranscodeCacheKey("A.mkv", 100, 5, "mp4", "aac");
    assert.equal(base, at.audioTranscodeCacheKey("A.mkv", 100, 5, "mp4", "aac", null));
    assert.notEqual(base, at.audioTranscodeCacheKey("A.mkv", 100, 5, "mp4", "aac", 3));
});

test("D3 video-transcode cache key: same rule", () => {
    const base = vt.videoTranscodeCacheKey("A.mkv", 100, 5, "mp4", "h264", "aac");
    assert.equal(base, vt.videoTranscodeCacheKey("A.mkv", 100, 5, "mp4", "h264", "aac", null));
    assert.notEqual(base, vt.videoTranscodeCacheKey("A.mkv", 100, 5, "mp4", "h264", "aac", 3));
});

function srcFile(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t13-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(512));
    return p;
}

test("D4 ensureRemux passes options.audioStreamIndex to the ffmpeg runner", async () => {
    const src = srcFile("r.mkv");
    let seen;
    const run = async (i, o, op) => { seen = op.audioStreamIndex; fs.writeFileSync(o, "X"); };
    const r = await remux.ensureRemux(
        { sourcePath: src, relativePath: "r.mkv", container: "mp4", audioStreamIndex: 2 }, { run });
    assert.equal(r.ok, true);
    assert.equal(seen, 2);
    fs.rmSync(r.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("D5 ensureAudioTranscode passes options.audioStreamIndex to the ffmpeg runner", async () => {
    const src = srcFile("a.mkv");
    let seen;
    const run = async (i, o, op) => { seen = op.audioStreamIndex; fs.writeFileSync(o, "X"); };
    const r = await at.ensureAudioTranscode(
        { sourcePath: src, relativePath: "a.mkv", container: "mp4", audioCodec: "aac", audioStreamIndex: 4 }, { run });
    assert.equal(r.ok, true);
    assert.equal(seen, 4);
    fs.rmSync(r.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("D6 ensureVideoTranscode passes options.audioStreamIndex to the ffmpeg runner", async () => {
    const src = srcFile("v.mkv");
    let seen;
    const run = async (i, o, op) => { seen = op.audioStreamIndex; fs.writeFileSync(o, "X"); };
    const r = await vt.ensureVideoTranscode(
        { sourcePath: src, relativePath: "v.mkv", container: "mp4", videoCodec: "h264", audioCodec: "aac", audioStreamIndex: 1 }, { run });
    assert.equal(r.ok, true);
    assert.equal(seen, 1);
    fs.rmSync(r.path, { force: true });
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

test("D7 no selection -> executor cache path is byte-identical to the pre-Task-13 path", () => {
    const src = srcFile("legacy.mkv");
    const withNothing = remux.resolveRemuxTarget(src, "legacy.mkv", "mp4");
    const withNull = remux.resolveRemuxTarget(src, "legacy.mkv", "mp4", null);
    assert.equal(withNothing.key, withNull.key);
    assert.equal(withNothing.cachePath, withNull.cachePath);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
});


// ============================================================
// PART E -- ffmpeg.primaryMapArgs()
// ============================================================

test("E1 default (no selection) -> primary video + first audio, both optional", () => {
    assert.deepEqual(ffmpeg.primaryMapArgs(), ["-map", "0:v:0?", "-map", "0:a:0?"]);
    assert.deepEqual(ffmpeg.primaryMapArgs({}), ["-map", "0:v:0?", "-map", "0:a:0?"]);
});

test("E2 an integer audioStreamIndex maps that ABSOLUTE stream", () => {
    assert.deepEqual(ffmpeg.primaryMapArgs({ audioStreamIndex: 0 }), ["-map", "0:v:0?", "-map", "0:0?"]);
    assert.deepEqual(ffmpeg.primaryMapArgs({ audioStreamIndex: 3 }), ["-map", "0:v:0?", "-map", "0:3?"]);
});

test("E3 invalid audioStreamIndex falls back to the first audio stream (shell-safe: integers only)", () => {
    for (const bad of [-1, 1.5, "2; rm -rf /", "0:a", NaN, null, undefined, {}]) {
        assert.deepEqual(
            ffmpeg.primaryMapArgs({ audioStreamIndex: bad }),
            ["-map", "0:v:0?", "-map", "0:a:0?"],
            JSON.stringify(bad)
        );
    }
    // every element the function can emit is a fixed token or "0:<int>?"
    for (const v of [0, 5, 42]) {
        const args = ffmpeg.primaryMapArgs({ audioStreamIndex: v });
        assert.match(args[3], /^0:\d+\?$/);
    }
});


// ============================================================
// PART F -- real server + real ffmpeg
// ============================================================

const BASE = "http://127.0.0.1:4000";

function makeTwoAudio(dest) {
    // one video + two audio tracks (eng default, fra second)
    execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=160x90:r=12",
        "-f", "lavfi", "-i", "sine=f=300:d=2",
        "-f", "lavfi", "-i", "sine=f=900:d=2",
        "-map", "0:v", "-map", "1:a", "-map", "2:a",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest",
        "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fra",
        "-disposition:a:0", "default",
        "-y", dest
    ], { stdio: "ignore" });
}
function ffprobeStreams(file) {
    return JSON.parse(execFileSync("ffprobe",
        ["-v", "error", "-print_format", "json", "-show_streams", file]).toString()).streams;
}
function get(p, headers) {
    return fetch(BASE + p, { headers: headers || {}, signal: AbortSignal.timeout(30000) });
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

test("Task 13 route: ?audio=<n> selects a non-first audio stream that reaches the remux output",
    { skip: FFMPEG ? false : "ffmpeg not available" }, async (t) => {

    const rt = fs.mkdtempSync(path.join(os.tmpdir(), "bf-t13-route-"));
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(rt, f));
    fs.mkdirSync(path.join(rt, "public"));
    fs.writeFileSync(path.join(rt, "public", "welcome.html"), "<!doctype html><title>t</title>");
    fs.mkdirSync(path.join(rt, "videos"), { recursive: true });

    makeTwoAudio(path.join(rt, "videos", "multi.mkv"));
    fs.writeFileSync(path.join(rt, "secret.txt"), "T13_SECRET");

    const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
    const child = spawn(process.execPath, ["server.js"], {
        cwd: rt,
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH ? `${NODE_MODULES}${path.delimiter}${process.env.NODE_PATH}` : NODE_MODULES },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const log = [];
    child.stdout.on("data", c => log.push(c.toString()));
    child.stderr.on("data", c => log.push(c.toString()));

    // client: h264 + aac ok, mp4 ok, mkv NOT -> REMUX
    const REMUXCAPS = caps({ video: { h264: true }, audio: { aac: true }, containers: { mp4: true } });
    const remuxDir = path.join(rt, "remuxed");
    const remuxFiles = () => (fs.existsSync(remuxDir) ? fs.readdirSync(remuxDir).filter(f => f.endsWith(".mp4")) : []);

    try {
        await waitForServer(child, log);

        const db = new Database(path.join(rt, "baseflix.db"));
        for (let i = 0; i < 60 && db.prepare("SELECT COUNT(*) n FROM videos").get().n < 1; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        db.prepare("UPDATE videos SET video_codec='h264', audio_codec='aac', width=160, height=90, needs_transcode=0 WHERE relative_path='multi.mkv'").run();
        db.close();

        // ---- the source really has two audio streams (eng, fra) ----
        const srcStreams = ffprobeStreams(path.join(rt, "videos", "multi.mkv"));
        const srcAudio = srcStreams.filter(s => s.codec_type === "audio");
        assert.equal(srcAudio.length, 2);
        const fraIndex = srcAudio.find(s => s.tags && s.tags.language === "fra").index;
        assert.equal(typeof fraIndex, "number");

        await t.test("no selection -> remux of the DEFAULT (first / eng) audio track", async () => {
            const r = await get("/video/multi.mkv", REMUXCAPS);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.equal(r.headers.get("x-baseflix-audio-stream"), null, "no explicit selection -> no header");
            const files = remuxFiles();
            assert.equal(files.length, 1);
            const outA = ffprobeStreams(path.join(remuxDir, files[0])).filter(s => s.codec_type === "audio");
            assert.equal(outA.length, 1, "one audio track in the remux");
            assert.equal(outA[0].tags && outA[0].tags.language, "eng");
        });

        await t.test("?audio=<fra> -> the fra track is the one carried into the remux; header reflects it", async () => {
            const before = remuxFiles().length;
            const r = await get("/video/multi.mkv?audio=" + fraIndex, REMUXCAPS);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.equal(r.headers.get("x-baseflix-audio-stream"), String(fraIndex));

            const files = remuxFiles();
            assert.equal(files.length, before + 1, "a distinct cache artefact for the selected track");
            // newest file = the selected-audio remux
            const newest = files
                .map(f => ({ f, m: fs.statSync(path.join(remuxDir, f)).mtimeMs }))
                .sort((a, b) => b.m - a.m)[0].f;
            const outA = ffprobeStreams(path.join(remuxDir, newest)).filter(s => s.codec_type === "audio");
            assert.equal(outA.length, 1);
            assert.equal(outA[0].tags && outA[0].tags.language, "fra", "the SELECTED (non-first) audio stream reached ffmpeg");
        });

        await t.test("selected-audio remux still supports Range -> 206", async () => {
            const full = Buffer.from(await (await get("/video/multi.mkv?audio=" + fraIndex, REMUXCAPS)).arrayBuffer());
            const r = await get("/video/multi.mkv?audio=" + fraIndex, { ...REMUXCAPS, Range: "bytes=10-40" });
            assert.equal(r.status, 206);
            assert.equal(r.headers.get("content-range"), `bytes 10-40/${full.length}`);
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(full.subarray(10, 41)));
        });

        await t.test("selected-audio remux is reused (no second ffmpeg job / artefact)", async () => {
            const before = remuxFiles().length;
            const a = Buffer.from(await (await get("/video/multi.mkv?audio=" + fraIndex, REMUXCAPS)).arrayBuffer());
            const b = Buffer.from(await (await get("/video/multi.mkv?audio=" + fraIndex, REMUXCAPS)).arrayBuffer());
            assert.ok(a.equals(b));
            assert.equal(remuxFiles().length, before);
        });

        await t.test("path containment still holds with a selection query present", async () => {
            const r = await get("/video/..%2F..%2Fsecret.txt?audio=1", REMUXCAPS);
            assert.equal(r.status, 404);
            assert.ok(!(await r.text()).includes("T13_SECRET"));
        });

        await t.test("an out-of-range ?audio index is ignored -> default remux, server stays up", async () => {
            const r = await get("/video/multi.mkv?audio=999", REMUXCAPS);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-baseflix-playback"), "remux");
            assert.equal((await get("/api/videos")).status, 200);
        });

        assert.match(log.join(""), /running on port 4000/);

    } finally {
        child.kill("SIGTERM");
        await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(r, 4000); });
        fs.rmSync(rt, { recursive: true, force: true });
    }
});
