CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON message_reactions(message_id);

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

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS moments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  text TEXT,
  images TEXT[] DEFAULT '{}',
  likes_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moment_likes (
  moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS moment_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  avatar_url TEXT,
  category VARCHAR(50) DEFAULT 'General',
  verified BOOLEAN DEFAULT FALSE,
  followers_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_followers (
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id, user_id)
);

INSERT INTO channels (name, description, category, verified, followers_count) VALUES
  ('EGChat Oficial', 'Novedades y actualizaciones de EGChat', 'Tecnología', TRUE, 12400),
  ('Noticias Guinea Ecuatorial', 'Las últimas noticias del país', 'Noticias', TRUE, 8900),
  ('Negocios GE', 'Oportunidades de negocio y emprendimiento', 'Negocios', TRUE, 5200),
  ('Deportes África', 'Fútbol y deportes africanos', 'Deportes', TRUE, 23100),
  ('Salud y Bienestar', 'Consejos de salud para toda la familia', 'Salud', FALSE, 3400)
ON CONFLICT DO NOTHING;

-- Datos de prueba para moments (posts de ejemplo)
INSERT INTO moments (id, user_id, text, likes_count, created_at) VALUES
  (gen_random_uuid(), (SELECT id FROM users LIMIT 1), 'Bienvenidos a EGChat Moments 🎉 ¡Comparte tus mejores momentos con la comunidad!', 15, NOW() - INTERVAL '2 hours'),
  (gen_random_uuid(), (SELECT id FROM users LIMIT 1 OFFSET 1), '¡Hermoso atardecer en Malabo hoy! 🌅 #GuineaEcuatorial', 8, NOW() - INTERVAL '5 hours'),
  (gen_random_uuid(), (SELECT id FROM users LIMIT 1), '¿Alguien más emocionado por el nuevo EGChat? Las funcionalidades están increíbles 🚀', 22, NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) DEFAULT 'Otro',
  description TEXT,
  phone VARCHAR(30),
  website TEXT,
  address TEXT,
  avatar_url TEXT,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS phone_verifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(30) NOT NULL,
  code VARCHAR(10) NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  attempts INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════════
-- EGCHAT — Nuevas features (ejecutar en Supabase SQL Editor)
-- ══════════════════════════════════════════════════════════════════

-- ── Task #1: Doble check real ─────────────────────────────────────
-- Agregar columna status a chat_messages si no existe
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent';
CREATE INDEX IF NOT EXISTS idx_chat_messages_status ON chat_messages(status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_sender ON chat_messages(chat_id, sender_id);

-- ── Task #5: Backup de claves E2E ─────────────────────────────────
-- Columnas en la tabla users para guardar el blob cifrado
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_public_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_key_backup JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_backup_updated TIMESTAMPTZ;

-- ── Task #7: Stickers descargables ───────────────────────────────
-- Catálogo de paquetes de stickers
CREATE TABLE IF NOT EXISTS sticker_packs (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  author VARCHAR(100) DEFAULT 'EGChat',
  cover_url TEXT,
  stickers JSONB DEFAULT '[]',
  download_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Paquetes instalados por usuario
CREATE TABLE IF NOT EXISTS user_sticker_packs (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  pack_id VARCHAR(100) NOT NULL,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, pack_id)
);

-- Stickers personalizados creados por el usuario desde sus fotos
CREATE TABLE IF NOT EXISTS user_custom_stickers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_custom_stickers_user ON user_custom_stickers(user_id);

-- Stickers favoritos
CREATE TABLE IF NOT EXISTS user_sticker_favorites (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sticker_id VARCHAR(200) NOT NULL,
  sticker_url TEXT NOT NULL,
  sticker_label VARCHAR(50),
  favorited_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, sticker_id)
);

-- Insertar paquetes integrados en el catálogo
INSERT INTO sticker_packs (id, name, author, cover_url, stickers, download_count) VALUES
  ('egchat_classic', 'EGChat Clásico', 'EGChat',
   'https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif',
   '[{"id":"eg_hi","url":"https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif","label":"👋"},{"id":"eg_bye","url":"https://media.tenor.com/3i9CnChAkuUAAAAi/bye-bye-wave.gif","label":"✌️"}]',
   0),
  ('guinea_eq', 'Guinea Ecuatorial', 'EGChat',
   'https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif',
   '[{"id":"ge1","url":"https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif","label":"🇬🇶"}]',
   0),
  ('africa_vibes', 'África Vibes', 'EGChat',
   'https://media.tenor.com/fRQXPTpRZqUAAAAi/clapping-applause.gif',
   '[{"id":"av1","url":"https://media.tenor.com/fRQXPTpRZqUAAAAi/clapping-applause.gif","label":"👏"}]',
   0)
