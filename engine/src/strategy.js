'use strict';

// Multi-asset strategy v2: trend structure + mean-reversion (RSI) + volume
// confirmation. Returns ranked LONG/SHORT/FLAT signals plus indicator values
// (rsi, atr) used for volatility-based position sizing. Pure functions.

const { EMA_FAST_4H, EMA_SLOW_4H, EMA_MOM_1H, RANGE_MIN_PCT, RANGE_MAX_PCT, RSI_PERIOD, RSI_LONG_MAX, RSI_SHORT_MIN, VOL_MA_PERIOD, VOL_CONFIRM_MULT, ATR_PERIOD } = (() => {
  return {
    EMA_FAST_4H: 20, EMA_SLOW_4H: 50, EMA_MOM_1H: 9, RANGE_MIN_PCT: 0.4, RANGE_MAX_PCT: 12,
    RSI_PERIOD: 14, RSI_LONG_MAX: 68, RSI_SHORT_MIN: 32,
    VOL_MA_PERIOD: 20, VOL_CONFIRM_MULT: 1.2, ATR_PERIOD: 14,
  };
})();

// ---- helpers ----
function sma(v, p) { if (v.length < p) return null; const s = v.slice(-p); return s.reduce((a,b)=>a+b,0)/p; }
function ema(v, p) {
  if (v.length < p) return null;
  const k = 2/(p+1); let e = sma(v, p);
  for (let i = v.length-p; i < v.length; i++) e = v[i]*k + e*(1-k);
  return e;
}
function rangePct(closes, p=24) {
  if (closes.length < p) return null;
  const s = closes.slice(-p); const hi = Math.max(...s); const lo = Math.min(...s);
  return ((hi-lo)/s[s.length-1])*100;
}

