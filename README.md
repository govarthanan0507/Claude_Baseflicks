# Baseflicks Server

Baseflicks is a self-hosted, browser-based media server built with Node.js, Express, SQLite (`better-sqlite3`), FFmpeg, and TMDB. It is designed for a home/local media library and aims to provide a Jellyfin-inspired browsing and playback experience without requiring a separate database server.

The server owns the media library, metadata, playback state, transcoding decisions, and the web UI. The same HTTP API can therefore serve as the foundation for future native clients such as an Android application.

## Current architecture

```text
                         ┌──────────────────────┐
                         │      Web Browser      │
                         │  library / profiles   │
                         │  details / player    │
                         └──────────┬───────────┘
                                    │ HTTP / JSON
                                    ▼
                         ┌──────────────────────┐
                         │      server.js       │
                         │ Express application  │
                         │ API + auth + player  │
                         └───────┬───────┬──────┘
                                 │       │
                   SQL           │       │ media / artwork
                                 ▼       ▼
                       ┌────────────┐  ┌──────────────┐
                       │ database.js│  │   scanner.js │
                       │ SQLite DB  │  │ library sync │
                       └─────┬──────┘  └──────┬───────┘
                             │                 │
                             │                 ▼
                             │          ┌─────────────┐
                             │          │   ffmpeg.js │
                             │          │ ffprobe +   │
                             │          │ FFmpeg      │
                             │          └─────────────┘
                             │
                             │                 ┌─────────────┐
                             └────────────────►│  poster.js  │
                                               │ TMDB client │
                                               └─────────────┘
```

### Responsibilities

| Component | Responsibility |
|---|---|
| `server.js` | Express server, HTTP routes, admin authentication, video streaming, transcode orchestration, playback state and user-driven library changes |
| `database.js` | Opens `baseflix.db`, creates the schema, performs startup migrations and seeds the initial Admin profile |
| `scanner.js` | Recursively scans `videos/`, synchronizes database rows, probes new media, generates thumbnails, queues background conversions and handles orphan cleanup |
| `ffmpeg.js` | `ffprobe` inspection, browser-playability checks, MP4 conversion, live transcoding, progress parsing, thumbnails and transcoded-path helpers |
| `poster.js` | TMDB search, metadata resolution, artwork downloads, API-key storage and movie/TV identification helpers |
| `public/app.js` | Main browser application: library browsing, navigation, shelves, details, metadata editing and playback UI |
| `public/profiles.js` | Profile picker and Admin login/password setup/management flow |
| `public/index.html` / CSS | Main application shell and styling |
| `public/welcome.*` | Welcome/landing page |
| `public/profiles.*` | Profile picker UI |
| `fix-vob.js` | Standalone VOB/media helper; it is not part of the normal server startup path |

## Runtime model

Baseflicks is intentionally simple to deploy:

- Node.js runs one Express process.
- SQLite is local to the installation.
- `better-sqlite3` provides one shared synchronous database connection through Node's module cache.
- The server listens on port **4000**.
- FFmpeg and FFprobe are external executables and must be available on the host system's `PATH`.
- The browser talks to the server using normal HTTP requests and JSON APIs.
- Media files are served directly when possible and transcoded when browser compatibility requires it.

## Folder structure

```text
Baseflicks_Server/
├── server.js
├── database.js
├── scanner.js
├── ffmpeg.js
├── poster.js
├── fix-vob.js
├── package.json
├── package-lock.json
├── public/
│   ├── welcome.html
│   ├── welcome.css
│   ├── index.html
│   ├── app.js
│   ├── profiles.html
│   ├── profiles.js
│   ├── profiles.css
│   ├── style.css
│   └── intro.mp4
│
├── videos/                    # media source library (gitignored)
├── posters/                   # generated/TMDB posters (gitignored)
├── backdrops/                 # TMDB backdrops (gitignored)
├── landscapes/                # TMDB landscape/still artwork (gitignored)
├── logos/                     # TMDB title logos (gitignored)
├── transcoded/                # completed conversion cache (gitignored)
├── not_compatible_originals/  # archived originals (gitignored)
└── baseflix.db                # SQLite database (gitignored)
```

Generated media/artwork folders deliberately live beside `videos/`, rather than inside it. The scanner treats files disappearing from `videos/` as library removals, so generated files must not be placed inside the scanned source tree.

The repository `.gitignore` excludes the source media, SQLite files, posters, artwork, transcoded output and archived originals.

## Startup sequence

When `node server.js` starts:

1. `database.js` opens `baseflix.db`.
2. Required tables are created if they do not exist.
3. Existing `videos` tables are inspected with `PRAGMA table_info(videos)` and missing columns are added as idempotent migrations.
4. A default Admin profile is created when no profiles exist.
5. Express middleware and routes are registered.
6. `scanner.scanLibrary()` is started in the background.
7. Express begins listening on port `4000`.

