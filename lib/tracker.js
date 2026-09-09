const { fetchLastPrice, fetchKlines } = require('./mexcClient');
const { checkContinuation } = require('./continuation');
const store = require('./store');
const mexcOrders = require('./mexcOrders');

// Trailing-stop rule, generalized for any number of TPs:
//  - TP1 hit -> if continuation still VALID, SL trails to entry + a small
//    fee buffer (NOT exact entry — a literal breakeven exit is a net loss
//    once round-trip exchange fees are counted, so we pad it in the
//    favorable direction by BREAKEVEN_FEE_BUFFER_PCT)
//  - TP2 hit -> if continuation still VALID, SL trails to TP1
//  - TP3 hit -> if continuation still VALID, SL trails to TP2 ... and so on
//  - Last TP hit -> full WIN, closes immediately (nothing left to trail)
// At EVERY non-final TP, before trailing, we re-check fresh 5m structure:
//  - if VALID  -> keep riding, trail the stop as above
//  - if INVALID -> close the whole position right now at market, rather than
//    letting it ride back down to the trailed stop and give profit back.
// If a trailed stop (not an invalidation-exit) is later tagged:
//  - tagged at the fee-buffered breakeven level (only TP1 had hit) -> 'partial'
//  - tagged at TP(n-1) for n >= 2                                  -> 'partial_profit'

function trailLevelFor(tpIndex, direction, entry, tps) {
  if (tpIndex === 0) {
    const feeBufferPct = parseFloat(process.env.BREAKEVEN_FEE_BUFFER_PCT || '0.001');
    const buffer = entry * feeBufferPct;
    return direction === 'long' ? entry + buffer : entry - buffer;
  }
  return tps[tpIndex - 1];
}

// Closes the trade in our own bookkeeping, and — if this trade has a live
// MEXC position — also submits a real closing market order. The exchange
// call is best-effort and NOT retried (see mexcOrders.js for why); a failure
// is logged loudly but never blocks our own tracking state from closing.
async function closeTrade(trade, patch, log) {
  store.closeTrade(trade.id, patch);
  if (trade.autoTraded && trade.exchangeOrder) {
    try {
      const res = await mexcOrders.closePosition({
        symbol: trade.symbol,
        direction: trade.direction,
        vol: trade.exchangeOrder.vol,
      });
      log(`[tracker] ${trade.symbol}: LIVE POSITION CLOSED on MEXC (orderId=${res.orderId})`);
    } catch (err) {
      log(`[tracker] ${trade.symbol}: !!! FAILED TO CLOSE LIVE MEXC POSITION (${err.message}) — check your MEXC account manually right now.`);
    }
  }
}

async function trackOnce(log = () => {}) {
  const open = store.getOpenTrades();
  for (const trade of open) {
    let price;
    try {
      price = await fetchLastPrice(trade.symbol);
    } catch (err) {
      log(`[tracker] price fetch failed for ${trade.symbol}: ${err.message}`);
      continue;
    }

    const isShort = trade.direction === 'short';
    const tps = trade.tps;
    const hits = trade.hits || {};
    let currentSl = trade.sl;
    let outcome = null; // 'closed' if this trade is fully done this cycle

    for (let i = 0; i < tps.length; i++) {
      const key = `tp${i + 1}`;
      if (hits[key]) continue;
      const reached = isShort ? price <= tps[i] : price >= tps[i];
      if (!reached) break; // TPs are ordered by distance — stop checking further ones
      hits[key] = true;

      if (i === tps.length - 1) {
        // Final TP — full target achieved, no continuation check needed.
        await closeTrade(trade, {
          result: 'win',
          closeReason: `TP${i + 1} hit (final target)`,
          hits, lastPrice: price, sl: currentSl,
        }, log);
        log(`[tracker] ${trade.symbol} closed WIN (TP${i + 1})`);
        outcome = 'closed';
        break;
      }

      // Not the final TP — re-check fresh 5m structure before trailing.
      let cont;
      try {
        const fresh5m = await fetchKlines(trade.symbol, '5m');
        cont = checkContinuation(trade.direction, fresh5m);
      } catch (err) {
        log(`[tracker] ${trade.symbol}: continuation check failed (${err.message}), defaulting to keep trailing`);
        cont = { valid: true, reasons: ['continuation check unavailable this cycle, defaulted to valid'] };
      }

      if (!cont.valid) {
        await closeTrade(trade, {
          result: 'partial_profit',
          closeReason: `TP${i + 1} hit but continuation invalid (${cont.reasons.join('; ')}) — closed at market`,
          hits, lastPrice: price, sl: currentSl, continuationCheck: cont.checks,
          continuationAudit: {
            pending: true,
            checkAt: Date.now() + parseInt(process.env.CONTINUATION_AUDIT_DELAY_MS || '1800000', 10),
          },
        }, log);
        log(`[tracker] ${trade.symbol} closed after TP${i + 1} — continuation invalidated (${cont.reasons.join('; ')})`);
        outcome = 'closed';
        break;
      }

      currentSl = trailLevelFor(i, trade.direction, trade.entry, tps);
      const label = i === 0 ? 'entry' : `TP${i}`;
      log(`[tracker] ${trade.symbol} TP${i + 1} hit, continuation still valid — SL trailed to ${label} (${currentSl})`);
    }
    if (outcome === 'closed') continue;

    // Now check the (possibly trailed) SL against price.
    const hitSl = isShort ? price >= currentSl : price <= currentSl;
    if (hitSl) {
      const hitCount = Object.values(hits).filter(Boolean).length;
      let result, reason;
      if (hitCount === 0) {
        result = 'loss';
        reason = 'SL hit';
      } else if (hitCount === 1) {
        result = 'partial';
        reason = 'Closed just above entry (SL trailed to fee-covering breakeven after TP1)';
      } else {
        result = 'partial_profit';
        reason = `Closed at TP${hitCount - 1} (SL trailed after TP${hitCount})`;
      }
      await closeTrade(trade, { result, closeReason: reason, hits, lastPrice: price, sl: currentSl }, log);
      log(`[tracker] ${trade.symbol} closed ${result.toUpperCase()} (${reason})`);
      continue;
    }

    store.updateOpenTrade(trade.id, {
      hits,
      sl: currentSl,
      lastPrice: price,
      status: hits.tp2 ? 'tp2_hit' : hits.tp1 ? 'tp1_hit' : 'open',
    });
  }
}

module.exports = { trackOnce };
