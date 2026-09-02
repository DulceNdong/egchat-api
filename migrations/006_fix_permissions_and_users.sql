-- ══════════════════════════════════════════════════════════════════
-- MIGRACIÓN 006: Corrección de permisos faltantes + usuarios
-- Ejecutar en: Neon Dashboard > SQL Editor
-- ══════════════════════════════════════════════════════════════════

-- 1. Insertar TODOS los permisos que faltan (los usados en routes/ pero no en migration 001)
--    Esto resuelve el error FK en user_permissions
-- ──────────────────────────────────────────────────────────────────

INSERT INTO permissions (name, description, module) VALUES
  -- Company / Empresa
  ('company.manage_org',           'Gestionar organigrama y regiones',          'company'),
  ('company.manage_staff',         'Gestionar empleados internos',               'company'),
  ('company.publish_announcement', 'Publicar comunicados a usuarios de EgChat',  'company'),
  ('company.view_stats',           'Ver estadísticas de la empresa',             'company'),
  ('company.edit_stats',           'Editar estadísticas de la empresa',          'company'),
  -- Provider / Proveedor
  ('provider.director',  'Acceso al dashboard ejecutivo del proveedor', 'provider'),
  ('provider.operator',  'Acceso al panel de operaciones del proveedor','provider'),
  ('provider.auto',      'Activar modo automático de procesamiento',    'provider'),
  ('provider.staff',     'Gestionar personal del proveedor',            'provider'),
  -- Services / Servicios
  ('services.view_orders',     'Ver pedidos de sus servicios',         'services'),
  ('services.process_orders',  'Procesar/confirmar pedidos',           'services'),
  ('services.view_analytics',  'Ver analytics de su servicio',         'services'),
  ('services.manage_packages', 'Gestionar paquetes y precios',         'services'),
  ('services.api_config',      'Configurar integración API',           'services')
ON CONFLICT (name) DO NOTHING;

-- 2. Asignar todos los permisos a los roles correctos
-- ──────────────────────────────────────────────────────────────────

INSERT INTO role_permissions (role, permission) VALUES
  -- OFFICIAL
  ('official', 'services.view_orders'),
  ('official', 'services.process_orders'),
  ('official', 'services.view_analytics'),
  ('official', 'company.manage_org'),
  ('official', 'company.manage_staff'),
  ('official', 'company.publish_announcement'),
  ('official', 'company.view_stats'),
  -- BUSINESS
  ('business', 'services.view_orders'),
  ('business', 'services.process_orders'),
  ('business', 'services.view_analytics'),
  ('business', 'services.manage_packages'),
  ('business', 'company.manage_org'),
  ('business', 'company.manage_staff'),
  ('business', 'company.publish_announcement'),
  ('business', 'company.view_stats'),
  ('business', 'company.edit_stats'),
  -- ADMIN
  ('admin', 'services.view_orders'),
  ('admin', 'services.process_orders'),
  ('admin', 'services.view_analytics'),
  ('admin', 'services.manage_packages'),
  ('admin', 'services.api_config'),
  ('admin', 'provider.director'),
  ('admin', 'provider.operator'),
  ('admin', 'provider.staff'),
  ('admin', 'company.manage_org'),
  ('admin', 'company.manage_staff'),
  ('admin', 'company.publish_announcement'),
  ('admin', 'company.view_stats'),
  ('admin', 'company.edit_stats'),
  -- SUPER_ADMIN
  ('super_admin', 'services.view_orders'),
  ('super_admin', 'services.process_orders'),
  ('super_admin', 'services.view_analytics'),
  ('super_admin', 'services.manage_packages'),
  ('super_admin', 'services.api_config'),
  ('super_admin', 'provider.director'),
  ('super_admin', 'provider.operator'),
  ('super_admin', 'provider.auto'),
  ('super_admin', 'provider.staff'),
  ('super_admin', 'company.manage_org'),
  ('super_admin', 'company.manage_staff'),
  ('super_admin', 'company.publish_announcement'),
  ('super_admin', 'company.view_stats'),
  ('super_admin', 'company.edit_stats')
ON CONFLICT DO NOTHING;

-- 3. Asignar rol super_admin al propietario del sistema (+240555570323)
-- ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_id UUID;
BEGIN
  SELECT id INTO v_owner_id FROM users WHERE phone = '+240555570323' LIMIT 1;
  IF v_owner_id IS NOT NULL THEN
    INSERT INTO user_roles (user_id, role, is_active)
    VALUES (v_owner_id, 'super_admin', true)
    ON CONFLICT (user_id, role) DO UPDATE SET is_active = true;

    UPDATE users
    SET account_type = 'super_admin', is_verified = true, verified_at = NOW()
    WHERE id = v_owner_id;

    RAISE NOTICE 'super_admin asignado a +240555570323 (id: %)', v_owner_id;
  ELSE
    RAISE NOTICE 'Usuario +240555570323 no encontrado — asigna el rol manualmente una vez que se registre';
  END IF;
END $$;

-- 4. Crear/actualizar usuario SEGESA (oficial de electricidad)
-- ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_segesa_id UUID;
  v_owner_id  UUID;
