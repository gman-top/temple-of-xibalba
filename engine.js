/* Temple of Xibalba — pure game engine.
 *
 * All slot math lives here: cluster detection, cascade, dig-up, FS round,
 * multipliers. NO Math.random anywhere — every random draw comes through
 * the injected `rng()` function. Same code drives:
 *   - sim.js          (Math.random RNG → Monte Carlo)
 *   - server.js       (HMAC-SHA256 RNG → provably fair production spins)
 *   - verify.js       (HMAC-SHA256 RNG → audit replay of any past spin)
 *
 * runFullSpin returns a deterministic `outcome` log the client can replay
 * step-by-step for animation. Re-running the engine with the same
 * (rng, state, args) ALWAYS produces the same outcome.
 */

"use strict";

const COLS = 5;
const ROWS = 7;

const REG_COUNT = 9;
const REG_WEIGHTS = [3, 4, 5, 6, 9, 12, 15, 18, 22];

const PAY_TABLE = [
  // Cluster size:    5,    6,    7,    8,    9,   10,   11,    12+
  // Re-balanced shape: low-tier symbols and small-cluster (5-7) tiers
  // pay meaningfully more than before (was: 5-cluster of sym09 = 0.02×);
  // top-tier 12+ trimmed so global RTP stays at ~95.3% — comfortably
  // under the 96.96% ceiling. Verified at 1.5M-spin sim. To recalibrate,
  // edit sim.js raw shape and run `node sim.js tune <rtp> <fsRate>`.
  [1.242, 1.722, 2.521, 3.728, 5.503,  8.166, 12.249, 18.464],  // jaguar
  [0.817, 1.135, 1.669, 2.486, 3.657,  5.503,  8.344, 12.782],  // feather
  [0.550, 0.763, 1.135, 1.704, 2.521,  3.835,  5.858,  9.232],  // red mask
  [0.337, 0.479, 0.711, 1.066, 1.562,  2.414,  3.728,  6.036],  // sym04
  [0.206, 0.292, 0.427, 0.639, 0.940,  1.455,  2.273,  3.728],  // sym05
  [0.127, 0.177, 0.263, 0.391, 0.586,  0.906,  1.420,  2.379],  // sym06
  [0.079, 0.111, 0.163, 0.245, 0.363,  0.561,  0.888,  1.491],  // sym07
  [0.050, 0.071, 0.107, 0.159, 0.234,  0.363,  0.576,  0.976],  // sym08
  [0.032, 0.047, 0.068, 0.103, 0.149,  0.234,  0.372,  0.639],  // sym09
];

const SCATTER_FILL_PROB    = 0.0339;
const SCATTER_FILL_PROB_FS = 0.004;
const DIG = { wild: 0.06, booster: 0.03, destroyer: 0.025, scatter: 0.02 };

const FS_AWARDS         = { 3: 10, 4: 12, 5: 15, 6: 20 };
const FS_AWARDS_RETRIG  = { 3:  5, 4:  6, 5:  8, 6: 10 };

const MAX_CASCADES = 15;
const MAX_CASCADES_FS_OPEN = 20;
const MAX_WIN_X = 10000;

const BET_LEVELS = [0.20, 0.50, 1.00, 2.00, 5.00, 10.00, 25.00, 50.00];

