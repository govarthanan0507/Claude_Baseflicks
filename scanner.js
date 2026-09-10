const fs = require("fs");
const path = require("path");

const db = require("./database");
const ffmpeg = require("./ffmpeg");
const poster = require("./poster");

const VIDEO_FOLDER =
    path.join(__dirname, "videos");

const POSTER_FOLDER =
    path.join(__dirname, "posters");

const TRANSCODED_FOLDER =
    path.join(__dirname, "transcoded");


const VIDEO_EXTENSIONS = [

    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".webm",
    ".m4v"

];


/*
    Find every video inside a folder
    and all of its subfolders.
*/

function findVideos(folder) {

    let results = [];

    const items =
        fs.readdirSync(folder, {
            withFileTypes: true
        });


    for (const item of items) {

        const fullPath =
            path.join(folder, item.name);


        if (item.isDirectory()) {

            results =
                results.concat(
                    findVideos(fullPath)
                );

        }

        else {

            const extension =
                path.extname(item.name)
                    .toLowerCase();


            if (
                VIDEO_EXTENSIONS.includes(
                    extension
                )
            ) {

                results.push(fullPath);

            }

        }

    }


    return results;

}


/*
    Probe any video that hasn't been analyzed yet (video_codec
    is still NULL) and record its codecs/duration/dimensions,
    whether it needs transcoding to play in a browser, and a
    generated thumbnail to use as its poster.

    Runs after the fast synchronous file-sync pass above, since
    ffmpeg/ffprobe are real subprocesses and this can take a
    while for a large library.
*/

async function probeUnanalyzedVideos() {

    const rows =
        db.prepare(`
            SELECT id, relative_path, duration
            FROM videos
            WHERE video_codec IS NULL
        `).all();


    if (rows.length === 0) {

        return;

    }


    console.log(
        `🔬 Probing ${rows.length} new video(s)...`
    );


    if (!fs.existsSync(POSTER_FOLDER)) {

        fs.mkdirSync(POSTER_FOLDER, { recursive: true });

    }


    const updateInfo =
        db.prepare(`
            UPDATE videos
            SET
                video_codec = ?,
                audio_codec = ?,
                duration = ?,
                width = ?,
                height = ?,
                needs_transcode = ?
            WHERE id = ?
        `);


    const updatePoster =
        db.prepare(`
            UPDATE videos
            SET poster = ?
            WHERE id = ?
        `);


    for (const row of rows) {

        const fullPath =
            path.join(
                VIDEO_FOLDER,
                row.relative_path
            );


        // -----------------------------------------------------
        // PROBE CODEC / DURATION / DIMENSIONS
        // -----------------------------------------------------

        const probeResult =
            await ffmpeg.probeFile(fullPath);


        if (!probeResult) {

            // Unreadable/corrupt file -- skip it this run,
            // it'll be retried on the next scan.
            console.error(
                `Could not probe ${row.relative_path}, skipping`
            );

            continue;

        }


        const playability =
            ffmpeg.checkPlayability(probeResult);


        updateInfo.run(

            probeResult.videoCodec,

            probeResult.audioCodec,

            probeResult.duration,

            probeResult.width,

            probeResult.height,

            playability.canDirectPlay ? 0 : 1,

            row.id

        );


        if (!playability.canDirectPlay) {

            console.log(
                `⚠️  ${row.relative_path} needs transcoding: ${playability.reason}`
            );

        }


        // -----------------------------------------------------
        // GENERATE A THUMBNAIL TO USE AS THE POSTER
        // A little way into the video rather than frame 0, so it
        // doesn't just grab a black/logo splash screen. Capped at
        // 10s for short clips.
        // -----------------------------------------------------

        const thumbnailTimestamp =
            probeResult.duration
                ? Math.min(10, probeResult.duration / 3)
                : 1;

        const posterFilename =
            `${row.id}.jpg`;

        const posterPath =
            path.join(
                POSTER_FOLDER,
                posterFilename
            );


        try {

            await ffmpeg.generateThumbnail(
                fullPath,
                posterPath,
                thumbnailTimestamp
            );


            updatePoster.run(
                `/posters/${posterFilename}`,
                row.id
            );

        }

        catch (error) {

            console.error(
                `Could not generate thumbnail for ${row.relative_path}:`,
                error.message
            );

        }

    }


    console.log(
        `🔬 Finished probing ${rows.length} video(s)`
    );

}


