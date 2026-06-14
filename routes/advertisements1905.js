/**
 * routes/advertisements.js — Full Ad Campaign CRUD + Analytics API
 *
 * GET    /api/ads                    List campaigns (filterable)
 * POST   /api/ads                    Create campaign
 * GET    /api/ads/:id                Get single campaign
 * PUT    /api/ads/:id                Update campaign
 * DELETE /api/ads/:id                Archive campaign
 * POST   /api/ads/:id/publish        Publish campaign
 * POST   /api/ads/:id/pause          Pause campaign
 * POST   /api/ads/upload             Upload media file (≤5MB)
 *
 * GET    /api/ads/:id/analytics      Full analytics for one campaign
 * GET    /api/ads/analytics/overview Overall ad analytics dashboard
 * POST   /api/ads/impressions        Ingest impression event (from student app)
 * GET    /api/ads/analytics/export   Download CSV/XLSX
 */
const router  = require('express').Router();
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const XLSX    = require('xlsx');
const { query }  = require('../db');
const { authenticate, requirePerm, masterAdminOnly } = require('../middleware/auth');
const { put, signedUrlFor } = require('../lib/storage');
const { auditLog } = require('../lib/auditLogger');
const { logger } = require('../lib/logger');

// ── File Upload (ad media, max 5 MB) — uses memory + storage abstraction ─────
const adUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.MAX_AD_FILE_MB) || 5) * 1024 * 1024 },
});

// ── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

// ══════════════════════════════════════════════════════════════════════════════
// CAMPAIGN CRUD
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/ads — list with optional filters
router.get('/', async (req, res) => {
  try {
    const { status, state, campaign_id, page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params     = [];

    if (status)      { params.push(status);   conditions.push(`status = $${params.length}`); }
    if (state)       { params.push(`%${state}%`); conditions.push(`$${params.length} = ANY(target_states) OR 'All India' = ANY(target_states)`); }
    if (campaign_id) { params.push(campaign_id); conditions.push(`id = $${params.length}`); }

    const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const result = await query(`
      SELECT c.*,
        u.full_name AS created_by_name
      FROM ad_campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const count = await query(`SELECT COUNT(*) FROM ad_campaigns ${where}`,
      params.slice(0, params.length - 2));

    res.json({
      campaigns : result.rows,
      total     : parseInt(count.rows[0].count),
      page      : parseInt(page),
      limit     : parseInt(limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// POST /api/ads — create campaign
router.post('/', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const {
      name, advertiser, description, media_type,
      publish_at, expires_at, publish_days,
      target_apps, target_states, target_districts, target_classes,
      target_subjects, target_languages,
      daily_push_limit = 5, show_before_topic = false,
      push_start_time = '08:00', push_end_time = '20:00'
    } = req.body;

    if (!name || !media_type) {
      return res.status(400).json({ error: 'name and media_type are required' });
    }

    const id     = uuidv4();
    const result = await query(`
      INSERT INTO ad_campaigns (
        id, name, advertiser, description, media_type,
        publish_at, expires_at, publish_days,
        target_apps, target_states, target_districts, target_classes,
        target_subjects, target_languages,
        daily_push_limit, show_before_topic,
        push_start_time, push_end_time, created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      ) RETURNING *
    `, [
      id, name, advertiser, description, media_type,
      publish_at || null, expires_at || null,
      publish_days || ['Mon','Tue','Wed','Thu','Fri'],
      target_apps || [], target_states || [], target_districts || [],
      target_classes || [], target_subjects || [], target_languages || [],
      Math.min(Math.max(parseInt(daily_push_limit), 0), 50),
      show_before_topic, push_start_time, push_end_time, req.user.id
    ]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// GET /api/ads/:id
router.get('/:id', async (req, res, next) => {
  // ⚡ THE SAFETY NET: If the request is for "kpi" or "analytics", pass it down the road!
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(req.params.id)) {
    return next(); 
  }

  try {
    const result = await query(`
      SELECT c.*, u.full_name AS created_by_name
      FROM ad_campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = $1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

// PUT /api/ads/:id
router.put('/:id', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const fields = [];
    const vals   = [];
    const allowed = [
      'name','advertiser','description','publish_at','expires_at','publish_days',
      'target_apps','target_states','target_districts','target_classes',
      'target_subjects','target_languages','daily_push_limit','show_before_topic',
      'push_start_time','push_end_time'
    ];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) {
        vals.push(f === 'daily_push_limit'
          ? Math.min(Math.max(parseInt(req.body[f]), 0), 50)
          : req.body[f]);
        fields.push(`${f} = $${vals.length}`);
      }
    });
    if (!fields.length) return res.status(400).json({ error: 'No valid fields provided' });

    vals.push(new Date(), req.params.id);
    const result = await query(`
      UPDATE ad_campaigns SET ${fields.join(', ')}, updated_at = $${vals.length - 1}
      WHERE id = $${vals.length} RETURNING *
    `, vals);

    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// POST /api/ads/:id/publish
router.post('/:id/publish', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE ad_campaigns SET status='live', publish_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ message: 'Campaign published', campaign: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish' });
  }
});

// POST /api/ads/:id/pause
router.post('/:id/pause', requirePerm('perm_manage_ads'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE ad_campaigns SET status='paused', updated_at=NOW()
       WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ message: 'Campaign paused', campaign: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause' });
  }
});

