// ============================================================
// ACTIVE BASEFLIX PROFILE
// ============================================================

const profileParams =
    new URLSearchParams(
        window.location.search
    );


const profileId =
    profileParams.get(
        "profile"
    );


const activeProfile =
    JSON.parse(
        localStorage.getItem(
            "baseflix_profile"
        ) || "null"
    );


console.log(
    "Active profile:",
    activeProfile
);


console.log(
    "Active profile ID:",
    profileId
);


// ============================================================
// VALIDATE ACTIVE PROFILE
// ============================================================

async function validateActiveProfile() {

    if (
        !profileId
    ) {

        console.error(
            "No profile selected"
        );

        window.location.href =
            "/profiles.html";

        return false;

    }


    try {

        const response =
            await fetch(
                `/api/profiles/${profileId}`
            );


        if (!response.ok) {

            throw new Error(
                "Profile not found"
            );

        }


        const verifiedProfile =
            await response.json();


        // ----------------------------------------------------
        // Update local profile data with the database version
        // ----------------------------------------------------

        localStorage.setItem(
            "baseflix_profile",
            JSON.stringify(
                verifiedProfile
            )
        );


        console.log(
            "Verified profile:",
            verifiedProfile
        );


        return true;

    }

    catch (error) {

        console.error(
            "Profile validation failed:",
            error
        );


        localStorage.removeItem(
            "baseflix_profile"
        );


        window.location.href =
            "/profiles.html";


        return false;

    }

}


// ============================================================
// PROFILE CONTEXT
// ============================================================

const profileContext = {

    id:
        Number(
            profileId
        ),

    name:
        activeProfile
            ? activeProfile.name
            : null,

    avatar:
        activeProfile
            ? activeProfile.avatar
            : null

};

// ============================================================
// CONNECT PROFILE TO HOME PAGE
// ============================================================

const profileData =
    document.querySelector(
        "#profileData"
    );


if (profileData) {

    profileData.dataset.profileId =
        profileContext.id;

}


console.log(
    "Baseflix profile context:",
    profileContext
);


// ============================================================
// ADMIN CHECK
// The default "Admin" profile (created in database.js, undeletable
// in server.js) is the privileged one. This gates admin-only UI
// (metadata editing, the cleanup banner, settings) so non-admin
// profiles don't see controls they can't use. NOTE: this is a UI
// convenience only -- the real security boundary is the admin key
// the backend checks on every privileged endpoint, which a
// frontend edit can't bypass.
// ============================================================

const isAdmin =
    profileContext.name === "Admin";




// ============================================================
// DISPLAY ACTIVE PROFILE
// ============================================================

function displayActiveProfile() {

    const profileContainer =
        document.querySelector(
            "#activeProfile"
        );


    const profileAvatar =
        document.querySelector(
            "#activeProfileAvatar"
        );


    const profileName =
        document.querySelector(
            "#activeProfileName"
        );


    if (
        !profileContainer ||
        !profileAvatar ||
        !profileName
    ) {

        return;

    }


    if (!activeProfile) {

        profileContainer.style.display =
            "none";

        return;

    }


    profileAvatar.textContent =
        activeProfile.avatar ||
        "🎬";


    profileName.textContent =
        activeProfile.name;


    profileContainer.style.display =
        "flex";

}


displayActiveProfile();


// ============================================================
// CONTINUE WATCHING HELPERS
// Shared by every fullscreen player instance created below.
// ============================================================

// How often (ms) to report progress while a video is playing.
const CONTINUE_WATCHING_SAVE_INTERVAL = 5000;


async function saveContinueWatching(video, player) {

    const duration =
        player.duration;

    const position =
        player.currentTime;


    // Nothing meaningful to save yet (e.g. metadata hasn't
    // loaded, or the source was already cleared).
    if (
        !Number.isFinite(duration) ||
        duration <= 0
    ) {

        return;

    }


    try {

        await fetch(
            "/api/continue-watching",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    profileId: profileContext.id,
                    videoId: video.id,
                    position: position,
                    duration: duration
                })
            }
        );

    }

    catch (error) {

        console.error(
            "Could not save watch progress:",
            error
        );

    }

}


async function fetchResumePosition(videoId) {

    try {

        const response =
            await fetch(
                `/api/continue-watching/${profileContext.id}`
            );


        if (!response.ok) {

            return 0;

        }


        const items =
            await response.json();


        const match =
            items.find(
                item => item.video_id === videoId
            );


        return match
            ? match.position
            : 0;

    }

    catch (error) {

        console.error(
            "Could not load resume position:",
            error
        );

        return 0;

    }

}


// ============================================================
// BUILD A VIDEO CARD
// Shared by the regular per-folder grid and the Continue
// Watching row. Pass progressPercent to draw a progress bar
// under the title (Continue Watching only).
// ============================================================

function createVideoCard(video, progressPercent) {

    const card =
        document.createElement("div");

    card.className =
        "video-card";


    // ====================================================
    // VIDEO CLICK
    // Feature 1: Automatic Fullscreen
    // ====================================================

    card.onclick = () => navigateToVideoDetails(video.id);


    // ====================================================
    // MEDIA AREA (poster image, or a live preview frame as
    // a fallback for anything not scanned/probed yet)
    // ====================================================

    const media =
        document.createElement("div");

    media.className =
        "video-media";


    let preview;

    if (video.poster) {

        preview =
            document.createElement("div");

        preview.className =
            "video-preview";

        preview.style.backgroundImage =
            `url("${video.poster}")`;

    }

    else {

        preview =
            document.createElement("video");

        preview.className =
            "video-preview";

        preview.muted =
            true;

        preview.preload =
            "metadata";

        preview.src =
            "/video/" +
            encodeURIComponent(
                video.relative_path
            );

    }


    const scrim =
        document.createElement("div");

    scrim.className =
        "video-card-scrim";


    const playButton =
        document.createElement("div");

    playButton.className =
        "video-card-play";

    playButton.textContent =
        "\u25B6";


    media.appendChild(preview);

    media.appendChild(scrim);

    media.appendChild(playButton);


    // ====================================================
    // VIDEO TITLE
    // ====================================================

    const titleRow =
        document.createElement("div");

    titleRow.className =
        "video-title-row";

    const title =
        document.createElement("div");

    title.className =
        "video-title";

    title.textContent =
        video.custom_title || stripVideoExtension(video.name);

    titleRow.appendChild(title);

    const cardMetaButton =
        createMetadataButton(video);

    if (cardMetaButton) {

        titleRow.appendChild(cardMetaButton);

    }


    card.appendChild(media);

    card.appendChild(titleRow);


    // ====================================================
    // PROGRESS BAR (Continue Watching only)
    // ====================================================

    if (progressPercent != null) {

        const track =
            document.createElement("div");

        track.className =
            "video-progress";

        const fill =
            document.createElement("div");

        fill.className =
            "video-progress-fill";

        fill.style.width =
            Math.min(100, Math.max(0, progressPercent)) + "%";

        track.appendChild(fill);

        card.appendChild(track);

    }


    return card;

}


// ============================================================
// PLAYBACK CAPABILITY DETECTION (Task 16)
// ============================================================
//
// Reports what THIS browser can decode to the server's existing
// decision engine (client-capabilities.js -> playback-decision.js)
// instead of leaving it to assume an unknown client. The browser
// only ever REPORTS capabilities -- it never decides Direct Play /
// Remux / Transcode itself; that stays entirely server-side.
//
// /client-capabilities.js is the EXACT SAME module server.js
// requires -- loaded lazily (most page views never open a player)
// and only once per session.

let capabilityDetectorPromise = null;

function loadCapabilityDetector() {

    if (capabilityDetectorPromise) {

        return capabilityDetectorPromise;

    }

    capabilityDetectorPromise = new Promise((resolve) => {

        if (window.BaseflixClientCapabilities) {

            resolve(window.BaseflixClientCapabilities);
            return;

        }

        const script =
            document.createElement("script");

        script.src = "/client-capabilities.js";
        script.async = true;

        script.onload = () =>
            resolve(window.BaseflixClientCapabilities || null);

        script.onerror = () =>
            resolve(null);

        document.head.appendChild(script);

    });

    return capabilityDetectorPromise;

}

// -> "" | "?caps=..." to append to a /video request. Never throws --
// a missing/broken detector (old browser, blocked script, detection
// error) must fall back to "" and let playback proceed exactly as it
// did before this feature existed, never block or crash it.
async function detectPlaybackCapabilities(videoElement) {

    try {

        const lib = await loadCapabilityDetector();

        if (!lib || typeof lib.detectBrowserCapabilities !== "function") {

            return "";

        }

        const report =
            lib.detectBrowserCapabilities({
                videoElement: videoElement,
                screen: window.screen,
                devicePixelRatio: window.devicePixelRatio
            });

        return typeof lib.toQueryString === "function"
            ? lib.toQueryString(report)
            : "";

    } catch (error) {

        console.warn(
            "Baseflix: capability detection failed, playing without it:",
            error
        );

        return "";

    }

}


