const { fetchKlines, fetchTopVolumeSymbols } = require('./mexcClient');
const { computeScore } = require('./scoring');
const { independentCheck } = require('./geminiClient');
const { buildSignal } = require('./signalEngine');
const store = require('./store');
const { trackOnce } = require('./tracker');

const state = {
  running: false,
  scanTimer: null,
  trackTimer: null,
  lastScanAt: null,
  logs: [], // recent activity, newest first, capped
};

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  state.logs.unshift(line);
  state.logs = state.logs.slice(0, 100);
  console.log(line);
}

async function resolveWatchlist() {
  const fixed = (process.env.WATCHLIST || '').trim();
  if (fixed) return fixed.split(',').map(s => s.trim()).filter(Boolean);
  const topN = parseInt(process.env.WATCHLIST_TOP_N || '10', 10);
  return fetchTopVolumeSymbols(topN);
}

async function scanSymbol(symbol, minScore) {
  if (store.isSymbolOpen(symbol)) {
    log(`[scan] ${symbol}: skipped, trade already open (duplicate guard)`);
    return;
  }

  const [c1h, c15m, c5m] = await Promise.all([
    fetchKlines(symbol, '1h'),
    fetchKlines(symbol, '15m'),
    fetchKlines(symbol, '5m'),
  ]);

  const candidate = computeScore(c1h, c15m, c5m);
  if (candidate.score < minScore) {
    log(`[scan] ${symbol}: our score ${candidate.score}/${candidate.maxScore} < min ${minScore}, skip`);
    return;
  }
  log(`[scan] ${symbol}: our score ${candidate.score}/${candidate.maxScore} (${candidate.direction}) >= min, checking with Gemini`);

  let gem;
  try {
    gem = await independentCheck(symbol, candidate, c1h, c15m, c5m, minScore, candidate.maxScore);
  } catch (err) {
    log(`[scan] ${symbol}: Gemini check failed (${err.message}), skip`);
    return;
  }

  if (!gem.valid || gem.direction !== candidate.direction || gem.score < minScore) {
    log(`[scan] ${symbol}: Gemini did not confirm (gemini score ${gem.score}, direction ${gem.direction}), skip`);
    return;
  }

  const entry = c5m[c5m.length - 1].close;
  const signal = buildSignal(symbol, candidate, entry, c5m, c15m);
  if (!signal) {
    log(`[scan] ${symbol}: no valid liquidity-sweep structure to anchor SL, skip`);
    return;
  }

  const trade = {
    id: `${symbol}-${Date.now()}`,
    symbol,
    direction: signal.direction,
    entry: signal.entry,
    sl: signal.sl,
    tps: signal.tps,
    rr: signal.rr,
    ourScore: signal.score,
    maxScore: signal.maxScore,
    geminiScore: gem.score,
    reasons: signal.reasons,
    geminiReasons: gem.reasons || [],
    slNote: gem.sl_note || `Beyond swept liquidity at ${signal.sweepLevel}`,
    tpNote: gem.tp_note || 'Next structural swing levels',
    status: 'open',
    hits: { tp1: false, tp2: false, tp3: false },
    lastPrice: entry,
    openedAt: Date.now(),
    timeframes: '1h15m5m',
  };
  store.addTrade(trade);
  log(`[scan] ${symbol}: SIGNAL CREATED ${trade.direction.toUpperCase()} @ ${trade.entry} (score ${trade.ourScore}, gemini ${trade.geminiScore})`);
}

async function scanOnce() {
  const minScore = parseInt(process.env.MIN_SCORE || '60', 10);
  let watchlist;
  try {
    watchlist = await resolveWatchlist();
  } catch (err) {
    log(`[scan] watchlist resolution failed: ${err.message}`);
    return;
  }
  log(`[scan] scanning ${watchlist.length} symbols: ${watchlist.join(', ')}`);
  for (const symbol of watchlist) {
    try {
      await scanSymbol(symbol, minScore);
    } catch (err) {
      log(`[scan] ${symbol}: error ${err.message}`);
    }
  }
  state.lastScanAt = Date.now();
}

function status() {
  return {
    running: state.running,
    lastScanAt: state.lastScanAt,
    logs: state.logs.slice(0, 30),
  };
}

function start() {
  if (state.running) return status();
  state.running = true;
  log('[scheduler] started');

  const scanIntervalMs = parseInt(process.env.SCAN_INTERVAL_MS || '300000', 10);
  const trackIntervalMs = parseInt(process.env.TRACK_INTERVAL_MS || '60000', 10);

  scanOnce(); // run immediately, then on interval
  state.scanTimer = setInterval(scanOnce, scanIntervalMs);
  state.trackTimer = setInterval(() => trackOnce(log), trackIntervalMs);
  return status();
}

function stop() {
  if (!state.running) return status();
  clearInterval(state.scanTimer);
  clearInterval(state.trackTimer);
  state.scanTimer = null;
  state.trackTimer = null;
  state.running = false;
  log('[scheduler] stopped');
  return status();
}

module.exports = { start, stop, status };
