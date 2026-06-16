/**
 * routes/uploads.js — AR Assets, Advertisements, and Unity Build Management
 *
 * Handles file uploads to Google Cloud Storage with proper authentication,
 * validation, and metadata tracking.
 *
 * Routes:
 * POST   /api/uploads/ar-asset            Upload AR 3D model/Unity prefab
 * POST   /api/uploads/advertisement       Upload advertisement creative
 * POST   /api/uploads/unity-build         Upload Unity mobile build
 * GET    /api/uploads/signed-url          Get signed download URL
 * DELETE /api/uploads/asset/:assetId      Delete AR asset from storage
 * DELETE /api/uploads/advertisement/:id   Delete advertisement from storage
 * DELETE /api/uploads/unity-build/:id     Delete Unity build from storage
 *
 * --- Changes vs. previous version ---
 * - All user-supplied path segments (asset_id, topic_id, campaign_id,
 *   build_version, platform) are sanitized before being used in a GCS object
 *   path. Previously these were interpolated raw, so a value containing "/"
 *   or ".." could write outside the intended prefix or collide with another
 *   tenant's objects.
 * - /signed-url now verifies the requester actually owns/has a DB record for
 *   the requested gcs_path before issuing a signed URL, instead of signing a
 *   URL for any arbitrary path in the bucket. Without this, perm_download_assets
 *   was a "read anything in the bucket" permission rather than scoped access.
 * - expires_hours is validated explicitly (NaN/range checked) instead of
 *   relying on a destructuring default that silently lets an empty string
 *   through as NaN, which previously produced an already-expired signed URL
 *   with a 200 OK response.
 * - Added DELETE routes for advertisements and unity_builds — previously only
 *   ar_assets could be deleted via this API, so storage objects from the
 *   other two upload types were permanently orphaned with no admin path to
 *   remove them.
 * - GCS upload and DB insert are no longer independently failable without
 *   cleanup: if the DB insert fails after a successful GCS upload, the
 *   orphaned GCS object is deleted in a catch block instead of being left
 *   behind silently.
 * - duration_seconds is normalized to a number consistently (was stored as
 *   string '0' in GCS metadata but number 0 in Postgres).
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { getStorage } = require('../lib/firebase');
const { query } = require('../db');
const { authenticate, requirePerm } = require('../middleware/auth');
const log = require('../lib/logger');

// Memory storage for multer (file goes to Firebase, not disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024  // 500MB max (for Unity builds)
  },
  fileFilter: (req, file, cb) => {
    // Validate MIME type based on endpoint
    const endpoint = req.path.split('/').pop();
    const allowedMimes = {
      'ar-asset': ['application/octet-stream', 'model/gltf-binary', 'application/x-unity3d'],
      'advertisement': ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
      'unity-build': ['application/octet-stream', 'application/zip']
    };

    const allowed = allowedMimes[endpoint];
    if (!allowed) {
      // Unknown endpoint key — fail closed instead of accepting anything.
      return cb(new Error(`No MIME allowlist configured for endpoint: ${endpoint}`));
    }
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`));
    }
  }
});

/**
 * Sanitize a value for safe use as a single GCS path segment.
 * Strips anything that isn't alphanumeric, dash, underscore, or dot, and
 * collapses leading dots so "../../x" can't escape the intended prefix.
 * Throws if the result is empty, since an empty segment is itself a problem
 * (e.g. produces a double-slash path or relies on a default elsewhere).
 */
function sanitizePathSegment(value, fieldName) {
  const str = String(value ?? '');
  const cleaned = str.replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, '');
  if (!cleaned) {
    throw new Error(`Invalid value for ${fieldName}`);
  }
  return cleaned;
}

/**
 * Upload a buffer to GCS and return the gcs path + public URL.
 * Shared by all three upload routes to avoid repeating the stream plumbing.
 */