// ============================================================
// OPEN FULLSCREEN PLAYER
// ============================================================

async function openPlayer(video) {

    const playerContainer =
        document.createElement("div");


    playerContainer.style.position =
        "fixed";

    playerContainer.style.inset =
        "0";

    playerContainer.style.width =
        "100%";

    playerContainer.style.height =
        "100%";

    playerContainer.style.background =
        "black";

    playerContainer.style.zIndex =
        "999999";


    // =================================================
    // VIDEO PLAYER
    // =================================================

    const player =
        document.createElement("video");


    // Check for a saved position *before* the
    // player starts loading, so we know where to
    // resume as soon as metadata is available.
    const resumePosition =
        await fetchResumePosition(
            video.id
        );


    // Task 16: report this browser's playback capabilities so the
    // server's decision engine can pick Direct Play / Remux / Audio
    // Transcode / Video Transcode instead of assuming an unknown
    // client. A <video src="..."> element cannot set a custom HTTP
    // header, so this uses the query-string arm playback-integration.js
    // already accepts (?caps=) -- the same intake, normalization and
    // decision path as the header form. Resolves to "" (no query
    // string added) when detection is unavailable or fails; Task 14's
    // no-capability Direct Play fast-path then applies exactly as
    // before this feature existed.
    const capabilitiesQuery =
        await detectPlaybackCapabilities(player);

    player.src =
        "/video/" +
        encodeURIComponent(
            video.relative_path
        ) +
        capabilitiesQuery;


    player.controls = true;

    player.autoplay = true;

    player.playsInline = true;


    player.style.width =
        "100%";

    player.style.height =
        "100%";

    player.style.background =
        "black";

    player.style.objectFit =
        "contain";


    playerContainer.appendChild(
        player
    );


    document.body.appendChild(
        playerContainer
    );


    // =================================================
    // PLAYER STATE
    // =================================================

    let isStopping = false;

    let saveTimer = null;


    // =================================================
    // RESUME ON OPEN
    // =================================================

    player.addEventListener(
        "loadedmetadata",
        () => {

            if (resumePosition > 0) {

                player.currentTime =
                    resumePosition;

            }

        }
    );


    // =================================================
    // PERIODIC SAVE WHILE PLAYING
    // =================================================

    player.addEventListener(
        "play",
        () => {

            clearInterval(saveTimer);

            saveTimer =
                setInterval(
                    () => saveContinueWatching(video, player),
                    CONTINUE_WATCHING_SAVE_INTERVAL
                );

        }
    );


    player.addEventListener(
        "pause",
        () => {

            clearInterval(saveTimer);

            saveContinueWatching(video, player);

        }
    );


    // Video played to the end on its own (no manual
    // stop) -- save final progress and close the
    // fullscreen player, same as pressing stop.
    player.addEventListener(
        "ended",
        () => {

            stopVideo();

        }
    );


    // =================================================
    // STOP VIDEO
    // =================================================

    const stopVideo = async () => {

        if (isStopping) {

            return;

        }


        isStopping = true;


        console.log(
            "Stopping video"
        );


        clearInterval(saveTimer);


        // Capture the final position BEFORE the source is torn
        // down below, and wait for it to finish saving so the
        // refreshed grid (below) reflects the latest progress.
        await saveContinueWatching(video, player);


        player.pause();


        player.currentTime = 0;


        player.removeAttribute(
            "src"
        );


        player.load();


        document.removeEventListener(
            "fullscreenchange",
            handleFullscreenChange
        );


        playerContainer.remove();


        // This page never navigates -- the grid was only built
        // once on initial load, so nothing else will pick up the
        // progress we just saved. Refresh whichever view (home or
        // a specific folder) the viewer actually came from.
        refreshCurrentView();

    };


    // =================================================
    // EXIT FULLSCREEN
    // Stop the video
    // =================================================

    function handleFullscreenChange() {

        if (
            !document.fullscreenElement &&
            !isStopping
        ) {

            stopVideo();

        }

    }


    document.addEventListener(
        "fullscreenchange",
        handleFullscreenChange
    );


    // =================================================
    // AUTOMATIC FULLSCREEN
    // =================================================

    try {

        await playerContainer.requestFullscreen();

    }

    catch (error) {

        console.log(
            "Fullscreen unavailable:",
            error
        );

    }


    // =================================================
    // PLAY
    // =================================================

    try {

        await player.play();

    }

    catch (error) {

        console.log(
            "Playback requires user interaction:",
            error
        );

    }

}


// ============================================================
// CURRENT VIEW STATE
// null = home screen (library folder grid). A string = inside
// that folder. Used so closing the player returns to wherever
// you actually were, instead of always bouncing back to home.
// ============================================================

// ============================================================
// ADMIN KEY -- entered once, reused for the rest of the session
// (and persisted in localStorage across page loads), rather than
// prompting on every single admin-gated action. Cleared and
// re-prompted only if the server actually rejects it (403) --
// so a stale/wrong cached key can't silently lock someone out.
// ============================================================

let cachedAdminKey =
    localStorage.getItem("baseflix_admin_key") || null;

function getAdminKey(promptMessage) {

    if (cachedAdminKey) {

        return cachedAdminKey;

    }

    const entered =
        prompt(promptMessage || "Enter admin key:");

    if (entered) {

        cachedAdminKey = entered;

        localStorage.setItem("baseflix_admin_key", entered);

    }

    return entered;

}

function clearCachedAdminKey() {

    cachedAdminKey = null;

    localStorage.removeItem("baseflix_admin_key");

}


let currentFolder = null;
let currentShowBackButton = true;
let currentDetailsVideoId = null;


async function refreshCurrentView() {

    if (currentDetailsVideoId != null) {

        await renderVideoDetails(currentDetailsVideoId);

    }

    else if (currentFolder) {

        await renderFolder(currentFolder, currentShowBackButton);

    }

    else {

        await renderHome();

    }

}


// ============================================================
// BROWSER HISTORY INTEGRATION
// Without this, every "navigation" in the app is really just
// rewriting .content in place -- as far as the browser is
// concerned you're still on the exact same page you loaded, so
// its own Back button has nothing to step through. These wrapper
// functions push a matching history entry every time the user
// moves to a genuinely new view (a folder tile, the home logo),
// and the popstate listener below re-renders the right view
// whenever the browser's Back/Forward buttons are used -- so our
// own "<- Back" links just call history.back() and let this
// same listener handle it, rather than duplicating the logic.
// ============================================================

async function navigateHome() {

    const rendered =
        await renderHome();

    window.history.pushState(
        rendered || { view: "home" },
        "",
        "#"
    );

}

async function navigateToFolder(folderPath) {

    await renderFolder(folderPath, true);

    window.history.pushState(
        {
            view: "folder",
            folderPath: folderPath,
            showBackButton: true
        },
        "",
        "#" + encodeURIComponent(folderPath)
    );

}

async function navigateToVideoDetails(videoId) {

    await renderVideoDetails(videoId);

    window.history.pushState(
        {
            view: "details",
            videoId: videoId
        },
        "",
        "#video-" + videoId
    );

}

function applyHistoryState(state) {

    if (!state || state.view === "home") {

        renderHome();

    }

    else if (state.view === "folder") {

        renderFolder(
            state.folderPath,
            state.showBackButton
        );

    }

    else if (state.view === "details") {

        renderVideoDetails(state.videoId);

    }

}

window.addEventListener("popstate", (event) => {

    applyHistoryState(event.state);

});


function createFolderCard(displayName, targetPath, videosInFolder) {

    const card =
        document.createElement("div");

    card.className =
        "library-card";


    const posterVideo =
        videosInFolder.find(v => v.poster);

    if (posterVideo) {

        card.style.backgroundImage =
            `url("${posterVideo.poster}")`;

    }


    const scrim =
        document.createElement("div");

    scrim.className =
        "library-card-scrim";


    const title =
        document.createElement("div");

    title.className =
        "library-card-title";

    title.textContent =
        displayName;


    card.appendChild(scrim);

    card.appendChild(title);


    card.onclick = () => navigateToFolder(targetPath);


    return card;

}


// ============================================================
// VIDEO DETAILS PAGE
// Shown when clicking a movie or show card (episodes in a season
// list still play directly, unchanged). Playback only starts
// once the Play button is pressed here.
// ============================================================

