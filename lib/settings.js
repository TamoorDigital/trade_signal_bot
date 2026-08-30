const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

const DEFAULTS = { autoTradeEnabled: false, leverage: 5, usdtPerTrade: 20 };

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
  if (password !== expected) {
    const err = new Error('Incorrect password');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  const current = load();
  const next = {
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

module.exports = { get, update };