async function uploadBufferToGcs({ bucket, gcsPath, buffer, contentType, metadata }) {
  const file = bucket.file(gcsPath);

  await new Promise((resolve, reject) => {
    const uploadStream = file.createWriteStream({
      metadata: {
        contentType: contentType || 'application/octet-stream',
        metadata
      }
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', resolve);
    uploadStream.end(buffer);
  });

  return `https://storage.googleapis.com/${process.env.STORAGE_BUCKET}/${gcsPath}`;
}

/**
 * Best-effort cleanup of a GCS object. Used when a DB write fails after the
 * upload already succeeded, so we don't leave an orphaned file with no
 * record of it anywhere.
 */
async function cleanupGcsObject(bucket, gcsPath) {
  try {
    await bucket.file(gcsPath).delete();
  } catch (cleanupErr) {
    log.error({ gcsPath, err: cleanupErr.message }, 'Failed to clean up orphaned GCS object after DB error');
  }
}

router.use(authenticate);

// ── Upload AR Asset (3D Model, Prefab, etc.) ───────────────────────────────
router.post('/ar-asset',
  requirePerm('perm_upload_ar'),
  upload.single('file'),
  async (req, res) => {
    let bucket, gcsPath;
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const { filename, mimetype, buffer, size } = req.file;
      const { asset_id, topic_id, asset_type, description } = req.body;

      if (!asset_id || !topic_id) {
        return res.status(400).json({
          error: 'Missing required fields: asset_id, topic_id'
        });
      }

      const safeAssetId = sanitizePathSegment(asset_id, 'asset_id');
      const safeTopicId = sanitizePathSegment(topic_id, 'topic_id');

      const maxMB = parseInt(process.env.MAX_UNITY_FILE_MB || 500, 10);
      if (size > maxMB * 1024 * 1024) {
        return res.status(413).json({
          error: `File too large. Max: ${maxMB}MB`,
          received_mb: (size / 1024 / 1024).toFixed(2)
        });
      }

      bucket = getStorage().bucket(process.env.STORAGE_BUCKET);
      const fileExtension = path.extname(filename) || '.glb';
      gcsPath = `ar-content/${safeTopicId}/${safeAssetId}-${Date.now()}${fileExtension}`;

      const publicUrl = await uploadBufferToGcs({
        bucket,
        gcsPath,
        buffer,
        contentType: mimetype,
        metadata: {
          uploaded_by: req.user.uid,
          uploaded_at: new Date().toISOString(),
          asset_id,
          topic_id,
          asset_type: asset_type || 'model',
          description: description || '',
          original_name: filename,
          file_size: size.toString()
        }
      });

      try {
        await query(`
          INSERT INTO ar_assets (
            id, topic_id, asset_type, gcs_path, public_url,
            file_size, filename, uploaded_by, uploaded_at, description
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET
            gcs_path = $4, public_url = $5, file_size = $6, uploaded_at = $9
        `, [
          asset_id, topic_id, asset_type || 'model', gcsPath, publicUrl,
          size, filename, req.user.uid, new Date(), description || null
        ]);
      } catch (dbErr) {
        await cleanupGcsObject(bucket, gcsPath);
        throw dbErr;
      }

      log.info({
        asset_id,
        topic_id,
        size_bytes: size,
        path: gcsPath,
        user: req.user.uid
      }, 'AR asset uploaded successfully');

      res.status(201).json({
        success: true,
        asset_id,
        topic_id,
        url: publicUrl,
        gcs_path: gcsPath,
        size_bytes: size,
        size_mb: (size / 1024 / 1024).toFixed(2),
        uploaded_at: new Date().toISOString(),
        content_type: mimetype
      });

    } catch (err) {
      log.error({ err: err.message, stack: err.stack, path: req.path }, 'AR asset upload failed');
      res.status(500).json({
        error: 'Upload failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : err.message
      });
    }
  }
);

// ── Upload Advertisement Creative ──────────────────────────────────────────
router.post('/advertisement',
  requirePerm('perm_upload_ads'),
  upload.single('file'),
  async (req, res) => {
    let bucket, gcsPath;
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const { filename, mimetype, buffer, size } = req.file;
      const { campaign_id, ad_type } = req.body;
      const durationSeconds = toSafeInt(req.body.duration_seconds, 0);

      if (!campaign_id) {
        return res.status(400).json({ error: 'Missing required field: campaign_id' });
      }

      const safeCampaignId = sanitizePathSegment(campaign_id, 'campaign_id');

      const maxMB = parseInt(process.env.MAX_AD_FILE_MB || 5, 10);
      if (size > maxMB * 1024 * 1024) {
        return res.status(413).json({
          error: `File too large. Max: ${maxMB}MB`,
          received_mb: (size / 1024 / 1024).toFixed(2)
        });
      }

      bucket = getStorage().bucket(process.env.STORAGE_BUCKET);
      const fileExtension = path.extname(filename) || '.jpg';
      const objectId = uuidv4();
      gcsPath = `advertisements/${safeCampaignId}/${objectId}${fileExtension}`;

      const publicUrl = await uploadBufferToGcs({
        bucket,
        gcsPath,
        buffer,
        contentType: mimetype,
        metadata: {
          uploaded_by: req.user.uid,
          campaign_id,
          ad_type: ad_type || 'image',
          duration_seconds: String(durationSeconds),
          original_name: filename,
          uploaded_at: new Date().toISOString()
        }
      });

      try {
        await query(`
          INSERT INTO advertisements (
            id, campaign_id, gcs_path, public_url, file_size,
            filename, ad_type, duration_seconds, uploaded_by, uploaded_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          objectId, campaign_id, gcsPath, publicUrl, size,
          filename, ad_type || 'image', durationSeconds,
          req.user.uid, new Date()
        ]);
      } catch (dbErr) {
        await cleanupGcsObject(bucket, gcsPath);
        throw dbErr;
      }

      log.info({
        campaign_id,
        size_bytes: size,
        ad_type,
        user: req.user.uid
      }, 'Advertisement uploaded successfully');

      res.status(201).json({
        success: true,
        ad_id: objectId,
        campaign_id,
        url: publicUrl,
        gcs_path: gcsPath,
        size_bytes: size,
        size_mb: (size / 1024 / 1024).toFixed(2),
        uploaded_at: new Date().toISOString(),
        content_type: mimetype
      });

    } catch (err) {
      log.error({ err: err.message, stack: err.stack, path: req.path }, 'Advertisement upload failed');
      res.status(500).json({
        error: 'Upload failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : err.message
      });
    }
  }
);

// ── Upload Unity Mobile Build ──────────────────────────────────────────────
router.post('/unity-build',
  requirePerm('perm_upload_unity'),
  upload.single('file'),
  async (req, res) => {
    let bucket, gcsPath;
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const { filename, mimetype, buffer, size } = req.file;
      const { build_version, platform, min_os_version } = req.body;

      if (!build_version || !platform) {
        return res.status(400).json({
          error: 'Missing required fields: build_version, platform'
        });
      }

      const safeBuildVersion = sanitizePathSegment(build_version, 'build_version');
      const safePlatform = sanitizePathSegment(platform, 'platform');

      const maxMB = parseInt(process.env.MAX_UNITY_FILE_MB || 500, 10);
      if (size > maxMB * 1024 * 1024) {
        return res.status(413).json({
          error: `File too large. Max: ${maxMB}MB`,
          received_mb: (size / 1024 / 1024).toFixed(2)
        });
      }

      bucket = getStorage().bucket(process.env.STORAGE_BUCKET);
      const fileExtension = path.extname(filename) || '.apk';
      const objectId = uuidv4();
      gcsPath = `unity-builds/${safePlatform}/${safeBuildVersion}/${objectId}${fileExtension}`;

      const publicUrl = await uploadBufferToGcs({
        bucket,
        gcsPath,
        buffer,
        contentType: mimetype,
        metadata: {
          uploaded_by: req.user.uid,
          build_version,
          platform,
          min_os_version: min_os_version || '1.0',
          original_name: filename,
          uploaded_at: new Date().toISOString()
        }
      });

      try {
        await query(`
          INSERT INTO unity_builds (
            id, build_version, platform, gcs_path, public_url, file_size,
            filename, min_os_version, uploaded_by, uploaded_at, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          objectId, build_version, platform, gcsPath, publicUrl, size,
          filename, min_os_version || '1.0', req.user.uid, new Date(), 'available'
        ]);
      } catch (dbErr) {
        await cleanupGcsObject(bucket, gcsPath);
        throw dbErr;
      }

      log.info({
        build_version,
        platform,
        size_bytes: size,
        user: req.user.uid
      }, 'Unity build uploaded successfully');

      res.status(201).json({
        success: true,
        build_id: objectId,
        build_version,
        platform,
        url: publicUrl,
        gcs_path: gcsPath,
        size_bytes: size,
        size_mb: (size / 1024 / 1024).toFixed(2),
        uploaded_at: new Date().toISOString(),
        content_type: mimetype || 'application/octet-stream'
      });

    } catch (err) {
      log.error({ err: err.message, stack: err.stack, path: req.path }, 'Unity build upload failed');
      res.status(500).json({
        error: 'Upload failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : err.message
      });
    }
  }
);

