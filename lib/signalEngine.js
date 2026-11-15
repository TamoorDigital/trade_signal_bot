const { swingPoints, avgRange, vwapBands } = require('./indicators');

// Geometry gates (v2). The 112-trade review showed the *recorded* R:R
// (median 0.6 / 1.57 / 3.1, measured from the planned entry) was fiction:
// trades open ~0.3% later at the confirmation price, so the real R:R from
// the actual entry was 0.24 / 1.0 / 2.1. These gates make sure TP2/TP3 are
// actually worth reaching, first at signal time (planned entry, a bit more
// demanding to leave room for the confirmation slippage), then again at
// confirmation time (actual entry).
const PLAN_MIN_RR = { tp2: 1.2, tp3: 2.5 };
const CONFIRM_MIN_RR = { tp2: 1.0, tp3: 2.0 };

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
function buildTPs(direction, entry, c5m, c15m, range5, c1h, vwapLevel) {
  const s5 = swingPoints(c5m);
  const s15 = swingPoints(c15m);
  const s1h = c1h ? swingPoints(c1h) : { highs: [], lows: [] };

  // TP1 must represent an actual move: at least 1.5x the typical 5m candle
  // range, or 0.3% of price, whichever is larger.
  const minTp1Dist = Math.max(range5 * 1.5, entry * 0.003);
  // Successive TPs must be spaced at least this far apart from each other.
  const minSpacing = Math.max(range5 * 1.0, entry * 0.0015);

  const candidates = direction === 'short'
    ? [...s5.lows, ...s15.lows, ...s1h.lows].filter(p => p.price <= entry - minTp1Dist)
    : [...s5.highs, ...s15.highs, ...s1h.highs].filter(p => p.price >= entry + minTp1Dist);
  // VWAP is a natural mean-reversion magnet: use it as a target if it sits on
  // the profit side of entry and is far enough away to be a real target.
  if (vwapLevel && (direction === 'short' ? vwapLevel <= entry - minTp1Dist : vwapLevel >= entry + minTp1Dist)) {
    candidates.push({ price: vwapLevel });
  }

  const sorted = candidates.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const levels = [];
  for (const c of sorted) {
    // BUG FIX 2026-11-13: levels holds plain numbers, but this used l.price
    // (undefined -> NaN -> every() false), so only TP1 ever came from structure
    // and TP2/TP3 were ALWAYS the fallback ladder (112/112 historical trades).
    if (levels.every(l => Math.abs(l - c.price) >= minSpacing)) levels.push(c.price);
    if (levels.length === 3) break;
  }
  return extendLevels(direction, entry, levels, range5);
}

// If real structure ran out, extend using the same ATR-scaled step so the
// fallback levels are just as "real" a distance as structural ones would be.
function extendLevels(direction, entry, levels, range5) {
  while (levels.length < 3) {
    const base = levels.length ? levels[levels.length - 1] : entry;
    const idx = levels.length + 1;
    const step = Math.max(range5 * 1.5, entry * 0.004) * idx;
    levels.push(direction === 'short' ? base - step : base + step);
  }
  return levels;
}

// Re-anchors an existing target ladder to the ACTUAL fill price (the
// confirmation price). Targets that are now too close to (or behind) the
// entry are dropped and the ladder is extended outward, so TP1 is always a
// real move away from where we really got in.
function rebaseTargets(direction, entry, tps, range5) {
  const minTp1Dist = Math.max(range5 * 1.5, entry * 0.003);
  const minSpacing = Math.max(range5 * 1.0, entry * 0.0015);
  const kept = [];
  for (const p of tps) {
    const far = direction === 'short' ? p <= entry - minTp1Dist : p >= entry + minTp1Dist;
    if (far && kept.every(k => Math.abs(k - p) >= minSpacing)) kept.push(p);
  }
  return extendLevels(direction, entry, kept, range5);
}

function computeRR(entry, sl, tps) {
  const risk = Math.abs(entry - sl);
  return tps.map(tp => +(Math.abs(tp - entry) / risk).toFixed(2));
}

function geometryOk(rr, min) {
  return rr[1] >= min.tp2 && rr[2] >= min.tp3;
}

function buildSignal(symbol, candidate, entry, c5m, c15m, c1h) {
  const { direction, sweepLevel } = candidate;
  if (!sweepLevel) return null; // SL must be anchored to real structure

  const range5 = avgRange(c5m, 20) || entry * 0.001;
  const sl = buildSL(direction, entry, sweepLevel, range5);
  const vw = vwapBands(c5m);
  const tps = buildTPs(direction, entry, c5m, c15m, range5, c1h, vw ? vw.vwap : null);
  const rr = computeRR(entry, sl, tps);
  if (!geometryOk(rr, PLAN_MIN_RR)) {
    return { rejected: `R:R too small for TP2/TP3 (rr ${rr.join('/')}, need TP2>=${PLAN_MIN_RR.tp2} TP3>=${PLAN_MIN_RR.tp3})` };
  }

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

module.exports = { buildSignal, rebaseTargets, computeRR, geometryOk, CONFIRM_MIN_RR };
