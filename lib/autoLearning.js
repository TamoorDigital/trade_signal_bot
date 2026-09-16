// The auto-learning loop. Every time the closed-trade count crosses a new
// multiple of 10 (10, 20, 30, ...), this runs automatically — no button
// needed. Per an explicit design decision: each run re-analyzes ALL closed
// trades so far (cumulative), not just the newest 10 — so the 20-trade run
// looks at all 20, the 30-trade run looks at all 30, and so on. This keeps
// conclusions from whipsawing on a tiny rolling window.
//
// What it actually DOES, by design (confirmed scope, 2026-09-10):
//   - Runs the same stats + Gemini analysis as the manual Feedback button
//     (lib/feedback.js), tagged trigger:'auto' so it's distinguishable in
//     the Learning Log.
//   - Automatically applies SMALL, BOUNDED adjustments to exactly two
//     numbers: MIN_SCORE (±1 per cycle, clamped 55-75) and
//     confirmationMinMovePct (±0.0005 per cycle, clamped 0.0005-0.005).
//   - Scoring WEIGHTS are never auto-changed — Gemini's suggestions about
//     them are only ever logged for a human to read and act on manually,
//     same as the existing manual Feedback flow. Weight changes have caused
//     the most damage historically when done on small/noisy samples; this
//     is a deliberate, permanent restriction, not a temporary one.
//   - Can be turned off entirely from the dashboard header (autoTuningEnabled)
//     without losing the analysis/logging — when off, this function no-ops.

const store = require('./store');
const settings = require('./settings');
const learningState = require('./learningState');
const { runFeedbackAnalysis } = require('./feedback');

const MIN_SCORE_STEP = 1;
const MIN_SCORE_FLOOR = 55;
const MIN_SCORE_CEILING = 75;

const MOVE_PCT_STEP = 0.0005;
const MOVE_PCT_FLOOR = 0.0005;
const MOVE_PCT_CEILING = 0.005;

function decideMinScoreAdjustment(stats, currentMinScore) {
  const winRate = stats.win_rate_pct;
  if (winRate === null) return { delta: 0, reason: 'no win-rate data yet' };
  if (winRate < 45) {
    return { delta: MIN_SCORE_STEP, reason: `win rate ${winRate}% is low — tightening entry filter` };
  }
  if (winRate > 70) {
    return { delta: -MIN_SCORE_STEP, reason: `win rate ${winRate}% is high — loosening slightly to gather more trade volume/data` };
  }
  return { delta: 0, reason: `win rate ${winRate}% in a reasonable range, no change` };
}

function decideMoveThresholdAdjustment(closedTrades) {
  const counts = learningState.get().discardCounts;
  const totalOutcomes = counts.sl + counts.timeout + counts.confirmed;
  if (totalOutcomes < 5) {
    return { delta: 0, reason: 'not enough pending-confirmation outcomes since last cycle to judge' };
  }

  // How did trades that DID confirm (via lib/pendingConfirmation.js) actually
  // turn out? Only look at trades carrying the confirmedFrom marker, so old
  // pre-feature trades don't skew this.
  const confirmedTrades = closedTrades.filter(t => t.confirmedFrom);
  const confirmedLossRate = confirmedTrades.length
    ? confirmedTrades.filter(t => t.result === 'loss').length / confirmedTrades.length
    : null;

  if (confirmedLossRate !== null && confirmedLossRate > 0.45) {
    return { delta: MOVE_PCT_STEP, reason: `${Math.round(confirmedLossRate * 100)}% of confirmed trades still lost — requiring a larger favorable move before confirming` };
  }
  if (counts.timeout > counts.confirmed * 2 && (confirmedLossRate === null || confirmedLossRate < 0.25)) {
    return { delta: -MOVE_PCT_STEP, reason: `mostly timeouts (${counts.timeout} timeout vs ${counts.confirmed} confirmed) and confirmed trades are doing fine — loosening slightly so fewer valid setups expire unused` };
  }
  return { delta: 0, reason: 'confirmation outcomes look balanced, no change' };
}

async function runLearningCycle(log) {
  const cfg = settings.get();
  if (!cfg.autoTuningEnabled) return;

  const closedTrades = store.getClosedTrades();
  const state = learningState.get();
  const nextThreshold = state.lastLearningTradeCount + 10;
  if (closedTrades.length < nextThreshold) return;

  log(`[learning] closed trade count reached ${closedTrades.length} (threshold ${nextThreshold}) — running auto-learning cycle on ALL ${closedTrades.length} trades`);

  let entry;
  try {
    entry = await runFeedbackAnalysis('auto');
  } catch (err) {
    log(`[learning] analysis failed (${err.message}) — skipping this cycle's adjustments, will retry once more trades close`);
    return;
  }
  if (!entry.ok) {
    log(`[learning] ${entry.message}`);
    return;
  }

  const minScoreDecision = decideMinScoreAdjustment(entry.stats, cfg.minScore);
  const moveDecision = decideMoveThresholdAdjustment(closedTrades);

  const newMinScore = Math.max(MIN_SCORE_FLOOR, Math.min(MIN_SCORE_CEILING, cfg.minScore + minScoreDecision.delta));
  const newMovePct = Math.max(MOVE_PCT_FLOOR, Math.min(MOVE_PCT_CEILING, cfg.confirmationMinMovePct + moveDecision.delta));

  settings.applyLearningAdjustment({ minScore: newMinScore, confirmationMinMovePct: newMovePct });

  const logEntry = {
    at: Date.now(),
    closedTradeCount: closedTrades.length,
    minScore: { from: cfg.minScore, to: newMinScore, reason: minScoreDecision.reason },
    confirmationMinMovePct: { from: cfg.confirmationMinMovePct, to: newMovePct, reason: moveDecision.reason },
    weightSuggestions: (entry.insight && entry.insight.recommendations) || [],
  };
  learningState.recordLearningRun(closedTrades.length, logEntry);
  learningState.resetDiscardCounts();

  log(`[learning] MIN_SCORE ${cfg.minScore} -> ${newMinScore} (${minScoreDecision.reason})`);
  log(`[learning] confirmationMinMovePct ${cfg.confirmationMinMovePct} -> ${newMovePct} (${moveDecision.reason})`);
  if (logEntry.weightSuggestions.length) {
    log(`[learning] weight suggestions logged (NOT auto-applied) — see Learning Log on the dashboard: ${logEntry.weightSuggestions.map(r => r.change).join('; ')}`);
  }
}

async function maybeRunLearningCycle(log = () => {}) {
  try {
    await runLearningCycle(log);
  } catch (err) {
    log(`[learning] unexpected error in learning cycle: ${err.message}`);
  }
}

module.exports = { maybeRunLearningCycle };
