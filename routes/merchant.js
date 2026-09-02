/**
 * routes/merchant.js
 * Endpoints del Merchant Dashboard: productos, pedidos, analytics, pagos
 */

const { requirePermission } = require('../middleware/roles');

module.exports = (app, auth, globalPool, supabase) => {

  // ─────────────────────────────────────────────────────────────────
  // PRODUCTOS
  // ─────────────────────────────────────────────────────────────────

  // GET /api/merchant/products
  app.get('/api/merchant/products', auth, requirePermission('merchant.products'), async (req, res) => {
    try {
      const pool = globalPool;
      const { page = 1, limit = 20, status } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = `SELECT * FROM merchant_products WHERE merchant_id = $1`;
      const params: any[] = [req.user.id];
      if (status) { params.push(status); query += ` AND status = $${params.length}`; }
      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // POST /api/merchant/products
  app.post('/api/merchant/products', auth, requirePermission('merchant.products'), async (req, res) => {
    try {
      const pool = globalPool;
      const { name, description, price, currency = 'XAF', category, stock, images = [], status = 'active' } = req.body;
      if (!name || !price) return res.status(400).json({ message: 'Nombre y precio requeridos' });

      const result = await pool.query(
        `INSERT INTO merchant_products (merchant_id, name, description, price, currency, category, stock, images, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *`,
        [req.user.id, name, description||null, price, currency, category||null, stock||0, JSON.stringify(images), status]
      );
      res.status(201).json(result.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // PUT /api/merchant/products/:id
  app.put('/api/merchant/products/:id', auth, requirePermission('merchant.products'), async (req, res) => {
    try {
      const pool = globalPool;
      const { name, description, price, stock, images, status } = req.body;
      const result = await pool.query(
        `UPDATE merchant_products SET name=$2, description=$3, price=$4, stock=$5, images=$6, status=$7, updated_at=NOW()
         WHERE id=$1 AND merchant_id=$8 RETURNING *`,
        [req.params.id, name, description, price, stock, JSON.stringify(images||[]), status, req.user.id]
      );
      if (!result.rows[0]) return res.status(404).json({ message: 'Producto no encontrado' });
      res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // DELETE /api/merchant/products/:id
  app.delete('/api/merchant/products/:id', auth, requirePermission('merchant.products'), async (req, res) => {
    try {
      const pool = globalPool;
      await pool.query(
        `UPDATE merchant_products SET status='deleted', updated_at=NOW() WHERE id=$1 AND merchant_id=$2`,
        [req.params.id, req.user.id]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────
  // PEDIDOS
  // ─────────────────────────────────────────────────────────────────

  // GET /api/merchant/orders
  app.get('/api/merchant/orders', auth, requirePermission('merchant.orders'), async (req, res) => {
    try {
      const pool = globalPool;
      const { page = 1, limit = 20, status } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = `
        SELECT mo.*, u.full_name as customer_name, u.phone as customer_phone
        FROM merchant_orders mo
        LEFT JOIN users u ON u.id = mo.customer_id
        WHERE mo.merchant_id = $1
      `;
      const params: any[] = [req.user.id];
      if (status) { params.push(status); query += ` AND mo.status = $${params.length}`; }
      query += ` ORDER BY mo.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // PUT /api/merchant/orders/:id/status — actualizar estado del pedido
  app.put('/api/merchant/orders/:id/status', auth, requirePermission('merchant.orders'), async (req, res) => {
    try {
      const pool = globalPool;
      const { status } = req.body;
      const validStatuses = ['pending','confirmed','preparing','shipped','delivered','cancelled'];
      if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Estado inválido' });

      const result = await pool.query(
        `UPDATE merchant_orders SET status=$2, updated_at=NOW() WHERE id=$1 AND merchant_id=$3 RETURNING *`,
        [req.params.id, status, req.user.id]
      );
      if (!result.rows[0]) return res.status(404).json({ message: 'Pedido no encontrado' });
      res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ─────────────────────────────────────────────────────────────────
  // ANALYTICS
  // ─────────────────────────────────────────────────────────────────

  // GET /api/merchant/analytics
  app.get('/api/merchant/analytics', auth, requirePermission('merchant.analytics'), async (req, res) => {
    try {
      const pool = globalPool;
      const userId = req.user.id;

      const [productsRes, ordersRes, revenueRes, pendingRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM merchant_products WHERE merchant_id=$1 AND status='active'`, [userId]),
        pool.query(`SELECT COUNT(*) FROM merchant_orders WHERE merchant_id=$1`, [userId]),
        pool.query(`SELECT COALESCE(SUM(total_amount),0) as revenue FROM merchant_orders WHERE merchant_id=$1 AND status='delivered'`, [userId]),
        pool.query(`SELECT COUNT(*) FROM merchant_orders WHERE merchant_id=$1 AND status='pending'`, [userId]),
      ].map(p => p.catch(() => ({ rows: [{ count: 0, revenue: 0 }] }))));

      // Pedidos por día (últimos 7 días)
      const dailyRes = await pool.query(
        `SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total_amount),0) as revenue
         FROM merchant_orders
         WHERE merchant_id=$1 AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY DATE(created_at) ORDER BY date`,
        [userId]
      ).catch(() => ({ rows: [] }));

      res.json({
        products_active: parseInt(productsRes.rows[0]?.count || 0),
        orders_total:    parseInt(ordersRes.rows[0]?.count || 0),
        revenue_total:   parseFloat(revenueRes.rows[0]?.revenue || 0),
        orders_pending:  parseInt(pendingRes.rows[0]?.count || 0),
        daily_stats:     dailyRes.rows,
      });
    } catch (e) {
      console.error('GET /api/merchant/analytics:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // PAGOS / PAYOUTS
  // ─────────────────────────────────────────────────────────────────

  // POST /api/merchant/payouts/request
  app.post('/api/merchant/payouts/request', auth, requirePermission('merchant.payouts'), async (req, res) => {
    try {
      const pool = globalPool;
      const { amount, bank_account, notes } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ message: 'Monto requerido' });
      if (amount < 5000) return res.status(400).json({ message: 'Monto mínimo: 5,000 XAF' });

      const result = await pool.query(
        `INSERT INTO merchant_payouts (merchant_id, amount, bank_account, notes, status, created_at)
         VALUES ($1,$2,$3,$4,'pending',NOW()) RETURNING *`,
        [req.user.id, amount, bank_account||null, notes||null]
      );
      res.status(201).json(result.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // GET /api/merchant/payouts
  app.get('/api/merchant/payouts', auth, requirePermission('merchant.payouts'), async (req, res) => {
    try {
      const pool = globalPool;
      const result = await pool.query(
        `SELECT * FROM merchant_payouts WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [req.user.id]
      ).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

};
