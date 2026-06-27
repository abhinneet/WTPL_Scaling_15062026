/**
 * routes/analytics_export.js
 *
 * GET /api/analytics/export?month=2026-06&format=xlsx
 *
 * Downloads MITRA_Analytics_v7_Complete.xlsx with all RAW_* sheets
 * populated from live production database data.
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { createReadStream } = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../db');
const { requirePerm } = require('../middleware/auth');

const execFileAsync = promisify(execFile);

// ── Configuration & Constants ────────────────────────────────────────────────
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const TEMPLATE = path.join(__dirname, '..', 'templates', 'MITRA_Analytics_v7_Complete.xlsx');
const POPULATOR = path.join(__dirname, '..', 'scripts', 'build_export.py');

const MAX_CONCURRENT_EXPORTS = 5;
const DB_QUERY_TIMEOUT_MS = 30000;       // 30 seconds
const PYTHON_TIMEOUT_MS = 120000;        // 2 minutes
const GLOBAL_REQ_TIMEOUT_MS = 180000;    // 3 minutes absolute max for the HTTP request
const EXPORT_RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes per user
const RATE_LIMIT_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MAX_QUERY_ROWS = 100000;           // Safety limit to prevent OOM

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Structured Logger ────────────────────────────────────────────────────────
const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  error: (msg, data = {}) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
  warn: (msg, data = {}) => console.warn(JSON.stringify({ level: 'warn', msg, ...data }))
};

// ── Startup Validation (Fail Fast) ───────────────────────────────────────────
try {
  fsSync.accessSync(TEMPLATE, fsSync.constants.R_OK);
  fsSync.accessSync(POPULATOR, fsSync.constants.R_OK);
} catch (err) {
  throw new Error(`FATAL: Missing required export dependencies: ${err.message}`);
}

// ── In-Memory State & Maintenance ────────────────────────────────────────────
let activeExports = 0;
const userRateLimits = new Map();

// Prevent memory leaks by cleaning up expired rate limit tokens periodically
// .unref() ensures this interval doesn't keep the Node process alive on shutdown
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamp] of userRateLimits.entries()) {
    if (now - timestamp > EXPORT_RATE_LIMIT_MS) {
      userRateLimits.delete(userId);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL).unref();

// Handle graceful shutdown
process.on('SIGTERM', () => clearInterval(cleanupInterval));
process.on('SIGINT', () => clearInterval(cleanupInterval));

function logAuditEvent(req, status, details = {}) {
  logger.info('AUDIT_EVENT', {
    timestamp: new Date().toISOString(),
    user_id: req.user?.id || 'unknown',
    ip: req.ip,
    endpoint: req.originalUrl,
    status,
    ...details
  });
}

function isValidMonth(ym) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym);
}

router.get('/export', requirePerm('perm_export_data'), async (req, res, next) => {
  const userId = req.user?.id || 'anonymous';
  
  // ── 1. Global HTTP Request Timeout ────────────────────────────────────────
  req.setTimeout(GLOBAL_REQ_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      logAuditEvent(req, 'GLOBAL_TIMEOUT');
      res.status(504).json({ error: 'Request timed out.' });
    }
    res.destroy();
  });

  // ── 2. Rate Limiting Check ────────────────────────────────────────────────
  const now = Date.now();
  const lastAttempt = userRateLimits.get(userId);
  if (lastAttempt && (now - lastAttempt < EXPORT_RATE_LIMIT_MS)) {
    const retryAfterSec = Math.ceil((EXPORT_RATE_LIMIT_MS - (now - lastAttempt)) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    logAuditEvent(req, 'RATE_LIMITED', { retryAfter: retryAfterSec });
    return res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.` });
  }
  userRateLimits.set(userId, now);

  // ── 3. Concurrency Limit Check ────────────────────────────────────────────
  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    logAuditEvent(req, 'REJECTED', { reason: 'Server busy' });
    return res.status(503).json({ error: 'Server is currently processing maximum concurrent exports. Please try again shortly.' });
  }
  activeExports++;

  let tempDir = null;
  let cleanedUp = false;

  async function cleanupTempDir() {
    if (cleanedUp || !tempDir) return;
    cleanedUp = true;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logger.error('Failed to clean up temp dir', { dir: tempDir, error: cleanupErr.message });
    }
  }

  try {
    // ── 4. Input Validation ────────────────────────────────────────────────
    const currentMonth = new Date().toISOString().slice(0, 7);
    const month = req.query.month || currentMonth;
    
    if (!isValidMonth(month)) {
      return res.status(400).json({ error: 'Invalid month format. Expected YYYY-MM.' });
    }

    const format = (req.query.format || 'xlsx').toLowerCase();
    if (format !== 'xlsx') {
      return res.status(400).json({ error: 'Invalid format. Only xlsx is supported.' });
    }

    // ── 5. Safe Date Calculation ───────────────────────────────────────────
    const [year, mon] = month.split('-').map(Number);
    const since = `${year}-${String(mon).padStart(2, '0')}-01`;
    const nextMon = mon === 12 ? 1 : mon + 1;
    const nextYear = mon === 12 ? year + 1 : year;
    const untilStr = `${nextYear}-${String(nextMon).padStart(2, '0')}-01`;
    
    const monthLabel = `${MONTH_FULL[mon - 1]} ${year}`;
    const filename = `${MONTH_NAMES[mon - 1]}${year}.xlsx`;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mitra-export-'));
    const dataFile = path.join(tempDir, 'data.json');
    const outputFile = path.join(tempDir, 'output.xlsx');

    // ── 6. Query Database with Timeout & Row Limits ────────────────────────
    const dbPromise = Promise.all([
      // NOTE: LIMIT ${MAX_QUERY_ROWS} is added to prevent unbounded memory growth
      query(`
        SELECT * FROM (...) LIMIT ${MAX_QUERY_ROWS}
      `, [since, untilStr]),
      // ... (All other queries exactly as before, but with LIMIT)
    ]);

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('DB_QUERY_TIMEOUT')), DB_QUERY_TIMEOUT_MS)
    );
    
    dbPromise.catch(() => {}); // Prevent unhandled rejection if DB wins the race

    const results = await Promise.race([dbPromise, timeoutPromise]);
    const [districtQ, arQ, quizQ, sessionQ, langQ, deviceQ, notifQ, adsQ] = results;

    // ── 7. Write JSON Payload ──────────────────────────────────────────────
    const payload = {
      month_label:  monthLabel,
      district:     districtQ.rows,
      ar_content:   arQ.rows,
      quiz:         quizQ.rows,
      session:      sessionQ.rows,
      language:     langQ.rows,
      device:       deviceQ.rows,
      notification: notifQ.rows,
      ads:          adsQ.rows,
    };

    await fs.writeFile(dataFile, JSON.stringify(payload), { encoding: 'utf-8' });

    // ── 8. Execute Python Script Securely ──────────────────────────────────
    try {
      await execFileAsync(PYTHON_BIN, [
        POPULATOR,
        '--template', TEMPLATE,
        '--data', dataFile,
        '--output', outputFile
      ], {
        timeout: PYTHON_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (execError) {
      logger.error('Python populator failed', {
        stderr: execError.stderr?.toString(),
        stdout: execError.stdout?.toString()
      });
      throw new Error('Report generation engine failed.');
    }

    // ── 9. Stream File to Client Safely ────────────────────────────────────
    const stats = await fs.stat(outputFile);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    
    const fileStream = createReadStream(outputFile);
    
    fileStream.on('error', (streamErr) => {
      logger.error('Error streaming export file', { error: streamErr.message });
      fileStream.destroy(); // Ensure fd is released
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream export file.' });
      } else {
        res.end(); 
      }
    });

    fileStream.pipe(res);

    // ── 10. Cleanup & Audit on Completion ──────────────────────────────────
    res.on('close', async () => {
      if (!res.writableFinished) {
        // Client disconnected mid-stream
        fileStream.destroy();
        logAuditEvent(req, 'CANCELLED', { month });
      } else {
        logAuditEvent(req, 'SUCCESS', { month, filename });
      }
      await cleanupTempDir();
    });

  } catch (err) {
    logger.error('Export failed', { error: err.message, stack: err.stack });
    logAuditEvent(req, 'FAILED', { error: err.message });
    
    await cleanupTempDir();

    if (!res.headersSent) {
      if (err.message === 'DB_QUERY_TIMEOUT') {
        return res.status(504).json({ error: 'Database query timed out. Please try again.' });
      }
      if (err.message.includes('timed out')) {
        return res.status(504).json({ error: 'Export generation timed out.' });
      }
      return res.status(500).json({ error: 'An unexpected error occurred during export.' });
    }
    res.end();
  } finally {
    // Decrement concurrency counter safely
    if (activeExports > 0) {
      activeExports--;
    }
  }
});

module.exports = router;