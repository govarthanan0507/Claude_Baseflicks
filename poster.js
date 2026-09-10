const axios = require("axios");
const fs = require("fs");
const path = require("path");
const db = require("./database");

// The key is read fresh from the database on every call (not
// cached at module load) so a user pasting one in through the
// Settings screen works immediately -- no server restart needed.
// TMDB_API_KEY as an env var is a dev-only convenience for local
// testing; there is deliberately no hardcoded fallback -- every
// packaged install gets its own key via the guided setup screen,
// never a shared/borrowed one baked into the software.
function getTmdbApiKey() {

    const row =
        db.prepare(`
            SELECT value
            FROM settings
            WHERE key = 'tmdb_api_key'
        `).get();

    return (
        (row && row.value) ||
        process.env.TMDB_API_KEY ||
        null
    );

}

const POSTER_DIR = path.join(__dirname, "posters");
const BACKDROP_DIR = path.join(__dirname, "backdrops");
const LANDSCAPE_DIR = path.join(__dirname, "landscapes");
const LOGO_DIR = path.join(__dirname, "logos");

// Each artwork type gets its own dedicated folder, all siblings
// of videos/ -- never inside it, so the library folder only ever
// contains actual video files, not scattered image files.
for (const dir of [POSTER_DIR, BACKDROP_DIR, LANDSCAPE_DIR, LOGO_DIR]) {

    if (!fs.existsSync(dir)) {

        fs.mkdirSync(dir, { recursive: true });

    }

}


