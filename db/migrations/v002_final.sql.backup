-- ═══════════════════════════════════════════════════════════════════════════
-- MITRA Database Migration v002 FINAL
-- Run in Cloud SQL Studio connected to `mitra` database
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ad_campaigns — Drop and recreate with correct columns ─────────────────

DROP TABLE IF EXISTS ad_campaigns CASCADE;

CREATE TABLE ad_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(200) NOT NULL,
  advertiser          VARCHAR(200),
  description         TEXT,
  media_type          VARCHAR(50) DEFAULT 'video',
  storage_key         TEXT,
  file_size_bytes     BIGINT,
  publish_at          TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  scheduled_at        TIMESTAMPTZ,
  publish_days        JSONB DEFAULT '["Mon","Tue","Wed","Thu","Fri"]',
  target_apps         JSONB DEFAULT '[]',
  target_states       JSONB DEFAULT '[]',
  target_districts    JSONB DEFAULT '[]',
  target_classes      JSONB DEFAULT '[]',
  target_subjects     JSONB DEFAULT '[]',
  target_languages    JSONB DEFAULT '[]',
  daily_push_limit    INT DEFAULT 5,
  show_before_topic   BOOLEAN DEFAULT FALSE,
  push_start_time     VARCHAR(10),
  push_end_time       VARCHAR(10),
  status              VARCHAR(50) DEFAULT 'draft',
  total_impressions   BIGINT DEFAULT 0,
  total_completions   BIGINT DEFAULT 0,
  total_clicks        BIGINT DEFAULT 0,
  avg_view_seconds    NUMERIC(8,2) DEFAULT 0,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status
  ON ad_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_publish
  ON ad_campaigns(publish_at);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_created_by
  ON ad_campaigns(created_by);

-- ── 2. curriculum_topics ─────────────────────────────────────────────────────

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

-- ── 3. compliance_findings ───────────────────────────────────────────────────

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

-- ── 5. quiz_attempts — Add missing columns ───────────────────────────────────

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS user_identifier VARCHAR(200),
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_identifier
  ON quiz_attempts(user_identifier)
  WHERE user_identifier IS NOT NULL;

-- ── 6. Seed compliance_findings ──────────────────────────────────────────────

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
   'low', 'CERT-In 2022', 'open', 'CERT-In Direction §4');

-- ── 7. Seed curriculum_topics from unity_assets ──────────────────────────────

INSERT INTO curriculum_topics (id, topic_name, class_name, subject, language, is_active)
SELECT DISTINCT
  gen_random_uuid(),
  topic,
  class_name,
  subject,
  language,
  TRUE
FROM unity_assets
WHERE topic IS NOT NULL AND topic != '';

-- ── VERIFY — Results should show 4 rows ──────────────────────────────────────

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN (
  'curriculum_topics',
  'ad_campaigns',
  'compliance_findings',
  'app_sessions'
)
ORDER BY table_name;

