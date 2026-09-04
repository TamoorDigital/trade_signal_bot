const { swingPoints, rsi, avgVolume, avgRange } = require('./indicators');

// After a TP hits (but before the final target), decides whether the move
// still looks likely to continue — using FRESH 5m candles at the moment of
// the check. Four checks are evaluated:
//
//   1. 5m structure confirms continuation — price hasn't broken back through
//      the most recent counter-trend swing point (no opposite BOS yet).
//   2. A new higher-low (long) / lower-high (short) has formed — the market
//      is still making continuation structure, not just drifting.
//   3. A displacement candle — at least one recent candle shows a strong,
//      directionally-aligned body relative to the typical 5m range.
//   4. Momentum remains valid — RSI still on the trade's side of 50, and
//      volume hasn't collapsed well below its recent average.
//
// REQUIRES 3 OF 4, not all 4 (tuned 2026-09-02 after a Feedback review showed
// 17/19 partial-profit trades were being invalidated immediately at TP1).
// The main culprit was check #2: swing-point confirmation has an inherent
// lag (the fractal detector needs candles AFTER a pivot to confirm it), so
// right when TP1 has *just* hit there often hasn't been time for a fresh
// swing to be confirmed yet — even when the move is genuinely continuing.
// Requiring all 4 treated that detection lag as if it were a bearish/bullish
// signal. 3-of-4 tolerates one check lagging while still requiring real
// multi-factor confirmation, not just a single indicator.
function checkContinuation(direction, c5m) {
  if (!c5m || c5m.length < 25) {
    return { valid: true, checks: {}, reasons: ['not enough fresh 5m data, defaulting to valid'] };
  }

  const last = c5m.length - 1;
  const lastClose = c5m[last].close;
  const swings = swingPoints(c5m);
  const range5 = avgRange(c5m, 20) || 1e-9;
  const avgVol = avgVolume(c5m, 20) || 1e-9;
  const lastVol = c5m[last].volume;
  const r = rsi(c5m, 14);
  const recent5 = c5m.slice(-5);

  // 1) Structure still in our favor
  let structureConfirms;
  if (direction === 'short') {
    const recentHigh = swings.highs[swings.highs.length - 1];
    structureConfirms = !recentHigh || lastClose < recentHigh.price;
  } else {
    const recentLow = swings.lows[swings.lows.length - 1];
    structureConfirms = !recentLow || lastClose > recentLow.price;
  }

  // 2) New higher-low (long) / lower-high (short)
  let newSwingFormed = false;
  if (direction === 'long' && swings.lows.length >= 2) {
    const lows = swings.lows;
    newSwingFormed = lows[lows.length - 1].price > lows[lows.length - 2].price;
  } else if (direction === 'short' && swings.highs.length >= 2) {
    const highs = swings.highs;
    newSwingFormed = highs[highs.length - 1].price < highs[highs.length - 2].price;
  }

  // 3) Displacement candle in the last 5 bars (threshold loosened from 1.1x
  // to 0.8x avg range — 1.1x was rarely triggering on ordinary healthy moves)
  const displacement = recent5.some(c => {
    const body = Math.abs(c.close - c.open);
    const aligned = direction === 'long' ? c.close > c.open : c.close < c.open;
    return aligned && body > 0.8 * range5;
  });

  // 4) Momentum still valid (volume floor loosened from 0.6x to 0.5x avg —
  // 0.6x was flagging normal lulls between impulse candles as "faded")
  const momentumOk = r !== null
    && (direction === 'long' ? r > 50 : r < 50)
    && lastVol >= avgVol * 0.5;

  const checks = { structureConfirms, newSwingFormed, displacement, momentumOk };
  const passCount = Object.values(checks).filter(Boolean).length;

  // Bypass rule added 2026-09-04: a 37-trade cross-check (manual calc +
  // Gemini + ChatGPT, all independently agreeing) found every observed
  // gate-triggered exit had structureConfirms=true AND displacement=true,
  // but got killed by newSwingFormed (known detection lag) and/or momentumOk
  // (a normal post-impulse volume lull). Structure holding + a real
  // displacement candle already IS the core continuation evidence — the
  // other two are lagging/noisy confirmations, not independent signals. If
  // both hold, treat it as valid regardless of the other two. Otherwise fall
  // back to the normal 3-of-4 bar.
  const structureAndDisplacementValid = structureConfirms && displacement;
  const valid = structureAndDisplacementValid || passCount >= 3;

  const reasons = [];
  if (!structureConfirms) reasons.push('structure broke against trade direction');
  if (!newSwingFormed) reasons.push(`no new ${direction === 'long' ? 'higher-low' : 'lower-high'} formed yet (often just detection lag)`);
  if (!displacement) reasons.push('no displacement candle in favor');
  if (!momentumOk) reasons.push(`momentum faded (RSI ${r ? r.toFixed(1) : '-'}, vol ${lastVol < avgVol ? 'below' : 'at/above'} avg)`);
  if (structureAndDisplacementValid) reasons.push('structure + displacement both confirm — valid regardless of swing/momentum lag');
  else if (valid) reasons.push(`${passCount}/4 continuation checks passed — still valid`);

  return { valid, checks, reasons };
}

module.exports = { checkContinuation };