async function renderVideoDetails(videoId) {

    currentFolder = null;

    currentDetailsVideoId = videoId;


    try {

        const response =
            await fetch("/api/videos");

        const videos =
            await response.json();

        const video =
            videos.find(v => v.id === videoId);


        const content =
            document.querySelector(".content");

        content.innerHTML = "";


        const backLink =
            document.createElement("a");

        backLink.className =
            "back-button";

        backLink.textContent =
            "\u2190 Back";

        backLink.href =
            "#";

        backLink.onclick = (event) => {

            event.preventDefault();

            window.history.back();

        };

        content.appendChild(backLink);


        if (!video) {

            const notFound =
                document.createElement("p");

            notFound.textContent =
                "This video could not be found.";

            content.appendChild(notFound);

            return;

        }


        const displayTitle =
            video.custom_title ||
            stripVideoExtension(video.name);


        const page =
            document.createElement("div");

        page.className =
            "details-page";


        // ----------------------------------------------------
        // BACKDROP -- the same poster image, blurred/darkened,
        // with the title overlaid large. We only have one image
        // per video, so it does double duty as both backdrop and
        // poster rather than needing a separate backdrop asset,
        // unless a real fetched backdrop/landscape image exists.
        // ----------------------------------------------------

        const backdrop =
            document.createElement("div");

        backdrop.className =
            "details-backdrop";

        const backdropImage =
            video.landscape || video.backdrop || video.poster;

        if (backdropImage) {

            backdrop.style.backgroundImage =
                `url("${backdropImage}")`;

        }

        const backdropOverlay =
            document.createElement("div");

        backdropOverlay.className =
            "details-backdrop-overlay";

        if (video.logo) {

            const logoImg =
                document.createElement("img");

            logoImg.className =
                "details-logo-image";

            logoImg.src =
                video.logo;

            logoImg.alt =
                displayTitle;

            backdropOverlay.appendChild(logoImg);

        }

        else {

            const bigTitle =
                document.createElement("h1");

            bigTitle.className =
                "details-big-title";

            bigTitle.textContent =
                displayTitle;

            backdropOverlay.appendChild(bigTitle);

        }

        backdrop.appendChild(backdropOverlay);

        page.appendChild(backdrop);


        // ----------------------------------------------------
        // POSTER + INFO ROW
        // ----------------------------------------------------

        const posterRow =
            document.createElement("div");

        posterRow.className =
            "details-poster-row";


        const posterEl =
            document.createElement("div");

        posterEl.className =
            "details-poster";

        if (video.poster) {

            posterEl.style.backgroundImage =
                `url("${video.poster}")`;

        }

        posterRow.appendChild(posterEl);


        const info =
            document.createElement("div");

        info.className =
            "details-info";


        const titleEl =
            document.createElement("h2");

        titleEl.className =
            "details-title";

        titleEl.textContent =
            displayTitle;

        info.appendChild(titleEl);


        const metaParts = [];

        if (video.release_year) {

            metaParts.push(video.release_year);

        }

        if (video.duration) {

            const totalMinutes =
                Math.round(video.duration / 60);

            const hours =
                Math.floor(totalMinutes / 60);

            const minutes =
                totalMinutes % 60;

            metaParts.push(
                hours > 0
                    ? `${hours}h ${minutes}m`
                    : `${minutes}m`
            );

        }

        if (metaParts.length > 0) {

            const metaLine =
                document.createElement("div");

            metaLine.className =
                "details-meta-line";

            metaLine.textContent =
                metaParts.join("  \u00B7  ");

            info.appendChild(metaLine);

        }


        const actions =
            document.createElement("div");

        actions.className =
            "details-actions";

        const playButton =
            document.createElement("button");

        playButton.className =
            "details-play-button";

        playButton.textContent =
            "\u25B6 Play";

        playButton.onclick = () => openPlayer(video);

        actions.appendChild(playButton);

        const detailsMetaButton =
            createMetadataButton(video);

        if (detailsMetaButton) {

            actions.appendChild(detailsMetaButton);

        }

        info.appendChild(actions);


        if (video.video_codec || video.audio_codec) {

            const tech =
                document.createElement("div");

            tech.className =
                "details-tech";

            if (video.video_codec) {

                const videoLine =
                    document.createElement("div");

                const heightLabel =
                    video.height
                        ? `${video.height}p `
                        : "";

                videoLine.textContent =
                    `Video: ${heightLabel}${video.video_codec.toUpperCase()}`;

                tech.appendChild(videoLine);

            }

            if (video.audio_codec) {

                const audioLine =
                    document.createElement("div");

                audioLine.textContent =
                    `Audio: ${video.audio_codec.toUpperCase()}`;

                tech.appendChild(audioLine);

            }

            info.appendChild(tech);

        }


        if (video.tagline) {

            const taglineEl =
                document.createElement("div");

            taglineEl.className =
                "details-tagline";

            taglineEl.textContent =
                video.tagline;

            info.appendChild(taglineEl);

        }


        if (video.overview) {

            const overviewEl =
                document.createElement("div");

            overviewEl.className =
                "details-overview";

            overviewEl.textContent =
                video.overview;

            info.appendChild(overviewEl);

        }


        const crewRows =
            [
                ["Genres", video.genres],
                ["Director", video.director],
                ["Writers", video.writers],
                ["Studio", video.studio]
            ].filter(([label, value]) => !!value);

        if (crewRows.length > 0) {

            const crew =
                document.createElement("div");

            crew.className =
                "details-crew";

            for (const [label, value] of crewRows) {

                const row =
                    document.createElement("div");

                row.className =
                    "details-crew-row";

                const labelEl =
                    document.createElement("span");

                labelEl.className =
                    "details-crew-label";

                labelEl.textContent =
                    label;

                const valueEl =
                    document.createElement("span");

                valueEl.className =
                    "details-crew-value";

                valueEl.textContent =
                    value;

                row.appendChild(labelEl);

                row.appendChild(valueEl);

                crew.appendChild(row);

            }

            info.appendChild(crew);

        }


        posterRow.appendChild(info);

        page.appendChild(posterRow);

        content.appendChild(page);

    }

    catch (error) {

        console.error(
            "Could not load video details:",
            error
        );

    }

}


function createVideoGridSection(headingText, videosList) {

    const section =
        document.createElement("section");

    section.className =
        "video-section";


    const heading =
        document.createElement("h2");

    heading.className =
        "folder-title";

    heading.textContent =
        headingText;


    const grid =
        document.createElement("div");

    grid.className =
        "video-grid";

    appendMixedVideoGrid(grid, videosList);


    section.appendChild(heading);

    section.appendChild(grid);


    return section;

}


function formatBytes(bytes) {

    if (!bytes) return "0 MB";

    const mb = bytes / (1024 * 1024);

    if (mb < 1024) {

        return mb.toFixed(0) + " MB";

    }

    return (mb / 1024).toFixed(1) + " GB";

}


function renderPendingCleanupBanner(pendingItems) {

    const section =
        document.createElement("section");

    section.className =
        "cleanup-banner";


    const heading =
        document.createElement("h2");

    heading.textContent =
        "Ready to Clean Up";

    const subheading =
        document.createElement("p");

    subheading.className =
        "cleanup-banner-subtext";

    subheading.textContent =
        "These files were converted to a compatible format. " +
        "You can move the original out of your videos folder to " +
        "save space, or keep both.";


    section.appendChild(heading);

    section.appendChild(subheading);


    for (const item of pendingItems) {

        const row =
            document.createElement("div");

        row.className =
            "cleanup-row";


        const info =
            document.createElement("div");

        info.className =
            "cleanup-row-info";

        const name =
            document.createElement("div");

        name.className =
            "cleanup-row-name";

        name.textContent =
            stripVideoExtension(item.name);

        const sizes =
            document.createElement("div");

        sizes.className =
            "cleanup-row-sizes";

        const savedBytes =
            item.original_size - item.converted_size;

        sizes.textContent =
            `Original: ${formatBytes(item.original_size)}` +
            `  →  Converted: ${formatBytes(item.converted_size)}` +
            (savedBytes > 0
                ? `  (save ${formatBytes(savedBytes)})`
                : "");

        info.appendChild(name);

        info.appendChild(sizes);


        const actions =
            document.createElement("div");

        actions.className =
            "cleanup-row-actions";


        const keepButton =
            document.createElement("button");

        keepButton.className =
            "cleanup-keep-button";

        keepButton.textContent =
            "Keep Both";

        keepButton.onclick = async () => {

            try {

                await fetch(
                    `/api/videos/${item.id}/keep-original`,
                    { method: "POST" }
                );

            }

            catch (error) {

                console.error(
                    "Could not update video:",
                    error
                );

            }

            refreshCurrentView();

        };


        const moveButton =
            document.createElement("button");

        moveButton.className =
            "cleanup-delete-button";

        moveButton.textContent =
            "Move Original";

        moveButton.onclick = async () => {

            const adminKey =
                getAdminKey(
                    "Enter admin key to move the original file out of videos/:"
                );

            if (!adminKey) {

                return;

            }


            try {

                const response =
                    await fetch(
                        `/api/videos/${item.id}/move-original`,
                        {
                            method: "POST",
                            headers: {
                                "x-admin-key": adminKey
                            }
                        }
                    );

                if (!response.ok) {

                    if (response.status === 403) {

                        clearCachedAdminKey();

                    }

                    const body =
                        await response.json();

                    alert(
                        body.error ||
                        "Could not move the original file."
                    );

                    return;

                }

            }

            catch (error) {

                console.error(
                    "Could not move original file:",
                    error
                );

                alert(
                    "Could not move the original file."
                );

                return;

            }

            refreshCurrentView();

        };


        actions.appendChild(keepButton);

        actions.appendChild(moveButton);


        row.appendChild(info);

        row.appendChild(actions);


        section.appendChild(row);

    }


    return section;

}


