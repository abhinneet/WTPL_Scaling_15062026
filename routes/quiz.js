/**
 * routes/quiz.js — Quiz Manager & Publisher
 *
 * GET    /api/quiz                         List all quizzes (master list)
 * POST   /api/quiz                         Create single quiz
 * PUT    /api/quiz/:id                      Update quiz
 * DELETE /api/quiz/:id                      Archive quiz
 * POST   /api/quiz/bulk-upload             Bulk import from XLSX
 * GET    /api/quiz/:id/questions           Get questions for a quiz
 * POST   /api/quiz/:id/questions           Add question to quiz
 * PUT    /api/quiz/:id/questions/:qid      Update question
 * DELETE /api/quiz/:id/questions/:qid      Delete question
 * POST   /api/quiz/:id/publish             Publish immediately
 * POST   /api/quiz/:id/schedule            Schedule for later
 * POST   /api/quiz/:id/pause              Pause live quiz
 * GET    /api/quiz/analytics              Quiz analytics overview
 * GET    /api/quiz/analytics/export       Download quiz analytics XLSX/CSV
 * POST   /api/quiz/attempts              Ingest attempt from student app
 */

const router  = require('express').Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query }       = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');

router.use(authenticate);

// ── File upload config (XLSX) ─────────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, '../uploads/quiz_imports/'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx','.xls','.csv'].includes(ext)) cb(null, true);
    else cb(new Error('Only XLSX, XLS, or CSV files allowed'));
  }
});

// ── List all quizzes (master list) ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      status, class_name, subject, topic, language,
      state, district, page = 1, limit = 50
    } = req.query;

    const conds = [];
    const params = [];

    if (status)     { params.push(status);     conds.push(`q.status = $${params.length}`); }
    if (class_name) { params.push(class_name); conds.push(`q.class_name ILIKE $${params.length}`); }
    if (subject)    { params.push(subject);    conds.push(`q.subject ILIKE $${params.length}`); }
    if (topic)      { params.push(topic);      conds.push(`q.topic ILIKE $${params.length}`); }
    if (language)   { params.push(language);   conds.push(`q.language ILIKE $${params.length}`); }
    if (state)      { params.push(`%"${state}"%`); conds.push(`q.target_states::text ILIKE $${params.length}`); }
    if (district)   { params.push(`%"${district}"%`); conds.push(`q.target_districts::text ILIKE $${params.length}`); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const result = await query(`
      SELECT q.*,
             u.full_name AS created_by_name,
             COUNT(qq.id) AS question_count
      FROM quizzes q
      LEFT JOIN users u ON u.id = q.created_by
      LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
      ${where}
      GROUP BY q.id, u.full_name
      ORDER BY q.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const countResult = await query(
      `SELECT COUNT(*) FROM quizzes q ${where}`,
      params.slice(0, -2)
    );

    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quizzes', detail: err.message });
  }
});

// ── Create single quiz ─────────────────────────────────────────────────────────
router.post('/', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const {
      title, description = '',
      class_name, subject, topic, language,
      class_node_id, subject_node_id, topic_node_id,
      target_states = [], target_districts = [],
      publish_at, expires_at,
      go_live_immediately = false
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });

    const id = uuidv4();
    const status = go_live_immediately ? 'live' : (publish_at ? 'scheduled' : 'draft');
    const effectivePublishAt = go_live_immediately ? new Date() : (publish_at || null);

    const result = await query(`
      INSERT INTO quizzes (
        id, title, description, status,
        class_name, subject, topic, language,
        class_node_id, subject_node_id, topic_node_id,
        target_states, target_districts,
        publish_at, expires_at, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
      id, title, description, status,
      class_name || null, subject || null, topic || null, language || null,
      class_node_id || null, subject_node_id || null, topic_node_id || null,
      target_states, target_districts,
      effectivePublishAt, expires_at || null,
      req.user.id
    ]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create quiz', detail: err.message });
  }
});

