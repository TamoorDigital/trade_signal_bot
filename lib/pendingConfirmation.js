// Entry-side confirmation gate — the counterpart to the post-TP continuation
// gate (lib/continuation.js).
//
// A signal that clears MIN_SCORE + Gemini does NOT open a trade immediately.
// It sits in "pending" first. Every tracking cycle we check what price has
// actually done since the signal fired:
//   - price reached the PLANNED stop-loss before ever confirming -> the
//     setup already invalidated itself; DISCARD, no trade of any kind opens.
//   - price has moved a MEANINGFUL amount in the favorable direction since
//     the planned entry (scaled to volatility, see minMove below) AND fresh
//     structure still confirms -> CONFIRMED: open the real trade now.
//   - neither yet, and still within the confirmation window -> keep waiting.
//   - window expires with no confirmation -> DISCARD as inconclusive.
//
// BUG FIXED 2026-09-10: the original version only ran the structural check
// (structure/swing/displacement/momentum from lib/continuation.js) without
// also requiring genuine NEW price movement. That check looks at "the last
// few candles" — and since the signal itself was built from those same
// recent candles, checking again 5-6 minutes later (one more candle) mostly
// just re-found the SAME displacement/structure that already existed at
// signal time, not new evidence. Result: 30 of 31 signals "confirmed" on
// the very first eligible check (~5-6 min), which is a rubber stamp, not a
// real filter — it added a delay (worsening entry price) without actually
// verifying anything new. The fix: require an explicit, hard, unambiguous
// NEW-information check — has price actually moved a meaningful distance
// in our favor since the planned entry — as well as the structural check.

const { fetchLastPrice, fetchKlines } = require('./mexcClient');
const { checkContinuation } = require('./continuation');
const { avgRange } = require('./indicators');
const store = require('./store');
const settings = require('./settings');
const mexcOrders = require('./mexcOrders');
const learningState = require('./learningState');

const MIN_WAIT_MS = parseInt(process.env.PENDING_MIN_WAIT_MS || '300000', 10);       // 5 min — let at least one fresh 5m candle form
const TIMEOUT_MS = parseInt(process.env.PENDING_CONFIRMATION_TIMEOUT_MS || '1800000', 10); // 30 min — give up if no confirmation by then

async function openConfirmedTrade(pending, currentPrice, log) {
  const trade = {
    ...pending,
    entry: currentPrice, // actual fill/confirmation price, not the stale planned entry
    status: 'open',
    hits: { tp1: false, tp2: false, tp3: false },
    lastPrice: currentPrice,
    openedAt: Date.now(),
    confirmedFrom: { plannedEntry: pending.plannedEntry, waitedMs: Date.now() - pending.createdAt },
    autoTraded: false,
    exchangeOrder: null,
  };
  delete trade.plannedEntry;
  delete trade.createdAt;

  const cfg = settings.get();
  if (cfg.autoTradeEnabled) {
    try {
      const order = await mexcOrders.openPosition({
        symbol: trade.symbol,
        direction: trade.direction,
        usdtMargin: cfg.usdtPerTrade,
        leverage: cfg.leverage,
        sl: trade.sl,
        finalTp: trade.tps[trade.tps.length - 1],
      });
      trade.autoTraded = true;
      trade.exchangeOrder = { orderId: order.orderId, vol: order.vol, leverage: order.leverageUsed, openedAt: Date.now() };
      log(`[confirm] ${trade.symbol}: LIVE ORDER PLACED orderId=${order.orderId} vol=${order.vol} leverage=${order.leverageUsed}x`);
    } catch (err) {
      log(`[confirm] ${trade.symbol}: AUTO-TRADE FAILED (${err.message}) — trade still tracked, but NO live order was placed.`);
    }
  }

  store.confirmPendingTrade(pending.id, trade);
  log(`[confirm] ${trade.symbol}: CONFIRMED and OPENED ${trade.direction.toUpperCase()} @ ${trade.entry} (waited ${Math.round(trade.confirmedFrom.waitedMs / 60000)} min, moved ${((currentPrice - pending.plannedEntry) / pending.plannedEntry * (pending.direction === 'long' ? 1 : -1) * 100).toFixed(2)}% favorably from planned entry ${trade.confirmedFrom.plannedEntry})`);
}

async function checkPendingConfirmations(log = () => {}) {
  const pendingList = store.getPendingTrades();
  const now = Date.now();

  for (const p of pendingList) {
    const isShort = p.direction === 'short';
    let price;
    try {
      price = await fetchLastPrice(p.symbol);
    } catch (err) {
      log(`[confirm] ${p.symbol}: price fetch failed (${err.message}), will retry next cycle`);
      continue;
    }

    // Hard invalidation: price already reached the planned stop before we
    // ever confirmed the move — the setup failed before we risked anything.
    const hitPlannedSl = isShort ? price >= p.sl : price <= p.sl;
    if (hitPlannedSl) {
      store.discardPendingTrade(p.id, 'price reached planned SL before confirmation — setup invalidated, no trade opened');
      learningState.incrementOutcome('sl');
      log(`[confirm] ${p.symbol}: DISCARDED — price hit the planned SL (${p.sl}) before ever confirming. No trade opened, no loss taken.`);
      continue;
    }

    // Timeout: waited long enough, still no clear move — give up on it.
    if (now - p.createdAt > TIMEOUT_MS) {
      store.discardPendingTrade(p.id, 'confirmation window expired with no clear directional move');
      learningState.incrementOutcome('timeout');
      log(`[confirm] ${p.symbol}: DISCARDED — no confirmation within ${Math.round(TIMEOUT_MS / 60000)} min. No trade opened.`);
      continue;
    }

    // Too soon to judge fresh structure — need at least one new candle.
    if (now - p.createdAt < MIN_WAIT_MS) continue;

    let fresh5m, cont;
    try {
      fresh5m = await fetchKlines(p.symbol, '5m');
      cont = checkContinuation(p.direction, fresh5m);
    } catch (err) {
      log(`[confirm] ${p.symbol}: structure check failed (${err.message}), will retry next cycle`);
      continue;
    }

    // Hard, objective, NEW-information requirement: price must have actually
    // moved a meaningful distance (scaled to volatility) in our favor since
    // the planned entry — this can't be satisfied by re-reading old,
    // pre-signal structure, unlike the structural check alone.
    const range5 = avgRange(fresh5m, 20) || p.plannedEntry * 0.001;
    const minMovePct = settings.get().confirmationMinMovePct;
    const minMove = Math.max(range5 * 0.5, p.plannedEntry * minMovePct);
    const actualMove = isShort ? (p.plannedEntry - price) : (price - p.plannedEntry);
    const priceConfirmed = actualMove >= minMove;

    if (priceConfirmed && cont.valid) {
      learningState.incrementOutcome('confirmed'); // not a discard, but same counter bucket for the confirm-rate ratio
      await openConfirmedTrade(p, price, log);
    } else if (!priceConfirmed) {
      log(`[confirm] ${p.symbol}: waiting — price has only moved ${(actualMove / p.plannedEntry * 100).toFixed(2)}% favorably, need ${(minMove / p.plannedEntry * 100).toFixed(2)}%`);
    }
    // else: price moved enough but structure not confirmed yet — keep waiting silently.
  }
}

module.exports = { checkPendingConfirmations };
