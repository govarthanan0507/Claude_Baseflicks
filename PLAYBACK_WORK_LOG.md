# Baseflicks Playback — Cumulative Work Log

## Purpose

This file is the cumulative implementation/work history for the Playback workstream on `feature/playback`.

It is appended/updated as each playback task is completed. Previous task history must not be removed.

## Competitive Benchmark

Jellyfin/Plex-level user-visible playback capability, reliability, correctness, and performance is the **minimum competitive benchmark**. Baseflicks may use a simpler internal implementation only when the resulting behavior and quality are not inferior.

## Task 1 — Playback Engine Analysis

**Status:** PASS / ACCEPTED

**Commit:** `a50cc3e519daf61695605c20f218fde3bcaca583`

**Work:** Analyzed the existing playback pipeline and identified gaps in capability-based playback, HTTP range handling, media probing, transcoding hierarchy, cache handling, multiple streams/subtitles, and security.

**Result:** Analysis accepted. No production playback redesign was authorized from this task.

## Task 2 — Media-Root Containment

**Status:** PASS / ACCEPTED

**Commit:** `f185fcb1d6beb1243475f67a2a5a41e9098cf672`

**Work:** Added centralized media-root path containment and realpath validation for `/video/:filename`, `/watch/:filename`, and derived transcode cache paths. Added focused automated containment/regression tests.

**Result:** Scope and implementation validated. Task accepted.

## Task 3 — Direct-Play HTTP Range Hardening

**Status:** PASS / ACCEPTED after rework

**Initial commit:** `1c3d51c7d0e22037cb976bedaeb2bd5744ecb9f7`

**Rework commit:** `2c00656e341ec857ed6867ba9effc379f31b8848`

**Work:** Hardened direct-play single-range handling, 416 responses, safe malformed/multiple-range fallback, extension-based MIME types, stream/stat error handling, and focused HTTP regression tests while preserving Task 2 containment.

**PM feedback/rework:** The initial parser filtered empty comma-separated range specs, allowing `bytes=0-99,` to become a valid 206. D1 corrected this by treating any comma-containing Range value as safe full-file fallback and added coverage for leading/trailing/double-comma/list-shaped cases.

**Developer test result after rework:** 66 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Result:** PM independently inspected the actual `server.js` and range tests on `feature/playback`. Task 3 rework accepted. It remains on `feature/playback`; no individual-task merge to `main`.

## Task 4 — Structured Media Capability Probe Model

**Status:** PASS / ACCEPTED