// Buy Bonus tiers. Each tier has progressively bigger boosts so the cost
// scaling is justified — without these boosts every option pays roughly the
// same (~40× bet) and the cheap tier becomes a guaranteed-profit arbitrage.
// Costs are calibrated so every option's RTP lands ≤ 96.96%. Re-run
// `node buy-bonus-probe.js` after tweaking any field below to verify.
//
//   wilds         — forced wild conversions at scatter positions (rest go to ×10 mult cells).
//   startingWildM — multiplier on those forced wilds (and on the all-wild flood for ALL SCATTERS).
//   bonusFsSpins  — extra FS spins added on top of the scatter-count award.
//   bonusMultCells — starting ×N cell multipliers planted on random non-scatter cells.
// Each option now delivers a DETERMINISTIC FS spin count: always 3 scatters
// (10 base spins) + bonusFsSpins per tier. So the player knows exactly what
// they're paying for: REGULAR=10 FS, 1 WILD=12, 2 WILDS=15, ALL SCATTERS=18.
const BUY_OPTIONS = [
  { idx: 0, label: "REGULAR",      cost:  37,  wilds: 0, startingWildM: 10, bonusFsSpins: 0,  bonusMultCells: { count: 0, mult: 0 } },
  { idx: 1, label: "1 WILD",       cost:  47,  wilds: 1, startingWildM: 15, bonusFsSpins: 2,  bonusMultCells: { count: 0, mult: 0 } },
  { idx: 2, label: "2 WILDS",      cost:  63,  wilds: 2, startingWildM: 25, bonusFsSpins: 5,  bonusMultCells: { count: 2, mult: 4 } },
  { idx: 3, label: "ALL SCATTERS", cost:  82,  wilds: 3, startingWildM: 30, bonusFsSpins: 8,  bonusMultCells: { count: 3, mult: 4 }, allWilds: true },
];

const TY = { REG: 0, SCAT: 1, WILD: 2, BOOST: 3, DEST: 4 };

const REG_WEIGHT_TOTAL = REG_WEIGHTS.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// helpers — every randomized helper takes `rng` so the engine is pure
// ---------------------------------------------------------------------------
function pickRegSymbol(rng) {
  let r = rng() * REG_WEIGHT_TOTAL;
  for (let i = 0; i < REG_WEIGHTS.length; i++) {
    r -= REG_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return REG_WEIGHTS.length - 1;
}
function rndCell(rng) { return { t: TY.REG, i: pickRegSymbol(rng) }; }
function randomGrid(rng) {
  const g = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) row.push(rndCell(rng));
    g.push(row);
  }
  return g;
}
function makeEmptyMultGrid() {
  const g = [];
  for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill(0));
  return g;
}
function cloneGrid(g) { return g.map((row) => row.map((v) => (v ? { ...v } : null))); }
function cloneMult(m) { return m.map((row) => row.slice()); }

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

function cascade(grid, inFs, rng) {
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
        if (!colHasScatter && rng() < scatProb) {
          grid[r][c] = { t: TY.SCAT };
        } else {
          grid[r][c] = rndCell(rng);
        }
      }
    }
  }
}

function digUp(grid, emptyCells, forceWilds, rng) {
  const result = { wilds: [], boosters: [], destroyers: [], scatters: [] };
  if (!emptyCells.length) return result;
  const pool = emptyCells.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const forced = pool.slice(0, Math.min(forceWilds, pool.length));
  for (const cell of forced) result.wilds.push(cell);
  const forcedSet = new Set(forced.map(([r, c]) => r * COLS + c));
  for (const [r, c] of emptyCells) {
    if (forcedSet.has(r * COLS + c)) continue;
    const roll = rng();
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

function applyDigUp(grid, cellMult, emptyCells, forceWilds, rng) {
  const r = digUp(grid, emptyCells, forceWilds, rng);
  for (const [y, x] of r.wilds)      grid[y][x] = { t: TY.WILD, m: cellMult[y][x] >= 2 ? 100 : 10 };
  for (const [y, x] of r.boosters)   grid[y][x] = { t: TY.BOOST };
  for (const [y, x] of r.destroyers) grid[y][x] = { t: TY.DEST };
  for (const [y, x] of r.scatters)   grid[y][x] = { t: TY.SCAT };

  let boosterDestroyedCells = [];
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
  let destroyerKilled = [];
  if (r.destroyers.length) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = grid[y][x];
        if (v && v.t === TY.REG && v.i >= 5) { destroyerKilled.push([y, x]); grid[y][x] = null; }
      }
    }
    for (const [y, x] of r.destroyers) grid[y][x] = null;
  }
  return { ...r, destroyerKilled };
}