// ── Update quiz ────────────────────────────────────────────────────────────────
router.put('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const {
      title, description, class_name, subject, topic, language,
      class_node_id, subject_node_id, topic_node_id,
      target_states, target_districts, publish_at, expires_at, status
    } = req.body;

    const result = await query(`
      UPDATE quizzes SET
        title         = COALESCE($1, title),
        description   = COALESCE($2, description),
        class_name    = COALESCE($3, class_name),
        subject       = COALESCE($4, subject),
        topic         = COALESCE($5, topic),
        language      = COALESCE($6, language),
        class_node_id    = COALESCE($7, class_node_id),
        subject_node_id  = COALESCE($8, subject_node_id),
        topic_node_id    = COALESCE($9, topic_node_id),
        target_states    = COALESCE($10, target_states),
        target_districts = COALESCE($11, target_districts),
        publish_at    = COALESCE($12, publish_at),
        expires_at    = COALESCE($13, expires_at),
        status        = COALESCE($14, status),
        updated_at    = NOW()
      WHERE id = $15
      RETURNING *
    `, [
      title, description, class_name, subject, topic, language,
      class_node_id, subject_node_id, topic_node_id,
      target_states, target_districts,
      publish_at, expires_at, status,
      req.params.id
    ]);

    if (!result.rows.length) return res.status(404).json({ error: 'Quiz not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quiz', detail: err.message });
  }
});

// ── Archive quiz ───────────────────────────────────────────────────────────────
router.delete('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    await query(`UPDATE quizzes SET status='archived', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Quiz archived' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive quiz' });
  }
});

// ── Publish immediately ────────────────────────────────────────────────────────
router.post('/:id/publish', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const result = await query(`
      UPDATE quizzes SET status='live', publish_at=NOW(), updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Quiz not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish quiz' });
  }
});

// ── Schedule quiz ──────────────────────────────────────────────────────────────
router.post('/:id/schedule', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const { publish_at, expires_at } = req.body;
    if (!publish_at) return res.status(400).json({ error: 'publish_at datetime required' });

    const result = await query(`
      UPDATE quizzes SET
        status='scheduled', publish_at=$1,
        expires_at=$2, updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [publish_at, expires_at || null, req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Quiz not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to schedule quiz' });
  }
});

