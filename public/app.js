async function loadVideos() {

    try {

        const response =
            await fetch("/api/videos");

        const videos =
            await response.json();


        const content =
            document.querySelector(".content");


        content.innerHTML = "";


        /*
            Group videos by folder
        */

        const folders = {};


        for (const video of videos) {

            const folder =
                video.folder || "Home";


            if (!folders[folder]) {

                folders[folder] = [];

            }


            folders[folder].push(video);

        }


        /*
            Create one section for each folder
        */

        for (const folder of Object.keys(folders)) {

            const section =
                document.createElement("section");

            section.className =
                "video-section";


            /*
                Folder heading
            */

            const heading =
                document.createElement("h2");

            heading.className =
                "folder-title";

            heading.textContent =
                folder;


            /*
                Video grid
            */

            const grid =
                document.createElement("div");

            grid.className =
                "video-grid";


            /*
                Create cards
            */

            for (const video of folders[folder]) {

                const card =
                    document.createElement("div");

                card.className =
                    "video-card";


                card.onclick = async () => {

    /*
        ============================================================
        BASEFLIX VIDEO PLAYER
        ============================================================

        Desktop:
        - Normal video controls
        - Keyboard seeking

        Mobile:
        - Double tap left  = rewind 10 seconds
        - Double tap right = forward 10 seconds
        - Lock
        - Picture in Picture

        TV:
        - Large pointer-friendly buttons
        - Rewind 10 seconds
        - Play / Pause
        - Forward 10 seconds
    */


    // ============================================================
    // PLAYER CONTAINER
    // ============================================================

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


    // ============================================================
    // VIDEO
    // ============================================================

    const player =
        document.createElement("video");

    player.src =
        "/video/" +
        encodeURIComponent(
            video.relative_path
        );

    player.controls =
        true;

    player.autoplay =
        true;

    player.playsInline =
        true;

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


    // ============================================================
    // STATE
    // ============================================================

    let isStopping =
        false;

    let isLocked =
        false;

    let lastTapTime =
        0;

    let lastTapSide =
        null;


    // ============================================================
    // STOP VIDEO
    // ============================================================

    const stopVideo = () => {

        if (isStopping) {

            return;

        }

        isStopping =
            true;


        console.log(
            "🛑 Stopping Baseflix video"
        );


        player.pause();

        player.currentTime =
            0;

        player.removeAttribute(
            "src"
        );

        player.load();


        document.removeEventListener(
            "keydown",
            handleKeyDown
        );


        document.removeEventListener(
            "fullscreenchange",
            handleFullscreenChange
        );


        playerContainer.remove();

    };


    // ============================================================
    // FORWARD 10 SECONDS
    // ============================================================

    const forward10 = () => {

        if (
            isStopping ||
            isLocked
        ) {

            return;

        }


        if (
            Number.isFinite(
                player.duration
            )
        ) {

            player.currentTime =
                Math.min(
                    player.currentTime + 10,
                    player.duration
                );

        } else {

            player.currentTime += 10;

        }


        console.log(
            "⏩ Forward 10 seconds"
        );

    };


    // ============================================================
    // REWIND 10 SECONDS
    // ============================================================

    const rewind10 = () => {

        if (
            isStopping ||
            isLocked
        ) {

            return;

        }


        player.currentTime =
            Math.max(
                player.currentTime - 10,
                0
            );


        console.log(
            "⏪ Rewind 10 seconds"
        );

    };


    // ============================================================
    // PLAY / PAUSE
    // ============================================================

    const togglePlayPause = () => {

        if (
            isStopping ||
            isLocked
        ) {

            return;

        }


        if (player.paused) {

            player.play().catch(
                error => {

                    console.log(
                        "Play failed:",
                        error
                    );

                }
            );

        } else {

            player.pause();

        }

    };


    

    // ============================================================
    // MOBILE DOUBLE TAP
    // ============================================================

    player.addEventListener(
        "touchend",
        event => {

            if (
                isStopping ||
                isLocked
            ) {

                return;

            }


            const now =
                Date.now();


            const rect =
                player.getBoundingClientRect();


            const touch =
                event.changedTouches[0];


            const x =
                touch.clientX -
                rect.left;


            const side =
                x <
                rect.width / 2
                    ? "left"
                    : "right";


            const elapsed =
                now -
                lastTapTime;


            if (
                elapsed < 350 &&
                lastTapSide === side
            ) {

                event.preventDefault();


                if (side === "left") {

                    rewind10();

                } else {

                    forward10();

                }


                lastTapTime =
                    0;

                lastTapSide =
                    null;

                return;

            }


            lastTapTime =
                now;

            lastTapSide =
                side;

        },
        {
            passive: false
        }
    );


    // ============================================================
    // MOBILE CONTROL BUTTONS
    // ============================================================

    const mobileControls =
        document.createElement("div");


    mobileControls.style.position =
        "absolute";

    mobileControls.style.top =
        "15px";

    mobileControls.style.right =
        "15px";

    mobileControls.style.display =
        "flex";

    mobileControls.style.gap =
        "8px";

    mobileControls.style.zIndex =
        "1000001";


    const createMobileButton =
        (text, title) => {

            const button =
                document.createElement("button");


            button.textContent =
                text;

            button.title =
                title;


            button.style.border =
                "none";

            button.style.borderRadius =
                "8px";

            button.style.padding =
                "9px 12px";

            button.style.background =
                "rgba(0,0,0,0.75)";

            button.style.color =
                "white";

            button.style.fontSize =
                "16px";


            return button;

        };


    const lockButton =
        createMobileButton(
            "🔓",
            "Lock video controls"
        );


    const pipButton =
        createMobileButton(
            "▣",
            "Picture in Picture"
        );


    mobileControls.appendChild(
        lockButton
    );

    mobileControls.appendChild(
        pipButton
    );


    playerContainer.appendChild(
        mobileControls
    );


    // ============================================================
    // LOCK
    // ============================================================

    lockButton.onclick =
        event => {

            event.preventDefault();

            event.stopPropagation();


            isLocked =
                !isLocked;


            if (isLocked) {

                lockButton.textContent =
                    "🔒";

                lockButton.title =
                    "Unlock video controls";


                player.controls =
                    false;

                tvControls.style.display =
                    "none";


            } else {

                lockButton.textContent =
                    "🔓";

                lockButton.title =
                    "Lock video controls";


                player.controls =
                    true;

                tvControls.style.display =
                    "flex";

            }

        };


    // ============================================================
    // PICTURE IN PICTURE
    // ============================================================

    pipButton.onclick =
        async event => {

            event.preventDefault();

            event.stopPropagation();


            if (isLocked) {

                return;

            }


            try {

                if (
                    document.pictureInPictureEnabled
                ) {

                    if (
                        document.pictureInPictureElement
                    ) {

                        await document
                            .exitPictureInPicture();

                    } else {

                        await player
                            .requestPictureInPicture();

                    }

                }

                else if (
                    typeof player
                        .webkitSetPresentationMode ===
                    "function"
                ) {

                    player.webkitSetPresentationMode(
                        "picture-in-picture"
                    );

                }

            }

            catch (error) {

                console.log(
                    "Picture-in-Picture failed:",
                    error
                );

            }

        };


    // ============================================================
    // KEYBOARD / TV MEDIA KEYS
    // ============================================================

    function handleKeyDown(event) {

        if (isStopping) {

            return;

        }


        switch (
            event.key
        ) {

            case "ArrowLeft":

                event.preventDefault();

                rewind10();

                break;


            case "ArrowRight":

                event.preventDefault();

                forward10();

                break;


            case " ":

            case "Enter":

                event.preventDefault();

                togglePlayPause();

                break;

        }


        switch (
            event.code
        ) {

            case "MediaRewind":

                event.preventDefault();

                rewind10();

                break;


            case "MediaFastForward":

                event.preventDefault();

                forward10();

                break;


            case "MediaPlayPause":

                event.preventDefault();

                togglePlayPause();

                break;

        }

    }


    document.addEventListener(
        "keydown",
        handleKeyDown
    );


    // ============================================================
    // FULLSCREEN EXIT
    // ============================================================

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


    // ============================================================
    // ENTER FULLSCREEN
    // ============================================================

    try {

        await playerContainer.requestFullscreen();

    }

    catch (error) {

        console.log(
            "Fullscreen unavailable:",
            error
        );

    }


    // ============================================================
    // PLAY
    // ============================================================

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

                const preview =
                    document.createElement("video");

                preview.className =
                    "video-preview";

                preview.muted = true;

                preview.preload =
                    "metadata";


                preview.src =
                    "/video/" +
                    encodeURIComponent(
                        video.relative_path
                    );


                const title =
                    document.createElement("div");

                title.className =
                    "video-title";

                title.textContent =
                    video.name;


                card.appendChild(preview);

                card.appendChild(title);

                grid.appendChild(card);

            }


            section.appendChild(heading);

            section.appendChild(grid);

            content.appendChild(section);

        }

    }

    catch (error) {

        console.error(
            "Could not load videos:",
            error
        );

    }

}


loadVideos();