// ---------------------------------------------------------------------------
// runOneSpin — single base/FS spin. Returns outcome log (replayable) +
// final state for grid/cellMult.
// ---------------------------------------------------------------------------
function runOneSpin({ bet, inFs, cellMult, forceWildsAtStart = 0, startGrid = null, rng }) {
  const initialGrid = startGrid ? cloneGrid(startGrid) : randomGrid(rng);
  const grid = cloneGrid(initialGrid);
  let totalWin = 0;
  let cascadeCount = 0;
  const cascades = [];
  let pendingForceWilds = forceWildsAtStart;

  while (true) {
    const clusters = findClusters(grid);
    if (!clusters.length) break;

    let stepWin = 0;
    const allCellKeys = new Set();
    const wildKeysInRound = new Set();
    const matchedClusters = [];

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
      const win = +(base * finalMult).toFixed(4);
      stepWin += win;
      matchedClusters.push({
        symIdx: cl.symIdx,
        cells: cl.cells.map(([r, c]) => [r, c]),
        wildCells: cl.wildCells.map(([r, c]) => [r, c]),
        size: cl.cells.length,
        multSum,
        win,
      });
      for (const [r, c] of cl.cells) allCellKeys.add(r * COLS + c);
    }
    totalWin += stepWin;

    for (const key of allCellKeys) {
      const r = Math.floor(key / COLS), c = key % COLS;
      const cur = cellMult[r][c];
      cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
    }
    for (const key of wildKeysInRound) {
      const r = Math.floor(key / COLS), c = key % COLS;
      const w = grid[r][c];
      if (w && w.t === TY.WILD) w.m = Math.min(100, w.m + 10);
    }
    for (const key of allCellKeys) {
      const r = Math.floor(key / COLS), c = key % COLS;
      grid[r][c] = null;
    }

    const empties = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] === null) empties.push([r, c]);
    const digResult = applyDigUp(grid, cellMult, empties, pendingForceWilds, rng);
    pendingForceWilds = 0;
    cascade(grid, inFs, rng);

    cascades.push({
      clusters: matchedClusters,
      stepWin,
      dig: {
        wilds: digResult.wilds, boosters: digResult.boosters,
        destroyers: digResult.destroyers, scatters: digResult.scatters,
        destroyerKilled: digResult.destroyerKilled,
      },
      gridAfter: cloneGrid(grid),
      multAfter: cloneMult(cellMult),
    });

    cascadeCount++;
    if (cascadeCount > MAX_CASCADES) break;
    if (totalWin >= MAX_WIN_X * bet) {
      totalWin = MAX_WIN_X * bet;
      break;
    }
  }

  let scatters = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] && grid[r][c].t === TY.SCAT) scatters++;

  return { totalWin: +totalWin.toFixed(4), scatters, grid, initialGrid, cascades };
}

