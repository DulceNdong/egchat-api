-- ══════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Soft-delete de mensajes con retención de 5 años
-- Ejecutar en Supabase SQL Editor
-- Fix: retention_expires_at como columna normal + trigger (GENERATED AS
--      no soporta INTERVAL en PostgreSQL por no ser inmutable)
-- ══════════════════════════════════════════════════════════════════════

-- 1. Agregar columnas de soft-delete a la tabla messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at           TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by           UUID        REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Ampliar message_deletions con retention_expires_at (columna normal)
ALTER TABLE message_deletions
  ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ DEFAULT NULL;

-- 3. Trigger: al hacer soft-delete en messages, calcular retention_expires_at
CREATE OR REPLACE FUNCTION trg_messages_set_retention()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    -- Recién marcado como borrado → retener 5 años
    NEW.retention_expires_at := NEW.deleted_at + INTERVAL '5 years';
  ELSIF NEW.deleted_at IS NULL THEN
    -- Si se "des-borra" (poco probable pero seguro), limpiar retention
    NEW.retention_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_retention ON messages;
CREATE TRIGGER trg_messages_retention
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION trg_messages_set_retention();

-- 4. Trigger: al insertar en message_deletions, calcular retention_expires_at
CREATE OR REPLACE FUNCTION trg_msg_deletions_set_retention()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.retention_expires_at := NEW.deleted_at + INTERVAL '5 years';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_msg_deletions_retention ON message_deletions;
CREATE TRIGGER trg_msg_deletions_retention
  BEFORE INSERT OR UPDATE ON message_deletions
  FOR EACH ROW EXECUTE FUNCTION trg_msg_deletions_set_retention();

-- 5. Rellenar retention_expires_at en filas ya existentes (si las hay)
UPDATE messages
  SET retention_expires_at = deleted_at + INTERVAL '5 years'
  WHERE deleted_at IS NOT NULL AND retention_expires_at IS NULL;

UPDATE message_deletions
  SET retention_expires_at = deleted_at + INTERVAL '5 years'
  WHERE retention_expires_at IS NULL;

-- 6. Índices de eficiencia para purgas programadas
CREATE INDEX IF NOT EXISTS idx_messages_deleted_at
  ON messages(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_retention_expires
  ON messages(retention_expires_at) WHERE retention_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_deletions_retention
  ON message_deletions(retention_expires_at);

-- 7. Vista de mensajes activos (excluye los borrados para todos)
CREATE OR REPLACE VIEW messages_active AS
  SELECT * FROM messages WHERE deleted_at IS NULL;

-- 8. Función de purga física (llamar manualmente o vía pg_cron)
--    SELECT purge_expired_messages();
CREATE OR REPLACE FUNCTION purge_expired_messages()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  deleted_count INT := 0;
  cnt INT;
BEGIN
  -- Purgar message_deletions ("para mí") expiradas
  DELETE FROM message_deletions
  WHERE retention_expires_at IS NOT NULL
    AND retention_expires_at < NOW();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  deleted_count := deleted_count + cnt;

  -- Purgar mensajes soft-deleted ("para todos") expirados
  DELETE FROM messages
  WHERE deleted_at IS NOT NULL
    AND retention_expires_at IS NOT NULL
    AND retention_expires_at < NOW();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  deleted_count := deleted_count + cnt;

  RETURN deleted_count;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-MIGRACIÓN
-- ══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'messages'
--   AND column_name IN ('deleted_at','deleted_by','retention_expires_at');
--
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'messages'::regclass;
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'message_deletions'::regclass;
