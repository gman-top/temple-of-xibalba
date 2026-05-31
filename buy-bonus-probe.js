#!/usr/bin/env node
/* Buy Bonus RTP probe.
 *
 * Sim doesn't cover buy-bonus actions — they pay differently from organic
 * FS triggers because the scatter count is uniform 3-6 rather than skewed
 * toward 3. This probe runs each buy-bonus option N times against the
 * production engine and reports per-option RTP so we can confirm none
 * of the four tiers overshoot the global 96.96% ceiling.
 */

"use strict";

const engine = require("./engine");

const N = parseInt(process.argv[2] || "50000", 10);
const BET = parseFloat(process.argv[3] || "1");

// Engine wants a stable rng() injector that returns [0,1) floats. For probe
// we just delegate to Math.random.
const rng = Math.random;

function probe(optIdx) {
  const opt = engine.BUY_OPTIONS[optIdx];
  let totalCost = 0;
  let totalWin = 0;
  const winBuckets = { 0: 0, "0-1x": 0, "1-5x": 0, "5-20x": 0, "20-100x": 0, "100-500x": 0, "500-2000x": 0, "2000-10000x": 0 };
  let maxX = 0;
  const scatterDist = { 3: 0, 4: 0, 5: 0, 6: 0 };
  let totalSpins = 0;

  for (let i = 0; i < N; i++) {
    const state = { balance: 1e9, bet: BET, buyBonusOptionIdx: optIdx };
    const r = engine.runFullSpin({ state, action: "buy_bonus", rng });
    const cost = r.outcome.cost;
    const win = r.outcome.totalWin;
    totalCost += cost;
    totalWin += win;
    const xCost = win / cost;
    if (xCost > maxX) maxX = xCost;
    if (win === 0)              winBuckets["0"]++;
    else if (xCost < 1)         winBuckets["0-1x"]++;
    else if (xCost < 5)         winBuckets["1-5x"]++;
    else if (xCost < 20)        winBuckets["5-20x"]++;
    else if (xCost < 100)       winBuckets["20-100x"]++;
    else if (xCost < 500)       winBuckets["100-500x"]++;
    else if (xCost < 2000)      winBuckets["500-2000x"]++;
    else                        winBuckets["2000-10000x"]++;
    scatterDist[r.outcome.scatterCellsAtTrigger.length]++;
    totalSpins += r.outcome.fs.fsSpins.length + 1;  // +1 for open cascade
  }
  return {
    optIdx, label: opt.label, costMult: opt.cost,
    iterations: N,
    totalCost, totalWin,
    rtp: totalWin / totalCost,
    avgPayout: totalWin / N,
    avgPayoutX: totalWin / N / BET,
    maxX,
    winBuckets,
    scatterDist,
    avgFsSpins: totalSpins / N,
  };
}

console.log(`\n=== Temple of Xibalba — Buy Bonus RTP probe ===`);
console.log(`Iterations per option: ${N.toLocaleString()}`);
console.log(`Bet: ${BET}`);
console.log(``);

const results = [];
for (let i = 0; i < engine.BUY_OPTIONS.length; i++) {
  process.stderr.write(`probing option ${i} (${engine.BUY_OPTIONS[i].label})...\n`);
  const t0 = Date.now();
  const r = probe(i);
  r.timeMs = Date.now() - t0;
  results.push(r);
}

console.log(`Option            Cost  Iter      RTP       AvgPayout    Max    AvgFsSpins`);
console.log(`----------------  ----  --------  --------  -----------  -----  ----------`);
for (const r of results) {
  console.log(
    `${r.label.padEnd(16)}  ${String(r.costMult).padStart(4)}×  `
    + `${String(r.iterations).padStart(8)}  `
    + `${(r.rtp * 100).toFixed(2).padStart(6)}%   `
    + `${r.avgPayoutX.toFixed(2).padStart(9)}×   `
    + `${r.maxX.toFixed(1).padStart(5)}×  `
    + `${r.avgFsSpins.toFixed(1)}`
  );
}
console.log(``);

const CEIL = 0.9696;
const overshoots = results.filter(r => r.rtp > CEIL);
if (overshoots.length) {
  console.log(`!!  WARNING — ${overshoots.length} option(s) over the 96.96% ceiling:`);
  for (const o of overshoots) {
    console.log(`!!    ${o.label}: ${(o.rtp * 100).toFixed(2)}% (target ≤ 96.96%)`);
    console.log(`!!    Scale multiplier suggested: ${(CEIL / o.rtp).toFixed(4)}`);
  }
} else {
  console.log(`OK — all options under the 96.96% ceiling.`);
}

// Distribution per option
console.log(`\nWin distribution by option (% of buys in each bucket):`);
for (const r of results) {
  console.log(`\n  ${r.label} (${r.costMult}×):`);
  for (const [k, v] of Object.entries(r.winBuckets)) {
    const pct = (v / r.iterations * 100).toFixed(2);
    const bar = "█".repeat(Math.min(50, Math.round(pct * 0.6)));
    console.log(`    ${k.padEnd(14)} ${pct.padStart(6)}%  ${bar}`);
  }
}

console.log(`\nScatter-count distribution (should be uniform ~25% each):`);
for (const r of results) {
  process.stdout.write(`  ${r.label.padEnd(16)}: `);
  for (const [n, v] of Object.entries(r.scatterDist)) {
    process.stdout.write(`${n}=${(v / r.iterations * 100).toFixed(1)}%  `);
  }
  process.stdout.write(`\n`);
}
