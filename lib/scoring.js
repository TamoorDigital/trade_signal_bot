const { ema, rsi, swingPoints, findFVGs, avgVolume, avgRange } = require('./indicators');

// Rebalanced a THIRD time 2026-09-05 after a 31-trade review (independently
// verified against the raw data, not just trusted from the Gemini summary):
// trendRegime averaged 97.3% of its weight in losses vs only 57.5% in strict
// full-wins — i.e. the more "trend-aligned" a setup looked on this metric,
// the MORE likely it was to lose (likely entries on an already-overextended
// trend). CHoCH/MSS showed the cleanest positive signal (83.3% wins vs 57.7%
// losses). Moved weight from trendRegime into choch. Total stays 93.
// liquiditySweep's signal flipped direction again vs the prior round — left
// its weight untouched since a flipping signal isn't one to chase yet.
// Rebalanced a FOURTH time 2026-09-07 after an 82-trade review (post the
// feedback.js weight-sync bug fix — see the changelog). freshPOI and htfBias
// have now shown positive separation across multiple rounds; crtTbs and
// liquiditySweep have shown NEGATIVE separation (higher in losses) across
// two independent rounds each. bos/choch/momentumVolume/trendRegime were
// left untouched — their signal direction flipped round to round, which is
// itself evidence they're not stable enough to chase further right now.
const WEIGHTS = {
  htfBias: 17,          // was 15 — confirmed positive twice
  trendRegime: 8,
  freshPOI: 24,          // was 22 — confirmed positive twice
  liquiditySweep: 9,    // was 11 — confirmed negative twice
  bos: 15,
  choch: 9,
  crtTbs: 2,             // was 4 — confirmed negative twice
  momentumVolume: 7,
  candlePattern: 2,
};
const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0); // 93

const clamp01 = (x) => Math.max(0, Math.min(1, x));
// Turns a 0..1 "how strong is this condition" number into points out of `weight`.
const graded = (weight, strength) => +(weight * clamp01(strength)).toFixed(2);

function lastSwingHigh(swings, before) {
  const h = swings.highs.filter(s => s.index < before);
  return h.length ? h[h.length - 1] : null;
}
function lastSwingLow(swings, before) {
  const l = swings.lows.filter(s => s.index < before);
  return l.length ? l[l.length - 1] : null;
}

function isBullishEngulfing(a, b) {
  return b.close > b.open && a.close < a.open && b.close >= a.open && b.open <= a.close;
}
function isBearishEngulfing(a, b) {
  return b.close < b.open && a.close > a.open && b.close <= a.open && b.open >= a.close;
}
// Returns 0..1 "how good a pin bar" instead of true/false.
function pinBarStrength(c, direction) {
  const range = c.high - c.low || 1e-9;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const wick = direction === 'long' ? lowerWick : upperWick;
  const wickRatio = wick / range;      // want > 0.5
  const bodyRatio = body / range;      // want < 0.4
  if (wickRatio <= 0.5 || bodyRatio >= 0.4) return 0;
  return clamp01((wickRatio - 0.5) / 0.4);
}
// Returns 0..1 "how good an engulfing candle" instead of true/false.
function engulfingStrength(a, b, direction) {
  const isEngulf = direction === 'long' ? isBullishEngulfing(a, b) : isBearishEngulfing(a, b);
  if (!isEngulf) return 0;
  const aBody = Math.abs(a.close - a.open) || 1e-9;
  const bBody = Math.abs(b.close - b.open);
  return clamp01((bBody / aBody - 1)); // 2x the prior body = full score
}

