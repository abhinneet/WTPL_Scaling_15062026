/**
 * db/index.js — PostgreSQL connection pool
 *
 * Supports three modes (auto-detected):
 * 1. Cloud SQL via Cloud SQL Node.js Connector (preferred for production)
 * Set CLOUD_SQL_INSTANCE=project:region:instance
 * 2. DATABASE_URL connection string (Heroku/Railway/Render style)
 * 3. Individual DB_* env vars (local development / Docker Compose)
 *
 * Security fixes in this rewrite:
 * - C6: poolConfig is now actually used (no longer constructed and discarded)
 * - C7: No schema-altering DDL runs in this file. Migrations are a separate concern.
 * - SSL: Default-on for any non-localhost connection; never silently disabled.
 * - M8: Query logging now gated on DB_QUERY_LOGGING=true (not just NODE_ENV).
 * - Serverless Throttling: Explicitly forced short timeouts to prevent container hangs.
 */

'use strict';

const { Pool } = require('pg');
const log = require('../lib/logger');

let pool;
let connectorCleanup = null; // tear-down hook for Cloud SQL connector

/**
 * Build a pg.Pool against Cloud SQL via the Node.js Connector.
 * Lazily loads @google-cloud/cloud-sql-connector so dev installs don't need it.
 */
async function buildCloudSqlPool() {
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance || !/^[\w-]+:[\w-]+:[\w-]+$/.test(instance)) {
    throw new Error(
      'CLOUD_SQL_INSTANCE must be in the form "project:region:instance"'
    );
  }

  // Lazy require: only needed in Cloud Run / GCE / GKE.
  // eslint-disable-next-line global-require
  const { Connector, IpAddressTypes, AuthTypes } = require('@google-cloud/cloud-sql-connector');
  const connector = new Connector();

  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: (process.env.CLOUD_SQL_IP_TYPE === 'PRIVATE')
      ? IpAddressTypes.PRIVATE
      : IpAddressTypes.PUBLIC,
    authType: (process.env.CLOUD_SQL_AUTH === 'IAM')
      ? AuthTypes.IAM
      : AuthTypes.PASSWORD,
  });

  const cfg = {
    ...clientOpts,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'mitra',
    
    // SERVERLESS AUTO-SCALING PROTECTIONS:
    // Limit to 2 connections per instance. If Google Cloud spins up 1,000 
    // server instances, we max out at 2,000 connections, keeping the database safe.
    max: 2, 
    
    // Drop idle connections after 2 seconds (down from 30). 
    // Do not hoard connections when other cloned servers might need them.
    idleTimeoutMillis: 2000,       
    
    // Fail fast. If the database is busy, throw an error to the Pub/Sub queue 
    // rather than hanging the server and crashing the whole system.
    connectionTimeoutMillis: 2000,  
  };

  if (!cfg.user || (!cfg.password && process.env.CLOUD_SQL_AUTH !== 'IAM')) {
    throw new Error('DB_USER and DB_PASSWORD must be set for Cloud SQL connections (or use IAM auth).');
  }

  connectorCleanup = async () => { try { await connector.close(); } catch (_) { /* ignore */ } };

  const p = new Pool(cfg);
  p.on('error', (err) => log.error({ err }, 'Cloud SQL pool error'));
  return p;
}

/**
 * Build a pg.Pool from DATABASE_URL or individual env vars.
 */
function buildStandardPool() {
  const isProduction = process.env.NODE_ENV === 'production';
  const useConnectionString = !!process.env.DATABASE_URL;

  let cfg;
  if (useConnectionString) {
    cfg = { connectionString: process.env.DATABASE_URL };
  } else {
    cfg = {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME     || 'mitra',
      user:     process.env.DB_USER     || 'mitra_admin',
      password: process.env.DB_PASSWORD || '',
    };
  }

  // SSL policy (C6 fix):
  //   - explicit DB_SSL=false → off (only honoured in dev)
  //   - explicit DB_SSL=true  → on, validate cert by default
  //   - production            → SSL required
  //   - dev with localhost    → SSL off
  const explicit = process.env.DB_SSL;
  const isLocalHost = !useConnectionString && /^(localhost|127\.0\.0\.1)$/.test(cfg.host);
  let ssl = false;
  if (explicit === 'true') {
    ssl = { rejectUnauthorized: process.env.DB_SSL_INSECURE !== 'true' };
  } else if (explicit === 'false') {
    if (isProduction) {
      log.warn('DB_SSL=false in production is ignored; SSL is required.');
      ssl = { rejectUnauthorized: process.env.DB_SSL_INSECURE !== 'true' };
    } else {
      ssl = false;
    }
  } else {
    // No explicit setting: on for prod or remote, off only for local dev.
    ssl = (isProduction || !isLocalHost)
      ? { rejectUnauthorized: process.env.DB_SSL_INSECURE !== 'true' }
      : false;
  }

  cfg.ssl = ssl;
  
  // Serverless Throttling Protections
  cfg.max = parseInt(process.env.DB_POOL_MAX, 10) || 10;
  cfg.idleTimeoutMillis = 30000;
  cfg.connectionTimeoutMillis = 2000; // Reduced from 10000 to 2000 to prevent Cloud Run hanging

  const p = new Pool(cfg);
  p.on('error', (err) => log.error({ err }, 'pg pool error'));
  return p;
}

/**
 * Initialise the pool once. Idempotent.
 */
async function init() {
  if (pool) return pool;
  if (process.env.CLOUD_SQL_INSTANCE) {
    pool = await buildCloudSqlPool();
    log.info(`PostgreSQL pool initialised via Cloud SQL connector (${process.env.CLOUD_SQL_INSTANCE})`);
  } else {
    pool = buildStandardPool();
    log.info('PostgreSQL pool initialised (standard driver)');
  }
  return pool;
}

/**
 * Execute a parameterised query.
 * @param {string} text   SQL with $1, $2 … placeholders
 * @param {Array}  params Parameter values
 */
async function query(text, params = []) {
  if (!pool) await init();
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.DB_QUERY_LOGGING === 'true') {
      log.debug({ ms: Date.now() - start, sql: text.slice(0, 120) }, 'DB query');
    }
    return result;
  } catch (err) {
    log.error({ err, sql: text.slice(0, 120) }, 'DB query failed');
    throw err;
  }
}

/**
 * Test connectivity at startup. Throws if it fails — let the caller decide.
 */
async function testConnection() {
  if (!pool) await init();
  const res = await pool.query('SELECT NOW() AS now');
  log.info({ now: res.rows[0].now }, 'PostgreSQL connected');
  return res.rows[0].now;
}

/**
 * Clean shutdown — call before process exit.
 */
async function close() {
  if (pool) {
    try { await pool.end(); } catch (e) { log.warn({ err: e }, 'pool.end failed'); }
  }
  if (connectorCleanup) await connectorCleanup();
}

// Lazy-initialised pool getter for routes that import { pool } directly.
const poolProxy = new Proxy({}, {
  get(_, prop) {
    if (!pool) throw new Error('pool accessed before init() — call testConnection() first');
    return pool[prop];
  },
});

module.exports = { init, query, testConnection, close, pool: poolProxy };