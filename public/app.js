const $ = (id) => document.getElementById(id);

// Same 9 criteria our engine (lib/scoring.js) and the Gemini prompt use.
const CRITERIA = [
  { label: 'HTF Bias (1h)',    ourKey: 'htfBias',        gemKey: 'htf_bias_1h',           weight: 20 },
  { label: 'Trend Regime',     ourKey: 'trendRegime',     gemKey: 'ema200_trend_regime',   weight: 15 },
  { label: 'Fresh 15m POI',    ourKey: 'freshPOI',        gemKey: 'fresh_15m_poi',         weight: 18 },
  { label: '5m Sweep',         ourKey: 'liquiditySweep',  gemKey: 'sweep_5m',              weight: 12 },
  { label: '5m BOS',           ourKey: 'bos',             gemKey: 'bos_5m',                weight: 12 },
  { label: 'CHoCH/MSS',        ourKey: 'choch',           gemKey: 'choch_5m',              weight: 5  },
  { label: 'CRT/TBS',          ourKey: 'crtTbs',          gemKey: 'crt_tbs_confirmation',  weight: 4  },
  { label: 'Momentum+Vol',     ourKey: 'momentumVolume',  gemKey: 'momentum_volume',       weight: 5  },
  { label: 'Candle Pattern',   ourKey: 'candlePattern',   gemKey: 'candle_pattern',         weight: 2  },
];

function renderBreakdown(t) {
  const bd = t.breakdown || {};
  const gbd = t.geminiBreakdown || null;
  const rows = CRITERIA.map(c => {
    const q = bd[c.ourKey] !== undefined ? bd[c.ourKey] : '-';
    const g = gbd && gbd[c.gemKey] !== undefined ? gbd[c.gemKey] : '-';
    return `<div class="bd-row"><span class="bd-label">${c.label}</span><span>Q ${q}/${c.weight}</span><span>G ${g}/${c.weight}</span></div>`;
  }).join('');
  return `<details class="score-details"><summary>Q:${fmt(t.ourScore)}/${t.maxScore} G:${fmt(t.geminiScore)}/${t.maxScore}</summary><div class="bd-box">${rows}</div></details>`;
}

function fmt(n) {
  if (n === undefined || n === null) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

async function refreshStatus() {
  const s = await (await fetch('/api/status')).json();
  $('statusDot').className = 'dot ' + (s.running ? 'running' : 'stopped');
  $('statusText').textContent = 'Scanning: ' + (s.running ? 'Running' : 'Stopped');
  $('trackStatusText').textContent = 'Tracking: ' + (s.trackingActive ? 'active (open trades always tracked)' : 'not started yet');
  $('logBox').textContent = s.logs.join('\n');
}

async function refreshStats() {
  const s = await (await fetch('/api/stats')).json();
  $('statTotal').textContent = s.totalTrades;
  $('statWinRate').textContent = s.winRate + '%';
  $('statWins').textContent = s.wins;
  $('statLosses').textContent = s.losses;
  $('statOpen').textContent = s.openCount;
}

async function refreshOpen() {
  const trades = await (await fetch('/api/trades/open')).json();
  $('openBody').innerHTML = trades.map(t => `
    <tr>
      <td>${t.symbol}</td>
      <td class="${t.direction}">${t.direction.toUpperCase()}</td>
      <td>${fmt(t.entry)}</td>
      <td>${fmt(t.sl)}</td>
      <td>${fmt(t.tps[0])}${t.hits.tp1 ? ' ✅' : ''}</td>
      <td>${fmt(t.tps[1])}${t.hits.tp2 ? ' ✅' : ''}</td>
      <td>${fmt(t.tps[2])}${t.hits.tp3 ? ' ✅' : ''}</td>
      <td>${fmt(t.lastPrice)}</td>
      <td>${t.status}</td>
      <td>${renderBreakdown(t)}</td>
      <td class="why">${(t.reasons || []).concat(t.geminiReasons || []).join('; ')}</td>
    </tr>`).join('') || '<tr><td colspan="11" style="color:var(--muted)">No open trades</td></tr>';
}

async function refreshClosed() {
  const trades = await (await fetch('/api/trades/closed')).json();
  $('closedBody').innerHTML = trades.slice().reverse().slice(0, 50).map(t => `
    <tr>
      <td>${t.symbol}</td>
      <td class="${t.direction}">${t.direction.toUpperCase()}</td>
      <td>${fmt(t.entry)}</td>
      <td>${fmt(t.sl)}</td>
      <td>${fmt(t.tps[0])}${t.hits && t.hits.tp1 ? ' ✅' : ''}</td>
      <td>${fmt(t.tps[1])}${t.hits && t.hits.tp2 ? ' ✅' : ''}</td>
      <td>${fmt(t.tps[2])}${t.hits && t.hits.tp3 ? ' ✅' : ''}</td>
      <td>${renderBreakdown(t)}</td>
      <td class="result-${t.result}">${t.result.toUpperCase()}</td>
      <td class="why">${t.closeReason || ''}</td>
      <td>${new Date(t.openedAt).toLocaleString()}</td>
      <td>${new Date(t.closedAt).toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="12" style="color:var(--muted)">No closed trades yet</td></tr>';
}

async function refreshAll() {
  try {
    await Promise.all([refreshStatus(), refreshStats(), refreshOpen(), refreshClosed()]);
  } catch (err) {
    console.error(err);
  }
}

$('startBtn').onclick = async () => { await fetch('/api/start', { method: 'POST' }); refreshAll(); };
$('stopBtn').onclick = async () => { await fetch('/api/stop', { method: 'POST' }); refreshAll(); };

refreshAll();
setInterval(refreshAll, 10000);
