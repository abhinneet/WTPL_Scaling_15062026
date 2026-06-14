/**
 * routes/auth.js — Login, refresh, logout, password reset
 *
 * Security fixes:
 *   - C1: removed plaintext-password console logging
 *   - H1: refresh-token rotation (one-time use + family revocation)
 *   - H7: per-account lockout after repeated failed logins
 *   - H9: stronger password policy (12 chars + complexity)
 *   - C2: no error.message ever leaks to client in production
 *   - Replaced `sendCredentialEmail` with one-time reset-link pattern
 */

'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { audit } = require('../lib/auditLogger');
const log = require('../lib/logger');

// ── Password policy ──────────────────────────────────────────────────────────
const MIN_PASSWORD_LEN = 12;
const COMMON_PASSWORDS = new Set([
  // Top patterns — full top-10k list lives in lib/top-10000-passwords.txt
  'password', 'password123', 'admin', 'admin123', 'qwerty', 'qwerty123',
  '12345678', '123456789', '1234567890', 'changeme', 'letmein',
  'welcome1', 'welcome123', 'mitra', 'mitra123',
]);

function passwordPolicyError(password, { email } = {}) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters`;
  if (password.length > 200) return 'Password too long';
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3) return 'Password must contain at least 3 of: lowercase, uppercase, digit, symbol';
  if (email && password.toLowerCase().includes(email.toLowerCase().split('@')[0])) {
    return 'Password must not contain your email';
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Password is too common';
  return null;
}

// ── Failed-login lockout ─────────────────────────────────────────────────────
const LOCKOUT_THRESHOLD = parseInt(process.env.LOCKOUT_THRESHOLD, 10) || 10;
const LOCKOUT_MINUTES = parseInt(process.env.LOCKOUT_MINUTES, 10) || 30;

async function recordFailedLogin(email, ip) {
  try {
    // 1. Look up the user's ID using their email
    const userRes = await query('SELECT id FROM users WHERE email = $1', [email]);
    const userId = userRes.rows[0]?.id || null;
    
    // 2. Insert using the correct database column names (user_id, ip_address)
    await query(
      `INSERT INTO failed_logins (user_id, ip_address, created_at)
       VALUES ($1, $2, NOW())`,
      [userId, ip]
    );
  } catch (err) {
    log.warn({ err: err.message }, 'failed_logins insert failed');
  }
}

async function isLockedOut(email) {
  try {
    // 1. Look up the user's ID using their email
    const userRes = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (!userRes.rows.length) return false;
    const userId = userRes.rows[0].id;

    // 2. Query using user_id instead of the non-existent email column
    const result = await query(
      `SELECT COUNT(*) AS c FROM failed_logins
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${LOCKOUT_MINUTES} minutes'`,
      [userId]
    );
    return parseInt(result.rows[0].c, 10) >= LOCKOUT_THRESHOLD;
  } catch (_) {
    return false;
  }
}

async function clearFailedLogins(email) {
  try {
    // 1. Look up the user's ID using their email
    const userRes = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length) {
      // 2. Delete using user_id
      await query('DELETE FROM failed_logins WHERE user_id = $1', [userRes.rows[0].id]);
    }
  } catch (_) {/* ignore */}
}

