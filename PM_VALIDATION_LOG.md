# Baseflicks Playback — PM Validation Log

## Purpose

This is the authoritative PM/Architect validation history for the Playback workstream on `feature/playback`.

For every task, PM records developer commit, scope validation, code/test/regression/benchmark validation, issues, decision, merge decision, and final merged commit when applicable.

## Competitive Benchmark

Jellyfin/Plex-level user-visible playback capability, reliability, correctness, and performance is the **minimum competitive benchmark**. Baseflicks must meet or exceed the relevant benchmark; simpler internals are acceptable only when behavior and quality are not inferior.

## Task 1 — Playback Engine Analysis

**Developer commit:** `a50cc3e519daf61695605c20f218fde3bcaca583`

**Scope validation:** Analysis-only; no unauthorized playback redesign.

**Code validation:** Playback pipeline and current architectural gaps reviewed.

**Test validation:** Analysis task; no production test requirement.

**Regression validation:** No application behavior changed.

**Benchmark validation:** Identified the capability-based playback and reliability gap relative to the benchmark.

**Issues:** Range handling, simplistic playback decision, client capability handling, transcoding hierarchy, cache behavior, streams/subtitles, and security required later work.

**PM decision:** PASS / ACCEPTED

**Merge policy:** No task-level merge. D1 remains on `feature/playback` until all D1 tasks are complete and the final D1 review passes.

## Task 2 — Media-Root Containment

**Developer commit:** `f185fcb1d6beb1243475f67a2a5a41e9098cf672`

**Scope validation:** Only playback path containment and focused regression tests were changed; no scanner/database/UI/FFmpeg redesign.

**Code validation:** `media-path.js` centralizes root containment, path normalization, realpath escape detection, prefix-collision protection, and safe handling of missing files. `/video` and `/watch` use the resolver; derived cache paths are also protected.

**Test validation:** Developer reported 28 passing tests, 0 failures, 0 skipped/todo/cancelled.

**Regression validation:** Focused tests cover legitimate nested paths, traversal, encoded traversal, absolute paths, prefix collision, junction escape, missing files, both routes, and a Range regression check.

**Benchmark validation:** Meets the required security/reliability baseline for media-root containment without changing the playback architecture.

**Issues / limitations:** TOCTOU replacement after realpath validation remains a separate hardening issue.

**PM decision:** PASS / ACCEPTED

**Merge policy:** No task-level merge. Remains on `feature/playback` pending final D1 completion and final PM merge review.

## Task 3 — Direct-Play HTTP Range Hardening

**Initial developer commit:** `1c3d51c7d0e22037cb976bedaeb2bd5744ecb9f7`

**Initial PM decision:** REWORK — minor correction required before PASS.

**Initial issue:** `parseByteRange()` filtered empty comma-separated range specifications before counting them, so headers such as `bytes=0-99,` could collapse to one valid spec and incorrectly return 206. PM required safe 200 full-file fallback for list-shaped input.

### Task 3 Rework — List-shaped Range headers

**Developer rework commit:** `2c00656e341ec857ed6867ba9effc379f31b8848`

**Developer response:** D1 corrected `parseByteRange()` so any comma in the Range value is treated as safe full-file fallback and added tests for trailing, leading, double-comma, and mixed-junk list-shaped values. D1 reported the complete suite at 66 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Scope validation:** PASS. Actual rework changes were limited to `server.js` Range handling and `test/direct-play-range.test.js` coverage. No scanner, database, UI, FFmpeg architecture, dependency, or unrelated playback redesign was introduced.

**Code validation:** PASS. PM independently inspected the actual `feature/playback` implementation. The corrected parser no longer collapses malformed list-shaped headers into a valid 206. Required single-range behavior remains intact.

**Regression validation:** PASS. Task 2 containment remained intact and Task 3 range/MIME requirements remained covered.

**Benchmark validation:** PASS for the Task 3 scope. The implementation safely avoids manufacturing multipart behavior and falls back to a complete response for list-shaped/malformed input.

**CI validation:** No GitHub status checks are attached to the rework commit. Local test evidence is recorded above.

**PM decision:** PASS / ACCEPTED.

**Merge policy:** No task-level merge. Task 3 remains on `feature/playback` until all D1 tasks are completed and the final D1 review passes.

## Task 4 — Structured Media Capability Probe Model

**Developer code commit:** `d4089cba9efc30da6611ff6ec1066455ca73fd98` on `baseflicks/feature/playback`.

