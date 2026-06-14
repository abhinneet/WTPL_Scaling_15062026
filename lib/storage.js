/**
 * lib/storage.js — Storage abstraction
 *
 * Hides the difference between:
 *   - Local filesystem (`./uploads/...`)        ← for `npm run dev`
 *   - Google Cloud Storage bucket               ← for Cloud Run / production
 *
 * The choice is automatic: if STORAGE_BUCKET is set, GCS is used; otherwise
 * the local filesystem under UPLOAD_DIR is used.
 *
 * Routes never touch fs or @google-cloud/storage directly. They call:
 *   await storage.put(buffer, key, { contentType })
 *   const stream = await storage.getStream(key)
 *   const url    = await storage.signedUrl(key, { expiresInMin: 10 })
 *   await storage.delete(key)
 *
 * Object keys are namespaced: `${category}/${uuid}.${ext}` — never user-supplied.
 *
 * Security fixes via this layer:
 *   - H5: MIME sniffed via file-type before put()
 *   - H6: Routes return only opaque keys; absolute paths never leave the server
 *   - C5: signedUrl() requires the caller to have already authorised the request
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const log = require('./logger');

// -------------------------------------------------------------------- file-type
// Lazy load: in older Node we use file-type v16 (CommonJS); v17+ is ESM-only.
let fileTypeFromBuffer;
try {
  // file-type@16 CJS
  // eslint-disable-next-line global-require
  fileTypeFromBuffer = require('file-type').fromBuffer;
} catch (_) {
  // Fallback: don't sniff. (Allowlist still applies.)
  fileTypeFromBuffer = async () => null;
}

// -------------------------------------------------------------------- MIME map
// Allowed (extension, MIME) per category. extension MUST match detected MIME.
const ALLOW = {
  ad_media: [
    ['.mp4',  'video/mp4'],
    ['.webm', 'video/webm'],
    ['.ogg',  'video/ogg'],
    ['.jpg',  'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png',  'image/png'],
    ['.gif',  'image/gif'],
    ['.webp', 'image/webp'],
  ],
  app_assets: [
    ['.png',  'image/png'],
    ['.jpg',  'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg',  'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.gif',  'image/gif'],
  ],
  quiz_xlsx: [
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.xls',  'application/vnd.ms-excel'],
    ['.csv',  'text/csv'],
  ],
  // Unity packages are large binary blobs; we don't sniff MIME but we cap size
  // and the file is always served with Content-Disposition: attachment.
  unity_assets: [
    ['.unitypackage', null],
    ['.assetbundle',  null],
    ['.glb',          'model/gltf-binary'],
    ['.gltf',         'model/gltf+json'],
    ['.fbx',          null],
    ['.obj',          null],
    ['.zip',          'application/zip'],
  ],
};

class StorageError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// -------------------------------------------------------------------- back-ends
class LocalBackend {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }
  _full(key) { return path.join(this.root, key); }

  async put(buffer, key, { contentType }) {
    const full = this._full(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    return { key, size: buffer.length, contentType, etag: crypto.createHash('md5').update(buffer).digest('hex') };
  }

  async exists(key) { return fs.existsSync(this._full(key)); }

  async getStream(key) {
    const full = this._full(key);
    if (!fs.existsSync(full)) throw new StorageError('Not found', 404);
    return fs.createReadStream(full);
  }

  async signedUrl(key, { expiresInMin = 10 } = {}) {
    // Local mode: return a signed app-level path. (The route serves it.)
    const exp = Date.now() + expiresInMin * 60 * 1000;
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'local')
      .update(`${key}|${exp}`).digest('hex').slice(0, 24);
    return `/api/uploads/file/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  }

  verifySignedUrl(key, exp, sig) {
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'local')
      .update(`${key}|${exp}`).digest('hex').slice(0, 24);
    return Number(exp) > Date.now() && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  async delete(key) {
    try { fs.unlinkSync(this._full(key)); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
}

class GcsBackend {
  constructor(bucketName) {
    // eslint-disable-next-line global-require
    const { Storage } = require('@google-cloud/storage');
    this.client = new Storage();
    this.bucket = this.client.bucket(bucketName);
    this.bucketName = bucketName;
  }

  async put(buffer, key, { contentType, disposition }) {
    const file = this.bucket.file(key);
    await file.save(buffer, {
      contentType,
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=0, no-store',
        contentDisposition: disposition || undefined,
      },
    });
    return { key, size: buffer.length, contentType };
  }

  async exists(key) {
    const [exists] = await this.bucket.file(key).exists();
    return exists;
  }

  async getStream(key) {
    const exists = await this.exists(key);
    if (!exists) throw new StorageError('Not found', 404);
    return this.bucket.file(key).createReadStream();
  }

  async signedUrl(key, { expiresInMin = 10 } = {}) {
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInMin * 60 * 1000,
    });
    return url;
  }

  async delete(key) {
    try { await this.bucket.file(key).delete(); return true; }
    catch (e) { if (e.code === 404) return false; throw e; }
  }
}

// -------------------------------------------------------------------- factory
let backend;
function getBackend() {
  if (backend) return backend;
  if (process.env.STORAGE_BUCKET) {
    log.info({ bucket: process.env.STORAGE_BUCKET }, 'Storage backend: GCS');
    backend = new GcsBackend(process.env.STORAGE_BUCKET);
  } else {
    const root = process.env.UPLOAD_DIR || './uploads';
    log.info({ root }, 'Storage backend: local filesystem');
    backend = new LocalBackend(root);
  }
  return backend;
}

// -------------------------------------------------------------------- validation
function safeExt(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!ext || ext.length > 12 || !/^\.[a-z0-9.]+$/i.test(ext)) {
    throw new StorageError('Invalid file extension', 400);
  }
  // Handle the .tar.gz edge case (M4)
  if (/\.tar$/.test(path.basename(originalName, ext))) {
    return '.tar' + ext; // e.g. ".tar.gz"
  }
  return ext;
}

/**
 * Validate a buffer against a category's allow-list. Returns the resolved
 * { ext, contentType } or throws.
 */
