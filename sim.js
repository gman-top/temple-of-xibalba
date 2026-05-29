#!/usr/bin/env node
/* Temple of Xibalba — Monte Carlo math simulator.
 *
 * Pure port of the game.js math (cluster detection, cascade, dig-up, FS
 * trigger, multiplier accumulation). Runs N spins headlessly and reports
 * RTP, hit rate, FS frequency, max-win distribution, volatility buckets.
 *
 * Usage:
 *   node sim.js [spins] [bet]
 *   node sim.js 1000000 1.00
 *
 * Tweak the constants at the top to retune the model, then re-run.
 */

"use strict";

// ============================================================================
// MATH CONSTANTS — mirror of game.js. Change here to retune, then re-run.
// ============================================================================
const COLS = 5;
const ROWS = 7;

const REG_COUNT = 9; // jaguar, feather, mask-red, symbol04..symbol09
const REG_WEIGHTS = [3, 4, 5, 6, 9, 12, 15, 18, 22];

// PAY_TABLE[symIdx][clusterSize - 5], clamped at len-1.
// `let` (not const) so the tune mode can swap a scaled copy in/out.
// Calibrated values mirror game.js — RTP 95.78%, hit 29.4%, FS 1/208.
let PAY_TABLE = [
  [2.13, 3.19, 5.32,  9.58, 15.97, 31.93,  53.22,  95.80],  // 0 jaguar
  [1.33, 2.13, 3.73,  6.39, 10.64, 21.29,  37.25,  63.86],  // 1 feather
  [0.80, 1.33, 2.40,  4.26,  7.45, 14.90,  25.55,  42.58],  // 2 red mask
  [0.43, 0.64, 1.17,  2.13,  3.73,  7.45,  12.77,  21.29],  // 3 symbol04
  [0.21, 0.32, 0.59,  1.06,  1.86,  3.73,   6.39,  10.64],  // 4 symbol05
  [0.11, 0.16, 0.27,  0.43,  0.74,  1.49,   2.66,   4.52],  // 5 symbol06
  [0.05, 0.08, 0.13,  0.21,  0.37,  0.74,   1.33,   2.40],  // 6 symbol07
  [0.03, 0.05, 0.09,  0.16,  0.27,  0.53,   0.96,   1.60],  // 7 symbol08
  [0.02, 0.03, 0.05,  0.11,  0.16,  0.32,   0.53,   0.96],  // 8 symbol09
];

// `let` so the tuner can rebind them on each probe.
// Calibrated value lands FS triggers at 1/208 spins (target 1/220).
let SCATTER_FILL_PROB    = 0.0339;
let SCATTER_FILL_PROB_FS = 0.004;
const DIG = { wild: 0.06, booster: 0.03, destroyer: 0.025, scatter: 0.02 };

const FS_AWARDS         = { 3: 10, 4: 12, 5: 15, 6: 20 };
const FS_AWARDS_RETRIG  = { 3:  5, 4:  6, 5:  8, 6: 10 };

const MAX_CASCADES = 15;
const MAX_CASCADES_FS_OPEN = 20;
const MAX_WIN_X = 10000; // hard cap on a single spin payout, as x of base bet

// Cell types
const TY = { REG: 0, SCAT: 1, WILD: 2, BOOST: 3, DEST: 4 };

// ============================================================================
// RNG — Math.random with optional seed for reproducible runs.
// ============================================================================
let rngState = 0;
function setSeed(s) { rngState = s >>> 0; }
function seededRand() {
  // xorshift32. `& 0xffffffff` returns a SIGNED 32-bit int in JS, which can
  // be negative — that propagates into Math.floor(rand() * n) and produces
  // out-of-range indices. `>>> 0` keeps the value unsigned.
  let x = rngState;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;  x >>>= 0;
  rngState = x;
  return x / 4294967296;
}
let rand = Math.random;

// ============================================================================
// PURE MATH ENGINE
// ============================================================================
const REG_WEIGHT_TOTAL = REG_WEIGHTS.reduce((a, b) => a + b, 0);
function pickRegSymbol() {
  let r = rand() * REG_WEIGHT_TOTAL;
  for (let i = 0; i < REG_WEIGHTS.length; i++) {
    r -= REG_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return REG_WEIGHTS.length - 1;
}
function rndCell() { return { t: TY.REG, i: pickRegSymbol() }; }

function randomGrid() {
  const g = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) row.push(rndCell());
    g.push(row);
  }
  return g;
}