**Authoritative branch tip inspected:** `f5049fd97f564658bcd3f26f684e967a803e9424` on `claude_baseflicks/feature/playback`, a cherry-pick of the same implementation content onto the PM documentation tip.

**Developer response:** D1 reported Task 4 complete, stopped as instructed, and supplied the changed-file list, output contract, failure behavior, 23 focused tests, manual real-media checks, and full-suite result of 89 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. D1 also confirmed no dependency changes and no `main` merge.

**Scope validation:** PASS. The actual Task 4 implementation adds only `media-probe.js`, `test/media-probe.test.js`, and additive `probeRaw()` support/export in `ffmpeg.js`. No scanner, database, UI, metadata, auth, route, server, or dependency changes were introduced by this task.

**Code validation:** PASS. PM independently inspected the actual GitHub implementation. `media-probe.js` provides a pure normalization layer plus filesystem/probe orchestration. The normalized model handles all video/audio/subtitle streams, preserves stream indexes, normalizes numeric values to Number/null, parses frame-rate rationals, supports language-tag fallbacks, classifies subtitle types, and returns stable `not_found` / `probe_failed` errors. The raw ffprobe document is kept behind the low-level `probeRaw()` boundary and is not exposed as the normalized application contract.

**Preservation validation:** PASS. `checkPlayability()` remains present and unchanged in the inspected `ffmpeg.js`; Task 4 adds no Direct Play, Remux, Audio Transcode, or Video Transcode decision logic. Task 2 containment and Task 3 range/MIME behavior are not modified by the Task 4 diff.

**Test validation:** PASS based on D1's reported complete local suite: 89 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0, including the 23 Task 4 tests. PM also inspected the actual fixture-driven Task 4 test file and confirmed coverage for single/multi-stream media, no-video media, index preservation, numeric normalization, frame-rate parsing, language fallbacks, malformed probe data, filesystem failures, injected probe failures, and regression contracts.

**Manual validation:** Developer reported successful real-media checks for an MP4, an MKV, and a missing media path. These checks are recorded as developer evidence; the PM acceptance is based on the actual code/test inspection rather than the report alone.

**CI validation:** No GitHub Actions/status check is attached to the Task 4 commit. This remains a repository/QA infrastructure limitation. Local test evidence is recorded separately above.

**Known limitations recorded:** `probeRaw()` duplicates the existing ffprobe invocation rather than refactoring `probeFile()`; per-stream bitrate may be null when the container does not provide it; subtitle type classification is intentionally coarse; HDR/color/disposition metadata is deferred. These are consistent with Task 4 scope and are not blockers.

**PM decision:** PASS / ACCEPTED.

**Merge policy:** No task-level merge. Task 4 remains on `feature/playback`. PM will reconcile branch divergence and merge only after all D1 tasks are complete and the final full D1 review passes.

## Task 5 — Client Capability Model

**Developer code commit:** `f4aad4700696a847f1db8706249c71f709008a81` on `baseflicks/feature/playback`.

**Authoritative branch tip inspected:** `e808c1430e46dd4fd3cfadc12d7a97cc70f95eef` on `claude_baseflicks/feature/playback`.

**Developer response:** D1 reported Task 5 complete and stopped as instructed. The report supplied the changed-file list, normalized contract, browser detection behavior, limitations, and full-suite result of 114 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. D1 confirmed `main` was unchanged and no dependencies were added.

**Scope validation:** PASS. PM independently compared the actual Task 5 commit with the preceding PM documentation tip and confirmed exactly two added files: `client-capabilities.js` and `test/client-capabilities.test.js`. No `server.js`, `ffmpeg.js`, `media-path.js`, scanner, database, metadata, UI, or `package.json` changes were introduced by Task 5.

**Code validation:** PASS. `client-capabilities.js` provides a UMD-compatible capability foundation with a single registry for the required video/audio/container formats, alias canonicalization, tri-state (`supported` / `unsupported` / `unknown`) values, safe invalid/partial input handling, duplicate conflict handling, validated resolution limits, warnings, frozen normalized output, and a detached frozen raw audit copy. `capabilityOf()` is alias-aware and conservative.

**Browser capability validation:** PASS for the assigned foundation scope. The implementation provides injectable `HTMLMediaElement.canPlayType()` detection, optional pre-gathered `MediaCapabilities.decodingInfo()` result refinement, and screen/DPR resolution information. Missing or uncertain capability information remains `unknown`; browser APIs are not executed by the server-side normalization path.

