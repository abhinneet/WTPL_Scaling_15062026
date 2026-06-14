/**
 * routes/consent.js — DPDPA 2023 Consent Management API
 *
 * POST /api/consent/grant          — User grants consent (called after login modal)
 * POST /api/consent/withdraw       — User withdraws consent
 * GET  /api/consent/status         — Check current user's consent status
 * POST /api/consent/parental       — Admin records parental consent for a student
 * GET  /api/consent/parental/:id   — Check parental consent status for a student
 *
 * DPDPA §6: Consent must be free, informed, specific, and withdrawable at any time.
 * DPDPA §9: Parental/guardian consent required for users under 18.
 */

'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');
const { audit } = require('../lib/auditLogger');
const log = require('../lib/logger');

// Current consent version — bump this string whenever your Privacy Policy
// materially changes. Users on an older version will be asked to re-consent.
const CURRENT_CONSENT_VERSION = '1.0';

// ── Helper: write to immutable audit log ─────────────────────────────────────
async function logConsentEvent(userId, consentType, action, ip, userAgent, version) {
  try {
    await query(
      `INSERT INTO consent_audit_log
         (id, user_id, consent_type, action, consent_version, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [uuidv4(), userId, consentType, action, version, ip, userAgent || null]
    );
  } catch (e) {
    log.warn({ err: e.message }, 'consent audit log insert failed');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/consent/grant
// Called by the frontend consent modal after the user ticks the boxes.
//
// Body: { consents: ['data_collection', 'analytics', 'communications'] }
//   — at minimum 'data_collection' must be present (it's mandatory)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/grant', authenticate, async (req, res) => {
  try {
    const { consents = [] } = req.body;
    const userAgent = req.headers['user-agent'] || null;

    // data_collection is mandatory — you cannot use the platform without it
    if (!Array.isArray(consents) || !consents.includes('data_collection')) {
      return res.status(400).json({
        error: 'data_collection consent is required to use the platform'
      });
    }

    const VALID_TYPES = ['data_collection', 'analytics', 'communications'];
    const toGrant = consents.filter(c => VALID_TYPES.includes(c));

    for (const consentType of toGrant) {
      // Upsert — if they consented before and withdrew, this re-grants
      await query(
        `INSERT INTO consents
           (id, user_id, consent_type, is_active, granted_at, ip_address, user_agent, consent_version, updated_at)
         VALUES ($1, $2, $3, true, NOW(), $4, $5, $6, NOW())
         ON CONFLICT (user_id, consent_type)
         DO UPDATE SET
           is_active       = true,
           granted_at      = NOW(),
           withdrawn_at    = NULL,
           ip_address      = $4,
           user_agent      = $5,
           consent_version = $6,
           updated_at      = NOW()`,
        [uuidv4(), req.user.id, consentType, req.ip, userAgent, CURRENT_CONSENT_VERSION]
      );

      await logConsentEvent(req.user.id, consentType, 'granted', req.ip, userAgent, CURRENT_CONSENT_VERSION);
    }

    audit({
      userId: req.user.id,
      action: 'consent.granted',
      resourceType: 'consent',
      resourceId: req.user.id,
      ip: req.ip,
      details: { types: toGrant, version: CURRENT_CONSENT_VERSION }
    });

    res.json({
      success: true,
      message: 'Consent recorded. Thank you.',
      consents_granted: toGrant,
      consent_version: CURRENT_CONSENT_VERSION
    });
  } catch (e) {
    log.error({ err: e.message }, 'consent/grant error');
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/consent/withdraw
// Called when user clicks "Withdraw Consent" in their account settings.
//
// Body: { consent_type: 'analytics' }  — or 'all' to withdraw everything
// ══════════════════════════════════════════════════════════════════════════════
router.post('/withdraw', authenticate, async (req, res) => {
  try {
    const { consent_type } = req.body;
    const userAgent = req.headers['user-agent'] || null;

    if (!consent_type) {
      return res.status(400).json({ error: 'consent_type is required' });
    }

    if (consent_type === 'all') {
      // Withdraw all consents for this user
      await query(
        `UPDATE consents
         SET is_active = false, withdrawn_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND is_active = true`,
        [req.user.id]
      );

      const types = ['data_collection', 'analytics', 'communications'];
      for (const t of types) {
        await logConsentEvent(req.user.id, t, 'withdrawn', req.ip, userAgent, CURRENT_CONSENT_VERSION);
      }
    } else {
      await query(
        `UPDATE consents
         SET is_active = false, withdrawn_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND consent_type = $2 AND is_active = true`,
        [req.user.id, consent_type]
      );

      await logConsentEvent(req.user.id, consent_type, 'withdrawn', req.ip, userAgent, CURRENT_CONSENT_VERSION);
    }

    audit({
      userId: req.user.id,
      action: 'consent.withdrawn',
      resourceType: 'consent',
      resourceId: req.user.id,
      ip: req.ip,
      details: { consent_type }
    });

    res.json({
      success: true,
      message: consent_type === 'all'
        ? 'All consents withdrawn. Your data will be processed per our retention policy.'
        : `Consent for "${consent_type}" withdrawn.`,
      withdrawn_type: consent_type
    });
  } catch (e) {
    log.error({ err: e.message }, 'consent/withdraw error');
    res.status(500).json({ error: 'Failed to withdraw consent' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/consent/status
// Called on page load to check if the current user has active consents.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/status', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT consent_type, is_active, granted_at, consent_version
       FROM consents WHERE user_id = $1`,
      [req.user.id]
    );

    const consents = {};
    for (const row of result.rows) {
      consents[row.consent_type] = {
        active: row.is_active,
        granted_at: row.granted_at,
        version: row.consent_version
      };
    }

    const hasRequiredConsent =
      consents['data_collection']?.active === true &&
      consents['data_collection']?.version === CURRENT_CONSENT_VERSION;

    res.json({
      consent_required: !hasRequiredConsent,
      current_version: CURRENT_CONSENT_VERSION,
      consents
    });
  } catch (e) {
    // If consents table doesn't exist yet, don't block login
    log.warn({ err: e.message }, 'consent/status check failed — table may need migration');
    res.json({ consent_required: false, current_version: CURRENT_CONSENT_VERSION, consents: {} });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/consent/parental
// Admin records that a school has obtained parental consent for a student.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/parental', authenticate, requirePerm('perm_create_users'), async (req, res) => {
  try {
    const {
      student_id, guardian_name, guardian_email,
      guardian_phone, notes
    } = req.body;

    if (!student_id || !guardian_name || !guardian_email) {
      return res.status(400).json({
        error: 'student_id, guardian_name and guardian_email are required'
      });
    }

    // Verify student exists
    const studentCheck = await query(
      'SELECT id, full_name FROM users WHERE id = $1',
      [student_id]
    );
    if (!studentCheck.rows.length) {
      return res.status(404).json({ error: 'Student not found' });
    }

    await query(
      `INSERT INTO parental_consents
         (id, student_id, guardian_name, guardian_email, guardian_phone,
          consent_given, consent_date, verification_method, recorded_by, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW(), 'school_admin', $6, $7, NOW())
       ON CONFLICT (student_id)
       DO UPDATE SET
         guardian_name       = $3,
         guardian_email      = $4,
         guardian_phone      = $5,
         consent_given       = true,
         consent_date        = NOW(),
         verification_method = 'school_admin',
         recorded_by         = $6,
         notes               = $7,
         updated_at          = NOW()`,
      [uuidv4(), student_id, guardian_name, guardian_email,
       guardian_phone || null, req.user.id, notes || null]
    );

    audit({
      userId: req.user.id,
      action: 'consent.parental_recorded',
      resourceType: 'parental_consent',
      resourceId: student_id,
      ip: req.ip,
      details: { guardian_email, student_id }
    });

    res.json({
      success: true,
      message: `Parental consent recorded for student ${studentCheck.rows[0].full_name}`
    });
  } catch (e) {
    log.error({ err: e.message }, 'consent/parental error');
    res.status(500).json({ error: 'Failed to record parental consent' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/consent/parental/:studentId
// Check if parental consent exists for a given student.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/parental/:studentId', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT pc.*, u.full_name AS recorded_by_name
       FROM parental_consents pc
       LEFT JOIN users u ON u.id = pc.recorded_by
       WHERE pc.student_id = $1`,
      [req.params.studentId]
    );

    if (!result.rows.length) {
      return res.json({ consent_given: false, student_id: req.params.studentId });
    }

    res.json({ consent_given: true, ...result.rows[0] });
  } catch (e) {
    res.json({ consent_given: false, error: 'Table may need migration' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NEP 2020 AD CONSENT ROUTES - Added 2026-05-23
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/consent/ad-consent - Record ad consent for student
router.post('/ad-consent', authenticate, async (req, res) => {
  try {
    const { 
      user_id, 
      date_of_birth, 
      consent_given, 
      parent_email, 
      ad_type 
    } = req.body;

    // Validate required fields
    if (!user_id || !date_of_birth || consent_given === undefined) {
      return res.status(400).json({ 
        error: 'user_id, date_of_birth, and consent_given are required' 
      });
    }

    // Calculate age
    const dob = new Date(date_of_birth);
    const today = new Date();
    const age = today.getFullYear() - dob.getFullYear();
    const isBirthday = today.getMonth() > dob.getMonth() || 
                       (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
    const actualAge = isBirthday ? age : age - 1;
    const isMinor = actualAge < 18;

    // If minor and consent given without parent email, reject
    if (isMinor && consent_given && !parent_email) {
      return res.status(400).json({ 
        error: 'Parental consent (parent email) required for users under 18' 
      });
    }

    // Update user record
    await query(
      `UPDATE users 
       SET date_of_birth = $1, 
           is_minor = $2, 
           ad_consent_given = $3,
           ad_consent_by = $4,
           ad_consent_at = NOW()
       WHERE id = $5`,
      [date_of_birth, isMinor, consent_given, parent_email || null, user_id]
    );

    // Log the consent event
    await query(
      `INSERT INTO ad_consent_log 
       (id, user_id, student_age, consent_given, consent_method, 
        consented_by, consent_ip, consent_user_agent, ad_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidv4(),
        user_id,
        actualAge,
        consent_given,
        isMinor ? 'parent_email' : 'self',
        parent_email || req.user.email,
        req.ip,
        req.headers['user-agent'] || 'unknown',
        ad_type || 'general'
      ]
    );

    // Audit log
    await query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, ip_address, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        uuidv4(),
        user_id,
        isMinor ? 'ad_consent.minor_consent_recorded' : 'ad_consent.adult_consent_recorded',
        'consent',
        req.ip,
        JSON.stringify({ age: actualAge, consent_given, parent_email: !!parent_email })
      ]
    );

    res.json({ 
      success: true, 
      is_minor: isMinor,
      age: actualAge,
      consent_recorded: true 
    });

  } catch (err) {
    console.error('[ad-consent]', err);
    res.status(500).json({ error: 'Failed to record ad consent' });
  }
});

// GET /api/consent/ad-consent/:userId - Check if user has given ad consent
router.get('/ad-consent/:userId', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT date_of_birth, is_minor, ad_consent_given, 
              ad_consent_by, ad_consent_at
       FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    
    res.json({
      has_consent: user.ad_consent_given === true,
      is_minor: user.is_minor,
      needs_parental_consent: user.is_minor && !user.ad_consent_given,
      consented_by: user.ad_consent_by,
      consented_at: user.ad_consent_at
    });

  } catch (err) {
    console.error('[ad-consent check]', err);
    res.status(500).json({ error: 'Failed to check consent' });
  }
});

module.exports = router;
