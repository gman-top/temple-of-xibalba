# Temple of Xibalba — Provably-Fair Protocol

Every spin in this slot is cryptographically auditable. The server commits to a secret
seed before the spin happens; once the seed is revealed (after rotation), anyone with
the public information can re-run the engine and confirm the outcome bit-for-bit.

## Files

| File         | Role                                                                |
|--------------|---------------------------------------------------------------------|
| `engine.js`  | Pure game math. RNG injected — no `Math.random` anywhere.            |
| `rng.js`     | HMAC-SHA256 RNG that yields floats from (serverSeed, clientSeed, nonce). |
| `db.js`      | SQLite layer: sessions, seed history, spin audit trail.              |
| `server.js`  | Express HTTP server. Endpoints under `/api/...`.                     |
| `verify.js`  | CLI auditor. Replays any spin from public values + revealed seed.    |
| `game.js`    | Thin frontend client. Falls back to local RNG when offline.          |
| `sim.js`     | Monte Carlo math sim + auto-tuner.                                   |

## RNG construction

```
bytes(blockIdx) = HMAC_SHA256( serverSeed, `${clientSeed}:${nonce}:${blockIdx}` )
float(j)        = read 4 bytes from byte j*4 of the current block
                  as big-endian uint32, divide by 2^32
                → uniform in [0, 1)
```

Each HMAC block (32 bytes) yields 8 floats; `blockIdx` advances when exhausted.
The same triple `(serverSeed, clientSeed, nonce)` always produces the same float
stream → the engine deterministically produces the same `outcome`.

## Commit-reveal lifecycle

1. **Session start** (`POST /api/session`)
   Server generates a random 32-byte `serverSeed`, returns the public commitment
   `serverSeedHash = sha256(serverSeed)` plus a 16-byte default `clientSeed`. The
   player can override `clientSeed` either now or via `/seed` later.

2. **Spin** (`POST /api/session/:id/spin`)
   Server runs the engine with the active seeds at the current nonce, persists
   the full outcome, returns it to the client, and increments nonce. The
   `serverSeed` stays secret.

3. **Rotate** (`POST /api/session/:id/seed`)
   Server REVEALS the current `serverSeed`, generates a new one, returns both
   the revealed seed and the new `serverSeedHash`. The new commitment is
   immediately active; nonce resets to 0.

4. **Audit** (anyone)
   Take any past spin's `nonce`, the revealed `serverSeed`, the `clientSeed`
   in effect at that nonce, the `bet`, the `action`, and:
   ```
   node verify.js <serverSeed> <clientSeed> <nonce> <action> <bet> [buyBonusIdx]
   ```
   Compare the printed `totalWin` (and full outcome JSON) against the spin
   record. They will match exactly.

   Also confirm `sha256(serverSeed) == server_seed_hash` from the spin record —
   this proves the server didn't change the seed after seeing the bet.

## Endpoints

| Method | Path                                  | Body                              | Notes                                       |
|--------|---------------------------------------|-----------------------------------|---------------------------------------------|
| POST   | `/api/session`                        | `{ clientSeed? }`                 | New session.                                |
| GET    | `/api/session/:id`                    |                                   | Public state.                               |
| POST   | `/api/session/:id/seed`               | `{ clientSeed? }`                 | Rotate. Reveals current `serverSeed`.       |
| POST   | `/api/session/:id/bet`                | `{ betIdx }`                      | Update bet level.                           |
| POST   | `/api/session/:id/buy-bonus-idx`      | `{ idx }`                         | Pre-select Buy Bonus option.                |
| POST   | `/api/session/:id/spin`               | `{ action: "spin"\|"wild_spin" }` | Run a spin.                                 |
| POST   | `/api/session/:id/buy-bonus`          |                                   | Buy & open the pre-selected bonus.          |
| GET    | `/api/session/:id/history?limit=50`   |                                   | Recent spin audit log.                      |
| GET    | `/api/session/:id/seeds`              |                                   | Revealed past seed pairs.                   |
| POST   | `/api/verify`                         | see verify.js                     | Server-side replay (audit endpoint).        |

## Running

```bash
npm install
node server.js                    # serves API + static frontend on :3000
node sim.js 1000000 1.00          # Monte Carlo verification of math
node sim.js tune 0.9630 220       # re-tune to a new RTP target
node verify.js <ss> <cs> <n> spin 1.00     # audit a past spin
```

Open `http://localhost:3000` — the frontend boots, creates a session via the
API, and from then on every spin / buy-bonus / wild-spin is server-signed.
Session id persists in `localStorage` so refreshes resume the same session.

## Storage

Single SQLite file (`xibalba.db`, override with `XIBALBA_DB`):

- `sessions` — current balance, bet, active seed pair, nonce
- `seeds` — full seed history; revealed seeds remain queryable forever
- `spins` — every game action with `outcome_json` for full replayability

For production: back the SQLite file with regular snapshots, or migrate to
Postgres by swapping `db.js` (the rest of the code only depends on the
exported function signatures).
