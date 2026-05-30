/* Temple of Xibalba — provably-fair backend server.
 *
 * Endpoints:
 *
 *   POST /api/session                — start a new session
 *        body: { clientSeed? }
 *        resp: { sessionId, serverSeedHash, clientSeed, nonce, balance, bet }
 *
 *   GET  /api/session/:id            — current state
 *        resp: { id, serverSeedHash, clientSeed, nonce, balance, bet, betIdx, buyBonusIdx }
 *
 *   POST /api/session/:id/seed       — rotate seeds (reveals current server seed)
 *        body: { clientSeed? }       — optional new client seed; auto-gen if omitted
 *        resp: { revealedServerSeed, newServerSeedHash, clientSeed }
 *
 *   POST /api/session/:id/bet        — update bet level
 *        body: { betIdx }
 *        resp: { bet, betIdx }
 *
 *   POST /api/session/:id/buy-bonus-idx
 *        body: { idx }               — pre-select which buy-bonus tier
 *
 *   POST /api/session/:id/spin       — base or wild spin
 *        body: { action: "spin"|"wild_spin" }
 *        resp: { nonce, outcome, balance, serverSeedHash, clientSeed }
 *
 *   POST /api/session/:id/buy-bonus  — buy the pre-selected bonus
 *        resp: same shape as /spin
 *
 *   GET  /api/session/:id/history?limit=50
 *
 *   GET  /api/session/:id/seeds      — revealed past seeds (audit trail)
 *
 *   POST /api/verify                 — independent replay of any spin
 *        body: { serverSeed, clientSeed, nonce, action, bet, buyBonusIdx?,
 *                startBalance? }
 *        resp: { outcome }
 */

"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const engine = require("./engine");
const { makeRng, commit, generateServerSeed, generateClientSeed } = require("./rng");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// Static hosting: serve index.html + assets so a single `node server.js`
// boots the whole stack on localhost:3000.
app.use(express.static(__dirname, { index: "index.html" }));

const now = () => Date.now();

// ---- helpers -------------------------------------------------------------
function sessionPublic(sess) {
  return {
    id: sess.id,
    serverSeedHash: sess.server_seed_hash,
    clientSeed: sess.client_seed,
    nonce: sess.nonce,
    balance: sess.balance,
    bet: sess.bet,
    betIdx: sess.bet_idx,
    buyBonusIdx: sess.buy_bonus_idx,
  };
}

function requireSession(req, res) {
  const sess = db.getSession(req.params.id);
  if (!sess) { res.status(404).json({ error: "SESSION_NOT_FOUND" }); return null; }
  return sess;
}

// ---- routes --------------------------------------------------------------
app.post("/api/session", (req, res) => {
  const id = crypto.randomBytes(12).toString("hex");
  const serverSeed = generateServerSeed();
  const serverSeedHash = commit(serverSeed);
  const clientSeed = (req.body && req.body.clientSeed) || generateClientSeed();
  db.createSession({
    id, serverSeed, serverSeedHash, clientSeed,
    balance: 100.00, bet: 1.00, betIdx: 2, now: now(),
  });
  const sess = db.getSession(id);
  res.json(sessionPublic(sess));
});

app.get("/api/session/:id", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  res.json(sessionPublic(sess));
});

app.post("/api/session/:id/seed", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  const newServerSeed = generateServerSeed();
  const newServerSeedHash = commit(newServerSeed);
  const newClientSeed = (req.body && req.body.clientSeed) || generateClientSeed();
  db.rotateSeed({
    sessionId: sess.id,
    serverSeed: newServerSeed, serverSeedHash: newServerSeedHash,
    clientSeed: newClientSeed, nonceEnd: sess.nonce, now: now(),
  });
  res.json({
    revealedServerSeed: sess.server_seed,
    revealedServerSeedHash: sess.server_seed_hash,
    newServerSeedHash, clientSeed: newClientSeed, nonce: 0,
  });
});

app.post("/api/session/:id/bet", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  const betIdx = Math.max(0, Math.min(engine.BET_LEVELS.length - 1, parseInt(req.body.betIdx, 10) || 0));
  const bet = engine.BET_LEVELS[betIdx];
  db.updateBet({ id: sess.id, bet, betIdx, now: now() });
  res.json({ bet, betIdx });
});

app.post("/api/session/:id/buy-bonus-idx", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  const idx = Math.max(0, Math.min(engine.BUY_OPTIONS.length - 1, parseInt(req.body.idx, 10) || 0));
  db.updateBuyBonusIdx({ id: sess.id, idx, now: now() });
  res.json({ idx });
});

function runAction(sess, action) {
  const rng = makeRng(sess.server_seed, sess.client_seed, sess.nonce);
  const state = {
    balance: sess.balance, bet: sess.bet,
    buyBonusOptionIdx: sess.buy_bonus_idx,
  };
  const result = engine.runFullSpin({ state, action, rng });
  if (result.error) return { ok: false, error: result.error };
  db.recordSpin({
    sessionId: sess.id,
    nonce: sess.nonce,
    action,
    bet: result.outcome.bet,
    serverSeedHash: sess.server_seed_hash,
    clientSeed: sess.client_seed,
    totalWin: result.outcome.totalWin,
    outcomeJson: JSON.stringify(result.outcome),
    balanceAfter: result.newState.balance,
    now: now(),
  });
  return {
    ok: true,
    nonce: sess.nonce,
    outcome: result.outcome,
    balance: result.newState.balance,
    serverSeedHash: sess.server_seed_hash,
    clientSeed: sess.client_seed,
  };
}

app.post("/api/session/:id/spin", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  const action = req.body && req.body.action === "wild_spin" ? "wild_spin" : "spin";
  const r = runAction(sess, action);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.post("/api/session/:id/buy-bonus", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  const optIdx = engine.BUY_OPTIONS[sess.buy_bonus_idx];
  if (!optIdx) return res.status(400).json({ error: "INVALID_BUY_OPTION" });
  if (sess.balance < optIdx.cost * sess.bet) return res.status(400).json({ error: "INSUFFICIENT_BALANCE" });
  const r = runAction(sess, "buy_bonus");
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.get("/api/session/:id/history", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  res.json(db.recentSpins(sess.id, limit));
});

app.get("/api/session/:id/seeds", (req, res) => {
  const sess = requireSession(req, res); if (!sess) return;
  res.json(db.revealedSeeds(sess.id));
});

app.post("/api/verify", (req, res) => {
  const { serverSeed, clientSeed, nonce, action, bet, buyBonusIdx, startBalance } = req.body || {};
  if (!serverSeed || !clientSeed || nonce === undefined || !action || !bet) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }
  const rng = makeRng(serverSeed, String(clientSeed), parseInt(nonce, 10));
  const state = {
    balance: typeof startBalance === "number" ? startBalance : 1_000_000,
    bet: parseFloat(bet),
    buyBonusOptionIdx: parseInt(buyBonusIdx || 0, 10),
  };
  const result = engine.runFullSpin({ state, action, rng });
  res.json({
    serverSeedHash: commit(serverSeed),
    outcome: result.outcome,
    error: result.error || null,
  });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`Temple of Xibalba — provably-fair server on http://localhost:${PORT}`);
});
