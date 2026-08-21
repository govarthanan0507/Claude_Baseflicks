async function loadVideos() {

    try {

        const response =
            await fetch("/api/videos");

        const videos =
            await response.json();


        const content =
            document.querySelector(".content");


        content.innerHTML = "";


        // ============================================================
        // GROUP VIDEOS BY FOLDER
        // ============================================================

        const folders = {};


        for (const video of videos) {

            const folder =
                video.folder || "Home";


            if (!folders[folder]) {

                folders[folder] = [];

            }


            folders[folder].push(video);

        }


        // ============================================================
        // CREATE FOLDER SECTIONS
        // ============================================================

        for (const folder of Object.keys(folders)) {

            const section =
                document.createElement("section");

            section.className =
                "video-section";


            // ========================================================
            // FOLDER TITLE
            // ========================================================

            const heading =
                document.createElement("h2");

            heading.className =
                "folder-title";

            heading.textContent =
                folder;


            // ========================================================
            // VIDEO GRID
            // ========================================================

            const grid =
                document.createElement("div");

            grid.className =
                "video-grid";


            // ========================================================
            // CREATE VIDEO CARDS
            // ========================================================

            for (const video of folders[folder]) {

                const card =
                    document.createElement("div");

                card.className =
                    "video-card";


                // ====================================================
                // VIDEO CLICK
                // Feature 1: Automatic Fullscreen
                // ====================================================

                card.onclick = async () => {

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


                    player.src =
                        "/video/" +
                        encodeURIComponent(
                            video.relative_path
                        );


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


                    // =================================================
                    // STOP VIDEO
                    // =================================================

                    const stopVideo = () => {

                        if (isStopping) {

                            return;

                        }


                        isStopping = true;


                        console.log(
                            "Stopping video"
                        );


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

                };


                // ====================================================
                // VIDEO PREVIEW
                // ====================================================

                const preview =
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


                // ====================================================
                // VIDEO TITLE
                // ====================================================

                const title =
                    document.createElement("div");


                title.className =
                    "video-title";


                title.textContent =
                    video.name;


                // ====================================================
                // ADD TO CARD
                // ====================================================

                card.appendChild(
                    preview
                );


                card.appendChild(
                    title
                );


                grid.appendChild(
                    card
                );

            }


            // ========================================================
            // ADD SECTION
            // ========================================================

            section.appendChild(
                heading
            );


            section.appendChild(
                grid
            );


            content.appendChild(
                section
            );

        }

    }

    catch (error) {

        console.error(
            "Could not load videos:",
            error
        );

    }

}


// ============================================================
// START APP
// ============================================================

loadVideos();