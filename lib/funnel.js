const fs = require('fs');
const path = require('path');

// Counts how many signals reach / die at each stage of the pipeline, per UTC
// day, persisted in data/funnel.json. The Activity Log only keeps ~100 lines
// (a single 10-symbol scan can push everything else out), so it can't answer
// "why am I getting so few trades?" — this can.
const FILE = path.join(__dirname, '..', 'data', 'funnel.json');
const KEEP_DAYS = 14;

// Display order + labels (the dashboard renders this list).
const STAGES = [
  ['scanned', 'Symbols scanned'],
  ['scan_error', 'Scan errors (data / API)'],
  ['long_only_skipped', 'Skipped: LONG_ONLY=1 and best setup was short'],
  ['smc_below_min', 'SMC score below minScore'],
  ['smc_far', '   ...of which far below (more than 20 points under min)'],
  ['smc_mid', '   ...of which 10-20 points under min'],
  ['smc_near', '   ...of which near miss (within 10 points of min)'],
  ['smc_passed', 'SMC passed minScore'],
  ['strategies_failed', 'Not enough strategies passed (RSI / AVWAP / Fib)'],
  ['strategies_passed', 'Enough strategies passed -> sent to Gemini'],
  ['gemini_error', 'Gemini call failed (keys / quota / parse)'],
  ['gemini_rejected', 'Gemini disagreed on SMC (direction / score / invalid)'],
  ['gemini_strategies_rejected', 'Gemini strategy scores too low'],
  ['gemini_passed', 'Gemini confirmed'],
  ['plan_no_structure', 'No valid sweep structure for SL'],
  ['plan_rr_rejected', 'R:R too small for TP2/TP3 at signal time'],
  ['pending_created', 'Signal created (waiting for price confirmation)'],
  ['pending_discarded_sl', 'Pending: price hit planned SL first'],
  ['pending_discarded_timeout', 'Pending: no confirmation in time'],
  ['pending_discarded_rr', 'Pending: R:R too small at real entry'],
  ['trades_opened', 'TRADES OPENED'],
];

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = { days: {} }; }
  if (!db.days) db.days = {};
  return db;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
  } catch { /* diagnostics must never break trading */ }
}

function hit(stage, n = 1) {
  const d = load();
  const day = new Date().toISOString().slice(0, 10);
  d.days[day] = d.days[day] || {};
  d.days[day][stage] = (d.days[day][stage] || 0) + n;
  const keys = Object.keys(d.days).sort();
  while (keys.length > KEEP_DAYS) delete d.days[keys.shift()];
  save();
}

function get() {
  const d = load();
  const days = Object.keys(d.days).sort().slice(-7);
  const today = new Date().toISOString().slice(0, 10);
  return {
    stages: STAGES.map(([key, label]) => ({
      key, label,
      today: (d.days[today] || {})[key] || 0,
      last7: days.reduce((a, day) => a + ((d.days[day] || {})[key] || 0), 0),
    })),
    daysCovered: days.length,
  };
}

module.exports = { hit, get };
