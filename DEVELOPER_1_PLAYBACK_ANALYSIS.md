# Baseflicks Playback Engine Analysis

**Role:** Developer 1 — Playback Engine Owner  
**Stage:** P0 — Analysis Only  
**Repository:** `govarthanan0507/Baseflicks_Server`  
**Branch:** `feature/playback`  
**Analysis baseline:** `main` at the time of investigation  
**Production code changes in this assignment:** NONE

> This report is an implementation baseline, not a playback redesign. Findings are deliberately separated into **OBSERVED IN CODE**, **RECOMMENDATION**, and **NOT VERIFIED**. Runtime/browser claims that could not be exercised from the repository inspection are not presented as tested facts.

## 1. Executive Summary

### OBSERVED IN CODE

Baseflicks currently has a functional but relatively simple playback pipeline:

```text
Browser
  -> /video/:filename
  -> database lookup
  -> if needs_transcode = 0: serve original with byte ranges
  -> if needs_transcode = 1 and cache exists: serve cached MP4 with byte ranges
  -> otherwise: start a live FFmpeg MP4 stream
```

Media analysis is performed by `ffprobe` in `ffmpeg.js`, and the scanner stores only one video codec, one audio codec, duration, width, height, and a boolean `needs_transcode`. The current playability decision is codec-whitelist based; **container compatibility is not part of the decision**. The current whitelist is H.264/VP8/VP9 video and AAC/MP3/Opus/Vorbis audio.

The application therefore does **not** currently implement the requested explicit hierarchy of Direct Play -> Remux -> Audio-only Transcode -> Video Transcode. It has Direct Play plus a generalized FFmpeg MP4 conversion path. That generalized path can preserve a compatible video track or compatible audio track with `-c copy`, so some audio-only/video-only transcoding behavior exists internally, but it is not a formal decision engine and does not model containers or client capabilities.

### Most important problems

1. **Container is ignored by playability logic.** A codec-compatible MKV/AVI/MOV/WebM can be classified as directly playable even though the browser/client may require a different container. The raw direct-play response is also hard-coded to `video/mp4` regardless of the actual source container.
2. **The direct-play/range implementation is permissive but not robust.** Range syntax is not fully validated, suffix ranges and invalid/out-of-bounds ranges are not handled explicitly, and multiple ranges are unsupported.
3. **Live transcode seeking is unavailable.** A cache can later become seekable, but the first live-transcode session has no Range support and no timestamp-seek API.
4. **There is no global FFmpeg concurrency control.** Multiple clients can start independent live transcodes of the same file, while the scanner can simultaneously perform background conversion.
5. **Multiple streams are not modeled.** Only the first video and first audio stream are stored. Audio language/track selection and subtitle tracks are not represented.
6. **Subtitles are not implemented in the normal browser player.** No subtitle probing, API, selection UI, or subtitle delivery was found in the inspected playback path.
7. **Playback endpoints are not protected by profile authentication/authorization.** `/video/:filename` is public, and playback-state endpoints accept caller-supplied profile IDs.
8. **Playback path containment is not explicitly enforced.** The media route constructs `path.join(VIDEO_FOLDER, filename)` without a post-normalization containment check. This needs immediate security testing before the server is exposed beyond a trusted local environment.
9. **VOB is not part of the normal scanner extension list.** `fix-vob.js` is a standalone helper and is not part of normal server startup/library playback.
10. **Cache existence is treated as cache validity.** The atomic temp-file/rename approach is good protection against ordinary partial writes, but there is no persistent cache manifest, source fingerprint, FFmpeg-version identity, or post-write validation.

### RECOMMENDATION

The safest next implementation stage is **P1 — Playback Test Laboratory**, not a rewrite. First build a small deterministic media compatibility/test harness that records the actual behavior of representative files across the target browsers. Then use those results to define a formal capability model and decision engine.

## 2. Current Playback Architecture

### OBSERVED IN CODE

The repository README describes `server.js` as owning HTTP routes, authentication, video streaming, transcode orchestration, and playback state; `scanner.js` owns library synchronization/probing/background conversions; `ffmpeg.js` owns ffprobe, playability checks, conversions, live streams, progress parsing, and thumbnails; and `public/app.js` owns the browser playback UI. `fix-vob.js` is explicitly a standalone helper and is not part of normal startup.

The runtime chain is:

```text
public/app.js
    |
    | GET /video/<encoded relative path>
    v
server.js
    |
    +--> SQLite lookup in videos
    |
    +--> direct file/range serving
    |
    +--> cached converted file serving
    |
    `--> ffmpeg.transcodeToMp4Stream()
              |
              `--> FFmpeg process
```

Before playback, the scanner normally performs:

```text
videos/
  -> ffprobe
  -> store codec/duration/dimensions/needs_transcode
  -> optionally generate thumbnail
  -> background conversion for flagged files
```

### RECOMMENDATION

Keep ownership split this way. Playback changes should remain centered in `server.js` and `ffmpeg.js`, with explicit PM coordination for scanner/database/UI/API changes.

