// Simple in-memory brute-force lockout: after too many wrong password
// attempts from the same key (e.g. an IP), lock that key out for a cooldown
// period. Not distributed (fine for a single-instance app like this).

const buckets = new Map(); // key -> { failures: number[], lockedUntil: number }

function isLocked(key) {
  const b = buckets.get(key);
  return !!b && Date.now() < b.lockedUntil;
}

function remainingLockMs(key) {
  const b = buckets.get(key);
  if (!b) return 0;
  return Math.max(0, b.lockedUntil - Date.now());
}

function recordFailure(key, { maxAttempts = 5, windowMs = 15 * 60 * 1000, lockoutMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { failures: [], lockedUntil: 0 }; buckets.set(key, b); }
  b.failures = b.failures.filter(t => now - t < windowMs);
  b.failures.push(now);
  if (b.failures.length >= maxAttempts) {
    b.lockedUntil = now + lockoutMs;
    b.failures = [];
  }
}

function recordSuccess(key) {
  buckets.delete(key);
}

module.exports = { isLocked, remainingLockMs, recordFailure, recordSuccess };
