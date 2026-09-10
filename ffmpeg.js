const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");


/*
    Pull the most recent "time=HH:MM:SS.ms" progress marker out of
    a chunk of ffmpeg's stderr output and convert it to seconds.
    ffmpeg prints one of these periodically while encoding --
    combined with a video's already-known total duration (from
    probeFile), this is how real conversion progress percentages
    get computed. Returns null if this chunk didn't contain one
    (that's normal -- ffmpeg doesn't print progress on every
    single stderr write).
*/
function parseProgressTimeSeconds(chunkText) {

    const matches =
        [...chunkText.matchAll(
            /time=(\d+):(\d+):(\d+\.\d+)/g
        )];

    if (matches.length === 0) {

        return null;

    }

    const [, hours, minutes, seconds] =
        matches[matches.length - 1];

    return (
        parseInt(hours, 10) * 3600 +
        parseInt(minutes, 10) * 60 +
        parseFloat(seconds)
    );

}


/*
    Given a video's relative_path (as stored in the videos table,
    e.g. "Movies/Some Long Torrent Name.mkv"), return the relative
    path its converted copy should live at inside TRANSCODED_FOLDER
    -- same subfolder structure, same descriptive name, just a
    .mp4 extension instead of the original's (the output of a
    conversion is always .mp4). Used both when WRITING a converted
    file (scanner.js) and when LOOKING ONE UP (server.js) -- both
    call this so they can never drift out of agreement with each
    other.
*/
function getTranscodedRelativePath(relativePath) {

    const parsed =
        path.parse(relativePath);

    return path.join(
        parsed.dir,
        parsed.name + ".mp4"
    );

}


// ============================================================
// BROWSER-COMPATIBLE CODEC WHITELIST
// If a file's video AND audio codecs are both in this list,
// the browser can play the raw bytes directly (what server.js's
// /video/:filename route already does) -- no transcoding needed.
// Anything else needs to be transcoded first.
// ============================================================

const DIRECT_PLAY_VIDEO_CODECS = [
    "h264",
    "vp8",
    "vp9"
];

const DIRECT_PLAY_AUDIO_CODECS = [
    "aac",
    "mp3",
    "opus",
    "vorbis"
];


/*
    Run ffprobe on a file and return its technical details:
    duration, resolution, and video/audio codec names.

    Returns null if the file can't be read/probed at all
    (corrupt file, not actually a media file, etc).
*/
function probeFile(filePath) {

    return new Promise((resolve, reject) => {

        execFile(
            "ffprobe",
            [
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                filePath
            ],
            {
                // ffprobe's JSON output can be large for files
                // with many streams/chapters -- 10MB is generous.
                maxBuffer: 10 * 1024 * 1024
            },
            (error, stdout) => {

                if (error) {

                    console.error(
                        `ffprobe failed for ${filePath}:`,
                        error.message
                    );

                    return resolve(null);

                }


                let parsed;

                try {

                    parsed = JSON.parse(stdout);

                }

                catch (parseError) {

                    console.error(
                        `Could not parse ffprobe output for ${filePath}:`,
                        parseError.message
                    );

                    return resolve(null);

                }


                const videoStream =
                    (parsed.streams || []).find(
                        stream => stream.codec_type === "video"
                    );

                const audioStream =
                    (parsed.streams || []).find(
                        stream => stream.codec_type === "audio"
                    );


                resolve({

                    formatName:
                        parsed.format
                            ? parsed.format.format_name
                            : null,

                    duration:
                        parsed.format && parsed.format.duration
                            ? parseFloat(parsed.format.duration)
                            : null,

                    size:
                        parsed.format && parsed.format.size
                            ? parseInt(parsed.format.size, 10)
                            : null,

                    videoCodec:
                        videoStream
                            ? videoStream.codec_name
                            : null,

                    width:
                        videoStream
                            ? videoStream.width
                            : null,

                    height:
                        videoStream
                            ? videoStream.height
                            : null,

                    audioCodec:
                        audioStream
                            ? audioStream.codec_name
                            : null

                });

            }
        );

    });

}


