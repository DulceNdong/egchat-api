module.exports = (app, supabase, adminResetKey, APP_VERSION, resetTable) => {
  const getProvidedAdminKey = (req) => {
    const headerKey = req.headers['x-admin-key'];
    const bodyKey = req.body?.adminKey;
    return typeof headerKey === 'string' ? headerKey : bodyKey;
  };

  const requireAdmin = (req, res) => {
    const providedKey = getProvidedAdminKey(req);
    if (!providedKey || providedKey !== adminResetKey) {
      res.status(403).json({ message: 'No autorizado' });
      return false;
    }
    return true;
  };

  app.post('/api/admin/reset-all', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const tablesToReset = [
      ['message_reads', 'read_at'],
      ['messages', 'created_at'],
      ['chat_participants', 'joined_at'],
      ['chats', 'created_at'],
      ['contacts', 'created_at'],
      ['transactions', 'created_at'],
      ['recharge_codes', 'created_at'],
      ['user_news_favorites', 'created_at'],
      ['insurance_claims', 'created_at'],
      ['insurance_policies', 'created_at'],
      ['lia_conversations', 'created_at'],
      ['wallets', 'created_at'],
      ['notifications', 'created_at'],
      ['users', 'created_at']
    ];

    const results = [];
    for (const [table, column] of tablesToReset) {
      const result = await resetTable(table, column);
      results.push(result);
      if (!result.ok) {
        return res.status(500).json({
          message: 'Reset incompleto',
          failed: [result],
          ok_tables: results.filter((r) => r.ok).map((r) => r.table)
        });
      }
    }

    const ok = results.filter((r) => r.ok).map((r) => r.table);
    return res.json({
      message: 'Reset ejecutado',
      ok_tables: ok,
      failed: []
    });
  });

  app.post('/api/admin/users/update-version', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const version = typeof req.body?.version === 'string' ? req.body.version : APP_VERSION;
    try {
      const { error } = await supabase.from('users').update({ app_version: version });
      if (error) {
        console.warn('Update user versions failed:', error.message);
        const isMissingColumn = /column \"app_version\".*does not exist/i.test(error.message || '');
        return res.status(500).json({
          message: 'No se pudo actualizar la versión de usuarios',
          detail: error.message,
          hint: isMissingColumn ? 'La columna app_version no existe en la tabla users. Agrega la columna a la base de datos antes de volver a ejecutar.' : undefined
        });
      }
      return res.json({ message: 'Versiones de usuarios actualizadas', version });
    } catch (e) {
      return res.status(500).json({ message: 'Error interno', detail: e.message });
    }
  });
};
