const express = require("express");
const fs = require("fs");
const path = require("path");

const db = require("./database");
const scanner = require("./scanner");

const app = express();

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

const PORT = 4000;

const VIDEO_FOLDER =
    path.join(__dirname, "videos");


// ============================================================
// VIDEO API
// ============================================================

app.get("/api/videos", (req, res) => {

    const videos = db.prepare(`
        SELECT
            id,
            name,
            relative_path,
            folder,
            size
        FROM videos
        ORDER BY added_at DESC
    `).all();

    res.json(videos);

});


// ============================================================
// VIDEO PLAYER PAGE
// ============================================================

app.get("/watch/:filename", (req, res) => {

    const filename =
        decodeURIComponent(
            req.params.filename
        );

    const videoPath =
        path.join(
            VIDEO_FOLDER,
            filename
        );


    if (!fs.existsSync(videoPath)) {

        return res
            .status(404)
            .send("Video not found");

    }


    res.send(`
        <!DOCTYPE html>

        <html>

        <head>

            <meta charset="UTF-8">

            <title>${filename}</title>

        </head>

        <body>

            <h1>${filename}</h1>

            <video
                controls
                autoplay
                style="
                    width: 90%;
                    max-width: 1200px;
                "
            >

                <source
                    src="/video/${encodeURIComponent(filename)}"
                >

                Your browser does not
                support video playback.

            </video>

        </body>

        </html>
    `);

});


// ============================================================
// VIDEO STREAM
// ============================================================

app.get("/video/:filename", (req, res) => {

    const filename =
        decodeURIComponent(
            req.params.filename
        );

    const videoPath =
        path.join(
            VIDEO_FOLDER,
            filename
        );


    if (!fs.existsSync(videoPath)) {

        return res
            .status(404)
            .send("Video not found");

    }


    const stat =
        fs.statSync(videoPath);

    const fileSize =
        stat.size;

    const range =
        req.headers.range;


    // --------------------------------------------------------
    // NORMAL VIDEO REQUEST
    // --------------------------------------------------------

    if (!range) {

        res.writeHead(200, {

            "Content-Length":
                fileSize,

            "Content-Type":
                "video/mp4"

        });

        fs.createReadStream(videoPath)
            .pipe(res);

        return;

    }


    // --------------------------------------------------------
    // VIDEO SEEKING / RANGE REQUEST
    // --------------------------------------------------------

    const parts =
        range
            .replace(/bytes=/, "")
            .split("-");


    const start =
        parseInt(
            parts[0],
            10
        );


    const end =
        parts[1]
            ? parseInt(parts[1], 10)
            : fileSize - 1;


    const chunkSize =
        (end - start) + 1;


    const file =
        fs.createReadStream(
            videoPath,
            {
                start,
                end
            }
        );


    res.writeHead(206, {

        "Content-Range":
            `bytes ${start}-${end}/${fileSize}`,

        "Accept-Ranges":
            "bytes",

        "Content-Length":
            chunkSize,

        "Content-Type":
            "video/mp4"

    });


    file.pipe(res);

});


// ============================================================
// SCAN VIDEO LIBRARY
// ============================================================

scanner.scanLibrary();


// ============================================================
// START BASEFLIX
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `🎬 Baseflix running on port ${PORT}`
        );

    }
);