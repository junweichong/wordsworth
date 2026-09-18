const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;

let isPostgres = false;
let db = null;
let pgPool = null;

if (DATABASE_URL) {
    isPostgres = true;
    const { Pool } = require('pg');
    console.log('[Database] Connecting to remote PostgreSQL database...');
    pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
            ? false
            : { rejectUnauthorized: false }
    });

    // Initialize Postgres Schema
    pgPool.query(`
    CREATE TABLE IF NOT EXISTS replays (
      id SERIAL PRIMARY KEY,
      replay_id VARCHAR(255) UNIQUE NOT NULL,
      room_id VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      player_count INTEGER NOT NULL,
      winner_name TEXT NOT NULL,
      winner_score INTEGER NOT NULL,
      host_name TEXT,
      called_letters TEXT NOT NULL,
      leaderboard_data TEXT NOT NULL
    )
  `).then(() => {
        console.log('[Database] PostgreSQL schema initialized successfully.');
    }).catch(err => {
        console.error('[Database Error] Failed to initialize PostgreSQL schema:', err);
    });

} else {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'game_history.db') : path.join(__dirname, 'game_history.db'));

    // Ensure target directory exists if using custom path
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log(`[Database] Initializing SQLite database at: ${dbPath}`);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
    CREATE TABLE IF NOT EXISTS replays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      replay_id TEXT UNIQUE NOT NULL,
      room_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      player_count INTEGER NOT NULL,
      winner_name TEXT NOT NULL,
      winner_score INTEGER NOT NULL,
      host_name TEXT,
      called_letters TEXT NOT NULL,
      leaderboard_data TEXT NOT NULL
    )
  `);

    try {
        db.exec(`ALTER TABLE replays ADD COLUMN host_name TEXT`);
    } catch (e) {
        // Column already exists
    }
}

async function saveReplay({ roomId, hostName, calledLetters, leaderboard }) {
    try {
        const replayId = `rep_${roomId}_${Date.now()}`;
        const winner = leaderboard[0] || { name: 'Unknown', score: 0 };
        const host = hostName || winner.name || 'Unknown';
        const calledLettersJson = JSON.stringify(calledLetters || []);
        const leaderboardJson = JSON.stringify(leaderboard || []);

        if (isPostgres) {
            const query = `
        INSERT INTO replays (replay_id, room_id, player_count, winner_name, winner_score, host_name, called_letters, leaderboard_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;
            await pgPool.query(query, [
                replayId,
                roomId,
                leaderboard.length,
                winner.name,
                winner.score,
                host,
                calledLettersJson,
                leaderboardJson
            ]);
        } else {
            const stmt = db.prepare(`
        INSERT INTO replays (replay_id, room_id, player_count, winner_name, winner_score, host_name, called_letters, leaderboard_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
            stmt.run(
                replayId,
                roomId,
                leaderboard.length,
                winner.name,
                winner.score,
                host,
                calledLettersJson,
                leaderboardJson
            );
        }
        console.log(`[Database] Game end-state successfully saved: ${replayId} (Room: ${roomId})`);
        return replayId;
    } catch (err) {
        console.error('[Database Error] Failed to save replay:', err);
        return null;
    }
}

async function getAllReplays() {
    try {
        if (isPostgres) {
            const res = await pgPool.query(`
        SELECT id, replay_id, room_id, created_at, player_count, winner_name, winner_score, host_name
        FROM replays
        ORDER BY created_at DESC
      `);
            return res.rows;
        } else {
            const stmt = db.prepare(`
        SELECT id, replay_id, room_id, created_at, player_count, winner_name, winner_score, host_name
        FROM replays
        ORDER BY created_at DESC
      `);
            return stmt.all();
        }
    } catch (err) {
        console.error('[Database Error] Failed to fetch replays:', err);
        return [];
    }
}

async function getReplayById(replayId) {
    try {
        let row;
        if (isPostgres) {
            const res = await pgPool.query(`SELECT * FROM replays WHERE replay_id = $1`, [replayId]);
            row = res.rows[0];
        } else {
            const stmt = db.prepare(`SELECT * FROM replays WHERE replay_id = ?`);
            row = stmt.get(replayId);
        }

        if (!row) return null;
        return {
            ...row,
            called_letters: typeof row.called_letters === 'string' ? JSON.parse(row.called_letters) : row.called_letters,
            leaderboard_data: typeof row.leaderboard_data === 'string' ? JSON.parse(row.leaderboard_data) : row.leaderboard_data
        };
    } catch (err) {
        console.error('[Database Error] Failed to fetch replay by ID:', err);
        return null;
    }
}

async function deleteReplay(replayId) {
    try {
        if (isPostgres) {
            const res = await pgPool.query(`DELETE FROM replays WHERE replay_id = $1`, [replayId]);
            return res.rowCount > 0;
        } else {
            const stmt = db.prepare(`DELETE FROM replays WHERE replay_id = ?`);
            const info = stmt.run(replayId);
            return info.changes > 0;
        }
    } catch (err) {
        console.error('[Database Error] Failed to delete replay:', err);
        return false;
    }
}

async function getStats() {
    try {
        if (isPostgres) {
            const res = await pgPool.query(`
        SELECT 
          COUNT(*)::int as "totalGames", 
          COALESCE(MAX(winner_score), 0)::int as "topScore", 
          COALESCE(SUM(player_count), 0)::int as "totalPlayers" 
        FROM replays
      `);
            return res.rows[0] || { totalGames: 0, topScore: 0, totalPlayers: 0 };
        } else {
            const countStmt = db.prepare(`SELECT COUNT(*) as totalGames FROM replays`);
            const maxScoreStmt = db.prepare(`SELECT MAX(winner_score) as topScore FROM replays`);
            const totalPlayersStmt = db.prepare(`SELECT SUM(player_count) as totalPlayers FROM replays`);
            return {
                totalGames: countStmt.get().totalGames || 0,
                topScore: maxScoreStmt.get().topScore || 0,
                totalPlayers: totalPlayersStmt.get().totalPlayers || 0
            };
        }
    } catch (err) {
        console.error('[Database Error] Failed to fetch stats:', err);
        return { totalGames: 0, topScore: 0, totalPlayers: 0 };
    }
}

module.exports = {
    saveReplay,
    getAllReplays,
    getReplayById,
    deleteReplay,
    getStats
};

