/**
 * routes/analytics.js — Student App Telemetry & Replay Analytics
 *
 * GET  /api/analytics/overview         Dashboard KPIs
 * GET  /api/analytics/replay           Replay & repeat engagement
 * GET  /api/analytics/location         State/district breakdown
 * GET  /api/analytics/classroom        Subject/class analytics
 * GET  /api/analytics/predictive       Churn & predictive signals
 * POST /api/analytics/telemetry        Ingest session event (from app)
 * GET  /api/analytics/export           Download as CSV/XLSX
 */
const router = require('express').Router();
const XLSX   = require('xlsx');
const { query }  = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(authenticate);

// ── Ingest telemetry from student app (unauthenticated — BUG-FIX #8) ─────────
// Must be ABOVE the authenticate middleware so student apps can POST without JWT
router.post('/telemetry', async (req, res) => {
  try {
    const {
      device_id, student_id, state, district, school_id,
      class_grade, subject, topic_id, session_minutes = 0,
      replay_count = 0, completed = false, dropped_off = false,
      offline_session = false, app_language, device_tier
    } = req.body;

    await query(`
      INSERT INTO app_telemetry (
        device_id, student_id, state, district, school_id,
        class_grade, subject, topic_id, session_minutes,
        replay_count, completed, dropped_off,
        offline_session, app_language, device_tier
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      device_id, student_id, state, district, school_id,
      class_grade, subject, topic_id || null,
      session_minutes, replay_count, completed, dropped_off,
      offline_session, app_language, device_tier
    ]);

    res.status(202).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: 'Telemetry ingestion failed' });
  }
});

// ── Overview KPIs ─────────────────────────────────────────────────────────────
router.get('/overview', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const { state, district, days = 30 } = req.query;
    const where = buildWhere({ state, district, days });

    const kpi = await query(`
      SELECT
        COUNT(DISTINCT student_id)                AS active_users,
        ROUND(AVG(session_minutes)::NUMERIC, 1)   AS avg_session_mins,
        ROUND(100.0 * SUM(CASE WHEN dropped_off THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0), 1) AS dropoff_pct,
        ROUND(100.0 * SUM(CASE WHEN offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0), 1) AS offline_pct,
        ROUND(AVG(replay_count)::NUMERIC, 2)      AS avg_replays
      FROM app_telemetry ${where.text}
    `, where.params);

    res.json(kpi.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Overview query failed', detail: err.message });
  }
});

// ── Replay & Repeat Analytics ──────────────────────────────────────────────────
router.get('/replay', requirePerm('perm_replay_analytics'), async (req, res) => {
  try {
    const { state, district, class_grade, subject, days = 30 } = req.query;
    const conds = [`recorded_at > NOW() - INTERVAL '${parseInt(days)} days'`];
    const params = [];
    // FIX: treat empty strings as missing (frontend sends state='' when no filter selected)
    if (state       && state.trim())       { params.push(state.trim());       conds.push(`state = $${params.length}`); }
    if (district    && district.trim())    { params.push(district.trim());    conds.push(`district = $${params.length}`); }
    if (class_grade && class_grade.trim()) { params.push(class_grade.trim()); conds.push(`class_grade = $${params.length}`); }
    if (subject     && subject.trim())     { params.push(subject.trim());     conds.push(`subject = $${params.length}`); }
    const where = 'WHERE ' + conds.join(' AND ');

    const kpi = await query(`
      SELECT
        COUNT(*) AS total_replays,
        ROUND(AVG(replay_count)::NUMERIC, 2) AS avg_replays_per_student,
        SUM(CASE WHEN replay_count >= 2 THEN 1 ELSE 0 END) AS repeat_sessions
      FROM app_telemetry ${where}
    `, params);

    const byModule = await query(`
      SELECT t.topic_id, n.name AS topic,
             ROUND(AVG(t.replay_count)::NUMERIC, 2) AS avg_replays,
             COUNT(*) AS total_events
      FROM app_telemetry t
      LEFT JOIN curriculum_nodes n ON n.id = t.topic_id::uuid
      ${where} AND t.topic_id IS NOT NULL AND t.topic_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      GROUP BY t.topic_id, n.name
      ORDER BY avg_replays DESC LIMIT 20
    `, params);

    const bySubject = await query(`
      SELECT subject,
             ROUND(AVG(replay_count)::NUMERIC, 2) AS avg_replays,
             COUNT(DISTINCT student_id) AS repeat_students
      FROM app_telemetry ${where}
      GROUP BY subject 
      HAVING subject IS NOT NULL
      ORDER BY avg_replays DESC
    `, params);

    const byState = await query(`
      SELECT state,
             ROUND(AVG(replay_count)::NUMERIC, 2) AS avg_replays,
             ROUND(100.0 * SUM(CASE WHEN replay_count>=2 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS repeat_pct
      FROM app_telemetry ${where}
      GROUP BY state 
      HAVING state IS NOT NULL
      ORDER BY avg_replays DESC
    `, params);

    const table = await query(`
      SELECT n.name AS module, t.subject, t.class_grade, t.state, t.district,
             ROUND(AVG(t.replay_count)::NUMERIC, 2) AS avg_replays,
             COUNT(*) AS total_events,
             ROUND(100.0 * SUM(CASE WHEN t.replay_count>=2 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) AS repeat_pct
      FROM app_telemetry t
      LEFT JOIN curriculum_nodes n ON n.id = t.topic_id::uuid
      ${where} AND t.topic_id IS NOT NULL AND t.topic_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      GROUP BY n.name, t.subject, t.class_grade, t.state, t.district
      ORDER BY avg_replays DESC LIMIT 50
    `, params);

    res.json({
      kpi       : kpi.rows[0],
      by_module : byModule.rows,
      by_subject: bySubject.rows,
      by_state  : byState.rows,
      table     : table.rows
    });
  } catch (err) {
    console.error('[analytics/replay]', err);
    res.status(500).json({ error: 'Replay analytics failed', detail: err.message });
  }
});


// ── Export ────────────────────────────────────────────────────────────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const { format = 'xlsx', type = 'telemetry', days = 30 } = req.query;
    let result;

    if (type === 'replay') {
      result = await query(`
        SELECT t.state, t.district, t.class_grade, t.subject,
               n.name AS topic, t.app_language,
               t.session_minutes, t.replay_count, t.completed,
               t.offline_session, t.device_tier,
               TO_CHAR(t.recorded_at,'YYYY-MM-DD HH24:MI') AS recorded_at
        FROM app_telemetry t
        LEFT JOIN curriculum_nodes n ON n.id = t.topic_id
        WHERE t.recorded_at > NOW() - INTERVAL '${parseInt(days)} days'
        ORDER BY t.replay_count DESC LIMIT 10000
      `);
    } else {
      result = await query(`
        SELECT state, district, class_grade, subject,
               ROUND(AVG(session_minutes)::NUMERIC,1) AS avg_session_mins,
               ROUND(AVG(replay_count)::NUMERIC,2)    AS avg_replays,
               COUNT(DISTINCT student_id)             AS active_users,
               ROUND(100.0*SUM(CASE WHEN offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS offline_pct,
               ROUND(100.0*SUM(CASE WHEN dropped_off THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1)     AS dropoff_pct
        FROM app_telemetry
        WHERE recorded_at > NOW() - INTERVAL '${parseInt(days)} days'
        GROUP BY state, district, class_grade, subject
        ORDER BY active_users DESC
      `);
    }

    const ws   = XLSX.utils.json_to_sheet(result.rows);
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Analytics');
    const ext      = format === 'csv' ? 'csv' : 'xlsx';
    const bookType = format === 'csv' ? 'csv' : 'xlsx';
    const buf      = XLSX.write(wb, { type: 'buffer', bookType });

    res.setHeader('Content-Disposition', `attachment; filename="MITRA_Analytics_${type}_${new Date().toISOString().slice(0,10)}.${ext}"`);
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Helper — FIX: empty string treated same as missing ────────────────────────
function buildWhere({ state, district, days = 30 }) {
  const conds  = [`recorded_at > NOW() - INTERVAL '${parseInt(days)} days'`];
  const params = [];
  if (state    && state.trim())    { params.push(state.trim());    conds.push(`state    = $${params.length}`); }
  if (district && district.trim()) { params.push(district.trim()); conds.push(`district = $${params.length}`); }
  return { text: 'WHERE ' + conds.join(' AND '), params };
}

router.get('/location', async (req, res) => {
  try {
    const result = await query(`SELECT state, district, COUNT(DISTINCT student_id) as active_users, AVG(session_minutes) as avg_session FROM app_telemetry GROUP BY state, district ORDER BY active_users DESC`);
    res.status(200).json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch location analytics.' }); }
});

router.get('/classroom', async (req, res) => {
  try {
    const result = await query(`SELECT class_grade, subject, AVG(session_minutes) as avg_session, COUNT(DISTINCT student_id) as total_students FROM app_telemetry GROUP BY class_grade, subject ORDER BY class_grade, subject`);
    res.status(200).json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch classroom analytics.' }); }
});

router.get('/predictive', async (req, res) => {
  try {
    const result = await query(`SELECT topic_id, SUM(CASE WHEN dropped_off THEN 1 ELSE 0 END) as drop_offs, AVG(session_minutes) as time_spent FROM app_telemetry GROUP BY topic_id ORDER BY drop_offs DESC LIMIT 10`);
    res.status(200).json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch predictive analytics.' }); }
});


// GET Master Telemetry Summary (Across all states)
router.get('/telemetry/summary', async (req, res) => {
  try {
    const { state, subject } = req.query;
    const conds = ['1=1'];
    const params = [];

    if (state   && state.trim())   { params.push(state.trim());   conds.push(`t.state = $${params.length}`); }
    if (subject && subject.trim()) { params.push(subject.trim()); conds.push(`t.subject = $${params.length}`); }

    const result = await query(`
      SELECT
        s.name AS region,
        s.code AS state,
        COALESCE(t.district, 'All') AS district,
        COUNT(DISTINCT t.student_id) AS users,
        ROUND(AVG(t.session_minutes) * 60) AS avg_module_seconds,
        ROUND((1.0 - AVG(CASE WHEN t.completed THEN 1.0 ELSE 0.0 END)) * 100, 1) AS drop,
        ROUND(AVG(CASE WHEN t.offline_session THEN 1.0 ELSE 0.0 END) * 100, 1) AS offline,
        MODE() WITHIN GROUP (ORDER BY t.subject) AS subject
      FROM app_telemetry t
      JOIN india_states s ON s.code = t.state
      WHERE ${conds.join(' AND ')}
      GROUP BY s.name, s.code, t.district ORDER BY users DESC
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Telemetry summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch telemetry data' });
  }
});


module.exports = router;