ON CONFLICT (id) DO NOTHING;

-- ── Task #8: Mini Programs sandbox (estructura) ───────────────────
CREATE TABLE IF NOT EXISTS mini_apps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon_url TEXT,
  url TEXT NOT NULL,          -- URL de la mini-app (WebView)
  category VARCHAR(50) DEFAULT 'Utilidades',
  developer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  installs_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_mini_apps (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  app_id UUID REFERENCES mini_apps(id) ON DELETE CASCADE,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY(user_id, app_id)
);

-- ── Task #9: Pagos con pasarela real ──────────────────────────────
-- Transacciones externas (Stripe/PayPal/local)
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,          -- 'deposit', 'withdrawal', 'transfer', 'payment'
  amount DECIMAL(15,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'XAF',
  status VARCHAR(20) DEFAULT 'pending', -- 'pending','completed','failed','refunded'
  gateway VARCHAR(30),                 -- 'stripe','paypal','orange_money','mtn_mobile'
  gateway_txn_id TEXT,                 -- ID de la transacción en la pasarela
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_txns_user ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_txns_status ON payment_transactions(status);

-- ── Task #10: Sincronización multi-dispositivo ────────────────────
-- Sesiones activas del usuario (para sincronización real)
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100),
  device_type VARCHAR(20),            -- 'ios','android','web','desktop'
  platform VARCHAR(30),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, is_active);

-- ══════════════════════════════════════════════════════════════════
-- Task #10 — Sesiones multi-dispositivo
-- Ejecutar en Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════

