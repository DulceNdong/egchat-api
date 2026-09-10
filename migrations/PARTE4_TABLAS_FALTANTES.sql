-- ═══════════════════════════════════════════════════════════════
-- EGCHAT — PARTE 4: tablas faltantes
-- Ejecutar en Supabase SQL Editor DESPUÉS de EJECUTAR_TODO_EN_UN_PASO.sql
-- Proyecto: fqfxtjnfhvpggssbymdn
-- ═══════════════════════════════════════════════════════════════

-- ── Mensajes programados ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  type VARCHAR(30) DEFAULT 'text',
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages(scheduled_at) WHERE sent = FALSE;

-- ── Widget data (pantalla de inicio) ───────────────────────────
CREATE TABLE IF NOT EXISTS widget_data (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chats_json JSONB DEFAULT '[]',
  unread_total INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Backups de chats en la nube ────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_backups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  file_url TEXT,
  file_size BIGINT DEFAULT 0,
  chat_count INTEGER DEFAULT 0,
  version VARCHAR(10) DEFAULT '2.0',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_backups_user
  ON chat_backups(user_id, created_at DESC);

-- ── Respuestas rápidas ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quick_replies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  shortcut VARCHAR(50) NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, shortcut)
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_user ON quick_replies(user_id);

-- ── Etiquetas de chats ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_labels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  chat_id TEXT NOT NULL,
  label VARCHAR(50) NOT NULL,
  color VARCHAR(20) DEFAULT '#00c8a0',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, chat_id, label)
);
CREATE INDEX IF NOT EXISTS idx_chat_labels_user ON chat_labels(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_labels_chat ON chat_labels(chat_id);

-- ── Mensajes fijados ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pinned_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  pinned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_pinned_messages_chat ON pinned_messages(chat_id);

-- ── Mensajes efímeros (config por chat) ───────────────────────
CREATE TABLE IF NOT EXISTS ephemeral_settings (
  chat_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  enabled BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(chat_id, user_id)
);

-- ── Log de actividad del usuario ───────────────────────────────
CREATE TABLE IF NOT EXISTS user_activity_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  type VARCHAR(30) NOT NULL,
  action VARCHAR(150) NOT NULL,
  description TEXT,
  ip_address INET,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_user
  ON user_activity_log(user_id, timestamp DESC);

-- ── Contactos sincronizados ────────────────────────────────────
CREATE TABLE IF NOT EXISTS synced_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  phone_hash TEXT NOT NULL,
  display_name VARCHAR(150),
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, phone_hash)
);
CREATE INDEX IF NOT EXISTS idx_synced_contacts_hash ON synced_contacts(phone_hash);

-- ── Configuración notificaciones (server-side) ─────────────────
CREATE TABLE IF NOT EXISTS user_notification_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notif_messages   BOOLEAN DEFAULT TRUE,
  notif_groups     BOOLEAN DEFAULT TRUE,
  notif_calls      BOOLEAN DEFAULT TRUE,
  notif_stories    BOOLEAN DEFAULT FALSE,
  notif_reactions  BOOLEAN DEFAULT TRUE,
  notif_transfers  BOOLEAN DEFAULT TRUE,
  notif_djangue    BOOLEAN DEFAULT TRUE,
  notif_moments    BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Columnas adicionales en tablas existentes ──────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(50) DEFAULT 'GQ';
ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'es';
ALTER TABLE users ADD COLUMN IF NOT EXISTS incognito_mode BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS online_status_visible BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(100);

ALTER TABLE chats ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_message_id TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS wallpaper_id VARCHAR(50) DEFAULT 'default';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

-- ── Índices adicionales de rendimiento ────────────────────────
CREATE INDEX IF NOT EXISTS idx_messages_chat_created
  ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_deleted
  ON messages(deleted_at) WHERE deleted_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
SELECT 'Parte 4 completada OK' AS resultado;
