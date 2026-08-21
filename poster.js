const axios = require("axios");
const fs = require("fs");
const path = require("path");

const TMDB_API_KEY = "318100c07773c34fab6afdaefaa3d665";

const POSTER_DIR = path.join(__dirname, "posters");

// Create poster directory automatically
if (!fs.existsSync(POSTER_DIR)) {
    fs.mkdirSync(POSTER_DIR, { recursive: true });
}


/*
    Search TMDB and download poster
*/
async function fetchPoster(movieName) {

    try {

        console.log(`Searching TMDB: ${movieName}`);

        const searchResponse = await axios.get(
            "https://api.themoviedb.org/3/search/movie",
            {
                params: {
                    api_key: TMDB_API_KEY,
                    query: movieName
                }
            }
        );

        const results = searchResponse.data.results;

        if (!results || results.length === 0) {

            console.log(`Movie not found: ${movieName}`);

            return null;
        }


        const movie = results[0];


        if (!movie.poster_path) {

            console.log(
                `No poster found for: ${movie.title}`
            );

            return null;
        }


        // TMDB poster
        const posterURL =
            "https://image.tmdb.org/t/p/w500" +
            movie.poster_path;


        // Safe filename
        const safeName = movieName
            .replace(/[<>:"/\\|?*]/g, "_")
            .trim();


        const fileName =
            safeName + ".jpg";


        const filePath =
            path.join(
                POSTER_DIR,
                fileName
            );


        // Don't download again if already exists
        if (fs.existsSync(filePath)) {

            console.log(
                `Poster already exists: ${fileName}`
            );

            return {
                title: movie.title,
                year: movie.release_date
                    ? movie.release_date.substring(0, 4)
                    : null,

                tmdbId: movie.id,

                poster:
                    "/posters/" + fileName
            };
        }


        // Download poster
        const posterResponse =
            await axios.get(
                posterURL,
                {
                    responseType: "arraybuffer"
                }
            );


        fs.writeFileSync(
            filePath,
            posterResponse.data
        );


        console.log(
            `Poster saved: ${fileName}`
        );


        return {

            title: movie.title,

            year: movie.release_date
                ? movie.release_date.substring(0, 4)
                : null,

            tmdbId: movie.id,

            poster:
                "/posters/" + fileName
        };

    }

    catch (error) {

        console.error(
            "TMDB poster error:",
            error.response?.data ||
            error.message
        );

        return null;
    }
}


module.exports = {
    fetchPoster
};