// ============================================================
// FOLDER PATH HELPERS
// video.folder is the video's full parent path (e.g. "Movies",
// "Movies/Action", or "Home" for loose root files) -- these pull
// out just the piece relevant at a given level of navigation, so
// nested subfolders group correctly instead of each distinct
// full path being treated as its own unrelated top-level folder.
// ============================================================

// scanner.js only ever scans these extensions (see VIDEO_EXTENSIONS
// in scanner.js), so a video's name always ends in one of these --
// stripping them here is purely cosmetic for display and never
// touches the underlying name/relative_path used for actual
// playback or file operations.
const KNOWN_VIDEO_EXTENSIONS = [
    ".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"
];

function stripVideoExtension(name) {

    if (!name) {

        return name;

    }

    const lower =
        name.toLowerCase();

    for (const ext of KNOWN_VIDEO_EXTENSIONS) {

        if (lower.endsWith(ext)) {

            return name.slice(0, name.length - ext.length);

        }

    }

    return name;

}


function formatWatchMeta(video, statusInfo) {

    const parts = [];

    if (video.duration) {

        parts.push(
            `Duration: ${Math.round(video.duration / 60)} min`
        );

    }

    if (statusInfo && statusInfo.status === "completed") {

        parts.push("Completed");

    }

    else if (statusInfo && statusInfo.status === "in_progress") {

        parts.push(
            `Watched: ${Math.round(statusInfo.position / 60)} min`
        );

    }

    return parts.join("  \u00B7  ");

}


function normalizeFolderPath(folder) {

    // scanner.js runs on whatever OS the server is on -- on
    // Windows, path.dirname() produces backslash-separated paths
    // ("Movies\English"), not forward-slash ones. The browser has
    // no OS awareness at all, so this must handle both separator
    // styles itself rather than assuming "/".
    return (folder || "Home").replace(/\\/g, "/");

}

function getTopLevelFolder(folder) {

    return normalizeFolderPath(folder).split("/")[0];

}


// ============================================================
// SERIES GROUPING
// A video 2 levels deep ("Movies/English") is a standalone item.
// One 3+ levels deep ("Shows/Breaking Bad/Season 1") is an
// episode -- returns which show it belongs to, so callers can
// collapse every episode from the same show into a single card
// instead of listing them all individually.
// ============================================================

function getSeriesGrouping(video) {

    const segments =
        normalizeFolderPath(video.folder).split("/");

    if (segments.length < 3) {

        return null;

    }

    return {
        seriesPath: segments[0] + "/" + segments[1],
        displayName: segments[1]
    };

}

// Takes a flat list of videos (already poster/name/folder-shaped,
// as returned by /api/videos or reshaped from continue-watching /
// watch-history) and collapses every video belonging to the same
// show into one entry. Movies and other standalone videos pass
// through unchanged. Order of first appearance is preserved.
function groupVideosForDisplay(videos) {

    const entries = [];
    const seriesIndex = {};

    for (const video of videos) {

        const grouping =
            getSeriesGrouping(video);

        if (!grouping) {

            entries.push({ type: "video", video: video });
            continue;

        }

        if (seriesIndex[grouping.seriesPath] != null) {

            entries[seriesIndex[grouping.seriesPath]]
                .videosInSeries.push(video);
            continue;

        }

        seriesIndex[grouping.seriesPath] = entries.length;

        entries.push({
            type: "series",
            seriesPath: grouping.seriesPath,
            displayName: grouping.displayName,
            videosInSeries: [video]
        });

    }

    return entries;

}

function createSeriesCard(displayName, targetPath, videosInSeries) {

    const card =
        document.createElement("div");

    card.className =
        "video-card";

    card.onclick = () => navigateToFolder(targetPath);


    const media =
        document.createElement("div");

    media.className =
        "video-media";


    const posterVideo =
        videosInSeries.find(v => v.poster);

    const preview =
        document.createElement("div");

    preview.className =
        "video-preview";

    if (posterVideo) {

        preview.style.backgroundImage =
            `url("${posterVideo.poster}")`;

    }

    media.appendChild(preview);


    const title =
        document.createElement("div");

    title.className =
        "video-title";

    title.textContent =
        displayName;


    card.appendChild(media);

    card.appendChild(title);


    return card;

}

// Renders a mixed grid of movie cards and series cards (via
// groupVideosForDisplay) into the given container -- the one
// shared code path Continue Watching, Recently Watched, and
// Recently Added's per-folder grids all use. getProgress (if
// given) is only applied to standalone videos -- a collapsed
// series card represents several episodes at once, so a single
// progress percentage wouldn't mean anything there.
function appendMixedVideoGrid(grid, videos, getProgress) {

    for (const entry of groupVideosForDisplay(videos)) {

        if (entry.type === "series") {

            grid.appendChild(
                createSeriesCard(
                    entry.displayName,
                    entry.seriesPath,
                    entry.videosInSeries
                )
            );

        }

        else {

            const progressPercent =
                getProgress
                    ? getProgress(entry.video)
                    : null;

            grid.appendChild(
                createVideoCard(entry.video, progressPercent)
            );

        }

    }

}


