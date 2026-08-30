require('dotenv').config();
const express = require('express');
const path = require('path');
const scheduler = require('./lib/scheduler');
const store = require('./lib/store');
const settings = require('./lib/settings');

const app = express();
app.use(express.json());
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

app.post('/api/settings', (req, res) => {
  try {
    const updated = settings.update(req.body || {});
    res.json(updated);
  } catch (err) {
    const status = err.code === 'BAD_PASSWORD' ? 401 : 400;
    res.status(status).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Signal dashboard listening on :${PORT}`);
  scheduler.ensureTracking(); // tracking runs from boot, independent of scan Start/Stop
});