/*
    Search TMDB and download poster
*/
async function fetchPoster(movieName) {

    try {

        const apiKey =
            getTmdbApiKey();

        if (!apiKey) {

            console.log(
                "No TMDB API key configured -- skipping poster fetch."
            );

            return null;

        }


        console.log(`Searching TMDB: ${movieName}`);

        const searchResponse = await axios.get(
            "https://api.themoviedb.org/3/search/movie",
            {
                params: {
                    api_key: apiKey,
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


/*
    "Populate from web" -- fetches the basics (title, overview,
    year, genres, poster) for a single video from TMDB, on demand
    (triggered from the details page), not automatically during
    scanning.
*/

async function searchTmdb(apiKey, query, year) {

    const params = {
        api_key: apiKey,
        query: query
    };

    if (year) {

        params.primary_release_year = year;

    }

    const response =
        await axios.get(
            "https://api.themoviedb.org/3/search/movie",
            { params }
        );

    return response.data.results;

}


async function searchTmdbTv(apiKey, query, year) {

    const params = {
        api_key: apiKey,
        query: query
    };

    if (year) {

        params.first_air_date_year = year;

    }

    const response =
        await axios.get(
            "https://api.themoviedb.org/3/search/tv",
            { params }
        );

    return response.data.results;

}


// Pulls a "S01E02"-style season/episode pair out of a filename.
// Returns null if the filename doesn't look like an episode --
// callers use that to fall back to movie search instead.
/*
    Pull season/episode numbers straight out of a filename by
    matching the specific episode-marker patterns directly --
    rather than trying to "clean" the whole filename first. This
    is deliberately robust to release-group junk, resolution tags,
    etc., because it keys off the S##E## / #x## / EP## markers and
    ignores everything around them (the approach Jellyfin uses).

    folderSeason (optional) supplies the season when the filename
    itself only carries an episode number (the "EP02" case), e.g.
    parsed from a "Season 1" parent folder.
*/
function extractSeasonEpisode(name, folderSeason) {

    // Pattern 1: S01E02 / S1E2 / s01.e02 / S01 E02 / S01-E02
    const seasonEpisode =
        name.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/);

    if (seasonEpisode) {

        return {
            season: parseInt(seasonEpisode[1], 10),
            episode: parseInt(seasonEpisode[2], 10)
        };

    }

    // Pattern 2: 1x02 / 1-02 as a standalone token. Bounded by
    // non-digits on both sides so it doesn't grab part of a
    // longer number run (e.g. a "264x1" codec fragment): the
    // season part is limited to 1-2 digits and must not be
    // preceded by another digit.
    const crossFormat =
        name.match(/(?:^|[^\dA-Za-z])(\d{1,2})[x-](\d{1,3})(?:[^\d]|$)/);

    if (crossFormat) {

        return {
            season: parseInt(crossFormat[1], 10),
            episode: parseInt(crossFormat[2], 10)
        };

    }

    // Pattern 3: EP02 / E02 with no season in the filename -- only
    // usable if the folder told us the season.
    const episodeOnly =
        name.match(/[Ee][Pp]?[\s._-]*(\d{1,3})/);

    if (episodeOnly && folderSeason != null) {

        return {
            season: folderSeason,
            episode: parseInt(episodeOnly[1], 10)
        };

    }

    return null;

}

// Pull a season number out of a "Season 1" / "S01" style folder
// name, for the episode-only filename case above.
function extractSeasonFromFolder(folder) {

    const normalized =
        (folder || "").replace(/\\/g, "/");

    const lastSegment =
        normalized.split("/").pop() || "";

    const match =
        lastSegment.match(/(?:season|s)[\s._-]*(\d{1,2})/i);

    return match ? parseInt(match[1], 10) : null;

}


// A video whose folder is 3+ levels deep (e.g. "Shows/Breaking
// Bad/Season 1") is treated as an episode; anything shallower is
// a standalone movie. The show name is the folder's 2nd segment.
// Same signal used throughout the frontend (getSeriesGrouping in
// app.js) and previously duplicated in server.js.
function isEpisodeFolder(folder) {

    return (folder || "").replace(/\\/g, "/").split("/").length >= 3;

}

function getShowNameFromFolder(folder) {

    return (folder || "").replace(/\\/g, "/").split("/")[1];

}


/*
    The shared "identify this video from TMDB" logic -- branches
    between movie and episode lookups based on the folder, and
    returns EITHER { metadata } on success or { error, status }
    on failure. It deliberately does NOT write to the database --
    callers (the single-video endpoint, the bulk job, and the
    scanner's auto-populate phase) each own their own DB writes,
    since a couple of them differ slightly in what they persist.
*/
async function resolveVideoMetadata(row) {

    if (isEpisodeFolder(row.folder)) {

        const showName =
            getShowNameFromFolder(row.folder);

        const seasonEpisode =
            extractSeasonEpisode(
                row.name,
                extractSeasonFromFolder(row.folder)
            );

        if (!seasonEpisode) {

            return {
                status: 422,
                error:
                    `Could not find a season/episode number ` +
                    `(like "S01E02") in "${row.name}".`
            };

        }

        const showSearch =
            await searchTmdbShows(showName, null);

        if (showSearch.error === "no_api_key") {

            return { status: 400, error: "no_api_key" };

        }

        if (showSearch.error) {

            return { status: 502, error: showSearch.error };

        }

        if (!showSearch.results || showSearch.results.length === 0) {

            return {
                status: 404,
                error: `No TV show found on TMDB for "${showName}"`
            };

        }

        const metadata =
            await fetchFullEpisodeDetails(
                showSearch.results[0].tmdbId,
                seasonEpisode.season,
                seasonEpisode.episode,
                row.custom_title || row.name
            );

        return finishResolve(metadata, `S${seasonEpisode.season}E${seasonEpisode.episode} of "${showName}"`);

    }


    const searched =
        guessSearchQuery(row.custom_title || row.name);

    const metadata =
        await fetchMovieMetadata(searched.query, searched.year);

    return finishResolve(
        metadata,
        `"${searched.query}"` + (searched.year ? ` (${searched.year})` : "")
    );

}


function finishResolve(metadata, notFoundLabel) {

    if (metadata && metadata.error === "no_api_key") {

        return { status: 400, error: "no_api_key" };

    }

    if (metadata && metadata.error) {

        return { status: 502, error: metadata.error };

    }

    if (!metadata) {

        return {
            status: 404,
            error: `No match found on TMDB for ${notFoundLabel}`
        };

    }

    return { metadata };

}


async function fetchExtraMovieDetails(apiKey, movieId) {

    try {

        const [detailsResponse, creditsResponse] =
            await Promise.all([
                axios.get(
                    `https://api.themoviedb.org/3/movie/${movieId}`,
                    { params: { api_key: apiKey } }
                ),
                axios.get(
                    `https://api.themoviedb.org/3/movie/${movieId}/credits`,
                    { params: { api_key: apiKey } }
                )
            ]);

        const tagline =
            detailsResponse.data.tagline || null;

        const studio =
            (detailsResponse.data.production_companies || [])
                .map(company => company.name)
                .join(", ") || null;

        const crew =
            creditsResponse.data.crew || [];

        const directorNames =
            [...new Set(
                crew
                    .filter(person => person.job === "Director")
                    .map(person => person.name)
            )];

        const writerJobs =
            ["Screenplay", "Writer", "Story", "Novel"];

        const writerNames =
            [...new Set(
                crew
                    .filter(person => writerJobs.includes(person.job))
                    .map(person => person.name)
            )];

        return {
            tagline: tagline,
            studio: studio,
            director: directorNames.join(", ") || null,
            writers: writerNames.join(", ") || null
        };

    }

    catch (error) {

        // Not fatal -- the caller already has the basics from
        // search. Just proceed without the extra details rather
        // than failing the whole fetch over a secondary call.
        console.error(
            "TMDB extra details error:",
            error.response?.data || error.message
        );

        return {
            tagline: null,
            studio: null,
            director: null,
            writers: null
        };

    }

}


async function downloadTmdbImage(imagePath, size, destDir, fileName) {

    const filePath =
        path.join(destDir, fileName);

    if (fs.existsSync(filePath)) {

        return filePath;

    }

    const imageURL =
        `https://image.tmdb.org/t/p/${size}${imagePath}`;

    const response =
        await axios.get(
            imageURL,
            { responseType: "arraybuffer" }
        );

    fs.writeFileSync(filePath, response.data);

    return filePath;

}


// Order backdrops so the ones without text baked in come first,
// then English-text ones, then everything else -- and within each
// group, highest-voted first. TMDB's /images list is otherwise a
// mix of every language (that's how a Portuguese "CENTRAL DE
// INTELIGÊNCIA" title card ends up as backdrops[0]).
function rankBackdrops(backdrops) {

    const languageRank = language => {

        if (language === null) return 0;
        if (language === "en") return 1;
        return 2;

    };

    return [...backdrops].sort((a, b) => {

        const byLanguage =
            languageRank(a.iso_639_1) - languageRank(b.iso_639_1);

        if (byLanguage !== 0) return byLanguage;

        return (b.vote_average || 0) - (a.vote_average || 0);

    });

}


async function fetchMovieImages(apiKey, movieId, safeName) {

    const result = {
        backdrop: null,
        landscape: null,
        logo: null
    };

    try {

        const response =
            await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}/images`,
                {
                    params: {
                        api_key: apiKey,
                        // Pull the textless originals plus any
                        // English ones; skip every other language.
                        include_image_language: "en,null"
                    }
                }
            );

        const backdrops =
            rankBackdrops(response.data.backdrops || []);

        const logos =
            response.data.logos || [];


        if (backdrops[0]) {

            await downloadTmdbImage(
                backdrops[0].file_path,
                "w1280",
                BACKDROP_DIR,
                `${safeName}-${movieId}-backdrop.jpg`
            );

            result.backdrop =
                `/backdrops/${safeName}-${movieId}-backdrop.jpg`;

        }

        // A second, genuinely different backdrop image for
        // "landscape" rather than duplicating the first one.
        if (backdrops[1]) {

            await downloadTmdbImage(
                backdrops[1].file_path,
                "w1280",
                LANDSCAPE_DIR,
                `${safeName}-${movieId}-landscape.jpg`
            );

            result.landscape =
                `/landscapes/${safeName}-${movieId}-landscape.jpg`;

        }

        // Prefer a language-neutral (no text baked in) PNG logo.
        const bestLogo =
            logos.find(logo => logo.iso_639_1 === null) ||
            logos[0];

        if (bestLogo) {

            const ext =
                bestLogo.file_path.endsWith(".svg")
                    ? "svg"
                    : "png";

            await downloadTmdbImage(
                bestLogo.file_path,
                "w500",
                LOGO_DIR,
                `${safeName}-${movieId}-logo.${ext}`
            );

            result.logo =
                `/logos/${safeName}-${movieId}-logo.${ext}`;

        }

    }

    catch (error) {

        // Same principle as fetchExtraMovieDetails -- a failed
        // images call shouldn't sink the whole fetch when the
        // basics + poster already succeeded.
        console.error(
            "TMDB images error:",
            error.response?.data || error.message
        );

    }

    return result;

}


/*
    Pure search -- returns a list of candidate matches (no
    downloads, no DB writes) for the person to choose from, the
    same way Jellyfin's manual "Identify" search works. Used both
    by the quick auto-populate path (which just takes the first
    result) and by the manual search UI (which shows the whole
    list).
*/
function classifyTmdbError(error, context) {

    const status =
        error.response?.status;

    console.error(
        `TMDB ${context} error:`,
        error.response?.data || error.message
    );

    if (status === 401) {

        return {
            error:
                "TMDB rejected the saved API key. Check it in " +
                "Settings and re-save it if needed."
        };

    }

    if (status === 429) {

        return {
            error:
                "TMDB is rate-limiting these requests right now -- " +
                "wait a moment and try again."
        };

    }

    return {
        error:
            "Could not reach TMDB. Check your internet " +
            "connection and try again."
    };

}


async function searchTmdbMovies(searchQuery, year) {

    const apiKey =
        getTmdbApiKey();

    if (!apiKey) {

        return { error: "no_api_key" };

    }


    try {

        console.log(
            `Searching TMDB: ${searchQuery}` +
            (year ? ` (${year})` : "")
        );

        let results =
            await searchTmdb(apiKey, searchQuery, year);

        if ((!results || results.length === 0) && year) {

            console.log(
                `No match with year ${year} -- retrying without it`
            );

            results =
                await searchTmdb(apiKey, searchQuery, null);

        }

        return {
            results: (results || []).slice(0, 8).map(movie => ({
                tmdbId: movie.id,
                title: movie.title,
                year: movie.release_date
                    ? movie.release_date.substring(0, 4)
                    : null,
                overview: movie.overview || null,
                posterThumb: movie.poster_path
                    ? `https://image.tmdb.org/t/p/w154${movie.poster_path}`
                    : null
            }))
        };

    }

    catch (error) {

        return classifyTmdbError(error, "search");

    }

}