async function renderHome() {

    currentFolder = null;
    currentDetailsVideoId = null;


    console.log(
        "Loading home for profile:",
        profileContext.id
    );


    try {

        const response =
            await fetch("/api/videos");

        const videos =
            await response.json();


        const content =
            document.querySelector(".content");


        content.innerHTML = "";


        // ============================================================
        // PENDING CLEANUP
        // Files the scanner has already converted to a compatible
        // format, where the (often much larger) original is still
        // sitting on disk awaiting a keep/delete decision.
        // ============================================================

        // The "Keep Both / Move Original" cleanup actions are
        // admin-only, so skip the whole banner for non-admins --
        // no point fetching or showing controls they can't use.
        if (isAdmin) {

            try {

                const pendingResponse =
                    await fetch("/api/videos/pending-cleanup");

                if (pendingResponse.ok) {

                    const pendingItems =
                        await pendingResponse.json();

                    if (pendingItems.length > 0) {

                        content.appendChild(
                            renderPendingCleanupBanner(pendingItems)
                        );

                    }

                }

            }

            catch (error) {

                console.error(
                    "Could not load pending cleanup list:",
                    error
                );

            }

        }


        // ============================================================
        // CONTINUE WATCHING
        // ============================================================

        try {

            const continueResponse =
                await fetch(
                    `/api/continue-watching/${profileContext.id}`
                );


            if (continueResponse.ok) {

                const continueItems =
                    await continueResponse.json();


                if (continueItems.length > 0) {

                    const continueSection =
                        document.createElement("section");

                    continueSection.className =
                        "video-section";


                    const continueHeading =
                        document.createElement("h2");

                    continueHeading.className =
                        "folder-title";

                    continueHeading.textContent =
                        "Continue Watching";


                    const continueGrid =
                        document.createElement("div");

                    continueGrid.className =
                        "video-grid";


                    // The continue-watching row returns the video
                    // fields flattened (video_id, name,
                    // relative_path, folder) rather than a nested
                    // video object -- reshape each one to look like
                    // a normal /api/videos entry so it can go
                    // through the same createVideoCard/openPlayer
                    // code path as everything else. Progress is
                    // looked up separately below since a collapsed
                    // series card (multiple episodes) can't
                    // sensibly show one percentage.
                    const progressById = {};

                    const cardVideos =
                        continueItems.map((item) => {

                            progressById[item.video_id] =
                                (item.position / item.duration) * 100;

                            return {
                                id: item.video_id,
                                name: item.name,
                                relative_path: item.relative_path,
                                folder: item.folder,
                                poster: item.poster
                            };

                        });


                    appendMixedVideoGrid(
                        continueGrid,
                        cardVideos,
                        (video) => progressById[video.id]
                    );


                    continueSection.appendChild(
                        continueHeading
                    );

                    continueSection.appendChild(
                        continueGrid
                    );

                    content.appendChild(
                        continueSection
                    );

                }

            }

        }

        catch (error) {

            console.error(
                "Could not load Continue Watching:",
                error
            );

        }


        // ============================================================
        // RECENTLY WATCHED
        // Permanent record (watch_history), not continue_watching --
        // already limited to 10 by the endpoint itself.
        // ============================================================

        try {

            const historyResponse =
                await fetch(
                    `/api/watch-history/${profileContext.id}`
                );

            if (historyResponse.ok) {

                const historyItems =
                    await historyResponse.json();

                if (historyItems.length > 0) {

                    const cardVideos =
                        historyItems.map(item => ({
                            id: item.video_id,
                            name: item.name,
                            relative_path: item.relative_path,
                            folder: item.folder,
                            poster: item.poster
                        }));

                    content.appendChild(
                        createVideoGridSection(
                            "Recently Watched",
                            cardVideos
                        )
                    );

                }

            }

        }

        catch (error) {

            console.error(
                "Could not load watch history:",
                error
            );

        }


        // ============================================================
        // RECENTLY ADDED -- one grid per top-level folder, videos
        // added within the last 7 days. Reuses the same `videos`
        // list already fetched above.
        // ============================================================

        const RECENTLY_ADDED_DAYS = 7;

        const recentCutoff =
            Date.now() -
            RECENTLY_ADDED_DAYS * 24 * 60 * 60 * 1000;

        const recentlyAddedByFolder = {};

        for (const video of videos) {

            if (!video.added_at) {

                continue;

            }

            const addedTime =
                new Date(video.added_at).getTime();

            if (
                Number.isNaN(addedTime) ||
                addedTime < recentCutoff
            ) {

                continue;

            }

            const topFolder =
                getTopLevelFolder(video.folder);

            if (!recentlyAddedByFolder[topFolder]) {

                recentlyAddedByFolder[topFolder] = [];

            }

            recentlyAddedByFolder[topFolder].push(video);

        }

        for (
            const folderName of
            Object.keys(recentlyAddedByFolder).sort()
        ) {

            content.appendChild(
                createVideoGridSection(
                    `Recently Added: ${folderName}`,
                    recentlyAddedByFolder[folderName]
                )
            );

        }


        // ============================================================
        // GROUP VIDEOS BY TOP-LEVEL FOLDER
        // A video's folder field is its full parent path (e.g.
        // "Movies/Action") -- group by just the first segment here
        // so "Movies" gets one tile regardless of how many
        // subfolders it has inside it. Subfolder grouping happens
        // one level down, inside renderFolder/renderFolderContent.
        // ============================================================

        const folders = {};


        for (const video of videos) {

            const topLevelFolder =
                getTopLevelFolder(video.folder);


            if (!folders[topLevelFolder]) {

                folders[topLevelFolder] = [];

            }


            folders[topLevelFolder].push(video);

        }


        const folderNames =
            Object.keys(folders);


        // Only one folder total (or everything's loose in "Home")
        // -- nothing to pick between, so skip straight into it
        // instead of showing a library of one tile.
        if (folderNames.length <= 1) {

            await renderFolder(
                folderNames[0] || "Home",
                false
            );

            return {
                view: "folder",
                folderPath: folderNames[0] || "Home",
                showBackButton: false
            };

        }


        // ============================================================
        // LIBRARY -- ONE TILE PER FOLDER
        // ============================================================

        const librarySection =
            document.createElement("section");

        librarySection.className =
            "video-section";


        const libraryHeading =
            document.createElement("h2");

        libraryHeading.className =
            "folder-title";

        libraryHeading.textContent =
            "My Media";


        const libraryGrid =
            document.createElement("div");

        libraryGrid.className =
            "library-grid";


        for (const folderName of folderNames) {

            libraryGrid.appendChild(
                createFolderCard(
                    folderName,
                    folderName,
                    folders[folderName]
                )
            );

        }


        librarySection.appendChild(
            libraryHeading
        );

        librarySection.appendChild(
            libraryGrid
        );

        content.appendChild(
            librarySection
        );

        return { view: "home" };

    }

    catch (error) {

        console.error(
            "Could not load videos:",
            error
        );

        return { view: "home" };

    }

}


function createMetadataButton(video) {

    // Metadata editing is admin-only -- non-admin profiles get no
    // button at all (callers null-check this).
    if (!isAdmin) {

        return null;

    }

    const button =
        document.createElement("button");

    button.className =
        "metadata-menu-button";

    button.textContent =
        "\u22EE";

    button.onclick = (event) => {

        // Don't let this bubble up to the card/row's own onclick,
        // which would start playback.
        event.stopPropagation();

        openMetadataEditor(video);

    };

    return button;

}


