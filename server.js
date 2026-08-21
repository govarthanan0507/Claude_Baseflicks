const express = require("express");
const fs = require("fs");
const path = require("path");

const db = require("./database");
const scanner = require("./scanner");

const app = express();

app.use(express.json());

// ============================================================
// BASEFLIX WELCOME PAGE
// ============================================================

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "welcome.html"
        )
    );

});

// ============================================================
// PUBLIC FILES
// ============================================================

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


// ============================================================
// BASEFLIX WELCOME PAGE
// ============================================================

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "welcome.html"
        )
    );

});


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
// PROFILE API
// ============================================================


// ============================================================
// GET PROFILES
// ============================================================

app.get("/api/profiles", (req, res) => {

    try {

        const profiles =
            db.prepare(`
                SELECT
                    id,
                    name,
                    avatar,
                    created_at
                FROM profiles
                ORDER BY id ASC
            `).all();


        res.json(profiles);

    }

    catch (error) {

        console.error(
            "Could not load profiles:",
            error
        );

        res
            .status(500)
            .json({
                error: "Could not load profiles"
            });

    }

});


// ============================================================
// ADMIN AUTHENTICATION
// ============================================================

function checkAdmin(req, res, next) {

    const adminKey =
        process.env.BASEFLIX_ADMIN_KEY;


    if (!adminKey) {

        return res
            .status(500)
            .json({
                error:
                    "BASEFLIX_ADMIN_KEY is not configured"
            });

    }


    const suppliedKey =
        req.headers["x-admin-key"];


    if (
        !suppliedKey ||
        suppliedKey !== adminKey
    ) {

        return res
            .status(403)
            .json({
                error:
                    "Admin access required"
            });

    }


    next();

}


// ============================================================
// CREATE PROFILE
// ADMIN ONLY
// ============================================================

app.post(
    "/api/profiles",
    checkAdmin,
    (req, res) => {

        try {

            const {
                name,
                avatar
            } = req.body;


            if (
                !name ||
                !name.trim()
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Profile name is required"
                    });

            }


            const cleanName =
                name.trim();


            const cleanAvatar =
                avatar ||
                "🎬";


            const result =
                db.prepare(`
                    INSERT INTO profiles
                    (
                        name,
                        avatar
                    )

                    VALUES
                    (
                        ?,
                        ?
                    )
                `).run(
                    cleanName,
                    cleanAvatar
                );


            res.json({
                success: true,
                id: result.lastInsertRowid
            });

        }

        catch (error) {

            if (
                error.code ===
                "SQLITE_CONSTRAINT_UNIQUE"
            ) {

                return res
                    .status(409)
                    .json({
                        error:
                            "A profile with that name already exists"
                    });

            }


            console.error(
                "Could not create profile:",
                error
            );


            res
                .status(500)
                .json({
                    error:
                        "Could not create profile"
                });

        }

    }
);


// ============================================================
// DELETE PROFILE
// ADMIN ONLY
// ============================================================

app.delete(
    "/api/profiles/:id",
    checkAdmin,
    (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(id)
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Invalid profile ID"
                    });

            }


            const profile =
                db.prepare(`
                    SELECT
                        id,
                        name
                    FROM profiles
                    WHERE id = ?
                `).get(id);


            if (!profile) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Profile not found"
                    });

            }


            // Prevent deleting Admin.

            if (
                profile.name ===
                "Admin"
            ) {

                return res
                    .status(403)
                    .json({
                        error:
                            "The Admin profile cannot be deleted"
                    });

            }


            db.prepare(`
                DELETE FROM profiles
                WHERE id = ?
            `).run(id);


            res.json({
                success: true
            });

        }

        catch (error) {

            console.error(
                "Could not delete profile:",
                error
            );


            res
                .status(500)
                .json({
                    error:
                        "Could not delete profile"
                });

        }

    }
);




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