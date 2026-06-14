/**
 * routes/curriculum.js — Curriculum Taxonomy CRUD + AR/Quiz Linking (v4.0)
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');
router.use(authenticate);

// ── Nodes ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const r = await query(`SELECT n.*, p.name AS parent_name FROM curriculum_nodes n
      LEFT JOIN curriculum_nodes p ON p.id = n.parent_id
      WHERE n.is_active = true ORDER BY n.sort_order, n.name`);
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Failed to fetch curriculum' }); }
});

// GET /api/curriculum/tree — Alias for GET / (frontend compatibility)
router.get('/tree', async (req, res) => {
  try {
    const r = await query(`
      SELECT n.*, p.name AS parent_name 
      FROM curriculum_nodes n
      LEFT JOIN curriculum_nodes p ON p.id = n.parent_id
      WHERE n.is_active = true
      ORDER BY n.sort_order, n.name
    `);
    res.json({ success: true, nodes: r.rows });
  } catch (err) {
    console.error('[curriculum/tree]', err);
    res.status(500).json({ error: 'Failed to fetch curriculum', details: err.message });
  }
});

router.post('/', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { parent_id, node_type, name, icon = '📘', sort_order = 0 } = req.body;
    if (!node_type || !name) return res.status(400).json({ error: 'node_type and name required' });
    const r = await query(`INSERT INTO curriculum_nodes (id,parent_id,node_type,name,icon,sort_order,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [uuidv4(), parent_id || null, node_type, name, icon, sort_order, req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Failed to create node' }); }
});

router.put('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { name, icon, sort_order, is_active } = req.body;
    const r = await query(`UPDATE curriculum_nodes SET name=COALESCE($1,name),icon=COALESCE($2,icon),
      sort_order=COALESCE($3,sort_order),is_active=COALESCE($4,is_active) WHERE id=$5 RETURNING *`,
      [name, icon, sort_order, is_active, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Node not found' });
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Failed to update node' }); }
});

router.delete('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    await query('UPDATE curriculum_nodes SET is_active=false WHERE id=$1', [req.params.id]);
    res.json({ message: 'Node deactivated' });
  } catch { res.status(500).json({ error: 'Failed to delete node' }); }
});

// ── AR Topics for curriculum dropdown (filtered by class + subject) ────────────
router.get('/ar-topics', async (req, res) => {
  try {
    const { class_name, subject, language } = req.query;
    const conds = [`status NOT IN ('archived','rejected')`, 'topic IS NOT NULL'];
    const params = []; let p = 1;
    if (class_name) { conds.push(`class_name = $${p++}`); params.push(class_name); }
    if (subject)    { conds.push(`subject    = $${p++}`); params.push(subject); }
    if (language)   { conds.push(`language   = $${p++}`); params.push(language); }
    const r = await query(`SELECT DISTINCT ON (topic) id,topic,class_name,subject,language,title,file_format,status,created_at
      FROM unity_assets WHERE ${conds.join(' AND ')} ORDER BY topic ASC, created_at DESC`, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch AR topics', detail: err.message }); }
});

// ── State Hierarchy ───────────────────────────────────────────────────────────
router.post('/hierarchy', async (req, res) => {
  try {
    const { state_code, structure } = req.body;
    if (!state_code) return res.status(400).json({ error: 'state_code required' });
    await query(`INSERT INTO curriculum_state_hierarchy (state_code,structure,updated_by,updated_at)
      VALUES ($1,$2,$3,NOW()) ON CONFLICT (state_code)
      DO UPDATE SET structure=$2,updated_by=$3,updated_at=NOW()`,
      [state_code, JSON.stringify(structure), req.user?.id || null]);
    res.json({ message: 'Hierarchy saved', state_code });
  } catch (err) {
    console.warn('hierarchy save:', err.message);
    res.json({ message: 'Hierarchy received (run migration to persist)', state_code: req.body.state_code });
  }
});

router.get('/hierarchy/:stateCode', async (req, res) => {
  try {
    const r = await query('SELECT structure FROM curriculum_state_hierarchy WHERE state_code=$1', [req.params.stateCode]);
    res.json(r.rows[0]?.structure || []);
  } catch { res.json([]); }
});

// ── Summary / Export ──────────────────────────────────────────────────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const r = await query(`SELECT csh.state_code, COALESCE(s.name,csh.state_code) AS state_name,
      csh.structure, csh.updated_at FROM curriculum_state_hierarchy csh
      LEFT JOIN india_states s ON s.code=csh.state_code ORDER BY state_name`);
    const rows = [];
    for (const sr of r.rows) {
      for (const cls of (sr.structure || [])) {
        for (const subj of (cls.subjects || [])) {
          const topics = subj.topics || [];
          if (!topics.length) {
            rows.push({ state: sr.state_name, state_code: sr.state_code, class: cls.class_name,
              subject: subj.subject, topic: '', ar_linked: 'No', asset_id: '', quizzes: '', quiz_count: 0 });
          }
          for (const t of topics) {
            rows.push({ state: sr.state_name, state_code: sr.state_code, class: cls.class_name,
              subject: subj.subject, topic: t.topic || t,
              ar_linked: t.asset_id ? 'Yes' : 'No', asset_id: t.asset_id || '',
              quizzes: (t.linked_quizzes || []).join('; '),
              quiz_count: (t.linked_quizzes || []).length });
          }
        }
      }
    }
    res.json({ data: rows, total: rows.length, exported_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

// ── Quiz Links ────────────────────────────────────────────────────────────────
router.post('/quiz-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { node_id, quiz_id } = req.body;
    if (!node_id || !quiz_id) return res.status(400).json({ error: 'node_id and quiz_id required' });

    // FIX 1: Let the database generate the UUID directly to prevent import crashes
    // FIX 2: Safely check for req.user.id or req.user.uid depending on the auth setup
    const r = await query(`
      INSERT INTO curriculum_quiz_links (id, node_id, quiz_id, linked_by)
      VALUES (gen_random_uuid(), $1, $2, $3) 
      ON CONFLICT (node_id, quiz_id) DO NOTHING 
      RETURNING *
    `, [node_id, quiz_id, req.user?.id || req.user?.uid || 'system']);

    res.status(201).json({ message: 'Quiz linked', link: r.rows[0] });
  } catch (error) { 
    // FIX 3: Print the actual error to the logs so it is never hidden again
    console.error('CRASH in /quiz-links:', error);
    res.status(500).json({ error: 'Failed to link quiz' }); 
  }
});

router.delete('/quiz-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    await query('DELETE FROM curriculum_quiz_links WHERE id=$1', [req.params.id]);
    res.json({ message: 'Quiz link removed' });
  } catch { res.status(500).json({ error: 'Failed to remove quiz link' }); }
});

router.get('/quiz-links/:nodeId', async (req, res) => {
  try {
    const r = await query(`SELECT l.*, q.title, q.class_name, q.subject, q.topic, q.language,
      q.status, q.question_count FROM curriculum_quiz_links l
      JOIN quizzes q ON q.id=l.quiz_id WHERE l.node_id=$1 ORDER BY l.linked_at ASC`,
      [req.params.nodeId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Failed to fetch quiz links' }); }
});

// ── AR Links ──────────────────────────────────────────────────────────────────
router.post('/ar-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { curriculum_node_id, asset_id } = req.body;
    if (!curriculum_node_id || !asset_id) return res.status(400).json({ error: 'curriculum_node_id and asset_id required' });
    const r = await query(`INSERT INTO curriculum_ar_links (id,curriculum_node_id,asset_id,linked_by)
      VALUES ($1,$2,$3,$4) ON CONFLICT (curriculum_node_id,asset_id) DO NOTHING RETURNING *`,
      [uuidv4(), curriculum_node_id, asset_id, req.user.id]);
    res.status(201).json({ message: 'AR asset linked', link: r.rows[0] });
  } catch { res.status(500).json({ error: 'Failed to link AR asset' }); }
});

router.delete('/ar-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    await query('DELETE FROM curriculum_ar_links WHERE id=$1', [req.params.id]);
    res.json({ message: 'AR link removed' });
  } catch { res.status(500).json({ error: 'Failed to remove AR link' }); }
});

router.get('/ar-links/:nodeId', async (req, res) => {
  try {
    const r = await query(`SELECT l.*, a.title, a.topic, a.class_name, a.subject, a.language,
      a.status, a.file_format FROM curriculum_ar_links l
      JOIN unity_assets a ON a.id=l.asset_id WHERE l.curriculum_node_id=$1 ORDER BY l.created_at ASC`,
      [req.params.nodeId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Failed to fetch AR links' }); }
});

// POST schedule visibility for curriculum topics (Issue 7)
router.post('/schedule', require('../middleware/auth').authenticate, async (req, res) => {
  const { topic_name, node_id, publish_at, expires_at, note } = req.body;
  if (!topic_name || !publish_at) {
    return res.status(400).json({ error: 'topic_name and publish_at are required' });
  }
  try {
    const db = require('../db');
    await db.query(
      `INSERT INTO curriculum_schedules (topic_name, node_id, publish_at, expires_at, note, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (node_id) DO UPDATE
         SET publish_at = EXCLUDED.publish_at, expires_at = EXCLUDED.expires_at,
             note = EXCLUDED.note, updated_at = NOW()`,
      [topic_name, node_id, publish_at, expires_at || null, note || null, req.user?.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
