/**
 * routes/unity.js — AR Asset Upload & Publishing (Firebase-ready)
 *
 * Changes from the original:
 *  • Uses lib/storage (local | GCS) instead of disk writes inside the app.
 *  • Hard size cap (default 500 MB, override via MAX_UNITY_FILE_MB).
 *  • Extension allow-list enforced server-side.
 *  • Permission check on download via signed URL.
 *  • Stores opaque storage_key, not a /uploads/… URL.
 *  • Removes raw fs.unlink — storage backend handles deletion.
 */

const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm, masterAdminOnly } = require('../middleware/auth');
const { put, signedUrlFor, remove } = require('../lib/storage');
const { auditLog } = require('../lib/auditLogger');
const { logger } = require('../lib/logger');

const UNITY_EXTENSIONS = new Set([
  '.unitypackage','.assetbundle','.unity','.bytes',
  '.asset','.prefab','.scene','.shader','.mat',
  '.fbx','.obj','.glb','.gltf',
  '.zip','.tar','.gz','.tgz',
  '.png','.jpg','.jpeg','.tga','.exr',
  '.wav','.mp3','.ogg',
  '.cs','.json','.xml'
]);

const MAX_UNITY_MB = parseInt(process.env.MAX_UNITY_FILE_MB) || 500;

const arUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UNITY_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (UNITY_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file extension: ${ext}`));
  },
});

router.use(authenticate);

// POST /api/unity/upload
router.post('/upload', requirePerm('perm_upload_unity'),
  (req, res, next) => arUpload.single('file')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds ${MAX_UNITY_MB} MB limit` });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { class_name, subject, topic, language, title, target_states, notes } = req.body;
    const id  = uuidv4();
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const fileSizeMb = (req.file.size / 1024 / 1024).toFixed(2);

    let parsedStates = null;
    try { parsedStates = target_states ? JSON.parse(target_states) : null; } catch(e) {}

    let stored;
    try {
      stored = await put({
        category    : 'unity_assets',
        buffer      : req.file.buffer,
        originalName: req.file.originalname,
        // Unity packages don't MIME-sniff cleanly — skip content sniffing here.
        skipMimeSniff: true,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const uploadId = uuidv4();
      await query(`
        INSERT INTO uploads (id, uploader_id, category, storage_backend, storage_key,
                             bucket, original_name, content_type, size_bytes, checksum_sha256)
        VALUES ($1,$2,'unity_assets',$3,$4,$5,$6,$7,$8,$9)
      `, [uploadId, req.user.id, stored.backend, stored.key, stored.bucket || null,
          req.file.originalname, stored.contentType || 'application/octet-stream', stored.size, stored.checksum]);

      const result = await query(`
        INSERT INTO unity_assets (
          id, name, original_name, file_path, file_size_bytes,
          class_name, subject, topic, language, title,
          file_format, file_size_mb, target_states,
          status, uploaded_by, notes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'uploaded',$14,$15)
        RETURNING *
      `, [
        id, title || req.file.originalname, req.file.originalname,
        stored.key, req.file.size,
        class_name||null, subject||null, topic||null, language||null, title||null,
        ext, fileSizeMb, parsedStates ? JSON.stringify(parsedStates) : null,
        req.user.id, notes||null
      ]);

      await auditLog(req, {
        action: 'unity_asset_uploaded',
        target_type: 'unity_asset',
        target_id: id,
        details: { size_bytes: stored.size, file_format: ext }
      });

      res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.error({ err: err.message }, 'Unity insert failed; rolling back storage');
      try { await remove(stored.key); } catch {}
      res.status(500).json({ error: 'Database insert failed' });
    }
  }
);

