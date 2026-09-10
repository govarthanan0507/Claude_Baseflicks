// ============================================================
// ONE-TIME VOB SEGMENT FIX
//
// Trims a clip from START_TIME to the end of the source file,
// deinterlaces/denoises/sharpens it, and upscales to TARGET_HEIGHT
// as a clean H.264/AAC MP4.
//
// Run:  node fix-vob.js
// ============================================================

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIGURE THESE
// ============================================================

// Full path to the source file. Use forward slashes even on
// Windows (e.g. "C:/Users/you/Videos/BETROTHAL-1 (2).VOB").
const INPUT_PATH = "E:/VideoPlayer/videos/Family Events/Mom&Dad Betrothal/BETROTHAL-1  (2).VOB";

// Where to start the cut. Everything from here to the end of
// the file is kept and fixed. Format: HH:MM:SS
const START_TIME = "00:02:50";

// Output height in pixels. Width is computed automatically to
// keep the source aspect ratio. Source here is 352x288 (CIF),
// so 720 is a large upscale — it'll look clean and stable, not
// "sharper" than the source really has detail for. Drop this to
// 480 if you want less stretching / a slightly crisper look.
const TARGET_HEIGHT = 720;

// Set to false if the source is progressive (not interlaced) —
// e.g. if you already know this was a straight digital recording
// rather than something captured on a camcorder/DVD. Deinterlacing
// progressive footage is usually harmless, but it's here to turn off.
const DEINTERLACE = true;

// Leave as "ffmpeg"/"ffprobe" if they're on your PATH. Otherwise
// point these at the full .exe path.
const FFMPEG_PATH = "ffmpeg";
const FFPROBE_PATH = "ffprobe";

// ============================================================
// derived paths
// ============================================================

const parsedInput = path.parse(INPUT_PATH);
const OUTPUT_PATH = path.join(parsedInput.dir, `${parsedInput.name}.mp4`);
const TEMP_PATH = `${OUTPUT_PATH}.tmp`;

// ============================================================
// helpers
// ============================================================

function timeToSeconds(hhmmss) {
    const parts = hhmmss.split(":").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
        return null;
    }
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
}

function probeDurationSeconds(filePath) {
    return new Promise(resolve => {
        execFile(
            FFPROBE_PATH,
            ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
            { windowsHide: true },
            (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                try {
                    const data = JSON.parse(stdout);
                    const duration = Number(data.format?.duration);
                    resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
                } catch (_) {
                    resolve(null);
                }
            }
        );
    });
}

