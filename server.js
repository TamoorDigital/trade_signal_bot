require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const scheduler = require('./lib/scheduler');
const store = require('./lib/store');
const settings = require('./lib/settings');
const rateLimit = require('./lib/rateLimit');
const feedback = require('./lib/feedback');

const app = express();
app.set('trust proxy', true); // needed on Render so req.ip is the real client IP, not the proxy's
app.use(express.json());

// Unauthenticated on purpose — this is what UptimeRobot (or any keep-alive
// pinger) should hit. It reveals nothing beyond "the process is up": no
// trades, no scores, no settings. Everything else below this line still
// goes through basicAuth.
app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Basic Auth over the ENTIRE app (dashboard + every API route, including
// /api/start and /api/stop which are otherwise not gated by EDIT_PASSWORD).
// Only active if DASHBOARD_USER + DASHBOARD_PASSWORD are both set — see the
// loud startup warning below if they're not. This is deliberately separate
// from EDIT_PASSWORD: getting past this gate lets someone view the dashboard
// and start/stop scanning; they'd still need EDIT_PASSWORD on top of that to
// change leverage/USDT-per-trade or flip auto-trade on.
// ---------------------------------------------------------------------------
function basicAuth(req, res, next) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) return next(); // not configured -> intentionally open, see startup warning

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  const creds = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '';
  const sep = creds.indexOf(':');
  const u = sep === -1 ? creds : creds.slice(0, sep);
  const p = sep === -1 ? '' : creds.slice(sep + 1);

  if (safeEqual(u, user) && safeEqual(p, pass)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Signal Dashboard"');
  res.status(401).send('Authentication required');
}
app.use(basicAuth);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json(scheduler.status());
});

app.post('/api/start', (req, res) => {
  res.json(scheduler.start());
});

app.post('/api/stop', (req, res) => {
  res.json(scheduler.stop());
});

app.get('/api/trades/open', (req, res) => {
  res.json(store.getOpenTrades());
});

app.get('/api/trades/closed', (req, res) => {
  res.json(store.getClosedTrades());
});

app.get('/api/stats', (req, res) => {
  res.json(store.getStats());
});

app.get('/api/settings', (req, res) => {
  res.json(settings.get());
});

// Manual backup/restore — the practical answer to Render's free-tier disk
// resetting on redeploy/restart. Export before anything risky (or just
// periodically); import right after a restart to pick up where you left off.
app.get('/api/export', (req, res) => {
  res.json({
    exportedAt: Date.now(),
    trades: { open: store.getOpenTrades(), closed: store.getClosedTrades() },
    feedback: store.getFeedbackHistory(),
    settings: settings.get(),
  });
});

app.post('/api/import', (req, res) => {
  const { password, data } = req.body || {};
  const expected = process.env.EDIT_PASSWORD;
  if (!expected) return res.status(400).json({ error: 'EDIT_PASSWORD is not set in the server environment — refusing import' });
  if (!safeEqual(password, expected)) return res.status(401).json({ error: 'Incorrect password' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'No data to import' });
  try {
    store.replaceAll(data.trades || { open: [], closed: [] });
    store.replaceFeedback(data.feedback || []);
    const restored = settings.restore(data.settings || {});
    res.json({ ok: true, restoredSettings: restored, tradesRestored: { open: (data.trades?.open || []).length, closed: (data.trades?.closed || []).length } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

let lastFeedbackAt = 0;
app.get('/api/feedback', (req, res) => {
  res.json(store.getFeedbackHistory());
});

app.post('/api/feedback', async (req, res) => {
  const cooldownMs = 30000;
  const sinceLast = Date.now() - lastFeedbackAt;
  if (sinceLast < cooldownMs) {
    return res.status(429).json({ error: `Please wait ${Math.ceil((cooldownMs - sinceLast) / 1000)}s before running another review.` });
  }
  lastFeedbackAt = Date.now();
  try {
    const result = await feedback.runFeedbackAnalysis();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Brute-force lockout: 5 wrong EDIT_PASSWORD attempts from the same IP
// within 15 minutes locks that IP out for 15 minutes.
app.post('/api/settings', (req, res) => {
  const key = 'settings:' + req.ip;
  if (rateLimit.isLocked(key)) {
    const secs = Math.ceil(rateLimit.remainingLockMs(key) / 1000);
    return res.status(429).json({ error: `Too many wrong attempts. Try again in ${secs}s.` });
  }
  try {
    const updated = settings.update(req.body || {});
    rateLimit.recordSuccess(key);
    res.json(updated);
  } catch (err) {
    if (err.code === 'BAD_PASSWORD') rateLimit.recordFailure(key);
    const status = err.code === 'BAD_PASSWORD' ? 401 : 400;
    res.status(status).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Signal dashboard listening on :${PORT}`);
  if (!process.env.DASHBOARD_USER || !process.env.DASHBOARD_PASSWORD) {
    console.warn('⚠️  WARNING: DASHBOARD_USER/DASHBOARD_PASSWORD are not set. This dashboard — including Start/Stop and the auto-trade settings form — is PUBLICLY reachable to anyone with the URL. Set both before deploying somewhere public.');
  }
  scheduler.ensureTracking(); // tracking runs from boot, independent of scan Start/Stop
});
