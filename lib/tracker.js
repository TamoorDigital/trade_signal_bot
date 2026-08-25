const { fetchLastPrice } = require('./mexcClient');
const store = require('./store');

// Trailing-stop rule, generalized for any number of TPs:
//  - TP1 hit  -> SL trails to entry
//  - TP2 hit  -> SL trails to TP1
//  - TP3 hit  -> SL trails to TP2 ... and so on
//  - Last TP hit -> full WIN, trade closes immediately (nothing left to trail)
// If the trailed SL is then tagged, the trade closes as a "partial":
//  - tagged at entry (only TP1 had hit)      -> result 'partial'
//  - tagged at TP(n-1) for n >= 2            -> result 'partial_profit'

function trailLevelFor(tpIndex, entry, tps) {
  // tpIndex is 0-based (0 = TP1). Returns the new SL level once that TP hits.
  return tpIndex === 0 ? entry : tps[tpIndex - 1];
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
    let newlyTrailedTo = null; // { tpIndex, level } if a TP was hit this cycle

    // Walk TPs in order; only the next un-hit TP can trigger this cycle.
    for (let i = 0; i < tps.length; i++) {
      const key = `tp${i + 1}`;
      if (hits[key]) continue; // already hit earlier
      const reached = isShort ? price <= tps[i] : price >= tps[i];
      if (!reached) break; // TPs are ordered by distance, stop checking further ones
      hits[key] = true;

      if (i === tps.length - 1) {
        // Final TP — trade is fully done, no trailing needed.
        store.closeTrade(trade.id, {
          result: 'win',
          closeReason: `TP${i + 1} hit (final target)`,
          hits,
          lastPrice: price,
          sl: currentSl,
        });
        log(`[tracker] ${trade.symbol} closed WIN (TP${i + 1})`);
        newlyTrailedTo = 'closed';
        break;
      } else {
        currentSl = trailLevelFor(i, trade.entry, tps);
        newlyTrailedTo = { tpIndex: i, level: currentSl };
      }
    }
    if (newlyTrailedTo === 'closed') continue;

    // If a TP hit this cycle moved the stop, persist it and log why.
    if (newlyTrailedTo) {
      const label = newlyTrailedTo.tpIndex === 0 ? 'entry' : `TP${newlyTrailedTo.tpIndex}`;
      log(`[tracker] ${trade.symbol} TP${newlyTrailedTo.tpIndex + 1} hit — SL trailed to ${label} (${currentSl})`);
    }

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
        reason = 'Closed at entry (SL trailed to breakeven after TP1)';
      } else {
        result = 'partial_profit';
        reason = `Closed at TP${hitCount - 1} (SL trailed after TP${hitCount})`;
      }
      store.closeTrade(trade.id, { result, closeReason: reason, hits, lastPrice: price, sl: currentSl });
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
