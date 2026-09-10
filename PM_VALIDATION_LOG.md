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

**Initial developer commit:** `1c3d51c7d0e22037cb976bedaeb2bd5744ecb9f7`

**Initial PM decision:** REWORK — minor correction required before PASS.

**Initial issue:** `parseByteRange()` filtered empty comma-separated range specifications before counting them, so headers such as `bytes=0-99,` could collapse to one valid spec and incorrectly return 206. PM required safe 200 full-file fallback for list-shaped input.

### Task 3 Rework — List-shaped Range headers

**Developer rework commit:** `2c00656e341ec857ed6867ba9effc379f31b8848`

**Scope validation:** PASS. Actual commit changes only `server.js` `parseByteRange()` handling and `test/direct-play-range.test.js` coverage for the identified comma/list edge case. No scanner, database, UI, FFmpeg architecture, dependency, or unrelated playback redesign was introduced.

**Code validation:** PASS. The actual `feature/playback` `server.js` now checks for any comma in the Range value before splitting/parsing and returns `{ kind: "full" }`. This prevents trailing, leading, double-comma, or mixed-junk list-shaped headers from becoming a 206. Single valid ranges remain parsed normally. The actual test file verifies full status, length, absence of `Content-Range`, and complete body bytes for the malformed/list-shaped cases.

**Test validation:** PASS based on the developer's reported complete local suite: 66 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. The added integration coverage includes `bytes=0-99,200-299`, `bytes=0-99,`, `bytes=,0-99`, `bytes=0-99,,`, `bytes=0-99 ,`, and `bytes=0-99,abc`.

**Regression validation:** PASS. The corrected code preserves the required single-range behaviors (explicit, open-ended, suffix, oversized suffix, EOF clamping, and valid unsatisfiable ranges). Task 2 containment regressions remain covered. The rework does not modify `media-path.js` or the route containment logic.

**Benchmark validation:** PASS for the Task 3 scope. The implementation safely refuses to manufacture a 206 for a list-shaped header because Baseflicks intentionally serves at most one range and does not emit multipart/byteranges. This meets the agreed direct-play HTTP reliability baseline for this scope.

**CI validation:** No GitHub status checks are attached to the rework commit. This remains a repository/QA infrastructure limitation, not a Task 3 code failure. Local test evidence is recorded separately above.

**PM decision:** PASS / ACCEPTED.

**Merge decision:** Task 3 is now eligible for PM-controlled merge to `main`, subject to reconciling the current branch divergence before merging. Developers must not merge it themselves.

**Final merged commit:** PENDING PM merge.

---

## PM Merge Policy

Developers do not merge playback branches into `main` themselves. After each completed task, PM validates the actual GitHub diff, tests, scope, regressions, and benchmark requirements. Only after PASS does PM perform the merge into `main`.
