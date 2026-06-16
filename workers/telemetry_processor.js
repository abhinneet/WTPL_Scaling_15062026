/**
 * workers/telemetry_processor.js — Firestore → BigQuery Telemetry Pipeline
 *
 * Processes student app telemetry data from Firestore and syncs it to BigQuery
 * for high-volume analytics.
 *
 * This can run as:
 * 1. A background worker (triggered by Cloud Tasks or scheduled Cloud Functions)
 * 2. A Pub/Sub subscriber (triggered by message queue)
 * 3. A long-running process in a separate pod/container
 *
 * Call with: `node workers/telemetry_processor.js start`
 *
 * --- Changes vs. previous version ---
 * - Two-phase claim/commit instead of read-then-write-after-insert. Docs are
 *   marked `processing: true` (claimed) BEFORE the BigQuery insert, so two
 *   workers polling concurrently can't grab the same batch. A stale-claim
 *   sweep unclaims docs that got stuck (e.g. worker crashed mid-batch).
 * - Deterministic `insertId` per BigQuery row (Firestore doc path) so a
 *   retried/duplicate insert is deduped by BigQuery instead of creating a
 *   second row.
 * - Firestore batch writes are chunked at the real 500-op ceiling instead of
 *   just logging a warning when the limit is reached.
 * - Stats use count() aggregation queries instead of `limit(1)` existence
 *   checks, so they're real numbers, not 0/1 guesses dressed up with
 *   Math.max(...,1).
 * - Adaptive poll loop: re-polls immediately when a full batch was processed
 *   (backlog likely), backs off to POLL_INTERVAL_MS when idle.
 * - parseInt(...) calls use radix 10 and fall back to 0 on NaN explicitly,
 *   rather than relying on `|| 0` to mask partially-numeric strings.
 */

'use strict';

const log = require('../lib/logger');

let firestore = null;
let bigquery = null;
let isRunning = false;
let loopTimer = null;

const BATCH_SIZE = 500;            // Process up to 500 docs at a time
const FIRESTORE_WRITE_LIMIT = 500; // Hard ceiling per Firestore batch commit
const POLL_INTERVAL_IDLE_MS = 5000;  // Poll cadence when queue is empty
const POLL_INTERVAL_BUSY_MS = 250;   // Poll cadence right after a full batch
const MAX_RETRIES = 3;             // Retry failed inserts 3 times
const RETRY_DELAY_MS = 1000;       // Base delay before retry (exponential)
const CLAIM_STALE_MS = 10 * 60 * 1000; // Unstick claims older than 10 minutes

/**
 * Initialize database connections
 */
async function initialize() {
  try {
    if (!firestore || !bigquery) {
      const firebase = require('../lib/firebase');
      await firebase.init();
      firestore = firebase.getFirestore();
      bigquery = require('../db').getBigQuery();
    }
    log.info('Telemetry processor initialized');
    return true;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to initialize processor');
    return false;
  }
}

/**
 * Safe integer parse — explicit radix, explicit NaN fallback.
 * Prevents silently truncating malformed values like "12abc" -> 12.
 */
function toSafeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Convert Firestore document to BigQuery row schema.
 * insertId is deterministic (doc path) so retried/duplicate inserts are
 * deduplicated by BigQuery's streaming insert dedup window.
 */
function docToBigQueryRow(doc, parentId) {
  const data = doc.data();
  const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();

  return {
    insertId: doc.ref.path,
    json: {
      document_id: doc.id,
      parent_id: parentId,
      timestamp: timestamp.toISOString(),
      student_id: data.student_id || parentId,
      school_code: data.school_code || '',
      class_grade: data.class_grade || '',
      subject: data.subject || '',
      topic_id: data.topic_id || '',
      session_minutes: toSafeInt(data.session_minutes),
      ar_module_id: data.ar_module_id || '',
      mcq_responses: data.mcq_responses ? JSON.stringify(data.mcq_responses) : null,
      offline_session: data.offline_session === true,
      app_version: data.app_version || '',
      device_id: data.device_id || '',
      network_quality: data.network_quality || 'unknown',
      sync_version: data.sync_version || 'v1',
      completion_percent: toSafeInt(data.completion_percent),
      time_spent_seconds: toSafeInt(data.time_spent_seconds),
      interactions_count: toSafeInt(data.interactions_count),
      has_ar_content: data.has_ar_content === true
    }
  };
}