-- Tabla de sesiones activas por dispositivo
-- La columna id usa el patrón compuesto "userId_deviceId"
-- para facilitar upsert sin conflictos
CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,          -- "{userId}_{deviceId}"
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  device_name  VARCHAR(150),
  device_type  VARCHAR(30),               -- 'ios','android','web','desktop'
  platform     VARCHAR(80),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
  ON user_sessions(user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen
  ON user_sessions(last_seen);

-- Auto-marcar sesiones como inactivas si no hacen heartbeat en 24h
-- (función que se puede llamar como cron job en Supabase)
CREATE OR REPLACE FUNCTION expire_old_sessions()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE user_sessions
  SET    is_active = FALSE
  WHERE  is_active = TRUE
    AND  last_seen < NOW() - INTERVAL '24 hours';
END;
$$;

-- ══════════════════════════════════════════════════════════════════
-- Task #9 — Pagos con pasarela real
-- ══════════════════════════════════════════════════════════════════

-- Transacciones de pasarela externa (Stripe, Orange Money, MTN)
-- Separada de la tabla 'transactions' interna del wallet
CREATE TABLE IF NOT EXISTS payment_transactions (
  id              TEXT PRIMARY KEY,         -- "pay_{ts}_{random}" o "wdr_{ts}_{random}"
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  type            VARCHAR(20) NOT NULL,     -- 'deposit', 'withdrawal'
  amount          DECIMAL(15,2) NOT NULL,
  currency        VARCHAR(10) DEFAULT 'XAF',
  gateway         VARCHAR(30) NOT NULL,     -- 'stripe','orange_money','mtn_mobile', etc.
  gateway_txn_id  TEXT,                     -- ID en la pasarela externa (Stripe PI id, etc.)
  status          VARCHAR(20) DEFAULT 'pending',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_txns_user
  ON payment_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_txns_status
  ON payment_transactions(status);

CREATE INDEX IF NOT EXISTS idx_payment_txns_gateway_txn
  ON payment_transactions(gateway_txn_id)
  WHERE gateway_txn_id IS NOT NULL;

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_payment_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_updated_at ON payment_transactions;
CREATE TRIGGER trg_payment_updated_at
  BEFORE UPDATE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION update_payment_updated_at();

-- ══════════════════════════════════════════════════════════════════
-- Task #5 — Backup de claves E2E (columnas en users)
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_public_key    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_key_backup    JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_backup_updated TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_e2e_public_key
  ON users(id) WHERE e2e_public_key IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════
-- Task #7 — Stickers
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sticker_packs (
  id             VARCHAR(100) PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  author         VARCHAR(100) DEFAULT 'EGChat',
  cover_url      TEXT,
  stickers       JSONB DEFAULT '[]',
  download_count INTEGER DEFAULT 0,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sticker_packs (
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  pack_id      VARCHAR(100) NOT NULL,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS user_custom_stickers (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  file_url   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_custom_stickers_user ON user_custom_stickers(user_id);

-- Paquetes iniciales
INSERT INTO sticker_packs (id, name, author, cover_url, stickers, download_count) VALUES
  ('egchat_classic', 'EGChat Clásico', 'EGChat',
   'https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif',
   '[{"id":"eg_hi","url":"https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif","label":"👋"},{"id":"eg_love","url":"https://media.tenor.com/bLyaMAGQg-MAAAAi/heart-love.gif","label":"❤️"}]',
   0),
  ('guinea_eq', 'Guinea Ecuatorial', 'EGChat',
   'https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif',
   '[{"id":"ge1","url":"https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif","label":"🇬🇶"}]',
   0)
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- Task #8 — Mini-Apps
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mini_apps (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  icon_url        TEXT,
  accent_color    VARCHAR(20) DEFAULT '#00c8a0',
  url             TEXT NOT NULL,
  category        VARCHAR(50) DEFAULT 'utilities',
  permissions     JSONB DEFAULT '[]',
  developer_name  VARCHAR(100) DEFAULT 'EGChat',
  developer_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  is_verified     BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  installs_count  INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_mini_apps (
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  app_id       UUID REFERENCES mini_apps(id) ON DELETE CASCADE,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY(user_id, app_id)
);

-- ══════════════════════════════════════════════════════════════════
-- Task #1 — Doble check real (status en chat_messages)
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent';

CREATE INDEX IF NOT EXISTS idx_chat_messages_status
  ON chat_messages(chat_id, status);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_sender
  ON chat_messages(chat_id, sender_id);

-- ══════════════════════════════════════════════════════════════════
-- Políticas RLS recomendadas (ejecutar si RLS está activado)
-- ══════════════════════════════════════════════════════════════════

-- user_sessions: solo el propio usuario puede ver sus sesiones
-- (ejecutar solo si usas RLS en Supabase)
/*
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_own ON user_sessions
  USING (user_id = auth.uid()::uuid);

ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_txns_own ON payment_transactions
  USING (user_id = auth.uid()::uuid);
*/

-- ══════════════════════════════════════════════════════════════════
-- Mi Taxi v2 — tabla taxi_rides
-- Pegar en Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS taxi_rides (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_ref       VARCHAR(60) UNIQUE NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  origin         TEXT NOT NULL,
  destination    TEXT NOT NULL,
  ride_type      VARCHAR(20) DEFAULT 'taxi',
  fare           DECIMAL(10,2),
  distance_km    DECIMAL(6,2),
  eta_minutes    INTEGER DEFAULT 4,
  status         VARCHAR(20) DEFAULT 'searching',
  payment_method VARCHAR(20) DEFAULT 'wallet',
  driver_name    VARCHAR(100),
  driver_rating  DECIMAL(2,1),
  driver_plate   VARCHAR(20),
  driver_vehicle VARCHAR(80),
  driver_phone   VARCHAR(30),
  rating         SMALLINT CHECK (rating BETWEEN 1 AND 5),
  rating_comment TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_taxi_rides_user    ON taxi_rides(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxi_rides_status  ON taxi_rides(status);
CREATE INDEX IF NOT EXISTS idx_taxi_rides_ref     ON taxi_rides(ride_ref);

-- ══════════════════════════════════════════════════════════════════
-- Servicios - Recargas móviles y facturas personales
-- ══════════════════════════════════════════════════════════════════

-- Facturas personales del usuario
CREATE TABLE IF NOT EXISTS user_bills (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  service     VARCHAR(200) NOT NULL,
  provider    VARCHAR(100) DEFAULT '',
  amount      INTEGER NOT NULL,
  due_date    DATE NOT NULL,
  reference   TEXT DEFAULT '',
  category_id VARCHAR(50) DEFAULT 'otros',
  icon        VARCHAR(10) DEFAULT '📄',
  color       VARCHAR(20) DEFAULT '#9CA3AF',
  status      VARCHAR(20) DEFAULT 'pendiente',
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_bills_user ON user_bills(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_user_bills_status ON user_bills(user_id, status);