## 3. Playback Request Flow

### OBSERVED IN CODE

The normal UI calls `openPlayer(video)` in `public/app.js`. It first retrieves the selected profile's Continue Watching list, then creates a `<video>` element whose source is:

```text
/video/<encodeURIComponent(video.relative_path)>
```

The player enables controls, autoplay, and `playsInline`, then requests fullscreen when possible. Resume is applied on `loadedmetadata`.

The server's `/video/:filename` route then:

1. Reads the route filename.
2. Joins it to `VIDEO_FOLDER`.
3. Looks up `needs_transcode`, `video_codec`, and `audio_codec` by `relative_path`.
4. Derives the expected converted path.
5. Checks source/cache existence.
6. If `needs_transcode` is false, serves the original with `serveDirectPlay()`.
7. If a cache exists, serves the cache with `serveDirectPlay()`.
8. Otherwise starts `ffmpeg.transcodeToMp4Stream()`.

### NOT VERIFIED

No live browser/network trace was run in this P0 inspection, so actual request headers produced by each target browser, exact retry patterns, and actual startup latency remain unverified.

## 4. Media Probing

### OBSERVED IN CODE

`ffmpeg.probeFile()` invokes:

```text
ffprobe -v quiet -print_format json -show_format -show_streams <file>
```

It extracts:

- container/format name
- duration
- total size
- first video stream codec
- first video stream width/height
- first audio stream codec

The scanner probes rows where `video_codec IS NULL` and writes the results to SQLite.

### LIMITATION

The complete stream model returned by ffprobe is discarded. Stream indexes, language tags, titles, dispositions, channel layouts, sample rates, bit depth, pixel format, frame rate, HDR metadata, subtitle streams, and additional audio/video tracks are not stored.

### RECOMMENDATION

P2 should introduce a normalized media-probe object before changing the database. Keep the raw probe information available to the playback decision engine even if the first implementation does not persist every field.

## 5. Video Stream Detection

### OBSERVED IN CODE

The implementation selects the first stream with `codec_type === "video"`. Only its codec, width, and height are retained.

### LIMITATION

Multiple video streams, alternate camera angles, attached cover streams, stereoscopic variants, interlaced state, frame rate, profile/level, bit depth, chroma subsampling, color primaries, transfer characteristics, and HDR information are not represented.

### NOT VERIFIED

Actual behavior for files containing multiple video streams was not tested.

## 6. Audio Stream Detection

### OBSERVED IN CODE

The implementation selects the first stream with `codec_type === "audio"` and stores only its codec.

The live transcode path can preserve a compatible audio track or convert it to AAC when the first detected audio codec is considered incompatible.

### LIMITATION

There is no stored language, title, channel count/layout, sample rate, bitrate, stream index, or default/forced disposition. Users cannot select among multiple audio tracks through the current player.

### RECOMMENDATION

Treat audio track selection as a first-class playback capability in P2/P5 rather than adding special cases to the current codec whitelist.

## 7. Subtitle Stream Detection

### OBSERVED IN CODE

No subtitle stream model was found in `ffmpeg.js`, `database.js`, `server.js`, or the inspected `public/app.js` playback path. The standard playback pipeline does not expose subtitle tracks or a subtitle selection control.

`fix-vob.js` explicitly uses `-sn`, but that standalone utility is not the normal playback pipeline.

### CURRENT RESULT

Subtitles: **NOT IMPLEMENTED in the normal playback path.**

### RECOMMENDATION

P15 should add subtitle probing, text/image subtitle classification, selection, and an explicit delivery strategy. Do not assume browser-native subtitle support covers all MKV/DVD subtitle formats.

## 8. Codec Detection

### OBSERVED IN CODE

Current video whitelist:

```text
h264
vp8
vp9
```

Current audio whitelist:

```text
aac
mp3
opus
vorbis
```

Anything outside the lists causes `needs_transcode = 1`.

### LIMITATION

Codec name alone is insufficient for a reliable playback decision. Browser support depends on the container and can also depend on codec profile/level, bit depth, platform, and client. Current logic does not inspect those properties.

## 9. Container Detection

### OBSERVED IN CODE

`probeFile()` obtains `formatName`, but the scanner does not persist it and `checkPlayability()` does not use it.

The scanner's normal extensions are:

```text
.mp4
.mkv
.avi
.mov
.webm
.m4v
```

`.vob` is absent.

### CRITICAL LIMITATION

The application currently makes a codec-only direct-play decision even though a browser must also be able to demux the container. This is the largest architectural gap in the current decision logic.

## 10. Current Client Compatibility

### OBSERVED IN CODE

The current player is a standard HTML `<video>` element. No explicit client capability negotiation was found. There is no use of `HTMLMediaElement.canPlayType()`, `MediaCapabilities.decodingInfo()`, or a server-side client capability profile in the inspected playback path.

### NOT VERIFIED

Actual Chrome, Edge, Firefox, Android Chrome, iPhone Safari, and TV browser results remain unverified.

