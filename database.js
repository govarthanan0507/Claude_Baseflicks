const Database = require("better-sqlite3");
const path = require("path");

const DATABASE_FILE =
    path.join(__dirname, "baseflix.db");

const db =
    new Database(DATABASE_FILE);


/*
    Create the videos table
    if it doesn't already exist.
*/

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


console.log("🗄️ Baseflix database ready");


module.exports = db;