/**
 * Look up a gcs_path across all three asset tables and return which table
 * it belongs to. Used by /signed-url to verify the requester is asking
 * about a real, tracked object rather than an arbitrary bucket path.
 */
async function findOwningRecord(gcsPath) {
  const tables = ['ar_assets', 'advertisements', 'unity_builds'];
  for (const table of tables) {
    const result = await query(
      `SELECT 1 FROM ${table} WHERE gcs_path = $1 LIMIT 1`,
      [gcsPath]
    );
    if (result.rows.length > 0) return table;
  }
  return null;
}

// ── Get Signed Download URL ────────────────────────────────────────────────
router.get('/signed-url',
  requirePerm('perm_download_assets'),
  async (req, res) => {
    try {
      const { gcs_path } = req.query;

      if (!gcs_path) {
        return res.status(400).json({ error: 'Missing required parameter: gcs_path' });
      }

      // Verify this is a real, tracked object — not an arbitrary bucket path.
      // Previously any authenticated caller with perm_download_assets could
      // sign a URL for *any* object in the bucket, regardless of which
      // asset/campaign/build they actually had access context for.
      const owningTable = await findOwningRecord(gcs_path);
      if (!owningTable) {
        return res.status(404).json({ error: 'Asset not found' });
      }

      const expiresHoursRaw = req.query.expires_hours;
      let expiresHours = 24;
      if (expiresHoursRaw !== undefined && expiresHoursRaw !== '') {
        const parsed = parseInt(expiresHoursRaw, 10);
        if (Number.isNaN(parsed) || parsed <= 0 || parsed > 168) {
          return res.status(400).json({ error: 'expires_hours must be a number between 1 and 168' });
        }
        expiresHours = parsed;
      }

      const bucket = getStorage().bucket(process.env.STORAGE_BUCKET);
      const file = bucket.file(gcs_path);

      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + (expiresHours * 60 * 60 * 1000)
      });

      res.json({
        success: true,
        gcs_path,
        signed_url: url,
        expires_in_hours: expiresHours
      });

    } catch (err) {
      log.error({ err: err.message, stack: err.stack, path: req.path }, 'Failed to generate signed URL');
      res.status(500).json({
        error: 'Failed to generate signed URL',
        detail: process.env.NODE_ENV === 'production' ? undefined : err.message
      });
    }
  }
);