BEGIN
  SELECT id INTO v_owner_id FROM users WHERE phone = '+240555570323' LIMIT 1;
  SELECT id INTO v_segesa_id FROM users WHERE phone = '+240222202020' LIMIT 1;

  IF v_segesa_id IS NULL THEN
    -- Crear usuario SEGESA (contraseña: 123456 hasheada con bcrypt)
    INSERT INTO users (phone, full_name, password_hash, is_verified, account_type, avatar_url)
    VALUES (
      '+240222202020',
      'SEGESA',
      '$2a$10$32EXycOXC/p0NfhYXB6v3.o3W/M6pwwrAW00glQIWUOUttoZwoboa', -- 123456 bcrypt
      true,
      'official',
      '/assets/facturas/segesa.svg'
    )
    RETURNING id INTO v_segesa_id;
    RAISE NOTICE 'Usuario SEGESA creado con id: %', v_segesa_id;
  ELSE
    -- Actualizar para asegurar que esté verificado
    UPDATE users SET is_verified = true, account_type = 'official', full_name = 'SEGESA'
    WHERE id = v_segesa_id;
    RAISE NOTICE 'Usuario SEGESA actualizado (id: %)', v_segesa_id;
  END IF;

  -- Asignar rol official a SEGESA
  INSERT INTO user_roles (user_id, role, granted_by, is_active)
  VALUES (v_segesa_id, 'official', COALESCE(v_owner_id, v_segesa_id), true)
  ON CONFLICT (user_id, role) DO UPDATE SET is_active = true;

  -- Registrar SEGESA como proveedor de servicios
  INSERT INTO service_providers (user_id, provider_key, name, category, color, description, is_active)
  VALUES (
    v_segesa_id,
    'segesa',
    'SEGESA',
    'facturas',
    '#F59E0B',
    'Sociedad de Electricidad de Guinea Ecuatorial',
    true
  )
  ON CONFLICT (provider_key) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        is_active = true,
        color = '#F59E0B',
        category = 'facturas';

  RAISE NOTICE 'SEGESA configurado correctamente como proveedor';
END $$;

-- 5. Asignar permisos de empresa extendida a SEGESA directamente
--    (por si hay lag en el cache de roles)
-- ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_segesa_id UUID;
  v_owner_id  UUID;
  perm TEXT;
  perms TEXT[] := ARRAY[
    'company.manage_org', 'company.manage_staff',
    'company.publish_announcement', 'company.view_stats', 'company.edit_stats',
    'services.view_orders', 'services.process_orders', 'services.view_analytics',
    'provider.director', 'provider.operator'
  ];
BEGIN
  SELECT id INTO v_segesa_id FROM users WHERE phone = '+240222202020' LIMIT 1;
  SELECT id INTO v_owner_id  FROM users WHERE phone = '+240555570323' LIMIT 1;

  IF v_segesa_id IS NOT NULL THEN
    FOREACH perm IN ARRAY perms LOOP
      INSERT INTO user_permissions (user_id, permission, granted, granted_by)
      VALUES (v_segesa_id, perm, true, COALESCE(v_owner_id, v_segesa_id))
      ON CONFLICT (user_id, permission) DO UPDATE SET granted = true;
    END LOOP;
    RAISE NOTICE 'Permisos extendidos asignados a SEGESA';
  END IF;
END $$;

-- 6. Crear las tablas necesarias si faltan (tablas de provider_staff)
-- ──────────────────────────────────────────────────────────────────
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

ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS auto_process     BOOLEAN DEFAULT false;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS commission_rate  NUMERIC(5,4) DEFAULT 0.015;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS total_revenue    NUMERIC(14,2) DEFAULT 0;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS description      TEXT;

CREATE TABLE IF NOT EXISTS company_regions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT DEFAULT '#1485EE',
  cover_url   TEXT,
  is_active   BOOLEAN DEFAULT true,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_org_chart (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  region_id   UUID REFERENCES company_regions(id) ON DELETE SET NULL,
  parent_id   UUID REFERENCES company_org_chart(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  title       TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  photo_url   TEXT,
  is_active   BOOLEAN DEFAULT true,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  region_id   UUID REFERENCES company_regions(id) ON DELETE SET NULL,
  stat_type   TEXT NOT NULL,
  stat_label  TEXT NOT NULL,
  stat_value  NUMERIC(14,2) DEFAULT 0,
  unit        TEXT DEFAULT '',
  period      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID REFERENCES users(id)
);

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

CREATE TABLE IF NOT EXISTS company_announcements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID REFERENCES service_providers(id) ON DELETE CASCADE,
  author_id    UUID REFERENCES users(id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  category     TEXT DEFAULT 'general',
  region_id    UUID REFERENCES company_regions(id) ON DELETE SET NULL,
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  cover_url    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para las nuevas tablas
CREATE INDEX IF NOT EXISTS idx_provider_staff_user  ON provider_staff(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_provider_staff_prov  ON provider_staff(provider_id, role);
CREATE INDEX IF NOT EXISTS idx_company_regions_prov ON company_regions(provider_id);
CREATE INDEX IF NOT EXISTS idx_company_org_prov     ON company_org_chart(provider_id);
CREATE INDEX IF NOT EXISTS idx_company_stats_prov   ON company_stats(provider_id, stat_type);
CREATE INDEX IF NOT EXISTS idx_company_staff_prov   ON company_staff(provider_id, is_active);
CREATE INDEX IF NOT EXISTS idx_company_ann_prov     ON company_announcements(provider_id, is_published);
CREATE INDEX IF NOT EXISTS idx_company_ann_pub      ON company_announcements(is_published, published_at DESC);

-- ══════════════════════════════════════════════════════════════════
-- FIN MIGRACIÓN 006
-- ══════════════════════════════════════════════════════════════════
