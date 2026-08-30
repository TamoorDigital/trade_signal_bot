const { swingPoints, rsi, avgVolume, avgRange } = require('./indicators');

// After a TP hits (but before the final target), decides whether the move
// still looks likely to continue — using FRESH 5m candles at the moment of
// the check, not the candles from entry time. All four checks must hold for
// the setup to stay "valid":
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
// If ANY check fails, the setup is "invalid" and the caller should close the
// position now rather than let it ride the trail back down to breakeven/TPn-1.
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

  // 3) Displacement candle in the last 5 bars
  const displacement = recent5.some(c => {
    const body = Math.abs(c.close - c.open);
    const aligned = direction === 'long' ? c.close > c.open : c.close < c.open;
    return aligned && body > 1.1 * range5;
  });

  // 4) Momentum still valid
  const momentumOk = r !== null
    && (direction === 'long' ? r > 50 : r < 50)
    && lastVol >= avgVol * 0.6;

  const checks = { structureConfirms, newSwingFormed, displacement, momentumOk };
  const valid = structureConfirms && newSwingFormed && displacement && momentumOk;

  const reasons = [];
  if (!structureConfirms) reasons.push('structure broke against trade direction');
  if (!newSwingFormed) reasons.push(`no new ${direction === 'long' ? 'higher-low' : 'lower-high'} formed`);
  if (!displacement) reasons.push('no displacement candle in favor');
  if (!momentumOk) reasons.push(`momentum faded (RSI ${r ? r.toFixed(1) : '-'}, vol ${lastVol < avgVol ? 'below' : 'at/above'} avg)`);
  if (valid) reasons.push('structure, new swing, displacement, and momentum all still confirm continuation');

  return { valid, checks, reasons };
}

module.exports = { checkContinuation };
