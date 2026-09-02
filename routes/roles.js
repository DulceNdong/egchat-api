/**
 * routes/roles.js
 * Endpoints de gestión de roles y permisos
 */

const express = require('express');
const router = express.Router();
const { requireRole, requirePermission, invalidateUserCache } = require('../middleware/roles');

module.exports = (app, auth, globalPool) => {

  // ── GET /api/me/role — rol y permisos del usuario actual ──────────
  app.get('/api/me/role', auth, async (req, res) => {
    try {
      const pool = globalPool;
      if (!pool) return res.json({ role: 'user', permissions: ['chat.send'], is_verified: false });

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
        [req.user.id]
      );

      const row = roleRes.rows[0];
      const role = row?.role || row?.account_type || 'user';

      const permsRes = await pool.query(
        `SELECT rp.permission FROM role_permissions rp WHERE rp.role = $1
         UNION
         SELECT up.permission FROM user_permissions up WHERE up.user_id = $2 AND up.granted = true
         EXCEPT
         SELECT up.permission FROM user_permissions up WHERE up.user_id = $2 AND up.granted = false`,
        [role, req.user.id]
      );

      res.json({
        role,
        permissions: permsRes.rows.map(r => r.permission),
        is_verified: row?.is_verified || false,
      });
    } catch (e) {
      console.error('GET /api/me/role error:', e.message);
      res.json({ role: 'user', permissions: ['chat.send'], is_verified: false });
    }
  });

  // ── GET /api/users/:userId/role — rol de otro usuario (admin) ──────
  app.get('/api/users/:userId/role', auth, requirePermission('admin.users'), async (req, res) => {
    try {
      const pool = globalPool;
      const { userId } = req.params;

      const res2 = await pool.query(
        `SELECT ur.role, ur.granted_at, ur.expires_at, ur.is_active,
                u.is_verified, u.account_type
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         WHERE u.id = $1`,
        [userId]
      );

      res.json(res2.rows);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/users/:userId/role — asignar rol (admin) ────────────
  app.post('/api/users/:userId/role', auth, requirePermission('admin.roles'), async (req, res) => {
    try {
      const pool = globalPool;
      const { userId } = req.params;
      const { role, expires_at } = req.body;

      const validRoles = ['user', 'official', 'business', 'merchant', 'moderator', 'admin'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: `Rol inválido. Válidos: ${validRoles.join(', ')}` });
      }

      // No permitir asignar super_admin salvo desde super_admin
      if (role === 'super_admin') {
        const { userRole } = req;
        if (userRole !== 'super_admin') {
          return res.status(403).json({ message: 'Solo super_admin puede asignar super_admin' });
        }
      }

      await pool.query(
        `INSERT INTO user_roles (user_id, role, granted_by, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, role) DO UPDATE SET
           is_active = true, granted_by = $3, granted_at = NOW(), expires_at = $4`,
        [userId, role, req.user.id, expires_at || null]
      );

      // Sincronizar account_type en users
      await pool.query(
        `UPDATE users SET account_type = $1 WHERE id = $2`,
        [role, userId]
      );

      // Si es oficial/business/merchant, marcar como verificado
      if (['official', 'business', 'merchant'].includes(role)) {
        await pool.query(
          `UPDATE users SET is_verified = true, verified_at = NOW(), verified_by = $1 WHERE id = $2`,
          [req.user.id, userId]
        );
      }

      invalidateUserCache(userId);

      res.json({ success: true, role, user_id: userId });
    } catch (e) {
      console.error('POST /api/users/:userId/role error:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // ── DELETE /api/users/:userId/role/:role — revocar rol ────────────
  app.delete('/api/users/:userId/role/:role', auth, requirePermission('admin.roles'), async (req, res) => {
    try {
      const pool = globalPool;
      const { userId, role } = req.params;

      await pool.query(
        `UPDATE user_roles SET is_active = false WHERE user_id = $1 AND role = $2`,
        [userId, role]
      );

      // Revertir a 'user' si no queda otro rol activo
      const remaining = await pool.query(
        `SELECT role FROM user_roles WHERE user_id = $1 AND is_active = true LIMIT 1`,
        [userId]
      );

      const newRole = remaining.rows[0]?.role || 'user';
      await pool.query(`UPDATE users SET account_type = $1 WHERE id = $2`, [newRole, userId]);

      invalidateUserCache(userId);
      res.json({ success: true, new_role: newRole });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/users/:userId/verify — verificar cuenta ─────────────
  app.post('/api/users/:userId/verify', auth, requirePermission('admin.users'), async (req, res) => {
    try {
      const pool = globalPool;
      const { userId } = req.params;
      const { verified } = req.body;

      await pool.query(
        `UPDATE users SET is_verified = $1, verified_at = $2, verified_by = $3 WHERE id = $4`,
        [verified !== false, verified !== false ? new Date() : null, req.user.id, userId]
      );

      invalidateUserCache(userId);
      res.json({ success: true, is_verified: verified !== false });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

};
