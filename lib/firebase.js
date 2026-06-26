'use strict';

const { initializeApp, cert, getApps, deleteApp } = require('firebase-admin/app');
const { getAuth: getAuthForApp } = require('firebase-admin/auth');
const { getFirestore: getFirestoreForApp } = require('firebase-admin/firestore');
const { getStorage: getStorageForApp } = require('firebase-admin/storage');
const log = require('./logger');

let firebaseApp = null;

function requireInitialized() {
  if (!firebaseApp) {
    throw new Error('Firebase not initialized. Call firebase.init() first.');
  }
  return firebaseApp;
}

async function init() {
  if (firebaseApp) return firebaseApp;
  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    return firebaseApp;
  }

  const projectId   = process.env.FIREBASE_PROJECT_ID || 'mitra-production-core';
  const storageBucket = process.env.STORAGE_BUCKET    || 'mitra-production-core.firebasestorage.app';

  try {
    // On Cloud Run: Application Default Credentials are automatic.
    // No JSON file needed — the service account attached to the Cloud Run
    // service is used automatically by Google's SDK.
    const { applicationDefault } = require('firebase-admin/app');
    firebaseApp = initializeApp({
      credential: applicationDefault(),
      projectId,
      storageBucket,
    });

    log.info({ projectId, storageBucket }, 'Firebase Admin SDK initialized (ADC)');
    return firebaseApp;
  } catch (err) {
    log.fatal({ err: err.message, stack: err.stack }, 'Firebase initialization failed');
    throw err;
  }
}

function getAuth()      { return getAuthForApp(requireInitialized()); }
function getStorage()   { return getStorageForApp(requireInitialized()); }
function getFirestore() { return getFirestoreForApp(requireInitialized()); }

async function verifyIdToken(token) {
  try {
    return await getAuth().verifyIdToken(token);
  } catch (err) {
    log.warn({ err: err.message }, 'Token verification failed');
    throw new Error('Invalid or expired token');
  }
}

async function createCustomToken(uid, claims = {}) {
  try {
    return await getAuth().createCustomToken(uid, { role: 'service', ...claims });
  } catch (err) {
    log.error({ err: err.message, uid }, 'Failed to create custom token');
    throw err;
  }
}

function isInitialized() { return firebaseApp !== null; }

async function shutdown() {
  if (firebaseApp) {
    try   { await deleteApp(firebaseApp); log.info('Firebase app deleted'); }
    catch (err) { log.error({ err: err.message }, 'Error deleting Firebase app'); }
    finally { firebaseApp = null; }
  }
}

module.exports = { init, getAuth, getStorage, getFirestore, verifyIdToken, createCustomToken, isInitialized, shutdown };