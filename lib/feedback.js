// Trade-history self-review, triggered manually from the dashboard's
// "Feedback" section. Never auto-applies anything — it only computes stats
// from every closed trade so far and asks Gemini for a plain-language read
// on what's working, what's not, and what to consider changing. The human
// decides whether to act on it.

const store = require('./store');
const { askGeminiJson } = require('./geminiClient');

const CRITERIA = [
  { key: 'htfBias', label: 'HTF Bias (1h)', weight: 20 },
  { key: 'trendRegime', label: 'Trend Regime', weight: 15 },
  { key: 'freshPOI', label: 'Fresh 15m POI', weight: 18 },
  { key: 'liquiditySweep', label: '5m Sweep', weight: 12 },
  { key: 'bos', label: '5m BOS', weight: 12 },
  { key: 'choch', label: 'CHoCH/MSS', weight: 5 },
  { key: 'crtTbs', label: 'CRT/TBS', weight: 4 },
  { key: 'momentumVolume', label: 'Momentum+Vol', weight: 5 },
  { key: 'candlePattern', label: 'Candle Pattern', weight: 2 },
];

const isWinLike = (t) => t.result === 'win' || t.result === 'partial' || t.result === 'partial_profit';
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const pct = (n) => (n === null ? null : +(n * 100).toFixed(1));

function computeStats(trades) {
  const total = trades.length;
  const wins = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  const partials = trades.filter(t => t.result === 'partial');
  const partialProfits = trades.filter(t => t.result === 'partial_profit');
  const winLike = trades.filter(isWinLike);

  // Per-criterion: average % of that criterion's own weight, split by outcome.
  // e.g. "HTF Bias averaged 85% of its weight in wins vs 60% in losses"
  const perCriterion = CRITERIA.map(c => {
    const pctOf = (t) => (t.breakdown && t.breakdown[c.key] !== undefined) ? t.breakdown[c.key] / c.weight : null;
    const winVals = wins.map(pctOf).filter(v => v !== null);
    const lossVals = losses.map(pctOf).filter(v => v !== null);
    return {
      criterion: c.label,
      avg_pct_in_wins: pct(avg(winVals)),
      avg_pct_in_losses: pct(avg(lossVals)),
      sample_wins: winVals.length,
      sample_losses: lossVals.length,
    };
  });

  // Score margin: how far above MIN_SCORE did winners vs losers actually score?
  const minScore = parseInt(process.env.MIN_SCORE || '60', 10);
  const marginOf = (t) => (t.ourScore !== undefined ? t.ourScore - minScore : null);
  const winMargins = winLike.map(marginOf).filter(v => v !== null);
  const lossMargins = losses.map(marginOf).filter(v => v !== null);

  // Continuation-invalidation: how often did the "close early to protect
  // profit" logic fire vs a plain trailed-stop exit?
  const invalidatedExits = partialProfits.filter(t => (t.closeReason || '').includes('continuation invalid')).length;

  // Direction split
  const longs = trades.filter(t => t.direction === 'long');
  const shorts = trades.filter(t => t.direction === 'short');
  const winRateOf = (arr) => (arr.length ? pct(arr.filter(isWinLike).length / arr.length) : null);

  // Per-symbol performance (only symbols with 2+ closed trades, to avoid noise)
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  const symbolStats = Object.entries(bySymbol)
    .filter(([, arr]) => arr.length >= 2)
    .map(([symbol, arr]) => ({ symbol, trades: arr.length, win_rate_pct: winRateOf(arr) }));

  return {
    total_closed_trades: total,
    win_rate_pct: total ? pct(winLike.length / total) : null,
    wins: wins.length, losses: losses.length,
    partial_breakeven: partials.length, partial_profit: partialProfits.length,
    avg_score_margin_above_min_score: { winners: avg(winMargins), losers: avg(lossMargins) },
    continuation_invalidation_exits_of_partial_profits: `${invalidatedExits}/${partialProfits.length}`,
    direction_split: {
      long: { count: longs.length, win_rate_pct: winRateOf(longs) },
      short: { count: shorts.length, win_rate_pct: winRateOf(shorts) },
    },
    per_criterion_avg_pct_of_weight: perCriterion,
    per_symbol: symbolStats,
  };
}

function buildPrompt(stats, sampleTrades) {
  const sample = sampleTrades.slice(-15).map(t => ({
    symbol: t.symbol, direction: t.direction, result: t.result,
    our_score: t.ourScore, gemini_score: t.geminiScore, max_score: t.maxScore,
    close_reason: t.closeReason,
  }));
  return `You are a quant reviewing an automated SMC (smart money concepts) crypto futures `
    + `trading bot's live performance. Below are AGGREGATED STATISTICS computed from every trade `
    + `it has closed so far, plus the most recent individual trades for concrete pattern-spotting. `
    + `The scoring checklist has 9 weighted criteria totaling 93 points (htfBias 20, trendRegime 15, `
    + `freshPOI 18, liquiditySweep 12, bos 12, choch 5, crtTbs 4, momentumVolume 5, candlePattern 2), `
    + `gated by a MIN_SCORE threshold before a trade opens, then independently re-scored by a second `
    + `model (Gemini) before it's actually taken. After a TP hits (except the final one), a separate `
    + `4-check continuation gate decides whether to keep trailing or exit immediately. `
    + `Your job: identify what's actually working, what's not, and give SPECIFIC, PRIORITIZED, `
    + `ACTIONABLE suggestions to improve win rate — e.g. should MIN_SCORE move up or down and by how `
    + `much, should any criterion's weight increase/decrease and why the data suggests it, is the `
    + `continuation-check helping or hurting, any symbol or direction pattern worth acting on. `
    + `If the sample size is small (under ~30 closed trades), say so explicitly and caveat your `
    + `confidence accordingly — do not overstate conclusions from a small sample. `
    + `Respond with ONLY compact JSON, no markdown fences, matching exactly: `
    + `{"confidence":"low|medium|high","sample_size_note":"...","summary":"2-3 sentence overview",`
    + `"recommendations":[{"change":"short label","why":"reasoning tied to the numbers","priority":"high|medium|low"}, ...],`
    + `"whats_working":["..."],"whats_not_working":["..."]}. `
    + `Aggregated stats:\n${JSON.stringify(stats)}\n\nRecent individual trades:\n${JSON.stringify(sample)}`;
}

async function runFeedbackAnalysis() {
  const trades = store.getClosedTrades();
  if (trades.length === 0) {
    return { ok: false, message: 'No closed trades yet — nothing to analyze.' };
  }
  const stats = computeStats(trades);
  const prompt = buildPrompt(stats, trades);
  const insight = await askGeminiJson(prompt);
  const entry = { ok: true, stats, insight, generatedAt: Date.now(), tradesAnalyzed: trades.length };
  store.addFeedbackEntry(entry);
  return entry;
}

module.exports = { runFeedbackAnalysis, computeStats };
