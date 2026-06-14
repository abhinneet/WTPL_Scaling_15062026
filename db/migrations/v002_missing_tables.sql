-- ═══════════════════════════════════════════════════════════════════════════
-- MITRA Database Migration v002 — Missing Tables & Column Fixes
-- Run this in Cloud SQL Studio connected to the `mitra` database
-- Date: 2026-06-03
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. curriculum_topics ─────────────────────────────────────────────────────
-- Used by notifications.js filters endpoint
-- /api/notifications/filters fetches classes, subjects and topics from here

CREATE TABLE IF NOT EXISTS curriculum_topics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_name  VARCHAR(200) NOT NULL,
  class_name  VARCHAR(50),
  subject     VARCHAR(100),
  language    VARCHAR(50),
  state_code  VARCHAR(10),
  node_id     UUID REFERENCES curriculum_nodes(id) ON DELETE SET NULL,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_curriculum_topics_class
  ON curriculum_topics(class_name);
CREATE INDEX IF NOT EXISTS idx_curriculum_topics_subject
  ON curriculum_topics(subject);
CREATE INDEX IF NOT EXISTS idx_curriculum_topics_active
  ON curriculum_topics(is_active);

-- ── 2. ad_campaigns ──────────────────────────────────────────────────────────
-- Used by advertisements.js for full campaign management

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  advertiser      VARCHAR(200),
  description     TEXT,
  media_type      VARCHAR(50) DEFAULT 'video',
  storage_key     TEXT,
  file_size_bytes BIGINT,
  target_states   JSONB DEFAULT '[]',
  target_classes  JSONB DEFAULT '[]',
  target_subjects JSONB DEFAULT '[]',
  target_languages JSONB DEFAULT '[]',
  publish_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  scheduled_at    TIMESTAMPTZ,
  status          VARCHAR(50) DEFAULT 'draft',
  push_per_day    INT DEFAULT 5,
  before_topic    BOOLEAN DEFAULT FALSE,
  skip_if_watched BOOLEAN DEFAULT TRUE,
  cooldown_hours  INT DEFAULT 2,
  impressions     BIGINT DEFAULT 0,
  views           BIGINT DEFAULT 0,
  clicks          BIGINT DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status
  ON ad_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_publish
  ON ad_campaigns(publish_at);

-- ── 3. compliance_findings ────────────────────────────────────────────────────
-- Used by compliance.js resolve findings endpoint
-- audit_findings exists but compliance_findings is different

CREATE TABLE IF NOT EXISTS compliance_findings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(300) NOT NULL,
  description   TEXT,
  severity      VARCHAR(50) DEFAULT 'medium',
  category      VARCHAR(100),
  status        VARCHAR(50) DEFAULT 'open',
  law_reference VARCHAR(200),
  resolution    TEXT,
  resolved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_findings_status
  ON compliance_findings(status);
CREATE INDEX IF NOT EXISTS idx_compliance_findings_severity
  ON compliance_findings(severity);

-- ── 4. app_sessions ──────────────────────────────────────────────────────────
-- Used by compliance.js purge-user endpoint (gracefully handled with .catch())
-- Also used in data export for DPDP compliance

CREATE TABLE IF NOT EXISTS app_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id   VARCHAR(200),
  ip_address  INET,
  user_agent  TEXT,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  is_active   BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_user
  ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_started
  ON app_sessions(started_at DESC);

-- ── 5. quiz_attempts — Add missing user_identifier column ────────────────────
-- compliance.js line 98: UPDATE quiz_attempts SET user_identifier='[PURGED]'
-- This column may be missing from the current schema

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS user_identifier VARCHAR(200),
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_identifier
  ON quiz_attempts(user_identifier)
  WHERE user_identifier IS NOT NULL;

-- ── 6. notification_log — Rename column check ────────────────────────────────
-- notifications.js uses notification_log table which exists
-- Verify delivery_status column exists (used in index idx_notif_log_status)
-- Already in DB per index audit ✅

-- ── 7. audit_logs — Add missing columns used by auditLogger.js ───────────────
-- Code inserts: id, user_id, action, resource_type, resource_id, ip_address,
--               details, created_at
-- DB has all these ✅ plus actor_id, occurred_at etc.
-- No changes needed for audit_logs ✅

-- ── 8. Seed compliance_findings with initial audit data ─────────────────────
-- The dashboard shows audit findings - seed with common DPDP findings

INSERT INTO compliance_findings (id, title, description, severity, category, status, law_reference)
VALUES
  (gen_random_uuid(), 'Data Retention Policy Documentation', 
   'Formal data retention schedule not yet documented in writing', 
   'medium', 'DPDPA 2023', 'open', 'DPDPA §8(7)'),
  (gen_random_uuid(), 'Privacy Policy Public Accessibility', 
   'Privacy policy must be accessible from the app home screen', 
   'high', 'IT Rules 2021', 'open', 'IT Rules §4(1)'),
  (gen_random_uuid(), 'Student Data Export Mechanism', 
   'Right to data portability not yet implemented for students', 
   'medium', 'DPDPA 2023', 'open', 'DPDPA §12'),
  (gen_random_uuid(), 'Breach Response Drill', 
   'Annual incident response drill not yet conducted', 
   'low', 'CERT-In 2022', 'open', 'CERT-In Direction §4')
ON CONFLICT DO NOTHING;

-- ── 9. Seed curriculum_topics from existing unity_assets ─────────────────────
-- Populate curriculum_topics from existing AR asset data so
-- notification filters work immediately

INSERT INTO curriculum_topics (id, topic_name, class_name, subject, language, is_active)
SELECT DISTINCT
  gen_random_uuid(),
  topic AS topic_name,
  class_name,
  subject,
  language,
  TRUE
FROM unity_assets
WHERE topic IS NOT NULL
  AND topic != ''
ON CONFLICT DO NOTHING;

-- ── 10. Mark migration as complete ───────────────────────────────────────────
INSERT INTO _migrations (filename, applied_at)
VALUES ('v002_missing_tables.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES — Run these after migration to confirm success
-- ═══════════════════════════════════════════════════════════════════════════

-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- AND table_name IN (
--   'curriculum_topics', 'ad_campaigns', 
--   'compliance_findings', 'app_sessions'
-- )
-- ORDER BY table_name;

-- Expected result: 4 rows returned ✅
