// Backtests the continuation gate's own decisions against what actually
// happened afterward. When a trade closes because the continuation check
// said "invalid" (lib/continuation.js), we don't just trust that call — we
// wait a while (CONTINUATION_AUDIT_DELAY_MS, default 30 min) and then check
// where price actually went:
//   'correct'     — price didn't reach the next un-hit TP; closing early
//                    genuinely protected profit.
//   'premature'   — price went on to reach the next un-hit TP anyway; the
//                    gate cost us that additional profit.
//   'inconclusive' — moved in the favorable direction but didn't reach the
//                    next target within the check window either way.
// This gives ground-truth data (not just correlational win-rate stats) for
// deciding whether the gate's thresholds need loosening or tightening.

const store = require('./store');
const { fetchLastPrice } = require('./mexcClient');

function needsAudit(t) {
  return t.continuationAudit && t.continuationAudit.pending === true
    && Date.now() >= t.continuationAudit.checkAt;
}

async function runAuditCheck(log = () => {}) {
  const closed = store.getClosedTrades();
  const due = closed.filter(needsAudit);

  for (const t of due) {
    let price;
    try {
      price = await fetchLastPrice(t.symbol);
    } catch (err) {
      log(`[audit] price fetch failed for ${t.symbol}: ${err.message}`);
      continue;
    }

    const hitCount = Object.values(t.hits || {}).filter(Boolean).length;
    const nextTarget = t.tps[hitCount]; // the TP we never reached because we exited early
    const exitPrice = t.lastPrice;
    const isLong = t.direction === 'long';

    const movedFavorably = isLong ? price > exitPrice : price < exitPrice;
    const reachedNextTarget = nextTarget !== undefined
      && (isLong ? price >= nextTarget : price <= nextTarget);
    const pctMoveFromExit = ((price - exitPrice) / exitPrice) * (isLong ? 1 : -1) * 100;

    let verdict;
    if (reachedNextTarget) verdict = 'premature';
    else if (movedFavorably) verdict = 'inconclusive';
    else verdict = 'correct';

    store.updateClosedTrade(t.id, {
      continuationAudit: {
        pending: false,
        verdict,
        priceAtCheck: price,
        checkedAt: Date.now(),
        pctMoveFromExit: +pctMoveFromExit.toFixed(3),
        nextTargetWas: nextTarget,
      },
    });
    log(`[audit] ${t.symbol}: continuation-gate verdict = ${verdict.toUpperCase()} (moved ${pctMoveFromExit.toFixed(2)}% from exit since close; next un-hit target was ${nextTarget})`);
  }
}

module.exports = { runAuditCheck };
