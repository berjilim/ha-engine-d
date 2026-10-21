'use strict';
// ============================================================================
// ENGINE D — Unified Decision Engine (paper). Implements SPEC_v2.md §1–§10
// plus Bernard 2026-09-25 Engine D spec (provenance: paper_C.js + two patches).
//
// ONE brain, three first-class legs sharing ONE durable ledger:
//   1. FAST SHORT   (1h)  — 120-bar-low break + 2x vol + below 200-EMA,
//                          0.5xATR chandelier trail, no hard stop, 48-bar cap.
//   2. MEDIUM LONG  (4h trend / 1h momentum) — Engine B's proven recipe,
//                          byte-faithful (scoreCoin, STOP/TP/TRAIL, 1h ATR,
//                          risk-budget sizing, longregime tighten, cooldown).
//   3. SLOW LONG    (1d)  — Donchian 20-high entry, exit on 20-low or 200-SMA.
//
// DUAL-TRACK FILL LOGGING (§6): every trade records three tracks.
//   * fantasy          — signal bar close entry, exact trigger-level exit.
//   * realistic_open   — B+1 open entry/exit + slippage  (THE stored ledger).
//   * realistic_close  — B+1 open entry, B+1 close exit + slippage.
// Fill-price convention (SPEC §6.1 table, literal): fantasy fills are RAW
// (signal close / trigger level, no slippage); realistic fills are SLIPPED
// (B+1 open/close adversarially moved). Maker/taker fees apply to ALL tracks;
// slippage applies only to the realistic (executable) fills. The headline
// equity is realistic_open; fantasy/realistic_close are DERIVED report-only
// PnL (never touch ledger cash → no double-count). pnlRealOpen is identity-
// checked against the ledger's own cash delta (§6.3).
//
// PAPER engine: no real orders, no real funds. ccxt live-loop bits are marked
// TODO(live); the decision logic is complete and runnable against cached data
// (--replay-daily / --replay).
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { PaperLedger, MAKER, TAKER } = require('./papercore');
const { scoreCoin, direction } = require('./src/strategy');
const { UNIVERSE, spotSymbol } = require('./src/market');
const lib = require('./src/engineC_lib');

// ---------------------------------------------------------------------------
// Config — process.env, namespaced C_*. Defaults are EXACTLY SPEC_v2 §10.
// maker/taker fees are FIXED at 2/5 bps by the frozen papercore ledger (the
// mandated cost model); slippage + funding are the tunable knobs applied here.
// ---------------------------------------------------------------------------
const env = (k, d) => { const v = process.env[k]; return (v === undefined || v === '') ? d : Number(v); };

const START       = env('C_START', 1140);              // paper start USDT (sits on the 570->1140 live basis)
const STATE       = process.env.C_STATE || 'pfD_state.json';
const REPLAY_DATA_DIR = path.join(__dirname, 'replay');
const LEV         = env('C_LEV', 1);

// regime (byte-faithful to Engine B regimeInfo §2.1)
const BREADTH_PERIOD  = env('C_BREADTH_PERIOD', 20);
const REGIME_WARMUP   = env('C_REGIME_WARMUP_BARS', 60);
const BREADTH_BULL    = env('C_BREADTH_BULL', 0.5);
const BREADTH_BEAR    = env('C_BREADTH_BEAR', 0.5);
// medium-long entry gate (review MAJOR M1): Engine B LIVE gates longs by
// breadth > B_LONG_BREADTH_MIN (0.60) with REGIME_ON off — NO BTC 20>50 SMA
// trend conjunctive. Engine D's medium-long uses that same breadth-only gate.
const LONG_BREADTH_MIN = env('C_LONG_BREADTH_MIN', 0.60);
const LONG_GUARD_BREADTH = env('C_LONG_GUARD_BREADTH', 0.70); // stricter Engine-D medium-long breadth guard
const C_ML_BULL_MAX_POS = env('C_ML_BULL_MAX_POS', 2);        // BULL-regime long cap (2 = shipped; 6 = no cap)

// costs (slippage + funding applied here; maker/taker frozen in papercore)
const SLIPPAGE_BPS    = env('C_SLIPPAGE_BPS', 5);      // 5bps adversarial, applied to the fill price exactly once
const FUNDING_8H_BPS  = env('C_FUNDING_8H_BPS', 1);    // 1bp/8h, shorts only
const GROSS_BOOK_CAP  = env('C_GROSS_BOOK_CAP', 1.0);
const SLIP = SLIPPAGE_BPS / 1e4;
const FUND_RATE = FUNDING_8H_BPS / 1e4;

// sizing / risk (book-sharing reservations §4.3)
const K                      = env('C_K', 6);                  // intraday slots (medium-long + fast-short)
const FASTSHORT_MAX_POS      = env('C_FASTSHORT_MAX_POS', 3);
const SLOWLONG_MAX_POS       = env('C_SLOWLONG_MAX_POS', 8);
const SLOWLONG_BOOK_FRAC     = env('C_SLOWLONG_BOOK_FRAC', 0.25);
const INTRADAY_BOOK_CAP      = env('C_INTRADAY_BOOK_CAP', 0.75);
const MEDIUMLONG_MAX_NOTIONAL_FRAC = env('C_MEDIUMLONG_MAX_NOTIONAL_FRAC', 0.125);
const RISK_BUDGET            = env('C_RISK_BUDGET', 0.015);
const CASH_CAP_FRAC          = env('C_CASH_CAP_FRAC', 0.8);
const FASTSHORT_NOTIONAL_FRAC = env('C_FASTSHORT_NOTIONAL_FRAC', 0.02);

// medium-long (Engine B proven recipe §3.2)
const LONG_TH            = env('C_LONG_TH', 50);
const LONG_STOP_ATR      = env('C_LONG_STOP_ATR', 4.0);
const TP_LONG_K_WEAK     = env('C_TP_LONG_K_WEAK', 1.0);
const TP_LONG_K_MEDIUM   = env('C_TP_LONG_K_MEDIUM', 2.0);
const TP_LONG_K_STRONG   = env('C_TP_LONG_K_STRONG', 3.0);
const TP_LONG_MEDIUM_LOW = env('C_TP_LONG_MEDIUM_LOW', 70);
const TP_LONG_STRONG_LOW = env('C_TP_LONG_STRONG_LOW', 80);
const TRAIL_ARM_ATR      = env('C_TRAIL_ARM_ATR', 2.0);
const TRAIL_ATR          = env('C_TRAIL_ATR', 1.0);
const LONGREGIME_BREADTH = env('C_LONGREGIME_BREADTH', 0.45);
const LONGREGIME_TIGHTEN_ATR = env('C_LONGREGIME_TIGHTEN_ATR', 2.5);
const TP_FEES            = env('C_TP_FEES', 0);
const STOP_FALLBACK      = env('C_STOP_FALLBACK', 0.06);       // absolute-stop fallback when 1h ATR is null (== Engine B STOP)
// medium-long adaptive cooldown (Engine B §7.5; referenced but not in §10's list)
const COOLDOWN_ATR_BARS  = env('C_COOLDOWN_ATR_BARS', 6);      // 6 x 4h = 24h max lock
const RETRACE_ATR        = env('C_RETRACE_ATR', 1.0);          // 1x ATR move unlocks early

// fast-short (§3.1)
const FASTSHORT_LOW_BARS     = env('C_FASTSHORT_LOW_BARS', 120);
const FASTSHORT_VOL_MULT     = env('C_FASTSHORT_VOL_MULT', 2.0);
const FASTSHORT_EMA          = env('C_FASTSHORT_EMA', 200);
const FASTSHORT_TRAIL_ATR    = env('C_FASTSHORT_TRAIL_ATR', 0.5);
const FASTSHORT_MAXHOLD_BARS = env('C_FASTSHORT_MAXHOLD_BARS', 48);
const FASTSHORT_COOLDOWN_H   = env('C_FASTSHORT_COOLDOWN_H', 24);
const FASTSHORT_BEAR_ONLY    = env('C_FASTSHORT_BEAR_ONLY', 1); // 1 = BEAR regime only; 0 = any regime

// fast-short mode: 0 = current trail (byte-identical), 1 = sell-the-rip (TP/stop/maxhold)
const FASTSHORT_MODE         = env('C_FASTSHORT_MODE', 1);      // 1 = sell-the-rip (shipped), 0 = legacy trail
const FS_TP_ATR              = env('C_FS_TP_ATR', 0.5);         // TP level in ATR multiples
const FS_STOP_ATR            = env('C_FS_STOP_ATR', 4.0);       // stop level in ATR multiples
const FS_MAXHOLD             = env('C_FS_MAXHOLD', 4);          // max hold in bars (4h bars)
const FS_CD_HOURS            = env('C_FS_CD_HOURS', 6);        // cooldown hours per coin (shipped 6h)
const FS_RISK_BUDGET         = env('C_FS_RISK_BUDGET', 0.015); // risk budget fraction
const FS_NOTIONAL_CAP        = env('C_FS_NOTIONAL_CAP', 0.125); // notional cap fraction