// Evaluate one candidate direction ('long' or 'short') against the three timeframes.
// Every criterion returns partial credit (0..weight) based on how strong the
// condition is, not just whether it technically passed.
function evaluateDirection(direction, c1h, c15m, c5m) {
  const reasons = [];
  const breakdown = {};
  const sign = direction === 'long' ? 1 : -1;

  // 1) HTF bias (1h) — graded by EMA gap size, price distance from EMA200,
  //    and how consistently recent 1h swings confirm the trend.
  const closes1h = c1h.map(c => c.close);
  const ema200_1h = ema(closes1h, 200);
  const ema50_1h = ema(closes1h, 50);
  const last1h = closes1h.length - 1;
  const price1h = closes1h[last1h];
  const emaGapPct = sign * (ema50_1h[last1h] - ema200_1h[last1h]) / price1h;
  const distPct = sign * (price1h - ema200_1h[last1h]) / price1h;
  const swings1h = swingPoints(c1h);
  const priorHighs1h = swings1h.highs.slice(-3);
  const priorLows1h = swings1h.lows.slice(-3);
  let structureFrac = 0;
  if (direction === 'long' && priorHighs1h.length >= 2) {
    let ok = 0;
    for (let i = 1; i < priorHighs1h.length; i++) if (priorHighs1h[i].price >= priorHighs1h[i - 1].price) ok++;
    structureFrac = ok / (priorHighs1h.length - 1);
  } else if (direction === 'short' && priorLows1h.length >= 2) {
    let ok = 0;
    for (let i = 1; i < priorLows1h.length; i++) if (priorLows1h[i].price <= priorLows1h[i - 1].price) ok++;
    structureFrac = ok / (priorLows1h.length - 1);
  }
  const emaStrength = clamp01(emaGapPct / 0.008);   // 0.8% EMA50/200 gap = full credit
  const distStrength = clamp01(distPct / 0.015);    // 1.5% price/EMA200 distance = full credit
  const htfStrength = 0.4 * emaStrength + 0.3 * distStrength + 0.3 * structureFrac;
  breakdown.htfBias = graded(WEIGHTS.htfBias, htfStrength);
  if (breakdown.htfBias > 0) reasons.push(`1H bias ${direction === 'long' ? 'bullish' : 'bearish'} (${Math.round(htfStrength * 100)}% strength)`);

  // 2) Trend regime on 15m — graded by 15m distance from its own EMA200,
  //    scaled down if it disagrees in direction with the 1h bias.
  const closes15m = c15m.map(c => c.close);
  const ema200_15m = ema(closes15m, 200);
  const last15 = closes15m.length - 1;
  const price15 = closes15m[last15];
  const dist15Pct = sign * (price15 - ema200_15m[last15]) / price15;
  const regimeStrength = clamp01(dist15Pct / 0.012) * (htfStrength > 0 ? 1 : 0.3);
  breakdown.trendRegime = graded(WEIGHTS.trendRegime, regimeStrength);
  if (breakdown.trendRegime > 0) reasons.push(`15M regime aligned with EMA200 (${Math.round(regimeStrength * 100)}%)`);

  // 3) Fresh 15m POI (order block / FVG) — ignores already-invalidated FVGs
  //    and starts counting taps/touches AFTER the FVG's 3rd (creation) candle.
  const fvgs15 = findFVGs(c15m);
  const wantType = direction === 'long' ? 'bullish' : 'bearish';
  const recentStart15 = Math.max(0, c15m.length - 6);
  let poi = null, poiStrength = 0;
  for (const z of fvgs15.filter(f => f.type === wantType)) {
    const fvgDoneIdx = z.index + 1;
    if (fvgDoneIdx >= c15m.length - 1) continue;
    const afterFormation = c15m.slice(fvgDoneIdx + 1, recentStart15);
    if (afterFormation.some(c => direction === 'long' ? c.close < z.bottom : c.close > z.top)) continue;

    const eligibleRecent = c15m.slice(Math.max(recentStart15, fvgDoneIdx + 1));
    const touchCandle = eligibleRecent.find(c => direction === 'long'
      ? (c.low <= z.top && c.high >= z.bottom && c.close >= z.bottom)
      : (c.high >= z.bottom && c.low <= z.top && c.close <= z.top));
    if (!touchCandle) continue;

    const zoneHeight = z.top - z.bottom || 1e-9;
    const penetration = direction === 'long'
      ? clamp01((z.top - Math.max(z.bottom, touchCandle.low)) / zoneHeight)
      : clamp01((Math.min(z.top, touchCandle.high) - z.bottom) / zoneHeight);
    const priorTaps = afterFormation.filter(c => direction === 'long'
      ? (c.low <= z.top && c.high >= z.bottom)
      : (c.high >= z.bottom && c.low <= z.top)).length;
    const freshness = clamp01(1 - 0.35 * priorTaps);
    const penScore = clamp01(0.35 + 0.65 * penetration);
    const strength = 0.6 * freshness + 0.4 * penScore;
    if (strength > poiStrength) { poiStrength = strength; poi = z; }
  }
  breakdown.freshPOI = poi ? graded(WEIGHTS.freshPOI, poiStrength) : 0;
  if (poi) reasons.push(`15M ${wantType} FVG reached, $${poi.bottom.toFixed(4)}-$${poi.top.toFixed(4)} (${Math.round(poiStrength * 100)}% quality)`);

  // 4) 5m liquidity sweep — searches newest-to-oldest over the last 16 bars
  //    for a sweep of an unbroken swing high/low whose sweep extreme hasn't
  //    been invalidated by a subsequent close.
  const swings5 = swingPoints(c5m);
  const c5last = c5m.length - 1;
  const range5 = avgRange(c5m, 20) || 1e-9;
  let sweepLevel = null, sweepBar = -1, sweepStrength = 0;
  const firstCandleIdx = Math.max(5, c5last - 15);
  for (let i = c5last; i >= firstCandleIdx; i--) {
    const c = c5m[i];
    const pivs = (direction === 'short' ? swings5.highs : swings5.lows)
      .filter(s => s.index < i - 2 && s.index >= i - 50);
    let matched = null, str = 0;
    for (let k = pivs.length - 1; k >= 0; k--) {
      const p = pivs[k];
      let alreadyBroken = false;
      for (let j = p.index + 3; j < i; j++) {
        if (direction === 'short' ? c5m[j].close > p.price : c5m[j].close < p.price) {
          alreadyBroken = true; break;
        }
      }
      if (alreadyBroken) continue;

      const swept = direction === 'short'
        ? (c.high > p.price && c.close < p.price)
        : (c.low < p.price && c.close > p.price);
      if (!swept) continue;

      const extremePrice = direction === 'short' ? c.high : c.low;
      let invalidated = false;
      for (let j = i + 1; j <= c5last; j++) {
        if (direction === 'short' ? c5m[j].close > extremePrice : c5m[j].close < extremePrice) {
          invalidated = true; break;
        }
      }
      if (invalidated) continue;

      const depth = clamp01((direction === 'short' ? (c.high - p.price) : (p.price - c.low)) / (0.5 * range5));
      const closeBack = clamp01((direction === 'short' ? (p.price - c.close) : (c.close - p.price)) / (0.5 * range5));
      str = 0.45 * depth + 0.55 * closeBack;
      matched = p;
      break;
    }
    if (matched) {
      sweepLevel = matched;
      sweepBar = i;
      sweepStrength = str;
      break;
    }
  }
  breakdown.liquiditySweep = sweepLevel ? graded(WEIGHTS.liquiditySweep, sweepStrength) : 0;
  if (sweepLevel) reasons.push(`5M liquidity sweep of ${direction === 'short' ? 'high' : 'low'} at $${sweepLevel.price.toFixed(4)} (${Math.round(sweepStrength * 100)}%)`);

  // 5) 5m BOS — break of the last opposite swing before the sweep, confirmed by
  //    any close from the sweep candle onward (so BOS stays valid on retests).
  let bosPoint = null, bosStrength = 0;
  if (sweepLevel) {
    bosPoint = direction === 'short' ? lastSwingLow(swings5, sweepBar) : lastSwingHigh(swings5, sweepBar);
    if (bosPoint) {
      let maxBreak = 0;
      for (let j = sweepBar; j <= c5last; j++) {
        const cl = c5m[j].close;
        const breakDist = direction === 'short' ? (bosPoint.price - cl) : (cl - bosPoint.price);
        if (breakDist > maxBreak) maxBreak = breakDist;
      }
      bosStrength = clamp01(maxBreak / (0.8 * range5));
    }
  }
  breakdown.bos = bosPoint ? graded(WEIGHTS.bos, bosStrength) : 0;
  if (breakdown.bos > 0) reasons.push(`5M BOS through $${bosPoint.price.toFixed(4)} (${Math.round(bosStrength * 100)}% of avg range)`);

  // 6) CHoCH/MSS — graded by how consistently the structure point that was
  //    broken belonged to an opposite-direction micro-trend.
  let chochStrength = 0;
  if (bosPoint && breakdown.bos > 0) {
    const priorLows = swings5.lows.filter(s => s.index < bosPoint.index).slice(-3);
    const priorHighs = swings5.highs.filter(s => s.index < bosPoint.index).slice(-3);
    if (direction === 'short' && priorLows.length >= 2) {
      let ok = 0;
      for (let i = 1; i < priorLows.length; i++) if (priorLows[i].price >= priorLows[i - 1].price) ok++;
      chochStrength = ok / (priorLows.length - 1);
    } else if (direction === 'long' && priorHighs.length >= 2) {
      let ok = 0;
      for (let i = 1; i < priorHighs.length; i++) if (priorHighs[i].price <= priorHighs[i - 1].price) ok++;
      chochStrength = ok / (priorHighs.length - 1);
    }
  }
  breakdown.choch = graded(WEIGHTS.choch, chochStrength);
  if (breakdown.choch > 0) reasons.push(`5M CHoCH confirms character shift (${Math.round(chochStrength * 100)}%)`);

  // 6b) CRT/TBS confirmation — uses the last completed 15m candle as the
  //     "range". CRT: a 5m candle wicks beyond that range and closes back
  //     inside. TBS (stronger): the raiding candle's OPEN (not just wick) was
  //     also outside the range, i.e. a full-body sweep with reversal close.
  const rangeCandle = c15m[c15m.length - 2];
  const rangeHigh = rangeCandle.high, rangeLow = rangeCandle.low;
  const rangeSize = (rangeHigh - rangeLow) || 1e-9;
  const recentForCRT = c5m.slice(-8);
  let crtTbsStrength = 0;
  for (const raid of recentForCRT) {
    let crtStrength = 0, tbsStrength = 0;
    if (direction === 'short' && raid.high > rangeHigh) {
      const wickDepth = clamp01((raid.high - rangeHigh) / rangeSize);
      const closeBack = clamp01((rangeHigh - raid.close) / rangeSize);
      crtStrength = 0.5 * wickDepth + 0.5 * closeBack;
      const bodyOutside = raid.open > rangeHigh ? 1 : 0;
      tbsStrength = bodyOutside * closeBack;
    } else if (direction === 'long' && raid.low < rangeLow) {
      const wickDepth = clamp01((rangeLow - raid.low) / rangeSize);
      const closeBack = clamp01((raid.close - rangeLow) / rangeSize);
      crtStrength = 0.5 * wickDepth + 0.5 * closeBack;
      const bodyOutside = raid.open < rangeLow ? 1 : 0;
      tbsStrength = bodyOutside * closeBack;
    }
    const combined = 0.5 * crtStrength + 0.5 * tbsStrength;
    if (combined > crtTbsStrength) crtTbsStrength = combined;
  }
  breakdown.crtTbs = graded(WEIGHTS.crtTbs, crtTbsStrength);
  if (breakdown.crtTbs > 0) reasons.push(`CRT/TBS: 15M range raided + reversal close (${Math.round(crtTbsStrength * 100)}%)`);

  // 7) Momentum + volume — uses closed 5m bars for RSI/avgVolume so a partially
  //    elapsed current candle doesn't artificially zero out volume.
  const closed5 = c5m.length > 21 ? c5m.slice(0, -1) : c5m;
  const r = rsi(closed5, 14);
  const avgVol = avgVolume(closed5, 20) || 1e-9;
  const recentVol = Math.max(closed5[closed5.length - 1].volume, c5m[c5last].volume);
  let momentumStrength = 0;
  if (r !== null && bosPoint && breakdown.bos > 0) {
    const rsiComponent = clamp01((sign * (r - 50)) / 20); // 20 RSI pts past 50 = full credit
    const volComponent = clamp01((recentVol / avgVol - 1) / 1); // 2x avg volume = full credit
    momentumStrength = 0.5 * rsiComponent + 0.5 * volComponent;
  }
  breakdown.momentumVolume = graded(WEIGHTS.momentumVolume, momentumStrength);
  if (breakdown.momentumVolume > 0) reasons.push(`Momentum+volume (RSI ${r ? r.toFixed(1) : '-'}, ${Math.round(momentumStrength * 100)}%)`);

  // 8) Candle pattern — check both latest closed candle and current candle.
  const cc = c5m[c5last], prevc = c5m[c5last - 1], prev2c = c5m[c5last - 2];
  const patternStrength = Math.max(
    pinBarStrength(prevc, direction),
    prev2c ? engulfingStrength(prev2c, prevc, direction) : 0,
    pinBarStrength(cc, direction),
    engulfingStrength(prevc, cc, direction)
  );
  breakdown.candlePattern = graded(WEIGHTS.candlePattern, patternStrength);
  if (breakdown.candlePattern > 0) reasons.push(`Confirming candle pattern (${Math.round(patternStrength * 100)}%)`);

  const score = +Object.values(breakdown).reduce((a, b) => a + b, 0).toFixed(2);
  const scorePercent = +((score / MAX_SCORE) * 100).toFixed(1);
  return { direction, score, maxScore: MAX_SCORE, scorePercent, breakdown, reasons, sweepLevel, bosLevel: bosPoint, poi };
}

// Tries both directions, returns the stronger one.
function computeScore(c1h, c15m, c5m) {
  const long = evaluateDirection('long', c1h, c15m, c5m);
  const short = evaluateDirection('short', c1h, c15m, c5m);
  return long.score >= short.score ? long : short;
}

module.exports = { computeScore, evaluateDirection, WEIGHTS, MAX_SCORE };
