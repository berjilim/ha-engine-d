'use strict';
// Ares Track B: SHARED paper-forward infrastructure.
// Durable virtual margin ledger (cash + positions, LONG & SHORT with leverage),
// maker/post-only vs taker fill simulation with honest Binance fees.
// Pure JS - no exchange writes. Engines A (daily) & B (intraday) share this so
// their accounting + cost model are IDENTICAL and directly comparable.
const fs = require('fs');

// Binance USDT-M tier0 fees: maker 0.02%, taker 0.05%.
const MAKER = 0.0002, TAKER = 0.0005;

class PaperLedger {
  constructor(opts) {
    this.file = opts.file;
    this.startUsdt = opts.startUsdt;
    this.k = opts.k;          // max concurrent positions
    this.lev = opts.lev || 1; // leverage multiplier (affects risk, not ledger cash)
    this.taker = !!opts.taker; // true = fill at taker fee; false = post-only maker
    this.closeFee = opts.closeFee; // optional OVERRIDE for close()/exits only (undefined = this.fee(); a realistic live 1x path uses TAKER on exits)
    this.fee = () => (this.taker ? TAKER : MAKER);
    this.clock = opts.clock || (() => Date.now()); // event timestamp source (replay passes a simulated clock)
    this.data = { usdt: this.startUsdt, coins: {}, start: this.startUsdt, peak: this.startUsdt };
    // coins[base] = { amt, dir:'LONG'|'SHORT', entry, entryNotional, stop, openedAt }
    // `entry` = blend of FILL PRICES only (fee-exclusive, amt-weighted), so
    // entry/amt is the true blended entry price used for stop/struct/trail/TP
    // geometry. `entryNotional` = full cost incl. fees (LONG) / net credit
    // (SHORT) — the PnL basis used by close().
    this.load();
  }
  load() {
    try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s && typeof s.usdt === 'number') this.data = { ...this.data, ...s }; }
    catch (e) { this.log('LOAD_ERR', { msg: `state corrupt or unreadable (${this.file}): ${e.message}` }); }
  }
  save() { // atomic write: temp file + rename, so a crash mid-write never truncates state
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...this.data, updatedAt: new Date().toISOString() }));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('SAVE_ERR', { msg: `save ${this.file}: ${e.message}` }); }
  }
  logf() { return this.file.replace('.json', '.jsonl'); }
  log(ev, obj) {
    const line = JSON.stringify({ t: new Date(this.clock()).toISOString(), ev, ...obj });
    try { fs.appendFileSync(this.logf(), line + '\n'); } catch {}
    return line;
  }
  // live mark value of one position
  posValue(px, pos) {
    if (pos.dir === 'LONG') return pos.amt * px;
    // SHORT: openShort already credited `entryNotional` (the sale proceeds) to
    // cash, so the position's value here is ONLY the liability we owe to buy it
    // back at current px. Adding entryNotional again would double-count it.
    return -(pos.amt * px);
  }
  portValue(getPx) {
    let v = this.data.usdt;
    for (const b of Object.keys(this.data.coins)) v += this.posValue(getPx(b), this.data.coins[b]);
    return v;
  }
  openLong(base, amt, px) {
    const f = this.fee(), cost = amt * px * (1 + f);
    if (cost > this.data.usdt || Object.keys(this.data.coins).length >= this.k) return false;
    const ex = this.data.coins[base];
    if (ex && ex.dir === 'LONG') {
      // pyramiding an existing long: accumulate size, blend entry upward
      this.data.usdt -= cost;
      ex.entQt = (ex.entQt || ex.entryNotional) + cost;
      ex.amt += amt;
      ex.entry += amt * px; // fee-exclusive, matches fresh openLong (entry/amt = blended fill price)
      ex.entryNotional = ex.entQt;
      ex.pyra = (ex.pyra || 0) + 1;
      return true;
    }
    this.data.usdt -= cost;
    this.data.coins[base] = { amt, dir: 'LONG', entry: amt * px, entryNotional: cost, stop: 0 };
    return true;
  }
  openShort(base, amt, px) {
    const f = this.fee(), credit = amt * px * (1 - f);
    if (Object.keys(this.data.coins).length >= this.k) return false;
    const ex = this.data.coins[base];
    if (ex && ex.dir === 'SHORT') {
      // pyramiding an existing short: accumulate size, blend entry downward
      this.data.usdt += credit;
      ex.entQt = (ex.entQt || ex.entryNotional) + credit;
      ex.amt += amt;
      ex.entry += amt * px; // fee-exclusive, matches fresh openShort (entry/amt = blended fill price)
      ex.entryNotional = ex.entQt;
      ex.pyra = (ex.pyra || 0) + 1;
      return true;
    }
    this.data.usdt += credit;
    this.data.coins[base] = { amt, dir: 'SHORT', entry: amt * px, entryNotional: credit, stop: 0 };
    return true;
  }
  setStop(base, px) { if (this.data.coins[base]) this.data.coins[base].stop = px; }
  // close at fillPx; returns {pnl, reason} or null
  close(base, fillPx, reason) {
    const pos = this.data.coins[base]; if (!pos) return null;
    const f = this.closeFee || this.fee(); // per-close override (Engine B taker exits) else engine's normal fee
    let pnl;
    if (pos.dir === 'LONG') {
      const proceeds = pos.amt * fillPx * (1 - f);
      pnl = proceeds - pos.entryNotional;
      this.data.usdt += proceeds;
    } else {
      const buyback = pos.amt * fillPx * (1 + f);
      pnl = pos.entryNotional - buyback;
      this.data.usdt -= buyback; // openShort already credited entryNotional to cash; here we just pay back the coins
    }
    delete this.data.coins[base];
    this.log('CLOSE', { base, dir: pos.dir, px: fillPx, pnl: +pnl.toFixed(2), reason });
    return { pnl, reason };
  }
  equity(getPx) { return this.portValue(getPx); }
}

module.exports = { PaperLedger, MAKER, TAKER };
