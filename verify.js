#!/usr/bin/env node
/* Provably-fair spin verifier.
 *
 * Anyone (player, regulator, third party) can independently replay any
 * past spin from (serverSeed, clientSeed, nonce, action, bet) once the
 * server has revealed the serverSeed. Output: full outcome + serverSeed
 * hash to compare against the pre-commit value the server published before
 * the spin happened.
 *
 * Usage (positional):
 *   node verify.js <serverSeed> <clientSeed> <nonce> <action> <bet> [buyBonusIdx]
 *
 * Or against a running server via fetch:
 *   node verify.js --server http://localhost:3000 <session_id> <nonce>
 *
 * The first form is the canonical audit — no server needed.
 */

"use strict";

const engine = require("./engine");
const { makeRng, commit } = require("./rng");

function help() {
  console.log(`Usage:
  node verify.js <serverSeed> <clientSeed> <nonce> <action> <bet> [buyBonusIdx]

Actions: spin | wild_spin | buy_bonus

Example:
  node verify.js \\
    7a3e1f...deadbeef \\
    cafef00d... \\
    42 \\
    spin \\
    1.00
`);
}

const args = process.argv.slice(2);
if (args.length < 5) { help(); process.exit(1); }

const [serverSeed, clientSeed, nonceStr, action, betStr, buyBonusIdxStr] = args;
const nonce = parseInt(nonceStr, 10);
const bet = parseFloat(betStr);
const buyBonusIdx = parseInt(buyBonusIdxStr || "0", 10);

if (!["spin", "wild_spin", "buy_bonus"].includes(action)) {
  console.error(`Invalid action: ${action}`);
  process.exit(1);
}

const rng = makeRng(serverSeed, clientSeed, nonce);
const state = { balance: 1_000_000, bet, buyBonusOptionIdx: buyBonusIdx };
const result = engine.runFullSpin({ state, action, rng });

const hash = commit(serverSeed);
console.log(`\n=== Spin verification ===`);
console.log(`Inputs:`);
console.log(`  serverSeed       : ${serverSeed}`);
console.log(`  serverSeedHash   : ${hash}`);
console.log(`  clientSeed       : ${clientSeed}`);
console.log(`  nonce            : ${nonce}`);
console.log(`  action           : ${action}`);
console.log(`  bet              : ${bet}`);
if (action === "buy_bonus") console.log(`  buyBonusIdx      : ${buyBonusIdx}`);

console.log(`\nOutput:`);
console.log(`  totalWin (units) : ${result.outcome?.totalWin?.toFixed(4) ?? "—"}`);
console.log(`  totalWin (x bet) : ${(result.outcome ? result.outcome.totalWin / bet : 0).toFixed(2)}x`);
if (result.outcome?.fs) {
  console.log(`  fsTriggered      : yes (${result.outcome.fs.totalAward} spins, win ${result.outcome.fs.fsWin.toFixed(4)})`);
}
console.log(`\nFull outcome JSON:`);
console.log(JSON.stringify(result.outcome, null, 2));
