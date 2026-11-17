const { swingPoints, avgRange } = require('../indicators');
const { clamp01, r1, last } = require('./util');

// Fibonacci strategy, scored 0-10 for ONE direction:
//   Valid confirmed impulse leg   max 3  largest 15M leg in the trade's direction (up-leg for
//                                        long, down-leg for short), >= 4x the 15M avg range
//                                        (1.5 pts, up to 3 pts at 8x). The leg must have ended
//                                        in the last 100 closed 15M bars and not been exceeded
//                                        since. Pivots need 3 closed bars on the right.
//   Pullback enters 0.50-0.786    max 3  deepest retracement in the last 8 closed 5M bars:
//                                        >=0.618 -> 3, >=0.5 -> 2, >=0.382 -> 1 (expiry = 8 bars)
//   Original swing intact          max 1  pullback started (>=0.382) and never reached the leg start
//   5M reversal confirmation       max 3  only counted once the 0.5 level was reached: trade-direction
//                                        candle (1), close beyond the 0.786 level (1), and a
//                                        higher low (lower high for short) than the pullback extreme (1)
// core = the pullback component must be > 0 to pass. Targets = 1.272 / 1.618 extensions.
const LEG_MAX_AGE = 100, PULLBACK_BARS = 8;

function evaluate(direction, c1h, c15m, c5m) {
  const up = direction === 'long';
  const zero = (why) => ({ score: 0, parts: { impulseLeg: 0, zone: 0, swingIntact: 0, confirm5m: 0 }, core: false, reasons: [why], targets: [] });
  const sw = swingPoints(c15m, 3);
  const pts = [...sw.highs.map(p => ({ ...p, type: 'H' })), ...sw.lows.map(p => ({ ...p, type: 'L' }))]
    .filter(p => p.index >= c15m.length - 200).sort((x, y) => x.index - y.index);
  const rng = avgRange(c15m, 20), minLeg = 4 * rng;
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.type === b.type || b.type !== (up ? 'H' : 'L')) continue;
    const size = Math.abs(b.price - a.price);
    if (b.index < c15m.length - LEG_MAX_AGE || size < minLeg || (best && size <= best.size)) continue;
    const after = c15m.slice(b.index + 1);
    if (up ? after.some(c => c.high > b.price) : after.some(c => c.low < b.price)) continue; // leg was extended
    best = { start: a, end: b, size };
  }
  if (!best) return zero(`no valid ${up ? 'bullish' : 'bearish'} impulse leg`);

  const { start, end, size: leg } = best;
  const at = (r) => (up ? end.price - r * leg : end.price + r * leg);
  const w = c5m.slice(-PULLBACK_BARS), c = last(c5m);
  const extreme = up ? Math.min(...w.map(x => x.low)) : Math.max(...w.map(x => x.high));
  const maxRetrace = up ? (end.price - extreme) / leg : (extreme - end.price) / leg;

  const legPts = 1.5 + 1.5 * clamp01((leg - minLeg) / minLeg);
  const zone = maxRetrace >= 1 ? 0 : maxRetrace >= 0.618 ? 3 : maxRetrace >= 0.5 ? 2 : maxRetrace >= 0.382 ? 1 : 0;
  const intact = maxRetrace >= 0.382 && maxRetrace < 1 ? 1 : 0;
  let confirm = 0;
  if (maxRetrace >= 0.5 && maxRetrace < 1) {
    const s = up ? 1 : -1;
    if (s * (c.close - c.open) > 0) confirm += 1;
    if (s * (c.close - at(0.786)) > 0) confirm += 1;
    if (up ? c.low > extreme : c.high < extreme) confirm += 1;
  }
  const parts = { impulseLeg: r1(legPts), zone, swingIntact: intact, confirm5m: confirm };
  const sgn = up ? 1 : -1;
  const targets = [start.price + sgn * 1.272 * leg, start.price + sgn * 1.618 * leg].filter(t => sgn * (t - c.close) > 0);
  return {
    score: r1(parts.impulseLeg + zone + intact + confirm),
    parts,
    core: zone > 0,
    reasons: [`leg ${start.price.toFixed(6)}→${end.price.toFixed(6)}, deepest pullback ${(maxRetrace * 100).toFixed(0)}% (zone ${at(0.5).toFixed(6)}-${at(0.786).toFixed(6)}), 5M confirm ${confirm}/3`],
    targets,
  };
}

module.exports = { evaluate };