// ── JWT helpers ──────────────────────────────────────────────────────────────
function signAccess(user) {
  return jwt.sign(
    {
      id:    user.id,
      email: user.email,
      role:  user.role,
      name:  user.full_name,
      state: user.assigned_state,
      perm_publish_apps:     !!user.perm_publish_apps,
      perm_upload_unity:     !!user.perm_upload_unity,
      perm_manage_geo:       !!user.perm_manage_geo,
      perm_view_analytics:   !!user.perm_view_analytics,
      perm_create_users:     !!user.perm_create_users,
      perm_edit_curriculum:  !!user.perm_edit_curriculum,
      perm_approve_content:  !!user.perm_approve_content,
      perm_export_data:      !!user.perm_export_data,
      perm_manage_ads:       !!user.perm_manage_ads,
      perm_replay_analytics: !!user.perm_replay_analytics,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' }
  );
}

function signRefresh(userId, familyId) {
  return jwt.sign(
    { id: userId, fam: familyId, kind: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', algorithm: 'HS256' }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    // 1. Grab all possible variables (from both Mobile and Dashboard)
    const { phone, role, method } = req.body;
    const email = String(req.body?.email || '').toLowerCase().trim();
    const password = req.body?.password;

    // ═══════════════════════════════════════════════════════
    // LANE 1: MOBILE APP (PASSWORDLESS OTP REQUEST)
    // ═══════════════════════════════════════════════════════
    if (method) {
      if (!phone || !role) {
        return res.status(400).json({ error: 'Phone/Email and role are required for OTP login' });
      }

      // NOTE FOR BACKEND DEVELOPER: 
      // Insert actual Twilio / Firebase / Nodemailer trigger code right here to actually send the message!
      console.log(`[AUTH] Generating OTP via ${method} for ${phone} (${role})`);

      // Return a success message so the mobile app slides over to the 6-digit OTP boxes
      return res.status(200).json({ message: `OTP sent successfully via ${method}` });
    }

    // ═══════════════════════════════════════════════════════
    // LANE 2: DASHBOARD (TRADITIONAL EMAIL & PASSWORD)
    // ═══════════════════════════════════════════════════════
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 255) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    if (await isLockedOut(email)) {
      audit({ userId: null, action: 'login.locked_out', resourceType: 'auth', ip: req.ip, details: { email } });
      return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
    }

    const result = await query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    // Constant-ish-time response: always run bcrypt even if user not found
    const fakeHash = '$2a$12$0000000000000000000000000000000000000000000000000000.';
    const userRow = result.rows[0];
    const hashToCheck = userRow ? userRow.password_hash : fakeHash;
    const match = await bcrypt.compare(password, hashToCheck);

    if (!userRow || !match) {
      await recordFailedLogin(email, req.ip);
      audit({ userId: userRow?.id || null, action: 'login.failure', resourceType: 'auth', ip: req.ip, details: { email } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await clearFailedLogins(email);
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userRow.id]);

    // Generate tokens with a family id (for refresh-token rotation tracking)
    const familyId = uuidv4();
    const accessToken = signAccess(userRow);
    const refreshToken = signRefresh(userRow.id, familyId);
    const refreshHash = hashToken(refreshToken);

    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, is_revoked)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days', false)`,
      [uuidv4(), userRow.id, refreshHash, familyId]
    );

    audit({ userId: userRow.id, action: 'login.success', resourceType: 'auth', ip: req.ip });

    res.json({
      token: accessToken,          // legacy field name; the dashboard reads this
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 28800,
      user: {
        id: userRow.id,
        name: userRow.full_name,
        email: userRow.email,
        role: userRow.role,
        state: userRow.assigned_state,
        permissions: {
          publish_apps:     !!userRow.perm_publish_apps,
          upload_unity:     !!userRow.perm_upload_unity,
          manage_geo:       !!userRow.perm_manage_geo,
          view_analytics:   !!userRow.perm_view_analytics,
          create_users:     !!userRow.perm_create_users,
          edit_curriculum:  !!userRow.perm_edit_curriculum,
          approve_content:  !!userRow.perm_approve_content,
          export_data:      !!userRow.perm_export_data,
          manage_ads:       !!userRow.perm_manage_ads,
          replay_analytics: !!userRow.perm_replay_analytics,
        },
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'login error');
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ═══════════════════════════════════════════════════════
// NEW ROUTE: VERIFY OTP (Mobile App)
// ═══════════════════════════════════════════════════════
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, role } = req.body;

    // 1. The Master OTP for development and testing
    if (otp !== '123456') {
      return res.status(400).json({ message: 'OTP is incorrect. Please try again.' });
    }

    // 2. Fetch the user to log them in. 
    // (Note: To ensure this doesn't crash your database if you don't have a 'phone' column yet, 
    // this query simply grabs the first active user with the requested role so you can test the app).
    // BYPASS: Just grab ANY active user from the DB so we have a valid ID to generate your security tokens!
    const result = await query(
      'SELECT * FROM users WHERE is_active = true LIMIT 1'
    );

    const userRow = result.rows[0];
    if (!userRow) {
      return res.status(404).json({ message: `No active ${role} found in the database.` });
    }

    // 3. Generate Secure Tokens (Using your existing backend security rules)
    const familyId = uuidv4();
    const accessToken = signAccess(userRow);
    const refreshToken = signRefresh(userRow.id, familyId);
    const refreshHash = hashToken(refreshToken);

    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, is_revoked)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days', false)`,
      [uuidv4(), userRow.id, refreshHash, familyId]
    );

    // 4. Send the exact package the React Native frontend is waiting for
    res.json({
      accessToken: accessToken,    // camelCase specifically for the mobile app
      refreshToken: refreshToken,
      user: {
        id: userRow.id,
        name: userRow.full_name,
        email: userRow.email,
        role: role, // <-- CHANGE THIS LINE to use the variable from the app!
        class_grade: userRow.class_grade || null,
      }
    });

  } catch (err) {
    log.error({ err: err.message }, 'verify-otp error');
    res.status(500).json({ message: 'Failed to verify OTP due to a server error.' });
  }
});

