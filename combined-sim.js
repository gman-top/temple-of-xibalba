#!/usr/bin/env node
/* Combined RTP sim — base spins + buy-bonus actions in the same run.
 *
 * Verifies that the total game RTP (every bet + every buy-bonus cost
 * vs every win) stays under the 96.96% ceiling. Important because the
 * individual sims test each path in isolation; this confirms the
 * aggregate is safe when a real player mixes them.
 *
 *   node combined-sim.js [baseSpins=1000000] [buyBonuses=1000] [bet=1]
 */

"use strict";

const engine = require("./engine");

const baseSpins = parseInt(process.argv[2] || "1000000", 10);
const buyCount  = parseInt(process.argv[3] || "1000", 10);
const BET       = parseFloat(process.argv[4] || "1");

const rng = Math.random;

let totalBet = 0, totalWin = 0;
let baseBet = 0, baseWin = 0;
let buyBet = 0, buyWin = 0;
const buckets = { 0: 0, "0-1x": 0, "1-5x": 0, "5-20x": 0, "20-100x": 0, "100-500x": 0, "500-2000x": 0, "2000-10000x": 0 };
const perTier = { 0: { bet: 0, win: 0, n: 0 }, 1: { bet: 0, win: 0, n: 0 }, 2: { bet: 0, win: 0, n: 0 }, 3: { bet: 0, win: 0, n: 0 } };
let baseHits = 0, fsTriggers = 0, fsTotalWin = 0, maxX = 0;

function tickBuckets(win, bet) {
  const x = bet > 0 ? win / bet : 0;
  if (x > maxX) maxX = x;
  if (win === 0)         buckets["0"]++;
  else if (x < 1)        buckets["0-1x"]++;
  else if (x < 5)        buckets["1-5x"]++;
  else if (x < 20)       buckets["5-20x"]++;
  else if (x < 100)      buckets["20-100x"]++;
  else if (x < 500)      buckets["100-500x"]++;
  else if (x < 2000)     buckets["500-2000x"]++;
  else                   buckets["2000-10000x"]++;
}

console.log(`=== Temple of Xibalba — combined RTP sim ===`);
console.log(`Base spins:   ${baseSpins.toLocaleString()}`);
console.log(`Buy bonuses:  ${buyCount.toLocaleString()} (250 per tier)`);
console.log(`Bet:          ${BET}`);
console.log(``);

// Base spins
process.stderr.write(`running ${baseSpins} base spins...\n`);
const t0 = Date.now();
for (let i = 0; i < baseSpins; i++) {
  const state = { balance: 1e9, bet: BET, buyBonusOptionIdx: 0 };
  const r = engine.runFullSpin({ state, action: "spin", rng });
  const cost = r.outcome.cost;
  const win = r.outcome.totalWin;
  totalBet += cost; totalWin += win;
  baseBet  += cost; baseWin  += win;
  if (win > 0) baseHits++;
  tickBuckets(win, cost);
  if (r.outcome.fs) { fsTriggers++; fsTotalWin += r.outcome.fs.fsWin; }
  if ((i + 1) % 100000 === 0) {
    process.stderr.write(`  ${((i+1)/baseSpins*100).toFixed(0)}%  base RTP=${(baseWin/baseBet*100).toFixed(2)}%\n`);
  }
}
const baseT = Date.now() - t0;
process.stderr.write(`base done in ${baseT}ms (${(baseSpins/(baseT/1000)).toFixed(0)} spins/s)\n\n`);

// Buy bonuses: 250 per tier, interleaved
process.stderr.write(`running ${buyCount} buy bonuses (${buyCount/4} per tier)...\n`);
const perTierCount = Math.floor(buyCount / 4);
for (let tier = 0; tier < 4; tier++) {
  for (let i = 0; i < perTierCount; i++) {
    const state = { balance: 1e9, bet: BET, buyBonusOptionIdx: tier };
    const r = engine.runFullSpin({ state, action: "buy_bonus", rng });
    const cost = r.outcome.cost;
    const win = r.outcome.totalWin;
    totalBet += cost; totalWin += win;
    buyBet   += cost; buyWin   += win;
    perTier[tier].bet += cost;
    perTier[tier].win += win;
    perTier[tier].n   += 1;
    tickBuckets(win, cost);
  }
}

const rtp     = totalWin / totalBet;
const baseRtp = baseWin / baseBet;
const buyRtp  = buyWin / buyBet;

console.log(`Total                    ${(totalBet).toLocaleString().padStart(14)} bet · ${(totalWin).toFixed(2).padStart(14)} win`);
console.log(`  RTP overall:    ${(rtp*100).toFixed(3)}%`);
console.log(`                  ${rtp <= 0.9696 ? "OK — under 96.96% ceiling" : "!! OVER 96.96% CEILING"}`);
console.log(``);
console.log(`Base game        ${(baseBet).toLocaleString().padStart(14)} bet · ${(baseWin).toFixed(2).padStart(14)} win`);
console.log(`  RTP:            ${(baseRtp*100).toFixed(3)}%`);
console.log(`  Hit rate:       ${(baseHits/baseSpins*100).toFixed(2)}%`);
console.log(`  FS triggers:    ${fsTriggers.toLocaleString()}  (1 / ${(baseSpins/Math.max(1,fsTriggers)).toFixed(0)} spins)`);
console.log(`  FS share:       ${(fsTotalWin/baseBet*100).toFixed(2)}%`);
console.log(``);
console.log(`Buy bonus        ${(buyBet).toLocaleString().padStart(14)} bet · ${(buyWin).toFixed(2).padStart(14)} win`);
console.log(`  RTP:            ${(buyRtp*100).toFixed(3)}%`);
console.log(``);
console.log(`Per tier breakdown:`);
const labels = ["REGULAR", "1 WILD", "2 WILDS", "ALL SCATTERS"];
for (let tier = 0; tier < 4; tier++) {
  const t = perTier[tier];
  if (t.n === 0) continue;
  const r = t.win / t.bet;
  console.log(`  ${labels[tier].padEnd(14)} ${t.n}x  cost ${engine.BUY_OPTIONS[tier].cost}×  RTP ${(r*100).toFixed(2)}%  ${r <= 0.9696 ? "OK" : "!!"}`);
}
console.log(``);
console.log(`Max win seen: ${maxX.toFixed(1)}× bet (cap ${engine.MAX_WIN_X}×)`);
console.log(`\nWin distribution (% of ALL actions in each bucket):`);
const totalN = baseSpins + buyCount;
for (const [k, v] of Object.entries(buckets)) {
  const pct = (v / totalN * 100).toFixed(2);
  const bar = "█".repeat(Math.min(60, Math.round(pct * 1.2)));
  console.log(`  ${k.padEnd(14)} ${pct.padStart(6)}%  ${bar}`);
}
