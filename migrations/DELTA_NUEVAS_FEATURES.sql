-- ══════════════════════════════════════════════════════════════════
-- EGCHAT — Migración DELTA (nuevas features de esta sesión)
-- Ejecutar en: https://supabase.com/dashboard/project/fqfxtjnfhvpggssbymdn/sql/new
-- DESPUÉS de haber ejecutado EJECUTAR_TODO_EN_UN_PASO.sql
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Columnas faltantes en chat_messages ────────────────────────
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS album_urls TEXT[] DEFAULT '{}';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS voice_transcript TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded_from TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]';

-- ── 2. Settings en chats (broadcast_mode, invite_link) ────────────
ALTER TABLE chats ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';

-- ── 3. djangue_notifications — armonizar esquema con el dispatcher ─
-- El esquema base ya existe, solo añadimos columnas si faltan
ALTER TABLE djangue_notifications ADD COLUMN IF NOT EXISTS sent BOOLEAN DEFAULT FALSE;
ALTER TABLE djangue_notifications ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_djangue_notif_sent ON djangue_notifications(sent, user_id);

-- ── 4. djangue_members — añadir columna role ─────────────────────
ALTER TABLE djangue_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member'
  CHECK (role IN ('owner', 'secretary', 'member'));

-- ── 5. djangue_contributions — columna has_justified ─────────────
ALTER TABLE djangue_contributions ADD COLUMN IF NOT EXISTS has_justified BOOLEAN DEFAULT FALSE;

-- ── 6. Tabla para story reactions ─────────────────────────────────
CREATE TABLE IF NOT EXISTS story_reactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  story_id UUID NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(story_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_story_reactions_story ON story_reactions(story_id);

-- ── 7. Columna voice_transcript en chat_messages (alias) ──────────
-- Ya añadida arriba

-- ── 8. Índice en chat_messages para álbumes ───────────────────────
CREATE INDEX IF NOT EXISTS idx_chat_messages_type ON chat_messages(type, chat_id);

-- ── 9. djangue_groups — columna biweekly en frequency check ────────
-- La constraint original no incluye 'biweekly', lo añadimos de forma segura
DO $$
BEGIN
  BEGIN
    ALTER TABLE djangue_groups DROP CONSTRAINT IF EXISTS djangue_groups_frequency_check;
    ALTER TABLE djangue_groups ADD CONSTRAINT djangue_groups_frequency_check
      CHECK (frequency IN ('daily','weekly','biweekly','monthly','annual'));
  EXCEPTION WHEN others THEN
    -- ignorar si falla (ya existe con los valores correctos)
  END;
END $$;

-- ── 10. Tabla scheduled_messages (backup en BD, opcional) ──────────
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'text',
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(scheduled_at, sent);

SELECT 'Delta migration completada OK' AS resultado;
