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


                card.onclick = () => {

                    window.location.href =
                        "/watch/" +
                        encodeURIComponent(
                            video.relative_path
                        );

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