// Small persisted state the auto-learning loop needs that doesn't belong in
// settings.js (which is user-facing config) or store.js (which is trade
// data): the "how many trades since we last ran a learning cycle" counter,
// pending-confirmation outcome counts (for tuning confirmationMinMovePct),
// and a running log of every adjustment the loop has ever made.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'data', 'learningState.json');

const DEFAULTS = {
  lastLearningTradeCount: 0,
  discardCounts: { sl: 0, timeout: 0, confirmed: 0 },
  adjustmentLog: [], // [{ at, closedTradeCount, minScoreChange, moveThresholdChange, reasoning }]
};

function load() {
  if (!fs.existsSync(STATE_PATH)) return structuredClone(DEFAULTS);
  try {
    return { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function get() {
  return load();
}

function incrementOutcome(type) {
  const state = load();
  state.discardCounts[type] = (state.discardCounts[type] || 0) + 1;
  save(state);
}

function resetDiscardCounts() {
  const state = load();
  state.discardCounts = { sl: 0, timeout: 0, confirmed: 0 };
  save(state);
}

function recordLearningRun(closedTradeCount, entry) {
  const state = load();
  state.lastLearningTradeCount = closedTradeCount;
  state.adjustmentLog.push(entry);
  state.adjustmentLog = state.adjustmentLog.slice(-100); // cap history
  save(state);
}

function resetAll() {
  save(structuredClone(DEFAULTS));
  return structuredClone(DEFAULTS);
}

module.exports = { get, incrementOutcome, resetDiscardCounts, recordLearningRun, resetAll };