function makeEmptyMultGrid() {
  const g = [];
  for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill(0));
  return g;
}

function payForCluster(symIdx, size) {
  const row = PAY_TABLE[symIdx];
  const i = Math.min(Math.max(size - 5, 0), row.length - 1);
  return row[i];
}

function findClusters(grid) {
  const seen = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const clusters = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (seen[r][c]) continue;
      const v = grid[r][c];
      if (!v || v.t !== TY.REG) continue;
      const seed = v.i;
      const cells = [];
      const wildCells = [];
      const stack = [[r, c]];
      const localSeen = new Set();
      while (stack.length) {
        const [y, x] = stack.pop();
        if (y < 0 || y >= ROWS || x < 0 || x >= COLS) continue;
        const key = y * COLS + x;
        if (localSeen.has(key)) continue;
        if (seen[y][x]) continue;
        const w = grid[y][x];
        if (!w) continue;
        if (w.t === TY.REG && w.i === seed) {
          localSeen.add(key);
          cells.push([y, x]);
          stack.push([y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]);
        } else if (w.t === TY.WILD) {
          localSeen.add(key);
          cells.push([y, x]);
          wildCells.push([y, x]);
          stack.push([y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]);
        }
      }
      if (cells.length >= 5) {
        for (const [y, x] of cells) seen[y][x] = true;
        clusters.push({ symIdx: seed, cells, wildCells });
      }
    }
  }
  return clusters;
}

function cascade(grid, inFs) {
  for (let c = 0; c < COLS; c++) {
    const movable = [];
    for (let r = 0; r < ROWS; r++) {
      const v = grid[r][c];
      if (v && v.t === TY.REG) movable.push(v);
    }
    let mIdx = movable.length - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      const v = grid[r][c];
      const sticky = v && (v.t === TY.WILD || v.t === TY.SCAT);
      if (sticky) continue;
      if (mIdx >= 0) {
        grid[r][c] = movable[mIdx--];
      } else {
        const colHasScatter = grid.some((row) => row[c] && row[c].t === TY.SCAT);
        const scatProb = inFs ? SCATTER_FILL_PROB_FS : SCATTER_FILL_PROB;
        if (!colHasScatter && rand() < scatProb) {
          grid[r][c] = { t: TY.SCAT };
        } else {
          grid[r][c] = rndCell();
        }
      }
    }
  }
}

function digUp(grid, emptyCells, forceWilds) {
  const result = { wilds: [], boosters: [], destroyers: [], scatters: [] };
  if (!emptyCells.length) return result;
  const pool = emptyCells.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const forced = pool.slice(0, Math.min(forceWilds, pool.length));
  for (const cell of forced) result.wilds.push(cell);
  const forcedSet = new Set(forced.map(([r, c]) => r * COLS + c));
  for (const [r, c] of emptyCells) {
    if (forcedSet.has(r * COLS + c)) continue;
    const roll = rand();
    let acc = 0;
    acc += DIG.wild;       if (roll < acc) { result.wilds.push([r, c]); continue; }
    acc += DIG.booster;    if (roll < acc) { result.boosters.push([r, c]); continue; }
    acc += DIG.destroyer;  if (roll < acc) { result.destroyers.push([r, c]); continue; }
    acc += DIG.scatter;
    if (roll < acc) {
      const colHasScatter = grid.some((row) => row[c] && row[c].t === TY.SCAT);
      if (!colHasScatter) result.scatters.push([r, c]);
    }
  }
  return result;
}