// slow-long (§3.3)
const SLOWLONG_DONCHIAN_N  = env('C_SLOWLONG_DONCHIAN_N', 20);
const SLOWLONG_EXIT_LOW_M  = env('C_SLOWLONG_EXIT_LOW_M', 20);
const SLOWLONG_EXIT_SMA    = env('C_SLOWLONG_EXIT_SMA', 200);
const SLOWLONG_BREADTH_MIN = env('C_SLOWLONG_BREADTH_MIN', 0.0);
// slow-long disabled by default (review BLOCKER B1): it fails its own §3.3 3y
// acceptance test (pnlRealOpen −20.38, median hold 1 day) — the whole research
// edge is a fill artifact. Set C_SLOWLONG_ENABLED=1 to re-enable the leg.
const SLOWLONG_ENABLED = env('C_SLOWLONG_ENABLED', 0);
// per-leg enable flags (entry-only gating, mirroring SLOWLONG_ENABLED; exits always
// run so a disabled leg drains naturally). Default 1 = current behaviour.
const MEDIUMLONG_ENABLED = env('C_MEDIUMLONG_ENABLED', 1);
const FASTSHORT_ENABLED  = env('C_FASTSHORT_ENABLED', 1);

// timing / gates (§7)
const POLL          = env('C_POLL', 60);                 // seconds
const MAX_STALE_MIN = env('C_MAX_STALE_MIN', 6);
const POLL_GAP_MIN  = env('C_POLL_GAP_MIN', 5);

const H1_MS      = 3600e3;
const DAY_MS     = 86400e3;
const FUND_8H_MS = 8 * 3600e3;
const BAR_MS     = 4 * 3600e3; // medium-long cooldown cadence (Engine B)
const ATOM_MS    = 300e3;      // 5m atom — full-window replay probe grid (geom_common parity)
const LEDGER_K   = K + SLOWLONG_MAX_POS; // 14 — backstop ceiling; real logic is the 6/8 split

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Pure cost/fill helpers
// ---------------------------------------------------------------------------
// Score -> TP multiplier (higher band wins), byte-faithful to Engine B longTpK.
function longTpK(score) {
  if (score >= TP_LONG_STRONG_LOW) return TP_LONG_K_STRONG;
  if (score >= TP_LONG_MEDIUM_LOW) return TP_LONG_K_MEDIUM;
  return TP_LONG_K_WEAK;
}

// Adversarial slippage on the fill PRICE only (geometry px stays clean). Slippage
// is applied exactly once here, and the ledger applies only its maker/taker fee —
// so there is no double-count (SPEC §5.1 MINOR-10).
function applySlip(px, dir, side) {
  if (SLIPPAGE_BPS <= 0) return px;
  if (side === 'ENTRY') return dir === 'LONG' ? px * (1 + SLIP) : px * (1 - SLIP);
  return dir === 'LONG' ? px * (1 - SLIP) : px * (1 + SLIP);
}

// Realized PnL for a round trip under the SAME fee shape papercore uses:
//   LONG : amt*exit*(1-taker) - amt*entry*(1+maker)
//   SHORT: amt*entry*(1-maker) - amt*exit*(1+taker)
// The fill prices passed in already carry slippage (for realistic tracks) or are
// raw (for the fantasy track). Used for pnlFantasy / pnlRealClose and to
// identity-check pnlRealOpen.
function tradePnl(dir, amt, entryFill, exitFill) {
  if (dir === 'LONG') return amt * exitFill * (1 - TAKER) - amt * entryFill * (1 + MAKER);
  return amt * entryFill * (1 - MAKER) - amt * exitFill * (1 + TAKER);
}

// ---------------------------------------------------------------------------
// Engine D
// ---------------------------------------------------------------------------
class EngineD {
  constructor(opts = {}) {
    this.clock = opts.clock || (() => Date.now());
    this.replay = !!opts.replay;                 // replay bypasses the freshness gate
    this.forceRegime = opts.forceRegime || null; // synthetic regime (slow-long 3y acceptance test)
    this.ledger = new PaperLedger({
      file: opts.state || STATE,
      startUsdt: opts.startUsdt || START,
      k: LEDGER_K,
      lev: LEV,
      closeFee: TAKER,      // realistic path: exits always take the taker side
      clock: this.clock,
    });
    if (!this.ledger.data.fastShortCooldown) this.ledger.data.fastShortCooldown = {};
    if (!this.ledger.data.mediumLongCooldown) this.ledger.data.mediumLongCooldown = {};
    if (this.ledger.data.lastFundIdx == null) this.ledger.data.lastFundIdx = null;
    if (!this.ledger.data.stats) this.ledger.data.stats = this._emptyStats();
    this.stats = this.ledger.data.stats;
    this.hist1h = {}; this.hist4h = {}; this.hist1d = {};
    this.form1h = {}; this.form4h = {}; this.form1d = {};   // raw forming bars (live fill source)
    this.freshAt = {};
  }

  _emptyStats() {
    const leg = () => ({ n: 0, wins: 0, pnlFantasy: 0, pnlRealOpen: 0, pnlRealClose: 0, fillQualityDelta: 0 });
    return {
      fastShort: leg(), mediumLong: leg(), slowLong: leg(),
      fees: 0, slippage: 0, funding: 0,
      coverGap: { '0-100': 0, '100-300': 0, '300-1000': 0, '1000+': 0 },
    };
  }
  _bucket(bps) {
    if (bps < 100) return '0-100';
    if (bps < 300) return '100-300';
    if (bps < 1000) return '300-1000';
    return '1000+';
  }

  isFresh(base) {
    if (this.replay) return true; // historical cached data is "fresh" by construction
    return !!this.freshAt[base] && (Date.now() - this.freshAt[base]) <= MAX_STALE_MIN * 60e3;
  }

  // §7.2 — daily freshness: the latest fetched daily bar must be the EXPECTED
  // latest CLOSED day (its open ts = the last fully-elapsed UTC day), not older
  // than one day's boundary. Returns true if stale (lagging/empty daily fetch).
  dailyIsStale(now) {
    const expectedOpen = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    const d = this.hist1d['BTC'];
    if (!d || !d.length) return true;
    return d[d.length - 1][0] < expectedOpen;
  }

  setFeeds(hist1h, hist4h, hist1d, freshAt) {
    if (hist1h) this.hist1h = hist1h;
    if (hist4h) this.hist4h = hist4h;
    if (hist1d) this.hist1d = hist1d;
    if (freshAt) this.freshAt = freshAt;
  }

  // latest CLOSED price per leg (intraday => 1h close, slow-long => daily close)
  getPx(base) {
    const p = this.ledger.data.coins[base];
    if (p && p.leg === 'slowLong') {
      const d = this.hist1d[base]; return d && d.length ? d[d.length - 1][4] : 0;
    }
    const h = this.hist1h[base]; return h && h.length ? h[h.length - 1][4] : 0;
  }

  // -------------------------------------------------------------------------
  // §2 — regime gate (byte-faithful to Engine B regimeInfo, closed bars only)
  // -------------------------------------------------------------------------
  regimeInfo() {
    if (this.forceRegime) return this.forceRegime;
    const btc4 = this.hist4h['BTC'];
    if (!btc4 || btc4.length < REGIME_WARMUP) return null;      // BTC feed missing / under warmup
    if (!this.isFresh('BTC')) return null;                      // stale BTC feed → UNDEFINED
    const closes = btc4.map(c => c[4]);
    const last = closes[closes.length - 1];
    const f = lib.sma(closes, BREADTH_PERIOD);
    const s = lib.sma(closes, 50);
    if (f == null || s == null) return null;
    let up = 0, n = 0;
    for (const { base } of UNIVERSE) {
      const h = this.hist4h[base];
      if (!h || h.length < REGIME_WARMUP) continue;             // < 60 closed 4h bars → excluded from both N and up
      n++;
      const c = h[h.length - 1][4];
      const m = lib.sma(h.map(x => x[4]), BREADTH_PERIOD);
      if (m != null && c > m) up++;
    }
    if (n < 12) return null;                                    // N_valid < 12 → UNDEFINED (REGIME_NODATA)
    const breadth = up / n;
    const bull = last > f && f > s && breadth > BREADTH_BULL;
    const bear = last < f && f < s && breadth < BREADTH_BEAR;
    const state = bull ? 'BULL' : bear ? 'BEAR' : 'RANGE';
    return { state, breadth, nValid: n, nAbove: up, btc: { last, f, s }, btcTrend: last / s - 1 };
  }

  // -------------------------------------------------------------------------
  // §5.2 — funding (shorts only, once per 8h boundary, lastFundIdx persisted)
  // -------------------------------------------------------------------------
  runFunding(now) {
    if (FUNDING_8H_BPS <= 0) return;
    const fundIdx = Math.floor(now / FUND_8H_MS);
    if (fundIdx === this.ledger.data.lastFundIdx) return;
    this.ledger.data.lastFundIdx = fundIdx;
    for (const b of Object.keys(this.ledger.data.coins)) {
      const p = this.ledger.data.coins[b];
      if (p.dir !== 'SHORT') continue;
      const px = this.getPx(b); if (!px) continue;
      const fund = p.amt * px * FUND_RATE;
      this.ledger.data.usdt -= fund;
      this.stats.funding += fund;
      this.ledger.log('FUND', { base: b, dir: 'SHORT', amt: +p.amt.toFixed(6), px: +px.toFixed(6), fund: -fund });
    }
  }

