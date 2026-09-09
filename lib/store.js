const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'trades.json');
const FEEDBACK_PATH = path.join(__dirname, '..', 'data', 'feedback.json');

function load() {
  if (!fs.existsSync(DB_PATH)) return { open: [], closed: [], pending: [] };
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.pending) db.pending = [];
    return db;
  } catch {
    return { open: [], closed: [], pending: [] };
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function loadFeedback() {
  if (!fs.existsSync(FEEDBACK_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveFeedback(list) {
  fs.mkdirSync(path.dirname(FEEDBACK_PATH), { recursive: true });
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(list, null, 2));
}

// Keeps a running history of past self-review runs so the dashboard can show
// "what did the last few reviews say", not just the most recent one.
function addFeedbackEntry(entry) {
  const list = loadFeedback();
  list.push(entry);
  saveFeedback(list.slice(-50)); // cap history so the file doesn't grow forever
  return entry;
}

function getFeedbackHistory() {
  return loadFeedback();
}

function isSymbolOpen(symbol) {
  const db = load();
  return db.open.some(t => t.symbol === symbol) || db.pending.some(t => t.symbol === symbol);
}

function addTrade(trade) {
  const db = load();
  db.open.push(trade);
  save(db);
  return trade;
}

function getOpenTrades() {
  return load().open;
}

function getClosedTrades() {
  return load().closed;
}

function updateOpenTrade(id, patch) {
  const db = load();
  const t = db.open.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  save(db);
  return t;
}

function closeTrade(id, closePatch) {
  const db = load();
  const idx = db.open.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const [t] = db.open.splice(idx, 1);
  Object.assign(t, closePatch, { closedAt: Date.now() });
  db.closed.push(t);
  save(db);
  return t;
}

// Used by the continuation-gate audit (lib/continuationAudit.js) to attach a
// verdict to a trade that's already in the closed list.
function updateClosedTrade(id, patch) {
  const db = load();
  const t = db.closed.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  save(db);
  return t;
}

function getStats() {
  const closed = getClosedTrades();
  const wins = closed.filter(t => t.result === 'win' || t.result === 'partial' || t.result === 'partial_profit').length;
  const losses = closed.filter(t => t.result === 'loss').length;
  const total = closed.length;
  return {
    totalTrades: total,
    wins,
    losses,
    winRate: total ? +((wins / total) * 100).toFixed(1) : 0,
    openCount: getOpenTrades().length,
  };
}

// Used only by the password-gated /api/import route to restore a previously
// exported backup (e.g. after a Render free-tier restart wiped the disk).
// Minimal shape validation so a malformed upload doesn't corrupt the store.
function replaceAll(tradesObj) {
  const open = Array.isArray(tradesObj && tradesObj.open) ? tradesObj.open : [];
  const closed = Array.isArray(tradesObj && tradesObj.closed) ? tradesObj.closed : [];
  const pending = Array.isArray(tradesObj && tradesObj.pending) ? tradesObj.pending : [];
  save({ open, closed, pending });
}

function replaceFeedback(list) {
  saveFeedback(Array.isArray(list) ? list.slice(-50) : []);
}

module.exports = { isSymbolOpen, addTrade, getOpenTrades, getClosedTrades, updateOpenTrade, closeTrade, updateClosedTrade, getStats, addFeedbackEntry, getFeedbackHistory, replaceAll, replaceFeedback, addPendingTrade, getPendingTrades, discardPendingTrade, confirmPendingTrade };

// --- Pending confirmation lifecycle ---
// A signal that cleared MIN_SCORE + Gemini goes here FIRST, not straight
// into 'open'. It only becomes a real (optionally live) trade once fresh
// price action actually confirms the move — see lib/pendingConfirmation.js.

function addPendingTrade(pending) {
  const db = load();
  db.pending.push(pending);
  save(db);
  return pending;
}

function getPendingTrades() {
  return load().pending;
}

// Price invalidated the setup or the confirmation window ran out — the
// signal is thrown away, no trade of any kind was ever opened for it.
function discardPendingTrade(id, reason) {
  const db = load();
  const idx = db.pending.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const [p] = db.pending.splice(idx, 1);
  save(db);
  return { ...p, discardReason: reason };
}

// Fresh price action confirmed the move — removes the pending record and
// pushes the caller's fully-built trade object into 'open' as-is (the
// caller is responsible for constructing the complete final record; we
// don't merge with the old pending fields, since that would silently
// resurrect anything the caller intentionally left out, like plannedEntry).
function confirmPendingTrade(id, trade) {
  const db = load();
  const idx = db.pending.findIndex(x => x.id === id);
  if (idx === -1) return null;
  db.pending.splice(idx, 1);
  db.open.push(trade);
  save(db);
  return trade;
}
