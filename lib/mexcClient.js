const axios = require('axios');

const BASE = 'https://contract.mexc.com/api/v1/contract';

// Our timeframe names -> MEXC interval codes
const INTERVAL_MAP = { '1h': 'Min60', '15m': 'Min15', '5m': 'Min5' };

// How many candles to pull per timeframe (enough history for EMA200 + swings)
const CANDLE_LIMIT = { '1h': 260, '15m': 260, '5m': 200 };

async function fetchKlines(symbol, tf) {
  const interval = INTERVAL_MAP[tf];
  const limit = CANDLE_LIMIT[tf];
  const barsSeconds = { Min60: 3600, Min15: 900, Min5: 300 }[interval];
  const end = Math.floor(Date.now() / 1000);
  const start = end - barsSeconds * (limit + 5);

  const { data } = await axios.get(`${BASE}/kline/${symbol}`, {
    params: { interval, start, end },
    timeout: 10000,
  });

  if (!data || !data.success || !data.data || !data.data.time) {
    throw new Error(`MEXC kline fetch failed for ${symbol} ${tf}: ${JSON.stringify(data)}`);
  }

  const d = data.data;
  const candles = d.time.map((t, i) => ({
    time: t * 1000,
    open: d.open[i],
    high: d.high[i],
    low: d.low[i],
    close: d.close[i],
    volume: d.vol[i],
  }));
  return candles;
}

async function fetchAllTickers() {
  const { data } = await axios.get(`${BASE}/ticker`, { timeout: 10000 });
  if (!data || !data.success || !Array.isArray(data.data)) {
    throw new Error('MEXC ticker fetch failed');
  }
  return data.data;
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
  const { data } = await axios.get(`${BASE}/ticker`, { params: { symbol }, timeout: 10000 });
  if (!data || !data.success || !data.data) throw new Error(`MEXC price fetch failed for ${symbol}`);
  return data.data.lastPrice;
}

module.exports = { fetchKlines, fetchTopVolumeSymbols, fetchLastPrice };
