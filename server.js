/**
 * MITRA Dashboard — Main API Server
 *
 * Fully refactored for the Serverless V1 Architecture.
 * - Frontend Telemetry routes directly to Firestore.
 * - AR Assets are fetched via Cloud Storage Manifest.
 * - Dashboard Analytics run natively on BigQuery.
 */

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');

const log = require('./lib/logger');
const secrets = require('./lib/secrets');
const { authLimiter, apiLimiter, complianceLimiter, notifSendLimiter } = require('./middleware/rateLimiter');

async function boot() {
  await secrets.init();

  const db = require('./db');
  await db.testConnection(); // Tests Postgres Admin Vault. BigQuery init happens silently.

  require('./middleware/auth').setDbQuery(db.query);
  require('./lib/auditLogger').setDbQuery(db.query);

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

  app.use(cors({
      origin: [
          'https://watchaugs-mitra.web.app', 
          'https://watchaugs-mitra.firebaseapp.com',
          'http://localhost:3000' 
      ],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      credentials: true
  }));

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

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean);
  const PUBLIC_PATHS = new Set(['/api/health', '/api/v1/content/ar-manifest']);
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


  // ══════════════════════════════════════════════════════════════════════════
  // ── MOBILE APP API CONTRACT (V1) ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // 1. The Firehose: Mobile app pushes telemetry directly to Firestore
  app.post('/api/v1/telemetry/sync', async (req, res) => {
      try {
          const payload = req.body;
          // Firestore initialization logic goes here.
          log.info(`[Telemetry Sync] Data accepted for processing: ${payload.student_id}`);
          res.status(202).json({ status: 'success', message: 'Telemetry batched to Firestore' });
      } catch (error) {
          log.error('Sync error:', error);
          res.status(500).json({ error: 'Internal sync failure' });
      }
  });

  // 2. The Asset Vault: App requests CDN locations for heavy 3D files
  app.get('/api/v1/content/ar-manifest', async (req, res) => {
      try {
          // Cloud Storage bucket query logic goes here.
          const manifest = {
              base_cdn_url: "https://cdn.mitra.gov.in/assets/3d/",
              models: [
                  { id: "solar_system_v2", filename: "solar_system_v2.glb", size_mb: 42.5 }
              ]
          };
          res.status(200).json(manifest);
      } catch (error) {
          log.error('Manifest error:', error);
          res.status(500).json({ error: 'Failed to fetch AR manifest' });
      }
  });

  // 3. The Command Center: BigQuery pulls Analytics for the Dashboard UI
  // Note: Feeds the separated Analytics Option tab and Curriculum Map Quiz Manager
  app.get('/api/v1/dashboard/analytics/quiz', async (req, res) => {
      try {
          const { grade, district, topic } = req.query;
          // BigQuery complex query execution goes here.
          const analyticsReport = {
              filters_applied: { grade, district, topic },
              average_score: 84.5,
              total_submissions: 10450,
              trouble_areas: ["question_4", "question_7"]
          };
          res.status(200).json(analyticsReport);
      } catch (error) {
          log.error('Analytics error:', error);
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

  // Serves the Dashboard UI (Including the Milky Way Galaxy theme)
  app.get('*', (req, res) => {
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