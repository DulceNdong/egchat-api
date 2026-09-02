/**
 * routes/provider_dashboard.js
 * Dashboard para proveedores de servicios — dos roles:
 *   owner/director → stats, ganancias, comisiones EgChat (1.5%)
 *   operator       → procesar pedidos, modo automático
 */
const { requirePermission } = require('../middleware/roles');

const COMMISSION_RATE = 0.015; // 1.5% por cada venta

module.exports = (app, auth, globalPool) => {

  // ── Obtener mi info de proveedor ────────────────────────────────
  app.get('/api/provider/me', auth, async (req, res) => {
    try {
      const pool = globalPool;
      // Buscar si este usuario es staff de algún proveedor
      const r = await pool.query(
        `SELECT sp.*, ps.role as staff_role
         FROM provider_staff ps
         JOIN service_providers sp ON sp.id = ps.provider_id
         WHERE ps.user_id = $1 AND ps.is_active = true
         LIMIT 1`,
        [req.user.id]
      );
      // También checar si es el owner directo
      const own = await pool.query(
        `SELECT * FROM service_providers WHERE user_id = $1 AND is_active = true LIMIT 1`,
        [req.user.id]
      );
      if (r.rows.length > 0) return res.json({ ...r.rows[0], is_owner: false });
      if (own.rows.length > 0) return res.json({ ...own.rows[0], staff_role: 'owner', is_owner: true });
      res.status(404).json({ message: 'No eres proveedor registrado' });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ── DIRECTOR: Estadísticas ejecutivas ──────────────────────────
  app.get('/api/provider/stats/director', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const providerKeys = await getMyProviderKeys(pool, req.user.id);
      if (providerKeys.length === 0) return res.status(403).json({ message: 'Sin acceso' });

      const [todayRes, monthRes, totalRes, pendingRes, dailyRes, byProductRes] = await Promise.all([
        // Hoy
        pool.query(
          `SELECT COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
           FROM service_orders WHERE provider_id = ANY($1)
           AND status='completed' AND DATE(created_at) = CURRENT_DATE`, [providerKeys]),
        // Este mes
        pool.query(
          `SELECT COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
           FROM service_orders WHERE provider_id = ANY($1)
           AND status='completed' AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`, [providerKeys]),
        // Total histórico
        pool.query(
          `SELECT COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
           FROM service_orders WHERE provider_id = ANY($1) AND status='completed'`, [providerKeys]),
        // Pendientes
        pool.query(
          `SELECT COUNT(*) as pending FROM service_orders
           WHERE provider_id = ANY($1) AND status IN ('pending','processing')`, [providerKeys]),
        // Últimos 7 días
        pool.query(
          `SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(amount),0) as revenue
           FROM service_orders WHERE provider_id = ANY($1) AND status='completed'
           AND created_at >= NOW() - INTERVAL '7 days'
           GROUP BY DATE(created_at) ORDER BY date`, [providerKeys]),
        // Por producto
        pool.query(
          `SELECT package_name, category, COUNT(*) as orders, COALESCE(SUM(amount),0) as revenue
           FROM service_orders WHERE provider_id = ANY($1) AND status='completed'
           GROUP BY package_name, category ORDER BY revenue DESC LIMIT 10`, [providerKeys]),
      ].map(p => p.catch(() => ({ rows: [{ revenue: 0, orders: 0, pending: 0 }] }))));

      const todayRev = parseFloat(todayRes.rows[0]?.revenue || 0);
      const monthRev = parseFloat(monthRes.rows[0]?.revenue || 0);
      const totalRev = parseFloat(totalRes.rows[0]?.revenue || 0);

      res.json({
        today: {
          revenue: todayRev,
          commission: +(todayRev * COMMISSION_RATE).toFixed(2),
          net: +(todayRev * (1 - COMMISSION_RATE)).toFixed(2),
          orders: parseInt(todayRes.rows[0]?.orders || 0),
        },
        month: {
          revenue: monthRev,
          commission: +(monthRev * COMMISSION_RATE).toFixed(2),
          net: +(monthRev * (1 - COMMISSION_RATE)).toFixed(2),
          orders: parseInt(monthRes.rows[0]?.orders || 0),
        },
        total: {
          revenue: totalRev,
          commission: +(totalRev * COMMISSION_RATE).toFixed(2),
          net: +(totalRev * (1 - COMMISSION_RATE)).toFixed(2),
          orders: parseInt(totalRes.rows[0]?.orders || 0),
        },
        pending: parseInt(pendingRes.rows[0]?.pending || 0),
        commission_rate: COMMISSION_RATE,
        daily: dailyRes.rows,
        by_product: byProductRes.rows,
      });
    } catch (e) { console.error(e); res.status(500).json({ message: e.message }); }
  });

  // ── OPERATOR: Ver pedidos de su proveedor ──────────────────────
  app.get('/api/provider/orders', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const providerKeys = await getMyProviderKeys(pool, req.user.id);
      if (providerKeys.length === 0) return res.status(403).json({ message: 'Sin acceso' });

      const { status, category, page = 1, limit = 100 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      const params = [providerKeys];
      let where = `WHERE so.provider_id = ANY($1)`;
      if (status) { params.push(status); where += ` AND so.status = $${params.length}`; }
      if (category) { params.push(category); where += ` AND so.category = $${params.length}`; }
      params.push(parseInt(limit), offset);

      const r = await pool.query(
        `SELECT so.*, u.full_name as user_name, u.phone as user_phone,
                u.avatar_url as user_avatar
         FROM service_orders so
         LEFT JOIN users u ON u.id = so.user_id
         ${where}
         ORDER BY CASE so.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                  so.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ── OPERATOR: Procesar pedido ──────────────────────────────────
  app.put('/api/provider/orders/:id/process', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const providerKeys = await getMyProviderKeys(pool, req.user.id);
      const { status, notes } = req.body;
      const valid = ['processing', 'completed', 'failed', 'refunded'];
      if (!valid.includes(status)) return res.status(400).json({ message: 'Estado inválido' });

      const orderR = await pool.query(`SELECT * FROM service_orders WHERE id = $1`, [req.params.id]);
      const order = orderR.rows[0];
      if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

      const isSuperAdmin = req.userRole === 'super_admin' || req.userRole === 'admin';
      if (!isSuperAdmin && !providerKeys.includes(order.provider_id)) {
        return res.status(403).json({ message: 'Sin acceso' });
      }

      const r = await pool.query(
        `UPDATE service_orders SET status=$1, notes=COALESCE($2,notes),
         processed_by=$3, processed_at=NOW(), updated_at=NOW()
         WHERE id=$4 RETURNING *`,
        [status, notes || null, req.user.id, req.params.id]
      );

      // Notificar al usuario por SSE
      try {
        const emit = req.app.get('emitToUsers');
        if (emit && order.user_id) {
          emit([order.user_id], { type: 'service_order_updated', order_id: order.id, status, provider_name: order.provider_name });
        }
      } catch {}

      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ── OWNER/DIRECTOR: Toggle modo automático ─────────────────────
  app.put('/api/provider/auto-process', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const { auto_process } = req.body;

      // Solo el owner puede activar el modo automático
      const r = await pool.query(
        `UPDATE service_providers SET auto_process = $1 WHERE user_id = $2 RETURNING *`,
        [!!auto_process, req.user.id]
      );

      if (r.rows.length === 0) {
        // También buscar si es staff con rol owner
        const staffR = await pool.query(
          `SELECT sp.id FROM provider_staff ps
           JOIN service_providers sp ON sp.id = ps.provider_id
           WHERE ps.user_id = $1 AND ps.role = 'owner'`, [req.user.id]
        );
        if (staffR.rows.length === 0 && req.userRole !== 'super_admin' && req.userRole !== 'admin') {
          return res.status(403).json({ message: 'Solo el propietario puede cambiar el modo automático' });
        }
        await pool.query(
          `UPDATE service_providers SET auto_process = $1
           WHERE id IN (SELECT provider_id FROM provider_staff WHERE user_id = $2 AND role='owner')`,
          [!!auto_process, req.user.id]
        );
      }

      res.json({ auto_process: !!auto_process });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ── Gestión de staff ──────────────────────────────────────────
  app.get('/api/provider/staff', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const providerKeys = await getMyProviderKeys(pool, req.user.id);
      if (providerKeys.length === 0) return res.status(403).json({ message: 'Sin acceso' });

      const r = await pool.query(
        `SELECT ps.*, u.full_name, u.phone, u.avatar_url
         FROM provider_staff ps
         JOIN service_providers sp ON sp.id = ps.provider_id
         JOIN users u ON u.id = ps.user_id
         WHERE sp.provider_key = ANY($1) AND ps.is_active = true`, [providerKeys]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/provider/staff', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const { phone, role = 'operator' } = req.body;
      if (!['director', 'operator'].includes(role)) return res.status(400).json({ message: 'Rol inválido' });

      // Encontrar usuario por teléfono
      const userR = await pool.query(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [phone]);
      if (!userR.rows[0]) return res.status(404).json({ message: 'Usuario no encontrado' });

      // Obtener el provider del owner actual
      const provR = await pool.query(
        `SELECT id FROM service_providers WHERE user_id = $1 LIMIT 1`, [req.user.id]
      );
      if (!provR.rows[0]) return res.status(403).json({ message: 'No eres propietario de un proveedor' });

      const r = await pool.query(
        `INSERT INTO provider_staff (provider_id, user_id, role, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (provider_id, user_id)
         DO UPDATE SET role=$3, is_active=true RETURNING *`,
        [provR.rows[0].id, userR.rows[0].id, role, req.user.id]
      );

      // Dar permiso según el rol
      const perm = role === 'director' ? 'provider.director' : 'provider.operator';
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission, granted, granted_by)
         VALUES ($1,$2,true,$3) ON CONFLICT (user_id, permission) DO UPDATE SET granted=true`,
        [userR.rows[0].id, perm, req.user.id]
      ).catch(() => {});

      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });
};

// ── Helper: obtener provider_keys del usuario ─────────────────────
async function getMyProviderKeys(pool, userId) {
  try {
    const [own, staff] = await Promise.all([
      pool.query(`SELECT provider_key FROM service_providers WHERE user_id=$1 AND is_active=true`, [userId]),
      pool.query(
        `SELECT sp.provider_key FROM provider_staff ps
         JOIN service_providers sp ON sp.id = ps.provider_id
         WHERE ps.user_id=$1 AND ps.is_active=true AND sp.is_active=true`, [userId]
      ),
    ]);
    const keys = new Set([...own.rows.map(r => r.provider_key), ...staff.rows.map(r => r.provider_key)]);
    // super_admin ve todos
    if (keys.size === 0) {
      // devolver vacío — el caller decide qué hacer
    }
    return [...keys];
  } catch { return []; }
}
