-- ══════════════════════════════════════════════════════════════════
-- EGCHAT — MIGRACIÓN COMPLETA (pegar todo esto en Supabase SQL Editor)
-- Proyecto: fqfxtjnfhvpggssbymdn
-- URL: https://supabase.com/dashboard/project/fqfxtjnfhvpggssbymdn/sql/new
-- ══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- PARTE 1: NUEVAS FEATURES
-- ─────────────────────────────────────────────────────────────────

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
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent';

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

ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_public_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_key_backup JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_backup_updated TIMESTAMPTZ;

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
CREATE TABLE IF NOT EXISTS user_sticker_packs (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  pack_id VARCHAR(100) NOT NULL,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, pack_id)
);
CREATE TABLE IF NOT EXISTS user_custom_stickers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_custom_stickers_user ON user_custom_stickers(user_id);
CREATE TABLE IF NOT EXISTS user_sticker_favorites (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sticker_id VARCHAR(200) NOT NULL,
  sticker_url TEXT NOT NULL,
  sticker_label VARCHAR(50),
  favorited_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, sticker_id)
);

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

CREATE TABLE IF NOT EXISTS mini_apps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon_url TEXT,
  accent_color VARCHAR(20) DEFAULT '#00c8a0',
  url TEXT NOT NULL,
  category VARCHAR(50) DEFAULT 'utilities',
  permissions JSONB DEFAULT '[]',
  developer_name VARCHAR(100) DEFAULT 'EGChat',
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

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  type VARCHAR(20) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'XAF',
  gateway VARCHAR(30) NOT NULL,
  gateway_txn_id TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_txns_user ON payment_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_txns_status ON payment_transactions(status);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  device_name VARCHAR(150),
  device_type VARCHAR(30),
  platform VARCHAR(80),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, is_active);

CREATE TABLE IF NOT EXISTS taxi_rides (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_ref VARCHAR(60) UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  ride_type VARCHAR(20) DEFAULT 'taxi',
  fare DECIMAL(10,2),
  distance_km DECIMAL(6,2),
  eta_minutes INTEGER DEFAULT 4,
  status VARCHAR(20) DEFAULT 'searching',
  payment_method VARCHAR(20) DEFAULT 'wallet',
  driver_name VARCHAR(100),
  driver_rating DECIMAL(2,1),
  driver_plate VARCHAR(20),
  driver_vehicle VARCHAR(80),
  driver_phone VARCHAR(30),
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  rating_comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_taxi_rides_user ON taxi_rides(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_taxi_rides_status ON taxi_rides(status);

CREATE TABLE IF NOT EXISTS user_bills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  service VARCHAR(200) NOT NULL,
  provider VARCHAR(100) DEFAULT '',
  amount INTEGER NOT NULL,
  due_date DATE NOT NULL,
  reference TEXT DEFAULT '',
  category_id VARCHAR(50) DEFAULT 'otros',
  icon VARCHAR(10) DEFAULT '📄',
  color VARCHAR(20) DEFAULT '#9CA3AF',
  status VARCHAR(20) DEFAULT 'pendiente',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_bills_user ON user_bills(user_id, due_date);

-- ─────────────────────────────────────────────────────────────────
-- PARTE 2: MI DJANGUE
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS djangue_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  slogan TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','annual')),
  quota_amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XAF',
  max_members INT NOT NULL DEFAULT 12,
  penalty_percent NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  notification_days_before INT NOT NULL DEFAULT 10,
  notification_final_days INT NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secretary_id UUID REFERENCES users(id) ON DELETE SET NULL,
  chat_group_id UUID,
  wallet_id UUID,
  current_turn INT NOT NULL DEFAULT 1,
  total_turns INT NOT NULL DEFAULT 0,
  period_start_date TIMESTAMPTZ,
  period_end_date TIMESTAMPTZ,
  next_payout_at TIMESTAMPTZ,
  total_mora_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS djangue_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL UNIQUE REFERENCES djangue_groups(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'XAF',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS djangue_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_order INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','removed')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, user_id),
  UNIQUE(group_id, turn_order)
);

CREATE TABLE IF NOT EXISTS djangue_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES djangue_members(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  turn_number INT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','justified')),
  justification_note TEXT,
  paid_at TIMESTAMPTZ,
  transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS djangue_penalties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES djangue_members(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  turn_number INT NOT NULL,
  penalty_amount NUMERIC(12,2) NOT NULL,
  penalty_percent NUMERIC(5,2) NOT NULL,
  amount NUMERIC(12,2),
  reason TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_at TIMESTAMPTZ,
  payment_method TEXT DEFAULT 'wallet',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS djangue_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('reminder_10days','reminder_daily','payment_received','turn_completed','penalty_applied')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS djangue_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  beneficiary_id UUID NOT NULL REFERENCES users(id),
  turn_number INT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  expected_amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_djangue_groups_owner ON djangue_groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_djangue_members_group ON djangue_members(group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_members_user ON djangue_members(user_id);
CREATE INDEX IF NOT EXISTS idx_djangue_contributions_group ON djangue_contributions(group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_contributions_user ON djangue_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_djangue_penalties_user_status ON djangue_penalties(user_id, status);
CREATE INDEX IF NOT EXISTS idx_djangue_notifications_user ON djangue_notifications(user_id);

ALTER TABLE chats ADD COLUMN IF NOT EXISTS group_type TEXT DEFAULT 'regular';

-- ─────────────────────────────────────────────────────────────────
-- PARTE 3: VOIP PUSH TOKENS
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS voip_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_voip_push_tokens_user_id ON voip_push_tokens(user_id);

-- expo_push_tokens (si no existe ya)
CREATE TABLE IF NOT EXISTS expo_push_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT DEFAULT 'android',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(token)
);
CREATE INDEX IF NOT EXISTS idx_expo_push_tokens_user ON expo_push_tokens(user_id);

-- ─────────────────────────────────────────────────────────────────
-- FIN — Migración completa EGCHAT
-- ─────────────────────────────────────────────────────────────────
SELECT 'Migracion completada OK' as resultado;
