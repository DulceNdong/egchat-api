-- ════════════════════════════════════════════════════════════════
-- EGChat — Nuevas tablas para paridad WhatsApp/WeChat
-- Ejecutar en: Supabase > SQL Editor > New Query
-- ════════════════════════════════════════════════════════════════

-- ── 1. REACCIONES A MENSAJES ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON message_reactions(message_id);

-- ── 2. RECEIPTS DE LECTURA EN GRUPOS ─────────────────────────────
CREATE TABLE IF NOT EXISTS message_receipts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_receipts_message_id ON message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_receipts_chat_id ON message_receipts(chat_id);

-- ── 3. CAMPO edited EN messages (si no existe) ───────────────────
-- La tabla de mensajes se llama "messages" en este proyecto
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- ── 4. MOMENTS / FEED SOCIAL ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS moments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  text TEXT,
  images TEXT[] DEFAULT '{}',
  likes_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moment_likes (
  moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS moment_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moments_user_id ON moments(user_id);
CREATE INDEX IF NOT EXISTS idx_moments_created_at ON moments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moment_comments_moment_id ON moment_comments(moment_id);

-- ── 5. CANALES OFICIALES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  avatar_url TEXT,
  category VARCHAR(50) DEFAULT 'General',
  verified BOOLEAN DEFAULT FALSE,
  followers_count INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_followers (
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  followed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  text TEXT,
  images TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Datos iniciales de canales oficiales
INSERT INTO channels (name, description, category, verified, followers_count)
VALUES
  ('EGChat Oficial', 'Novedades y actualizaciones de EGChat', 'Tecnología', TRUE, 12400),
  ('Noticias Guinea Ecuatorial', 'Las últimas noticias del país', 'Noticias', TRUE, 8900),
  ('Negocios GE', 'Oportunidades de negocio y emprendimiento', 'Negocios', TRUE, 5200),
  ('Deportes África', 'Fútbol y deportes africanos', 'Deportes', TRUE, 23100),
  ('Salud y Bienestar', 'Consejos de salud para toda la familia', 'Salud', FALSE, 3400)
ON CONFLICT DO NOTHING;

-- ── 6. PERFILES EMPRESARIALES ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) DEFAULT 'Otro',
  description TEXT,
  phone VARCHAR(30),
  email VARCHAR(100),
  website TEXT,
  address TEXT,
  avatar_url TEXT,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  price VARCHAR(30),
  currency VARCHAR(10) DEFAULT 'XAF',
  description TEXT,
  image_url TEXT,
  available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_user_id ON catalog_items(user_id);

-- ── 7. BACKUPS EN LA NUBE ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_backups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  chat_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 8. OTP / VERIFICACIÓN SMS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS phone_verifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(30) NOT NULL,
  code VARCHAR(10) NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  attempts INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_phone ON phone_verifications(phone);

-- ── 9. Full-text search en mensajes ──────────────────────────────
-- Índice full-text en messages
CREATE INDEX IF NOT EXISTS idx_messages_text_search 
  ON messages USING gin(to_tsvector('spanish', COALESCE(text, '')));
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