// FS round: takes the post-spin grid (with scatters) + persistent cellMult
// (which may already carry multipliers from base game). Returns total FS win
// + array of per-spin outcomes for client replay.
// Free-spins entry. Used by:
//   - organic trigger (3+ scatters from base spin): forcedWilds=0,
//     forceAllScatterToWild=false, deterministicConversion=false
//     → 50/50 random per-scatter conversion (legacy behaviour).
//   - buy-bonus action: forcedWilds=N, deterministicConversion=true
//     → exactly N scatters become wild, the rest become ×10 mult cells.
//       No randomness in the conversion, so option-N pays meaningfully
//       differently from option-N+1 (a wild is much stronger than a
//       passive mult cell in chain reactions).
function runFreeSpinsRound({
  bet, scatterCount, initialGrid,
  forceAllScatterToWild = false,
  forcedWilds = 0,
  deterministicConversion = false,
  startingWildM = 10,
  bonusFsSpins = 0,
  bonusMultCells = null,
  rng,
}) {
  const baseAward = FS_AWARDS[Math.min(scatterCount, 6)] || 0;
  const award = baseAward + bonusFsSpins;
  const cellMult = makeEmptyMultGrid();
  const grid = cloneGrid(initialGrid);

  const scatterCells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] && grid[r][c].t === TY.SCAT) scatterCells.push([r, c]);
  for (let i = scatterCells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [scatterCells[i], scatterCells[j]] = [scatterCells[j], scatterCells[i]];
  }
  const conversion = [];
  let forcedConverted = 0;
  for (const [r, c] of scatterCells) {
    const shouldBeWild =
      forceAllScatterToWild
      || forcedConverted < forcedWilds
      || (!deterministicConversion && rng() < 0.5);
    if (shouldBeWild) {
      grid[r][c] = { t: TY.WILD, m: startingWildM };
      forcedConverted++;
      conversion.push({ r, c, to: "wild", m: startingWildM });
    } else {
      grid[r][c] = null;
      cellMult[r][c] = 10;
      conversion.push({ r, c, to: "mult", value: 10 });
    }
  }

  // Buy Bonus higher tiers also pre-seed extra ×N cell multipliers on random
  // non-scatter cells. The player sees these "lit up" cells before the open
  // cascade — they make the higher-cost tiers visibly more powerful.
  if (bonusMultCells && bonusMultCells.count > 0 && bonusMultCells.mult > 0) {
    const candidates = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (cellMult[r][c] === 0 && !(grid[r][c] && grid[r][c].t === TY.WILD)) candidates.push([r, c]);
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const n = Math.min(bonusMultCells.count, candidates.length);
    for (let i = 0; i < n; i++) {
      const [r, c] = candidates[i];
      cellMult[r][c] = bonusMultCells.mult;
      conversion.push({ r, c, to: "mult", value: bonusMultCells.mult });
    }
  }

  // Open-cascade once on prepared grid (no extra bet, may form clusters)
  let fsWin = 0;
  let cs = 0;
  const openCascades = [];
  while (true) {
    const clusters = findClusters(grid);
    if (!clusters.length) break;
    let stepWin = 0;
    const allKeys = new Set();
    const matched = [];
    for (const cl of clusters) {
      let multSum = 0;
      for (const [r, c] of cl.cells) if (cellMult[r][c] > 0) multSum += cellMult[r][c];
      for (const [r, c] of cl.wildCells) {
        const w = grid[r][c];
        if (w && w.t === TY.WILD) multSum += w.m;
      }
      const base = payForCluster(cl.symIdx, cl.cells.length) * bet;
      const win = +(base * Math.max(1, multSum)).toFixed(4);
      stepWin += win;
      matched.push({ symIdx: cl.symIdx, cells: cl.cells, wildCells: cl.wildCells, size: cl.cells.length, multSum, win });
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
    const dig = applyDigUp(grid, cellMult, empties, 0, rng);
    cascade(grid, true, rng);
    openCascades.push({ clusters: matched, stepWin, dig, gridAfter: cloneGrid(grid), multAfter: cloneMult(cellMult) });
    cs++;
    if (cs > MAX_CASCADES_FS_OPEN) break;
    if (fsWin >= MAX_WIN_X * bet) { fsWin = MAX_WIN_X * bet; break; }
  }

  const fsSpins = [];
  let spinsLeft = award;
  let spinsTotal = award;
  let retriggers = [];
  while (spinsLeft > 0) {
    const out = runOneSpin({ bet, inFs: true, cellMult, forceWildsAtStart: 1, rng });
    fsWin += out.totalWin;
    spinsLeft--;
    let retrigger = 0;
    if (out.scatters >= 3) {
      retrigger = FS_AWARDS_RETRIG[Math.min(out.scatters, 6)] || 0;
      spinsLeft += retrigger;
      spinsTotal += retrigger;
      retriggers.push({ atSpin: spinsTotal - spinsLeft, count: retrigger });
    }
    fsSpins.push({
      initialGrid: out.initialGrid,
      cascades: out.cascades,
      totalWin: out.totalWin,
      scatters: out.scatters,
      retrigger,
    });
    if (fsWin >= MAX_WIN_X * bet) { fsWin = MAX_WIN_X * bet; break; }
  }
  return { totalAward: spinsTotal, conversion, openCascades, fsSpins, fsWin: +fsWin.toFixed(4), retriggers };
}

