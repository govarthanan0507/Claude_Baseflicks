// ============================================================
// BASEFLIX PROFILE PAGE
// ============================================================


// ============================================================
// AVAILABLE PROFILE AVATARS
// ============================================================

const profileAvatars = [

    "🐶",
    "🐱",
    "🦁",
    "🐯",
    "🐼",
    "🐨",
    "🐸",
    "🦊"

];


// ============================================================
// LOAD PROFILES
// ============================================================

async function loadProfiles() {

    try {

        const response =
            await fetch("/api/profiles");


        if (!response.ok) {

            throw new Error(
                "Could not load profiles"
            );

        }


        const profiles =
            await response.json();


        const profileGrid =
            document.querySelector(
                "#profileGrid"
            );


        if (!profileGrid) {

            console.error(
                "Profile grid not found"
            );

            return;

        }


        profileGrid.innerHTML = "";


        // ========================================================
        // CREATE PROFILE CARDS
        // ========================================================

        for (
            const profile
            of profiles
        ) {

            const card =
                document.createElement("div");


            card.className =
                "profile-card";


            // ====================================================
            // AVATAR
            // ====================================================

            const avatar =
                document.createElement("div");


            avatar.className =
                "profile-avatar";


            avatar.textContent =
                profile.avatar ||
                "🐶";


            // ====================================================
            // PROFILE NAME
            // ====================================================

            const name =
                document.createElement("div");


            name.className =
                "profile-name";


            name.textContent =
                profile.name;


            // ====================================================
            // ADD TO CARD
            // ====================================================

            card.appendChild(
                avatar
            );


            card.appendChild(
                name
            );


            // ====================================================
            // PROFILE CLICK
            // ====================================================

            card.addEventListener(
                "click",
                () => {

                    selectProfile(
                        profile
                    );

                }
            );


            profileGrid.appendChild(
                card
            );

        }

    }

    catch (error) {

        console.error(
            "Could not load profiles:",
            error
        );

    }

}


// ============================================================
// SELECT PROFILE
// ============================================================

function selectProfile(
    profile
) {

    console.log(
        "Selected profile:",
        profile.name
    );


    localStorage.setItem(
        "baseflix_profile",
        JSON.stringify(
            profile
        )
    );


    window.location.href =
        "/index.html";

}


// ============================================================
// SHOW PROFILE MANAGEMENT
// ============================================================

