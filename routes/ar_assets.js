/**
 * routes/ar_assets.js — AR Asset management with full DB integration
 *
 * POST   /api/ar/upload                Upload AR/Unity asset → saves to disk + DB
 * GET    /api/ar/assets                List assets (filters: class_name, subject, topic, language, status, state)
 * GET    /api/ar/assets/:id            Single asset details
 * PUT    /api/ar/assets/:id            Update metadata
 * DELETE /api/ar/assets/:id            Soft-delete
 * POST   /api/ar/assets/:id/publish    Publish asset (set status = 'published')
 * POST   /api/ar/assets/:id/review     Submit for review
 * GET    /api/ar/topics                Unique topics (filtered by class_name + subject for dropdowns)
 *
 * Curriculum Linkage:
 * POST   /api/ar/links                 Link asset to a curriculum node
 * DELETE /api/ar/links/:linkId         Remove link
 * GET    /api/ar/links/:nodeId         Get all AR links for a curriculum node
 */

const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');

// ── Accepted AR/Unity file extensions ────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([
  '.unitypackage', '.assetbundle', '.unity', '.bytes',
  '.asset', '.prefab', '.scene', '.shader', '.mat',
  '.fbx', '.obj', '.glb', '.gltf',
  '.zip', '.tar', '.gz', '.tgz',
  '.png', '.jpg', '.jpeg', '.tga', '.exr',
  '.wav', '.mp3', '.ogg',
  '.cs', '.json', '.xml'
]);

// ── Multer disk storage ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_DIR || './uploads', 'ar_assets');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`File type "${ext}" not supported. Use Unity-compatible formats.`));
  }
  // No size limit for Unity bundles
});

router.use(authenticate);

// ══ POST /api/ar/upload ══════════════════════════════════════════════════════
router.post('/upload', requirePerm('perm_upload_unity'),
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const {
      class_name, subject, topic, language, title,
      target_states, target_districts, target_apps,
      notes, restrict_login, offline_available
    } = req.body;

    if (!class_name || !subject || !topic) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'class_name, subject and topic are required' });
    }

    const id         = uuidv4();
    const ext        = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const sizeMb     = parseFloat((req.file.size / 1024 / 1024).toFixed(2));
    const filePath   = req.file.path;

    let parsedStates = null, parsedDistricts = null, parsedApps = null;
    try { parsedStates     = target_states     ? JSON.parse(target_states)     : null; } catch {}
    try { parsedDistricts  = target_districts  ? JSON.parse(target_districts)  : null; } catch {}
    try { parsedApps       = target_apps       ? JSON.parse(target_apps)       : null; } catch {}

    try {
      const result = await query(`
        INSERT INTO unity_assets (
          id, name, original_name, file_path, file_size_bytes,
          class_name, subject, topic, language, title,
          file_format, file_size_mb, target_states, target_districts, target_apps,
          restrict_login, offline_available, status, uploaded_by, notes
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17,'uploaded',$18,$19
        ) RETURNING *
      `, [
        id,
        title || req.file.originalname,
        req.file.originalname,
        filePath,
        req.file.size,
        class_name, subject, topic, language || null,
        title || req.file.originalname,
        ext, sizeMb,
        parsedStates ? JSON.stringify(parsedStates) : null,
        parsedDistricts ? JSON.stringify(parsedDistricts) : null,
        parsedApps ? JSON.stringify(parsedApps) : null,
        restrict_login !== 'false',
        offline_available !== 'false',
        req.user.id,
        notes || null
      ]);

      res.status(201).json({ message: 'AR Asset uploaded', asset: result.rows[0] });
    } catch (err) {
      console.error('AR Upload DB error:', err);
      // Try to remove orphaned file
      try { fs.unlinkSync(filePath); } catch {}
      res.status(500).json({ error: 'Database error during upload', detail: err.message });
    }
  }
);