  // -------------------------------------------------------------------------
  // §6.4 — engine-level cross-direction guard (one position per coin, any leg)
  // -------------------------------------------------------------------------
  guardHeld(base, attemptedDir, leg) {
    const p = this.ledger.data.coins[base];
    if (!p) return false;
    this.ledger.log('GUARD_HELD', { base, heldDir: p.dir, heldLeg: p.leg, attemptedDir, leg });
    return true;
  }

  grossBook() {
    let book = 0;
    for (const b of Object.keys(this.ledger.data.coins)) {
      const px = this.getPx(b); if (!px) continue;
      book += this.ledger.data.coins[b].amt * px;
    }
    return book;
  }
  countLeg(leg) {
    let n = 0;
    for (const b of Object.keys(this.ledger.data.coins)) if (this.ledger.data.coins[b].leg === leg) n++;
    return n;
  }
  intradayCount() {
    let n = 0;
    for (const b of Object.keys(this.ledger.data.coins)) {
      const leg = this.ledger.data.coins[b].leg;
      if (leg === 'fastShort' || leg === 'mediumLong') n++;
    }
    return n;
  }
  // 1x gross-book invariant assertion (must never fire; if it does, it's a bug)
  assertBook(eq) {
    const book = this.grossBook();
    if (book > eq * GROSS_BOOK_CAP + 1e-6) {
      this.ledger.log('BUG_GROSS_BOOK', { book: +book.toFixed(2), eq: +eq.toFixed(2), cap: GROSS_BOOK_CAP });
    }
  }

  // -------------------------------------------------------------------------
  // EXIT — medium-long (STOP > TP > TRAIL), byte-faithful to Engine B §3.2
  // -------------------------------------------------------------------------
  mediumLongExit(base, reg, nextOpen, nextClose) {
    const pos = this.ledger.data.coins[base];
    if (!pos || pos.leg !== 'mediumLong') return null;
    const h1 = this.hist1h[base]; if (!h1 || !h1.length) return null;
    const p = h1[h1.length - 1][4];
    const atrB = lib.coinATR(h1);
    // geometry anchor = the CLEAN signal price (un-slipped p at entry), never the
    // slipped pos.entry/pos.amt. STOP is already clean; TP and longregime-tighten
    // now use the same clean anchor (removes the ~5bps drift, review m1).
    const entryPx = pos.signalPx || (pos.entry && pos.amt ? pos.entry / pos.amt : p);
    const trailBase = pos.trailBase || entryPx;
    const heldBars = (h1[h1.length - 1][0] - (pos.entryBarTs || h1[h1.length - 1][0])) / H1_MS;

    // longregime tighten: breadth < 0.45 → pull stop to entry − 2.5×ATR, WRITE it (persists)
    if (LONGREGIME_BREADTH > 0 && reg && reg.breadth < LONGREGIME_BREADTH && atrB) {
      pos.stop = Math.max(pos.stop || 0, entryPx - LONGREGIME_TIGHTEN_ATR * atrB);
    }

    const stopHit = pos.stop && p <= pos.stop;
    let trail = false;
    if (atrB) {
      pos.trailHi = pos.trailHi == null ? p : Math.max(pos.trailHi, p);
      if (pos.trailHi - trailBase >= TRAIL_ARM_ATR * atrB && p <= pos.trailHi - TRAIL_ATR * atrB) trail = true;
    }
    let tp = false, tpTarget = null;
    if (atrB) {
      const kk = pos.tpTk || TP_LONG_K_WEAK;
      const gain = Math.max(kk * atrB, entryPx * ((1 + TAKER) / (1 - TAKER) - 1) + entryPx * (TP_FEES / 100));
      tpTarget = entryPx + gain;
      if (p >= tpTarget) tp = true;
    }

    let reason = null, trigger = null;
    if (stopHit) { reason = 'STOP'; trigger = pos.stop; }
    else if (tp) { reason = 'TP'; trigger = tpTarget; }
    else if (trail) { reason = 'TRAIL'; trigger = pos.trailHi - TRAIL_ATR * atrB; }
    if (!reason) return null;

    // adaptive cooldown (Engine B): block re-entry until 1×ATR move in the exited
    // direction OR 6×4h elapse — whichever first. Separate map from fast-short.
    const atrFrac = atrB && p > 0 ? atrB / p : STOP_FALLBACK;
    this.ledger.data.mediumLongCooldown[base] = {
      lockedPx: p, needMove: RETRACE_ATR * atrFrac,
      until: this.clock() + COOLDOWN_ATR_BARS * BAR_MS, dir: pos.dir,
    };

    const signalPx = pos.signalPx || p;
    return this._close(base, pos, reason, signalPx, trigger, nextOpen, nextClose, heldBars, {});
  }

  // -------------------------------------------------------------------------
  // EXIT — medium-long LIVE TP TOUCH (Engine D patch 1, V5 touch design). The
  // TP is re-checked against LIVE price on every poll between 1h decisions and
  // fires at the touch; STOP and TRAIL (and trailHi ratcheting) are NEVER
  // evaluated down here — the 1h mediumLongExit (above, unmodified) owns them,
  // so its STOP/TRAIL/TP-at-hour decisions see byte-identical state to paper_C.
  // ATR and all strength evaluation use ONLY the last CLOSED 1h bar feed
  // (this.hist1h as fed by the previous decision tick) — never an intra-bar or
  // 5m recompute, never the forming hour. Geometry/prio + adaptive-cooldown
  // stamp are a verbatim mirror of the TP branch of mediumLongExit (lines
  // 343-349, 359-363 in paper_C.js). Exit reason 'TP' through the shared close
  // path (so exit-mix/checkin semantics are unchanged) with a `probe: true`
  // flag on the EXIT record; a PROBE_EXIT log line (V5 driver parity) tags the
  // live-banked touch explicitly for the checkin tooling.
  // -------------------------------------------------------------------------
  probeMediumLongTP(base, now, probePx, barTs) {
    const pos = this.ledger.data.coins[base];
    if (!pos || pos.leg !== 'mediumLong') return null;
    const h1 = this.hist1h[base]; if (!h1 || !h1.length) return null;
    const p = probePx;
    const atrB = lib.coinATR(h1);                          // last CLOSED 1h bar only
    const entryPx = pos.signalPx || (pos.entry && pos.amt ? pos.entry / pos.amt : p); // clean anchor (paper_C.js:328)
    if (!atrB) return null;                                // same ATR guard the hourly TP uses

    // TP target — CURRENT moving target, fresh recompute from closed 1h ATR
    // (mediumLongExit lines 343-349, verbatim). NOT a high-water variant.
    const kk = pos.tpTk || TP_LONG_K_WEAK;
    const gain = Math.max(kk * atrB, entryPx * ((1 + TAKER) / (1 - TAKER) - 1) + entryPx * (TP_FEES / 100));
    const tpTarget = entryPx + gain;
    if (!(p >= tpTarget)) return null;

    // adaptive cooldown stamp — verbatim mediumLongExit lines 359-363
    const heldBars = (now - (pos.entryBarTs || now)) / H1_MS;
    const atrFrac = atrB && p > 0 ? atrB / p : STOP_FALLBACK;
    this.ledger.data.mediumLongCooldown[base] = {
      lockedPx: p, needMove: RETRACE_ATR * atrFrac,
      until: this.clock() + COOLDOWN_ATR_BARS * BAR_MS, dir: pos.dir,
    };

    const signalPx = pos.signalPx || p;
    this.ledger.log('PROBE_EXIT', {
      base, reason: 'TP', probeTime: now, barTs, fiveClose: +p.toFixed(6),
      trigger: +tpTarget.toFixed(6), heldBars: +heldBars.toFixed(2),
    });
    // fill = live/probe price (realistic_open = slipped probe + TAKER, same _close path)
    return this._close(base, pos, 'TP', signalPx, tpTarget, p, p, heldBars, { probe: true });
  }

  // Probe loop: every open medium-long position at the current LIVE price
  // (poll path between 1h decisions). `priceOf(b)` returns the live price,
  // `barTsOf(b)` the source bar ts (5m bar ts in replay). The probe runs
  // strictly BEFORE the next 1h tick, so a probe-closed position is already
  // out of the ledger when the hourly mediumLongExit runs — no double-close.
  probeOpenMediumLongs(now, priceOf, barTsOf) {
    for (const b of Object.keys(this.ledger.data.coins)) {
      if (this.ledger.data.coins[b].leg !== 'mediumLong') continue;
      if (!this.isFresh(b)) continue;
      const px = priceOf(b); if (!px) continue;
      if (this.probeMediumLongTP(b, now, px, barTsOf ? barTsOf(b) : null)) this.ledger.save();
    }
  }