/**
 * Commit Firestore updates in chunks of at most FIRESTORE_WRITE_LIMIT,
 * instead of a single batch that throws once the real ceiling is hit.
 */
async function commitInChunks(updates) {
  for (let i = 0; i < updates.length; i += FIRESTORE_WRITE_LIMIT) {
    const chunk = updates.slice(i, i + FIRESTORE_WRITE_LIMIT);
    const batch = firestore.batch();
    chunk.forEach(({ docRef, updateData }) => batch.update(docRef, updateData));
    await batch.commit();
  }
}

/**
 * Release a stale claim (processing=true but never completed/failed within
 * CLAIM_STALE_MS) so it becomes eligible for reprocessing. Run opportunistically
 * before claiming a new batch.
 */
async function sweepStaleClaims() {
  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MS);

  const staleSnapshot = await firestore
    .collectionGroup('sessions')
    .where('processing', '==', true)
    .where('processed', '==', false)
    .where('claimed_at', '<=', staleCutoff)
    .limit(BATCH_SIZE)
    .get();

  if (staleSnapshot.empty) return 0;

  const updates = staleSnapshot.docs.map(doc => ({
    docRef: doc.ref,
    updateData: { processing: false, claimed_at: null }
  }));

  await commitInChunks(updates);
  log.warn({ count: updates.length }, 'Released stale telemetry claims');
  return updates.length;
}

/**
 * Claim a batch of unprocessed, unclaimed documents by marking them
 * `processing: true` before doing any external work. This is what makes
 * concurrent workers safe — a doc claimed by one worker won't be picked up
 * by another until the claim is released or it completes.
 */
async function claimBatch() {
  const snapshot = await firestore
    .collectionGroup('sessions')
    .where('processed', '==', false)
    .where('processing', '==', false)
    .limit(BATCH_SIZE)
    .get();

  if (snapshot.empty) return [];

  const claimedAt = new Date();
  const updates = snapshot.docs.map(doc => ({
    docRef: doc.ref,
    updateData: { processing: true, claimed_at: claimedAt }
  }));

  await commitInChunks(updates);

  return snapshot.docs;
}

/**
 * Insert rows into BigQuery with retry + exponential backoff.
 * Returns true on success, false if all retries exhausted.
 */
async function insertWithRetry(table, rows) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await table.insert(rows, {
        skipInvalidRows: true,
        ignoreUnknownValues: true,
        raw: true // rows carry explicit insertId; see docToBigQueryRow
      });
      return true;
    } catch (err) {
      lastError = err;
      log.warn({
        attempt,
        maxRetries: MAX_RETRIES,
        error: err.message
      }, 'BigQuery insert failed, retrying...');

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve =>
          setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1))
        );
      }
    }
  }

  log.error({
    rowCount: rows.length,
    error: lastError.message
  }, 'Failed to insert telemetry batch to BigQuery after retries');
  return false;
}

/**
 * Process a batch of unprocessed telemetry documents.
 * Returns the count of documents successfully processed.
 */
async function processBatch() {
  try {
    await sweepStaleClaims();

    const docs = await claimBatch();
    if (docs.length === 0) return 0;

    const rows = [];
    const completionUpdates = [];
    const releaseUpdates = [];

    docs.forEach(doc => {
      try {
        const parentId = doc.ref.parent.parent.id;
        rows.push(docToBigQueryRow(doc, parentId));
        completionUpdates.push({
          docRef: doc.ref,
          updateData: { processing: false, processed: true, bq_sync_time: new Date() }
        });
      } catch (rowErr) {
        // Malformed doc (e.g. missing parent ref) — release its claim rather
        // than letting one bad doc fail the whole batch.
        log.error({ docPath: doc.ref.path, err: rowErr.message }, 'Skipping malformed doc');
        releaseUpdates.push({
          docRef: doc.ref,
          updateData: { processing: false, claimed_at: null }
        });
      }
    });

    if (releaseUpdates.length > 0) {
      await commitInChunks(releaseUpdates);
    }

    if (rows.length === 0) return 0;

    const table = bigquery
      .dataset(process.env.BIGQUERY_DATASET_ID || 'mitra_telemetry_production')
      .table('telemetry_synced');

    const insertSuccess = await insertWithRetry(table, rows);

    if (!insertSuccess) {
      // Release claims so these docs are retried on a future poll instead
      // of being stuck `processing: true` forever.
      const releaseOnFailure = completionUpdates.map(u => ({
        docRef: u.docRef,
        updateData: { processing: false, claimed_at: null }
      }));
      await commitInChunks(releaseOnFailure);
      return 0;
    }

    await commitInChunks(completionUpdates);

    log.info({
      processedCount: rows.length,
      batchSize: BATCH_SIZE
    }, 'Telemetry batch processed successfully');

    return rows.length;

  } catch (err) {
    log.error({ err: err.message, stack: err.stack }, 'Batch processing error');
    return 0; // Return 0 on error to prevent infinite loops
  }
}

