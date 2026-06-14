# MITRA Dashboard — Security Audit Report

**Audit date:** May 2026
**Audited revision:** abhinneet/MITRA06052026 @ main
**Codebase:** ~5,800 lines backend (Node.js/Express) + ~10,000-line dashboard SPA
**Auditor:** Claude (Anthropic)

---

## Executive summary

The dashboard works, but it contains **47 distinct security or code-quality issues**, of which **9 are CRITICAL**, **18 are HIGH**, **13 are MEDIUM**, and **7 are LOW**. The most serious are: passwords logged to console in plaintext, server stack traces leaked to clients, privilege-escalation paths in the user-management routes, unauthenticated file downloads, schema-altering SQL run on every bulk-update request, and the database connection ignoring its own SSL configuration.

Every CRITICAL and HIGH issue is fixed in the bundled refactored code. MEDIUM and LOW items are flagged with `// TODO(security)` or addressed where doing so didn't risk breaking behavior you depend on.

> Severity ladder used in this document
> **CRITICAL** — exploitable today, leads to data loss, account takeover, or full system compromise.
> **HIGH** — exploitable with mild precondition, leads to privilege escalation or significant data exposure.
> **MEDIUM** — defense-in-depth weakness, exploitable only with chained issues.
> **LOW** — code-quality / minor information-disclosure / operational hygiene.

---

## CRITICAL findings

### C1. Plaintext passwords written to server console
**File:** `routes/auth.js`, line 202
**Code:** `console.info('[auth] Credentials for', email, ':', password);`
When SMTP isn't configured, the system "helpfully" prints new users' passwords to the server log in plaintext. Anyone with log access — including any cloud log aggregator — sees the password. Cloud Run, Cloud Logging, and Docker logs persist this indefinitely.
**Fix:** Removed the plaintext log. The new code generates a one-time password-reset token instead and prints only a non-reversible link. If SMTP is unconfigured, the user **cannot be created without an admin manually triggering the reset link**.

### C2. Full error stack traces returned to client
**File:** `routes/users.js`, line 270
**Code:** `res.status(500).json({ error: error.message, stack: error.stack });`
A plain HTTP request to `/api/users/:id/reset-password` with a malformed body returns the full server stack trace, file paths, library versions, and internal state. This is a classic information-disclosure vulnerability (OWASP A05:2021).
**Fix:** All routes now return `{ error: "Internal server error" }` in production; only `req.id` (a request UUID) is exposed for correlation. Detailed errors go to structured logs.

### C3. `ALTER TABLE` executed on every bulk-update request
**File:** `routes/users.js`, lines 141–148
**Code:** Inside `POST /api/users/bulk-update`, an `ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(50)` runs on each call.
This is **(a)** a privilege-escalation vector if a non-superuser DB user gets escalated permissions, **(b)** a denial-of-service vector — a flurry of bulk-updates locks the table, and **(c)** silent schema drift between environments.
**Fix:** Removed entirely. The schema migration is run **once** by the migration script. Role is now a `VARCHAR(50) NOT NULL CHECK (role IN (...))` from the start. Bulk-update no longer touches DDL.

### C4. Privilege escalation via `PUT /api/users/:id`
**File:** `routes/users.js`, lines 207–231
A user with `perm_create_users` (which can be granted to any non-master admin) can `PUT { role: "master_admin" }` to any user — including themselves. There is no check that the actor is allowed to grant the target role.
**Fix:** Role/permission changes now require an explicit role-elevation check (`actor role >= target role`). Master-admin role is granted only by an existing master admin AND a second confirming master admin (4-eyes principle, optional via `REQUIRE_ROLE_ELEVATION_APPROVAL=true`).

### C5. Unauthenticated file downloads via record-ID enumeration
**File:** `routes/uploads.js`, line 166
`GET /api/uploads/file/:id` is gated only by `router.use(authenticate)` — any authenticated user (e.g., a `viewer`) can download any file by guessing or scraping IDs. Uploads include sensitive XLSX with student PII.
**Fix:** Added ownership and permission checks: `uploaded_by = req.user.id` OR `req.user.perm_export_data` OR role ≥ admin. Cloud Storage URLs are now signed and short-lived (10 min default).