**Decision-engine boundary:** PASS. The implementation explicitly does not combine container, codec, profile, level, resolution, and audio properties and does not select Direct Play, Remux, Audio Transcode, or Video Transcode. That composition remains a later task.

**Regression validation:** PASS. The Task 5 tests explicitly verify that Task 4 media-probe codec names canonicalize into the client registry and that existing `ffmpeg.js` and `media-path.js` contracts remain available. The capability module does not pull `server.js` into its require graph.

**Test validation:** PASS based on D1's reported complete local suite: 114 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0, including 25 Task 5 tests. PM independently inspected the actual Task 5 test file and confirmed coverage for model creation, supported/unsupported/unknown values, partial information, invalid input, browser API fallback, normalization/aliases/conflicts/freezing/raw detachment, Task 4 regression, and playback-contract preservation.

**CI validation:** No GitHub Actions/status check is attached to the Task 5 commit. Local test evidence is therefore the recorded execution evidence.

**Known limitations recorded:** The capability model is not yet wired into the live player or HTTP endpoint; `MediaCapabilities.decodingInfo()` gathering remains the browser caller's responsibility; capability granularity is codec-name level and does not yet represent profile/level/bit-depth/HDR/channel constraints; subtitles are outside this task. These are deferred by design and are not blockers for Task 5.

**PM decision:** **PASS / ACCEPTED.** Task 5 meets the requested capability-model foundation and preserves the boundary against premature playback decision logic.

**Merge policy:** No task-level merge. Task 5 remains on `feature/playback` until all D1 tasks are complete and the final full-workstream review passes.

## Task 6 — Capability-Based Playback Decision Engine

**Developer implementation commit:** `e8d7629495d50b99ccec5c450acb8dc558e96596` on `baseflicks/feature/playback`.

**Authoritative PM branch tip inspected:** `4f1b3aa5a3cece3f57c788aa2f2a56b9856d7aa3` on `claude_baseflicks/feature/playback`.

**Developer response:** D1 reported Task 6 complete and stopped as instructed. The report supplied the exact changed-file list, decision contract, hierarchy, conservative handling, limitations, and full-suite result of 138 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Scope validation:** PASS. PM independently inspected the actual Task 6 commit and confirmed exactly two added files: `playback-decision.js` and `test/playback-decision.test.js`. The commit has no `server.js`, `/video` route, `ffmpeg.js`, transcode-job, cache, scanner, database, metadata, player/library UI, HTTP API, `package.json`, or dependency changes.

**Code validation:** PASS. `decidePlayback(media, client)` normalizes the client through Task 5, consumes the Task 4 media description, resolves the container, canonicalizes media codecs, evaluates Direct Play → Remux → Audio Transcode → Video Transcode in order, and returns a deeply frozen result. The engine is stateless and has no filesystem, HTTP, Express, database, scanner, browser, or FFmpeg execution dependency. The source/client summaries, blockers, reasons, targets, and warnings match the intended decision-layer contract.

**Conservative validation:** PASS. Unknown client capabilities are not promoted to support. The inspected implementation explicitly distinguishes supported, unsupported, and unknown states and blocks copy-based modes when required capability information is unknown. The H.264 + client-H.264-unknown case is explicitly covered by the tests.

**Media/stream validation:** PASS for the assigned scope. Container resolution uses extension first with ffprobe format fallback. Resolution ceilings and deterministic high-bit-depth/non-4:2:0 checks can block copying. Audio-only and video-only media are handled. Multiple stream counts are reported and warnings are emitted; the current decision uses the first audio/video stream as the primary stream, as deliberately documented by the implementation.

**Hierarchy validation:** PASS. The implementation does not let an unsupported audio track fall through directly to Video Transcode when copyable video plus a supported target audio/container can satisfy Audio Transcode. Conversely, unsupported video/resolution/exotic-video blockers prevent Audio Transcode and force Video Transcode.

**Test validation:** PASS based on D1's reported complete local suite: 138 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0, including 24 Task 6 tests. PM inspected the actual Task 6 test file and confirmed coverage for Direct Play, unsupported video/audio, Remux including WebM-only targeting, unsupported container + unsupported video, unknown and partial clients, resolution limits, exotic video, audio-only/video-only, multi-stream warnings, malformed inputs, determinism, container resolution, and end-to-end Task 4 → Task 5 → Task 6 composition.

**Regression validation:** PASS. Task 2–5 implementations remain intact and the Task 6 commit is additive. No prior playback hardening or model files were overwritten.

**Benchmark validation:** PASS for the decision-layer scope. The new capability-based decision engine is a substantial improvement over the original codec whitelist and establishes the required Jellyfin/Plex-level capability foundation. Live playback behavior has not yet changed and therefore still requires integration and runtime validation.