// ══ GET /api/ar/assets ════════════════════════════════════════════════════════
router.get('/assets', async (req, res) => {
  try {
    const { class_name, subject, topic, language, status, state, limit = 200, offset = 0 } = req.query;

    const conditions = ['a.status != \'archived\''];
    const params     = [];
    let p = 1;

    if (class_name) { conditions.push(`a.class_name = $${p++}`); params.push(class_name); }
    if (subject)    { conditions.push(`a.subject = $${p++}`);    params.push(subject); }
    if (topic)      { conditions.push(`a.topic ILIKE $${p++}`);  params.push(`%${topic}%`); }
    if (language)   { conditions.push(`a.language = $${p++}`);   params.push(language); }
    if (status)     { conditions.push(`a.status = $${p++}`);     params.push(status); }

    params.push(parseInt(limit), parseInt(offset));

    const result = await query(`
      SELECT a.*, u.full_name AS uploaded_by_name
      FROM unity_assets a
      LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, params);

    const countResult = await query(`
      SELECT COUNT(*) FROM unity_assets a
      WHERE ${conditions.join(' AND ')}
    `, params.slice(0, -2));

    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0]?.count || 0),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('AR assets list error:', err);
    res.status(500).json({ error: 'Failed to fetch AR assets' });
  }
});

// ══ GET /api/ar/topics — distinct topics (for curriculum dropdowns) ════════════
router.get('/topics', async (req, res) => {
  try {
    const { class_name, subject, language } = req.query;
    const conditions = [`status NOT IN ('archived','rejected')`, 'topic IS NOT NULL'];
    const params = [];
    let p = 1;

    if (class_name) { conditions.push(`class_name = $${p++}`); params.push(class_name); }
    if (subject)    { conditions.push(`subject = $${p++}`);    params.push(subject); }
    if (language)   { conditions.push(`language = $${p++}`);   params.push(language); }

    const result = await query(`
      SELECT DISTINCT ON (topic) id, topic, class_name, subject, language, title, file_format, status, created_at
      FROM unity_assets
      WHERE ${conditions.join(' AND ')}
      ORDER BY topic, created_at DESC
    `, params);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch topics' });
  }
});

// ══ GET /api/ar/assets/:id ════════════════════════════════════════════════════
router.get('/assets/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT a.*, u.full_name AS uploaded_by_name
       FROM unity_assets a LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch asset' });
  }
});

// ══ PUT /api/ar/assets/:id ════════════════════════════════════════════════════
router.put('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const { class_name, subject, topic, language, title, notes, target_states, status } = req.body;
    const result = await query(`
      UPDATE unity_assets
      SET class_name   = COALESCE($1, class_name),
          subject      = COALESCE($2, subject),
          topic        = COALESCE($3, topic),
          language     = COALESCE($4, language),
          title        = COALESCE($5, title),
          notes        = COALESCE($6, notes),
          target_states= COALESCE($7::jsonb, target_states),
          status       = COALESCE($8, status),
          updated_at   = NOW()
      WHERE id = $9 RETURNING *
    `, [class_name, subject, topic, language, title, notes,
        target_states ? JSON.stringify(JSON.parse(target_states)) : null,
        status, req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

// ══ DELETE /api/ar/assets/:id ════════════════════════════════════════════════
router.delete('/assets/:id', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    await query(`UPDATE unity_assets SET status = 'archived', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Asset archived' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive asset' });
  }
});

// ══ POST /api/ar/assets/:id/publish ══════════════════════════════════════════
router.post('/assets/:id/publish', requirePerm('perm_approve_content'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE unity_assets SET status='published', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json({ message: 'Asset published', asset: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish' });
  }
});

// ══ POST /api/ar/assets/:id/review ═══════════════════════════════════════════
router.post('/assets/:id/review', requirePerm('perm_upload_unity'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE unity_assets SET status='review', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json({ message: 'Submitted for review', asset: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit for review' });
  }
});

// ══ POST /api/ar/links — Link AR asset to curriculum node ════════════════════
router.post('/links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { curriculum_node_id, asset_id } = req.body;
    if (!curriculum_node_id || !asset_id) {
      return res.status(400).json({ error: 'curriculum_node_id and asset_id required' });
    }
    const result = await query(`
      INSERT INTO curriculum_ar_links (id, curriculum_node_id, asset_id, linked_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (curriculum_node_id, asset_id) DO NOTHING
      RETURNING *
    `, [uuidv4(), curriculum_node_id, asset_id, req.user.id]);

    res.status(201).json({ message: 'AR asset linked', link: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create AR link' });
  }
});

// ══ DELETE /api/ar/links/:linkId ══════════════════════════════════════════════
router.delete('/links/:linkId', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    await query('DELETE FROM curriculum_ar_links WHERE id = $1', [req.params.linkId]);
    res.json({ message: 'AR link removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove link' });
  }
});

// ══ GET /api/ar/links/:nodeId ════════════════════════════════════════════════
router.get('/links/:nodeId', async (req, res) => {
  try {
    const result = await query(`
      SELECT l.*, a.title, a.topic, a.class_name, a.subject, a.language, a.status, a.file_format
      FROM curriculum_ar_links l
      JOIN unity_assets a ON a.id = l.asset_id
      WHERE l.curriculum_node_id = $1
      ORDER BY l.created_at ASC
    `, [req.params.nodeId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch AR links' });
  }
});

module.exports = router;