async function searchTmdbShows(searchQuery, year) {

    const apiKey =
        getTmdbApiKey();

    if (!apiKey) {

        return { error: "no_api_key" };

    }


    try {

        console.log(
            `Searching TMDB TV: ${searchQuery}` +
            (year ? ` (${year})` : "")
        );

        let results =
            await searchTmdbTv(apiKey, searchQuery, year);

        if ((!results || results.length === 0) && year) {

            console.log(
                `No match with year ${year} -- retrying without it`
            );

            results =
                await searchTmdbTv(apiKey, searchQuery, null);

        }

        return {
            results: (results || []).slice(0, 8).map(show => ({
                tmdbId: show.id,
                title: show.name,
                year: show.first_air_date
                    ? show.first_air_date.substring(0, 4)
                    : null,
                overview: show.overview || null,
                posterThumb: show.poster_path
                    ? `https://image.tmdb.org/t/p/w154${show.poster_path}`
                    : null
            }))
        };

    }

    catch (error) {

        return classifyTmdbError(error, "TV search");

    }

}


/*
    Full fetch for a SPECIFIC, already-known TMDB movie id --
    no searching involved. Used once the person has picked which
    match is correct (or by the quick-populate path, which picks
    the first search result on the caller's behalf).
*/
async function fetchFullMovieDetails(movieId, fileNameHint) {

    const apiKey =
        getTmdbApiKey();

    if (!apiKey) {

        return { error: "no_api_key" };

    }

    try {

        const detailsResponse =
            await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}`,
                { params: { api_key: apiKey } }
            );

        const movie =
            detailsResponse.data;

        const genreNames =
            (movie.genres || []).map(g => g.name);


        const safeName =
            (fileNameHint || movie.title)
                .replace(/[<>:"/\\|?*]/g, "_")
                .trim();


        let posterPath = null;

        if (movie.poster_path) {

            await downloadTmdbImage(
                movie.poster_path,
                "w500",
                POSTER_DIR,
                `${safeName}-${movie.id}.jpg`
            );

            posterPath =
                `/posters/${safeName}-${movie.id}.jpg`;

        }


        const [extraDetails, images] =
            await Promise.all([
                fetchExtraMovieDetails(apiKey, movie.id),
                fetchMovieImages(apiKey, movie.id, safeName)
            ]);


        return {
            title: movie.title,
            overview: movie.overview || null,
            year: movie.release_date
                ? movie.release_date.substring(0, 4)
                : null,
            genres: genreNames.join(", ") || null,
            poster: posterPath,
            backdrop: images.backdrop,
            landscape: images.landscape,
            logo: images.logo,
            tagline: extraDetails.tagline,
            studio: extraDetails.studio,
            director: extraDetails.director,
            writers: extraDetails.writers,
            tmdbId: movie.id
        };

    }

    catch (error) {

        return classifyTmdbError(error, "details");

    }

}


/*
    Full fetch for a specific episode of a specific TV show --
    given a known show id plus season/episode numbers (pulled from
    the "S01E02" pattern in the filename). Unlike movies, the
    interesting per-item data (title, synopsis, air date, still
    image) lives on the EPISODE, not the show -- genres are the
    one thing pulled from the show level, since TMDB doesn't tag
    genres per-episode.
*/
async function fetchFullEpisodeDetails(showId, seasonNumber, episodeNumber, fileNameHint) {

    const apiKey =
        getTmdbApiKey();

    if (!apiKey) {

        return { error: "no_api_key" };

    }

    try {

        const [episodeResponse, showResponse] =
            await Promise.all([
                axios.get(
                    `https://api.themoviedb.org/3/tv/${showId}/season/${seasonNumber}/episode/${episodeNumber}`,
                    { params: { api_key: apiKey } }
                ),
                axios.get(
                    `https://api.themoviedb.org/3/tv/${showId}`,
                    { params: { api_key: apiKey } }
                )
            ]);

        const episode =
            episodeResponse.data;

        const show =
            showResponse.data;

        const genreNames =
            (show.genres || []).map(g => g.name);


        const safeName =
            (fileNameHint || `${show.name} S${seasonNumber}E${episodeNumber}`)
                .replace(/[<>:"/\\|?*]/g, "_")
                .trim();


        let posterPath = null;

        // The episode's own still image, not the show's poster --
        // matches what an episode list actually wants to show.
        if (episode.still_path) {

            await downloadTmdbImage(
                episode.still_path,
                "w500",
                POSTER_DIR,
                `${safeName}-ep${showId}.jpg`
            );

            posterPath =
                `/posters/${safeName}-ep${showId}.jpg`;

        }


        return {
            title: episode.name || null,
            overview: episode.overview || null,
            date: episode.air_date || null,
            genres: genreNames.join(", ") || null,
            poster: posterPath,
            showTitle: show.name,
            tmdbShowId: showId
        };

    }

    catch (error) {

        return classifyTmdbError(error, "episode details");

    }

}


