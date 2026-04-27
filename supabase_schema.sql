-- EGCHAT Schema para Supabase
-- Ejecuta este SQL en: Supabase > SQL Editor > New Query

-- Tabla de usuarios
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE
);

-- Tabla de monederos
CREATE TABLE IF NOT EXISTS wallets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  balance DECIMAL(15,2) DEFAULT 5000.00,
  currency VARCHAR(3) DEFAULT 'XAF',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de transacciones
CREATE TABLE IF NOT EXISTS transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  method VARCHAR(100),
  reference TEXT,
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de codigos de recarga
CREATE TABLE IF NOT EXISTS recharge_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  used_by UUID REFERENCES users(id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de conversaciones con Lia-25
CREATE TABLE IF NOT EXISTS lia_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de contactos
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id UUID REFERENCES users(id),
  name VARCHAR(100),
  phone VARCHAR(20),
  is_blocked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lia_conversations_user_id ON lia_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);

-- Codigos de recarga de prueba
INSERT INTO recharge_codes (code, amount, expires_at) VALUES
  ('1234-5678-9012-3456', 5000,  NOW() + INTERVAL '1 year'),
  ('ABCD-EFGH-IJKL-MNOP', 10000, NOW() + INTERVAL '1 year'),
  ('TEST-CODE-2026-EGCH', 25000, NOW() + INTERVAL '1 year')
ON CONFLICT (code) DO NOTHING;

-- Tabla de estados/stories
CREATE TABLE IF NOT EXISTS stories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  media JSONB NOT NULL,
  type TEXT DEFAULT 'text',
  views INTEGER DEFAULT 0,
  reactions JSONB DEFAULT '[]',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires_at ON stories(expires_at);

-- Tabla de sesiones de llamadas WebRTC
CREATE TABLE IF NOT EXISTS call_sessions (
  call_id VARCHAR(100) PRIMARY KEY,
  offer TEXT,
  answer TEXT,
  caller_candidates TEXT DEFAULT '[]',
  callee_candidates TEXT DEFAULT '[]',
  type VARCHAR(10) DEFAULT 'audio',
  caller_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  ended BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_sessions_target ON call_sessions(target_user_id, ended);
CREATE INDEX IF NOT EXISTS idx_call_sessions_created ON call_sessions(created_at);

-- Tabla para "eliminar para mí" (mensajes ocultos por usuario)
-- EJECUTAR ESTE SQL EN SUPABASE si los mensajes vuelven a aparecer al recargar
CREATE TABLE IF NOT EXISTS message_deletions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_deletions_user ON message_deletions(user_id);
CREATE INDEX IF NOT EXISTS idx_message_deletions_message ON message_deletions(message_id);
