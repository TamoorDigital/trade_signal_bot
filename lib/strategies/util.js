const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r1 = (x) => Math.round(x * 10) / 10;
const last = (a) => a[a.length - 1];

// Only fully CLOSED candles may be used for strategy confirmation, otherwise a
// signal can appear and vanish while the candle is still forming (repaint).
// A candle is closed once open-time + timeframe length has passed.
function closedOnly(candles, tfMs, now = Date.now()) {
  return candles.filter(c => c.time + tfMs <= now);
}

module.exports = { clamp01, r1, last, closedOnly };