async function fetchMovieMetadata(searchQuery, year) {

    const searchResult =
        await searchTmdbMovies(searchQuery, year);

    if (searchResult.error) {

        return searchResult;

    }

    if (!searchResult.results || searchResult.results.length === 0) {

        console.log(`No TMDB match for: ${searchQuery}`);

        return null;

    }

    return fetchFullMovieDetails(
        searchResult.results[0].tmdbId,
        searchQuery
    );

}


/*
    Turn a messy torrent-style filename into something worth
    searching TMDB with -- strips the extension, swaps dots/
    underscores for spaces, and removes the common junk tokens
    (resolution, source, codec, release-group tags) that would
    otherwise pollute the search query. The year is pulled out
    separately (it's usually sitting right there in parens, e.g.
    "Fatherhood (2021)") rather than left in the query text --
    TMDB has a dedicated primary_release_year search parameter,
    and leaving a bare year mixed into the fuzzy title text can
    hurt matching instead of helping it.
*/
function guessSearchQuery(name) {

    let text =
        name.replace(/\.\w{2,4}$/, "");

    const yearMatch =
        text.match(/\b(19\d{2}|20\d{2})\b/);

    const year =
        yearMatch ? yearMatch[1] : null;

    // Trailing release-group tag shaped like a domain (e.g.
    // "-Pahe.in") -- caught here, before dots turn into spaces,
    // while it's still recognizable as one token.
    text =
        text.replace(
            /-\s*[a-zA-Z0-9]+\.[a-zA-Z]{2,4}\s*$/,
            " "
        );

    text = text
        .replace(/[._]/g, " ")
        .replace(/\(.*?\)|\[.*?\]/g, " ")
        .replace(
            /\b(720p|1080p|480p|2160p|4k|hdtv|webrip|web-?dl|bluray|br-?rip|dvdrip|hdrip|x264|x265|hevc|aac|e-?sub|lq|hq|nf|amzn|dsnp|hulu|atvp|hmax|dual audio|multi|19\d{2}|20\d{2})\b/gi,
            " "
        )
        .replace(
            /\b(tamil|hindi|telugu|kannada|malayalam|english|bengali|marathi|punjabi|gujarati|urdu|korean|japanese|chinese)\b/gi,
            " "
        )
        // Trailing ALL-CAPS release-group tag, e.g. "-KILLERS"
        .replace(/-\s*[A-Z0-9]{3,}\s*$/, " ")
        .replace(/\s+/g, " ")
        .trim();

    return { query: text, year };

}


