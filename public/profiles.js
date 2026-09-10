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

async function selectProfile(
    profile
) {

    console.log(
        "Selected profile:",
        profile.name
    );


    // The Admin profile is password-protected. On first-ever use
    // there's no password yet, so prompt to CREATE one; afterwards
    // prompt to log in. The verified password is stashed so the
    // main app can use it as the admin key without re-prompting.
    if (profile.name === "Admin") {

        const unlocked =
            await handleAdminLogin();

        if (!unlocked) {

            // Cancelled or failed -- don't enter the Admin profile.
            return;

        }

    }

    else {

        // Switching to a non-admin profile clears any cached admin
        // credential, so admin controls don't leak across a
        // profile switch.
        localStorage.removeItem("baseflix_admin_key");

    }


    localStorage.setItem(
        "baseflix_profile",
        JSON.stringify(
            profile
        )
    );


    window.location.href =
    `/index.html?profile=${profile.id}`;

}


// Returns true if the Admin profile is unlocked (password created
// or correctly entered), false if the user cancelled or failed.
async function handleAdminLogin() {

    let passwordSet = false;

    try {

        const statusRes =
            await fetch("/api/admin/status");

        const status =
            await statusRes.json();

        passwordSet =
            status.passwordSet;

    }

    catch (error) {

        console.error(
            "Could not check admin status:",
            error
        );

        alert(
            "Could not reach the server to check the admin password."
        );

        return false;

    }


    if (!passwordSet) {

        // First-time setup -- create a password.
        const newPassword =
            prompt(
                "Set an Admin password (at least 4 characters). " +
                "You'll use this to manage your library."
            );

        if (!newPassword) {

            return false;

        }

        if (newPassword.length < 4) {

            alert("Password must be at least 4 characters.");

            return false;

        }

        const confirmPassword =
            prompt("Confirm the Admin password:");

        if (confirmPassword !== newPassword) {

            alert("Passwords didn't match. Try again.");

            return false;

        }


        try {

            const res =
                await fetch(
                    "/api/admin/set-password",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ newPassword })
                    }
                );

            const body =
                await res.json();

            if (!res.ok) {

                alert(body.error || "Could not set password.");

                return false;

            }

        }

        catch (error) {

            console.error("Could not set admin password:", error);

            alert("Could not set the admin password.");

            return false;

        }


        // Cache it so the app uses it as the admin key.
        localStorage.setItem("baseflix_admin_key", newPassword);

        return true;

    }


    // Password already set -- log in.
    const password =
        prompt("Enter the Admin password:");

    if (!password) {

        return false;

    }


    try {

        const res =
            await fetch(
                "/api/admin/login",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password })
                }
            );

        if (!res.ok) {

            alert("Incorrect password.");

            return false;

        }

    }

    catch (error) {

        console.error("Could not verify admin password:", error);

        alert("Could not verify the password.");

        return false;

    }


    localStorage.setItem("baseflix_admin_key", password);

    return true;

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
    // Reuse the cached admin password if the user has already
    // logged into the Admin profile this session; only prompt if
    // there isn't one yet.
    // ========================================================

    let adminKey =
        localStorage.getItem("baseflix_admin_key");

    if (!adminKey) {

        adminKey =
            prompt(
                "Enter the Admin password:"
            );

    }


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
