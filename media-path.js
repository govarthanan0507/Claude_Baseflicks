"use strict";

const fs = require("fs");
const path = require("path");

/*
    ============================================================
    MEDIA-ROOT CONTAINMENT
    ============================================================

    server.js turns a URL segment (`/video/:filename`,
    `/watch/:filename`, and any future media-serving route) into a
    filesystem path by joining it onto a configured media root
    (VIDEO_FOLDER / TRANSCODED_FOLDER).

    That URL segment is fully attacker-controlled, and Express has
    already percent-decoded it by the time a handler sees it, so a
    request for

        /video/..%2F..%2Fsecret.txt

    arrives as the string "../../secret.txt". Joined naively onto the
    media root that is an arbitrary-file-read of anything the server
    process can open.

    This module is the ONE place that containment decision is made, so
    every route shares exactly one implementation. It is deliberately
    dependency-free (node:path + node:fs only).

    Benchmark: Jellyfin/Plex resolve the requested path and verify the
    real filesystem target is inside the configured library root before
    opening it. This does the same:

      1. Reject structurally-bad input (empty, non-string, NUL byte).
      2. Resolve "..", separators and absolute-path overrides, then
         require the result to be strictly below the root using
         relative-path semantics (NOT a string prefix test).
      3. If something actually exists at that path, canonicalise it
         with fs.realpathSync so a symlink / NTFS junction inside the
         root that points back out is caught by re-checking the REAL
         location.
*/


/*
    Textual containment: is `target` strictly below `root`?
    Both arguments must already be absolute and resolved.

    path.relative is used on purpose instead of `target.startsWith(root)`.
    A raw string-prefix test treats

        root   = F:\Baseflicks_Server\videos
        target = F:\Baseflicks_Server\videos_backup\secret.mkv

    as "inside" simply because the strings share a prefix. The relative
    path from root to that target is "..\videos_backup\secret.mkv",
    which correctly reports as an escape.
*/
function isStrictlyInside(root, target) {

    if (target === root) {
        // The media root directory itself is not a media file.
        return false;
    }

    const relative =
        path.relative(root, target);

    if (relative.length === 0) {
        return false;
    }

    // "../x" (POSIX) or "..\x" (Windows), or exactly ".." -> the
    // target sits at or above the root.
    if (
        relative === ".." ||
        relative.startsWith(".." + path.sep)
    ) {
        return false;
    }

    // A rooted result (a different Windows drive letter, or an
    // absolute POSIX path) means path.relative could not express the
    // target as a descendant of root at all.
    if (path.isAbsolute(relative)) {
        return false;
    }

    return true;
}


/*
    Resolve a user-supplied path against a trusted media root and
    return an absolute path GUARANTEED to sit inside that root -- or
    null if it does not (parent traversal, absolute path, prefix
    sibling, symlink/junction escape, or a malformed value).

      rootDir        trusted directory (VIDEO_FOLDER, TRANSCODED_FOLDER).
      requestedPath  untrusted, already URL-decoded (req.params.filename
                     or a value derived from it).

    Callers MUST treat null as an ordinary "not found" and must not
    reveal in the HTTP response that it was a containment rejection
    rather than a genuine miss.
*/
function resolveMediaFilePath(rootDir, requestedPath) {

    if (
        typeof requestedPath !== "string" ||
        requestedPath.length === 0
    ) {
        return null;
    }

    // A NUL byte truncates the path at the C layer inside libuv --
    // the classic "poison null byte" bypass (".../secret.txt\0.mkv").
    if (requestedPath.indexOf("\0") !== -1) {
        return null;
    }

    const root =
        path.resolve(rootDir);

    // path.resolve applies "..", normalises separators, and -- key
    // point -- discards `root` entirely when `requestedPath` is itself
    // absolute ("/etc/passwd", "C:\\Windows\\..."), so those land
    // outside `root` and are rejected by the check below.
    const resolved =
        path.resolve(root, requestedPath);

    if (!isStrictlyInside(root, resolved)) {
        return null;
    }

    // Textual containment holds. Now defend against a symlink / NTFS
    // junction INSIDE the media root that points back out. The only
    // way that leaks data is if the final target actually exists, and
    // in that case fs.realpathSync resolves every reparse point in the
    // whole chain, letting us re-check the real location.
    let realResolved;

    try {
        realResolved =
            fs.realpathSync(resolved);
    }
    catch (error) {

        if (error && error.code === "ENOENT") {
            // Nothing exists at this path yet, so there is nothing to
            // read and nothing to leak. Hand back the textually
            // contained path; the caller's own existence check turns
            // it into the normal 404.
            return resolved;
        }

        // EACCES / ELOOP / ENOTDIR / name-too-long / etc -- refuse.
        return null;
    }

    let realRoot;

    try {
        realRoot =
            fs.realpathSync(root);
    }
    catch (error) {
        realRoot = root;
    }

    if (!isStrictlyInside(realRoot, realResolved)) {
        return null;
    }

    return realResolved;
}


module.exports = {
    resolveMediaFilePath,
    isStrictlyInside
};
