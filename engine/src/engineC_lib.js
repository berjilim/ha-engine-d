'use strict';
// Engine C — pure, deterministic indicator helpers. No I/O, no ledger, no state.
// Every function takes a candle array and returns a value (or null if insufficient
// data). Candle schema is CCXT OHLCV: [ts, open, high, low, close, volume]
// (indexes: open=1, high=2, low=3, close=4, volume=5). The 1d replay cache uses
// [ts, open, high, low, close, baseVol, quoteVol, trades] — close=4, high=2,
// low=3, so the same index positions hold for both sources.

// Simple moving average of the last `period` values, or null if too few.
function sma(values, period) {
  if (!values || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

// Standard EMA over the last `period` values, seeded with their SMA. k = 2/(p+1).
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = sma(values, period);
  for (let i = values.length - period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// EMA with an explicit smoothing constant k, seeded with the SMA of the FIRST
// `period` values (used by the fast-short 200-EMA, k = 2/201).
function emaK(values, period, k) {
  if (!values || values.length < period) return null;
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Wilder recursive ATR(14) over 1h candles. BYTE-FAITHFUL to paper_B.js coinATR:
// seed = simple mean of the first 14 true ranges, then a = (a*13 + tr)/14.
// Returns an absolute value or null if there aren't enough bars (needs >= 42).
function coinATR(candles) {
  if (!candles || candles.length < 42) return null;
  let a = 0, ok = false;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i][2] - candles[i][3],
      Math.abs(candles[i][2] - candles[i - 1][4]),
      Math.abs(candles[i][3] - candles[i - 1][4])
    );
    if (i <= 14) a += tr;
    else { if (!ok) { a /= 14; ok = true; } a = (a * 13 + tr) / 14; }
  }
  return ok ? a : null;
}

// Fast-short 200-EMA (1h close), k = 2/201, seeded with the SMA of the first 200 closes.
function ema200(closes) { return emaK(closes, 200, 2 / 201); }

// Fade veto: is the coin's latest CLOSED 4h close below its 20-EMA(4h close)?
// BYTE-FAITHFUL to paper_B.js priceBelowFast4h (computed over closed bars only).
function priceBelowFast4h(candles4h) {
  if (!candles4h || candles4h.length < 21) return false;
  const closes = candles4h.map(c => c[4]);
  const k = 2 / 21;
  let e = sma(closes, 20);
  for (let i = closes.length - 20; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return closes[closes.length - 1] < e;
}

// Simple mean of the last `period` values (no null handling beyond length check).
// NOTE: this INCLUDES the most recent bar — use priorMean() when the current bar
// must be excluded (e.g. a "trailing average before the breaker bar").
function smaOf(candles, period, idx) {
  if (!candles || candles.length < period) return null;
  let s = 0;
  for (let i = candles.length - period; i < candles.length; i++) s += candles[i][idx];
  return s / period;
}

// Rolling window min/max/mean of a candle field over the `n` bars STRICTLY before
// the last (most recent) bar. The last bar is excluded by design (it is the
// breaker). Returns null if insufficient bars (need n + 1 bars total).
function priorMin(candles, n, idx) {
  if (!candles || candles.length < n + 1) return null;
  let lo = Infinity;
  for (let i = candles.length - 1 - n; i <= candles.length - 2; i++) lo = Math.min(lo, candles[i][idx]);
  return lo;
}
function priorMax(candles, n, idx) {
  if (!candles || candles.length < n + 1) return null;
  let hi = -Infinity;
  for (let i = candles.length - 1 - n; i <= candles.length - 2; i++) hi = Math.max(hi, candles[i][idx]);
  return hi;
}
function priorMean(candles, n, idx) {
  if (!candles || candles.length < n + 1) return null;
  let s = 0;
  for (let i = candles.length - 1 - n; i <= candles.length - 2; i++) s += candles[i][idx];
  return s / n;
}

module.exports = { sma, ema, emaK, coinATR, ema200, priceBelowFast4h, smaOf, priorMin, priorMax, priorMean };