function applyDigUp(grid, cellMult, emptyCells, forceWilds) {
  const r = digUp(grid, emptyCells, forceWilds);
  for (const [y, x] of r.wilds)    grid[y][x] = { t: TY.WILD, m: cellMult[y][x] >= 2 ? 100 : 10 };
  for (const [y, x] of r.boosters) grid[y][x] = { t: TY.BOOST };
  for (const [y, x] of r.destroyers) grid[y][x] = { t: TY.DEST };
  for (const [y, x] of r.scatters) grid[y][x] = { t: TY.SCAT };

  // Booster: bump all existing cellMult by +2 (cap 10), then booster vanishes.
  if (r.boosters.length) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (cellMult[y][x] > 0 && cellMult[y][x] < 10) {
          cellMult[y][x] = Math.min(10, cellMult[y][x] + 2);
        }
      }
    }
    for (const [y, x] of r.boosters) grid[y][x] = null;
  }
  // Destroyer: clear all idx >= 5 (low-tier gems), then destroyer vanishes.
  if (r.destroyers.length) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = grid[y][x];
        if (v && v.t === TY.REG && v.i >= 5) grid[y][x] = null;
      }
    }
    for (const [y, x] of r.destroyers) grid[y][x] = null;
  }
}

// Run one base-game spin OR one FS spin and return totalWin + (in base game)
// fs trigger result. cellMult resets per spin in base, persists in FS.
function runOneSpin({ bet, inFs, cellMult, forceWildsAtStart = 0, startGrid = null }) {
  const grid = startGrid || randomGrid();
  let totalWin = 0;
  let cascadeCount = 0;
  const maxCasc = MAX_CASCADES;

  let firstCascade = true;
  let pendingForceWilds = forceWildsAtStart;

  while (true) {
    const clusters = findClusters(grid);
    if (!clusters.length) break;

    let stepWin = 0;
    const allCellKeys = new Set();
    const wildKeysInRound = new Set();

    for (const cl of clusters) {
      let multSum = 0;
      for (const [r, c] of cl.cells) if (cellMult[r][c] > 0) multSum += cellMult[r][c];
      for (const [r, c] of cl.wildCells) {
        const w = grid[r][c];
        if (w && w.t === TY.WILD) multSum += w.m;
        wildKeysInRound.add(r * COLS + c);
      }
      const base = payForCluster(cl.symIdx, cl.cells.length) * bet;
      const finalMult = Math.max(1, multSum);
      const win = base * finalMult;
      stepWin += win;
      for (const [r, c] of cl.cells) allCellKeys.add(r * COLS + c);
    }
    totalWin += stepWin;

    // Bump cellMult on every winning cell
    for (const key of allCellKeys) {
      const r = Math.floor(key / COLS), c = key % COLS;
      const cur = cellMult[r][c];
      cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
    }
    // Bump wild m
    for (const key of wildKeysInRound) {
      const r = Math.floor(key / COLS), c = key % COLS;
      const w = grid[r][c];
      if (w && w.t === TY.WILD) w.m = Math.min(100, w.m + 10);
    }
    // Clear winning cells
    for (const key of allCellKeys) {
      const r = Math.floor(key / COLS), c = key % COLS;
      grid[r][c] = null;
    }

    // Dig-up
    const empties = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] === null) empties.push([r, c]);
    applyDigUp(grid, cellMult, empties, firstCascade ? pendingForceWilds : 0);
    firstCascade = false;
    pendingForceWilds = 0;

    // Cascade refill
    cascade(grid, inFs);

    cascadeCount++;
    if (cascadeCount > maxCasc) break;
    // Apply max-win cap
    if (totalWin >= MAX_WIN_X * bet) {
      totalWin = MAX_WIN_X * bet;
      break;
    }
  }

  // Count scatters left on board (for FS trigger)
  let scatters = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] && grid[r][c].t === TY.SCAT) scatters++;

  return { totalWin, scatters, grid };
}