**Developer commit:** `f5049fd97f564658bcd3f26f684e967a803e9424` on `claude_baseflicks/feature/playback` (equivalent implementation commit `d4089cba9efc30da6611ff6ec1066455ca73fd98` on `baseflicks/feature/playback).

**Developer report:** D1 reported Task 4 complete with changes limited to `ffmpeg.js`, new `media-probe.js`, and new `test/media-probe.test.js`; no dependencies or unrelated subsystems changed. D1 reported 23 new fixture-driven tests and full suite result of 89 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. D1 also reported manual real-media checks for MP4, MKV, and a missing file.

**Work:** Added an additive raw ffprobe boundary and a normalized media description layer. The normalized model captures container information and every video, audio, and subtitle stream; numeric fields are normalized to Number/null, frame-rate rationals are parsed, language tags have fallbacks, subtitle codecs receive coarse text/image classification, non-contiguous stream indexes are preserved, and audio-only media is valid with an empty video array. Filesystem/probe failures return stable `not_found` or `probe_failed` errors.

**Scope preservation:** Existing `probeFile()` and `checkPlayability()` were preserved; no Direct Play/Remux/Audio Transcode/Video Transcode decision logic was added. `server.js`, `media-path.js`, scanner, database, UI, package dependencies, and metadata were not changed by Task 4.

**PM result:** PASS / ACCEPTED after independent inspection of the actual commit, `media-probe.js`, `ffmpeg.js`, and Task 4 tests. Task 2 and Task 3 behavior remains outside the Task 4 diff and is covered by the full reported suite.

**Merge:** PENDING. D1 remains on `feature/playback`; PM will merge only after all D1 tasks are completed and the final full-workstream review passes.

## Task 5 — Client Capability Model

**Status:** PASS / ACCEPTED

**Developer implementation commit:** `f4aad4700696a847f1db8706249c71f709008a81` on `baseflicks/feature/playback`; authoritative PM branch tip inspected at `e808c1430e46dd4fd3cfadc12d7a97cc70f95eef` on `claude_baseflicks/feature/playback`.

**Developer report:** D1 reported Task 5 complete with changes limited to new `client-capabilities.js` and `test/client-capabilities.test.js`; no server, FFmpeg, scanner, database, metadata, UI, or dependency changes. D1 reported 25 new tests and a full suite result of 114 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. `main` was unchanged.

**Work:** Added a normalized client capability model covering video codecs H.264/HEVC/VP8/VP9/AV1, audio codecs AAC/MP3/Opus/Vorbis/AC3/E-AC3/FLAC, containers MP4/WebM/MKV/MOV/AVI, and a resolution ceiling where known. Capabilities use conservative tri-state values (`supported`, `unsupported`, `unknown`) with alias canonicalization, partial-information handling, conflict handling, invalid-input tolerance, warnings, and frozen audit data.

**Browser detection:** Added injectable `HTMLMediaElement.canPlayType()` detection plus an optional pre-gathered `MediaCapabilities.decodingInfo()` result hook and screen/DPR resolution ceiling. Browser APIs remain client-side; the server-facing model is a normalized plain object. Missing/uncertain capability information is not promoted to support.

**Scope preservation:** No playback decision engine, Direct Play selection, Remux, Audio Transcode, Video Transcode, FFmpeg job, cache, scanner, database, metadata, or UI integration was added. The implementation explicitly leaves composition of container + codec + profile + level + resolution + audio to the later decision engine.

**PM code validation:** PM independently inspected the actual GitHub `feature/playback` commit and both Task 5 source/test files. The commit comparison from the preceding PM documentation tip shows exactly two added files and no unrelated changes. The model exposes the required registries, tri-state normalization, alias handling, conflict handling, resolution validation, browser capability detection, and query API. The tests exercise the required categories and regression boundaries.

**PM regression validation:** Task 4 media-probe codec names are covered by the Task 5 registry regression, and existing `ffmpeg.js` / `media-path.js` contracts are asserted. No `server.js` dependency is introduced by the capability module.

**Test validation:** Developer reported 114 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. PM inspected the actual 25-test Task 5 suite. No GitHub Actions/status check is attached to the Task 5 commit; local test evidence is therefore the recorded execution evidence.

**Known limitations recorded:** The model is not yet wired into the live player or HTTP endpoint; `MediaCapabilities.decodingInfo()` gathering remains the browser caller's responsibility; capability granularity is codec-name level and does not yet represent profile/level/bit-depth/HDR/channel constraints; subtitles are outside this task. These are deferred by design and are not blockers for Task 5.

**PM result:** PASS / ACCEPTED. The implementation satisfies Task 5's foundation scope without prematurely implementing playback decisions.

**Merge:** PENDING. No individual task is merged to `main`. D1 remains on `feature/playback` until all D1 tasks are complete and the final full-workstream review passes.

## Task 6 — Capability-Based Playback Decision Engine

**Status:** PASS / ACCEPTED

**Developer implementation commit:** `e8d7629495d50b99ccec5c450acb8dc558e96596` on `baseflicks/feature/playback`; authoritative PM branch tip inspected at `4f1b3aa5a3cece3f57c788aa2f2a56b9856d7aa3` on `claude_baseflicks/feature/playback`.

**Developer report:** D1 reported Task 6 complete with exactly two new files: `playback-decision.js` and `test/playback-decision.test.js`; no server, route, FFmpeg, transcode job, cache, scanner, database, metadata, UI, HTTP API, package, or dependency changes. Main remained unchanged. Developer reported 24 new Task 6 tests and a full suite of 138 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Work:** Added a pure, deterministic playback decision engine consuming the Task 4 media-probe model and Task 5 normalized client capability model. The engine evaluates `direct_play -> remux -> audio_transcode -> video_transcode` in order and selects the first possible mode. It returns a frozen structured decision containing the selected mode, reason, source stream/container summary, client capability summary, per-mode feasibility/blockers, transcode targets, and warnings.

**Conservative capability rule:** `unknown` is never promoted to `supported`. Direct Play, Remux, and Audio Transcode require explicit support for the relevant capability. H.264 with client H.264=`unknown` is therefore not Direct Play.

**Media constraints:** Container is resolved from file extension first with ffprobe format fallback. Video codec and audio codec are canonicalized through the Task 5 model. Resolution limits and deterministic high-bit-depth/non-4:2:0 video checks can block stream copying. The engine recognizes audio-only and video-only media, reports stream counts, and warns when multiple streams exist while using the first stream as the primary decision input. Media/client malformed inputs degrade safely to the conservative Video Transcode fallback without throwing.

**Remux/transcode targeting:** Remux selects a client-supported MP4/WebM target only when the target can carry the selected codecs without re-encoding. Audio Transcode preserves copyable video and chooses a supported target audio codec/container. Video Transcode remains the universal fallback target. No actual FFmpeg execution was introduced by this task.

**PM code validation:** PASS. PM independently inspected the actual GitHub `feature/playback` implementation and Task 6 test file, including the complete decision flow, mode evaluation, normalization boundary, conservative unknown handling, container resolution, resolution/exotic-video checks, malformed-input handling, frozen output, and module exports. The actual Task 6 commit contains exactly the two requested added files and no unrelated application changes.

**Regression validation:** PASS based on the reported 138-test full suite and inspection of the cumulative Task 2–6 tests. Task 2 containment, Task 3 range hardening, Task 4 probe contracts, and Task 5 capability contracts remain outside the Task 6 diff and are not overwritten. The Task 6 tests include an end-to-end probe/capability/decision contract check.

**Architectural validation:** PASS. The decision engine is stateless and has no Express, HTTP, database, scanner, UI, or FFmpeg execution dependency. It is suitable for later server integration without forcing a rewrite of the existing architecture.

**Benchmark validation:** PASS for the Task 6 decision-layer scope. The capability-based decision engine is a substantial improvement over the original codec whitelist and establishes the required Direct Play → Remux → Audio Transcode → Video Transcode foundation. Live playback behavior remains to be integrated and validated later.

**Known limitations recorded:** Client capability granularity remains codec-name based; H.264/HEVC profile and level compatibility cannot yet be fully evaluated because those fields are not represented by the Task 4/5 contracts. Container/codec combination support is represented by a static remux compatibility table rather than per-client combination probing. Multi-stream selection is intentionally deferred; the first audio/video stream drives the current decision and counts/warnings are reported. CI is still not attached to the feature branch, so local test execution is the recorded test evidence.

**PM decision:** **PASS / ACCEPTED.** No rework is required for Task 6 within the assigned scope.

**Merge:** PENDING. No individual task is merged to `main`. D1 remains on `feature/playback` until the complete Playback workstream is finished and the final PM review passes.

## Task 7 — Playback Decision Integration Boundary

**Status:** PASS / ACCEPTED

**Developer implementation commit:** `bbc9a5a43f3a53ac41fdb7e1b587e36edfd823b8` on `baseflicks/feature/playback`; authoritative PM inspection commit: `3adb16664412731a525de4d426379901904c9feb` on `claude_baseflicks/feature/playback`.

**Developer report:** D1 reported Task 7 complete with a new `playback-integration.js`, `server.js` orchestration, new integration tests, and fixture-list updates required by the isolated server tests. Main remained unchanged and no task-level merge was performed. Developer reported 20 Task 7 tests and a complete suite of 158 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Work:** Added a dedicated orchestration boundary connecting Task 4 media probing, Task 5 client capability normalization, and Task 6 playback decisions. `playback-integration.js` exposes safe capability intake, a lightweight library-row probe for the hot `/video` path, a full-probe decision path for diagnostics, and a compact probe summary. `server.js` adds `POST /api/playback/decision` and surfaces an advisory playback-mode header on `/video` without executing Remux or Transcode.

**Capability intake:** The integration accepts client capabilities from the request body for the diagnostic endpoint or from the `X-Baseflix-Client-Capabilities` header / `caps` query. Missing, oversized, unparsable, or non-object values are passed as undefined and therefore normalize through Task 6 to the conservative unknown-capability result. No session/schema persistence was introduced.

**Playback preservation:** The `/video` route retains the existing serving path and `serveDirectPlay()` range implementation; Task 7 only adds the advisory decision calculation and response headers. The diagnostic endpoint performs a real library-row check and full `describeMedia()` probe, while the `/video` hot path avoids an extra ffprobe by using stored codec/width/height/size fields.

**Security/regression preservation:** The diagnostic endpoint reuses `resolveMediaFilePath()` and requires a real library row. Task 2 traversal protection and Task 3 Range/416/MIME behavior remain covered. The two existing isolated-runtime test fixtures were updated only to copy the newly required playback modules into the test runtime.

**Code validation:** PASS. PM independently inspected the authoritative Task 7 commit and confirmed the integration module contains orchestration only, while decision rules remain in `playback-decision.js`. `server.js` delegates to the integration boundary and does not duplicate decision rules. The commit contains the expected integration files and fixture-only test adjustments; scanner, database schema, metadata, UI, FFmpeg execution, and package dependencies are outside the Task 7 change.

**Important architectural observation:** The `/video` advisory decision is intentionally degraded because the scanner row does not contain all Task 4 probe fields. This is acceptable for Task 7 because the result is advisory and does not control serving. Full-fidelity ffprobe remains available through the diagnostic boundary. The first-stream limitation and static container compatibility model remain known Task 6 limitations.

**Test validation:** PASS based on D1's reported complete local suite: 158 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0, including 20 Task 7 tests. The inspected Task 7 tests cover capability intake, lightweight probe construction, all four decision modes reaching the boundary, malformed/missing capabilities, injected full-probe composition, diagnostic endpoint validation, advisory `/video` headers, Task 2 containment, Task 3 range/416, and byte-preservation checks.

**CI validation:** No GitHub Actions/status check is attached to the Task 7 feature commit. Local test execution is the recorded evidence.

**Known limitations recorded:** Task 7 is advisory-only; Remux/Audio Transcode/Video Transcode execution is intentionally deferred. The `/video` path uses a degraded scanner-row probe without profile/level/frame-rate/pixel-format information. The diagnostic endpoint runs ffprobe per request and has no rate limiting or probe cache yet. Capabilities are request-scoped rather than persisted. Matroska/WebM disambiguation remains extension-based. These are deferred and are not blockers for Task 7.

**PM decision:** **PASS / ACCEPTED.** No rework is required for Task 7 within the assigned scope.

**Merge:** PENDING. No individual task is merged to `main`. D1 remains on `feature/playback` until the complete Playback workstream and final PM review are complete.

## Change Policy

For every subsequent playback task, append a new task section containing assignment, work performed, files changed, developer tests, commit SHA, status, developer report/rework history, and PM outcome. Never delete prior history.
