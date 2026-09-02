-- ══════════════════════════════════════════════════════════════════
-- MÓDULO 1: ROLES Y PERMISOS
-- Ejecutar en: Neon Dashboard > SQL Editor
-- ══════════════════════════════════════════════════════════════════

-- Tipos de rol disponibles (compatible con Neon/PostgreSQL)
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('user', 'official', 'business', 'merchant', 'moderator', 'admin', 'super_admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tabla de roles por usuario
CREATE TABLE IF NOT EXISTS user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        user_role NOT NULL DEFAULT 'user',
  granted_by  UUID REFERENCES users(id),
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN DEFAULT true,
  metadata    JSONB DEFAULT '{}',
  UNIQUE(user_id, role)
);

-- Tabla de permisos granulares
CREATE TABLE IF NOT EXISTS permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,  -- e.g. 'send_broadcast', 'view_analytics'
  description TEXT,
  module      TEXT NOT NULL,          -- e.g. 'chat', 'wallet', 'merchant', 'admin'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Permisos por rol (defaults)
CREATE TABLE IF NOT EXISTS role_permissions (
  role        user_role NOT NULL,
  permission  TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  PRIMARY KEY (role, permission)
);

-- Permisos extra por usuario (overrides)
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  granted     BOOLEAN DEFAULT true,  -- true=grant, false=revoke
  granted_by  UUID REFERENCES users(id),
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, permission)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
CREATE INDEX IF NOT EXISTS idx_user_roles_active ON user_roles(user_id, is_active);

-- Cuentas oficiales: añadir columna a users (si no existe)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified  BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type user_role DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_by  UUID REFERENCES users(id);

-- ── Permisos por defecto ──────────────────────────────────────────

-- Permisos disponibles
INSERT INTO permissions (name, description, module) VALUES
  -- Chat
  ('chat.send',            'Enviar mensajes',                    'chat'),
  ('chat.broadcast',       'Enviar broadcast a múltiples chats', 'chat'),
  ('chat.delete_any',      'Eliminar mensajes de otros',         'chat'),
  ('chat.moderate',        'Moderar chats y grupos',             'chat'),
  -- Wallet
  ('wallet.view',          'Ver balance y transacciones',        'wallet'),
  ('wallet.transfer',      'Transferir dinero',                  'wallet'),
  ('wallet.topup',         'Recargar saldo',                     'wallet'),
  ('wallet.withdraw',      'Retirar saldo',                      'wallet'),
  ('wallet.admin',         'Gestionar wallets de usuarios',      'wallet'),
  -- Business
  ('business.view_stats',  'Ver estadísticas del negocio',       'business'),
  ('business.manage',      'Gestionar cuenta empresarial',       'business'),
  ('business.verified_badge', 'Mostrar badge verificado',        'business'),
  -- Merchant
  ('merchant.products',    'Gestionar productos',                'merchant'),
  ('merchant.orders',      'Gestionar pedidos',                  'merchant'),
  ('merchant.analytics',   'Ver analytics del merchant',         'merchant'),
  ('merchant.payouts',     'Solicitar pagos',                    'merchant'),
  -- Admin
  ('admin.users',          'Gestionar usuarios',                 'admin'),
  ('admin.roles',          'Asignar roles',                      'admin'),
  ('admin.content',        'Moderar contenido',                  'admin'),
  ('admin.system',         'Configuración del sistema',          'admin')
ON CONFLICT (name) DO NOTHING;

-- Asignar permisos por rol
INSERT INTO role_permissions (role, permission) VALUES
  -- user: permisos básicos
  ('user', 'chat.send'),
  ('user', 'wallet.view'),
  ('user', 'wallet.transfer'),
  ('user', 'wallet.topup'),
  -- official: usuario + badge + broadcast
  ('official', 'chat.send'),
  ('official', 'chat.broadcast'),
  ('official', 'wallet.view'),
  ('official', 'wallet.transfer'),
  ('official', 'wallet.topup'),
  ('official', 'business.verified_badge'),
  ('official', 'business.view_stats'),
  -- business: official + gestión empresarial
  ('business', 'chat.send'),
  ('business', 'chat.broadcast'),
  ('business', 'wallet.view'),
  ('business', 'wallet.transfer'),
  ('business', 'wallet.topup'),
  ('business', 'wallet.withdraw'),
  ('business', 'business.verified_badge'),
  ('business', 'business.view_stats'),
  ('business', 'business.manage'),
  -- merchant: business + productos y pedidos
  ('merchant', 'chat.send'),
  ('merchant', 'chat.broadcast'),
  ('merchant', 'wallet.view'),
  ('merchant', 'wallet.transfer'),
  ('merchant', 'wallet.topup'),
  ('merchant', 'wallet.withdraw'),
  ('merchant', 'business.verified_badge'),
  ('merchant', 'business.view_stats'),
  ('merchant', 'business.manage'),
  ('merchant', 'merchant.products'),
  ('merchant', 'merchant.orders'),
  ('merchant', 'merchant.analytics'),
  ('merchant', 'merchant.payouts'),
  -- moderator
  ('moderator', 'chat.send'),
  ('moderator', 'chat.moderate'),
  ('moderator', 'chat.delete_any'),
  ('moderator', 'admin.content'),
  -- admin: todo excepto system
  ('admin', 'chat.send'),
  ('admin', 'chat.broadcast'),
  ('admin', 'chat.moderate'),
  ('admin', 'chat.delete_any'),
  ('admin', 'wallet.view'),
  ('admin', 'wallet.admin'),
  ('admin', 'business.view_stats'),
  ('admin', 'business.manage'),
  ('admin', 'admin.users'),
  ('admin', 'admin.roles'),
  ('admin', 'admin.content'),
  -- super_admin: todo
  ('super_admin', 'chat.send'),
  ('super_admin', 'chat.broadcast'),
  ('super_admin', 'chat.moderate'),
  ('super_admin', 'chat.delete_any'),
  ('super_admin', 'wallet.view'),
  ('super_admin', 'wallet.admin'),
  ('super_admin', 'wallet.withdraw'),
  ('super_admin', 'business.view_stats'),
  ('super_admin', 'business.manage'),
  ('super_admin', 'merchant.analytics'),
  ('super_admin', 'admin.users'),
  ('super_admin', 'admin.roles'),
  ('super_admin', 'admin.content'),
  ('super_admin', 'admin.system')
ON CONFLICT DO NOTHING;