/**
 * Get telemetry processing statistics using real aggregation counts
 * rather than limit(1) existence checks.
 */
async function getStats() {
  try {
    const unprocessedCountQuery = firestore
      .collectionGroup('sessions')
      .where('processed', '==', false)
      .count();

    const processedCountQuery = firestore
      .collectionGroup('sessions')
      .where('processed', '==', true)
      .count();

    const [unprocessedResult, processedResult] = await Promise.all([
      unprocessedCountQuery.get(),
      processedCountQuery.get()
    ]);

    const bqQuery = `
      SELECT COUNT(*) as total_rows
      FROM \`${process.env.BIGQUERY_PROJECT_ID}.${process.env.BIGQUERY_DATASET_ID || 'mitra_telemetry_production'}.telemetry_synced\`
    `;

    const [rows] = await bigquery.query(bqQuery);
    const bigQueryCount = rows[0]?.total_rows || 0;

    return {
      firestore_unprocessed: unprocessedResult.data().count,
      firestore_processed: processedResult.data().count,
      bigquery_synced: bigQueryCount,
      processor_running: isRunning
    };
  } catch (err) {
    log.error({ err: err.message }, 'Failed to get stats');
    return null;
  }
}

/**
 * Main processing loop. Runs continuously, polling for unprocessed telemetry.
 * Adaptive cadence: re-poll quickly if the last batch was full (likely more
 * backlog), back off to the idle interval otherwise.
 */
async function startProcessingLoop() {
  isRunning = true;
  log.info('Telemetry processor started');

  const processLoop = async () => {
    if (!isRunning) {
      log.info('Telemetry processor stopped');
      return;
    }

    let processed = 0;
    try {
      processed = await processBatch();
    } catch (err) {
      log.error({ err: err.message }, 'Processing loop error (will retry)');
    }

    const nextDelay = processed >= BATCH_SIZE ? POLL_INTERVAL_BUSY_MS : POLL_INTERVAL_IDLE_MS;
    loopTimer = setTimeout(processLoop, nextDelay);
  };

  await processLoop();
}

/**
 * Stop the processor gracefully
 */
async function stop() {
  isRunning = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  log.info('Stopping telemetry processor...');

  // Give pending operations time to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Health check endpoint
 */
function getStatus() {
  return {
    running: isRunning,
    initialized: firestore !== null && bigquery !== null
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const command = process.argv[2] || 'start';

  (async () => {
    switch (command) {
      case 'start': {
        const success = await initialize();
        if (!success) {
          process.exit(1);
        }
        await startProcessingLoop();
        break;
      }

      case 'stats': {
        const success = await initialize();
        if (!success) {
          process.exit(1);
        }
        const stats = await getStats();
        console.log(JSON.stringify(stats, null, 2));
        process.exit(0);
        break;
      }

      case 'test': {
        const success = await initialize();
        if (!success) {
          process.exit(1);
        }
        const count = await processBatch();
        console.log(`Processed ${count} documents`);
        process.exit(0);
        break;
      }

      case 'sweep': {
        const success = await initialize();
        if (!success) {
          process.exit(1);
        }
        const count = await sweepStaleClaims();
        console.log(`Released ${count} stale claims`);
        process.exit(0);
        break;
      }

      default:
        console.log(`
Usage: node workers/telemetry_processor.js [command]

Commands:
  start  Start the continuous processing loop (default)
  stats  Get processing statistics
  test   Run a single batch and exit
  sweep  Release stale claims and exit

Examples:
  npm start telemetry-processor
  node workers/telemetry_processor.js start
  node workers/telemetry_processor.js stats
  node workers/telemetry_processor.js test
        `);
        process.exit(0);
    }
  })();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });
}

module.exports = {
  initialize,
  processBatch,
  startProcessingLoop,
  stop,
  getStats,
  getStatus,
  sweepStaleClaims
};