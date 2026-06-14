/**
 * db/seed.js — Seed database with the initial master admin + sample data
 *
 * SECURITY (changed from the original):
 *   The original had a hard-coded password 'admin123'. That has been removed.
 *   You MUST supply SEED_ADMIN_PASSWORD as an environment variable. The seed
 *   refuses to run otherwise. Password must be ≥12 chars and include upper,
 *   lower, digit, and symbol.
 *
 * Usage (local):
 *   SEED_ADMIN_EMAIL=you@yourdomain.com \
 *   SEED_ADMIN_PASSWORD='SomethingStrong!2026' \
 *   SEED_ADMIN_NAME='Your Name' \
 *   npm run seed
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { init, query, close } = require('./index');
const logger = require('../lib/logger');

function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'SEED_ADMIN_PASSWORD is required';
  if (pw.length < 12) return 'Password must be ≥12 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include a digit';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must include a symbol';
  const banned = ['admin', 'password', 'mitra', '123', 'qwerty', 'letmein'];
  const lower = pw.toLowerCase();
  if (banned.some(b => lower.includes(b))) return 'Password contains a common/banned substring';
  return null;
}

async function seed() {
  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const pw    = process.env.SEED_ADMIN_PASSWORD || '';
  const name  = (process.env.SEED_ADMIN_NAME || 'Master Admin').trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    logger.error('SEED_ADMIN_EMAIL must be a valid email address');
    process.exit(2);
  }
  const pwErr = validatePassword(pw);
  if (pwErr) {
    logger.error({ reason: pwErr }, 'SEED_ADMIN_PASSWORD invalid');
    process.exit(2);
  }

  await init();
  logger.info('🌱 Seeding database…');

  // ── Master Admin ────────────────────────────────────────────────────────────
  const adminPwd = await bcrypt.hash(pw, 12);
  await query(`
    INSERT INTO users (
      id, full_name, email, password_hash, role, is_active,
      perm_view_dashboard, perm_view_controls, perm_view_curriculum,
      perm_view_ar_assets, perm_view_notif, perm_view_users,
      perm_view_legal, perm_view_settings, perm_view_app_builder, perm_manage_compliance
    ) VALUES (
      $1, $2, $3, $4, 'master_admin', true,
      true, true, true,
      true, true, true,
      true, true, true, true
    ) ON CONFLICT (email) DO NOTHING;
  `, [uuidv4(), name, email, adminPwd]);
  logger.info({ email }, '✅ Master admin upserted');

  // ── Sample Curriculum Nodes (optional demo data) ────────────────────────────
  if (process.env.SEED_SAMPLE_DATA === 'true') {
    const cl10 = uuidv4(), cl9 = uuidv4(), sciId = uuidv4(), mathId = uuidv4();
    await query(`
      INSERT INTO curriculum_nodes (id, node_type, name, icon, sort_order) VALUES
        ($1,'class','Class 10','🏫',10),
        ($2,'class','Class 9','🏫',9)
      ON CONFLICT DO NOTHING
    `, [cl10, cl9]);
    await query(`
      INSERT INTO curriculum_nodes (id, parent_id, node_type, name, icon) VALUES
        ($1,$3,'subject','Science','📘'),
        ($2,$3,'subject','Mathematics','📐')
      ON CONFLICT DO NOTHING
    `, [sciId, mathId, cl10]);
    logger.info('✅ Sample curriculum nodes seeded');
  }

  logger.info('🎉 Seed complete');
  await close();
}

seed().catch(err => {
  logger.error({ err: err.message }, 'Seed failed');
  process.exit(1);
});