function openTmdbSetupModal() {

    const overlay =
        document.createElement("div");

    overlay.className =
        "metadata-modal-overlay";

    overlay.onclick = (event) => {

        if (event.target === overlay) {

            overlay.remove();

        }

    };


    const modal =
        document.createElement("div");

    modal.className =
        "metadata-modal";

    modal.onclick = (event) => event.stopPropagation();


    const heading =
        document.createElement("h3");

    heading.textContent =
        "Set up movie details lookup";

    modal.appendChild(heading);


    const explanation =
        document.createElement("p");

    explanation.className =
        "tmdb-setup-explanation";

    explanation.textContent =
        "To fetch titles, overviews, posters, and genres " +
        "automatically, Baseflix needs a free API key from " +
        "The Movie Database (TMDB). It's your own key, just for " +
        "this install -- takes about two minutes to get.";

    modal.appendChild(explanation);


    const steps =
        document.createElement("ol");

    steps.className =
        "tmdb-setup-steps";

    const stepTexts = [
        "Create a free account at themoviedb.org",
        "Go to Settings -> API",
        "Click \"Request an API Key\", choose the Developer (non-commercial) option",
        "Fill in the short form -- \"Baseflix\" and \"Personal media server\" are fine",
        "Copy the API Key (v3 auth) value and paste it below"
    ];

    for (const stepText of stepTexts) {

        const li =
            document.createElement("li");

        li.textContent =
            stepText;

        steps.appendChild(li);

    }

    modal.appendChild(steps);


    const linkButton =
        document.createElement("button");

    linkButton.type =
        "button";

    linkButton.className =
        "cleanup-keep-button";

    linkButton.textContent =
        "Open TMDB API settings \u2197";

    linkButton.onclick = () => {

        window.open(
            "https://www.themoviedb.org/settings/api",
            "_blank"
        );

    };

    modal.appendChild(linkButton);


    const keyLabel =
        document.createElement("label");

    keyLabel.textContent =
        "API Key (v3 auth)";

    keyLabel.style.marginTop =
        "16px";

    const keyInput =
        document.createElement("input");

    keyInput.type =
        "text";

    keyInput.placeholder =
        "Paste your TMDB API key here";

    modal.appendChild(keyLabel);

    modal.appendChild(keyInput);


    const feedback =
        document.createElement("div");

    feedback.className =
        "tmdb-setup-feedback";

    modal.appendChild(feedback);


    const buttonRow =
        document.createElement("div");

    buttonRow.className =
        "metadata-modal-buttons";


    const cancelButton =
        document.createElement("button");

    cancelButton.className =
        "cleanup-keep-button";

    cancelButton.textContent =
        "Close";

    cancelButton.onclick = () => overlay.remove();


    const saveButton =
        document.createElement("button");

    saveButton.className =
        "cleanup-delete-button";

    saveButton.textContent =
        "Test & Save";

    saveButton.onclick = async () => {

        feedback.textContent = "";

        feedback.className =
            "tmdb-setup-feedback";

        if (!keyInput.value.trim()) {

            feedback.textContent =
                "Paste your API key first.";

            feedback.className =
                "tmdb-setup-feedback tmdb-setup-error";

            return;

        }


        const adminKey =
            getAdminKey(
                "Enter admin key to save this setting:"
            );

        if (!adminKey) {

            return;

        }


        saveButton.disabled = true;

        saveButton.textContent =
            "Testing...";


        try {

            const response =
                await fetch(
                    "/api/settings/tmdb-key",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-admin-key": adminKey
                        },
                        body: JSON.stringify({
                            apiKey: keyInput.value
                        })
                    }
                );

            const body =
                await response.json();

            if (!response.ok) {

                if (response.status === 403) {

                    clearCachedAdminKey();

                }

                feedback.textContent =
                    body.error || "Could not save this key.";

                feedback.className =
                    "tmdb-setup-feedback tmdb-setup-error";

                saveButton.disabled = false;

                saveButton.textContent =
                    "Test & Save";

                return;

            }


            feedback.textContent =
                "Saved! Movie details lookup is ready to use.";

            feedback.className =
                "tmdb-setup-feedback tmdb-setup-success";

            saveButton.textContent =
                "Saved";

        }

        catch (error) {

            console.error(
                "Could not save TMDB key:",
                error
            );

            feedback.textContent =
                "Could not reach the server. Try again.";

            feedback.className =
                "tmdb-setup-feedback tmdb-setup-error";

            saveButton.disabled = false;

            saveButton.textContent =
                "Test & Save";

        }

    };


    buttonRow.appendChild(cancelButton);

    buttonRow.appendChild(saveButton);

    modal.appendChild(buttonRow);


    // ----------------------------------------------------
    // BULK POPULATE -- runs populate-from-web across every
    // not-yet-identified video in the library, one at a time,
    // in the background. Never touches anything already
    // identified (manually or previously fetched).
    // ----------------------------------------------------

    const bulkHeading =
        document.createElement("h3");

    bulkHeading.style.marginTop =
        "24px";

    bulkHeading.textContent =
        "Bulk populate";

    modal.appendChild(bulkHeading);


    const bulkExplanation =
        document.createElement("p");

    bulkExplanation.className =
        "tmdb-setup-explanation";

    bulkExplanation.textContent =
        "Fetch details automatically for every video in your " +
        "library that hasn't been identified yet. Anything " +
        "already populated -- fetched before or entered " +
        "manually -- is left untouched.";

    modal.appendChild(bulkExplanation);


    const bulkButton =
        document.createElement("button");

    bulkButton.type =
        "button";

    bulkButton.className =
        "cleanup-delete-button";

    bulkButton.textContent =
        "Populate entire library";

    modal.appendChild(bulkButton);


    const bulkProgress =
        document.createElement("div");

    bulkProgress.className =
        "tmdb-setup-feedback";

    modal.appendChild(bulkProgress);


    let bulkPollTimer = null;

    async function pollBulkStatus() {

        try {

            const response =
                await fetch("/api/bulk-populate-status");

            const status =
                await response.json();

            if (status.running) {

                bulkProgress.textContent =
                    `Populating: ${status.completed} / ${status.total}` +
                    (status.currentVideo
                        ? ` -- ${stripVideoExtension(status.currentVideo)}`
                        : "");

                bulkProgress.className =
                    "tmdb-setup-feedback";

                return;

            }


            clearInterval(bulkPollTimer);

            bulkButton.disabled = false;

            bulkButton.textContent =
                "Populate entire library";

            if (status.total === 0) {

                bulkProgress.textContent =
                    "Nothing to populate -- everything's already " +
                    "identified.";

                bulkProgress.className =
                    "tmdb-setup-feedback";

                return;

            }


            let summary =
                `Done -- ${status.succeeded} populated`;

            if (status.failed > 0) {

                summary +=
                    `, ${status.failed} could not be matched`;

            }

            if (status.stoppedReason) {

                summary +=
                    `. Stopped early: ${status.stoppedReason}`;

            }

            bulkProgress.textContent =
                summary;

            bulkProgress.className =
                status.failed > 0 || status.stoppedReason
                    ? "tmdb-setup-feedback tmdb-setup-error"
                    : "tmdb-setup-feedback tmdb-setup-success";

            refreshCurrentView();

        }

        catch (error) {

            console.error(
                "Could not check bulk populate status:",
                error
            );

        }

    }

    bulkButton.onclick = async () => {

        const adminKey =
            getAdminKey(
                "Enter admin key to bulk populate the library:"
            );

        if (!adminKey) {

            return;

        }


        bulkButton.disabled = true;

        bulkButton.textContent =
            "Starting...";

        bulkProgress.textContent =
            "";


        try {

            const response =
                await fetch(
                    "/api/bulk-populate-from-web",
                    {
                        method: "POST",
                        headers: { "x-admin-key": adminKey }
                    }
                );

            const body =
                await response.json();

            if (!response.ok) {

                if (response.status === 403) {

                    clearCachedAdminKey();

                }

                alert(
                    body.error ||
                    "Could not start bulk populate."
                );

                bulkButton.disabled = false;

                bulkButton.textContent =
                    "Populate entire library";

                return;

            }

            if (body.total === 0) {

                bulkProgress.textContent =
                    "Nothing to populate -- everything's already " +
                    "identified.";

                bulkButton.disabled = false;

                bulkButton.textContent =
                    "Populate entire library";

                return;

            }


            bulkButton.textContent =
                "Running...";

            bulkPollTimer =
                setInterval(pollBulkStatus, 1500);

            pollBulkStatus();

        }

        catch (error) {

            console.error(
                "Could not start bulk populate:",
                error
            );

            alert(
                "Could not start bulk populate."
            );

            bulkButton.disabled = false;

            bulkButton.textContent =
                "Populate entire library";

        }

    };


    overlay.appendChild(modal);

    document.body.appendChild(overlay);

}