/*
    Fully convert every video that's been flagged as needing a
    transcode into a permanent, high-quality copy in
    TRANSCODED_FOLDER -- preserving quality as closely as
    practical (slower encode preset, low CRF, decent audio
    bitrate) rather than the fast/lower-quality settings used for
    an on-demand live transcode someone is actively waiting on.

    Processed ONE AT A TIME, deliberately -- running several of
    these heavy conversions in parallel could easily overwhelm a
    modest server's CPU if a scan turns up multiple large files
    at once.

    original_status distinguishes "the scanner has already fully
    converted this and it's awaiting a keep/delete decision" (or
    later, a recorded decision) from "hasn't been handled yet" --
    so this never reconverts the same file on every scan, and
    doesn't care whether some lower-quality on-demand cache
    happens to already exist from someone playing it before the
    scanner got to it (that gets overwritten with the real
    high-quality version here).
*/

async function convertFlaggedVideos() {

    const rows =
        db.prepare(`
            SELECT id, relative_path
            FROM videos
            WHERE needs_transcode = 1
            AND original_status IS NULL
        `).all();


    if (rows.length === 0) {

        return;

    }


    console.log(
        `🎞️  ${rows.length} video(s) identified as needing conversion:`
    );

    if (!fs.existsSync(TRANSCODED_FOLDER)) {

        fs.mkdirSync(TRANSCODED_FOLDER, { recursive: true });

    }

    // A compatible copy may already exist for some of these --
    // e.g. someone played the file already, which caches a copy
    // on demand (see server.js), or a previous scan converted it
    // but crashed before marking the database row. Check for that
    // BEFORE queuing anything, both to report it and so the loop
    // below never wastefully re-converts something already done.
    const rowsNeedingConversion = [];

    for (const row of rows) {

        const cachePath =
            path.join(
                TRANSCODED_FOLDER,
                ffmpeg.getTranscodedRelativePath(row.relative_path)
            );

        if (fs.existsSync(cachePath)) {

            console.log(
                `    - ${row.relative_path} ` +
                `(alternative already available, skipping conversion)`
            );

        }

        else {

            console.log(
                `    - ${row.relative_path} (needs conversion)`
            );

            rowsNeedingConversion.push(row);

        }

    }


    // Anything that already had an alternative just needs its
    // status recorded, not a fresh conversion.
    const markPending =
        db.prepare(`
            UPDATE videos
            SET original_status = 'pending'
            WHERE id = ?
        `);

    for (const row of rows) {

        if (!rowsNeedingConversion.includes(row)) {

            markPending.run(row.id);

        }

    }


    if (rowsNeedingConversion.length === 0) {

        return;

    }


    console.log(
        `🎞️  Converting ${rowsNeedingConversion.length} video(s) ` +
        `one at a time (this can take a while for large files)...`
    );


    for (const row of rowsNeedingConversion) {

        const fullPath =
            path.join(
                VIDEO_FOLDER,
                row.relative_path
            );

        const outputPath =
            path.join(
                TRANSCODED_FOLDER,
                ffmpeg.getTranscodedRelativePath(row.relative_path)
            );


        // Re-check codecs (and duration, for progress %) fresh
        // rather than trusting a stale in-memory value, since this
        // can run a while after the probing pass above.
        const videoRow =
            db.prepare(`
                SELECT video_codec, audio_codec, duration
                FROM videos
                WHERE id = ?
            `).get(row.id);

        const playability =
            ffmpeg.checkPlayability({
                videoCodec: videoRow.video_codec,
                audioCodec: videoRow.audio_codec
            });


        try {

            console.log(
                `🎞️  Converting ${row.relative_path}...`
            );

            // These torrent-style filenames can be 100+ characters
            // -- long enough to wrap across multiple terminal rows,
            // which breaks \r-based single-line progress redraw
            // (it only rewinds to the start of the last wrapped
            // row, not the true start of the block, so old wrapped
            // lines get left behind instead of overwritten). Rather
            // than fight terminal-width edge cases, print progress
            // as plain, separate lines at 10% steps with a
            // shortened name -- works identically everywhere.
            const displayName =
                row.relative_path.length > 70
                    ? row.relative_path.slice(0, 67) + "..."
                    : row.relative_path;

            let lastPrintedStep = -1;

            await ffmpeg.transcodeToMp4File(
                fullPath,
                outputPath,
                {
                    copyVideo: playability.videoOk,
                    copyAudio: playability.audioOk,
                    // Quality over speed -- this is a one-time
                    // background job, not something a viewer is
                    // waiting on live.
                    preset: "medium",
                    crf: 18,
                    audioBitrate: "256k",
                    durationSeconds: videoRow.duration,
                    onProgress: (percent) => {

                        const step =
                            Math.floor(percent / 10) * 10;

                        if (step === lastPrintedStep) {

                            return;

                        }

                        lastPrintedStep = step;

                        console.log(
                            `    ${displayName}: ${step}%`
                        );

                    }
                }
            );

            markPending.run(row.id);

            console.log(
                `✅ Converted ${row.relative_path} -- ` +
                `original is now safe to review for deletion`
            );

        }

        catch (error) {

            console.error(
                `Could not convert ${row.relative_path}:`,
                error.message
            );

            // Leave original_status NULL so this gets retried on
            // the next scan instead of being silently abandoned.

        }

    }

}