  // -------------------------------------------------------------------------
  // EXIT — fast-short (chandelier trail, no hard stop, 48-bar cap)
  // -------------------------------------------------------------------------
  fastShortExit(base, nextOpen, nextClose) {
    const pos = this.ledger.data.coins[base];
    if (!pos || pos.leg !== 'fastShort') return null;
    const h1 = this.hist1h[base];
    if (!h1 || !h1.length) return null;
    const curTs = h1[h1.length - 1][0];
    const closeB = h1[h1.length - 1][4];
    const atrEntry = pos.atrEntry;
    const heldBars = (curTs - (pos.entryBarTs || curTs)) / H1_MS;

    // Mode 0: current trail (byte-identical)
    if (FASTSHORT_MODE !== 1) {
      let runningLow = Infinity;
      for (const c of h1) {
        if (c[0] < pos.entryBarTs) continue;
        if (c[0] >= curTs) break;
        if (c[3] < runningLow) runningLow = c[3];
      }
      const trailTrigger = (runningLow !== Infinity && atrEntry) ? runningLow + FASTSHORT_TRAIL_ATR * atrEntry : null;

      let reason = null, trigger = null;
      if (trailTrigger != null && closeB >= trailTrigger) { reason = 'TRAIL'; trigger = trailTrigger; }
      else if (heldBars >= FASTSHORT_MAXHOLD_BARS) { reason = 'MAXHOLD'; trigger = closeB; }
      if (!reason) return null;

      this.ledger.data.fastShortCooldown[base] = this.clock() + FASTSHORT_COOLDOWN_H * 3600e3;

      const signalPx = pos.signalPx || closeB;
      const extra = {
        trailTriggerPx: trailTrigger,
        coverGapBps: (trailTrigger != null && nextOpen) ? (nextOpen - trailTrigger) / trailTrigger * 1e4 : null,
        dumpSizeBps: (pos.entryRaw && nextOpen) ? (pos.entryRaw - nextOpen) / pos.entryRaw * 1e4 : null,
      };
      return this._close(base, pos, reason, signalPx, trigger, nextOpen, nextClose, heldBars, extra);
    }

    // Mode 1: sell-the-rip (TP / stop / maxhold, no trail)
    const tp = pos.tp;
    const stop = pos.stop;
    const maxHold = FS_MAXHOLD;

    let reason = null, trigger = null;
    // STOP first (safety): price rose to stop level
    if (stop != null && closeB >= stop) { reason = 'STOP'; trigger = stop; }
    // TP: price dropped to TP level
    else if (tp != null && closeB <= tp) { reason = 'TP'; trigger = tp; }
    // MAXHOLD: held too long
    else if (heldBars >= maxHold) { reason = 'MAXHOLD'; trigger = closeB; }
    if (!reason) return null;

    // per-coin cooldown (FS_CD_HOURS for mode 1)
    this.ledger.data.fastShortCooldown[base] = this.clock() + FS_CD_HOURS * 3600e3;

    const signalPx = pos.signalPx || closeB;
    const extra = {
      trailTriggerPx: null,
      coverGapBps: (trigger != null && nextOpen) ? (nextOpen - trigger) / trigger * 1e4 : null,
      dumpSizeBps: (pos.entryRaw && nextOpen) ? (pos.entryRaw - nextOpen) / pos.entryRaw * 1e4 : null,
      tpLevelPx: tp,
      stopLevelPx: stop,
      mode: FASTSHORT_MODE,
    };
    return this._close(base, pos, reason, signalPx, trigger, nextOpen, nextClose, heldBars, extra);
  }

  // -------------------------------------------------------------------------
  // EXIT — slow-long (Donchian 20-low OR 200-SMA)
  // -------------------------------------------------------------------------
  slowLongExit(base, nextOpen, nextClose) {
    const pos = this.ledger.data.coins[base];
    if (!pos || pos.leg !== 'slowLong') return null;
    const d = this.hist1d[base];
    if (!d || d.length < Math.max(SLOWLONG_EXIT_LOW_M, SLOWLONG_EXIT_SMA)) return null;
    const closeD = d[d.length - 1][4];
    const heldBars = (d[d.length - 1][0] - (pos.entryBarTs || d[d.length - 1][0])) / DAY_MS;
    const lo20 = lib.priorMin(d, SLOWLONG_EXIT_LOW_M, 3);
    const sma200 = lib.sma(d.map(x => x[4]), SLOWLONG_EXIT_SMA);
    let reason = null, trigger = null;
    if (lo20 != null && closeD < lo20) { reason = 'DONCHIAN'; trigger = lo20; }
    else if (sma200 != null && closeD < sma200) { reason = 'SMA200'; trigger = sma200; }
    if (!reason) return null;
    const signalPx = pos.signalPx || closeD;
    return this._close(base, pos, reason, signalPx, trigger, nextOpen, nextClose, heldBars, {});
  }

  // -------------------------------------------------------------------------
  // shared close path: ledger move (realistic_open) + derived fantasy/realclose
  // -------------------------------------------------------------------------
  _close(base, pos, reason, signalPx, trigger, nextOpen, nextClose, heldBars, extra) {
    const dir = pos.dir, amt = pos.amt;

    // three raw exit prices (fantasy = exact trigger, realistic = B+1 open/close)
    const exitFantasyRaw = trigger != null ? trigger : (this.getPx(base) || 0);
    const exitRealOpenRaw = nextOpen != null ? nextOpen : exitFantasyRaw;
    const exitRealCloseRaw = nextClose != null ? nextClose : exitRealOpenRaw;

    // fill prices: realistic are slipped, fantasy is raw (SPEC §6.1)
    const entryRealOpenFill = pos.entry && pos.amt ? pos.entry / pos.amt : signalPx; // slipped entry (ledger basis)
    const exitRealOpenFill = applySlip(exitRealOpenRaw, dir, 'EXIT');
    const exitRealCloseFill = applySlip(exitRealCloseRaw, dir, 'EXIT');

    // close on the realistic_open track (the stored cash move)
    const res = this.ledger.close(base, exitRealOpenFill, reason);
    if (!res) return null;
    const pnlRealOpen = res.pnl;

    // derived tracks (report-only; never touch ledger cash). The fantasy track
    // deliberately EXCLUDES slippage (raw signal close / trigger level) to isolate
    // the pure fill gap; realistic tracks include slippage (review m4, §6.1).
    const pnlFantasy = tradePnl(dir, amt, signalPx, exitFantasyRaw);                      // raw fills, fees only
    const pnlRealClose = tradePnl(dir, amt, entryRealOpenFill, exitRealCloseFill);        // slipped fills, fees

    // identity self-check §6.3
    const checkPnl = tradePnl(dir, amt, entryRealOpenFill, exitRealOpenFill);
    if (Math.abs(checkPnl - pnlRealOpen) > 1e-6) {
      this.ledger.log('BUG_PNL_IDENTITY', { base, check: +checkPnl.toFixed(6), ledger: +pnlRealOpen.toFixed(6) });
    }

    const fillQualityDelta = pnlFantasy - pnlRealOpen;
    const leg = pos.leg;
    const legStats = this.stats[leg];
    legStats.n++;
    if (pnlRealOpen > 0) legStats.wins++;
    legStats.pnlFantasy += pnlFantasy;
    legStats.pnlRealOpen += pnlRealOpen;
    legStats.pnlRealClose += pnlRealClose;
    legStats.fillQualityDelta += fillQualityDelta;

    // cost breakdown (fees + slippage for this trade)
    this.stats.fees += amt * entryRealOpenFill * MAKER + amt * exitRealOpenFill * TAKER;
    this.stats.slippage += amt * (pos.entryRaw || signalPx) * SLIP + amt * exitRealOpenRaw * SLIP;

    // fast-short cover-gap rollup bucketed by dump size
    if (leg === 'fastShort' && extra.dumpSizeBps != null) {
      this.stats.coverGap[this._bucket(Math.abs(extra.dumpSizeBps))]++;
    }

    this.ledger.log('EXIT', {
      leg, base, dir, reason, heldBars: +heldBars.toFixed(1),
      signalPx: +signalPx.toFixed(6),
      exitFantasy: +exitFantasyRaw.toFixed(6),
      exitRealOpen: +exitRealOpenFill.toFixed(6),
      exitRealClose: +exitRealCloseFill.toFixed(6),
      pnlFantasy: +pnlFantasy.toFixed(4), pnlRealOpen: +pnlRealOpen.toFixed(4), pnlRealClose: +pnlRealClose.toFixed(4),
      fillQualityDelta: +fillQualityDelta.toFixed(4),
      ...(leg === 'fastShort' ? {
        trailTriggerPx: extra.trailTriggerPx != null ? +extra.trailTriggerPx.toFixed(6) : null,
        realCoverPx: +exitRealOpenRaw.toFixed(6),
        coverGapBps: extra.coverGapBps != null ? +extra.coverGapBps.toFixed(2) : null,
        dumpSizeBps: extra.dumpSizeBps != null ? +extra.dumpSizeBps.toFixed(2) : null,
      } : {}),
      ...(extra.probe ? { probe: true } : {}),
    });
    return { pnl: pnlRealOpen, reason, leg };
  }