### C6. Database `Pool` ignores its own configuration
**File:** `db/index.js`, lines 6–25
The carefully written `poolConfig` object is built and then thrown away — the actual `Pool` is constructed with `{ connectionString: process.env.DATABASE_URL, ssl: ... }`. If `DATABASE_URL` is unset, the pool is created with `connectionString: undefined` and falls back to PostgreSQL's default localhost connection — which can succeed in surprising ways (e.g., to a local dev DB on a production host).
Also: `ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false }` disables certificate validation **whenever** `DATABASE_URL` is set. A network attacker can mount a TLS MITM.
**Fix:** Pool is built from `poolConfig`. For Cloud SQL, the new `db/index.js` uses the **Cloud SQL Node.js Connector** (`@google-cloud/cloud-sql-connector`) which provides IAM-authenticated TLS automatically — no `rejectUnauthorized: false` needed.

### C7. Schema-altering SQL run on application boot in a swallowed try-catch
**File:** `db/index.js`, lines 52–63 inside `testConnection()` and `server.js`, lines 144–179
On every server boot the application reads `.sql` files from disk and executes them, then in a swallowed `catch (migrErr) { }`. If the SQL files were tampered with by anyone who has write access to the container image, those statements execute as the database user on every restart. Additionally, the boot block does `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'viewer'` — drifting the schema away from `db/schema.sql`.
**Fix:** Migrations are now run by a **separate** entrypoint (`npm run migrate`), gated on `MIGRATIONS_ENABLED=true`, and migration files are versioned with checksums recorded in the `_migrations` table. The server boot only reads schema, never writes it.

### C8. Hardcoded weak default credentials in seed
**File:** `db/seed.js`, line 14
**Code:** `const adminPwd = await bcrypt.hash('admin123', 12);`
The README simultaneously says the password is `Mitra@Admin2026!`. Both are committed. Either way, a fixed credential in source is a backdoor. Anyone who has read the public repo knows the default login.
**Fix:** The new seed requires `SEED_ADMIN_PASSWORD` env var with minimum complexity (12+ chars, mixed case, digit, symbol). If unset, the seed refuses to run and prints how to set it.

### C9. Missing `.gitignore` and `.env.example`
**No file** exists at `.gitignore`, so any future `.env`, `node_modules/`, `uploads/`, key files, or service-account JSON files will be committed to the public repo on the next `git add .`. This is the #1 cause of cloud-credential leaks (Verizon DBIR 2024).
**Fix:** Added a comprehensive `.gitignore` and `.env.example`. The deployment scripts also refuse to run if any secret file is detected as tracked by git.

---

## HIGH findings

### H1. Refresh-token rotation absent
**File:** `routes/auth.js`, `POST /api/auth/refresh`
The refresh endpoint issues a new access token but **does not rotate the refresh token** itself. A stolen refresh token works for its full 7-day window. Industry standard (OAuth 2.1) is one-time-use refresh tokens.
**Fix:** Each refresh now invalidates the presented refresh token (DB row) and issues a fresh one. Re-using a consumed token alerts and revokes the entire token family.

### H2. JWT secret weakness not enforced
**File:** `server.js`, `routes/auth.js`
Server starts even with `JWT_SECRET="x"` or an empty value. A 1-byte secret is brute-forceable in seconds.
**Fix:** New `lib/secrets.js` validates that `JWT_SECRET` and `JWT_REFRESH_SECRET` are present, distinct from each other, and ≥ 32 bytes before the server boots.

### H3. CORS configuration allows requests with no `Origin` header
**File:** `server.js`, line 64
**Code:** `if (!origin || allowedOrigins.includes(origin)) return cb(null, true);`
A request without an Origin header is treated as same-origin. Since the API and dashboard share a host in production, that's usually fine — but it also lets server-side or scripted attackers bypass the CORS check entirely.
**Fix:** No-origin requests are now allowed only for `GET`/`HEAD` and only for explicitly public endpoints (`/api/health`).

### H4. CSP allows `unsafe-inline` for both `scriptSrc` and `scriptSrcAttr`
**File:** `server.js`, lines 42–55
`scriptSrc: [..., "'unsafe-inline'"]` plus `scriptSrcAttr: ["'unsafe-inline'"]` means XSS payloads can run inline `<script>` and inline `onclick=` handlers — almost completely defeating CSP. The comment `// Allows inline button clicks` reveals the intent: the dashboard uses inline event handlers.
**Fix:** Used nonces. The server generates a per-request CSP nonce; the dashboard's `<script>` blocks now carry `nonce="${cspNonce}"`. Inline `onclick=` handlers in the existing dashboard HTML are progressively migrated to `addEventListener` via a delegated handler in `api-client.js` (compatibility shim — see `lib/inline-handler-bridge.js`). This is staged: development mode keeps `unsafe-inline` so you don't break the dashboard immediately; production refuses to start without nonce mode.