/*
    One-time cleanup: earlier versions of this code named
    converted files after their numeric database id ("5.mp4")
    instead of mirroring the original's descriptive name and
    folder. Find any leftover files still using that old naming
    and rename them into the new scheme, so already-converted
    files don't get silently orphaned (and wastefully
    re-converted) just because the naming convention changed.
*/
function migrateOldTranscodedFilenames() {

    if (!fs.existsSync(TRANSCODED_FOLDER)) {

        return;

    }

    const entries =
        fs.readdirSync(TRANSCODED_FOLDER, { withFileTypes: true });

    for (const entry of entries) {

        if (!entry.isFile()) {

            continue;

        }

        const match =
            entry.name.match(/^(\d+)\.mp4$/);

        if (!match) {

            // Not an old-style "<id>.mp4" file -- nothing to do.
            continue;

        }

        const id =
            parseInt(match[1], 10);

        const row =
            db.prepare(`
                SELECT relative_path
                FROM videos
                WHERE id = ?
            `).get(id);

        if (!row) {

            // No matching video row anymore (deleted?) -- leave
            // the orphaned file alone rather than guessing.
            continue;

        }

        const oldPath =
            path.join(TRANSCODED_FOLDER, entry.name);

        const newRelative =
            ffmpeg.getTranscodedRelativePath(row.relative_path);

        const newPath =
            path.join(TRANSCODED_FOLDER, newRelative);

        if (fs.existsSync(newPath)) {

            // Already has a new-style file somehow -- don't
            // clobber it, just leave the old one alone.
            continue;

        }

        fs.mkdirSync(
            path.dirname(newPath),
            { recursive: true }
        );

        fs.renameSync(oldPath, newPath);

        console.log(
            `🔄 Renamed converted file to match its source: ` +
            `${entry.name} -> ${newRelative}`
        );

    }

}


