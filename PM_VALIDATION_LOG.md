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

**Developer commit:** PENDING

**Scope validation:** Pending developer completion.

**Code validation:** Pending.

**Test validation:** Pending. Must include focused range/MIME tests and exact `npm test` results.

**Regression validation:** Must preserve Task 2 media-root containment behavior.

**Benchmark validation:** Must meet reliable HTTP range-serving behavior expected of a competitive media server, including correct 206/416 semantics and MIME types.

**Issues:** None yet; task is in progress.

**PM decision:** PENDING

**Merge decision:** No merge until PM validation passes.

**Final merged commit:** PENDING

---

## PM Merge Policy

Developers do not merge playback branches into `main` themselves. After each completed task, PM validates the actual GitHub diff, tests, scope, regressions, and benchmark requirements. Only after PASS does PM perform the merge into `main`.
