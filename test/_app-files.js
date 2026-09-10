"use strict";

/*
    The application .js files an isolated-runtime integration test
    must copy next to a spawned `node server.js`. Computed from the
    repo root so a new first-party module (a future playback task,
    say) is picked up automatically instead of every server-booting
    test file needing its own hand-maintained list.
*/

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

module.exports = fs
    .readdirSync(ROOT)
    .filter((name) => name.endsWith(".js") && !name.startsWith("_"))
    .sort();
