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

// Outcome buckets — a trade's bucket is the FURTHEST target it reached:
//   sl  = stopped out before TP1 (full loss)
//   tp1 = TP1 hit, then stopped at breakeven (or closed by the continuation gate)
//   tp2 = TP2 hit, then closed at TP1 (or closed by the continuation gate)
//   tp3 = TP3 hit (final target, full win)
// The old "win rate" counted every TP1-then-breakeven exit as a win, which
// is why it read ~70% while the account was roughly flat. These buckets +
// netR (realised R-multiples, fee-adjusted) are the honest picture.
const FEE_ROUNDTRIP_PCT = parseFloat(process.env.FEE_ROUNDTRIP_PCT || '0.04');

function classifyTrade(t) {
  if (t.result === 'loss') return 'sl';
  if (t.hits && t.hits.tp3) return 'tp3';
  if (t.hits && t.hits.tp2) return 'tp2';
  return 'tp1';
}

function realizedR(t) {
  const entry = t.entry;
  const sl = t.originalSl !== undefined ? t.originalSl : t.sl;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || !Array.isArray(t.tps)) return 0;
  const dist = (i) => Math.abs(t.tps[i] - entry) / risk;
  const invalidated = (t.closeReason || '').includes('continuation invalid');
  const bucket = classifyTrade(t);
  let r;
  if (bucket === 'sl') r = -1;
  else if (bucket === 'tp3') r = dist(2);
  else if (bucket === 'tp2') r = invalidated ? dist(1) : dist(0);
  else r = invalidated ? dist(0) : (entry * 0.001) / risk; // fee-buffered breakeven
  return r - (entry * FEE_ROUNDTRIP_PCT / 100) / risk;
}

function outcomeBreakdown(trades) {
  const c = { sl: 0, tp1: 0, tp2: 0, tp3: 0 };
  let netR = 0;
  for (const t of trades) { c[classifyTrade(t)]++; netR += realizedR(t); }
  const total = trades.length;
  const p = (n) => (total ? +((n / total) * 100).toFixed(1) : 0);
  return {
    total, ...c,
    pct: { sl: p(c.sl), tp1: p(c.tp1), tp2: p(c.tp2), tp3: p(c.tp3) },
    // "reached" = touched that target at all (includes trades that went further)
    reached: { tp1: p(c.tp1 + c.tp2 + c.tp3), tp2: p(c.tp2 + c.tp3), tp3: p(c.tp3) },
    netR: +netR.toFixed(1),
    avgR: total ? +(netR / total).toFixed(3) : 0,
  };
}

function getStats() {
  const closed = getClosedTrades();
  return {
    totalTrades: closed.length,
    openCount: getOpenTrades().length,
    pendingCount: getPendingTrades().length,
    all: outcomeBreakdown(closed),
    long: outcomeBreakdown(closed.filter(t => t.direction === 'long')),
    short: outcomeBreakdown(closed.filter(t => t.direction === 'short')),
    v2: outcomeBreakdown(closed.filter(t => t.engine === 'v2')),
    legacy: outcomeBreakdown(closed.filter(t => t.engine !== 'v2')),
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

module.exports = { classifyTrade, realizedR, outcomeBreakdown, isSymbolOpen, addTrade, getOpenTrades, getClosedTrades, updateOpenTrade, closeTrade, updateClosedTrade, getStats, addFeedbackEntry, getFeedbackHistory, replaceAll, replaceFeedback, addPendingTrade, getPendingTrades, discardPendingTrade, confirmPendingTrade };

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