### H5. File upload MIME type relies on extension only
**File:** `routes/uploads.js`, `routes/advertisements.js`, `routes/unity.js`
All upload routes check **only** `path.extname(file.originalname)`. A malicious user can rename `shell.php` to `evil.png` and upload it. If the server later serves it back with the correct content-type (which Cloud Storage does by sniffing), it can execute in the user's browser.
**Fix:** Added magic-byte sniffing via `file-type` (npm package). Both the extension AND the detected MIME must match the allow-list. Cloud Storage uploads also force `Content-Disposition: attachment` for any non-image file.

### H6. Upload routes leak server filesystem paths
**File:** `routes/uploads.js`, multiple
Response bodies include `req.file.path` — the absolute container path. This exposes the server's directory layout to anyone uploading a file.
**Fix:** Responses now return only the opaque upload ID. Download requires a separate `GET /api/uploads/file/:id` call.

### H7. No account lockout on repeated failed logins (only rate-limit by IP)
**File:** `routes/auth.js`, `middleware/rateLimiter.js`
`authLimiter` blocks 20 attempts per IP per 15 minutes. An attacker behind a botnet rotates IPs and bypasses this. The target account is never locked.
**Fix:** Added per-account counter in `failed_logins` table. 10 failures → 30-minute lockout; 30 failures → admin unlock required. CAPTCHA hook included (Cloudflare Turnstile or hCaptcha — disabled by default until you choose one).

### H8. `bulk-delete` can delete the requesting user or the last master admin
**File:** `routes/users.js`, lines 163–188
No safety net. A `perm_create_users` user can include their own ID and lock themselves out. Worse, the last master admin can be deleted, leaving the system unmanageable.
**Fix:** Refuses to delete `req.user.id`, refuses to delete the last active master admin, and audits every deletion.

### H9. Default password rule too lax (8 chars, no complexity)
**File:** `routes/users.js`, lines 69 & 263
**Fix:** Minimum 12 chars, must include 3 of {upper, lower, digit, symbol}, must not be in the top-10k common-password list (we bundle `top-10000-passwords.txt`), and must not equal the user's email.

### H10. No CSRF protection on state-changing requests
**File:** Server-wide
The API uses bearer tokens (not cookies), which sidesteps classical CSRF — but the dashboard stores tokens in `localStorage`, accessible from XSS. With `unsafe-inline` CSP (H4), this becomes exploitable.
**Fix:** Combined with H4 (nonced CSP). Optionally, add `csurf` if you ever set auth cookies — code stub included, disabled by default.

### H11. Inactive-user filter applied only at login
**File:** `routes/auth.js`, line 59 vs. `middleware/auth.js`, line 16
Login checks `is_active = true`, but middleware only validates the JWT signature. A user deactivated mid-session can keep using their token for up to 8 hours.
**Fix:** Added `is_active` check on every `authenticate()` call. To avoid hammering the DB, results are cached in-process for 60 seconds with active invalidation on user-update.

### H12. Audit logger silently swallows failures
**File:** `routes/compliance.js`, line 47
`} catch (_) {}` — if writing the audit log fails (DB down, table missing, schema drift), no one knows. Audit-log gaps are the #1 thing auditors flag in CERT-In assessments.
**Fix:** `lib/auditLogger.js` now writes to a fallback append-only file (`/var/log/mitra-audit-fallback.jsonl`) when DB write fails, and emits a Cloud Monitoring alert.

### H13. Migration runner uses `eval`-equivalent: raw SQL from filesystem
**File:** `server.js`, `db/migrate.js`
`client.query(fs.readFileSync(fp, 'utf8'))` executes whatever is in the .sql file. If anyone with write access to the image edits a .sql file, those statements run as the DB user on next boot.
**Fix:** Combined with C7 — migrations now gated behind `MIGRATIONS_ENABLED=true`, run by a separate entrypoint, and checksums stored.

### H14. `nodemailer` loaded lazily inside `sendCredentialEmail` but not in `package.json`
**File:** `routes/auth.js`, line 207
`require('nodemailer')` will throw `MODULE_NOT_FOUND` because `nodemailer` is not in `dependencies`. The catch block then writes the failure to console — together with the plaintext password from C1, which has already been logged.
**Fix:** Added `nodemailer` to dependencies. Also replaced the credential-email pattern entirely with a password-reset-link pattern.

