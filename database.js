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

db.prepare(`
    CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT '🎬',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
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