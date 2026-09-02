-- ══════════════════════════════════════════════════════════════════
-- ROLES INTERNOS DE PROVEEDORES
-- Cada empresa tiene: director + operadores de ventas
-- ══════════════════════════════════════════════════════════════════

-- Añadir columnas a service_providers
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS
  auto_process BOOLEAN DEFAULT false;  -- Modo automático ON/OFF
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS
  commission_rate NUMERIC(5,4) DEFAULT 0.015;  -- 1.5% por defecto
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS
  total_revenue NUMERIC(14,2) DEFAULT 0;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS
  description TEXT;

-- Roles internos del proveedor
-- provider_role: director ve solo stats, operator procesa pedidos
DO $$ BEGIN
  CREATE TYPE provider_role AS ENUM ('director', 'operator', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS provider_staff (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'operator'
                 CHECK (role IN ('owner','director','operator')),
  is_active    BOOLEAN DEFAULT true,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_staff_user ON provider_staff(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_provider_staff_prov ON provider_staff(provider_id, role);

-- Log de procesamiento automático
CREATE TABLE IF NOT EXISTS auto_process_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID REFERENCES service_orders(id),
  provider_id TEXT NOT NULL,
  result      TEXT,  -- 'success' | 'failed' | 'skipped'
  response    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Añadir permisos de director y operator
INSERT INTO permissions (name, description, module) VALUES
  ('provider.director',  'Acceso al dashboard ejecutivo del proveedor', 'provider'),
  ('provider.operator',  'Acceso al panel de operaciones del proveedor', 'provider'),
  ('provider.auto',      'Activar modo automático de procesamiento', 'provider'),
  ('provider.staff',     'Gestionar personal del proveedor', 'provider')
ON CONFLICT (name) DO NOTHING;

-- super_admin puede ver todo
INSERT INTO role_permissions (role, permission) VALUES
  ('super_admin', 'provider.director'),
  ('super_admin', 'provider.operator'),
  ('super_admin', 'provider.auto'),
  ('super_admin', 'provider.staff'),
  ('admin', 'provider.director'),
  ('admin', 'provider.operator'),
  ('admin', 'provider.staff')
ON CONFLICT DO NOTHING;
