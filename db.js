/* SQLite persistence for sessions, seed history, spin audit trail.
 *
 * Tables:
 *   sessions   — one row per player session
 *                (current active serverSeed kept secret; hash exposed to client)
 *   seeds      — historical seeds (revealed after rotation, queryable by anyone
 *                with the session id → enables independent audit)
 *   spins      — every game action with full input/output (for replay)
 */

"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.XIBALBA_DB || path.join(__dirname, "xibalba.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    server_seed     TEXT NOT NULL,         -- secret until rotated
    server_seed_hash TEXT NOT NULL,        -- sha256(server_seed), published
    client_seed     TEXT NOT NULL,
    nonce           INTEGER NOT NULL DEFAULT 0,
    balance         REAL NOT NULL DEFAULT 100.00,
    bet             REAL NOT NULL DEFAULT 1.00,
    bet_idx         INTEGER NOT NULL DEFAULT 2,
    buy_bonus_idx   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seeds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    server_seed     TEXT NOT NULL,
    server_seed_hash TEXT NOT NULL,
    client_seed     TEXT NOT NULL,
    nonce_start     INTEGER NOT NULL,      -- first nonce that used this seed pair
    nonce_end       INTEGER,               -- last nonce that used it (null = still active)
    revealed_at     INTEGER,               -- unix ms when seed was revealed
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS spins (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    nonce           INTEGER NOT NULL,
    action          TEXT NOT NULL,         -- "spin" | "wild_spin" | "buy_bonus"
    bet             REAL NOT NULL,
    server_seed_hash TEXT NOT NULL,        -- hash committed at time of spin
    client_seed     TEXT NOT NULL,
    total_win       REAL NOT NULL,
    outcome_json    TEXT NOT NULL,         -- full engine outcome (replayable)
    balance_after   REAL NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE(session_id, nonce)
  );

  CREATE INDEX IF NOT EXISTS idx_spins_session ON spins(session_id, nonce DESC);
  CREATE INDEX IF NOT EXISTS idx_seeds_session ON seeds(session_id, created_at DESC);
`);

const stmts = {
  insertSession: db.prepare(`
    INSERT INTO sessions (id, server_seed, server_seed_hash, client_seed, nonce, balance, bet, bet_idx, buy_bonus_idx, created_at, updated_at)
    VALUES (@id, @serverSeed, @serverSeedHash, @clientSeed, 0, @balance, @bet, @betIdx, 0, @now, @now)
  `),
  insertSeed: db.prepare(`
    INSERT INTO seeds (session_id, server_seed, server_seed_hash, client_seed, nonce_start, created_at)
    VALUES (@sessionId, @serverSeed, @serverSeedHash, @clientSeed, @nonceStart, @now)
  `),
  closeSeed: db.prepare(`
    UPDATE seeds SET nonce_end = @nonceEnd, revealed_at = @now
    WHERE session_id = @sessionId AND nonce_end IS NULL
  `),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  updateSessionAfterSpin: db.prepare(`
    UPDATE sessions
    SET nonce = @nonce, balance = @balance, updated_at = @now
    WHERE id = @id
  `),
  updateSessionBet: db.prepare(`
    UPDATE sessions SET bet = @bet, bet_idx = @betIdx, updated_at = @now WHERE id = @id
  `),
  updateBuyBonusIdx: db.prepare(`
    UPDATE sessions SET buy_bonus_idx = @idx, updated_at = @now WHERE id = @id
  `),
  rotateSeed: db.prepare(`
    UPDATE sessions
    SET server_seed = @serverSeed, server_seed_hash = @serverSeedHash,
        client_seed = @clientSeed, nonce = 0, updated_at = @now
    WHERE id = @id
  `),
  insertSpin: db.prepare(`
    INSERT INTO spins (session_id, nonce, action, bet, server_seed_hash, client_seed, total_win, outcome_json, balance_after, created_at)
    VALUES (@sessionId, @nonce, @action, @bet, @serverSeedHash, @clientSeed, @totalWin, @outcomeJson, @balanceAfter, @now)
  `),
  recentSpins: db.prepare(`
    SELECT id, nonce, action, bet, total_win, balance_after, created_at, server_seed_hash, client_seed
    FROM spins WHERE session_id = ? ORDER BY nonce DESC LIMIT ?
  `),
  getRevealedSeed: db.prepare(`
    SELECT server_seed, server_seed_hash, client_seed, nonce_start, nonce_end, revealed_at
    FROM seeds WHERE session_id = ? AND revealed_at IS NOT NULL ORDER BY created_at DESC
  `),
};

const insertSessionWithSeed = db.transaction((args) => {
  stmts.insertSession.run(args);
  stmts.insertSeed.run({
    sessionId: args.id,
    serverSeed: args.serverSeed,
    serverSeedHash: args.serverSeedHash,
    clientSeed: args.clientSeed,
    nonceStart: 0,
    now: args.now,
  });
});

const rotateSeedTxn = db.transaction((args) => {
  stmts.closeSeed.run({ sessionId: args.sessionId, nonceEnd: args.nonceEnd, now: args.now });
  stmts.rotateSeed.run({
    id: args.sessionId, serverSeed: args.serverSeed, serverSeedHash: args.serverSeedHash,
    clientSeed: args.clientSeed, now: args.now,
  });
  stmts.insertSeed.run({
    sessionId: args.sessionId, serverSeed: args.serverSeed, serverSeedHash: args.serverSeedHash,
    clientSeed: args.clientSeed, nonceStart: 0, now: args.now,
  });
});

const recordSpinTxn = db.transaction((args) => {
  stmts.insertSpin.run(args);
  stmts.updateSessionAfterSpin.run({
    id: args.sessionId, nonce: args.nonce + 1, balance: args.balanceAfter, now: args.now,
  });
});

module.exports = {
  db,
  createSession(args)         { insertSessionWithSeed(args); },
  getSession(id)              { return stmts.getSession.get(id); },
  rotateSeed(args)            { rotateSeedTxn(args); },
  recordSpin(args)            { recordSpinTxn(args); },
  updateBet(args)             { stmts.updateSessionBet.run(args); },
  updateBuyBonusIdx(args)     { stmts.updateBuyBonusIdx.run(args); },
  recentSpins(sessionId, n)   { return stmts.recentSpins.all(sessionId, n); },
  revealedSeeds(sessionId)    { return stmts.getRevealedSeed.all(sessionId); },
};
