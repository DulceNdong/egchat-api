-- ══════════════════════════════════════════════════════════════════
-- EGCHAT — KYC / AML complete schema for Supabase
-- Idempotent migration aligned with server/egchat-api/index.js
-- Proyecto: fqfxtjnfhvpggssbymdn
-- ══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Helpers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_egchat_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fn_egchat_audit_log_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'kyc_audit_log is immutable: % is not allowed', TG_OP;
END;
$$;

-- ── Admin users / compliance roles ───────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_MANAGER', 'COMPLIANCE_OFFICER',
    'ANALYST', 'BANK_APPROVER', 'BANK_VIEWER', 'REGULATOR_AUDITOR'
  )),
  entity TEXT NOT NULL DEFAULT 'EGCHAT' CHECK (entity IN ('EGCHAT', 'BANGE', 'ANIF', 'REGULATOR')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  two_factor_secret TEXT,
  two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_verified_at TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON admin_users;
CREATE TRIGGER trg_admin_users_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);
CREATE INDEX IF NOT EXISTS idx_admin_users_entity ON admin_users(entity);
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(is_active) WHERE is_active = TRUE;

-- ── Users KYC status ─────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_kyc_status TEXT DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_kyc_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_kyc_reviewer_id UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_kyc_reject_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_users_wallet_kyc_status') THEN
    ALTER TABLE users ADD CONSTRAINT ck_users_wallet_kyc_status
      CHECK (wallet_kyc_status IN ('none','pending','approved','rejected','suspended'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_wallet_kyc_status ON users(wallet_kyc_status);

-- ── Main KYC application table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'low',
  bank_decision TEXT,
  bank_notes TEXT,
  bank_decision_at TIMESTAMPTZ,
  bank_reviewer_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_by_admin UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  reviewer_notes TEXT,
  device_info JSONB DEFAULT '{}',
  ip_address TEXT,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS risk_level TEXT DEFAULT 'low';
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bank_decision TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bank_notes TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bank_decision_at TIMESTAMPTZ;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS bank_reviewer_id UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS reviewed_by_admin UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS reviewer_notes TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS device_info JSONB DEFAULT '{}';
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_full_name_not_null;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_birth_date_not_null;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_doc_type_not_null;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_doc_number_not_null;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_user_id_key;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_status_check;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS kyc_verifications_risk_level_check;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS ck_kyc_verifications_status;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS ck_kyc_verifications_risk_level;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS ck_kyc_verifications_risk_score;
ALTER TABLE kyc_verifications DROP CONSTRAINT IF EXISTS ck_kyc_verifications_bank_decision;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_verifications' AND column_name='full_name') THEN
    ALTER TABLE kyc_verifications ALTER COLUMN full_name DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_verifications' AND column_name='birth_date') THEN
    ALTER TABLE kyc_verifications ALTER COLUMN birth_date DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_verifications' AND column_name='doc_type') THEN
    ALTER TABLE kyc_verifications ALTER COLUMN doc_type DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_verifications' AND column_name='doc_number') THEN
    ALTER TABLE kyc_verifications ALTER COLUMN doc_number DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE kyc_verifications ADD CONSTRAINT ck_kyc_verifications_status
  CHECK (status IN ('draft','IN_PROGRESS','submitted','PENDING_REVIEW','PENDING_INFO','under_review','AUTO_APPROVED','MANUAL_REVIEW','approved','APPROVED','rejected','REJECTED','BLOCKED','suspended'));
ALTER TABLE kyc_verifications ADD CONSTRAINT ck_kyc_verifications_risk_level
  CHECK (risk_level IN ('low','medium','high','critical'));
ALTER TABLE kyc_verifications ADD CONSTRAINT ck_kyc_verifications_risk_score
  CHECK (risk_score >= 0 AND risk_score <= 100);
ALTER TABLE kyc_verifications ADD CONSTRAINT ck_kyc_verifications_bank_decision
  CHECK (bank_decision IS NULL OR bank_decision IN ('APPROVED','REJECTED','PENDING','REQUEST_INFO','BLOCKED'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_session_id ON kyc_verifications(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_user_id ON kyc_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_verifications(status);
CREATE INDEX IF NOT EXISTS idx_kyc_submitted_at ON kyc_verifications(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_bank_decision ON kyc_verifications(bank_decision) WHERE bank_decision IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_risk_score ON kyc_verifications(risk_score DESC);

DROP TRIGGER IF EXISTS trg_kyc_updated_at ON kyc_verifications;
CREATE TRIGGER trg_kyc_updated_at
  BEFORE UPDATE ON kyc_verifications
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_set_updated_at();

-- ── Orchestrator attempts/idempotency ────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID REFERENCES kyc_verifications(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  idempotency_key TEXT,
  step TEXT NOT NULL DEFAULT 'init',
  status TEXT NOT NULL DEFAULT 'started',
  request_hash TEXT,
  response JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_attempt_idempotency ON kyc_attempts(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_attempts_user ON kyc_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_attempts_session ON kyc_attempts(session_id);

DROP TRIGGER IF EXISTS trg_kyc_attempts_updated_at ON kyc_attempts;
CREATE TRIGGER trg_kyc_attempts_updated_at
  BEFORE UPDATE ON kyc_attempts
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_set_updated_at();

-- ── Personal data ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_personal_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL UNIQUE REFERENCES kyc_verifications(id) ON DELETE CASCADE,
  full_name TEXT,
  date_of_birth DATE,
  place_of_birth TEXT,
  nationality TEXT DEFAULT 'GQ',
  sex TEXT,
  marital_status TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  country TEXT DEFAULT 'GQ',
  phone TEXT,
  email TEXT,
  profession TEXT,
  employer TEXT,
  monthly_income_range TEXT,
  source_of_funds TEXT,
  politically_exposed BOOLEAN NOT NULL DEFAULT FALSE,
  pep_details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE kyc_personal_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_kyc_personal_app ON kyc_personal_data(application_id);
CREATE INDEX IF NOT EXISTS idx_kyc_personal_pep ON kyc_personal_data(politically_exposed) WHERE politically_exposed = TRUE;

DROP TRIGGER IF EXISTS trg_kyc_personal_updated_at ON kyc_personal_data;
CREATE TRIGGER trg_kyc_personal_updated_at
  BEFORE UPDATE ON kyc_personal_data
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_set_updated_at();

-- ── Documents and biometrics ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_id UUID REFERENCES kyc_verifications(id) ON DELETE CASCADE,
  application_id UUID REFERENCES kyc_verifications(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  document_type TEXT,
  document_number TEXT,
  expiry_date DATE,
  side TEXT,
  file_url TEXT,
  mime_type TEXT DEFAULT 'image/jpeg',
  file_size INTEGER,
  front_image_url TEXT,
  back_image_url TEXT,
  selfie_url TEXT,
  ocr_confidence NUMERIC(5,4),
  face_match_score NUMERIC(5,4),
  liveness_passed BOOLEAN,
  liveness_score NUMERIC(5,4),
  ocr_raw_data JSONB DEFAULT '{}',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES kyc_verifications(id) ON DELETE CASCADE;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS document_type TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS document_number TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS side TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS front_image_url TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS back_image_url TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS selfie_url TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC(5,4);
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS face_match_score NUMERIC(5,4);
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS liveness_passed BOOLEAN;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS liveness_score NUMERIC(5,4);
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS ocr_raw_data JSONB DEFAULT '{}';
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE kyc_documents SET application_id = kyc_id WHERE application_id IS NULL AND kyc_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_documents' AND column_name='kyc_id') THEN
    ALTER TABLE kyc_documents ALTER COLUMN kyc_id DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_documents' AND column_name='user_id') THEN
    ALTER TABLE kyc_documents ALTER COLUMN user_id DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_documents' AND column_name='doc_type') THEN
    ALTER TABLE kyc_documents ALTER COLUMN doc_type DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kyc_documents' AND column_name='file_url') THEN
    ALTER TABLE kyc_documents ALTER COLUMN file_url DROP NOT NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_documents_application ON kyc_documents(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_docs_kyc ON kyc_documents(kyc_id) WHERE kyc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_docs_app ON kyc_documents(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kyc_docs_liveness ON kyc_documents(liveness_passed) WHERE liveness_passed IS NOT NULL;

DROP TRIGGER IF EXISTS trg_kyc_documents_updated_at ON kyc_documents;
CREATE TRIGGER trg_kyc_documents_updated_at
  BEFORE UPDATE ON kyc_documents
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_set_updated_at();

-- ── Screening results ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_screening_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES kyc_verifications(id) ON DELETE CASCADE,
  screening_type TEXT NOT NULL CHECK (screening_type IN ('SANCTIONS','PEP','ADVERSE_MEDIA','INTERPOL','LOCAL_LIST')),
  provider TEXT NOT NULL DEFAULT 'internal',
  provider_ref TEXT,
  match_found BOOLEAN NOT NULL DEFAULT FALSE,
  match_score NUMERIC(5,4),
  match_details JSONB NOT NULL DEFAULT '{}',
  reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  false_positive BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screening_app ON kyc_screening_results(application_id);
CREATE INDEX IF NOT EXISTS idx_screening_type ON kyc_screening_results(screening_type);
CREATE INDEX IF NOT EXISTS idx_screening_match ON kyc_screening_results(match_found) WHERE match_found = TRUE;
CREATE INDEX IF NOT EXISTS idx_screening_provider ON kyc_screening_results(provider);

-- ── Immutable audit log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_audit_log (
  id BIGSERIAL PRIMARY KEY,
  application_id UUID REFERENCES kyc_verifications(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  performed_by UUID,
  performed_role TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_kyc_audit_no_update ON kyc_audit_log;
CREATE TRIGGER trg_kyc_audit_no_update
  BEFORE UPDATE ON kyc_audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_audit_log_immutable();

DROP TRIGGER IF EXISTS trg_kyc_audit_no_delete ON kyc_audit_log;
CREATE TRIGGER trg_kyc_audit_no_delete
  BEFORE DELETE ON kyc_audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_audit_log_immutable();

CREATE INDEX IF NOT EXISTS idx_audit_log_app ON kyc_audit_log(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON kyc_audit_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON kyc_audit_log(admin_id) WHERE admin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON kyc_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON kyc_audit_log(created_at DESC);

-- ── Transaction AML flags ────────────────────────────────────────
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'XAF';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS flag_type TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS flagged_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS aml_reviewed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS aml_reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS aml_reviewed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS aml_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_flagged ON transactions(flagged) WHERE flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_transactions_flag_type ON transactions(flag_type) WHERE flag_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_amount ON transactions(amount DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

-- ── Suspicious activity reports ──────────────────────────────────
CREATE TABLE IF NOT EXISTS suspicious_activity_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  application_id UUID REFERENCES kyc_verifications(id) ON DELETE SET NULL,
  transaction_id UUID,
  transaction_ids UUID[] DEFAULT '{}',
  reported_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  report_type TEXT NOT NULL DEFAULT 'SAR' CHECK (report_type IN ('SAR','CTR','STR')),
  suspicious_reason TEXT,
  description TEXT,
  indicators JSONB NOT NULL DEFAULT '[]',
  subject_name TEXT,
  subject_id_type TEXT,
  subject_id_num TEXT,
  amount NUMERIC(15,2),
  amount_involved NUMERIC(15,2),
  currency TEXT DEFAULT 'XAF',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_REVIEW','APPROVED','SENT_TO_ANIF','ACKNOWLEDGED','CLOSED')),
  anif_reference TEXT,
  anif_response JSONB NOT NULL DEFAULT '{}',
  sif_payload JSONB NOT NULL DEFAULT '{}',
  payload JSONB NOT NULL DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_sar_updated_at ON suspicious_activity_reports;
CREATE TRIGGER trg_sar_updated_at
  BEFORE UPDATE ON suspicious_activity_reports
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_sar_status ON suspicious_activity_reports(status);
CREATE INDEX IF NOT EXISTS idx_sar_user ON suspicious_activity_reports(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sar_application ON suspicious_activity_reports(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sar_detected_at ON suspicious_activity_reports(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_sar_anif_reference ON suspicious_activity_reports(anif_reference) WHERE anif_reference IS NOT NULL;

-- ── Views for dashboards ─────────────────────────────────────────
CREATE OR REPLACE VIEW kyc_dashboard_view AS
SELECT
  kv.id AS application_id,
  kv.session_id,
  kv.status,
  kv.risk_level,
  kv.risk_score,
  kv.bank_decision,
  kv.submitted_at,
  kv.reviewed_at,
  kv.created_at,
  u.id AS user_id,
  u.phone AS user_phone,
  u.wallet_kyc_status,
  pd.full_name,
  pd.nationality,
  pd.date_of_birth,
  pd.profession,
  pd.monthly_income_range,
  pd.source_of_funds,
  pd.politically_exposed,
  doc.document_type,
  doc.document_number,
  doc.ocr_confidence,
  doc.face_match_score,
  doc.liveness_passed,
  (SELECT COUNT(*) FROM kyc_screening_results sr WHERE sr.application_id = kv.id AND sr.match_found = TRUE) AS screening_hits
FROM kyc_verifications kv
JOIN users u ON u.id = kv.user_id
LEFT JOIN kyc_personal_data pd ON pd.application_id = kv.id
LEFT JOIN kyc_documents doc ON doc.application_id = kv.id;

CREATE OR REPLACE VIEW pending_sars_view AS
SELECT
  sar.*,
  sar.detected_at + INTERVAL '72 hours' AS deadline_at,
  (sar.detected_at + INTERVAL '72 hours') < NOW() AS overdue
FROM suspicious_activity_reports sar
WHERE sar.status NOT IN ('SENT_TO_ANIF','ACKNOWLEDGED','CLOSED')
ORDER BY sar.detected_at ASC;

-- ── Status sync + audit triggers ─────────────────────────────────
CREATE OR REPLACE FUNCTION fn_egchat_sync_user_kyc_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users SET
    wallet_kyc_status = CASE
      WHEN NEW.status IN ('approved','APPROVED','AUTO_APPROVED') THEN 'approved'
      WHEN NEW.status IN ('rejected','REJECTED','BLOCKED') THEN 'rejected'
      WHEN NEW.status = 'suspended' THEN 'suspended'
      WHEN NEW.status IN ('submitted','IN_PROGRESS','PENDING_REVIEW','PENDING_INFO','under_review','MANUAL_REVIEW') THEN 'pending'
      ELSE wallet_kyc_status
    END,
    wallet_kyc_submitted_at = CASE WHEN NEW.submitted_at IS NOT NULL THEN NEW.submitted_at ELSE wallet_kyc_submitted_at END,
    wallet_kyc_reviewed_at = CASE WHEN NEW.status IN ('approved','APPROVED','AUTO_APPROVED','rejected','REJECTED','BLOCKED','suspended') THEN COALESCE(NEW.reviewed_at, NOW()) ELSE wallet_kyc_reviewed_at END,
    wallet_kyc_reject_reason = CASE WHEN NEW.status IN ('rejected','REJECTED','BLOCKED') THEN NEW.rejection_reason ELSE wallet_kyc_reject_reason END
  WHERE id = NEW.user_id;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO kyc_audit_log(application_id, user_id, action, performed_by, performed_role, details)
    VALUES (NEW.id, NEW.user_id, 'KYC_STATUS_CHANGED', COALESCE(NEW.reviewed_by_admin, NEW.user_id), CASE WHEN NEW.reviewed_by_admin IS NULL THEN 'system' ELSE 'admin' END,
      jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status, 'risk_score', NEW.risk_score, 'risk_level', NEW.risk_level));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_kyc_status ON kyc_verifications;
CREATE TRIGGER trg_sync_kyc_status
  AFTER INSERT OR UPDATE ON kyc_verifications
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_sync_user_kyc_status();

CREATE OR REPLACE FUNCTION fn_egchat_tx_flag_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.flagged = TRUE AND (TG_OP = 'INSERT' OR OLD.flagged IS DISTINCT FROM NEW.flagged) THEN
    INSERT INTO kyc_audit_log(user_id, admin_id, action, performed_by, performed_role, details)
    VALUES (NEW.user_id, NEW.flagged_by, 'TX_FLAGGED', COALESCE(NEW.flagged_by, NEW.user_id), CASE WHEN NEW.flagged_by IS NULL THEN 'system' ELSE 'admin' END,
      jsonb_build_object('transaction_id', NEW.id, 'amount', NEW.amount, 'currency', NEW.currency, 'flag_type', NEW.flag_type, 'flag_reason', NEW.flag_reason));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tx_flag_audit ON transactions;
CREATE TRIGGER trg_tx_flag_audit
  AFTER INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION fn_egchat_tx_flag_audit();

SELECT 'EGCHAT KYC/AML schema aligned OK' AS resultado;