// GET /api/unity/assets
router.get('/assets', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const { class_name, subject, topic, language, status, page=1, limit=100 } = req.query;
    const conds = [], vals = [];
    if (class_name) { vals.push(class_name);    conds.push(`a.class_name=$${vals.length}`); }
    if (subject)    { vals.push(subject);        conds.push(`a.subject=$${vals.length}`); }
    if (topic)      { vals.push(`%${topic}%`);   conds.push(`a.topic ILIKE $${vals.length}`); }
    if (language)   { vals.push(language);       conds.push(`a.language=$${vals.length}`); }
    if (status)     { vals.push(status);         conds.push(`a.status=$${vals.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const lim   = Math.min(parseInt(limit) || 100, 500);
    const off   = (Math.max(parseInt(page),1)-1) * lim;
    vals.push(lim, off);
    const r = await query(`
      SELECT a.*, u.full_name AS uploaded_by_name
      FROM unity_assets a LEFT JOIN users u ON u.id=a.uploaded_by
      ${where} ORDER BY a.created_at DESC
      LIMIT $${vals.length-1} OFFSET $${vals.length}
    `, vals);
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    logger.error({ err: err.message }, 'unity list failed');
    res.status(500).json({ error: 'List failed' });
  }
});

// GET /api/unity/assets/:id
router.get('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const r = await query('SELECT * FROM unity_assets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Lookup failed' }); }
});

// GET /api/unity/assets/:id/download — signed URL
router.get('/assets/:id/download', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const r = await query('SELECT file_path, original_name FROM unity_assets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const url = await signedUrlFor(r.rows[0].file_path, {
      expiresInSeconds: 900,
      downloadName: r.rows[0].original_name,
    });
    await auditLog(req, {
      action: 'unity_asset_downloaded',
      target_type: 'unity_asset',
      target_id: req.params.id,
    });
    res.json({ url });
  } catch (err) {
    logger.error({ err: err.message }, 'unity download signing failed');
    res.status(500).json({ error: 'Could not generate download URL' });
  }
});

// PUT /api/unity/assets/:id
router.put('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const { title, class_name, subject, topic, language,
      target_states, target_districts, target_apps, target_classes, target_subjects,
      publish_at, expires_at, restrict_login, offline_available, notes } = req.body;
    const r = await query(`
      UPDATE unity_assets SET
        title=$1, class_name=$2, subject=$3, topic=$4, language=$5,
        target_states=$6, target_districts=$7, target_apps=$8,
        target_classes=$9, target_subjects=$10,
        publish_at=$11, expires_at=$12,
        restrict_login=$13, offline_available=$14,
        notes=$15, updated_at=NOW()
      WHERE id=$16 RETURNING *
    `, [title, class_name, subject, topic, language,
        target_states, target_districts, target_apps,
        target_classes, target_subjects,
        publish_at||null, expires_at||null,
        restrict_login!==false, offline_available!==false,
        notes, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'unity update failed');
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/unity/assets/:id
router.delete('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const ex = await query('SELECT file_path FROM unity_assets WHERE id=$1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Not found' });

    try { await remove(ex.rows[0].file_path); } catch (e) {
      logger.warn({ err: e.message, key: ex.rows[0].file_path }, 'Storage removal failed; deleting DB row anyway');
    }
    await query('DELETE FROM unity_assets WHERE id=$1', [req.params.id]);

    await auditLog(req, {
      action: 'unity_asset_deleted',
      target_type: 'unity_asset',
      target_id: req.params.id,
    });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// POST /api/unity/assets/:id/publish
router.post('/assets/:id/publish', masterAdminOnly, async (req, res) => {
  try {
    const r = await query(`
      UPDATE unity_assets SET status='live', reviewed_by=$1, publish_at=NOW(), updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [req.user.id, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await auditLog(req, { action: 'unity_asset_published', target_type: 'unity_asset', target_id: req.params.id });
    res.json({ message: 'Published', asset: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Publish failed' }); }
});

// POST /api/unity/assets/:id/review
router.post('/assets/:id/review', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const r = await query(
      `UPDATE unity_assets SET status='review', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'In review', asset: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Review failed' }); }
});

module.exports = router;
