/**
 * MITRA Dashboard — Main API Server
 *
 * Fully refactored for the Serverless V1 Architecture.
 * - Frontend Telemetry routes directly to Firestore.
 * - AR Assets are fetched via Cloud Storage Manifest.
 * - Dashboard Analytics run natively on BigQuery.
 *
 * --- Changes vs. previous version ---
 * - Removed the duplicate `app.use(cors({...}))` call. The file previously
 *   registered CORS twice: once with a hardcoded origin array, once with a
 *   dynamic ALLOWED_ORIGINS-based validator. Running both means either
 *   duplicate Access-Control-Allow-Origin headers (which browsers reject) or
 *   the first, more permissive config silently taking precedence over the
 *   second, security-conscious one. Only the dynamic ALLOWED_ORIGINS-based
 *   config remains; the three previously-hardcoded origins should be added
 *   to ALLOWED_ORIGINS in the environment if still needed.
 * - /api/v1/telemetry/sync now actually writes to Firestore instead of only
 *   logging and returning 202. It also requires authenticate, since it was
 *   previously reachable with no auth at all (it sat above every
 *   `router.use(authenticate)` in the mounted route files).
 * - /api/v1/dashboard/analytics/quiz now requires authenticate for the same
 *   reason. /api/v1/content/ar-manifest is left public on purpose — it's
 *   already listed in PUBLIC_PATHS, which is now actually enforced (see
 *   below) rather than declared and unused.
 * - PUBLIC_PATHS is now read by an explicit middleware that skips
 *   authenticate for those paths, instead of being declared and never
 *   referenced.
 * - log.error calls in the two route stubs now use the same structured
 *   `{ err: err.message, stack: err.stack }` shape used everywhere else in
 *   this file, instead of `log.error('Sync error:', error)`, which (for a
 *   pino-style structured logger) treats the second argument as a format
 *   placeholder rather than merged metadata and can silently drop the
 *   error detail from log output.
 * - shutdown() now also calls firebase.shutdown(), since firebase.init()
 *   runs at boot but was never torn down on SIGTERM/SIGINT.
 * - The BigQuery analytics query and the GCS manifest listing are still
 *   TODOs returning explicitly-labeled placeholder data — implementing the
 *   real BigQuery SQL and bucket-listing logic needs the actual table
 *   schema and manifest format, which aren't available from this file
 *   alone. Returning invented "real-looking" numbers in their place would
 *   be worse than an honest placeholder.
 */

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');

const log = require('./lib/logger');
const secrets = require('./lib/secrets');
const { authLimiter, apiLimiter, complianceLimiter, notifSendLimiter } = require('./middleware/rateLimiter');

