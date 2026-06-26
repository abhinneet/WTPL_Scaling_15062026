/**
 * lib/firebase.js — Firebase Admin SDK initialization (v12+ modular API)
 *
 * Handles:
 * - Authentication delegation to Firebase Auth
 * - Cloud Storage for AR assets, advertisements, Unity builds
 * - Firestore for student telemetry
 * - Cloud Functions integration
 *
 * This module MUST be initialized before any Firebase services are used.
 */

'use strict';

const { initializeApp, cert, deleteApp } = require('firebase-admin/app');
const { getAuth: getAuthForApp } = require('firebase-admin/auth');
const { getFirestore: getFirestoreForApp } = require('firebase-admin/firestore');
const { getStorage: getStorageForApp } = require('firebase-admin/storage');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

let firebaseApp = null;
let initPromise = null;

/**
 * Throw a consistent error if Firebase hasn't been initialized yet.
 */
function requireInitialized() {
  if (!firebaseApp) {
    throw new Error('Firebase not initialized. Call firebase.init() first.');
  }
  return firebaseApp;
}

/**
 * Load and parse the service account JSON from disk.
 */
function loadServiceAccount(keyPath) {
  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    log.error({ path: keyPath, err: err.message }, 'Failed to read service account file');
    throw new Error(`Firebase service account not found at: ${keyPath}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    log.error({ path: keyPath, err: err.message }, 'Service account file is not valid JSON');
    throw new Error(`Firebase service account at ${keyPath} is not valid JSON`);
  }
}

/**
 * Actually perform initialization.
 */
async function doInit() {
  const keyPath = process.env.FIREBASE_ADMIN_SDK_PATH ||
    path.join(__dirname, '../config/secrets/mitra-production-core-firebase-adminsdk-fbsvc-db61242ba7.json');

  const serviceAccount = loadServiceAccount(keyPath);

  const projectId = process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id;
  const storageBucket = process.env.STORAGE_BUCKET ||
    `${projectId}.appspot.com`;

  try {
    const app = initializeApp({
      credential: cert(serviceAccount),
      projectId,
      storageBucket,
      databaseURL: `https://${projectId}.firebaseio.com`
    });

    log.info({ projectId, storageBucket }, 'Firebase Admin SDK initialized successfully');
    return app;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to initialize Firebase app');
    throw err;
  }
}

/**
 * Initialize Firebase Admin SDK with service account credentials.
 * Safe to call multiple times — all callers share the same initialization.
 */
async function init() {
  if (firebaseApp) {
    log.info('Firebase already initialized, returning existing instance');
    return firebaseApp;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doInit()
    .then(app => {
      firebaseApp = app;
      return app;
    })
    .catch(err => {
      log.fatal({ err: err.message, stack: err.stack }, 'Firebase initialization failed');
      throw err;
    })
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
}

/**
 * Get Firebase Auth instance
 */
function getAuth() {
  const app = requireInitialized();
  return getAuthForApp(app);
}

/**
 * Get Cloud Storage bucket reference
 */
function getStorage() {
  const app = requireInitialized();
  return getStorageForApp(app);
}

/**
 * Get Firestore instance
 */
function getFirestore() {
  const app = requireInitialized();
  return getFirestoreForApp(app);
}

/**
 * Verify ID token from Firebase Auth
 */
async function verifyIdToken(token) {
  try {
    const auth = getAuth();
    const decodedToken = await auth.verifyIdToken(token);
    return decodedToken;
  } catch (err) {
    log.warn({ err: err.message }, 'Token verification failed');
    throw new Error('Invalid or expired token');
  }
}

/**
 * Create custom token for service-to-service auth
 */
async function createCustomToken(uid, claims = {}) {
  try {
    const auth = getAuth();
    const token = await auth.createCustomToken(uid, {
      role: 'service',
      ...claims
    });
    return token;
  } catch (err) {
    log.error({ err: err.message, uid }, 'Failed to create custom token');
    throw err;
  }
}

/**
 * Check if Firebase is initialized
 */
function isInitialized() {
  return firebaseApp !== null;
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  if (firebaseApp) {
    try {
      await deleteApp(firebaseApp);
      log.info('Firebase app deleted successfully');
    } catch (err) {
      log.error({ err: err.message }, 'Error deleting Firebase app');
    } finally {
      firebaseApp = null;
    }
  }
  initPromise = null;
}

module.exports = {
  init,
  getAuth,
  getStorage,
  getFirestore,
  verifyIdToken,
  createCustomToken,
  isInitialized,
  shutdown
};