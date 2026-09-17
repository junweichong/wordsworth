const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'game_history.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency performance
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS replays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    replay_id TEXT UNIQUE NOT NULL,
    room_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    player_count INTEGER NOT NULL,
    winner_name TEXT NOT NULL,
    winner_score INTEGER NOT NULL,
    called_letters TEXT NOT NULL,
    leaderboard_data TEXT NOT NULL
  )
`);

function saveReplay({ roomId, calledLetters, leaderboard }) {
    try {
        const replayId = `rep_${roomId}_${Date.now()}`;
        const winner = leaderboard[0] || { name: 'Unknown', score: 0 };
        const stmt = db.prepare(`
      INSERT INTO replays (replay_id, room_id, player_count, winner_name, winner_score, called_letters, leaderboard_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(
            replayId,
            roomId,
            leaderboard.length,
            winner.name,
            winner.score,
            JSON.stringify(calledLetters || []),
            JSON.stringify(leaderboard)
        );
        console.log(`[Database] Game end-state successfully saved: ${replayId} (Room: ${roomId})`);
        return replayId;
    } catch (err) {
        console.error('[Database Error] Failed to save replay:', err);
        return null;
    }
}

function getAllReplays() {
    try {
        const stmt = db.prepare(`
      SELECT id, replay_id, room_id, created_at, player_count, winner_name, winner_score
      FROM replays
      ORDER BY created_at DESC
    `);
        return stmt.all();
    } catch (err) {
        console.error('[Database Error] Failed to fetch replays:', err);
        return [];
    }
}

function getReplayById(replayId) {
    try {
        const stmt = db.prepare(`SELECT * FROM replays WHERE replay_id = ?`);
        const row = stmt.get(replayId);
        if (!row) return null;
        return {
            ...row,
            called_letters: JSON.parse(row.called_letters),
            leaderboard_data: JSON.parse(row.leaderboard_data)
        };
    } catch (err) {
        console.error('[Database Error] Failed to fetch replay by ID:', err);
        return null;
    }
}

function deleteReplay(replayId) {
    try {
        const stmt = db.prepare(`DELETE FROM replays WHERE replay_id = ?`);
        const info = stmt.run(replayId);
        return info.changes > 0;
    } catch (err) {
        console.error('[Database Error] Failed to delete replay:', err);
        return false;
    }
}

function getStats() {
    try {
        const countStmt = db.prepare(`SELECT COUNT(*) as totalGames FROM replays`);
        const maxScoreStmt = db.prepare(`SELECT MAX(winner_score) as topScore FROM replays`);
        const totalPlayersStmt = db.prepare(`SELECT SUM(player_count) as totalPlayers FROM replays`);
        return {
            totalGames: countStmt.get().totalGames || 0,
            topScore: maxScoreStmt.get().topScore || 0,
            totalPlayers: totalPlayersStmt.get().totalPlayers || 0
        };
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