  // -------------------------------------------------------------------------
  // ENTRY — fast-short
  // -------------------------------------------------------------------------
  fastShortEntry(base, reg, nextOpen) {
    if (!FASTSHORT_ENABLED) {
      if (!this._fastShortDisabledNoted) {
        this._fastShortDisabledNoted = true;
        this.ledger.log('FASTSHORT_DISABLED', { reason: 'leg off (C_FASTSHORT_ENABLED=0)' });
      }
      return null;
    }
    const h1 = this.hist1h[base];
    if (!h1 || h1.length < FASTSHORT_EMA) return null;
    const B = h1.length - 1;
    const closeB = h1[B][4];

    // Mode 0: current breakdown entry (byte-identical)
    if (FASTSHORT_MODE !== 1) {
      const low120 = lib.priorMin(h1, FASTSHORT_LOW_BARS, 3);
      const volAvg = lib.priorMean(h1, FASTSHORT_LOW_BARS, 5);
      const e200 = lib.ema200(h1.map(c => c[4]));
      if (low120 == null || volAvg == null || e200 == null) return null;
      if (closeB >= low120) return null;
      if (h1[B][5] < FASTSHORT_VOL_MULT * volAvg) return null;
      if (closeB >= e200) return null;
      if (FASTSHORT_BEAR_ONLY && reg.state !== 'BEAR') return null;
      if (this.guardHeld(base, 'SHORT', 'fastShort')) return null;
      if (this.countLeg('fastShort') >= FASTSHORT_MAX_POS) return null;
      if (this.intradayCount() >= K) return null;
      const cd = this.ledger.data.fastShortCooldown[base];
      if (cd && this.clock() < cd) return null;

      const eq = this.ledger.equity(this.getPx.bind(this));
      const notional = Math.min(FASTSHORT_NOTIONAL_FRAC * eq, this.ledger.data.usdt * CASH_CAP_FRAC) * LEV;
      if (notional < 5) return null;
      const amt = notional / nextOpen;
      const fillPx = applySlip(nextOpen, 'SHORT', 'ENTRY');
      if (this.ledger.openShort(base, amt, fillPx)) {
        const pos = this.ledger.data.coins[base];
        pos.leg = 'fastShort';
        pos.atrEntry = lib.coinATR(h1);
        pos.entryBarTs = h1[B][0];
        pos.signalPx = closeB;
        pos.entryRaw = nextOpen;
        pos.openedAt = this.clock();
        this.ledger.log('ENTER', {
          leg: 'fastShort', base, dir: 'SHORT', regime: reg.state, breadth: +reg.breadth.toFixed(2),
          signalPx: +closeB.toFixed(6), entryFantasy: +closeB.toFixed(6),
          entryRealOpen: +fillPx.toFixed(6), entryRealClose: +fillPx.toFixed(6),
          fillRawOpen: +nextOpen.toFixed(6),
          notional: +notional.toFixed(2), amt: +amt.toFixed(6),
          low120: +low120.toFixed(6), volRatio: +(h1[B][5] / volAvg).toFixed(2), ema200: +e200.toFixed(6),
        });
        return true;
      }
      return null;
    }

    // Mode 1: sell-the-rip (short on bounce in downtrend)
    if (!reg) return null;
    if (reg.state !== 'BEAR') return null;
    // Hour filter: block entries during 06:00-09:00 GMT+8 (0/6 wins, −$13.10 in replay)
    const _hourGMT8 = (new Date(this.clock()).getUTCHours() + 8) % 24;
    if (_hourGMT8 >= 6 && _hourGMT8 < 9) return null;
    const sma20 = lib.priorMean(h1, 20, 4); // trailing 20-bar SMA of close (B excluded)
    if (sma20 == null) return null;
    if (!(closeB > sma20)) return null; // must have bounced
    const e200 = lib.ema200(h1.map(c => c[4]));
    if (e200 == null || !(closeB < e200)) return null; // still in downtrend
    const volAvg120 = lib.priorMean(h1, 120, 5);
    if (volAvg120 == null) return null;
    const volRatio = h1[B][5] / volAvg120;
    if (volRatio < 1.5) return null;
    if (this.guardHeld(base, 'SHORT', 'fastShort')) return null;
    if (this.countLeg('fastShort') >= FASTSHORT_MAX_POS) return null;
    if (this.intradayCount() >= K) return null;
    const cd = this.ledger.data.fastShortCooldown[base];
    if (cd && this.clock() < cd) return null;

    const atrE = lib.coinATR(h1);
    if (!atrE) return null;
    const eq = this.ledger.equity(this.getPx.bind(this));
    const risk = eq * FS_RISK_BUDGET;
    const stopDist = FS_STOP_ATR * atrE / closeB;
    const notional = Math.min(risk / stopDist, FS_NOTIONAL_CAP * eq, this.ledger.data.usdt * CASH_CAP_FRAC) * LEV;
    if (notional < 5) return null;
    const amt = notional / nextOpen;
    const fillPx = applySlip(nextOpen, 'SHORT', 'ENTRY');
    const depthBefore = this.intradayCount();
    if (this.ledger.openShort(base, amt, fillPx)) {
      const pos = this.ledger.data.coins[base];
      pos.leg = 'fastShort';
      pos.atrEntry = atrE;
      pos.entryBarTs = h1[B][0];
      pos.signalPx = closeB;
      pos.entryRaw = nextOpen;
      pos.openedAt = this.clock();
      pos.tp = closeB - Math.max(FS_TP_ATR * atrE, closeB * ((1 + TAKER) / (1 - TAKER) - 1)); // TP level (price, with fee floor)
      pos.stop = closeB + FS_STOP_ATR * atrE;    // stop level (price)
      pos.maxHoldBars = FS_MAXHOLD;
      this.ledger.log('ENTER', {
        leg: 'fastShort', base, dir: 'SHORT', regime: reg.state, breadth: +reg.breadth.toFixed(2),
        signalPx: +closeB.toFixed(6), entryFantasy: +closeB.toFixed(6),
        entryRealOpen: +fillPx.toFixed(6), entryRealClose: +fillPx.toFixed(6),
        fillRawOpen: +nextOpen.toFixed(6),
        notional: +notional.toFixed(2), amt: +amt.toFixed(6),
        volRatio: +volRatio.toFixed(2), ema200: +e200.toFixed(6),
        sma20: +sma20.toFixed(6), atrEntry: +atrE.toFixed(6),
        tpLevelPx: +pos.tp.toFixed(6), stopLevelPx: +pos.stop.toFixed(6),
        mode: 1, depth: depthBefore,
      });
      return true;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // ENTRY — medium-long (byte-faithful to Engine B §3.2)
  // -------------------------------------------------------------------------
  mediumLongEntry(base, reg, nextOpen) {
    if (!MEDIUMLONG_ENABLED) {
      if (!this._mediumLongDisabledNoted) {
        this._mediumLongDisabledNoted = true;
        this.ledger.log('MEDIUMLONG_DISABLED', { reason: 'leg off (C_MEDIUMLONG_ENABLED=0)' });
      }
      return null;
    }
    if (!(reg.breadth > LONG_BREADTH_MIN)) return null; // Engine B live gate: breadth>0.60, no BTC-trend conjunctive
    const c1 = this.hist1h[base], c4 = this.hist4h[base];
    if (!c1 || !c4) return null;
    const sc = scoreCoin(c1, c4);
    if (!sc) return null;
    if (sc.score < LONG_TH || direction(sc.score, LONG_TH, -50) !== 'LONG') return null; // score < 50 ignored (long-only)
    if (lib.priceBelowFast4h(c4)) return null;               // no bounce-fading against a falling 4h trend
    if (this.guardHeld(base, 'LONG', 'mediumLong')) return null;
    // BULL cap: limit concurrent longs in BULL regime (bullcap2)
    if (reg.state === 'BULL' && C_ML_BULL_MAX_POS > 0 && this.countLeg('mediumLong') >= C_ML_BULL_MAX_POS) return null;
    if (this.intradayCount() >= K) return null;
    if (this.inMediumLongCooldown(base)) return null;

    const p = c1[c1.length - 1][4];
    const atrE = lib.coinATR(c1);
    const eq = this.ledger.equity(this.getPx.bind(this));
    const risk = eq * RISK_BUDGET;
    const stopDist = atrE ? LONG_STOP_ATR * atrE / p : STOP_FALLBACK;
    const notional = Math.min(risk / stopDist, MEDIUMLONG_MAX_NOTIONAL_FRAC * eq, this.ledger.data.usdt * CASH_CAP_FRAC) * LEV;
    if (notional < 5) return null;

    // === ENGINE D BREADTH GUARD (patch 2, V6B parity) ===
    // Medium-long entries additionally require breadth >= 0.80 (skip when
    // breadth < 0.80); the engine's 0.60 gate above stays as the lower bound,
    // the 0.80 is a stricter addition — exact V6B patch placement (after every
    // other engine gate, so GUARD_BLOCK_BREADTH == would-otherwise-have-entered).
    if (!(reg.breadth >= LONG_GUARD_BREADTH)) {
      this.ledger.log('GUARD_BLOCK_BREADTH', { base, dir: 'LONG', breadth: +reg.breadth.toFixed(4), score: sc.score, now: this.clock() });
      return null;
    }

    const amt = notional / nextOpen;
    const fillPx = applySlip(nextOpen, 'LONG', 'ENTRY'); // long buys higher
    if (this.ledger.openLong(base, amt, fillPx)) {
      const pos = this.ledger.data.coins[base];
      pos.leg = 'mediumLong';
      pos.stop = atrE ? p - LONG_STOP_ATR * atrE : p * (1 - STOP_FALLBACK);
      pos.openedAt = this.clock();
      pos.trailHi = p; pos.trailBase = p;
      pos.tpTk = longTpK(sc.score);
      pos.entryBarTs = c1[c1.length - 1][0];
      pos.signalPx = p;
      pos.entryRaw = nextOpen;
      this.ledger.log('ENTER', {
        leg: 'mediumLong', base, dir: 'LONG', regime: reg.state, breadth: +reg.breadth.toFixed(2),
        signalPx: +p.toFixed(6), entryFantasy: +p.toFixed(6),
        entryRealOpen: +fillPx.toFixed(6), entryRealClose: +fillPx.toFixed(6),
        fillRawOpen: +nextOpen.toFixed(6),
        notional: +notional.toFixed(2), amt: +amt.toFixed(6), score: sc.score, tpTk: pos.tpTk, why: sc.reason,
      });
      return true;
    }
    return null;
  }
  inMediumLongCooldown(base) {
    const cd = this.ledger.data.mediumLongCooldown[base];
    if (!cd) return false;
    if (this.clock() >= cd.until) { delete this.ledger.data.mediumLongCooldown[base]; return false; }
    if (cd.lockedPx && cd.needMove) {
      if (!this.isFresh(base)) return true;
      const p = this.getPx(base);
      const moved = cd.dir === 'SHORT' ? p <= cd.lockedPx * (1 - cd.needMove)
        : cd.dir === 'LONG' ? p >= cd.lockedPx * (1 + cd.needMove)
        : Math.abs(p - cd.lockedPx) / cd.lockedPx >= cd.needMove;
      if (moved) { delete this.ledger.data.mediumLongCooldown[base]; return false; }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // ENTRY — slow-long (Donchian 20-high)
  // -------------------------------------------------------------------------
  slowLongEntry(base, reg, nextOpen) {
    if (!SLOWLONG_ENABLED) {
      if (!this._slowLongDisabledNoted) {
        this._slowLongDisabledNoted = true;
        this.ledger.log('SLOWLONG_DISABLED', { reason: 'fails §3.3 3y acceptance: pnlRealOpen -20.38, median hold 1 day (fill artifact)' });
      }
      return null;
    }
    if (reg.state !== 'BULL') return null;
    if (SLOWLONG_BREADTH_MIN > 0 && reg.breadth < SLOWLONG_BREADTH_MIN) return null;
    const d = this.hist1d[base];
    if (!d || d.length < Math.max(SLOWLONG_DONCHIAN_N, SLOWLONG_EXIT_SMA)) return null;
    const closeD = d[d.length - 1][4];
    const hi20 = lib.priorMax(d, SLOWLONG_DONCHIAN_N, 2);
    if (hi20 == null || closeD <= hi20) return null;
    if (this.guardHeld(base, 'LONG', 'slowLong')) return null;
    if (this.countLeg('slowLong') >= SLOWLONG_MAX_POS) return null;

    const eq = this.ledger.equity(this.getPx.bind(this));
    const perPos = SLOWLONG_BOOK_FRAC * eq / SLOWLONG_MAX_POS;
    const notional = Math.min(perPos, this.ledger.data.usdt * CASH_CAP_FRAC) * LEV;
    if (notional < 5) return null;
    const amt = notional / nextOpen;
    const fillPx = applySlip(nextOpen, 'LONG', 'ENTRY');
    if (this.ledger.openLong(base, amt, fillPx)) {
      const pos = this.ledger.data.coins[base];
      pos.leg = 'slowLong';
      pos.openedAt = this.clock();
      pos.entryBarTs = d[d.length - 1][0];
      pos.signalPx = closeD;
      pos.entryRaw = nextOpen;
      this.ledger.log('ENTER', {
        leg: 'slowLong', base, dir: 'LONG', regime: reg.state, breadth: +reg.breadth.toFixed(2),
        signalPx: +closeD.toFixed(6), entryFantasy: +closeD.toFixed(6),
        entryRealOpen: +fillPx.toFixed(6), entryRealClose: +fillPx.toFixed(6),
        fillRawOpen: +nextOpen.toFixed(6),
        notional: +notional.toFixed(2), amt: +amt.toFixed(6), donchianHigh: +hi20.toFixed(6),
      });
      return true;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // decision step (one closed bar). tick = { now, daily, hourly, next1h, next1d }
  //   next1h = { base: {open, close} }, next1d = { base: {open, close} }
  // -------------------------------------------------------------------------
  step(tick) {
    const now = tick.now;
    const reg = this.regimeInfo();
    if (!reg) this.ledger.log('REGIME_NODATA', { now: new Date(now).toISOString() });

    // §7.2 STALE_DAILY: skip the whole slow-long daily cycle (exits + entries) if
    // the latest daily bar isn't the expected closed day (lagging/empty fetch).
    const dailyStale = tick.daily && this.dailyIsStale(now);
    if (dailyStale) this.ledger.log('STALE_DAILY', { now: new Date(now).toISOString() });

    // 1. slow-long exits (daily boundary, before everything)
    if (tick.daily && !dailyStale) {
      for (const b of Object.keys(this.ledger.data.coins)) {
        const pos = this.ledger.data.coins[b];
        if (pos.leg !== 'slowLong') continue;
        if (!this.isFresh(b)) continue;
        const nx = tick.next1d && tick.next1d[b];
        this.slowLongExit(b, nx && nx.open, nx && nx.close);
      }
    }
    // 2. intraday exits (fast-short + medium-long)
    if (tick.hourly) {
      for (const b of Object.keys(this.ledger.data.coins)) {
        const pos = this.ledger.data.coins[b];
        if (!this.isFresh(b)) continue;
        const nx = tick.next1h && tick.next1h[b];
        if (pos.leg === 'mediumLong') this.mediumLongExit(b, reg, nx && nx.open, nx && nx.close);
        else if (pos.leg === 'fastShort') this.fastShortExit(b, nx && nx.open, nx && nx.close);
      }
    }
    // 3. funding (after exits, before entries)
    this.runFunding(now);

    if (!reg) { this.ledger.save(); return; } // stale regime → no new entries (exits already ran)

    const eq = this.ledger.equity(this.getPx.bind(this));
    this.ledger.data.peak = Math.max(this.ledger.data.peak || this.ledger.startUsdt, eq);

    // 4. intraday entries
    if (tick.hourly) {
      if (FASTSHORT_ENABLED && (!FASTSHORT_BEAR_ONLY || reg.state === 'BEAR')) {
        for (const { base } of UNIVERSE) {
          if (!this.isFresh(base)) continue;
          const nx = tick.next1h && tick.next1h[base];
          if (!nx) continue;
          this.fastShortEntry(base, reg, nx.open);
        }
      }
      if (MEDIUMLONG_ENABLED && reg.breadth > LONG_BREADTH_MIN) {  // medium-long: Engine B live breadth-only gate
        const ranked = [];
        for (const { base } of UNIVERSE) {
          if (!this.isFresh(base)) continue;
          const c1 = this.hist1h[base], c4 = this.hist4h[base];
          const sc = c1 && c4 ? scoreCoin(c1, c4) : null;
          if (sc && sc.score >= LONG_TH) ranked.push({ base, score: sc.score });
        }
        ranked.sort((a, b) => b.score - a.score);
        for (const { base } of ranked) {
          const nx = tick.next1h && tick.next1h[base];
          if (!nx) continue;
          this.mediumLongEntry(base, reg, nx.open);
        }
      }
    }
    // 5. slow-long entries (daily boundary)
    if (tick.daily && !dailyStale) {
      for (const { base } of UNIVERSE) {
        if (!this.isFresh(base)) continue;
        const nx = tick.next1d && tick.next1d[base];
        if (!nx) continue;
        this.slowLongEntry(base, reg, nx.open);
      }
    }

    // assert the 1× gross-book invariant against POST-entry equity (fresh), so a
    // breach is caught against the book that includes this cycle's new positions.
    this.assertBook(this.ledger.equity(this.getPx.bind(this)));
    this.snapshot(tick.daily ? 'DAILY_SNAPSHOT' : 'SNAPSHOT', reg);
    this.ledger.save();
  }

  // -------------------------------------------------------------------------
  // §8 — report
  // -------------------------------------------------------------------------
  snapshot(kind, reg) {
    const eq = this.ledger.equity(this.getPx.bind(this));
    const peak = this.ledger.data.peak || this.ledger.startUsdt;
    const dd = peak ? (peak - eq) / peak : 0;
    const openByLeg = { fastShort: { n: 0, notional: 0 }, mediumLong: { n: 0, notional: 0 }, slowLong: { n: 0, notional: 0 } };
    for (const b of Object.keys(this.ledger.data.coins)) {
      const p = this.ledger.data.coins[b];
      const px = this.getPx(b); if (!px) continue;
      openByLeg[p.leg].n++;
      openByLeg[p.leg].notional += p.amt * px;
    }
    const fmt = (s) => ({
      n: s.n, pnlRealOpen: +s.pnlRealOpen.toFixed(2), pnlFantasy: +s.pnlFantasy.toFixed(2),
      pnlRealClose: +s.pnlRealClose.toFixed(2), hitRate: s.n ? +(s.wins / s.n).toFixed(2) : null,
      fillQualityDelta: +s.fillQualityDelta.toFixed(2),
    });
    this.ledger.log(kind, {
      regime: reg.state, breadth: +reg.breadth.toFixed(2), nValid: reg.nValid, nAbove: reg.nAbove,
      btc: { last: +reg.btc.last.toFixed(2), sma20: +reg.btc.f.toFixed(2), sma50: +reg.btc.s.toFixed(2) },
      equity: +eq.toFixed(2),
      fastShort: fmt(this.stats.fastShort), mediumLong: fmt(this.stats.mediumLong), slowLong: fmt(this.stats.slowLong),
      open: {
        fastShort: openByLeg.fastShort, mediumLong: openByLeg.mediumLong, slowLong: openByLeg.slowLong,
        grossBook: +this.grossBook().toFixed(2), cap: GROSS_BOOK_CAP,
        intradayCap: INTRADAY_BOOK_CAP, slowLongCap: SLOWLONG_BOOK_FRAC,
      },
      cost: { fees: +this.stats.fees.toFixed(4), slippage: +this.stats.slippage.toFixed(4), funding: +this.stats.funding.toFixed(4) },
      coverGap: this.stats.coverGap,
      dd: +(dd * 100).toFixed(2),
    });
  }
}

// ---------------------------------------------------------------------------
// LIVE LOOP — ccxt fetch. TODO(live): network path; not exercised in replay.
// Fills at B+1 use the FORMING bar's open/close (approximate for realistic_close;
// the canonical measurement is the replay).
// ---------------------------------------------------------------------------
async function runLive() {
  const engine = new EngineD({ clock: () => Date.now() });
  const spot = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'spot' } });

  // --- Startup verification (Docker/HA deployment) ---
  const _now = new Date();
  const _gmt8Hour = (_now.getUTCHours() + 8) % 24;
  console.log(`[STARTUP] clockUtc: ${_now.toISOString()}`);
  console.log(`[STARTUP] clockGmt8Hour: ${_gmt8Hour}`);
  console.log(`[STARTUP] tz: ${process.env.TZ || 'unset'}`);
  console.log(`[STARTUP] nodeVersion: ${process.version}`);
  console.log(`[STARTUP] state file: ${engine.ledger.file}`);
  try { engine.ledger.save(); console.log('[STARTUP] state file write: OK'); }
  catch (e) { console.error('[STARTUP] state file write: FAIL', e.message); }
  // Test Binance API connectivity
  try {
    const ping = await spot.fetchTime();
    console.log(`[STARTUP] Binance API: OK (server time ${new Date(ping).toISOString()})`);
  } catch (e) {
    console.error('[STARTUP] Binance API: FAIL', e.message);
  }
  console.log('[STARTUP] READY — engine starting main loop');

  engine.ledger.log('START', {
    engine: 'D', usdt: engine.ledger.startUsdt, k: K, ledgerK: LEDGER_K, lev: LEV,
    legs: 'fastShort/mediumLong/slowLong', makerBps: 2, takerBps: 5, slipBps: SLIPPAGE_BPS, funding8hBps: FUNDING_8H_BPS,
  });

  // --- Graceful shutdown (Docker SIGTERM) ---
  let _shuttingDown = false;
  async function _gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`[SHUTDOWN] received ${signal}, saving state...`);
    try { engine.ledger.save(); console.log('[SHUTDOWN] state saved OK'); }
    catch (e) { console.error('[SHUTDOWN] state save FAIL:', e.message); }
    process.exit(0);
  }
  process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => _gracefulShutdown('SIGINT'));

