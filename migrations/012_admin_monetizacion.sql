-- ============================================================
-- CREAR ADMIN MONETIZACIÓN
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

-- 1. Ampliar el CHECK de entity para incluir MONETIZACION
--    (si ya existe la tabla admin_users con CHECK constraint)
ALTER TABLE admin_users
  DROP CONSTRAINT IF EXISTS admin_users_entity_check;

ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_entity_check
  CHECK (entity IN ('EGCHAT', 'BANGE', 'ANIF', 'REGULATOR', 'MONETIZACION', 'OUR_COMPANY'));

-- 2. Ampliar el CHECK de role para incluir MONETIZACION_ADMIN
ALTER TABLE admin_users
  DROP CONSTRAINT IF EXISTS admin_users_role_check;

ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check
  CHECK (role IN (
    'SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_MANAGER', 'COMPLIANCE_OFFICER',
    'ANALYST', 'BANK_APPROVER', 'BANK_VIEWER', 'REGULATOR_AUDITOR',
    'MONETIZACION_ADMIN'
  ));

-- 3. Insertar el usuario admin de monetización
--    Email:    admin.monetizacion@egchat.gq
--    Password: EGChat2026!$Admin
INSERT INTO admin_users (email, password_hash, role, entity, is_active)
VALUES (
  'admin.monetizacion@egchat.gq',
  '$2a$12$2pXCcEBd5dvIgS8ewTeRr.dyRi/M62vmNWk2r9iAtWg2SSavhZw8O',
  'MONETIZACION_ADMIN',
  'MONETIZACION',
  true
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  role          = EXCLUDED.role,
  entity        = EXCLUDED.entity,
  is_active     = true;

-- 4. Verificar
SELECT id, email, role, entity, is_active, created_at
FROM admin_users
WHERE entity = 'MONETIZACION';