async function showProfileManagement() {

    // Don't create it twice.

    if (
        document.querySelector(
            "#profileManagement"
        )
    ) {

        return;

    }


    // ========================================================
    // ADMIN KEY
    // ========================================================

    const adminKey =
        prompt(
            "Enter Baseflix Admin Key:"
        );


    if (!adminKey) {

        return;

    }


    // ========================================================
    // MANAGEMENT CONTAINER
    // ========================================================

    const management =
        document.createElement("div");


    management.id =
        "profileManagement";


    management.style.marginTop =
        "40px";


    management.style.padding =
        "25px";


    management.style.background =
        "#222";


    management.style.borderRadius =
        "10px";


    management.style.maxWidth =
        "500px";


    management.style.marginLeft =
        "auto";


    management.style.marginRight =
        "auto";


    // ========================================================
    // CREATE PROFILE HEADING
    // ========================================================

    const heading =
        document.createElement("h2");


    heading.textContent =
        "Create Profile";


    // ========================================================
    // NAME INPUT
    // ========================================================

    const nameInput =
        document.createElement("input");


    nameInput.type =
        "text";


    nameInput.placeholder =
        "Profile name";


    nameInput.style.display =
        "block";


    nameInput.style.width =
        "100%";


    nameInput.style.padding =
        "12px";


    nameInput.style.marginTop =
        "15px";


    nameInput.style.boxSizing =
        "border-box";


    // ========================================================
    // AVATAR TITLE
    // ========================================================

    const avatarHeading =
        document.createElement("div");


    avatarHeading.textContent =
        "Choose Avatar";


    avatarHeading.style.marginTop =
        "20px";


    avatarHeading.style.marginBottom =
        "10px";


    avatarHeading.style.fontSize =
        "16px";


    avatarHeading.style.fontWeight =
        "bold";


    // ========================================================
    // SELECTED AVATAR
    // ========================================================

    let selectedAvatar =
        profileAvatars[0];


    // ========================================================
    // AVATAR GRID
    // ========================================================

    const avatarGrid =
        document.createElement("div");


    avatarGrid.style.display =
        "grid";


    avatarGrid.style.gridTemplateColumns =
        "repeat(4, 1fr)";


    avatarGrid.style.gap =
        "10px";


    // ========================================================
    // CREATE AVATAR BUTTONS
    // ========================================================

    for (
        const avatar
        of profileAvatars
    ) {

        const avatarButton =
            document.createElement("button");


        avatarButton.type =
            "button";


        avatarButton.textContent =
            avatar;


        avatarButton.style.fontSize =
            "35px";


        avatarButton.style.padding =
            "10px";


        avatarButton.style.cursor =
            "pointer";


        avatarButton.style.border =
            "2px solid transparent";


        avatarButton.style.borderRadius =
            "10px";


        avatarButton.style.background =
            "#333";


        // ====================================================
        // DEFAULT SELECTION
        // ====================================================

        if (
            avatar === selectedAvatar
        ) {

            avatarButton.style.border =
                "2px solid white";

        }


        // ====================================================
        // AVATAR CLICK
        // ====================================================

        avatarButton.addEventListener(
            "click",
            () => {

                selectedAvatar =
                    avatar;


                const buttons =
                    avatarGrid.querySelectorAll(
                        "button"
                    );


                buttons.forEach(
                    button => {

                        button.style.border =
                            "2px solid transparent";

                    }
                );


                avatarButton.style.border =
                    "2px solid white";

            }
        );


        avatarGrid.appendChild(
            avatarButton
        );

    }


    // ========================================================
    // CREATE BUTTON
    // ========================================================

    const createButton =
        document.createElement("button");


    createButton.type =
        "button";


    createButton.textContent =
        "Create Profile";


    createButton.style.marginTop =
        "20px";


    createButton.style.padding =
        "12px 25px";


    createButton.style.cursor =
        "pointer";


    // ========================================================
    // CREATE STATUS
    // ========================================================

    const status =
        document.createElement("div");


    status.style.marginTop =
        "15px";


    // ========================================================
    // CREATE PROFILE
    // ========================================================

    createButton.addEventListener(
        "click",
        async () => {

            const name =
                nameInput.value.trim();


            if (!name) {

                status.textContent =
                    "Please enter a profile name.";

                return;

            }


            createButton.disabled =
                true;


            status.textContent =
                "Creating profile...";


            try {

                const response =
                    await fetch(
                        "/api/profiles",
                        {

                            method:
                                "POST",

                            headers: {

                                "Content-Type":
                                    "application/json",

                                "x-admin-key":
                                    adminKey

                            },

                            body:
                                JSON.stringify(
                                    {

                                        name:
                                            name,

                                        avatar:
                                            selectedAvatar

                                    }
                                )

                        }
                    );


                const result =
                    await response.json();


                if (!response.ok) {

                    throw new Error(
                        result.error ||
                        "Could not create profile"
                    );

                }


                status.textContent =
                    "Profile created successfully!";


                nameInput.value =
                    "";


                // Reload profile cards.

                await loadProfiles();


                // Reload delete list.

                await loadDeleteProfiles();

            }

            catch (error) {

                console.error(
                    "Could not create profile:",
                    error
                );


                status.textContent =
                    error.message;

            }

            finally {

                createButton.disabled =
                    false;

            }

        }
    );


    // ========================================================
    // ADD CREATE PROFILE ELEMENTS
    // ========================================================

    management.appendChild(
        heading
    );


    management.appendChild(
        nameInput
    );


    management.appendChild(
        avatarHeading
    );


    management.appendChild(
        avatarGrid
    );


    management.appendChild(
        createButton
    );


    management.appendChild(
        status
    );


    // ========================================================
    // DELETE PROFILE HEADING
    // ========================================================

    const deleteHeading =
        document.createElement("h2");


    deleteHeading.textContent =
        "Delete Profile";


    deleteHeading.style.marginTop =
        "35px";


    // ========================================================
    // DELETE PROFILE LIST
    // ========================================================

    const deleteList =
        document.createElement("div");


    deleteList.style.display =
        "flex";


    deleteList.style.flexDirection =
        "column";


    deleteList.style.gap =
        "10px";


    deleteList.style.marginTop =
        "15px";


    // ========================================================
    // LOAD PROFILES FOR DELETE
    // ========================================================

    async function loadDeleteProfiles() {

        try {

            const response =
                await fetch(
                    "/api/profiles"
                );


            if (!response.ok) {

                throw new Error(
                    "Could not load profiles"
                );

            }


            const profiles =
                await response.json();


            deleteList.innerHTML =
                "";


            // ====================================================
            // CREATE DELETE ROWS
            // ====================================================

            for (
                const profile
                of profiles
            ) {

                const row =
                    document.createElement("div");


                row.style.display =
                    "flex";


                row.style.alignItems =
                    "center";


                row.style.justifyContent =
                    "space-between";


                row.style.padding =
                    "10px";


                row.style.background =
                    "#333";


                row.style.borderRadius =
                    "8px";


                // =================================================
                // PROFILE INFORMATION
                // =================================================

                const profileInfo =
                    document.createElement("div");


                profileInfo.textContent =
                    `${profile.avatar || "🐶"} ${profile.name}`;


                profileInfo.style.fontSize =
                    "18px";


                // =================================================
                // DELETE BUTTON
                // =================================================

                const deleteButton =
                    document.createElement("button");


                deleteButton.type =
                    "button";


                // =================================================
                // ADMIN PROTECTION
                // =================================================

                if (
                    profile.name === "Admin"
                ) {

                    deleteButton.textContent =
                        "🔒";


                    deleteButton.disabled =
                        true;


                    deleteButton.title =
                        "Admin cannot be deleted";

                }

                else {

                    deleteButton.textContent =
                        "🗑️";


                    deleteButton.style.cursor =
                        "pointer";


                    deleteButton.title =
                        "Delete profile";


                    // =============================================
                    // DELETE CLICK
                    // =============================================

                    deleteButton.addEventListener(
                        "click",
                        async () => {

                            const confirmed =
                                confirm(
                                    `Delete profile "${profile.name}"?`
                                );


                            if (!confirmed) {

                                return;

                            }


                            deleteButton.disabled =
                                true;


                            deleteButton.textContent =
                                "Deleting...";


                            try {

                                const response =
                                    await fetch(
                                        `/api/profiles/${profile.id}`,
                                        {

                                            method:
                                                "DELETE",

                                            headers: {

                                                "x-admin-key":
                                                    adminKey

                                            }

                                        }
                                    );


                                const result =
                                    await response.json();


                                if (!response.ok) {

                                    throw new Error(
                                        result.error ||
                                        "Could not delete profile"
                                    );

                                }


                                // =================================
                                // REFRESH PROFILE LIST
                                // =================================

                                await loadProfiles();


                                // =================================
                                // REFRESH DELETE LIST
                                // =================================

                                await loadDeleteProfiles();

                            }

                            catch (error) {

                                console.error(
                                    "Could not delete profile:",
                                    error
                                );


                                alert(
                                    error.message
                                );


                                deleteButton.disabled =
                                    false;


                                deleteButton.textContent =
                                    "🗑️";

                            }

                        }
                    );

                }


                row.appendChild(
                    profileInfo
                );


                row.appendChild(
                    deleteButton
                );


                deleteList.appendChild(
                    row
                );

            }

        }

        catch (error) {

            console.error(
                "Could not load delete profiles:",
                error
            );

        }

    }


    // ========================================================
    // ADD DELETE SECTION
    // ========================================================

    management.appendChild(
        deleteHeading
    );


    management.appendChild(
        deleteList
    );


    // ========================================================
    // ADD MANAGEMENT AREA TO PAGE
    // ========================================================

    const container =
        document.querySelector(
            ".profile-container"
        );


    if (!container) {

        console.error(
            "Profile container not found"
        );

        return;

    }


    container.appendChild(
        management
    );


    // ========================================================
    // INITIAL DELETE LIST LOAD
    // ========================================================

    await loadDeleteProfiles();

}


// ============================================================
// MANAGE PROFILES BUTTON
// ============================================================

const manageButton =
    document.querySelector(
        "#manageProfilesButton"
    );


if (manageButton) {

    manageButton.addEventListener(
        "click",
        () => {

            showProfileManagement();

        }
    );

}


// ============================================================
// START PROFILE PAGE
// ============================================================

loadProfiles();