/*
    Auto-populate metadata from TMDB during the scan (Jellyfin
    style) -- for every video not yet identified. Processes one
    at a time, sequentially, so it's gentle on a weak server and
    on TMDB's rate limits. Videos it can't match are simply left
    as-is; the user can identify those manually later. Skips
    entirely (no noise, no delay) when no API key is configured,
    since that's the common case for a fresh install before the
    user has set one up.
*/
async function autoPopulateMetadata() {

    // Cheap early-out: if there's no key, don't even query for
    // work -- just quietly do nothing.
    if (!poster.getStoredApiKey()) {

        return;

    }


    const rows =
        db.prepare(`
            SELECT id, name, custom_title, folder
            FROM videos
            WHERE custom_title IS NULL
            ORDER BY folder, name
        `).all();

    if (rows.length === 0) {

        return;

    }


    console.log(
        `🌐 Auto-populating metadata for ${rows.length} video(s) from TMDB...`
    );


    let succeeded = 0;
    let consecutiveFailures = 0;

    const MAX_CONSECUTIVE_FAILURES = 50;


    for (const row of rows) {

        try {

            const resolved =
                await poster.resolveVideoMetadata(row);

            if (resolved.error) {

                // No key mid-run (shouldn't happen given the
                // early-out, but be safe) -- stop, every remaining
                // one would fail identically.
                if (resolved.error === "no_api_key") {

                    break;

                }

                consecutiveFailures++;

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {

                    console.log(
                        `⚠️  Stopping auto-populate after ` +
                        `${MAX_CONSECUTIVE_FAILURES} failures in a row ` +
                        `(${resolved.error}). Remaining videos can be ` +
                        `identified manually.`
                    );

                    break;

                }

                continue;

            }

            writeVideoMetadata(row.id, row.folder, resolved.metadata);

            succeeded++;

            consecutiveFailures = 0;

        }

        catch (error) {

            console.error(
                "Auto-populate error for",
                row.name,
                error.message
            );

            consecutiveFailures++;

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {

                break;

            }

        }

        // Courtesy pause between requests -- same as the bulk job.
        await new Promise(resolve => setTimeout(resolve, 300));

    }


    console.log(
        `✅ Auto-populated ${succeeded} of ${rows.length} video(s)`
    );

}


// Persists resolved metadata -- episodes and movies store
// slightly different field sets. Mirrors writeMetadataToVideo in
// server.js (kept separate because scanner.js and server.js don't
// import each other).
function writeVideoMetadata(id, folder, metadata) {

    if (poster.isEpisodeFolder(folder)) {

        db.prepare(`
            UPDATE videos
            SET
                custom_title = ?,
                overview = ?,
                custom_date = ?,
                genres = ?,
                poster = COALESCE(?, poster)
            WHERE id = ?
        `).run(
            metadata.title,
            metadata.overview,
            metadata.date,
            metadata.genres,
            metadata.poster,
            id
        );

    }

    else {

        // metadata.imagesOk => the TMDB /images call came back and
        // its artwork set is authoritative, so write it straight
        // through (clearing unused slots). Otherwise COALESCE and
        // keep whatever's already stored. Mirrors writeMetadataToVideo
        // in server.js.
        const artworkAssign =
            metadata.imagesOk
                ? "backdrop = ?, landscape = ?, logo = ?"
                : "backdrop = COALESCE(?, backdrop), " +
                  "landscape = COALESCE(?, landscape), " +
                  "logo = COALESCE(?, logo)";

        db.prepare(`
            UPDATE videos
            SET
                custom_title = ?,
                overview = ?,
                release_year = ?,
                genres = ?,
                poster = COALESCE(?, poster),
                tagline = ?,
                studio = ?,
                director = ?,
                writers = ?,
                ${artworkAssign}
            WHERE id = ?
        `).run(
            metadata.title,
            metadata.overview,
            metadata.year,
            metadata.genres,
            metadata.poster,
            metadata.tagline,
            metadata.studio,
            metadata.director,
            metadata.writers,
            metadata.backdrop,
            metadata.landscape,
            metadata.logo,
            id
        );

    }

}