/*
    Given a probeFile() result, decide whether the browser can
    play this file's raw bytes as-is, or whether it needs to be
    transcoded first. Also explains *why*, which is useful for
    logging/debugging during a library scan.
*/
function checkPlayability(probeResult) {

    if (!probeResult) {

        return {
            canDirectPlay: false,
            videoOk: false,
            audioOk: false,
            reason: "Could not read file (probe failed)"
        };

    }


    const videoOk =
        probeResult.videoCodec &&
        DIRECT_PLAY_VIDEO_CODECS.includes(
            probeResult.videoCodec
        );

    const audioOk =
        // A video with no audio track at all is fine --
        // only reject when an incompatible audio codec IS present.
        !probeResult.audioCodec ||
        DIRECT_PLAY_AUDIO_CODECS.includes(
            probeResult.audioCodec
        );


    if (videoOk && audioOk) {

        return {
            canDirectPlay: true,
            videoOk: true,
            audioOk: true,
            reason: "Video and audio codecs are browser-compatible"
        };

    }


    const problems = [];

    if (!videoOk) {

        problems.push(
            `video codec '${probeResult.videoCodec}' is not browser-compatible`
        );

    }

    if (!audioOk) {

        problems.push(
            `audio codec '${probeResult.audioCodec}' is not browser-compatible`
        );

    }


    return {
        canDirectPlay: false,
        videoOk,
        audioOk,
        reason: problems.join("; ")
    };

}


/*
    Transcode a file to a browser-compatible H.264/AAC file on
    disk, start to finish, before resolving. Unlike
    transcodeToMp4Stream, this isn't tied to any particular
    viewer's connection -- it's meant to be called once per video
    (with the caller deduplicating concurrent requests for the
    same file onto a single shared call, see server.js), producing
    a complete file that every future request can serve normally
    with full range-request/seeking support.

    Written to "<outputPath>.tmp" first and only renamed into
    place on a clean, complete finish, so a crashed/failed
    transcode never leaves a corrupt file behind for something
    else to serve as if it were done.

    options:
      - copyVideo / copyAudio / maxHeight: same meaning as
        transcodeToMp4Stream.
      - preset: x264 encoding speed/efficiency tradeoff (default
        "veryfast" -- fast but lower quality-per-bit, appropriate
        for an on-demand transcode someone is waiting on). Pass a
        slower preset ("slow", "medium") for a background
        conversion where quality matters more than turnaround
        time -- slower presets compress more efficiently at the
        same visual quality, or look better at the same file size.
      - crf: x264 quality target (0-51, LOWER is higher quality
        and bigger files; x264's own default is 23). Omit to use
        x264's default; pass something like 18 for a
        near-visually-lossless conversion when preserving quality
        matters more than file size.
      - audioBitrate: AAC bitrate when re-encoding audio (e.g.
        "192k", "256k"). Omit for ffmpeg's AAC default.
*/
function transcodeToMp4File(inputPath, outputPath, options) {

    options = options || {};

    return new Promise((resolve, reject) => {

        // outputPath may now include subfolders (mirroring the
        // source's own folder structure) -- make sure they exist
        // before ffmpeg tries to write there.
        fs.mkdirSync(
            path.dirname(outputPath),
            { recursive: true }
        );


        const videoArgs =
            options.copyVideo
                ? ["-c:v", "copy"]
                : [
                    "-c:v", "libx264",
                    "-preset", options.preset || "veryfast",
                    ...(options.crf != null
                        ? ["-crf", String(options.crf)]
                        : []),
                    ...(options.maxHeight
                        ? ["-vf", `scale=-2:min(${options.maxHeight}\\,ih)`]
                        : [])
                ];

        const audioArgs =
            options.copyAudio
                ? ["-c:a", "copy"]
                : [
                    "-c:a", "aac",
                    ...(options.audioBitrate
                        ? ["-b:a", options.audioBitrate]
                        : [])
                ];

        const tempPath =
            `${outputPath}.tmp`;


        const ffmpeg =
            spawn(
                "ffmpeg",
                [
                    "-i", inputPath,

                    ...videoArgs,
                    ...audioArgs,

                    // A normal (non-fragmented) MP4 with the moov
                    // atom moved to the front, since this is a
                    // complete file on disk, not a live pipe --
                    // faststart means a player can begin reading
                    // it without first jumping to the end of the
                    // file for metadata.
                    "-movflags", "+faststart",

                    "-f", "mp4",

                    "-y",

                    tempPath
                ]
            );


        let stderrOutput = "";

        ffmpeg.stderr.on("data", (chunk) => {

            const chunkText =
                chunk.toString();

            stderrOutput += chunkText;


            if (
                typeof options.onProgress === "function" &&
                options.durationSeconds
            ) {

                const elapsedSeconds =
                    parseProgressTimeSeconds(chunkText);

                if (elapsedSeconds != null) {

                    const percent =
                        Math.min(
                            100,
                            (elapsedSeconds / options.durationSeconds) * 100
                        );

                    options.onProgress(percent);

                }

            }

        });


        ffmpeg.on("error", (error) => {

            fs.unlink(tempPath, () => {});

            reject(error);

        });


        ffmpeg.on("close", (code, signal) => {

            if (code === 0 && !signal) {

                fs.rename(tempPath, outputPath, (renameError) => {

                    if (renameError) {

                        return reject(renameError);

                    }

                    resolve({});

                });

            }

            else {

                fs.unlink(tempPath, () => {});

                reject(
                    new Error(
                        `ffmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`
                    )
                );

            }

        });

    });

}


