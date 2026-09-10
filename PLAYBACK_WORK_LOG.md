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

**Status:** ASSIGNED / PENDING

**Assignment:** Harden direct file serving to provide reliable single-range HTTP behavior, correct 416 handling, safe multiple-range fallback, extension-based MIME types, stat-race protection, and focused automated tests while preserving Task 2 containment.

**Required range cases:** `bytes=0-99`, `bytes=1000-`, `bytes=-500`, end beyond EOF, suffix larger than file, unsatisfiable range, malformed/unsupported range, and multiple ranges.

**Required MIME cases:** `.mp4`, `.webm`, `.mov`, `.m4v`, `.mkv`, `.avi`, plus safe fallback.

**Restrictions:** No playback capability model, remux/transcoding redesign, cache redesign, scanner/database/UI changes, new dependencies, or server.js rewrite.

**Completion:** Developer must run `npm test`, commit, push, and report exact results. PM validates GitHub before accepting/merging.

---

## Change Policy

For every subsequent playback task, append a new task section containing assignment, work performed, files changed, developer tests, commit SHA, status, and PM outcome. Never delete prior history.
