/* Temple of Xibalba — Aztec-style cluster-pays slot
 *
 * Grid: 5 reels × 7 rows. A cluster = 5+ orthogonally-connected cells with the
 * same paying symbol (wilds substitute). Clusters pay, cells empty, remaining
 * symbols cascade down, new symbols fill from the top — repeats until no more
 * clusters form.
 *
 * Symbol roles:
 *   - symbol01           → SCATTER (special, doesn't cluster, triggers FS)
 *   - symbol02..symbol09 → 8 regular paying symbols (idx 0..7, idx 0 = highest pay)
 *   - WILD / BOOSTER / DESTROYER → synthetic specials (no asset), rendered via
 *     CSS badge overlays. Dug up on empty cells before refill.
 *
 * Features:
 *   - Cluster pays
 *   - Cell multipliers (×2 → ×10, persist within spin sequence)
 *   - Dig-up: Wild, Booster, Destroyer, Scatter appear on empty cells
 *   - Wild: sticky during refill, substitutes any reg symbol, ×10 base
 *           multiplier, +×10 per win it joins (max ×100)
 *   - Booster: upgrades all cell multipliers (+2, capped at ×10) then vanishes
 *   - Destroyer: removes all low-tier symbols (idx 5..7) without pay
 *   - Free Spins: 3+ scatters → 10/12/15/20 spins, cell multipliers persist
 *   - Buy Bonus: 4 options (0/1/2/3 guaranteed wilds)
 *   - Wild Spin: doubles bet, guarantees at least 1 wild dig-up
 *   - Autoplay: 10/25/50/100 spins, optional stop on bonus trigger
 */