// ── Pause quiz ─────────────────────────────────────────────────────────────────
router.post('/:id/pause', requirePerm('perm_publish_apps'), async (req, res) => {
  try {
    const result = await query(`
      UPDATE quizzes SET status='paused', updated_at=NOW() WHERE id=$1 RETURNING *
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Quiz not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause quiz' });
  }
});

// ── Questions CRUD ─────────────────────────────────────────────────────────────
router.get('/:id/questions', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM quiz_questions WHERE quiz_id=$1 ORDER BY sort_order, created_at
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});

router.post('/:id/questions', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const {
      question_text, option_a, option_b, option_c, option_d,
      correct_answer, correct_display, explanation, difficulty = 'medium',
      marks = 1, class_name, subject, topic, language
    } = req.body;

    if (!question_text || !option_a || !option_b || !option_c || !option_d || !correct_answer) {
      return res.status(400).json({ error: 'question_text, 4 options, and correct_answer required' });
    }
    if (!['A','B','C','D'].includes(correct_answer.toUpperCase())) {
      return res.status(400).json({ error: 'correct_answer must be A, B, C, or D' });
    }

    // Get max sort_order
    const maxOrder = await query(
      'SELECT COALESCE(MAX(sort_order),0) AS max_order FROM quiz_questions WHERE quiz_id=$1',
      [req.params.id]
    );

    const result = await query(`
      INSERT INTO quiz_questions (
        id, quiz_id, sort_order,
        question_text, option_a, option_b, option_c, option_d,
        correct_answer, correct_display, explanation,
        difficulty, marks, class_name, subject, topic, language
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [
      uuidv4(), req.params.id, maxOrder.rows[0].max_order + 1,
      question_text, option_a, option_b, option_c, option_d,
      correct_answer.toUpperCase(), correct_display || null, explanation || null,
      difficulty, marks, class_name || null, subject || null, topic || null, language || null
    ]);

    // Update question count on quiz
    await query(
      'UPDATE quizzes SET question_count=(SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=$1), updated_at=NOW() WHERE id=$1',
      [req.params.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add question', detail: err.message });
  }
});

router.put('/:id/questions/:qid', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const {
      question_text, option_a, option_b, option_c, option_d,
      correct_answer, correct_display, explanation, difficulty, marks
    } = req.body;

    const result = await query(`
      UPDATE quiz_questions SET
        question_text  = COALESCE($1, question_text),
        option_a       = COALESCE($2, option_a),
        option_b       = COALESCE($3, option_b),
        option_c       = COALESCE($4, option_c),
        option_d       = COALESCE($5, option_d),
        correct_answer = COALESCE($6, correct_answer),
        correct_display = COALESCE($7, correct_display),
        explanation    = COALESCE($8, explanation),
        difficulty     = COALESCE($9, difficulty),
        marks          = COALESCE($10, marks)
      WHERE id=$11 AND quiz_id=$12
      RETURNING *
    `, [
      question_text, option_a, option_b, option_c, option_d,
      correct_answer?.toUpperCase(), correct_display, explanation, difficulty, marks,
      req.params.qid, req.params.id
    ]);

    if (!result.rows.length) return res.status(404).json({ error: 'Question not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update question' });
  }
});

router.delete('/:id/questions/:qid', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    await query('DELETE FROM quiz_questions WHERE id=$1 AND quiz_id=$2', [req.params.qid, req.params.id]);
    await query(
      'UPDATE quizzes SET question_count=(SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=$1) WHERE id=$1',
      [req.params.id]
    );
    res.json({ message: 'Question deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// ── Bulk upload from XLSX ──────────────────────────────────────────────────────
/**
 * Expected XLSX columns (row 1 = headers, case-insensitive):
 * Class | Subject | Topic | Language | Question | Option A | Option B | Option C | Option D | Correct Answer | Correct Display | Explanation
 */
router.post('/bulk-upload', requirePerm('perm_edit_curriculum'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Spreadsheet is empty' });
    }

    // Normalize column names
    const normalize = key => key.toString().toLowerCase().trim()
      .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

    const results = { created_quizzes: 0, created_questions: 0, errors: [] };

    // Group rows by (Class, Subject, Topic, Language) → one quiz per unique group
    const groups = {};
    rows.forEach((row, i) => {
      const r = {};
      Object.keys(row).forEach(k => { r[normalize(k)] = row[k]; });

      const cls  = (r['class'] || r['class_name'] || '').toString().trim();
      const subj = (r['subject'] || '').toString().trim();
      const topic = (r['topic'] || '').toString().trim();
      const lang  = (r['language'] || r['lang'] || '').toString().trim();
      const key   = `${cls}||${subj}||${topic}||${lang}`;

      if (!groups[key]) groups[key] = { cls, subj, topic, lang, rows: [] };
      groups[key].rows.push({ r, rowNum: i + 2 });
    });

    const client = await require('../db').pool.connect();
    try {
      await client.query('BEGIN');

      for (const [key, group] of Object.entries(groups)) {
        const { cls, subj, topic, lang } = group;

        // Create quiz for this group
        const quizTitle = [cls, subj, topic, lang].filter(Boolean).join(' – ') || 'Imported Quiz';
        const quizId = uuidv4();

        await client.query(`
          INSERT INTO quizzes (id, title, class_name, subject, topic, language, status, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
        `, [quizId, quizTitle, cls || null, subj || null, topic || null, lang || null, req.user.id]);

        results.created_quizzes++;
        let sortOrder = 0;

        for (const { r, rowNum } of group.rows) {
          const q_text = (r['question'] || r['question_text'] || '').toString().trim();
          const optA   = (r['option_a'] || r['a'] || r['option_1'] || '').toString().trim();
          const optB   = (r['option_b'] || r['b'] || r['option_2'] || '').toString().trim();
          const optC   = (r['option_c'] || r['c'] || r['option_3'] || '').toString().trim();
          const optD   = (r['option_d'] || r['d'] || r['option_4'] || '').toString().trim();
          const correct = (r['correct_answer'] || r['answer'] || r['correct'] || '').toString().trim().toUpperCase();
          const display = (r['correct_display'] || r['display'] || '').toString().trim();
          const expl    = (r['explanation'] || r['explanation_(optional)'] || '').toString().trim();

          if (!q_text || !optA || !optB || !optC || !optD) {
            results.errors.push(`Row ${rowNum}: Missing question text or options`);
            continue;
          }
          if (!['A','B','C','D'].includes(correct)) {
            results.errors.push(`Row ${rowNum}: correct_answer must be A/B/C/D (got "${correct}")`);
            continue;
          }

          await client.query(`
            INSERT INTO quiz_questions (
              id, quiz_id, sort_order,
              question_text, option_a, option_b, option_c, option_d,
              correct_answer, correct_display, explanation,
              class_name, subject, topic, language
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          `, [
            uuidv4(), quizId, ++sortOrder,
            q_text, optA, optB, optC, optD,
            correct, display || null, expl || null,
            cls || null, subj || null, topic || null, lang || null
          ]);

          results.created_questions++;
        }

        // Update question count
        await client.query(
          'UPDATE quizzes SET question_count=(SELECT COUNT(*) FROM quiz_questions WHERE quiz_id=$1) WHERE id=$1',
          [quizId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Clean up temp file
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.status(201).json({
      message: `Bulk upload complete`,
      ...results
    });
  } catch (err) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch(e) {}
    console.error(err);
    res.status(500).json({ error: 'Bulk upload failed', detail: err.message });
  }
});

// GET /api/quiz/attempts — Fetch quiz attempts with filters
router.get('/attempts', async (req, res) => {
  try {
    const { page = 1, limit = 50, quiz_id, state, class_grade, student_id } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const conds = [];
    const params = [];
    
    if (quiz_id && quiz_id.trim()) { 
      params.push(quiz_id.trim()); 
      conds.push(`qa.quiz_id = $${params.length}::uuid`); 
    }
    if (state && state.trim()) { 
      params.push(state.trim()); 
      conds.push(`qa.state = $${params.length}`); 
    }
    if (class_grade && class_grade.trim()) { 
      params.push(class_grade.trim()); 
      conds.push(`qa.class_grade = $${params.length}`); 
    }
    if (student_id && student_id.trim()) {
      params.push(student_id.trim());
      conds.push(`qa.student_id = $${params.length}`);
    }
    
    const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(parseInt(limit), offset);
    
    const r = await query(`
      SELECT qa.*, q.title AS quiz_title, q.subject, q.class_name
      FROM quiz_attempts qa
      LEFT JOIN quizzes q ON q.id = qa.quiz_id
      ${where}
      ORDER BY qa.attempted_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    
    const countR = await query(
      `SELECT COUNT(*) FROM quiz_attempts qa ${where}`,
      params.slice(0, -2)
    );
    
    res.json({ 
      success: true,
      attempts: r.rows, 
      total: parseInt(countR.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error('[quiz/attempts GET]', err);
    res.status(500).json({ error: 'Failed to fetch attempts', details: err.message });
  }
});

// ── Ingest attempt from student app ──────────────────────────────────────────
router.post('/attempts', async (req, res) => {
  try {
    const {
      quiz_id, device_id, student_id, state, district, school_id,
      class_grade, score, max_score, questions_attempted,
      correct_answers, time_taken_secs = 0, completed = false, app_language
    } = req.body;

    if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });

    const pct = max_score > 0 ? ((score / max_score) * 100).toFixed(2) : 0;

    await query(`
      INSERT INTO quiz_attempts (
        quiz_id, device_id, student_id, state, district, school_id,
        class_grade, score, max_score, pct_score,
        questions_attempted, correct_answers, time_taken_secs,
        completed, app_language
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      quiz_id, device_id, student_id, state, district, school_id,
      class_grade, score || 0, max_score || 0, pct,
      questions_attempted || 0, correct_answers || 0, time_taken_secs,
      completed, app_language
    ]);

    // Update quiz avg_score and total_attempts
    await query(`
      UPDATE quizzes SET
        total_attempts = total_attempts + 1,
        avg_score = (
          SELECT ROUND(AVG(pct_score)::NUMERIC, 2) FROM quiz_attempts WHERE quiz_id=$1
        ),
        updated_at = NOW()
      WHERE id=$1
    `, [quiz_id]);

    res.status(202).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: 'Attempt ingestion failed' });
  }
});

// ── Quiz Analytics ─────────────────────────────────────────────────────────────
router.get('/analytics', requirePerm('perm_view_analytics'), async (req, res) => {
  try {
    const { state, district, class_name, subject, language, days = 30 } = req.query;
    const conds = [`qa.attempted_at > NOW() - INTERVAL '${parseInt(days)} days'`];
    const params = [];

    if (state)      { params.push(state);      conds.push(`qa.state=$${params.length}`); }
    if (district)   { params.push(district);   conds.push(`qa.district=$${params.length}`); }
    if (class_name) { params.push(class_name); conds.push(`q.class_name ILIKE $${params.length}`); }
    if (subject)    { params.push(subject);    conds.push(`q.subject ILIKE $${params.length}`); }
    if (language)   { params.push(language);   conds.push(`q.language ILIKE $${params.length}`); }

    const where = 'WHERE ' + conds.join(' AND ');

    // KPIs
    const kpi = await query(`
      SELECT
        COUNT(DISTINCT qa.quiz_id)           AS total_quizzes,
        COUNT(*)                             AS total_attempts,
        COUNT(DISTINCT qa.student_id)        AS unique_students,
        ROUND(AVG(qa.pct_score)::NUMERIC,1)  AS avg_score_pct,
        ROUND(100.0*SUM(CASE WHEN qa.completed THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS completion_rate,
        ROUND(AVG(qa.time_taken_secs)::NUMERIC,0) AS avg_time_secs
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id=qa.quiz_id
      ${where}
    `, params);

    // Top quizzes by attempts
    const topQuizzes = await query(`
      SELECT q.title, q.class_name, q.subject, q.topic, q.language, q.status,
             COUNT(qa.id) AS attempts,
             ROUND(AVG(qa.pct_score)::NUMERIC,1) AS avg_score,
             ROUND(100.0*SUM(CASE WHEN qa.completed THEN 1 ELSE 0 END)/NULLIF(COUNT(qa.id),0),1) AS completion_rate
      FROM quizzes q
      LEFT JOIN quiz_attempts qa ON qa.quiz_id=q.id
        AND qa.attempted_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY q.id, q.title, q.class_name, q.subject, q.topic, q.language, q.status
      ORDER BY attempts DESC
      LIMIT 20
    `);

    // Score distribution
    const scoreDist = await query(`
      SELECT
        CASE
          WHEN pct_score < 25 THEN '0–25%'
          WHEN pct_score < 50 THEN '25–50%'
          WHEN pct_score < 75 THEN '50–75%'
          ELSE '75–100%'
        END AS bucket,
        COUNT(*) AS count
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id=qa.quiz_id
      ${where}
      GROUP BY bucket ORDER BY bucket
    `, params);

    // State-wise
    const byState = await query(`
      SELECT qa.state,
             COUNT(*) AS attempts,
             ROUND(AVG(qa.pct_score)::NUMERIC,1) AS avg_score
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id=qa.quiz_id
      ${where} AND qa.state IS NOT NULL
      GROUP BY qa.state ORDER BY attempts DESC LIMIT 30
    `, params);

    // Subject-wise
    const bySubject = await query(`
      SELECT q.subject,
             COUNT(*) AS attempts,
             ROUND(AVG(qa.pct_score)::NUMERIC,1) AS avg_score
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id=qa.quiz_id
      ${where} AND q.subject IS NOT NULL
      GROUP BY q.subject ORDER BY attempts DESC
    `, params);

    // Class-wise
    const byClass = await query(`
      SELECT q.class_name,
             COUNT(*) AS attempts,
             ROUND(AVG(qa.pct_score)::NUMERIC,1) AS avg_score
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id=qa.quiz_id
      ${where} AND q.class_name IS NOT NULL
      GROUP BY q.class_name ORDER BY q.class_name
    `, params);

    res.json({
      kpi: kpi.rows[0],
      top_quizzes: topQuizzes.rows,
      score_distribution: scoreDist.rows,
      by_state: byState.rows,
      by_subject: bySubject.rows,
      by_class: byClass.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Quiz analytics failed', detail: err.message });
  }
});

// ── Export quiz analytics ──────────────────────────────────────────────────────

// GET /api/quiz/analytics/deep — FIX: Scope and Type-safe Analytics endpoint
router.get('/analytics/deep', requirePerm('perm_view_analytics'), async (req, res) => {
  
  // 1. THE SCOPE FIX: Define variables OUTSIDE the try/catch so both blocks can use them safely
  const { quiz_id, days = 30 } = req.query;
  const validQuizId = (quiz_id && quiz_id.trim() !== '') ? quiz_id : null;

  try {
    const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString();

    // Per-question analysis
    const questionStats = await query(`
      SELECT
        qq.id          AS question_id,
        qq.question_text,
        qq.correct_answer,
        COUNT(qa.id)                                   AS attempts,
        ROUND(AVG(CASE WHEN qa.is_correct THEN 1 ELSE 0 END)::numeric * 100, 1) AS accuracy_pct,
        ROUND(AVG(a.time_taken_seconds)::numeric, 1)  AS avg_time_sec
      FROM quiz_questions qq
      LEFT JOIN quiz_attempt_answers qa ON qa.question_id = qq.id
      LEFT JOIN quiz_attempts a ON a.id = qa.attempt_id AND a.completed_at >= $1
      
      -- 2. THE SQL FIX: Use ::bigint to match your database schema
      WHERE ($2::bigint IS NULL OR qq.quiz_id = $2::bigint)
      
      GROUP BY qq.id, qq.question_text, qq.correct_answer
      ORDER BY accuracy_pct ASC
      LIMIT 50
    `, [since, validQuizId]);

    // Score distribution
    const distribution = await query(`
      SELECT
        CASE
          WHEN score_pct >= 90 THEN '90-100'
          WHEN score_pct >= 75 THEN '75-89'
          WHEN score_pct >= 50 THEN '50-74'
          ELSE '0-49'
        END AS band,
        COUNT(*) AS count
      FROM quiz_attempts
      
      -- 2. THE SQL FIX: Use ::bigint here as well
      WHERE completed_at >= $1 AND ($2::bigint IS NULL OR quiz_id = $2::bigint)
      
      GROUP BY band ORDER BY band DESC
    `, [since, validQuizId]);

    res.json({
      question_stats:     questionStats.rows,
      score_distribution: distribution.rows,
      period_days:        parseInt(days)
    });

  } catch (err) {
    console.error('🔥 DEEP ANALYTICS CRASH:', err.message);
    
    // 3. THE FALLBACK: Safely return empty arrays using the globally scoped `days` variable
    res.json({
      question_stats: [],
      score_distribution: [],
      period_days: parseInt(days)
    });
  }
});

router.get('/analytics/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const { format = 'xlsx', days = 30 } = req.query;

    const result = await query(`
      SELECT q.title AS quiz_title, q.class_name, q.subject, q.topic, q.language,
             q.status,
             qa.state, qa.district, qa.school_id, qa.class_grade,
             qa.score, qa.max_score, qa.pct_score,
             qa.questions_attempted, qa.correct_answers,
             qa.time_taken_secs, qa.completed,
             TO_CHAR(qa.attempted_at,'YYYY-MM-DD HH24:MI') AS attempted_at
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id=qa.quiz_id
      WHERE qa.attempted_at > NOW() - INTERVAL '${parseInt(days)} days'
      ORDER BY qa.attempted_at DESC
      LIMIT 50000
    `);

    const ws  = XLSX.utils.json_to_sheet(result.rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Quiz Analytics');
    const ext = format === 'csv' ? 'csv' : 'xlsx';
    const buf = XLSX.write(wb, { type: 'buffer', bookType: format === 'csv' ? 'csv' : 'xlsx' });

    res.setHeader('Content-Disposition',
      `attachment; filename="MITRA_Quiz_Analytics_${new Date().toISOString().slice(0,10)}.${ext}"`);
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Download XLSX template for bulk upload ─────────────────────────────────────
router.get('/template', (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Class','Subject','Topic','Language','Question','Option A','Option B','Option C','Option D','Correct Answer','Correct Display','Explanation'],
    ['Class 9','Science','Photosynthesis','Hindi','What is photosynthesis?','Making food from sunlight','Breathing in CO2','Drinking water','None of these','A','Making food from sunlight','Plants use sunlight, CO2, and water to make glucose (food).'],
    ['Class 10','Mathematics','Trigonometry','English','What is sin 90°?','0','1','√2/2','Undefined','B','1','sin 90° = 1 is a standard trigonometric value.'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Quiz Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="MITRA_Quiz_Upload_Template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

/**
 * POST /api/quiz/bulk-action
 * Applies a specific status update or deletes multiple quizzes at once.
 */
router.post('/bulk-action', async (req, res) => {
  const { quizIds, action } = req.body;
  
  if (!quizIds || !Array.isArray(quizIds) || quizIds.length === 0) {
    return res.status(400).json({ error: 'No quizzes selected.' });
  }

  try {
    if (action === 'delete') {
      // Using the standard query method already active in your file
      await query(`DELETE FROM quizzes WHERE id = ANY($1)`, [quizIds]);
    } else {
      await query(`UPDATE quizzes SET status = $1, updated_at = NOW() WHERE id = ANY($2)`, [action, quizIds]);
    }

    res.status(200).json({ message: `Successfully applied ${action} to ${quizIds.length} quizzes.` });
  } catch (error) {
    console.error('Bulk action error:', error);
    res.status(500).json({ error: 'Failed to execute bulk action.' });
  }
});

module.exports = router;
