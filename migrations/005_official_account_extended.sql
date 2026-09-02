-- ══════════════════════════════════════════════════════════════════
-- MÓDULO CUENTA OFICIAL EXTENDIDA
-- Organigrama, regiones, comunicados públicos, empleados internos
-- ══════════════════════════════════════════════════════════════════

-- Regiones de la empresa (Insular, Continental, etc.)
CREATE TABLE IF NOT EXISTS company_regions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,           -- "Región Insular", "Región Continental"
  description TEXT,
  color       TEXT DEFAULT '#1485EE',
  cover_url   TEXT,
  is_active   BOOLEAN DEFAULT true,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Organigrama (jerarquía de cargos)
CREATE TABLE IF NOT EXISTS company_org_chart (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  region_id   UUID REFERENCES company_regions(id) ON DELETE SET NULL,
  parent_id   UUID REFERENCES company_org_chart(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,  -- si tiene cuenta en EgChat
  name        TEXT NOT NULL,
  title       TEXT NOT NULL,           -- "Director General", "Jefe Región Insular"
  phone       TEXT,
  email       TEXT,
  photo_url   TEXT,
  is_active   BOOLEAN DEFAULT true,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Estadísticas de consumo por región (editables por el admin de la empresa)
CREATE TABLE IF NOT EXISTS company_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  region_id   UUID REFERENCES company_regions(id) ON DELETE SET NULL,
  stat_type   TEXT NOT NULL,  -- 'consumption_kwh', 'clients_count', 'revenue', 'outages'
  stat_label  TEXT NOT NULL,
  stat_value  NUMERIC(14,2) DEFAULT 0,
  unit        TEXT DEFAULT '',
  period      TEXT,           -- "Enero 2026", "T1 2026"
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID REFERENCES users(id)
);

-- Empleados internos de la empresa (staff que usa EgChat para comunicación interna)
CREATE TABLE IF NOT EXISTS company_staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  role_title  TEXT DEFAULT 'Empleado',
  region_id   UUID REFERENCES company_regions(id) ON DELETE SET NULL,
  is_active   BOOLEAN DEFAULT true,
  added_by    UUID REFERENCES users(id),
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider_id, user_id)
);

-- Comunicados públicos (visibles en la pestaña de la empresa en Servicios)
CREATE TABLE IF NOT EXISTS company_announcements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  category    TEXT DEFAULT 'general',  -- 'general', 'mantenimiento', 'corte', 'aviso', 'oferta'
  region_id   UUID REFERENCES company_regions(id) ON DELETE SET NULL,  -- NULL = todas las regiones
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  cover_url    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_company_regions_prov   ON company_regions(provider_id);
CREATE INDEX IF NOT EXISTS idx_company_org_prov        ON company_org_chart(provider_id);
CREATE INDEX IF NOT EXISTS idx_company_stats_prov      ON company_stats(provider_id, stat_type);
CREATE INDEX IF NOT EXISTS idx_company_staff_prov      ON company_staff(provider_id, is_active);
CREATE INDEX IF NOT EXISTS idx_company_ann_prov        ON company_announcements(provider_id, is_published);
CREATE INDEX IF NOT EXISTS idx_company_ann_published   ON company_announcements(is_published, published_at DESC);

-- Permisos adicionales
INSERT INTO permissions (name, description, module) VALUES
  ('company.manage_org',          'Gestionar organigrama y regiones',         'company'),
  ('company.manage_staff',        'Gestionar empleados internos',              'company'),
  ('company.publish_announcement','Publicar comunicados a usuarios de EgChat', 'company'),
  ('company.view_stats',          'Ver estadísticas de la empresa',            'company'),
  ('company.edit_stats',          'Editar estadísticas de la empresa',         'company')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role, permission) VALUES
  ('official',    'company.manage_org'),
  ('official',    'company.manage_staff'),
  ('official',    'company.publish_announcement'),
  ('official',    'company.view_stats'),
  ('business',    'company.manage_org'),
  ('business',    'company.manage_staff'),
  ('business',    'company.publish_announcement'),
  ('business',    'view_stats'),
  ('business',    'company.edit_stats'),
  ('admin',       'company.manage_org'),
  ('admin',       'company.manage_staff'),
  ('admin',       'company.publish_announcement'),
  ('admin',       'company.view_stats'),
  ('admin',       'company.edit_stats'),
  ('super_admin', 'company.manage_org'),
  ('super_admin', 'company.manage_staff'),
  ('super_admin', 'company.publish_announcement'),
  ('super_admin', 'company.view_stats'),
  ('super_admin', 'company.edit_stats')
ON CONFLICT DO NOTHING;