/*
    Remove the files a deleted video left behind -- its downloaded
    artwork (poster/backdrop/landscape/logo), its ffmpeg-generated
    thumbnail, and any transcoded copy -- so they don't accumulate
    as dead clutter after the source file is gone.

    Safety is the priority here, since this deletes files:
    - Artwork paths come straight from the row itself (the exact
      files that row referenced), converted from their public URL
      ("/posters/x.jpg") back to a real path under __dirname.
    - Every resolved path is verified to sit INSIDE one of our own
      managed folders (posters/backdrops/landscapes/logos/
      transcoded) before deletion -- a defense against a malformed
      or unexpected stored path ever pointing somewhere it
      shouldn't. Anything outside those folders is skipped.
    - Missing files are ignored; a failure on one file never stops
      the rest or the scan.
*/

const URL_PREFIX_TO_FOLDER = {
    "/posters/": POSTER_FOLDER,
    "/backdrops/": path.join(__dirname, "backdrops"),
    "/landscapes/": path.join(__dirname, "landscapes"),
    "/logos/": path.join(__dirname, "logos")
};

const MANAGED_FOLDERS = [
    POSTER_FOLDER,
    path.join(__dirname, "backdrops"),
    path.join(__dirname, "landscapes"),
    path.join(__dirname, "logos"),
    TRANSCODED_FOLDER
];


function isInsideManagedFolder(candidatePath) {

    const resolved =
        path.resolve(candidatePath);

    return MANAGED_FOLDERS.some((folder) => {

        const folderWithSep =
            path.resolve(folder) + path.sep;

        return (
            resolved.startsWith(folderWithSep)
        );

    });

}


function safeUnlink(filePath, label) {

    if (!filePath) {

        return false;

    }

    if (!isInsideManagedFolder(filePath)) {

        // Should never happen for our own stored paths -- but if a
        // path somehow points outside our managed folders, refuse
        // to touch it rather than risk deleting something else.
        console.warn(
            `⚠️  Skipping cleanup of ${label} -- resolved outside ` +
            `managed folders: ${filePath}`
        );

        return false;

    }

    try {

        if (fs.existsSync(filePath)) {

            fs.unlinkSync(filePath);

            return true;

        }

    }

    catch (error) {

        console.warn(
            `⚠️  Could not remove ${label} (${filePath}): ` +
            error.message
        );

    }

    return false;

}


// Turns a stored public artwork URL ("/posters/foo.jpg") into the
// real filesystem path it maps to, or null if it isn't one of our
// recognized artwork URLs.
function artworkUrlToPath(url) {

    if (!url) {

        return null;

    }

    for (const prefix of Object.keys(URL_PREFIX_TO_FOLDER)) {

        if (url.startsWith(prefix)) {

            return path.join(
                URL_PREFIX_TO_FOLDER[prefix],
                url.slice(prefix.length)
            );

        }

    }

    return null;

}


function cleanupOrphanedFiles(removedRows) {

    let filesRemoved = 0;

    for (const row of removedRows) {

        // Artwork -- exactly the files this row pointed at.
        for (const url of [row.poster, row.backdrop, row.landscape, row.logo]) {

            const filePath =
                artworkUrlToPath(url);

            if (safeUnlink(filePath, "artwork")) {

                filesRemoved++;

            }

        }

        // The scanner's own ffmpeg thumbnail is named "<id>.jpg"
        // and may be what poster pointed at, but delete it by its
        // deterministic name too in case poster was later
        // overwritten by a TMDB image (leaving the "<id>.jpg"
        // thumbnail behind as its own orphan).
        if (safeUnlink(path.join(POSTER_FOLDER, `${row.id}.jpg`), "thumbnail")) {

            filesRemoved++;

        }

        // Transcoded copy, at its derived path. Note: for a
        // video that was "moved" (converted copy promoted into
        // videos/ as the main file), there is no longer a file in
        // transcoded/ -- safeUnlink simply no-ops on the missing
        // path, which is correct.
        const transcodedPath =
            path.join(
                TRANSCODED_FOLDER,
                ffmpeg.getTranscodedRelativePath(row.relative_path)
            );

        if (safeUnlink(transcodedPath, "transcoded copy")) {

            filesRemoved++;

        }

        // NOTE: a "moved" video's archived original in
        // not_compatible_originals/ is intentionally left alone --
        // that's the user's own backup copy of their source file,
        // and removing it is their call to make manually.

    }

    console.log(
        `🧹 Cleaned up ${filesRemoved} orphaned file(s) from ` +
        `${removedRows.length} removed video(s)`
    );

}


