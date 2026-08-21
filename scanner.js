const fs = require("fs");
const path = require("path");

const db = require("./database");

const VIDEO_FOLDER =
    path.join(__dirname, "videos");


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
    Synchronize the database
    with the actual video folder.
*/

function scanLibrary() {

    console.log("🔍 Scanning video library...");


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
            SELECT relative_path
            FROM videos
        `).all();


    const remove =
        db.prepare(`
            DELETE FROM videos
            WHERE relative_path = ?
        `);


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
                Remove stale database entries.
            */

            for (const row of existing) {

                if (
                    !currentPaths.includes(
                        row.relative_path
                    )
                ) {

                    remove.run(
                        row.relative_path
                    );

                }

            }

        });


    transaction();


    console.log(
        `🎬 Found ${videos.length} video(s)`
    );

}


module.exports = {
    scanLibrary
};