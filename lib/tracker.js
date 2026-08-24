const { fetchLastPrice } = require('./mexcClient');
const store = require('./store');

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
    const hits = trade.hits || { tp1: false, tp2: false, tp3: false };
    const hitSl = isShort ? price >= trade.sl : price <= trade.sl;

    if (!hits.tp1 && (isShort ? price <= trade.tps[0] : price >= trade.tps[0])) hits.tp1 = true;
    if (hits.tp1 && !hits.tp2 && (isShort ? price <= trade.tps[1] : price >= trade.tps[1])) hits.tp2 = true;
    if (hits.tp2 && !hits.tp3 && (isShort ? price <= trade.tps[2] : price >= trade.tps[2])) hits.tp3 = true;

    if (hits.tp3) {
      store.closeTrade(trade.id, { result: 'win', closeReason: 'TP3 hit', hits, lastPrice: price });
      log(`[tracker] ${trade.symbol} closed WIN (TP3)`);
      continue;
    }
    if (hitSl) {
      const anyTp = hits.tp1 || hits.tp2 || hits.tp3;
      const reason = anyTp ? `SL hit after ${hits.tp2 ? 'TP2' : 'TP1'} (partial)` : 'SL hit';
      store.closeTrade(trade.id, { result: anyTp ? 'partial' : 'loss', closeReason: reason, hits, lastPrice: price });
      log(`[tracker] ${trade.symbol} closed ${anyTp ? 'PARTIAL' : 'LOSS'}`);
      continue;
    }

    store.updateOpenTrade(trade.id, {
      hits,
      lastPrice: price,
      status: hits.tp2 ? 'tp2_hit' : hits.tp1 ? 'tp1_hit' : 'open',
    });
  }
}

module.exports = { trackOnce };