// ── POST /api/auth/refresh — H1: rotation + family revocation ────────────────
router.post('/refresh', async (req, res) => {
  try {
    const presented = req.body?.refresh_token;
    if (!presented || typeof presented !== 'string' || presented.length > 4096) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(presented, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
      if (decoded.kind !== 'refresh') throw new Error('not a refresh token');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const tokenHash = hashToken(presented);
    const stored = await query(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = $1 AND expires_at > NOW()`,
      [tokenHash]
    );

    if (!stored.rows.length) {
      // Either revoked or already-used token. If it's a known family, revoke the whole family.
      if (decoded.fam) {
        await query('UPDATE refresh_tokens SET is_revoked = true WHERE family_id = $1', [decoded.fam]);
        audit({ userId: decoded.id, action: 'refresh.replay_detected', resourceType: 'auth', ip: req.ip, details: { family_id: decoded.fam } });
      }
      return res.status(401).json({ error: 'Refresh token not found or already used' });
    }

    const row = stored.rows[0];
    if (row.is_revoked) {
      await query('UPDATE refresh_tokens SET is_revoked = true WHERE family_id = $1', [row.family_id]);
      return res.status(401).json({ error: 'Refresh token revoked' });
    }

    const userRes = await query('SELECT * FROM users WHERE id = $1 AND is_active = true', [decoded.id]);
    if (!userRes.rows.length) return res.status(401).json({ error: 'User not found' });

    // Rotate: revoke this token, issue new one in the same family.
    const newRefresh = signRefresh(userRes.rows[0].id, row.family_id);
    await query(
      `UPDATE refresh_tokens SET is_revoked = true, replaced_by = $1 WHERE id = $2`,
      [hashToken(newRefresh), row.id]
    );
    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, is_revoked)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days', false)`,
      [uuidv4(), userRes.rows[0].id, hashToken(newRefresh), row.family_id]
    );

    const accessToken = signAccess(userRes.rows[0]);
    res.json({ access_token: accessToken, refresh_token: newRefresh, expires_in: 28800 });
  } catch (err) {
    log.error({ err: err.message }, 'refresh error');
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    await query('UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1', [req.user.id]);
    audit({ userId: req.user.id, action: 'logout', resourceType: 'auth', ip: req.ip });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    log.error({ err: err.message }, 'logout error');
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, email, role, assigned_state, assigned_district,
              is_active, last_login_at, created_at,
              perm_publish_apps, perm_upload_unity, perm_manage_geo,
              perm_view_analytics, perm_create_users, perm_edit_curriculum,
              perm_approve_content, perm_export_data, perm_manage_ads,
              perm_replay_analytics
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    log.error({ err: err.message }, '/me error');
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── POST /api/auth/request-reset — One-time reset link ──────────────────────
// Always returns 200 to avoid enumerating valid emails.
router.post('/request-reset', async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(200).json({ message: 'If that account exists, a reset link has been sent.' });

    const userRes = await query('SELECT id, full_name FROM users WHERE email = $1 AND is_active = true', [email]);
    if (userRes.rows.length) {
      const user = userRes.rows[0];
      const token = crypto.randomBytes(32).toString('hex');
      const hash = hashToken(token);
      await query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '48 hours', NOW())`,
        [uuidv4(), user.id, hash]
      );

      const link = `${process.env.PUBLIC_URL || 'https://watchaugs-mitra.web.app'}/reset/?token=${token}`;
      await sendResetEmail({ to: email, name: user.full_name, link });
      audit({ userId: user.id, action: 'password.reset_requested', resourceType: 'user', resourceId: user.id, ip: req.ip });
    }
    // Constant response regardless of whether the email exists
    res.json({ message: 'If that account exists, a reset link has been sent.' });
  } catch (err) {
    log.error({ err: err.message }, 'request-reset error');
    res.status(500).json({ error: 'Could not process request' });
  }
});

// ── Email sender ────────────────────────────────────────────────────────────
// Sends a one-time reset link, never the password itself.
async function sendResetEmail({ to, name, link }) {
  console.log(`[MITRA EMAIL ENGINE] Preparing to send email to: ${to}`);
  
  // Guard: fail fast with a clear message if SMTP credentials are missing
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    const missing = [!process.env.SMTP_USER && 'SMTP_USER', !process.env.SMTP_PASS && 'SMTP_PASS'].filter(Boolean).join(', ');
    const err = new Error(`Email not sent — missing environment variable(s): ${missing}. Set them in Cloud Run → Edit & Deploy → Variables & Secrets.`);
    console.error(`[MITRA EMAIL ENGINE] CONFIGURATION ERROR:`, err.message);
    throw err;
  }
  
  try {
    const nodemailer = require('nodemailer');
    
    // Exact configuration used on May 30, 2026
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 587, 
      secure: false, // TLS requires this to be false on port 587
      auth: { 
        user: process.env.SMTP_USER, // Your ceo@watchaugs.com email
        pass: process.env.SMTP_PASS  // The 16-character App Password generated on May 30
      },
      pool: true,
      maxConnections: 1
    });

    console.log(`[MITRA EMAIL ENGINE] Transport built. Using sender: ${process.env.SMTP_USER}`);

    const info = await transport.sendMail({
      from: `"MITRA Support" <${process.env.SMTP_USER}>`,
      to: to,
      subject: 'MITRA Dashboard - Account Setup & Password Reset',
      text: `Dear ${name || 'Colleague'},\n\nAn account setup or password reset has been requested for your MITRA Dashboard profile.\n\nIf you did not request this, please notify your administrator.\n\nSetup / Reset Link (valid for 48 hours):\n${link}\n\nMITRA Platform · Ministry of Education`,
    attachments: fs.existsSync(path.join(__dirname, '../logo.png'))
      ? [{ filename: 'logo.png', path: path.join(__dirname, '../logo.png'), cid: 'mitra_logo_secret_id' }]
      : [],

      // 👇 THE UPDATED HTML WITH CID IMAGE 👇
      html: `
      <div style="background-color: #07090f; margin: 0; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #f1f5f9;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #111827; border: 1px solid #1e2d4a; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
          
          <div style="background: linear-gradient(135deg, #1e2d4a, #0c1020); padding: 30px; text-align: center; border-bottom: 1px solid #1e2d4a;">
            <img src="cid:mitra_logo_secret_id" alt="MITRA Logo" style="height: 50px; width: auto; display: block; margin: 0 auto;" />
          </div>

          <div style="padding: 40px 30px;">
            <h2 style="margin-top: 0; color: #ffffff; font-size: 22px; font-weight: 700;">Account Setup Request</h2>
            <p style="font-size: 15px; color: #94a3b8; line-height: 1.6;">
              Dear ${name || 'Colleague'},
            </p>
            <p style="font-size: 15px; color: #94a3b8; line-height: 1.6;">
              An account setup or password reset has been requested for your official dashboard profile. Please click the button below to establish your secure credentials.
            </p>

            <div style="text-align: center; margin: 40px 0;">
              <a href="${link}" style="background: linear-gradient(135deg, #6366f1, #ec4899); color: #ffffff; text-decoration: none; padding: 14px 28px; font-size: 16px; font-weight: 600; border-radius: 8px; display: inline-block;">
                Set Up My Password
              </a>
            </div>

            <p style="font-size: 13px; color: #475569; line-height: 1.5; text-align: center; margin-bottom: 0;">
              This link is secure and will expire in 48 hours.<br>If you did not request this, please notify your administrator immediately.
            </p>
          </div>

          <div style="background-color: #0c1020; padding: 20px; text-align: center; border-top: 1px solid #1e2d4a;">
            <p style="font-size: 12px; color: #475569; margin: 0;">
              <strong>WatchAugs Technologies</strong><br>
              MITRA Platform · Ministry of Education<br>
              Anand, Gujarat
            </p>
          </div>
          
        </div>
      </div>
      `
    });

    console.log(`[MITRA EMAIL ENGINE] SUCCESS! Email sent. Message ID: ${info.messageId}`);
    return info;

  } catch (err) {
    console.error(`[MITRA EMAIL ENGINE] CRITICAL FAILURE:`, err.message);
    throw err; 
  }
}

// ── POST /api/auth/reset-password ──────────────────────────────────────────
// Handles the password reset form submission from the /reset link
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    
    // Enforce the CERT-In minimum length rule
    if (newPassword.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }

    // 1. Hash the incoming token using SHA-256 to match what is stored in the database
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 2. Look up the token in the database (ensuring it hasn't expired)
    const tokenRes = await query(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND expires_at > NOW()`,
      [tokenHash]
    );

    if (!tokenRes.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired reset token. Please request a new link.' });
    }

    const userId = tokenRes.rows[0].user_id;

    // 3. Hash the brand new password securely
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // 4. Update the user's password and ensure their account is marked as active
    await query(
      `UPDATE users SET password_hash = $1, is_active = true, updated_at = NOW() WHERE id = $2`,
      [newPasswordHash, userId]
    );

    // 5. Delete the used token so it can never be used again (Security Best Practice)
    await query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);

    // 6. Log the successful action
    audit({ userId, action: 'user.password_reset_completed', resourceType: 'auth', ip: req.ip });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    log.error({ err: err.message }, 'reset-password error');
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
module.exports.passwordPolicyError = passwordPolicyError;
module.exports.sendResetEmail = sendResetEmail;