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

**PM feedback/rework:** The initial parser filtered empty comma-separated range specifications, allowing `bytes=0-99,` to become a valid 206. D1 corrected this by treating any comma-containing Range value as safe full-file fallback and added coverage for leading/trailing/double-comma/list-shaped cases.

**Developer test result after rework:** 66 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Result:** PM independently inspected the actual `server.js` and range tests on `feature/playback`. Task 3 rework accepted. It remains on `feature/playback`; no individual-task merge to `main`.

## Task 4 — Structured Media Capability Probe Model

**Status:** PASS / ACCEPTED

**Developer commit:** `f5049fd97f564658bcd3f26f684e967a803e9424` on `claude_baseflicks/feature/playback` (equivalent implementation commit `d4089cba9efc30da6611ff6ec1066455ca73fd98` on `baseflicks/feature/playback).

**Work:** Added an additive raw ffprobe boundary and a normalized media description layer. The normalized model captures container information and every video, audio, and subtitle stream; numeric fields are normalized to Number/null, frame-rate rationals are parsed, language tags have fallbacks, subtitle codecs receive coarse text/image classification, non-contiguous stream indexes are preserved, and audio-only media is valid with an empty video array. Filesystem/probe failures return stable `not_found` or `probe_failed` errors.

**Scope preservation:** Existing `probeFile()` and `checkPlayability()` were preserved; no Direct Play/Remux/Audio Transcode/Video Transcode decision logic was added. `server.js`, `media-path.js`, scanner, database, UI, package dependencies, and metadata were not changed by Task 4.

**PM result:** PASS / ACCEPTED after independent inspection of the actual commit, `media-probe.js`, `ffmpeg.js`, and Task 4 tests.

**Merge:** PENDING. D1 remains on `feature/playback`; PM will merge only after all D1 tasks are completed and the final full-workstream review passes.

## Task 5 — Client Capability Model

**Status:** PASS / ACCEPTED

**Developer implementation commit:** `f4aad4700696a847f1db8706249c71f709008a81` on `baseflicks/feature/playback`; authoritative PM branch tip inspected at `e808c1430e46dd4fd3cfadc12d7a97cc70f95eef` on `claude_baseflicks/feature/playback`.

**Work:** Added a normalized client capability model covering video, audio, and container capabilities, conservative tri-state handling, aliases/conflicts, resolution limits, browser capability detection hooks, warnings, and frozen normalized/audit data.

**PM result:** PASS / ACCEPTED after independent source/test inspection. No live playback decision or execution was added.

**Merge:** PENDING until final D1 workstream review.

## Task 6 — Capability-Based Playback Decision Engine

**Status:** PASS / ACCEPTED

**Developer implementation commit:** `e8d7629495d50b99ccec5c450acb8dc558e96596`; authoritative PM branch tip `4f1b3aa5a3cece3f57c788aa2f2a56b9856d7aa3`.

**Work:** Added a pure capability-based decision engine evaluating `DIRECT_PLAY → REMUX → AUDIO_TRANSCODE → VIDEO_TRANSCODE`, with conservative unknown handling, container/codec/resolution checks, structured blockers/reasons/targets, and multi-stream warnings.

**PM result:** PASS / ACCEPTED. The decision layer remains stateless and independent of HTTP, FFmpeg, database, scanner, and UI.

**Merge:** PENDING until final D1 workstream review.

## Task 7 — Playback Decision Integration Boundary

**Status:** PASS / ACCEPTED

**Authoritative commit:** `3adb16664412731a525de4d426379901904c9feb`.

**Work:** Added orchestration between media probing, client capability normalization, and Task 6 decisions; added diagnostic decision API and advisory playback headers on `/video` without executing Remux/Transcode.

**PM result:** PASS / ACCEPTED. Task 2 containment and Task 3 serving/range behavior were preserved.

**Merge:** PENDING until final D1 workstream review.

## Task 8 — Direct Play Execution Integration

**Status:** PASS / ACCEPTED

**Authoritative commit:** `28e90e5fb3250838c1c59847a12fb8cdfcf7ce6e`.

**Work:** Integrated the Task 6 decision boundary into `/video` so an explicit `direct_play` decision reaches the existing hardened `serveDirectPlay()` implementation. Full ffprobe confirmation is required when `needs_transcode=1`; failed confirmation cannot direct-play. Added bounded decision caching and playback headers. Non-direct modes continue through fallback paths.

**PM validation:** PASS after independent inspection of `server.js`, integration code, and tests. Direct Play execution preserves Task 2 containment and Task 3 Range/416 behavior. No Remux/Audio/Video execution was incorrectly introduced by this task.

**Developer test result:** 181 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Merge:** PENDING until final D1 workstream review.

## Task 9 — Remux Execution Integration

**Status:** PASS / ACCEPTED after rework

**Initial authoritative commit:** `8cdf917186ddac8117a27e0ca3add943d4216457`.

**Rework authoritative commit:** `92c504a5fbeeddab582cf29a6cabc94fd4400639`.

**Work:** Added deterministic Remux execution with FFmpeg stream copy, dedicated `remuxed/` cache, in-flight job de-duplication, safe argument arrays, atomic `.tmp → final` completion, and serving through the hardened Range path. Remux remains below Direct Play and above Audio Transcode.

**PM feedback/rework:** PM found a cache identity defect where `mtimeMs` was reduced to whole seconds, allowing same-size rapid source edits to reuse stale remux output. D1 corrected the identity to retain full `mtimeMs` precision and added sub-second/same-size rewrite coverage.

**Developer test result after rework:** 205 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**PM result:** PASS / ACCEPTED. Cache identity, atomic completion, containment, Range serving, and hierarchy were independently inspected. A latent waiter/abort lifecycle issue remained in the Remux job manager and was deliberately deferred to Task 11 rather than expanding the Task 9 rework scope.

**Merge:** PENDING until final D1 workstream review.

## Task 10 — Audio Transcode Execution Integration

**Status:** PASS / ACCEPTED after rework

**Initial authoritative commit:** `8f6832d6c6a389cc6205f318b0ab03cb7ff2e200`.

**Rework authoritative commit:** `b83cfcaf4e5d7df379508516f439248e1e2ca9d4`.

**Work:** Added audio-only FFmpeg execution below Remux and above Video Transcode, preserving copyable video while encoding the selected target audio codec. Added a dedicated `audio_transcoded/` cache, in-flight de-duplication, atomic completion, full-precision source identity, safe FFmpeg argument arrays, and completed-output serving through the existing hardened Range path.

**PM feedback/rework:** PM independently found a waiter lifecycle defect: timeout could leave a phantom waiter, and abort before process registration could fail to terminate the process. D1 corrected the lifecycle with idempotent release, zero-waiter cancellation, kill-on-registration, and prompt abort handling. Rework scope was limited to `audio-transcode.js` and its focused tests.

**Developer test result after rework:** 236 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**PM result:** PASS / ACCEPTED. Direct Play → Remux → Audio Transcode ordering is preserved, Task 6 target/audio codec values are used directly, and the Audio Transcode job lifecycle is hardened. The analogous Remux lifecycle issue was intentionally deferred to Task 11.

**Merge:** PENDING until final D1 workstream review.

## Task 11 — Remux Job Lifecycle Hardening

**Status:** PASS / ACCEPTED

**Authoritative commit:** `3fe68dc0ab3cf1a75c7dc57be934931e60dd0a69` on `claude_baseflicks/feature/playback`.

**Developer implementation source:** `43481022dfb923a32c27e903af2eb84e04bacda4` on the `baseflicks` remote, cherry-picked to the authoritative PM branch.

**Scope:** Limited to `remux.js` waiter lifecycle and `test/remux-execution.test.js` lifecycle regressions. No Audio Transcode, server hierarchy, decision engine, cache identity, containment, Range implementation, scanner, database, metadata, UI, auth, or dependency changes.

**Work:** Hardened the existing Remux job manager so each request increments the waiter count once and releases exactly once through a guarded release path. Abort and timeout now release correctly; a zero-waiter job is cancelled immediately when running or armed for kill as soon as FFmpeg registers. Aborted requests race the shared job and return promptly. Concurrent requests still share one FFmpeg job, and the job continues when at least one waiter remains. Successful, failed, and cancelled jobs clean their in-flight registry state.

**Cache/execution preservation:** Full `mtimeMs` cache identity, deterministic cache path, completed-cache reuse, atomic `.tmp → final`, FFmpeg execution, and existing serving integration were left unchanged.

**Regression tests:** Added focused lifecycle coverage for abort before process registration, all waiters aborting before start, one of two waiters aborting, timeout waiter release, timeout as final waiter, prompt abort return, successful completion/reuse, and failed-job cleanup/fresh retry. Existing Range 206/416, de-duplication, cache reuse, containment, Audio Transcode, Video Transcode, and real-FFmpeg route coverage remained.

**Developer test result:** 243 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Known limitations:** A lone timeout now cancels the Remux rather than warming the cache in the background; the in-flight registry is process-local; no cache size/age eviction was introduced. CI remains absent on the feature branch, so local `npm test` is the recorded execution evidence.

**PM result:** PASS / ACCEPTED after independent GitHub inspection of the authoritative commit, actual `remux.js` lifecycle implementation, commit diff, and Task 11 regression suite. No correctness blocker was found within scope.

**Merge:** PENDING. No individual D1 task is merged to `main`; PM will perform the controlled merge only after final full-workstream review.

## Change Policy

For every subsequent playback task, append a new task section containing assignment, work performed, files changed, developer tests, commit SHA, status, developer report/rework history, and PM outcome. Never delete prior history.