### External reference

Browser media compatibility is container + codec dependent. MDN documents MP4/H.264/AAC and WebM/VP8/VP9/Opus/Vorbis as common browser combinations and notes that container support is distinct from codec support.

## 11. Current Playback Decision Logic

### OBSERVED IN CODE

The effective current decision is:

```text
Scanner:
  probe first video/audio codec
       |
       v
  checkPlayability()
       |
       +-- both whitelisted --> needs_transcode = 0
       |
       `-- otherwise --------> needs_transcode = 1

Playback:
  needs_transcode = 0
       -> direct file/range serving

  needs_transcode = 1 + cache exists
       -> serve cached MP4/ranges

  needs_transcode = 1 + no cache
       -> live FFmpeg MP4 stream
```

There is no explicit state machine of:

```text
Direct Play
  -> Remux
  -> Audio Transcode
  -> Video Transcode
```

### IMPORTANT FINDING

The implementation contains pieces of the desired hierarchy but does not implement the hierarchy as a formal decision engine. For example, an H.264 + AC3 file can preserve video (`-c:v copy`) and encode audio to AAC, which is effectively audio-only transcoding. However, the choice is derived only from two codec booleans and always targets MP4 output; it does not reason about source container or client capability.

## 12. Direct Play

### OBSERVED IN CODE

For `needs_transcode = 0`, `serveDirectPlay()` reads the source file directly and supports byte-range requests.

For a request without `Range`, it returns:

```text
200
Content-Length
Content-Type: video/mp4
Accept-Ranges: bytes
```

For a request with `Range`, it returns:

```text
206
Content-Range
Accept-Ranges: bytes
Content-Length
Content-Type: video/mp4
```

### IMPORTANT BUG

`Content-Type` is hard-coded to `video/mp4` for every direct-play source. This is incorrect for WebM, WebM-like media, AVI, MOV, and other containers.

### RECOMMENDATION

Direct Play must eventually use a media/container-aware MIME type and, where useful, a codec-aware response. The decision should be based on actual client capability rather than a codec-only whitelist.

## 13. Remux

### OBSERVED IN CODE

There is no dedicated remux decision or cache stage.

However, `transcodeToMp4Stream()` can invoke FFmpeg with both:

```text
-c:v copy
-c:a copy
```

while forcing an MP4 output container. Therefore, if the current codec booleans both return true but the file has nevertheless reached the live transcode path, FFmpeg can perform a container conversion without re-encoding those tracks.

More importantly, the current `needs_transcode` decision generally prevents a codec-compatible source from reaching this path, so the implementation does not have a proper **container-only remux stage**.

### CURRENT RESULT

Formal remux support: **NOT IMPLEMENTED as a distinct playback mode.**

## 14. Audio Transcoding / Direct Stream

### OBSERVED IN CODE

When `videoOk` is true and `audioOk` is false, the live path passes:

```text
-c:v copy
-c:a aac
```

This is an audio-only transcode in substance.

### LIMITATION

It still uses the same generalized live MP4 pipeline. There is no explicit mode, no user-visible explanation, no track-selection policy, and no container-aware decision.

### RECOMMENDATION

P8 should formalize this as a distinct decision outcome and test H.264 + AC3, H.264 + E-AC3, H.264 + DTS, H.264 + TrueHD, H.264 + FLAC, and H.264 + PCM separately.

## 15. Video Transcoding

### OBSERVED IN CODE

When video is incompatible, `transcodeToMp4Stream()` uses:

```text
-c:v libx264
-preset veryfast
```

and optionally:

```text
-vf scale=-2:min(1080,ih)
```

Audio is copied when considered compatible; otherwise it is encoded to AAC.

The background scanner conversion uses:

```text
preset = medium
crf = 18
audioBitrate = 256k
```

and writes a complete MP4 with `+faststart` to a temporary file before renaming it into place.

### OBSERVED CONSEQUENCE

4K sources are software-encoded down to at most 1080p during the live path when video re-encoding is required. This is a sensible safety measure for modest CPUs, but it is not adaptive to CPU capability or client display resolution.

### NOT VERIFIED

Real-time performance for 4K HEVC, AV1, MPEG-2, high frame rate, 10-bit, HDR, and difficult interlaced sources has not been benchmarked.

## 16. FFmpeg Architecture

### OBSERVED IN CODE

`ffmpeg.js` owns:

- `ffprobe` invocation
- codec playability checks
- complete-file conversion
- live stream conversion
- conversion progress parsing
- thumbnail generation
- transcoded path naming

The server invokes FFmpeg directly through Node's `child_process.spawn` / `execFile` APIs.

### RECOMMENDATION

Keep this module as the FFmpeg boundary. Future playback modes should return structured results such as mode, selected streams, FFmpeg arguments, cache identity, and reason rather than letting route code reconstruct decisions ad hoc.

## 17. FFmpeg Process Management

### OBSERVED IN CODE

Live transcode processes are created per request. The server registers `res.on("close")` and kills the FFmpeg child with `SIGKILL` when the response closes before normal completion.

Complete conversions use a temp file and rename only after a clean FFmpeg exit.

### IMPORTANT LIMITATION

There is no global process registry, queue, per-user limit, per-source deduplication, CPU budget, or maximum concurrent live transcode count.

### Failure handling

- FFmpeg start failure: promise rejects; server attempts HTTP 500/response end.
- FFmpeg nonzero exit: rejects for the live stream; temp cache is removed.
- Client disconnect: FFmpeg is killed.
- Completed cache: temp cache is renamed into final cache path.

### NOT VERIFIED

Exact behavior when the Node process itself crashes while FFmpeg children are running was not tested.

## 18. HTTP Range Handling

### OBSERVED IN CODE

The direct-file path supports a single byte range and returns HTTP 206. It advertises `Accept-Ranges: bytes`.

### LIMITATIONS / BUGS

The parser simply splits `bytes=start-end` and does not robustly validate:

- missing start
- suffix ranges such as `bytes=-500`
- start beyond EOF
- end beyond EOF
- start > end
- malformed numbers
- multiple ranges
- invalid range units

There is also no explicit `416 Range Not Satisfiable` path.

### RECOMMENDATION

P11 should replace the ad-hoc range parser with a standards-compliant single-range implementation and add automated tests for all boundary cases.

## 19. Seeking

### OBSERVED IN CODE

Direct/cached files can seek through HTTP byte ranges.

Live transcoded responses deliberately omit `Accept-Ranges` and `Content-Length`, and no timestamp-seek request parameter or FFmpeg seek operation is implemented. Therefore arbitrary seeking during the first live transcode is not supported by the server architecture.

### IMPORTANT CONSEQUENCE

A user playing a not-yet-cached incompatible file may not be able to jump from minute 5 to minute 90. Once a complete cache exists, normal byte-range seeking is available.

## 20. Resume Playback

### OBSERVED IN CODE

`public/app.js` saves playback every 5 seconds while playing and also on pause/stop/end events. It restores the matching `continue_watching` position on `loadedmetadata`.

`server.js` stores progress in `continue_watching(profile_id, video_id, position, duration)`.

The server considers a video just started when position is <= 3 seconds and finished when position is >= duration - 10 seconds. Finished items are removed from Continue Watching and written to `watch_history`.

### LIMITATIONS

The browser's `beforeunload` reliability is inherently limited, and the current code does not use a background beacon/keepalive mechanism specifically designed for unload. Network failure can lose the final position.

### NOT VERIFIED

Resume accuracy after browser crash, mobile backgrounding, OS sleep, network interruption, or forced server termination was not tested.

## 21. Transcoding Cache

### OBSERVED IN CODE

Cache identity is derived from the source `relative_path` by changing its extension to `.mp4` and mirroring its directory structure inside `transcoded/`.

Example:

```text
videos/Movies/Foo.mkv
transcoded/Movies/Foo.mp4
```

The cache is used when it exists and the database row still says `needs_transcode = 1`.

### LIMITATIONS

Cache identity does not include:

- source modification time
- source size/hash
- FFmpeg version
- encoder settings
- target client
- target resolution
- audio track
- subtitle selection
- future playback profile

A source file changing in place without its relative path changing could therefore leave a stale cache.

## 22. Temporary Files

### OBSERVED IN CODE

Complete conversions use `<output>.tmp`.

Live streams with caching use a unique temp suffix containing process ID and timestamp, then rename the temp file to the final cache path only after a clean completion.

### POSITIVE FINDING

The temp-file + final-rename pattern is substantially safer than streaming directly into the final cache filename.

## 23. Cache Recovery

### OBSERVED IN CODE

Failed/interrupted live cache temp files are removed. Failed complete conversions remove their temp files. Existing completed cache files are detected simply by filesystem existence.

### LIMITATION

There is no startup recovery scan for stale `.tmp` files, no cache manifest, and no integrity verification of an existing final cache.

### RECOMMENDATION

P12 should add cache lifecycle states and startup cleanup without changing source media automatically.

## 24. Error Handling

### OBSERVED IN CODE

The route returns 404 if neither source nor cache exists. Live transcode failures are logged and the response is ended or changed to 500 when headers have not already been sent.

### LIMITATIONS

Once a live response has started, an FFmpeg failure cannot be cleanly converted into a structured JSON error because media bytes may already have been sent. The browser receives a failed/truncated media stream instead.

There is no user-facing playback error classification such as:

```text
SOURCE_MISSING
UNSUPPORTED_MEDIA
FFMPEG_NOT_INSTALLED
TRANSCODE_FAILED
CLIENT_DISCONNECTED
DISK_FULL
CACHE_CORRUPT
```

## 25. Playback Recovery

### OBSERVED IN CODE

The browser player logs playback errors only in general JavaScript promise/error paths; there is no dedicated `video.error` recovery state, retry strategy, alternate source selection, or cache invalidation workflow in the inspected player.

### RECOMMENDATION

P14 should introduce structured playback failures and recovery actions. Recovery must not blindly retry an expensive transcode indefinitely.

## 26. Client Disconnect Handling

### OBSERVED IN CODE

The server intentionally kills the live FFmpeg process when the response closes before it has normally ended. This is a good resource-protection measure.

### LIMITATION

No central process registry means cleanup depends on each request's local callback. There is no global orphan-child reconciliation.

## 27. Server Restart Behaviour

### OBSERVED IN CODE

Completed transcoded files persist on disk and can be served after restart. Continue Watching and watch history persist in SQLite.

Incomplete live transcodes do not have a resume mechanism; their temporary cache files should be discarded by normal failure handling, but startup cleanup is not implemented.

The scanner runs again at startup and can discover/probe/convert files.

### NOT VERIFIED

Crash-level restart while FFmpeg is still running was not executed. Windows process-tree behavior should be tested specifically.

## 28. Resource Management

### OBSERVED IN CODE

The scanner deliberately converts flagged files sequentially. This is a good baseline for ordinary PCs.

Live playback, however, has no equivalent global limit. Each live transcode request can spawn a new FFmpeg process.

### KEY RISK

A user opening the same incompatible 4K video in several tabs, or several users requesting several incompatible files, can create several CPU-heavy FFmpeg processes simultaneously.

## 29. CPU Usage

### OBSERVED IN CODE

Live video re-encoding uses `libx264` with `veryfast`; background conversion uses `medium`, CRF 18, and may cap live output at 1080p.

### NOT VERIFIED

No benchmark was run on the target ordinary Windows hardware class. CPU utilization, transcoding FPS, and playback buffer stability must be measured before setting hard concurrency limits.

## 30. RAM Usage

### OBSERVED IN CODE

No explicit FFmpeg memory budget or Node process memory budget exists.

The live pipeline pipes FFmpeg stdout to the HTTP response and optionally to a cache stream, which avoids intentionally buffering the entire video in Node memory.

### NOT VERIFIED

Actual peak RAM for multiple 4K/10-bit transcodes is unmeasured.

## 31. Disk Usage

### OBSERVED IN CODE

The system may retain:

- original source
- completed transcoded copy
- archived original after cleanup decision
- poster/artwork
- temporary conversion files during processing

The scanner has cleanup logic for referenced/unreferenced generated content and transcoded copies.

### LIMITATION

There is no configurable transcoding cache size, age policy, or disk-space threshold before starting a conversion.

## 32. Concurrent Playback

### OBSERVED IN CODE

Direct Play is cheap and can serve multiple clients independently.

Cached playback is also normal file serving.

Live transcode is unbounded per request.

### NOT VERIFIED

No 2/3/5-user stress test has been executed.

### RECOMMENDATION

P13 should introduce a resource manager with at minimum:

- maximum live transcodes
- duplicate-request deduplication
- process tracking
- cancellation
- optional queueing
- disk-space checks
- per-source lock

## 33. Hardware Acceleration

### OBSERVED IN CODE

No Intel Quick Sync, NVIDIA NVENC/NVDEC, AMD AMF, or other hardware acceleration path is referenced in the normal playback engine.

The current FFmpeg commands explicitly use software `libx264` for video encoding.

### RECOMMENDATION

Hardware acceleration should remain P16. First stabilize the software decision engine, range handling, cache, error recovery, and resource manager. Then detect available encoders and make hardware acceleration an optional policy rather than a mandatory dependency.

FFmpeg documents hardware-specific integrations such as AMD AMF; availability depends on the FFmpeg build and host hardware.

## 34. Security Review

### OBSERVED IN CODE

Admin-protected library-changing routes use `x-admin-key` and salted scrypt verification. Playback routes themselves are not admin-gated, which is appropriate for normal media consumption, but they also do not have profile/session authorization.

The media route uses:

```text
path.join(VIDEO_FOLDER, filename)
```

without an explicit `path.resolve()` containment check against `VIDEO_FOLDER`.

### HIGH PRIORITY SECURITY FINDING

The playback route must be tested for path traversal. Because the route accepts a caller-controlled filename and does not explicitly verify that the normalized target remains under `VIDEO_FOLDER`, this is a potential arbitrary-file-read vulnerability if Express route decoding permits crafted path segments to reach `..` components.

The `/watch/:filename` page has the same path construction pattern.

### OTHER PLAYBACK SECURITY FINDINGS

`GET /api/continue-watching/:profileId`, `GET /api/watch-history/:profileId`, and `POST /api/continue-watching` accept profile IDs from the caller without session authorization. A client that knows another profile ID can potentially read or alter that profile's playback state.

### FFmpeg command injection

The normal FFmpeg invocation uses `spawn()`/`execFile()` with argument arrays rather than a shell command string. That is a positive finding: filenames are passed as argument values rather than interpolated into a shell command.

### RECOMMENDATION

Treat playback path containment and profile playback authorization as P0/P1 security work. Do not expose the server to an untrusted network until traversal testing and authorization design are resolved.

## 35. API Analysis

### OBSERVED IN CODE

Playback endpoints:

```text
GET /video/:filename
GET /watch/:filename
GET /api/continue-watching/:profileId
POST /api/continue-watching
DELETE /api/continue-watching/:profileId/:videoId
GET /api/watch-status/:profileId
GET /api/watch-history/:profileId
```

### Current media API

**Endpoint:** `GET /video/:filename`  
**Authentication:** none  
**Request:** path parameter plus optional HTTP `Range` header  
**Response:** raw media, 200 or 206 for direct/cached files; streamed fragmented MP4 for live transcode  
**Errors:** 404 for missing source/cache; 500 may occur after transcode failure

### Required future API discipline

If a formal playback decision endpoint is introduced, document it before implementation:

```text
Endpoint
Method
Request
Response
Client capability data
Selected mode
Selected streams
Reason
Authentication
Errors
Backward compatibility
```

No API changes are made in P0.

## 36. Database Analysis

### OBSERVED IN CODE

The `videos` table contains:

```text
video_codec
 audio_codec