**CI validation:** No GitHub Actions/status check is attached to the Task 6 commit. Local test execution is the recorded evidence for the reported 138 passing tests.

**Known limitations recorded:** Capability granularity is still codec-name based; profile/level compatibility is not fully represented. Remux container/codec combinations use a static compatibility table rather than client-specific combination probing. Multi-stream selection is deferred; first-stream selection is currently intentional and warnings/counts expose the limitation. Live route integration and actual remux/transcode execution are not part of Task 6.

**PM decision:** **PASS / ACCEPTED.** No rework is required for Task 6 within the assigned scope.

**Merge decision:** **PENDING.** No individual D1 task is merged to `main`. PM will reconcile branch divergence and perform the final merge only after the complete Playback workstream passes its final review.

## Task 7 — Playback Decision Integration Boundary

**Developer implementation commit:** `3adb16664412731a525de4d426379901904c9feb` on `claude_baseflicks/feature/playback`. D1 also reported `bbc9a5a43f3a53ac41fdb7e1b587e36edfd823b8` on the `baseflicks` remote, but that SHA is not present in the authoritative `Claude_Baseflicks` repository and is therefore not used as the inspected source of truth.

**Scope validation:** PASS. The authoritative Task 7 commit is a direct child of the previous PM validation tip and adds the playback integration boundary, server orchestration, and integration tests. No scanner, database schema, metadata, UI, FFmpeg implementation, or dependency changes were introduced.

**Code validation:** PASS. `playback-integration.js` is an orchestration-only module connecting media probing, client capability intake, and `decidePlayback()`. `server.js` imports this boundary rather than duplicating decision rules. The diagnostic endpoint performs containment + library-row validation, then full media probing and decision. The `/video` path uses a lightweight scanner-row probe and exposes an advisory decision header while leaving the existing streaming implementation in place.

**Capability intake validation:** PASS. Request-scoped capabilities can arrive through the diagnostic request body or the `X-Baseflix-Client-Capabilities` header / `caps` query. Oversized, unparsable, missing, or non-object inputs are treated conservatively and ultimately normalize through the decision engine without crashing the route.

**Security/regression validation:** PASS. The diagnostic endpoint reuses `resolveMediaFilePath()` and requires a matching library row before probing. Existing `/video` and `/watch` containment remains in place. Task 3's range/MIME/416 implementation remains in `serveDirectPlay()`, and Task 7's tests exercise containment, range responses, response bytes, and advisory-header coexistence.

**Architectural observation:** The `/video` advisory result is deliberately degraded because the scanner row does not contain all Task 4 probe fields. That is acceptable for Task 7 because the result is advisory-only and cannot change playback. Full-fidelity probing remains available through the diagnostic boundary. The first-stream and static container compatibility limitations remain inherited from Task 6.

**Test validation:** PASS based on D1's reported complete local suite: 158 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0, including 20 Task 7 tests. PM inspected the actual Task 7 test source and confirmed coverage for capability intake, lightweight probe construction, all four decision modes reaching the integration boundary, malformed/missing capabilities, injected full-probe composition, diagnostic endpoint validation, advisory `/video` headers, Task 2 containment, Task 3 range/416, and byte-preservation checks.

**CI validation:** No GitHub Actions/status check is attached to the Task 7 feature commit. Local test execution is the recorded evidence.

**Known limitations:** Task 7 is advisory-only; Remux/Audio Transcode/Video Transcode execution is intentionally deferred. The `/video` path uses a degraded scanner-row probe without profile/level/frame-rate/pixel-format information. The diagnostic endpoint runs ffprobe per request and has no rate limiting or probe cache yet. Capabilities are request-scoped rather than persisted. Matroska/WebM disambiguation remains extension-based. The integration module also contains an unused `path` import, which is a minor cleanup item but not a correctness blocker.

**PM decision:** **PASS / ACCEPTED.** No rework is required for Task 7 within the assigned scope.

**Merge decision:** **PENDING.** No individual D1 task is merged to `main`. D1 remains on `feature/playback` until the complete Playback workstream and final PM review are complete.

## PM Merge Policy

Developers do not merge playback branches into `main` themselves. PM validates each task on `feature/playback` and records the result here. **No individual D1 task is merged to `main`.** After all D1 tasks are completed, PM performs a final full-workstream review, reconciles branch divergence, and then performs the controlled merge to `main` if the complete D1 implementation passes.
