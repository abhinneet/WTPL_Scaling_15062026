/**
 * middleware/rateLimiter.js — In-memory sliding-window rate limiter
 *
 * Per-process. For multi-instance Cloud Run deployments this is per-instance,
 * which is usually fine: an attacker hitting 5 instances at the same rate
 * gets 5× the limit, but is still bounded. For true global rate limiting,
 * use Cloud Armor or a Redis-backed limiter (stub below).
 *
 * Fixes:
 *   - Properly clears the cleanup interval on test teardown
 *   - Honest reset timestamp when no requests recorded yet
 */

'use strict';

const requestStore = new Map();
const intervals = [];

function createRateLimiter({ windowMs = 900_000, max = 100, message = 'Too many requests, please try again later.', keyFn }) {
  const interval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of requestStore.entries()) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) requestStore.delete(key);
      else requestStore.set(key, filtered);
    }
  }, 300_000);
  if (typeof interval.unref === 'function') interval.unref();
  intervals.push(interval);

  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn ? keyFn(req) : (req.ip || 'unknown');
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (requestStore.get(key) || []).filter(t => t > cutoff);
    timestamps.push(now);
    requestStore.set(key, timestamps);

    const remaining = Math.max(0, max - timestamps.length);
    const reset = Math.ceil((timestamps.length ? timestamps[0] + windowMs : now + windowMs) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', reset);

    if (timestamps.length > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message, retryAfter: Math.ceil(windowMs / 1000) });
    }
    next();
  };
}

const authLimiter = createRateLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900_000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10)  || 20,
  message:  'Too many login attempts. Please wait 15 minutes before retrying.',
  keyFn:    req => 'auth:' + (req.ip || 'unknown'),
});

const apiLimiter = createRateLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX, 10)       || 500,
  message:  'Rate limit exceeded. Please slow down.',
  keyFn:    req => 'api:' + (req.ip || 'unknown'),
});

const complianceLimiter = createRateLimiter({
  windowMs: 3_600_000,
  max: 10,
  message: 'Compliance action rate limit exceeded.',
  keyFn: req => 'compliance:' + (req.user?.id || req.ip || 'unknown'),
});

const notifSendLimiter = createRateLimiter({
  windowMs: 3_600_000,
  max: 200,
  message: 'Notification send limit exceeded.',
  keyFn: req => 'notif:' + (req.user?.id || req.ip || 'unknown'),
});

function shutdown() { intervals.forEach(clearInterval); }

module.exports = { authLimiter, apiLimiter, complianceLimiter, notifSendLimiter, createRateLimiter, shutdown };
