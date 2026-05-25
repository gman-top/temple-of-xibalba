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

  // Weights skewed toward common low-tier symbols so clusters form often,
  // but not so extreme that cascades chain forever.
  const REG_WEIGHTS = [2, 3, 4, 6, 9, 13, 17, 22];

  // base payouts: PAY_TABLE[symIdx][clusterSize - 5], clamped at len-1
  const PAY_TABLE = [
    [25, 40, 70, 120, 200, 400, 700, 1200],   // idx 0 (highest)
    [12, 20, 35,  60, 100, 200, 350,  600],
    [ 6, 10, 18,  30,  50, 100, 180,  300],
    [ 3,  5,  9,  15,  25,  50,  90,  150],
    [ 2,  3,  5,   8,  14,  25,  45,   80],
    [ 1, 1.5,2.5,  4,   7,  12,  22,   40],
    [0.6, 1, 1.6,  3,   5,   9,  16,   28],
    [0.4, 0.6,1.0, 2,   3,   6,  10,   18],  // idx 7 (lowest, most common)
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

  // BGaming Aztec Clusters' Buy Free Spins ratios: regular 100×, +1 wild 200×,
  // +2 wilds 400×, all wilds 800×. Our minimum 100× matches "REGULAR 150 FUN
  // at 1.50 bet" in the reference screenshot.
  const BUY_OPTIONS = [
    { label: "REGULAR",            sublabel: "",                  cost: 100,  wilds: 0 },
    { label: "1 WILD",             sublabel: "GUARANTEED",        cost: 200,  wilds: 1 },
    { label: "2 WILDS",            sublabel: "GUARANTEED",        cost: 400,  wilds: 2 },
    { label: "ALL SCATTERS",       sublabel: "TURN WILDS",        cost: 800,  wilds: 3, allWilds: true },
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
  const wildSpinModal = $("wildSpinModal");
  const wildSpinClose = $("wildSpinClose");
  const wsCost = $("wsCost");
  const wsBet = $("wsBet");
  const wsActivate = $("wsActivate");
  const wsBetUp = $("wsBetUp");
  const wsBetDown = $("wsBetDown");
  const fsTriggerModal = $("fsTriggerModal");
  const fsTriggerCount = $("fsTriggerCount");
  const bonusActivePanel = $("bonusActivePanel");
  const baValue = $("baValue");
  const bbBet = $("bbBet");
  const bbBetUp = $("bbBetUp");
  const bbBetDown = $("bbBetDown");
  const bbConfirmModal = $("bbConfirmModal");
  const bbConfirmClose = $("bbConfirmClose");
  const bbConfirmAmount = $("bbConfirmAmount");
  const bbConfirmBack = $("bbConfirmBack");
  const bbConfirmOk = $("bbConfirmOk");

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

  function refreshBonusActive() {
    if (state.inFreeSpins) {
      bonusActivePanel.classList.add("visible");
      baValue.textContent = `${fmt(state.freeSpinsWin)} ETH`;
    } else {
      bonusActivePanel.classList.remove("visible");
    }
  }

  // FS trigger announcement modal — pauses on CLICK TO CONTINUE so the
  // trigger gets the weight it deserves.
  function showFsTriggerModal(count) {
    return new Promise((resolve) => {
      fsTriggerCount.textContent = count;
      fsTriggerModal.classList.add("visible");
      fsTriggerModal.setAttribute("aria-hidden", "false");
      const advance = () => {
        fsTriggerModal.classList.remove("visible");
        fsTriggerModal.setAttribute("aria-hidden", "true");
        fsTriggerModal.removeEventListener("click", advance);
        document.removeEventListener("keydown", onKey);
        resolve();
      };
      const onKey = (e) => {
        if (e.code === "Space" || e.code === "Enter" || e.code === "Escape") {
          e.preventDefault();
          advance();
        }
      };
      fsTriggerModal.addEventListener("click", advance);
      document.addEventListener("keydown", onKey);
      // Auto-advance after ~6s in case user doesn't click (esp. autoplay)
      setTimeout(() => {
        if (fsTriggerModal.classList.contains("visible")) advance();
      }, state.fastForward ? 1200 : 6000);
    });
  }
  function addRecentWin(symIdx, size, payMult, amount) {
    state.recentWins.unshift({ symIdx, size, payMult, amount });
    if (state.recentWins.length > 8) state.recentWins.length = 8;
    renderPaytable();
  }
  // Thousand-separated amount: 3211.20 → "3,211.20"
  function fmtAmount(v) {
    const fixed = v.toFixed(2);
    const [int, dec] = fixed.split(".");
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + dec;
  }
  function renderPaytable() {
    if (!state.recentWins.length) {
      paytableRows.innerHTML = '<div class="paytable-empty">No wins yet</div>';
      return;
    }
    // Show up to 3 rows — the space between the two carved arrows on the
    // totem fits ~3 rows cleanly without crowding either arrow.
    const visible = state.recentWins.slice(0, 3);
    paytableRows.innerHTML = "";
    for (const w of visible) {
      const row = document.createElement("div");
      row.className = "pt-row";
      const icon = `assets/${REG_ASSETS[w.symIdx]}.png`;
      // Matches Aztec Clusters reference: count icon amount (no ×mult column).
      row.innerHTML =
        `<span class="pt-count">${w.size}</span>` +
        `<div class="pt-icon" style="background-image:url('${icon}')"></div>` +
        `<span class="pt-amount">${fmtAmount(w.amount)}</span>`;
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

  // Convert a viewport rect into stage-local coords (un-scaled)
  function stageCoords(rect) {
    const sr = stage.getBoundingClientRect();
    const sc = sr.width / 1920;
    return {
      x: (rect.left - sr.left) / sc + (rect.width / sc) / 2,
      y: (rect.top - sr.top) / sc + (rect.height / sc) / 2,
    };
  }

  // Win amount flies from a cluster's centroid toward the recent-wins panel,
  // following a slight arc, then dissolves into the panel header.
  function flyWinToPanel(cells, symIdx, amount) {
    // Centroid of cluster cells
    let cx = 0, cy = 0;
    for (const [r, c] of cells) {
      const p = stageCoords(cellAt(r, c).getBoundingClientRect());
      cx += p.x; cy += p.y;
    }
    cx /= cells.length;
    cy /= cells.length;

    const target = stageCoords(paytableRows.getBoundingClientRect());

    const flyout = document.createElement("div");
    flyout.className = "fly-win";
    flyout.innerHTML =
      `<div class="fly-icon" style="background-image:url('assets/${REG_ASSETS[symIdx]}.png')"></div>` +
      `<div class="fly-amount">+${amount.toFixed(2)}</div>`;
    // Start position
    flyout.style.left = "0px";
    flyout.style.top = "0px";
    flyout.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%) scale(0.6)`;
    flyout.style.opacity = "0";
    stage.appendChild(flyout);

    const dx = target.x - cx;
    const dy = target.y - cy;
    // Arc control point: slightly above the midpoint
    const midX = cx + dx * 0.4;
    const midY = cy + dy * 0.4 - 80;

    const dur = state.fastForward ? 280 : 750;
    flyout.animate(
      [
        { transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%) scale(0.6)`,  opacity: 0,  offset: 0 },
        { transform: `translate(${cx}px, ${cy - 30}px) translate(-50%, -50%) scale(1.25)`, opacity: 1, offset: 0.16 },
        { transform: `translate(${midX}px, ${midY}px) translate(-50%, -50%) scale(1.1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${target.x}px, ${target.y}px) translate(-50%, -50%) scale(0.7)`, opacity: 0.85, offset: 0.92 },
        { transform: `translate(${target.x}px, ${target.y}px) translate(-50%, -50%) scale(0.4)`, opacity: 0, offset: 1 },
      ],
      { duration: dur, easing: "cubic-bezier(0.3, 0, 0.4, 1)", fill: "forwards" }
    );
    setTimeout(() => flyout.remove(), dur + 60);
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

  // Smooth column-wise reel spin using the Web Animations API.
  // Each column animates through 4 keyframes:
  //   1. Off-screen (prerolls at top of viewport, real cells above)
  //   2. ~70% of the way (high-velocity scroll past prerolls, motion blur)
  //   3. Overshoot ~12px past the target (so it "snaps" back)
  //   4. Final rest position with cells settled in place
  // Each cell gets a small landing pop at the end of its column's animation.
  async function animateSpinIn(initialGrid) {
    state.grid = initialGrid;

    const PREROLL = 14;
    const cellH = cellHeightPx() || (681 / ROWS);
    const offset = PREROLL * cellH;

    // Paint the final symbols into the existing 7 cells (currently above viewport)
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) paintCell(r, c);
    }

    // Append preroll cells below the real cells in each column
    for (let c = 0; c < COLS; c++) {
      const track = colTrack(c);
      for (let i = 0; i < PREROLL; i++) {
        track.appendChild(makePrerollCell());
      }
      track.style.transition = "none";
      track.style.transform = `translateY(${-offset}px)`;
      track.style.filter = "blur(0px)";
      void track.offsetHeight;
    }

    // Longer spin with visible deceleration (~1200ms base + per-col stagger).
    // Curve: fast linear scroll for first ~40% (most distance covered),
    // then a long visible deceleration for ~50%, ending with a tiny overshoot.
    const BASE = 1100;
    const COL_STAGGER = 130;
    const animations = [];

    for (let c = 0; c < COLS; c++) {
      const track = colTrack(c);
      const duration = BASE + c * COL_STAGGER;

      const anim = track.animate(
        [
          { transform: `translateY(${-offset}px)`,         filter: "blur(3px)",   offset: 0,    easing: "linear" },
          { transform: `translateY(${-offset * 0.45}px)`,  filter: "blur(2.5px)", offset: 0.30, easing: "linear" },
          { transform: `translateY(-200px)`,               filter: "blur(2px)",   offset: 0.55, easing: "cubic-bezier(0.3, 0, 0.5, 1)" },
          { transform: `translateY(-50px)`,                filter: "blur(1px)",   offset: 0.78, easing: "cubic-bezier(0.3, 0, 0.4, 1)" },
          { transform: `translateY(10px)`,                 filter: "blur(0px)",   offset: 0.92, easing: "ease-out" },
          { transform: `translateY(-2px)`,                 filter: "blur(0px)",   offset: 0.97, easing: "ease-out" },
          { transform: `translateY(0px)`,                  filter: "blur(0px)",   offset: 1 },
        ],
        {
          duration: state.fastForward ? Math.max(220, duration * 0.32) : duration,
          fill: "forwards",
        }
      );
      animations.push(anim);
    }

    // Wait for the last column to finish
    await animations[animations.length - 1].finished;

    // Cleanup: remove preroll cells, commit final transform, give each cell a
    // small landing pop
    for (let c = 0; c < COLS; c++) {
      const track = colTrack(c);
      // Web Animations leaves the computed style on the element; reset inline
      // so subsequent paints/cascades don't pick up the animated state
      try { animations[c].cancel(); } catch (e) {}
      track.style.transition = "";
      track.style.transform = "";
      track.style.filter = "";
      const prerolls = Array.from(track.querySelectorAll(".cell.preroll"));
      for (const p of prerolls) p.remove();

      // Per-cell landing pop
      for (let r = 0; r < ROWS; r++) {
        const sym = cellAt(r, c).querySelector(".symbol");
        sym.animate(
          [
            { transform: "translateY(-6px) scale(1.06)", offset: 0 },
            { transform: "translateY(2px) scale(0.97)", offset: 0.5 },
            { transform: "translateY(0) scale(1)",      offset: 1 },
          ],
          { duration: state.fastForward ? 90 : 220, easing: "ease-out" }
        );
      }
    }
  }

  // animateMatched: three-phase cluster-pop choreography.
  //   Phase 1 (380ms): cells go lavender + symbols crack/shake (build-up).
  //   Phase 2 (380ms): explode + fly-out animation toward the recent-wins
  //                    panel; once the fly-out lands, the panel rows update.
  //   Phase 3:         clear regs from the grid (wilds stay sticky).
  // `winInfo` is an array of { cells, symIdx, size, payMult, amount } — one
  // entry per winning cluster from this cascade step.
  async function animateMatched(cells, winInfo, isWild = false) {
    // Phase 1: highlight
    for (const [r, c] of cells) {
      cellAt(r, c).classList.add("in-cluster");
    }
    await ffWait(380);

    // Phase 2: explode + fly-out
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.remove("in-cluster");
      cell.classList.add("matched");
      emitSparks(cell, isWild ? 12 : 8);
    }

    // Trigger fly-outs (in parallel) for each cluster
    if (winInfo) {
      for (const wi of winInfo) {
        flyWinToPanel(wi.cells, wi.symIdx, wi.amount);
      }
      // Add to panel after fly-out has covered most of the arc
      const updateDelay = state.fastForward ? 200 : 600;
      setTimeout(() => {
        for (const wi of winInfo) {
          addRecentWin(wi.symIdx, wi.size, wi.payMult, wi.amount);
        }
      }, updateDelay);
    }

    await ffWait(420);

    // Phase 3: clear regs; wilds stay sticky
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.remove("matched");
      const v = state.grid[r][c];
      if (v && v.t === TY.WILD) {
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
    // Recent wins persist across spins — new wins prepend; old wins age out
    // naturally via the 8-row cap.
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
      const winInfo = [];

      for (const cl of clusters) {
        let multSum = 0;
        for (const [r, c] of cl.cells) {
          if (state.cellMult[r][c] > 0) multSum += state.cellMult[r][c];
        }
        for (const [r, c] of cl.wildCells) {
          const w = state.grid[r][c];
          if (w && w.t === TY.WILD) multSum += w.m;
          wildCellsInRound.add(`${r},${c}`);
        }
        const base = payForCluster(cl.symIdx, cl.cells.length) * effectiveBet;
        const finalMult = Math.max(1, multSum);
        const win = +(base * finalMult).toFixed(2);
        stepWin += win;
        const payMult = +(base * finalMult / effectiveBet).toFixed(2);
        winInfo.push({
          cells: cl.cells,
          symIdx: cl.symIdx,
          size: cl.cells.length,
          payMult,
          amount: win,
        });
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

      await animateMatched(allCells, winInfo);

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
      if (cascades > 15) break;
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
      refreshFSBanner(); refreshBonusActive();
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
      refreshFSBanner(); refreshBonusActive();
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
      const allWilds = state.pendingBuyTrigger ? state.pendingBuyTrigger.allWilds : false;
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
        if (allWilds || convertedWilds < wildsToForce || Math.random() < 0.5) {
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
      refreshFSBanner(); refreshBonusActive();

      // Announcement modal: shows the count (with the +5/+3/+2 retrigger info),
      // pauses on "CLICK TO CONTINUE" to give the trigger weight.
      await showFsTriggerModal(award);

      // Cascade once more (wilds may form clusters now)
      let cs = 0;
      while (true) {
        const clusters = findClusters(state.grid);
        if (!clusters.length) break;
        let stepWin = 0;
        const allCells = [];
        const winInfo = [];
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
          winInfo.push({
            cells: cl.cells,
            symIdx: cl.symIdx,
            size: cl.cells.length,
            payMult: +(base * Math.max(1, multSum) / state.bet).toFixed(2),
            amount: win,
          });
          allCells.push(...cl.cells);
        }
        state.freeSpinsWin += stepWin;
        refreshFSBanner(); refreshBonusActive();
        for (const [r, c] of allCells) {
          const cur = state.cellMult[r][c];
          state.cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
        }
        await animateMatched(allCells, winInfo);
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
      refreshFSBanner(); refreshBonusActive();
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
    refreshFSBanner(); refreshBonusActive();
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
  function pyramidIconsHTML(count) {
    let html = "";
    for (let i = 0; i < count; i++) html += '<div class="bb-pyramid"></div>';
    return `<div class="bb-pyramids">${html}</div>`;
  }
  function renderBuyOptions() {
    bbOptions.innerHTML = "";
    for (const opt of BUY_OPTIONS) {
      const card = document.createElement("div");
      card.className = "bb-option";
      const cost = opt.cost * state.bet;
      const affordable = state.balance >= cost;
      card.innerHTML =
        pyramidIconsHTML(opt.wilds) +
        `<div class="bb-label-main">${opt.label}</div>` +
        (opt.sublabel ? `<div class="bb-label-sub">${opt.sublabel}</div>` : "") +
        `<div class="bb-cost">${fmtAmount(cost)} ETH</div>` +
        `<button class="bb-buy" type="button" ${affordable ? "" : "disabled"}>BUY</button>`;
      const buyBtn = card.querySelector(".bb-buy");
      buyBtn.addEventListener("click", () => {
        if (!affordable) return;
        showBuyConfirm(opt);
      });
      if (!affordable) card.classList.add("disabled");
      bbOptions.appendChild(card);
    }
    bbBet.textContent = fmt(state.bet);
  }

  // Confirmation modal between selecting a buy option and actually paying.
  let pendingBuyOpt = null;
  function showBuyConfirm(opt) {
    pendingBuyOpt = opt;
    bbConfirmAmount.textContent = `${fmtAmount(opt.cost * state.bet)} ETH`;
    openModal(bbConfirmModal);
  }
  function openModal(el) { el.classList.add("visible"); el.setAttribute("aria-hidden", "false"); }
  function closeModal(el) { el.classList.remove("visible"); el.setAttribute("aria-hidden", "true"); }

  async function buyBonus(opt) {
    closeModal(bbConfirmModal);
    closeModal(buyBonusModal);
    if (state.spinning) return;
    const cost = opt.cost * state.bet;
    if (state.balance < cost) { flashHUD(hudBalance); return; }
    state.balance -= cost;
    refreshHUD();
    // Force a free-spin trigger: prime the next spin so that ≥3 scatters land
    state.pendingBuyTrigger = { wilds: opt.wilds, allWilds: !!opt.allWilds };
    await triggerBuyBonusSpin(opt);
  }

  async function triggerBuyBonusSpin(opt) {
    // Generate a grid with 3-6 scatters
    state.spinning = true;
    btnSpin.disabled = true;
    btnSpin.classList.add("spinning");
    state.lastWin = 0;
    state.totalSpinWin = 0;
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
      const winInfo = [];
      for (const cl of clusters) {
        const base = payForCluster(cl.symIdx, cl.cells.length) * state.bet;
        const win = +base.toFixed(2);
        stepWin += win;
        winInfo.push({
          cells: cl.cells,
          symIdx: cl.symIdx,
          size: cl.cells.length,
          payMult: +(base / state.bet).toFixed(2),
          amount: win,
        });
        allCells.push(...cl.cells);
      }
      state.totalSpinWin += stepWin;
      state.lastWin = state.totalSpinWin;
      refreshHUD();
      for (const [r, c] of allCells) {
        const cur = state.cellMult[r][c];
        state.cellMult[r][c] = Math.min(10, cur === 0 ? 2 : cur + 2);
      }
      await animateMatched(allCells, winInfo);
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
    if (state.wildSpinArmed) {
      // Mutually exclusive with Wild Spin — flash to indicate it's unavailable
      flashHUD(btnBuyBonus);
      return;
    }
    renderBuyOptions();
    openModal(buyBonusModal);
  });
  buyBonusClose.addEventListener("click", () => closeModal(buyBonusModal));
  buyBonusModal.addEventListener("click", (e) => { if (e.target === buyBonusModal) closeModal(buyBonusModal); });

  // Buy Free Spins bet selector (its own arrows in the modal)
  bbBetUp.addEventListener("click", () => {
    state.betIdx = Math.min(BET_LEVELS.length - 1, state.betIdx + 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
    renderBuyOptions();
  });
  bbBetDown.addEventListener("click", () => {
    state.betIdx = Math.max(0, state.betIdx - 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
    renderBuyOptions();
  });

  // Buy Free Spins confirmation modal
  bbConfirmClose.addEventListener("click", () => closeModal(bbConfirmModal));
  bbConfirmModal.addEventListener("click", (e) => { if (e.target === bbConfirmModal) closeModal(bbConfirmModal); });
  bbConfirmBack.addEventListener("click", () => closeModal(bbConfirmModal));
  bbConfirmOk.addEventListener("click", () => {
    if (pendingBuyOpt) buyBonus(pendingBuyOpt);
    pendingBuyOpt = null;
  });

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

  function refreshExclusiveButtons() {
    // Wild Spin and Buy Bonus are mutually exclusive — if one is engaged,
    // the other is greyed out.
    if (state.wildSpinArmed) {
      btnBuyBonus.setAttribute("aria-disabled", "true");
    } else {
      btnBuyBonus.removeAttribute("aria-disabled");
    }
  }

  btnWildSpin.addEventListener("click", () => {
    if (state.spinning || state.inFreeSpins) return;
    if (state.wildSpinArmed) {
      state.wildSpinArmed = false;
      btnWildSpin.setAttribute("aria-pressed", "false");
      refreshExclusiveButtons();
      return;
    }
    refreshWildSpinModal();
    openModal(wildSpinModal);
  });

  function refreshWildSpinModal() {
    // Wild Spin doubles the bet for the upcoming spin → cost = 2 × bet shown
    // here for clarity. The actual deduction happens in spin().
    wsCost.textContent = fmt(state.bet * 2);
    wsBet.textContent = fmt(state.bet);
  }
  wildSpinClose.addEventListener("click", () => closeModal(wildSpinModal));
  wildSpinModal.addEventListener("click", (e) => { if (e.target === wildSpinModal) closeModal(wildSpinModal); });
  wsActivate.addEventListener("click", () => {
    state.wildSpinArmed = true;
    btnWildSpin.setAttribute("aria-pressed", "true");
    refreshExclusiveButtons();
    closeModal(wildSpinModal);
  });
  wsBetUp.addEventListener("click", () => {
    state.betIdx = Math.min(BET_LEVELS.length - 1, state.betIdx + 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
    refreshWildSpinModal();
  });
  wsBetDown.addEventListener("click", () => {
    state.betIdx = Math.max(0, state.betIdx - 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
    refreshWildSpinModal();
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
  refreshFSBanner(); refreshBonusActive();
  renderPaytable();

  // Loading intro: actually preload every PNG used by the game and drive
  // the progress bar from REAL load progress. Bar reaches 100% only when
  // the last asset finishes. A minimum 900ms display keeps the brand
  // moment visible even when assets are cached.
  (function runLoadingIntro() {
    const overlay = document.getElementById("loadingIntro");
    if (!overlay) return;
    const fill = document.getElementById("loadingBarFill");
    const pct  = document.getElementById("loadingPct");

    // Every PNG the game touches. Listed explicitly so a missing/typo asset
    // is visible here rather than silently ignored at runtime.
    const ASSETS = [
      // Background / scene
      "bg.png", "logo.png", "left-asset.png", "bottom.png", "slot-frame.png",
      "fire-left.png", "fire-right.png",
      // HUD buttons
      "buy-bonus-button.png", "wildspin-button-off.png", "wildspin-button-on.png",
      "spin-button.png", "button-autoplay.png", "button-fastfwd.png",
      "plus.png", "minus.png",
      // Regular paying symbols
      "symbol01.png", "symbol02.png", "symbol03.png", "symbol04.png",
      "symbol05.png", "symbol06.png", "symbol07.png", "symbol08.png", "symbol09.png",
      // Special grid symbols
      "scatter-medallion.png", "wild-pyramid.png", "mult-pyramid-base.png",
      "booster-symbol.png", "destroyer-symbol.png",
      // Modal frames + titles
      "modal-panel-bg.png", "card-buy-option-bg.png", "confirm-jar.png",
      "title-wild-spin.png", "title-buy-free-spins.png",
      "title-free-spins.png", "title-bonus-game.png",
      // Modal buttons + arrows
      "btn-activate.png", "btn-buy.png", "btn-buy-disabled.png",
      "btn-ok.png", "btn-back.png", "btn-close-x.png",
      "arrow-left.png", "arrow-right.png",
      // Buy FS pyramid icons
      "pyramid-stack.png",
      // FS overlays + banner panels
      "fs-trigger-screen.png", "fs-portal-bg.png",
      "special-asset1.png", "right-special-asset-2.png",
    ];

    const MIN_MS = 900;
    const startedAt = performance.now();
    let loaded = 0;
    const total = ASSETS.length;

    function updateBar() {
      const p = Math.round((loaded / total) * 100);
      if (fill) fill.style.width = p + "%";
      if (pct)  pct.textContent  = p + "%";
    }

    function loadOne(src) {
      return new Promise((resolve) => {
        const img = new Image();
        // Resolve either way — a missing PNG shouldn't block the intro
        const done = () => { loaded++; updateBar(); resolve(); };
        img.onload = done;
        img.onerror = done;
        img.src = "assets/" + src;
      });
    }

    Promise.all(ASSETS.map(loadOne)).then(() => {
      const elapsed = performance.now() - startedAt;
      const wait = Math.max(0, MIN_MS - elapsed);
      setTimeout(() => overlay.classList.add("hidden"), wait);
    });

    updateBar();
  })();
})();
