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

## PM Merge Policy

Developers do not merge playback branches into `main` themselves. PM validates each task on `feature/playback` and records the result here. **No individual D1 task is merged to `main`.** After all D1 tasks are completed, PM performs a final full-workstream review, reconciles branch divergence, and then performs the controlled merge to `main` if the complete D1 implementation passes.
