const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

// minScore/confirmationMinMovePct seed from env on first run only, then
// become persisted + auto-tunable — env vars alone can't be changed by the
// running process, but these two need to be, for the auto-learning loop.
const DEFAULTS = {
  autoTradeEnabled: false,
  leverage: 5,
  usdtPerTrade: 20,
  minScore: parseInt(process.env.MIN_SCORE || '60', 10),
  confirmationMinMovePct: parseFloat(process.env.PENDING_MIN_MOVE_PCT || '0.0015'),
  autoTuningEnabled: true,
};

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function load() {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function get() {
  return load();
}

// Password is required for EVERY change (no session/token) — simple and
// matches "click Edit -> asks for password" with no persistent login state.
function update({ password, autoTradeEnabled, leverage, usdtPerTrade }) {
  const expected = process.env.EDIT_PASSWORD;
  if (!expected) throw new Error('EDIT_PASSWORD is not set in the server environment — refusing all edits');
  if (!safeEqual(password, expected)) {
    const err = new Error('Incorrect password');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  const current = load();
  const next = {
    ...current,
    autoTradeEnabled: autoTradeEnabled !== undefined ? !!autoTradeEnabled : current.autoTradeEnabled,
    leverage: leverage !== undefined ? Number(leverage) : current.leverage,
    usdtPerTrade: usdtPerTrade !== undefined ? Number(usdtPerTrade) : current.usdtPerTrade,
  };
  if (!(next.leverage > 0) || !(next.usdtPerTrade > 0)) {
    throw new Error('leverage and usdtPerTrade must be positive numbers');
  }
  save(next);
  return next;
}

// Quick header toggle for the auto-learning loop — deliberately NOT
// password-gated (unlike leverage/usdt/auto-trade) since it only controls
// whether the system's own bounded, logged self-tuning runs; it can't place
// or size real orders by itself.
function setAutoTuning(enabled) {
  const current = load();
  const next = { ...current, autoTuningEnabled: !!enabled };
  save(next);
  return next;
}

// Used ONLY by lib/autoLearning.js — small, bounded, logged adjustments to
// minScore / confirmationMinMovePct. Never touches leverage, usdtPerTrade,
// or autoTradeEnabled; those stay human-only via update() above.
function applyLearningAdjustment({ minScore, confirmationMinMovePct }) {
  const current = load();
  const next = {
    ...current,
    minScore: minScore !== undefined ? minScore : current.minScore,
    confirmationMinMovePct: confirmationMinMovePct !== undefined ? confirmationMinMovePct : current.confirmationMinMovePct,
  };
  save(next);
  return next;
}

// Used only by the password-gated /api/import route. The password was
// already checked at the route level, so this writes directly. Always
// forces autoTradeEnabled off — restoring a backup should never silently
// re-enable live trading; the user re-enables it deliberately if they want.
function restore(partial) {
  const current = load();
  const next = {
    ...current,
    autoTradeEnabled: false,
    leverage: partial && partial.leverage !== undefined ? Number(partial.leverage) : current.leverage,
    usdtPerTrade: partial && partial.usdtPerTrade !== undefined ? Number(partial.usdtPerTrade) : current.usdtPerTrade,
  };
  save(next);
  return next;
}

// Used only by the password-gated /api/reset-all route.
function resetToDefaults() {
  save({ ...DEFAULTS });
  return { ...DEFAULTS };
}

module.exports = { get, update, restore, setAutoTuning, applyLearningAdjustment, resetToDefaults };