/*
    Transcode a file to a browser-compatible H.264/AAC stream and
    pipe the output directly into a writable stream (e.g. an
    Express response). Resolves once ffmpeg exits, rejects on
    error.

    options:
      - copyVideo: stream-copy the video track instead of
        re-encoding it (huge CPU savings) -- use this whenever the
        video codec is ALREADY browser-compatible and only audio
        is the problem (e.g. h264 video + AC3/DTS audio, common in
        .mkv rips). Re-encoding video you don't need to re-encode
        is pure waste.
      - copyAudio: same idea for audio, for the rarer case where
        only the video codec is incompatible.
      - maxHeight: if video IS being re-encoded (copyVideo=false)
        and the source is taller than this, scale down to it.
        4K software encoding is dramatically more expensive than
        1080p -- capping resolution is often the difference
        between real-time-ish playback and a stream that can't
        keep up with itself.
      - cacheFilePath: if given, ffmpeg's output is ALSO written
        to this path (at no extra encoding cost -- same process,
        same output, just teed to two destinations) so the next
        request for this file can be served as a normal complete
        file instead of live-transcoded all over again. Written
        to a temp file first and only renamed into place on a
        clean, complete finish -- a killed/failed transcode never
        leaves a corrupt file where a caller might serve it as if
        it were done.

    Resolves with { code, signal, cachedComplete }. cachedComplete
    is true only when cacheFilePath was given AND the transcode
    finished cleanly (not killed, not errored) -- callers should
    check this before treating the cache file as usable.

    Pass onProcessStart to receive the spawned child process the
    moment it starts, so the caller can kill it early (e.g. if
    the viewer closes the connection mid-stream) -- without this,
    closing a video early would leave ffmpeg running and burning
    CPU until the source file naturally ends.

    NOTE: without cacheFilePath, this streams a single fragmented
    MP4 output and does NOT support HTTP range/seek requests -- a
    viewer can't jump to an arbitrary timestamp mid-transcode the
    way direct play supports. Once a file IS cached, though, it's
    a normal complete file on disk and can be served exactly like
    any direct-play file, seeking included.
*/
function transcodeToMp4Stream(inputPath, outputStream, options, onProcessStart) {

    // Support the old 3-arg call shape (inputPath, outputStream,
    // onProcessStart) so existing callers don't break.
    if (typeof options === "function") {

        onProcessStart = options;
        options = {};

    }

    options = options || {};


    return new Promise((resolve, reject) => {

        const videoArgs =
            options.copyVideo
                ? ["-c:v", "copy"]
                : [
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    ...(options.maxHeight
                        ? ["-vf", `scale=-2:min(${options.maxHeight}\\,ih)`]
                        : [])
                ];

        const audioArgs =
            options.copyAudio
                ? ["-c:a", "copy"]
                : ["-c:a", "aac"];


        const ffmpeg =
            spawn(
                "ffmpeg",
                [
                    "-i", inputPath,

                    ...videoArgs,
                    ...audioArgs,

                    // Fragmented MP4 so the output can be streamed
                    // through a pipe instead of needing to be
                    // seekable on disk first.
                    "-movflags", "frag_keyframe+empty_moov",

                    "-f", "mp4",

                    // Write to stdout instead of a file.
                    "pipe:1"
                ]
            );


        if (typeof onProcessStart === "function") {

            onProcessStart(ffmpeg);

        }


        ffmpeg.stdout.pipe(outputStream);


        // Tee the same output to a temp cache file, if requested.
        // A random suffix avoids two simultaneous requests for the
        // same never-yet-cached file stomping on each other's temp
        // file -- whichever finishes first wins, harmlessly.
        let cacheTempPath = null;
        let cacheStream = null;

        if (options.cacheFilePath) {

            // cacheFilePath may now include subfolders (mirroring
            // the source's own folder structure).
            fs.mkdirSync(
                path.dirname(options.cacheFilePath),
                { recursive: true }
            );

            cacheTempPath =
                `${options.cacheFilePath}.${process.pid}.${Date.now()}.tmp`;

            cacheStream =
                fs.createWriteStream(cacheTempPath);

            ffmpeg.stdout.pipe(cacheStream);

        }


        let stderrOutput = "";

        ffmpeg.stderr.on("data", (chunk) => {

            // ffmpeg logs progress/info to stderr even on success;
            // only surface it if the process actually fails below.
            stderrOutput += chunk.toString();

        });


        ffmpeg.on("error", (error) => {

            if (cacheTempPath) {

                fs.unlink(cacheTempPath, () => {});

            }

            reject(error);

        });


        ffmpeg.on("close", (code, signal) => {

            const cleanFinish =
                code === 0 && !signal;


            const finalizeCacheAndResolve = () => {

                if (!cacheTempPath) {

                    return resolve({ code, signal, cachedComplete: false });

                }


                if (cleanFinish) {

                    fs.rename(cacheTempPath, options.cacheFilePath, (renameError) => {

                        if (renameError) {

                            console.error(
                                "Could not finalize transcode cache file:",
                                renameError.message
                            );

                            fs.unlink(cacheTempPath, () => {});

                            return resolve({ code, signal, cachedComplete: false });

                        }

                        resolve({ code, signal, cachedComplete: true });

                    });

                }

                else {

                    // Killed early or failed -- the cache file is
                    // incomplete/corrupt, never leave it around.
                    fs.unlink(cacheTempPath, () => {

                        resolve({ code, signal, cachedComplete: false });

                    });

                }

            };


            // A SIGKILL/SIGTERM here almost always means the
            // caller deliberately stopped this (e.g. the viewer
            // disconnected) -- that's not a real failure for the
            // purposes of the live stream, even though the cache
            // file (if any) still gets discarded above.
            if (code === 0 || signal) {

                finalizeCacheAndResolve();

            }

            else {

                if (cacheTempPath) {

                    fs.unlink(cacheTempPath, () => {});

                }

                reject(
                    new Error(
                        `ffmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`
                    )
                );

            }

        });

    });

}


/*
    Grab a single frame at the given timestamp (seconds) and save
    it as a JPEG. Used for auto-generating a thumbnail when TMDB
    doesn't have a poster for a file (or as the primary poster
    source if you'd rather not depend on TMDB at all).
*/
function generateThumbnail(inputPath, outputPath, timestampSeconds) {

    return new Promise((resolve, reject) => {

        const targetDir =
            path.dirname(outputPath);

        if (!fs.existsSync(targetDir)) {

            fs.mkdirSync(targetDir, { recursive: true });

        }


        execFile(
            "ffmpeg",
            [
                "-ss", String(timestampSeconds),
                "-i", inputPath,
                "-frames:v", "1",
                "-q:v", "3",
                "-y",
                outputPath
            ],
            (error, stdout, stderr) => {

                if (error) {

                    return reject(
                        new Error(
                            `Thumbnail generation failed: ${stderr || error.message}`
                        )
                    );

                }


                resolve(outputPath);

            }
        );

    });

}


module.exports = {
    probeFile,
    checkPlayability,
    transcodeToMp4Stream,
    transcodeToMp4File,
    generateThumbnail,
    getTranscodedRelativePath
};