// POST /api/ads/upload — upload media file (signed-URL friendly)
router.post('/upload', requirePerm('perm_manage_ads'),
  (req, res, next) => adUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds ${process.env.MAX_AD_FILE_MB || 5} MB limit` });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { campaign_id } = req.body;

    try {
      const stored = await put({
        category    : 'ad_media',
        buffer      : req.file.buffer,
        originalName: req.file.originalname,
      });

      // Record in uploads table
      const uploadId = uuidv4();
      await query(`
        INSERT INTO uploads (id, uploader_id, category, storage_backend, storage_key,
                             bucket, original_name, content_type, size_bytes, checksum_sha256)
        VALUES ($1,$2,'ad_media',$3,$4,$5,$6,$7,$8,$9)
      `, [uploadId, req.user.id, stored.backend, stored.key, stored.bucket || null,
          req.file.originalname, stored.contentType, stored.size, stored.checksum]);

      if (campaign_id) {
        await query(
          'UPDATE ad_campaigns SET storage_key=$1, file_size_bytes=$2, updated_at=NOW() WHERE id=$3',
          [stored.key, stored.size, campaign_id]
        );
      }

      await auditLog(req, {
        action: 'ad_media_uploaded',
        target_type: 'upload',
        target_id: uploadId,
        details: { campaign_id, size_bytes: stored.size, content_type: stored.contentType }
      });

      // Issue a signed URL the dashboard can use to play/preview immediately
      const url = await signedUrlFor(stored.key, { expiresInSeconds: 3600 });

      res.json({
        upload_id    : uploadId,
        url,
        storage_key  : stored.key,
        original_name: req.file.originalname,
        size_bytes   : stored.size,
        size_mb      : (stored.size / 1024 / 1024).toFixed(2),
        content_type : stored.contentType,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'Ad upload failed');
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
  }
);

// GET /api/ads/:id/media — short-lived signed URL for playback
router.get('/:id/media', async (req, res) => {
  try {
    const r = await query('SELECT storage_key FROM ad_campaigns WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].storage_key) {
      return res.status(404).json({ error: 'No media for this campaign' });
    }
    const url = await signedUrlFor(r.rows[0].storage_key, { expiresInSeconds: 600 });
    res.json({ url });
  } catch (err) {
    logger.error({ err: err.message }, 'Signed URL fetch failed');
    res.status(500).json({ error: 'Could not produce media URL' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// IMPRESSION INGESTION (called by student apps)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/impressions', async (req, res) => {
  try {
    const {
      campaign_id, device_id, student_id, state, district,
      school_id, class_grade, age_group, subject_context,
      app_language, app_version, media_type,
      view_seconds = 0, completed = false, clicked = false,
      skipped = false, is_repeat = false, repeat_count = 1
    } = req.body;

    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    await query(`
      INSERT INTO ad_impressions (
        id, campaign_id, device_id, student_id, state, district,
        school_id, class_grade, age_group, subject_context,
        app_language, app_version, media_type,
        view_seconds, completed, clicked, skipped, is_repeat, repeat_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    `, [
      uuidv4(), campaign_id, device_id, student_id, state, district,
      school_id, class_grade, age_group, subject_context,
      app_language, app_version, media_type,
      view_seconds, completed, clicked, skipped, is_repeat, repeat_count
    ]);

    // Update campaign counters (async — fire and forget)
    query(`
      UPDATE ad_campaigns SET
        total_impressions = total_impressions + 1,
        total_completions = total_completions + $1,
        total_clicks      = total_clicks + $2,
        avg_view_seconds  = (avg_view_seconds * (total_impressions) + $3) / (total_impressions + 1),
        updated_at        = NOW()
      WHERE id = $4
    `, [completed ? 1 : 0, clicked ? 1 : 0, view_seconds, campaign_id]).catch(() => {});

    res.status(202).json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record impression' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/ads/analytics/overview — dashboard summary
router.get('/analytics/overview', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const { campaign_id, state, district, class_grade, subject, language, days = 30 } = req.query;
    const conditions = [`viewed_at > NOW() - INTERVAL '${parseInt(days)} days'`];
    const params     = [];

    if (campaign_id) { params.push(campaign_id); conditions.push(`campaign_id = $${params.length}`); }
    if (state)       { params.push(state);       conditions.push(`state = $${params.length}`); }
    if (district)    { params.push(district);    conditions.push(`district = $${params.length}`); }
    if (class_grade) { params.push(class_grade); conditions.push(`class_grade = $${params.length}`); }
    if (subject)     { params.push(subject);     conditions.push(`subject_context = $${params.length}`); }
    if (language)    { params.push(language);    conditions.push(`app_language = $${params.length}`); }

    const where = 'WHERE ' + conditions.join(' AND ');

    // KPIs
    const kpi = await query(`
      SELECT
        COUNT(*)                                     AS total_impressions,
        COUNT(DISTINCT student_id)                   AS unique_viewers,
        ROUND(AVG(view_seconds)::NUMERIC, 1)         AS avg_view_seconds,
        ROUND(100.0 * SUM(CASE WHEN completed THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS completion_rate,
        ROUND(1.0 * COUNT(*) / NULLIF(COUNT(DISTINCT student_id),0), 2) AS repeat_views,
        ROUND(100.0 * SUM(CASE WHEN clicked THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2)  AS ctr
      FROM ad_impressions ${where}
    `, params);

    // Hourly distribution
    const hourly = await query(`
      SELECT hour_of_day, COUNT(*) AS impressions
      FROM ad_impressions ${where}
      GROUP BY hour_of_day ORDER BY hour_of_day
    `, params);

    // Daily trend (last N days)
    const daily = await query(`
      SELECT DATE(viewed_at) AS day,
             COUNT(*) AS impressions,
             COUNT(DISTINCT student_id) AS unique_viewers
      FROM ad_impressions ${where}
      GROUP BY day ORDER BY day
    `, params);

    // By state
    const byState = await query(`
      SELECT state,
             COUNT(*) AS impressions,
             ROUND(100.0 * SUM(CASE WHEN completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS completion_rate
      FROM ad_impressions ${where} AND state IS NOT NULL
      GROUP BY state ORDER BY impressions DESC LIMIT 10
    `, params);

    // By district
    const byDistrict = await query(`
      SELECT district, COUNT(*) AS impressions
      FROM ad_impressions ${where} AND district IS NOT NULL
      GROUP BY district ORDER BY impressions DESC LIMIT 10
    `, params);

    // By classroom
    const byClass = await query(`
      SELECT class_grade, COUNT(*) AS impressions
      FROM ad_impressions ${where} AND class_grade IS NOT NULL
      GROUP BY class_grade ORDER BY impressions DESC
    `, params);

    // By age group
    const byAge = await query(`
      SELECT age_group, COUNT(*) AS impressions
      FROM ad_impressions ${where} AND age_group IS NOT NULL
      GROUP BY age_group ORDER BY impressions DESC
    `, params);

    // By subject
    const bySubject = await query(`
      SELECT subject_context AS subject, COUNT(*) AS impressions
      FROM ad_impressions ${where} AND subject_context IS NOT NULL
      GROUP BY subject ORDER BY impressions DESC
    `, params);

    // By language
    const byLanguage = await query(`
      SELECT app_language AS language, COUNT(*) AS impressions
      FROM ad_impressions ${where} AND app_language IS NOT NULL
      GROUP BY language ORDER BY impressions DESC
    `, params);

    // By day of week
    const byDOW = await query(`
      SELECT day_of_week,
             COUNT(*) AS impressions,
             ROUND(100.0 * SUM(CASE WHEN completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS completion_rate
      FROM ad_impressions ${where}
      GROUP BY day_of_week ORDER BY day_of_week
    `, params);

    // By media type
    const byMedia = await query(`
      SELECT media_type,
             COUNT(*) AS impressions,
             ROUND(100.0 * SUM(CASE WHEN completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS completion_rate,
             ROUND(100.0 * SUM(CASE WHEN clicked THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2) AS ctr
      FROM ad_impressions ${where} AND media_type IS NOT NULL
      GROUP BY media_type
    `, params);

    // Completion funnel (view quartiles)
    const funnel = await query(`
      SELECT
        COUNT(*)                                                         AS delivered,
        SUM(CASE WHEN view_seconds > 0 THEN 1 ELSE 0 END)               AS started,
        SUM(CASE WHEN view_seconds >= (SELECT AVG(view_seconds)*0.5 FROM ad_impressions ${where}) THEN 1 ELSE 0 END) AS halfway,
        SUM(CASE WHEN view_seconds >= (SELECT AVG(view_seconds)*0.75 FROM ad_impressions ${where}) THEN 1 ELSE 0 END) AS three_quarters,
        SUM(CASE WHEN completed THEN 1 ELSE 0 END)                       AS completed
      FROM ad_impressions ${where}
    `, params);

    // Repeat distribution
    const repeatDist = await query(`
      SELECT repeat_count, COUNT(*) AS viewers
      FROM ad_impressions ${where}
      GROUP BY repeat_count ORDER BY repeat_count LIMIT 6
    `, params);

    // Granular table
    const granular = await query(`
      SELECT state, district, class_grade, age_group, subject_context, app_language,
             COUNT(*) AS impressions,
             COUNT(DISTINCT student_id) AS unique_viewers,
             ROUND(AVG(view_seconds)::NUMERIC,1) AS avg_view_sec,
             ROUND(100.0*SUM(CASE WHEN completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS completion_pct,
             ROUND(1.0*COUNT(*)/NULLIF(COUNT(DISTINCT student_id),0),1) AS repeat_views,
             ROUND(100.0*SUM(CASE WHEN skipped THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS skip_rate,
             ROUND(100.0*SUM(CASE WHEN clicked THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2) AS ctr
      FROM ad_impressions ${where}
      GROUP BY state, district, class_grade, age_group, subject_context, app_language
      ORDER BY impressions DESC LIMIT 100
    `, params);

    res.json({
      kpi          : kpi.rows[0],
      hourly       : hourly.rows,
      daily        : daily.rows,
      by_state     : byState.rows,
      by_district  : byDistrict.rows,
      by_class     : byClass.rows,
      by_age       : byAge.rows,
      by_subject   : bySubject.rows,
      by_language  : byLanguage.rows,
      by_dow       : byDOW.rows,
      by_media     : byMedia.rows,
      funnel       : funnel.rows[0],
      repeat_dist  : repeatDist.rows,
      granular     : granular.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analytics query failed' });
  }
});

// GET /api/ads/analytics/export?format=csv|xlsx
router.get('/analytics/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const { format = 'xlsx', campaign_id, days = 30 } = req.query;
    const conditions = [`viewed_at > NOW() - INTERVAL '${parseInt(days)} days'`];
    const params = [];

    if (campaign_id) { params.push(campaign_id); conditions.push(`campaign_id = $${params.length}`); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const result = await query(`
      SELECT
        c.name AS campaign_name,
        i.state, i.district, i.class_grade, i.age_group,
        i.subject_context, i.app_language, i.media_type,
        i.view_seconds, i.completed, i.clicked, i.skipped,
        i.is_repeat, i.repeat_count,
        TO_CHAR(i.viewed_at,'YYYY-MM-DD HH24:MI') AS viewed_at
      FROM ad_impressions i
      LEFT JOIN ad_campaigns c ON c.id = i.campaign_id
      ${where}
      ORDER BY i.viewed_at DESC
      LIMIT 10000
    `, params);

    const ws = XLSX.utils.json_to_sheet(result.rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ad_Analytics');

    const ext      = format === 'csv' ? 'csv' : 'xlsx';
    const bookType = format === 'csv' ? 'csv'  : 'xlsx';
    const buf      = XLSX.write(wb, { type: 'buffer', bookType });
    const fname    = `MITRA_Ad_Analytics_${new Date().toISOString().slice(0,10)}.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/ads/analytics/granular/export
router.get('/analytics/granular/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const { format = 'xlsx', campaign_id, days = 30 } = req.query;
    const conditions = [`viewed_at > NOW() - INTERVAL '${parseInt(days)} days'`];
    const params = [];
    if (campaign_id) { params.push(campaign_id); conditions.push(`campaign_id = $${params.length}`); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const result = await query(`
      SELECT state, district, class_grade, age_group, subject_context, app_language,
        COUNT(*) AS impressions,
        COUNT(DISTINCT student_id) AS unique_viewers,
        ROUND(AVG(view_seconds)::NUMERIC,1) AS avg_view_seconds,
        ROUND(100.0*SUM(CASE WHEN completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS completion_pct,
        ROUND(1.0*COUNT(*)/NULLIF(COUNT(DISTINCT student_id),0),1) AS repeat_views,
        ROUND(100.0*SUM(CASE WHEN skipped THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS skip_rate_pct,
        ROUND(100.0*SUM(CASE WHEN clicked THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2) AS ctr_pct
      FROM ad_impressions ${where}
      GROUP BY state, district, class_grade, age_group, subject_context, app_language
      ORDER BY impressions DESC
    `, params);

    const ws = XLSX.utils.json_to_sheet(result.rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Granular_Data');
    const bookType = format === 'csv' ? 'csv' : 'xlsx';
    const buf = XLSX.write(wb, { type: 'buffer', bookType });
    const ext = format === 'csv' ? 'csv' : 'xlsx';

    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Ad_Granular_${new Date().toISOString().slice(0,10)}.${ext}"`);
    res.setHeader('Content-Type', format === 'csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Granular export failed' });
  }
});

module.exports = router;
