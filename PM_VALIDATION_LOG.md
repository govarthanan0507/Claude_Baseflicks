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

**Merge decision:** Accepted as playback workstream baseline.

**Final merged commit:** Not separately recorded here.

## Task 2 — Media-Root Containment

**Developer commit:** `f185fcb1d6beb1243475f67a2a5a41e9098cf672`

**Scope validation:** Only playback path containment and focused regression tests were changed; no scanner/database/UI/FFmpeg redesign.

**Code validation:** `media-path.js` centralizes root containment, path normalization, realpath escape detection, prefix-collision protection, and safe handling of missing files. `/video` and `/watch` use the resolver; derived cache paths are also protected.

**Test validation:** Developer reported 28 passing tests, 0 failures, 0 skipped/todo/cancelled.

**Regression validation:** Focused tests cover legitimate nested paths, traversal, encoded traversal, absolute paths, prefix collision, junction escape, missing files, both routes, and a Range regression check.

**Benchmark validation:** Meets the required security/reliability baseline for media-root containment without changing the playback architecture.

**Issues / limitations:** TOCTOU replacement after realpath validation remains a separate hardening issue.

**PM decision:** PASS / ACCEPTED

**Merge decision:** Eligible for PM-controlled merge after normal branch/PR integration checks.

**Final merged commit:** Not separately recorded here.

## Task 3 — Direct-Play HTTP Range Hardening

**Developer commit:** `1c3d51c7d0e22037cb976bedaeb2bd5744ecb9f7`

**Scope validation:** PASS for intended scope. The implementation is limited to direct-play HTTP range/MIME handling, stream lifecycle/error handling, focused tests, and the sequential test-script adjustment. Task 2 containment code was preserved.

**Code validation:** Actual `server.js` implementation reviewed. `parseByteRange()` now distinguishes full, partial, and unsatisfiable ranges; supports explicit, open-ended, and suffix ranges; clamps valid ends to EOF; and produces 416 for valid unsatisfiable single ranges. `serveDirectPlay()` uses extension-aware MIME types, protects non-regular files, handles stream errors, and destroys streams when the response closes. The implementation avoids the previous invalid `createReadStream()` offsets and hard-coded `video/mp4` behavior.

**Test validation:** Actual `test/direct-play-range.test.js` was added with booted-server HTTP assertions covering range status, headers, response bytes, MIME mappings, uppercase extension handling, nested paths, and Task 2 containment regression. `package.json` sets `--test-concurrency=1` to avoid server-port races. However, PM could not verify an actual CI status for this commit because GitHub reported no attached status checks.

**Regression validation:** Task 2 containment implementation remains in use; no scanner/database/UI/FFmpeg redesign was introduced.

**Benchmark validation:** Core single-range HTTP behavior now meets the required reliability baseline for direct serving and is materially stronger than the previous implementation.

**Issues:** The parser filters empty comma-separated range specifications before counting them. Therefore a malformed header with a trailing comma such as `bytes=0-99,` can be interpreted as a valid single range and return 206 instead of the required safe full-file 200 fallback. Tests should explicitly cover trailing/empty comma specifications and other malformed comma forms.

**PM decision:** REWORK — minor correction required before PASS.

**Required correction:** Treat empty range specifications created by commas as malformed/multi-range input rather than silently filtering them. Add regression tests for `bytes=0-99,`, `bytes=,0-99`, and similar empty-spec comma forms, confirming safe 200 full-file fallback. Re-run the complete test suite and report exact pass/fail/skipped/todo/cancelled counts. No redesign or unrelated changes.

**Merge decision:** BLOCKED pending correction and PM re-validation. PM will not merge Task 3 to `main` until the actual corrected code and tests pass review.

**Final merged commit:** PENDING

---

## PM Merge Policy

Developers do not merge playback branches into `main` themselves. After each completed task, PM validates the actual GitHub diff, tests, scope, regressions, and benchmark requirements. Only after PASS does PM perform the merge into `main`.
