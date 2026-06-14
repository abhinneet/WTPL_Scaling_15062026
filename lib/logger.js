/**
 * lib/logger.js — Structured logger (Pino)
 *
 * Why: Cloud Logging expects JSON structured logs. console.log emits raw text
 * that can't be filtered by severity or queried by field.
 *
 * Usage:
 *   const log = require('./lib/logger');
 *   log.info('thing happened');
 *   log.error({ err, userId }, 'login failed');
 *
 * In tests, set LOG_LEVEL=silent to suppress.
 */

'use strict';

const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // Google Cloud Logging expects `severity` rather than `level`
  formatters: isProduction
    ? {
        level(label) {
          const map = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' };
          return { severity: map[label] || 'DEFAULT' };
        },
      }
    : undefined,
  // Pretty print in dev only
  transport: !isProduction
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
  // Redact obvious secrets
  redact: {
    paths: [
      'password', '*.password', '*.password_hash', 'password_hash',
      'token', '*.token', '*.access_token', '*.refresh_token',
      'authorization', '*.authorization',
      'cookie', '*.cookie',
      'JWT_SECRET', 'JWT_REFRESH_SECRET', 'DB_PASSWORD',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
