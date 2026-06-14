-- ════════════════════════════════════════════════════════════════════════════
-- MITRA Dashboard — Complete Schema (Single Clean Migration)
-- Replaces v001 through v005. All tables in correct dependency order.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Clean slate (drops any partial schema from failed previous runs) ──────────
-- Safe to run: no seed data exists yet. _migrations table is preserved.
DROP TABLE IF EXISTS app_builder_rbac, app_builder_settings, app_layouts,
  app_build_logs, app_builds, app_db_instances, app_asset_comments,
  app_uiux_assets, app_code_versions, app_code_files,
  tenant_app_files, password_reset_tokens, failed_logins, uploads,
  incident_reports, compliance_settings, audit_logs,
  notification_analytics, push_notifications,
  telemetry_sessions, ad_impressions,
  curriculum_state_hierarchy, curriculum_ar_links, curriculum_quiz_links,
  quiz_attempts, quiz_questions, quizzes,
  geofences, state_apps, unity_assets,
  india_districts, india_states,
  curriculum_nodes, refresh_tokens, users CASCADE;

DROP TYPE IF EXISTS user_role, asset_status, ad_status, media_type, app_status, quiz_status CASCADE;

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── ENUMs ────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('master_admin','admin','district_officer','teacher','content_manager','viewer'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE asset_status AS ENUM ('draft','uploading','processing','review','published','archived','rejected'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE ad_status AS ENUM ('draft','scheduled','live','paused','expiring_soon','expired','archived'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE media_type AS ENUM ('video','image','gif'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE app_status AS ENUM ('building','compiled','live','update_pending','retired'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE quiz_status AS ENUM ('draft','scheduled','live','paused','archived'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── users (no FK dependencies) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name              VARCHAR(150) NOT NULL,
  email                  VARCHAR(255) UNIQUE NOT NULL,
  password_hash          VARCHAR(255) NOT NULL,
  role                   user_role NOT NULL DEFAULT 'viewer',
  assigned_state         VARCHAR(100) DEFAULT 'All India',
  assigned_district      VARCHAR(100),
  is_active              BOOLEAN DEFAULT TRUE,
  perm_publish_apps      BOOLEAN DEFAULT FALSE,
  perm_upload_unity      BOOLEAN DEFAULT FALSE,
  perm_manage_geo        BOOLEAN DEFAULT FALSE,
  perm_view_analytics    BOOLEAN DEFAULT FALSE,
  perm_create_users      BOOLEAN DEFAULT FALSE,
  perm_edit_curriculum   BOOLEAN DEFAULT FALSE,
  perm_approve_content   BOOLEAN DEFAULT FALSE,
  perm_export_data       BOOLEAN DEFAULT FALSE,
  perm_manage_ads        BOOLEAN DEFAULT FALSE,
  perm_replay_analytics  BOOLEAN DEFAULT FALSE,
  perm_view_dashboard    BOOLEAN DEFAULT FALSE,
  perm_view_curriculum   BOOLEAN DEFAULT FALSE,
  perm_view_controls     BOOLEAN DEFAULT FALSE,
  perm_view_ar_assets    BOOLEAN DEFAULT FALSE,
  perm_view_notif        BOOLEAN DEFAULT FALSE,
  perm_view_users        BOOLEAN DEFAULT FALSE,
  perm_view_legal        BOOLEAN DEFAULT FALSE,
  perm_view_settings     BOOLEAN DEFAULT FALSE,
  perm_delete_users      BOOLEAN DEFAULT FALSE,
  perm_manage_compliance BOOLEAN DEFAULT FALSE,
  perm_view_app_builder  BOOLEAN DEFAULT FALSE,
  mfa_enforced           BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret             TEXT,
  last_login_at          TIMESTAMPTZ,
  purged_at              TIMESTAMPTZ,
  purge_reason           TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);
CREATE INDEX IF NOT EXISTS idx_users_purged ON users(purged_at) WHERE purged_at IS NOT NULL;

-- ── india_states (no FK dependencies) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS india_states (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(10) UNIQUE NOT NULL,
  name          VARCHAR(255) UNIQUE NOT NULL,
  state_code    VARCHAR(10),
  state_name    VARCHAR(255),
  region        VARCHAR(100),
  capital       VARCHAR(255),
  geojson       JSONB,
  nominatim_id  BIGINT,
  last_geo_sync TIMESTAMPTZ,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── refresh_tokens (depends on: users) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  family_id   UUID,
  is_revoked  BOOLEAN DEFAULT FALSE,
  replaced_by UUID,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id, is_revoked);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

-- ── curriculum_nodes (depends on: users, self) ────────────────────────────────
CREATE TABLE IF NOT EXISTS curriculum_nodes (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id UUID REFERENCES curriculum_nodes(id) ON DELETE CASCADE,
  node_type VARCHAR(20) NOT NULL CHECK (node_type IN ('class','subject','topic','language')),
  name      VARCHAR(200) NOT NULL,
  icon      VARCHAR(10) DEFAULT '📘',
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── india_districts (depends on: india_states) ───────────────────────────────
CREATE TABLE IF NOT EXISTS india_districts (
  id            SERIAL PRIMARY KEY,
  state_code    VARCHAR(10) REFERENCES india_states(code) ON DELETE CASCADE,
  name          VARCHAR(150) NOT NULL,
  district_code VARCHAR(20),
  geojson       JSONB,
  nominatim_id  BIGINT,
  last_geo_sync TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (state_code, name)
);
CREATE INDEX IF NOT EXISTS idx_districts_state ON india_districts(state_code);

-- ── unity_assets (depends on: users) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unity_assets (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(255) NOT NULL,
  original_name     VARCHAR(255),
  file_path         VARCHAR(512),
  file_size_bytes   BIGINT,
  file_size_mb      NUMERIC(12,2),
  file_format       TEXT,
  status            asset_status DEFAULT 'draft',
  uploaded_by       UUID REFERENCES users(id),
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  class_name        TEXT,
  subject           TEXT,
  topic             TEXT,
  language          TEXT,
  title             TEXT,
  target_apps       JSONB,
  target_states     JSONB,
  target_districts  JSONB,
  target_classes    JSONB,
  target_subjects   JSONB,
  publish_at        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  restrict_login    BOOLEAN DEFAULT TRUE,
  offline_available BOOLEAN DEFAULT TRUE,
  version           VARCHAR(20) DEFAULT 'v1.0.0',
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_unity_class_name ON unity_assets(class_name);
CREATE INDEX IF NOT EXISTS idx_unity_subject    ON unity_assets(subject);
CREATE INDEX IF NOT EXISTS idx_unity_topic      ON unity_assets(topic);
CREATE INDEX IF NOT EXISTS idx_unity_status     ON unity_assets(status);
CREATE INDEX IF NOT EXISTS idx_unity_language   ON unity_assets(language);

-- ── state_apps (depends on: users) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS state_apps (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_name          VARCHAR(150) NOT NULL,
  target_state      VARCHAR(100) NOT NULL,
  version           VARCHAR(20) DEFAULT 'v1.0.0',
  status            app_status DEFAULT 'building',
  active_users      INT DEFAULT 0,
  theme_color       VARCHAR(20) DEFAULT '#6366f1',
  file_path         VARCHAR(512),
  icon_path         VARCHAR(512),
  splash_path       VARCHAR(512),
  ar_bundle_version TEXT DEFAULT 'unity-2023.1.4f1',
  built_by          UUID REFERENCES users(id),
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── geofences (depends on: users) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geofences (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(200) NOT NULL,
  state          VARCHAR(100) NOT NULL,
  district       VARCHAR(150),
  radius_km      INT DEFAULT 50,
  is_active      BOOLEAN DEFAULT TRUE,
  language_lock  VARCHAR(50) DEFAULT 'Follow User Setting',
  offline_only   BOOLEAN DEFAULT FALSE,
  ar_modules     TEXT[],
  geojson        JSONB,
  nominatim_id   BIGINT,
  last_geo_sync  TIMESTAMPTZ,
  admin_level    SMALLINT DEFAULT 4,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── quizzes (depends on: curriculum_nodes, users) ─────────────────────────────
CREATE TABLE IF NOT EXISTS quizzes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title            VARCHAR(300) NOT NULL,
  description      TEXT,
  status           quiz_status DEFAULT 'draft',
  class_name       VARCHAR(100),
  subject          VARCHAR(100),
  topic            VARCHAR(200),
  language         VARCHAR(80),
  class_node_id    UUID REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
  subject_node_id  UUID REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
  topic_node_id    UUID REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
  target_states    TEXT[] DEFAULT '{}',
  target_districts TEXT[] DEFAULT '{}',
  publish_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  question_count   INT DEFAULT 0,
  total_attempts   BIGINT DEFAULT 0,
  avg_score        NUMERIC(5,2) DEFAULT 0,
  created_by       UUID REFERENCES users(id),
  reviewed_by      UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quizzes_status     ON quizzes(status);
CREATE INDEX IF NOT EXISTS idx_quizzes_class      ON quizzes(class_name);
CREATE INDEX IF NOT EXISTS idx_quizzes_subject    ON quizzes(subject);
CREATE INDEX IF NOT EXISTS idx_quizzes_language   ON quizzes(language);
CREATE INDEX IF NOT EXISTS idx_quizzes_publish_at ON quizzes(publish_at);

-- ── quiz_questions (depends on: quizzes) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_questions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id        UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  sort_order     INT DEFAULT 0,
  question_text  TEXT NOT NULL,
  option_a       TEXT,
  option_b       TEXT,
  option_c       TEXT,
  option_d       TEXT,
  correct_answer TEXT,
  correct_display TEXT,
  explanation    TEXT,
  difficulty     VARCHAR(20) DEFAULT 'medium',
  marks          NUMERIC(4,1) DEFAULT 1,
  question_type  VARCHAR(50) DEFAULT 'multiple_choice',
  options        JSONB,
  points         INT DEFAULT 1,
  class_name     VARCHAR(100),
  subject        VARCHAR(100),
  topic          VARCHAR(200),
  language       VARCHAR(80),
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions(quiz_id);

-- ── quiz_attempts (depends on: quizzes) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id                    BIGSERIAL PRIMARY KEY,
  quiz_id               UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  device_id             VARCHAR(128),
  student_id            VARCHAR(128),
  state                 VARCHAR(100),
  district              VARCHAR(100),
  school_id             VARCHAR(100),
  class_grade           VARCHAR(50),
  score                 NUMERIC(6,2) DEFAULT 0,
  max_score             NUMERIC(6,2) DEFAULT 0,
  pct_score             NUMERIC(5,2) DEFAULT 0,
  questions_attempted   INT DEFAULT 0,
  correct_answers       INT DEFAULT 0,
  time_taken_secs       INT DEFAULT 0,
  completed             BOOLEAN DEFAULT FALSE,
  app_language          VARCHAR(80),
  attempted_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz  ON quiz_attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_state ON quiz_attempts(state);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_date  ON quiz_attempts(attempted_at DESC);

-- ── curriculum_quiz_links (depends on: curriculum_nodes, quizzes, users) ──────
CREATE TABLE IF NOT EXISTS curriculum_quiz_links (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  node_id   UUID REFERENCES curriculum_nodes(id) ON DELETE CASCADE,
  quiz_id   UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  linked_by UUID REFERENCES users(id),
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(node_id, quiz_id)
);
CREATE INDEX IF NOT EXISTS idx_cqz_links_node ON curriculum_quiz_links(node_id);
CREATE INDEX IF NOT EXISTS idx_cqz_links_quiz ON curriculum_quiz_links(quiz_id);

-- ── curriculum_ar_links (depends on: unity_assets, users) ────────────────────
CREATE TABLE IF NOT EXISTS curriculum_ar_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_node_id TEXT NOT NULL,
  asset_id           UUID NOT NULL REFERENCES unity_assets(id) ON DELETE CASCADE,
  linked_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(curriculum_node_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_car_links_node  ON curriculum_ar_links(curriculum_node_id);
CREATE INDEX IF NOT EXISTS idx_car_links_asset ON curriculum_ar_links(asset_id);

-- ── curriculum_state_hierarchy (depends on: users) ───────────────────────────
CREATE TABLE IF NOT EXISTS curriculum_state_hierarchy (
  state_code VARCHAR(4) PRIMARY KEY,
  structure  JSONB NOT NULL DEFAULT '[]',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ad_impressions (no FK dependencies) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_impressions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL,
  device_id       TEXT NOT NULL,
  student_id      TEXT,
  state           TEXT,
  district        TEXT,
  class_grade     TEXT,
  age_group       TEXT,
  subject_context TEXT,
  app_language    TEXT,
  media_type      TEXT,
  view_seconds    NUMERIC(8,2) DEFAULT 0,
  completed       BOOLEAN DEFAULT FALSE,
  clicked         BOOLEAN DEFAULT FALSE,
  skipped         BOOLEAN DEFAULT FALSE,
  is_repeat       BOOLEAN DEFAULT FALSE,
  repeat_count    INT DEFAULT 0,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── telemetry_sessions (no FK dependencies) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        TEXT NOT NULL,
  student_id       TEXT,
  state            TEXT,
  district         TEXT,
  class_grade      TEXT,
  subject          TEXT,
  topic_id         UUID,
  session_minutes  NUMERIC(8,2) DEFAULT 0,
  replay_count     INT DEFAULT 0,
  completed        BOOLEAN DEFAULT FALSE,
  offline_session  BOOLEAN DEFAULT FALSE,
  app_language     TEXT,
  device_tier      TEXT,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── push_notifications (depends on: curriculum_nodes, quizzes, users) ─────────
CREATE TABLE IF NOT EXISTS push_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  target_state    TEXT,
  target_class    TEXT,
  target_subject  TEXT,
  target_ar_topic UUID REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
  target_quiz_id  UUID REFERENCES quizzes(id) ON DELETE SET NULL,
  deep_link_type  TEXT CHECK (deep_link_type IN ('ar_topic','quiz') OR deep_link_type IS NULL),
  deep_link_id    TEXT,
  deep_link_title TEXT,
  fcm_topic       TEXT,
  status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','scheduled','cancelled','failed')),
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  sent_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_notif_status    ON push_notifications(status);
CREATE INDEX IF NOT EXISTS idx_push_notif_state     ON push_notifications(target_state);
CREATE INDEX IF NOT EXISTS idx_push_notif_sent_at   ON push_notifications(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_notif_scheduled ON push_notifications(scheduled_at) WHERE status='scheduled';

-- ── notification_analytics (depends on: push_notifications) ──────────────────
CREATE TABLE IF NOT EXISTS notification_analytics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES push_notifications(id) ON DELETE CASCADE,
  delivered       BIGINT DEFAULT 0,
  opened          BIGINT DEFAULT 0,
  clicked         BIGINT DEFAULT 0,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(notification_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_analytics_notif ON notification_analytics(notification_id);

-- ── audit_logs (depends on: users) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_id      UUID,
  actor_email   TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  target_type   TEXT,
  resource_id   TEXT,
  target_id     TEXT,
  ip_address    INET,
  ip            TEXT,
  user_agent    TEXT,
  request_id    TEXT,
  details       JSONB DEFAULT '{}',
  occurred_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user_id         ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action          ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created         ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_time ON audit_logs(actor_id, occurred_at DESC);

-- ── compliance_settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO compliance_settings (key, value) VALUES
  ('auto_purge_inactive', 'false'),
  ('dpdp_consent_version', '2.0'),
  ('audit_retention_days', '180')
ON CONFLICT (key) DO NOTHING;

-- ── incident_reports (depends on: users) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 TEXT NOT NULL,
  severity             TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical','high','medium','low')),
  description          TEXT NOT NULL,
  affected_users_count INTEGER DEFAULT 0,
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reported_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','closed')),
  resolution_notes     TEXT,
  resolved_at          TIMESTAMPTZ,
  cert_in_reported     BOOLEAN DEFAULT FALSE,
  cert_in_reported_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incident_status   ON incident_reports(status);
CREATE INDEX IF NOT EXISTS idx_incident_severity ON incident_reports(severity);

-- ── uploads (depends on: users) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  category        TEXT NOT NULL,
  storage_backend TEXT,
  storage_key     TEXT,
  bucket          TEXT,
  original_name   TEXT,
  content_type    TEXT,
  file_path       VARCHAR(512),
  file_size_bytes BIGINT,
  size_bytes      BIGINT,
  checksum_sha256 TEXT,
  meta            JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uploads_category ON uploads(category);
CREATE INDEX IF NOT EXISTS idx_uploads_uploader ON uploads(uploader_id);
CREATE INDEX IF NOT EXISTS idx_uploads_created  ON uploads(created_at DESC);

-- ── app builder tables (depend on: state_apps, users) ────────────────────────
CREATE TABLE IF NOT EXISTS app_code_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID REFERENCES state_apps(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  language    TEXT NOT NULL,
  size_bytes  BIGINT DEFAULT 0,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_code_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id          UUID REFERENCES app_code_files(id) ON DELETE CASCADE,
  commit_hash      TEXT NOT NULL,
  message          TEXT DEFAULT 'Auto-commit',
  content_snapshot TEXT NOT NULL,
  committed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_uiux_assets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         UUID REFERENCES state_apps(id) ON DELETE SET NULL,
  filename       TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  asset_type     TEXT NOT NULL,
  size_bytes     BIGINT DEFAULT 0,
  description    TEXT DEFAULT '',
  status         TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  optimized      BOOLEAN DEFAULT FALSE,
  review_comment TEXT,
  reviewed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_asset_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     UUID REFERENCES app_uiux_assets(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  comment_text TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_db_instances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  host        TEXT DEFAULT 'localhost',
  port        INTEGER DEFAULT 5432,
  db_name     TEXT DEFAULT 'mitra_app',
  username    TEXT DEFAULT 'postgres',
  is_isolated BOOLEAN DEFAULT FALSE,
  linked_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_builds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            UUID REFERENCES state_apps(id) ON DELETE SET NULL,
  app_name          TEXT NOT NULL,
  target_state      TEXT NOT NULL,
  theme_color       TEXT DEFAULT '#6366f1',
  export_formats    JSONB DEFAULT '["apk","aab"]',
  status            TEXT DEFAULT 'queued' CHECK (status IN ('queued','building','success','failed','cancelled','published')),
  run_optimization  BOOLEAN DEFAULT FALSE,
  published_regions JSONB,
  published_at      TIMESTAMPTZ,
  triggered_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_build_logs (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id  UUID REFERENCES app_builds(id) ON DELETE CASCADE,
  log_line  TEXT NOT NULL,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_layouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID REFERENCES state_apps(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  screen_name   TEXT DEFAULT 'Main Screen',
  layout_json   JSONB DEFAULT '[]',
  element_count INTEGER DEFAULT 0,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_builder_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT UNIQUE NOT NULL,
  encrypted_value TEXT,
  masked_value    TEXT,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_builder_rbac (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role              TEXT UNIQUE NOT NULL,
  can_build         BOOLEAN DEFAULT FALSE,
  can_publish       BOOLEAN DEFAULT FALSE,
  can_upload_code   BOOLEAN DEFAULT FALSE,
  can_upload_assets BOOLEAN DEFAULT FALSE,
  can_manage_db     BOOLEAN DEFAULT FALSE,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO app_builder_rbac (id, role, can_build, can_publish, can_upload_code, can_upload_assets, can_manage_db)
VALUES
  (gen_random_uuid(), 'superadmin', TRUE,  TRUE,  TRUE,  TRUE,  TRUE),
  (gen_random_uuid(), 'admin',      TRUE,  TRUE,  TRUE,  TRUE,  FALSE),
  (gen_random_uuid(), 'developer',  TRUE,  FALSE, TRUE,  TRUE,  FALSE),
  (gen_random_uuid(), 'designer',   FALSE, FALSE, FALSE, TRUE,  FALSE),
  (gen_random_uuid(), 'viewer',     FALSE, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (role) DO NOTHING;

-- ── tenant_app_files (depends on: users) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_app_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name         TEXT NOT NULL,
  target_state     TEXT NOT NULL,
  platform         TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android','ios','both')),
  version_code     INTEGER NOT NULL DEFAULT 100,
  version_name     TEXT NOT NULL,
  build_status     TEXT NOT NULL DEFAULT 'building' CHECK (build_status IN ('building','live','update_pending','deprecated','failed')),
  file_size_mb     NUMERIC(8,2),
  storage_path     TEXT,
  sha256_hash      TEXT,
  skin_name        TEXT,
  primary_language TEXT,
  active_students  INTEGER NOT NULL DEFAULT 0,
  last_ota_push    TIMESTAMPTZ,
  built_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_files_state  ON tenant_app_files(target_state);
CREATE INDEX IF NOT EXISTS idx_tenant_files_status ON tenant_app_files(build_status);

-- ── failed_logins (depends on: users) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS failed_logins (
  id         SERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  ip_address VARCHAR(45),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_failed_logins_user_ip ON failed_logins(user_id, ip_address);
CREATE INDEX IF NOT EXISTS idx_failed_logins_created_at ON failed_logins(user_id, created_at DESC);

-- ── password_reset_tokens (depends on: users) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['push_notifications','users','incident_reports']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_' || tbl) THEN
      EXECUTE format(
        'CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
        tbl, tbl
      );
    END IF;
  END LOOP;
END;
$$;

-- ── Views ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vw_curriculum_summary AS
SELECT s.name AS state_name, csh.state_code,
       jsonb_array_length(csh.structure) AS class_count, csh.updated_at
FROM curriculum_state_hierarchy csh
LEFT JOIN india_states s ON s.code = csh.state_code
ORDER BY state_name;

CREATE OR REPLACE VIEW vw_ar_assets_by_class AS
SELECT class_name, subject, COUNT(*) AS asset_count,
       COUNT(DISTINCT topic) AS topic_count,
       array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL) AS languages,
       MAX(created_at) AS latest_upload
FROM unity_assets
WHERE status NOT IN ('archived','rejected')
GROUP BY class_name, subject ORDER BY class_name, subject;

CREATE OR REPLACE VIEW vw_quiz_coverage AS
SELECT q.class_name, q.subject, COUNT(*) AS quiz_count,
       SUM(q.question_count) AS total_questions,
       COUNT(*) FILTER (WHERE q.status='live') AS live_quizzes,
       COUNT(*) FILTER (WHERE q.status='draft') AS draft_quizzes
FROM quizzes q GROUP BY q.class_name, q.subject ORDER BY q.class_name, q.subject;

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_admin_only ON audit_logs;
CREATE POLICY audit_logs_admin_only ON audit_logs FOR ALL
  USING (current_setting('app.user_role', TRUE) IN ('admin','superadmin'));

DROP POLICY IF EXISTS push_notifs_staff_read ON push_notifications;
CREATE POLICY push_notifs_staff_read ON push_notifications FOR SELECT
  USING (current_setting('app.user_role', TRUE) IN ('admin','superadmin','teacher','district'));

-- ════════════════════════════════════════════════════════════════════════════
-- Schema complete. Run seed.js to create the first admin user.
-- ════════════════════════════════════════════════════════════════════════════
