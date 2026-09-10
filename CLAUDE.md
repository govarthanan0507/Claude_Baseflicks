# Baseflix

Self-hosted media server, Express + better-sqlite3, modeled after Jellyfin.
Goal: bring it closer to Jellyfin's UX — poster grid, shelves, details page, nicer player.
Target users: semi-technical home-server hosts, not hardcore homelab experts.

## Running

- `npm install` then `node server.js` — serves on port 4000
- Media library lives in `videos/`; artwork/derived folders (`posters/`, `backdrops/`,
  `landscapes/`, `logos/`, `transcoded/`, `not_compatible_originals/`) are auto-created and gitignored
- SQLite database is `baseflix.db` (gitignored); schema + migrations run on startup from `database.js`

## Architecture

- `server.js` — Express app, all routes, streaming, admin auth, TMDB write-paths
- `database.js` — single better-sqlite3 connection (synchronous, no ORM); exports `db`
- `scanner.js` — library scan, ffprobe, transcode queue, auto-populate, orphan cleanup
- `ffmpeg.js` — probe / transcode / thumbnail helpers
- `poster.js` — TMDB client: search, details, images, API-key management
- `public/` — static SPA (`app.js`, `profiles.js`, styles); served by `express.static`

`server.js` and `scanner.js` both `require("./database")` (shared singleton) but do not
import each other, so a few write helpers are intentionally duplicated.

## Versioning & commits

- After completing a feature or fix, commit with a clear, descriptive message
- Bump the version in `package.json` (semver: patch/minor/major)
- Add an entry to `CHANGELOG.md` summarizing the change
- Tag releases: `git tag vX.Y.Z`

## Git remotes

- `baseflicks` → `Baseflicks_Server.git` — the current repo; `main` tracks it
- `origin` → old `baseflix.git` — legacy, push to explicitly only if needed