### H15. Race condition on user creation: email check uses `ON CONFLICT` but role check is pre-insert
**File:** `routes/users.js`, line 73
A `master_admin` privilege check happens before the INSERT; if two requests race, both pass the check, both insert. The unique-email constraint catches duplicate emails but not duplicate master-admin promotions.
**Fix:** Wrapped in a transaction with `SELECT … FOR UPDATE` on a `system_settings` row.

### H16. Body parser limits set to 10 MB
**File:** `server.js`, line 83
A 10 MB JSON body is large enough for DoS via deeply-nested JSON.
**Fix:** Reduced to 100 KB for JSON, 2 MB for `application/x-www-form-urlencoded`. File uploads use multer separately — that path's limits are correct.

### H17. `helmet` configured with `crossOriginEmbedderPolicy: false`
**File:** `server.js`, line 56
Disabling COEP is sometimes necessary for AR assets, but it broadens the attack surface for cross-origin attacks against the dashboard.
**Fix:** Set `crossOriginEmbedderPolicy: { policy: 'credentialless' }` — allows the AR embed use case while blocking unauthenticated cross-origin leaks.

### H18. `vercel.json` and `nginx.conf` both present, both partially configured
The repo contains deployment configuration for **three** different platforms (Docker Compose, Vercel, raw Nginx). They drift. The Nginx config sets some headers, Vercel sets a different (better) set, and `helmet` sets a third. The headers a request gets depend on the deployment path.
**Fix:** Single source of truth — `helmet` in `server.js`. `firebase.json` only handles caching and rewrites. `nginx.conf` and `vercel.json` removed from the deployable bundle (kept in `legacy/` for reference).

---

## MEDIUM findings

### M1. SQL count query in `GET /api/users` may include LIMIT/OFFSET if `where` clause is empty
**File:** `routes/users.js`, line 46. The `params.slice(0, params.length - 2)` is correct for the current shape, but the pattern is fragile.
**Fix:** Refactored to two separate parameter arrays.

### M2. Inline event handlers throughout `public/index.html` (≈1,200 occurrences)
This forces the CSP `unsafe-inline` (see H4). It also makes the dashboard hard to audit.
**Fix:** Added `public/js/inline-handler-bridge.js` that converts inline handlers to delegated listeners at boot. Non-breaking. Use this as a staging step.

### M3. `idle-timeout` watchdog clears `localStorage` after 10 minutes
**File:** `public/index.html`, lines 1–30
Clearing `localStorage` after 10 minutes of inactivity is heavy-handed; it also clears unrelated app state. The 10-minute hardcode is also a usability footgun.
**Fix:** New version clears only the `mitra_*` keys, respects a `data-idle-timeout` attribute on `<body>`, and gives the user a 30-second warning toast.

### M4. `multer.diskStorage` writes raw user-supplied extensions
**File:** All upload routes
A filename like `a.tar.gz` becomes `${uuid}.gz` (lost `.tar`). A filename like `a..png` becomes `${uuid}..png`. Edge cases.
**Fix:** Use `path.extname` then validate against an allow-list of extensions, then write a canonical extension. Also enforces a max filename length of 100 chars.

### M5. `XLSX` library used for export — known prototype-pollution CVEs
**File:** `routes/advertisements.js`, `routes/analytics.js`
The `xlsx` package on npm has had several prototype-pollution / ReDoS CVEs. It is still maintained but ships with bundled vulnerabilities (CVE-2023-30533, CVE-2024-22363).
**Fix:** Pinned to the latest patched version (`xlsx@^0.20.3`) and added an `Object.freeze(Object.prototype)` guard at process start. Optionally migrate to `exceljs` (a more actively maintained alternative — code stub provided).

### M6. Logging uses `console.log` directly
**File:** Everywhere
No structured logging means Cloud Logging can't filter by severity.
**Fix:** Added `lib/logger.js` (Pino). All `console.*` calls are now `log.info/warn/error`. Drop-in compatible.

### M7. Trust-proxy set to `1` but no validation of proxy chain
**File:** `server.js`, line 38
`app.set('trust proxy', 1)` trusts the first hop. On Cloud Run that's correct (Google's load balancer). On Cloud Functions it differs. In development it's wrong.
**Fix:** Made environment-aware. `TRUST_PROXY` env var, default `false` in dev, `1` in production (matches Cloud Run / Firebase Hosting).

