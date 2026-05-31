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

  // ---- audio --------------------------------------------------------------
  // Lightweight sound bank — one Audio per event, plus an HTML5 audio element
  // for the looping background tracks. Pre-warmed on first user gesture
  // (browsers block autoplay until the user interacts) so the play button
  // click double-duties as the audio unlock.
  const SFX = {
    click:        new Audio("assets/sounds/click.ogg"),
    spin:         new Audio("assets/sounds/spin.ogg"),
    reelStop:     new Audio("assets/sounds/reel-stop.ogg"),
    spinLand:     new Audio("assets/sounds/spin-land.ogg"),   // big "drank" on grid settle
    reelLand:     new Audio("assets/sounds/reel-land.ogg"),   // weighty drop on cascade
    clusterPop:   new Audio("assets/sounds/cluster-pop.ogg"),
    scatter:      new Audio("assets/sounds/scatter.ogg"),
    wildDig:      new Audio("assets/sounds/wild-dig.ogg"),
    multBump:     new Audio("assets/sounds/mult-bump.ogg"),
    winSmall:     new Audio("assets/sounds/win-small.ogg"),
    winMedium:    new Audio("assets/sounds/win-medium.ogg"),
    winBig:       new Audio("assets/sounds/win-big.ogg"),
    winMega:      new Audio("assets/sounds/win-mega.ogg"),
    fsTrigger:    new Audio("assets/sounds/fs-trigger.ogg"),
    fsEnd:        new Audio("assets/sounds/fs-end.ogg"),
    buyBonus:     new Audio("assets/sounds/buy-bonus.ogg"),
    coinTick:     new Audio("assets/sounds/coin-tick.ogg"),
  };
  for (const k in SFX) { SFX[k].preload = "auto"; SFX[k].volume = 0.45; }
  SFX.click.volume = 0.35;
  SFX.spin.volume  = 0.45;   // short wood tap — quick, percussive, Aztec drum feel
  SFX.coinTick.volume = 0.25;
  SFX.winMega.volume = 0.7;
  SFX.spinLand.volume = 0.65;   // big drop hit, should feel weighty
  SFX.reelLand.volume = 0.5;

  // BGM: keep TWO audio nodes per track so we can pre-cue the next loop
  // start before the first one ends — eliminates the ~200ms silent gap
  // browsers introduce between iterations of <audio loop>. The second
  // copy starts ~250ms before the first ends, fading in as the first
  // fades out, creating a seamless rolling crossfade.
  function makeBgmPair(src, volume) {
    const a = new Audio(src), b = new Audio(src);
    a.preload = "auto"; b.preload = "auto";
    a.volume = volume;  b.volume = volume;
    a.load(); b.load();
    let activeRef = a;
    function arm(node, other) {
      node.addEventListener("timeupdate", () => {
        if (!node.duration || node.paused) return;
        const remaining = node.duration - node.currentTime;
        if (remaining < 0.25 && other.paused) {
          other.currentTime = 0;
          other.volume = 0;
          other.play().catch(() => {});
          activeRef = other;          // <-- track the new active node
          const startedAt = performance.now();
          const fadeMs = 240;
          const fading = node; const incoming = other;
          (function fade() {
            const t = Math.min(1, (performance.now() - startedAt) / fadeMs);
            fading.volume   = volume * (1 - t);
            incoming.volume = volume * t;
            if (t < 1) requestAnimationFrame(fade);
            else { fading.pause(); fading.currentTime = 0; fading.volume = volume; }
          })();
        }
      });
    }
    arm(a, b); arm(b, a);
    // Try to play, and if the browser blocks/rejects (audio not yet
    // decoded), retry once the canplay event fires. Fixes the "music
    // sometimes doesn't start" report.
    let canPlayListener = null;
    function clearCanPlayListener() {
      if (canPlayListener) {
        canPlayListener.node.removeEventListener("canplay", canPlayListener.fn);
        canPlayListener = null;
      }
    }
    function tryPlay() {
      clearCanPlayListener();
      activeRef.currentTime = 0;
      activeRef.volume = volume;
      const p = activeRef.play();
      if (p && p.catch) {
        p.catch(() => {
          const node = activeRef;
          const fn = () => {
            canPlayListener = null;
            node.removeEventListener("canplay", fn);
            // Honor mute that may have flipped on between the failed
            // play() and the canplay retry — otherwise we'd resurrect
            // BGM the user just silenced.
            if (audioMuted) return;
            node.play().catch(() => {});
          };
          canPlayListener = { node, fn };
          node.addEventListener("canplay", fn);
        });
      }
    }
    return {
      play()  { tryPlay(); },
      pause() { a.pause(); b.pause(); },
    };
  }
  const bgmBase = makeBgmPair("assets/sounds/bg-loop-base.ogg", 0.22);
  const bgmFS   = makeBgmPair("assets/sounds/bg-loop-fs.ogg",   0.28);

  let audioMuted = false;
  // Some sounds benefit from a temple-style echo (big wins, FS trigger,
  // cluster pops). Cheap implementation: play a second quieter copy with
  // a short delay — no Web Audio graph needed, works reliably on first
  // load. Keys here use the same names as SFX above.
  const ECHO_DELAYS = {
    clusterPop: [180],
    scatter:    [220, 440],
    wildDig:    [180, 360],
    winBig:     [240, 480],
    winMega:    [260, 520, 780],
    fsTrigger:  [280, 560],
    fsEnd:      [240],
    spinLand:   [180, 360],   // premium "drank" — heavy hit + cavern tail
  };
  // Pool of pre-loaded clones per SFX so rapid triggers (cascade chains)
  // overlap without each one having to decode-from-scratch on cloneNode.
  // The original SFX[key] stays as the canonical preload; clones are
  // built UPFRONT inside prewarm() so first play is instant.
  const SFX_POOL = {};
  const POOL_SIZE = 4;
  let poolIdx = {};
  function playSfx(key) {
    if (audioMuted) return;
    const pool = SFX_POOL[key];
    const tpl  = SFX[key];
    if (!tpl) return;
    const play = (volMul, delay) => {
      // Round-robin through the pool so back-to-back triggers don't cut
      // each other off and we don't pay for cloneNode on every call.
      let node;
      if (pool) {
        poolIdx[key] = ((poolIdx[key] || 0) + 1) % pool.length;
        node = pool[poolIdx[key]];
        try { node.currentTime = 0; } catch (e) {}
      } else {
        node = tpl.cloneNode(true);
      }
      node.volume = tpl.volume * volMul;
      const start = () => { try { node.play().catch(() => {}); } catch (e) {} };
      if (delay > 0) setTimeout(start, delay);
      else start();
    };
    play(1.0, 0);
    const echoes = ECHO_DELAYS[key];
    if (echoes) {
      // Each echo is fainter than the last → exponential decay
      echoes.forEach((delay, i) => play(0.55 * Math.pow(0.6, i), delay));
    }
  }
  function startBgm(which) {
    if (audioMuted) return;
    const target = which === "fs" ? bgmFS : bgmBase;
    const other  = which === "fs" ? bgmBase : bgmFS;
    other.pause();
    target.play();
  }
  function stopBgm() { bgmBase.pause(); bgmFS.pause(); }
  // Decode every SFX once inside the user-gesture context — guarantees no
  // "first play swallowed because the buffer wasn't ready" hiccup later.
  function prewarm() {
    for (const k in SFX) {
      const s = SFX[k];
      // Build a small pool of cloned nodes for round-robin overlap
      // playback. Done HERE (inside the user-gesture context) so every
      // clone has its decode pipeline kicked off — first real playSfx is
      // guaranteed audible.
      const pool = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const c = s.cloneNode(true);
        c.preload = "auto";
        c.volume = s.volume;
        try { c.load(); } catch (e) {}
        pool.push(c);
      }
      SFX_POOL[k] = pool;
      // Touch each node with a muted play→pause to force the codec to
      // decode now rather than on first real playback.
      try {
        s.muted = true;
        const p = s.play();
        if (p && p.then) {
          p.then(() => { s.pause(); s.currentTime = 0; s.muted = false; })
           .catch(() => { s.muted = false; });
        } else {
          s.pause(); s.currentTime = 0; s.muted = false;
        }
      } catch (e) { s.muted = false; }
    }
  }
  // Expose globally for the loading-intro PLAY button to call (it lives
  // outside this IIFE-managed code path).
  window.__xibalbaAudio = { playSfx, startBgm, stopBgm, prewarm,
    setMuted(m) { audioMuted = m; if (m) stopBgm(); else startBgm("base"); } };


  // ---- config ----------------------------------------------------------------
  const COLS = 5;
  const ROWS = 7;

  // 8 regular paying symbols (idx 0..7, 0 = highest pay)
  // symbol01 and symbol02 are reserved as multiplier-badge BASES (frame
  // PNG, ×N rendered as 3D text overlay via CSS). symbol03 is dropped
  // because it's visually identical to scatter-medallion. Regular paying
  // symbols are 3 hero tiles (jaguar / feathered serpent / red mask) +
  // the gem set symbol04..symbol09. Heroes are RAREST (lowest weights),
  // gems get progressively more common.
  const REG_ASSETS = ["symbol-jaguar","symbol-feather","symbol-mask-red","symbol04","symbol05","symbol06","symbol07","symbol08","symbol09"];

  // Weights skewed toward common low-tier symbols so clusters form often.
  // Length MUST match REG_ASSETS or pickRegSymbol returns an index that
  // maps to undefined and the cell silently fails to render.
  const REG_WEIGHTS = [3, 4, 5, 6, 9, 12, 15, 18, 22];

  // base payouts: PAY_TABLE[symIdx][clusterSize - 5], clamped at len-1.
  // 9 rows = REG_ASSETS.length: jaguar / feather / mask-red are the three
  // hero tiers at the top, followed by the 6 gem tiers.
  // Calibrated by Monte Carlo simulation (sim.js) with FS boost active
  // (1 guaranteed wild per FS spin): RTP ~96%, hit 29.4%, FS 1/220,
  // FS-share ~18% of RTP. Re-tune via `node sim.js tune` and copy the
  // printed final table back here.
  const PAY_TABLE = [
    [1.281, 1.776, 2.600, 3.845, 5.676,  8.423, 12.634, 19.044],  // 0 jaguar
    [0.843, 1.171, 1.721, 2.564, 3.772,  5.676,  8.606, 13.184],  // 1 feather
    [0.567, 0.787, 1.171, 1.758, 2.600,  3.955,  6.042,  9.522],  // 2 red mask
    [0.348, 0.494, 0.733, 1.099, 1.611,  2.490,  3.845,  6.226],  // 3 symbol04
    [0.212, 0.301, 0.440, 0.659, 0.970,  1.501,  2.344,  3.845],  // 4 symbol05
    [0.131, 0.183, 0.271, 0.403, 0.604,  0.934,  1.465,  2.454],  // 5 symbol06
    [0.081, 0.114, 0.168, 0.253, 0.374,  0.579,  0.916,  1.538],  // 6 symbol07
    [0.052, 0.073, 0.110, 0.164, 0.241,  0.374,  0.594,  1.007],  // 7 symbol08
    [0.033, 0.048, 0.070, 0.106, 0.154,  0.241,  0.384,  0.659],  // 8 symbol09
  ];

  function payForCluster(symIdx, size) {
    const row = PAY_TABLE[symIdx];
    const i = Math.min(Math.max(size - 5, 0), row.length - 1);
    return row[i];
  }

  // Probabilities for special symbols on initial fill / cascade fill.
  // Base-game value calibrated by sim.js to land FS triggers at 1/208 spins.
  const SCATTER_FILL_PROB    = 0.0328; // base-game spawn rate per cell (capped 1/reel)
  const SCATTER_FILL_PROB_FS = 0.004;  // ~8× rarer during free spins to prevent runaway retriggers

  // Dig-up probabilities (per cleared cell, after a cluster pop, before refill)
  const DIG = {
    wild: 0.06,
    booster: 0.03,
    destroyer: 0.025,
    scatter: 0.02,
  };

  const BET_LEVELS = [0.20, 0.50, 1.00, 2.00, 5.00, 10.00, 25.00, 50.00];

  function freeSpinsForScatters(n, isRetrigger) {
    // Retriggers award FEWER spins than the initial trigger so a streak of
    // lucky scatter spawns can't keep the round running forever.
    if (isRetrigger) {
      if (n >= 6) return 10;
      if (n >= 5) return 8;
      if (n >= 4) return 6;
      if (n >= 3) return 5;
      return 0;
    }
    if (n >= 6) return 20;
    if (n >= 5) return 15;
    if (n >= 4) return 12;
    if (n >= 3) return 10;
    return 0;
  }

  // Buy Free Spins ratios calibrated by sim.js. Avg FS payout ≈ 19× per
  // trigger → REGULAR at 20× is ~95% RTP buy (typical premium ratio).
  // Higher tiers pay proportional to their guaranteed-wild boost (each
  // forced wild ~doubles the round's EV).
  const BUY_OPTIONS = [
    { label: "REGULAR",            sublabel: "10 FREE SPINS",                 cost:  37,  wilds: 0 },
    { label: "1 WILD",             sublabel: "12 FS · WILD ×15",              cost:  47,  wilds: 1 },
    { label: "2 WILDS",            sublabel: "15 FS · WILD ×25 · ×4 MULTS",   cost:  63,  wilds: 2 },
    { label: "ALL SCATTERS",       sublabel: "18 FS · ALL WILDS ×30 · ×4 MULTS",  cost:  82,  wilds: 3, allWilds: true },
  ];

  // ---- cell types -----------------------------------------------------------
  // grid[r][c] is null | { t: "reg", i: 0..7 } | { t: "scatter" } |
  //                  { t: "wild", m: 10..100 } | { t: "booster" } | { t: "destroyer" }
  const TY = { REG: "reg", SCAT: "scatter", WILD: "wild", BOOST: "booster", DEST: "destroyer" };

  // ---- provably-fair backend integration ----------------------------------
  // SERVER_MODE: when true, every spin/buy-bonus is sent to the server and
  // the returned outcome is replayed locally. Outcomes are deterministic
  // from (serverSeed, clientSeed, nonce) so the player can verify any past
  // spin independently. When the API can't be reached we fall back to the
  // local Math.random path so the game remains playable offline.
  const API_BASE = (typeof window !== "undefined"
    && (window.location.protocol === "http:" || window.location.protocol === "https:"))
    ? `${window.location.protocol}//${window.location.host}`
    : "http://localhost:3000";
  let SERVER_MODE = false;             // flipped on after ensureSession() succeeds
  let SESSION = null;                  // { id, serverSeedHash, clientSeed, nonce, balance, bet, betIdx, buyBonusIdx }
  const LS_KEY = "xibalba_session_id";

  async function api(path, opts = {}) {
    const url = `${API_BASE}/api${path}`;
    const r = await fetch(url, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!r.ok) {
      let body = {};
      try { body = await r.json(); } catch (_) {}
      const e = new Error(body.error || `HTTP ${r.status}`);
      e.status = r.status; e.body = body;
      throw e;
    }
    return r.json();
  }

  async function ensureSession() {
    const cached = (typeof localStorage !== "undefined") ? localStorage.getItem(LS_KEY) : null;
    if (cached) {
      try { SESSION = await api(`/session/${cached}`); SERVER_MODE = true; return; }
      catch (_) { /* expired or server down — fall through */ }
    }
    try {
      SESSION = await api(`/session`, { method: "POST", body: {} });
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, SESSION.id);
      SERVER_MODE = true;
    } catch (_) {
      SERVER_MODE = false;   // offline / standalone demo mode
      console.warn("[xibalba] backend unreachable, running standalone demo mode");
    }
  }

  // Engine cells use integer `t` (0=reg, 1=scat, 2=wild, ...). Local code
  // uses string `t`. Convert both directions when bridging.
  const TY_INT_TO_STR = ["reg", "scatter", "wild", "booster", "destroyer"];
  function unboxCell(v) { if (!v) return null; return { ...v, t: TY_INT_TO_STR[v.t] }; }
  function unboxGrid(g) { return g.map((row) => row.map(unboxCell)); }
  function cloneMultGrid(m) { return m.map((row) => row.slice()); }

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
    // Uniform letterbox scale — same factor for X and Y so the whole
    // 1920×1080 stage (bg video + slot + chrome + character + totem)
    // moves as ONE locked unit. Nothing drifts relative to anything
    // else on resize. 4dp rounding kills sub-pixel jitter.
    const s = Math.round(Math.min(sw / 1920, sh / 1080) * 10000) / 10000;
    stage.style.transform = `scale(${s})`;
  }
  // Debounce resize so a drag-to-resize doesn't fire 60+ layout passes.
  let fitT = null;
  window.addEventListener("resize", () => {
    if (fitT) cancelAnimationFrame(fitT);
    fitT = requestAnimationFrame(fit);
  });
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
        const scatProb = state.inFreeSpins ? SCATTER_FILL_PROB_FS : SCATTER_FILL_PROB;
        if (scattersPerCol[c] === 0 && Math.random() < scatProb) {
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

    cell.classList.remove("scatter", "wild", "booster", "destroyer", "mult-only", "has-mult", "has-mult-high", "mult-low", "mult-mid", "mult-high");

    if (!v) {
      sym.style.opacity = "0";
      sym.style.backgroundImage = "";
      badge.removeAttribute("data-mult");
    } else if (v.t === TY.REG) {
      sym.style.opacity = "1";
      sym.style.backgroundImage = `url("assets/${REG_ASSETS[v.i]}.png")`;
    } else if (v.t === TY.SCAT) {
      // Scatter visual = scatter-medallion.png (drawn via .cell.scatter .symbol
      // CSS rule). No JS-set fallback PNG so the old symbol01.png ×90 pyramid
      // can't leak through.
      sym.style.opacity = "1";
      sym.style.backgroundImage = "";
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

    // Multiplier badge. Wild cells already paint their ×N via the badge
    // ::before pseudo-element (data-mult), so suppressing the separate
    // .multiplier overlay there avoids the "××N" double-× render.
    const m = state.cellMult[r][c];
    const isWild = v && v.t === TY.WILD;
    if (m && m > 0 && !isWild) {
      multEl.textContent = `×${m}`;
      multEl.style.display = "flex";
      multEl.classList.toggle("big", m >= 8);
      // Soft highlight on cells with an active multiplier (no stroke; just
      // a faint tint so the square reads as part of the bg).
      cell.classList.add(m >= 6 ? "has-mult-high" : "has-mult");
      // Pick the pyramid tier asset by multiplier value:
      //   ≤10  → low  (gold)
      //   ≤50  → mid  (orange-fire)
      //   else → high (purple-magical)
      const tier = m <= 10 ? "mult-low" : m <= 50 ? "mult-mid" : "mult-high";
      cell.classList.add(tier);
      // Empty cell + multiplier: paint a dimmed gem behind the ×N so the cell
      // reads as the same square shape as its neighbours (no jarring cartouche).
      // Pick deterministically from position so the ghost gem stays stable
      // across re-paints.
      if (!v) {
        cell.classList.add("mult-only");
        const ghostIdx = (r * 5 + c) % REG_ASSETS.length;
        sym.style.backgroundImage = `url("assets/${REG_ASSETS[ghostIdx]}.png")`;
        sym.style.opacity = "1";
      }
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
          const scatProb = state.inFreeSpins ? SCATTER_FILL_PROB_FS : SCATTER_FILL_PROB;
          if (!colHasScatter && Math.random() < scatProb) {
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
  // Counter-up animation on the HUD WIN so the number visibly RACES up to
  // its new value instead of just changing — much more "you won this!"
  // than a silent text swap. Stores the in-flight animation handle so a
  // new cascade step interrupts cleanly instead of stacking.
  let hudWinFrom = 0, hudWinTo = 0, hudWinAnim = null;
  function setHudWinAnimated(target) {
    if (Math.abs(target - hudWinTo) < 0.001) return;
    hudWinFrom = parseFloat((hudWin.textContent || "0").replace(/[^\d.]/g, "")) || 0;
    hudWinTo   = target;
    if (hudWinAnim) cancelAnimationFrame(hudWinAnim);
    const startedAt = performance.now();
    const DUR = 600;
    function step(now) {
      const t = Math.min(1, (now - startedAt) / DUR);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = hudWinFrom + (hudWinTo - hudWinFrom) * eased;
      hudWin.textContent = `${fmt(v)} ETH`;
      if (t < 1) hudWinAnim = requestAnimationFrame(step);
      else { hudWin.textContent = `${fmt(hudWinTo)} ETH`; hudWinAnim = null; }
    }
    hudWinAnim = requestAnimationFrame(step);
    // Pulse + glow on the WIN cell so it visually pops when the value
    // changes — the user said the per-spin win wasn't readable enough.
    if (target > 0) {
      hudWin.classList.remove("won"); void hudWin.offsetWidth; // restart anim
      hudWin.classList.add("won");
    }
  }
  // Center-bottom popup that shows the per-spin total with a count-up
  // effect — paired with the HUD pulse for unmissable "you won X" feedback.
  const spinWinPopup = document.getElementById("spinWinPopup");
  const spinWinAmount = document.getElementById("spinWinAmount");
  let spinWinHideT = null;
  let spinWinRaf = null;
  function showSpinWinPopup(amount) {
    if (!spinWinPopup) return;
    spinWinPopup.classList.add("visible");
    spinWinPopup.setAttribute("aria-hidden", "false");
    // Cancel any in-flight count-up so a rapid re-show doesn't race the
    // previous one (older rAF overwriting the newer value).
    if (spinWinRaf) cancelAnimationFrame(spinWinRaf);
    const startedAt = performance.now();
    const DUR = 500;
    (function tick(now) {
      const t = Math.min(1, (now - startedAt) / DUR);
      const eased = 1 - Math.pow(1 - t, 2);
      spinWinAmount.textContent = `${fmt(amount * eased)} ETH`;
      if (t < 1) spinWinRaf = requestAnimationFrame(tick);
      else { spinWinAmount.textContent = `${fmt(amount)} ETH`; spinWinRaf = null; }
    })(startedAt);
    if (spinWinHideT) clearTimeout(spinWinHideT);
    spinWinHideT = setTimeout(hideSpinWinPopup, 2400);
  }
  function hideSpinWinPopup() {
    if (!spinWinPopup) return;
    if (spinWinRaf) { cancelAnimationFrame(spinWinRaf); spinWinRaf = null; }
    spinWinPopup.classList.remove("visible");
    spinWinPopup.setAttribute("aria-hidden", "true");
  }
  function refreshHUD() {
    hudBalance.textContent = `${fmt(state.balance)} ETH`;
    hudBet.textContent = fmt(state.bet);
    setHudWinAnimated(state.lastWin);
    // Totem labels track the live bet — wild spin = 2× bet (matches the
    // modal cost), so the user sees the same number both places.
    const wsLabel = document.getElementById("wildSpinCostLabel");
    if (wsLabel) wsLabel.textContent = `${fmt(state.bet * 2)} ETH`;
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
      // Grace period: ignore clicks/keys for 1s so the overlay reveal
      // animation finishes and the user doesn't accidentally dismiss it
      // with a stray click from the previous spin.
      const armedAt = performance.now();
      const GRACE_MS = 1000;
      const advance = () => {
        if (performance.now() - armedAt < GRACE_MS) return;
        fsTriggerModal.classList.remove("visible");
        fsTriggerModal.setAttribute("aria-hidden", "true");
        fsTriggerModal.removeEventListener("click", advance);
        document.removeEventListener("keydown", onKey);
        resolve();
      };
      // Any key (not just Space/Enter/Esc) advances — user asked for
      // "press any key". Modifier-only presses are ignored so Cmd-tabbing
      // doesn't skip the moment.
      const onKey = (e) => {
        if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" ||
            e.key === "Meta"  || e.key === "CapsLock") return;
        e.preventDefault();
        advance();
      };
      fsTriggerModal.addEventListener("click", advance);
      document.addEventListener("keydown", onKey);
      // NO auto-advance — the user explicitly asked for the modal to wait
      // for a keypress/click. Autoplay sessions stay paused here too;
      // a real user interaction is required to enter the bonus round.
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
    // Match the audio celebration to the size of the win
    if (label === "MEGA WIN") playSfx("winMega");
    else if (label === "HUGE WIN") playSfx("winBig");
    else playSfx("winMedium");
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

  // Concentric red ring that ripples out from a destroyer cell — makes it
  // unmistakable that the destroyer is unleashing a board-wide effect.
  function emitDestroyerShockwave(cell) {
    const p = stageCoords(cell.getBoundingClientRect());
    for (let i = 0; i < 2; i++) {
      const ring = document.createElement("div");
      ring.className = "destroyer-shockwave";
      ring.style.left = p.x + "px";
      ring.style.top  = p.y + "px";
      ring.style.animationDelay = (i * 140) + "ms";
      stage.appendChild(ring);
      setTimeout(() => ring.remove(), 1000 + i * 140);
    }
  }

  // "DESTROYER · -N SYMBOLS" badge over the destroyer cell so the player
  // gets a literal explanation of what just happened, not just sparks.
  function showDestroyerLabel(cell, killCount) {
    const p = stageCoords(cell.getBoundingClientRect());
    const el = document.createElement("div");
    el.className = "destroyer-label";
    el.style.left = p.x + "px";
    el.style.top  = p.y + "px";
    el.innerHTML = `DESTROYER<span class="dl-count">−${killCount} low symbol${killCount === 1 ? "" : "s"}</span>`;
    stage.appendChild(el);
    setTimeout(() => el.remove(), 1400);
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
  // Classify a win-multiplier-of-bet into a visual tier (drives label size,
  // glow, optional badge text, and screen shake).
  function tierForWin(amount) {
    const x = amount / Math.max(0.0001, state.bet);
    if (x >= 100) return "mega";
    if (x >= 20)  return "huge";
    if (x >= 5)   return "big";
    if (x >= 1)   return "medium";
    return "small";
  }

  // Pops a readable "x SYM +AMOUNT" badge at the cluster centroid during the
  // highlight phase. Self-removes after the CSS animation ends.
  function showClusterWinLabel(wi) {
    if (!wi || !wi.cells || !wi.cells.length) return;
    let cx = 0, cy = 0;
    for (const [r, c] of wi.cells) {
      const p = stageCoords(cellAt(r, c).getBoundingClientRect());
      cx += p.x; cy += p.y;
    }
    cx /= wi.cells.length; cy /= wi.cells.length;
    const tier = tierForWin(wi.amount);
    const el = document.createElement("div");
    el.className = `cluster-win-label tier-${tier}`;
    el.style.left = cx + "px";
    el.style.top  = cy + "px";
    el.innerHTML = `<span class="cwl-size">×${wi.size}</span><span class="cwl-amt">+${wi.amount.toFixed(2)}</span>`;
    stage.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const lifetime = (tier === "mega" || tier === "huge") ? 1600 : 1250;
    setTimeout(() => el.remove(), lifetime);
    // Bigger wins also shake the stage. Re-trigger animation on each call so
    // multiple back-to-back huge clusters compound the shake.
    if (tier === "huge" || tier === "mega") {
      // Shake the wrapper, NOT #stage — #stage has a transform:scale set
      // by fit() that the shake's transform:translate would otherwise wipe,
      // breaking the layout until the next resize.
      const wrap = document.getElementById("stage-wrap");
      if (wrap) {
        wrap.classList.remove("shake");
        void wrap.offsetWidth;
        wrap.classList.add("shake");
        setTimeout(() => wrap.classList.remove("shake"), 450);
      }
    }
  }

  // ---- cluster connection SVG overlay --------------------------------------
  // Snake a glowing path through every cluster cell to make it visually
  // obvious WHICH symbols are connected. Lines fade as the cluster pops.
  const clusterLinksSvg = document.getElementById("clusterLinks");
  if (clusterLinksSvg) {
    clusterLinksSvg.innerHTML =
      `<defs>
         <linearGradient id="linkGradient" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0"   stop-color="#fff5b0"/>
           <stop offset="0.5" stop-color="#ffc94d"/>
           <stop offset="1"   stop-color="#ff7a1f"/>
         </linearGradient>
       </defs>`;
  }

  // Compute (x, y) of a cell's center in SVG-overlay coordinates (which match
  // the .reels box exactly, since the overlay is positioned/sized identically).
  function cellCenterInReels(r, c) {
    const cellRect = cellAt(r, c).getBoundingClientRect();
    const reelRect = reelsEl.getBoundingClientRect();
    const scaleX = clusterLinksSvg ? (clusterLinksSvg.clientWidth  / reelRect.width)  : 1;
    const scaleY = clusterLinksSvg ? (clusterLinksSvg.clientHeight / reelRect.height) : 1;
    return {
      x: (cellRect.left + cellRect.width / 2  - reelRect.left) * scaleX,
      y: (cellRect.top  + cellRect.height / 2 - reelRect.top ) * scaleY,
    };
  }

  // Order cluster cells so the path doesn't crisscross: greedy nearest-neighbor
  // starting from the top-left cell. Adjacent cells stay adjacent in the path.
  function orderClusterCells(cells) {
    if (!cells.length) return [];
    const pool = cells.map((c) => [...c]);
    pool.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const ordered = [pool.shift()];
    while (pool.length) {
      const [lr, lc] = ordered[ordered.length - 1];
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const [r, c] = pool[i];
        const d = Math.abs(r - lr) + Math.abs(c - lc);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      ordered.push(pool.splice(bestIdx, 1)[0]);
    }
    return ordered;
  }

  function drawClusterLinks(winInfo) {
    if (!clusterLinksSvg || !winInfo) return [];
    const paths = [];
    for (const wi of winInfo) {
      if (!wi.cells || wi.cells.length < 2) continue;
      const tier = tierForWin(wi.amount);
      const tierClass = (tier === "mega") ? "tier-mega"
                       : (tier === "huge") ? "tier-huge"
                       : (tier === "big")  ? "tier-big"  : "";
      const ordered = orderClusterCells(wi.cells);
      const points = ordered.map(([r, c]) => cellCenterInReels(r, c));
      let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
      for (let i = 1; i < points.length; i++) {
        d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `link-path ${tierClass}`);
      path.setAttribute("d", d);
      clusterLinksSvg.appendChild(path);
      paths.push(path);
    }
    return paths;
  }
  function clearClusterLinks(paths) {
    if (!paths) return;
    for (const p of paths) p.remove();
  }

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
    // Phase 1: highlight + draw connection links + show centroid labels.
    // The player can read "what symbol, how many, how much" AND see exactly
    // which cells are connected before they explode.
    for (const [r, c] of cells) {
      cellAt(r, c).classList.add("in-cluster");
    }
    const links = drawClusterLinks(winInfo);
    if (winInfo) for (const wi of winInfo) showClusterWinLabel(wi);
    await ffWait(800);

    // Phase 2: explode — fade out the connection lines as the cells go off.
    clearClusterLinks(links);
    for (const [r, c] of cells) {
      const cell = cellAt(r, c);
      cell.classList.remove("in-cluster");
      cell.classList.add("matched");
      emitSparks(cell, isWild ? 12 : 8);
    }

    // Fly-out to the totem panel — delayed so it doesn't overlap the centroid
    // label that's still on screen.
    if (winInfo) {
      const flyDelay = state.fastForward ? 0 : 250;
      setTimeout(() => {
        for (const wi of winInfo) flyWinToPanel(wi.cells, wi.symIdx, wi.amount);
      }, flyDelay);
      const updateDelay = state.fastForward ? 200 : 850;
      setTimeout(() => {
        for (const wi of winInfo) addRecentWin(wi.symIdx, wi.size, wi.payMult, wi.amount);
      }, updateDelay);
    }

    await ffWait(580);

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

    // Set grid types + matching audio cue
    if (result.wilds.length)    playSfx("wildDig");
    if (result.scatters.length) playSfx("scatter");
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

  // Replay one engine outcome (from /api/.../spin or /api/.../buy-bonus).
  // Drives the same animation pipeline as the local-RNG path but the
  // cells/clusters/dig-up positions all come from the server-signed
  // outcome — no client RNG, fully auditable.
  async function replayBaseSpin(base, effectiveBet, { resetMult = true } = {}) {
    if (resetMult) state.cellMult = makeEmptyGrid(false);
    await animateSpinIn(unboxGrid(base.initialGrid));
    state.grid = unboxGrid(base.initialGrid);

    for (const step of base.cascades) {
      playSfx("spinLand");
      playSfx("clusterPop");
      const clusterCells = [];
      const winInfo = [];
      for (const cl of step.clusters) {
        const payMult = +(cl.win / effectiveBet).toFixed(2);
        winInfo.push({ cells: cl.cells, symIdx: cl.symIdx, size: cl.size, payMult, amount: cl.win });
        clusterCells.push(...cl.cells);
      }
      state.totalSpinWin += step.stepWin;
      state.lastWin = state.totalSpinWin;
      refreshHUD();

      await animateMatched(clusterCells, winInfo);

      // Clear every cluster cell (incl. wilds that participated — the engine
      // removes them too). Sync our local grid to the engine's mid-step state.
      for (const [r, c] of clusterCells) {
        state.grid[r][c] = null;
        const cell = cellAt(r, c);
        cell.classList.remove("wild");
        const sym = cell.querySelector(".symbol");
        if (sym) sym.style.opacity = "0";
      }
      paintAll();

      // ---- DIG-UP REPLAY ----------------------------------------------------
      // Recreate what the engine produced: place each special on its cell,
      // then sequentially show booster/destroyer effects before refilling.
      const d = step.dig || { wilds:[], boosters:[], destroyers:[], scatters:[], destroyerKilled:[] };
      const hasAny = d.wilds.length || d.boosters.length || d.destroyers.length || d.scatters.length;
      if (hasAny) {
        if (d.wilds.length)    playSfx("wildDig");
        if (d.scatters.length) playSfx("scatter");
        for (const [r, c] of d.wilds) {
          state.grid[r][c] = { t: "wild", m: state.cellMult[r][c] >= 2 ? 100 : 10 };
        }
        for (const [r, c] of d.boosters)   state.grid[r][c] = { t: "booster" };
        for (const [r, c] of d.destroyers) state.grid[r][c] = { t: "destroyer" };
        for (const [r, c] of d.scatters)   state.grid[r][c] = { t: "scatter" };
        paintAll();
        for (const arr of [d.wilds, d.boosters, d.destroyers, d.scatters]) {
          for (const [r, c] of arr) digBurst(cellAt(r, c));
        }
        await ffWait(520);

        if (d.boosters.length) {
          for (const [r, c] of d.boosters) {
            emitSparks(cellAt(r, c), 8, "green");
            state.grid[r][c] = null;
          }
          await ffWait(420);
          paintAll();
        }
        if (d.destroyers.length) {
          const killed = d.destroyerKilled || [];
          // Phase A: light up the destroyer cell + show literal "DESTROYER -N"
          // badge + emit a shockwave ring. Holds long enough for the player
          // to read what's about to happen.
          for (const [r, c] of d.destroyers) {
            const cell = cellAt(r, c);
            cell.classList.add("destroyer-active");
            showDestroyerLabel(cell, killed.length);
            emitDestroyerShockwave(cell);
          }
          // Stage shake reinforces the impact across the whole board.
          const wrap = document.getElementById("stage-wrap");
          if (wrap) {
            wrap.classList.remove("shake");
            void wrap.offsetWidth;
            wrap.classList.add("shake");
            setTimeout(() => wrap.classList.remove("shake"), 450);
          }
          await ffWait(550);

          // Phase B: each victim cell shakes + flares + dissolves. Driven
          // by the .destroying CSS keyframes (0.7s). Sparks add grit.
          for (const [r, c] of killed) {
            const cell = cellAt(r, c);
            cell.classList.add("destroying");
            emitSparks(cell, 10, "red");
          }
          await ffWait(700);

          // Phase C: clean up — destroy victims, remove destroyer itself,
          // strip animation classes.
          for (const [r, c] of killed) {
            state.grid[r][c] = null;
            cellAt(r, c).classList.remove("destroying");
          }
          for (const [r, c] of d.destroyers) {
            state.grid[r][c] = null;
            cellAt(r, c).classList.remove("destroyer-active");
          }
          paintAll();
          await ffWait(220);
        }
      }

      // Cascade refill: snap to engine's gridAfter + run dropIn animation.
      state.grid = unboxGrid(step.gridAfter);
      state.cellMult = cloneMultGrid(step.multAfter);
      for (const cell of allCells()) cell.classList.add("dropping");
      paintAll();
      await ffWait(420);
      for (const cell of allCells()) cell.classList.remove("dropping");
    }
  }

  async function replayFreeSpinsRound(fs, effectiveBet) {
    state.inFreeSpins = true;
    state.freeSpinsTotal = fs.totalAward;
    state.freeSpinsLeft = fs.totalAward;
    state.freeSpinsWin = 0;
    stage.classList.add("fs-active");
    if (window.__xibalbaAudio) window.__xibalbaAudio.startBgm("fs");

    // Convert scatters + plant bonus mult cells per the engine's deterministic plan.
    // Engine sends explicit m/value so the visual matches the math (higher buy
    // tiers have higher-m wilds + extra ×N mult cells on random non-scatter cells).
    for (const conv of fs.conversion) {
      if (!state.grid[conv.r]) continue;
      if (conv.to === "wild") {
        state.grid[conv.r][conv.c] = { t: "wild", m: conv.m || 10 };
      } else if (conv.to === "mult") {
        state.grid[conv.r][conv.c] = null;
        state.cellMult[conv.r][conv.c] = conv.value || 10;
      }
    }
    paintAll();
    playSfx("fsTrigger");
    refreshFSBanner(); refreshBonusActive();
    await showFsTriggerModal(fs.totalAward);

    // Open-cascade once on prepared grid (wilds may have lined up).
    for (const step of fs.openCascades) {
      const clusterCells = [];
      const winInfo = [];
      for (const cl of step.clusters) {
        const payMult = +(cl.win / effectiveBet).toFixed(2);
        winInfo.push({ cells: cl.cells, symIdx: cl.symIdx, size: cl.size, payMult, amount: cl.win });
        clusterCells.push(...cl.cells);
      }
      state.freeSpinsWin += step.stepWin;
      refreshFSBanner(); refreshBonusActive();
      await animateMatched(clusterCells, winInfo);
      for (const [r, c] of clusterCells) {
        state.grid[r][c] = null;
        cellAt(r, c).classList.remove("wild");
      }
      paintAll();
      // Open-cascade dig-up replay (boosters / destroyers visible).
      const d = step.dig || { wilds:[], boosters:[], destroyers:[], scatters:[], destroyerKilled:[] };
      if (d.wilds.length || d.boosters.length || d.destroyers.length || d.scatters.length) {
        for (const [r, c] of d.wilds)      state.grid[r][c] = { t: "wild", m: state.cellMult[r][c] >= 2 ? 100 : 10 };
        for (const [r, c] of d.boosters)   state.grid[r][c] = { t: "booster" };
        for (const [r, c] of d.destroyers) state.grid[r][c] = { t: "destroyer" };
        for (const [r, c] of d.scatters)   state.grid[r][c] = { t: "scatter" };
        paintAll();
        for (const arr of [d.wilds, d.boosters, d.destroyers, d.scatters]) {
          for (const [r, c] of arr) digBurst(cellAt(r, c));
        }
        await ffWait(520);
        if (d.destroyers.length) {
          for (const [r, c] of (d.destroyerKilled || [])) emitSparks(cellAt(r, c), 5, "red");
          await ffWait(420);
        }
      }
      state.grid = unboxGrid(step.gridAfter);
      state.cellMult = cloneMultGrid(step.multAfter);
      for (const cell of allCells()) cell.classList.add("dropping");
      paintAll();
      await ffWait(420);
      for (const cell of allCells()) cell.classList.remove("dropping");
    }

    // Run each FS spin.
    for (const spin of fs.fsSpins) {
      await ffWait(900);
      await replayBaseSpin({ initialGrid: spin.initialGrid, cascades: spin.cascades }, effectiveBet, { resetMult: false });
      state.freeSpinsWin += spin.totalWin;
      state.freeSpinsLeft--;
      refreshFSBanner(); refreshBonusActive();
      if (spin.retrigger) {
        state.freeSpinsTotal += spin.retrigger;
        state.freeSpinsLeft += spin.retrigger;
        winBannerText.textContent = `+${spin.retrigger} FREE SPINS`;
        winBanner.classList.add("visible");
        await ffWait(1400);
        winBanner.classList.remove("visible");
      }
    }
    await endFreeSpins();
  }

  async function spinViaServer({ wildSpinActive }) {
    state.spinning = true;
    btnSpin.disabled = true;
    btnSpin.classList.add("spinning");
    state.lastWin = 0;
    state.totalSpinWin = 0;
    hideSpinWinPopup();
    refreshHUD();
    try {
      const r = await api(`/session/${SESSION.id}/spin`, {
        method: "POST",
        body: { action: wildSpinActive ? "wild_spin" : "spin" },
      });
      SESSION.nonce = r.nonce + 1;
      playSfx("spin");
      await replayBaseSpin(r.outcome.base, r.outcome.bet);
      if (r.outcome.fs) await replayFreeSpinsRound(r.outcome.fs, r.outcome.bet);
      state.balance = r.balance;
      refreshHUD();
      if (r.outcome.totalWin > 0) {
        showSpinWinPopup(r.outcome.totalWin);
        await maybeShowBigWin(r.outcome.totalWin, r.outcome.bet);
      }
      if (wildSpinActive) {
        state.wildSpinArmed = false;
        btnWildSpin.setAttribute("aria-pressed", "false");
      }
    } catch (err) {
      console.error("spinViaServer error:", err);
      if (err.body && err.body.error === "INSUFFICIENT_BALANCE") flashHUD(hudBalance);
    } finally {
      state.spinning = false;
      btnSpin.disabled = false;
      btnSpin.classList.remove("spinning");
    }

    // Autoplay continuation in server mode
    if (state.autoplayLeft > 0) {
      state.autoplayLeft--;
      if (state.autoplayLeft > 0 && state.balance >= state.bet) {
        await ffWait(450);
        spin();
      } else {
        state.autoplayLeft = 0;
        btnAutoplay.classList.remove("active");
      }
    }
  }

  async function buyBonusViaServer(opt) {
    closeModal(bbConfirmModal);
    closeModal(buyBonusModal);
    try {
      await api(`/session/${SESSION.id}/buy-bonus-idx`, {
        method: "POST", body: { idx: opt.idx },
      });
      state.spinning = true;
      btnSpin.disabled = true;
      btnSpin.classList.add("spinning");
      state.lastWin = 0; state.totalSpinWin = 0;
      hideSpinWinPopup(); refreshHUD();
      const r = await api(`/session/${SESSION.id}/buy-bonus`, { method: "POST", body: {} });
      SESSION.nonce = r.nonce + 1;
      // Buy bonus paints a grid with the chosen scatter cells, then opens FS.
      state.grid = makeEmptyGrid(true);
      for (const [r2, c2] of r.outcome.scatterCellsAtTrigger) {
        state.grid[r2][c2] = { t: "scatter" };
      }
      paintAll();
      await replayFreeSpinsRound(r.outcome.fs, r.outcome.bet);
      state.balance = r.balance;
      refreshHUD();
      if (r.outcome.totalWin > 0) {
        showSpinWinPopup(r.outcome.totalWin);
        await maybeShowBigWin(r.outcome.totalWin, r.outcome.bet);
      }
    } catch (err) {
      console.error("buyBonusViaServer error:", err);
      if (err.body && err.body.error === "INSUFFICIENT_BALANCE") flashHUD(hudBalance);
    } finally {
      state.spinning = false;
      btnSpin.disabled = false;
      btnSpin.classList.remove("spinning");
    }
  }

  async function spin({ skipBet = false } = {}) {
    if (state.spinning) return;
    if (SERVER_MODE && SESSION && !state.inFreeSpins) {
      // In server mode the entire FS round is bundled into the spin response,
      // so we never have a standalone "FS continue" call from here.
      const wildSpinActive = state.wildSpinArmed && !state.inFreeSpins;
      return spinViaServer({ wildSpinActive });
    }
    return spinLocal({ skipBet });
  }

  async function spinLocal({ skipBet = false } = {}) {
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
    hideSpinWinPopup();   // clear previous spin's popup before next reel-in
    // Recent wins persist across spins — new wins prepend; old wins age out
    // naturally via the 8-row cap.
    refreshHUD();

    // Hoisted so the FS-trigger branch (below the try) can read the value
    // set inside the cascade loop without a scope error.
    let scatterCount = 0;

    // Safety net: if anything below throws, the unhandled error used to
    // leave state.spinning=true forever — button visually spun but every
    // subsequent click bounced off the early-return guard. The try/finally
    // guarantees release.
    try {

    // Reset multipliers per spin (unless in FS)
    if (!state.inFreeSpins) {
      state.cellMult = makeEmptyGrid(false);
    }
    // Wild Spin mode AND every FS spin guarantee at least 1 wild dig-up.
    // The FS guarantee is the engine of the "premium FS feel" — combined
    // with cellMult persistence across FS spins it lifts FS share of RTP
    // from ~9% to ~18% (see sim.js verification).
    if (isWildSpin || state.inFreeSpins) state.guaranteedWilds = 1;

    playSfx("spin");
    await animateSpinIn(randomGrid());

    // Cascade loop
    let cascades = 0;
    while (true) {
      const clusters = findClusters(state.grid);
      if (!clusters.length) break;
      // Premium "drank" — heavy impact + cavern echo when a cluster locks
      // in. Lives here (not on every spin landing) so the player only
      // hears it as a REWARD signal: "your spin paid off."
      playSfx("spinLand");
      playSfx("clusterPop");

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
    scatterCount = 0;
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
      showSpinWinPopup(state.totalSpinWin);
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

    } catch (err) {
      // Anything in the cascade chain blew up — surface the error but
      // still release the spin lock (handled by the finally below).
      console.error("spin error:", err);
    } finally {
      // Re-assert the unlock so we never leave the button stuck spinning.
      state.spinning = false;
      btnSpin.disabled = false;
      btnSpin.classList.remove("spinning");
    }

    // FS trigger / continue. Outside the try because these RECURSIVELY call
    // spin() and the recursion must not be inside the parent's try (it
    // would await its own descendants and we don't want the finally to
    // fire while a nested chain is still running).
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
    const award = freeSpinsForScatters(scatterCount, state.inFreeSpins);
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
      // Swap to the FS-themed slot frame (red ember + cyan magical glow)
      stage.classList.add("fs-active");
      playSfx("fsTrigger");
      if (window.__xibalbaAudio) window.__xibalbaAudio.startBgm("fs");
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
    const totalWin = state.freeSpinsWin;
    state.balance += totalWin;
    refreshHUD();
    playSfx("fsEnd");
    if (window.__xibalbaAudio) window.__xibalbaAudio.startBgm("base");
    // Grand celebration overlay — count-up + tiered title + confetti.
    await showFsEndCelebration(totalWin, state.bet);
    state.inFreeSpins = false;
    state.freeSpinsLeft = 0;
    state.freeSpinsTotal = 0;
    state.freeSpinsWin = 0;
    stage.classList.remove("fs-active");
    refreshFSBanner(); refreshBonusActive();
    state.cellMult = makeEmptyGrid(false);
    paintAll();
  }

  // Big celebration screen at the end of a Free Spins round.
  //   - Tier classes (win / big / huge / epic / legendary) drive title size,
  //     palette, and animation intensity.
  //   - Number counts up from 0 to total over ~2.5s with easeOutCubic.
  //   - Confetti density scales with tier.
  //   - Stays until the user clicks/taps anywhere on the overlay (with a
  //     ~1s grace so a misplaced click doesn't skip it).
  function tierForFsEnd(winX) {
    if (winX >= 1000) return "legendary";
    if (winX >= 200)  return "epic";
    if (winX >= 50)   return "huge";
    if (winX >= 10)   return "big";
    return "win";
  }
  function titleForTier(tier) {
    return {
      win:       "FREE SPINS COMPLETE",
      big:       "BIG BONUS WIN!",
      huge:      "HUGE BONUS WIN!",
      epic:      "EPIC BONUS WIN!",
      legendary: "LEGENDARY WIN!!!",
    }[tier];
  }
  function spawnFsEndConfetti(panel, density) {
    const rect = panel.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const colors = ["#ffd966", "#ff9b30", "#ff5e2c", "#d6286b", "#5e2eb2", "#2eb2d6"];
    for (let i = 0; i < density; i++) {
      const c = document.createElement("div");
      c.className = "fs-end-confetti";
      c.style.left = (Math.random() * w) + "px";
      c.style.top  = (-20 - Math.random() * 80) + "px";
      c.style.background = colors[Math.floor(Math.random() * colors.length)];
      panel.appendChild(c);
      const driftX = (Math.random() - 0.5) * 240;
      const fallY  = h + 60 + Math.random() * 120;
      const rot    = (Math.random() - 0.5) * 1080;
      const dur    = 1800 + Math.random() * 1600;
      c.animate(
        [
          { transform: `translate(0, 0) rotate(0deg)`, opacity: 1 },
          { transform: `translate(${driftX}px, ${fallY}px) rotate(${rot}deg)`, opacity: 0 },
        ],
        { duration: dur, easing: "cubic-bezier(0.35, 0.05, 0.55, 0.95)", fill: "forwards", delay: Math.random() * 400 }
      );
      setTimeout(() => c.remove(), dur + 500);
    }
  }
  function showFsEndCelebration(totalWin, bet) {
    return new Promise((resolve) => {
      const modal = document.getElementById("fsEndModal");
      const panel = modal.querySelector(".fs-end-panel");
      const titleEl = document.getElementById("fsEndTitle");
      const amountEl = document.getElementById("fsEndAmount");
      const multEl   = document.getElementById("fsEndMult");

      const winX = bet > 0 ? totalWin / bet : 0;
      const tier = tierForFsEnd(winX);
      panel.classList.remove("tier-win", "tier-big", "tier-huge", "tier-epic", "tier-legendary");
      panel.classList.add(`tier-${tier}`);
      titleEl.textContent = titleForTier(tier);
      multEl.textContent  = `×${winX.toFixed(2)} BET`;
      amountEl.textContent = "0.00";

      modal.classList.add("visible");
      modal.setAttribute("aria-hidden", "false");

      // Confetti density scales with the tier
      const density = { win: 24, big: 48, huge: 80, epic: 140, legendary: 220 }[tier];
      spawnFsEndConfetti(panel, density);

      // Count-up: easeOutCubic over 2.5s. Tier-legendary takes a beat longer.
      const dur = tier === "legendary" ? 3200 : 2400;
      const t0 = performance.now();
      function tick(now) {
        const t = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        amountEl.textContent = (totalWin * eased).toFixed(2);
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

      // Grace period before accepting input so a stray click doesn't skip
      const armedAt = performance.now();
      const GRACE = 900;
      const onDismiss = () => {
        if (performance.now() - armedAt < GRACE) return;
        modal.classList.remove("visible");
        modal.setAttribute("aria-hidden", "true");
        modal.removeEventListener("click", onDismiss);
        document.removeEventListener("keydown", onKey);
        amountEl.textContent = totalWin.toFixed(2);  // ensure final number is exact
        resolve();
      };
      const onKey = (e) => {
        if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
        e.preventDefault();
        onDismiss();
      };
      modal.addEventListener("click", onDismiss);
      document.addEventListener("keydown", onKey);

      // Auto-dismiss after a long wait (longer than the count-up) so it
      // never strands the player if they walk away.
      setTimeout(() => onDismiss(), dur + 5000);
    });
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
    if (state.spinning) return;
    if (SERVER_MODE && SESSION) return buyBonusViaServer(opt);
    closeModal(bbConfirmModal);
    closeModal(buyBonusModal);
    const cost = opt.cost * state.bet;
    if (state.balance < cost) { flashHUD(hudBalance); return; }
    state.balance -= cost;
    refreshHUD();
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
    playSfx("click");
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

  // Sound toggle (sound-on.png / sound-off.png swap via aria-pressed)
  const btnSound = document.getElementById("btnSound");
  if (btnSound) {
    btnSound.addEventListener("click", () => {
      const muted = btnSound.getAttribute("aria-pressed") === "true";
      btnSound.setAttribute("aria-pressed", muted ? "false" : "true");
      if (window.__xibalbaAudio) window.__xibalbaAudio.setMuted(muted);
    });
  }

  // Menu button → opens the Info / Paytable modal.
  const btnMenu     = document.getElementById("btnMenu");
  const infoModal   = document.getElementById("infoModal");
  const infoClose   = document.getElementById("infoClose");
  const infoPaytableBody = document.getElementById("infoPaytableBody");

  function renderInfoPaytable() {
    if (!infoPaytableBody) return;
    // Headers row: cluster sizes 5..12+
    const sizeLabels = ["5", "6", "7", "8", "9", "10", "11", "12+"];
    const symLabels  = ["Jaguar", "Feather", "Mask", "Sym 04", "Sym 05", "Sym 06", "Sym 07", "Sym 08", "Sym 09"];
    const tierClass  = ["top", "high", "high", "mid", "mid", "mid", "low", "low", "low"];

    let html = `<div class="info-pt-head sym">Symbol</div>`;
    for (const s of sizeLabels) html += `<div class="info-pt-head">${s}</div>`;
    for (let i = 0; i < PAY_TABLE.length; i++) {
      html += `<div class="info-pt-row ${tierClass[i]}">
                 <div class="info-pt-sym" title="${symLabels[i]}"
                      style="background-image:url('assets/${REG_ASSETS[i]}.png')"></div>
               </div>`;
      for (const v of PAY_TABLE[i]) {
        html += `<div class="info-pt-cell ${tierClass[i]}">${v.toFixed(2)}×</div>`;
      }
    }
    infoPaytableBody.innerHTML = html;
  }
  renderInfoPaytable();

  if (btnMenu && infoModal) {
    btnMenu.addEventListener("click", () => { playSfx("click"); openModal(infoModal); });
  }
  if (infoClose) infoClose.addEventListener("click", () => { playSfx("click"); closeModal(infoModal); });
  if (infoModal) infoModal.addEventListener("click", (e) => {
    if (e.target === infoModal) closeModal(infoModal);
  });
  document.querySelectorAll(".info-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      document.querySelectorAll(".info-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".info-panel").forEach((p) => {
        p.hidden = p.dataset.panel !== target;
      });
      playSfx("click");
    });
  });

  btnBuyBonus.addEventListener("click", () => {
    playSfx("click");
    void 0; // tag below as the original handler
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
    playSfx("buyBonus");
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
    playSfx("click");
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

  function syncBetToServer() {
    if (!SERVER_MODE || !SESSION) return;
    api(`/session/${SESSION.id}/bet`, { method: "POST", body: { betIdx: state.betIdx } }).catch(() => {});
  }
  betUp.addEventListener("click", () => {
    state.betIdx = Math.min(BET_LEVELS.length - 1, state.betIdx + 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
    syncBetToServer();
  });
  betDown.addEventListener("click", () => {
    state.betIdx = Math.max(0, state.betIdx - 1);
    state.bet = BET_LEVELS[state.betIdx];
    refreshHUD();
    syncBetToServer();
  });

  document.addEventListener("keydown", (e) => {
    // Don't hijack keys while the loading intro is still up — Space there
    // should enter the game, not also-spin the reels behind it.
    const intro = document.getElementById("loadingIntro");
    if (intro && !intro.classList.contains("hidden")) return;
    // FS trigger modal owns Space/Enter to dismiss itself. Skip the
    // spin/autoplay shortcuts so a single keypress closes the modal
    // first instead of also kicking off a spin behind it.
    if (fsTriggerModal && fsTriggerModal.classList.contains("visible")) return;
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

  // Kick off provably-fair session in the background. When it returns we
  // adopt the server's balance/bet/nonce so subsequent spins are auditable.
  ensureSession().then(() => {
    if (SERVER_MODE && SESSION) {
      state.balance = SESSION.balance;
      state.bet = SESSION.bet;
      state.betIdx = SESSION.betIdx;
      refreshHUD();
    }
  });

  // Three-step entry flow:
  //   1) Aigo brand splash (~1.8s) — fades out
  //   2) Loading screen: critical assets preload; bar fills; PLAY button shows
  //   3) User clicks PLAY → game appears
  // Entry flow (Banana-Hustlers style):
  //   1) Aigo splash holds the screen while critical PNGs preload. Loading
  //      bar lives inside the LEFT (aigo) panel of the split-screen.
  //   2) When preload finishes, aigoSplash fades out and the PLAY screen
  //      (video bg + PLAY button) fades in.
  //   3) Click/Space PLAY → enter slot.
  (function runEntryFlow() {
    // No-op timer — kept for backwards compat so old hidden classes don't
    // strand the splash. Actual hide is driven by preload completion.
  })();

  (function runLoadingIntro() {
    const overlay = document.getElementById("loadingIntro");
    if (!overlay) return;
    const fill = document.getElementById("loadingBarFill");
    const pct  = document.getElementById("loadingPct");

    // CRITICAL = first-paint of the slot scene. Small list, bar fills
    // fast, splash doesn't hold the user up. Big PNGs (modal frames, FS
    // art) are pushed to DEFERRED — they keep loading in the background
    // while the user reads the PLAY screen.
    const CRITICAL = [
      "bg.png", "logo.png", "left-asset.png", "bottom.png", "slot-frame.png",
      "fire-left.png", "fire-right.png",
      "aigo-star.png", "aigo-logo.svg",
      "buy-bonus-button.png", "wildspin-button-off.png", "wildspin-button-on.png",
      "spin-button.png", "button-autoplay.png", "button-fastfwd.png",
      "button-play.png", "plus.png", "minus.png",
      "menu.png", "sound-on.png", "sound-off.png",
      "symbol-jaguar.png", "symbol-feather.png", "symbol-mask-red.png",
      "symbol04.png", "symbol05.png", "symbol06.png",
      "symbol07.png", "symbol08.png", "symbol09.png",
    ];

    // DEFERRED kicks off in parallel WHILE the user is on the PLAY
    // screen, finishing before they click PLAY (~2-5s of "look at the
    // pretty bg and find the button"). Includes all the big modal/FS
    // panels that would otherwise stall the initial load.
    const DEFERRED = [
      "slot-frame-special-round-fixed.png",
      "symbol01.png", "symbol02.png",
      "scatter-medallion.png", "wild-pyramid.png",
      "mult-pyramid-low.png", "mult-pyramid-mid.png", "mult-pyramid-high.png",
      "booster-symbol.png", "destroyer-symbol.png",
      "modal-panel-bg.png", "card-buy-option-bg.png", "confirm-jar.png",
      "title-wild-spin.png", "title-buy-free-spins.png",
      "title-free-spins.png", "title-bonus-game.png",
      "btn-activate.png", "btn-buy.png", "btn-buy-disabled.png",
      "btn-ok.png", "btn-back.png", "btn-close-x.png",
      "arrow-left.png", "arrow-right.png",
      "pyramid-stack.png",
      "fs-portal-bg.png",
      "special-asset1.png", "right-special-asset-2.png",
    ];

    // FS trigger modal art — needs to be ready the first time FS lands,
    // not still streaming when the modal opens. Kicked off immediately at
    // module init so the browser cache always has it by trigger time.
    new Image().src = "assets/fs-banner-bg-new.png";

    // Splash + bar visible at least 1.2s even on cache-hit so the brand
    // moment lands. Quick on actual cold loads too with the trimmed list.
    const MIN_MS = 1200;
    const startedAt = performance.now();
    let loaded = 0;
    const total = CRITICAL.length;

    function updateBar() {
      const p = Math.round((loaded / total) * 100);
      if (fill) fill.style.width = p + "%";
      if (pct)  pct.textContent  = p + "%";
    }

    function loadOne(src) {
      return new Promise((resolve) => {
        const img = new Image();
        const done = () => { resolve(); };
        img.onload = done;
        img.onerror = done;
        img.src = "assets/" + src;
      });
    }

    function preload(src) {
      return loadOne(src).then(() => { loaded++; updateBar(); });
    }

    Promise.all(CRITICAL.map(preload)).then(() => {
      const elapsed = performance.now() - startedAt;
      const wait = Math.max(0, MIN_MS - elapsed);
      setTimeout(() => {
        // Critical done: hide aigo splash, reveal PLAY screen. Start
        // background prefetch of the rest so modal/FS art is cached by
        // the time the user actually clicks PLAY.
        const splash = document.getElementById("aigoSplash");
        if (splash) splash.classList.add("hidden");
        overlay.classList.add("ready");
        DEFERRED.forEach(loadOne);
      }, wait);
    });

    const playBtn = document.getElementById("loadingPlay");
    if (playBtn) {
      const enter = () => {
        overlay.classList.add("hidden");
        // First user gesture — unlock + kick off the background music.
        if (window.__xibalbaAudio) {
          // Pre-warm every SFX so the first cluster-pop / win / scatter
          // is audible (some browsers refuse to decode until play() is
          // invoked from a user gesture context). Each is muted+played+
          // immediately paused/reset → decode pipeline runs, no audible
          // pop, ready for instant playback when the real event fires.
          window.__xibalbaAudio.prewarm();
          window.__xibalbaAudio.playSfx("click");
          window.__xibalbaAudio.startBgm("base");
        }
      };
      playBtn.addEventListener("click", enter);
      // Space / Enter while the loading screen is up also triggers entry —
      // keyboard users (and impatient testers) don't have to find the button.
      const onKey = (e) => {
        // PLAY screen is available once the aigo splash has hidden
        const aigoStillUp = document.getElementById("aigoSplash") &&
                            !document.getElementById("aigoSplash").classList.contains("hidden");
        if (aigoStillUp || overlay.classList.contains("hidden")) return;
        if (e.code === "Space" || e.code === "Enter") {
          e.preventDefault();
          enter();
          document.removeEventListener("keydown", onKey);
        }
      };
      document.addEventListener("keydown", onKey);
    }

    updateBar();
  })();
})();