  async function refresh() {
    const jobs = UNIVERSE.map(async ({ base }) => {
      try {
        const [h1, h4, d1] = await Promise.all([
          spot.fetchOHLCV(spotSymbol(base), '1h', undefined, 500),
          spot.fetchOHLCV(spotSymbol(base), '4h', undefined, 200),
          spot.fetchOHLCV(spotSymbol(base), '1d', undefined, 300),
        ]);
        // decisions use closed bars only (drop the forming bar from hist feeds);
        // keep the raw FORMING bar separately to source B+1 open/close fills.
        engine.hist1h[base] = h1.slice(0, -1);
        engine.hist4h[base] = h4.slice(0, -1);
        engine.hist1d[base] = d1.slice(0, -1);
        engine.form1h[base] = h1.length ? h1[h1.length - 1] : null;
        engine.form4h[base] = h4.length ? h4[h4.length - 1] : null;
        engine.form1d[base] = d1.length ? d1[d1.length - 1] : null;
        engine.freshAt[base] = Date.now();
      } catch (e) { engine.ledger.log('ERR', { msg: `fetch ${base}: ${e.message}` }); }
    });
    await Promise.all(jobs);
  }

  let lastPollAt = Date.now();
  let last1hBarTs = null, last1dBarTs = null;
  for (;;) {
    if (Date.now() - lastPollAt > POLL_GAP_MIN * 60e3) {
      engine.ledger.log('MISSED_POLL', { engine: 'D', gapMin: +((Date.now() - lastPollAt) / 60e3).toFixed(1) });
    }
    lastPollAt = Date.now();
    try {
      await refresh();
      const next1h = {}, next1d = {};
      // populate next1h/next1d from the FORMING bar's open/close (B+1 open + live close).
      let hourly = false, daily = false;
      for (const { base } of UNIVERSE) {
        const h = engine.hist1h[base];
        if (h && h.length) {
          const ts = h[h.length - 1][0];
          if (last1hBarTs == null) last1hBarTs = ts;
          else if (ts !== last1hBarTs) { hourly = true; last1hBarTs = ts; }
          const f = engine.form1h[base];
          if (f && f.length >= 5) next1h[base] = { open: f[1], close: f[4] };
          else {
            next1h[base] = { open: h[h.length - 1][4], close: h[h.length - 1][4] };
            engine.ledger.log('WARN', { msg: `forming 1h bar missing for ${base}, fill falls back to closed-bar close` });
          }
        }
        const d = engine.hist1d[base];
        if (d && d.length) {
          const ts = d[d.length - 1][0];
          if (last1dBarTs == null) last1dBarTs = ts;
          else if (ts !== last1dBarTs) { daily = true; last1dBarTs = ts; }
          const f = engine.form1d[base];
          if (f && f.length >= 5) next1d[base] = { open: f[1], close: f[4] };
          else {
            next1d[base] = { open: d[d.length - 1][4], close: d[d.length - 1][4] };
            engine.ledger.log('WARN', { msg: `forming 1d bar missing for ${base}, fill falls back to closed-bar close` });
          }
        }
      }
      if (!hourly && !daily) {
        // Engine D patch 1 (live leg): probe every open medium-long at the LIVE
        // price on EVERY poll between 1h decisions (C_POLL cadence) and fire the
        // TP at the touch. STOP/TRAIL/TP-at-hour stay on the 1h clock (step()).
        // This runs strictly before the next hourly step, so a probe-closed
        // position is already out of the ledger when the hourly exits run — no
        // double-close, no boundary re-evaluation.
        engine.probeOpenMediumLongs(Date.now(), (b) => {
          const f = engine.form1h[b];
          if (f && f.length >= 5) return f[4];               // forming bar close = live price
          const h = engine.hist1h[b];
          return h && h.length ? h[h.length - 1][4] : 0;
        });
        await new Promise(r => setTimeout(r, POLL * 1000)); continue;
      }
      engine.step({ now: Date.now(), hourly, daily, next1h, next1d });
    } catch (e) { engine.ledger.log('ERR', { msg: e.message }); }
    await new Promise(r => setTimeout(r, POLL * 1000));
  }
}

