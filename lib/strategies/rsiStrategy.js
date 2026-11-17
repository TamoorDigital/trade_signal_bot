const { rsiSeries } = require('../indicators');
const { clamp01, r1, last } = require('./util');

// RSI strategy, scored 0-10 for ONE direction (SMC's direction):
//   1H directional bias            max 3   1H RSI on the right side of 50 (full at 60+/40-)
//   15M pullback + recovery        max 4   RSI reached <=40 (>=60) within the last 12
//                                          closed bars (deeper = more), has recovered
//                                          >=5 pts (full at 10) and is turning; 0 if
//                                          already exhausted (>=70 long / <=30 short)
//   5M entry confirmation          max 3   5M RSI on the right side of 45/55 and moving
//                                          in the trade direction vs 3 bars ago
// "Signal expiry" = the 12-bar window: an old dip no longer counts.
// core = the 15M pullback component (the setup itself) must be > 0 to pass.
const PULLBACK_BARS = 12;

function evaluate(direction, c1h, c15m, c5m) {
  const sign = direction === 'long' ? 1 : -1;
  const r1h = last(rsiSeries(c1h, 14));
  const r15 = rsiSeries(c15m, 14), r5 = rsiSeries(c5m, 14);
  const now15 = last(r15), prev15 = r15[r15.length - 2];
  const now5 = last(r5), prev5 = r5[r5.length - 4];
  if ([r1h, now15, prev15, now5, prev5].some(v => v === null || v === undefined)) {
    return { score: 0, parts: { bias1h: 0, pullback15m: 0, entry5m: 0 }, core: false, reasons: ['not enough data for RSI'] };
  }
  const win = r15.slice(-PULLBACK_BARS).filter(v => v !== null);
  const extreme = direction === 'long' ? Math.min(...win) : Math.max(...win);

  const bias = clamp01(sign * (r1h - 50) / 10);
  const depth = clamp01(sign * (50 - extreme) / 20);
  const recovery = clamp01(sign * (now15 - extreme) / 10);
  const turning = sign * (now15 - prev15) > 0 ? 1 : 0;
  const exhausted = direction === 'long' ? now15 >= 70 : now15 <= 30;
  const pull = exhausted ? 0 : 0.4 * depth + 0.4 * recovery + 0.2 * turning;
  const level5 = direction === 'long' ? clamp01((now5 - 40) / 10) : clamp01((60 - now5) / 10);
  const moving5 = sign * (now5 - prev5) > 0 ? 1 : 0;
  const entry = 0.5 * level5 + 0.5 * moving5;

  const parts = { bias1h: r1(3 * bias), pullback15m: r1(4 * pull), entry5m: r1(3 * entry) };
  return {
    score: r1(parts.bias1h + parts.pullback15m + parts.entry5m),
    parts,
    core: parts.pullback15m > 0,
    reasons: [`1H ${r1h.toFixed(1)}, 15M ${now15.toFixed(1)} (${PULLBACK_BARS}-bar extreme ${extreme.toFixed(0)}${exhausted ? ', exhausted' : ''}), 5M ${now5.toFixed(1)} (3 bars ago ${prev5.toFixed(1)})`],
  };
}

module.exports = { evaluate };
