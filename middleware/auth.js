/**
 * middleware/auth.js — JWT verification & RBAC guards
 *
 * Security fixes:
 *   - H11: is_active check on every request (with 60-second in-memory cache)
 *   - C2: never include error.message or stack in response bodies
 *   - Authorization header is parsed safely
 *   - Token must be < 4 KB (defends against pathological JWTs)
 */

'use strict';

const jwt = require('jsonwebtoken');
const log = require('../lib/logger');

// 60-second in-memory cache: userId → { active, role, perms, fetchedAt }
const userStatusCache = new Map();
const CACHE_TTL_MS = 60_000;
let _query;
function setDbQuery(q) { _query = q; }

function invalidateUserCache(userId) { userStatusCache.delete(userId); }

async function loadUserStatus(userId) {
  const cached = userStatusCache.get(userId);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return cached;
  if (!_query) return null;
  try {
    const result = await _query(
      'SELECT is_active, role FROM users WHERE id = $1',
      [userId]
    );
    if (!result.rows.length) return { active: false };
    const status = { active: result.rows[0].is_active, role: result.rows[0].role, fetchedAt: Date.now() };
    userStatusCache.set(userId, status);
    return status;
  } catch (err) {
    log.error({ err: err.message }, 'authenticate: user-status lookup failed');
    return null;
  }
}

/**
 * Verify Bearer token, check user is still active, attach req.user.
 */
async function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.slice(7).trim();
  if (token.length === 0 || token.length > 4096) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      maxAge: process.env.JWT_EXPIRES_IN || '8h',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }

  // H11: confirm user is still active
  if (decoded.id) {
    const status = await loadUserStatus(decoded.id);
    if (status && status.active === false) {
      return res.status(401).json({ error: 'Account deactivated', code: 'ACCOUNT_INACTIVE' });
    }
    // Prefer the live role over the JWT claim (defense against token-replay after demotion)
    if (status && status.role) decoded.role = status.role;
  }

  req.user = decoded;
  next();
}

/**
 * Require one of the listed roles.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role' });
    }
    next();
  };
}

/**
 * Require a specific permission flag (master_admin bypasses).
 */
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!req.user[perm] && req.user.role !== 'master_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

const masterAdminOnly = requireRole('master_admin');

/**
 * Role-elevation check (fixes C4): require that the actor's role is at least
 * as privileged as the role being granted, and that master_admin promotion
 * is only granted by an existing master_admin.
 */
const ROLE_RANK = {
  master_admin:    100,
  admin:           80,
  superadmin:      80,
  content_manager: 60,
  content:         60,
  district_officer: 50,
  district:        50,
  teacher:         40,
  viewer:          20,
};
function canGrantRole(actorRole, targetRole) {
  if (!targetRole) return true;
  const a = ROLE_RANK[actorRole] || 0;
  const t = ROLE_RANK[targetRole] || 0;
  if (targetRole === 'master_admin' && actorRole !== 'master_admin') return false;
  return a >= t;
}

module.exports = {
  authenticate,
  requireRole,
  requirePerm,
  masterAdminOnly,
  canGrantRole,
  setDbQuery,
  invalidateUserCache,
};
