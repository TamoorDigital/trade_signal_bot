const axios = require('axios');

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
  const payload = {
    symbol,
    candidate_direction: candidate.direction,
    our_score: candidate.score,
    max_score: maxScore,
    min_score_required: minScore,
    weights: {
      htf_bias_1h: 15, ema200_trend_regime: 12, fresh_15m_poi: 22,
      sweep_5m: 16, bos_5m: 12, choch_5m: 5, crt_tbs_confirmation: 4,
      momentum_volume: 5, candle_pattern: 2,
    },
    // arrays: [unix_seconds, open, high, low, close, volume]
    candles_1h: compact(c1h, 40),
    candles_15m: compact(c15m, 40),
    candles_5m: compact(c5m, 40),
  };
  return `You are an independent SMC (smart money concepts) trading analyst. `
    + `Given raw OHLCV candles for 1h/15m/5m timeframes for ${symbol}, evaluate the ${candidate.direction.toUpperCase()} setup `
    + `using the SAME weighted checklist as our engine (weights given below, total ${maxScore}). `
    + `Give PARTIAL CREDIT per criterion based on how strong the condition is (0 to that criterion's weight) — do not just award full or zero weight. `
    + `Score independently from scratch — do not just copy our_score. `
    + `Respond with ONLY compact JSON, no prose, no markdown fences, matching exactly: `
    + `{"direction":"long|short|none","score":number,"valid":boolean,"breakdown":{"htf_bias_1h":number,"ema200_trend_regime":number,"fresh_15m_poi":number,"sweep_5m":number,"bos_5m":number,"choch_5m":number,"crt_tbs_confirmation":number,"momentum_volume":number,"candle_pattern":number},"reasons":["short reason", ...],"sl_note":"where SL should sit and why","tp_note":"where TP levels should sit and why"}. `
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

async function callGeminiWithFailover(prompt) {
  const keys = getKeys();
  if (!keys.length) throw new Error('No GEMINI_API_KEY_1/2/3 configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  let lastErr;
  for (const key of keys) {
    try {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        },
        { timeout: 20000 }
      );
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      return extractJson(text);
    } catch (err) {
      lastErr = err;
      // try next key
    }
  }
  throw new Error(`All Gemini API keys failed: ${lastErr?.message}`);
}

async function independentCheck(symbol, candidate, c1h, c15m, c5m, minScore, maxScore) {
  const prompt = buildPrompt(symbol, candidate, c1h, c15m, c5m, minScore, maxScore);
  return callGeminiWithFailover(prompt);
}

// Generic entry point: any caller can hand Gemini a prompt and get back
// parsed JSON, using the same 3-key failover as signal scoring. Used by
// lib/feedback.js for the trade-history self-review.
async function askGeminiJson(prompt) {
  return callGeminiWithFailover(prompt);
}

module.exports = { independentCheck, askGeminiJson };