// ---------------------------------------------------------------------------
// REPLAY — offline, against cached data (proves the decision logic runs).
//   --replay-daily : slow-long over cache_multi_3y_1d.json (3y daily).
//   --replay       : Engine D full-window REALISTIC replay — the V6B driver
//                    wiring (/tmp/replay_c_v6b.js, Bernard 2026-09-25): 5m bars,
//                    08-31T15:17:18Z start (570), 09-03 capital reset 570->1140,
//                    1h decision cadence, live-TP probe on every 5m boundary
//                    strictly before each tick (TP only; STOP/TRAIL hourly; no
//                    trailHi mutation), realistic costs (maker2/taker5 frozen in
//                    papercore, slip 5bps, funding 1bp shorts, 1x gross cap).
// ---------------------------------------------------------------------------
function upperBound(arr, ts) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= ts) lo = m + 1; else hi = m; } return lo; }
function build4h(bars) {
  const out = []; const byK = new Map();
  for (const c of bars) { const k = Math.floor(c[0] / BAR_MS); if (!byK.has(k)) byK.set(k, []); byK.get(k).push(c); }
  for (const k of [...byK.keys()].sort((a, b) => a - b)) {
    const cs = byK.get(k);
    out.push([k * BAR_MS, cs[0][1], Math.max(...cs.map(c => c[2])), Math.min(...cs.map(c => c[3])), cs[cs.length - 1][4], cs.reduce((a, c) => a + c[5], 0)]);
  }
  return out;
}
// complete-bucket aggregation from 5m bars (same semantics as /tmp/geom_common.js
// buildSeries: a bucket with < tfMs/5m complete bars is dropped).
function buildSeries(bars, tfMs) {
  const out = []; const byK = new Map();
  for (const c of bars) {
    const k = Math.floor(c[0] / tfMs);
    if (!byK.has(k)) byK.set(k, []);
    byK.get(k).push(c);
  }
  for (const k of [...byK.keys()].sort((a, b) => a - b)) {
    const cs = byK.get(k);
    if (cs.length < tfMs / ATOM_MS) continue;
    out.push([k * tfMs, cs[0][1], Math.max(...cs.map(c => c[2])), Math.min(...cs.map(c => c[3])), cs[cs.length - 1][4], cs.reduce((a, c) => a + c[5], 0)]);
  }
  return out;
}

