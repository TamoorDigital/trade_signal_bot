const { swingPoints, avgRange } = require('./indicators');

// SL sits just beyond the swept liquidity level (structure), not an arbitrary
// tiny %. Buffer is the LARGER of: 1x the symbol's own typical 5m candle
// range (so ordinary noise/wicks don't tag it), or a 0.12% floor (safety net
// for extremely low-volatility symbols where avgRange could be near zero).
function buildSL(direction, entry, sweepLevel, range5) {
  const buffer = Math.max(range5 * 1.0, entry * 0.0012);
  if (direction === 'short') return sweepLevel.price + buffer;
  return sweepLevel.price - buffer;
}

// TPs sit at the next real structure (swing points on 5m then 15m) beyond
// entry — but a swing point that's only a few ticks from entry isn't a real
// target, it's noise. Minimum distances scale with the symbol's own
// volatility (avg 5m range), so this works whether price is $0.08 or $4,000.
function buildTPs(direction, entry, c5m, c15m, range5) {
  const s5 = swingPoints(c5m);
  const s15 = swingPoints(c15m);

  // TP1 must represent an actual move: at least 1.5x the typical 5m candle
  // range, or 0.3% of price, whichever is larger.
  const minTp1Dist = Math.max(range5 * 1.5, entry * 0.003);
  // Successive TPs must be spaced at least this far apart from each other.
  const minSpacing = Math.max(range5 * 1.0, entry * 0.0015);

  const candidates = direction === 'short'
    ? [...s5.lows, ...s15.lows].filter(p => p.price <= entry - minTp1Dist)
    : [...s5.highs, ...s15.highs].filter(p => p.price >= entry + minTp1Dist);

  const sorted = candidates.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const levels = [];
  for (const c of sorted) {
    if (levels.every(l => Math.abs(l.price - c.price) >= minSpacing)) levels.push(c.price);
    if (levels.length === 3) break;
  }
  // If real structure ran out, extend using the same ATR-scaled step so the
  // fallback levels are just as "real" a distance as structural ones would be.
  while (levels.length < 3) {
    const base = levels.length ? levels[levels.length - 1] : entry;
    const idx = levels.length + 1;
    const step = Math.max(range5 * 1.5, entry * 0.004) * idx;
    levels.push(direction === 'short' ? base - step : base + step);
  }
  return levels;
}

function buildSignal(symbol, candidate, entry, c5m, c15m) {
  const { direction, sweepLevel } = candidate;
  if (!sweepLevel) return null; // SL must be anchored to real structure

  const range5 = avgRange(c5m, 20) || entry * 0.001;
  const sl = buildSL(direction, entry, sweepLevel, range5);
  const tps = buildTPs(direction, entry, c5m, c15m, range5);
  const risk = Math.abs(entry - sl);
  const rr = tps.map(tp => +(Math.abs(tp - entry) / risk).toFixed(2));

  return {
    symbol,
    direction,
    entry,
    sl,
    tps,
    rr, // informational R:R per TP, derived — never a fixed 1:2/1:3 target
    reasons: candidate.reasons,
    sweepLevel: sweepLevel.price,
    score: candidate.score,
    maxScore: candidate.maxScore,
  };
}

module.exports = { buildSignal };