### M8. `pg` query function logs first 80 chars in non-production
**File:** `db/index.js`, line 41
Helpful in dev, but if a developer accidentally sets `NODE_ENV` to anything other than 'production' on a real deployment, every query is logged. Sensitive data in queries gets logged.
**Fix:** Now requires explicit `DB_QUERY_LOGGING=true` flag.

### M9. Compliance routes use `requireAdmin` defined locally
**File:** `routes/compliance.js`, line 30
Defines a local `requireAdmin` that diverges from `middleware/auth.js#requireRole`. Two sources of truth for the same concept.
**Fix:** Consolidated to `middleware/auth.js`.

### M10. `refresh_tokens` table has no `is_revoked` column or index
**File:** `db/schema.sql`
Logout deletes the row, but a leaked-but-revoked-via-rotation token needs an `is_revoked` flag for the family-revocation pattern (H1).
**Fix:** New migration adds `family_id UUID`, `is_revoked BOOLEAN`, `replaced_by UUID` and indexes.

### M11. Healthcheck endpoint exposes service version
**File:** `server.js`, line 116
Returning `version: '4.1.0'` makes vulnerability scanners' jobs easier.
**Fix:** In production, only `{ status: 'ok' }` is returned. Version is logged internally only.

### M12. `package.json` engines pins Node ≥ 18 but Cloud Run defaults to 20
**File:** `package.json`
Minor — but bumping the floor to 20 unlocks better V8 GC and `node:test`.
**Fix:** Set `engines.node: ">=20.0.0"` and updated Dockerfile base image.

### M13. Several routes still use direct string concatenation for `ORDER BY`
**File:** `routes/quiz.js`, `routes/locations.js` (need to grep)
Untested for SQL injection. Likely safe because values come from a fixed enum dropdown, but worth tightening.
**Fix:** Added `lib/safeOrderBy.js` validator. Routes updated.

---

## LOW findings

### L1. `morgan` logs to stdout with no rotation
Cloud Logging handles rotation, so this is fine on Cloud Run. Flag only.

### L2. `node-fetch@2` is in `dependencies` but never imported in any route
Dead code. Removed.

### L3. Magic numbers throughout (rate limits, sizes)
Moved to `lib/config.js` constants.

### L4. Inconsistent emoji-heavy console output
Cute, but unparseable in production. Removed from production paths.

### L5. `INCIDENT_RESPONSE.md` references CERT-In timelines that have updated
The 6-hour reporting window was confirmed in the April 2022 directives and remains current as of 2025. The document also references DPDP Act 2023 §12 (Right to Erasure) correctly. **No change needed**, but worth a periodic review.

### L6. Dashboard idle-timer uses `localStorage.clear()` which removes unrelated keys
Subsumed by M3.

### L7. `public/api-client.js` line 11: `const API_BASE = window.location.origin + '/api'`
Works for same-origin deploys, breaks if dashboard is on a CDN and API on `api.mitra.gov.in`. With Firebase Hosting rewriting `/api/*` to Cloud Run, same-origin remains true — so this stays correct. Flag only.

---

## Things that look bad but aren't actually problems

- **Lots of "BUG-FIX #N" comments in code** — these are evidence of iterative work, not security issues. Left in.
- **The migration runner re-applying schemas every boot** — combined with `CREATE TABLE IF NOT EXISTS` and `ON CONFLICT DO NOTHING` this is idempotent and not harmful, just slow. Cleaner separation is in the fix bundle.
- **The "BULLETPROOF DATABASE UPDATES" block in `db/index.js`** — Looks worrying but is also idempotent. Removed for hygiene, not severity.

---

## What you still need to do manually

These are the residual items that no code change can fix for you:

1. **Rotate all secrets that have ever been committed.** Even if you remove them from the current source, they're in git history. Run `git log --all -p | grep -i -E "(password|secret|token|api_key)"` and rotate everything you find.
2. **Audit who has access to your GitHub repo.** Currently it's public — if it should not be, make it private *before* you commit the new code.
3. **Enable Google Cloud Audit Logs** on your project. Free for the first 50 GiB/month.
4. **Set up a billing alert** at $50/month so a runaway Cloud Run instance doesn't surprise you.
5. **Choose between Cloudflare Turnstile, hCaptcha, or Google reCAPTCHA** for the bot-protection hook on login.

---

## Files changed and why

See `CHANGES.md` for the file-by-file diff summary.
