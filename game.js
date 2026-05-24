/* Temple of Xibalba — slot game logic
 *
 * Mechanic: 5 reels x 7 rows, cluster pays.
 * A "cluster" = 5+ orthogonally-connected cells with the same symbol.
 * After a winning spin, matched symbols are removed and remaining symbols
 * cascade down; new symbols drop into the empty cells. Cascades repeat
 * until no more clusters form.
 */

(() => {
  "use strict";

  // ---- config ----------------------------------------------------------------
  const COLS = 5;
  const ROWS = 7;
  const SYMBOLS = [
    "symbol01", "symbol02", "symbol03", "symbol04",
    "symbol05", "symbol06", "symbol07", "symbol08", "symbol09",
  ];

  // weighted probabilities — lower-index symbols are rarer (higher value)
  const WEIGHTS = [3, 4, 5, 7, 9, 11, 13, 15, 17];

  // payout multipliers per symbol per cluster size
  // size 5 → small, size 12+ → huge
  function payout(symbolIndex, clusterSize, bet) {
    // higher-tier symbols (lower index) pay much more
    const tierMult = [50, 25, 12, 6, 3, 1.6, 1, 0.6, 0.4][symbolIndex];
    const sizeMult = Math.pow(clusterSize / 5, 1.8);
    return +(bet * tierMult * sizeMult * 0.04).toFixed(2);
  }

  const BET_LEVELS = [0.20, 0.50, 1.00, 2.00, 5.00, 10.00, 25.00, 50.00];

  // ---- state -----------------------------------------------------------------
  const state = {
    grid: [],             // grid[row][col] = symbol index
    balance: 100.00,
    bet: 1.00,
    betIdx: 2,
    lastWin: 0,
    totalSpinWin: 0,
    spinning: false,
    autoplay: false,
    fastForward: false,
    wildSpinArmed: false,
  };

  // ---- DOM refs --------------------------------------------------------------
  const reelsEl = document.getElementById("reels");
  const btnSpin = document.getElementById("btnSpin");
  const btnAutoplay = document.getElementById("btnAutoplay");
  const btnFastFwd = document.getElementById("btnFastFwd");
  const btnBuyBonus = document.getElementById("btnBuyBonus");
  const btnWildSpin = document.getElementById("btnWildSpin");
  const hudBalance = document.getElementById("hudBalance");
  const hudBet = document.getElementById("hudBet");
  const hudWin = document.getElementById("hudWin");
  const betUp = document.getElementById("betUp");
  const betDown = document.getElementById("betDown");
  const winBanner = document.getElementById("winBanner");
  const winBannerText = document.getElementById("winBannerText");

  // ---- responsive scaling ----------------------------------------------------
  const stage = document.getElementById("stage");
  function fit() {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const scale = Math.min(sw / 1920, sh / 1080);
    stage.style.transform = `scale(${scale})`;
  }
  window.addEventListener("resize", fit);
  fit();

  // ---- grid helpers ----------------------------------------------------------
  function pickWeightedSymbol() {
    const total = WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < WEIGHTS.length; i++) {
      r -= WEIGHTS[i];
      if (r <= 0) return i;
    }
    return WEIGHTS.length - 1;
  }

  function randomGrid() {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(pickWeightedSymbol());
      g.push(row);
    }
    return g;
  }

  function buildCells() {
    reelsEl.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.row = r;
        cell.dataset.col = c;
        const sym = document.createElement("div");
        sym.className = "symbol";
        cell.appendChild(sym);
        reelsEl.appendChild(cell);
      }
    }
  }

  function cellAt(r, c) {
    return reelsEl.children[r * COLS + c];
  }

  function paint() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = cellAt(r, c);
        const sym = cell.querySelector(".symbol");
        const idx = state.grid[r][c];
        if (idx === null || idx === undefined) {
          sym.style.backgroundImage = "";
          sym.style.opacity = "0";
        } else {
          sym.style.backgroundImage = `url("assets/${SYMBOLS[idx]}.png")`;
          sym.style.opacity = "1";
        }
      }
    }
  }

  // ---- cluster detection (orthogonal flood fill) -----------------------------
  function findClusters(grid) {
    const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    const clusters = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (seen[r][c]) continue;
        const sym = grid[r][c];
        if (sym === null || sym === undefined) continue;
        const stack = [[r, c]];
        const cells = [];
        while (stack.length) {
          const [y, x] = stack.pop();
          if (y < 0 || y >= ROWS || x < 0 || x >= COLS) continue;
          if (seen[y][x]) continue;
          if (grid[y][x] !== sym) continue;
          seen[y][x] = true;
          cells.push([y, x]);
          stack.push([y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]);
        }
        if (cells.length >= 5) {
          clusters.push({ symbol: sym, cells });
        }
      }
    }
    return clusters;
  }

  // ---- cascade: drop existing symbols down, fill empties on top -------------
  function cascade(grid) {
    for (let c = 0; c < COLS; c++) {
      const stack = [];
      for (let r = ROWS - 1; r >= 0; r--) {
        if (grid[r][c] !== null && grid[r][c] !== undefined) {
          stack.push(grid[r][c]);
        }
      }
      const newSymbols = [];
      for (let r = ROWS - 1; r >= 0; r--) {
        if (stack.length) grid[r][c] = stack.shift();
        else {
          const ns = pickWeightedSymbol();
          grid[r][c] = ns;
          newSymbols.push([r, c]);
        }
      }
    }
  }

  // ---- animation helpers -----------------------------------------------------
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  function ffWait(ms) { return wait(state.fastForward ? Math.max(40, ms * 0.25) : ms); }

  function emitSparks(cell) {
    const rect = cell.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const stageScale = stageRect.width / 1920;
    const cx = (rect.left + rect.width / 2 - stageRect.left) / stageScale;
    const cy = (rect.top + rect.height / 2 - stageRect.top) / stageScale;
    for (let i = 0; i < 6; i++) {
      const s = document.createElement("div");
      s.className = "spark";
      s.style.left = cx + "px";
      s.style.top = cy + "px";
      const ang = (Math.PI * 2 * i) / 6 + Math.random() * 0.4;
      const dist = 40 + Math.random() * 40;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      stage.appendChild(s);
      setTimeout(() => s.remove(), 800);
    }
  }

  async function animateSpinIn() {
    // mark all cells spinning and start a per-cell ticker that swaps the
    // background image to a random symbol every ~60ms — this gives the illusion
    // of a reel scrolling past, rather than a single symbol bouncing in-cell.
    for (const cell of reelsEl.children) cell.classList.add("spinning");

    const tickers = [];
    for (const cell of reelsEl.children) {
      const sym = cell.querySelector(".symbol");
      sym.style.opacity = "1";
      const id = setInterval(() => {
        const rnd = Math.floor(Math.random() * SYMBOLS.length);
        sym.style.backgroundImage = `url("assets/${SYMBOLS[rnd]}.png")`;
      }, 55 + Math.random() * 40);
      tickers.push(id);
    }

    await ffWait(600);

    // pick the final grid, then stop each column in left-to-right sequence
    state.grid = randomGrid();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const idx = r * COLS + c;
        clearInterval(tickers[idx]);
        const cell = reelsEl.children[idx];
        cell.classList.remove("spinning");
        cell.classList.add("dropping");
        const sym = cell.querySelector(".symbol");
        sym.style.backgroundImage = `url("assets/${SYMBOLS[state.grid[r][c]]}.png")`;
      }
      await ffWait(90);
    }
    await ffWait(180);
    for (const cell of reelsEl.children) cell.classList.remove("dropping");
  }

  async function animateMatched(cells) {
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.add("matched");
      emitSparks(cell);
    }
    await ffWait(550);
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.remove("matched");
      state.grid[r][c] = null;
      const sym = cell.querySelector(".symbol");
      sym.style.opacity = "0";
      sym.style.backgroundImage = "";
    }
  }

  async function animateCascade() {
    cascade(state.grid);
    // mark all cells as dropping for the visual; paint and let the CSS anim run
    for (let i = 0; i < reelsEl.children.length; i++) {
      reelsEl.children[i].classList.add("dropping");
    }
    paint();
    await ffWait(360);
    for (const cell of reelsEl.children) cell.classList.remove("dropping");
  }

  // ---- big-win banner --------------------------------------------------------
  function tierLabel(win, bet) {
    const r = win / bet;
    if (r >= 50) return "MEGA WIN";
    if (r >= 20) return "HUGE WIN";
    if (r >= 10) return "BIG WIN";
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

  // ---- HUD updates -----------------------------------------------------------
  function fmt(v) { return v.toFixed(2); }
  function refreshHUD() {
    hudBalance.textContent = `${fmt(state.balance)} ETH`;
    hudBet.textContent = fmt(state.bet);
    hudWin.textContent = `${fmt(state.lastWin)} ETH`;
  }

  // ---- core spin loop --------------------------------------------------------
  async function spin() {
    if (state.spinning) return;

    // wild-spin: doubles bet, guarantees at least one wild row by biasing toward
    // a single high-tier symbol. For simplicity we just inflate weights.
    let effectiveBet = state.bet;
    if (state.wildSpinArmed) {
      effectiveBet = state.bet * 2;
    }

    if (state.balance < effectiveBet) {
      flashHUD(hudBalance);
      return;
    }

    state.spinning = true;
    btnSpin.disabled = true;
    btnSpin.classList.add("spinning");
    state.balance -= effectiveBet;
    state.lastWin = 0;
    state.totalSpinWin = 0;
    refreshHUD();

    await animateSpinIn();

    // optional wild spin: replace ~10% of cells with the highest-tier symbol (0)
    if (state.wildSpinArmed) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (Math.random() < 0.12) state.grid[r][c] = 0;
        }
      }
      paint();
    }

    // cascade loop
    let cascades = 0;
    while (true) {
      const clusters = findClusters(state.grid);
      if (!clusters.length) break;

      let stepWin = 0;
      const allCells = [];
      for (const cl of clusters) {
        stepWin += payout(cl.symbol, cl.cells.length, effectiveBet);
        allCells.push(...cl.cells);
      }
      state.totalSpinWin += stepWin;
      state.lastWin = state.totalSpinWin;
      refreshHUD();

      await animateMatched(allCells);
      await animateCascade();

      cascades++;
      if (cascades > 25) break; // safety
    }

    state.balance += state.totalSpinWin;
    refreshHUD();

    if (state.totalSpinWin > 0) {
      await maybeShowBigWin(state.totalSpinWin, effectiveBet);
    }

    // wild-spin consumes one spin
    if (state.wildSpinArmed) {
      state.wildSpinArmed = false;
      btnWildSpin.setAttribute("aria-pressed", "false");
    }

    state.spinning = false;
    btnSpin.disabled = false;
    btnSpin.classList.remove("spinning");

    if (state.autoplay) {
      await ffWait(500);
      if (state.autoplay && state.balance >= state.bet) spin();
      else {
        state.autoplay = false;
        btnAutoplay.classList.remove("active");
      }
    }
  }

  function flashHUD(el) {
    el.animate(
      [
        { color: "#ff5252", transform: "scale(1.15)" },
        { color: "#ffe8a1", transform: "scale(1)" },
      ],
      { duration: 600 }
    );
  }

  // ---- buttons ---------------------------------------------------------------
  btnSpin.addEventListener("click", () => {
    if (state.autoplay) {
      state.autoplay = false;
      btnAutoplay.classList.remove("active");
      return;
    }
    spin();
  });

  btnAutoplay.addEventListener("click", () => {
    state.autoplay = !state.autoplay;
    btnAutoplay.classList.toggle("active", state.autoplay);
    if (state.autoplay && !state.spinning) spin();
  });

  btnFastFwd.addEventListener("click", () => {
    state.fastForward = !state.fastForward;
    btnFastFwd.classList.toggle("active", state.fastForward);
  });

  btnBuyBonus.addEventListener("click", async () => {
    if (state.spinning) return;
    const cost = state.bet * 100; // "from 100x" style buy-bonus
    if (state.balance < cost) { flashHUD(hudBalance); return; }
    state.balance -= cost;
    refreshHUD();
    // bonus round: 6 free spins with wild-spin behavior
    let won = 0;
    for (let i = 0; i < 6; i++) {
      state.wildSpinArmed = true;
      btnWildSpin.setAttribute("aria-pressed", "true");
      const beforeBal = state.balance;
      // skip the wild-spin extra-cost by temporarily refunding
      state.balance += state.bet * 2;
      await spin();
      won += state.totalSpinWin;
      await ffWait(200);
    }
    winBannerText.textContent = `BONUS +${fmt(won)} ETH`;
    winBanner.classList.add("visible");
    await ffWait(1800);
    winBanner.classList.remove("visible");
  });

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

  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); btnSpin.click(); }
    if (e.code === "KeyA") btnAutoplay.click();
    if (e.code === "KeyF") btnFastFwd.click();
  });

  // ---- init ------------------------------------------------------------------
  buildCells();
  state.grid = randomGrid();
  paint();
  refreshHUD();
})();
