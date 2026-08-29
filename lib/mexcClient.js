const axios = require('axios');

const BASE = 'https://contract.mexc.com/api/v1/contract';

// Our timeframe names -> MEXC interval codes
const INTERVAL_MAP = { '1h': 'Min60', '15m': 'Min15', '5m': 'Min5' };

// How many candles to pull per timeframe.
// 1h/15m need enough history for EMA200 to actually converge — EMA is seeded
// from the first candle's price, and that seed's influence only decays to
// ~2% after ~600 bars (it's still ~55% present at 260 bars). Since EMA200
// drives htfBias + trendRegime (35 of our 93 score points), skimping here
// would make our two heaviest-weighted criteria unreliable.
// 5m never computes an EMA200 (only RSI14 / 20-bar avg / 8-bar CRT lookback),
// so 200 bars is already comfortably more than enough.
const CANDLE_LIMIT = { '1h': 600, '15m': 600, '5m': 200 };

// ---------------------------------------------------------------------------
// Rate limiting: MEXC's public futures API returns {"success":false,"code":510,
// "message":"Requests are too frequent..."} (HTTP 200, error is inside the
// JSON body, not a 429) when hit too fast. All requests below are funneled
// through one queue that (a) enforces a minimum gap between calls and
// (b) retries with exponential backoff specifically on that error.
// ---------------------------------------------------------------------------
const MIN_GAP_MS = parseInt(process.env.MEXC_MIN_GAP_MS || '400', 10);
let lastCallAt = 0;
let queue = Promise.resolve();

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Every call reserves its own slot in the queue, spaced at least MIN_GAP_MS
// apart, so we never fire a burst regardless of how many things call in
// parallel (Promise.all, concurrent tracker loops, etc).
function throttledCall(fn) {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.catch(() => {}); // don't let one failure break the chain for later callers
  return run;
}

function isRateLimitError(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('"code":510') || msg.toLowerCase().includes('too frequent')) return true;
  const status = err && err.response && err.response.status;
  return status === 429 || status === 503;
}

async function withRetry(fn, { retries = 5, baseDelay = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await throttledCall(fn);
    } catch (err) {
      if (attempt >= retries || !isRateLimitError(err)) throw err;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 300;
      await sleep(delay);
    }
  }
}

async function fetchKlines(symbol, tf) {
  const interval = INTERVAL_MAP[tf];
  const limit = CANDLE_LIMIT[tf];
  const barsSeconds = { Min60: 3600, Min15: 900, Min5: 300 }[interval];
  const end = Math.floor(Date.now() / 1000);
  const start = end - barsSeconds * (limit + 5);

  return withRetry(async () => {
    const { data } = await axios.get(`${BASE}/kline/${symbol}`, {
      params: { interval, start, end },
      timeout: 10000,
    });

    if (!data || !data.success || !data.data || !data.data.time) {
      throw new Error(`MEXC kline fetch failed for ${symbol} ${tf}: ${JSON.stringify(data)}`);
    }

    const d = data.data;
    return d.time.map((t, i) => ({
      time: t * 1000,
      open: d.open[i],
      high: d.high[i],
      low: d.low[i],
      close: d.close[i],
      volume: d.vol[i],
    }));
  });
}

async function fetchAllTickers() {
  return withRetry(async () => {
    const { data } = await axios.get(`${BASE}/ticker`, { timeout: 10000 });
    if (!data || !data.success || !Array.isArray(data.data)) {
      throw new Error(`MEXC ticker fetch failed: ${JSON.stringify(data)}`);
    }
    return data.data;
  });
}

// Top-N USDT-M perpetual symbols by 24h USD turnover (amount24).
async function fetchTopVolumeSymbols(n = 10) {
  const tickers = await fetchAllTickers();
  return tickers
    .filter(t => t.symbol && t.symbol.endsWith('_USDT'))
    .sort((a, b) => (b.amount24 || 0) - (a.amount24 || 0))
    .slice(0, n)
    .map(t => t.symbol);
}

async function fetchLastPrice(symbol) {
  return withRetry(async () => {
    const { data } = await axios.get(`${BASE}/ticker`, { params: { symbol }, timeout: 10000 });
    if (!data || !data.success || !data.data) throw new Error(`MEXC price fetch failed for ${symbol}: ${JSON.stringify(data)}`);
    return data.data.lastPrice;
  });
}

module.exports = { fetchKlines, fetchTopVolumeSymbols, fetchLastPrice };
