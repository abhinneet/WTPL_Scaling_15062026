# MIGRATION_GUIDE.md — Moving Postgres data to Cloud SQL

This is **optional**. If you don't have existing user/campaign data yet, skip this entirely — your fresh Cloud SQL instance will start empty and `npm run migrate && npm run seed` will set up everything you need.

If you DO have existing data you want to keep, follow this.

## What you'll be doing

1. Take a dump of your existing PostgreSQL database.
2. Connect to Cloud SQL via the Cloud SQL Auth Proxy.
3. Restore the dump into Cloud SQL.
4. Apply the new schema migrations on top.

## Prerequisites

- Your existing Postgres reachable from your laptop (or wherever you run this)
- `pg_dump` and `psql` installed (Postgres client tools — `brew install postgresql` on Mac, or the official Postgres installer on Windows)
- Cloud SQL Auth Proxy installed: https://cloud.google.com/sql/docs/postgres/connect-auth-proxy
- A Cloud SQL Postgres instance already created (walkthrough step 5)
- An EMPTY database created on that instance:
  ```bash
  gcloud sql databases create mitra --instance=YOUR_INSTANCE_NAME
  ```
- A Cloud SQL user with login + full rights on that database:
  ```bash
  gcloud sql users create mitra_app --instance=YOUR_INSTANCE_NAME --password='YourStrongPassword'
  ```

## Step-by-step

### 1. Dump your existing database

```bash
pg_dump --no-owner --no-acl --clean --if-exists \
        --format=plain \
        --file=mitra-dump.sql \
        "postgresql://YOUR_USER:YOUR_PASSWORD@YOUR_HOST:5432/YOUR_DB"
```

Verify the dump:
```bash
ls -lh mitra-dump.sql      # should be a few MB to a few hundred MB
head -50 mitra-dump.sql    # should start with PostgreSQL header comments
```

### 2. Start the Cloud SQL Auth Proxy in a separate terminal

```bash
cloud-sql-proxy --port 5433 YOUR_PROJECT:asia-south1:YOUR_INSTANCE_NAME
```

Leave this running. You should see a "ready for new connections" message.

### 3. Restore the dump

In another terminal:
```bash
PGPASSWORD='YourStrongPassword' psql \
  --host=127.0.0.1 --port=5433 \
  --username=mitra_app \
  --dbname=mitra \
  --single-transaction \
  --set ON_ERROR_STOP=on \
  --file=mitra-dump.sql
```

Common errors:
- **`extension "uuid-ossp" does not exist`** — Cloud SQL has it, but you need to be the owner. Run as the `postgres` superuser instead, OR add this line to the top of the dump: `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`
- **`permission denied for schema public`** — the user needs ownership of the public schema. As superuser:
  ```sql
  ALTER SCHEMA public OWNER TO mitra_app;
  GRANT ALL ON SCHEMA public TO mitra_app;
  ```

### 4. Apply the new security migrations

```bash
# Point the migration runner at the proxy
DATABASE_URL="postgresql://mitra_app:YourStrongPassword@127.0.0.1:5433/mitra" \
  npm run migrate
```

This adds: failed_logins, password_reset_tokens, audit_logs, uploads, and the new columns on refresh_tokens — without touching your existing rows.

### 5. (Optional) Quick automated version

The included script wraps steps 1–4:

```bash
SOURCE_URL="postgresql://YOUR_USER:YOUR_PW@YOUR_HOST:5432/YOUR_DB" \
CLOUD_SQL_INSTANCE="YOUR_PROJECT:asia-south1:YOUR_INSTANCE_NAME" \
TARGET_DB="mitra" \
TARGET_USER="mitra_app" \
TARGET_PASSWORD="YourStrongPassword" \
  ./scripts/migrate-postgres-to-cloudsql.sh
```

## Verification

```bash
# Still using the proxy:
psql --host=127.0.0.1 --port=5433 --username=mitra_app --dbname=mitra -c "SELECT COUNT(*) FROM users;"
psql --host=127.0.0.1 --port=5433 --username=mitra_app --dbname=mitra -c "SELECT filename FROM _migrations ORDER BY applied_at;"
```

Expected: your existing user count, plus v001 through v005 in `_migrations`.

## ⚠️ Important warning about existing passwords

Existing user records will have bcrypt-hashed passwords. These will continue to work — the hardened `routes/auth.js` accepts the same hashes.

However:
- **Refresh tokens** issued by the old code lack the `family_id` column. On first login after migration, users will get new refresh tokens that work normally. Old tokens just won't refresh — users have to log in once.
- **The hardcoded `admin@mitra.com` / `admin123` user** from the old `seed.js` is now a security risk. Either delete it or reset the password immediately:
  ```sql
  DELETE FROM users WHERE email = 'admin@mitra.com';
  ```
  Then run the new seed to create your real admin.

## Rollback

The old database is unchanged — you only dumped from it, didn't modify it. To roll back, point your old code at it again. The migration is fully reversible until you cut DNS over to Firebase Hosting.