// runFullSpin — the public entry point. Takes server state + action + rng,
// returns { outcome, newState }. Outcome is fully replayable client-side.
function runFullSpin({ state, action, rng }) {
  const bet = state.bet;
  const wildSpin = action === "wild_spin";
  const buyOpt = (action === "buy_bonus") ? BUY_OPTIONS[state.buyBonusOptionIdx] : null;
  const effectiveBet = wildSpin ? bet * 2 : bet;

  // cellMult resets per spin in base game
  const cellMult = makeEmptyMultGrid();
  const forceWilds = wildSpin ? 1 : 0;

  let cost = 0;
  let initialFsScatters = 0;
  let scatterCellsAtTrigger = [];

  if (action === "buy_bonus") {
    // Buy bonus skips the base spin and lands a FIXED 3 scatters.
    //
    // Each tier therefore delivers a deterministic FS spin count
    // (10 + bonusFsSpins) instead of the previous variable 10/12/15/20 that
    // confused players: paying for ALL SCATTERS and getting 12 spins while
    // a REGULAR neighbour got 15 felt unfair. The progressive boost across
    // tiers (bigger wild multipliers, more bonus spins, pre-seeded mult
    // cells) is what differentiates the cost — not random scatter luck.
    cost = buyOpt.cost * bet;
    const grid = randomGrid(rng);
    const scatterCount = 3;
    initialFsScatters = scatterCount;
    const positions = [];
    const cols = [0, 1, 2, 3, 4];
    for (let i = cols.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cols[i], cols[j]] = [cols[j], cols[i]];
    }
    for (let i = 0; i < scatterCount; i++) {
      const c = cols[i];
      const r = Math.floor(rng() * ROWS);
      positions.push([r, c]);
      grid[r][c] = { t: TY.SCAT };
    }
    scatterCellsAtTrigger = positions;
    const fs = runFreeSpinsRound({
      bet, scatterCount, initialGrid: grid,
      forceAllScatterToWild: !!buyOpt.allWilds,
      forcedWilds: buyOpt.wilds,
      // Deterministic conversion: exactly forcedWilds scatters become wild,
      // the rest become ×10 multiplier cells. This makes the four buy
      // tiers behave meaningfully differently (otherwise the legacy 50/50
      // randomness produced ~the same wild count for every tier).
      deterministicConversion: true,
      startingWildM: buyOpt.startingWildM,
      bonusFsSpins: buyOpt.bonusFsSpins,
      bonusMultCells: buyOpt.bonusMultCells,
      rng,
    });
    return {
      newState: { balance: +(state.balance - cost + fs.fsWin).toFixed(2) },
      outcome: {
        action: "buy_bonus", bet, cost,
        buyOption: buyOpt.idx,
        scatterCellsAtTrigger,
        fs,
        totalWin: fs.fsWin,
      },
    };
  }

  // base or wild spin: deduct bet, run one spin, maybe trigger FS
  if (state.balance < effectiveBet) {
    return { error: "INSUFFICIENT_BALANCE", newState: { balance: state.balance }, outcome: null };
  }
  cost = effectiveBet;
  const r = runOneSpin({ bet: effectiveBet, inFs: false, cellMult, forceWildsAtStart: forceWilds, rng });

  let fs = null;
  let totalWin = r.totalWin;
  if (r.scatters >= 3) {
    fs = runFreeSpinsRound({ bet: effectiveBet, scatterCount: r.scatters, initialGrid: r.grid, rng });
    totalWin += fs.fsWin;
  }
  if (totalWin >= MAX_WIN_X * effectiveBet) totalWin = MAX_WIN_X * effectiveBet;

  return {
    newState: { balance: +(state.balance - cost + totalWin).toFixed(2) },
    outcome: {
      action,
      bet: effectiveBet,
      cost,
      base: {
        initialGrid: r.initialGrid,
        cascades: r.cascades,
        totalWin: r.totalWin,
        scatters: r.scatters,
      },
      fs,
      totalWin: +totalWin.toFixed(4),
    },
  };
}

module.exports = {
  COLS, ROWS, REG_COUNT, REG_WEIGHTS, PAY_TABLE,
  SCATTER_FILL_PROB, SCATTER_FILL_PROB_FS, DIG,
  FS_AWARDS, FS_AWARDS_RETRIG, MAX_CASCADES, MAX_WIN_X,
  BET_LEVELS, BUY_OPTIONS, TY,
  pickRegSymbol, rndCell, randomGrid, makeEmptyMultGrid,
  findClusters, cascade, digUp, applyDigUp,
  runOneSpin, runFreeSpinsRound, runFullSpin,
};