function openMetadataEditor(video) {

    const overlay =
        document.createElement("div");

    overlay.className =
        "metadata-modal-overlay";

    overlay.onclick = (event) => {

        if (event.target === overlay) {

            overlay.remove();

        }

    };


    const modal =
        document.createElement("div");

    modal.className =
        "metadata-modal";

    modal.onclick = (event) => event.stopPropagation();


    const heading =
        document.createElement("h3");

    heading.textContent =
        "Edit details";

    modal.appendChild(heading);


    const populateLink =
        document.createElement("button");

    populateLink.type =
        "button";

    populateLink.className =
        "populate-from-web-link";

    populateLink.textContent =
        "\u21BB Populate from web";

    populateLink.onclick = async () => {

        populateLink.disabled = true;

        populateLink.textContent =
            "Checking...";

        let keyStatus;

        try {

            const statusResponse =
                await fetch("/api/settings/tmdb-key");

            keyStatus =
                await statusResponse.json();

        }

        catch (error) {

            console.error(
                "Could not check TMDB key status:",
                error
            );

        }


        if (!keyStatus || !keyStatus.configured) {

            populateLink.disabled = false;

            populateLink.textContent =
                "\u21BB Populate from web";

            openTmdbSetupModal();

            return;

        }


        populateLink.textContent =
            "Fetching...";


        try {

            const adminKey =
                getAdminKey(
                    "Enter admin key to fetch details from the web:"
                );

            if (!adminKey) {

                populateLink.disabled = false;

                populateLink.textContent =
                    "\u21BB Populate from web";

                return;

            }


            const response =
                await fetch(
                    `/api/videos/${video.id}/populate-from-web`,
                    {
                        method: "POST",
                        headers: { "x-admin-key": adminKey }
                    }
                );

            const body =
                await response.json();

            if (!response.ok) {

                if (response.status === 403) {

                    clearCachedAdminKey();

                }

                if (body.error === "no_api_key") {

                    openTmdbSetupModal();

                }

                else {

                    alert(
                        body.error ||
                        "Could not fetch details from the web."
                    );

                }

                populateLink.disabled = false;

                populateLink.textContent =
                    "\u21BB Populate from web";

                return;

            }


            // Reflect the fetched values immediately, so Save
            // (still required to persist) shows what was found.
            titleInput.value =
                body.metadata.title || titleInput.value;

            overviewInput.value =
                body.metadata.overview || overviewInput.value;

            if (body.metadata.year) {

                yearInput.value =
                    body.metadata.year;

            }

            if (body.metadata.genres) {

                genresInput.value =
                    body.metadata.genres;

            }

            if (body.metadata.tagline) {

                taglineInput.value =
                    body.metadata.tagline;

            }

            if (body.metadata.director) {

                directorInput.value =
                    body.metadata.director;

            }

            if (body.metadata.writers) {

                writersInput.value =
                    body.metadata.writers;

            }

            if (body.metadata.studio) {

                studioInput.value =
                    body.metadata.studio;

            }


            populateLink.textContent =
                "\u2713 Fetched -- click Save to keep it";

        }

        catch (error) {

            console.error(
                "Could not populate from web:",
                error
            );

            alert(
                "Could not fetch details from the web."
            );

            populateLink.disabled = false;

            populateLink.textContent =
                "\u21BB Populate from web";

        }

    };

    modal.appendChild(populateLink);


    // ----------------------------------------------------
    // MANUAL SEARCH -- Jellyfin-style: type (or accept the
    // pre-filled guess), see real candidate matches, pick the
    // right one yourself instead of trusting an automatic guess.
    // ----------------------------------------------------

    const searchToggle =
        document.createElement("button");

    searchToggle.type =
        "button";

    searchToggle.className =
        "populate-from-web-link";

    searchToggle.style.marginLeft =
        "10px";

    searchToggle.textContent =
        "\u{1F50D} Search manually";

    searchToggle.onclick = () => {

        searchPanel.style.display =
            searchPanel.style.display === "none"
                ? "block"
                : "none";

    };

    modal.appendChild(searchToggle);


    const searchPanel =
        document.createElement("div");

    searchPanel.className =
        "tmdb-search-panel";

    searchPanel.style.display =
        "none";


    const searchRow =
        document.createElement("div");

    searchRow.className =
        "tmdb-search-row";

    const searchInput =
        document.createElement("input");

    searchInput.type =
        "text";

    searchInput.value =
        video.custom_title || stripVideoExtension(video.name);

    searchRow.appendChild(searchInput);

    const searchButton =
        document.createElement("button");

    searchButton.type =
        "button";

    searchButton.className =
        "cleanup-keep-button";

    searchButton.textContent =
        "Search";

    searchRow.appendChild(searchButton);

    searchPanel.appendChild(searchRow);


    const resultsList =
        document.createElement("div");

    resultsList.className =
        "tmdb-results-list";

    searchPanel.appendChild(resultsList);


    function createTmdbResultRow(result) {

        const row =
            document.createElement("div");

        row.className =
            "tmdb-result-row";

        row.onclick = async () => {

            const adminKey =
                getAdminKey(
                    "Enter admin key to apply this match:"
                );

            if (!adminKey) {

                return;

            }


            try {

                const response =
                    await fetch(
                        `/api/videos/${video.id}/apply-tmdb-match`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "x-admin-key": adminKey
                            },
                            body: JSON.stringify({
                                tmdbId: result.tmdbId
                            })
                        }
                    );

                const body =
                    await response.json();

                if (!response.ok) {

                    if (response.status === 403) {

                        clearCachedAdminKey();

                    }

                    alert(
                        body.error ||
                        "Could not apply this match."
                    );

                    return;

                }


                titleInput.value =
                    body.metadata.title || titleInput.value;

                overviewInput.value =
                    body.metadata.overview || overviewInput.value;

                if (body.metadata.year) {

                    yearInput.value =
                        body.metadata.year;

                }

                if (body.metadata.genres) {

                    genresInput.value =
                        body.metadata.genres;

                }

                if (body.metadata.tagline) {

                    taglineInput.value =
                        body.metadata.tagline;

                }

                if (body.metadata.director) {

                    directorInput.value =
                        body.metadata.director;

                }

                if (body.metadata.writers) {

                    writersInput.value =
                        body.metadata.writers;

                }

                if (body.metadata.studio) {

                    studioInput.value =
                        body.metadata.studio;

                }


                searchPanel.style.display =
                    "none";

            }

            catch (error) {

                console.error(
                    "Could not apply TMDB match:",
                    error
                );

                alert(
                    "Could not apply this match."
                );

            }

        };


        const thumb =
            document.createElement("div");

        thumb.className =
            "tmdb-result-thumb";

        if (result.posterThumb) {

            thumb.style.backgroundImage =
                `url("${result.posterThumb}")`;

        }

        row.appendChild(thumb);


        const info =
            document.createElement("div");

        info.className =
            "tmdb-result-info";

        const resultTitle =
            document.createElement("div");

        resultTitle.className =
            "tmdb-result-title";

        resultTitle.textContent =
            result.title +
            (result.year ? ` (${result.year})` : "");

        info.appendChild(resultTitle);

        if (result.overview) {

            const resultOverview =
                document.createElement("div");

            resultOverview.className =
                "tmdb-result-overview";

            resultOverview.textContent =
                result.overview;

            info.appendChild(resultOverview);

        }

        row.appendChild(info);


        return row;

    }


    searchButton.onclick = async () => {

        const query =
            searchInput.value.trim();

        if (!query) {

            return;

        }


        const adminKey =
            getAdminKey(
                "Enter admin key to search TMDB:"
            );

        if (!adminKey) {

            return;

        }


        resultsList.textContent =
            "";

        searchButton.disabled = true;

        searchButton.textContent =
            "Searching...";


        try {

            const response =
                await fetch(
                    `/api/videos/${video.id}/tmdb-search?query=${encodeURIComponent(query)}`,
                    {
                        headers: { "x-admin-key": adminKey }
                    }
                );

            const body =
                await response.json();

            if (!response.ok) {

                if (response.status === 403) {

                    clearCachedAdminKey();

                }

                if (body.error === "no_api_key") {

                    openTmdbSetupModal();

                }

                else {

                    alert(
                        body.error || "Could not search TMDB."
                    );

                }

            }

            else if (!body.results || body.results.length === 0) {

                const noResults =
                    document.createElement("div");

                noResults.className =
                    "tmdb-no-results";

                noResults.textContent =
                    "No matches found.";

                resultsList.appendChild(noResults);

            }

            else {

                for (const result of body.results) {

                    resultsList.appendChild(
                        createTmdbResultRow(result)
                    );

                }

            }

        }

        catch (error) {

            console.error(
                "Could not search TMDB:",
                error
            );

            alert(
                "Could not search TMDB."
            );

        }

        searchButton.disabled = false;

        searchButton.textContent =
            "Search";

    };


    modal.appendChild(searchPanel);


    const titleLabel =
        document.createElement("label");

    titleLabel.textContent =
        "Title";

    const titleInput =
        document.createElement("input");

    titleInput.type =
        "text";

    titleInput.value =
        video.custom_title || "";

    titleInput.placeholder =
        stripVideoExtension(video.name);

    modal.appendChild(titleLabel);

    modal.appendChild(titleInput);


    const dateLabel =
        document.createElement("label");

    dateLabel.textContent =
        "Date";

    const dateInput =
        document.createElement("input");

    dateInput.type =
        "text";

    dateInput.value =
        video.custom_date || "";

    dateInput.placeholder =
        "e.g. Mon, Sep 25, 2017";

    modal.appendChild(dateLabel);

    modal.appendChild(dateInput);


    const overviewLabel =
        document.createElement("label");

    overviewLabel.textContent =
        "Overview";

    const overviewInput =
        document.createElement("textarea");

    overviewInput.value =
        video.overview || "";

    overviewInput.rows =
        4;

    modal.appendChild(overviewLabel);

    modal.appendChild(overviewInput);


    function addTextField(labelText, existingValue) {

        const label =
            document.createElement("label");

        label.textContent =
            labelText;

        const input =
            document.createElement("input");

        input.type =
            "text";

        input.value =
            existingValue || "";

        modal.appendChild(label);

        modal.appendChild(input);

        return input;

    }

    const yearInput =
        addTextField("Year", video.release_year);

    const genresInput =
        addTextField(
            "Genres (comma-separated)",
            video.genres
        );

    const taglineInput =
        addTextField("Tagline", video.tagline);

    const directorInput =
        addTextField("Director", video.director);

    const writersInput =
        addTextField(
            "Writers (comma-separated)",
            video.writers
        );

    const studioInput =
        addTextField("Studio", video.studio);


    const buttonRow =
        document.createElement("div");

    buttonRow.className =
        "metadata-modal-buttons";


    const cancelButton =
        document.createElement("button");

    cancelButton.className =
        "cleanup-keep-button";

    cancelButton.textContent =
        "Cancel";

    cancelButton.onclick = () => overlay.remove();


    const saveButton =
        document.createElement("button");

    saveButton.className =
        "cleanup-delete-button";

    saveButton.textContent =
        "Save";

    saveButton.onclick = async () => {

        const adminKey =
            getAdminKey(
                "Enter admin key to save these details:"
            );

        if (!adminKey) {

            return;

        }


        try {

            const response =
                await fetch(
                    `/api/videos/${video.id}/metadata`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-admin-key": adminKey
                        },
                        body: JSON.stringify({
                            title: titleInput.value,
                            overview: overviewInput.value,
                            date: dateInput.value,
                            year: yearInput.value,
                            genres: genresInput.value,
                            tagline: taglineInput.value,
                            director: directorInput.value,
                            writers: writersInput.value,
                            studio: studioInput.value
                        })
                    }
                );

            if (!response.ok) {

                if (response.status === 403) {

                    clearCachedAdminKey();

                }

                const body =
                    await response.json();

                alert(
                    body.error ||
                    "Could not save details."
                );

                return;

            }

        }

        catch (error) {

            console.error(
                "Could not save metadata:",
                error
            );

            alert(
                "Could not save details."
            );

            return;

        }


        overlay.remove();

        refreshCurrentView();

    };


    buttonRow.appendChild(cancelButton);

    buttonRow.appendChild(saveButton);

    modal.appendChild(buttonRow);


    overlay.appendChild(modal);

    document.body.appendChild(overlay);

}