async function validate(category, originalName, buffer) {
  const allow = ALLOW[category];
  if (!allow) throw new StorageError(`Unknown upload category "${category}"`, 400);

  const ext = safeExt(originalName);
  const allowedRow = allow.find(([e]) => e === ext);
  if (!allowedRow) {
    throw new StorageError(`Extension ${ext} not allowed for category ${category}`, 400);
  }

  let detectedMime = allowedRow[1]; // default: claim it matches if we can't sniff
  if (fileTypeFromBuffer && buffer.length > 0) {
    const sniff = await fileTypeFromBuffer(buffer);
    if (sniff && allowedRow[1] && sniff.mime !== allowedRow[1]) {
      // Allow MIME family match (e.g., application/vnd.openxmlformats... has many subtypes)
      const family = (m) => m.split('/')[0];
      if (family(sniff.mime) !== family(allowedRow[1])) {
        throw new StorageError(
          `File content (${sniff.mime}) does not match its extension (${ext})`, 400
        );
      }
    }
    if (sniff) detectedMime = sniff.mime;
  }

  return { ext, contentType: detectedMime || 'application/octet-stream' };
}

// -------------------------------------------------------------------- public API
/**
 * Save an in-memory buffer. Returns an object you store in `uploads.storage_key`.
 *
 * @param {string} category one of: ad_media | app_assets | quiz_xlsx | unity_assets
 * @param {string} originalName user-supplied filename (used only for extension)
 * @param {Buffer} buffer the file bytes
 * @param {object} [opts]
 * @returns {Promise<{key, size, contentType, originalName}>}
 */
async function put(category, originalName, buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer)) throw new StorageError('Buffer required', 400);

  const maxBytes = opts.maxBytes || categoryMaxBytes(category);
  if (buffer.length > maxBytes) {
    throw new StorageError(`File too large (${buffer.length} > ${maxBytes})`, 413);
  }

  const { ext, contentType } = await validate(category, originalName, buffer);

  const key = `${category}/${uuidv4()}${ext}`;
  // Images we display inline; everything else gets Content-Disposition: attachment.
  const inline = /^image\//.test(contentType);
  const disposition = inline ? undefined : `attachment; filename="${path.basename(originalName).replace(/[^\w. -]/g, '_').slice(0, 80)}"`;

  await getBackend().put(buffer, key, { contentType, disposition });

  return { key, size: buffer.length, contentType, originalName: path.basename(originalName).slice(0, 200) };
}

function categoryMaxBytes(category) {
  return {
    ad_media:      parseInt(process.env.MAX_AD_FILE_MB,     10) || 5,
    app_assets:    parseInt(process.env.MAX_APP_ASSET_MB,   10) || 10,
    quiz_xlsx:     parseInt(process.env.MAX_QUIZ_XLSX_MB,   10) || 50,
    unity_assets:  parseInt(process.env.MAX_UNITY_MB,       10) || 500,
  }[category] * 1024 * 1024;
}

async function getStream(key)   { return getBackend().getStream(key); }
async function signedUrl(key, opts) { return getBackend().signedUrl(key, opts); }
async function exists(key)      { return getBackend().exists(key); }
async function del(key)         { return getBackend().delete(key); }
function verifySignedUrl(key, exp, sig) {
  const b = getBackend();
  return typeof b.verifySignedUrl === 'function'
    ? b.verifySignedUrl(key, exp, sig)
    : true; // GCS signs its own URLs — we just hand them off
}

module.exports = {
  put, getStream, signedUrl, exists, delete: del,
  verifySignedUrl, StorageError,
  // for tests
  _internal: { getBackend, validate, safeExt, categoryMaxBytes },
};
