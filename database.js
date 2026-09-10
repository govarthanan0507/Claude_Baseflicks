const Database = require("better-sqlite3");
const path = require("path");

const DATABASE_FILE = path.join(__dirname, "baseflix.db");

const db = new Database(DATABASE_FILE);

db.prepare(`
    CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        folder TEXT,
        size INTEGER,
        added_at TEXT DEFAULT CURRENT_TIMESTAMP,
        watched INTEGER DEFAULT 0,
        position REAL DEFAULT 0
    )
`).run();


// ============================================================
// SETTINGS TABLE
// A simple key/value store for app-wide configuration entered
// through the UI -- starting with the user's own TMDB API key,
// so "populate from web" works without editing environment
// variables or restarting the server. Generic enough to hold
// other future settings the same way.
// ============================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`).run();


// ============================================================
// MEDIA INFO / POSTER COLUMNS
// Added after the table already existed in the wild, so these
// are applied as a migration rather than in CREATE TABLE above --
// SQLite doesn't support "ADD COLUMN IF NOT EXISTS", so we check
// the existing columns first and only add what's missing. Safe
// to run this on every startup, on an old DB or a fresh one.
// ============================================================

const existingVideoColumns =
    db.prepare(`PRAGMA table_info(videos)`)
        .all()
        .map(column => column.name);

const videoColumnsToAdd = [
    { name: "video_codec", type: "TEXT" },
    { name: "audio_codec", type: "TEXT" },
    { name: "duration", type: "REAL" },
    { name: "width", type: "INTEGER" },
    { name: "height", type: "INTEGER" },
    { name: "needs_transcode", type: "INTEGER" },
    { name: "poster", type: "TEXT" },
    // Tracks the decision on the ORIGINAL file once a full-quality
    // converted copy exists in transcoded/. NULL = no decision
    // needed yet (either not converted, or nothing to decide).
    // 'pending' = converted copy exists, original still present,
    // waiting on the user. 'kept' = user chose to keep both.
    // 'moved' = user approved moving the original out of videos/
    // (to NOT_COMPATIBLE_FOLDER) and it happened. Nothing ever
    // gets permanently deleted by this feature.
    { name: "original_status", type: "TEXT" },
    // Manually-entered metadata (via the "..." edit form) -- all
    // optional, all display-only overrides. custom_title replaces
    // the raw filename in the UI when set; overview and
    // custom_date are shown alongside it. None of this touches
    // relative_path/name, which stay tied to the real file on disk.
    { name: "custom_title", type: "TEXT" },
    { name: "overview", type: "TEXT" },
    { name: "custom_date", type: "TEXT" },
    // Details-page fields. release_year is separate from
    // custom_date (which is a free-form display string, e.g. an
    // episode air date) -- this is specifically the year shown on
    // a movie's details page. genres/director/writers are simple
    // comma-separated free text, not a relational table -- matches
    // how lightweight the rest of this schema is.
    { name: "tagline", type: "TEXT" },
    { name: "genres", type: "TEXT" },
    { name: "director", type: "TEXT" },
    { name: "writers", type: "TEXT" },
    { name: "studio", type: "TEXT" },
    { name: "release_year", type: "TEXT" },
    { name: "backdrop", type: "TEXT" },
    { name: "landscape", type: "TEXT" },
    { name: "logo", type: "TEXT" }
];

for (const column of videoColumnsToAdd) {

    if (!existingVideoColumns.includes(column.name)) {

        db.prepare(`
            ALTER TABLE videos
            ADD COLUMN ${column.name} ${column.type}
        `).run();

        console.log(
            `🗄️ Migrated videos table: added column '${column.name}'`
        );

    }

}


db.prepare(`
    CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT '🎬',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`).run();


// ============================================================
// CONTINUE WATCHING TABLE
// ============================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS continue_watching (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        profile_id INTEGER NOT NULL,

        video_id INTEGER NOT NULL,

        position REAL NOT NULL DEFAULT 0,

        duration REAL NOT NULL DEFAULT 0,

        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

        UNIQUE (
            profile_id,
            video_id
        ),

        FOREIGN KEY (
            profile_id
        )
        REFERENCES profiles(id)
        ON DELETE CASCADE,

        FOREIGN KEY (
            video_id
        )
        REFERENCES videos(id)
        ON DELETE CASCADE

    )
`).run();



// ============================================================
// WATCH HISTORY TABLE
// Separate from continue_watching on purpose -- that table's
// rows get deleted once a video is finished (by design, so
// Continue Watching only shows things genuinely in progress).
// This one is the permanent record of "this profile finished
// this video, and when" that Recently Watched is built from.
// ============================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS watch_history (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        profile_id INTEGER NOT NULL,

        video_id INTEGER NOT NULL,

        watched_at TEXT DEFAULT CURRENT_TIMESTAMP,

        UNIQUE (
            profile_id,
            video_id
        ),

        FOREIGN KEY (
            profile_id
        )
        REFERENCES profiles(id)
        ON DELETE CASCADE,

        FOREIGN KEY (
            video_id
        )
        REFERENCES videos(id)
        ON DELETE CASCADE

    )
`).run();



const profileCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM profiles
`).get();

if (profileCount.count === 0) {
    db.prepare(`
        INSERT INTO profiles (name, avatar)
        VALUES (?, ?)
    `).run("Admin", "👑");
}

console.log("🗄️ Baseflix database ready");

module.exports = db;