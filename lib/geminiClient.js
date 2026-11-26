const axios = require('axios');
const { ema } = require('./indicators');

function getKeys() {
  return [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3]
    .filter(Boolean);
}

// Round + trim candles to keep the payload (and token cost) small.
function compact(candles, n) {
  return candles.slice(-n).map(c => [
    Math.round(c.time / 1000),
    +c.open.toFixed(6), +c.high.toFixed(6), +c.low.toFixed(6), +c.close.toFixed(6),
    +c.volume.toFixed(2),
  ]);
}

function buildPrompt(symbol, candidate, c1h, c15m, c5m, minScore, maxScore) {
  const closes1h = c1h.map(c => c.close);
  const closes15m = c15m.map(c => c.close);
  const ema50_1h = ema(closes1h, 50);
  const ema200_1h = ema(closes1h, 200);
  const ema200_15m = ema(closes15m, 200);
  const payload = {
    symbol,
    candidate_direction: candidate.direction,
    our_score: candidate.score,
    max_score: maxScore,
    min_score_required: minScore,
    weights: {
      htf_bias_1h: 17, ema200_trend_regime: 8, fresh_15m_poi: 24,
      sweep_5m: 9, bos_5m: 15, choch_5m: 9, crt_tbs_confirmation: 2,
      momentum_volume: 7, candle_pattern: 2,
    },
    // EMA200 needs 600 bars to converge; provide exact values so Gemini isn't
    // forced to guess EMA200 from the 100-candle window below.
    ema_context: {
      ema50_1h: +ema50_1h[ema50_1h.length - 1].toFixed(6),
      ema200_1h: +ema200_1h[ema200_1h.length - 1].toFixed(6),
      ema200_15m: +ema200_15m[ema200_15m.length - 1].toFixed(6),
    },
    // arrays: [unix_seconds, open, high, low, close, volume]
    // 100 15m bars for Fibonacci impulse leg; 60 bars of 1h/5m is plenty for
    // AVWAP/RSI/sweep since ema_context already supplies 600-bar EMA50/EMA200.
    candles_1h: compact(c1h, 100),
    candles_15m: compact(c15m, 100),
    candles_5m: compact(c5m, 100),
  };
  return `You are an independent SMC (smart money concepts) trading analyst. `
    + `Given raw OHLCV candles for 1h/15m/5m timeframes for ${symbol}, evaluate the ${candidate.direction.toUpperCase()} setup `
    + `using the SAME weighted checklist as our engine (weights given below, total ${maxScore}). `
    + `Give PARTIAL CREDIT per criterion based on how strong the condition is (0 to that criterion's weight) — do not just award full or zero weight. `
    + `Score independently from scratch — do not just copy our_score. `
    + `SECOND TASK: also score three independent strategies, each 0-10 FOR THE ${candidate.direction.toUpperCase()} DIRECTION ONLY, from the same raw candles. `
    + `Points for a condition that supports the OPPOSITE direction must be 0. If both LONG and SHORT conditions of a strategy are fully satisfied, give that strategy 0. `
    + `The LAST candle of every timeframe may still be forming: ignore it for all three strategies (closed candles only). Give partial credit inside each part (whole or half points). `
    + `RSI (14, Wilder), parts: bias_1h max 3 (1H RSI on the trade side of 50, full at 60+/40-); pullback_recovery_15m max 4 (15M RSI reached <=40 for long / >=60 for short within the last 12 closed bars, has recovered >=5 points from that extreme and is turning, not exhausted (>=70 long / <=30 short)); entry_5m max 3 (5M RSI above 45 and rising for long / below 55 and falling for short). `
    + `Anchored VWAP (anchored at the last 1H swing low for long / swing high for short, and at the biggest-bodied 1H candle of the last 30 = impulse), parts: alignment_1h max 4 (1H close beyond the swing AVWAP 1.5, beyond the impulse AVWAP 1.5, last 3 1H closes holding 1.0); pullback_15m max 3 (price touched/penetrated the AVWAP within the last 10 closed 15M bars 1, a 15M close back on the trade side 1, no close lost it since 1); retest_5m max 3 (AVWAP retested on 5M 1, latest 5M candle in trade direction 1, it closed on the trade side of AVWAP 1). `
    + `Fibonacci (largest 15M impulse leg in the trade direction, ended within the last 100 closed 15M bars, not exceeded since), parts: impulse_leg max 3; zone max 3 (deepest 5M retracement in last 8 bars: >=0.618 3, >=0.5 2, >=0.382 1, broke leg start 0); swing_intact max 1; confirm_5m max 3 (only if 0.5 reached: trade-direction 5M candle 1, close beyond the 0.786 level 1, higher low / lower high than the pullback extreme 1). `
    + `Respond with ONLY compact JSON, no prose, no markdown fences, matching exactly: `
    + `{"direction":"long|short|none","score":number,"valid":boolean,"breakdown":{"htf_bias_1h":number,"ema200_trend_regime":number,"fresh_15m_poi":number,"sweep_5m":number,"bos_5m":number,"choch_5m":number,"crt_tbs_confirmation":number,"momentum_volume":number,"candle_pattern":number},"strategies":{"rsi":{"score":number,"parts":{"bias_1h":number,"pullback_recovery_15m":number,"entry_5m":number}},"avwap":{"score":number,"parts":{"alignment_1h":number,"pullback_15m":number,"retest_5m":number}},"fib":{"score":number,"parts":{"impulse_leg":number,"zone":number,"swing_intact":number,"confirm_5m":number}}},"reasons":["short reason", ...],"sl_note":"where SL should sit and why","tp_note":"where TP levels should sit and why"}. `
    + `Each "breakdown" value must be between 0 and that criterion's weight (see weights below), and they must sum to "score". `
    + `"score" must be 0-${maxScore}. "valid" must be true only if score >= min_score_required AND direction matches candidate_direction. `
    + `Data:\n${JSON.stringify(payload)}`;
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Gemini response had no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function buildGenerationConfig(model) {
  const cfg = { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 2048 };
  const m = String(model || '').toLowerCase();
  // gemini-2.5-flash enables dynamic thinking by default, which spends 45s+
  // crunching arithmetic on 200+ OHLCV arrays and hits the request timeout.
  // Cap/disable thinking per model family (override via GEMINI_THINKING_BUDGET).
  const budgetEnv = process.env.GEMINI_THINKING_BUDGET;
  if (m.includes('gemini-2.5-pro')) {
    cfg.thinkingConfig = { thinkingBudget: budgetEnv !== undefined ? parseInt(budgetEnv, 10) : 512 };
  } else if (m.includes('gemini-2.5')) {
    cfg.thinkingConfig = { thinkingBudget: budgetEnv !== undefined ? parseInt(budgetEnv, 10) : 0 };
  } else if (m.includes('gemini-3')) {
    cfg.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'low' };
  }
  return cfg;
}

