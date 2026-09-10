# Baseflicks Playback — PM Validation Log

## Purpose

This is the authoritative PM/Architect validation history for the Playback workstream on `feature/playback`.

For every task, PM records developer commit, scope validation, code/test/regression/benchmark validation, issues, decision, merge decision, and final merged commit when applicable.

## Competitive Benchmark

Jellyfin/Plex-level user-visible playback capability, reliability, correctness, and performance is the **minimum competitive benchmark**. Baseflicks must meet or exceed the relevant benchmark; simpler internals are acceptable only when behavior and quality are not inferior.

## Task 1 — Playback Engine Analysis

**Developer commit:** `a50cc3e519daf61695605c20f218fde3bcaca583`

**PM decision:** PASS / ACCEPTED.

## Task 2 — Media-Root Containment

**Developer commit:** `f185fcb1d6beb1243475f67a2a5a41e9098cf672`

**PM decision:** PASS / ACCEPTED.

**Key validation:** Centralized media-root containment, traversal/prefix-collision protection, realpath escape checks, and focused route/cache regressions were preserved.

## Task 3 — Direct-Play HTTP Range Hardening

**Initial developer commit:** `1c3d51c7d0e22037cb976bedaeb2bd5744ecb9f7`

**Initial PM decision:** REWORK.

**Rework commit:** `2c00656e341ec857ed6867ba9effc379f31b8848`

**Issue corrected:** `bytes=0-99,` could be incorrectly reduced to a valid single range. The corrected implementation safely treats comma-containing/list-shaped Range input as full-file fallback and retains correct 206/416 behavior.

**PM decision after rework:** PASS / ACCEPTED.

## Task 4 — Structured Media Capability Probe Model

**Authoritative PM commit:** `f5049fd97f564658bcd3f26f684e967a803e9424`.

**PM validation:** PASS. Normalized multi-stream media probing, numeric normalization, frame-rate parsing, language/subtitle handling, and stable probe failures were independently inspected. Existing `probeFile()` / `checkPlayability()` and prior playback hardening were preserved.

**Developer test evidence:** 89 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled.

**PM decision:** PASS / ACCEPTED.

## Task 5 — Client Capability Model

**Authoritative PM commit:** `e808c1430e46dd4fd3cfadc12d7a97cc70f95eef`.

**PM validation:** PASS. Tri-state capability normalization, aliases/conflicts, conservative unknown handling, browser detection hooks, resolution ceiling, warnings, and frozen output were inspected. No premature decision or execution logic was introduced.

**Developer test evidence:** 114 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled.

**PM decision:** PASS / ACCEPTED.

## Task 6 — Capability-Based Playback Decision Engine

**Authoritative PM commit:** `4f1b3aa5a3cece3f57c788aa2f2a56b9856d7aa3`.

**PM validation:** PASS. The pure decision engine evaluates Direct Play → Remux → Audio Transcode → Video Transcode, remains conservative for unknown capabilities, and returns structured feasibility/blocker/target data without HTTP/FFmpeg/database dependencies.

**Developer test evidence:** 138 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled.

**PM decision:** PASS / ACCEPTED.

## Task 7 — Playback Decision Integration Boundary

**Authoritative PM commit:** `3adb16664412731a525de4d426379901904c9feb`.

**PM validation:** PASS. The integration layer orchestrates probing/capability intake/decision; `/video` receives only advisory playback headers and retains the hardened serving path. Containment and Range/416 behavior remain intact.

**Developer test evidence:** 158 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled.

**PM decision:** PASS / ACCEPTED.

## Task 8 — Direct Play Execution Integration

**Authoritative PM commit:** `28e90e5fb3250838c1c59847a12fb8cdfcf7ce6e`.

**Scope validation:** PASS. The implementation connects the Task 6 `DIRECT_PLAY` result to the existing Task 3 `serveDirectPlay()` path. Full ffprobe confirmation is required where the library row indicates `needs_transcode=1`; failed confirmation cannot direct-play. Bounded decision caching and playback headers were added without changing the lower-level Range implementation.

**Code validation:** PASS. PM independently inspected the authoritative `server.js`, playback integration, and related tests. Non-direct modes do not bypass the intended fallback hierarchy. Task 2 containment and Task 3 206/416 behavior remain preserved.

**Test validation:** PASS based on developer-reported 181 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. Task 8 added 23 tests.

**PM decision:** PASS / ACCEPTED.

**Merge decision:** PENDING until final D1 workstream review.

## Task 9 — Remux Execution Integration

**Initial authoritative commit:** `8cdf917186ddac8117a27e0ca3add943d4216457`.

**Rework authoritative commit:** `92c504a5fbeeddab582cf29a6cabc94fd4400639`.

**Scope validation:** PASS. Remux execution was added through a dedicated job manager and cache without redesigning the decision engine or server architecture.

**Code validation:** PASS after rework. FFmpeg is invoked through argument arrays without a shell; video/audio are stream-copied; output is written atomically through `.tmp` and rename; the completed output is served through the hardened Range path; cache identity includes full `mtimeMs` precision and target container. Concurrent identical requests are de-duplicated.

