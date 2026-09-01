const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'trades.json');
const FEEDBACK_PATH = path.join(__dirname, '..', 'data', 'feedback.json');

function load() {
  if (!fs.existsSync(DB_PATH)) return { open: [], closed: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { open: [], closed: [] };
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
  return db.open.some(t => t.symbol === symbol);
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

module.exports = { isSymbolOpen, addTrade, getOpenTrades, getClosedTrades, updateOpenTrade, closeTrade, getStats, addFeedbackEntry, getFeedbackHistory };
