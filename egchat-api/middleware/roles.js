/**
 * middleware/roles.js
 * Middleware de roles y permisos para EgChat API
 */

const { Pool } = require('pg');

// Cache en memoria para permisos (TTL 5 minutos)
const permCache = new Map(); // userId -> { permissions: Set, role, expiresAt }
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Obtener permisos efectivos de un usuario
 * Combina: permisos del rol + overrides por usuario
 */
async function getUserPermissions(userId, pool) {
  // Revisar caché
  const cached = permCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  try {
    // Obtener rol activo del usuario
    const roleRes = await pool.query(
      `SELECT ur.role, u.is_verified, u.account_type
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active = true
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
       WHERE u.id = $1
       ORDER BY CASE ur.role
         WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1
         WHEN 'moderator' THEN 2 WHEN 'merchant' THEN 3
         WHEN 'business' THEN 4 WHEN 'official' THEN 5
         ELSE 6 END
       LIMIT 1`,
      [userId]
    );

    const row = roleRes.rows[0];
    const role = row?.role || row?.account_type || 'user';

    // Obtener permisos del rol
    const rolePermsRes = await pool.query(
      `SELECT permission FROM role_permissions WHERE role = $1`,
      [role]
    );

    // Obtener overrides por usuario
    const userPermsRes = await pool.query(
      `SELECT permission, granted FROM user_permissions WHERE user_id = $1`,
      [userId]
    );

    const permissions = new Set(rolePermsRes.rows.map(r => r.permission));

    // Aplicar overrides
    for (const override of userPermsRes.rows) {
      if (override.granted) {
        permissions.add(override.permission);
      } else {
        permissions.delete(override.permission);
      }
    }

    const result = { role, permissions, isVerified: row?.is_verified || false, expiresAt: Date.now() + CACHE_TTL };
    permCache.set(userId, result);
    return result;
  } catch {
    // Fallback: rol user con permisos básicos
    return { role: 'user', permissions: new Set(['chat.send', 'wallet.view', 'wallet.transfer', 'wallet.topup']), isVerified: false, expiresAt: Date.now() + CACHE_TTL };
  }
}

/**
 * Invalidar caché de un usuario (llamar tras cambio de rol)
 */
function invalidateUserCache(userId) {
  permCache.delete(userId);
}

/**
 * Middleware: requerir rol mínimo
 * Uso: requireRole('admin')
 */
function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ message: 'No autenticado' });

    const pool = req.app.get('globalPool');
    if (!pool) return next(); // Si no hay pool, dejar pasar (degraded mode)

    const { role } = await getUserPermissions(req.user.id, pool);
    const roleHierarchy = ['user', 'official', 'business', 'merchant', 'moderator', 'admin', 'super_admin'];
    const userLevel = roleHierarchy.indexOf(role);
    const requiredLevel = Math.min(...roles.map(r => roleHierarchy.indexOf(r)));

    if (userLevel < requiredLevel && !roles.includes(role)) {
      return res.status(403).json({ message: 'Permisos insuficientes', required: roles, current: role });
    }
    req.userRole = role;
    next();
  };
}

/**
 * Middleware: requerir permiso específico
 * Uso: requirePermission('wallet.admin')
 */
function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ message: 'No autenticado' });

    const pool = req.app.get('globalPool');
    if (!pool) return next();

    const { permissions, role } = await getUserPermissions(req.user.id, pool);
    if (!permissions.has(permission)) {
      return res.status(403).json({ message: `Permiso requerido: ${permission}`, current_role: role });
    }
    req.userRole = role;
    req.userPermissions = permissions;
    next();
  };
}

/**
 * Inyectar rol y permisos en req sin bloquear (para rutas que solo necesitan saber el rol)
 */
function injectRole(pool) {
  return async (req, res, next) => {
    if (req.user?.id && pool) {
      try {
        const info = await getUserPermissions(req.user.id, pool);
        req.userRole = info.role;
        req.userPermissions = info.permissions;
        req.isVerified = info.isVerified;
      } catch {}
    }
    next();
  };
}

module.exports = { getUserPermissions, requireRole, requirePermission, injectRole, invalidateUserCache };
