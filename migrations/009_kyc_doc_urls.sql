-- ── Migración 009: Añadir columnas de URLs de documentos a kyc_verifications ──
-- Necesario para el flujo legado (kycAPI / kyc.ts) que envía las URLs
-- directamente en POST /api/kyc/submit en lugar de usar kyc_documents.

ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS doc_front_url TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS doc_back_url  TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS selfie_url    TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS full_name     TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS birth_date    TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS nationality   TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS doc_type      TEXT;
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS doc_number    TEXT;
