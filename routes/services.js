/**
 * routes/services.js
 * Endpoints para el sistema de pedidos de servicios:
 * Recarga, Internet, Canales, y próximos bloques.
 *
 * Flujo:
 * 1. Usuario confirma pedido en la app → POST /api/services/orders
 * 2. Proveedor ve el pedido en su dashboard → GET /api/services/orders/provider
 * 3. Proveedor procesa → PUT /api/services/orders/:id/status
 * 4. Usuario ve el estado actualizado
 */

const { requirePermission } = require('../middleware/roles');

module.exports = (app, auth, globalPool) => {

  // ─────────────────────────────────────────────────────────────────
  // USUARIO: Crear pedido de servicio
  // ─────────────────────────────────────────────────────────────────

  app.post('/api/services/orders', auth, async (req, res) => {
    try {
      const pool = globalPool;
      if (!pool) return res.status(503).json({ message: 'DB no disponible' });

      const {
        provider_id, provider_name, provider_color,
        category, package_id, package_name,
        amount, phone_target, notes, metadata,
      } = req.body;

      if (!provider_id || !category || !amount) {
        return res.status(400).json({ message: 'provider_id, category y amount son requeridos' });
      }

      const result = await pool.query(
        `INSERT INTO service_orders
           (user_id, provider_id, provider_name, provider_color, category,
            package_id, package_name, amount, currency, phone_target,
            notes, metadata, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'XAF',$9,$10,$11,'pending',NOW(),NOW())
         RETURNING id, status, created_at`,
        [
          req.user.id, provider_id, provider_name, provider_color || '#007AFF',
          category, package_id || null, package_name || null,
          amount, phone_target || null, notes || null,
          JSON.stringify(metadata || {}),
        ]
      );

      // Notificar al proveedor por SSE si está conectado
      try {
        const emitToUsers = req.app.get('emitToUsers');
        // Buscar el user_id del proveedor en service_providers
        const provRes = await pool.query(
          `SELECT user_id FROM service_providers WHERE provider_key = $1 AND is_active = true LIMIT 1`,
          [provider_id]
        );
        if (provRes.rows[0]?.user_id && emitToUsers) {
          emitToUsers([provRes.rows[0].user_id], {
            type: 'new_service_order',
            order: result.rows[0],
            provider_id,
            category,
          });
        }
      } catch {}

      res.status(201).json(result.rows[0]);
    } catch (e) {
      console.error('POST /api/services/orders:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // GET /api/services/orders/me — historial de pedidos del usuario
  app.get('/api/services/orders/me', auth, async (req, res) => {
    try {
      const pool = globalPool;
      const { category, page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = `SELECT * FROM service_orders WHERE user_id = $1`;
      const params: any[] = [req.user.id];
      if (category) { params.push(category); query += ` AND category = $${params.length}`; }
      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // PROVEEDOR: Ver sus pedidos (requiere permiso services.view_orders)
  // ─────────────────────────────────────────────────────────────────

  // GET /api/services/orders/provider — pedidos que le corresponden al proveedor logueado
  app.get('/api/services/orders/provider', auth, requirePermission('services.view_orders'), async (req, res) => {
    try {
      const pool = globalPool;
      const { status, category, page = 1, limit = 50 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Obtener los provider_keys asignados a este usuario
      const provRes = await pool.query(
        `SELECT provider_key FROM service_providers WHERE user_id = $1 AND is_active = true`,
        [req.user.id]
      );

      // super_admin ve todos los pedidos
      const isSuperAdmin = req.userRole === 'super_admin' || req.userRole === 'admin';
      const providerKeys = provRes.rows.map(r => r.provider_key);

      if (!isSuperAdmin && providerKeys.length === 0) {
        return res.json([]);
      }

      let query = `
        SELECT so.*, u.full_name as user_name, u.phone as user_phone
        FROM service_orders so
        LEFT JOIN users u ON u.id = so.user_id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (!isSuperAdmin) {
        params.push(providerKeys);
        query += ` AND so.provider_id = ANY($${params.length})`;
      }
      if (status) { params.push(status); query += ` AND so.status = $${params.length}`; }
      if (category) { params.push(category); query += ` AND so.category = $${params.length}`; }

      query += ` ORDER BY so.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) {
      console.error('GET /api/services/orders/provider:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // PUT /api/services/orders/:id/status — procesar pedido
  app.put('/api/services/orders/:id/status', auth, requirePermission('services.process_orders'), async (req, res) => {
    try {
      const pool = globalPool;
      const { status, notes } = req.body;
      const validStatuses = ['pending', 'processing', 'completed', 'failed', 'refunded'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: `Estado inválido. Válidos: ${validStatuses.join(', ')}` });
      }

      // Verificar que el pedido pertenece a su proveedor (o es admin)
      const isSuperAdmin = req.userRole === 'super_admin' || req.userRole === 'admin';
      let orderQuery = `SELECT so.* FROM service_orders so WHERE so.id = $1`;
      const orderResult = await pool.query(orderQuery, [req.params.id]);
      const order = orderResult.rows[0];
      if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

      if (!isSuperAdmin) {
        const provRes = await pool.query(
          `SELECT provider_key FROM service_providers WHERE user_id = $1 AND provider_key = $2`,
          [req.user.id, order.provider_id]
        );
        if (provRes.rows.length === 0) return res.status(403).json({ message: 'Sin acceso a este pedido' });
      }

      const result = await pool.query(
        `UPDATE service_orders
         SET status = $1, notes = COALESCE($2, notes),
             processed_by = $3, processed_at = NOW(), updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, notes || null, req.user.id, req.params.id]
      );

      // Notificar al usuario por SSE
      try {
        const emitToUsers = req.app.get('emitToUsers');
        if (emitToUsers && order.user_id) {
          emitToUsers([order.user_id], {
            type: 'service_order_updated',
            order_id: req.params.id,
            status,
            provider_name: order.provider_name,
            category: order.category,
          });
        }
      } catch {}

      res.json(result.rows[0]);
    } catch (e) {
      console.error('PUT /api/services/orders/:id/status:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // PROVEEDOR: Analytics
  // ─────────────────────────────────────────────────────────────────

  app.get('/api/services/analytics', auth, requirePermission('services.view_analytics'), async (req, res) => {
    try {
      const pool = globalPool;
      const isSuperAdmin = req.userRole === 'super_admin' || req.userRole === 'admin';

      let whereClause = '';
      const params: any[] = [];

      if (!isSuperAdmin) {
        const provRes = await pool.query(
          `SELECT provider_key FROM service_providers WHERE user_id = $1`,
          [req.user.id]
        );
        const keys = provRes.rows.map(r => r.provider_key);
        if (keys.length === 0) return res.json({ total: 0, pending: 0, completed: 0, revenue: 0, by_category: [] });
        params.push(keys);
        whereClause = `WHERE provider_id = ANY($1)`;
      }

      const [totalRes, pendingRes, completedRes, revenueRes, byCatRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM service_orders ${whereClause}`, params),
        pool.query(`SELECT COUNT(*) FROM service_orders ${whereClause ? whereClause + ' AND' : 'WHERE'} status='pending'`, params),
        pool.query(`SELECT COUNT(*) FROM service_orders ${whereClause ? whereClause + ' AND' : 'WHERE'} status='completed'`, params),
        pool.query(`SELECT COALESCE(SUM(amount),0) as revenue FROM service_orders ${whereClause ? whereClause + ' AND' : 'WHERE'} status='completed'`, params),
        pool.query(`SELECT category, COUNT(*) as count, COALESCE(SUM(amount),0) as revenue FROM service_orders ${whereClause} GROUP BY category ORDER BY count DESC`, params),
      ].map(p => p.catch(() => ({ rows: [{ count: 0, revenue: 0 }] }))));

      // Pedidos por día (últimos 7 días)
      const dailyRes = await pool.query(
        `SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(amount),0) as revenue
         FROM service_orders
         ${whereClause ? whereClause + ' AND' : 'WHERE'} created_at >= NOW() - INTERVAL '7 days'
         GROUP BY DATE(created_at) ORDER BY date`,
        params
      ).catch(() => ({ rows: [] }));

      res.json({
        total:       parseInt(totalRes.rows[0]?.count || 0),
        pending:     parseInt(pendingRes.rows[0]?.count || 0),
        completed:   parseInt(completedRes.rows[0]?.count || 0),
        revenue:     parseFloat(revenueRes.rows[0]?.revenue || 0),
        by_category: byCatRes.rows,
        daily:       dailyRes.rows,
      });
    } catch (e) {
      console.error('GET /api/services/analytics:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // ADMIN: Registrar proveedor (asignar provider_key a un user)
  // ─────────────────────────────────────────────────────────────────

  app.post('/api/services/providers', auth, requirePermission('admin.roles'), async (req, res) => {
    try {
      const pool = globalPool;
      const { user_id, provider_key, name, category, color, logo_url } = req.body;
      if (!user_id || !provider_key || !name || !category) {
        return res.status(400).json({ message: 'user_id, provider_key, name y category son requeridos' });
      }

      const result = await pool.query(
        `INSERT INTO service_providers (user_id, provider_key, name, category, color, logo_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id) DO UPDATE SET
           provider_key=$2, name=$3, category=$4, color=$5, logo_url=$6, is_active=true
         RETURNING *`,
        [user_id, provider_key, name, category, color || '#007AFF', logo_url || null]
      );

      // Asignar rol official al user del proveedor
      await pool.query(
        `INSERT INTO user_roles (user_id, role, granted_by, is_active)
         VALUES ($1,'official',$2,true)
         ON CONFLICT (user_id, role) DO UPDATE SET is_active=true`,
        [user_id, req.user.id]
      ).catch(() => {});

      res.status(201).json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // GET /api/services/providers — listar todos los proveedores registrados
  app.get('/api/services/providers', auth, requirePermission('admin.users'), async (req, res) => {
    try {
      const pool = globalPool;
      const result = await pool.query(
        `SELECT sp.*, u.full_name, u.phone
         FROM service_providers sp
         LEFT JOIN users u ON u.id = sp.user_id
         ORDER BY sp.category, sp.name`,
      ).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

};