The scanner therefore does not have to finish before the web server becomes available.

## Database architecture

The database is intentionally small and relational only where it adds value.

### `videos`

The central library table. It stores:

- physical identity: `name`, `relative_path`, `folder`, `size`
- lifecycle: `added_at`, `original_status`
- playback basics: `watched`, `position`
- technical media data: `video_codec`, `audio_codec`, `duration`, `width`, `height`, `needs_transcode`
- generated artwork: `poster`, `backdrop`, `landscape`, `logo`
- user/TMDB metadata: `custom_title`, `overview`, `custom_date`, `tagline`, `genres`, `director`, `writers`, `studio`, `release_year`

`relative_path` is unique and remains the link between the database record and the real file on disk.

### `profiles`

Stores the local viewing profiles:

- `id`
- `name`
- `avatar`
- `created_at`

Profile names are unique.

### `continue_watching`

Stores in-progress playback per profile/video pair. It uses a unique `(profile_id, video_id)` constraint so progress is updated rather than duplicated.

### `watch_history`

Stores completed playback separately from in-progress playback. This is what powers Recently Watched.

### `settings`

A generic key/value table used for installation-level settings, including the TMDB API key and the hashed Admin password.

Foreign keys on playback tables use `ON DELETE CASCADE`, so deleting a profile or video also removes its associated playback state.

## Library scanner

`scanner.js` recursively walks the `videos/` directory and synchronizes it with SQLite.

For newly discovered videos it can:

1. Add the file to the `videos` table.
2. Run `ffprobe` to discover codecs, duration and dimensions.
3. Decide whether the file can be direct-played by the browser.
4. Generate a thumbnail poster with FFmpeg.
5. Identify movie/TV metadata through TMDB when configured.
6. Queue a permanent browser-compatible conversion when required.

Scanning and heavy conversion work are intentionally sequential rather than highly parallel. This is a deliberate choice for modest home-server hardware.

The scanner also removes database rows for files that no longer exist in `videos/` and cleans up associated generated content. Filesystem cleanup is performed separately from the database transaction because filesystem operations are not transactional.

## Playback and transcoding

### Direct play

The current playability check treats these video codecs as browser-compatible:

- H.264
- VP8
- VP9

And these audio codecs as browser-compatible:

- AAC
- MP3
- Opus
- Vorbis

If both tracks are compatible, the original file can be served directly.

### Range requests

The `/video/:filename` endpoint supports HTTP byte ranges. This allows browser seeking without requiring the entire file to be downloaded first.

### Live transcoding

When a file needs transcoding and a completed compatible copy does not yet exist, FFmpeg can transcode it to an H.264/AAC MP4 stream for playback.

The implementation avoids re-encoding a track that is already compatible where possible. Software transcoding can also cap output resolution to 1080p to avoid making 4K software encoding impractical on modest CPUs.

### Persistent conversion

The scanner can create a permanent MP4 conversion in `transcoded/` using a quality-oriented background encode. The completed file is written through a temporary path and only moved into place after FFmpeg finishes successfully.

When the user approves the conversion, the server can:

1. Move the original into `not_compatible_originals/`.
2. Move the converted MP4 into the original library location.
3. Re-probe the replacement file.
4. Update the database to reflect the new path and codecs.

The original is archived rather than permanently deleted.

## Metadata and TMDB

TMDB integration is optional. The application works without an API key; metadata retrieval is simply unavailable until one is configured.

The key is stored in the local SQLite `settings` table and can be configured through the Admin UI without editing an environment file or restarting the server. The API exposes only a masked preview of the stored key.

Supported metadata workflows include:

- automatic identification during library processing
- manual `Populate from web`
- manual search and selection of a TMDB match
- movie metadata
- TV show / episode metadata
- poster artwork
- backdrop artwork
- landscape/still artwork
- title-logo artwork
- tagline, studio, director and writer information where available

For TV episodes, the folder structure is used to recognize a series and the filename's `S01E02`-style information identifies the specific episode.

## Profiles and Admin access

Baseflicks supports multiple local profiles.

The Admin profile is also the privileged account for library-management actions. The Admin password is stored as a salted `scrypt` hash in SQLite rather than plaintext.

Privileged requests send the password as the `x-admin-key` header and the server verifies it against the stored hash.

Admin-gated operations include library metadata editing, TMDB management and filesystem-changing operations such as moving converted originals.

This is intentionally **home-server-grade authentication**, not a hardened internet-facing identity system. Baseflicks should not currently be treated as a production-grade public service without additional authentication, session management, transport security and abuse protections.

## Playback state

The player stores playback state against the selected profile.

The server distinguishes:

- **Continue Watching** — meaningful in-progress positions only
- **Completed / Recently Watched** — finished videos recorded in `watch_history`

The implementation uses shared start/end thresholds so the read and write sides agree about when a video is considered started or finished.

