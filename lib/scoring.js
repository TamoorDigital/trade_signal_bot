const { ema, rsi, swingPoints, findFVGs, avgVolume, avgRange } = require('./indicators');

// Rebalanced 2026-09-02 after a Feedback review of 32 closed trades: losses
// showed very high HTF trend alignment (89-97%) but weak actual SMC trigger
// execution (sweep only 46%, fresh POI only 49%) — trades were entering on
// macro trend alone without real confluence at the entry itself. Moved
// weight from the two trend criteria into the two entry-trigger criteria;
// total stays 93 so MIN_SCORE and everything downstream is unaffected.
const WEIGHTS = {
  htfBias: 15,       // was 20
  trendRegime: 12,   // was 15
  freshPOI: 22,       // was 18
  liquiditySweep: 16, // was 12
  bos: 12,
  choch: 5,
  crtTbs: 4,
  momentumVolume: 5,
  candlePattern: 2,
};
const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0); // 88

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
  const emaStrength = clamp01(emaGapPct / 0.01);   // 1% EMA50/200 gap = full credit
  const distStrength = clamp01(distPct / 0.02);    // 2% price/EMA200 distance = full credit
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
  const regimeStrength = clamp01(dist15Pct / 0.015) * (htfStrength > 0 ? 1 : 0.3);
  breakdown.trendRegime = graded(WEIGHTS.trendRegime, regimeStrength);
  if (breakdown.trendRegime > 0) reasons.push(`15M regime aligned with EMA200 (${Math.round(regimeStrength * 100)}%)`);

  // 3) Fresh 15m POI (order block / FVG) — graded by how deep price
  //    penetrated the zone and how "fresh" it still is (fewer prior taps).
  const fvgs15 = findFVGs(c15m);
  const wantType = direction === 'long' ? 'bullish' : 'bearish';
  const recent15 = c15m.slice(-5);
  let poi = null, poiStrength = 0;
  for (const z of fvgs15.filter(f => f.type === wantType)) {
    const zoneHeight = z.top - z.bottom || 1e-9;
    const touchCandle = recent15.find(c => direction === 'long'
      ? c.low <= z.top && c.low >= z.bottom
      : c.high >= z.bottom && c.high <= z.top);
    if (!touchCandle) continue;
    const penetration = direction === 'long'
      ? clamp01((z.top - touchCandle.low) / zoneHeight)
      : clamp01((touchCandle.high - z.bottom) / zoneHeight);
    const between = c15m.slice(z.index + 1, c15m.length - recent15.length);
    const priorTaps = between.filter(c => direction === 'long'
      ? c.low <= z.top && c.low >= z.bottom
      : c.high >= z.bottom && c.high <= z.top).length;
    const freshness = clamp01(1 - 0.35 * priorTaps);
    const strength = 0.6 * penetration + 0.4 * freshness;
    if (strength > poiStrength) { poiStrength = strength; poi = z; }
  }
  breakdown.freshPOI = poi ? graded(WEIGHTS.freshPOI, poiStrength) : 0;
  if (poi) reasons.push(`15M ${wantType} FVG reached, $${poi.bottom.toFixed(4)}-$${poi.top.toFixed(4)} (${Math.round(poiStrength * 100)}% quality)`);

  // 4) 5m liquidity sweep — graded by wick size beyond the swing point and
  //    how convincingly it closed back inside, relative to typical 5m range.
  const swings5 = swingPoints(c5m);
  const c5last = c5m.length - 1;
  const recent5 = c5m.slice(-6);
  const range5 = avgRange(c5m, 20) || 1e-9;
  let sweepLevel = null, sweepStrength = 0;
  if (direction === 'short') {
    const sh = lastSwingHigh(swings5, c5last - 1);
    if (sh) {
      const sweepCandle = recent5.find(c => c.high > sh.price);
      if (sweepCandle) {
        const depth = clamp01((sweepCandle.high - sh.price) / range5);
        const closeBack = clamp01((sh.price - sweepCandle.close) / range5);
        sweepStrength = 0.5 * depth + 0.5 * closeBack;
        if (sweepCandle.close < sh.price) sweepLevel = sh;
      }
    }
  } else {
    const sl = lastSwingLow(swings5, c5last - 1);
    if (sl) {
      const sweepCandle = recent5.find(c => c.low < sl.price);
      if (sweepCandle) {
        const depth = clamp01((sl.price - sweepCandle.low) / range5);
        const closeBack = clamp01((sweepCandle.close - sl.price) / range5);
        sweepStrength = 0.5 * depth + 0.5 * closeBack;
        if (sweepCandle.close > sl.price) sweepLevel = sl;
      }
    }
  }
  breakdown.liquiditySweep = sweepLevel ? graded(WEIGHTS.liquiditySweep, sweepStrength) : 0;
  if (sweepLevel) reasons.push(`5M liquidity sweep of ${direction === 'short' ? 'high' : 'low'} at $${sweepLevel.price.toFixed(4)} (${Math.round(sweepStrength * 100)}%)`);

  // 5) 5m BOS — graded by how far price closed beyond the opposite-side
  //    structure point, relative to typical 5m range.
  let bosPoint = null, bosStrength = 0;
  if (sweepLevel) {
    bosPoint = direction === 'short' ? lastSwingLow(swings5, c5last) : lastSwingHigh(swings5, c5last);
    if (bosPoint) {
      const lastClose = c5m[c5last].close;
      const breakDist = direction === 'short' ? (bosPoint.price - lastClose) : (lastClose - bosPoint.price);
      bosStrength = clamp01(breakDist / range5);
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

  // 7) Momentum + volume — graded by RSI distance from 50 (in trade direction)
  //    and breakout-candle volume vs its 20-bar average.
  const r = rsi(c5m, 14);
  const avgVol = avgVolume(c5m, 20) || 1e-9;
  const lastVol = c5m[c5last].volume;
  let momentumStrength = 0;
  if (r !== null && bosPoint) {
    const rsiComponent = clamp01((sign * (r - 50)) / 20); // 20 RSI pts past 50 = full credit
    const volComponent = clamp01((lastVol / avgVol - 1) / 1); // 2x avg volume = full credit
    momentumStrength = 0.5 * rsiComponent + 0.5 * volComponent;
  }
  breakdown.momentumVolume = graded(WEIGHTS.momentumVolume, momentumStrength);
  if (breakdown.momentumVolume > 0) reasons.push(`Momentum+volume (RSI ${r ? r.toFixed(1) : '-'}, ${Math.round(momentumStrength * 100)}%)`);

  // 8) Candle pattern — graded by pin-bar wick ratio or engulfing body ratio,
  //    whichever is stronger, at the trigger candle.
  const cc = c5m[c5last], prevc = c5m[c5last - 1];
  const patternStrength = Math.max(pinBarStrength(cc, direction), engulfingStrength(prevc, cc, direction));
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
