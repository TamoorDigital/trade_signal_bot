const { swingPoints, anchoredVwapSeries } = require('../indicators');
const { r1, last } = require('./util');

// Anchored-VWAP strategy, scored 0-10 for ONE direction:
//   1H swing + impulse AVWAP alignment  max 4  close beyond the swing AVWAP (1.5) and
//                                              beyond the impulse AVWAP (1.5) + the last
//                                              3 closed 1H closes holding the swing AVWAP (1.0)
//   15M pullback / rejection            max 3  touch/penetration of the AVWAP line within
//                                              the last 10 closed bars (1), a close back on
//                                              the right side after it (1), and no close
//                                              lost it since (1)
//   5M retest + candle confirmation     max 3  AVWAP retested within the last 12 5M bars (1),
//                                              latest 5M candle is a trade-direction candle (1),
//                                              and it closed on the right side of the line (1)
// Swing = LONG: last 1H swing low / SHORT: last 1H swing high (pivots need 3 closed
// candles on the right, so nothing is confirmed early). Impulse = biggest-bodied of the
// last 30 1H candles. The 15M touch window (10 bars) is the signal expiry.
// core = the 15M pullback component must be > 0 to pass.
const TOUCH_TOL = 0.0015; // 0.15% tolerance around the line counts as a touch
const PULLBACK_BARS = 10;

function evaluate(direction, c1h, c15m, c5m) {
  const sign = direction === 'long' ? 1 : -1;
  const zero = (why) => ({ score: 0, parts: { align1h: 0, pullback15m: 0, retest5m: 0 }, core: false, reasons: [why] });
  const t0 = c15m[0].time; // anchors older than our 15M window can't be rebuilt accurately
  const sw = swingPoints(c1h, 3);
  const swing = last((direction === 'long' ? sw.lows : sw.highs).filter(s => s.time >= t0));
  if (!swing) return zero('no recent 1H swing anchor');
  const recent = c1h.slice(-30);
  const impulse = recent.reduce((b, c) => (Math.abs(c.close - c.open) > Math.abs(b.close - b.open) ? c : b), recent[0]);

  const sSw1h = anchoredVwapSeries(c1h, swing.time), sImp1h = anchoredVwapSeries(c1h, impulse.time);
  const close1h = last(c1h).close;
  const heldN = c1h.slice(-3).filter((c, k) => { const L = sSw1h[c1h.length - 3 + k]; return L !== null && sign * (c.close - L) > 0; }).length;
  const align = (sign * (close1h - last(sSw1h)) > 0 ? 1.5 : 0) + (sImp1h[c1h.length - 1] !== null && sign * (close1h - last(sImp1h)) > 0 ? 1.5 : 0) + heldN / 3;

  const a = anchoredVwapSeries(c15m, swing.time), b = anchoredVwapSeries(c15m, impulse.time);
  const line = a.map((v, i) => (v === null || b[i] === null ? null : (direction === 'long' ? Math.max(v, b[i]) : Math.min(v, b[i]))));
  const lvl = last(line);
  let pull = 0, retest = 0;
  if (lvl !== null) {
    const n = c15m.length;
    let touch = -1;
    for (let i = n - 1; i >= Math.max(0, n - PULLBACK_BARS); i--) {
      if (line[i] === null) continue;
      if (direction === 'long' ? c15m[i].low <= line[i] * (1 + TOUCH_TOL) : c15m[i].high >= line[i] * (1 - TOUCH_TOL)) { touch = i; break; }
    }
    if (touch !== -1) {
      pull = 1;
      let reclaim = -1;
      for (let i = touch; i < n; i++) { if (line[i] !== null && sign * (c15m[i].close - line[i]) > 0) { reclaim = i; break; } }
      if (reclaim !== -1) {
        pull = 2;
        if (c15m.slice(reclaim).every((c, k) => line[reclaim + k] !== null && sign * (c.close - line[reclaim + k]) > 0)) pull = 3;
      }
    }
    const c = last(c5m);
    if (c5m.slice(-12).some(x => (direction === 'long' ? x.low <= lvl * (1 + TOUCH_TOL) : x.high >= lvl * (1 - TOUCH_TOL)))) retest += 1;
    if (sign * (c.close - c.open) > 0) retest += 1;
    if (sign * (c.close - lvl) > 0) retest += 1;
  }
  const parts = { align1h: r1(align), pullback15m: pull, retest5m: retest };
  return {
    score: r1(parts.align1h + parts.pullback15m + parts.retest5m),
    parts,
    core: pull > 0,
    reasons: [`1H align ${parts.align1h}/4, 15M pullback ${pull}/3, 5M retest ${retest}/3${lvl !== null ? ` (AVWAP ${lvl.toFixed(6)})` : ''}`],
  };
}

module.exports = { evaluate };
