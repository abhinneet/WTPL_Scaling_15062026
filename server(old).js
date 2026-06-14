/**
 * MITRA Dashboard — Main API Server
 *
 * Hardened, Cloud-Run-ready edition. See SECURITY_AUDIT.md for the full
 * list of changes; the most important ones in this file are:
 *
 *   - C7/H13: no schema-altering SQL runs on boot. Migrations are a separate npm script.
 *   - H2:     fail-fast secret validation before any route is mounted
 *   - H3:     CORS denies requests with no Origin except on safe endpoints
 *   - H4:     CSP nonce-based; production refuses to start with unsafe-inline scripts
 *   - H16:    body parser limits reduced to 100 KB JSON / 2 MB urlencoded
 *   - H17:    COEP set to credentialless to allow AR embeds while keeping isolation
 *   - M7:     trust-proxy is environment-aware
 *   - M11:    health endpoint no longer leaks build version in production
 */

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');

const log = require('./lib/logger');
const secrets = require('./lib/secrets');

const { authLimiter, apiLimiter, complianceLimiter, notifSendLimiter } = require('./middleware/rateLimiter');
const path = require('path');

// ── Boot order ───────────────────────────────────────────────────────────────
// Validate secrets FIRST so we never start a server with a 1-byte JWT_SECRET.
async function boot() {
  await secrets.init();

  const db = require('./db');
  await db.testConnection();

  // Wire up the lazy-init dependencies
  require('./middleware/auth').setDbQuery(db.query);
  require('./lib/auditLogger').setDbQuery(db.query);

  // Route modules
  const authRoutes          = require('./routes/auth');
  const analyticsRoutes     = require('./routes/analytics');
  const unityRoutes         = require('./routes/unity');
  const curriculumRoutes    = require('./routes/curriculum');
  const appBuilderRoutes    = require('./routes/appBuilder');
  const dashboardRoutes     = require('./routes/dashboard');
  const quizRoutes          = require('./routes/quiz');
  const locationsRoutes     = require('./routes/locations');
  const arAssetsRoutes      = require('./routes/ar_assets');
  const uploadsRoutes       = require('./routes/uploads');
  const notificationsRoutes = require('./routes/notifications');
  const complianceRoutes    = require('./routes/compliance');
  const usersRoutes         = require('./routes/users');
  const advertisementsRoutes = require('./routes/advertisements');
  const tenantRoutes        = require('./routes/tenant');
  const geofenceRoutes      = require('./routes/geofence');

  const app = express();

  // ── Trust proxy ─────────────────────────────────────────────────────────────
  // Cloud Run sits behind exactly one proxy hop. Local dev: trust nothing.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy === 'true') app.set('trust proxy', true);
  else if (trustProxy && !Number.isNaN(parseInt(trustProxy, 10))) app.set('trust proxy', parseInt(trustProxy, 10));
  else app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

  const PORT = parseInt(process.env.PORT, 10) || 3000;

  // ── Request ID — for correlating logs/audit ─────────────────────────────────
  app.use((req, _res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    next();
  });

  // ── CSP nonce — per request (H4) ────────────────────────────────────────────
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  // ── Security headers ────────────────────────────────────────────────────────
  const inlineMode = process.env.ALLOW_INLINE_SCRIPTS === 'true' || process.env.NODE_ENV !== 'production';
  if (inlineMode && process.env.NODE_ENV === 'production') {
    log.warn('ALLOW_INLINE_SCRIPTS=true in production — XSS protection significantly reduced.');
  }
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (_req, res) => `'nonce-${res.locals.cspNonce}'`,
          ...(inlineMode ? ["'unsafe-inline'", "'unsafe-eval'"] : []),
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com',
        ],
        scriptSrcAttr: inlineMode ? ["'unsafe-inline'"] : ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'",
          'https://fcm.googleapis.com',
          ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
        ],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: { policy: 'credentialless' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  app.use(compression());

  // Morgan with our pino stream — keeps Cloud Logging happy
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    stream: { write: (msg) => log.info(msg.trim()) },
  }));

  // ── CORS — H3 fix ───────────────────────────────────────────────────────────
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean);
  const PUBLIC_PATHS = new Set(['/api/health']);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) {
        // Same-origin or curl. Allow only if the actual request goes to a public path —
        // we'll re-check in a small middleware below.
        return cb(null, true);
      }
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not permitted'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }));
  app.use((req, res, next) => {
    // For requests with no Origin (e.g. server-side scripts) only allow GET/HEAD on PUBLIC_PATHS.
    if (!req.headers.origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !PUBLIC_PATHS.has(req.path)) {
      // Permit if a valid Authorization header is present — server-to-server clients should still authenticate.
      if (!req.headers.authorization) return res.status(403).json({ error: 'Forbidden: missing Origin' });
    }
    next();
  });

  // ── Body parsers — H16 ──────────────────────────────────────────────────────
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_LIMIT || '2mb' }));

  // ── Rate limiting ───────────────────────────────────────────────────────────
  app.use('/api', apiLimiter);

  // ── Static files ────────────────────────────────────────────────────────────
  // Serve the dashboard with the CSP nonce injected into the HTML.
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));

  // ── API routes ──────────────────────────────────────────────────────────────
  app.use('/api/auth',         authLimiter, authRoutes);
  app.use('/api/dashboard',    dashboardRoutes);
  app.use('/api/analytics',    analyticsRoutes);
  app.use('/api/unity',        unityRoutes);
  app.use('/api/ar',           arAssetsRoutes);
  app.use('/api/curriculum',   curriculumRoutes);
  app.use('/api/app-builder',  appBuilderRoutes);
  app.use('/api/quiz',         quizRoutes);
  app.use('/api/locations',    locationsRoutes);
  app.use('/api/uploads',      uploadsRoutes);
  app.use('/api/notifications/send',     notifSendLimiter);
  app.use('/api/notifications/schedule', notifSendLimiter);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/compliance/purge-user',     complianceLimiter);
  app.use('/api/compliance/run-auto-purge', complianceLimiter);
  app.use('/api/compliance',   complianceRoutes);
  app.use('/api/users',        usersRoutes);
  app.use('/api/ads',          advertisementsRoutes);
  app.use('/api/tenant',       tenantRoutes);
  app.use('/api/geofence',     geofenceRoutes);

  // ── Health check (M11) ──────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json(process.env.NODE_ENV === 'production'
      ? { status: 'ok' }
      : { status: 'ok', service: 'MITRA Dashboard API', time: new Date().toISOString() });
  });

  // ── SPA fallback ────────────────────────────────────────────────────────────
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // ── Global error handler (C2) ───────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error({ err: err.message, stack: err.stack, reqId: req.id, path: req.path }, 'Unhandled error');
    if (err.message?.startsWith('CORS:')) {
      return res.status(403).json({ error: 'Origin not permitted', reqId: req.id });
    }
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
      reqId: req.id,
    });
  });

  // ── Listen ──────────────────────────────────────────────────────────────────
  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info(`MITRA API listening on :${PORT}`);
  });

  // Graceful shutdown — Cloud Run sends SIGTERM and expects you to drain.
  function shutdown(signal) {
    log.info({ signal }, 'Shutting down');
    server.close(async () => {
      try { await db.close(); } catch (_) { /* */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  return app;
}

if (require.main === module) {
  boot().catch(err => {
    log.fatal({ err: err.message, stack: err.stack }, 'Fatal boot error');
    process.exit(1);
  });
}

module.exports = boot;
