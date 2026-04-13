// Cargar variables de entorno (solo en local, en Render vienen del dashboard)
try { 
  const dotenv = require('dotenv');
  dotenv.config();
} catch(e) {}
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'EGchat2025!xK9mP3nQ7rL2vW8tY4uJ6hF1bN5cA0dE_prod_secret';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set in environment, using fallback. Set it in Render dashboard for production.');
}
const APP_VERSION = '2.5.0';
const chatStreams = new Map();
const dependencyCache = { timestamp: 0, result: null };

// --- Supabase ---------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://egchat-app.vercel.app,http://localhost:5173,http://localhost:3001,http://localhost:3000,http://127.0.0.1:3001')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Permitir sin origin (Electron file://, apps móviles, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Permitir cualquier localhost en desarrollo
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
    return callback(new Error('CORS policy: origin not allowed'));
  }
};

app.use(cors(corsOptions));
app.use(express.json());

// --- Middleware auth --------------------------------------------------
const parseBearerToken = (header) => {
  if (typeof header !== 'string') return '';
  const match = header.match(/^\s*Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

const auth = (req, res, next) => {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) return res.status(401).json({ message: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
};

const authFromQuery = (req, res, next) => {
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const tokenFromHeader = parseBearerToken(req.headers.authorization);
  const token = tokenFromQuery || tokenFromHeader;
  if (!token) return res.status(401).json({ message: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
};

const emitToUser = (userId, payload) => {
  const key = String(userId);
  const streams = chatStreams.get(key);
  if (!streams || streams.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of streams) {
    try {
      res.write(data);
    } catch {}
  }
};

const emitToUsers = (userIds, payload) => {
  const uniq = Array.from(new Set((userIds || []).map((id) => String(id))));
  uniq.forEach((id) => emitToUser(id, payload));
};

const adminResetKey = process.env.ADMIN_RESET_KEY || JWT_SECRET;
const ADMIN_RESET_MARKER = '00000000-0000-0000-0000-000000000000';
const resetTable = async (table, column = 'id') => {
  try {
    const query = supabase.from(table).delete();
    const { error } = (column === 'id')
      ? await query.neq('id', ADMIN_RESET_MARKER)
      : await query.not(column, 'is', null);
    if (error) return { table, ok: false, error: error.message };
    return { table, ok: true };
  } catch (e) {
    return { table, ok: false, error: e.message || 'unknown error' };
  }
};

const checkTable = async (table) => {
  try {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (error) return { table, ok: false, error: error.message };
    return { table, ok: true };
  } catch (e) {
    return { table, ok: false, error: e.message || 'unknown error' };
  }
};

// --- ADMIN ROUTES (inline) -------------------------------------------
app.post('/api/admin/reset-all', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== adminResetKey) return res.status(403).json({ message: 'No autorizado' });
  const results = [];
  results.push(await resetTable('message_reads', 'read_at'));
  results.push(await resetTable('messages', 'created_at'));
  results.push(await resetTable('chat_participants', 'joined_at'));
  results.push(await resetTable('chats', 'created_at'));
  results.push(await resetTable('contacts', 'created_at'));
  results.push(await resetTable('transactions', 'created_at'));
  results.push(await resetTable('recharge_codes', 'created_at'));
  results.push(await resetTable('user_news_favorites', 'created_at'));
  results.push(await resetTable('insurance_claims', 'created_at'));
  results.push(await resetTable('insurance_policies', 'created_at'));
  results.push(await resetTable('lia_conversations', 'created_at'));
  results.push(await resetTable('wallets', 'created_at'));
  results.push(await resetTable('notifications', 'created_at'));
  results.push(await resetTable('users', 'created_at'));
  return res.json({ message: 'Reset ejecutado', ok_tables: results.filter(r=>r.ok).map(r=>r.table), failed: results.filter(r=>!r.ok) });
});

app.post('/api/admin/users/update-version', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== adminResetKey) return res.status(403).json({ message: 'No autorizado' });
  const version = typeof req.body?.version === 'string' ? req.body.version : APP_VERSION;
  try {
    const { error } = await supabase.from('users').update({ app_version: version });
    if (error) return res.status(500).json({ message: 'No se pudo actualizar', detail: error.message });
    return res.json({ message: 'Versiones actualizadas', version });
  } catch (e) {
    return res.status(500).json({ message: 'Error interno', detail: e.message });
  }
});

// Reset contraseña por admin
app.post('/api/admin/reset-password', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== adminResetKey) return res.status(403).json({ message: 'No autorizado' });
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ message: 'phone y newPassword requeridos' });
  const hashed = await bcrypt.hash(newPassword, 10);
  const { data, error } = await supabase.from('users').update({ password_hash: hashed }).eq('phone', phone).select('id, phone, full_name').single();
  if (error || !data) return res.status(404).json({ message: 'Usuario no encontrado', error: error?.message });
  res.json({ message: 'Contrasena reseteada', user: data });
});

// --- ROOT -------------------------------------------------------------
app.get('/', (req, res) => res.json({
  message: 'EGCHAT API funcionando!',
  version: APP_VERSION,
  database: 'Supabase',
  status: 'active'
}));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/debug', (req, res) => res.json({
  supabase_url: process.env.SUPABASE_URL ? 'âœ… set' : 'âŒ missing',
  supabase_key: process.env.SUPABASE_SERVICE_KEY ? 'âœ… set' : 'âŒ missing',
  jwt_secret: process.env.JWT_SECRET ? 'âœ… set' : 'âŒ missing',
  node_env: process.env.NODE_ENV || 'not set',
  port: PORT
}));

app.get('/api/system/dependencies', async (_req, res) => {
  const now = Date.now();
  if (dependencyCache.result && now - dependencyCache.timestamp < 60000) {
    return res.json(dependencyCache.result);
  }

  const required = [
    'users',
    'wallets',
    'transactions',
    'recharge_codes',
    'contacts',
    'chats',
    'chat_participants',
    'messages',
    'message_reads',
    'lia_conversations',
    'ledger_accounts',
    'ledger_journals',
    'ledger_entries',
    'ledger_approvals',
    'taxi_rides',
    'service_orders',
    'cemac_transfers',
    'audit_logs'
  ];
  const checks = await Promise.all(required.map(checkTable));
  const missing = checks.filter((c) => !c.ok);
  const payload = {
    ok: missing.length === 0,
    required_tables: required.length,
    ready_tables: checks.filter((c) => c.ok).length,
    missing,
    hint: missing.length ? 'Ejecuta egchat-api/full_dependencies.sql en Supabase SQL Editor.' : 'Backend listo y sincronizado.'
  };

  dependencyCache.timestamp = now;
  dependencyCache.result = payload;
  res.json(payload);
});

// Stream SSE para mensajerÃ­a en tiempo real
app.get('/api/chat/stream', authFromQuery, (req, res) => {
  const userId = String(req.user.id);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!chatStreams.has(userId)) chatStreams.set(userId, new Set());
  chatStreams.get(userId).add(res);

  // Evento inicial
  res.write(`data: ${JSON.stringify({ type: 'connected', userId, ts: Date.now() })}\n\n`);

  // Keepalive para evitar timeout en proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
    } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const streams = chatStreams.get(userId);
    if (streams) {
      streams.delete(res);
      if (streams.size === 0) chatStreams.delete(userId);
    }
  });
});

// AUTH
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, full_name, avatar_url } = req.body;
    if (!phone || !password || !full_name)
      return res.status(400).json({ message: 'phone, password y full_name son requeridos' });

    const profileAvatar = avatar_url || null;

    // Verificar si ya existe
    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).maybeSingle();
    if (existing) return res.status(409).json({ message: 'El telÃ©fono ya estÃ¡ registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ phone, full_name, password_hash: hashed, avatar_url: profileAvatar })
      .select('id, phone, full_name, avatar_url')
      .single();

    if (error) throw error;

    // Crear wallet inicial
    await supabase.from('wallets').insert({ user_id: user.id, balance: 5000, currency: 'XAF' });

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { ...user, app_version: APP_VERSION } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ message: 'phone y password son requeridos' });

    const { data: user, error } = await supabase
      .from('users').select('*').eq('phone', phone).maybeSingle();

    if (error || !user) return res.status(401).json({ message: 'Credenciales incorrectas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Credenciales incorrectas' });

    // Actualizar Ãºltimo acceso
    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url, app_version: user.app_version || APP_VERSION } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, avatar_url, created_at').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
  res.json({ ...user, app_version: APP_VERSION });
});

app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { full_name, avatar_url } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .update({ full_name, avatar_url })
      .eq('id', req.user.id)
      .select('id, phone, full_name, avatar_url')
      .single();
    if (error) throw error;
    res.json(user);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/logout', auth, (req, res) => res.json({ message: 'SesiÃ³n cerrada' }));

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// CONTACTOS
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// ========================================================================
// CHAT / MENSAJERÃA COMPLETA
// ========================================================================

// Obtener todos los chats del usuario
app.get('/api/chats', auth, async (req, res) => {
  try {
    // Buscar chats donde el usuario es participante
    const { data: participations, error: pErr } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', req.user.id);

    if (pErr) {
      // Si la tabla no existe, devolver array vacÃ­o
      return res.json([]);
    }

    if (!participations || participations.length === 0) return res.json([]);

    const chatIds = participations.map(p => p.chat_id);

    const { data: chats } = await supabase
      .from('chats')
      .select('*')
      .in('id', chatIds)
      .order('updated_at', { ascending: false });

    if (!chats) return res.json([]);

    const [{ data: participants }, { data: messages }] = await Promise.all([
      supabase.from('chat_participants')
        .select('chat_id, user_id, users(id, phone, full_name)')
        .in('chat_id', chatIds),
      supabase.from('messages')
        .select('id, text, type, created_at, sender_id, chat_id')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false })
    ]);

    const participantsByChat = (participants || []).reduce((acc, part) => {
      const chatId = part.chat_id;
      if (!acc[chatId]) acc[chatId] = [];
      acc[chatId].push(part);
      return acc;
    }, {});

    const lastMessageByChat = (messages || []).reduce((acc, message) => {
      if (!acc[message.chat_id]) acc[message.chat_id] = message;
      return acc;
    }, {});

    const result = chats.map(chat => ({
      id: chat.id,
      type: chat.type || 'private',
      name: chat.name,
      participants: participantsByChat[chat.id] || [],
      last_message: lastMessageByChat[chat.id] || null,
      updated_at: chat.updated_at,
      unread_count: 0
    }));

    res.json(result);
  } catch (e) {
    console.error('Get chats error:', e.message);
    res.json([]); // Devolver vacÃ­o en vez de 500
  }
});

