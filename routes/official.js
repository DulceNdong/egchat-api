/**
 * routes/official.js
 * Endpoints para cuentas oficiales: broadcast y stats
 */

const { requirePermission } = require('../middleware/roles');

module.exports = (app, auth, globalPool) => {

  // ── GET /api/official/stats ───────────────────────────────────────
  app.get('/api/official/stats', auth, requirePermission('business.view_stats'), async (req, res) => {
    try {
      const pool = globalPool;
      const userId = req.user.id;

      const [contactsRes, messagesRes, chatsRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM contacts WHERE user_id = $1`, [userId]),
        pool.query(`SELECT COUNT(*) FROM messages WHERE sender_id = $1`, [userId]),
        pool.query(`SELECT COUNT(DISTINCT chat_id) FROM chat_participants WHERE user_id = $1`, [userId]),
      ]);

      // Broadcasts enviados (mensajes marcados como broadcast)
      const broadcastRes = await pool.query(
        `SELECT COUNT(*) FROM messages WHERE sender_id = $1 AND metadata->>'type' = 'broadcast'`,
        [userId]
      ).catch(() => ({ rows: [{ count: 0 }] }));

      res.json({
        contacts:      parseInt(contactsRes.rows[0]?.count || 0),
        messages_sent: parseInt(messagesRes.rows[0]?.count || 0),
        active_chats:  parseInt(chatsRes.rows[0]?.count || 0),
        broadcasts:    parseInt(broadcastRes.rows[0]?.count || 0),
      });
    } catch (e) {
      console.error('GET /api/official/stats:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/official/broadcast ─────────────────────────────────
  app.post('/api/official/broadcast', auth, requirePermission('chat.broadcast'), async (req, res) => {
    try {
      const pool = globalPool;
      const { text, targetType = 'all_contacts' } = req.body;
      if (!text?.trim()) return res.status(400).json({ message: 'Texto requerido' });
      if (text.length > 500) return res.status(400).json({ message: 'Máximo 500 caracteres' });

      const userId = req.user.id;

      // Obtener contactos destino
      let contactsRes;
      if (targetType === 'all_contacts') {
        contactsRes = await pool.query(
          `SELECT DISTINCT c.contact_user_id
           FROM contacts c
           WHERE c.user_id = $1 AND c.contact_user_id IS NOT NULL`,
          [userId]
        );
      } else {
        contactsRes = { rows: [] };
      }

      const targetUserIds = contactsRes.rows.map(r => r.contact_user_id);
      if (targetUserIds.length === 0) {
        return res.json({ sent: 0, message: 'No hay contactos destino' });
      }

      // Rate limit: máximo 1 broadcast cada 30 minutos
      const lastBroadcast = await pool.query(
        `SELECT created_at FROM messages
         WHERE sender_id = $1 AND metadata->>'type' = 'broadcast'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      ).catch(() => ({ rows: [] }));

      if (lastBroadcast.rows.length > 0) {
        const lastTime = new Date(lastBroadcast.rows[0].created_at).getTime();
        if (Date.now() - lastTime < 30 * 60 * 1000) {
          return res.status(429).json({ message: 'Solo puedes enviar un broadcast cada 30 minutos' });
        }
      }

      let sent = 0;
      const errors = [];

      // Enviar mensaje a cada contacto
      for (const targetId of targetUserIds) {
        try {
          // Buscar o crear chat privado
          const existingChat = await pool.query(
            `SELECT cp1.chat_id FROM chat_participants cp1
             JOIN chat_participants cp2 ON cp1.chat_id = cp2.chat_id
             JOIN chats c ON c.id = cp1.chat_id
             WHERE cp1.user_id = $1 AND cp2.user_id = $2 AND c.type = 'private'
             LIMIT 1`,
            [userId, targetId]
          );

          let chatId;
          if (existingChat.rows.length > 0) {
            chatId = existingChat.rows[0].chat_id;
          } else {
            const newChat = await pool.query(
              `INSERT INTO chats (type, created_by, created_at, updated_at)
               VALUES ('private', $1, NOW(), NOW()) RETURNING id`,
              [userId]
            );
            chatId = newChat.rows[0].id;
            await pool.query(
              `INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
              [chatId, userId, targetId]
            );
          }

          // Insertar mensaje con metadata broadcast
          await pool.query(
            `INSERT INTO messages (chat_id, sender_id, text, type, status, metadata, created_at)
             VALUES ($1, $2, $3, 'text', 'sent', '{"type":"broadcast"}', NOW())`,
            [chatId, userId, text.trim()]
          );

          await pool.query(`UPDATE chats SET updated_at = NOW() WHERE id = $1`, [chatId]);
          sent++;
        } catch (err) {
          errors.push({ targetId, error: err.message });
        }
      }

      res.json({ sent, total: targetUserIds.length, errors: errors.length > 0 ? errors.slice(0, 5) : undefined });
    } catch (e) {
      console.error('POST /api/official/broadcast:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

};