// Run a free-spins round: returns total FS-round win.
function runFreeSpinsRound({ bet, initialAward, initialGrid, forceAllScatterToWild = false, forcedWilds = 0 }) {
  // Convert scatters on the grid: half become wilds m=10, the other half become ×10 cellMult.
  const cellMult = makeEmptyMultGrid();
  const grid = initialGrid.map(row => row.slice());
  const scatterCells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] && grid[r][c].t === TY.SCAT) scatterCells.push([r, c]);
  // Shuffle
  for (let i = scatterCells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [scatterCells[i], scatterCells[j]] = [scatterCells[j], scatterCells[i]];
  }
  let forcedConverted = 0;
  for (const [r, c] of scatterCells) {
    if (forceAllScatterToWild || forcedConverted < forcedWilds || rand() < 0.5) {
      grid[r][c] = { t: TY.WILD, m: 10 };
      forcedConverted++;
    } else {
      grid[r][c] = null;
      cellMult[r][c] = 10;
    }
  }

  // Open-cascade once on the prepared grid (no further bet)
  let fsWin = 0;
  let cs = 0;
  while (true) {
    const clusters = findClusters(grid);
    if (!clusters.length) break;
    let stepWin = 0;
    const allKeys = new Set();
    for (const cl of clusters) {
      let multSum = 0;
      for (const [r, c] of cl.cells) if (cellMult[r][c] > 0) multSum += cellMult[r][c];
      for (const [r, c] of cl.wildCells) {
        const w = grid[r][c];
        if (w && w.t === TY.WILD) multSum += w.m;
      }
      const base = payForCluster(cl.symIdx, cl.cells.length) * bet;
      const win = base * Math.max(1, multSum);
      stepWin += win;
      for (const [r, c] of cl.cells) allKeys.add(r * COLS + c);
    }
    fsWin += stepWin;
    for (const key of allKeys) {
      const r = Math.floor(key / COLS), c = key % COLS;
      const cur = cellMult[r][c];
      cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
      grid[r][c] = null;
    }
    const empties = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] === null) empties.push([r, c]);
    applyDigUp(grid, cellMult, empties, 0);
    cascade(grid, true);
    cs++;
    if (cs > MAX_CASCADES_FS_OPEN) break;
    if (fsWin >= MAX_WIN_X * bet) { fsWin = MAX_WIN_X * bet; break; }
  }

  let spinsLeft = initialAward;
  while (spinsLeft > 0) {
    // FS boost: every FS spin guarantees at least 1 wild on first dig-up.
    // Combined with the cellMult persistence across FS spins, this pushes
    // the FS contribution into premium territory (~40-50% of RTP).
    const r = runOneSpin({ bet, inFs: true, cellMult, forceWildsAtStart: 1 });
    fsWin += r.totalWin;
    spinsLeft--;
    if (r.scatters >= 3) {
      const add = FS_AWARDS_RETRIG[Math.min(r.scatters, 6)] || 0;
      spinsLeft += add;
    }
    if (fsWin >= MAX_WIN_X * bet) { fsWin = MAX_WIN_X * bet; break; }
  }
  return fsWin;
}

// One full base-game spin (handles FS trigger automatically).
function fullSpin({ bet, wildSpin = false }) {
  const cellMult = makeEmptyMultGrid();
  const effectiveBet = wildSpin ? bet * 2 : bet;
  const r = runOneSpin({
    bet: effectiveBet, inFs: false, cellMult,
    forceWildsAtStart: wildSpin ? 1 : 0,
  });
  let totalWin = r.totalWin;
  let fsTriggered = false;
  let fsWin = 0;
  if (r.scatters >= 3) {
    fsTriggered = true;
    const award = FS_AWARDS[Math.min(r.scatters, 6)] || 0;
    fsWin = runFreeSpinsRound({ bet: effectiveBet, initialAward: award, initialGrid: r.grid });
    totalWin += fsWin;
  }
  if (totalWin > MAX_WIN_X * effectiveBet) totalWin = MAX_WIN_X * effectiveBet;
  return { totalWin, effectiveBet, fsTriggered, fsWin };
}

// ============================================================================
// SIMULATOR DRIVER
// ============================================================================
function runSim(spins, bet, mode = "base") {
  const stats = {
    spins, bet, mode,
    totalBet: 0, totalWin: 0,
    hits: 0,
    fsTriggers: 0,
    fsTotalWin: 0,
    maxWinX: 0,
    winBuckets: { "0": 0, "0-1x": 0, "1-5x": 0, "5-20x": 0, "20-100x": 0, "100-500x": 0, "500-2000x": 0, "2000-10000x": 0 },
  };
  for (let i = 0; i < spins; i++) {
    const out = mode === "wild"
      ? fullSpin({ bet, wildSpin: true })
      : fullSpin({ bet });
    stats.totalBet += out.effectiveBet;
    stats.totalWin += out.totalWin;
    if (out.totalWin > 0) stats.hits++;
    if (out.fsTriggered) { stats.fsTriggers++; stats.fsTotalWin += out.fsWin; }
    const x = out.totalWin / out.effectiveBet;
    if (x > stats.maxWinX) stats.maxWinX = x;
    if (x === 0) stats.winBuckets["0"]++;
    else if (x <= 1) stats.winBuckets["0-1x"]++;
    else if (x <= 5) stats.winBuckets["1-5x"]++;
    else if (x <= 20) stats.winBuckets["5-20x"]++;
    else if (x <= 100) stats.winBuckets["20-100x"]++;
    else if (x <= 500) stats.winBuckets["100-500x"]++;
    else if (x <= 2000) stats.winBuckets["500-2000x"]++;
    else stats.winBuckets["2000-10000x"]++;

    if ((i + 1) % 50000 === 0) {
      const pct = ((i + 1) / spins * 100).toFixed(1);
      const rtp = (stats.totalWin / stats.totalBet * 100).toFixed(2);
      process.stderr.write(`  ${pct}%  RTP=${rtp}%  hits=${stats.hits}  fs=${stats.fsTriggers}  max=${stats.maxWinX.toFixed(0)}x\n`);
    }
  }
  return stats;
}