async function callGeminiWithFailover(prompt) {
  const keys = getKeys();
  if (!keys.length) throw new Error('No GEMINI_API_KEY_1/2/3 configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const timeout = parseInt(process.env.GEMINI_TIMEOUT_MS || '90000', 10);
  const generationConfig = buildGenerationConfig(model);

  let lastErr;
  for (const key of keys) {
    try {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        },
        { timeout }
      );
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      return extractJson(text);
    } catch (err) {
      const apiMsg = err.response?.data?.error?.message;
      lastErr = apiMsg ? new Error(`${err.message}: ${apiMsg}`) : err;
      // try next key
    }
  }
  throw new Error(`All Gemini API keys failed: ${lastErr?.message}`);
}

async function independentCheck(symbol, candidate, c1h, c15m, c5m, minScore, maxScore) {
  const prompt = buildPrompt(symbol, candidate, c1h, c15m, c5m, minScore, maxScore);
  const res = await callGeminiWithFailover(prompt);
  if (res && typeof res.direction === 'string') res.direction = res.direction.toLowerCase();
  return res;
}

// Generic entry point: any caller can hand Gemini a prompt and get back
// parsed JSON, using the same 3-key failover as signal scoring. Used by
// lib/feedback.js for the trade-history self-review.
async function askGeminiJson(prompt) {
  return callGeminiWithFailover(prompt);
}

module.exports = { independentCheck, askGeminiJson };
