/**
 * routes/company.js
 * Endpoints para la Cuenta Oficial extendida:
 * - Regiones
 * - Organigrama
 * - Estadísticas de consumo
 * - Empleados internos
 * - Comunicados públicos
 */
const { requirePermission } = require('../middleware/roles');

module.exports = (app, auth, globalPool) => {

  // ── Helper: obtener provider del usuario ────────────────────────
  async function getMyProvider(userId) {
    const r = await globalPool.query(
      `SELECT id, provider_key, name, category, color FROM service_providers WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId]
    );
    return r.rows[0] || null;
  }

  // ════════════════════════════════════════════════════════════════
  // REGIONES
  // ════════════════════════════════════════════════════════════════

  app.get('/api/company/regions', auth, async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.json([]);
      const r = await globalPool.query(
        `SELECT * FROM company_regions WHERE provider_id = $1 AND is_active = true ORDER BY sort_order, name`,
        [prov.id]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/company/regions', auth, requirePermission('company.manage_org'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.status(403).json({ message: 'Sin proveedor' });
      const { name, description, color, cover_url, sort_order } = req.body;
      const r = await globalPool.query(
        `INSERT INTO company_regions (provider_id, name, description, color, cover_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [prov.id, name, description || null, color || '#1485EE', cover_url || null, sort_order || 0]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.put('/api/company/regions/:id', auth, requirePermission('company.manage_org'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      const { name, description, color, cover_url, sort_order } = req.body;
      const r = await globalPool.query(
        `UPDATE company_regions SET name=$1,description=$2,color=$3,cover_url=$4,sort_order=$5
         WHERE id=$6 AND provider_id=$7 RETURNING *`,
        [name, description || null, color, cover_url || null, sort_order || 0, req.params.id, prov?.id]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // ORGANIGRAMA
  // ════════════════════════════════════════════════════════════════

  app.get('/api/company/org', auth, async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.json([]);
      const r = await globalPool.query(
        `SELECT o.*, cr.name as region_name
         FROM company_org_chart o
         LEFT JOIN company_regions cr ON cr.id = o.region_id
         WHERE o.provider_id = $1 AND o.is_active = true
         ORDER BY o.sort_order, o.title`,
        [prov.id]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/company/org', auth, requirePermission('company.manage_org'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.status(403).json({ message: 'Sin proveedor' });
      const { name, title, phone, email, photo_url, region_id, parent_id, sort_order } = req.body;
      // Buscar user_id si el teléfono coincide con alguien en EgChat
      let userId = null;
      if (phone) {
        const u = await globalPool.query(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [phone]);
        if (u.rows[0]) userId = u.rows[0].id;
      }
      const r = await globalPool.query(
        `INSERT INTO company_org_chart (provider_id, region_id, parent_id, user_id, name, title, phone, email, photo_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [prov.id, region_id || null, parent_id || null, userId, name, title, phone || null, email || null, photo_url || null, sort_order || 0]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.put('/api/company/org/:id', auth, requirePermission('company.manage_org'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      const { name, title, phone, email, photo_url, region_id, parent_id, sort_order } = req.body;
      let userId = null;
      if (phone) {
        const u = await globalPool.query(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [phone]);
        if (u.rows[0]) userId = u.rows[0].id;
      }
      const r = await globalPool.query(
        `UPDATE company_org_chart SET name=$1,title=$2,phone=$3,email=$4,photo_url=$5,region_id=$6,parent_id=$7,user_id=$8,sort_order=$9,updated_at=NOW()
         WHERE id=$10 AND provider_id=$11 RETURNING *`,
        [name, title, phone || null, email || null, photo_url || null, region_id || null, parent_id || null, userId, sort_order || 0, req.params.id, prov?.id]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.delete('/api/company/org/:id', auth, requirePermission('company.manage_org'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      await globalPool.query(
        `UPDATE company_org_chart SET is_active=false WHERE id=$1 AND provider_id=$2`,
        [req.params.id, prov?.id]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // ESTADÍSTICAS DE CONSUMO
  // ════════════════════════════════════════════════════════════════

  app.get('/api/company/stats', auth, async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.json([]);
      const r = await globalPool.query(
        `SELECT cs.*, cr.name as region_name
         FROM company_stats cs
         LEFT JOIN company_regions cr ON cr.id = cs.region_id
         WHERE cs.provider_id = $1 ORDER BY cr.name, cs.stat_type`,
        [prov.id]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/company/stats', auth, requirePermission('company.edit_stats'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.status(403).json({ message: 'Sin proveedor' });
      const { region_id, stat_type, stat_label, stat_value, unit, period } = req.body;
      const r = await globalPool.query(
        `INSERT INTO company_stats (provider_id, region_id, stat_type, stat_label, stat_value, unit, period, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING RETURNING *`,
        [prov.id, region_id || null, stat_type, stat_label, stat_value || 0, unit || '', period || null, req.user.id]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.put('/api/company/stats/:id', auth, requirePermission('company.edit_stats'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      const { stat_value, stat_label, unit, period } = req.body;
      const r = await globalPool.query(
        `UPDATE company_stats SET stat_value=$1,stat_label=$2,unit=$3,period=$4,updated_at=NOW()
         WHERE id=$5 AND provider_id=$6 RETURNING *`,
        [stat_value, stat_label, unit || '', period || null, req.params.id, prov?.id]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // EMPLEADOS INTERNOS
  // ════════════════════════════════════════════════════════════════

  app.get('/api/company/staff', auth, async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.json([]);
      const r = await globalPool.query(
        `SELECT cs.*, u.full_name, u.phone, u.avatar_url, cr.name as region_name
         FROM company_staff cs
         JOIN users u ON u.id = cs.user_id
         LEFT JOIN company_regions cr ON cr.id = cs.region_id
         WHERE cs.provider_id = $1 AND cs.is_active = true`,
        [prov.id]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/company/staff', auth, requirePermission('company.manage_staff'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.status(403).json({ message: 'Sin proveedor' });
      const { phone, role_title, region_id } = req.body;
      // Buscar usuario por teléfono
      const u = await globalPool.query(`SELECT id, full_name FROM users WHERE phone = $1 LIMIT 1`, [phone]);
      if (!u.rows[0]) return res.status(404).json({ message: 'Usuario no encontrado en EgChat con ese teléfono' });
      const r = await globalPool.query(
        `INSERT INTO company_staff (provider_id, user_id, role_title, region_id, added_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (provider_id, user_id) DO UPDATE SET is_active=true, role_title=$3, region_id=$4
         RETURNING *`,
        [prov.id, u.rows[0].id, role_title || 'Empleado', region_id || null, req.user.id]
      );
      res.status(201).json({ ...r.rows[0], full_name: u.rows[0].full_name });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.delete('/api/company/staff/:userId', auth, requirePermission('company.manage_staff'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      await globalPool.query(
        `UPDATE company_staff SET is_active=false WHERE user_id=$1 AND provider_id=$2`,
        [req.params.userId, prov?.id]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // COMUNICADOS PÚBLICOS
  // ════════════════════════════════════════════════════════════════

  // Endpoint genérico público: comunicados de todos los proveedores de electricidad
  // usado en el FacturasModal del usuario para ver avisos de SEGESA, cortes, etc.
  app.get('/api/company/public-announcements', async (req, res) => {
    try {
      const { category, provider_key } = req.query;
      let whereExtra = '';
      const params = [true];
      if (provider_key) {
        params.push(provider_key);
        whereExtra += ` AND sp.provider_key = $${params.length}`;
      }
      // Si se pide por categoría (puede ser lista separada por comas)
      if (category) {
        const cats = String(category).split(',').map(c => c.trim()).filter(Boolean);
        params.push(cats);
        whereExtra += ` AND ca.category = ANY($${params.length})`;
      }
      const r = await globalPool.query(
        `SELECT ca.id, ca.title, ca.body, ca.category, ca.published_at, ca.cover_url, ca.region_id,
                sp.name as provider_name, sp.provider_key, sp.color as provider_color,
                cr.name as region_name
         FROM company_announcements ca
         JOIN service_providers sp ON sp.id = ca.provider_id
         LEFT JOIN company_regions cr ON cr.id = ca.region_id
         WHERE ca.is_published = $1
           AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
           ${whereExtra}
         ORDER BY ca.published_at DESC LIMIT 20`,
        params
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // Públicos por proveedor específico
  app.get('/api/company/:providerKey/announcements', async (req, res) => {
    try {
      const r = await globalPool.query(
        `SELECT ca.*, cr.name as region_name, u.full_name as author_name
         FROM company_announcements ca
         JOIN service_providers sp ON sp.id = ca.provider_id
         LEFT JOIN company_regions cr ON cr.id = ca.region_id
         LEFT JOIN users u ON u.id = ca.author_id
         WHERE sp.provider_key = $1 AND ca.is_published = true
           AND (ca.expires_at IS NULL OR ca.expires_at > NOW())
         ORDER BY ca.published_at DESC LIMIT 50`,
        [req.params.providerKey]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // Internos: el admin de la empresa gestiona sus comunicados
  app.get('/api/company/announcements', auth, async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.json([]);
      const r = await globalPool.query(
        `SELECT ca.*, cr.name as region_name
         FROM company_announcements ca
         LEFT JOIN company_regions cr ON cr.id = ca.region_id
         WHERE ca.provider_id = $1 ORDER BY ca.created_at DESC LIMIT 100`,
        [prov.id]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.post('/api/company/announcements', auth, requirePermission('company.publish_announcement'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      if (!prov) return res.status(403).json({ message: 'Sin proveedor' });
      const { title, body, category, region_id, cover_url, expires_at } = req.body;
      const r = await globalPool.query(
        `INSERT INTO company_announcements (provider_id, author_id, title, body, category, region_id, cover_url, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [prov.id, req.user.id, title, body, category || 'general', region_id || null, cover_url || null, expires_at || null]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  // Publicar / despublicar
  app.put('/api/company/announcements/:id/publish', auth, requirePermission('company.publish_announcement'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      const { publish } = req.body;
      const r = await globalPool.query(
        `UPDATE company_announcements
         SET is_published=$1, published_at=$2, updated_at=NOW()
         WHERE id=$3 AND provider_id=$4 RETURNING *`,
        [!!publish, publish ? new Date() : null, req.params.id, prov?.id]
      );
      const ann = r.rows[0];
      // Si se publica, notificar por SSE a todos los usuarios
      if (publish && ann) {
        try {
          const emit = req.app.get('emitToUsers');
          // Obtener todos los usuarios activos (simplificado: emit en broadcast)
          if (emit) {
            const usersRes = await globalPool.query(`SELECT id FROM users LIMIT 1000`);
            const userIds = usersRes.rows.map(u => u.id);
            emit(userIds, {
              type: 'company_announcement',
              provider_key: prov?.provider_key,
              provider_name: prov?.name,
              announcement: ann,
            });
          }
        } catch {}
      }
      res.json(ann);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.put('/api/company/announcements/:id', auth, requirePermission('company.publish_announcement'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      const { title, body, category, region_id, cover_url, expires_at } = req.body;
      const r = await globalPool.query(
        `UPDATE company_announcements SET title=$1,body=$2,category=$3,region_id=$4,cover_url=$5,expires_at=$6,updated_at=NOW()
         WHERE id=$7 AND provider_id=$8 RETURNING *`,
        [title, body, category, region_id || null, cover_url || null, expires_at || null, req.params.id, prov?.id]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

  app.delete('/api/company/announcements/:id', auth, requirePermission('company.publish_announcement'), async (req, res) => {
    try {
      const prov = await getMyProvider(req.user.id);
      await globalPool.query(`DELETE FROM company_announcements WHERE id=$1 AND provider_id=$2`, [req.params.id, prov?.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
  });

};
