/**
 * routes/uploads.js — Unified upload handler
 *
 * Replaces:
 *   - disk-based multer storage  →  in-memory + storage abstraction
 *   - extension-only validation  →  extension + magic-byte sniff (H5)
 *   - public download by ID      →  authorisation check + signed URL (C5)
 *   - filesystem path in response →  opaque key only (H6)
 *
 * Endpoints (unchanged):
 *   POST /api/uploads/quiz-xlsx
 *   POST /api/uploads/app-icon
 *   POST /api/uploads/app-splash
 *   GET  /api/uploads/file/:id
 *   GET  /api/uploads
 *   DELETE /api/uploads/:id
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');
const storage = require('../lib/storage');
const { audit } = require('../lib/auditLogger');
const log = require('../lib/logger');

router.use(authenticate);

// memoryStorage so we can sniff bytes before persisting
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // hard ceiling; storage.put enforces per-category
});

// ── helper: record metadata ─────────────────────────────────────────────────
async function recordUpload({ userId, category, originalName, storageKey, size, contentType, meta = {} }) {
  try {
    const result = await query(
      `INSERT INTO uploads
        (id, uploaded_by, category, original_name, storage_key, file_size_bytes, content_type, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, category, original_name, file_size_bytes, content_type, created_at`,
      [uuidv4(), userId, category, originalName, storageKey, size, contentType, JSON.stringify(meta)]
    );
    return result.rows[0];
  } catch (err) {
    log.warn({ err: err.message }, 'uploads table insert failed (run migration?)');
    return null;
  }
}

async function ingest(req, res, category, permName) {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file provided' });

  try {
    const saved = await storage.put(category, file.originalname, file.buffer);
    const record = await recordUpload({
      userId: req.user.id,
      category,
      originalName: saved.originalName,
      storageKey: saved.key,
      size: saved.size,
      contentType: saved.contentType,
      meta: req.body || {},
    });
    audit({
      userId: req.user.id, action: 'upload.create', resourceType: 'upload', resourceId: record?.id,
      ip: req.ip, details: { category, size: saved.size },
    });
    res.status(201).json({
      id: record?.id,
      category,
      originalName: saved.originalName,
      size: saved.size,
      contentType: saved.contentType,
      // No filesystem path in the response (H6)
    });
  } catch (err) {
    const status = err.status || 500;
    log.warn({ err: err.message, category }, 'upload rejected');
    res.status(status).json({ error: err.message || 'Upload failed' });
  }
}

// ── POST /api/uploads/quiz-xlsx ─────────────────────────────────────────────
router.post('/quiz-xlsx',
  requirePerm('perm_edit_curriculum'),
  memUpload.single('file'),
  (req, res) => ingest(req, res, 'quiz_xlsx', 'perm_edit_curriculum')
);

// ── POST /api/uploads/app-icon ──────────────────────────────────────────────
router.post('/app-icon',
  requirePerm('perm_publish_apps'),
  memUpload.single('icon'),
  (req, res) => ingest(req, res, 'app_assets', 'perm_publish_apps')
);

// ── POST /api/uploads/app-splash ────────────────────────────────────────────
router.post('/app-splash',
  requirePerm('perm_publish_apps'),
  memUpload.single('splash'),
  (req, res) => ingest(req, res, 'app_assets', 'perm_publish_apps')
);

// ── GET /api/uploads — list (admin-ish) ─────────────────────────────────────
router.get('/', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const { category } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const params = [];
    const conds = [];
    if (category && typeof category === 'string' && category.length <= 30) {
      params.push(category);
      conds.push(`category = $${params.length}`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(limit, offset);
    const result = await query(
      `SELECT u.id, u.category, u.original_name, u.file_size_bytes, u.content_type, u.created_at,
              usr.full_name AS uploaded_by_name
       FROM uploads u
       LEFT JOIN users usr ON usr.id = u.uploaded_by
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows, limit, offset });
  } catch (err) {
    log.error({ err: err.message }, 'list uploads error');
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

// ── GET /api/uploads/file/:id — C5 authorisation check + signed URL ─────────
router.get('/file/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, uploaded_by, category, original_name, storage_key, content_type
       FROM uploads WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'File not found' });
    const record = result.rows[0];

    // Ownership / permission check
    const u = req.user;
    const allowed =
      record.uploaded_by === u.id ||
      u.role === 'master_admin' || u.role === 'admin' || u.role === 'superadmin' ||
      u.perm_export_data === true ||
      (record.category === 'app_assets' && u.perm_publish_apps) ||
      (record.category === 'quiz_xlsx'  && u.perm_edit_curriculum) ||
      (record.category === 'ad_media'   && u.perm_manage_ads);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    if (!record.storage_key) return res.status(410).json({ error: 'File no longer available' });

    // If the caller asked for a redirect to a signed URL, give it.
    if (req.query.signed === '1' || req.query.redirect === '1') {
      const url = await storage.signedUrl(record.storage_key, { expiresInMin: 10 });
      return res.redirect(url);
    }

    // Otherwise stream it through this server.
    if (!await storage.exists(record.storage_key)) {
      return res.status(410).json({ error: 'File no longer available' });
    }
    res.setHeader('Content-Type', record.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${record.original_name.replace(/[^\w. -]/g, '_').slice(0, 80)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = await storage.getStream(record.storage_key);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);

    audit({ userId: u.id, action: 'upload.download', resourceType: 'upload', resourceId: record.id, ip: req.ip });
  } catch (err) {
    log.error({ err: err.message }, 'download error');
    if (!res.headersSent) res.status(500).json({ error: 'Failed to retrieve file' });
  }
});

// ── DELETE /api/uploads/:id ─────────────────────────────────────────────────
router.delete('/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, uploaded_by, storage_key FROM uploads WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Upload record not found' });
    const record = result.rows[0];

    // Allow uploader OR admin to delete
    const u = req.user;
    const allowed = record.uploaded_by === u.id || u.role === 'master_admin' || u.role === 'admin';
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    if (record.storage_key) {
      try { await storage.delete(record.storage_key); }
      catch (e) { log.warn({ err: e.message }, 'storage delete failed'); }
    }
    await query('DELETE FROM uploads WHERE id = $1', [req.params.id]);
    audit({ userId: u.id, action: 'upload.delete', resourceType: 'upload', resourceId: req.params.id, ip: req.ip });
    res.json({ message: 'Upload deleted' });
  } catch (err) {
    log.error({ err: err.message }, 'delete upload error');
    res.status(500).json({ error: 'Failed to delete upload' });
  }
});

module.exports = router;
