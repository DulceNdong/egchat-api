-- ══════════════════════════════════════════════════════════════════
-- BLOQUE BÁSICO: Pedidos de Servicios (Recarga, Internet, Canales)
-- Ejecutar en Neon
-- ══════════════════════════════════════════════════════════════════

-- Categorías de servicios
DO $$ BEGIN
  CREATE TYPE service_category AS ENUM (
    'recarga', 'internet', 'canales', 'banco', 'seguros',
    'facturas', 'salud', 'transporte', 'comercio', 'publico'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Pedidos de servicios (una fila por pedido independiente del tipo)
CREATE TABLE IF NOT EXISTS service_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id     TEXT NOT NULL,        -- id del proveedor (mo1, ip1, cc1, etc.)
  provider_name   TEXT NOT NULL,        -- nombre legible (GETESA, Orange, Canal Sol...)
  provider_color  TEXT DEFAULT '#007AFF',
  category        TEXT NOT NULL,        -- recarga | internet | canales | ...
  package_id      TEXT,                 -- id del paquete seleccionado
  package_name    TEXT,                 -- nombre del paquete
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'XAF',
  phone_target    TEXT,                 -- número a recargar / cuenta destino
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed','refunded')),
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',   -- datos extra (velocidad, canales, etc.)
  processed_by    UUID REFERENCES users(id),  -- user_id del proveedor que procesó
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Perfiles de proveedores (uno por entidad registrada en EgChat)
CREATE TABLE IF NOT EXISTS service_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider_key    TEXT UNIQUE NOT NULL,  -- mo1, ip1, cc1, bank_ccei, etc.
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  color           TEXT DEFAULT '#007AFF',
  logo_url        TEXT,
  api_endpoint    TEXT,                  -- si tienen API propia
  api_key_hash    TEXT,                  -- API key cifrada
  has_api         BOOLEAN DEFAULT false,
  is_active       BOOLEAN DEFAULT true,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_service_orders_user     ON service_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_orders_provider ON service_orders(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_service_orders_status   ON service_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_providers_key   ON service_providers(provider_key);

-- Añadir permisos para proveedores de servicios
INSERT INTO permissions (name, description, module) VALUES
  ('services.view_orders',    'Ver pedidos de sus servicios',          'services'),
  ('services.process_orders', 'Procesar/confirmar pedidos',            'services'),
  ('services.view_analytics', 'Ver analytics de su servicio',         'services'),
  ('services.manage_packages','Gestionar paquetes y precios',          'services'),
  ('services.api_config',     'Configurar integración API',            'services')
ON CONFLICT (name) DO NOTHING;

-- Rol proveedor_servicio hereda de official + servicios
INSERT INTO role_permissions (role, permission) VALUES
  ('official', 'services.view_orders'),
  ('official', 'services.process_orders'),
  ('official', 'services.view_analytics'),
  ('business', 'services.view_orders'),
  ('business', 'services.process_orders'),
  ('business', 'services.view_analytics'),
  ('business', 'services.manage_packages'),
  ('admin',    'services.view_orders'),
  ('admin',    'services.process_orders'),
  ('admin',    'services.view_analytics'),
  ('admin',    'services.manage_packages'),
  ('admin',    'services.api_config'),
  ('super_admin', 'services.view_orders'),
  ('super_admin', 'services.process_orders'),
  ('super_admin', 'services.view_analytics'),
  ('super_admin', 'services.manage_packages'),
  ('super_admin', 'services.api_config')
ON CONFLICT DO NOTHING;