function report(stats) {
  const rtp = stats.totalWin / stats.totalBet;
  const hitRate = stats.hits / stats.spins;
  const fsFreq = stats.fsTriggers ? (stats.spins / stats.fsTriggers) : Infinity;
  const fsRtpShare = stats.fsTriggers ? (stats.fsTotalWin / stats.totalBet) : 0;
  const baseRtpShare = rtp - fsRtpShare;

  console.log("\n=== Temple of Xibalba — math sim ===");
  console.log(`Mode:           ${stats.mode}`);
  console.log(`Spins:          ${stats.spins.toLocaleString()}`);
  console.log(`Bet:            ${stats.bet}`);
  console.log(`Total bet:      ${stats.totalBet.toFixed(2)}`);
  console.log(`Total win:      ${stats.totalWin.toFixed(2)}`);
  console.log(`RTP:            ${(rtp * 100).toFixed(2)}%`);
  console.log(`  base RTP:     ${(baseRtpShare * 100).toFixed(2)}%`);
  console.log(`  FS RTP:       ${(fsRtpShare * 100).toFixed(2)}%`);
  console.log(`Hit rate:       ${(hitRate * 100).toFixed(2)}%`);
  console.log(`FS triggers:    ${stats.fsTriggers.toLocaleString()}  (1 / ${fsFreq.toFixed(0)} spins)`);
  console.log(`Avg FS payout:  ${stats.fsTriggers ? (stats.fsTotalWin / stats.fsTriggers / stats.bet).toFixed(1) : 0}x`);
  console.log(`Max win seen:   ${stats.maxWinX.toFixed(1)}x  (cap ${MAX_WIN_X}x)`);
  console.log(`\nWin distribution (% of spins in each bucket):`);
  for (const [k, v] of Object.entries(stats.winBuckets)) {
    const pct = (v / stats.spins * 100).toFixed(2);
    const bar = "█".repeat(Math.min(60, Math.round(pct * 1.2)));
    console.log(`  ${k.padEnd(14)} ${pct.padStart(6)}%  ${bar}`);
  }
}

