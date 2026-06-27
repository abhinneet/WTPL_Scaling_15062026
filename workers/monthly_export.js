/**
 * workers/monthly_export.js
 * 
 * Generates the MITRA Analytics workbook from live DB data
 * and saves it to GCS: exports/MITRA_Analytics_YYYY-MM.xlsx
 *
 * Runs as a Cloud Run Job triggered by Cloud Scheduler.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { Storage } = require('@google-cloud/storage');

// ── Structured Logger ────────────────────────────────────────────────────────
const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), msg, ...data })),
  error: (msg, data = {}) => console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), msg, ...data })),
  warn: (msg, data = {}) => console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), msg, ...data }))
};

// ── Configuration & Constants ────────────────────────────────────────────────
const BUCKET = process.env.STORAGE_BUCKET;
const TEMPLATE_PATH = path.join(__dirname, '../templates/MITRA_Analytics_v7_Complete.xlsx');

// Fail fast if critical config is missing
if (!BUCKET) {
  logger.error('FATAL: STORAGE_BUCKET environment variable is not set.');
  process.exit(1);
}
if (!fs.existsSync(TEMPLATE_PATH)) {
  logger.error(`FATAL: Template not found at ${TEMPLATE_PATH}`);
  process.exit(1);
}

const DB_CONFIG = {
  // Cloud Run connects via Unix socket through Cloud SQL Proxy
  // DB_HOST is not set — use socket path instead
  host: process.env.DB_HOST || undefined,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Cloud SQL Proxy handles SSL — do not enable ssl here
  ssl: false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// If running on Cloud Run, override with Unix socket
if (process.env.CLOUD_SQL_INSTANCE) {
  DB_CONFIG.host = `/cloudsql/${process.env.CLOUD_SQL_INSTANCE}`;
  DB_CONFIG.port = undefined;
}

const pool = new Pool(DB_CONFIG);
const storage = new Storage();
const bucket = storage.bucket(BUCKET);

// ── Date Calculation (Strict UTC to prevent timezone shifts) ─────────────────
const now = new Date();
const exportDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

const YEAR = exportDate.getUTCFullYear();
const MONTH = exportDate.getUTCMonth() + 1; // 1-12
const MONTH_STR = exportDate.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const MONTH_START = `${YEAR}-${String(MONTH).padStart(2, '0')}-01`;
const MONTH_END = new Date(Date.UTC(YEAR, exportDate.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
const GCS_KEY = `exports/MITRA_Analytics_${YEAR}-${String(MONTH).padStart(2, '0')}.xlsx`;

const q = (sql, params) => pool.query(sql, params);

// ── Graceful Shutdown Handler ────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    await pool.end();
    logger.info('Database pool closed.');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Main Logic ───────────────────────────────────────────────────────────────
async function main() {
  logger.info('Starting export', { month: MONTH_STR, range: `${MONTH_START} to ${MONTH_END}` });

  const wb = XLSX.readFile(TEMPLATE_PATH, { cellStyles: true, cellFormula: true });

  // Fetch and write all RAW sheets in parallel
  const [
    district, ar, quiz, session, language, notif, device, feedback, ads
  ] = await Promise.all([
    fetchDistrict(), fetchAR(), fetchQuiz(), fetchSession(),
    fetchLanguage(), fetchNotification(), fetchDevice(),
    fetchFeedback(), fetchAds(),
  ]);

  writeSheet(wb, 'RAW_DISTRICT', district);
  writeSheet(wb, 'RAW_AR_CONTENT', ar);
  writeSheet(wb, 'RAW_QUIZ', quiz);
  writeSheet(wb, 'RAW_SESSION', session);
  writeSheet(wb, 'RAW_LANGUAGE', language);
  writeSheet(wb, 'RAW_NOTIFICATION', notif);
  writeSheet(wb, 'RAW_DEVICE', device);
  writeSheet(wb, 'RAW_FEEDBACK', feedback);
  writeSheet(wb, 'RAW_ADS', ads);

  // Write to buffer
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

  // Save to GCS
  const file = bucket.file(GCS_KEY);
  await file.save(buf, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    metadata: {
      contentDisposition: `attachment; filename="MITRA_Analytics_${YEAR}-${String(MONTH).padStart(2, '0')}.xlsx"`,
      month: MONTH_STR,
      generatedAt: new Date().toISOString(),
    },
    resumable: true // Helps prevent failures on large files or spotty networks
  });

  logger.info('File uploaded to GCS', { bucket: BUCKET, key: GCS_KEY, sizeKb: (buf.length / 1024).toFixed(1) });

  // Generate Signed URL (Don't fail the job if URL generation hiccups)
  try {
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    logger.info('Signed URL generated', { url });
  } catch (urlErr) {
    logger.error('Failed to generate signed URL', { error: urlErr.message });
  }
}

// ── Write rows into RAW sheet at row 4 ───────────────────────────────────────
function writeSheet(wb, sheetName, rows) {
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    logger.warn(`Sheet not found in workbook`, { sheetName });
    return;
  }

  const ref = XLSX.utils.decode_range(ws['!ref'] || 'A1:Z1000');
  const hdrs = [];
  for (let c = ref.s.c; c <= ref.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 2, c })]; // Row 3 (0-indexed 2)
    hdrs.push(cell ? cell.v : null);
  }

  // Clear existing data rows (from row 4 / index 3 onwards)
  for (let r = 3; r <= ref.e.r; r++) {
    for (let c = ref.s.c; c <= ref.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && !ws[addr].f) { // Preserve formulas
        delete ws[addr];
      }
    }
  }

  // Write new rows
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
  const newEndRow = rows.length > 0 ? rows.length + 2 : 2; 
  const newEnd = XLSX.utils.encode_cell({ r: newEndRow, c: hdrs.length - 1 });
  ws['!ref'] = `A1:${newEnd}`;
  
  logger.info(`Sheet processed`, { sheet: sheetName, rows: rows.length });
}

// ── Data Fetch Functions ─────────────────────────────────────────────────────

async function fetchDistrict() {
  const r = await q(`
    SELECT s.name AS "State",
      'All'                                                          AS "District",
      $1                                                             AS "Report Month",
      NULL AS "Area Type",
      COUNT(DISTINCT t.student_id)                                   AS "Active Users",
      ROUND(COUNT(DISTINCT t.student_id)::NUMERIC/30,1)             AS "DAU Avg",
      COUNT(qa.id)                                                   AS "Quiz Attempts",
      COALESCE(SUM(qa.correct_answers),0)                           AS "Quiz Correct Answers",
      COUNT(t.id)                                                    AS "AR Sessions",
      SUM(CASE WHEN t.completed THEN 1 ELSE 0 END)                 AS "AR Completions",
      COUNT(t.id)                                                    AS "Total Sessions",
      SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)           AS "Offline Sessions",
      SUM(CASE WHEN t.ar_capable THEN 1 ELSE 0 END)                AS "AR-Capable Devices",
      COUNT(DISTINCT t.device_id)                                   AS "Total Devices",
      COUNT(DISTINCT t.school_code)                                 AS "Schools Active",
      NULL AS "Teacher Logins",
      CASE WHEN ROUND(100.0*SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 50 THEN 'Low'
           WHEN ROUND(100.0*SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 20 THEN 'Medium'
           ELSE 'High' END                                           AS "Connectivity Level",
      CASE WHEN ROUND(100.0*SUM(CASE WHEN t.dropped_off THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 30 THEN 'High Risk'
           WHEN ROUND(100.0*SUM(CASE WHEN t.dropped_off THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),0) > 15 THEN 'Medium Risk'
           ELSE 'Low Risk' END                                       AS "Risk Level",
      NULL AS "Aspirational District", NULL AS "Notes", NULL AS "Scope Match Rank"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state_code = s.code
      AND t.session_timestamp >= $2 AND t.session_timestamp < $3
    LEFT JOIN quiz_attempts qa ON qa.state = s.name
      AND qa.attempted_at >= $2 AND qa.attempted_at < $3
    GROUP BY s.name ORDER BY s.name
  `, [MONTH_STR, MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchAR() {
  const r = await q(`
    SELECT s.name AS "State",
      ua.subject AS "Subject", ua.class_name AS "Class",
      COALESCE(ua.title, ua.topic) AS "AR Module Title",
      COALESCE(ua.ar_tier,'Basic 3D') AS "AR Tier",
      ua.status AS "Status", 'Yes' AS "NCERT Mapped", 'CBSE/State' AS "Board",
      COALESCE(ua.language,'Hindi') AS "Language",
      COUNT(t.id) AS "Total Launches",
      COUNT(DISTINCT t.student_id) AS "Unique Students",
      ROUND(AVG(t.session_minutes)::NUMERIC,1) AS "Avg Dwell (min)",
      ROUND(100.0*SUM(CASE WHEN t.completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Completion %",
      ROUND(100.0*SUM(CASE WHEN t.replay_count>0 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Replay %",
      NULL AS "Pre-Module Avg Score %", NULL AS "Post-Module Avg Score %",
      TO_CHAR(ua.created_at,'DD Mon YYYY') AS "Published Date"
    FROM unity_assets ua CROSS JOIN india_states s
    LEFT JOIN app_telemetry t ON t.topic_id = ua.id::text
      AND t.session_timestamp >= $1 AND t.session_timestamp < $2
    WHERE ua.status IN ('published','live','active')
    GROUP BY s.name,ua.subject,ua.class_name,ua.title,ua.topic,ua.ar_tier,ua.status,ua.language,ua.created_at
    ORDER BY s.name,ua.subject LIMIT 5000
  `, [MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchQuiz() {
  const r = await q(`
    SELECT s.name AS "State", q.subject AS "Subject", q.class_name AS "Class",
      q.title AS "Quiz Title", 'CBSE/State' AS "Board", q.status AS "Status",
      'Knowledge' AS "Bloom's Level Focus",
      COALESCE(q.language,'Hindi') AS "Language",
      COALESCE(q.question_count,0) AS "Questions Count",
      COUNT(qa.id) AS "Attempts This Month",
      COALESCE(SUM(qa.correct_answers),0) AS "Correct Answers",
      SUM(CASE WHEN qa.completed THEN 1 ELSE 0 END) AS "Completions",
      SUM(CASE WHEN NOT qa.completed THEN 1 ELSE 0 END) AS "Abandoned Attempts",
      ROUND(COALESCE(SUM(qa.time_taken_secs)/60.0,0)::NUMERIC,1) AS "Total Attempt Time (min)",
      TO_CHAR(q.created_at,'DD Mon YYYY') AS "Published Date", NULL AS "Notes"
    FROM quizzes q CROSS JOIN india_states s
    LEFT JOIN quiz_attempts qa ON qa.quiz_id=q.id AND qa.state=s.name
      AND qa.attempted_at >= $1 AND qa.attempted_at < $2
    WHERE q.status IN ('live','published')
    GROUP BY s.name,q.subject,q.class_name,q.title,q.status,q.language,q.question_count,q.created_at
    ORDER BY s.name,q.subject LIMIT 5000
  `, [MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchSession() {
  const r = await q(`
    SELECT s.name AS "State", $1 AS "Report Month",
      COUNT(t.id) AS "Total Sessions",
      ROUND(AVG(t.session_minutes)::NUMERIC,1) AS "Avg Session Duration (min)",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes<1 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Bounce Sessions (<1min) %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes BETWEEN 1 AND 5 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions 1-5min %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes BETWEEN 5 AND 15 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions 5-15min %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes BETWEEN 15 AND 30 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions 15-30min %",
      ROUND(100.0*SUM(CASE WHEN t.session_minutes>30 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Sessions >30min %",
      EXTRACT(HOUR FROM MODE() WITHIN GROUP (ORDER BY t.session_timestamp))::INTEGER AS "Peak Session Hour (24h)",
      ROUND(100.0*SUM(CASE WHEN EXTRACT(HOUR FROM t.session_timestamp) BETWEEN 16 AND 20 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "After-School Sessions % (4-8PM)",
      ROUND(100.0*SUM(CASE WHEN EXTRACT(HOUR FROM t.session_timestamp) BETWEEN 9 AND 15 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "In-School Sessions % (9AM-3PM)",
      ROUND(100.0*SUM(CASE WHEN t.crash_event THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2) AS "App Crash Rate %",
      ROUND(AVG(CASE WHEN t.load_time_ms>0 THEN t.load_time_ms/1000.0 ELSE NULL END)::NUMERIC,2) AS "Cold Start Load Time (sec)",
      ROUND(100.0*SUM(CASE WHEN t.anr_event THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),2) AS "ANR Rate %",
      COALESCE(SUM(t.rage_tap_count),0) AS "Rage Tap Events", NULL AS "Notes"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state_code=s.code
      AND t.session_timestamp >= $2 AND t.session_timestamp < $3
    GROUP BY s.name ORDER BY s.name
  `, [MONTH_STR, MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchLanguage() {
  const r = await q(`
    SELECT s.name AS "State",
      COALESCE(MODE() WITHIN GROUP (ORDER BY t.language_used), 'Unknown') AS "Primary Language Used",
      COUNT(*) FILTER (WHERE t.language_used = (
        SELECT MODE() WITHIN GROUP (ORDER BY t2.language_used)
        FROM app_telemetry t2 WHERE t2.state_code = s.code
      )) AS "Sessions in Primary Lang",
      SUM(CASE WHEN t.language_used='Hindi'   THEN 1 ELSE 0 END) AS "Sessions in Hindi",
      SUM(CASE WHEN t.language_used='English' THEN 1 ELSE 0 END) AS "Sessions in English",
      ROUND(AVG(t.language_switches)::NUMERIC,2) AS "Language Switches per Session",
      ROUND(100.0*SUM(CASE WHEN t.tts_used      THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "TTS Used %",
      ROUND(100.0*SUM(CASE WHEN t.subtitle_used THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Subtitles Used %",
      ROUND(100.0*SUM(CASE WHEN t.high_contrast THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "High Contrast Mode %",
      ROUND(100.0*SUM(CASE WHEN t.large_text    THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Large Text Mode %",
      ROUND(100.0*SUM(CASE WHEN t.color_blind_mode THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Color Blind Mode %",
      SUM(CASE WHEN t.screen_reader THEN 1 ELSE 0 END) AS "Screen Reader Events",
      ROUND(100.0*SUM(CASE WHEN t.fallback_2d THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "2D Fallback Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.haptic_feedback THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Haptic Feedback %",
      NULL AS "Notes"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state_code=s.code
      AND t.session_timestamp >= $1 AND t.session_timestamp < $2
    GROUP BY s.name ORDER BY s.name
  `, [MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchNotification() {
  const r = await q(`
    SELECT COALESCE(pn.target_state,'All India') AS "State",
      'Push Notification' AS "Notification Type",
      COUNT(pn.id) AS "Sent",
      COALESCE(SUM(na.delivered),0) AS "Delivered",
      ROUND(100.0*COALESCE(SUM(na.delivered),0)/NULLIF(COUNT(pn.id),0),1) AS "Delivery %",
      ROUND(100.0*COALESCE(SUM(na.opened),0)/NULLIF(SUM(na.delivered),0),1) AS "Open Rate %",
      ROUND(100.0*COALESCE(SUM(na.clicked),0)/NULLIF(SUM(na.delivered),0),1) AS "CTR %",
      NULL AS "Conversion %", NULL AS "Best Send Time",
      NULL AS "Opt-Outs", NULL AS "Opt-Out Rate %",
      NULL AS "Win-back in 48hrs %", NULL AS "Notes"
    FROM push_notifications pn
    LEFT JOIN notification_analytics na ON na.notification_id=pn.id
    WHERE pn.status='sent'
      AND pn.created_at >= $1 AND pn.created_at < $2
    GROUP BY pn.target_state ORDER BY pn.target_state
  `, [MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchDevice() {
  const r = await q(`
    SELECT s.name AS "State",
      SUM(CASE WHEN t.ar_capable THEN 1 ELSE 0 END) AS "AR-Capable Devices",
      COUNT(DISTINCT t.device_id) AS "Total Devices",
      SUM(CASE WHEN t.device_ram_gb<2 THEN 1 ELSE 0 END) AS "Devices <2GB RAM",
      SUM(CASE WHEN t.device_ram_gb BETWEEN 2 AND 4 THEN 1 ELSE 0 END) AS "Devices 2-4GB RAM",
      SUM(CASE WHEN t.device_ram_gb>4 THEN 1 ELSE 0 END) AS "Devices >4GB RAM",
      SUM(CASE WHEN t.android_version<=8 THEN 1 ELSE 0 END) AS "Android 8 and below",
      SUM(CASE WHEN t.android_version BETWEEN 9 AND 11 THEN 1 ELSE 0 END) AS "Android 9-11",
      SUM(CASE WHEN t.android_version>=12 THEN 1 ELSE 0 END) AS "Android 12+",
      SUM(CASE WHEN t.is_ios THEN 1 ELSE 0 END) AS "iOS Devices",
      ROUND(100.0*SUM(CASE WHEN t.network_type='wifi' THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "WiFi Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.network_type='4g'   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "4G Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.network_type='3g'   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "3G Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.network_type IN ('2g','edge') THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "2G/Edge Sessions %",
      ROUND(100.0*SUM(CASE WHEN t.offline_session THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Offline Sessions %",
      ROUND(AVG(t.battery_drain_pct)::NUMERIC,1) AS "Avg Battery Drain per AR Session %",
      NULL AS "Notes"
    FROM india_states s
    LEFT JOIN app_telemetry t ON t.state_code=s.code
      AND t.session_timestamp >= $1 AND t.session_timestamp < $2
    GROUP BY s.name ORDER BY s.name
  `, [MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchFeedback() {
  const r = await q(`
    SELECT COALESCE(f.state,'All India') AS "State / Module",
      f.feedback_type AS "Feedback Type (Module/NPS/Teacher)",
      COUNT(*) AS "Total Responses",
      ROUND(AVG(f.rating)::NUMERIC,1) AS "Avg Rating (1-5)",
      ROUND(100.0*SUM(CASE WHEN f.loved_it   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Loved It",
      ROUND(100.0*SUM(CASE WHEN f.confusing  THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Confusing",
      ROUND(100.0*SUM(CASE WHEN f.too_fast   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Too Fast",
      ROUND(100.0*SUM(CASE WHEN f.too_easy   THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Too Easy",
      ROUND(100.0*SUM(CASE WHEN f.boring     THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "% Boring",
      SUM(CASE WHEN f.nps_score>=9 THEN 1 ELSE 0 END) AS "NPS Promoters (9-10)",
      SUM(CASE WHEN f.nps_score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS "NPS Passives (7-8)",
      SUM(CASE WHEN f.nps_score<=6 THEN 1 ELSE 0 END) AS "NPS Detractors (0-6)",
      NULL AS "Notes"
    FROM app_feedback f
    WHERE f.created_at >= $1 AND f.created_at < $2
    GROUP BY f.state, f.feedback_type ORDER BY f.state
  `, [MONTH_START, MONTH_END]);
  if (!r.rows.length) return [{ '#': 1, 'State / Module': 'No feedback this month', 'Feedback Type (Module/NPS/Teacher)': 'NPS', 'Total Responses': 0 }];
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

async function fetchAds() {
  const r = await q(`
    SELECT ac.name AS "Campaign Name",
      COALESCE(ac.media_type,'Video') AS "Campaign Type",
      COALESCE((ac.target_states->0)::text,'All India') AS "Target State",
      COUNT(ai.id) AS "Impressions",
      COUNT(DISTINCT ai.device_id) AS "Unique Reach",
      ROUND(100.0*SUM(CASE WHEN ai.clicked THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "CTR %",
      ROUND(AVG(ai.view_seconds)::NUMERIC,1) AS "Avg View Duration (sec)",
      ROUND(100.0*SUM(CASE WHEN ai.completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS "Completion %",
      NULL AS "Revenue (INR)", $1 AS "Period",
      'Compliant' AS "Compliance Status", NULL AS "Notes"
    FROM ad_campaigns ac
    LEFT JOIN ad_impressions ai ON ai.campaign_id=ac.id
      AND ai.created_at >= $2 AND ai.created_at < $3
    GROUP BY ac.name, ac.media_type, ac.target_states
    ORDER BY COUNT(ai.id) DESC
  `, [MONTH_STR, MONTH_START, MONTH_END]);
  return r.rows.map((row, i) => ({ '#': i + 1, ...row }));
}

// ── Execution Wrapper ────────────────────────────────────────────────────────
async function run() {
  try {
    await main();
    logger.info('Export completed successfully.');
  } catch (err) {
    logger.error('Export FAILED', { error: err.message, stack: err.stack });
    process.exitCode = 1; // Ensure Cloud Run Job marks as failed
  } finally {
    await pool.end();
    logger.info('Database pool closed.');
  }
}

run();