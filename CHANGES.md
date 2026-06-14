# CHANGES.md — File-by-file summary

This bundle is **not a complete drop-in replacement**. It contains the **hardened files** that fix the issues in `SECURITY_AUDIT.md`. You'll need to merge these with the rest of your existing repo.

The simplest way:

1. Copy your existing `MITRA_06052026/` to a new folder, say `MITRA_DEPLOYABLE/`
2. Copy/overwrite the files listed below from this bundle into `MITRA_DEPLOYABLE/`
3. Delete the files listed under "Delete from your repo" below

---

## ✅ Files to OVERWRITE in your existing repo

| File | Why |
|---|---|
| `package.json` | New deps (Cloud SQL Connector, GCS, Secret Manager, pino, file-type, nodemailer); Node ≥20 |
| `server.js` | Fail-fast secret validation, CSP nonces, COEP, graceful SIGTERM, request IDs, body limits, no DDL on boot |
| `Dockerfile` | Multi-stage, distroless final image |
| `db/index.js` | Cloud SQL Connector mode, no rejectUnauthorized:false, lazy init |
| `db/seed.js` | Refuses to seed without strong SEED_ADMIN_PASSWORD env |
| `db/migrate.js` | Versioned, checksummed migration runner |
| `middleware/auth.js` | is_active cache, role-rank enforcement, no privilege escalation |
| `middleware/rateLimiter.js` | Clean shutdown, unref'd intervals |
| `routes/auth.js` | Refresh-token rotation+revocation, account lockout, password reset, no plaintext logs, constant-time response |
| `routes/users.js` | Role-elevation guard, transaction-wrapped create, no DDL on bulk update, password reset via link only, no stack traces leaked |
| `routes/uploads.js` | Permission checks on download, storage abstraction, signed URLs |
| `routes/advertisements.js` | Storage abstraction (memory→GCS), signed URLs, audit logs, no disk writes |
| `routes/unity.js` | Size cap, storage abstraction, signed URL download, audit logs |

## ✅ Files to ADD (do not exist in your repo)

| File | Why |
|---|---|
| `lib/logger.js` | Structured Pino logger with GCP severity mapping + secret redaction |
| `lib/secrets.js` | Validates JWT secret strength; optional Secret Manager load |
| `lib/storage.js` | Backend-agnostic upload/download (local | GCS), MIME sniffing, allow-lists, signed URLs |
| `lib/auditLogger.js` | Writes to audit_logs table + JSONL fallback |
| `db/migrations/v005_security_fixes.sql` | New tables: failed_logins, password_reset_tokens, audit_logs, uploads metadata; rotation columns on refresh_tokens |
| `public/api-client.js` | Frontend: auto-refresh on 401, signed-URL downloads, idle warning, selective logout |
| `public/inline-handler-bridge.js` | Optional shim that lets you switch to strict CSP without rewriting inline handlers |
| `firebase.json` | Hosting → Cloud Run rewrites |
| `.firebaserc.example` | Template (rename to `.firebaserc` and fill in your project ID) |
| `cloudbuild.yaml` | Cloud Build pipeline |
| `.env.example` | Documented environment variables |
| `.gitignore` | **Was missing — this is critical to avoid committing secrets** |
| `.gcloudignore` | Keeps build context small |
| `scripts/deploy.sh` | One-shot deploy (Linux/Mac) |
| `scripts/deploy.ps1` | One-shot deploy (Windows) |
| `scripts/migrate-postgres-to-cloudsql.sh` | Move existing DB to Cloud SQL |

## ✅ Files to KEEP UNCHANGED from your repo

These routes did not need security changes for the migration:

- `routes/analytics.js`
- `routes/locations.js`
- `routes/curriculum.js`
- `routes/quiz.js`
- `routes/ar_assets.js`
- `routes/compliance.js`
- `routes/dashboard.js`
- `routes/notifications.js`
- `routes/tenant.js`
- `routes/geofence.js`
- `routes/appBuilder.js`
- `db/seed_india_locations.js`
- `public/index.html` — your dashboard UI (DO NOT let me rewrite this; too risky)
- `INCIDENT_RESPONSE.md`
- `firestore.rules` (unused but well-written; keep for future smartphone-app Firestore use)

## ❌ Files to DELETE from your repo

| File | Why |
|---|---|
| `docker-compose.yml` | Replaced by Cloud Run + Cloud SQL; local dev uses `npm run dev` |
| `nginx.conf` | Cloud Run + Firebase Hosting handle TLS and routing |
| `vercel.json` | Vercel-specific; you're using Firebase + Cloud Run now |
| `api/` (if present) | Vercel serverless functions; routes live in `routes/` |

(Keep them in git history — just don't ship them.)

---

## Quick verification after merge

Run from the merged folder:

```bash
npm install
node -e "require('./db'); console.log('DB module loads OK')"
node -e "require('./lib/secrets').validateOrThrow(); console.log('Secrets OK')"
# Set your local .env first, then:
npm run dev
```

If it boots without errors, you're ready for the walkthrough.