// ============================================================================
// TUNER — find PAY_TABLE scaler + SCATTER_FILL_PROB that hit target RTP + FS
// frequency. Coarse: 1) tune scatter spawn to hit FS-rate target. 2) binary-
// search a uniform paytable divisor to hit RTP target.
// ============================================================================
const BASE_PAY_TABLE = PAY_TABLE.map(row => row.slice());
function scalePayTable(div) {
  PAY_TABLE = BASE_PAY_TABLE.map(row => row.map(v => v / div));
}
function probeFsRate(spins, scatterProb) {
  SCATTER_FILL_PROB = scatterProb;
  let trig = 0;
  for (let i = 0; i < spins; i++) {
    const out = fullSpin({ bet: 1 });
    if (out.fsTriggered) trig++;
  }
  return spins / Math.max(1, trig);
}
function probeRtp(spins) {
  let totalBet = 0, totalWin = 0;
  for (let i = 0; i < spins; i++) {
    const out = fullSpin({ bet: 1 });
    totalBet += out.effectiveBet;
    totalWin += out.totalWin;
  }
  return totalWin / totalBet;
}
async function tune({ rtpTarget, fsRateTarget, probeSpins }) {
  // Seed each probe identically so binary search sees a deterministic
  // function of the knob — without this, RNG variance on small probes
  // makes the search wander. Verify at the end with a fresh seed.
  const PROBE_SEED = 0xC0FFEE;

  // --- step 1: SCATTER_FILL_PROB so FS rate ≈ target -------------------------
  console.log(`\n[tune] step 1 — calibrate FS rate to 1/${fsRateTarget} spins`);
  let lo = 0.005, hi = 0.20;
  for (let it = 0; it < 16; it++) {
    const mid = (lo + hi) / 2;
    setSeed(PROBE_SEED); rand = seededRand;
    const got = probeFsRate(probeSpins, mid);
    process.stderr.write(`  iter ${it+1}  scatProb=${mid.toFixed(4)}  → 1/${got.toFixed(0)}\n`);
    if (got > fsRateTarget) lo = mid;
    else hi = mid;
    if (Math.abs(got - fsRateTarget) / fsRateTarget < 0.03) break;
  }
  SCATTER_FILL_PROB = (lo + hi) / 2;
  console.log(`  → SCATTER_FILL_PROB = ${SCATTER_FILL_PROB.toFixed(4)}`);

  // --- step 2: PAY_TABLE divisor so RTP ≈ target -----------------------------
  console.log(`\n[tune] step 2 — calibrate paytable divisor to RTP ${(rtpTarget*100).toFixed(2)}%`);
  let dLo = 1, dHi = 50;
  for (let it = 0; it < 18; it++) {
    const mid = (dLo + dHi) / 2;
    scalePayTable(mid);
    setSeed(PROBE_SEED); rand = seededRand;
    const got = probeRtp(probeSpins);
    process.stderr.write(`  iter ${it+1}  div=${mid.toFixed(3)}  → RTP ${(got*100).toFixed(2)}%\n`);
    if (got > rtpTarget) dLo = mid;
    else dHi = mid;
    if (Math.abs(got - rtpTarget) / rtpTarget < 0.002) break;
  }
  const divisor = (dLo + dHi) / 2;
  scalePayTable(divisor);
  console.log(`  → PAY_TABLE divisor = ${divisor.toFixed(3)}`);
  // Restore Math.random for the unseeded verify pass
  rand = Math.random;
  return { scatterProb: SCATTER_FILL_PROB, payDivisor: divisor };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args[0] === "tune") {
  // Usage: node sim.js tune [rtp=0.9630] [fsRate=220] [probeSpins=60000] [verifySpins=500000]
  const RTP_T   = parseFloat(args[1] || "0.9630");
  const FS_T    = parseInt  (args[2] || "220",     10);
  const PROBE   = parseInt  (args[3] || "60000",   10);
  const VERIFY  = parseInt  (args[4] || "500000",  10);
  (async () => {
    const t0 = Date.now();
    const result = await tune({ rtpTarget: RTP_T, fsRateTarget: FS_T, probeSpins: PROBE });
    console.log(`\n[tune] verifying with ${VERIFY.toLocaleString()} spins...`);
    const stats = runSim(VERIFY, 1, "base");
    report(stats);
    console.log(`\n[tune] FINAL:`);
    console.log(`  SCATTER_FILL_PROB = ${result.scatterProb.toFixed(4)}`);
    console.log(`  PAY_TABLE divisor = ${result.payDivisor.toFixed(3)}`);
    console.log(`  Scaled paytable:`);
    for (let i = 0; i < PAY_TABLE.length; i++) {
      const row = PAY_TABLE[i].map(v => +v.toFixed(3)).join(", ");
      console.log(`    [${row}],`);
    }
    console.log(`\n(${((Date.now()-t0)/1000).toFixed(1)}s)`);
  })();
} else {
  const N = parseInt(args[0] || "100000", 10);
  const BET = parseFloat(args[1] || "1.00");
  const MODE = args[2] || "base";
  const SEED = args[3] ? parseInt(args[3], 10) : null;
  if (SEED !== null) { setSeed(SEED); rand = seededRand; }
  const t0 = Date.now();
  const stats = runSim(N, BET, MODE);
  const dt = (Date.now() - t0) / 1000;
  report(stats);
  console.log(`\n(${dt.toFixed(1)}s, ${Math.round(N / dt).toLocaleString()} spins/s)`);
}