async function boot() {
  await secrets.init();
  const firebase = require('./lib/firebase');
  await firebase.init();

  const db = require('./db');
  //await db.testConnection(); // Tests Postgres Admin Vault. BigQuery init happens silently.

  require('./middleware/auth').setDbQuery(db.query);
  require('./lib/auditLogger').setDbQuery(db.query);

  const { authenticate } = require('./middleware/auth');

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
  const consentRoutes       = require('./routes/consent');
  const usersRoutes         = require('./routes/users');
  const advertisementsRoutes = require('./routes/advertisements');
  const tenantRoutes        = require('./routes/tenant');
  const geofenceRoutes      = require('./routes/geofence');

  const app = express();

  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy === 'true') app.set('trust proxy', true);
  else if (trustProxy && !Number.isNaN(parseInt(trustProxy, 10))) app.set('trust proxy', parseInt(trustProxy, 10));
  else app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

  const PORT = parseInt(process.env.PORT, 10) || 8080;

  app.use((req, _res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    next();
  });

  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  const inlineMode = process.env.ALLOW_INLINE_SCRIPTS === 'true' || process.env.NODE_ENV !== 'production';
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

  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    stream: { write: (msg) => log.info(msg.trim()) },
  }));

  // Single CORS configuration. ALLOWED_ORIGINS should include every origin
  // that previously relied on the removed hardcoded list (e.g.
  // https://watchaugs-mitra.web.app, https://watchaugs-mitra.firebaseapp.com,
  // http://localhost:3000) if those are still needed.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean);
  const cors = require('cors');
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not permitted'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }));

  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_LIMIT || '2mb' }));
  app.use('/api', apiLimiter);

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));

  // Paths that should be reachable without authentication. Previously
  // declared and never actually enforced anywhere.
  const PUBLIC_PATHS = new Set(['/api/health', '/api/v1/content/ar-manifest']);
  function authenticateUnlessPublic(req, res, next) {
    if (PUBLIC_PATHS.has(req.path)) return next();
    return authenticate(req, res, next);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── MOBILE APP API CONTRACT (V1) ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // 1. The Firehose: Mobile app pushes telemetry directly to Firestore
  app.post('/api/v1/telemetry/sync', authenticateUnlessPublic, async (req, res) => {
      try {
          const payload = req.body;

          if (!payload || !payload.student_id) {
              return res.status(400).json({ error: 'Missing required field: student_id' });
          }

          const firestore = firebase.getFirestore();
          const sessionRef = firestore
              .collection('students')
              .doc(payload.student_id)
              .collection('sessions')
              .doc();

          await sessionRef.set({
              ...payload,
              processed: false,
              processing: false,
              received_at: new Date(),
              received_by_uid: req.user?.uid || null
          });

          log.info({ studentId: payload.student_id, sessionId: sessionRef.id }, 'Telemetry accepted for processing');
          res.status(202).json({ status: 'success', message: 'Telemetry batched to Firestore', session_id: sessionRef.id });
      } catch (err) {
          log.error({ err: err.message, stack: err.stack, path: req.path }, 'Telemetry sync error');
          res.status(500).json({ error: 'Internal sync failure' });
      }
  });

  // 2. The Asset Vault: App requests CDN locations for heavy 3D files
  // Intentionally public (listed in PUBLIC_PATHS) — mobile clients fetch
  // this before the user has authenticated.
  // TODO: replace placeholder manifest with a real GCS bucket listing /
  // cached manifest file once the manifest storage format is finalized.
  app.get('/api/v1/content/ar-manifest', authenticateUnlessPublic, async (req, res) => {
      try {
          const manifest = {
              base_cdn_url: "https://cdn.mitra.gov.in/assets/3d/",
              models: [
                  { id: "solar_system_v2", filename: "solar_system_v2.glb", size_mb: 42.5 }
              ],
              _placeholder: true
          };
          res.status(200).json(manifest);
      } catch (err) {
          log.error({ err: err.message, stack: err.stack, path: req.path }, 'Manifest error');
          res.status(500).json({ error: 'Failed to fetch AR manifest' });
      }
  });

  // 3. The Command Center: BigQuery pulls Analytics for the Dashboard UI
  // Note: Feeds the separated Analytics Option tab and Curriculum Map Quiz Manager
  // TODO: replace placeholder report with the real BigQuery query once the
  // analytics table schema is finalized.
  app.get('/api/v1/dashboard/analytics/quiz', authenticateUnlessPublic, async (req, res) => {
      try {
          const { grade, district, topic } = req.query;
          const analyticsReport = {
              filters_applied: { grade, district, topic },
              average_score: 84.5,
              total_submissions: 10450,
              trouble_areas: ["question_4", "question_7"],
              _placeholder: true
          };
          res.status(200).json(analyticsReport);
      } catch (err) {
          log.error({ err: err.message, stack: err.stack, path: req.path }, 'Analytics error');
          res.status(500).json({ error: 'Failed to generate BigQuery report' });
      }
  });


  // ══════════════════════════════════════════════════════════════════════════
  // ── DASHBOARD ADMIN ROUTES (POSTGRESQL VAULT) ─────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
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
  app.use('/api/notifications', notificationsRoutes); // Manage App Notifications mapped here
  app.use('/api/compliance/purge-user',     complianceLimiter);
  app.use('/api/compliance/run-auto-purge', complianceLimiter);
  app.use('/api/compliance',   complianceRoutes);
  app.use('/api/consent',      consentRoutes);
  app.use('/api/users',        usersRoutes);
  app.use('/api/ads',          advertisementsRoutes);
  app.use('/api/tenant',       tenantRoutes);
  app.use('/api/geofence',     geofenceRoutes);

  app.get('/api/health', (req, res) => {
    res.json(process.env.NODE_ENV === 'production'
      ? { status: 'ok' }
      : { status: 'ok', service: 'MITRA Scaled Dashboard API', time: new Date().toISOString() });
  });

  // Unmatched /api/* paths get a 404 JSON response instead of falling
  // through to the SPA catch-all below, which previously returned a
  // confusing 200 + index.html for typo'd or removed API endpoints.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // Serves the Dashboard UI (Including the Milky Way Galaxy theme)
  // Note: Express 5 / path-to-regexp v7 removed support for a bare '*'
  // wildcard (it now requires a named wildcard). If you're still on
  // Express 4, '*' would also work, but '/*splat' works on both.
  app.get('/*splat', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

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

  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info(`MITRA API Engine live on port ${PORT}`);
  });

  function shutdown(signal) {
    log.info({ signal }, 'Shutting down');
    server.close(async () => {
      try { await db.close(); } catch (_) { /* */ }
      try { await firebase.shutdown(); } catch (_) { /* */ }
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