/**
 * lib/secrets.js — Secret loading and validation
 *
 * Two responsibilities:
 *   1. Validate that required secrets are present and strong before the server boots.
 *      (Fixes H2 — JWT secret weakness not enforced.)
 *   2. Optionally fetch secrets from Google Secret Manager when SECRET_MANAGER=true,
 *      so production never has secrets in env vars or files.
 *
 * Call once at boot, before requiring anything that uses these secrets.
 */

'use strict';

const log = require('./logger');

const REQUIRED_SECRETS = [
  { name: 'JWT_SECRET',         minBytes: 32 },
  { name: 'JWT_REFRESH_SECRET', minBytes: 32 },
];

/**
 * Optionally load each REQUIRED secret from Google Secret Manager
 * if it's not already in process.env. Secret name in Secret Manager is the
 * lowercased env name (e.g. `jwt_secret`) — override with
 * SECRET_MAP_JSON='{"JWT_SECRET":"projects/x/secrets/foo/versions/latest"}'.
 */
async function loadFromSecretManager() {
  if (process.env.SECRET_MANAGER !== 'true') return;

  // eslint-disable-next-line global-require
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new Client();
  const map = process.env.SECRET_MAP_JSON ? JSON.parse(process.env.SECRET_MAP_JSON) : {};

  const project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('SECRET_MANAGER=true requires GCP_PROJECT to be set.');

  // helper
  async function fetchOne(envName) {
    if (process.env[envName]) return; // already set
    const ref = map[envName] || `projects/${project}/secrets/${envName.toLowerCase()}/versions/latest`;
    try {
      const [version] = await client.accessSecretVersion({ name: ref });
      const payload = version.payload.data.toString('utf8');
      process.env[envName] = payload;
      log.info({ secret: envName }, 'Loaded secret from Secret Manager');
    } catch (err) {
      log.error({ err: err.message, secret: envName, ref }, 'Failed to load secret');
    }
  }

  const targets = [
    'JWT_SECRET', 'JWT_REFRESH_SECRET',
    'DB_PASSWORD', 'SMTP_PASS',
    'FCM_SERVER_KEY', 'TURNSTILE_SECRET',
  ];
  await Promise.all(targets.map(fetchOne));

  // Class-name fix above (Client referenced) — use the imported class
  function Client() { return new SecretManagerServiceClient(); }
}

/**
 * Validate that all required secrets are present and strong.
 */
function validate() {
  const errors = [];
  for (const { name, minBytes } of REQUIRED_SECRETS) {
    const val = process.env[name];
    if (!val) {
      errors.push(`${name} is not set.`);
      continue;
    }
    const byteLen = Buffer.byteLength(val, 'utf8');
    if (byteLen < minBytes) {
      errors.push(`${name} is too short (${byteLen} bytes; need ≥ ${minBytes}).`);
    }
    if (/^(change|secret|password|admin|test|demo)/i.test(val)) {
      errors.push(`${name} looks like a placeholder ("${val.slice(0, 12)}…"). Set a real random value.`);
    }
  }

  if (process.env.JWT_SECRET && process.env.JWT_REFRESH_SECRET &&
      process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
    errors.push('JWT_SECRET and JWT_REFRESH_SECRET must be different.');
  }

  if (errors.length) {
    log.fatal({ errors }, 'Secret validation failed');
    // eslint-disable-next-line no-console
    console.error('\n\u001b[31m✗ Secret validation failed:\u001b[0m');
    errors.forEach(e => console.error('  -', e));
    console.error('\nGenerate strong secrets with:');
    console.error("  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n");
    process.exit(1);
  }

  log.info('Secret validation passed');
}

async function init() {
  await loadFromSecretManager();
  validate();
}

module.exports = { init, validate };
