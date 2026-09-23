-- ══════════════════════════════════════════════════════════════════
-- MIGRACIÓN 007 — Añadir banner_url (portada) a la tabla users
-- Ejecutar en Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════

-- 1. Añadir columna banner_url a users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT NULL;

-- 2. Comentario descriptivo
COMMENT ON COLUMN users.banner_url IS 'URL de la imagen de portada/banner del perfil del usuario';

-- 3. Índice opcional para búsquedas rápidas de usuarios con banner
-- (solo si hay necesidad de filtrar por existencia de banner)
-- CREATE INDEX IF NOT EXISTS idx_users_banner_url ON users (banner_url) WHERE banner_url IS NOT NULL;

-- 4. Verificar
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'banner_url';
