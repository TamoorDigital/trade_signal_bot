const { swingPoints } = require('./indicators');

// SL sits just beyond the swept liquidity level (structure), not an arbitrary %.
function buildSL(direction, entry, sweepLevel) {
  const buffer = entry * 0.0012; // small pad beyond the wick so noise doesn't tag it
  if (direction === 'short') return sweepLevel.price + buffer;
  return sweepLevel.price - buffer;
}

// TPs sit at the next real structure (swing points on 5m then 15m) beyond entry.
function buildTPs(direction, entry, c5m, c15m) {
  const s5 = swingPoints(c5m);
  const s15 = swingPoints(c15m);
  const candidates = direction === 'short'
    ? [...s5.lows, ...s15.lows].filter(p => p.price < entry)
    : [...s5.highs, ...s15.highs].filter(p => p.price > entry);

  // Dedupe close-together levels, sort by distance from entry (nearest first).
  const sorted = candidates
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const levels = [];
  for (const c of sorted) {
    if (levels.every(l => Math.abs(l.price - c.price) / entry > 0.0015)) levels.push(c.price);
    if (levels.length === 3) break;
  }
  // If structure ran out, extend the last found level proportionally so we still return 3.
  while (levels.length < 3) {
    const base = levels.length ? levels[levels.length - 1] : entry;
    const step = entry * 0.004 * (levels.length + 1);
    levels.push(direction === 'short' ? base - step : base + step);
  }
  return levels;
}

function buildSignal(symbol, candidate, entry, c5m, c15m) {
  const { direction, sweepLevel } = candidate;
  if (!sweepLevel) return null; // SL must be anchored to real structure

  const sl = buildSL(direction, entry, sweepLevel);
  const tps = buildTPs(direction, entry, c5m, c15m);
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