The browser player periodically sends progress to `/api/continue-watching` and restores the saved position when playback resumes.

## Main API surface

The API is intentionally HTTP/JSON based so future clients can reuse the same server.

### Library

- `GET /api/videos`
- `POST /api/videos/:id/metadata`
- `POST /api/videos/:id/populate-from-web`
- `GET /api/videos/:id/tmdb-search`
- `POST /api/videos/:id/apply-tmdb-match`
- `GET /api/videos/pending-cleanup`
- `POST /api/videos/:id/move-original`
- `POST /api/videos/:id/keep-original`

### Bulk metadata

- `POST /api/bulk-populate-from-web`
- `GET /api/bulk-populate-status`

Bulk population runs in the background and processes videos sequentially. It stops early for a missing API key or repeated failures rather than continuing to hammer TMDB.

### Profiles

- `GET /api/profiles`
- `GET /api/profiles/:id`
- profile CRUD endpoints in `server.js`

### Playback state

- `GET /api/continue-watching/:profileId`
- `POST /api/continue-watching`
- `GET /api/watch-status/:profileId?videoIds=...`
- `GET /api/watch-history/:profileId`

### Admin/settings

- `GET /api/admin/status`
- `POST /api/admin/login`
- `POST /api/admin/set-password`
- `GET /api/settings/tmdb-key`
- `POST /api/settings/tmdb-key`

### Media

- `GET /video/:filename`
- `GET /watch/:filename`

Artwork is exposed through the `/posters`, `/backdrops`, `/landscapes` and `/logos` static paths.

## Installation

### Prerequisites

- Node.js
- FFmpeg
- FFprobe

FFmpeg and FFprobe must be callable as `ffmpeg` and `ffprobe` from the server process.

### Install

```bash
npm install
```

Place media inside:

```text
videos/
```

Then start the server:

```bash
node server.js
```

Open:

```text
http://localhost:4000
```

The SQLite database and generated folders are created automatically as needed.

## Configuration

### TMDB

TMDB is optional. Configure an API key from the Admin settings UI. Each installation is expected to use its own user-supplied key; no shared key is bundled into the application.

### Media storage

The current implementation assumes the media library is rooted at the project's `videos/` directory. Generated data is stored in sibling directories so it cannot be mistaken for source media by the scanner.

## Design principles

Several implementation choices are deliberate:

1. **Local-first** — SQLite and filesystem storage keep installation simple.
2. **Browser-first playback** — direct play is preferred; transcoding is a compatibility fallback.
3. **Reuse compatible tracks** — avoid unnecessary CPU-heavy re-encoding.
4. **Safe conversion lifecycle** — failed conversions do not replace originals.
5. **Non-destructive cleanup** — converted originals are archived instead of automatically deleted.
6. **Sequential heavy jobs** — metadata population and background conversion avoid overwhelming modest hardware.
7. **Client-independent API** — library and playback state are exposed through HTTP/JSON rather than being tied to the current web UI.
8. **Schema migrations in code** — the application can evolve an existing SQLite database without requiring a separate migration service.

## Current limitations

- The server is primarily designed for a trusted home/local network.
- Admin authentication is not yet a hardened internet-facing authentication system.
- There is no built-in HTTPS/reverse-proxy layer.
- There is no live-TV/DVR subsystem.
- The current repository is video-focused; music and photo management are not part of this server yet.
- Archived originals are intentionally not auto-deleted.
- TMDB metadata depends on an external API key and network availability.
- Software transcoding can be CPU-intensive, especially for high-resolution media.
- The current database is SQLite and is intentionally kept simple rather than using a separate database server.

## Future client architecture

The server/client boundary is already useful for a future Android application:

```text
Android / Web / future TV client
             │
             │ HTTP + JSON + media streams
             ▼
      Baseflicks Server
             │
      ┌──────┴─────────┐
      │                │
   SQLite           Filesystem
   metadata         media/art
```

A native Android client can therefore focus on presentation, navigation, authentication/session UX and playback while continuing to use the Baseflicks server as the source of truth for the media library and playback state.

## Development workflow

For future feature work, prefer:

1. Create a feature branch.
2. Implement one coherent feature/fix.
3. Test the affected server and UI behavior.
4. Update `package.json` version when the project release convention calls for it.
5. Add a concise changelog entry when `CHANGELOG.md` is introduced/maintained.
6. Commit with a descriptive message.
7. Push the feature branch.
8. Merge through a pull request when appropriate.

Avoid committing generated media, databases, posters, transcodes or archived originals.

## Project status

This README documents the architecture present on the `main` branch at the time it was created. It is intentionally based on the repository code and the accompanying project architecture/feature notes rather than describing features that are only planned.

For the authoritative implementation, treat the source files—especially `server.js`, `database.js`, `scanner.js`, `ffmpeg.js`, `poster.js` and `public/`—as the source of truth.
