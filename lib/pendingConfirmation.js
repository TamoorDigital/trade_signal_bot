// Entry-side confirmation gate — the counterpart to the post-TP continuation
// gate (lib/continuation.js), reusing the SAME structure/swing/displacement/
// momentum check, just applied BEFORE a trade opens instead of after a TP.
//
// A signal that clears MIN_SCORE + Gemini does NOT open a trade immediately.
// It sits in "pending" first. Every tracking cycle we check what price has
// actually done since the signal fired:
//   - price reached the PLANNED stop-loss before ever confirming -> the
//     setup already invalidated itself; DISCARD, no trade of any kind opens.
//   - fresh 5m structure now passes the continuation check (same 4-check
//     logic, same 3-of-4-or-bypass rule) -> CONFIRMED: open the real trade
//     now, at the current price, and place a live order if auto-trade is on.
//   - neither yet, and still within the confirmation window -> keep waiting.
//   - window expires with no confirmation -> DISCARD as inconclusive.
//
// Net effect: fewer trades taken overall, but ones that ARE taken already
// have real price action behind them — the goal is to push the loss rate
// toward zero, accepting smaller profit-per-trade in exchange.

const { fetchLastPrice, fetchKlines } = require('./mexcClient');
const { checkContinuation } = require('./continuation');
const store = require('./store');
const settings = require('./settings');
const mexcOrders = require('./mexcOrders');

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
  log(`[confirm] ${trade.symbol}: CONFIRMED and OPENED ${trade.direction.toUpperCase()} @ ${trade.entry} (waited ${Math.round(trade.confirmedFrom.waitedMs / 60000)} min for confirmation, planned entry was ${trade.confirmedFrom.plannedEntry})`);
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
      log(`[confirm] ${p.symbol}: DISCARDED — price hit the planned SL (${p.sl}) before ever confirming. No trade opened, no loss taken.`);
      continue;
    }

    // Timeout: waited long enough, still no clear move — give up on it.
    if (now - p.createdAt > TIMEOUT_MS) {
      store.discardPendingTrade(p.id, 'confirmation window expired with no clear directional move');
      log(`[confirm] ${p.symbol}: DISCARDED — no confirmation within ${Math.round(TIMEOUT_MS / 60000)} min. No trade opened.`);
      continue;
    }

    // Too soon to judge fresh structure — need at least one new candle.
    if (now - p.createdAt < MIN_WAIT_MS) continue;

    let cont;
    try {
      const fresh5m = await fetchKlines(p.symbol, '5m');
      cont = checkContinuation(p.direction, fresh5m);
    } catch (err) {
      log(`[confirm] ${p.symbol}: structure check failed (${err.message}), will retry next cycle`);
      continue;
    }

    if (cont.valid) {
      await openConfirmedTrade(p, price, log);
    }
    // else: not yet confirmed but not invalidated either — keep waiting silently.
  }
}

module.exports = { checkPendingConfirmations };
