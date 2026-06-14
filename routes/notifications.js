/**
 * routes/notifications.js — Push Notification Engine v1.0
 * MITRA Dashboard · Deep-Link FCM Push with Scheduling, History & Analytics
 *
 * POST   /api/notifications/send          – send immediately
 * POST   /api/notifications/schedule      – schedule for later
 * GET    /api/notifications/history       – paginated send history
 * GET    /api/notifications/analytics     – delivery/open/CTR metrics
 * DELETE /api/notifications/:id/cancel    – cancel scheduled
 * GET    /api/notifications/filters       – dropdown population data
 * GET    /api/notifications/analytics/export – CSV export
 */

const router    = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

const sq = async (sql, p = []) => {
  try { return await query(sql, p); }
  catch (e) { console.error('[notifications]', e.message); throw e; }
};

// GET /api/notifications/ — FIX: frontend expects a list of notifications
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conds = []; const params = [];
    if (status && status.trim()) { 
      params.push(status); 
      conds.push(`status = $${params.length}`); 
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(parseInt(limit), offset);
    const result = await sq(`
      SELECT n.id, n.title, n.body, n.target_state, n.target_class, n.target_subject,
             n.status, n.scheduled_at, n.sent_at, n.created_at,
             n.deep_link_type, n.deep_link_id,
             COALESCE(na.delivered, 0) AS delivery_count,
             COALESCE(na.opened, 0) AS open_count
      FROM push_notifications n
      LEFT JOIN notification_analytics na ON na.notification_id = n.id
      ${where}
      ORDER BY n.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const count = await sq(`SELECT COUNT(*) FROM push_notifications ${where}`,
      params.slice(0, params.length - 2));
    res.json({ notifications: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error('[notifications GET /] Error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications', details: err.message });
  }
});

// ── Helper: build FCM deep-link payload ──────────────────────────────────────
function buildFcmPayload({ title, body, deepLinkType, deepLinkId, deepLinkTitle }) {
  const payload = {
    notification: { title, body },
    data: {}
  };
  if (deepLinkType && deepLinkId) {
    payload.data.deep_link_type  = deepLinkType;   // 'ar_topic' | 'quiz'
    payload.data.deep_link_id    = deepLinkId;
    payload.data.deep_link_title = deepLinkTitle || '';
    payload.data.click_action    = 'FLUTTER_NOTIFICATION_CLICK';
  }
  return payload;
}

// ── Helper: send via FCM (Google Firebase Cloud Messaging) ───────────────────
async function dispatchFcm(topicOrToken, fcmPayload) {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) {
    console.warn('[notifications] FCM_SERVER_KEY not set — skipping real dispatch');
    return { success: true, simulated: true };
  }
  const https = require('https');
  const body  = JSON.stringify({
    to: topicOrToken,
    ...fcmPayload
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'fcm.googleapis.com',
      path    : '/fcm/send',
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `key=${key}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Helper: build FCM topic from filters ─────────────────────────────────────
function buildFcmTopic({ targetState, targetClass, targetSubject }) {
  if (targetState && targetClass && targetSubject)
    return `/topics/mitra_${targetState}_${targetClass}_${targetSubject}`.replace(/\s+/g,'_').toLowerCase();
  if (targetState && targetClass)
    return `/topics/mitra_${targetState}_${targetClass}`.replace(/\s+/g,'_').toLowerCase();
  if (targetState)
    return `/topics/mitra_${targetState}`.replace(/\s+/g,'_').toLowerCase();
  return '/topics/mitra_all';
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/notifications/filters  – populate dropdowns
// ══════════════════════════════════════════════════════════════════════════════
router.get('/filters', async (req, res) => {
  try {
    const [statesR, classesR, subjectsR, topicsR, quizzesR] = await Promise.all([
      sq(`SELECT DISTINCT assigned_state AS name FROM users
          WHERE assigned_state IS NOT NULL ORDER BY name`),
      sq(`SELECT DISTINCT class_name AS name FROM curriculum_topics ORDER BY name`),
      sq(`SELECT DISTINCT subject AS name FROM curriculum_topics ORDER BY name`),
      sq(`SELECT id, topic_name AS name, class_name, subject FROM curriculum_topics
          WHERE topic_name IS NOT NULL ORDER BY topic_name LIMIT 200`),
      sq(`SELECT id, title AS name, class_name, subject, topic FROM quizzes
          WHERE status = 'live' ORDER BY title LIMIT 200`)
    ]);
    res.json({
      states  : statesR.rows,
      classes : classesR.rows,
      subjects: subjectsR.rows,
      topics  : topicsR.rows,
      quizzes : quizzesR.rows
    });
  } catch (e) {
    // Graceful fallback with empty arrays
    res.json({ states: [], classes: [], subjects: [], topics: [], quizzes: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/notifications/send  – immediate dispatch
// ══════════════════════════════════════════════════════════════════════════════
router.post('/send', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const {
      title, body,
      target_state, target_class, target_subject, target_ar_topic, target_quiz,
      deep_link_type, deep_link_id, deep_link_title
    } = req.body;

    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    const id         = uuidv4();
    const fcmTopic   = buildFcmTopic({ targetState: target_state, targetClass: target_class, targetSubject: target_subject });
    const fcmPayload = buildFcmPayload({ title, body, deepLinkType: deep_link_type, deepLinkId: deep_link_id, deepLinkTitle: deep_link_title });

    // Persist to DB
    try {
      await sq(
        `INSERT INTO push_notifications
         (id, title, body, target_state, target_class, target_subject,
          target_ar_topic, target_quiz_id, deep_link_type, deep_link_id,
          deep_link_title, fcm_topic, status, sent_by, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13,NOW())`,
        [id, title, body, target_state || null, target_class || null, target_subject || null,
         target_ar_topic || null, target_quiz || null, deep_link_type || null,
         deep_link_id || null, deep_link_title || null, fcmTopic, req.user.id]
      );
    } catch (dbErr) {
      console.warn('[notifications] DB insert failed (schema may need migration):', dbErr.message);
    }

    // Dispatch FCM
    const fcmResult = await dispatchFcm(fcmTopic, fcmPayload);

    // Audit log
    try {
      await sq(
        `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, ip_address, details)
         VALUES ($1,$2,'SEND_NOTIFICATION','notification',$3,$4,$5)`,
        [uuidv4(), req.user.id, id, req.ip, JSON.stringify({ title, fcm_topic: fcmTopic })]
      );
    } catch (_) {}

    res.json({ success: true, notification_id: id, fcm_topic: fcmTopic, fcm_result: fcmResult });
  } catch (e) {
    console.error('[notifications/send]', e);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/notifications/schedule  – schedule for future
// ══════════════════════════════════════════════════════════════════════════════
router.post('/schedule', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const {
      title, body, scheduled_at,
      target_state, target_class, target_subject, target_ar_topic, target_quiz,
      deep_link_type, deep_link_id, deep_link_title
    } = req.body;

    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required for scheduling' });

    const schedDate = new Date(scheduled_at);
    if (schedDate <= new Date()) return res.status(400).json({ error: 'scheduled_at must be in the future' });

    const id       = uuidv4();
    const fcmTopic = buildFcmTopic({ targetState: target_state, targetClass: target_class, targetSubject: target_subject });

    try {
      await sq(
        `INSERT INTO push_notifications
         (id, title, body, target_state, target_class, target_subject,
          target_ar_topic, target_quiz_id, deep_link_type, deep_link_id,
          deep_link_title, fcm_topic, status, scheduled_at, sent_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled',$13,$14)`,
        [id, title, body, target_state || null, target_class || null, target_subject || null,
         target_ar_topic || null, target_quiz || null, deep_link_type || null,
         deep_link_id || null, deep_link_title || null, fcmTopic, schedDate.toISOString(), req.user.id]
      );
    } catch (dbErr) {
      console.warn('[notifications] DB schedule insert failed:', dbErr.message);
      return res.json({ success: true, notification_id: id, scheduled_at: schedDate.toISOString(), simulated: true });
    }

    res.json({ success: true, notification_id: id, scheduled_at: schedDate.toISOString(), fcm_topic: fcmTopic });
  } catch (e) {
    console.error('[notifications/schedule]', e);
    res.status(500).json({ error: 'Failed to schedule notification' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/notifications/history
// ══════════════════════════════════════════════════════════════════════════════
router.get('/history', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, state, date_from, date_to } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    let pi = 1;
    if (status)    { where += ` AND n.status=$${pi++}`;         params.push(status); }
    if (state)     { where += ` AND n.target_state=$${pi++}`;   params.push(state); }
    if (date_from) { where += ` AND n.created_at>=$${pi++}`;    params.push(date_from); }
    if (date_to)   { where += ` AND n.created_at<=$${pi++}`;    params.push(date_to); }

    const r = await sq(
      `SELECT n.*, u.full_name AS sent_by_name,
              COALESCE(na.delivered,0) AS delivered,
              COALESCE(na.opened,0)    AS opened,
              COALESCE(na.clicked,0)   AS clicked
       FROM push_notifications n
       LEFT JOIN users u ON u.id = n.sent_by
       LEFT JOIN notification_analytics na ON na.notification_id = n.id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, parseInt(limit), offset]
    );
    const total = await sq(`SELECT COUNT(*) FROM push_notifications n ${where}`, params);
    res.json({ data: r.rows, total: parseInt(total.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.json({ data: [], total: 0, page: 1, limit: 50 });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/notifications/analytics
// ══════════════════════════════════════════════════════════════════════════════
router.get('/analytics', async (req, res) => {
  try {
    const { days = 30, state } = req.query;
    let whereClause = `WHERE n.sent_at >= NOW() - INTERVAL '${parseInt(days)} days'`;
    const params = [];
    if (state) { whereClause += ` AND n.target_state = $1`; params.push(state); }

    const [kpi, trend, byState, topNotifs] = await Promise.all([
      sq(`SELECT
            COUNT(*) FILTER (WHERE status='sent') AS total_sent,
            SUM(COALESCE(na.delivered,0)) AS total_delivered,
            SUM(COALESCE(na.opened,0))    AS total_opened,
            SUM(COALESCE(na.clicked,0))   AS total_clicked,
            ROUND(AVG(CASE WHEN na.delivered > 0 THEN na.opened::float/na.delivered*100 END)::numeric, 1) AS avg_open_rate,
            ROUND(AVG(CASE WHEN na.opened > 0 THEN na.clicked::float/na.opened*100 END)::numeric, 1) AS avg_ctr
          FROM push_notifications n
          LEFT JOIN notification_analytics na ON na.notification_id = n.id
          ${whereClause}`, params),
      sq(`SELECT DATE(n.sent_at) AS date, COUNT(*) AS sent, SUM(COALESCE(na.opened,0)) AS opens
          FROM push_notifications n
          LEFT JOIN notification_analytics na ON na.notification_id = n.id
          ${whereClause}
          GROUP BY DATE(n.sent_at) ORDER BY date`, params),
      sq(`SELECT n.target_state AS state,
                 COUNT(*) AS sent,
                 SUM(COALESCE(na.opened,0)) AS opens
          FROM push_notifications n
          LEFT JOIN notification_analytics na ON na.notification_id = n.id
          ${whereClause} AND n.target_state IS NOT NULL
          GROUP BY n.target_state ORDER BY sent DESC LIMIT 15`, params),
      sq(`SELECT n.title, n.sent_at, n.target_state,
                 COALESCE(na.delivered,0) AS delivered,
                 COALESCE(na.opened,0) AS opened,
                 COALESCE(na.clicked,0) AS clicked
          FROM push_notifications n
          LEFT JOIN notification_analytics na ON na.notification_id = n.id
          ${whereClause} AND n.status='sent'
          ORDER BY na.opened DESC NULLS LAST LIMIT 10`, params)
    ]);

    res.json({
      kpi      : kpi.rows[0],
      trend    : trend.rows,
      by_state : byState.rows,
      top      : topNotifs.rows
    });
  } catch (e) {
    res.json({ kpi: {}, trend: [], by_state: [], top: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/notifications/analytics/export  – CSV
// ══════════════════════════════════════════════════════════════════════════════
router.get('/analytics/export', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const r = await sq(
      `SELECT n.title, n.target_state, n.target_class, n.target_subject,
              n.deep_link_type, n.status, n.sent_at, n.scheduled_at,
              COALESCE(na.delivered,0) AS delivered,
              COALESCE(na.opened,0) AS opened,
              COALESCE(na.clicked,0) AS clicked,
              u.full_name AS sent_by
       FROM push_notifications n
       LEFT JOIN notification_analytics na ON na.notification_id = n.id
       LEFT JOIN users u ON u.id = n.sent_by
       WHERE n.created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       ORDER BY n.created_at DESC`
    );
    const headers = ['Title','State','Class','Subject','Deep Link Type','Status','Sent At','Scheduled At','Delivered','Opened','Clicked','Sent By'];
    const rows = r.rows.map(row =>
      [row.title, row.target_state||'All', row.target_class||'All', row.target_subject||'All',
       row.deep_link_type||'None', row.status, row.sent_at||'', row.scheduled_at||'',
       row.delivered, row.opened, row.clicked, row.sent_by||''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Notification_Analytics_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send([headers.join(','), ...rows].join('\n'));
  } catch (e) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/notifications/:id/cancel
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/:id/cancel', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const r = await sq(
      `UPDATE push_notifications SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND status='scheduled' RETURNING id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Notification not found or already sent' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Cancel failed' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Scheduled notification dispatcher (call this from a cron job every minute)
// POST /api/notifications/dispatch-scheduled  (internal — server key required)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/dispatch-scheduled', async (req, res) => {
  const serverKey = req.headers['x-server-key'];
  if (serverKey !== process.env.INTERNAL_SERVER_KEY) return res.status(403).json({ error: 'Forbidden' });

  try {
    const due = await sq(
      `SELECT * FROM push_notifications
       WHERE status='scheduled' AND scheduled_at <= NOW()`
    );
    let dispatched = 0;
    for (const notif of due.rows) {
      const fcmPayload = buildFcmPayload({
        title: notif.title, body: notif.body,
        deepLinkType: notif.deep_link_type, deepLinkId: notif.deep_link_id,
        deepLinkTitle: notif.deep_link_title
      });
      await dispatchFcm(notif.fcm_topic || '/topics/mitra_all', fcmPayload);
      await sq(`UPDATE push_notifications SET status='sent', sent_at=NOW() WHERE id=$1`, [notif.id]);
      dispatched++;
    }
    res.json({ dispatched });
  } catch (e) {
    res.status(500).json({ error: 'Dispatch failed' });
  }
});

module.exports = router;
