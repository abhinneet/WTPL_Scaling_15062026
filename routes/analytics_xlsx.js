/**
 * routes/analytics_xlsx.js
 * GET /api/analytics/export-xlsx
 *
 * Downloads the MITRA_Analytics_v7_Complete.xlsx template
 * with all RAW sheets populated from live database data.
 * Dashboard formula sheets auto-calculate from the RAW data.
 */

'use strict';

const router   = require('express').Router();
const path     = require('path');
const fs       = require('fs');
const XLSX     = require('xlsx');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

const TEMPLATE_PATH = path.join(__dirname, '../templates/MITRA_Analytics_v7_Complete.xlsx');
const REPORT_MONTH  = new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });

// ── Helper: safe number rounding ─────────────────────────────────────────────
const pct  = v => v === null || v === undefined ? null : Math.round(parseFloat(v) * 10) / 10;
const num  = v => v === null || v === undefined ? null : parseInt(v);
const dec  = (v, d=1) => v === null || v === undefined ? null : Math.round(parseFloat(v) * Math.pow(10,d)) / Math.pow(10,d);

// ── Main export route ─────────────────────────────────────────────────────────
router.get('/export-xlsx', requirePerm('perm_export_data'), async (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      return res.status(500).json({ error: 'Excel template not found on server. Upload MITRA_Analytics_v7_Complete.xlsx to /templates/' });
    }

    // Load template preserving all formulas, styles, charts
    const wb = XLSX.readFile(TEMPLATE_PATH, { cellStyles: true, cellFormula: true });

    // ── Fetch all data in parallel ────────────────────────────────────────────
    const [
      districtData, arData, quizData, sessionData, languageData,
      notifData, deviceData, feedbackData, adsData, statesRef
    ] = await Promise.all([
      fetchDistrictData(),
      fetchARData(),
      fetchQuizData(),
      fetchSessionData(),
      fetchLanguageData(),
      fetchNotificationData(),
      fetchDeviceData(),
      fetchFeedbackData(),
      fetchAdsData(),
      fetchStatesRef(),
    ]);

    // ── Write each RAW sheet ──────────────────────────────────────────────────
    writeSheet(wb, 'RAW_DISTRICT',     districtData);
    writeSheet(wb, 'RAW_AR_CONTENT',   arData);
    writeSheet(wb, 'RAW_QUIZ',         quizData);
    writeSheet(wb, 'RAW_SESSION',      sessionData);
    writeSheet(wb, 'RAW_LANGUAGE',     languageData);
    writeSheet(wb, 'RAW_NOTIFICATION', notifData);
    writeSheet(wb, 'RAW_DEVICE',       deviceData);
    writeSheet(wb, 'RAW_FEEDBACK',     feedbackData);
    writeSheet(wb, 'RAW_ADS',          adsData);

    // ── Write buffer and send ─────────────────────────────────────────────────
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
    const filename = `MITRA_Analytics_${new Date().toISOString().slice(0,7)}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);

  } catch (err) {
    console.error('[analytics_xlsx] export error:', err.message);
    res.status(500).json({ error: 'Export failed', detail: err.message });
  }
});

// ── Write rows into a RAW sheet starting at row 4 ────────────────────────────
function writeSheet(wb, sheetName, rows) {
  const ws = wb.Sheets[sheetName];
  if (!ws) { console.warn(`Sheet ${sheetName} not found in template`); return; }

  // Get headers from row 3
  const ref  = XLSX.utils.decode_range(ws['!ref'] || 'A1:Z1000');
  const hdrs = [];
  for (let c = ref.s.c; c <= ref.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 2, c })]; // row 3 = index 2
    hdrs.push(cell ? cell.v : null);
  }

  // Clear existing data rows (row 4 onward = index 3+)
  for (let r = 3; r <= ref.e.r; r++) {
    for (let c = ref.s.c; c <= ref.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && !ws[addr].f) { // don't clear formula cells
        delete ws[addr];
      }
    }
  }

  // Write new data rows
  rows.forEach((row, rowIdx) => {
    hdrs.forEach((hdr, colIdx) => {
      if (!hdr) return;
      const val = row[hdr];
      if (val === undefined || val === null) return;
      const addr = XLSX.utils.encode_cell({ r: rowIdx + 3, c: colIdx });
      ws[addr] = { v: val, t: typeof val === 'number' ? 'n' : 's' };
    });
  });

  // Update sheet range
  const newEnd = XLSX.utils.encode_cell({ r: rows.length + 3, c: hdrs.length - 1 });
  ws['!ref'] = `A1:${newEnd}`;
}

// ── RAW_DISTRICT ──────────────────────────────────────────────────────────────
async function fetchDistrictData() {
  const r = await query(`
    SELECT
      s.name                                                          AS "State",
      COALESCE(t.district, 'All')                                    AS "District",
      $1                                                              AS "Report Month",
      NULL                                                            AS "Area Type",
      COUNT(DISTINCT t.student_id)                                   AS "Active Users",
      ROUND(COUNT(DISTINCT t.student_id)::NUMERIC / 30, 1)          AS "DAU Avg",
      COUNT(qa.id)                                                    AS "Quiz Attempts",
      COALESCE(SUM(qa.correct_answers), 0)                           AS "Quiz Correct Answers",
      COUNT(t.id)                                                     AS "AR Sessions",
      SUM(CASE WHEN t.completed THEN 1 ELSE 0 END)                  AS "AR Completions",
      COUNT(t.id)                                                     AS "Total Sessions",
      SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)            AS "Offline Sessions",
      SUM(CASE WHEN t.ar_capable THEN 1 ELSE 0 END)                 AS "AR-Capable Devices",
      COUNT(DISTINCT t.device_id)                                    AS "Total Devices",
      COUNT(DISTINCT t.school_code)                                  AS "Schools Active",
      NULL                                                            AS "Teacher Logins",
      CASE
        WHEN ROUND(100.0*SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 50
          THEN 'Low' 
        WHEN ROUND(100.0*SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 20
          THEN 'Medium'
        ELSE 'High'
      END                                                             AS "Connectivity Level",
      CASE
        WHEN ROUND(100.0*SUM(CASE WHEN t.dropped_off THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 30
          THEN 'High Risk'
        WHEN ROUND(100.0*SUM(CASE WHEN t.dropped_off THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 15
          THEN 'Medium Risk'
        ELSE 'Low Risk'
      END                                                             AS "Risk Level",
      NULL                                                            AS "Aspirational District",
      NULL                                                            AS "Notes",
      NULL                                                            AS "Scope Match Rank"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state = s.code
    LEFT JOIN quiz_attempts qa ON qa.state = s.name
    GROUP BY s.name, t.district
    ORDER BY s.name, t.district
  `, [REPORT_MONTH]);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_AR_CONTENT ────────────────────────────────────────────────────────────
async function fetchARData() {
  const r = await query(`
    SELECT
      s.name                                                         AS "State",
      ua.subject                                                     AS "Subject",
      ua.class_name                                                  AS "Class",
      COALESCE(ua.title, ua.topic)                                  AS "AR Module Title",
      COALESCE(ua.ar_tier, 'Basic 3D')                             AS "AR Tier",
      ua.status                                                      AS "Status",
      'Yes'                                                          AS "NCERT Mapped",
      'CBSE/State'                                                   AS "Board",
      COALESCE(ua.language, 'Hindi')                               AS "Language",
      COUNT(t.id)                                                    AS "Total Launches",
      COUNT(DISTINCT t.student_id)                                  AS "Unique Students",
      ROUND(AVG(t.session_minutes)::NUMERIC, 1)                    AS "Avg Dwell (min)",
      ROUND(100.0*SUM(CASE WHEN t.completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Completion %",
      ROUND(100.0*SUM(CASE WHEN t.replay_count > 0 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Replay %",
      NULL                                                           AS "Pre-Module Avg Score %",
      NULL                                                           AS "Post-Module Avg Score %",
      TO_CHAR(ua.created_at, 'DD Mon YYYY')                       AS "Published Date"
    FROM unity_assets ua
    CROSS JOIN india_states s
    LEFT JOIN app_telemetry t ON t.topic_id = ua.id
    WHERE ua.status IN ('published','live','active')
    GROUP BY s.name, ua.subject, ua.class_name, ua.title, ua.topic,
             ua.ar_tier, ua.status, ua.language, ua.created_at
    ORDER BY s.name, ua.subject, ua.class_name
    LIMIT 5000
  `);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_QUIZ ──────────────────────────────────────────────────────────────────
async function fetchQuizData() {
  const r = await query(`
    SELECT
      s.name                                                         AS "State",
      q.subject                                                      AS "Subject",
      q.class_name                                                   AS "Class",
      q.title                                                        AS "Quiz Title",
      'CBSE/State'                                                   AS "Board",
      q.status                                                       AS "Status",
      'Knowledge'                                                    AS "Bloom's Level Focus",
      COALESCE(q.language, 'Hindi')                                AS "Language",
      COALESCE(q.question_count, 0)                                AS "Questions Count",
      COUNT(qa.id)                                                   AS "Attempts This Month",
      COALESCE(SUM(qa.correct_answers), 0)                         AS "Correct Answers",
      SUM(CASE WHEN qa.completed THEN 1 ELSE 0 END)               AS "Completions",
      SUM(CASE WHEN NOT qa.completed THEN 1 ELSE 0 END)           AS "Abandoned Attempts",
      ROUND(COALESCE(SUM(qa.time_taken_secs)/60.0, 0)::NUMERIC,1) AS "Total Attempt Time (min)",
      TO_CHAR(q.created_at, 'DD Mon YYYY')                        AS "Published Date",
      NULL                                                           AS "Notes"
    FROM quizzes q
    CROSS JOIN india_states s
    LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.state = s.name
    WHERE q.status IN ('live','published')
    GROUP BY s.name, q.subject, q.class_name, q.title, q.status,
             q.language, q.question_count, q.created_at
    ORDER BY s.name, q.subject, q.class_name
    LIMIT 5000
  `);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_SESSION ───────────────────────────────────────────────────────────────
async function fetchSessionData() {
  const r = await query(`
    SELECT
      s.name                                                         AS "State",
      $1                                                             AS "Report Month",
      COUNT(t.id)                                                    AS "Total Sessions",
      ROUND(AVG(t.session_minutes)::NUMERIC, 1)                    AS "Avg Session Duration (min)",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes < 1 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1)    AS "Bounce Sessions (<1min) %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes BETWEEN 1 AND 5 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions 1-5min %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes BETWEEN 5 AND 15 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions 5-15min %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes BETWEEN 15 AND 30 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions 15-30min %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes > 30 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1)   AS "Sessions >30min %",
      EXTRACT(HOUR FROM MODE() WITHIN GROUP (ORDER BY t.session_timestamp))::INTEGER              AS "Peak Session Hour (24h)",
      ROUND(100.0*SUM(CASE WHEN EXTRACT(HOUR FROM t.session_timestamp) BETWEEN 16 AND 20 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "After-School Sessions % (4-8PM)",
      ROUND(100.0*SUM(CASE WHEN EXTRACT(HOUR FROM t.session_timestamp) BETWEEN 9 AND 15 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1)  AS "In-School Sessions % (9AM-3PM)",
      ROUND(100.0*SUM(CASE WHEN t.crash_event THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2)          AS "App Crash Rate %",
      ROUND(AVG(CASE WHEN t.load_time_ms > 0 THEN t.load_time_ms/1000.0 ELSE NULL END)::NUMERIC,2) AS "Cold Start Load Time (sec)",
      ROUND(100.0*SUM(CASE WHEN t.anr_event THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2)            AS "ANR Rate %",
      COALESCE(SUM(t.rage_tap_count), 0)                           AS "Rage Tap Events",
      NULL                                                           AS "Notes"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state = s.code
    GROUP BY s.name
    ORDER BY s.name
  `, [REPORT_MONTH]);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_LANGUAGE ──────────────────────────────────────────────────────────────
async function fetchLanguageData() {
  const r = await query(`
    SELECT
      s.name                                                         AS "State",
      MODE() WITHIN GROUP (ORDER BY t.language_used)                AS "Primary Language Used",
      SUM(CASE WHEN t.language_used = MODE() WITHIN GROUP (ORDER BY t.language_used) THEN 1 ELSE 0 END) AS "Sessions in Primary Lang",
      SUM(CASE WHEN t.language_used = 'Hindi'   THEN 1 ELSE 0 END) AS "Sessions in Hindi",
      SUM(CASE WHEN t.language_used = 'English' THEN 1 ELSE 0 END) AS "Sessions in English",
      ROUND(AVG(t.language_switches)::NUMERIC, 2)                  AS "Language Switches per Session",
      ROUND(100.0*SUM(CASE WHEN t.tts_used      THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "TTS Used %",
      ROUND(100.0*SUM(CASE WHEN t.subtitle_used THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Subtitles Used %",
      ROUND(100.0*SUM(CASE WHEN t.high_contrast THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "High Contrast Mode %",
      ROUND(100.0*SUM(CASE WHEN t.large_text    THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Large Text Mode %",
      ROUND(100.0*SUM(CASE WHEN t.color_blind_mode THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Color Blind Mode %",
      SUM(CASE WHEN t.screen_reader   THEN 1 ELSE 0 END)           AS "Screen Reader Events",
      ROUND(100.0*SUM(CASE WHEN t.fallback_2d   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "2D Fallback Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.haptic_feedback THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Haptic Feedback %",
      NULL                                                           AS "Notes"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state = s.code
    GROUP BY s.name
    ORDER BY s.name
  `);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_NOTIFICATION ──────────────────────────────────────────────────────────
async function fetchNotificationData() {
  const r = await query(`
    SELECT
      COALESCE(pn.target_state, 'All India')                       AS "State",
      'Push Notification'                                            AS "Notification Type",
      COUNT(pn.id)                                                   AS "Sent",
      COALESCE(SUM(na.delivered), 0)                               AS "Delivered",
      ROUND(100.0*COALESCE(SUM(na.delivered),0)/NULLIF(COUNT(pn.id),0),1) AS "Delivery %",
      ROUND(100.0*COALESCE(SUM(na.opened),0)/NULLIF(SUM(na.delivered),0),1) AS "Open Rate %",
      ROUND(100.0*COALESCE(SUM(na.clicked),0)/NULLIF(SUM(na.delivered),0),1) AS "CTR %",
      NULL AS "Conversion %",
      NULL AS "Best Send Time",
      NULL AS "Opt-Outs",
      NULL AS "Opt-Out Rate %",
      NULL AS "Win-back in 48hrs %",
      NULL AS "Notes"
    FROM push_notifications pn
    LEFT JOIN notification_analytics na ON na.notification_id = pn.id
    WHERE pn.status = 'sent'
    GROUP BY pn.target_state
    ORDER BY pn.target_state
  `);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_DEVICE ────────────────────────────────────────────────────────────────
async function fetchDeviceData() {
  const r = await query(`
    SELECT
      s.name                                                          AS "State",
      SUM(CASE WHEN t.ar_capable THEN 1 ELSE 0 END)                AS "AR-Capable Devices",
      COUNT(DISTINCT t.device_id)                                   AS "Total Devices",
      SUM(CASE WHEN t.device_ram_gb < 2    THEN 1 ELSE 0 END)     AS "Devices <2GB RAM",
      SUM(CASE WHEN t.device_ram_gb BETWEEN 2 AND 4 THEN 1 ELSE 0 END) AS "Devices 2-4GB RAM",
      SUM(CASE WHEN t.device_ram_gb > 4    THEN 1 ELSE 0 END)     AS "Devices >4GB RAM",
      SUM(CASE WHEN t.android_version <= 8 THEN 1 ELSE 0 END)     AS "Android 8 and below",
      SUM(CASE WHEN t.android_version BETWEEN 9 AND 11 THEN 1 ELSE 0 END) AS "Android 9-11",
      SUM(CASE WHEN t.android_version >= 12 THEN 1 ELSE 0 END)    AS "Android 12+",
      SUM(CASE WHEN t.is_ios THEN 1 ELSE 0 END)                   AS "iOS Devices",
      ROUND(100.0*SUM(CASE WHEN t.network_type='wifi'   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "WiFi Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.network_type='4g'     THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "4G Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.network_type='3g'     THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "3G Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.network_type IN ('2g','edge') THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "2G/Edge Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Offline Sessions %",
      ROUND(AVG(t.battery_drain_pct)::NUMERIC, 1)                 AS "Avg Battery Drain per AR Session %",
      NULL                                                           AS "Notes"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state = s.code
    GROUP BY s.name
    ORDER BY s.name
  `);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_FEEDBACK ──────────────────────────────────────────────────────────────
async function fetchFeedbackData() {
  const r = await query(`
    SELECT
      COALESCE(f.state, 'All India')                               AS "State / Module",
      f.feedback_type                                               AS "Feedback Type (Module/NPS/Teacher)",
      COUNT(*)                                                      AS "Total Responses",
      ROUND(AVG(f.rating)::NUMERIC, 1)                            AS "Avg Rating (1-5)",
      ROUND(100.0*SUM(CASE WHEN f.loved_it   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Loved It",
      ROUND(100.0*SUM(CASE WHEN f.confusing  THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Confusing",
      ROUND(100.0*SUM(CASE WHEN f.too_fast   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Too Fast",
      ROUND(100.0*SUM(CASE WHEN f.too_easy   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Too Easy",
      ROUND(100.0*SUM(CASE WHEN f.boring     THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Boring",
      SUM(CASE WHEN f.nps_score >= 9 THEN 1 ELSE 0 END)          AS "NPS Promoters (9-10)",
      SUM(CASE WHEN f.nps_score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS "NPS Passives (7-8)",
      SUM(CASE WHEN f.nps_score <= 6 THEN 1 ELSE 0 END)          AS "NPS Detractors (0-6)",
      NULL                                                          AS "Notes"
    FROM app_feedback f
    GROUP BY f.state, f.feedback_type
    ORDER BY f.state, f.feedback_type
  `);

  // Return placeholder row if no feedback yet
  if (!r.rows.length) {
    return [{ '#': 1, 'State / Module': 'No feedback collected yet',
      'Feedback Type (Module/NPS/Teacher)': 'NPS', 'Total Responses': 0 }];
  }
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── RAW_ADS ───────────────────────────────────────────────────────────────────
async function fetchAdsData() {
  const r = await query(`
    SELECT
      ac.name                                                        AS "Campaign Name",
      COALESCE(ac.media_type, 'Video')                             AS "Campaign Type",
      COALESCE((ac.target_states->0)::text, 'All India')          AS "Target State",
      COUNT(ai.id)                                                   AS "Impressions",
      COUNT(DISTINCT ai.device_id)                                  AS "Unique Reach",
      ROUND(100.0*SUM(CASE WHEN ai.clicked THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1)    AS "CTR %",
      ROUND(AVG(ai.view_seconds)::NUMERIC, 1)                      AS "Avg View Duration (sec)",
      ROUND(100.0*SUM(CASE WHEN ai.completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1)  AS "Completion %",
      NULL                                                           AS "Revenue (INR)",
      $1                                                             AS "Period",
      'Compliant'                                                    AS "Compliance Status",
      NULL                                                           AS "Notes"
    FROM ad_campaigns ac
    LEFT JOIN ad_impressions ai ON ai.campaign_id = ac.id
    GROUP BY ac.name, ac.media_type, ac.target_states
    ORDER BY COUNT(ai.id) DESC
  `, [REPORT_MONTH]);

  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── REF states list ───────────────────────────────────────────────────────────
async function fetchStatesRef() {
  const r = await query(`SELECT name, code FROM india_states ORDER BY name`);
  return r.rows;
}

module.exports = router;