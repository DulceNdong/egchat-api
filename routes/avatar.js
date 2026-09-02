// routes/avatar.js — Upload de avatar via Supabase Storage
module.exports = function mountAvatar(app, auth, supabase) {
  app.post('/api/user/avatar', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      // Opción 1: URL directa (p.ej. ya subida externamente)
      if (req.body && req.body.avatar_url) {
        const { error } = await supabase.from('users').update({ avatar_url: req.body.avatar_url }).eq('id', userId);
        if (error) throw error;
        return res.json({ avatar_url: req.body.avatar_url });
      }
      // Opción 2: base64 en JSON body
      const rawBody = req.body || {};
      const base64 = rawBody.avatar_base64 || rawBody.file || rawBody.data;
      if (base64) {
        const clean = String(base64).replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(clean, 'base64');
        const fileName = `avatar_${userId}_${Date.now()}.jpg`;
        const { error: upErr } = await supabase.storage.from('avatars')
          .upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });
        if (!upErr) {
          const { data: pub } = supabase.storage.from('avatars').getPublicUrl(fileName);
          const publicUrl = pub.publicUrl;
          await supabase.from('users').update({ avatar_url: publicUrl }).eq('id', userId);
          return res.json({ avatar_url: publicUrl });
        }
      }
      // Fallback: responder OK sin URL (el cliente usará el URI local)
      res.json({ avatar_url: null, message: 'Usa PUT /api/auth/profile con avatar_url para actualizar' });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });
};