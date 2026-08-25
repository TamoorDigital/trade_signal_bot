const $ = (id) => document.getElementById(id);

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
      <td>${t.ourScore}/${t.maxScore} (G:${t.geminiScore})</td>
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
      <td class="result-${t.result}">${t.result.toUpperCase()}</td>
      <td class="why">${t.closeReason || ''}</td>
      <td>${new Date(t.openedAt).toLocaleString()}</td>
      <td>${new Date(t.closedAt).toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="11" style="color:var(--muted)">No closed trades yet</td></tr>';
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