// Obtener mensajes de un chat especÃƒÂ­fico
app.get('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const from = (page - 1) * limit;

    // Verificar que el usuario pertenece al chat
    const { data: part } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .single();

    if (!part) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { data: messages } = await supabase
      .from('messages')
      .select('id, text, type, created_at, sender_id, status, reply_to, file_url')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    res.json((messages || []).reverse());
  } catch (e) {
    console.error('Get messages error:', e.message);
    res.json([]);
  }
});
// Enviar mensaje
app.post('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text, type = 'text', reply_to, file_url } = req.body;
    if (!text && !file_url) return res.status(400).json({ message: 'Texto o archivo requerido' });

    // Verificar acceso
    const { data: part } = await supabase
      .from('chat_participants').select('chat_id').eq('chat_id', chatId).eq('user_id', req.user.id).single();
    if (!part) return res.status(403).json({ message: 'Sin acceso' });

    const { data: message, error } = await supabase
      .from('messages')
      .insert({ chat_id: chatId, sender_id: req.user.id, text: text || null, type, reply_to: reply_to || null, file_url: file_url || null, status: 'sent' })
      .select('id, text, type, created_at, sender_id, status')
      .single();

    if (error) throw error;

    await supabase.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', chatId);

    // Emitir evento en tiempo real a todos los participantes del chat
    try {
      const { data: parts } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('chat_id', chatId);
      const targetUsers = (parts || []).map((p) => p.user_id);
      emitToUsers(targetUsers, { type: 'new_message', chatId, message });
      emitToUsers(targetUsers, { type: 'chat_updated', chatId, ts: Date.now() });
    } catch {}

    res.status(201).json(message);
  } catch (e) {
    console.error('Send message error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// Crear chat privado
// Crear chat privado Ã¢â‚¬â€ usa chat_participants
app.post('/api/chats/private', auth, async (req, res) => {
  try {
    const { participant_id, phone } = req.body;
    let targetId = participant_id;

    if (!targetId && phone) {
      const { data: found, error: userError } = await supabase
        .from('users')
        .select('id, phone, full_name, avatar_url')
        .eq('phone', phone)
        .single();

      if (userError || !found) {
        return res.status(404).json({ message: 'Usuario no encontrado con ese nÃºmero' });
      }

      targetId = found.id;
    }

    if (!targetId) {
      return res.status(400).json({ message: 'participant_id o phone es requerido' });
    }

    if (targetId === req.user.id) {
      return res.status(400).json({ message: 'No puedes crear un chat contigo mismo' });
    }

    const { data: myChats } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', req.user.id);

    const { data: theirChats } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', targetId);

    const myIds = (myChats || []).map((c) => c.chat_id);
    const theirIds = (theirChats || []).map((c) => c.chat_id);
    const common = myIds.filter((id) => theirIds.includes(id));

    if (common.length > 0) {
      const { data: existing } = await supabase
        .from('chats')
        .select('*')
        .in('id', common)
        .eq('type', 'private')
        .limit(1)
        .single();

      if (existing) {
        return res.json(existing);
      }
    }

    const { data: targetUser, error: userError } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .eq('id', targetId)
      .single();

    if (userError || !targetUser) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const { data: chat, error: createError } = await supabase
      .from('chats')
      .insert({
        type: 'private',
        created_by: req.user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) throw createError;

    await supabase.from('chat_participants').insert([
      { chat_id: chat.id, user_id: req.user.id },
      { chat_id: chat.id, user_id: targetId }
    ]);

    const formattedChat = {
      ...chat,
      participants: [
        { user_id: req.user.id },
        { user_id: targetId, ...targetUser }
      ],
      last_message: null,
      unread_count: 0
    };

    res.status(201).json(formattedChat);
  } catch (e) {
    console.error('Create private chat error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// Crear chat grupal
app.post('/api/chats/group', auth, async (req, res) => {
  try {
    const { name, participant_ids, avatar_url } = req.body;

    if (!name || !participant_ids || participant_ids.length === 0) {
      return res.status(400).json({ message: 'El nombre y los participantes son requeridos' });
    }

    if (!participant_ids.includes(req.user.id)) {
      participant_ids.push(req.user.id);
    }

    // Obtener informaciÃ³n de los participantes
    const { data: participants, error: userError } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .in('id', participant_ids);

    if (userError || !participants) {
      return res.status(404).json({ message: 'Algunos usuarios no fueron encontrados' });
    }

    // Crear chat grupal
    const { data: chat, error: createError } = await supabase
      .from('chats')
      .insert({
        type: 'group',
        name,
        avatar_url,
        participants: participants.map(p => ({ user_id: p.id })),
        created_by: req.user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) throw createError;

    // Formatear respuesta
    const formattedChat = {
      ...chat,
      participants: participants.map(p => ({ user_id: p.id, ...p })),
      last_message: null,
      unread_count: 0
    };

    res.status(201).json(formattedChat);
  } catch (e) {
    console.error('Create group chat error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Marcar mensajes como leÃ­dos
app.post('/api/chats/:chatId/read', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { message_id } = req.body;

    // Verificar acceso al chat
    const { data: part } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .single();

    if (!part) {
      return res.status(403).json({ message: 'No tienes acceso a este chat' });
    }

    // Marcar mensajes como leÃ­dos hasta el mensaje especificado
    const { error: updateError } = await supabase
      .from('message_reads')
      .upsert({
        chat_id: chatId,
        user_id: req.user.id,
        last_read_message_id: message_id,
        read_at: new Date().toISOString()
      }, {
        onConflict: 'chat_id,user_id'
      });

    if (updateError) throw updateError;

    // Resetear contador de no leÃƒÂ­dos
    await supabase
      .from('chat_participants')
      .update({ unread_count: 0 })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);

    res.json({ message: 'Mensajes marcados como leÃƒÂ­dos' });
  } catch (e) {
    console.error('Mark as read error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Subir archivo de chat
app.post('/api/chats/:chatId/upload', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    
    // Verificar acceso al chat
    const { data: part } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .single();

    if (!part) {
      return res.status(403).json({ message: 'No tienes acceso a este chat' });
    }

    // AquÃ­ irÃ­a la lÃ³gica de subida de archivos a un servicio como AWS S3
    // Por ahora, simulamos la subida
    const fileUrl = `https://storage.egchat-gq.com/chats/${chatId}/${Date.now()}.jpg`;
    
    res.json({
      file_url: fileUrl,
      file_type: 'image',
      file_size: 1024000, // 1MB
      thumbnail_url: `${fileUrl}?thumbnail=true`
    });
  } catch (e) {
    console.error('Upload file error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Eliminar mensaje
app.delete('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const { messageId } = req.params;

    // Verificar que el mensaje pertenece al usuario
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .select('id, sender_id, chat_id')
      .eq('id', messageId)
      .single();

    if (msgError || !message) {
      return res.status(404).json({ message: 'Mensaje no encontrado' });
    }

    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ message: 'No puedes eliminar mensajes de otros usuarios' });
    }

    // Eliminar mensaje
    const { error: deleteError } = await supabase
      .from('messages')
      .delete()
      .eq('id', messageId);

    if (deleteError) throw deleteError;

    res.json({ message: 'Mensaje eliminado exitosamente' });
  } catch (e) {
    console.error('Delete message error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// CONTACTOS - GESTIÃƒâ€œN COMPLETA
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

// Obtener todos los contactos del usuario
app.get('/api/contacts', auth, async (req, res) => {
  try {
    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!contacts || contacts.length === 0) return res.json([]);

    // Obtener datos de usuarios por separado
    const userIds = contacts.map(c => c.contact_user_id).filter(Boolean);
    const { data: users } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .in('id', userIds);

    const usersMap = (users || []).reduce((acc, u) => { acc[u.id] = u; return acc; }, {});

    const formattedContacts = contacts.map(contact => ({
      id: contact.id,
      contact_user_id: contact.contact_user_id,
      name: contact.nickname || usersMap[contact.contact_user_id]?.full_name || 'Sin nombre',
      phone: usersMap[contact.contact_user_id]?.phone || '',
      avatar_url: usersMap[contact.contact_user_id]?.avatar_url || '',
      is_blocked: contact.is_blocked,
      is_favorite: contact.is_favorite,
      created_at: contact.created_at,
      user: usersMap[contact.contact_user_id] || null
    }));

    res.json(formattedContacts);
  } catch (e) {
    console.error('Get contacts error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Agregar contacto
app.post('/api/contacts', auth, async (req, res) => {
  try {
    const { contact_user_id, nickname, phone } = req.body;
    let targetId = contact_user_id;

    if (!targetId && phone) {
      const { data: targetUser, error: userError } = await supabase
        .from('users')
        .select('id, phone, full_name')
        .eq('phone', phone)
        .single();

      if (userError || !targetUser) {
        return res.status(404).json({ message: 'Usuario no encontrado con ese nÃºmero' });
      }

      targetId = targetUser.id;
    }

    if (!targetId) {
      return res.status(400).json({ message: 'ID de contacto o telÃ©fono requerido' });
    }

    // Verificar que el usuario a agregar existe
    const { data: targetUser, error: userError } = await supabase
      .from('users')
      .select('id, phone, full_name')
      .eq('id', targetId)
      .single();

    if (userError || !targetUser) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    // Verificar que ya no sea contacto
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('contact_user_id', targetId)
      .single();

    if (existingContact) {
      return res.status(409).json({ message: 'El usuario ya es tu contacto' });
    }

    // Agregar contacto
    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({
        user_id: req.user.id,
        user_id_min: req.user.id < targetId ? req.user.id : targetId,
        user_id_max: req.user.id < targetId ? targetId : req.user.id,
        contact_user_id: targetId,
        nickname: nickname || targetUser.full_name
      })
      .select('*')
      .single();

    if (error) throw error;

    res.json({
      id: contact.id,
      contact_user_id: contact.contact_user_id,
      name: contact.nickname || targetUser.full_name,
      phone: targetUser.phone,
      avatar_url: targetUser.avatar_url || '',
      is_blocked: contact.is_blocked,
      is_favorite: contact.is_favorite,
      created_at: contact.created_at,
      user: targetUser
    });
  } catch (e) {
    console.error('Add contact error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Bloquear contacto
app.post('/api/contacts/:contactId/block', auth, async (req, res) => {
  try {
    const { contactId } = req.params;

    const { data: contact, error } = await supabase
      .from('contacts')
      .update({ is_blocked: true })
      .eq('id', contactId)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    if (!contact) {
      return res.status(404).json({ message: 'Contacto no encontrado' });
    }

    res.json({ message: 'Contacto bloqueado exitosamente', contact });
  } catch (e) {
    console.error('Block contact error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Desbloquear contacto
app.post('/api/contacts/:contactId/unblock', auth, async (req, res) => {
  try {
    const { contactId } = req.params;

    const { data: contact, error } = await supabase
      .from('contacts')
      .update({ is_blocked: false })
      .eq('id', contactId)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    if (!contact) {
      return res.status(404).json({ message: 'Contacto no encontrado' });
    }

    res.json({ message: 'Contacto desbloqueado exitosamente', contact });
  } catch (e) {
    console.error('Unblock contact error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Eliminar contacto
app.delete('/api/contacts/:contactId', auth, async (req, res) => {
  try {
    const { contactId } = req.params;

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', contactId)
      .eq('user_id', req.user.id);

    if (error) throw error;

    res.json({ message: 'Contacto eliminado exitosamente' });
  } catch (e) {
    console.error('Delete contact error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Marcar contacto como favorito
app.post('/api/contacts/:contactId/favorite', auth, async (req, res) => {
  try {
    const { contactId } = req.params;

    const { data: contact, error } = await supabase
      .from('contacts')
      .update({ is_favorite: true })
      .eq('id', contactId)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    if (!contact) {
      return res.status(404).json({ message: 'Contacto no encontrado' });
    }

    res.json({ message: 'Contacto marcado como favorito', contact });
  } catch (e) {
    console.error('Favorite contact error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Desmarcar contacto como favorito
app.delete('/api/contacts/:contactId/favorite', auth, async (req, res) => {
  try {
    const { contactId } = req.params;
    const { data: contact, error } = await supabase
      .from('contacts')
      .update({ is_favorite: false })
      .eq('id', contactId)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) throw error;
    if (!contact) return res.status(404).json({ message: 'Contacto no encontrado' });
    res.json({ message: 'Contacto desmarcado como favorito', contact });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Listar solo contactos favoritos
app.get('/api/contacts/favorites', auth, async (req, res) => {
  try {
    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_favorite', true);
    if (error) throw error;
    if (!contacts || contacts.length === 0) return res.json([]);

    const userIds = contacts.map(c => c.contact_user_id).filter(Boolean);
    const { data: users } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .in('id', userIds);
    const usersMap = (users || []).reduce((acc, u) => { acc[u.id] = u; return acc; }, {});

    res.json(contacts.map(c => ({
      id: c.id,
      name: c.nickname || usersMap[c.contact_user_id]?.full_name || 'Sin nombre',
      phone: usersMap[c.contact_user_id]?.phone || '',
      avatar_url: usersMap[c.contact_user_id]?.avatar_url || '',
      is_favorite: true,
      contact_user_id: c.contact_user_id,
      user: usersMap[c.contact_user_id] || null
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Obtener contactos para chat
app.get('/api/contacts/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ message: 'La bÃƒÂºsqueda debe tener al menos 2 caracteres' });
    }

    // Buscar usuarios por telÃ©fono o nombre
    const { data: users, error } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url, last_seen')
      .or(`phone.ilike.%${q}%,full_name.ilike.%${q}%`)
      .neq('id', req.user.id)
      .limit(20);

    if (error) throw error;

    res.json(users);
  } catch (e) {
    console.error('Search contacts error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// WALLET
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
app.get('/api/wallet/balance', auth, async (req, res) => {
  let { data: wallet } = await supabase
    .from('wallets').select('balance, currency').eq('user_id', req.user.id).single();
  if (!wallet) {
    const { data } = await supabase
      .from('wallets').insert({ user_id: req.user.id, balance: 5000, currency: 'XAF' }).select().single();
    wallet = data;
  }
  res.json({ balance: wallet.balance, currency: wallet.currency || 'XAF' });
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const from = (page - 1) * limit;

  const { data: transactions, count } = await supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);

  res.json({ transactions: transactions || [], total: count || 0 });
});

app.post('/api/wallet/deposit', auth, async (req, res) => {
  const { amount, method, reference } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe invÃƒÂ¡lido' });

  const { data: wallet } = await supabase
    .from('wallets').select('balance').eq('user_id', req.user.id).single();
  const newBalance = (wallet?.balance || 0) + amount;

  await supabase.from('wallets').upsert({ user_id: req.user.id, balance: newBalance, currency: 'XAF' });

  const { data: tx } = await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'deposit', amount, method,
    reference, status: 'completed'
  }).select().single();

  res.json({ balance: newBalance, transaction: tx });
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const { amount, method, destination } = req.body;
  const { data: wallet } = await supabase
    .from('wallets').select('balance').eq('user_id', req.user.id).single();

  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe invÃƒÂ¡lido' });
  if (!wallet || amount > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });

  const newBalance = wallet.balance - amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

  const { data: tx } = await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'withdraw', amount, method,
    reference: destination, status: 'completed'
  }).select().single();

  res.json({ balance: newBalance, transaction: tx });
});

app.post('/api/wallet/transfer', auth, async (req, res) => {
  const { to, amount, concept } = req.body;
  const { data: wallet } = await supabase
    .from('wallets').select('balance').eq('user_id', req.user.id).single();

  if (amount > (wallet?.balance || 0)) return res.status(400).json({ message: 'Saldo insuficiente' });

  const newBalance = wallet.balance - amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

  const { data: tx } = await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'transfer_sent', amount, method: 'EGCHAT',
    reference: `A: ${to} Ã‚Â· ${concept || ''}`, status: 'completed'
  }).select().single();

  res.json({ balance: newBalance, transaction: tx });
});

app.post('/api/wallet/recharge-code', auth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.replace(/-/g, '').length !== 16)
    return res.status(400).json({ message: 'CÃƒÂ³digo invÃƒÂ¡lido' });

  // Verificar si el cÃƒÂ³digo ya fue usado
  const { data: usedCode } = await supabase
    .from('recharge_codes').select('*').eq('code', code).single();

  if (!usedCode) return res.status(400).json({ message: 'CÃƒÂ³digo no vÃƒÂ¡lido' });
  if (usedCode.used || usedCode.is_used) return res.status(400).json({ message: 'CÃƒÂ³digo ya utilizado' });
  if (usedCode.expires_at && new Date(usedCode.expires_at) < new Date())
    return res.status(400).json({ message: 'CÃƒÂ³digo expirado' });

  const amount = usedCode?.amount || 5000;

  // Marcar como usado
  if (usedCode) {
    await supabase.from('recharge_codes').update({ used: true, used_by: req.user.id, used_at: new Date().toISOString() }).eq('code', code);
  }

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const newBalance = (wallet?.balance || 0) + amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'deposit', amount, method: 'CÃƒÂ³digo de recarga',
    reference: code, status: 'completed'
  });

  res.json({ balance: newBalance, amount, message: `${amount.toLocaleString()} XAF aÃƒÂ±adidos` });
});

const WALLET_LIMITS = {
  dailyDeposit: 5000000,
  dailyWithdraw: 3000000,
  dailyTransfer: 3000000,
  perTxTransfer: 1000000
};

const startOfTodayIso = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const getWalletSafe = async (userId) => {
  let { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).maybeSingle();
  if (!wallet) {
    const { data } = await supabase
      .from('wallets')
      .insert({ user_id: userId, balance: 5000, currency: 'XAF' })
      .select()
      .single();
    wallet = data;
  }
  return wallet;
};

const sumTodayByType = async (userId) => {
  const { data } = await supabase
    .from('transactions')
    .select('type, amount')
    .eq('user_id', userId)
    .gte('created_at', startOfTodayIso())
    .in('type', ['deposit', 'withdraw', 'transfer']);

  const totals = { deposit: 0, withdraw: 0, transfer: 0 };
  (data || []).forEach((tx) => {
    const type = String(tx.type || '').toLowerCase();
    if (type in totals) {
      totals[type] += Number(tx.amount || 0);
    }
  });
  return totals;
};

app.get('/api/wallet/limits', auth, async (req, res) => {
  const today = await sumTodayByType(req.user.id);
  res.json({
    limits: WALLET_LIMITS,
    used_today: today,
    remaining_today: {
      deposit: Math.max(0, WALLET_LIMITS.dailyDeposit - today.deposit),
      withdraw: Math.max(0, WALLET_LIMITS.dailyWithdraw - today.withdraw),
      transfer: Math.max(0, WALLET_LIMITS.dailyTransfer - today.transfer)
    }
  });
});

app.get('/api/wallet/summary', auth, async (req, res) => {
  const wallet = await getWalletSafe(req.user.id);
  const { data: last10 } = await supabase
    .from('transactions')
    .select('id,type,amount,status,created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(10);
  const pendingHolds = (last10 || []).filter((t) => t.type === 'hold' && t.status === 'pending')
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  res.json({
    balance: Number(wallet?.balance || 0),
    currency: wallet?.currency || 'XAF',
    available_balance: Math.max(0, Number(wallet?.balance || 0) - pendingHolds),
    pending_holds: pendingHolds,
    recent: last10 || []
  });
});

app.post('/api/wallet/hold', auth, async (req, res) => {
  const amount = Number(req.body?.amount || 0);
  const reference = req.body?.reference || `HOLD-${Date.now()}`;
  if (amount <= 0) return res.status(400).json({ message: 'Importe invÃ¡lido' });
  const wallet = await getWalletSafe(req.user.id);
  if (amount > Number(wallet.balance || 0)) return res.status(400).json({ message: 'Saldo insuficiente' });
  const { data: tx } = await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'hold', amount, method: 'EGCHAT', reference, status: 'pending'
  }).select().single();
  res.status(201).json({ hold: tx, balance: Number(wallet.balance || 0) });
});

app.post('/api/wallet/hold/:id/capture', auth, async (req, res) => {
  const holdId = req.params.id;
  const { data: hold } = await supabase.from('transactions').select('*')
    .eq('id', holdId).eq('user_id', req.user.id).eq('type', 'hold').maybeSingle();
  if (!hold) return res.status(404).json({ message: 'RetenciÃ³n no encontrada' });
  if (hold.status !== 'pending') return res.status(400).json({ message: 'RetenciÃ³n ya procesada' });
  const wallet = await getWalletSafe(req.user.id);
  const amount = Number(hold.amount || 0);
  if (amount > Number(wallet.balance || 0)) return res.status(400).json({ message: 'Saldo insuficiente para captura' });
  const newBalance = Number(wallet.balance || 0) - amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
  await supabase.from('transactions').update({ status: 'captured' }).eq('id', holdId);
  const { data: tx } = await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'payment_capture', amount, method: 'EGCHAT',
    reference: `CAPTURE:${hold.reference || holdId}`, status: 'completed'
  }).select().single();
  res.json({ balance: newBalance, transaction: tx });
});

app.post('/api/wallet/hold/:id/cancel', auth, async (req, res) => {
  const holdId = req.params.id;
  const { data: hold } = await supabase.from('transactions').select('*')
    .eq('id', holdId).eq('user_id', req.user.id).eq('type', 'hold').maybeSingle();
  if (!hold) return res.status(404).json({ message: 'RetenciÃ³n no encontrada' });
  if (hold.status !== 'pending') return res.status(400).json({ message: 'RetenciÃ³n ya procesada' });
  await supabase.from('transactions').update({ status: 'cancelled' }).eq('id', holdId);
  res.json({ message: 'RetenciÃ³n cancelada' });
});

app.post('/api/wallet/reverse/:txId', auth, async (req, res) => {
  const txId = req.params.txId;
  const { data: tx } = await supabase.from('transactions').select('*')
    .eq('id', txId).eq('user_id', req.user.id).maybeSingle();
  if (!tx) return res.status(404).json({ message: 'TransacciÃ³n no encontrada' });
  if (tx.status === 'reversed') return res.status(400).json({ message: 'TransacciÃ³n ya revertida' });
  const reversible = ['withdraw', 'transfer_sent', 'payment', 'payment_capture'];
  if (!reversible.includes(tx.type)) return res.status(400).json({ message: 'Tipo no reversible' });
  const wallet = await getWalletSafe(req.user.id);
  const amount = Number(tx.amount || 0);
  const newBalance = Number(wallet.balance || 0) + amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
  await supabase.from('transactions').update({ status: 'reversed' }).eq('id', txId);
  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'reversal_credit', amount, method: 'EGCHAT',
    reference: `REV:${txId}`, status: 'completed'
  });
  res.json({ balance: newBalance, message: 'Reverso aplicado' });
});

const LEDGER_APPROVAL_THRESHOLD = Number(process.env.LEDGER_APPROVAL_THRESHOLD || 1000000);

const ensureSystemLedgerAccounts = async () => {
  const baseAccounts = [
    { code: 'SYS-CASH', name: 'Caja Operativa', account_type: 'asset' },
    { code: 'SYS-FEES', name: 'Ingresos por Comisiones', account_type: 'income' },
    { code: 'SYS-SUSPENSE', name: 'Cuenta Puente', account_type: 'liability' }
  ];
  for (const a of baseAccounts) {
    await supabase.from('ledger_accounts').upsert({
      code: a.code,
      name: a.name,
      account_type: a.account_type,
      currency: 'XAF',
      is_system: true,
      is_active: true
    }, { onConflict: 'code' });
  }
};

const makeAccountCode = (userId) => `USR-${String(userId).slice(0, 8)}-${Date.now()}`;

app.get('/api/wallet/ledger/config', auth, async (_req, res) => {
  res.json({
    approval_threshold: LEDGER_APPROVAL_THRESHOLD,
    currency: 'XAF',
    modes: ['draft', 'posted', 'pending_approval', 'rejected']
  });
});

app.get('/api/wallet/ledger/accounts', auth, async (req, res) => {
  await ensureSystemLedgerAccounts();
  const scope = String(req.query.scope || 'mine');
  let query = supabase.from('ledger_accounts').select('*').order('created_at', { ascending: false });
  if (scope === 'system') query = query.eq('is_system', true);
  else if (scope === 'all') query = query.or(`is_system.eq.true,user_id.eq.${req.user.id}`);
  else query = query.eq('user_id', req.user.id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ message: error.message });
  res.json(data || []);
});

app.post('/api/wallet/ledger/accounts', auth, async (req, res) => {
  const { name, account_type, currency } = req.body || {};
  if (!name || !account_type) return res.status(400).json({ message: 'name y account_type son requeridos' });
  const payload = {
    user_id: req.user.id,
    code: makeAccountCode(req.user.id),
    name: String(name).trim(),
    account_type: String(account_type).trim(),
    currency: String(currency || 'XAF'),
    is_system: false,
    is_active: true
  };
  const { data, error } = await supabase.from('ledger_accounts').insert(payload).select().single();
  if (error) return res.status(500).json({ message: error.message });
  res.status(201).json(data);
});

app.get('/api/wallet/ledger/journals', auth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const from = (page - 1) * limit;
  const { data, count, error } = await supabase
    .from('ledger_journals')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);
  if (error) return res.status(500).json({ message: error.message });
  res.json({ journals: data || [], total: count || 0 });
});

app.get('/api/wallet/ledger/journals/:id', auth, async (req, res) => {
  const id = req.params.id;
  const { data: journal, error } = await supabase
    .from('ledger_journals')
    .select('*')
    .eq('id', id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ message: error.message });
  if (!journal) return res.status(404).json({ message: 'Asiento no encontrado' });
  const { data: entries } = await supabase
    .from('ledger_entries')
    .select('*, ledger_accounts(code,name,account_type)')
    .eq('journal_id', id)
    .order('created_at', { ascending: true });
  const { data: approval } = await supabase
    .from('ledger_approvals')
    .select('*')
    .eq('journal_id', id)
    .maybeSingle();
  res.json({ journal, entries: entries || [], approval: approval || null });
});

app.post('/api/wallet/ledger/journals', auth, async (req, res) => {
  await ensureSystemLedgerAccounts();
  const { concept, reference, lines } = req.body || {};
  if (!concept || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ message: 'concept y al menos 2 lÃ­neas son requeridos' });
  }

  let debit = 0;
  let credit = 0;
  const normalized = [];
  for (const l of lines) {
    const amount = Number(l?.amount || 0);
    const entryType = String(l?.entry_type || '');
    const accountId = String(l?.account_id || '');
    if (!accountId || !['debit', 'credit'].includes(entryType) || amount <= 0) {
      return res.status(400).json({ message: 'LÃ­neas invÃ¡lidas: account_id, entry_type y amount son obligatorios' });
    }
    if (entryType === 'debit') debit += amount;
    else credit += amount;
    normalized.push({
      account_id: accountId,
      entry_type: entryType,
      amount,
      currency: String(l?.currency || 'XAF'),
      memo: l?.memo ? String(l.memo) : null,
      counterparty_user_id: l?.counterparty_user_id || null
    });
  }
  if (Math.abs(debit - credit) > 0.00001) {
    return res.status(400).json({ message: 'Asiento no balanceado: total debit debe igualar total credit' });
  }

  const totalAmount = debit;
  const requiresApproval = totalAmount >= LEDGER_APPROVAL_THRESHOLD;
  const status = requiresApproval ? 'pending_approval' : 'posted';

  const { data: journal, error: jErr } = await supabase.from('ledger_journals').insert({
    user_id: req.user.id,
    reference: reference || `JR-${Date.now()}`,
    concept,
    total_amount: totalAmount,
    status,
    requires_approval: requiresApproval,
    created_by: req.user.id
  }).select().single();
  if (jErr) return res.status(500).json({ message: jErr.message });

  const entriesPayload = normalized.map((e) => ({ ...e, journal_id: journal.id }));
  const { error: eErr } = await supabase.from('ledger_entries').insert(entriesPayload);
  if (eErr) return res.status(500).json({ message: eErr.message });

  if (requiresApproval) {
    await supabase.from('ledger_approvals').upsert({
      journal_id: journal.id,
      requested_by: req.user.id,
      status: 'pending'
    }, { onConflict: 'journal_id' });
  }

  res.status(201).json({
    journal_id: journal.id,
    status: journal.status,
    requires_approval: journal.requires_approval,
    total_amount: totalAmount
  });
});

app.post('/api/wallet/ledger/journals/:id/approve', auth, async (req, res) => {
  const id = req.params.id;
  const { reason } = req.body || {};
  const { data: journal } = await supabase
    .from('ledger_journals')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!journal) return res.status(404).json({ message: 'Asiento no encontrado' });
  if (journal.status !== 'pending_approval') return res.status(400).json({ message: 'El asiento no estÃ¡ pendiente de aprobaciÃ³n' });
  if (String(journal.created_by) === String(req.user.id)) {
    return res.status(403).json({ message: 'Maker-checker activo: el creador no puede aprobar su propio asiento' });
  }

  const approvedAt = new Date().toISOString();
  await supabase.from('ledger_journals').update({
    status: 'posted',
    approved_by: req.user.id,
    approved_at: approvedAt
  }).eq('id', id);

  await supabase.from('ledger_approvals').upsert({
    journal_id: id,
    requested_by: journal.created_by,
    approved_by: req.user.id,
    status: 'approved',
    reason: reason || null,
    updated_at: approvedAt
  }, { onConflict: 'journal_id' });

  res.json({ message: 'Asiento aprobado y contabilizado', journal_id: id, approved_at: approvedAt });
});

app.post('/api/wallet/ledger/journals/:id/reject', auth, async (req, res) => {
  const id = req.params.id;
  const { reason } = req.body || {};
  const { data: journal } = await supabase
    .from('ledger_journals')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!journal) return res.status(404).json({ message: 'Asiento no encontrado' });
  if (journal.status !== 'pending_approval') return res.status(400).json({ message: 'El asiento no estÃ¡ pendiente de aprobaciÃ³n' });
  if (String(journal.created_by) === String(req.user.id)) {
    return res.status(403).json({ message: 'Maker-checker activo: el creador no puede rechazar su propio asiento' });
  }

  const updatedAt = new Date().toISOString();
  await supabase.from('ledger_journals').update({ status: 'rejected' }).eq('id', id);
  await supabase.from('ledger_approvals').upsert({
    journal_id: id,
    requested_by: journal.created_by,
    approved_by: req.user.id,
    status: 'rejected',
    reason: reason || 'Rechazado por validador',
    updated_at: updatedAt
  }, { onConflict: 'journal_id' });

  res.json({ message: 'Asiento rechazado', journal_id: id });
});

const ensureUserCashAccount = async (userId) => {
  const code = `USR-CASH-${String(userId).slice(0, 8)}`;
  let { data: acc } = await supabase.from('ledger_accounts').select('*').eq('code', code).maybeSingle();
  if (!acc) {
    const { data } = await supabase.from('ledger_accounts').insert({
      user_id: userId,
      code,
      name: 'Caja Usuario EGCHAT',
      account_type: 'asset',
      currency: 'XAF',
      is_system: false,
      is_active: true
    }).select().single();
    acc = data;
  }
  return acc;
};

app.get('/api/cemac/rates', auth, async (_req, res) => {
  try {
    res.json({
      base: 'XAF',
      countries: ['GQ', 'CM', 'GA', 'CG', 'TD', 'CF'],
      transfer_fee_flat: 750,
      sandbox: true,
      max_amount: 1000000,
      min_amount: 1000
    });
  } catch (error) {
    console.error('CEMAC rates error:', error);
    res.status(500).json({ message: 'Error al obtener tasas', code: 'INTERNAL_ERROR' });
  }
});

const taxiFallbackStore = new Map();
const cemacFallbackStore = new Map();
const getUserStore = (store, userId) => {
  const key = String(userId);
  if (!store.has(key)) store.set(key, []);
  return store.get(key);
};

app.post('/api/cemac/transfers', auth, async (req, res) => {
  try {
    const { from_country, to_country, beneficiary_name, beneficiary_account, amount, external_id } = req.body || {};
    
    // ValidaciÃ³n robusta
    if (!from_country || !to_country || !beneficiary_name || !beneficiary_account || Number(amount || 0) <= 0) {
      return res.status(400).json({ message: 'Datos de transferencia invalidos', code: 'VALIDATION_ERROR' });
    }
    
    // Validar paÃ­ses CEMAC
    const validCountries = ['GQ', 'CM', 'GA', 'CG', 'TD', 'CF'];
    if (!validCountries.includes(from_country) || !validCountries.includes(to_country)) {
      return res.status(400).json({ message: 'Paises no soportados', code: 'INVALID_COUNTRY' });
    }
    
    // Verificar transferencia existente con fallback
    if (external_id) {
      try {
        const { data: existing } = await supabase.from('cemac_transfers').select('*').eq('transfer_ref', external_id).eq('user_id', req.user.id).maybeSingle();
        if (existing) return res.json({ transfer: existing, idempotent: true });
      } catch (checkError) {
        console.warn('Existing transfer check failed:', checkError.message);
      }
    }

    const fee = 750;
    const total = Number(amount) + fee;
    
    // Debitar wallet con fallback
    let deb = { ok: false, balance: 0, message: 'Error wallet' };
    try {
      deb = await debitWalletWithTx(req.user.id, total, 'EGCHAT', `CEMAC-${to_country}-${beneficiary_account}`, 'cemac_transfer');
    } catch (walletError) {
      console.warn('Wallet debit failed:', walletError.message);
    }
    
    if (!deb.ok) {
      return res.status(400).json({ message: deb.message || 'Saldo insuficiente', code: 'INSUFFICIENT_BALANCE' });
    }

    const transferRef = external_id || safeRef('CEMAC');
    let transfer = null;
    
    // Insert con manejo de columnas y fallback
    try {
      const insertData = {
        transfer_ref: transferRef,
        user_id: req.user.id,
        from_country,
        to_country,
        beneficiary_name,
        beneficiary_account,
        amount: Number(amount),
        fee,
        status: 'processing',
        metadata: { sandbox: true },
        created_by: req.user.id
      };
      
      const { data } = await supabase.from('cemac_transfers').insert(insertData).select().single();
      transfer = data;
    } catch (insertError) {
      console.warn('CEMAC transfer insert failed, using fallback:', insertError.message);
      
      // Fallback a memoria local
      const fallbackTransfer = {
        id: transferRef,
        transfer_ref: transferRef,
        user_id: req.user.id,
        from_country,
        to_country,
        beneficiary_name,
        beneficiary_account,
        amount: Number(amount),
        fee,
        status: 'processing',
        metadata: { sandbox: true },
        created_at: new Date().toISOString(),
        created_by: req.user.id
      };
      getUserStore(cemacFallbackStore, req.user.id).push(fallbackTransfer);
      transfer = fallbackTransfer;
    }

    // Ledger con fallback
    let journalId = null;
    try {
      await ensureSystemLedgerAccounts();
      const userCash = await ensureUserCashAccount(req.user.id);
      const { data: suspense } = await supabase.from('ledger_accounts').select('*').eq('code', 'SYS-SUSPENSE').single();
      
      if (suspense?.id && userCash?.id) {
        const { data: journal } = await supabase.from('ledger_journals').insert({
          user_id: req.user.id,
          reference: `CEMAC:${transferRef}`,
          concept: `Transferencia CEMAC ${from_country}->${to_country}`,
          total_amount: Number(amount),
          status: 'posted',
          requires_approval: false,
          created_by: req.user.id
        }).select().single();
        
        journalId = journal?.id || null;
        
        if (journalId) {
          try {
            await supabase.from('ledger_entries').insert([
              { journal_id: journal.id, account_id: suspense.id, entry_type: 'debit', amount: Number(amount), currency: 'XAF', memo: 'Salida CEMAC' },
              { journal_id: journal.id, account_id: userCash.id, entry_type: 'credit', amount: Number(amount), currency: 'XAF', memo: 'Debito usuario CEMAC' }
            ]);
          } catch (entriesError) {
            console.warn('Ledger entries failed:', entriesError.message);
          }
        }
      }
    } catch (ledgerError) {
      console.warn('Ledger creation failed:', ledgerError.message);
    }
    
    // Audit logging con fallback
    try {
      await logAudit(req.user.id, 'cemac_transfer_create', 'cemac', transfer?.id || transferRef, { transfer_ref: transferRef, amount: Number(amount), fee });
    } catch (auditError) {
      console.warn('Audit logging failed:', auditError.message);
    }

    res.status(201).json({ transfer, ledger_journal_id: journalId, balance: deb.balance });
  } catch (e) {
    console.error('CEMAC transfer error:', e);
    res.status(500).json({ message: e?.message || 'Error interno', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/cemac/transfers', auth, async (req, res) => {
  try {
    let transfers = [];
    
    // Intentar obtener de Supabase
    try {
      const { data } = await supabase.from('cemac_transfers')
        .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
      transfers = data || [];
    } catch (dbError) {
      console.warn('CEMAC transfers query failed, using fallback:', dbError.message);
    }
    
    // Combinar con fallback store
    const fallbackTransfers = getUserStore(cemacFallbackStore, req.user.id);
    const combined = [...transfers, ...fallbackTransfers];
    
    // Eliminar duplicados por transfer_ref y ordenar
    const uniqueTransfers = combined.filter((transfer, index, self) => 
      index === self.findIndex(t => t.transfer_ref === transfer.transfer_ref)
    );
    
    uniqueTransfers.sort((a, b) => 
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
    
    res.json(uniqueTransfers);
  } catch (e) {
    console.error('CEMAC transfers error:', e);
    res.status(500).json({ message: e?.message || 'Error interno', code: 'INTERNAL_ERROR' });
  }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// LIA-25
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
app.post('/api/lia/chat', auth, async (req, res) => {
  const { message } = req.body;
  const lower = message.toLowerCase();

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const balance = wallet?.balance || 0;

  let reply = '';
  if (lower.includes('saldo') || lower.includes('balance'))
    reply = `Tu saldo actual es **${balance.toLocaleString()} XAF**. Ã‚Â¿Deseas recargar o retirar?`;
  else if (lower.includes('hola') || lower.includes('buenos'))
    reply = 'Ã‚Â¡Hola! Soy Lia-25, tu asistente inteligente de EGCHAT. Ã‚Â¿En quÃƒÂ© puedo ayudarte hoy?';
  else if (lower.includes('taxi'))
    reply = 'Puedo ayudarte a pedir un taxi. Ve a la secciÃƒÂ³n MiTaxi desde el menÃƒÂº principal.';
  else if (lower.includes('salud') || lower.includes('hospital'))
    reply = 'En la secciÃƒÂ³n Salud encontrarÃƒÂ¡s hospitales, farmacias y puedes pedir citas mÃƒÂ©dicas.';
  else if (lower.includes('supermercado') || lower.includes('compra'))
    reply = 'Puedes hacer compras en lÃƒÂ­nea desde la secciÃƒÂ³n Supermercados. Tenemos tiendas en Malabo y Bata.';
  else if (lower.includes('transferir') || lower.includes('enviar dinero'))
    reply = 'Para enviar dinero, ve a Mi Monedero Ã¢â€ â€™ Enviar, o dime el nÃƒÂºmero y el importe.';
  else if (lower.includes('seguro'))
    reply = 'Puedes contratar seguros de salud, vehÃƒÂ­culo, vida y hogar en la secciÃƒÂ³n Seguros.';
  else if (lower.includes('noticias'))
    reply = 'Las ÃƒÂºltimas noticias de Guinea Ecuatorial y del mundo estÃƒÂ¡n en la secciÃƒÂ³n Noticias.';
  else if (lower.includes('gracias'))
    reply = 'Ã‚Â¡De nada! Estoy aquÃƒÂ­ para ayudarte. Ã‚Â¿Hay algo mÃƒÂ¡s?';
  else
    reply = `Entendido: "${message}". Puedo ayudarte con saldo, transferencias, taxi, salud, supermercados, seguros y noticias.`;

  // Guardar conversaciÃƒÂ³n en Supabase
  await supabase.from('lia_conversations').insert({
    user_id: req.user.id, message, reply
  }).catch(() => {});

  res.json({ reply, timestamp: new Date().toISOString() });
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// USER
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
app.get('/api/user/profile', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, created_at, last_login').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'No encontrado' });
  res.json({ ...user, app_version: APP_VERSION });
});

app.put('/api/user/profile', auth, async (req, res) => {
  const { full_name, avatar_url, city } = req.body;
  const updates = {};
  if (full_name) updates.full_name = full_name;
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;
  if (city) updates.city = city;
  const { data: user } = await supabase
    .from('users').update(updates).eq('id', req.user.id).select('id, phone, full_name, avatar_url').single();
  res.json({ ...user, app_version: APP_VERSION });
});

app.post('/api/user/change-password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if (!ok) return res.status(401).json({ message: 'Contraseña actual incorrecta' });
  const hashed = await bcrypt.hash(newPassword, 10);
  await supabase.from('users').update({ password_hash: hashed }).eq('id', req.user.id);
  res.json({ message: 'Contraseña actualizada' });
});

// Reset de contraseña por admin (protegido con ADMIN_RESET_KEY)
app.post('/api/admin/reset-password', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== adminResetKey) return res.status(403).json({ message: 'No autorizado' });
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ message: 'phone y newPassword requeridos' });
  const hashed = await bcrypt.hash(newPassword, 10);
  const { data, error } = await supabase.from('users').update({ password_hash: hashed }).eq('phone', phone).select('id, phone, full_name').single();
  if (error || !data) return res.status(404).json({ message: 'Usuario no encontrado', error: error?.message });
  res.json({ message: 'Contraseña reseteada', user: data });
});


// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// CONTACTOS
// SERVICIOS PÃƒÅ¡BLICOS (simulados con datos reales de GE)
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
const sandboxStatus = ['pending', 'processing', 'completed', 'failed'];
const safeRef = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
const toNum = (v) => Number(v || 0);

const logAudit = async (userId, action, module, entityId, details) => {
  await supabase.from('audit_logs').insert({
    user_id: userId,
    action,
    module,
    entity_id: entityId || null,
    details: details || {}
  }).catch(() => {});
};

const createServiceOrder = async (userId, provider, serviceType, amount, contractRef, payload, response) => {
  const orderRef = safeRef(provider.toUpperCase());
  const insert = {
    order_ref: orderRef,
    user_id: userId,
    provider,
    service_type: serviceType,
    contract_ref: contractRef || null,
    amount: toNum(amount),
    status: 'completed',
    payload: payload || {},
    response: response || {}
  };
  const { data } = await supabase.from('service_orders').insert(insert).select().maybeSingle();
  await logAudit(userId, 'service_order_create', 'services', data?.id || orderRef, insert);
  return { orderRef, record: data || insert };
};

const debitWalletWithTx = async (userId, amount, method, reference, txType = 'payment') => {
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
  if (!wallet || amount > Number(wallet.balance || 0)) return { ok: false, message: 'Saldo insuficiente' };
  const newBalance = Number(wallet.balance || 0) - Number(amount || 0);
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', userId);
  const { data: tx } = await supabase.from('transactions').insert({
    user_id: userId,
    type: txType,
    amount,
    method: method || 'EGCHAT',
    reference,
    status: 'completed'
  }).select().maybeSingle();
  await logAudit(userId, 'wallet_debit', 'wallet', tx?.id || reference, { amount, reference, txType });
  return { ok: true, balance: newBalance, tx };
};

app.post('/api/servicios/segesa/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Numero de contrato requerido', code: 'VALIDATION_ERROR' });
  const response = { contrato, titular: 'Cliente SEGESA', importe: Math.floor(Math.random()*15000)+5000, vencimiento: '2026-04-30', estado: 'pendiente', direccion: 'Malabo, Guinea Ecuatorial' };
  await createServiceOrder(req.user.id, 'segesa', 'consultar', 0, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/segesa/pagar', auth, async (req, res) => {
  const { contrato, importe, metodo } = req.body;
  if (!contrato || toNum(importe) <= 0) return res.status(400).json({ message: 'Datos invalidos', code: 'VALIDATION_ERROR' });
  const deb = await debitWalletWithTx(req.user.id, toNum(importe), metodo || 'EGCHAT', `SEGESA-${contrato}`, 'service_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message, code: 'INSUFFICIENT_BALANCE' });
  const response = { success: true, balance: deb.balance, referencia: safeRef('SEG'), message: 'Pago de electricidad completado' };
  await createServiceOrder(req.user.id, 'segesa', 'pagar', importe, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/snge/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Numero de contrato requerido', code: 'VALIDATION_ERROR' });
  const response = { contrato, titular: 'Cliente SNGE', importe: Math.floor(Math.random()*8000)+2000, vencimiento: '2026-04-30', estado: 'pendiente', direccion: 'Malabo, Guinea Ecuatorial' };
  await createServiceOrder(req.user.id, 'snge', 'consultar', 0, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/snge/pagar', auth, async (req, res) => {
  const { contrato, importe, metodo } = req.body;
  if (!contrato || toNum(importe) <= 0) return res.status(400).json({ message: 'Datos invalidos', code: 'VALIDATION_ERROR' });
  const deb = await debitWalletWithTx(req.user.id, toNum(importe), metodo || 'EGCHAT', `SNGE-${contrato}`, 'service_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message, code: 'INSUFFICIENT_BALANCE' });
  const response = { success: true, balance: deb.balance, referencia: safeRef('SNGE'), message: 'Pago de agua completado' };
  await createServiceOrder(req.user.id, 'snge', 'pagar', importe, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/dgi/consultar', auth, async (req, res) => {
  const { nif, tipo } = req.body;
  if (!nif) return res.status(400).json({ message: 'NIF requerido', code: 'VALIDATION_ERROR' });
  const response = { nif, tipo, importe: Math.floor(Math.random()*50000)+10000, periodo: '2026-T1', estado: 'pendiente', descripcion: `Impuesto ${tipo || 'general'}` };
  await createServiceOrder(req.user.id, 'dgi', 'consultar', 0, nif, req.body, response);
  res.json(response);
});

app.post('/api/servicios/dgi/pagar', auth, async (req, res) => {
  const { nif, importe, referencia } = req.body;
  if (!nif || toNum(importe) <= 0) return res.status(400).json({ message: 'Datos invalidos', code: 'VALIDATION_ERROR' });
  const deb = await debitWalletWithTx(req.user.id, toNum(importe), 'EGCHAT', `DGI-${nif}-${referencia || 'R'}`, 'tax_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message, code: 'INSUFFICIENT_BALANCE' });
  const response = { success: true, balance: deb.balance, referencia: safeRef('DGI'), message: 'Pago de impuesto completado' };
  await createServiceOrder(req.user.id, 'dgi', 'pagar', importe, nif, req.body, response);
  res.json(response);
});

app.post('/api/servicios/correos/enviar', auth, async (req, res) => {
  const { destinatario, peso, tipo } = req.body;
  if (!destinatario) return res.status(400).json({ message: 'destinatario requerido', code: 'VALIDATION_ERROR' });
  const tarifa = tipo === 'express' ? 5000 : 2500;
  const response = { tracking: `EG${Date.now()}`, tarifa, estimado: tipo === 'express' ? '1-2 dias' : '3-5 dias', destinatario, message: 'Paquete registrado correctamente' };
  await createServiceOrder(req.user.id, 'correos', 'enviar', tarifa, destinatario, { destinatario, peso, tipo }, response);
  res.json(response);
});

app.get('/api/servicios/orders', auth, async (req, res) => {
  const { data } = await supabase.from('service_orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// SUPERMERCADOS
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
const SUPERMERCADOS = [
  { id: '1', name: 'Supermarket Malabo', city: 'Malabo', address: 'Calle de la Independencia', phone: '+240 222 001', open: true },
  { id: '2', name: 'Tienda Bata Centro', city: 'Bata', address: 'Av. Hassan II', phone: '+240 333 001', open: true },
  { id: '3', name: 'Mercado Mongomo', city: 'Mongomo', address: 'Plaza Central', phone: '+240 444 001', open: false },
];
const PRODUCTOS = [
  { id: '1', name: 'Arroz 5kg', price: 3500, category: 'AlimentaciÃƒÂ³n', stock: 50 },
  { id: '2', name: 'Aceite 1L', price: 1200, category: 'AlimentaciÃƒÂ³n', stock: 30 },
  { id: '3', name: 'Agua 6x1.5L', price: 2000, category: 'Bebidas', stock: 100 },
  { id: '4', name: 'Leche 1L', price: 800, category: 'LÃƒÂ¡cteos', stock: 20 },
  { id: '5', name: 'Pan de molde', price: 600, category: 'PanaderÃƒÂ­a', stock: 15 },
];

app.get('/api/supermarkets', auth, async (req, res) => {
  const { city } = req.query;
  const result = city ? SUPERMERCADOS.filter(s => s.city.toLowerCase() === city.toLowerCase()) : SUPERMERCADOS;
  res.json(result);
});

app.get('/api/supermarkets/:smId/products', auth, async (req, res) => {
  const { cat } = req.query;
  const result = cat ? PRODUCTOS.filter(p => p.category === cat) : PRODUCTOS;
  res.json(result);
});

app.post('/api/supermarkets/orders', auth, async (req, res) => {
  const { items, supermarketId, address, external_id } = req.body;
  if (external_id) {
    const { data: existing } = await supabase.from('service_orders').select('*').eq('order_ref', external_id).eq('user_id', req.user.id).maybeSingle();
    if (existing) return res.json({ orderId: existing.order_ref, status: existing.status, total: existing.amount, balance: null, eta: '30-45 min', idempotent: true });
  }
  const total = items?.reduce((s, i) => s + (i.price * i.qty), 0) || 0;
  const deb = await debitWalletWithTx(req.user.id, total, 'EGCHAT', `SUPER-${supermarketId}`, 'shopping_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message, code: 'INSUFFICIENT_BALANCE' });
  const orderId = external_id || safeRef('ORD');
  await supabase.from('service_orders').upsert({
    order_ref: orderId,
    user_id: req.user.id,
    provider: 'supermarkets',
    service_type: 'order',
    contract_ref: String(supermarketId || ''),
    amount: total,
    status: 'completed',
    payload: { items: items || [], address: address || '' },
    response: { eta: '30-45 min' }
  }, { onConflict: 'order_ref' });
  await logAudit(req.user.id, 'supermarket_order_create', 'supermarkets', orderId, { total, supermarketId });
  res.json({ orderId, status: 'confirmed', total, balance: deb.balance, eta: '30-45 min' });
});

app.get('/api/supermarkets/orders', auth, async (req, res) => {
  const { data } = await supabase.from('service_orders').select('*')
    .eq('user_id', req.user.id).eq('provider', 'supermarkets').order('created_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/supermarkets/orders/:id', auth, async (req, res) => {
  const { data } = await supabase
    .from('service_orders')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('order_ref', req.params.id)
    .maybeSingle();
  if (!data) return res.status(404).json({ message: 'Pedido no encontrado' });
  res.json(data);
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// SALUD
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
const HOSPITALES = [
  { id: '1', name: 'Hospital General de Malabo', city: 'Malabo', phone: '+240 222 100', emergency: true, specialties: ['Urgencias', 'CirugÃƒÂ­a', 'PediatrÃƒÂ­a'] },
  { id: '2', name: 'ClÃƒÂ­nica Santa Isabel', city: 'Malabo', phone: '+240 222 200', emergency: false, specialties: ['Medicina General', 'GinecologÃƒÂ­a'] },
  { id: '3', name: 'Hospital Regional de Bata', city: 'Bata', phone: '+240 333 100', emergency: true, specialties: ['Urgencias', 'TraumatologÃƒÂ­a'] },
];
const FARMACIAS = [
  { id: '1', name: 'Farmacia Central Malabo', city: 'Malabo', phone: '+240 222 300', open24h: true },
  { id: '2', name: 'Farmacia Bata Norte', city: 'Bata', phone: '+240 333 300', open24h: false },
];

app.get('/api/salud/hospitales', auth, async (req, res) => {
  const { city } = req.query;
  res.json(city ? HOSPITALES.filter(h => h.city.toLowerCase() === city.toLowerCase()) : HOSPITALES);
});

app.get('/api/salud/farmacias', auth, async (req, res) => {
  const { city } = req.query;
  res.json(city ? FARMACIAS.filter(f => f.city.toLowerCase() === city.toLowerCase()) : FARMACIAS);
});

app.post('/api/salud/citas', auth, async (req, res) => {
  const { hospitalId, especialidad, fecha, motivo } = req.body;
  const hospital = HOSPITALES.find(h => h.id === hospitalId) || HOSPITALES[0];
  const citaId = safeRef('CITA');
  const response = { citaId, hospital: hospital.name, especialidad, fecha, motivo, confirmado: true, message: 'Cita medica confirmada' };
  await createServiceOrder(req.user.id, 'salud', 'cita', 0, hospitalId, req.body, response);
  res.json(response);
});

app.get('/api/salud/medicamentos', auth, async (req, res) => {
  const { q } = req.query;
  const meds = [
    { id: '1', name: 'Paracetamol 500mg', price: 500, stock: true },
    { id: '2', name: 'Ibuprofeno 400mg', price: 800, stock: true },
    { id: '3', name: 'Amoxicilina 500mg', price: 1500, stock: false },
    { id: '4', name: 'Omeprazol 20mg', price: 1200, stock: true },
  ];
  const result = q ? meds.filter(m => m.name.toLowerCase().includes(q.toLowerCase())) : meds;
  res.json(result);
});

app.post('/api/salud/medicamentos/pedido', auth, async (req, res) => {
  const { items, farmaciaId, direccion, external_id } = req.body;
  const total = items?.reduce((s, i) => s + (i.price * i.qty), 0) || 0;
  const orderId = external_id || safeRef('MED');
  await supabase.from('service_orders').upsert({
    order_ref: orderId,
    user_id: req.user.id,
    provider: 'salud',
    service_type: 'medicamentos',
    contract_ref: String(farmaciaId || ''),
    amount: total,
    status: 'completed',
    payload: { items: items || [], direccion: direccion || '' },
    response: { eta: '20-30 min' }
  }, { onConflict: 'order_ref' });
  res.json({ orderId, status: 'confirmed', total, eta: '20-30 min', message: 'Pedido de medicamentos confirmado' });
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// TAXI
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
app.post('/api/taxi/request', auth, async (req, res) => {
  try {
    const { origin, dest, type } = req.body;
    if (!origin || !dest) return res.status(400).json({ message: 'origin y dest requeridos', code: 'VALIDATION_ERROR' });
    const tarifa = type === 'premium' ? 3500 : type === 'moto' ? 800 : 1500;
    
    // Validar wallet con fallback
    let wallet = null;
    try {
      const { data } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
      wallet = data;
    } catch (e) {
      console.warn('Wallet query failed, using fallback:', e.message);
    }
    
    if (!wallet || tarifa > Number(wallet.balance || 0)) {
      return res.status(400).json({ message: 'Saldo insuficiente', code: 'INSUFFICIENT_BALANCE' });
    }
    
    const rideId = safeRef('RIDE');
    const driver = { name: 'Carlos Mba', phone: '+240 222 555', rating: 4.8, plate: 'GE-1234', vehicle: type === 'moto' ? 'Moto Honda' : 'Toyota Corolla' };
    
    // Insert con manejo de columnas y fallback
    let ride = null;
    try {
      const insertData = {
        ride_ref: rideId,
        user_id: req.user.id,
        origin,
        destination: dest,
        ride_type: type || 'basic',
        fare: tarifa,
        status: 'searching',
        driver
      };
      
      // Intentar insert con columnas especÃ­ficas
      const { data } = await supabase.from('taxi_rides').insert(insertData).select().maybeSingle();
      ride = data;
    } catch (insertError) {
      console.warn('Taxi ride insert failed, using fallback store:', insertError.message);
      // Fallback a memoria local
      const fallbackRide = {
        id: rideId,
        ride_ref: rideId,
        user_id: req.user.id,
        origin,
        destination: dest,
        ride_type: type || 'basic',
        fare: tarifa,
        status: 'searching',
        driver,
        created_at: new Date().toISOString()
      };
      getUserStore(taxiFallbackStore, req.user.id).push(fallbackRide);
      ride = fallbackRide;
    }
    
    try {
      await logAudit(req.user.id, 'taxi_request', 'taxi', ride?.id || rideId, { tarifa, type });
    } catch (auditError) {
      console.warn('Audit logging failed:', auditError.message);
    }
    
    res.json({ rideId, driver, eta: Math.floor(Math.random() * 8) + 3, tarifa, type, status: 'searching' });
  } catch (error) {
    console.error('Taxi request error:', error);
    res.status(500).json({ message: 'Error al solicitar taxi', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/taxi/:rideId/status', auth, async (req, res) => {
  try {
    let ride = null;
    
    // Intentar obtener de Supabase
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
      ride = data;
    } catch (dbError) {
      console.warn('Taxi status query failed, checking fallback:', dbError.message);
    }
    
    // Si no hay datos, buscar en fallback store
    if (!ride) {
      const userRides = getUserStore(taxiFallbackStore, req.user.id);
      ride = userRides.find(r => r.ride_ref === req.params.rideId);
    }
    
    if (!ride) {
      return res.status(404).json({ message: 'Viaje no encontrado', code: 'RIDE_NOT_FOUND' });
    }
    
    const status = sandboxStatus.includes(ride.status) ? ride.status : 'processing';
    res.json({ 
      rideId: ride.ride_ref, 
      status, 
      eta: status === 'completed' ? 0 : 2, 
      driver_location: { lat: 3.75, lng: 8.78 }, 
      fare: ride.fare, 
      driver: ride.driver 
    });
  } catch (error) {
    console.error('Taxi status error:', error);
    res.status(500).json({ message: 'Error al obtener estado del viaje', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/taxi/:rideId/cancel', auth, async (req, res) => {
  try {
    let ride = null;
    
    // Buscar en Supabase
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
      ride = data;
    } catch (dbError) {
      console.warn('Taxi cancel query failed, checking fallback:', dbError.message);
    }
    
    // Si no hay datos, buscar en fallback store
    if (!ride) {
      const userRides = getUserStore(taxiFallbackStore, req.user.id);
      ride = userRides.find(r => r.ride_ref === req.params.rideId);
    }
    
    if (!ride) {
      return res.status(404).json({ message: 'Viaje no encontrado', code: 'RIDE_NOT_FOUND' });
    }
    
    // Actualizar en Supabase si tiene ID
    if (ride.id && typeof ride.id === 'string' && !ride.id.startsWith('RIDE')) {
      try {
        await supabase.from('taxi_rides').update({ 
          status: 'failed', 
          updated_at: new Date().toISOString() 
        }).eq('id', ride.id);
      } catch (updateError) {
        console.warn('Taxi cancel update failed:', updateError.message);
      }
    }
    
    // Actualizar en fallback store
    const userRides = getUserStore(taxiFallbackStore, req.user.id);
    const fallbackIndex = userRides.findIndex(r => r.ride_ref === req.params.rideId);
    if (fallbackIndex !== -1) {
      userRides[fallbackIndex].status = 'failed';
      userRides[fallbackIndex].updated_at = new Date().toISOString();
    }
    
    try {
      await logAudit(req.user.id, 'taxi_cancel', 'taxi', ride.id, { ride_ref: ride.ride_ref });
    } catch (auditError) {
      console.warn('Audit logging failed:', auditError.message);
    }
    
    res.json({ message: 'Viaje cancelado', rideId: req.params.rideId });
  } catch (error) {
    console.error('Taxi cancel error:', error);
    res.status(500).json({ message: 'Error al cancelar viaje', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/taxi/:rideId/rate', auth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating debe ser entre 1 y 5', code: 'INVALID_RATING' });
    }
    
    let ride = null;
    
    // Buscar en Supabase
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
      ride = data;
    } catch (dbError) {
      console.warn('Taxi rate query failed, checking fallback:', dbError.message);
    }
    
    // Si no hay datos, buscar en fallback store
    if (!ride) {
      const userRides = getUserStore(taxiFallbackStore, req.user.id);
      ride = userRides.find(r => r.ride_ref === req.params.rideId);
    }
    
    if (!ride) {
      return res.status(404).json({ message: 'Viaje no encontrado', code: 'RIDE_NOT_FOUND' });
    }
    
    const updateData = {
      rating: Number(rating),
      rating_comment: comment || null,
      status: 'completed',
      updated_at: new Date().toISOString()
    };
    
    // Actualizar en Supabase si tiene ID
    if (ride.id && typeof ride.id === 'string' && !ride.id.startsWith('RIDE')) {
      try {
        await supabase.from('taxi_rides').update(updateData).eq('id', ride.id);
      } catch (updateError) {
        console.warn('Taxi rate update failed:', updateError.message);
      }
    }
    
    // Actualizar en fallback store
    const userRides = getUserStore(taxiFallbackStore, req.user.id);
    const fallbackIndex = userRides.findIndex(r => r.ride_ref === req.params.rideId);
    if (fallbackIndex !== -1) {
      Object.assign(userRides[fallbackIndex], updateData);
    }
    
    let deb = { balance: 0 };
    try {
      deb = await debitWalletWithTx(req.user.id, 0, 'EGCHAT', `TAXI-RATE-${req.params.rideId}`, 'taxi_rate');
    } catch (walletError) {
      console.warn('Wallet debit failed:', walletError.message);
    }
    
    try {
      await logAudit(req.user.id, 'taxi_rate', 'taxi', ride.id, { ride_ref: ride.ride_ref, rating });
    } catch (auditError) {
      console.warn('Audit logging failed:', auditError.message);
    }
    
    res.json({ 
      message: 'Valoracion enviada', 
      rating: Number(rating), 
      rideId: req.params.rideId, 
      balance: deb.balance 
    });
  } catch (error) {
    console.error('Taxi rate error:', error);
    res.status(500).json({ message: 'Error al valorar viaje', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/taxi/rides', auth, async (req, res) => {
  try {
    let rides = [];
    
    // Intentar obtener de Supabase
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
      rides = data || [];
    } catch (dbError) {
      console.warn('Taxi rides query failed, using fallback:', dbError.message);
    }
    
    // Combinar con fallback store
    const fallbackRides = getUserStore(taxiFallbackStore, req.user.id);
    const combined = [...rides, ...fallbackRides];
    
    // Eliminar duplicados por ride_ref y ordenar
    const uniqueRides = combined.filter((ride, index, self) => 
      index === self.findIndex(r => r.ride_ref === ride.ride_ref)
    );
    
    uniqueRides.sort((a, b) => 
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
    
    res.json(uniqueRides);
  } catch (error) {
    console.error('Taxi rides error:', error);
    res.status(500).json({ message: 'Error al obtener viajes', code: 'INTERNAL_ERROR' });
  }
});

// Alias legacy sin /api
app.post('/taxi/:rideId/cancel', auth, async (req, res) => {
  req.url = `/api/taxi/${req.params.rideId}/cancel`;
  return app._router.handle(req, res, () => {});
});
app.get('/taxi/:rideId/status', auth, async (req, res) => {
  req.url = `/api/taxi/${req.params.rideId}/status`;
  return app._router.handle(req, res, () => {});
});
app.post('/taxi/:rideId/rate', auth, async (req, res) => {
  req.url = `/api/taxi/${req.params.rideId}/rate`;
  return app._router.handle(req, res, () => {});
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// SEGUROS - COTIZACIONES, PÃƒâ€œLIZAS, RECLAMACIONES
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

// Obtener tipos de seguros disponibles
app.get('/api/insurance/types', auth, async (req, res) => {
  try {
    const insuranceTypes = [
      {
        id: 'salud',
        name: 'Seguro de Salud',
        icon: 'Ã°Å¸ÂÂ¥',
        description: 'Cobertura mÃƒÂ©dica completa',
        coverage: ['consultas', 'urgencias', 'hospitalizaciÃƒÂ³n', 'medicamentos'],
        starting_price: 5000
      },
      {
        id: 'vehiculo',
        name: 'Seguro de VehÃƒÂ­culo',
        icon: 'Ã°Å¸Å¡â€”',
        description: 'ProtecciÃƒÂ³n para tu vehÃƒÂ­culo',
        coverage: ['colisiÃƒÂ³n', 'robo', 'daÃƒÂ±os', 'responsabilidad civil'],
        starting_price: 8000
      },
      {
        id: 'vida',
        name: 'Seguro de Vida',
        icon: 'Ã°Å¸â€ºÂ¡Ã¯Â¸Â',
        description: 'Seguridad para tu familia',
        coverage: ['fallecimiento', 'invalidez', 'enfermedades graves'],
        starting_price: 3000
      },
      {
        id: 'hogar',
        name: 'Seguro de Hogar',
        icon: 'Ã°Å¸ÂÂ ',
        description: 'ProtecciÃƒÂ³n para tu vivienda',
        coverage: ['incendio', 'robo', 'daÃƒÂ±os estructurales', 'responsabilidad civil'],
        starting_price: 4000
      }
    ];

    res.json(insuranceTypes);
  } catch (e) {
    console.error('Get insurance types error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener cotizaciÃƒÂ³n de seguro
app.post('/api/insurance/quote', auth, async (req, res) => {
  try {
    const { insurance_type, coverage_amount, duration_months } = req.body;

    if (!insurance_type || !coverage_amount || !duration_months) {
      return res.status(400).json({ message: 'Datos incompletos para cotizaciÃƒÂ³n' });
    }

    // Calcular prima mensual (ejemplo simple)
    const baseRates = {
      salud: 0.02,
      vehiculo: 0.035,
      vida: 0.015,
      hogar: 0.025
    };

    const monthly_premium = Math.round(coverage_amount * baseRates[insurance_type] || 0.02);
    const total_premium = monthly_premium * duration_months;

    res.json({
      insurance_type,
      coverage_amount,
      duration_months,
      monthly_premium,
      total_premium,
      currency: 'XAF',
      valid_until: new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString()
    });
  } catch (e) {
    console.error('Get insurance quote error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Contratar seguro
app.post('/api/insurance/contract', auth, async (req, res) => {
  try {
    const { insurance_type, coverage_amount, duration_months, payment_method } = req.body;

    if (!insurance_type || !coverage_amount || !duration_months) {
      return res.status(400).json({ message: 'Datos incompletos para contratar' });
    }

    // Verificar saldo
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();

    // Calcular prima
    const baseRates = {
      salud: 0.02,
      vehiculo: 0.035,
      vida: 0.015,
      hogar: 0.025
    };

    const monthly_premium = Math.round(coverage_amount * baseRates[insurance_type] || 0.02);
    const total_premium = monthly_premium * duration_months;

    if (!wallet || total_premium > wallet.balance) {
      return res.status(400).json({ message: 'Saldo insuficiente para contratar seguro' });
    }

    // Crear pÃƒÂ³liza
    const { data: policy } = await supabase
      .from('insurance_policies')
      .insert({
        user_id: req.user.id,
        insurance_type,
        coverage_amount,
        duration_months,
        monthly_premium,
        total_premium,
        status: 'active',
        start_date: new Date().toISOString(),
        end_date: new Date(Date.now() + (duration_months * 30 * 24 * 60 * 60 * 1000)).toISOString()
      })
      .select()
      .single();

    // Procesar pago
    const newBalance = wallet.balance - total_premium;
    await supabase
      .from('wallets')
      .update({ balance: newBalance })
      .eq('user_id', req.user.id);

    // Registrar transacciÃƒÂ³n
    await supabase
      .from('transactions')
      .insert({
        user_id: req.user.id,
        type: 'insurance_payment',
        amount: total_premium,
        method: payment_method,
        reference: `INSURANCE-${policy.id}`,
        status: 'completed',
        metadata: {
          policy_id: policy.id,
          insurance_type,
          duration_months
        }
      });

    res.json({
      message: 'Seguro contratado exitosamente',
      policy,
      balance: newBalance
    });
  } catch (e) {
    console.error('Contract insurance error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener pÃƒÂ³lizas del usuario
app.get('/api/insurance/policies', auth, async (req, res) => {
  try {
    const { data: policies } = await supabase
      .from('insurance_policies')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    res.json(policies || []);
  } catch (e) {
    console.error('Get insurance policies error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Presentar reclamaciÃƒÂ³n
app.post('/api/insurance/claim', auth, async (req, res) => {
  try {
    const { policy_id, claim_type, description, amount } = req.body;

    if (!policy_id || !claim_type || !description) {
      return res.status(400).json({ message: 'Datos incompletos para reclamaciÃƒÂ³n' });
    }

    // Verificar que la pÃƒÂ³liza pertenece al usuario
    const { data: policy } = await supabase
      .from('insurance_policies')
      .select('id, user_id, status')
      .eq('id', policy_id)
      .single();

    if (!policy || policy.user_id !== req.user.id) {
      return res.status(404).json({ message: 'PÃƒÂ³liza no encontrada' });
    }

    if (policy.status !== 'active') {
      return res.status(400).json({ message: 'La pÃƒÂ³liza no estÃƒÂ¡ activa' });
    }

    // Crear reclamaciÃƒÂ³n
    const { data: claim } = await supabase
      .from('insurance_claims')
      .insert({
        policy_id,
        user_id: req.user.id,
        claim_type,
        description,
        amount,
        status: 'pending',
        submitted_at: new Date().toISOString()
      })
      .select()
      .single();

    res.json({
      message: 'ReclamaciÃƒÂ³n presentada exitosamente',
      claim
    });
  } catch (e) {
    console.error('Submit insurance claim error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener reclamaciones del usuario
app.get('/api/insurance/claims', auth, async (req, res) => {
  try {
    const { data: claims } = await supabase
      .from('insurance_claims')
      .select(`
        *,
        policy:insurance_policies(id, insurance_type, status)
      `)
      .eq('user_id', req.user.id)
      .order('submitted_at', { ascending: false });

    res.json(claims || []);
  } catch (e) {
    console.error('Get insurance claims error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// NOTICIAS - CATEGORÃƒÂAS, FEEDS, BÃƒÅ¡SQUEDA, PERSONALIZACIÃƒâ€œN
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

// Obtener categorÃƒÂ­as de noticias
app.get('/api/news/categories', auth, async (req, res) => {
  try {
    const categories = [
      {
        id: 'nacional',
        name: 'Nacional',
        icon: 'Ã°Å¸â€¡Â¬Ã°Å¸â€¡Â¶',
        description: 'Noticias de Guinea Ecuatorial'
      },
      {
        id: 'internacional',
        name: 'Internacional',
        icon: 'Ã°Å¸Å’Â',
        description: 'Noticias del mundo'
      },
      {
        id: 'deportes',
        name: 'Deportes',
        icon: 'Ã¢Å¡Â½',
        description: 'FÃƒÂºtbol y otros deportes'
      },
      {
        id: 'economia',
        name: 'EconomÃƒÂ­a',
        icon: 'Ã°Å¸â€™Â°',
        description: 'Finanzas y negocios'
      },
      {
        id: 'tecnologia',
        name: 'TecnologÃƒÂ­a',
        icon: 'Ã°Å¸â€™Â»',
        description: 'TecnologÃƒÂ­a y ciencia'
      },
      {
        id: 'cultura',
        name: 'Cultura',
        icon: 'Ã°Å¸Å½Â­',
        description: 'Arte y entretenimiento'
      }
    ];

    res.json(categories);
  } catch (e) {
    console.error('Get news categories error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener noticias por categorÃƒÂ­a
app.get('/api/news', auth, async (req, res) => {
  try {
    const { category, page = 1, limit = 20 } = req.query;

    // Noticias simuladas (en producciÃƒÂ³n vendrÃƒÂ­an de una API real)
    const allNews = [
      {
        id: '1',
        title: 'EGCHAT lanza nueva funcionalidad de mensajerÃ­a instantÃ¡nea',
        category: 'tecnologia',
        summary: 'La aplicaciÃƒÂ³n EGCHAT anuncia importantes mejoras...',
        content: '...',
        image_url: 'https://example.com/egchat-news.jpg',
        published_at: new Date().toISOString(),
        source: 'TechGE'
      },
      {
        id: '2',
        title: 'EconomÃƒÂ­a de Guinea Ecuatorial muestra crecimiento',
        category: 'economia',
        summary: 'El Banco Central de Guinea Ecuatorial reporta...',
        content: '...',
        image_url: 'https://example.com/economy-news.jpg',
        published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        source: 'EcoDiario'
      }
    ];

    const filteredNews = category 
      ? allNews.filter(news => news.category === category)
      : allNews;

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedNews = filteredNews.slice(startIndex, endIndex);

    res.json({
      news: paginatedNews,
      total: filteredNews.length,
      page: parseInt(page),
      totalPages: Math.ceil(filteredNews.length / limit)
    });
  } catch (e) {
    console.error('Get news error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Buscar noticias
app.get('/api/news/search', auth, async (req, res) => {
  try {
    const { q, category } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ message: 'La bÃƒÂºsqueda debe tener al menos 2 caracteres' });
    }

    // Noticias simuladas para bÃƒÂºsqueda
    const searchResults = [
      {
        id: 'search1',
        title: `Resultados para "${q}" en EGCHAT`,
        category: category || 'todos',
        summary: `Se encontraron artÃƒÂ­culos relacionados con ${q}...`,
        published_at: new Date().toISOString(),
        source: 'SearchEG'
      }
    ];

    res.json({
      query: q,
      results: searchResults,
      total: searchResults.length
    });
  } catch (e) {
    console.error('Search news error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Marcar noticia como favorita
app.post('/api/news/:newsId/favorite', auth, async (req, res) => {
  try {
    const { newsId } = req.params;

    const { data: favorite } = await supabase
      .from('user_news_favorites')
      .upsert({
        user_id: req.user.id,
        news_id: newsId
      })
      .select()
      .single();

    res.json({
      message: 'Noticia marcada como favorita',
      favorite
    });
  } catch (e) {
    console.error('Favorite news error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener noticias favoritas del usuario
app.get('/api/news/favorites', auth, async (req, res) => {
  try {
    const { data: favorites } = await supabase
      .from('user_news_favorites')
      .select(`
        *,
        news:news_items(id, title, summary, published_at, image_url)
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    res.json(favorites || []);
  } catch (e) {
    console.error('Get favorite news error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// SEGUROS
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

const ASEGURADORAS = [
  { id: '1', name: 'COGE Seguros', products: ['Vida', 'Salud', 'Auto', 'Hogar'] },
  { id: '2', name: 'SIAT Guinea', products: ['Auto', 'Empresarial', 'Transporte'] },
  { id: '3', name: 'Allianz GE', products: ['Vida', 'Salud', 'Viaje'] },
];

app.get('/api/seguros/companias', auth, async (req, res) => res.json(ASEGURADORAS));

app.get('/api/seguros/companias/:companyId/productos', auth, async (req, res) => {
  const company = ASEGURADORAS.find(a => a.id === req.params.companyId) || ASEGURADORAS[0];
  res.json(company.products.map((p, i) => ({ id: String(i+1), name: p, price: (i+1)*5000, coverage: '12 meses' })));
});
app.get('/seguros/companias/:companyId/productos', auth, async (req, res) => {
  const company = ASEGURADORAS.find(a => a.id === req.params.companyId) || ASEGURADORAS[0];
  res.json(company.products.map((p, i) => ({ id: String(i + 1), name: p, price: (i + 1) * 5000, coverage: '12 meses' })));
});

app.post('/api/seguros/solicitar', auth, async (req, res) => {
  const { companyId, producto, datos, external_id } = req.body || {};
  if (!companyId || !producto) return res.status(400).json({ message: 'companyId y producto requeridos', code: 'VALIDATION_ERROR' });
  const solicitudId = external_id || safeRef('SEG');
  await supabase.from('service_orders').upsert({
    order_ref: solicitudId,
    user_id: req.user.id,
    provider: 'seguros',
    service_type: 'solicitud',
    contract_ref: String(companyId),
    amount: 0,
    status: 'pending',
    payload: { producto, datos: datos || null },
    response: { message: 'Solicitud de seguro enviada. Te contactaremos en 24h.' }
  }, { onConflict: 'order_ref' });
  await logAudit(req.user.id, 'insurance_request', 'seguros', solicitudId, { companyId, producto });
  res.json({ solicitudId, status: 'pending', message: 'Solicitud de seguro enviada. Te contactaremos en 24h.' });
});

app.post('/api/seguros/solicitudes/:solicitudId/documentos', auth, async (req, res) => {
  const { solicitudId } = req.params;
  const { tipo } = req.body || {};
  res.status(201).json({
    solicitudId,
    tipo: tipo || 'documento',
    status: 'uploaded',
    message: 'Documento recibido'
  });
});
app.post('/seguros/solicitudes/:solicitudId/documentos', auth, async (req, res) => {
  const { solicitudId } = req.params;
  const { tipo } = req.body || {};
  res.status(201).json({ solicitudId, tipo: tipo || 'documento', status: 'uploaded', message: 'Documento recibido' });
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// NOTICIAS
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
const NOTICIAS = [
  { id: '1', title: 'Presidente anuncia nuevas medidas econÃƒÂ³micas para 2026', source: 'Presidencia GE', category: 'PolÃƒÂ­tica', time: '14:30', isLive: true },
  { id: '2', title: 'CEMAC aprueba nuevo marco financiero regional', source: 'Noticias CEMAC', category: 'Finanzas', time: '13:45' },
  { id: '3', title: 'Ministerio de Salud reporta avances en vacunaciÃƒÂ³n', source: 'Ministerio de InformaciÃƒÂ³n', category: 'Salud', time: '12:20' },
  { id: '4', title: 'Nueva tecnologÃƒÂ­a 5G llega a Malabo', source: 'TVGE', category: 'TecnologÃƒÂ­a', time: '11:15' },
  { id: '5', title: 'SelecciÃƒÂ³n nacional se prepara para eliminatorias', source: 'Radio Nacional', category: 'Deportes', time: '10:30' },
  { id: '6', title: 'BEAC anuncia nuevas polÃƒÂ­ticas monetarias', source: 'BEAC', category: 'Finanzas', time: '09:00' },
];

app.get('/api/noticias', auth, async (req, res) => {
  const { cat } = req.query;
  res.json(cat ? NOTICIAS.filter(n => n.category.toLowerCase() === cat.toLowerCase()) : NOTICIAS);
});

app.get('/api/noticias/:id', auth, async (req, res) => {
  const noticia = NOTICIAS.find(n => n.id === req.params.id);
  if (!noticia) return res.status(404).json({ message: 'Noticia no encontrada' });
  res.json({ ...noticia, content: `Contenido completo de: ${noticia.title}. Esta noticia fue publicada por ${noticia.source}.` });
});

app.post('/api/user/avatar', auth, async (req, res) => {
  res.json({
    message: 'Avatar recibido',
    avatar_url: `https://egchat-api.onrender.com/static/avatars/${req.user.id}-${Date.now()}.jpg`
  });
});

app.post('/lia/analyze', auth, async (_req, res) => {
  res.json({ analysis: 'AnÃ¡lisis completado.' });
});

app.post('/api/lia/analyze', auth, async (_req, res) => {
  res.json({ analysis: 'AnÃ¡lisis completado.' });
});

app.post('/lia/transcribe', auth, async (_req, res) => {
  res.json({ text: 'TranscripciÃ³n completada.' });
});

app.post('/api/lia/transcribe', auth, async (_req, res) => {
  res.json({ text: 'TranscripciÃ³n completada.' });
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// GRUPOS DE CHAT
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// AÃƒÂ±adir participante a grupo
app.post('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    await supabase.from('chat_participants').upsert({ chat_id: req.params.chatId, user_id });
    res.json({ message: 'Participante aÃƒÂ±adido' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// NOTIFICACIONES
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
app.get('/api/notifications', auth, async (req, res) => {
  try {
    // Mensajes no leÃƒÂ­dos como notificaciones
    const { data: parts } = await supabase.from('chat_participants').select('chat_id').eq('user_id', req.user.id);
    const chatIds = (parts || []).map(p => p.chat_id);
    if (!chatIds.length) return res.json([]);

    const { data: msgs } = await supabase.from('messages')
      .select('id, text, chat_id, sender_id, created_at, users!sender_id(full_name, avatar_url)')
      .in('chat_id', chatIds)
      .neq('sender_id', req.user.id)
      .eq('status', 'sent')
      .order('created_at', { ascending: false })
      .limit(20);

    res.json(msgs || []);
  } catch (e) { res.json([]); }
});

// Marcar mensajes como leÃƒÂ­dos
app.post('/api/chats/:chatId/read', auth, async (req, res) => {
  try {
    await supabase.from('messages')
      .update({ status: 'read' })
      .eq('chat_id', req.params.chatId)
      .neq('sender_id', req.user.id);
    res.json({ message: 'Mensajes marcados como leÃƒÂ­dos' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// CONTACTOS CON FOTO Y PERFIL
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// Perfil público de un usuario
app.get('/api/users/:userId', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('id, phone, full_name, avatar_url, created_at').eq('id', req.params.userId).single();
    if (!data) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// START
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
const updateUserVersions = async () => {
  const isPlaceholderSupabase =
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_URL.includes('TU_PROYECTO') ||
    process.env.SUPABASE_SERVICE_KEY.includes('TU_SERVICE_ROLE_KEY');

  if (isPlaceholderSupabase) {
    console.warn('Skipping user version update: Supabase credentials are missing or placeholder values.');
    return;
  }

  try {
    const { error } = await supabase.from('users').update({ app_version: APP_VERSION });
    if (error) {
      const missingColumn = /column \"app_version\".*does not exist/i.test(error.message || '');
      console.warn('User versions update not completed:', error.message);
      if (missingColumn) {
        console.warn('The users table is missing the app_version column. Add it before retrying.');
      }
      return;
    }
    console.log(`Updated app_version for all users to ${APP_VERSION}.`);
  } catch (e) {
    console.warn('Failed updating user versions:', e.message);
  }
};

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n😎 EGCHAT API + Supabase en http://localhost:${PORT}`);
    console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅ Conectado' : '❌ Sin configurar'}`);
    console.log(`   Auth:   POST /api/auth/register | /api/auth/login`);
    console.log(`   Wallet: GET  /api/wallet/balance | POST /api/wallet/deposit`);
    console.log(`   Lia-25: POST /api/lia/chat\n`);
  });
  updateUserVersions();
}

module.exports = app;