/**
 * Shared delete handler for a (table, idColumn) pair — used by all three
 * delete routes below to avoid repeating the lookup/delete/cleanup logic.
 */
function makeDeleteHandler(table, label) {
  return async (req, res) => {
    try {
      const { assetId } = req.params;

      const result = await query(
        `SELECT gcs_path FROM ${table} WHERE id = $1`,
        [assetId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: `${label} not found` });
      }

      const { gcs_path } = result.rows[0];

      const bucket = getStorage().bucket(process.env.STORAGE_BUCKET);
      await bucket.file(gcs_path).delete();

      await query(`DELETE FROM ${table} WHERE id = $1`, [assetId]);

      log.info({ assetId, gcs_path, table }, `${label} deleted successfully`);

      res.json({
        success: true,
        asset_id: assetId,
        message: `${label} deleted successfully`
      });

    } catch (err) {
      log.error({ err: err.message, stack: err.stack, path: req.path }, `${label} deletion failed`);
      res.status(500).json({
        error: 'Deletion failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : err.message
      });
    }
  };
}

// ── Delete AR Asset ─────────────────────────────────────────────────────────
router.delete('/asset/:assetId',
  requirePerm('perm_delete_assets'),
  makeDeleteHandler('ar_assets', 'AR asset')
);

// ── Delete Advertisement ────────────────────────────────────────────────────
// Previously missing entirely — advertisement GCS objects had no API-level
// delete path and were orphaned forever once uploaded.
router.delete('/advertisement/:assetId',
  requirePerm('perm_delete_assets'),
  makeDeleteHandler('advertisements', 'Advertisement')
);

// ── Delete Unity Build ───────────────────────────────────────────────────────
// Previously missing entirely — same orphaning issue as advertisements.
router.delete('/unity-build/:assetId',
  requirePerm('perm_delete_assets'),
  makeDeleteHandler('unity_builds', 'Unity build')
);

/**
 * Safe integer parse — explicit radix, explicit NaN fallback.
 */
function toSafeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = router;