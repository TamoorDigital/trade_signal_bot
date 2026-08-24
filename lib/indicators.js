// Plain technical-analysis helpers. Candles are arrays of
// { time, open, high, low, close, volume } sorted oldest -> newest.

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    if (i === 0) {
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  });
  return out;
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 5-candle fractal: candle[i] is a swing high if it's the highest of the
// 2 candles before and after it (same for swing low).
function swingPoints(candles, lookback = 2) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (c.high === Math.max(...window.map(w => w.high))) {
      highs.push({ index: i, price: c.high, time: c.time });
    }
    if (c.low === Math.min(...window.map(w => w.low))) {
      lows.push({ index: i, price: c.low, time: c.time });
    }
  }
  return { highs, lows };
}

// Fair value gap: 3-candle imbalance where candle[i-1].low > candle[i+1].high
// (bearish FVG) or candle[i-1].high < candle[i+1].low (bullish FVG).
function findFVGs(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1], c = candles[i + 1];
    if (a.low > c.high) {
      fvgs.push({ type: 'bearish', top: a.low, bottom: c.high, index: i });
    } else if (a.high < c.low) {
      fvgs.push({ type: 'bullish', top: c.low, bottom: a.high, index: i });
    }
  }
  return fvgs;
}

function avgVolume(candles, n = 20) {
  const slice = candles.slice(-n);
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

// Average high-low range over the last n candles — used as a "typical move"
// yardstick so sweep/BOS magnitude can be graded instead of pass/fail.
function avgRange(candles, n = 20) {
  const slice = candles.slice(-n);
  return slice.reduce((s, c) => s + (c.high - c.low), 0) / slice.length;
}

module.exports = { ema, rsi, swingPoints, findFVGs, avgVolume, avgRange };
