-- ══════════════════════════════════════════════════════════════════
-- Migración: voip_push_tokens
-- Almacena los tokens VoIP de PushKit (iOS) para llamadas con app cerrada.
-- Ejecutar en Supabase SQL Editor.
-- ══════════════════════════════════════════════════════════════════

-- Tabla principal
CREATE TABLE IF NOT EXISTS voip_push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Un usuario → un token VoIP activo (se reemplaza al registrar de nuevo)
  UNIQUE(user_id)
);

-- Índice para lookups rápidos por user_id (al enviar llamadas)
CREATE INDEX IF NOT EXISTS idx_voip_push_tokens_user_id
  ON voip_push_tokens(user_id);

-- RLS: solo el propio usuario y el service role pueden ver/modificar
ALTER TABLE voip_push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voip_tokens_own" ON voip_push_tokens;
CREATE POLICY "voip_tokens_own"
  ON voip_push_tokens
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- El servidor (service role) puede leer todos los tokens para enviar llamadas
DROP POLICY IF EXISTS "voip_tokens_service" ON voip_push_tokens;
CREATE POLICY "voip_tokens_service"
  ON voip_push_tokens
  FOR SELECT
  USING (true);  -- service_role bypasses RLS automáticamente

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_voip_token_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS voip_push_tokens_updated_at ON voip_push_tokens;
CREATE TRIGGER voip_push_tokens_updated_at
  BEFORE UPDATE ON voip_push_tokens
  FOR EACH ROW EXECUTE FUNCTION update_voip_token_timestamp();

-- Limpiar tokens inactivos (+30 días sin actualizar)
-- Ejecutar periódicamente o via cron job en Supabase
-- DELETE FROM voip_push_tokens WHERE updated_at < NOW() - INTERVAL '30 days';