// RSI (Wilder's smoothing) over closes. Returns 0..100 or null if insufficient.
function rsi(closes, p = RSI_PERIOD) {
  if (closes.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) { const d = closes[closes.length - p - 1 + i] - closes[closes.length - p - 1 + i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= p; loss /= p;
  for (let i = closes.length - p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gain = (gain * (p-1) + Math.max(d, 0)) / p;
    loss = (loss * (p-1) + Math.max(-d, 0)) / p;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - (100 / (1 + rs));
}

// ATR (Wilder) over high/low/close candles. Returns absolute ATR or null.
function atr(candles, p = ATR_PERIOD) {
  if (candles.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i-1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, p).reduce((a,b)=>a+b,0) / p;
  for (let i = p; i < trs.length; i++) a = (a * (p-1) + trs[i]) / p;
  return a;
}

// Volume confirmation: is the most recent COMPLETED 1h candle volume above the
// N-candle average by at least CONFIRM_MULT? The last candle in ccxt's OHLCV
// array is still FORMING (partial volume ~0 right after the boundary), so using
// it would false-fire an empty-candle as "weak volume" every hour — a bias we
// don't want in the score. Returns true/false/null.
function volConfirm(candles, p = VOL_MA_PERIOD, mult = VOL_CONFIRM_MULT) {
  if (candles.length < p + 2) return null;
  const completed = candles.slice(0, -1);
  const vols = completed.slice(-(p + 1), -1).map(c => c[5]);
  const avg = vols.reduce((a, b) => a + b, 0) / p;
  if (avg <= 0) return null;
  const lastVol = completed[completed.length - 1][5];
  return lastVol >= avg * mult;
}

// Score a coin in [-100, +100]. `candles1h` and `candles4h` are ccxt OHLCV
// arrays: [ts, open, high, low, close, volume]. Uses close for trend/RSI and
// high/low/volume for ATR/volume filters. Returns null if insufficient data.
function scoreCoin(candles1h, candles4h) {
  if (!candles1h || !candles4h || candles1h.length < 120 || candles4h.length < 60) return null;
  const closes1h = candles1h.map(c => c[4]);
  const closes4h = candles4h.map(c => c[4]);
  const f4 = ema(closes4h, EMA_FAST_4H);
  const s4 = ema(closes4h, EMA_SLOW_4H);
  const f1 = ema(closes1h, EMA_MOM_1H);
  const last = closes1h[closes1h.length-1];
  if (f4===null || s4===null || f1===null) return null;

  const rsi14 = rsi(closes1h);
  const atr14 = atr(candles1h);
  const vc = volConfirm(candles1h);
  const rng = rangePct(closes1h);

  // range filter (chop suppression)
  if (rng !== null && rng < RANGE_MIN_PCT) return { score: 0, reason: 'range too tight', rsi: rsi14, atr: atr14 };

  let score = 0; let reason = [];
  // 4h trend layer (dominant weight)
  if (f4 > s4) { score += 40; reason.push('4h bull'); }
  else if (f4 < s4) { score -= 40; reason.push('4h bear'); }
  else reason.push('4h flat');
  // price vs 4h fast EMA
  if (last > f4) { score += 20; reason.push('px>fast4h'); }
  else if (last < f4) { score -= 20; reason.push('px<fast4h'); }
  // 1h momentum layer
  const prev1 = ema(closes1h.slice(0,-1), EMA_MOM_1H);
  if (prev1 !== null) {
    if (f1 > prev1) { score += 15; reason.push('1h mom up'); }
    else if (f1 < prev1) { score -= 15; reason.push('1h mom dn'); }
  }
  if (last > f1) { score += 10; reason.push('px>fast1h'); }
  else if (last < f1) { score -= 10; reason.push('px<fast1h'); }

  // --- v2 confirmations ---
  // RSI overbought suppression: don't chase an overbought LONG; reward a
  // pullback-to-oversold only as a soft positive, never override the trend.
  if (rsi14 !== null) {
    if (score > 0 && rsi14 > RSI_LONG_MAX) { score -= 8; reason.push(`rsi overbought ${rsi14.toFixed(0)}`); }
    else if (score < 0 && rsi14 < RSI_SHORT_MIN) { score += 8; reason.push(`rsi oversold ${rsi14.toFixed(0)}`); }
  }
  // Volume confirmation: only add to the score when the move is backed by volume.
  // SYMMETRIC weights (+6 for confirmed / −6 for weak): a weak-volume move costs a
  // LONG and a SHORT equally. Before 2026-09-11 this was +6/−3, which let LONGs
  // reach +91 while SHORTs capped at −88. Equalizing makes both ceilings ±91, so
  // K+X (|score|>=91) is reachable on either side.
  if (vc === true) { score += 6; reason.push('vol up'); }
  else if (vc === false) { score -= 6; reason.push('vol low'); }

  return { score, reason: reason.join(' '), last, rsi: rsi14, atr: atr14, volConfirm: vc };
}

// Decide direction for a coin from its score.
function direction(score, longT = 50, shortT = -50) {
  if (score >= longT) return 'LONG';
  if (score <= shortT) return 'SHORT';
  return 'FLAT';
}

function rank(all) {
  const longs = Object.entries(all)
    .filter(([,c]) => c.direction === 'LONG')
    .sort((a,b) => b.score - a.score);
  const shorts = Object.entries(all)
    .filter(([,c]) => c.direction === 'SHORT')
    .sort((a,b) => a.score - b.score);
  return { longs, shorts };
}

// Market regime gate. Uses a market proxy (BTC, or a configurable pair) 1d/4h
// trend structure plus breadth to classify the broad regime:
//   BULL  -> longs allowed, shorts disallowed
//   BEAR  -> longs disallowed (sit in cash) / shorts favored
//   RANGE -> stay flat (chop risk high)
// `prox1d` / `prox4h` are ccxt OHLCV arrays for the proxy symbol (default BTC).
// `breadth` is an optional array of {direction} per universe coin (from rank()).
// Returns { trend: 'BULL'|'RANGE'|'BEAR', score, reason }.
function marketRegime(prox1d, prox4h, breadth) {
  if (!prox1d || !prox4h || prox1d.length < 30 || prox4h.length < 60) return { trend: 'RANGE', score: 0, reason: 'nodata' };
  const c1d = prox1d.map(c => c[4]);
  const c4h = prox4h.map(c => c[4]);
  const f1d = ema(c1d, 20), s1d = ema(c1d, 50);
  const f4h = ema(c4h, 20), s4h = ema(c4h, 50);
  const last = c1d[c1d.length - 1];
  if (f1d === null || s1d === null || f4h === null || s4h === null) return { trend: 'RANGE', score: 0, reason: 'nodata' };
  const rng = rangePct(c1d, 30); // 30-day range of the proxy
  let score = 0, reason = [];
  if (f1d > s1d) { score += 40; reason.push('1d bull'); }
  else if (f1d < s1d) { score -= 40; reason.push('1d bear'); }
  else reason.push('1d flat');
  if (f4h > s4h) { score += 25; reason.push('4h bull'); }
  else if (f4h < s4h) { score -= 25; reason.push('4h bear'); }
  if (last > f1d) { score += 15; reason.push('px>1d'); }
  else if (last < f1d) { score -= 15; reason.push('px<1d'); }
  // breadth: fraction of universe coins currently LONG vs SHORT
  if (Array.isArray(breadth) && breadth.length) {
    const longShare = breadth.filter(b => b.direction === 'LONG').length / breadth.length;
    const shortShare = breadth.filter(b => b.direction === 'SHORT').length / breadth.length;
    if (longShare > 0.4) { score += 20; reason.push(`breadth${Math.round(longShare*100)}`); }
    else if (shortShare > 0.4) { score -= 20; reason.push(`breadth-${Math.round(shortShare*100)}`); }
  }
  if (rng !== null) {
    if (rng < 3) { score *= 0; reason.push('range'); } // tight chop → stand aside
  }
  let trend = 'RANGE';
  if (score >= 40) trend = 'BULL';
  else if (score <= -40) trend = 'BEAR';
  return { trend, score, reason: reason.join(' ') };
}

// Universe breadth gate: allow longs when >= threshold fraction of universe coins
// have a positive raw score. Replaces the falsified BTC-proxy marketRegime gate.
// `scores` = {base: {score, ...}} from the scoring sweep.
function breadthGate(scores, threshold = 0.40) {
  const entries = Object.values(scores).filter(s => s && typeof s.score === 'number');
  if (!entries.length) return { allow: true, bullishFraction: 0.5 };
  const bullish = entries.filter(e => e.score > 0).length;
  const bullishFraction = bullish / entries.length;
  return { allow: bullishFraction >= threshold, bullishFraction };
}

// Cross-sectional relative-strength scorer (v3 signal). Ranks a coin by its
// N-bar price return relative to the pre-sorted universe peer returns.
// `candles1h`: 1h OHLCV array (most recent last). `sortedPeerReturns`: sorted
// array of all universe coins' returns over the same lookback (for percentile).
// `lookbackBars`: how many 1h bars to look back (default 48 = 48h).
// Returns {score, ret, rank, atr} or null if insufficient data.
// score maps percentile rank 0-1 to -100..+100; use direction() with appropriate
// threshold (e.g. direction(score, 50) where rank=0.75 gives score=50).
function scoreRS(candles1h, sortedPeerReturns, lookbackBars = 48) {
  if (!candles1h || candles1h.length < lookbackBars + 2) return null;
  const closes = candles1h.map(c => c[4]);
  const pxNow = closes[closes.length - 1];
  const pxPrev = closes[closes.length - 1 - lookbackBars];
  if (!pxPrev || pxPrev <= 0) return null;
  const ret = (pxNow - pxPrev) / pxPrev;
  const nR = sortedPeerReturns.length;
  const rank = nR > 0 ? sortedPeerReturns.filter(r => ret > r).length / nR : 0.5;
  const score = (rank - 0.5) * 200; // rank 0.75 → score 50 (LONG threshold)
  const atr14 = atr(candles1h);
  return { score, ret, rank, atr: atr14 };
}

module.exports = {
  scoreCoin, direction, rank, marketRegime, breadthGate, scoreRS,
  rsi, atr, volConfirm,
  EMA_FAST_4H, EMA_SLOW_4H, EMA_MOM_1H, RSI_PERIOD, RSI_LONG_MAX, RSI_SHORT_MIN,
  VOL_MA_PERIOD, VOL_CONFIRM_MULT, ATR_PERIOD,
};
