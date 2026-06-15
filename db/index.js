/**
 * db/index.js — The Dual-Engine Data Bridge
 * * 1. PostgreSQL (Throttled): Used strictly for low-volume administrative 
 * Dashboard data (admin auth, geofences, tenant logic).
 * 2. BigQuery (Serverless): Used for high-volume student telemetry, 
 * powering the heavy Analytics Option and Curriculum Map reporting.
 */

'use strict';

const { Pool } = require('pg');
const { BigQuery } = require('@google-cloud/bigquery');
const log = require('../lib/logger');

let pool;
let bqClient;
let connectorCleanup = null; 

// ── 1. Initialize BigQuery (Analytics Engine) ───────────────────────────────
function initBigQuery() {
  if (!bqClient) {
    bqClient = new BigQuery(); // Automatically picks up Google Cloud credentials
    log.info('Google BigQuery client initialized for massive telemetry analytics.');
  }
  return bqClient;
}

// ── 2. Initialize PostgreSQL (Admin/Dashboard Data Engine) ──────────────────
async function buildCloudSqlPool() {
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance || !/^[\w-]+:[\w-]+:[\w-]+$/.test(instance)) {
    throw new Error('CLOUD_SQL_INSTANCE must be in the form "project:region:instance"');
  }

  // eslint-disable-next-line global-require
  const { Connector, IpAddressTypes, AuthTypes } = require('@google-cloud/cloud-sql-connector');
  const connector = new Connector();

  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: process.env.CLOUD_SQL_IP_TYPE === 'PRIVATE' ? IpAddressTypes.PRIVATE : IpAddressTypes.PUBLIC,
    authType: process.env.CLOUD_SQL_AUTH === 'IAM' ? AuthTypes.IAM : AuthTypes.PASSWORD,
  });

  const cfg = {
    ...clientOpts,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'mitra_core',
    
    // SERVERLESS AUTO-SCALING PROTECTIONS (Admin Data Only)
    max: 2, 
    idleTimeoutMillis: 2000,       
    connectionTimeoutMillis: 2000,  
  };

  connectorCleanup = async () => { try { await connector.close(); } catch (_) { /* ignore */ } };

  const p = new Pool(cfg);
  p.on('error', (err) => log.error({ err }, 'Cloud SQL pool error'));
  return p;
}

function buildStandardPool() {
  const cfg = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'mitra_core',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: 2, // Serverless limit
    idleTimeoutMillis: 2000,
    connectionTimeoutMillis: 2000,
  };

  const isProduction = process.env.NODE_ENV === 'production';
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(cfg.host);
  
  if (process.env.DB_SSL === 'true') {
    cfg.ssl = { rejectUnauthorized: process.env.DB_SSL_INSECURE !== 'true' };
  } else if (!isLocalHost && isProduction) {
    cfg.ssl = { rejectUnauthorized: process.env.DB_SSL_INSECURE !== 'true' };
  }

  const p = new Pool(cfg);
  p.on('error', (err) => log.error({ err }, 'pg pool error'));
  return p;
}

async function init() {
  if (!pool) {
    if (process.env.CLOUD_SQL_INSTANCE) {
      pool = await buildCloudSqlPool();
      log.info(`PostgreSQL pool initialized via Cloud SQL connector (${process.env.CLOUD_SQL_INSTANCE})`);
    } else {
      pool = buildStandardPool();
      log.info('PostgreSQL pool initialized (standard driver)');
    }
  }
  initBigQuery();
  return pool;
}

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

async function testConnection() {
  if (!pool) await init();
  const res = await pool.query('SELECT NOW() AS now');
  log.info({ now: res.rows[0].now }, 'PostgreSQL Admin Vault connected');
  return res.rows[0].now;
}

async function close() {
  if (pool) {
    try { await pool.end(); } catch (e) { log.warn({ err: e }, 'pool.end failed'); }
  }
  if (connectorCleanup) await connectorCleanup();
}

const poolProxy = new Proxy({}, {
  get(_, prop) {
    if (!pool) throw new Error('pool accessed before init() — call testConnection() first');
    return pool[prop];
  },
});

module.exports = { init, query, testConnection, close, pool: poolProxy, getBigQuery: initBigQuery };