/*
    Broader sweep: removes any file in the artwork + transcoded
    folders that NO current video row references. This catches
    leftovers the row-based cleanup can't -- most importantly
    artwork that was replaced during a video's life (e.g. a TMDB
    re-fetch), where the old file is no longer pointed at by any
    row but was never a "removed video" either.

    Deliberately does NOT touch not_compatible_originals/ -- an
    archived original is the user's only remaining copy of their
    source file, and its extension can't be reconstructed to match
    reliably, so a fuzzy "is this still referenced?" sweep there
    would be too dangerous. Archived originals are cleaned only by
    the precise row-based path above, when their video is removed.

    Runs every scan, but only ever deletes files inside our own
    managed folders (enforced by safeUnlink), and only when the
    database genuinely has video rows to build the keep-set from --
    if the videos table is empty (e.g. first run, or the earlier
    suspicious-scan guard tripped), it skips entirely rather than
    treating "no rows" as "delete everything".
*/
function sweepUnreferencedFiles() {

    const rows =
        db.prepare(`
            SELECT id, relative_path, poster, backdrop, landscape, logo
            FROM videos
        `).all();

    // Guard: never sweep against an empty video table. That would
    // mean "nothing is referenced -> delete all artwork", which is
    // exactly wrong in the drive-not-mounted / fresh-start cases.
    if (rows.length === 0) {

        return;

    }


    // Build the set of every filesystem path any row legitimately
    // references right now.
    const keep = new Set();

    for (const row of rows) {

        for (const url of [row.poster, row.backdrop, row.landscape, row.logo]) {

            const filePath =
                artworkUrlToPath(url);

            if (filePath) {

                keep.add(path.resolve(filePath));

            }

        }

        // The scanner's ffmpeg thumbnail, by deterministic name.
        keep.add(
            path.resolve(path.join(POSTER_FOLDER, `${row.id}.jpg`))
        );

        // The transcoded copy, by derived path (only exists for a
        // not-yet-moved conversion, but keep it referenced either
        // way so an in-progress/pending one is never swept).
        keep.add(
            path.resolve(
                path.join(
                    TRANSCODED_FOLDER,
                    ffmpeg.getTranscodedRelativePath(row.relative_path)
                )
            )
        );

    }


    let swept = 0;

    // Walk each managed folder (except the archive) and remove any
    // file not in the keep-set.
    const foldersToSweep = [
        POSTER_FOLDER,
        path.join(__dirname, "backdrops"),
        path.join(__dirname, "landscapes"),
        path.join(__dirname, "logos"),
        TRANSCODED_FOLDER
    ];

    function walkAndSweep(dir) {

        if (!fs.existsSync(dir)) {

            return;

        }

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {

            const fullPath =
                path.join(dir, entry.name);

            if (entry.isDirectory()) {

                walkAndSweep(fullPath);

                continue;

            }

            if (!keep.has(path.resolve(fullPath))) {

                if (safeUnlink(fullPath, "unreferenced file")) {

                    swept++;

                }

            }

        }

    }

    for (const folder of foldersToSweep) {

        walkAndSweep(folder);

    }


    if (swept > 0) {

        console.log(
            `🧹 Swept ${swept} unreferenced file(s) from artwork/` +
            `transcoded folders`
        );

    }

}


/*
    Synchronize the database
    with the actual video folder.
*/