function createVideoListItem(video, progressPercent, metaText) {

    const item =
        document.createElement("div");

    item.className =
        "video-list-item";

    item.onclick = () => openPlayer(video);


    let thumbnail;

    if (video.poster) {

        thumbnail =
            document.createElement("div");

        thumbnail.className =
            "video-list-thumbnail";

        thumbnail.style.backgroundImage =
            `url("${video.poster}")`;

    }

    else {

        // Fallback for anything not scanned/thumbnailed yet --
        // matches the same graceful-degradation pattern used for
        // grid cards elsewhere in the app.
        thumbnail =
            document.createElement("div");

        thumbnail.className =
            "video-list-play";

        thumbnail.textContent =
            "\u25B6";

    }


    const info =
        document.createElement("div");

    info.className =
        "video-list-info";


    // Title + date on one line, like "S1.E1 - Burnt Food ... Mon,
    // Sep 25, 2017" -- date only appears once manually set via the
    // "..." edit menu.
    const titleRow =
        document.createElement("div");

    titleRow.className =
        "video-list-title-row";


    const title =
        document.createElement("div");

    title.className =
        "video-list-title";

    title.textContent =
        video.custom_title || stripVideoExtension(video.name);

    titleRow.appendChild(title);


    if (video.custom_date) {

        const dateEl =
            document.createElement("div");

        dateEl.className =
            "video-list-date";

        dateEl.textContent =
            video.custom_date;

        titleRow.appendChild(dateEl);

    }

    info.appendChild(titleRow);


    if (metaText) {

        const meta =
            document.createElement("div");

        meta.className =
            "video-list-meta";

        meta.textContent =
            metaText;

        info.appendChild(meta);

    }


    if (video.overview) {

        const overview =
            document.createElement("div");

        overview.className =
            "video-list-overview";

        overview.textContent =
            video.overview;

        info.appendChild(overview);

    }


    if (progressPercent != null) {

        const track =
            document.createElement("div");

        track.className =
            "video-progress";

        const fill =
            document.createElement("div");

        fill.className =
            "video-progress-fill";

        fill.style.width =
            Math.min(100, Math.max(0, progressPercent)) + "%";

        track.appendChild(fill);

        info.appendChild(track);

    }


    item.appendChild(thumbnail);

    item.appendChild(info);

    const listMetaButton =
        createMetadataButton(video);

    if (listMetaButton) {

        item.appendChild(listMetaButton);

    }


    return item;

}


/*
    Fully recursive folder browser: every level, whether it's a
    top-level category ("Movies") or several clicks deep ("Shows/
    Breaking Bad/Season 1"), works the same way -- any child
    subfolders found become clickable tiles you drill into, and
    any video files that live directly at this level (no further
    subfolder) get rendered here.

    Direct video files render as a grid when this level sits
    right under a top-level category (e.g. "Movies/English") --
    matching how movie posters have looked all along -- and as a
    compact list once you're two or more levels deep (e.g. "Shows/
    Breaking Bad/Season 1"), which reads much better for a season's
    worth of episodes than a poster grid would.
*/
async function renderFolder(folderPath, showBackButton) {

    currentFolder = folderPath;
    currentDetailsVideoId = null;

    if (showBackButton == null) {

        showBackButton = true;

    }

    currentShowBackButton = showBackButton;


    try {

        const response =
            await fetch("/api/videos");

        const videos =
            await response.json();


        const pathSegments =
            folderPath.split("/");


        const relevantVideos =
            videos.filter((video) => {

                const videoFolder =
                    normalizeFolderPath(video.folder);

                return (
                    videoFolder === folderPath ||
                    videoFolder.startsWith(folderPath + "/")
                );

            });


        // Split into "directly at this level" vs "one level
        // deeper", the latter grouped by that immediate child
        // folder's name.
        const directVideos = [];
        const byChildFolder = {};

        for (const video of relevantVideos) {

            const videoFolder =
                normalizeFolderPath(video.folder);

            if (videoFolder === folderPath) {

                directVideos.push(video);
                continue;

            }

            const rest =
                videoFolder.slice(folderPath.length + 1);

            const childName =
                rest.split("/")[0];

            if (!byChildFolder[childName]) {

                byChildFolder[childName] = [];

            }

            byChildFolder[childName].push(video);

        }


        const content =
            document.querySelector(".content");

        content.innerHTML = "";


        if (showBackButton) {

            const backLink =
                document.createElement("a");

            backLink.className =
                "back-button";

            const parentSegments =
                pathSegments.slice(0, -1);

            backLink.textContent =
                parentSegments.length === 0
                    ? "\u2190 My Media"
                    : "\u2190 " + parentSegments[parentSegments.length - 1];

            backLink.href =
                "#";

            backLink.onclick = (event) => {

                event.preventDefault();

                // Let the browser's own history mechanism handle
                // this -- it'll fire popstate, which re-renders
                // via the exact same code path a real Back-button
                // press uses. Keeps our own back link and the
                // browser's native Back button perfectly in sync.
                window.history.back();

            };

            content.appendChild(backLink);

        }


        const pageHeading =
            document.createElement("h2");

        pageHeading.className =
            "folder-title";

        pageHeading.textContent =
            pathSegments[pathSegments.length - 1];

        content.appendChild(pageHeading);


        // ----------------------------------------------------
        // CHILD FOLDERS -- always clickable tiles, at any depth
        // ----------------------------------------------------

        const childNames =
            Object.keys(byChildFolder).sort();

        if (childNames.length > 0) {

            const section =
                document.createElement("section");

            section.className =
                "video-section";

            const grid =
                document.createElement("div");

            grid.className =
                "library-grid";

            for (const childName of childNames) {

                grid.appendChild(
                    createFolderCard(
                        childName,
                        folderPath + "/" + childName,
                        byChildFolder[childName]
                    )
                );

            }

            section.appendChild(grid);

            content.appendChild(section);

        }


        // ----------------------------------------------------
        // VIDEOS DIRECTLY AT THIS LEVEL
        // ----------------------------------------------------

        if (directVideos.length > 0) {

            const section =
                document.createElement("section");

            section.className =
                "video-section";

            // One level under a top-level category (e.g.
            // "Movies/English", 2 segments) -> grid, matching how
            // movies have always looked. Deeper than that (e.g.
            // "Shows/Breaking Bad/Season 1", 3+ segments) -> list,
            // which reads better for a season's worth of episodes.
            const useList =
                pathSegments.length >= 3;

            const container =
                document.createElement("div");

            container.className =
                useList ? "video-list" : "video-grid";


            // Look up watch status (in-progress / completed / never
            // started) for exactly these videos, so episodes show
            // the same progress indication Continue Watching does
            // on the home page, plus a duration/watched line for
            // the list view. Scoped to just this folder's videos --
            // not the capped-at-10 recently-watched list -- so an
            // older completed episode still shows correctly.
            let statusByVideoId = {};

            try {

                const videoIds =
                    directVideos.map(v => v.id).join(",");

                const statusResponse =
                    await fetch(
                        `/api/watch-status/${profileContext.id}?videoIds=${videoIds}`
                    );

                if (statusResponse.ok) {

                    statusByVideoId =
                        await statusResponse.json();

                }

            }

            catch (error) {

                console.error(
                    "Could not load watch status:",
                    error
                );

            }


            for (const video of directVideos) {

                const statusInfo =
                    statusByVideoId[video.id];

                const progressPercent =
                    statusInfo && statusInfo.status === "in_progress"
                        ? (statusInfo.position / statusInfo.duration) * 100
                        : null;

                container.appendChild(
                    useList
                        ? createVideoListItem(
                            video,
                            progressPercent,
                            formatWatchMeta(video, statusInfo)
                        )
                        : createVideoCard(video, progressPercent)
                );

            }

            section.appendChild(container);

            content.appendChild(section);

        }

    }

    catch (error) {

        console.error(
            "Could not load folder:",
            error
        );

    }

}


// ============================================================
// START APP
// ============================================================
// ============================================================
// START BASEFLIX
// ============================================================

(async () => {

    const valid =
        await validateActiveProfile();


    if (!valid) {

        return;

    }


    const logo =
        document.getElementById("baseflixLogo");

    if (logo) {

        logo.onclick = () => navigateHome();

    }


    const settingsButton =
        document.getElementById("settingsButton");

    if (settingsButton) {

        // Settings (TMDB key, bulk populate) are admin-only. Hide
        // the gear entirely for non-admin profiles rather than
        // letting them open a panel they can't use.
        if (isAdmin) {

            settingsButton.onclick = () => openTmdbSetupModal();

        }

        else {

            settingsButton.style.display = "none";

        }

    }


    const rendered =
        await renderHome();

    // replaceState (not pushState) for the very first view --
    // this establishes the baseline history entry to build on,
    // without creating a spurious extra step Back would have to
    // click through to leave the app entirely.
    window.history.replaceState(
        rendered || { view: "home" },
        "",
        "#"
    );

})();

