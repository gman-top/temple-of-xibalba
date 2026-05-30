/* Provably-fair RNG built on HMAC-SHA256.
 *
 * Protocol (industry standard, same as Stake / BC.Game / etc):
 *   bytes(i)   = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`)
 *   float(j)   = read 4 bytes from the stream starting at byte j*4,
 *                interpret as uint32 big-endian, divide by 2^32.
 *
 *   - i increments each time the 32-byte HMAC output is exhausted (8 floats
 *     per HMAC block).
 *   - Same (serverSeed, clientSeed, nonce) ALWAYS produces the same float
 *     stream → re-running the engine recomputes the same outcome bit-for-bit.
 *
 * Public:
 *   makeRng(serverSeed, clientSeed, nonce) → function returning floats in [0, 1)
 *   commit(serverSeed)                     → sha256 hash to publish before reveal
 */

"use strict";

const crypto = require("crypto");

function commit(serverSeed) {
  return crypto.createHash("sha256").update(serverSeed).digest("hex");
}

function makeRng(serverSeed, clientSeed, nonce) {
  let blockIdx = 0;
  let block = null;
  let floatIdx = 0; // 0..7 within current block (8 floats per 32 bytes)

  function nextBlock() {
    const h = crypto.createHmac("sha256", serverSeed);
    h.update(`${clientSeed}:${nonce}:${blockIdx}`);
    block = h.digest();
    blockIdx++;
    floatIdx = 0;
  }

  return function rng() {
    if (block === null || floatIdx >= 8) nextBlock();
    const offset = floatIdx * 4;
    floatIdx++;
    // big-endian uint32 / 2^32 → uniform [0, 1)
    const u = block.readUInt32BE(offset);
    return u / 0x1_0000_0000;
  };
}

// Generate a fresh 32-byte server seed (hex string)
function generateServerSeed() {
  return crypto.randomBytes(32).toString("hex");
}

// Default client seed if the player doesn't supply one
function generateClientSeed() {
  return crypto.randomBytes(16).toString("hex");
}

module.exports = { makeRng, commit, generateServerSeed, generateClientSeed };
