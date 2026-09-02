/**
 * routes/wallet_extended.js
 * Extensiones del wallet: balance con stats mensuales, historial Neon
 */

const { requirePermission } = require('../middleware/roles');

module.exports = (app, auth, globalPool, supabase) => {

  // ── GET /api/wallet/balance/full — balance + stats mensuales ─────
  app.get('/api/wallet/balance/full', auth, requirePermission('wallet.view'), async (req, res) => {
    try {
      const pool = globalPool;
      const userId = req.user.id;

      // Balance desde Supabase (sistema existente)
      const { data: wallet } = await supabase
        .from('wallets').select('balance, currency').eq('user_id', userId).single();

      // Transacciones del mes actual desde Neon (si existe la tabla)
      let monthly_transactions = 0;
      let monthly_volume = 0;

      try {
        const txRes = await pool.query(
          `SELECT COUNT(*) as count, COALESCE(SUM(ABS(amount)),0) as volume
           FROM wallet_transactions
           WHERE user_id = $1
             AND created_at >= date_trunc('month', NOW())`,
          [userId]
        );
        monthly_transactions = parseInt(txRes.rows[0]?.count || 0);
        monthly_volume = parseFloat(txRes.rows[0]?.volume || 0);
      } catch {}

      res.json({
        balance: wallet?.balance || 0,
        currency: wallet?.currency || 'XAF',
        monthly_transactions,
        monthly_volume,
      });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/wallet/transactions/history — historial extendido ────
  app.get('/api/wallet/transactions/history', auth, requirePermission('wallet.view'), async (req, res) => {
    try {
      const pool = globalPool;
      const { page = 1, limit = 20, type } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = `
        SELECT id, type, amount, description, status, metadata, created_at
        FROM wallet_transactions
        WHERE user_id = $1
      `;
      const params: any[] = [req.user.id];

      if (type) {
        params.push(type);
        query += ` AND type = $${params.length}`;
      }

      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit), offset);

      const result = await pool.query(query, params).catch(() => ({ rows: [] }));
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/wallet/transfer/p2p — transferencia entre usuarios ──
  app.post('/api/wallet/transfer/p2p', auth, requirePermission('wallet.transfer'), async (req, res) => {
    try {
      const pool = globalPool;
      const { recipient_phone, amount, description } = req.body;

      if (!recipient_phone || !amount || amount <= 0) {
        return res.status(400).json({ message: 'Teléfono y monto requeridos' });
      }
      if (amount > 1000000) return res.status(400).json({ message: 'Monto máximo: 1,000,000 XAF' });

      // Verificar saldo del remitente
      const { data: senderWallet } = await supabase
        .from('wallets').select('balance').eq('user_id', req.user.id).single();
      if (!senderWallet || senderWallet.balance < amount) {
        return res.status(400).json({ message: 'Saldo insuficiente' });
      }

      // Buscar destinatario
      const { data: recipient } = await supabase
        .from('users').select('id, full_name').eq('phone', recipient_phone).single();
      if (!recipient) return res.status(404).json({ message: 'Usuario no encontrado' });
      if (recipient.id === req.user.id) return res.status(400).json({ message: 'No puedes enviarte dinero a ti mismo' });

      // Ejecutar transferencia atómica
      const [debit, credit] = await Promise.all([
        supabase.from('wallets').update({ balance: senderWallet.balance - amount }).eq('user_id', req.user.id),
        supabase.from('wallets').select('balance').eq('user_id', recipient.id).single(),
      ]);

      const recipientBalance = credit.data?.balance || 0;
      await supabase.from('wallets').update({ balance: recipientBalance + amount }).eq('user_id', recipient.id);

      // Registrar transacción en Neon (si existe)
      await pool.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, status, metadata, created_at)
         VALUES ($1, 'transfer_out', $2, $3, 'completed', $4, NOW())`,
        [req.user.id, -amount, description || `Transferencia a ${recipient.full_name}`, JSON.stringify({ recipient_id: recipient.id })]
      ).catch(() => {});

      await pool.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, status, metadata, created_at)
         VALUES ($1, 'transfer_in', $2, $3, 'completed', $4, NOW())`,
        [recipient.id, amount, description || `Transferencia de usuario`, JSON.stringify({ sender_id: req.user.id })]
      ).catch(() => {});

      res.json({
        success: true,
        amount,
        recipient: recipient.full_name,
        new_balance: senderWallet.balance - amount,
      });
    } catch (e) {
      console.error('POST /api/wallet/transfer/p2p:', e.message);
      res.status(500).json({ message: e.message });
    }
  });

};