duration
width
height
needs_transcode
original_status
```

Playback state is stored in `continue_watching` and `watch_history`.

### LIMITATIONS

There is no:

- container field
- media probe version
- selected audio stream
- subtitle stream data
- client capability data
- cache fingerprint
- transcode profile
- transcode status table
- playback session table

The existing schema is intentionally simple and should not be expanded during P0.

### Future migration requirement

Any schema change must document the reason, new fields/tables, migration, rollback, and impact on existing installations before PM approval.

## 37. Current Bugs

### OBSERVED IN CODE

1. Direct-play MIME type is always `video/mp4`.
2. Container format is not part of the playability decision.
3. Range parsing does not implement a complete RFC-compatible single-range policy.
4. No explicit 416 response for invalid ranges.
5. Live transcode has no arbitrary seek support.
6. No global FFmpeg concurrency limit.
7. Duplicate requests can start duplicate live transcodes.
8. Only the first video/audio streams are represented.
9. No subtitle support in the normal player.
10. VOB is excluded from normal scanner discovery.
11. Cache validity is inferred from file existence.
12. No startup cleanup of stale temporary transcode files.
13. Playback errors have no structured client recovery path.
14. Profile playback state endpoints are not authorization-bound to a session/profile.
15. Media path containment is not explicitly enforced.

## 38. Current Limitations

### OBSERVED IN CODE

- Browser-first playback only.
- No formal client capability model.
- No formal playback decision engine.
- No remux mode.
- No subtitle model.
- No multi-audio selection.
- No hardware acceleration.
- No transcoding quota/queue.
- No adaptive quality ladder.
- No HLS/DASH/WebRTC streaming layer.
- No native mobile-specific playback contract yet.

## 39. Real-World Compatibility Matrix

**Legend:** `CODE PATH` means the repository logic would choose that path. `NOT VERIFIED` means no runtime/client test was performed.

| Container | Video | Audio | Expected Method | Current Result |
|---|---|---|---|---|
| MP4 | H264 | AAC | Direct Play | CODE PATH: Direct Play; runtime NOT VERIFIED |
| MKV | H264 | AAC | Remux/Direct Play | CODE PATH: Direct Play because container is ignored; runtime NOT VERIFIED |
| MKV | H264 | AC3 | Audio Transcode | CODE PATH: live MP4 with H264 copy + AAC encode; runtime NOT VERIFIED |
| MKV | HEVC | AAC | Client dependent / Transcode | CODE PATH: H264 encode + AAC copy; runtime NOT VERIFIED |
| MP4 | AV1 | AAC | Client dependent | CODE PATH: H264 encode + AAC copy; runtime NOT VERIFIED |
| AVI | MPEG-2 | MP3 | Transcode | CODE PATH: H264 encode + MP3 copy; runtime NOT VERIFIED |
| WEBM | VP9 | Opus | Client dependent | CODE PATH: Direct Play because codecs are whitelisted; MIME is incorrectly `video/mp4`; runtime NOT VERIFIED |
| MOV | H264 | AAC | Client dependent | CODE PATH: Direct Play because codecs are whitelisted; MIME is `video/mp4`; runtime NOT VERIFIED |
| M4V | H264 | AAC | Direct Play | CODE PATH: Direct Play; runtime NOT VERIFIED |
| VOB | MPEG-2 | AC3 | Transcode | NOT DISCOVERED by normal scanner; standalone `fix-vob.js` can convert a configured VOB segment |

The compatibility matrix should be expanded during P1/P2 with real files and exact browser results.

## 40. Test Matrix

### Playback

| Test | Current status |
|---|---|
| Play direct MP4 | NOT VERIFIED |
| Pause | NOT VERIFIED |
| Resume | NOT VERIFIED |
| Stop/close player | NOT VERIFIED |
| Browser reload | NOT VERIFIED |
| Close browser | NOT VERIFIED |
| Reopen and resume | NOT VERIFIED |

### Seeking

| Test | Current status |
|---|---|
| Direct-play forward seek | CODE SUPPORT; runtime NOT VERIFIED |
| Direct-play backward seek | CODE SUPPORT; runtime NOT VERIFIED |
| Cached transcode seek | CODE SUPPORT; runtime NOT VERIFIED |
| Live-transcode seek | CODE LIMITATION: no Range support |
| Repeated seeking | NOT VERIFIED |
| Seek after pause | NOT VERIFIED |
| Long-video seek | NOT VERIFIED |
| Large-file seek | NOT VERIFIED |

### Errors

| Test | Current status |
|---|---|
| Missing file | CODE PATH: 404 |
| Corrupt file | ffprobe may fail; playback behavior NOT VERIFIED |
| Unsupported codec | CODE PATH: transcode |
| FFmpeg unavailable | NOT VERIFIED at runtime |
| FFmpeg failure | CODE HANDLING EXISTS; browser UX NOT VERIFIED |
| Client disconnect | CODE HANDLING EXISTS: kill live FFmpeg |
| Server restart | PERSISTENCE CODE EXISTS; crash behavior NOT VERIFIED |
| Disk full | NOT VERIFIED |
| Corrupt cache | NOT VERIFIED |

### Media containers

```text
MP4       NOT VERIFIED
MKV       NOT VERIFIED
AVI       NOT VERIFIED
MOV       NOT VERIFIED
WEBM      NOT VERIFIED
M4V       NOT VERIFIED
VOB       NOT SUPPORTED BY NORMAL SCANNER
```

### Resolutions

```text
480p      NOT VERIFIED
720p      NOT VERIFIED
1080p     NOT VERIFIED
1440p     NOT VERIFIED
4K        NOT VERIFIED
```

### Audio

```text
AAC       CODE WHITELISTED / runtime NOT VERIFIED
MP3       CODE WHITELISTED / runtime NOT VERIFIED
AC3       CODE PATH: audio transcode if video is compatible
E-AC3     CODE PATH: audio transcode if video is compatible
DTS       CODE PATH: audio transcode if video is compatible
FLAC      CODE PATH: audio transcode if video is compatible
PCM       CODE PATH: audio transcode if video is compatible
No audio  CODE PATH: audio accepted when absent
```

### Video

```text
H264      CODE WHITELISTED / runtime NOT VERIFIED
HEVC      CODE PATH: video transcode
VP8       CODE WHITELISTED / runtime NOT VERIFIED
VP9       CODE WHITELISTED / runtime NOT VERIFIED
AV1       CODE PATH: video transcode
MPEG-2    CODE PATH: video transcode
MPEG-4    CODE PATH: video transcode
```

### Clients

```text
Chrome          NOT VERIFIED
Edge            NOT VERIFIED
Firefox         NOT VERIFIED
Android Chrome  NOT VERIFIED
iPhone Safari   NOT VERIFIED
TV browser      NOT VERIFIED
```

## 41. Recommended Improvements

### P0 — Critical

1. Verify and fix media-path containment before untrusted-network use.
2. Verify profile playback-state authorization boundaries.
3. Establish the real playback baseline with representative media.

### P1 — High

1. Build a repeatable playback test laboratory.
2. Implement standards-compliant HTTP Range handling.
3. Add structured playback error/recovery reporting.
4. Add FFmpeg process tracking and a concurrency guard.

### P2 — Medium

1. Expand media probing.
2. Persist container information.
3. Model multiple audio/video/subtitle streams.
4. Add client capability detection.

### P3 — Nice to Have

1. Advanced telemetry.
2. Detailed playback diagnostics UI.
3. Adaptive quality profiles.

## 42. Recommended Development Roadmap

The contract's proposed roadmap remains appropriate, with one security/testing adjustment:

```text
P0 — Baseline Investigation                 DONE (this report)
P1 — Playback Test Laboratory               NEXT
P1.1 — Playback path security verification NEXT/CRITICAL
P2 — Media Probing
P3 — Codec / Container Capability
P4 — Client Capability Model
P5 — Playback Decision Engine
P6 — Direct Play Hardening
P7 — Remux
P8 — Audio-only Transcoding
P9 — Video Transcoding
P10 — FFmpeg Reliability
P11 — Seeking / Range
P12 — Transcoding Cache
P13 — Resource Management
P14 — Recovery / Error Handling
P15 — Audio / Subtitle Handling
P16 — Hardware Acceleration
P17 — Multi-user / Stress
P18 — Final Playback Certification
```

Each stage should have its own tests and PM review. No stage should become a giant playback rewrite.

## 43. Dependencies

### OBSERVED IN CODE

Runtime dependencies relevant to playback:

- Node.js
- Express
- `better-sqlite3`
- external `ffmpeg`
- external `ffprobe`
- browser HTML5 video support

`package.json` does not list FFmpeg/FFprobe as an npm dependency; they are host executables expected on `PATH`.

The server uses Express 5.x and CommonJS modules.

### External compatibility references

For future implementation/testing, the compatibility model should be checked against current browser media-format documentation and the installed FFmpeg build capabilities rather than relying on a static codec whitelist.

## 44. Risks

| Risk | Severity | Finding |
|---|---|---|
| Path traversal / arbitrary file read | CRITICAL until tested/fixed | Playback route lacks explicit media-root containment |
| Wrong MIME for non-MP4 direct files | HIGH | `video/mp4` is hard-coded |
| Wrong Direct Play decisions | HIGH | Container/client capability ignored |
| CPU exhaustion from concurrent transcodes | HIGH | No global FFmpeg scheduler/limit |
| Duplicate transcodes | HIGH | No per-source in-flight deduplication |
| Live seek unavailable | HIGH | No Range/timestamp seek on live transcode |
| Multiple audio/subtitle handling | HIGH | Only first video/audio stream modeled |
| Stale cache | MEDIUM | Cache keyed only by relative path |
| Disk exhaustion | HIGH | No disk-space gate/cache quota |
| Crash recovery | MEDIUM | No startup temp-file/process reconciliation |
| Browser compatibility drift | MEDIUM | Static whitelist is not client-aware |
| Public-network exposure | HIGH | Home-server-grade auth and public playback routes |

## 45. Definition of Done

For the eventual Playback Engine release, the following should be demonstrably true:

1. Every playback decision is explainable.
2. Direct Play is used whenever the selected client can reliably play the exact container/codec combination.
3. Compatible streams are preserved whenever possible.
4. Remux is chosen before re-encoding when only the container is incompatible.
5. Audio-only transcoding preserves compatible video.
6. Video transcoding is used only when required.
7. Range requests are standards-compliant.
8. Direct and cached playback seek reliably.
9. Live-transcode seeking has an explicit supported strategy or an explicit documented limitation.
10. FFmpeg processes are tracked, cancellable, and concurrency-controlled.
11. Failed/partial caches cannot be mistaken for complete caches.
12. Source files are never destroyed by a failed conversion.
13. Audio and subtitle selection works for supported formats.
14. Resume state is reliable across normal browser/server lifecycle events.
15. Missing/corrupt/unsupported media produces actionable errors.
16. Path traversal and unauthorized playback-state access are closed.
17. CPU/RAM/disk behavior is measured on the target ordinary Windows PC class.
18. Chrome, Edge, Firefox, Android Chrome, iPhone Safari, and TV browser behavior is documented for the supported matrix.
19. Hardware acceleration is optional and cannot destabilize software playback.
20. Every implementation stage has automated/manual regression tests and PM approval.

## 46. Final Recommendation

### OBSERVED IN CODE

Baseflicks already has a useful foundation: ffprobe-based inspection, direct file serving with Range support, live H.264/AAC conversion, compatible-track copying, persistent conversion, temp-file finalization, sequential scanner conversion, playback-state persistence, and client-independent HTTP APIs.

The core weakness is that the playback engine is currently **codec-whitelist driven rather than capability/format driven**. It therefore cannot reliably answer the fundamental question:

> "Can this exact client play this exact media without unnecessary work?"

### RECOMMENDATION

**Do not rewrite playback yet.**

The safest next stage is:

```text
P1 — Playback Test Laboratory
        |
        +--> security verification
        |
        +--> real media corpus
        |
        +--> browser/client matrix
        |
        +--> HTTP/range traces
        |
        +--> FFmpeg resource measurements
        v