function secondsToTimeString(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = (totalSeconds % 60).toFixed(3);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.padStart(6, "0")}`;
}

function parseProgressTimeSeconds(stderrText) {
    const match = stderrText.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const [, h, m, s] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// ============================================================
// main
// ============================================================

async function main() {
    if (!fs.existsSync(INPUT_PATH)) {
        console.error(`❌ Input file not found: ${INPUT_PATH}`);
        console.error("   Edit INPUT_PATH at the top of this script.");
        process.exit(1);
    }

    const startSeconds = timeToSeconds(START_TIME);
    if (startSeconds === null) {
        console.error(`❌ START_TIME must be HH:MM:SS, got: ${START_TIME}`);
        process.exit(1);
    }

    const totalDuration = await probeDurationSeconds(INPUT_PATH);
    let clipDuration = null;

    if (totalDuration !== null) {
        clipDuration = totalDuration - startSeconds;
        if (clipDuration <= 0) {
            console.error(
                `❌ START_TIME (${START_TIME}) is at or past the end of the source ` +
                `(source is ${totalDuration.toFixed(1)}s long).`
            );
            process.exit(1);
        }
    } else {
        console.warn("⚠️  Could not read source duration — progress % won't be shown, but the fix will still run.");
    }

    if (fs.existsSync(TEMP_PATH)) {
        fs.unlinkSync(TEMP_PATH);
    }

    // ------------------------------------------------------------
    // hybrid seek: fast keyframe seek (before -i) to get close,
    // then a small precise seek (after -i) to land exactly on
    // START_TIME. This avoids running the full filter+encode
    // pipeline over the entire discarded prefix of the file.
    // ------------------------------------------------------------

    const FAST_SEEK_BUFFER_SECONDS = 5;
    const fastSeekSeconds = Math.max(0, startSeconds - FAST_SEEK_BUFFER_SECONDS);
    const preciseOffsetSeconds = startSeconds - fastSeekSeconds;
    const fastSeekTime = secondsToTimeString(fastSeekSeconds);
    const preciseOffsetTime = secondsToTimeString(preciseOffsetSeconds);

    // ------------------------------------------------------------
    // build filter chain
    // ------------------------------------------------------------

    const filters = [];

    if (DEINTERLACE) {
        filters.push("yadif=mode=send_frame:parity=auto:deint=all");
    }

    filters.push("hqdn3d=2:1.5:6:6");
    filters.push(`scale=-2:${TARGET_HEIGHT}:flags=lanczos`);
    filters.push("unsharp=5:5:0.5:5:5:0");
    filters.push("eq=contrast=1.02:brightness=0.01:saturation=1.02");

    // ------------------------------------------------------------
    // build ffmpeg args
    // ------------------------------------------------------------

    const args = [
        "-ss", fastSeekTime,        // fast input-side seek: jump close, cheap
        "-i", INPUT_PATH,
        "-ss", preciseOffsetTime,   // precise output-side seek: correct the last bit exactly
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-sn", "-dn",

        "-c:v", "libx264",
        "-preset", "veryslow",      // clip is short, so we can afford max quality
        "-crf", "16",
        "-pix_fmt", "yuv420p",
        "-vf", filters.join(","),

        "-c:a", "aac",
        "-ar", "48000",
        "-b:a", "256k",

        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        "-f", "mp4",
        "-y",
        TEMP_PATH
    ];

    console.log("");
    console.log("==============================================");
    console.log("🎬 FIXING VOB SEGMENT");
    console.log("==============================================");
    console.log(`Input:  ${INPUT_PATH}`);
    console.log(`Output: ${OUTPUT_PATH}`);
    console.log(`Range:  ${START_TIME} → end`);
    console.log(`Seek:   fast to ${fastSeekTime}, then precise +${preciseOffsetSeconds.toFixed(1)}s`);
    if (clipDuration !== null) {
        console.log(`Length: ${clipDuration.toFixed(1)}s`);
    }
    console.log(`Target: ${TARGET_HEIGHT}p`);
    console.log("==============================================");
    console.log("");

    const ffmpeg = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderrBuffer = "";

    ffmpeg.stderr.on("data", chunk => {
        const text = chunk.toString();
        stderrBuffer += text;
        if (stderrBuffer.length > 50000) {
            stderrBuffer = stderrBuffer.slice(-50000);
        }

        const currentSeconds = parseProgressTimeSeconds(text);
        if (currentSeconds !== null) {
            if (clipDuration && clipDuration > 0) {
                const percent = Math.min(100, Math.max(0, (currentSeconds / clipDuration) * 100));
                process.stdout.write(`\rProgress: ${percent.toFixed(1)}%   `);
            } else {
                process.stdout.write(`\rElapsed: ${currentSeconds.toFixed(1)}s   `);
            }
        }
    });

    ffmpeg.on("error", error => {
        console.error(`\n❌ Unable to start ffmpeg: ${error.message}`);
        try { if (fs.existsSync(TEMP_PATH)) fs.unlinkSync(TEMP_PATH); } catch (_) {}
        process.exit(1);
    });

    ffmpeg.on("close", code => {
        console.log("");

        if (code !== 0) {
            console.error(`❌ ffmpeg exited with code ${code}`);
            console.error(stderrBuffer);
            try { if (fs.existsSync(TEMP_PATH)) fs.unlinkSync(TEMP_PATH); } catch (_) {}
            process.exit(1);
        }

        if (!fs.existsSync(TEMP_PATH)) {
            console.error("❌ ffmpeg finished but no output file was created.");
            process.exit(1);
        }

        try {
            if (fs.existsSync(OUTPUT_PATH)) {
                fs.unlinkSync(OUTPUT_PATH);
            }
            fs.renameSync(TEMP_PATH, OUTPUT_PATH);
        } catch (error) {
            console.error(`❌ Failed to finalize output file: ${error.message}`);
            process.exit(1);
        }

        console.log("✅ DONE");
        console.log(`📁 ${OUTPUT_PATH}`);
        console.log("");
    });
}

main();