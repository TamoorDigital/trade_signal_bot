const rsi = require('./rsiStrategy');
const avwap = require('./avwapStrategy');
const fib = require('./fibStrategy');
const { closedOnly } = require('./util');

// SMC (93 pts, compulsory) is scored elsewhere. Here the three independent
// strategies each score 0-10 for SMC's direction. A strategy PASSES when its
// score >= STRATEGY_MIN_SCORE (default 6) and its core setup component is > 0
// (so e.g. RSI bias + 5M entry alone can't pass without any 15M pullback).
// ALL three strategies are always fully evaluated (there is no off switch and
// no early exit), so every strategy's score is known for every signal. Only at
// the end is the count of passing strategies compared with STRATEGIES_REQUIRED
// (1, 2 or 3; default 1 => SMC + any one strategy = "2 out of 4"). A strategy
// that errors counts as 0 points and never stops the other two from running.
// The same requirement is applied to Gemini's own strategy scores.
const STRATEGY_MIN_SCORE = parseFloat(process.env.STRATEGY_MIN_SCORE || '6');
const STRATEGIES_REQUIRED = Math.max(1, Math.min(3, parseInt(process.env.STRATEGIES_REQUIRED || '1', 10) || 1));
const STRATEGY_MAX = 10;
const TF_MS = { '1h': 3600000, '15m': 900000, '5m': 300000 };
const MODULES = { rsi, avwap, fib };

function evaluateStrategies(smcDirection, c1h, c15m, c5m, now = Date.now()) {
  const h = closedOnly(c1h, TF_MS['1h'], now), m15 = closedOnly(c15m, TF_MS['15m'], now), m5 = closedOnly(c5m, TF_MS['5m'], now);
  const opposite = smcDirection === 'long' ? 'short' : 'long';
  const passes = (r) => r.score >= STRATEGY_MIN_SCORE && r.core;

  const strategies = {};
  let fibTargets = [];
  for (const [name, mod] of Object.entries(MODULES)) {
    let own, opp;
    try {
      own = mod.evaluate(smcDirection, h, m15, m5);
      opp = mod.evaluate(opposite, h, m15, m5);
    } catch (err) {
      strategies[name] = { score: 0, max: STRATEGY_MAX, parts: null, pass: false, conflict: false, oppositeScore: 0, reasons: [`error: ${err.message}`] };
      continue;
    }
    // Both LONG and SHORT conditions satisfied at once -> WAIT: no points.
    const conflict = passes(own) && passes(opp);
    const pass = !conflict && passes(own);
    strategies[name] = {
      score: conflict ? 0 : own.score, max: STRATEGY_MAX, parts: own.parts, pass, conflict,
      oppositeScore: opp.score, reasons: conflict ? ['LONG and SHORT conditions both met -> WAIT'] : own.reasons,
    };
    if (name === 'fib' && pass) fibTargets = own.targets || [];
  }
  const passed = Object.values(strategies).filter(s => s.pass).length;
  const summary = Object.entries(strategies)
    .map(([n, s]) => `${n.toUpperCase()} ${s.score}/${STRATEGY_MAX}${s.pass ? '✓' : s.conflict ? ' conflict' : ''}`).join(' | ');
  return { ok: passed >= STRATEGIES_REQUIRED, passed, required: STRATEGIES_REQUIRED, summary, strategies, fibTargets };
}

// Gemini returns its own strategy scores from raw candles. Same pass rule
// (score >= STRATEGY_MIN_SCORE), same required count.
function checkGeminiStrategies(raw) {
  const out = {};
  for (const name of Object.keys(MODULES)) {
    const s = (raw && raw[name]) || {};
    const score = Math.max(0, Math.min(STRATEGY_MAX, Number(s.score) || 0));
    out[name] = { score, max: STRATEGY_MAX, parts: s.parts || null, pass: score >= STRATEGY_MIN_SCORE };
  }
  const passed = Object.values(out).filter(s => s.pass).length;
  return { ok: passed >= STRATEGIES_REQUIRED, passed, required: STRATEGIES_REQUIRED, strategies: out };
}

module.exports = { evaluateStrategies, checkGeminiStrategies, STRATEGY_MIN_SCORE, STRATEGIES_REQUIRED };