function runDailyReplay() {
  const dailyFull = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache_multi_3y_1d.json'), 'utf8')).coins;
  const bases = UNIVERSE.map(u => u.base).filter(b => dailyFull[b] && dailyFull[b].length >= 200);
  const stateFile = '/tmp/pfD_replay_daily_state.json';
  try { fs.rmSync(stateFile, { force: true }); fs.rmSync(stateFile + 'l', { force: true }); } catch {}
  let clockNow = 0;
  const engine = new EngineD({
    clock: () => clockNow, state: stateFile, startUsdt: 1140, replay: true,
    // slow-long 3y acceptance test isolates the Donchian/SMA logic; the 4h regime
    // cannot be computed from daily-only data, so it is force-gated BULL.
    forceRegime: { state: 'BULL', breadth: 0.6, nValid: 24, nAbove: 14, btc: { last: 1, f: 1, s: 1 }, btcTrend: 0 },
  });
  engine.hist1d = {}; // fresh object — never alias the full source (truncation must not mutate it)
  for (const b of bases) engine.freshAt[b] = Date.now();

  const tset = new Set();
  for (const b of bases) for (let i = 200; i < dailyFull[b].length - 1; i++) tset.add(dailyFull[b][i][0]);
  const times = [...tset].sort((a, b) => a - b);

  for (const ts of times) {
    clockNow = ts;
    const next1d = {};
    for (const b of bases) {
      const arr = dailyFull[b];                    // full source, never mutated
      const idx = upperBound(arr, ts);             // bars with ts <= decision bar
      engine.hist1d[b] = arr.slice(0, idx);        // no-lookahead feed
      if (idx < arr.length) next1d[b] = { open: arr[idx][1], close: arr[idx][4] };
    }
    engine.step({ now: ts, daily: true, hourly: false, next1h: {}, next1d });
  }
  const s = engine.stats.slowLong;
  log('=== slow-long 3y replay (cache_multi_3y_1d.json) ===');
  log(`trades=${s.n} wins=${s.wins} hitRate=${s.n ? (s.wins / s.n).toFixed(2) : 'n/a'}`);
  log(`pnlRealOpen=${s.pnlRealOpen.toFixed(2)}  pnlFantasy=${s.pnlFantasy.toFixed(2)}  pnlRealClose=${s.pnlRealClose.toFixed(2)}`);
  log(`fillQualityDelta=${s.fillQualityDelta.toFixed(2)}`);
  log(`fees=${engine.stats.fees.toFixed(2)} slippage=${engine.stats.slippage.toFixed(2)} funding=${engine.stats.funding.toFixed(2)}`);
  log(`final equity=${engine.ledger.equity(engine.getPx.bind(engine)).toFixed(2)}`);
}

function runFiveReplay() {
  // Engine D full-window realistic replay — exact V6B driver semantics (full
  // decision-parity requirement, Bernard 2026-09-25): the sequence at each 1h
  // tick is (1) intra-hour live-TP probes at every 5m boundary strictly BEFORE
  // the tick (probe close = last 5m bar with ts+300s <= t, no lookahead; ATR/
  // TP target from this.hist1h fed at the PREVIOUS tick = last closed 1h bar),
  // (2) the 09-03 capital reset once at the first tick >= RESET_TS, (3) the
  // normal engine step with closed-bar feeds. Probe-closed positions are gone
  // before the hourly exits run and the 5m bar closing at te is never probed
  // (probeTs < te strictly) — no exit is double-handled at the boundary.
  const RUN_START = Date.parse('2026-08-31T15:17:18.830Z');  // == /tmp/geom_common.js
  const RESET_TS = Date.parse('2026-09-03T14:44:32.154Z');   // == /tmp/geom_common.js
  const START_CAP = 570, RESET_CAP = 1140;                   // == /tmp/geom_common.js
  const fiveFile = process.env.C_FIVE_FILE || path.join(REPLAY_DATA_DIR, 'pfB_replay_five_full.json');
  const cache = JSON.parse(fs.readFileSync(fiveFile, 'utf8'));
  const five = cache.data;
  const bases = UNIVERSE.map(u => u.base).filter(b => five[b] && five[b].length >= 200);
  const s1 = {}, s4 = {};
  for (const b of bases) { s1[b] = buildSeries(five[b], H1_MS); s4[b] = buildSeries(five[b], BAR_MS); }
  const ref = bases.includes('BTC') ? 'BTC' : bases[0];
  const ticks = s1[ref].map(c => c[0] + H1_MS).filter(te => te > RUN_START);
  const probeTs = five[ref].map(c => c[0] + ATOM_MS).filter(t => t > RUN_START && t <= ticks[ticks.length - 1]);

  const stateFile = '/tmp/pfD_replay_five_state.json';
  try { fs.rmSync(stateFile, { force: true }); fs.rmSync(stateFile + 'l', { force: true }); } catch {}
  let clockNow = RUN_START;
  const engine = new EngineD({ clock: () => clockNow, state: stateFile, startUsdt: START_CAP, replay: true });

  log(`=== Engine D full-window realistic replay (${fiveFile}) ===`);
  log(`bases=${bases.length} ticks=${ticks.length} probes=${probeTs.length} from ${new Date(ticks[0]).toISOString()} to ${new Date(ticks[ticks.length - 1]).toISOString()}`);

  let resetDone = false;
  let pi = 0;
  for (const te of ticks) {
    // ---- intra-hour LIVE TP probes: every 5m boundary t in (tePrev, te) ----
    while (pi < probeTs.length && probeTs[pi] < te) {
      const t = probeTs[pi];
      clockNow = t; // monotonic realistic clock (cooldowns/funding-index stay correct)
      for (const b of Object.keys(engine.ledger.data.coins)) {
        if (engine.ledger.data.coins[b].leg !== 'mediumLong') continue;
        const ii = upperBound(five[b], t - ATOM_MS) - 1;
        const c = five[b][ii]; if (!c) continue;             // ts+300s <= t guaranteed
        engine.probeMediumLongTP(b, t, c[4], c[0]);
      }
      pi++;
    }
    // ---- decision tick: V6B baseline step ----
    clockNow = te;
    if (!resetDone && te >= RESET_TS) {
      resetDone = true;
      for (const b of Object.keys(engine.ledger.data.coins)) {
        const px = (() => { const a = s1[b]; const i = upperBound(a, te - H1_MS) - 1; return a[i] ? a[i][4] : 0; })();
        if (px) engine.ledger.close(b, px, 'RESET');
      }
      engine.ledger.data.usdt = RESET_CAP;
      engine.ledger.data.mediumLongCooldown = {};
      engine.ledger.data.fastShortCooldown = {};
      log(`[reset] ${new Date(te).toISOString()} book flattened, capital ${START_CAP}->${RESET_CAP}`);
    }
    const next1h = {};
    for (const b of bases) {
      const a1 = s1[b];
      const i1 = upperBound(a1, te - H1_MS);                  // bars with barEnd <= te (closed)
      engine.hist1h[b] = a1.slice(0, i1);
      if (i1 < a1.length) next1h[b] = { open: a1[i1][1], close: a1[i1][4] };
      const a4 = s4[b];
      engine.hist4h[b] = a4.slice(0, upperBound(a4, te - BAR_MS));
    }
    engine.step({ now: te, daily: false, hourly: true, next1h, next1d: {} });
  }
  const eq = engine.ledger.equity(engine.getPx.bind(engine));
  log('equity:', eq.toFixed(2));
  log('mediumLong:', JSON.stringify(engine.stats.mediumLong));
  log('fastShort:', JSON.stringify(engine.stats.fastShort));
  log('cost:', JSON.stringify({ fees: engine.stats.fees, slippage: engine.stats.slippage, funding: engine.stats.funding }));
  log('ledger ->', stateFile, 'log ->', stateFile.replace('.json', '.jsonl'));
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === '--replay-daily') runDailyReplay();
  else if (mode === '--replay') runFiveReplay();
  else runLive().catch(e => { console.error('FATAL', e); process.exit(1); });
}

module.exports = { EngineD, tradePnl, applySlip, longTpK };