(() => {
  "use strict";

  // ---- config ----------------------------------------------------------------
  const COLS = 5;
  const ROWS = 7;

  // 8 regular paying symbols (idx 0..7, 0 = highest pay)
  const REG_ASSETS = ["symbol02","symbol03","symbol04","symbol05","symbol06","symbol07","symbol08","symbol09"];
  const SCATTER_ASSET = "symbol01";

  // weights for random regular symbol pick (lower idx = rarer)
  const REG_WEIGHTS = [3, 5, 7, 9, 11, 13, 15, 17];

  // base payouts: PAY_TABLE[symIdx][clusterSize - 5], clamped at len-1
  const PAY_TABLE = [
    [10, 15, 25, 40, 80, 150, 300, 500],   // idx 0 (highest)
    [ 5,  8, 12, 20, 40,  80, 150, 250],
    [ 3,  5,  8, 12, 20,  40,  80, 120],
    [ 2,  3,  5,  8, 12,  20,  40,  60],
    [1.2, 2,  3,  5,  8,  12,  20,  30],
    [0.8, 1.2, 2, 3,  5,   8,  12,  18],
    [0.5, 0.8, 1.2, 2, 3,  5,   8,  12],
    [0.3, 0.5, 0.8, 1.2, 2, 3,  5,   8],   // idx 7 (lowest)
  ];

  function payForCluster(symIdx, size) {
    const row = PAY_TABLE[symIdx];
    const i = Math.min(Math.max(size - 5, 0), row.length - 1);
    return row[i];
  }

  // Probabilities for special symbols on initial fill / cascade fill
  const SCATTER_FILL_PROB = 0.025;  // per cell on each fill — capped at 1/reel

  // Dig-up probabilities (per cleared cell, after a cluster pop, before refill)
  const DIG = {
    wild: 0.06,
    booster: 0.03,
    destroyer: 0.025,
    scatter: 0.02,
  };

  const BET_LEVELS = [0.20, 0.50, 1.00, 2.00, 5.00, 10.00, 25.00, 50.00];

  function freeSpinsForScatters(n) {
    if (n >= 6) return 20;
    if (n >= 5) return 15;
    if (n >= 4) return 12;
    if (n >= 3) return 10;
    return 0;
  }

  const BUY_OPTIONS = [
    { label: "Free Spins",       cost: 80,  wilds: 0 },
    { label: "FS + 1 Wild",      cost: 110, wilds: 1 },
    { label: "FS + 2 Wilds",     cost: 150, wilds: 2 },
    { label: "FS + 3 Wilds",     cost: 200, wilds: 3 },
  ];

  // ---- cell types -----------------------------------------------------------
  // grid[r][c] is null | { t: "reg", i: 0..7 } | { t: "scatter" } |
  //                  { t: "wild", m: 10..100 } | { t: "booster" } | { t: "destroyer" }
  const TY = { REG: "reg", SCAT: "scatter", WILD: "wild", BOOST: "booster", DEST: "destroyer" };

  // ---- state ----------------------------------------------------------------
  const state = {
    grid: [],
    cellMult: [],
    balance: 100.00,
    bet: 1.00,
    betIdx: 2,
    lastWin: 0,
    totalSpinWin: 0,
    spinning: false,
    autoplayLeft: 0,
    autoStopOnFs: true,
    fastForward: false,
    inFreeSpins: false,
    freeSpinsLeft: 0,
    freeSpinsTotal: 0,
    freeSpinsWin: 0,
    guaranteedWilds: 0,    // wilds to force dig-up at start of next spin
    wildSpinArmed: false,
    recentWins: [],        // {size, symIdx, mult, amount}
    pendingBuyTrigger: null,
  };

  // ---- DOM refs --------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const reelsEl = $("reels");
  const btnSpin = $("btnSpin");
  const btnAutoplay = $("btnAutoplay");
  const btnFastFwd = $("btnFastFwd");
  const btnBuyBonus = $("btnBuyBonus");
  const btnWildSpin = $("btnWildSpin");
  const hudBalance = $("hudBalance");
  const hudBet = $("hudBet");
  const hudWin = $("hudWin");
  const betUp = $("betUp");
  const betDown = $("betDown");
  const winBanner = $("winBanner");
  const winBannerText = $("winBannerText");
  const fsBanner = $("fsBanner");
  const fsLeftEl = $("fsLeft");
  const fsTotalEl = $("fsTotal");
  const fsWinEl = $("fsWin");
  const buyBonusModal = $("buyBonusModal");
  const buyBonusClose = $("buyBonusClose");
  const bbOptions = $("bbOptions");
  const autoplayModal = $("autoplayModal");
  const autoplayClose = $("autoplayClose");
  const autoStopOnFsEl = $("autoStopOnFs");
  const paytableRows = $("paytableRows");

  // ---- responsive scaling ----------------------------------------------------
  const stage = $("stage");
  function fit() {
    const sw = window.innerWidth, sh = window.innerHeight;
    stage.style.transform = `scale(${Math.min(sw / 1920, sh / 1080)})`;
  }
  window.addEventListener("resize", fit);
  fit();

  // ---- grid helpers ----------------------------------------------------------
  function makeEmptyGrid(fillNull = true) {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(fillNull ? null : 0));
  }
  function pickRegSymbol() {
    const total = REG_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < REG_WEIGHTS.length; i++) {
      r -= REG_WEIGHTS[i];
      if (r <= 0) return i;
    }
    return REG_WEIGHTS.length - 1;
  }
  function rndCell() { return { t: TY.REG, i: pickRegSymbol() }; }

  function randomGrid() {
    const g = makeEmptyGrid();
    const scattersPerCol = new Array(COLS).fill(0);
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (scattersPerCol[c] === 0 && Math.random() < SCATTER_FILL_PROB) {
          g[r][c] = { t: TY.SCAT };
          scattersPerCol[c] = 1;
        } else {
          g[r][c] = rndCell();
        }
      }
    }
    return g;
  }

  // Cells are organized per column: .reels > .reel-col[0..4] > .reel-track > .cell[0..6]
  // During spin, preroll .cell.preroll elements are prepended to the track and
  // the track is translated to slide them through the visible window.
  const reelCols = [];   // per-col { col, track, cells: [7] }

  function buildCells() {
    reelsEl.innerHTML = "";
    reelCols.length = 0;
    for (let c = 0; c < COLS; c++) {
      const col = document.createElement("div");
      col.className = "reel-col";
      col.dataset.col = c;
      const track = document.createElement("div");
      track.className = "reel-track";
      col.appendChild(track);
      const cells = [];
      for (let r = 0; r < ROWS; r++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.row = r;
        cell.dataset.col = c;
        const sym = document.createElement("div");
        sym.className = "symbol";
        const badge = document.createElement("div");
        badge.className = "badge";
        const mult = document.createElement("div");
        mult.className = "multiplier";
        cell.appendChild(sym);
        cell.appendChild(badge);
        cell.appendChild(mult);
        track.appendChild(cell);
        cells.push(cell);
      }
      reelsEl.appendChild(col);
      reelCols.push({ col, track, cells });
    }
  }
  function cellAt(r, c) { return reelCols[c].cells[r]; }
  function colTrack(c) { return reelCols[c].track; }
  function allCells() {
    const out = [];
    for (const rc of reelCols) for (const cell of rc.cells) out.push(cell);
    return out;
  }
  function cellHeightPx() {
    // Use track-relative measurement so it works at any scale
    return reelCols[0].cells[0].getBoundingClientRect().height /
           (stage.getBoundingClientRect().width / 1920);
  }

  function paintCell(r, c) {
    const cell = cellAt(r, c);
    const sym = cell.querySelector(".symbol");
    const badge = cell.querySelector(".badge");
    const multEl = cell.querySelector(".multiplier");
    const v = state.grid[r][c];

    cell.classList.remove("scatter", "wild", "booster", "destroyer", "mult-only", "has-mult", "has-mult-high");

    if (!v) {
      sym.style.opacity = "0";
      sym.style.backgroundImage = "";
      badge.removeAttribute("data-mult");
    } else if (v.t === TY.REG) {
      sym.style.opacity = "1";
      sym.style.backgroundImage = `url("assets/${REG_ASSETS[v.i]}.png")`;
    } else if (v.t === TY.SCAT) {
      sym.style.opacity = "1";
      sym.style.backgroundImage = `url("assets/${SCATTER_ASSET}.png")`;
      cell.classList.add("scatter");
    } else if (v.t === TY.WILD) {
      sym.style.opacity = "0";
      cell.classList.add("wild");
      badge.setAttribute("data-mult", `×${v.m}`);
    } else if (v.t === TY.BOOST) {
      sym.style.opacity = "0";
      cell.classList.add("booster");
    } else if (v.t === TY.DEST) {
      sym.style.opacity = "0";
      cell.classList.add("destroyer");
    }

    // Multiplier badge
    const m = state.cellMult[r][c];
    if (m && m > 0) {
      multEl.textContent = `×${m}`;
      multEl.style.display = "flex";
      multEl.classList.toggle("big", m >= 8);
      // Lavender highlight on cells with an active multiplier
      cell.classList.add(m >= 6 ? "has-mult-high" : "has-mult");
      // If the cell has no symbol (empty + multiplier), render as a gold medallion
      if (!v) cell.classList.add("mult-only");
    } else {
      multEl.textContent = "";
      multEl.style.display = "none";
    }
  }
  function paintAll() {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) paintCell(r, c);
  }

  // ---- cluster detection (wilds substitute) ----------------------------------
  function findClusters(grid) {
    const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    const clusters = [];

    // Pass 1: seed from regular cells; expand including matching reg + wilds.
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

  // ---- cascade ---------------------------------------------------------------
  function cascade(grid) {
    // Wilds and scatters STAY in place during cascade (sticky).
    // Empty cells below them act as if filled from above only for non-sticky.
    // Implementation: for each column, walk bottom-up, keep wild/scatter rows
    // in place; collect non-null non-sticky cells; restack regular cells from
    // the bottom up; fill empties above with new regs (and possibly scatters).

    for (let c = 0; c < COLS; c++) {
      // Collect non-sticky regulars in column from top to bottom (preserves order)
      const movable = [];
      for (let r = 0; r < ROWS; r++) {
        const v = grid[r][c];
        if (v && (v.t === TY.REG)) movable.push(v);
      }
      // Walk column bottom-up, fill non-sticky cells from movable stack
      // (stack popped from bottom-of-original = last pushed = bottom-most reg)
      let mIdx = movable.length - 1;
      for (let r = ROWS - 1; r >= 0; r--) {
        const v = grid[r][c];
        const sticky = v && (v.t === TY.WILD || v.t === TY.SCAT);
        if (sticky) continue;
        if (mIdx >= 0) {
          grid[r][c] = movable[mIdx--];
        } else {
          // Fill with new symbol, with small chance of scatter (1/reel cap)
          const colHasScatter = grid.some((row) => row[c] && row[c].t === TY.SCAT);
          if (!colHasScatter && Math.random() < SCATTER_FILL_PROB) {
            grid[r][c] = { t: TY.SCAT };
          } else {
            grid[r][c] = rndCell();
          }
        }
      }
    }
  }

  // ---- dig-up logic ----------------------------------------------------------
  // After a cluster pops, before cascade, each empty cell can dig up a special.
  // Returns { wilds: [[r,c]], boosters: [[r,c]], destroyers: [[r,c]], scatters: [[r,c]] }
  function digUp(emptyCells, forceWilds = 0) {
    const result = { wilds: [], boosters: [], destroyers: [], scatters: [] };
    if (!emptyCells.length) return result;

    // Force `forceWilds` wilds on random empty cells first
    const pool = [...emptyCells];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const forced = pool.slice(0, Math.min(forceWilds, pool.length));
    for (const cell of forced) result.wilds.push(cell);
    const forcedSet = new Set(forced.map(([r, c]) => r * COLS + c));

    for (const [r, c] of emptyCells) {
      if (forcedSet.has(r * COLS + c)) continue;
      const roll = Math.random();
      let acc = 0;
      acc += DIG.wild;
      if (roll < acc) { result.wilds.push([r, c]); continue; }
      acc += DIG.booster;
      if (roll < acc) { result.boosters.push([r, c]); continue; }
      acc += DIG.destroyer;
      if (roll < acc) { result.destroyers.push([r, c]); continue; }
      acc += DIG.scatter;
      if (roll < acc) {
        // Respect 1-scatter-per-reel rule
        const colHasScatter = state.grid.some((row) => row[c] && row[c].t === TY.SCAT);
        if (!colHasScatter) result.scatters.push([r, c]);
      }
    }
    return result;
  }

  // ---- HUD / paytable --------------------------------------------------------
  const fmt = (v) => v.toFixed(2);
  function refreshHUD() {
    hudBalance.textContent = `${fmt(state.balance)} ETH`;
    hudBet.textContent = fmt(state.bet);
    hudWin.textContent = `${fmt(state.lastWin)} ETH`;
  }
  function refreshFSBanner() {
    if (state.inFreeSpins) {
      fsBanner.classList.add("visible");
      fsLeftEl.textContent = state.freeSpinsLeft;
      fsTotalEl.textContent = state.freeSpinsTotal;
      fsWinEl.textContent = `${fmt(state.freeSpinsWin)} ETH`;
    } else {
      fsBanner.classList.remove("visible");
    }
  }
  function addRecentWin(symIdx, size, payMult, amount) {
    state.recentWins.unshift({ symIdx, size, payMult, amount });
    if (state.recentWins.length > 8) state.recentWins.length = 8;
    renderPaytable();
  }
  function renderPaytable() {
    if (!state.recentWins.length) {
      paytableRows.innerHTML = '<div class="paytable-empty">No wins yet</div>';
      return;
    }
    paytableRows.innerHTML = "";
    for (const w of state.recentWins) {
      const row = document.createElement("div");
      row.className = "pt-row";
      const icon = `assets/${REG_ASSETS[w.symIdx]}.png`;
      row.innerHTML =
        `<span class="pt-count">${w.size}</span>` +
        `<div class="pt-icon" style="background-image:url('${icon}')"></div>` +
        `<span class="pt-mult">×${w.payMult.toFixed(0)}</span>` +
        `<span class="pt-amount">${fmt(w.amount)}</span>`;
      paytableRows.appendChild(row);
    }
  }
  function clearRecentWins() {
    state.recentWins = [];
    renderPaytable();
  }

  // ---- big-win banner --------------------------------------------------------
  function tierLabel(win, bet) {
    const r = win / bet;
    if (r >= 100) return "MEGA WIN";
    if (r >= 50)  return "HUGE WIN";
    if (r >= 20)  return "BIG WIN";
    return null;
  }
  async function maybeShowBigWin(win, bet) {
    const label = tierLabel(win, bet);
    if (!label) return;
    winBannerText.textContent = label;
    winBanner.classList.add("visible");
    await ffWait(1600);
    winBanner.classList.remove("visible");
  }

  // ---- animation helpers -----------------------------------------------------
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  function ffWait(ms) { return wait(state.fastForward ? Math.max(30, ms * 0.22) : ms); }

  function emitSparks(cell, count = 6, color = "gold") {
    const rect = cell.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const sc = stageRect.width / 1920;
    const cx = (rect.left + rect.width / 2 - stageRect.left) / sc;
    const cy = (rect.top + rect.height / 2 - stageRect.top) / sc;
    for (let i = 0; i < count; i++) {
      const s = document.createElement("div");
      s.className = "spark";
      if (color === "red") s.style.background = "radial-gradient(circle, #ffd2b8 0%, #ff5a3a 40%, rgba(180,40,20,0) 70%)";
      if (color === "green") s.style.background = "radial-gradient(circle, #c8ffd0 0%, #4ed882 40%, rgba(20,160,60,0) 70%)";
      s.style.left = cx + "px";
      s.style.top = cy + "px";
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 40 + Math.random() * 40;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      stage.appendChild(s);
      setTimeout(() => s.remove(), 800);
    }
  }
  function digBurst(cell) {
    const burst = document.createElement("div");
    burst.className = "dig-burst";
    cell.appendChild(burst);
    setTimeout(() => burst.remove(), 600);
  }

  // Build a preroll cell (random reg symbol) for the spin animation
  function makePrerollCell() {
    const cell = document.createElement("div");
    cell.className = "cell preroll";
    const sym = document.createElement("div");
    sym.className = "symbol";
    const idx = Math.floor(Math.random() * REG_ASSETS.length);
    sym.style.backgroundImage = `url("assets/${REG_ASSETS[idx]}.png")`;
    sym.style.opacity = "1";
    cell.appendChild(sym);
    return cell;
  }

  // Smooth column-wise reel spin: for each column, append N preroll cells
  // BELOW the 7 real cells, set translateY to -(N * cellH) so the prerolls
  // are initially visible in the viewport, then ease the track down to 0
  // so the real cells settle in. Columns decelerate left-to-right.
  async function animateSpinIn(initialGrid) {
    state.grid = initialGrid;

    const PREROLL = 16;
    const cellH = cellHeightPx() || (681 / ROWS);
    const offset = PREROLL * cellH;

    // 1. Paint the final symbols into the existing 7 cells (they're invisible
    //    while translated above the viewport)
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) paintCell(r, c);
    }

    // 2. Append preroll cells below the real cells in each column
    for (let c = 0; c < COLS; c++) {
      const track = colTrack(c);
      for (let i = 0; i < PREROLL; i++) {
        track.appendChild(makePrerollCell());
      }
      // Position track so prerolls are visible (real cells above viewport)
      track.style.transition = "none";
      track.style.transform = `translateY(${-offset}px)`;
      void track.offsetHeight;   // force reflow
      track.classList.add("spinning");
    }

    // 3. Animate each column down to translateY(0) with staggered duration
    const baseDuration = 700;
    const colDelay = 110;
    for (let c = 0; c < COLS; c++) {
      const track = colTrack(c);
      const duration = baseDuration + c * colDelay;
      track.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.62, 0.18, 1)`;
      track.style.transform = "translateY(0)";
    }

    const totalDuration = baseDuration + (COLS - 1) * colDelay + 80;
    await ffWait(totalDuration);

    // 4. Cleanup: remove preroll cells, clear transforms
    for (let c = 0; c < COLS; c++) {
      const track = colTrack(c);
      track.classList.remove("spinning");
      const prerolls = Array.from(track.querySelectorAll(".cell.preroll"));
      for (const p of prerolls) p.remove();
      track.style.transition = "";
      track.style.transform = "";
    }
  }

  async function animateMatched(cells, isWild = false) {
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.add("matched");
      emitSparks(cell, isWild ? 10 : 6);
    }
    await ffWait(520);
    // Don't clear wild/scatter from grid; only clear regs (wilds stay sticky)
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.remove("matched");
      const v = state.grid[r][c];
      if (v && v.t === TY.WILD) {
        // wild stays; bump its multiplier later
        const sym = cell.querySelector(".symbol");
        sym.style.opacity = "0";
        cell.classList.add("wild");
      } else {
        state.grid[r][c] = null;
        const sym = cell.querySelector(".symbol");
        sym.style.opacity = "0";
        sym.style.backgroundImage = "";
      }
    }
  }

  async function animateCascade() {
    cascade(state.grid);
    for (const cell of allCells()) cell.classList.add("dropping");
    paintAll();
    await ffWait(330);
    for (const cell of allCells()) cell.classList.remove("dropping");
  }

  // ---- dig-up application ----------------------------------------------------
  async function applyDigUp(emptyCells) {
    const forced = state.guaranteedWilds;
    state.guaranteedWilds = 0;
    const result = digUp(emptyCells, forced);

    if (!result.wilds.length && !result.boosters.length && !result.destroyers.length && !result.scatters.length) {
      return { destroyed: [] };
    }

    // Set grid types
    for (const [r, c] of result.wilds) {
      state.grid[r][c] = { t: TY.WILD, m: state.cellMult[r][c] >= 2 ? 100 : 10 };
    }
    for (const [r, c] of result.boosters) {
      state.grid[r][c] = { t: TY.BOOST };
    }
    for (const [r, c] of result.destroyers) {
      state.grid[r][c] = { t: TY.DEST };
    }
    for (const [r, c] of result.scatters) {
      state.grid[r][c] = { t: TY.SCAT };
    }

    paintAll();
    // Burst effect on each dug-up cell
    for (const arr of [result.wilds, result.boosters, result.destroyers, result.scatters]) {
      for (const [r, c] of arr) digBurst(cellAt(r, c));
    }
    await ffWait(450);

    // Apply booster effect: upgrade all cell multipliers +2 (capped at 10)
    let destroyed = [];
    if (result.boosters.length) {
      let bumped = 0;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (state.cellMult[r][c] > 0 && state.cellMult[r][c] < 10) {
            state.cellMult[r][c] = Math.min(10, state.cellMult[r][c] + 2);
            bumped++;
          }
        }
      }
      // Boosters consumed — return their cells to empty
      for (const [r, c] of result.boosters) {
        state.grid[r][c] = null;
        emitSparks(cellAt(r, c), 8, "green");
      }
      if (bumped > 0) await ffWait(350);
      paintAll();
    }

    // Apply destroyer: remove all low-tier symbols (idx 5,6,7) without pay
    if (result.destroyers.length) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = state.grid[r][c];
          if (v && v.t === TY.REG && v.i >= 5) {
            destroyed.push([r, c]);
            const cell = cellAt(r, c);
            emitSparks(cell, 4, "red");
          }
        }
      }
      await ffWait(300);
      for (const [r, c] of destroyed) state.grid[r][c] = null;
      // Destroyer itself vanishes too
      for (const [r, c] of result.destroyers) {
        state.grid[r][c] = null;
      }
      paintAll();
    }

    return { destroyed };
  }

  // ---- core spin loop --------------------------------------------------------
  async function spin({ skipBet = false } = {}) {
    if (state.spinning) return;

    const isWildSpin = state.wildSpinArmed && !state.inFreeSpins;
    let effectiveBet = state.bet;
    if (isWildSpin) effectiveBet = state.bet * 2;

    if (!skipBet && !state.inFreeSpins) {
      if (state.balance < effectiveBet) {
        flashHUD(hudBalance);
        return;
      }
      state.balance -= effectiveBet;
    }

    state.spinning = true;
    btnSpin.disabled = true;
    btnSpin.classList.add("spinning");
    state.lastWin = 0;
    state.totalSpinWin = 0;
    if (!state.inFreeSpins) clearRecentWins();
    refreshHUD();

    // Reset multipliers per spin (unless in FS)
    if (!state.inFreeSpins) {
      state.cellMult = makeEmptyGrid(false);
    }
    if (isWildSpin) state.guaranteedWilds = 1;

    await animateSpinIn(randomGrid());

    // Cascade loop
    let cascades = 0;
    while (true) {
      const clusters = findClusters(state.grid);
      if (!clusters.length) break;

      let stepWin = 0;
      const allCells = [];
      const wildCellsInRound = new Set();

      for (const cl of clusters) {
        // Sum multipliers of cells in this cluster
        let multSum = 0;
        for (const [r, c] of cl.cells) {
          if (state.cellMult[r][c] > 0) multSum += state.cellMult[r][c];
        }
        // Wilds in cluster contribute their own multiplier
        for (const [r, c] of cl.wildCells) {
          const w = state.grid[r][c];
          if (w && w.t === TY.WILD) multSum += w.m;
          wildCellsInRound.add(`${r},${c}`);
        }
        const base = payForCluster(cl.symIdx, cl.cells.length) * effectiveBet;
        const finalMult = Math.max(1, multSum);
        const win = +(base * finalMult).toFixed(2);
        stepWin += win;
        const payMult = +(base * finalMult / effectiveBet).toFixed(0);
        addRecentWin(cl.symIdx, cl.cells.length, payMult, win);
        allCells.push(...cl.cells);
      }
      state.totalSpinWin += stepWin;
      state.lastWin = state.totalSpinWin;
      refreshHUD();

      // Mark winning cells with new multipliers (×2 → ×10)
      const winningCellKeys = new Set();
      for (const [r, c] of allCells) {
        winningCellKeys.add(`${r},${c}`);
      }
      for (const key of winningCellKeys) {
        const [r, c] = key.split(",").map(Number);
        const cur = state.cellMult[r][c];
        state.cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
      }
      // Bump wild multipliers (+10, max 100)
      for (const key of wildCellsInRound) {
        const [r, c] = key.split(",").map(Number);
        const w = state.grid[r][c];
        if (w && w.t === TY.WILD) w.m = Math.min(100, w.m + 10);
      }

      await animateMatched(allCells);

      // Dig-up on empty cells
      const empties = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (state.grid[r][c] === null) empties.push([r, c]);
        }
      }
      await applyDigUp(empties);

      await animateCascade();
      paintAll();

      cascades++;
      if (cascades > 30) break;
    }

    // After cascades: count scatters → maybe trigger FS
    let scatterCount = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (state.grid[r][c] && state.grid[r][c].t === TY.SCAT) scatterCount++;
      }
    }

    // Apply winnings
    if (!state.inFreeSpins) {
      state.balance += state.totalSpinWin;
    } else {
      state.freeSpinsWin += state.totalSpinWin;
      refreshFSBanner();
    }
    refreshHUD();

    if (state.totalSpinWin > 0) {
      await maybeShowBigWin(state.totalSpinWin, effectiveBet);
    }

    // Wild spin consumed
    if (isWildSpin) {
      state.wildSpinArmed = false;
      btnWildSpin.setAttribute("aria-pressed", "false");
    }

    state.spinning = false;
    btnSpin.disabled = false;
    btnSpin.classList.remove("spinning");

    // FS trigger / continue
    if (scatterCount >= 3) {
      await triggerOrRetrigger(scatterCount);
    } else if (state.inFreeSpins) {
      // Continue FS round
      state.freeSpinsLeft--;
      refreshFSBanner();
      if (state.freeSpinsLeft > 0) {
        await ffWait(500);
        spin({ skipBet: true });
        return;
      } else {
        await endFreeSpins();
      }
    } else if (state.autoplayLeft > 0) {
      state.autoplayLeft--;
      if (state.autoStopOnFs && scatterCount >= 3) { /* will end on FS anyway */ }
      if (state.autoplayLeft > 0 && state.balance >= state.bet) {
        await ffWait(450);
        spin();
      } else {
        state.autoplayLeft = 0;
        btnAutoplay.classList.remove("active");
      }
    }
  }

  async function triggerOrRetrigger(scatterCount) {
    const award = freeSpinsForScatters(scatterCount);
    if (!state.inFreeSpins) {
      // Trigger: convert scatters to wilds or ×10 multipliers
      let convertedWilds = 0;
      const wildsToForce = state.pendingBuyTrigger ? state.pendingBuyTrigger.wilds : 0;
      state.pendingBuyTrigger = null;

      const scatterCells = [];
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++)
          if (state.grid[r][c] && state.grid[r][c].t === TY.SCAT) scatterCells.push([r, c]);

      // Shuffle
      for (let i = scatterCells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [scatterCells[i], scatterCells[j]] = [scatterCells[j], scatterCells[i]];
      }
      for (const [r, c] of scatterCells) {
        if (convertedWilds < wildsToForce || Math.random() < 0.5) {
          state.grid[r][c] = { t: TY.WILD, m: 10 };
          convertedWilds++;
        } else {
          state.grid[r][c] = null;
          state.cellMult[r][c] = 10;
        }
      }
      paintAll();
      await ffWait(600);

      state.inFreeSpins = true;
      state.freeSpinsTotal = award;
      state.freeSpinsLeft = award;
      state.freeSpinsWin = 0;
      refreshFSBanner();

      winBannerText.textContent = `${award} FREE SPINS`;
      winBanner.classList.add("visible");
      await ffWait(1800);
      winBanner.classList.remove("visible");

      // Cascade once more (wilds may form clusters now)
      let cs = 0;
      while (true) {
        const clusters = findClusters(state.grid);
        if (!clusters.length) break;
        let stepWin = 0;
        const allCells = [];
        for (const cl of clusters) {
          let multSum = 0;
          for (const [r, c] of cl.cells) if (state.cellMult[r][c] > 0) multSum += state.cellMult[r][c];
          for (const [r, c] of cl.wildCells) {
            const w = state.grid[r][c];
            if (w && w.t === TY.WILD) multSum += w.m;
          }
          const base = payForCluster(cl.symIdx, cl.cells.length) * state.bet;
          const win = +(base * Math.max(1, multSum)).toFixed(2);
          stepWin += win;
          addRecentWin(cl.symIdx, cl.cells.length, +(base * Math.max(1, multSum) / state.bet).toFixed(0), win);
          allCells.push(...cl.cells);
        }
        state.freeSpinsWin += stepWin;
        refreshFSBanner();
        for (const [r, c] of allCells) {
          const cur = state.cellMult[r][c];
          state.cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
        }
        await animateMatched(allCells);
        await animateCascade();
        paintAll();
        cs++;
        if (cs > 20) break;
      }

      // Start first FS spin
      await ffWait(400);
      spin({ skipBet: true });
    } else {
      // Retrigger: add spins
      state.freeSpinsLeft += award;
      state.freeSpinsTotal += award;
      refreshFSBanner();
      winBannerText.textContent = `+${award} FREE SPINS`;
      winBanner.classList.add("visible");
      await ffWait(1400);
      winBanner.classList.remove("visible");
      // Continue
      state.freeSpinsLeft--;
      if (state.freeSpinsLeft > 0) {
        await ffWait(400);
        spin({ skipBet: true });
      } else {
        await endFreeSpins();
      }
    }
  }

  async function endFreeSpins() {
    state.balance += state.freeSpinsWin;
    refreshHUD();
    winBannerText.textContent = `BONUS WIN ${fmt(state.freeSpinsWin)} ETH`;
    winBanner.classList.add("visible");
    await ffWait(2200);
    winBanner.classList.remove("visible");
    state.inFreeSpins = false;
    state.freeSpinsLeft = 0;
    state.freeSpinsTotal = 0;
    state.freeSpinsWin = 0;
    refreshFSBanner();
    // Clear multipliers between rounds
    state.cellMult = makeEmptyGrid(false);
    paintAll();
  }

  // ---- HUD flash -------------------------------------------------------------
  function flashHUD(el) {
    el.animate(
      [
        { color: "#ff5252", transform: "scale(1.15)" },
        { color: "#ffe8a1", transform: "scale(1)" },
      ],
      { duration: 600 }
    );
  }

  // ---- modals ---------------------------------------------------------------
  function renderBuyOptions() {
    bbOptions.innerHTML = "";
    for (const opt of BUY_OPTIONS) {
      const btn = document.createElement("button");
      btn.className = "bb-btn";
      btn.type = "button";
      btn.innerHTML =
        `<span class="bb-btn-label">${opt.label}</span>` +
        `<span class="bb-btn-cost">${fmt(opt.cost * state.bet)} ETH</span>`;
      btn.addEventListener("click", () => buyBonus(opt));
      bbOptions.appendChild(btn);
    }
  }
  function openModal(el) { el.classList.add("visible"); el.setAttribute("aria-hidden", "false"); }
  function closeModal(el) { el.classList.remove("visible"); el.setAttribute("aria-hidden", "true"); }

  async function buyBonus(opt) {
    closeModal(buyBonusModal);
    if (state.spinning) return;
    const cost = opt.cost * state.bet;
    if (state.balance < cost) { flashHUD(hudBalance); return; }
    state.balance -= cost;
    refreshHUD();
    // Force a free-spin trigger: prime the next spin so that ≥3 scatters land
    state.pendingBuyTrigger = { wilds: opt.wilds };
    await triggerBuyBonusSpin(opt);
  }

  async function triggerBuyBonusSpin(opt) {
    // Generate a grid with 3-6 scatters
    state.spinning = true;
    btnSpin.disabled = true;
    btnSpin.classList.add("spinning");
    state.lastWin = 0;
    state.totalSpinWin = 0;
    clearRecentWins();
    state.cellMult = makeEmptyGrid(false);

    const g = randomGrid();
    // Force scatters: pick random scatter count 3-5, place one per random reel
    const scatterCount = 3 + Math.floor(Math.random() * 3);
    const cols = [...Array(COLS).keys()].sort(() => Math.random() - 0.5).slice(0, scatterCount);
    // Clear any existing scatters first
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (g[r][c] && g[r][c].t === TY.SCAT) g[r][c] = rndCell();
    for (const c of cols) {
      const r = Math.floor(Math.random() * ROWS);
      g[r][c] = { t: TY.SCAT };
    }
    await animateSpinIn(g);

    // Run cascades (may already have cluster wins from the random grid)
    let cs = 0;
    while (true) {
      const clusters = findClusters(state.grid);
      if (!clusters.length) break;
      let stepWin = 0;
      const allCells = [];
      for (const cl of clusters) {
        const base = payForCluster(cl.symIdx, cl.cells.length) * state.bet;
        const win = +base.toFixed(2);
        stepWin += win;
        addRecentWin(cl.symIdx, cl.cells.length, +(base / state.bet).toFixed(0), win);
        allCells.push(...cl.cells);
      }
      state.totalSpinWin += stepWin;
      state.lastWin = state.totalSpinWin;
      refreshHUD();
      for (const [r, c] of allCells) {
        const cur = state.cellMult[r][c];
        state.cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
      }
      await animateMatched(allCells);
      const empties = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (state.grid[r][c] === null) empties.push([r, c]);
      await applyDigUp(empties);
      await animateCascade();
      paintAll();
      cs++; if (cs > 20) break;
    }
    state.balance += state.totalSpinWin;
    refreshHUD();
    state.spinning = false;
    btnSpin.disabled = false;
    btnSpin.classList.remove("spinning");

    // Count scatters and trigger FS
    let sc = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (state.grid[r][c] && state.grid[r][c].t === TY.SCAT) sc++;
    if (sc >= 3) await triggerOrRetrigger(sc);
  }

  // ---- buttons --------------------------------------------------------------
  btnSpin.addEventListener("click", () => {
    if (state.autoplayLeft > 0) {
      state.autoplayLeft = 0;
      btnAutoplay.classList.remove("active");
      return;
    }
    spin();
  });

  btnAutoplay.addEventListener("click", () => {
    if (state.autoplayLeft > 0) {
      state.autoplayLeft = 0;
      btnAutoplay.classList.remove("active");
      return;
    }
    openModal(autoplayModal);
  });

  btnFastFwd.addEventListener("click", () => {
    state.fastForward = !state.fastForward;
    btnFastFwd.classList.toggle("active", state.fastForward);
  });

  btnBuyBonus.addEventListener("click", () => {
    if (state.spinning || state.inFreeSpins) return;
    renderBuyOptions();
    openModal(buyBonusModal);
  });
  buyBonusClose.addEventListener("click", () => closeModal(buyBonusModal));
  buyBonusModal.addEventListener("click", (e) => { if (e.target === buyBonusModal) closeModal(buyBonusModal); });

  autoplayClose.addEventListener("click", () => closeModal(autoplayModal));
  autoplayModal.addEventListener("click", (e) => { if (e.target === autoplayModal) closeModal(autoplayModal); });
  for (const btn of autoplayModal.querySelectorAll(".auto-btn")) {
    btn.addEventListener("click", () => {
      state.autoplayLeft = parseInt(btn.dataset.count, 10);
      state.autoStopOnFs = autoStopOnFsEl.checked;
      btnAutoplay.classList.add("active");
      closeModal(autoplayModal);
      if (!state.spinning) spin();
    });
  }

  btnWildSpin.addEventListener("click", () => {
    if (state.spinning) return;
    state.wildSpinArmed = !state.wildSpinArmed;
    btnWildSpin.setAttribute("aria-pressed", String(state.wildSpinArmed));
  });

  betUp.addEventListener("click", () => {
    state.betIdx = Math.min(BET_LEVELS.length - 1, state.betIdx + 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
  });
  betDown.addEventListener("click", () => {
    state.betIdx = Math.max(0, state.betIdx - 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
  });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); btnSpin.click(); }
    if (e.code === "KeyA") btnAutoplay.click();
    if (e.code === "KeyF") btnFastFwd.click();
    if (e.code === "Escape") {
      if (buyBonusModal.classList.contains("visible")) closeModal(buyBonusModal);
      if (autoplayModal.classList.contains("visible")) closeModal(autoplayModal);
    }
  });

  // ---- init ------------------------------------------------------------------
  state.cellMult = makeEmptyGrid(false);
  buildCells();
  state.grid = randomGrid();
  paintAll();
  refreshHUD();
  refreshFSBanner();
  renderPaytable();
})();