async function scanLibrary() {

    console.log("🔍 Scanning video library...");


    migrateOldTranscodedFilenames();


    const videos =
        findVideos(VIDEO_FOLDER);


    /*
        Create a list of the files
        that actually exist.
    */

    const currentPaths =
        videos.map(videoPath =>
            path.relative(
                VIDEO_FOLDER,
                videoPath
            )
        );


    /*
        Add new videos.
    */

    const insert =
        db.prepare(`
            INSERT OR IGNORE INTO videos
            (name, relative_path, folder, size)

            VALUES
            (?, ?, ?, ?)
        `);


    /*
        Remove videos that no longer
        exist at their old location.
    */

    const existing =
        db.prepare(`
            SELECT
                id,
                relative_path,
                poster,
                backdrop,
                landscape,
                logo
            FROM videos
        `).all();


    // -----------------------------------------------------
    // SAFETY GUARD
    // If the scan found zero files but the database already
    // has entries, something is almost certainly wrong with
    // the scan itself (the videos/ drive or network share
    // isn't mounted yet, a permissions issue, etc) -- NOT that
    // your entire library was actually deleted. Treating this
    // as "everything is gone" would wipe every video row, and
    // because continue_watching cascades on video deletion,
    // it would silently wipe all watch history too. Skip the
    // cleanup pass entirely rather than risk that.
    // -----------------------------------------------------

    const scanLooksSuspicious =
        videos.length === 0 &&
        existing.length > 0;

    if (scanLooksSuspicious) {

        console.error(
            `⚠️  Scan found 0 video files, but the database has ` +
            `${existing.length} already. Skipping cleanup this run ` +
            `to avoid deleting your library/watch history -- is the ` +
            `videos folder/drive properly mounted?`
        );

    }


    const remove =
        db.prepare(`
            DELETE FROM videos
            WHERE relative_path = ?
        `);


    const removedRows = [];

    const transaction =
        db.transaction(() => {


            /*
                Add new / existing videos.
            */

            for (const videoPath of videos) {

                const relativePath =
                    path.relative(
                        VIDEO_FOLDER,
                        videoPath
                    );


                let folder =
                    path.dirname(
                        relativePath
                    );


                /*
                    If the video is directly
                    inside videos/, don't show "."
                */

                if (folder === ".") {

                    folder = "Home";

                }


                const stats =
                    fs.statSync(videoPath);


                insert.run(

                    path.basename(videoPath),

                    relativePath,

                    folder,

                    stats.size

                );

            }


            /*
                Remove stale database entries -- unless the scan
                itself looked suspicious (see guard above). Each
                removed row is collected first so its orphaned
                files can be cleaned up AFTER the transaction
                commits (filesystem deletes aren't transactional,
                so they must not run inside db.transaction).
            */

            if (!scanLooksSuspicious) {

                for (const row of existing) {

                    if (
                        !currentPaths.includes(
                            row.relative_path
                        )
                    ) {

                        removedRows.push(row);

                        remove.run(
                            row.relative_path
                        );

                    }

                }

            }

        });


    transaction();


    // Now that the rows are gone from the DB, remove the files
    // they left behind -- artwork, thumbnails, transcoded copies,
    // archived originals. Done outside the transaction on purpose.
    if (removedRows.length > 0) {

        cleanupOrphanedFiles(removedRows);

    }

    // Broader sweep for anything the row-based pass can't catch
    // (e.g. artwork replaced mid-life). Skipped automatically when
    // the scan looked suspicious, since sweeping against a
    // possibly-incomplete DB would be risky.
    if (!scanLooksSuspicious) {

        sweepUnreferencedFiles();

    }


    console.log(
        `🎬 Found ${videos.length} video(s)`
    );


    await probeUnanalyzedVideos();

    await autoPopulateMetadata();

    await convertFlaggedVideos();

}


module.exports = {
    scanLibrary,
    VIDEO_EXTENSIONS,
    TRANSCODED_FOLDER
};