**PM feedback/rework:** PM identified whole-second `mtimeMs` truncation as a stale-cache risk for rapid same-size source edits. D1 corrected the key to use full `mtimeMs` precision and added sub-second/same-size rewrite coverage.

**Developer test evidence after rework:** 205 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**Deferred issue:** PM observed a waiter/abort lifecycle weakness in `remux.js` analogous to the issue later fixed in Audio Transcode. It was explicitly deferred to Task 11 rather than expanding Task 9's rework scope.

**PM decision:** PASS / ACCEPTED.

**Merge decision:** PENDING until final D1 workstream review.

## Task 10 — Audio Transcode Execution Integration

**Initial authoritative commit:** `8f6832d6c6a389cc6205f318b0ab03cb7ff2e200`.

**Rework authoritative commit:** `b83cfcaf4e5d7df379508516f439248e1e2ca9d4`.

**Scope validation:** PASS. Audio-only transcode execution was added below Remux and above Video Transcode, with separate cache/output handling and no change to Task 6 decision authority.

**Code validation:** PASS after rework. Task 6 target/container and audio codec values are passed through directly; video remains copyable; FFmpeg uses safe argv; output completion is atomic; cache identity retains full `mtimeMs`; completed output uses the hardened serving path.

**PM feedback/rework:** PM identified phantom waiters after timeout and an abort-before-process-registration race. D1 added guarded release, zero-waiter cancellation, kill-on-registration, and prompt abort handling. Rework was limited to `audio-transcode.js` and its focused tests.

**Developer test evidence after rework:** 236 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0.

**PM decision:** PASS / ACCEPTED.

**Deferred issue:** The analogous Remux waiter lifecycle weakness was intentionally scheduled for Task 11.

**Merge decision:** PENDING until final D1 workstream review.

## Task 11 — Remux Job Lifecycle Hardening

**Developer implementation commit:** `43481022dfb923a32c27e903af2eb84e04bacda4` on `baseflicks/feature/playback`.

**Authoritative PM commit inspected:** `3fe68dc0ab3cf1a75c7dc57be934931e60dd0a69` on `claude_baseflicks/feature/playback`.

**Parent:** `b83cfcaf4e5d7df379508516f439248e1e2ca9d4` (Task 10 rework).

**Scope validation:** PASS. GitHub commit metadata shows exactly two modified files: `remux.js` and `test/remux-execution.test.js`. The production diff is confined to `ensureRemux()` waiter lifecycle handling. Cache identity, Remux directory, target resolution, atomic output design, and exports are unchanged. No Audio Transcode, server, decision engine, scanner, DB, metadata, UI, auth, dependency, Task 2, or Task 3 changes were introduced.

**Code validation:** PASS. PM independently inspected the actual `remux.js` at the authoritative commit. Each request increments `entry.waiters` once. A per-request guarded `release()` prevents double decrement when both abort and `finally` paths execute. Timeout and normal completion release through `finally`; abort releases immediately. When the last waiter leaves, the job is marked cancelled and a live FFmpeg process is killed; if FFmpeg has not registered yet, `onProcessStart` calls `killIfDoomed()` so the process is killed immediately upon registration. Aborted requests participate directly in `Promise.race`, providing prompt cancellation. Shared jobs remain shared while at least one waiter remains. The job's existing `finally` removes the in-flight entry after completion/failure.

**Race validation:** PASS. The inspected implementation closes the abort-before-`onProcessStart` race and avoids phantom waiters after timeout. It also preserves the important two-waiter behavior: one aborting waiter does not kill a job needed by the remaining waiter.

**Test validation:** Developer reported 243 total tests, all passing: 243 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. PM inspected the actual Task 11 test additions and confirmed focused lifecycle coverage for pre-registration abort, all-waiters abort, partial waiter abort, timeout release, timeout-final cancellation, prompt abort, successful completion/reuse, and failed-job cleanup/fresh retry, alongside retained Range, containment, hierarchy, cache, and real-FFmpeg regressions.

**CI validation:** No GitHub Actions/status check is attached to the feature branch. Local `npm test` is the recorded execution evidence.

**Known limitations:** A lone timeout now cancels the Remux instead of leaving it running to warm the cache. The in-flight registry is process-local and no cache size/age eviction was introduced. These are unchanged or explicitly accepted Task 11 behavior, not blockers.

**Benchmark validation:** PASS for lifecycle reliability. The Remux execution layer now has the same waiter lifecycle correctness standard established for Audio Transcode while retaining the lightweight in-process architecture.

**PM decision:** **PASS / ACCEPTED.** No rework required.

**Merge decision:** **PENDING.** `main` remains untouched. PM will perform the final full-workstream review and controlled merge only after the remaining D1 playback tasks are completed.

## PM Merge Policy

Developers do not merge playback branches into `main` themselves. PM validates each task on `feature/playback` and records the result here. **No individual D1 task is merged to `main`.** After all D1 tasks are completed, PM performs a final full-workstream review, reconciles branch divergence, and then performs the controlled merge to `main` if the complete D1 implementation passes.
