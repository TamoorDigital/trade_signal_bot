// MEXC Futures PRIVATE (authenticated) API — order placement.
//
// This is a separate module from mexcClient.js on purpose: mexcClient.js only
// ever reads public market data and is safe to retry aggressively.
// Everything here places or closes real positions with real money, so:
//   - order-placement calls are NEVER auto-retried. A network timeout does
//     not guarantee the order didn't go through — blindly retrying could
//     open or close a position twice. On failure we log loudly and stop;
//     a human should check the MEXC account directly.
//   - read-only calls here (contract spec, sizing) reuse mexcClient's
//     throttle so they respect the same request pacing.
//
// Base URL and auth scheme per MEXC's official Futures API docs
// (mexc.com/api-docs/futures/integration-guide, fetched Aug 2026):
//   - Base: https://api.mexc.com
//   - Headers: ApiKey, Request-Time (ms), Signature
//   - Signature = HMAC_SHA256(secretKey, accessKey + timestamp + paramString)
//     paramString: POST -> raw JSON body string (no sorting).
//                  GET  -> dictionary-sorted "k=v&k=v" query string.

const axios = require('axios');
const crypto = require('crypto');
const { fetchLastPrice, fetchContractDetail, throttledCall } = require('./mexcClient');

const PRIVATE_BASE = 'https://api.mexc.com';

function credsOrThrow() {
  const accessKey = process.env.MEXC_ACCESS_KEY;
  const secretKey = process.env.MEXC_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error('MEXC_ACCESS_KEY / MEXC_SECRET_KEY not configured — cannot place live orders');
  }
  return { accessKey, secretKey };
}

function sign(accessKey, secretKey, timestamp, paramString) {
  return crypto.createHmac('sha256', secretKey).update(accessKey + timestamp + paramString).digest('hex');
}

// Read-only private call (e.g. querying an order) — safe to throttle/retry
// the same way public calls are, since it can't duplicate a side effect.
async function privateGet(path, params = {}) {
  const { accessKey, secretKey } = credsOrThrow();
  return throttledCall(async () => {
    const timestamp = Date.now().toString();
    const sortedKeys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null).sort();
    const paramString = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    const signature = sign(accessKey, secretKey, timestamp, paramString);
    const { data } = await axios.get(`${PRIVATE_BASE}${path}`, {
      params, timeout: 10000,
      headers: { ApiKey: accessKey, 'Request-Time': timestamp, Signature: signature },
    });
    if (!data || data.success === false) throw new Error(`MEXC private GET ${path} failed: ${JSON.stringify(data)}`);
    return data.data;
  });
}

// Side-effecting private call (place/close order) — called at most ONCE,
// no retry wrapper. Caller must handle the failure explicitly.
async function privatePostOnce(path, body = {}) {
  const { accessKey, secretKey } = credsOrThrow();
  const timestamp = Date.now().toString();
  const paramString = JSON.stringify(body);
  const signature = sign(accessKey, secretKey, timestamp, paramString);
  const { data } = await axios.post(`${PRIVATE_BASE}${path}`, body, {
    timeout: 15000,
    headers: {
      ApiKey: accessKey, 'Request-Time': timestamp, Signature: signature,
      'Content-Type': 'application/json',
    },
  });
  if (!data || data.success === false) {
    throw new Error(`MEXC private POST ${path} failed: ${JSON.stringify(data)}`);
  }
  return data.data;
}

function roundToStep(value, step) {
  if (!step || step <= 0) return value;
  return Math.floor(value / step) * step;
}

// MEXC caps max leverage per symbol (majors like BTC/ETH often allow 100x+,
// smaller/newer listings are frequently capped much lower, e.g. 20x or 50x).
// If the requested leverage exceeds what the symbol allows, we clamp down to
// the symbol's maximum rather than let the order fail — and clamp up to its
// minimum on the rare case a symbol's floor is above 1x.
function clampLeverage(requested, detail) {
  const min = detail.minLeverage || 1;
  const max = detail.maxLeverage || requested;
  return Math.max(min, Math.min(requested, max));
}

// Converts a USDT margin amount into the "vol" (number of contracts) the
// order API expects: notional = margin * effectiveLeverage; vol = notional / (price * contractSize).
// Also returns the leverage actually used, after clamping to the symbol's
// exchange-allowed min/max — this may differ from the requested leverage.
async function computeOrderVol(symbol, usdtMargin, requestedLeverage, price) {
  const detail = await fetchContractDetail(symbol);
  const contractSize = detail.contractSize;
  const volUnit = detail.volUnit || 1;
  const minVol = detail.minVol || 1;
  const leverage = clampLeverage(requestedLeverage, detail);
  const notional = usdtMargin * leverage;
  let vol = notional / (price * contractSize);
  vol = roundToStep(vol, volUnit);
  if (vol < minVol) vol = minVol;
  return {
    vol, contractSize, minVol, volUnit,
    leverage, requestedLeverage,
    maxLeverage: detail.maxLeverage, minLeverage: detail.minLeverage,
    wasClamped: leverage !== requestedLeverage,
  };
}

// side: 1 open long, 2 close short, 3 open short, 4 close long
const SIDE = { openLong: 1, closeShort: 2, openShort: 3, closeLong: 4 };

// Opens a live position sized from usdtMargin+leverage, with the ORIGINAL
// hard SL and final TP embedded on the exchange as a dead-man's-switch safety
// net (in case this server goes down). Our own trailing logic below does NOT
// keep the exchange stop in sync in real time — see README for why.
// If the requested leverage exceeds this symbol's max, it's automatically
// clamped down to that symbol's maximum allowed leverage (see clampLeverage).
async function openPosition({ symbol, direction, usdtMargin, leverage: requestedLeverage, sl, finalTp }) {
  const price = await fetchLastPrice(symbol);
  const sizing = await computeOrderVol(symbol, usdtMargin, requestedLeverage, price);
  const body = {
    symbol, price, vol: sizing.vol, leverage: sizing.leverage,
    side: direction === 'long' ? SIDE.openLong : SIDE.openShort,
    type: 5,          // market
    openType: 1,       // isolated margin — caps risk to this position's margin
    stopLossPrice: sl,
    takeProfitPrice: finalTp,
  };
  const data = await privatePostOnce('/api/v1/private/order/create', body);
  return {
    orderId: data.orderId, vol: sizing.vol, entryPriceRef: price,
    leverageUsed: sizing.leverage, leverageRequested: requestedLeverage, wasClamped: sizing.wasClamped,
  };
}

// Closes the full position at market. flashClose:true tells MEXC to close
// the whole open position regardless of vol; we also pass the vol we opened
// with as a fallback in case flashClose isn't honored exactly as documented.
async function closePosition({ symbol, direction, vol }) {
  const price = await fetchLastPrice(symbol);
  const body = {
    symbol, price, vol: vol || 1,
    side: direction === 'long' ? SIDE.closeLong : SIDE.closeShort,
    type: 5,
    openType: 1,
    flashClose: true,
  };
  const data = await privatePostOnce('/api/v1/private/order/create', body);
  return { orderId: data.orderId };
}

module.exports = { openPosition, closePosition, computeOrderVol, privateGet };