/*
    Test whether a given key is actually valid, by calling TMDB's
    lightweight /configuration endpoint (no search cost, just
    confirms the key authenticates). Used by the Settings screen
    to give immediate "yes this works" / "no it doesn't" feedback
    before saving, rather than saving blind and only finding out
    the key was wrong the next time someone tries to fetch details.
*/
async function testApiKey(apiKey) {

    if (!apiKey || !apiKey.trim()) {

        return { valid: false, error: "Enter an API key first." };

    }

    try {

        await axios.get(
            "https://api.themoviedb.org/3/configuration",
            { params: { api_key: apiKey.trim() } }
        );

        return { valid: true };

    }

    catch (error) {

        const status =
            error.response?.status;

        if (status === 401) {

            return {
                valid: false,
                error: "That key was rejected by TMDB -- double check it was copied correctly."
            };

        }

        return {
            valid: false,
            error: "Could not reach TMDB to verify the key. Check your internet connection and try again."
        };

    }

}


function getStoredApiKey() {

    return getTmdbApiKey();

}

function saveApiKey(apiKey) {

    db.prepare(`
        INSERT INTO settings (key, value)
        VALUES ('tmdb_api_key', ?)
        ON CONFLICT (key)
        DO UPDATE SET value = excluded.value
    `).run(apiKey.trim());

}


module.exports = {
    fetchPoster,
    fetchMovieMetadata,
    searchTmdbMovies,
    fetchFullMovieDetails,
    searchTmdbShows,
    fetchFullEpisodeDetails,
    extractSeasonEpisode,
    extractSeasonFromFolder,
    isEpisodeFolder,
    getShowNameFromFolder,
    resolveVideoMetadata,
    guessSearchQuery,
    testApiKey,
    getStoredApiKey,
    saveApiKey
};