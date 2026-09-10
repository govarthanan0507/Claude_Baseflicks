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

**Developer commit:** `f5049fd97f564658bcd3f26f684e967a803e9424` on `claude_baseflicks/feature/playback` (equivalent implementation commit `d4089cba9efc30da6611ff6ec1066455ca73fd98` on `baseflicks/feature/playback`).

**Developer report:** D1 reported Task 4 complete with changes limited to `ffmpeg.js`, new `media-probe.js`, and new `test/media-probe.test.js`; no dependencies or unrelated subsystems changed. D1 reported 23 new fixture-driven tests and full suite result of 89 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled, exit code 0. D1 also reported manual real-media checks for MP4, MKV, and a missing file.

**Work:** Added an additive raw ffprobe boundary and a normalized media description layer. The normalized model captures container information and every video, audio, and subtitle stream; numeric fields are normalized to Number/null, frame-rate rationals are parsed, language tags have fallbacks, subtitle codecs receive coarse text/image classification, non-contiguous stream indexes are preserved, and audio-only media is valid with an empty video array. Filesystem/probe failures return stable `not_found` or `probe_failed` results.

**Scope preservation:** Existing `probeFile()` and `checkPlayability()` were preserved; no Direct Play/Remux/Transcode decision logic was added. `server.js`, `media-path.js`, scanner, database, UI, package dependencies, and metadata were not changed by Task 4.

**PM result:** PASS / ACCEPTED after independent inspection of the actual commit, `media-probe.js`, `ffmpeg.js`, and Task 4 tests. Task 2 and Task 3 behavior remains outside the Task 4 diff and is covered by the full reported suite.

**Merge:** PENDING. D1 remains on `feature/playback`; PM will merge only after all D1 tasks are completed and the final D1 review passes.

## Change Policy

For every subsequent playback task, append a new task section containing assignment, work performed, files changed, developer tests, commit SHA, status, developer report/rework history, and PM outcome. Never delete prior history.
