/**
 * db/migrate.js — Versioned, idempotent migration runner with checksums
 *
 * • Reads .sql files from ./migrations alphabetically (v001_, v002_, …)
 * • Records each one in a _migrations table with name + sha256 checksum + applied_at
 * • Refuses to run if a previously-applied file's content has changed (drift detection)
 * • Each migration runs in its own transaction
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { init, close } = require('./index');
const logger = require('../lib/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function migrate() {
  const pool = await init();
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.error({ dir: MIGRATIONS_DIR }, 'Migrations directory missing');
    process.exit(2);
  }
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    logger.warn('No migration files found');
    return;
  }

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await client.query('SELECT filename, checksum FROM _migrations');
    const appliedMap = new Map(applied.rows.map(r => [r.filename, r.checksum]));

    for (const f of files) {
      const fullPath = path.join(MIGRATIONS_DIR, f);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const cs = sha256(sql);

      if (appliedMap.has(f)) {
        if (appliedMap.get(f) !== cs) {
          logger.error({ filename: f }, `Migration drift detected. Previously-applied file has been modified. Aborting.`);
          process.exit(3);
        }
        logger.info({ filename: f }, 'Already applied, skipping');
        continue;
      }

      logger.info({ filename: f }, '⏳ Applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations(filename, checksum) VALUES ($1,$2)', [f, cs]);
        await client.query('COMMIT');
        logger.info({ filename: f }, '✅ Migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ filename: f, err: err.message }, '❌ Migration failed, rolled back');
        process.exit(4);
      }
    }
    logger.info('🎉 All migrations applied');
  } finally {
    client.release();
    await close();
  }
}

migrate().catch(err => {
  logger.error({ err: err.message }, 'Migration runner crashed');
  process.exit(1);
});