P2 — richer media probing
        v
P3/P4 — codec + container + client capability model
        v
P5 — explainable playback decision engine
        v
P6+ — hardening/remux/audio/video transcode/recovery/cache/resource work
```

The first implementation after PM approval should therefore be a **small, independently testable playback laboratory**, not a playback-engine rewrite. It should produce evidence for every later decision and expose the current security boundary before Baseflicks is used outside a trusted local environment.

### STOP CONDITION FOR THIS ASSIGNMENT

P0 is complete. No production playback code, database schema, scanner code, UI, or API behavior was changed as part of this assignment.

The identified path-traversal risk is an architectural/security boundary that must be reviewed before broader deployment. It should be treated as a PM-visible blocker for untrusted-network exposure, but it does not justify silently modifying production code during this analysis-only assignment.

---

## Investigation Sources

Repository source files inspected on `main`:

- `server.js`
- `ffmpeg.js`
- `database.js`
- `scanner.js`
- `poster.js`
- `package.json`
- `public/app.js`
- `fix-vob.js`
- `README.md`

External technical references consulted for compatibility context:

- MDN Media container formats: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers
- MDN video codecs: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs
- FFmpeg formats documentation: https://ffmpeg.org/ffmpeg-formats.html
- FFmpeg documentation: https://ffmpeg.org/ffmpeg.html
- ffprobe documentation: https://ffmpeg.org/ffprobe.html

All external compatibility information is contextual only; actual Baseflicks browser compatibility remains **NOT VERIFIED** until P1 testing is performed.
