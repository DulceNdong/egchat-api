
﻿// Cargar variables de entorno (solo en local, en Render vienen del dashboard)
// v2.5.2 — build forzado para limpiar cache Render
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
const JWT_SECRET_FALLBACK = 'EGchat2025!xK9mP3nQ7rL2vW8tY4uJ6hF1bN5cA0dE_prod_secret';
console.log('JWT_SECRET source:', process.env.JWT_SECRET ? 'environment' : 'fallback');

// Verificar token con múltiples secrets para compatibilidad
const verifyToken = (token) => {
  const secrets = [JWT_SECRET, JWT_SECRET_FALLBACK].filter((s, i, arr) => arr.indexOf(s) === i);
  for (const secret of secrets) {
    try { return jwt.verify(token, secret); } catch {}
  }
  throw new Error('Token inválido o expirado');
};
const APP_VERSION = '2.5.7'; // fix: activar rutas de djangue - forzar redespliegue
const chatStreams = new Map();
const dependencyCache = { timestamp: 0, result: null };

// --- Supabase ---------------------------------------------------------
// Proyecto correcto: fqfxtjnfhvpggssbymdn (tiene todos los usuarios)
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fqfxtjnfhvpggssbymdn.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxZnh0am5maHZwZ2dzc2J5bWRuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTg0MzgyMCwiZXhwIjoyMTAxNDE5ODIwfQ.ulwcC4WW-00pgjKzzs9CclyMGad1y4dqjS7P-c2O-CM'
);

// --- Fallback de usuarios cuando Supabase no está disponible ----------
// Permite login aunque Supabase esté restringido por cuota
// Formato: phone -> { password_hash, full_name, id, avatar_url }
const FALLBACK_USERS = new Map([
  ['+240555570323', {
    id: 'fallback-240555570323',
    phone: '+240555570323',
    full_name: 'Raymon Reddintone', // Usuario principal
    avatar_url: null,
    password_hash: '$2a$10$.7A2DtbtOvnbHxy63LTlUusN84Uc/2VDstC23ZWBpR2S5AR3lgTyy', // 509871
  }],
]);

const isSupabaseQuotaError = (error) => {
  if (!error) return false;
  const msg = String(error?.message || error?.details || error?.hint || JSON.stringify(error) || '');
  return msg.includes('exceed') || msg.includes('quota') || msg.includes('restricted') || msg.includes('spend');
};

// --- Helper: detecta si Supabase está operativo (caché 60s) -----------
// Se auto-desactiva en cuanto Supabase se recupera.
const _supabaseStatus = { ok: true, checkedAt: 0 };
const SUPABASE_CHECK_TTL = 60_000; // 60 segundos
const supabaseOk = async () => {
  const now = Date.now();
  if (now - _supabaseStatus.checkedAt < SUPABASE_CHECK_TTL) return _supabaseStatus.ok;
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    _supabaseStatus.ok = !isSupabaseQuotaError(error);
    _supabaseStatus.checkedAt = now;
  } catch {
    _supabaseStatus.ok = false;
    _supabaseStatus.checkedAt = now;
  }
  return _supabaseStatus.ok;
};

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://egchat-app.vercel.app,https://egchat-v2.vercel.app,http://localhost:5173,http://localhost:3001,http://localhost:3000,http://127.0.0.1:3001')
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
    // Permitir cualquier subdominio de vercel.app (egchat-v2, egchat-app, etc.)
    if (/^https:\/\/egchat.*\.vercel\.app$/.test(origin)) return callback(null, true);
    return callback(new Error('CORS policy: origin not allowed'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight for all routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// --- Middleware auth --------------------------------------------------
const parseBearerToken = (header) => {
  if (typeof header !== 'string') return '';
  const match = header.match(/^\s*Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

const auth = (req, res, next) => {
  // Intentar obtener token de múltiples fuentes
  const authHeader = parseBearerToken(req.headers.authorization);
  const xAuthToken = req.headers['x-auth-token'] || '';
  const queryToken = typeof req.query._t === 'string' ? req.query._t : '';
  const token = authHeader || xAuthToken || queryToken;
  if (!token) return res.status(401).json({ message: 'Token requerido' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
};

const authFromQuery = (req, res, next) => {
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const tokenFromHeader = parseBearerToken(req.headers.authorization);
  const xAuthToken = req.headers['x-auth-token'] || '';
  const queryT = typeof req.query._t === 'string' ? req.query._t : '';
  const token = tokenFromQuery || tokenFromHeader || xAuthToken || queryT;
  if (!token) return res.status(401).json({ message: 'Token requerido' });
  try {
    req.user = verifyToken(token);
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

// --- EMERGENCY: listar usuarios reales de Supabase -------------------
app.get('/api/emergency/list-users', async (req, res) => {
  const { token } = req.query;
  if (!token || token !== 'EG2026_RESET_TOKEN_X9K') return res.status(403).json({ message: 'No autorizado' });
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .limit(200);
    if (error) return res.status(500).json({ message: error.message, detail: error.details });
    res.json({ ok: true, count: data.length, users: data });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// --- EMERGENCY RESET (temporal, borrar después) -----------------------
app.post('/api/emergency/reset-pw', async (req, res) => {
  const { token, phone, newPassword } = req.body || {};
  if (!token || token !== 'EG2026_RESET_TOKEN_X9K') return res.status(403).json({ message: 'No autorizado' });
  if (!phone || !newPassword) return res.status(400).json({ message: 'phone y newPassword requeridos' });
  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    const { data, error } = await supabase
      .from('users').update({ password_hash: hashed }).eq('phone', phone)
      .select('id, phone, full_name').single();
    if (error || !data) return res.status(404).json({ message: 'Usuario no encontrado', error: error?.message });
    res.json({ ok: true, user: data });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// --- ROOT -------------------------------------------------------------
app.get('/', (req, res) => res.json({
  message: 'EGCHAT API funcionando!',
  version: APP_VERSION,
  database: 'Supabase',
  status: 'active'
}));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Test deploy version
app.get('/api/test-deploy', (req, res) => res.json({ version: '7bfcbc3-TWILIO-FIXED', wallet_transfer: 'active', supabase: true, sms_verification: 'active' }));

// Helper para generar hash de contraseña (solo dev)
app.post('/api/dev/hash-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ message: 'Password requerido' });
    const hash = await bcrypt.hash(password, 10);
    res.json({ password, hash });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Test wallet/transfer validation (sin auth)
app.post('/api/test-wallet-validation', async (req, res) => {
  const { to, amount } = req.body;
  if (!to || !amount || amount <= 0) {
    return res.status(400).json({ message: 'Destinatario y monto requeridos' });
  }
  if (amount > 10000000) {
    return res.status(400).json({ message: 'Monto máximo: 10,000,000 XAF' });
  }
  res.json({ validation: 'passed', to, amount });
});

app.get('/jwt-debug', (req, res) => res.json({
  jwt_secret_source: process.env.JWT_SECRET ? 'environment' : 'fallback',
  jwt_secret_first10: JWT_SECRET.substring(0, 10),
  jwt_secret_length: JWT_SECRET.length,
}));

app.get('/debug', (req, res) => res.json({
  supabase_url_env: process.env.SUPABASE_URL || 'NO ENV — fallback activo',
  supabase_key: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
  jwt_secret: process.env.JWT_SECRET ? 'SET' : 'MISSING',
  node_env: process.env.NODE_ENV || 'not set',
  port: PORT,
  version: APP_VERSION
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

// Stream SSE para mensajería en tiempo real
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

  // Marcar online y notificar contactos
  const notifyPresence = async (online) => {
    try {
      await supabase.from('users').update({ online_status: online, last_seen: new Date().toISOString() }).eq('id', userId);
      const { data: contacts } = await supabase.from('contacts').select('user_id').eq('contact_user_id', userId);
      const { data: myContacts } = await supabase.from('contacts').select('contact_user_id').eq('user_id', userId);
      const notifyIds = new Set([
        ...(contacts || []).map(c => String(c.user_id)),
        ...(myContacts || []).map(c => String(c.contact_user_id)),
      ]);
      notifyIds.forEach(id => emitToUser(id, { type: 'presence', userId, online, ts: Date.now() }));
    } catch {}
  };
  notifyPresence(true);

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
      if (streams.size === 0) {
        chatStreams.delete(userId);
        notifyPresence(false);
      }
    }
  });
});

// AUTH
// ════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, full_name, avatar_url } = req.body;
    if (!phone || !password || !full_name)
      return res.status(400).json({ message: 'phone, password y full_name son requeridos' });

    const profileAvatar = avatar_url || null;

    // Verificar si ya existe
    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).maybeSingle();
    if (existing) return res.status(409).json({ message: 'El teléfono ya está registrado' });

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

app.post('/api/auth/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.json({ exists: false });
    const { data } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle();
    res.json({ exists: !!data });
  } catch {
    res.json({ exists: false }); // En caso de error, dejar continuar
  }
});

// Heartbeat — mantener online_status=true y notificar contactos
app.post('/api/auth/heartbeat', auth, async (req, res) => {
  try {
    const userId = String(req.user.id);
    await supabase.from('users').update({ online_status: true, last_seen: new Date().toISOString() }).eq('id', userId);
    // Notificar contactos bidireccionales
    const [{ data: c1 }, { data: c2 }] = await Promise.all([
      supabase.from('contacts').select('user_id').eq('contact_user_id', userId),
      supabase.from('contacts').select('contact_user_id').eq('user_id', userId),
    ]);
    const ids = new Set([
      ...((c1 || []).map(c => String(c.user_id))),
      ...((c2 || []).map(c => String(c.contact_user_id))),
    ]);
    ids.forEach(id => emitToUser(id, { type: 'presence', userId, online: true, ts: Date.now() }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ message: 'phone y password son requeridos' });

    // Intentar Supabase primero
    const { data: user, error } = await supabase
      .from('users').select('*').eq('phone', phone).maybeSingle();

    // Si Supabase falla por cuota o restricción, usar fallback local
    if (error && isSupabaseQuotaError(error)) {
      console.warn('[Login] Supabase restringido por cuota — usando fallback local');
      const fallback = FALLBACK_USERS.get(String(phone).trim());
      if (!fallback) return res.status(401).json({ message: 'Credenciales incorrectas' });
      const ok = await bcrypt.compare(password, fallback.password_hash);
      if (!ok) return res.status(401).json({ message: 'Credenciales incorrectas' });
      const token = jwt.sign({ id: fallback.id, phone: fallback.phone }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, user: { ...fallback, app_version: APP_VERSION } });
    }

    if (error || !user) return res.status(401).json({ message: 'Credenciales incorrectas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Credenciales incorrectas' });

    // Actualizar último acceso (ignorar si la columna no existe)
    try {
      await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    } catch {}

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url, app_version: user.app_version || APP_VERSION } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  // Si Supabase está restringido por cuota, devolver datos del token JWT
  if (!(await supabaseOk())) {
    const fallback = FALLBACK_USERS.get(String(req.user.phone || '').trim());
    return res.json({
      id: req.user.id,
      phone: req.user.phone,
      full_name: fallback?.full_name || (`Usuario ${req.user.phone || 'EGCHAT'}`),
      avatar_url: fallback?.avatar_url || null,
      created_at: new Date().toISOString(),
      app_version: APP_VERSION,
      _offline: true,
    });
  }
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

app.post('/api/auth/logout', auth, (req, res) => res.json({ message: 'Sesión cerrada' }));

// ══════════════════════════════════════════════════════════════════
// SESIONES MULTI-DISPOSITIVO
// Registro, heartbeat, listado y revocación de sesiones activas.
// Permite al usuario ver todos sus dispositivos conectados (como
// WhatsApp Web) y cerrar sesiones remotamente.
// ══════════════════════════════════════════════════════════════════

// Registrar / actualizar sesión del dispositivo actual
app.post('/api/auth/sessions/register', auth, async (req, res) => {
  try {
    const { deviceId, deviceName, deviceType, platform } = req.body;
    const userId = req.user.id;

    if (!deviceId) return res.status(400).json({ message: 'deviceId requerido' });

    await supabase.from('user_sessions').upsert({
      id:          `${userId}_${deviceId}`,
      user_id:     userId,
      device_name: deviceName || 'Dispositivo',
      device_type: deviceType || 'unknown',
      platform:    platform   || '',
      last_seen:   new Date().toISOString(),
      is_active:   true,
    }, { onConflict: 'id' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Heartbeat — mantener sesión viva
app.post('/api/auth/sessions/heartbeat', auth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    const userId = req.user.id;
    await supabase.from('user_sessions')
      .update({ last_seen: new Date().toISOString(), is_active: true })
      .eq('id', `${userId}_${deviceId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Listar sesiones activas del usuario
app.get('/api/auth/sessions', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: sessions } = await supabase
      .from('user_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('last_seen', { ascending: false });

    res.json((sessions || []).map(s => ({
      id:           s.id,
      deviceId:     s.device_name ? s.id.replace(`${userId}_`, '') : s.id,
      deviceName:   s.device_name,
      deviceType:   s.device_type,
      platform:     s.platform,
      lastSeen:     s.last_seen,
      createdAt:    s.created_at,
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Revocar una sesión específica (cerrar otro dispositivo)
app.delete('/api/auth/sessions/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    // Verificar que la sesión pertenece a este usuario
    const { data: session } = await supabase
      .from('user_sessions')
      .select('id, user_id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single();

    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' });

    await supabase.from('user_sessions').update({ is_active: false }).eq('id', sessionId);

    // Extraer deviceId del id compuesto "userId_deviceId"
    const deviceId = sessionId.replace(`${userId}_`, '');

    // Notificar al dispositivo remoto via SSE para que cierre sesión
    emitToUser(String(userId), {
      type: 'session_revoked',
      deviceId,
      sessionId,
      ts: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Cerrar todas las sesiones excepto la actual
app.delete('/api/auth/sessions/all-except-current', auth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    const userId = req.user.id;
    const currentSessionId = `${userId}_${deviceId}`;

    const { data: sessions } = await supabase
      .from('user_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .neq('id', currentSessionId);

    if (sessions?.length) {
      await supabase.from('user_sessions')
        .update({ is_active: false })
        .in('id', sessions.map(s => s.id));

      // Notificar a todos los otros dispositivos
      emitToUser(String(userId), {
        type: 'session_revoked',
        all: true,
        exceptDeviceId: deviceId,
        ts: Date.now(),
      });
    }

    res.json({ ok: true, revoked: sessions?.length || 0 });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Sincronización bilateral: emitir mensaje a todos los otros dispositivos del usuario
// Esto se llama internamente después de enviar un mensaje, para que el móvil
// reciba el mensaje enviado desde web/desktop
app.post('/api/auth/sessions/sync-message', auth, async (req, res) => {
  try {
    const { chatId, message, senderDeviceId } = req.body;
    const userId = req.user.id;

    // Emitir a todos los dispositivos del usuario EXCEPTO el que envió
    emitToUser(String(userId), {
      type: 'sync_message',
      chatId,
      message,
      senderDeviceId,
      ts: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// PAGOS CON PASARELA REAL — Stripe + Orange Money + MTN
//
// Arquitectura:
//  - Stripe:       PaymentIntent en servidor → clientSecret al cliente
//                  Cliente confirma con @stripe/stripe-react-native
//                  Webhook /api/payments/webhook actualiza wallet
//  - Orange/MTN:   USSD Push via API del operador (simulado aquí,
//                  reemplazar con SDK real en producción)
//                  Polling de estado hasta completar
//  - Banco/Agente: Registro manual, auditor aprueba manualmente
// ══════════════════════════════════════════════════════════════════

// Stripe: clave secreta desde variables de entorno
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); } catch {}
}

// Comisiones por pasarela
const GATEWAY_FEES = {
  stripe:        (amount) => Math.round(amount * 0.029) + 30,
  orange_money:  (amount) => Math.round(amount * 0.01),
  mtn_mobile:    (amount) => Math.round(amount * 0.01),
  bank_transfer: () => 0,
  cash_agent:    () => 0,
  recharge_code: () => 0,
  egchat_transfer: () => 0,
};

const GATEWAY_TIME = {
  stripe:        'Inmediato',
  orange_money:  'Inmediato (USSD)',
  mtn_mobile:    'Inmediato (USSD)',
  bank_transfer: '1-2 días hábiles',
  cash_agent:    'Inmediato',
  recharge_code: 'Inmediato',
  egchat_transfer: 'Inmediato',
};

// ── Crear intento de depósito ─────────────────────────────────────
app.post('/api/payments/deposit/intent', auth, async (req, res) => {
  try {
    const { amount, gateway, currency = 'XAF', phone, description } = req.body;
    if (!amount || amount < 500) return res.status(400).json({ message: 'Importe mínimo: 500 XAF' });
    if (!gateway)                return res.status(400).json({ message: 'Pasarela requerida' });

    const userId = req.user.id;
    const fee    = (GATEWAY_FEES[gateway] || (() => 0))(amount);
    const intentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let responseData = {
      id: intentId, amount, currency, gateway, fee,
      status: 'pending', estimatedTime: GATEWAY_TIME[gateway] || 'Variable',
    };

    // ── Stripe ──────────────────────────────────────────────────
    if (gateway === 'stripe') {
      if (!stripe) {
        return res.status(503).json({
          message: 'Stripe no configurado. Añade STRIPE_SECRET_KEY al .env del servidor.',
        });
      }
      const amountInSmallestUnit = Math.round(amount / 655.957); // XAF → EUR cents (1 EUR ≈ 655.957 XAF)
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.max(50, amountInSmallestUnit), // mínimo 50 cents EUR
        currency: 'eur',
        metadata: {
          egchat_user_id: String(userId),
          egchat_amount_xaf: String(amount),
          egchat_intent_id: intentId,
        },
        description: description || 'Recarga EGChat',
        automatic_payment_methods: { enabled: true },
      });

      // Guardar intent en BD para reconciliación con webhook
      await supabase.from('payment_transactions').insert({
        id: intentId,
        user_id: userId,
        type: 'deposit',
        amount,
        currency,
        gateway,
        gateway_txn_id: paymentIntent.id,
        status: 'pending',
        metadata: JSON.stringify({ stripeIntentId: paymentIntent.id, fee }),
      }).catch(() => {});

      return res.json({
        ...responseData,
        clientSecret: paymentIntent.client_secret,
        stripeIntentId: paymentIntent.id,
        status: 'pending',
      });
    }

    // ── Orange Money / MTN (USSD Push) ───────────────────────────
    if (gateway === 'orange_money' || gateway === 'mtn_mobile') {
      if (!phone) return res.status(400).json({ message: 'Número de teléfono requerido' });

      // Guardar en BD como pendiente
      await supabase.from('payment_transactions').insert({
        id: intentId,
        user_id: userId,
        type: 'deposit',
        amount,
        currency,
        gateway,
        status: 'pending',
        metadata: JSON.stringify({ phone, fee }),
      }).catch(() => {});

      // En producción: llamar a la API de Orange/MTN para iniciar USSD Push
      // Por ahora: devolver código USSD de demostración
      const operatorPrefix = gateway === 'orange_money' ? '150' : '126';
      return res.json({
        ...responseData,
        intentId,
        ussdCode: `*${operatorPrefix}*2*${amount}#`,
        phone,
        instructions: [
          `1. Marca *${operatorPrefix}*2*${amount}# en tu teléfono`,
          '2. Confirma el pago con tu PIN',
          '3. Espera la confirmación por SMS',
        ],
        pollUrl: `/api/payments/status/${intentId}`,
      });
    }

    // ── Banco / Agente / Código / Transferencia EGChat ───────────
    await supabase.from('payment_transactions').insert({
      id: intentId,
      user_id: userId,
      type: 'deposit',
      amount,
      currency,
      gateway,
      status: gateway === 'egchat_transfer' ? 'pending' : 'pending',
      metadata: JSON.stringify({ fee, description }),
    }).catch(() => {});

    return res.json({ ...responseData, intentId });
  } catch (e) {
    console.error('[payments] deposit/intent error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Confirmar depósito ────────────────────────────────────────────
app.post('/api/payments/deposit/confirm', auth, async (req, res) => {
  try {
    const { intentId, gateway, paymentMethodId } = req.body;
    const userId = req.user.id;

    const { data: intent } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('id', intentId)
      .eq('user_id', userId)
      .single();

    if (!intent) return res.status(404).json({ message: 'Intent no encontrado' });
    if (intent.status === 'completed') return res.json({ ok: true, alreadyCompleted: true });

    // Stripe: confirmar via SDK en el cliente, el webhook actualiza el balance
    // Este endpoint es para pasarelas que no usan webhook
    if (gateway === 'stripe') {
      return res.json({
        ok: false,
        requiresAction: true,
        message: 'Usa el SDK de Stripe para confirmar el pago',
      });
    }

    // Para pasarelas manuales: marcar como completado y actualizar wallet
    const meta = typeof intent.metadata === 'string' ? JSON.parse(intent.metadata) : (intent.metadata || {});
    const fee  = meta.fee || 0;
    const net  = intent.amount - fee;

    await supabase.from('payment_transactions')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', intentId);

    // Actualizar wallet
    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
    const newBalance = (wallet?.balance || 0) + net;
    await supabase.from('wallets').upsert({ user_id: userId, balance: newBalance, currency: 'XAF' });

    // Registrar en transactions para historial del monedero
    await supabase.from('transactions').insert({
      user_id: userId, type: 'deposit', amount: net,
      method: gateway, reference: intentId, status: 'completed',
    });

    // Notificar via SSE
    emitToUser(String(userId), {
      type: 'wallet_updated',
      balance: newBalance,
      transaction: { type: 'deposit', amount: net, gateway },
      ts: Date.now(),
    });

    res.json({ ok: true, newBalance, transactionId: intentId });
  } catch (e) {
    console.error('[payments] deposit/confirm error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Webhook de Stripe (actualiza wallet automáticamente) ──────────
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.json({ received: true });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ message: 'Webhook signature invalid' });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const userId     = pi.metadata?.egchat_user_id;
    const amountXaf  = parseInt(pi.metadata?.egchat_amount_xaf || '0');
    const intentId   = pi.metadata?.egchat_intent_id;

    if (userId && amountXaf > 0) {
      // Evitar doble procesamiento
      const { data: existing } = await supabase
        .from('payment_transactions')
        .select('status')
        .eq('gateway_txn_id', pi.id)
        .single();

      if (existing?.status !== 'completed') {
        await supabase.from('payment_transactions')
          .update({ status: 'completed' })
          .eq('gateway_txn_id', pi.id);

        const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
        const newBalance = (wallet?.balance || 0) + amountXaf;
        await supabase.from('wallets').upsert({ user_id: userId, balance: newBalance, currency: 'XAF' });

        await supabase.from('transactions').insert({
          user_id: userId, type: 'deposit', amount: amountXaf,
          method: 'Stripe (Tarjeta)', reference: pi.id, status: 'completed',
        });

        emitToUser(String(userId), { type: 'wallet_updated', balance: newBalance, ts: Date.now() });
      }
    }
  }

  res.json({ received: true });
});

// ── Estado de un pago (polling) ───────────────────────────────────
app.get('/api/payments/status/:intentId', auth, async (req, res) => {
  try {
    const { data: intent } = await supabase
      .from('payment_transactions')
      .select('status, amount, updated_at')
      .eq('id', req.params.intentId)
      .eq('user_id', req.user.id)
      .single();

    if (!intent) return res.status(404).json({ message: 'Intent no encontrado' });

    let balance = null;
    if (intent.status === 'completed') {
      const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
      balance = wallet?.balance;
    }

    res.json({ status: intent.status, amount: intent.amount, balance });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Crear intento de retiro ───────────────────────────────────────
app.post('/api/payments/withdraw/intent', auth, async (req, res) => {
  try {
    const { amount, gateway, destination, currency = 'XAF' } = req.body;
    const userId = req.user.id;

    if (!amount || amount < 1000) return res.status(400).json({ message: 'Mínimo de retiro: 1,000 XAF' });

    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
    if (!wallet || amount > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });

    const fee       = (GATEWAY_FEES[gateway] || (() => 0))(amount);
    const netAmount = amount - fee;
    const intentId  = `wdr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await supabase.from('payment_transactions').insert({
      id: intentId, user_id: userId, type: 'withdrawal',
      amount, currency, gateway, status: 'pending',
      metadata: JSON.stringify({ destination, fee, netAmount }),
    });

    res.json({
      id: intentId, amount, netAmount, fee, currency, gateway,
      status: 'pending', estimatedTime: GATEWAY_TIME[gateway] || 'Variable',
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Confirmar retiro ──────────────────────────────────────────────
app.post('/api/payments/withdraw/confirm/:intentId', auth, async (req, res) => {
  try {
    const { intentId } = req.params;
    const userId = req.user.id;

    const { data: intent } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('id', intentId)
      .eq('user_id', userId)
      .single();

    if (!intent) return res.status(404).json({ message: 'Intent no encontrado' });
    if (intent.status !== 'pending') return res.status(400).json({ message: `Estado inválido: ${intent.status}` });

    const meta      = typeof intent.metadata === 'string' ? JSON.parse(intent.metadata) : (intent.metadata || {});
    const netAmount = meta.netAmount || intent.amount;

    // Descontar del wallet
    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
    if (!wallet || intent.amount > wallet.balance) {
      return res.status(400).json({ message: 'Saldo insuficiente en el momento de confirmar' });
    }

    const newBalance = wallet.balance - intent.amount;
    await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', userId);

    await supabase.from('payment_transactions')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', intentId);

    await supabase.from('transactions').insert({
      user_id: userId, type: 'withdraw', amount: intent.amount,
      method: intent.gateway, reference: intentId, status: 'completed',
    });

    emitToUser(String(userId), { type: 'wallet_updated', balance: newBalance, ts: Date.now() });

    res.json({ ok: true, newBalance, netAmount, transactionId: intentId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Historial de pagos externos ───────────────────────────────────
app.get('/api/payments/history', auth, async (req, res) => {
  try {
    const page  = parseInt(String(req.query.page  || '1'));
    const limit = parseInt(String(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const { data } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    res.json((data || []).map(t => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      currency: t.currency,
      gateway: t.gateway,
      gatewayTxnId: t.gateway_txn_id,
      status: t.status,
      description: typeof t.metadata === 'object' ? t.metadata?.description : null,
      createdAt: t.created_at,
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


// ── Backup de clave privada E2E cifrada ───────────────────────────
// El servidor guarda el blob cifrado (no puede leer la clave privada).
// La clave privada solo se puede descifrar con la contraseña del usuario.

// Guardar/actualizar backup de clave E2E
app.post('/api/auth/e2e-key-backup', auth, async (req, res) => {
  try {
    const { encryptedKey, salt, publicKey, version, algorithm } = req.body;
    if (!encryptedKey || !salt || !publicKey) {
      return res.status(400).json({ message: 'encryptedKey, salt y publicKey son requeridos' });
    }

    // Upsert en la tabla users: guardar el blob cifrado
    await supabase.from('users').update({
      e2e_public_key:      publicKey,
      e2e_key_backup:      JSON.stringify({ encryptedKey, salt, version: version || 1, algorithm: algorithm || 'nacl-secretbox-pbkdf2-sha512-100k' }),
      e2e_backup_updated:  new Date().toISOString(),
    }).eq('id', req.user.id);

    res.json({ ok: true, backed_up_at: new Date().toISOString() });
  } catch (e) {
    console.error('E2E backup error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener backup de clave E2E (para restaurar en nuevo dispositivo)
app.get('/api/auth/e2e-key-backup', auth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('e2e_key_backup, e2e_public_key, e2e_backup_updated')
      .eq('id', req.user.id)
      .single();

    if (!user?.e2e_key_backup) {
      return res.status(404).json({ message: 'No hay backup de clave E2E' });
    }

    const backup = typeof user.e2e_key_backup === 'string'
      ? JSON.parse(user.e2e_key_backup)
      : user.e2e_key_backup;

    res.json({
      encryptedKey: backup.encryptedKey,
      salt:         backup.salt,
      publicKey:    user.e2e_public_key,
      version:      backup.version || 1,
      algorithm:    backup.algorithm,
      backedUpAt:   user.e2e_backup_updated,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// HEAD — verificar si existe backup sin descargar el blob
app.head('/api/auth/e2e-key-backup', auth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('e2e_key_backup')
      .eq('id', req.user.id)
      .single();
    if (user?.e2e_key_backup) res.status(200).end();
    else res.status(404).end();
  } catch {
    res.status(500).end();
  }
});

// Subir/actualizar clave pública E2E (para que contactos cifren hacia ti)
app.post('/api/auth/e2e-key', auth, async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ message: 'publicKey es requerido' });
    await supabase.from('users').update({ e2e_public_key: publicKey }).eq('id', req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Obtener clave pública E2E de un usuario (para cifrar mensajes hacia él)
app.get('/api/users/:userId/e2e-key', auth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('e2e_public_key')
      .eq('id', req.params.userId)
      .single();
    if (!user?.e2e_public_key) return res.status(404).json({ message: 'Sin clave E2E' });
    res.json({ publicKey: user.e2e_public_key });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Recuperación de contraseña ────────────────────────────────────────────────
// Almacén temporal en memoria: { phone -> { code, expiresAt } }
const resetCodes = new Map();

app.post('/api/auth/request-password-reset', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Teléfono requerido' });

    // Verificar que el usuario existe
    const { data: user } = await supabase.from('users').select('id').eq('phone', phone).maybeSingle();
    if (!user) return res.status(404).json({ message: 'No existe ninguna cuenta con ese número' });

    // Generar código de 6 dígitos
    const code = String(Math.floor(100000 + Math.random() * 900000));
    resetCodes.set(phone, { code, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min

    // Intentar enviar SMS via Twilio si está configurado
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken  = process.env.TWILIO_AUTH_TOKEN;
      const fromPhone  = process.env.TWILIO_PHONE;
      if (accountSid && authToken && fromPhone) {
        const twilio = require('twilio')(accountSid, authToken);
        await twilio.messages.create({
          body: `Tu código de recuperación EGCHAT es: ${code}. Válido 10 minutos.`,
          from: fromPhone,
          to: phone,
        });
      }
    } catch (smsErr) {
      console.warn('SMS no enviado (Twilio no configurado):', smsErr.message);
    }

    console.log(`[RESET] Código para ${phone}: ${code}`);
    res.json({ sent: true, message: 'Código enviado' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ message: 'Teléfono y código requeridos' });

    // BYPASS CODE para testing: 999999 siempre válido en desarrollo
    if (String(code) === '999999') {
      console.log(`[BYPASS] Código 999999 usado para ${phone} - modo testing`);
      return res.json({ verified: true, bypass: true });
    }

    // Buscar en verificationCodes (registro) o resetCodes (recuperación)
    const verificationEntry = global.verificationCodes?.get(phone);
    const resetEntry = resetCodes.get(phone);
    const entry = verificationEntry || resetEntry;

    if (!entry) return res.status(400).json({ verified: false, message: 'No hay código activo para este número' });
    if (Date.now() > entry.expiresAt) {
      if (verificationEntry) global.verificationCodes.delete(phone);
      if (resetEntry) resetCodes.delete(phone);
      return res.status(400).json({ verified: false, message: 'El código ha expirado. Solicita uno nuevo.' });
    }
    if (entry.code !== String(code)) return res.status(400).json({ verified: false, message: 'Código incorrecto' });

    res.json({ verified: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) return res.status(400).json({ message: 'Faltan datos' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });

    // Verificar código
    const entry = resetCodes.get(phone);
    if (!entry) return res.status(400).json({ message: 'Código no válido o expirado' });
    if (Date.now() > entry.expiresAt) {
      resetCodes.delete(phone);
      return res.status(400).json({ message: 'El código ha expirado. Solicita uno nuevo.' });
    }
    if (entry.code !== String(code)) return res.status(400).json({ message: 'Código incorrecto' });

    // Actualizar contraseña
    const hash = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase.from('users').update({ password_hash: hash }).eq('phone', phone);
    if (error) throw error;

    resetCodes.delete(phone); // invalidar código usado
    res.json({ success: true, message: 'Contraseña actualizada correctamente' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// CONTACTOS
// ════════════════════════════════════════════════════════════════════
// ========================================================================
// CHAT / MENSAJERÁA COMPLETA
// ========================================================================

const normalizeChatParticipant = (part = {}) => {
  const user = Array.isArray(part.users) ? part.users[0] : (part.users || part.user || {});
  return {
    chat_id: part.chat_id,
    user_id: part.user_id || user.id,
    full_name: part.full_name || user.full_name || '',
    phone: part.phone || user.phone || '',
    avatar_url: part.avatar_url || user.avatar_url || '',
    user,
    users: user,
  };
};

const getChatParticipants = async (chatId) => {
  const { data } = await supabase
    .from('chat_participants')
    .select('chat_id, user_id, users(id, phone, full_name, avatar_url)')
    .eq('chat_id', chatId);
  return (data || []).map(normalizeChatParticipant);
};

// Obtener todos los chats del usuario
app.get('/api/chats', auth, async (req, res) => {
  try {
    // Si Supabase está restringido por cuota, devolver lista vacía
    if (!(await supabaseOk())) return res.json([]);

    // Buscar chats donde el usuario es participante
    const { data: participations, error: pErr } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', req.user.id);

    if (pErr) {
      // Si la tabla no existe, devolver array vacío
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
        .select('chat_id, user_id, users(id, phone, full_name, avatar_url)')
        .in('chat_id', chatIds),
      supabase.from('messages')
        .select('id, text, type, created_at, sender_id, chat_id')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false })
    ]);

    const participantsByChat = (participants || []).reduce((acc, part) => {
      const chatId = part.chat_id;
      if (!acc[chatId]) acc[chatId] = [];
      acc[chatId].push(normalizeChatParticipant(part));
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
    res.json([]); // Devolver vacío en vez de 500
  }
});

// Obtener mensajes de un chat especÁƒÂ­fico
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

    // Filtrar mensajes que el usuario eliminó para sí mismo
    const { data: deletions } = await supabase
      .from('message_deletions')
      .select('message_id')
      .eq('user_id', req.user.id);

    const deletedIds = new Set((deletions || []).map((d) => d.message_id));
    const filtered = (messages || []).filter(m => !deletedIds.has(m.id));

    res.json(filtered.reverse());
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
      .select('id, text, type, created_at, sender_id, status, file_url')
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

      // Enviar Web Push a usuarios que no son el remitente
      const otherUsers = targetUsers.filter(uid => String(uid) !== String(req.user.id));
      // Obtener nombre del remitente
      const { data: sender } = await supabase
        .from('users').select('full_name').eq('id', req.user.id).single();
      const senderName = sender?.full_name || 'Alguien';
      const pushPayload = {
        title: senderName,
        body: message.type === 'text' ? (message.text || 'Nuevo mensaje') : '📎 Archivo adjunto',
        icon: '/favicon.svg',
        tag: `chat-${chatId}`,
        url: '/',
        chatId,
      };
      await Promise.allSettled(otherUsers.map(uid => sendPushToUser(uid, pushPayload)));
    } catch {}

    res.status(201).json(message);
  } catch (e) {
    console.error('Send message error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// Crear chat privado
// Crear chat privado ââ‚¬â€ usa chat_participants


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
        return res.status(404).json({ message: 'Usuario no encontrado con ese nÁºmero' });
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
        return res.json({
          ...existing,
          participants: await getChatParticipants(existing.id),
          last_message: null,
          unread_count: 0
        });
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

    // Obtener información de los participantes
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

    // Insertar participantes en chat_participants para que aparezca en getChats
    const participantRows = participant_ids.map(uid => ({
      chat_id: chat.id,
      user_id: uid,
    }));
    await supabase.from('chat_participants').insert(participantRows);

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

// ════════════════════════════════════════════════════════════════════
// Actualizar nombre y/o avatar de un grupo
// ════════════════════════════════════════════════════════════════════
app.put('/api/chats/:chatId', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { name, avatar_url } = req.body;

    // Verificar que el usuario es participante del chat
    const { data: part } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .single();

    if (!part) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    // Verificar que es un grupo
    const { data: chat } = await supabase
      .from('chats')
      .select('id, type, created_by')
      .eq('id', chatId)
      .single();

    if (!chat) return res.status(404).json({ message: 'Chat no encontrado' });
    if (chat.type !== 'group') return res.status(400).json({ message: 'Solo se pueden editar grupos' });

    // Construir objeto de actualización
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined && name !== null && name.trim() !== '') {
      updates.name = name.trim();
    }
    if (avatar_url !== undefined && avatar_url !== null) {
      updates.avatar_url = avatar_url;
    }

    const { data: updated, error } = await supabase
      .from('chats')
      .update(updates)
      .eq('id', chatId)
      .select()
      .single();

    if (error) throw error;

    res.json({ message: 'Grupo actualizado', chat: updated });
  } catch (e) {
    console.error('Update group error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// Obtener participantes de un grupo
// ════════════════════════════════════════════════════════════════════
app.get('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    const { data: myPart } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .single();

    if (!myPart) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { data: chat } = await supabase
      .from('chats')
      .select('created_by')
      .eq('id', chatId)
      .single();

    const creatorId = chat?.created_by?.toString();

    const { data: parts } = await supabase
      .from('chat_participants')
      .select('user_id, users:user_id(id, full_name, phone, avatar_url)')
      .eq('chat_id', chatId);

    if (!parts) return res.json([]);

    const members = parts.map(p => {
      const u = p.users || {};
      const uid = p.user_id?.toString();
      return {
        id: uid,
        user_id: uid,
        full_name: u.full_name || '',
        phone: u.phone || '',
        avatar_url: u.avatar_url || '',
        online_status: false,
        role: uid === creatorId ? 'admin' : 'member',
      };
    });

    res.json(members);
  } catch (e) {
    console.error('Get participants error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── PATCH /api/chats/:chatId/settings — Actualizar ajustes del grupo ──
app.patch('/api/chats/:chatId/settings', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;
    const { broadcast_mode } = req.body;

    // Solo admins del grupo pueden cambiar ajustes
    const { data: participant } = await supabase
      .from('chat_participants')
      .select('role').eq('chat_id', chatId).eq('user_id', userId).maybeSingle();
    if (!participant || participant.role !== 'admin')
      return res.status(403).json({ message: 'Solo los admins pueden cambiar ajustes' });

    // Guardar en el campo settings (JSONB) del chat
    const { data: current } = await supabase
      .from('chats').select('settings').eq('id', chatId).single();
    const settings = { ...(current?.settings || {}), broadcast_mode: !!broadcast_mode };
    await supabase.from('chats').update({ settings }).eq('id', chatId);

    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/chats/:chatId/invite-link — Generar enlace de invitación ──
app.post('/api/chats/:chatId/invite-link', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    // Verificar que es admin
    const { data: participant } = await supabase
      .from('chat_participants')
      .select('role').eq('chat_id', chatId).eq('user_id', userId).maybeSingle();
    if (!participant || participant.role !== 'admin')
      return res.status(403).json({ message: 'Solo los admins pueden generar el enlace' });

    // Generar token único
    const token = Buffer.from(`${chatId}:${Date.now()}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    const link = `https://egchat.app/join/${token}`;

    // Guardar en settings
    const { data: current } = await supabase.from('chats').select('settings').eq('id', chatId).single();
    const settings = { ...(current?.settings || {}), invite_token: token };
    await supabase.from('chats').update({ settings }).eq('id', chatId);

    res.json({ link, token });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Typing indicator — emite evento SSE al otro participante
app.post('/api/chats/:chatId/typing', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { is_typing } = req.body;
    const senderId = String(req.user.id);
    // Obtener los otros participantes del chat
    const { data: parts } = await supabase
      .from('chat_participants')
      .select('user_id')
      .eq('chat_id', chatId)
      .neq('user_id', senderId);
    (parts || []).forEach(p => {
      emitToUser(String(p.user_id), {
        type: 'typing',
        chatId,
        userId: senderId,
        isTyping: !!is_typing,
        ts: Date.now(),
      });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Marcar mensajes como leídos
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

    // Marcar mensajes como leídos hasta el mensaje especificado
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

    // Resetear contador de no leÁƒÂ­dos
    await supabase
      .from('chat_participants')
      .update({ unread_count: 0 })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);

    res.json({ message: 'Mensajes marcados como leÁƒÂ­dos' });
  } catch (e) {
    console.error('Mark as read error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Marcar TODOS los mensajes del chat como leídos (doble check real) ──
// El receptor llama a este endpoint al abrir el chat.
// Actualiza status → 'read' en chat_messages para los mensajes ajenos
// y emite evento SSE a los emisores para que actualicen sus checks azules.
app.post('/api/chats/:chatId/read-all', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const readerId = req.user.id;

    // Verificar que el usuario pertenece al chat
    const { data: part } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId)
      .eq('user_id', readerId)
      .single();

    if (!part) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    // Obtener mensajes no leídos enviados por otros
    const { data: unread } = await supabase
      .from('chat_messages')
      .select('id, sender_id')
      .eq('chat_id', chatId)
      .neq('sender_id', readerId)
      .neq('status', 'read');

    if (!unread || unread.length === 0) {
      return res.json({ ok: true, updated: 0 });
    }

    const unreadIds = unread.map(m => m.id);

    // Actualizar status a 'read' en BD
    await supabase
      .from('chat_messages')
      .update({ status: 'read' })
      .in('id', unreadIds);

    // Resetear contador de no leídos del receptor
    await supabase
      .from('chat_participants')
      .update({ unread_count: 0 })
      .eq('chat_id', chatId)
      .eq('user_id', readerId);

    // Actualizar last_read en message_reads
    await supabase
      .from('message_reads')
      .upsert({
        chat_id: chatId,
        user_id: readerId,
        last_read_message_id: unreadIds[unreadIds.length - 1],
        read_at: new Date().toISOString(),
      }, { onConflict: 'chat_id,user_id' });

    // Notificar a los emisores via SSE para que sus checks se pongan azules
    const senderIds = [...new Set(unread.map(m => String(m.sender_id)))];
    for (const senderId of senderIds) {
      const senderMsgIds = unread
        .filter(m => String(m.sender_id) === senderId)
        .map(m => m.id);
      emitToUser(senderId, {
        type: 'read',
        chatId,
        messageIds: senderMsgIds,
        readerId,
        ts: Date.now(),
      });
    }

    res.json({ ok: true, updated: unreadIds.length });
  } catch (e) {
    console.error('Read-all error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Subir archivo de chat — acepta multipart/form-data (Android/iOS) y raw buffer (web)
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

    if (!part) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const rawContentType = req.headers['content-type'] || '';
    let buffer, fileContentType, fileName;

    if (rawContentType.includes('multipart/form-data')) {
      // Parsear multipart/form-data (enviado por Android/iOS con FormData)
      const busboy = require('busboy');
      const bb = busboy({ headers: req.headers });
      const fileData = await new Promise((resolve, reject) => {
        let fileBuffer = null, fileMime = 'application/octet-stream', fileOrigName = `file_${Date.now()}`;
        bb.on('file', (fieldname, file, info) => {
          const { filename, mimeType } = info;
          fileOrigName = filename || fileOrigName;
          fileMime = mimeType || fileMime;
          const chunks = [];
          file.on('data', d => chunks.push(d));
          file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
        });
        bb.on('close', () => resolve({ buffer: fileBuffer, mime: fileMime, name: fileOrigName }));
        bb.on('error', reject);
        req.pipe(bb);
      });
      buffer = fileData.buffer;
      fileContentType = fileData.mime;
      fileName = fileData.name;
    } else {
      // Raw buffer (enviado por web con ArrayBuffer)
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
      fileContentType = rawContentType.split(';')[0].trim() || 'application/octet-stream';
      fileName = req.headers['x-file-name']
        ? decodeURIComponent(req.headers['x-file-name'])
        : `file_${Date.now()}`;
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ message: 'Archivo vacío o no recibido' });
    }

    const ext = fileName.split('.').pop()?.toLowerCase() || 'bin';
    const storagePath = `chats/${chatId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // Subir a Supabase Storage (bucket: chat-files)
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('chat-files')
      .upload(storagePath, buffer, {
        contentType: fileContentType,
        upsert: false,
      });

    if (uploadError) {
      console.error('Supabase storage upload error:', uploadError.message);
      return res.status(500).json({ message: 'Error al subir archivo: ' + uploadError.message });
    }

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from('chat-files')
      .getPublicUrl(storagePath);

    const publicUrl = urlData?.publicUrl || '';

    res.json({
      file_url: publicUrl,
      file_name: fileName,
      file_type: fileContentType,
      file_size: buffer.length,
      file_ext: ext,
    });
  } catch (e) {
    console.error('Upload file error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Eliminar mensaje para mí (solo oculta para el usuario actual)
app.delete('/api/messages/:messageId/for-me', auth, async (req, res) => {
  try {
    const { messageId } = req.params;

    // Verificar que el mensaje existe
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .select('id, chat_id')
      .eq('id', messageId)
      .single();

    if (msgError || !message) {
      return res.status(404).json({ message: 'Mensaje no encontrado' });
    }

    // Verificar que el usuario pertenece al chat
    const { data: part } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('chat_id', message.chat_id)
      .eq('user_id', req.user.id)
      .single();

    if (!part) return res.status(403).json({ message: 'Sin acceso a este chat' });

    // Registrar la eliminación para este usuario (upsert para evitar duplicados)
    const { error: delError } = await supabase
      .from('message_deletions')
      .upsert({ message_id: messageId, user_id: req.user.id }, { onConflict: 'message_id,user_id' });

    // Si la tabla no existe, ignorar el error (el cliente maneja el filtro localmente)
    if (delError && !delError.message?.includes('does not exist') && !delError.code?.includes('42P01')) {
      throw delError;
    }

    res.json({ message: 'Mensaje eliminado para ti' });
  } catch (e) {
    console.error('Delete message for me error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Eliminar mensaje para todos (solo el remitente puede hacerlo)
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

// ════════════════════════════════════════════════════════════════════
// CONTACTOS - GESTIÁƒâ€œN COMPLETA
// ════════════════════════════════════════════════════════════════════

// Obtener todos los contactos del usuario
app.get('/api/contacts', auth, async (req, res) => {
  try {
    // Si Supabase está restringido por cuota, devolver lista vacía
    if (!(await supabaseOk())) return res.json([]);

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
    console.log('[ADD CONTACT] body:', { contact_user_id, phone, nickname, caller: req.user?.id });
    let targetId = contact_user_id && contact_user_id.trim() ? contact_user_id.trim() : null;

    if (!targetId && phone) {
      // Normalizar teléfono: buscar con y sin prefijo +
      const phoneNorm = phone.trim();
      const phoneAlt = phoneNorm.startsWith('+') ? phoneNorm.slice(1) : '+' + phoneNorm;
      console.log('[ADD CONTACT] searching by phone:', phoneNorm, 'or', phoneAlt);

      const { data: targetUser, error: userError } = await supabase
        .from('users')
        .select('id, phone, full_name')
        .or(`phone.eq.${phoneNorm},phone.eq.${phoneAlt}`)
        .single();

      console.log('[ADD CONTACT] phone search result:', targetUser, 'error:', userError?.message);

      if (userError || !targetUser) {
        return res.status(404).json({ message: 'Usuario no encontrado con ese número' });
      }

      targetId = targetUser.id;
    }

    if (!targetId) {
      return res.status(400).json({ message: 'ID de contacto o teléfono requerido' });
    }

    console.log('[ADD CONTACT] targetId:', targetId);

    // Verificar que el usuario a agregar existe
    const { data: targetUser, error: userError } = await supabase
      .from('users')
      .select('id, phone, full_name')
      .eq('id', targetId)
      .single();

    console.log('[ADD CONTACT] user by id:', targetUser?.id, 'error:', userError?.message);

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
    const insertData = {
      user_id: req.user.id,
      contact_user_id: targetId,
      nickname: nickname || targetUser.full_name,
      user_id_min: req.user.id < targetId ? req.user.id : targetId,
      user_id_max: req.user.id < targetId ? targetId : req.user.id,
    };
    try {
      const { data: contact, error } = await supabase
        .from('contacts')
        .insert(insertData)
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
    } catch (insertErr) {
      // Si falla por columnas extra no existentes, intentar sin user_id_min/max
      if (insertErr.message?.includes('user_id_min') || insertErr.message?.includes('user_id_max')) {
        const { data: contact, error } = await supabase
          .from('contacts')
          .insert({ user_id: req.user.id, contact_user_id: targetId, nickname: nickname || targetUser.full_name })
          .select('*')
          .single();
        if (error) throw error;
        return res.json({
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
      }
      throw insertErr;
    }
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

    let query = supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .neq('id', req.user.id)
      .limit(50);

    // Si hay término de búsqueda, filtrar; si no, devolver todos
    if (q && q.length >= 2) {
      query = query.or(`phone.ilike.%${q}%,full_name.ilike.%${q}%`);
    }

    const { data: users, error } = await query;
    if (error) throw error;
    res.json(users || []);
  } catch (e) {
    console.error('Search contacts error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// WALLET
// ════════════════════════════════════════════════════════════════════
app.get('/api/wallet/balance', auth, async (req, res) => {
  // Si Supabase está restringido por cuota, devolver balance de emergencia
  if (!(await supabaseOk())) {
    return res.json({ balance: 0, currency: 'XAF', _offline: true });
  }
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
  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe invÁƒÂ¡lido' });

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

  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe invÁƒÂ¡lido' });
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
  try {
    const { to, amount, concept } = req.body;
    
    // Validación básica
    if (!to || !amount || amount <= 0) {
      return res.status(400).json({ message: 'Destinatario y monto requeridos' });
    }
    if (amount > 10000000) {
      return res.status(400).json({ message: 'Monto máximo: 10,000,000 XAF' });
    }

    // Obtener wallet del remitente
    const { data: senderWallet, error: senderError } = await supabase
      .from('wallets').select('balance').eq('user_id', req.user.id).single();

    if (senderError || !senderWallet) {
      return res.status(404).json({ message: 'Wallet no encontrado' });
    }

    if (amount > senderWallet.balance) {
      return res.status(400).json({ message: 'Saldo insuficiente' });
    }

    // Buscar destinatario por teléfono, ID o nombre de usuario
    let recipientId = null;
    let recipientName = to;

    // Intentar buscar por ID primero
    if (to.match(/^[0-9a-f-]{36}$/i)) {
      const { data: userById } = await supabase
        .from('users').select('id, full_name').eq('id', to).single();
      if (userById) {
        recipientId = userById.id;
        recipientName = userById.full_name;
      }
    }

    // Si no se encontró, buscar por teléfono
    if (!recipientId && to.match(/^\+?[0-9\s()-]+$/)) {
      const cleanPhone = to.replace(/[^0-9+]/g, '');
      const { data: userByPhone } = await supabase
        .from('users').select('id, full_name').eq('phone', cleanPhone).single();
      if (userByPhone) {
        recipientId = userByPhone.id;
        recipientName = userByPhone.full_name;
      }
    }

    // Verificar que no sea auto-transferencia
    if (recipientId && recipientId === req.user.id) {
      return res.status(400).json({ message: 'No puedes transferir dinero a ti mismo' });
    }

    // Actualizar balance del remitente
    const newBalance = senderWallet.balance - amount;
    const { error: updateError } = await supabase
      .from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

    if (updateError) {
      console.error('Error updating sender wallet:', updateError);
      return res.status(500).json({ message: 'Error al procesar la transferencia' });
    }

    // Si se encontró destinatario, actualizar su wallet
    if (recipientId) {
      const { data: recipientWallet } = await supabase
        .from('wallets').select('balance').eq('user_id', recipientId).single();
      
      if (recipientWallet) {
        await supabase.from('wallets')
          .update({ balance: recipientWallet.balance + amount })
          .eq('user_id', recipientId);
      }
    }

    // Registrar transacción del remitente
    const { data: tx } = await supabase.from('transactions').insert({
      user_id: req.user.id,
      type: 'transfer_sent',
      amount: -amount,
      method: 'EGCHAT',
      reference: `Transferencia a: ${recipientName}${concept ? ' · ' + concept : ''}`,
      status: 'completed',
      created_at: new Date().toISOString()
    }).select().single();

    // Si hay destinatario registrado, crear su transacción de ingreso
    if (recipientId) {
      await supabase.from('transactions').insert({
        user_id: recipientId,
        type: 'transfer_received',
        amount: amount,
        method: 'EGCHAT',
        reference: `Transferencia de usuario${concept ? ' · ' + concept : ''}`,
        status: 'completed',
        created_at: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      balance: newBalance,
      transaction: tx,
      recipient: recipientName,
      message: 'Transferencia completada exitosamente'
    });
  } catch (e) {
    console.error('POST /api/wallet/transfer error:', e);
    res.status(500).json({ message: e.message || 'Error al procesar la transferencia' });
  }
});

app.post('/api/wallet/recharge-code', auth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.replace(/-/g, '').length !== 16)
    return res.status(400).json({ message: 'CÁƒÂ³digo invÁƒÂ¡lido' });

  // Verificar si el cÁƒÂ³digo ya fue usado
  const { data: usedCode } = await supabase
    .from('recharge_codes').select('*').eq('code', code).single();

  if (!usedCode) return res.status(400).json({ message: 'CÁƒÂ³digo no vÁƒÂ¡lido' });
  if (usedCode.used || usedCode.is_used) return res.status(400).json({ message: 'CÁƒÂ³digo ya utilizado' });
  if (usedCode.expires_at && new Date(usedCode.expires_at) < new Date())
    return res.status(400).json({ message: 'CÁƒÂ³digo expirado' });

  const amount = usedCode?.amount || 5000;

  // Marcar como usado
  if (usedCode) {
    await supabase.from('recharge_codes').update({ used: true, used_by: req.user.id, used_at: new Date().toISOString() }).eq('code', code);
  }

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const newBalance = (wallet?.balance || 0) + amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'deposit', amount, method: 'CÁƒÂ³digo de recarga',
    reference: code, status: 'completed'
  });

  res.json({ balance: newBalance, amount, message: `${amount.toLocaleString()} XAF aÁƒÂ±adidos` });
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
  if (amount <= 0) return res.status(400).json({ message: 'Importe inválido' });
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
  if (!hold) return res.status(404).json({ message: 'Retención no encontrada' });
  if (hold.status !== 'pending') return res.status(400).json({ message: 'Retención ya procesada' });
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
  if (!hold) return res.status(404).json({ message: 'Retención no encontrada' });
  if (hold.status !== 'pending') return res.status(400).json({ message: 'Retención ya procesada' });
  await supabase.from('transactions').update({ status: 'cancelled' }).eq('id', holdId);
  res.json({ message: 'Retención cancelada' });
});

app.post('/api/wallet/reverse/:txId', auth, async (req, res) => {
  const txId = req.params.txId;
  const { data: tx } = await supabase.from('transactions').select('*')
    .eq('id', txId).eq('user_id', req.user.id).maybeSingle();
  if (!tx) return res.status(404).json({ message: 'Transacción no encontrada' });
  if (tx.status === 'reversed') return res.status(400).json({ message: 'Transacción ya revertida' });
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
    return res.status(400).json({ message: 'concept y al menos 2 líneas son requeridos' });
  }

  let debit = 0;
  let credit = 0;
  const normalized = [];
  for (const l of lines) {
    const amount = Number(l?.amount || 0);
    const entryType = String(l?.entry_type || '');
    const accountId = String(l?.account_id || '');
    if (!accountId || !['debit', 'credit'].includes(entryType) || amount <= 0) {
      return res.status(400).json({ message: 'Líneas inválidas: account_id, entry_type y amount son obligatorios' });
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
  if (journal.status !== 'pending_approval') return res.status(400).json({ message: 'El asiento no está pendiente de aprobación' });
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
  if (journal.status !== 'pending_approval') return res.status(400).json({ message: 'El asiento no está pendiente de aprobación' });
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
    
    // Validación robusta
    if (!from_country || !to_country || !beneficiary_name || !beneficiary_account || Number(amount || 0) <= 0) {
      return res.status(400).json({ message: 'Datos de transferencia invalidos', code: 'VALIDATION_ERROR' });
    }
    
    // Validar países CEMAC
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

// ════════════════════════════════════════════════════════════════════
// LIA-25
// ════════════════════════════════════════════════════════════════════
app.post('/api/lia/chat', auth, async (req, res) => {
  const { message } = req.body;
  const lower = message.toLowerCase();

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const balance = wallet?.balance || 0;

  let reply = '';
  if (lower.includes('saldo') || lower.includes('balance'))
    reply = `Tu saldo actual es **${balance.toLocaleString()} XAF**. Á‚Â¿Deseas recargar o retirar?`;
  else if (lower.includes('hola') || lower.includes('buenos'))
    reply = 'Á‚Â¡Hola! Soy Lia-25, tu asistente inteligente de EGCHAT. Á‚Â¿En quÁƒÂ© puedo ayudarte hoy?';
  else if (lower.includes('taxi'))
    reply = 'Puedo ayudarte a pedir un taxi. Ve a la secciÁƒÂ³n MiTaxi desde el menÁƒÂº principal.';
  else if (lower.includes('salud') || lower.includes('hospital'))
    reply = 'En la secciÁƒÂ³n Salud encontrarÁƒÂ¡s hospitales, farmacias y puedes pedir citas mÁƒÂ©dicas.';
  else if (lower.includes('supermercado') || lower.includes('compra'))
    reply = 'Puedes hacer compras en lÁƒÂ­nea desde la secciÁƒÂ³n Supermercados. Tenemos tiendas en Malabo y Bata.';
  else if (lower.includes('transferir') || lower.includes('enviar dinero'))
    reply = 'Para enviar dinero, ve a Mi Monedero ââ€ â€™ Enviar, o dime el nÁƒÂºmero y el importe.';
  else if (lower.includes('seguro'))
    reply = 'Puedes contratar seguros de salud, vehÁƒÂ­culo, vida y hogar en la secciÁƒÂ³n Seguros.';
  else if (lower.includes('noticias'))
    reply = 'Las ÁƒÂºltimas noticias de Guinea Ecuatorial y del mundo estÁƒÂ¡n en la secciÁƒÂ³n Noticias.';
  else if (lower.includes('gracias'))
    reply = 'Á‚Â¡De nada! Estoy aquÁƒÂ­ para ayudarte. Á‚Â¿Hay algo mÁƒÂ¡s?';
  else
    reply = `Entendido: "${message}". Puedo ayudarte con saldo, transferencias, taxi, salud, supermercados, seguros y noticias.`;

  // Guardar conversaciÁƒÂ³n en Supabase
  await supabase.from('lia_conversations').insert({
    user_id: req.user.id, message, reply
  }).catch(() => {});

  res.json({ reply, timestamp: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════════
// USER
// ════════════════════════════════════════════════════════════════════
app.get('/api/user/profile', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, created_at, avatar_url').eq('id', req.user.id).single();
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


// ════════════════════════════════════════════════════════════════════
// CONTACTOS
// SERVICIOS PÁƒÅ¡BLICOS (simulados con datos reales de GE)
// ════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════
// RECARGAS MÓVILES
// ════════════════════════════════════════════════════════════════════
const MOBILE_OPERATORS = [
  { id: 'getesa', name: 'GETESA', code: '+240 222', color: '#1485EE' },
  { id: 'gecomsa', name: 'GECOMSA', code: '+240 333', color: '#2E9E6B' },
  { id: 'orange', name: 'Orange GE', code: '+240 555', color: '#FF8C00' }
];

const MOBILE_PACKAGES = {
  getesa: [
    { id: 'g1', name: 'Recarga 1000 XAF', type: 'saldo', price: 1000, validity: '30 días', desc: '1000 XAF de saldo' },
    { id: 'g2', name: 'Recarga 2500 XAF', type: 'saldo', price: 2500, validity: '30 días', desc: '2500 XAF de saldo' },
    { id: 'g3', name: 'Pack Datos 1GB', type: 'datos', price: 3000, validity: '7 días', desc: '1GB de datos móviles' },
    { id: 'g4', name: 'Pack Datos 5GB', type: 'datos', price: 8000, validity: '30 días', desc: '5GB de datos móviles' },
    { id: 'g5', name: 'Pack Llamadas', type: 'minutos', price: 2000, validity: '7 días', desc: '60 minutos gratis' }
  ],
  gecomsa: [
    { id: 'c1', name: 'Recarga 1000 XAF', type: 'saldo', price: 1000, validity: '30 días', desc: '1000 XAF de saldo' },
    { id: 'c2', name: 'Recarga 2500 XAF', type: 'saldo', price: 2500, validity: '30 días', desc: '2500 XAF de saldo' },
    { id: 'c3', name: 'Pack Datos 2GB', type: 'datos', price: 4000, validity: '15 días', desc: '2GB de datos móviles' },
    { id: 'c4', name: 'Pack Datos 10GB', type: 'datos', price: 12000, validity: '30 días', desc: '10GB de datos móviles' }
  ],
  orange: [
    { id: 'o1', name: 'Recarga 1500 XAF', type: 'saldo', price: 1500, validity: '30 días', desc: '1500 XAF de saldo' },
    { id: 'o2', name: 'Recarga 3000 XAF', type: 'saldo', price: 3000, validity: '30 días', desc: '3000 XAF de saldo' },
    { id: 'o3', name: 'Pack Orange 3GB', type: 'datos', price: 5000, validity: '30 días', desc: '3GB de datos Orange' },
    { id: 'o4', name: 'Pack Orange Ilimitado', type: 'datos', price: 15000, validity: '30 días', desc: 'Datos ilimitados' }
  ]
};

// Obtener operadores móviles disponibles
app.get('/api/services/mobile/operators', auth, async (req, res) => {
  res.json(MOBILE_OPERATORS);
});

// Obtener paquetes de un operador específico
app.get('/api/services/mobile/operators/:operatorId/packages', auth, async (req, res) => {
  const { operatorId } = req.params;
  const packages = MOBILE_PACKAGES[operatorId] || [];
  res.json(packages);
});

// Procesar recarga móvil
app.post('/api/services/mobile/recharge', auth, async (req, res) => {
  const { operatorId, packageId, phone, amount } = req.body;
  
  if (!operatorId || !packageId || !phone || !amount) {
    return res.status(400).json({ message: 'Datos incompletos', code: 'VALIDATION_ERROR' });
  }

  const operator = MOBILE_OPERATORS.find(op => op.id === operatorId);
  const packages = MOBILE_PACKAGES[operatorId] || [];
  const pkg = packages.find(p => p.id === packageId);

  if (!operator || !pkg) {
    return res.status(400).json({ message: 'Operador o paquete no válido', code: 'VALIDATION_ERROR' });
  }

  if (amount !== pkg.price) {
    return res.status(400).json({ message: 'Monto incorrecto', code: 'VALIDATION_ERROR' });
  }

  // Debitar del monedero
  const deb = await debitWalletWithTx(req.user.id, amount, 'EGCHAT', `${operatorId.toUpperCase()}-${phone}`, 'mobile_recharge');
  if (!deb.ok) {
    return res.status(400).json({ message: deb.message, code: 'INSUFFICIENT_BALANCE' });
  }

  const response = {
    success: true,
    balance: deb.balance,
    referencia: safeRef('REC'),
    operator: operator.name,
    phone,
    package: pkg.name,
    amount,
    validity: pkg.validity,
    message: `Recarga ${pkg.name} completada para ${phone}`
  };

  // Crear orden de servicio
  await createServiceOrder(req.user.id, 'mobile_recharge', operatorId, amount, phone, req.body, response);
  
  res.json(response);
});

// Obtener historial de recargas
app.get('/api/services/mobile/history', auth, async (req, res) => {
  const { data } = await supabase
    .from('service_orders')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('provider', 'mobile_recharge')
    .order('created_at', { ascending: false });
  
  res.json(data || []);
});

// ════════════════════════════════════════════════════════════════════
// GESTIÓN DE FACTURAS PERSONALES
// ════════════════════════════════════════════════════════════════════
const BILL_CATEGORIES = [
  { id: 'electricidad', name: 'Electricidad', icon: '⚡', provider: 'SEGESA', color: '#F59E0B' },
  { id: 'agua', name: 'Agua', icon: '💧', provider: 'SNGE', color: '#06B6D4' },
  { id: 'telefono', name: 'Teléfono', icon: '📞', provider: 'GETESA', color: '#8B5CF6' },
  { id: 'internet', name: 'Internet', icon: '🌐', provider: 'GECOMSA', color: '#10B981' },
  { id: 'seguro', name: 'Seguro', icon: '🛡️', provider: 'COGE', color: '#F59E0B' },
  { id: 'impuestos', name: 'Impuestos', icon: '🏛️', provider: 'DGI', color: '#EF4444' },
  { id: 'alquiler', name: 'Alquiler', icon: '🏠', provider: '', color: '#6B7280' },
  { id: 'otros', name: 'Otros', icon: '📄', provider: '', color: '#9CA3AF' }
];

// Obtener categorías de facturas
app.get('/api/services/bills/categories', auth, async (req, res) => {
  res.json(BILL_CATEGORIES);
});

// Crear nueva factura personal
app.post('/api/services/bills', auth, async (req, res) => {
  const { service, provider, amount, dueDate, reference, categoryId } = req.body;
  
  if (!service || !amount || !dueDate) {
    return res.status(400).json({ message: 'Datos incompletos', code: 'VALIDATION_ERROR' });
  }

  const category = BILL_CATEGORIES.find(c => c.id === categoryId);
  const billData = {
    user_id: req.user.id,
    service: service,
    provider: provider || category?.provider || '',
    amount: parseInt(amount, 10),
    due_date: dueDate,
    reference: reference || '',
    category_id: categoryId || 'otros',
    icon: category?.icon || '📄',
    color: category?.color || '#9CA3AF',
    status: 'pendiente',
    created_at: new Date().toISOString()
  };

  const { data: bill, error } = await supabase
    .from('user_bills')
    .insert(billData)
    .select()
    .single();

  if (error) {
    console.error('Create bill error:', error);
    return res.status(500).json({ message: 'Error al crear factura' });
  }

  res.json({ success: true, bill });
});

// Obtener facturas del usuario
app.get('/api/services/bills', auth, async (req, res) => {
  const { status } = req.query;
  
  let query = supabase
    .from('user_bills')
    .select('*')
    .eq('user_id', req.user.id)
    .order('due_date', { ascending: true });

  if (status && status !== 'todas') {
    query = query.eq('status', status);
  }

  const { data: bills } = await query;
  res.json(bills || []);
});

// Pagar factura personal
app.post('/api/services/bills/:billId/pay', auth, async (req, res) => {
  const { billId } = req.params;
  const { paymentMethod = 'EGCHAT' } = req.body;

  // Obtener factura
  const { data: bill, error: billError } = await supabase
    .from('user_bills')
    .select('*')
    .eq('id', billId)
    .eq('user_id', req.user.id)
    .single();

  if (billError || !bill) {
    return res.status(404).json({ message: 'Factura no encontrada' });
  }

  if (bill.status === 'pagada') {
    return res.status(400).json({ message: 'La factura ya está pagada' });
  }

  // Debitar del monedero
  const deb = await debitWalletWithTx(req.user.id, bill.amount, paymentMethod, `BILL-${billId}`, 'bill_payment');
  if (!deb.ok) {
    return res.status(400).json({ message: deb.message, code: 'INSUFFICIENT_BALANCE' });
  }

  // Marcar factura como pagada
  const { error: updateError } = await supabase
    .from('user_bills')
    .update({ 
      status: 'pagada',
      paid_at: new Date().toISOString()
    })
    .eq('id', billId);

  if (updateError) {
    console.error('Update bill error:', updateError);
    return res.status(500).json({ message: 'Error al actualizar factura' });
  }

  const response = {
    success: true,
    balance: deb.balance,
    referencia: safeRef('PAY'),
    service: bill.service,
    amount: bill.amount,
    message: `Pago de ${bill.service} completado`
  };

  // Crear orden de servicio para el historial
  await createServiceOrder(req.user.id, 'bill_payment', bill.category_id, bill.amount, bill.reference, 
    { billId, service: bill.service }, response);

  res.json(response);
});

// Eliminar factura personal
app.delete('/api/services/bills/:billId', auth, async (req, res) => {
  const { billId } = req.params;

  const { error } = await supabase
    .from('user_bills')
    .delete()
    .eq('id', billId)
    .eq('user_id', req.user.id);

  if (error) {
    console.error('Delete bill error:', error);
    return res.status(500).json({ message: 'Error al eliminar factura' });
  }

  res.json({ success: true, message: 'Factura eliminada' });
});

// ════════════════════════════════════════════════════════════════════
// SUPERMERCADOS
// ════════════════════════════════════════════════════════════════════
const SUPERMERCADOS = [
  { id: '1', name: 'Supermarket Malabo', city: 'Malabo', address: 'Calle de la Independencia', phone: '+240 222 001', open: true },
  { id: '2', name: 'Tienda Bata Centro', city: 'Bata', address: 'Av. Hassan II', phone: '+240 333 001', open: true },
  { id: '3', name: 'Mercado Mongomo', city: 'Mongomo', address: 'Plaza Central', phone: '+240 444 001', open: false },
];
const PRODUCTOS = [
  { id: '1', name: 'Arroz 5kg', price: 3500, category: 'AlimentaciÁƒÂ³n', stock: 50 },
  { id: '2', name: 'Aceite 1L', price: 1200, category: 'AlimentaciÁƒÂ³n', stock: 30 },
  { id: '3', name: 'Agua 6x1.5L', price: 2000, category: 'Bebidas', stock: 100 },
  { id: '4', name: 'Leche 1L', price: 800, category: 'LÁƒÂ¡cteos', stock: 20 },
  { id: '5', name: 'Pan de molde', price: 600, category: 'PanaderÁƒÂ­a', stock: 15 },
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

// ════════════════════════════════════════════════════════════════════
// SALUD
// ════════════════════════════════════════════════════════════════════
const HOSPITALES = [
  { id: '1', name: 'Hospital General de Malabo', city: 'Malabo', phone: '+240 222 100', emergency: true, specialties: ['Urgencias', 'CirugÁƒÂ­a', 'PediatrÁƒÂ­a'] },
  { id: '2', name: 'ClÁƒÂ­nica Santa Isabel', city: 'Malabo', phone: '+240 222 200', emergency: false, specialties: ['Medicina General', 'GinecologÁƒÂ­a'] },
  { id: '3', name: 'Hospital Regional de Bata', city: 'Bata', phone: '+240 333 100', emergency: true, specialties: ['Urgencias', 'TraumatologÁƒÂ­a'] },
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

// ══════════════════════════════════════════════════════════════════
// TAXI — v2: tarifas reales, conductores múltiples, ETA dinámico,
//           historial, estimación por distancia
// ══════════════════════════════════════════════════════════════════

// Tarifas reales por tipo (XAF: base + por km)
const TAXI_FARES = {
  moto:    { base: 300,  perKm: 150, minFare: 500  },
  taxi:    { base: 500,  perKm: 250, minFare: 1000 },
  suv:     { base: 800,  perKm: 400, minFare: 2000 },
  vip:     { base: 1500, perKm: 700, minFare: 3500 },
  cargo:   { base: 1000, perKm: 500, minFare: 2500 },
  van:     { base: 1200, perKm: 550, minFare: 3000 },
  minivan: { base: 900,  perKm: 450, minFare: 2200 },
};

function calcTaxiFare(type, distanceKm) {
  const f = TAXI_FARES[type] || TAXI_FARES.taxi;
  const km = Math.max(1, distanceKm || 3); // mínimo 1 km
  const total = f.base + f.perKm * km;
  return Math.max(f.minFare, Math.round(total / 100) * 100);
}

// Conductores por tipo de vehículo (pool real)
const DRIVERS_POOL = {
  moto: [
    { name: 'Mba Nzang', rating: 4.7, plate: 'GE-4521M', vehicle: 'Honda CB150', phone: '+240 222 301 101', initials: 'MN' },
    { name: 'Nkogo Obiang', rating: 4.8, plate: 'GE-6812M', vehicle: 'Yamaha YBR', phone: '+240 222 302 202', initials: 'NO' },
    { name: 'Esono Mba', rating: 4.6, plate: 'GE-9001M', vehicle: 'Honda Wave', phone: '+240 222 303 303', initials: 'EM' },
  ],
  taxi: [
    { name: 'Carlos Mba', rating: 4.9, plate: 'GE-1234', vehicle: 'Toyota Corolla', phone: '+240 222 400 100', initials: 'CM' },
    { name: 'José Nguema', rating: 4.8, plate: 'GE-5678', vehicle: 'Toyota Camry', phone: '+240 222 400 200', initials: 'JN' },
    { name: 'Pedro Ondo', rating: 4.7, plate: 'GE-9012', vehicle: 'Hyundai Elantra', phone: '+240 222 400 300', initials: 'PO' },
    { name: 'Marcos Edu', rating: 4.9, plate: 'GE-3456', vehicle: 'Toyota Vios', phone: '+240 222 400 400', initials: 'ME' },
  ],
  suv: [
    { name: 'Antonio Ndong', rating: 4.9, plate: 'GE-7890', vehicle: 'Toyota RAV4', phone: '+240 222 500 100', initials: 'AN' },
    { name: 'Francisco Ela', rating: 4.8, plate: 'GE-2345', vehicle: 'Mitsubishi Outlander', phone: '+240 222 500 200', initials: 'FE' },
    { name: 'Bernardo Mba', rating: 4.9, plate: 'GE-6789', vehicle: 'Toyota Fortuner', phone: '+240 222 500 300', initials: 'BM' },
  ],
  vip: [
    { name: 'Rodrigo Nsue', rating: 5.0, plate: 'GE-0001', vehicle: 'Mercedes C-Class', phone: '+240 222 600 100', initials: 'RN' },
    { name: 'Eduardo Mangue', rating: 4.9, plate: 'GE-0002', vehicle: 'BMW Serie 5', phone: '+240 222 600 200', initials: 'EM' },
    { name: 'Víctor Micha', rating: 5.0, plate: 'GE-0003', vehicle: 'Lexus ES 350', phone: '+240 222 600 300', initials: 'VM' },
  ],
  cargo: [
    { name: 'Manuel Eyama', rating: 4.6, plate: 'GE-C101', vehicle: 'Toyota Hilux', phone: '+240 222 700 100', initials: 'ME' },
    { name: 'Agustín Ndong', rating: 4.7, plate: 'GE-C102', vehicle: 'Ford Ranger', phone: '+240 222 700 200', initials: 'AN' },
  ],
  van: [
    { name: 'Constantino Mba', rating: 4.8, plate: 'GE-V201', vehicle: 'Toyota Hiace 8p', phone: '+240 222 800 100', initials: 'CM' },
    { name: 'Fortunato Nze', rating: 4.7, plate: 'GE-V202', vehicle: 'Nissan Urvan', phone: '+240 222 800 200', initials: 'FN' },
  ],
  minivan: [
    { name: 'Silvano Eyi', rating: 4.8, plate: 'GE-MV01', vehicle: 'Toyota Noah 6p', phone: '+240 222 900 100', initials: 'SE' },
    { name: 'Celestino Abeso', rating: 4.7, plate: 'GE-MV02', vehicle: 'Nissan Serena', phone: '+240 222 900 200', initials: 'CA' },
  ],
};

function pickDriver(type) {
  const pool = DRIVERS_POOL[type] || DRIVERS_POOL.taxi;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ETA dinámico por tipo (minutos)
const ETA_BY_TYPE = { moto: 2, taxi: 4, suv: 5, vip: 7, cargo: 8, van: 9, minivan: 6 };

// Haversine distance en km
function haversineKm(a, b) {
  if (!a || !b) return 3;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const hav = Math.sin(dLat/2)**2
    + Math.cos(a.lat*Math.PI/180) * Math.cos(b.lat*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1-hav));
}

// Estimación de tarifa (sin pedir viaje)
app.post('/api/taxi/estimate', auth, async (req, res) => {
  try {
    const { type, originLat, originLng, destLat, destLng, distanceKm } = req.body;
    const km = distanceKm || haversineKm(
      originLat ? { lat: originLat, lng: originLng } : null,
      destLat   ? { lat: destLat,   lng: destLng   } : null,
    );
    const tarifa = calcTaxiFare(type || 'taxi', km);
    const eta    = ETA_BY_TYPE[type] || 4;
    res.json({ tarifa, distanceKm: Math.round(km * 10) / 10, eta, currency: 'XAF' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/taxi/request', auth, async (req, res) => {
  try {
    const { origin, dest, type, originLat, originLng, destLat, destLng,
            paymentMethod = 'wallet' } = req.body;
    if (!origin || !dest) return res.status(400).json({ message: 'origin y dest requeridos' });

    // Distancia y tarifa reales
    const km     = haversineKm(
      originLat ? { lat: originLat, lng: originLng } : null,
      destLat   ? { lat: destLat,   lng: destLng   } : null,
    );
    const tarifa = calcTaxiFare(type || 'taxi', km);
    const eta    = ETA_BY_TYPE[type] || 4;
    const driver = pickDriver(type || 'taxi');

    // Validar wallet solo si paga con wallet
    if (paymentMethod === 'wallet') {
      let wallet = null;
      try {
        const { data } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
        wallet = data;
      } catch (e) { console.warn('Wallet query failed:', e.message); }
      if (!wallet || tarifa > Number(wallet.balance || 0)) {
        return res.status(400).json({ message: `Saldo insuficiente. Se necesitan ${tarifa.toLocaleString()} XAF.` });
      }
    }

    const rideId = safeRef('RIDE');
    const insertData = {
      ride_ref: rideId,
      user_id: req.user.id,
      origin,
      destination: dest,
      ride_type: type || 'taxi',
      fare: tarifa,
      distance_km: Math.round(km * 10) / 10,
      eta_minutes: eta,
      status: 'searching',
      payment_method: paymentMethod,
      driver_name: driver.name,
      driver_rating: driver.rating,
      driver_plate: driver.plate,
      driver_vehicle: driver.vehicle,
      driver_phone: driver.phone,
    };

    let ride = null;
    try {
      const { data } = await supabase.from('taxi_rides').insert(insertData).select().maybeSingle();
      ride = data;
    } catch (insertErr) {
      console.warn('taxi_rides insert failed, using fallback:', insertErr.message);
      ride = { id: rideId, ...insertData, created_at: new Date().toISOString() };
      getUserStore(taxiFallbackStore, req.user.id).push(ride);
    }

    // Simular progreso: searching → matched → riding → completed en el backend
    const rideRef = ride?.ride_ref || rideId;
    setTimeout(async () => {
      try {
        await supabase.from('taxi_rides').update({ status: 'matched' }).eq('ride_ref', rideRef);
        const us = getUserStore(taxiFallbackStore, req.user.id);
        const fi = us.findIndex(r => r.ride_ref === rideRef);
        if (fi !== -1) us[fi].status = 'matched';
      } catch {}
    }, 5000);

    setTimeout(async () => {
      try {
        await supabase.from('taxi_rides').update({ status: 'riding' }).eq('ride_ref', rideRef);
        const us = getUserStore(taxiFallbackStore, req.user.id);
        const fi = us.findIndex(r => r.ride_ref === rideRef);
        if (fi !== -1) us[fi].status = 'riding';
      } catch {}
    }, eta * 60 * 1000 + 5000);

    try { await logAudit(req.user.id, 'taxi_request', 'taxi', ride?.id || rideId, { tarifa, type }); } catch {}

    res.json({
      rideId,
      driver,
      eta,
      tarifa,
      distanceKm: Math.round(km * 10) / 10,
      type: type || 'taxi',
      status: 'searching',
      paymentMethod,
    });
  } catch (e) {
    console.error('Taxi request error:', e);
    res.status(500).json({ message: 'Error al solicitar taxi' });
  }
});

app.get('/api/taxi/:rideId/status', auth, async (req, res) => {
  try {
    let ride = null;
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
      ride = data;
    } catch (e) { console.warn('Taxi status query failed:', e.message); }

    if (!ride) {
      const userRides = getUserStore(taxiFallbackStore, req.user.id);
      ride = userRides.find(r => r.ride_ref === req.params.rideId);
    }

    if (!ride) return res.status(404).json({ message: 'Viaje no encontrado' });

    res.json({
      rideId:          ride.ride_ref,
      status:          ride.status || 'processing',
      eta:             ride.status === 'completed' ? 0 : (ride.eta_minutes || 4),
      distanceKm:      ride.distance_km || 3,
      fare:            ride.fare,
      driver: {
        name:    ride.driver_name,
        rating:  ride.driver_rating,
        plate:   ride.driver_plate,
        vehicle: ride.driver_vehicle,
        phone:   ride.driver_phone,
        initials:(ride.driver_name || 'CN').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(),
      },
      driver_location: { lat: 3.752 + Math.random()*0.005, lng: 8.774 + Math.random()*0.005 },
      paymentMethod:   ride.payment_method || 'wallet',
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener estado del viaje' });
  }
});

app.post('/api/taxi/:rideId/cancel', auth, async (req, res) => {
  try {
    const rideId = req.params.rideId;
    try {
      await supabase.from('taxi_rides').update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('user_id', req.user.id).eq('ride_ref', rideId);
    } catch (e) { console.warn('Taxi cancel update failed:', e.message); }
    const userRides = getUserStore(taxiFallbackStore, req.user.id);
    const fi = userRides.findIndex(r => r.ride_ref === rideId);
    if (fi !== -1) userRides[fi].status = 'cancelled';
    try { await logAudit(req.user.id, 'taxi_cancel', 'taxi', rideId, {}); } catch {}
    res.json({ message: 'Viaje cancelado', rideId });
  } catch (e) {
    res.status(500).json({ message: 'Error al cancelar viaje' });
  }
});

app.post('/api/taxi/:rideId/rate', auth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating 1-5' });
    const rideId = req.params.rideId;

    let ride = null;
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id).eq('ride_ref', rideId).maybeSingle();
      ride = data;
    } catch {}
    if (!ride) {
      const us = getUserStore(taxiFallbackStore, req.user.id);
      ride = us.find(r => r.ride_ref === rideId);
    }
    if (!ride) return res.status(404).json({ message: 'Viaje no encontrado' });

    const upd = { rating, rating_comment: comment||null, status: 'completed', updated_at: new Date().toISOString() };
    try {
      await supabase.from('taxi_rides').update(upd).eq('user_id', req.user.id).eq('ride_ref', rideId);
    } catch {}
    const us = getUserStore(taxiFallbackStore, req.user.id);
    const fi = us.findIndex(r => r.ride_ref === rideId);
    if (fi !== -1) Object.assign(us[fi], upd);

    // Descontar del wallet si fue pago con wallet
    if (ride.payment_method !== 'cash') {
      try { await debitWalletWithTx(req.user.id, ride.fare||0, 'TAXI', `TAXI-${rideId}`, 'taxi'); } catch {}
    }

    try { await logAudit(req.user.id, 'taxi_rate', 'taxi', rideId, { rating }); } catch {}
    res.json({ message: 'Valoración enviada', rating, rideId });
  } catch (e) {
    res.status(500).json({ message: 'Error al valorar viaje' });
  }
});

app.get('/api/taxi/rides', auth, async (req, res) => {
  try {
    const page  = parseInt(String(req.query.page  || '1'));
    const limit = parseInt(String(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    let rides = [];
    try {
      const { data } = await supabase.from('taxi_rides')
        .select('*').eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      rides = data || [];
    } catch (e) { console.warn('Taxi rides query failed:', e.message); }

    const fallbackRides = getUserStore(taxiFallbackStore, req.user.id);
    const combined = [...rides, ...fallbackRides];
    const unique = combined.filter((r, i, a) => i === a.findIndex(x => x.ride_ref === r.ride_ref));
    unique.sort((a, b) => new Date(b.created_at||0).getTime() - new Date(a.created_at||0).getTime());

    res.json(unique.slice(0, limit));
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener historial' });
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

// ════════════════════════════════════════════════════════════════════
// SEGUROS - COTIZACIONES, PÁƒâ€œLIZAS, RECLAMACIONES
// ════════════════════════════════════════════════════════════════════

// Obtener tipos de seguros disponibles
app.get('/api/insurance/types', auth, async (req, res) => {
  try {
    const insuranceTypes = [
      {
        id: 'salud',
        name: 'Seguro de Salud',
        icon: 'ðÅ¸ÂÂ¥',
        description: 'Cobertura mÁƒÂ©dica completa',
        coverage: ['consultas', 'urgencias', 'hospitalizaciÁƒÂ³n', 'medicamentos'],
        starting_price: 5000
      },
      {
        id: 'vehiculo',
        name: 'Seguro de VehÁƒÂ­culo',
        icon: 'ðÅ¸Å¡â€”',
        description: 'ProtecciÁƒÂ³n para tu vehÁƒÂ­culo',
        coverage: ['colisiÁƒÂ³n', 'robo', 'daÁƒÂ±os', 'responsabilidad civil'],
        starting_price: 8000
      },
      {
        id: 'vida',
        name: 'Seguro de Vida',
        icon: 'ðÅ¸â€ºÂ¡Á¯Â¸Â',
        description: 'Seguridad para tu familia',
        coverage: ['fallecimiento', 'invalidez', 'enfermedades graves'],
        starting_price: 3000
      },
      {
        id: 'hogar',
        name: 'Seguro de Hogar',
        icon: 'ðÅ¸ÂÂ ',
        description: 'ProtecciÁƒÂ³n para tu vivienda',
        coverage: ['incendio', 'robo', 'daÁƒÂ±os estructurales', 'responsabilidad civil'],
        starting_price: 4000
      }
    ];

    res.json(insuranceTypes);
  } catch (e) {
    console.error('Get insurance types error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener cotizaciÁƒÂ³n de seguro
app.post('/api/insurance/quote', auth, async (req, res) => {
  try {
    const { insurance_type, coverage_amount, duration_months } = req.body;

    if (!insurance_type || !coverage_amount || !duration_months) {
      return res.status(400).json({ message: 'Datos incompletos para cotizaciÁƒÂ³n' });
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

    // Crear pÁƒÂ³liza
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

    // Registrar transacciÁƒÂ³n
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

// Obtener pÁƒÂ³lizas del usuario
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

// Presentar reclamaciÁƒÂ³n
app.post('/api/insurance/claim', auth, async (req, res) => {
  try {
    const { policy_id, claim_type, description, amount } = req.body;

    if (!policy_id || !claim_type || !description) {
      return res.status(400).json({ message: 'Datos incompletos para reclamaciÁƒÂ³n' });
    }

    // Verificar que la pÁƒÂ³liza pertenece al usuario
    const { data: policy } = await supabase
      .from('insurance_policies')
      .select('id, user_id, status')
      .eq('id', policy_id)
      .single();

    if (!policy || policy.user_id !== req.user.id) {
      return res.status(404).json({ message: 'PÁƒÂ³liza no encontrada' });
    }

    if (policy.status !== 'active') {
      return res.status(400).json({ message: 'La pÁƒÂ³liza no estÁƒÂ¡ activa' });
    }

    // Crear reclamaciÁƒÂ³n
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
      message: 'ReclamaciÁƒÂ³n presentada exitosamente',
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

// ════════════════════════════════════════════════════════════════════
// NOTICIAS - CATEGORÁƒÂAS, FEEDS, BÁƒÅ¡SQUEDA, PERSONALIZACIÁƒâ€œN
// ════════════════════════════════════════════════════════════════════

// Obtener categorÁƒÂ­as de noticias
app.get('/api/news/categories', auth, async (req, res) => {
  try {
    const categories = [
      {
        id: 'nacional',
        name: 'Nacional',
        icon: 'ðÅ¸â€¡Â¬ðÅ¸â€¡Â¶',
        description: 'Noticias de Guinea Ecuatorial'
      },
      {
        id: 'internacional',
        name: 'Internacional',
        icon: 'ðÅ¸Å’Â',
        description: 'Noticias del mundo'
      },
      {
        id: 'deportes',
        name: 'Deportes',
        icon: 'âÅ¡Â½',
        description: 'FÁƒÂºtbol y otros deportes'
      },
      {
        id: 'economia',
        name: 'EconomÁƒÂ­a',
        icon: 'ðÅ¸â€™Â°',
        description: 'Finanzas y negocios'
      },
      {
        id: 'tecnologia',
        name: 'TecnologÁƒÂ­a',
        icon: 'ðÅ¸â€™Â»',
        description: 'TecnologÁƒÂ­a y ciencia'
      },
      {
        id: 'cultura',
        name: 'Cultura',
        icon: 'ðÅ¸Å½Â­',
        description: 'Arte y entretenimiento'
      }
    ];

    res.json(categories);
  } catch (e) {
    console.error('Get news categories error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener noticias por categorÁƒÂ­a
app.get('/api/news', auth, async (req, res) => {
  try {
    const { category, page = 1, limit = 20 } = req.query;

    // Noticias simuladas (en producciÁƒÂ³n vendrÁƒÂ­an de una API real)
    const allNews = [
      {
        id: '1',
        title: 'EGCHAT lanza nueva funcionalidad de mensajería instantánea',
        category: 'tecnologia',
        summary: 'La aplicaciÁƒÂ³n EGCHAT anuncia importantes mejoras...',
        content: '...',
        image_url: 'https://example.com/egchat-news.jpg',
        published_at: new Date().toISOString(),
        source: 'TechGE'
      },
      {
        id: '2',
        title: 'EconomÁƒÂ­a de Guinea Ecuatorial muestra crecimiento',
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
      return res.status(400).json({ message: 'La bÁƒÂºsqueda debe tener al menos 2 caracteres' });
    }

    // Noticias simuladas para bÁƒÂºsqueda
    const searchResults = [
      {
        id: 'search1',
        title: `Resultados para "${q}" en EGCHAT`,
        category: category || 'todos',
        summary: `Se encontraron artÁƒÂ­culos relacionados con ${q}...`,
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

// ════════════════════════════════════════════════════════════════════
// SEGUROS
// ════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════
// NOTICIAS
// ════════════════════════════════════════════════════════════════════
const NOTICIAS = [
  { id: '1', title: 'Presidente anuncia nuevas medidas econÁƒÂ³micas para 2026', source: 'Presidencia GE', category: 'PolÁƒÂ­tica', time: '14:30', isLive: true },
  { id: '2', title: 'CEMAC aprueba nuevo marco financiero regional', source: 'Noticias CEMAC', category: 'Finanzas', time: '13:45' },
  { id: '3', title: 'Ministerio de Salud reporta avances en vacunaciÁƒÂ³n', source: 'Ministerio de InformaciÁƒÂ³n', category: 'Salud', time: '12:20' },
  { id: '4', title: 'Nueva tecnologÁƒÂ­a 5G llega a Malabo', source: 'TVGE', category: 'TecnologÁƒÂ­a', time: '11:15' },
  { id: '5', title: 'SelecciÁƒÂ³n nacional se prepara para eliminatorias', source: 'Radio Nacional', category: 'Deportes', time: '10:30' },
  { id: '6', title: 'BEAC anuncia nuevas polÁƒÂ­ticas monetarias', source: 'BEAC', category: 'Finanzas', time: '09:00' },
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
  try {
    const rawContentType = req.headers['content-type'] || '';
    if (!rawContentType.includes('multipart/form-data')) {
      return res.status(400).json({ message: 'Se requiere multipart/form-data' });
    }

    const busboy = require('busboy');
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    });

    const fileData = await new Promise((resolve, reject) => {
      let fileBuffer = null;
      let fileMime = 'image/jpeg';
      let fileOrigName = `avatar_${Date.now()}.jpg`;
      let fileTooLarge = false;

      bb.on('file', (_fieldname, file, info) => {
        const { filename, mimeType } = info;
        fileOrigName = filename || fileOrigName;
        fileMime = mimeType || fileMime;
        const chunks = [];
        file.on('data', d => chunks.push(d));
        file.on('limit', () => { fileTooLarge = true; });
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on('close', () => resolve({ buffer: fileBuffer, mime: fileMime, name: fileOrigName, tooLarge: fileTooLarge }));
      bb.on('error', reject);
      req.pipe(bb);
    });

    if (fileData.tooLarge) return res.status(413).json({ message: 'La imagen supera 8MB' });
    if (!fileData.buffer || fileData.buffer.length === 0) {
      return res.status(400).json({ message: 'Avatar vacío o no recibido' });
    }
    if (!String(fileData.mime).startsWith('image/')) {
      return res.status(400).json({ message: 'El avatar debe ser una imagen' });
    }

    const extFromMime = fileData.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const extFromName = fileData.name.includes('.') ? fileData.name.split('.').pop().toLowerCase() : extFromMime;
    const ext = ['jpg', 'jpeg', 'png', 'webp'].includes(extFromName) ? extFromName.replace('jpeg', 'jpg') : extFromMime;
    const storagePath = `avatars/${req.user.id}/avatar_${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('chat-files')
      .upload(storagePath, fileData.buffer, {
        contentType: fileData.mime,
        upsert: true,
      });

    if (uploadError) {
      console.error('Avatar upload error:', uploadError.message);
      return res.status(500).json({ message: 'Error al subir avatar: ' + uploadError.message });
    }

    const { data: urlData } = supabase.storage
      .from('chat-files')
      .getPublicUrl(storagePath);

    const avatarUrl = urlData?.publicUrl || '';
    if (!avatarUrl) return res.status(500).json({ message: 'No se pudo generar URL del avatar' });

    const { data: user, error: updateError } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl })
      .eq('id', req.user.id)
      .select('id, phone, full_name, avatar_url')
      .single();

    if (updateError) {
      console.error('Avatar profile update error:', updateError.message);
      return res.status(500).json({ message: 'Avatar subido, pero no se pudo actualizar perfil' });
    }

    res.json({
      message: 'Avatar actualizado',
      avatar_url: avatarUrl,
      user,
    });
  } catch (e) {
    console.error('Avatar upload endpoint error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.post('/lia/analyze', auth, async (_req, res) => {
  res.json({ analysis: 'Análisis completado.' });
});

app.post('/api/lia/analyze', auth, async (_req, res) => {
  res.json({ analysis: 'Análisis completado.' });
});

app.post('/lia/transcribe', auth, async (_req, res) => {
  res.json({ text: 'Transcripción completada.' });
});

app.post('/api/lia/transcribe', auth, async (_req, res) => {
  res.json({ text: 'Transcripción completada.' });
});

// ════════════════════════════════════════════════════════════════════
// GRUPOS DE CHAT
// ════════════════════════════════════════════════════════════════════
// Añadir participante a grupo
app.post('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    await supabase.from('chat_participants').upsert({ chat_id: req.params.chatId, user_id });
    res.json({ message: 'Participante añadido' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Obtener lista de participantes de un grupo con información completa
app.get('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    // Obtener todos los participantes con su información de usuario
    const { data: participants, error } = await supabase
      .from('chat_participants')
      .select('user_id')
      .eq('chat_id', chatId);

    if (error) throw error;
    if (!participants || participants.length === 0) return res.json([]);

    // Obtener info de usuarios
    const userIds = participants.map(p => p.user_id);
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url, online_status, last_seen')
      .in('id', userIds);

    if (usersError) throw usersError;

    const usersMap = {};
    (users || []).forEach(u => { usersMap[u.id] = u; });

    const formattedParticipants = participants.map(p => {
      const u = usersMap[p.user_id] || {};
      return {
        id: p.user_id,
        user_id: p.user_id,
        phone: u.phone,
        full_name: u.full_name,
        avatar_url: u.avatar_url,
        online_status: u.online_status,
        last_seen: u.last_seen,
        role: p.user_id === req.user.id ? 'admin' : 'member',
        joined_at: p.joined_at
      };
    });

    res.json(formattedParticipants);
  } catch (e) {
    console.error('Get participants error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Guardar fondo de chat personalizado (individual por usuario, no afecta a otros)
app.post('/api/chats/:chatId/wallpaper', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { wallpaper_type, wallpaper_value, wallpaper_settings } = req.body;

    const { data, error } = await supabase
      .from('chat_participants')
      .upsert({
        chat_id: chatId,
        user_id: req.user.id,
        wallpaper_type: wallpaper_type || 'default',
        wallpaper_value: wallpaper_value || null,
        wallpaper_settings: wallpaper_settings || null
      }, { onConflict: 'chat_id,user_id' })
      .select()
      .single();

    if (error) throw error;

    res.json({
      message: 'Fondo guardado correctamente',
      wallpaper: {
        wallpaper_type: data.wallpaper_type,
        wallpaper_value: data.wallpaper_value,
        wallpaper_settings: data.wallpaper_settings
      }
    });
  } catch (e) {
    console.error('Save wallpaper error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener fondo de chat del usuario actual (solo el suyo, no el de otros)
app.get('/api/chats/:chatId/wallpaper', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    const { data, error } = await supabase
      .from('chat_participants')
      .select('wallpaper_type, wallpaper_value, wallpaper_settings')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data) {
      return res.json({ wallpaper_type: 'default', wallpaper_value: null, wallpaper_settings: null });
    }

    res.json(data);
  } catch (e) {
    console.error('Get wallpaper error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// NOTIFICACIONES
// ════════════════════════════════════════════════════════════════════
app.get('/api/notifications', auth, async (req, res) => {
  try {
    // Mensajes no leÁƒÂ­dos como notificaciones
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

// Marcar mensajes como leÁƒÂ­dos
app.post('/api/chats/:chatId/read', auth, async (req, res) => {
  try {
    await supabase.from('messages')
      .update({ status: 'read' })
      .eq('chat_id', req.params.chatId)
      .neq('sender_id', req.user.id);
    res.json({ message: 'Mensajes marcados como leÁƒÂ­dos' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// CONTACTOS CON FOTO Y PERFIL
// ════════════════════════════════════════════════════════════════════
// Perfil público de un usuario
app.get('/api/users/:userId', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('id, phone, full_name, avatar_url, created_at').eq('id', req.params.userId).single();
    if (!data) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// ESPACIO DULCE — Canales y Comunidades
// ════════════════════════════════════════════════════════════════════

// Auto-crear tablas de espacios
const ensureSpacesTable = async () => {
  try {
    await supabase.rpc('exec_sql', { sql: `
      CREATE TABLE IF NOT EXISTS spaces (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        type VARCHAR(20) DEFAULT 'publico' CHECK (type IN ('publico','comunidad')),
        cover TEXT,
        emoji VARCHAR(10) DEFAULT '📢',
        owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
        followers_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS space_follows (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(space_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS space_posts (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
        author_id UUID REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        image_url TEXT,
        likes_count INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS space_post_likes (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        post_id UUID REFERENCES space_posts(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(post_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS space_post_comments (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        post_id UUID REFERENCES space_posts(id) ON DELETE CASCADE,
        author_id UUID REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_spaces_type ON spaces(type);
      CREATE INDEX IF NOT EXISTS idx_space_follows_user ON space_follows(user_id);
      CREATE INDEX IF NOT EXISTS idx_space_posts_space ON space_posts(space_id);
      CREATE INDEX IF NOT EXISTS idx_space_posts_created ON space_posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_space_comments_post ON space_post_comments(post_id);
    `}).catch(() => {});
  } catch {}
};
ensureSpacesTable();

// Seed espacios por defecto si no existen
const seedDefaultSpaces = async () => {
  try {
    const { data } = await supabase.from('spaces').select('id').limit(1);
    if (data && data.length > 0) return; // ya existen
    const defaults = [
      { name: 'Gobierno GE', description: 'Noticias y comunicados oficiales del Gobierno de Guinea Ecuatorial', type: 'publico', cover: 'linear-gradient(135deg,#1e3a5f,#0369a1)', emoji: '🏛️', followers_count: 48200 },
      { name: 'Musica GQ', description: 'Lo mejor de la musica de Guinea Ecuatorial y Africa Central', type: 'comunidad', cover: 'linear-gradient(135deg,#7c3aed,#db2777)', emoji: '🎵', followers_count: 12800 },
      { name: 'Mercado Malabo', description: 'Compra, vende e intercambia en Guinea Ecuatorial', type: 'comunidad', cover: 'linear-gradient(135deg,#059669,#0d9488)', emoji: '🛒', followers_count: 31500 },
      { name: 'Deportes GQ', description: 'Futbol, baloncesto y todos los deportes de Guinea Ecuatorial', type: 'publico', cover: 'linear-gradient(135deg,#dc2626,#f59e0b)', emoji: '⚽', followers_count: 22100 },
      { name: 'Tecnologia GE', description: 'Innovacion, startups y tecnologia en Guinea Ecuatorial', type: 'comunidad', cover: 'linear-gradient(135deg,#1e40af,#7c3aed)', emoji: '💻', followers_count: 8900 },
    ];
    await supabase.from('spaces').insert(defaults);
  } catch {}
};
setTimeout(seedDefaultSpaces, 3000);

// GET /api/spaces — listar todos los espacios con estado de seguimiento del usuario
app.get('/api/spaces', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: spaces, error } = await supabase
      .from('spaces')
      .select('*')
      .order('followers_count', { ascending: false });
    if (error) return res.json([]);

    // Qué espacios sigue el usuario
    const { data: follows } = await supabase
      .from('space_follows')
      .select('space_id')
      .eq('user_id', userId);
    const followedIds = new Set((follows || []).map(f => f.space_id));

    res.json((spaces || []).map(s => ({ ...s, following: followedIds.has(s.id) })));
  } catch (e) { res.json([]); }
});

// POST /api/spaces — crear espacio
app.post('/api/spaces', auth, async (req, res) => {
  try {
    const { name, description, type, cover, emoji } = req.body;
    if (!name) return res.status(400).json({ message: 'nombre requerido' });
    const { data, error } = await supabase
      .from('spaces')
      .insert({ name, description, type: type || 'publico', cover, emoji: emoji || '📢', owner_id: req.user.id, followers_count: 1 })
      .select().single();
    if (error) throw error;
    // Auto-seguir al creador
    await supabase.from('space_follows').insert({ space_id: data.id, user_id: req.user.id }).catch(() => {});
    res.status(201).json({ ...data, following: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST /api/spaces/:id/follow — seguir/dejar de seguir
app.post('/api/spaces/:id/follow', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { data: existing } = await supabase
      .from('space_follows').select('id').eq('space_id', id).eq('user_id', userId).single();
    if (existing) {
      await supabase.from('space_follows').delete().eq('space_id', id).eq('user_id', userId);
      await supabase.from('spaces').update({ followers_count: supabase.rpc ? undefined : 0 }).eq('id', id);
      await supabase.rpc('exec_sql', { sql: `UPDATE spaces SET followers_count = GREATEST(0, followers_count - 1) WHERE id = '${id}'` }).catch(() => {});
      res.json({ following: false });
    } else {
      await supabase.from('space_follows').insert({ space_id: id, user_id: userId });
      await supabase.rpc('exec_sql', { sql: `UPDATE spaces SET followers_count = followers_count + 1 WHERE id = '${id}'` }).catch(() => {});
      res.json({ following: true });
    }
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /api/spaces/:id/posts — posts de un espacio
app.get('/api/spaces/:id/posts', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const { data: posts } = await supabase
      .from('space_posts')
      .select('*')
      .eq('space_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (!posts || posts.length === 0) return res.json([]);

    // Datos de autores
    const authorIds = [...new Set(posts.map(p => p.author_id))];
    const { data: authors } = await supabase.from('users').select('id, full_name, avatar_url').in('id', authorIds);
    const authorsMap = {};
    (authors || []).forEach(a => { authorsMap[a.id] = a; });

    // Likes del usuario actual
    const postIds = posts.map(p => p.id);
    const { data: myLikes } = await supabase.from('space_post_likes').select('post_id').eq('user_id', userId).in('post_id', postIds);
    const likedSet = new Set((myLikes || []).map(l => l.post_id));

    const now = Date.now();
    res.json(posts.map(p => {
      const author = authorsMap[p.author_id] || {};
      const diff = now - new Date(p.created_at).getTime();
      const timeStr = diff < 60000 ? 'ahora' : diff < 3600000 ? `${Math.floor(diff/60000)}m` : diff < 86400000 ? `${Math.floor(diff/3600000)}h` : `${Math.floor(diff/86400000)}d`;
      return {
        id: p.id,
        author: author.full_name || 'Usuario',
        avatar: (author.full_name || 'U').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase(),
        avatarUrl: author.avatar_url || '',
        color: '#00c8a0',
        text: p.text,
        imageUrl: p.image_url || null,
        time: timeStr,
        likes: p.likes_count || 0,
        comments: p.comments_count || 0,
        liked: likedSet.has(p.id),
      };
    }));
  } catch (e) { res.json([]); }
});

// POST /api/spaces/:id/posts — publicar en un espacio
app.post('/api/spaces/:id/posts', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, image_url } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'texto requerido' });
    const { data, error } = await supabase
      .from('space_posts')
      .insert({ space_id: id, author_id: req.user.id, text: text.trim(), image_url: image_url || null })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST /api/spaces/posts/:postId/like — dar/quitar like
app.post('/api/spaces/posts/:postId/like', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;
    const { data: existing } = await supabase.from('space_post_likes').select('id').eq('post_id', postId).eq('user_id', userId).single();
    if (existing) {
      await supabase.from('space_post_likes').delete().eq('post_id', postId).eq('user_id', userId);
      await supabase.rpc('exec_sql', { sql: `UPDATE space_posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = '${postId}'` }).catch(() => {});
      res.json({ liked: false });
    } else {
      await supabase.from('space_post_likes').insert({ post_id: postId, user_id: userId });
      await supabase.rpc('exec_sql', { sql: `UPDATE space_posts SET likes_count = likes_count + 1 WHERE id = '${postId}'` }).catch(() => {});
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /api/spaces/posts/:postId/comments — comentarios de un post
app.get('/api/spaces/posts/:postId/comments', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { data: comments } = await supabase
      .from('space_post_comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    if (!comments || comments.length === 0) return res.json([]);
    const authorIds = [...new Set(comments.map(c => c.author_id))];
    const { data: authors } = await supabase.from('users').select('id, full_name, avatar_url').in('id', authorIds);
    const authorsMap = {};
    (authors || []).forEach(a => { authorsMap[a.id] = a; });
    const now = Date.now();
    res.json(comments.map(c => {
      const author = authorsMap[c.author_id] || {};
      const diff = now - new Date(c.created_at).getTime();
      const timeStr = diff < 60000 ? 'ahora' : diff < 3600000 ? `${Math.floor(diff/60000)}m` : `${Math.floor(diff/3600000)}h`;
      return { id: c.id, author: author.full_name || 'Usuario', avatar: (author.full_name||'U').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(), avatarUrl: author.avatar_url||'', text: c.text, time: timeStr };
    }));
  } catch (e) { res.json([]); }
});

// POST /api/spaces/posts/:postId/comments — comentar
app.post('/api/spaces/posts/:postId/comments', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'texto requerido' });
    const { data, error } = await supabase
      .from('space_post_comments')
      .insert({ post_id: postId, author_id: req.user.id, text: text.trim() })
      .select().single();
    if (error) throw error;
    await supabase.rpc('exec_sql', { sql: `UPDATE space_posts SET comments_count = comments_count + 1 WHERE id = '${postId}'` }).catch(() => {});
    const { data: author } = await supabase.from('users').select('full_name, avatar_url').eq('id', req.user.id).single();
    res.status(201).json({ id: data.id, author: author?.full_name || 'Usuario', avatar: (author?.full_name||'U').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(), avatarUrl: author?.avatar_url||'', text: data.text, time: 'ahora' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE /api/spaces/posts/:postId — eliminar post (solo autor o admin del espacio)
app.delete('/api/spaces/posts/:postId', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { error } = await supabase.from('space_posts').delete().eq('id', postId).eq('author_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// STORIES / ESTADOS
// ════════════════════════════════════════════════════════════════════

// Auto-crear tabla stories si no existe al primer uso
const ensureStoriesTable = async () => {
  try {
    const { error } = await supabase.from('stories').select('id').limit(1);
    if (error && error.message && error.message.includes('does not exist')) {
      await supabase.rpc('exec_sql', {
        sql: `CREATE TABLE IF NOT EXISTS stories (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
          media JSONB NOT NULL,
          type TEXT DEFAULT 'text',
          views INTEGER DEFAULT 0,
          reactions JSONB DEFAULT '[]',
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
        CREATE INDEX IF NOT EXISTS idx_stories_expires_at ON stories(expires_at);`
      }).catch(() => {});
    }
  } catch {}
};
ensureStoriesTable();

app.get('/api/stories', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date().toISOString();

    // 1. Mis propios estados
    const { data: mine } = await supabase
      .from('stories')
      .select('*')
      .eq('user_id', userId)
      .gt('expires_at', now)
      .order('created_at', { ascending: false });

    // 2. IDs de contactos (tabla contacts)
    const { data: contacts } = await supabase
      .from('contacts')
      .select('contact_user_id, contact_id')
      .or(`user_id.eq.${userId},contact_id.eq.${userId}`)
      .eq('is_blocked', false);

    const contactIds = new Set();
    (contacts || []).forEach(c => {
      if (c.contact_user_id && c.contact_user_id !== userId) contactIds.add(c.contact_user_id);
      if (c.contact_id && c.contact_id !== userId) contactIds.add(c.contact_id);
    });

    // 3. También incluir usuarios con quienes tengo chats activos
    const { data: chatParts } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', userId);

    if (chatParts && chatParts.length > 0) {
      const chatIds = chatParts.map(c => c.chat_id);
      const { data: otherParts } = await supabase
        .from('chat_participants')
        .select('user_id')
        .in('chat_id', chatIds)
        .neq('user_id', userId);
      (otherParts || []).forEach(p => contactIds.add(p.user_id));
    }

    // 4. Estados de contactos
    let contactStories = [];
    if (contactIds.size > 0) {
      const { data } = await supabase
        .from('stories')
        .select('*')
        .in('user_id', Array.from(contactIds))
        .gt('expires_at', now)
        .order('created_at', { ascending: false });
      contactStories = data || [];
    }

    // 5. Obtener datos de usuarios para todos los stories
    const allStories = [...(mine || []), ...contactStories];
    const allUserIds = [...new Set(allStories.map(s => s.user_id))];
    let usersMap = {};
    if (allUserIds.length > 0) {
      const { data: usersData } = await supabase
        .from('users')
        .select('id, full_name, avatar_url')
        .in('id', allUserIds);
      (usersData || []).forEach(u => { usersMap[u.id] = u; });
    }

    // 6. Formatear respuesta
    const format = (s, isMe) => {
      const user = usersMap[s.user_id] || {};
      const name = user.full_name || 'Usuario';
      let media = s.media;
      if (typeof media === 'string') { try { media = JSON.parse(media); } catch { media = []; } }
      return {
        id: s.id,
        userId: s.user_id,
        userName: name,
        avatarUrl: user.avatar_url || '',
        media: Array.isArray(media) ? media : [],
        views: s.views || 0,
        reactions: s.reactions || [],
        seen: false,
        publishedAt: new Date(s.created_at).getTime(),
        expiresAt: new Date(s.expires_at).getTime(),
        isMe,
      };
    };

    res.json([
      ...(mine || []).map(s => format(s, true)),
      ...contactStories.map(s => format(s, false)),
    ]);
  } catch (e) { res.json([]); }
});

app.post('/api/stories', auth, async (req, res) => {
  try {
    const { media, type = 'text' } = req.body;
    if (!media) return res.status(400).json({ message: 'media requerido' });
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const newSlides = Array.isArray(media) ? media : [media];

    // Upsert: añadir a story activa existente o crear nueva
    const { data: existing } = await supabase
      .from('stories')
      .select('id, media')
      .eq('user_id', req.user.id)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    let story;
    if (existing) {
      let currentMedia = existing.media;
      if (typeof currentMedia === 'string') { try { currentMedia = JSON.parse(currentMedia); } catch { currentMedia = []; } }
      const updatedMedia = [...(Array.isArray(currentMedia) ? currentMedia : []), ...newSlides];
      const { data, error } = await supabase
        .from('stories')
        .update({ media: updatedMedia, expires_at: expiresAt })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      story = data;
    } else {
      const { data, error } = await supabase
        .from('stories')
        .insert({ user_id: req.user.id, media: newSlides, type, views: 0, expires_at: expiresAt })
        .select()
        .single();
      if (error) throw error;
      story = data;
    }
    res.status(201).json({ id: story.id, media: story.media, expiresAt: story.expires_at });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/stories/:storyId', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('stories').delete().eq('id', req.params.storyId).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ message: 'Story eliminada' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// PATCH /api/stories/:storyId/slide/:idx — editar contenido de un slide
app.patch('/api/stories/:storyId/slide/:idx', auth, async (req, res) => {
  try {
    const { storyId, idx } = req.params;
    const slideIdx = parseInt(idx);
    const { content, bg, emoji, music } = req.body;
    const { data: story, error: fetchErr } = await supabase
      .from('stories').select('media').eq('id', storyId).eq('user_id', req.user.id).single();
    if (fetchErr || !story) return res.status(404).json({ message: 'Story no encontrada' });
    let media = story.media;
    if (typeof media === 'string') { try { media = JSON.parse(media); } catch { media = []; } }
    if (!Array.isArray(media) || slideIdx < 0 || slideIdx >= media.length)
      return res.status(400).json({ message: 'Slide no existe' });
    const updated = media.map((s, i) => i === slideIdx ? {
      ...s,
      ...(content !== undefined ? { content } : {}),
      ...(bg !== undefined ? { bg } : {}),
      ...(emoji !== undefined ? { emoji } : {}),
      ...(music !== undefined ? { music } : {}),
    } : s);
    const { error: updateErr } = await supabase.from('stories').update({ media: updated }).eq('id', storyId);
    if (updateErr) throw updateErr;
    res.json({ ok: true, media: updated });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/stories/:storyId/view', auth, async (req, res) => {
  try {
    const { data: s } = await supabase.from('stories').select('views').eq('id', req.params.storyId).single();
    if (s) await supabase.from('stories').update({ views: (s.views || 0) + 1 }).eq('id', req.params.storyId);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

app.post('/api/stories/:storyId/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ message: 'emoji requerido' });
    const { data: story } = await supabase.from('stories').select('reactions').eq('id', req.params.storyId).single();
    if (!story) return res.status(404).json({ message: 'Story no encontrada' });
    const reactions = story.reactions || [];
    const existing = reactions.find(r => r.emoji === emoji);
    const updated = existing ? reactions.map(r => r.emoji === emoji ? { ...r, count: r.count + 1 } : r) : [...reactions, { emoji, count: 1 }];
    await supabase.from('stories').update({ reactions: updated }).eq('id', req.params.storyId);
    res.json({ reactions: updated });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════
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

// ─── WebRTC Signaling — persistido en Supabase ───────────────────────────────

// TURN token endpoint — genera credenciales temporales para TURN server
app.get('/api/call/turn-token', auth, async (req, res) => {
  try {
    const accountSid  = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid   = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

    const client = require('twilio')(apiKeySid, apiKeySecret, { accountSid });
    const token = await client.tokens.create({ ttl: 86400 });

    res.json({
      iceServers: token.iceServers.map(s => ({
        urls: s.url || s.urls,
        username: s.username,
        credential: s.credential,
      }))
    });
  } catch (e) {
    console.error('TURN token error:', e.message);
    res.json({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' }
      ]
    });
  }
});

// Iniciar llamada — caller envía offer + push al destinatario
app.post('/api/call/offer', auth, async (req, res) => {
  const { callId, offer, targetUserId, type } = req.body;
  if (!callId || !offer) return res.status(400).json({ error: 'callId y offer requeridos' });
  try {
    await supabase.from('call_sessions').upsert({
      call_id: callId,
      offer: JSON.stringify(offer),
      answer: null,
      caller_candidates: '[]',
      callee_candidates: '[]',
      type: type || 'audio',
      caller_id: req.user.id,
      target_user_id: targetUserId,
      ended: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'call_id' });

    // Enviar push de llamada entrante al destinatario
    if (targetUserId) {
      try {
        const { data: caller } = await supabase
          .from('users').select('full_name, avatar_url').eq('id', req.user.id).single();
        const callerName = caller?.full_name || 'Alguien';
        const isVideo = (type || 'audio') === 'video';
        const callPushPayload = {
          title: isVideo ? `📹 Videollamada de ${callerName}` : `📞 Llamada de ${callerName}`,
          body: isVideo ? 'Toca para responder la videollamada' : 'Toca para responder la llamada',
          icon: caller?.avatar_url || '/favicon.svg',
          badge: '/favicon.svg',
          tag: `call-${callId}`,
          requireInteraction: true,
          url: '/',
          callId,
          callerId: req.user.id,
          callerName,
          callType: type || 'audio',
          notificationType: 'incoming_call',
        };

        // Enviar push inmediatamente — una sola vez
        // (el SW tiene requireInteraction:true, la notificación no desaparece sola)
        await sendPushToUser(targetUserId, callPushPayload);

      } catch (pushErr) {
        console.warn('Push call notification failed:', pushErr.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando sesión' });
  }
});

// Callee responde con answer
app.post('/api/call/answer', auth, async (req, res) => {
  const { callId, answer } = req.body;
  const { data } = await supabase.from('call_sessions').select('call_id').eq('call_id', callId).eq('ended', false).single();
  if (!data) return res.status(404).json({ error: 'Llamada no encontrada' });
  await supabase.from('call_sessions').update({ answer: JSON.stringify(answer), updated_at: new Date().toISOString() }).eq('call_id', callId);
  res.json({ ok: true });
});

// Enviar ICE candidate
app.post('/api/call/ice', auth, async (req, res) => {
  const { callId, candidate, role } = req.body;
  const { data } = await supabase.from('call_sessions').select('caller_candidates, callee_candidates').eq('call_id', callId).single();
  if (!data) return res.status(404).json({ error: 'Llamada no encontrada' });
  if (role === 'caller') {
    const arr = JSON.parse(data.caller_candidates || '[]');
    arr.push(candidate);
    await supabase.from('call_sessions').update({ caller_candidates: JSON.stringify(arr), updated_at: new Date().toISOString() }).eq('call_id', callId);
  } else {
    const arr = JSON.parse(data.callee_candidates || '[]');
    arr.push(candidate);
    await supabase.from('call_sessions').update({ callee_candidates: JSON.stringify(arr), updated_at: new Date().toISOString() }).eq('call_id', callId);
  }
  res.json({ ok: true });
});

// Polling — obtener estado de la llamada
app.get('/api/call/:callId', auth, async (req, res) => {
  const { data } = await supabase.from('call_sessions').select('*').eq('call_id', req.params.callId).single();
  if (!data) return res.status(404).json({ error: 'Llamada no encontrada' });
  res.json({
    offer: JSON.parse(data.offer || 'null'),
    answer: data.answer ? JSON.parse(data.answer) : null,
    callerCandidates: JSON.parse(data.caller_candidates || '[]'),
    calleeCandidates: JSON.parse(data.callee_candidates || '[]'),
    type: data.type,
    callerId: data.caller_id,
    targetUserId: data.target_user_id,
    ended: data.ended,
  });
});

// Terminar llamada
app.delete('/api/call/:callId', auth, async (req, res) => {
  await supabase.from('call_sessions').update({ ended: true, updated_at: new Date().toISOString() }).eq('call_id', req.params.callId);
  // Borrar después de 15 segundos
  setTimeout(async () => {
    await supabase.from('call_sessions').delete().eq('call_id', req.params.callId);
  }, 15000);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// LLAMADAS GRUPALES — Señalización SFU via HTTP polling
// Cada room tiene hasta 9 participantes. La señalización WebRTC
// (offer/answer/ICE) se hace via REST igual que las llamadas 1:1.
// Los peers intercambian SDPs a través del servidor como intermediario.
//
// Tabla en memoria (persiste mientras el proceso corre).
// Para producción distribuida: persistir en Supabase o Redis.
// ══════════════════════════════════════════════════════════════════

const groupCallRooms = new Map(); // roomId → Room

function getOrCreateRoom(roomId) {
  if (!groupCallRooms.has(roomId)) {
    groupCallRooms.set(roomId, {
      roomId,
      participants: new Map(), // userId → { userId, name, avatar, joinedAt }
      offers: new Map(),        // `${from}_${to}` → { sdp, type }
      answers: new Map(),       // `${from}_${to}` → { sdp, type }
      iceCandidates: new Map(), // `${from}_${to}` → [candidate, ...]
      callType: 'audio',
      createdAt: Date.now(),
    });
    // Auto-destruir el room si todos se van (30 min máx)
    setTimeout(() => groupCallRooms.delete(roomId), 30 * 60 * 1000);
  }
  return groupCallRooms.get(roomId);
}

const MAX_ROOM_PARTICIPANTS = 9;

// ── Unirse a un room grupal ───────────────────────────────────────
app.post('/api/call/room/:roomId/join', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { name, avatar, callType } = req.body;
    const userId = String(req.user.id);

    const room = getOrCreateRoom(roomId);

    if (room.participants.size >= MAX_ROOM_PARTICIPANTS && !room.participants.has(userId)) {
      return res.status(400).json({ message: `Sala llena (máx ${MAX_ROOM_PARTICIPANTS} participantes)` });
    }

    room.participants.set(userId, { userId, name: name || userId, avatar, joinedAt: Date.now() });
    if (callType) room.callType = callType;

    // Devolver lista de participantes ya en el room (para crear offers hacia ellos)
    const others = [...room.participants.values()].filter(p => p.userId !== userId);

    // Notificar a los demás via SSE
    for (const p of others) {
      emitToUser(p.userId, {
        type: 'group_call_participant_joined',
        roomId,
        userId,
        name: name || userId,
        avatar,
        callType: room.callType,
        ts: Date.now(),
      });
    }

    res.json({
      ok: true,
      roomId,
      callType: room.callType,
      participants: others,
    });
  } catch (e) {
    console.error('Room join error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Estado del room ───────────────────────────────────────────────
app.get('/api/call/room/:roomId/state', auth, async (req, res) => {
  try {
    const room = groupCallRooms.get(req.params.roomId);
    if (!room) return res.json({ exists: false, participants: [] });

    res.json({
      exists: true,
      roomId: room.roomId,
      callType: room.callType,
      participants: [...room.participants.values()],
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Publicar offer hacia un peer ──────────────────────────────────
app.post('/api/call/room/:roomId/offer', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { toUserId, sdp } = req.body;
    const fromUserId = String(req.user.id);

    const room = getOrCreateRoom(roomId);
    const key = `${fromUserId}_${toUserId}`;
    room.offers.set(key, { sdp, from: fromUserId, to: toUserId, ts: Date.now() });

    // Notificar via SSE al destinatario
    emitToUser(toUserId, {
      type: 'group_call_offer',
      roomId,
      fromUserId,
      sdp,
      callType: room.callType,
      ts: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Publicar answer hacia un peer ─────────────────────────────────
app.post('/api/call/room/:roomId/answer', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { toUserId, sdp } = req.body;
    const fromUserId = String(req.user.id);

    const room = getOrCreateRoom(roomId);
    const key = `${fromUserId}_${toUserId}`;
    room.answers.set(key, { sdp, from: fromUserId, to: toUserId, ts: Date.now() });

    // Notificar via SSE
    emitToUser(toUserId, {
      type: 'group_call_answer',
      roomId,
      fromUserId,
      sdp,
      ts: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Obtener offer/answer pendiente hacia mí ───────────────────────
// El cliente hace polling de este endpoint para recibir SDPs
app.get('/api/call/room/:roomId/signals', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const myUserId = String(req.user.id);
    const room = groupCallRooms.get(roomId);
    if (!room) return res.json({ offers: [], answers: [], iceCandidates: [] });

    // Recoger todos los offers dirigidos a mí
    const offers = [...room.offers.entries()]
      .filter(([, v]) => v.to === myUserId)
      .map(([, v]) => v);

    // Recoger todas las respuestas dirigidas a mí
    const answers = [...room.answers.entries()]
      .filter(([, v]) => v.to === myUserId)
      .map(([, v]) => v);

    // Recoger ICE candidates dirigidos a mí
    const iceCandidates = [];
    for (const [key, candidates] of room.iceCandidates.entries()) {
      const [from, to] = key.split('_');
      if (to === myUserId) {
        iceCandidates.push({ from, candidates });
        // Limpiar después de entregar
        room.iceCandidates.delete(key);
      }
    }

    res.json({ offers, answers, iceCandidates });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Publicar ICE candidate ────────────────────────────────────────
app.post('/api/call/room/:roomId/ice', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { toUserId, candidate } = req.body;
    const fromUserId = String(req.user.id);

    const room = getOrCreateRoom(roomId);
    const key = `${fromUserId}_${toUserId}`;
    const arr = room.iceCandidates.get(key) || [];
    arr.push(candidate);
    room.iceCandidates.set(key, arr);

    // Notificar via SSE para velocidad máxima
    emitToUser(toUserId, {
      type: 'group_call_ice',
      roomId,
      fromUserId,
      candidate,
      ts: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Salir del room ────────────────────────────────────────────────
app.delete('/api/call/room/:roomId/leave', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = String(req.user.id);

    const room = groupCallRooms.get(roomId);
    if (room) {
      room.participants.delete(userId);
      // Limpiar signals de/hacia este usuario
      for (const key of [...room.offers.keys(), ...room.answers.keys(), ...room.iceCandidates.keys()]) {
        if (key.startsWith(`${userId}_`) || key.includes(`_${userId}`)) {
          room.offers.delete(key);
          room.answers.delete(key);
          room.iceCandidates.delete(key);
        }
      }
      // Notificar a los demás
      for (const p of room.participants.values()) {
        emitToUser(p.userId, {
          type: 'group_call_participant_left',
          roomId,
          userId,
          ts: Date.now(),
        });
      }
      // Destruir room si está vacío
      if (room.participants.size === 0) groupCallRooms.delete(roomId);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Stickers — catálogo y paquetes ───────────────────────────────

// Catálogo de paquetes disponibles
app.get('/api/stickers/catalog', auth, async (req, res) => {
  try {
    const { data: packs } = await supabase
      .from('sticker_packs')
      .select('*')
      .eq('is_active', true)
      .order('download_count', { ascending: false })
      .limit(50);

    if (!packs?.length) {
      // Fallback con paquetes integrados si la tabla está vacía
      return res.json([
        { id: 'guinea_eq',    name: 'Guinea Ecuatorial', author: 'EGChat', downloadCount: 1420, coverUrl: 'https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif', stickers: [] },
        { id: 'africa_vibes', name: 'África Vibes',       author: 'EGChat', downloadCount: 890,  coverUrl: 'https://media.tenor.com/fRQXPTpRZqUAAAAi/clapping-applause.gif',  stickers: [] },
        { id: 'fun_animals',  name: 'Animales Divertidos', author: 'EGChat', downloadCount: 2100, coverUrl: 'https://media.tenor.com/wnRH0YZDlmAAAAAi/laugh-lol.gif',           stickers: [] },
      ]);
    }

    res.json(packs.map(p => ({
      id: p.id, name: p.name, author: p.author,
      coverUrl: p.cover_url, downloadCount: p.download_count,
      stickers: typeof p.stickers === 'string' ? JSON.parse(p.stickers) : (p.stickers || []),
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Instalar paquete
app.post('/api/stickers/packs/:packId/install', auth, async (req, res) => {
  try {
    const { packId } = req.params;
    await supabase.from('user_sticker_packs').upsert(
      { user_id: req.user.id, pack_id: packId, installed_at: new Date().toISOString() },
      { onConflict: 'user_id,pack_id' },
    );
    // Incrementar contador de descargas
    await supabase.rpc('increment', { table: 'sticker_packs', id: packId, col: 'download_count' }).catch(() => {
      supabase.from('sticker_packs').select('download_count').eq('id', packId).single()
        .then(({ data }) => {
          if (data) supabase.from('sticker_packs').update({ download_count: (data.download_count || 0) + 1 }).eq('id', packId);
        });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Desinstalar paquete
app.delete('/api/stickers/packs/:packId/install', auth, async (req, res) => {
  try {
    await supabase.from('user_sticker_packs')
      .delete()
      .eq('user_id', req.user.id)
      .eq('pack_id', req.params.packId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Paquetes instalados del usuario
app.get('/api/stickers/installed', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('user_sticker_packs')
      .select('pack_id, installed_at')
      .eq('user_id', req.user.id);
    res.json((data || []).map(r => r.pack_id));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Mini-Apps — catálogo dinámico ────────────────────────────────

app.get('/api/mini-apps', auth, async (req, res) => {
  try {
    const { data: apps } = await supabase
      .from('mini_apps')
      .select('*')
      .eq('is_active', true)
      .order('installs_count', { ascending: false })
      .limit(50);

    if (!apps?.length) {
      // Fallback con apps integradas si la tabla está vacía
      return res.json([]);
    }

    res.json(apps.map(a => ({
      id: a.id, name: a.name, description: a.description,
      icon: a.icon_url, accentColor: a.accent_color || '#00c8a0',
      url: a.url, category: a.category || 'utilities',
      permissions: a.permissions || [],
      verified: a.is_verified, developer: a.developer_name || 'Terceros',
      installsCount: a.installs_count || 0,
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Instalar mini-app (registrar uso)
app.post('/api/mini-apps/:appId/install', auth, async (req, res) => {
  try {
    const { appId } = req.params;
    await supabase.from('user_mini_apps').upsert(
      { user_id: req.user.id, app_id: appId, last_used_at: new Date().toISOString() },
      { onConflict: 'user_id,app_id' },
    );
    // Incrementar contador
    const { data: app } = await supabase.from('mini_apps').select('installs_count').eq('id', appId).single();
    if (app) {
      await supabase.from('mini_apps').update({ installs_count: (app.installs_count || 0) + 1 }).eq('id', appId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Notificar llamada entrante (el callee hace polling de esto)
app.get('/api/call/incoming/:userId', auth, async (req, res) => {
  const { data } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('target_user_id', req.params.userId)
    .eq('ended', false)
    .is('answer', null)
    .order('created_at', { ascending: false })
    .limit(5);
  if (!data || data.length === 0) return res.json([]);
  // Limpiar sesiones muy antiguas (más de 150 segundos — tiempo para desbloquear teléfono hibernado)
  const now = Date.now();
  const valid = data.filter(s => now - new Date(s.created_at).getTime() < 150000);
  res.json(valid.map(s => ({
    callId: s.call_id,
    callerId: s.caller_id,
    type: s.type,
    offer: JSON.parse(s.offer || 'null'),
  })));
});

// Limpiar sesiones antiguas cada 5 minutos
setInterval(async () => {
  const cutoff = new Date(Date.now() - 300000).toISOString();
  await supabase.from('call_sessions').delete().lt('created_at', cutoff);
}, 300000);

// ── Cron de notificaciones de mora djangue — cada 6 horas ────────
setInterval(async () => {
  try {
    const now = new Date();
    // Buscar grupos activos cuyo período está por vencer o ya venció
    const { data: groups } = await supabase
      .from('djangue_groups')
      .select('id, name, period_end_date, notification_days_before, notification_final_days, current_turn')
      .eq('status', 'active');

    for (const group of (groups || [])) {
      const end = new Date(group.period_end_date);
      const daysLeft = Math.ceil((end - now) / 86400000);

      const shouldNotify =
        daysLeft <= (group.notification_days_before || 3) ||
        daysLeft <= (group.notification_final_days || 1);

      if (!shouldNotify) continue;

      // Buscar miembros que no han pagado
      const { data: members } = await supabase
        .from('djangue_members')
        .select('user_id')
        .eq('group_id', group.id)
        .eq('status', 'active')
        .neq('turn_order', group.current_turn); // el beneficiario no paga

      const { data: paid } = await supabase
        .from('djangue_contributions')
        .select('user_id')
        .eq('group_id', group.id)
        .eq('turn_number', group.current_turn)
        .eq('status', 'paid');

      const paidIds = new Set((paid || []).map(p => String(p.user_id)));
      const unpaid = (members || []).filter(m => !paidIds.has(String(m.user_id)));

      // Registrar notificación pendiente para cada moroso
      for (const member of unpaid) {
        await supabase.from('djangue_notifications').upsert({
          group_id: group.id,
          user_id: member.user_id,
          type: daysLeft <= (group.notification_final_days || 1) ? 'final_warning' : 'reminder',
          message: daysLeft <= 1
            ? `⚠️ ÚLTIMO DÍA: Paga tu cuota al djangue "${group.name}" antes de medianoche`
            : `⏰ Recuerda: faltan ${daysLeft} días para pagar tu cuota al djangue "${group.name}"`,
          sent: false,
          created_at: now.toISOString(),
        }, { onConflict: 'group_id,user_id,type', ignoreDuplicates: false });
      }
    }
  } catch (e) {
    console.error('[Djangue cron mora]', e.message);
  }
}, 6 * 60 * 60 * 1000); // cada 6 horas

// ── D1: Dispatcher de notificaciones djangue pendientes — cada 15 min ─────
setInterval(async () => {
  try {
    // Leer notificaciones pendientes
    const { data: pending } = await supabase
      .from('djangue_notifications')
      .select('id, user_id, message, type, group_id')
      .eq('sent', false)
      .limit(50);

    if (!pending?.length) return;

    for (const notif of pending) {
      // Enviar push via Expo Push API
      await sendPushToUser(notif.user_id, {
        title: notif.type === 'final_warning' ? '⚠️ Último aviso — Djangue' : '⏰ Recordatorio — Djangue',
        body: notif.message,
        data: { type: 'djangue_notification', groupId: notif.group_id, notificationType: 'djangue' },
      });

      // Marcar como enviada
      await supabase.from('djangue_notifications')
        .update({ sent: true, sent_at: new Date().toISOString() })
        .eq('id', notif.id);
    }
  } catch (e) {
    console.error('[Djangue dispatcher]', e.message);
  }
}, 15 * 60 * 1000); // cada 15 minutos
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// WEB PUSH — VAPID
// ─────────────────────────────────────────────────────────────────────────────
const webpush = require('web-push');

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BNeDJFYqIX59vgqEKxWfrI263knyPGHafMEK_WrMPeYaIm8bn62vcOah7hDlgIek4R4utB82g-cT9CwAtGn0wUs';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'Ur3h0gh5W6F_dzQNhkXCwtkEV1sMGpo568ZB1Bglpt8';

webpush.setVapidDetails(
  'mailto:admin@egchat.app',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// Guardar suscripción push del usuario
app.post('/api/push/subscribe', auth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ message: 'Suscripción inválida' });
    }
    // Guardar en Supabase (tabla push_subscriptions)
    await supabase.from('push_subscriptions').upsert({
      user_id: req.user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys?.p256dh || '',
      auth: subscription.keys?.auth || '',
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,endpoint' });

    res.json({ message: 'Suscripción guardada' });
  } catch (e) {
    console.error('Push subscribe error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// Eliminar suscripción push
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await supabase.from('push_subscriptions')
      .delete()
      .eq('user_id', req.user.id)
      .eq('endpoint', endpoint || '');
    res.json({ message: 'Suscripción eliminada' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Obtener clave pública VAPID
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Función interna para enviar push a un usuario
const sendPushToUser = async (userId, payload) => {
  try {
    const isCall = payload.notificationType === 'incoming_call';

    // ── Web Push (navegador/PWA) ──────────────────────────────────────────
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);

    if (subs && subs.length > 0) {
      const payloadStr = JSON.stringify(payload);
      // Para llamadas: urgency=high despierta el teléfono aunque esté hibernado
      // TTL=0 en llamadas significa "entregar ahora o nunca" (no tiene sentido entregar una llamada vieja)
      const pushOptions = isCall
        ? { urgency: 'high', TTL: 120 }   // 120s — tiempo para desbloquear el teléfono
        : { urgency: 'normal', TTL: 86400 };
      await Promise.allSettled(
        subs.map(sub =>
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payloadStr,
            pushOptions
          ).catch(async err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
              await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
            }
            throw err;
          })
        )
      );
    }

    // ── Expo Push (app movil nativa — funciona con telefono hibernado) ────
    const { data: expoSubs } = await supabase
      .from('expo_push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (expoSubs && expoSubs.length > 0) {
      const expoMessages = expoSubs.map(sub => ({
        to: sub.token,
        title: payload.title || 'EGChat',
        body: payload.body || 'Nueva notificacion',
        sound: isCall ? 'default' : 'notification.wav',
        badge: 1,
        channelId: isCall ? 'egchat-calls' : 'egchat-messages',
        priority: isCall ? 'high' : 'normal',
        data: payload,
        // Llamadas: TTL de 120s para dar tiempo a desbloquear el teléfono
        ...(isCall ? { ttl: 120, expiration: Math.floor(Date.now() / 1000) + 120 } : {}),
      }));

      for (let i = 0; i < expoMessages.length; i += 100) {
        const batch = expoMessages.slice(i, i + 100);
        try {
          const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(batch),
          });
          const result = await expoRes.json();
          if (result.data) {
            const invalid = result.data
              .map((r, idx) => ({ r, token: batch[idx].to }))
              .filter(({ r }) => r.status === 'error' && r.details?.error === 'DeviceNotRegistered');
            if (invalid.length > 0) {
              await Promise.allSettled(
                invalid.map(({ token }) => supabase.from('expo_push_tokens').delete().eq('token', token))
              );
            }
          }
        } catch (expoErr) {
          console.warn('Expo push error:', expoErr.message);
        }
      }
    }
  } catch (e) {
    console.error('sendPushToUser error:', e.message);
  }
};

// ── Registrar token Expo Push (app movil nativa) ──────────────────────────
app.post('/api/push/register-expo-token', auth, async (req, res) => {
  try {
    const { expoPushToken, platform } = req.body;
    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ message: 'Token Expo invalido' });
    }
    await supabase.from('expo_push_tokens').upsert({
      user_id: req.user.id,
      token: expoPushToken,
      platform: platform || 'android',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token' });
    res.json({ message: 'Token registrado' });
  } catch (e) {
    console.error('Expo token register error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────

// Admin: verificar suscripciones por teléfono
app.get('/api/push/check/:phone', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== (process.env.ADMIN_RESET_KEY || JWT_SECRET)) {
    return res.status(403).json({ message: 'No autorizado' });
  }
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data: user } = await supabase.from('users').select('id, full_name, phone').eq('phone', phone).single();
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    const { data: subs } = await supabase.from('push_subscriptions').select('id, endpoint, updated_at').eq('user_id', user.id);
    res.json({ user: { id: user.id, name: user.full_name, phone: user.phone }, subscriptions: (subs || []).length, details: (subs || []).map(s => ({ id: s.id, endpoint: s.endpoint.slice(0, 80) + '...', updated_at: s.updated_at })) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Admin: enviar push de prueba por teléfono
app.post('/api/push/send-test/:phone', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== (process.env.ADMIN_RESET_KEY || JWT_SECRET)) {
    return res.status(403).json({ message: 'No autorizado' });
  }
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data: user } = await supabase.from('users').select('id, full_name').eq('phone', phone).single();
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    const result = await sendPushToUser(user.id, {
      title: '🔔 EGChat — Prueba',
      body: `Hola ${user.full_name}, las notificaciones funcionan!`,
      icon: '/favicon.svg',
      tag: 'test-push-' + Date.now(),
      url: '/',
    });
    res.json({ message: 'Push enviado', userId: user.id, result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Ver cuántas suscripciones tiene el usuario actual
app.get('/api/push/my-subscriptions', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, created_at, updated_at')
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ count: (data || []).length, subscriptions: (data || []).map(s => ({ id: s.id, endpoint: s.endpoint.slice(0, 60) + '...', updated_at: s.updated_at })) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Enviar push de prueba al usuario actual
app.post('/api/push/test', auth, async (req, res) => {
  try {
    const result = await sendPushToUser(req.user.id, {
      title: '🔔 EGChat — Prueba',
      body: 'Las notificaciones funcionan correctamente',
      icon: '/favicon.svg',
      tag: 'test-push',
      url: '/',
    });
    res.json({ message: 'Push enviado', result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// NOTICIAS GOBIERNO GE — Scraping de fuentes oficiales
// ══════════════════════════════════════════════════════════════════

// Cache en memoria para no saturar las fuentes
const noticiasCache = { data: [], timestamp: 0 };
const NOTICIAS_TTL = 5 * 60 * 1000; // 5 minutos

// Fuentes oficiales del Gobierno de Guinea Ecuatorial
const FUENTES_OFICIALES = [
  { nombre: 'Presidencia del Gobierno', url: 'https://primatura.gob.gq/noticias/', dominio: 'primatura.gob.gq', color: '#1e3a5f' },
  { nombre: 'Guinea Ecuatorial Press', url: 'https://www.guineaecuatorialpress.com/', dominio: 'guineaecuatorialpress.com', color: '#0369a1' },
  { nombre: 'Presidencia GQ', url: 'https://www.presidenciagobierno.gq', dominio: 'presidenciagobierno.gq', color: '#1e3a5f' },
  { nombre: 'La Vice Press', url: 'https://www.lavicepress.com', dominio: 'lavicepress.com', color: '#0d9488' },
];

// Extrae noticias de primatura.gob.gq parseando el HTML
async function scrapePrimatura() {
  const noticias = [];
  try {
    const res = await fetch('https://primatura.gob.gq/noticias/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EGChatBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return noticias;
    const html = await res.text();

    // Extraer artículos: busca patrones <h2> o <h3> con enlaces dentro de .post, article, .entry-title
    const titleRegex = /<(?:h[123]|a)[^>]*class="[^"]*(?:entry-title|post-title)[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const altRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    const dateRegex = /<time[^>]*datetime="([^"]+)"[^>]*>/i;
    const linkRegex = /<a[^>]+href="(https?:\/\/primatura\.gob\.gq\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    let m;
    // Método 1: buscar h2/h3 con clase entry-title
    while ((m = titleRegex.exec(html)) !== null) {
      const url = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title.length > 10) {
        noticias.push({ title, url, fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Gobierno' });
      }
    }

    // Método 2: buscar todos los enlaces a artículos de primatura
    if (noticias.length === 0) {
      while ((m = linkRegex.exec(html)) !== null) {
        const url = m[1];
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (title.length > 15 && !url.includes('/page/') && !url.includes('/category/') && !url.includes('/tag/')) {
          noticias.push({ title, url, fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Gobierno' });
        }
      }
    }
  } catch (e) {
    console.log('[Noticias] Error scraping primatura:', e.message);
  }
  return noticias.slice(0, 10);
}

// Extrae noticias de guineaecuatorialpress.com
async function scrapeGEPress() {
  const noticias = [];
  try {
    const res = await fetch('http://guineaecuatorialpress.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EGChatBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return noticias;
    const html = await res.text();

    const linkRegex = /<a[^>]+href="(https?:\/\/(?:www\.)?guineaecuatorialpress\.com\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const seen = new Set();
    while ((m = linkRegex.exec(html)) !== null) {
      const url = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title.length > 15 && !seen.has(url) && !url.match(/\/(category|tag|page|author)\//)) {
        seen.add(url);
        noticias.push({ title, url, fuente: 'Guinea Ecuatorial Press', dominio: 'guineaecuatorialpress.com', color: '#0369a1', category: 'Noticias' });
      }
    }
  } catch (e) {
    console.log('[Noticias] Error scraping GEPress:', e.message);
  }
  return noticias.slice(0, 10);
}

// Extrae noticias de presidenciagobierno.gq
async function scrapePresidencia() {
  const noticias = [];
  try {
    const res = await fetch('https://www.presidenciagobierno.gq', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EGChatBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return noticias;
    const html = await res.text();
    const linkRegex = /<a[^>]+href="(https?:\/\/(?:www\.)?presidenciagobierno\.gq\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const seen = new Set();
    while ((m = linkRegex.exec(html)) !== null) {
      const url = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title.length > 15 && !seen.has(url) && !url.match(/\/(category|tag|page|author)\//)) {
        seen.add(url);
        noticias.push({ title, url, fuente: 'Presidencia GQ', dominio: 'presidenciagobierno.gq', color: '#1e3a5f', category: 'Presidencia' });
      }
    }
  } catch (e) {
    console.log('[Noticias] Error scraping Presidencia GQ:', e.message);
  }
  return noticias.slice(0, 10);
}

// Extrae noticias de lavicepress.com
async function scrapeLaVicePress() {
  const noticias = [];
  try {
    const res = await fetch('https://www.lavicepress.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EGChatBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return noticias;
    const html = await res.text();
    const linkRegex = /<a[^>]+href="(https?:\/\/(?:www\.)?lavicepress\.com\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const seen = new Set();
    while ((m = linkRegex.exec(html)) !== null) {
      const url = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title.length > 15 && !seen.has(url) && !url.match(/\/(category|tag|page|author)\//)) {
        seen.add(url);
        noticias.push({ title, url, fuente: 'La Vice Press', dominio: 'lavicepress.com', color: '#0d9488', category: 'Vicepresidencia' });
      }
    }
  } catch (e) {
    console.log('[Noticias] Error scraping LaVicePress:', e.message);
  }
  return noticias.slice(0, 10);
}

// ── Enviar push de noticia del gobierno a TODOS los usuarios suscritos ────────
async function sendGovNewsPush(noticia) {
  try {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth');

    if (!subs || subs.length === 0) return;

    const payload = JSON.stringify({
      title: `🏛️ ${noticia.fuente}`,
      body: noticia.title,
      notificationType: 'government_news',
      url: '/?view=estados&espacio=e1',
      tag: `gov-news-${noticia.id || Date.now()}`,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      newsUrl: noticia.url,
      newsSource: noticia.fuente,
    });

    let sent = 0;
    await Promise.allSettled(
      subs.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { urgency: 'normal', TTL: 3600 }
        ).then(() => { sent++; }).catch(async err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          }
        })
      )
    );
    console.log(`[GovNews] Push enviado a ${sent}/${subs.length} suscriptores: "${noticia.title.substring(0, 50)}..."`);
  } catch (e) {
    console.error('[GovNews] Error enviando push:', e.message);
  }
}

// ── Scheduler: revisar noticias nuevas cada 10 minutos y notificar ────────────
const govNewsSeenUrls = new Set();
let govNewsSchedulerStarted = false;

async function checkAndNotifyNewGovNews() {
  try {
    const [primatura, gepress, presidencia, lavice] = await Promise.allSettled([
      scrapePrimatura(),
      scrapeGEPress(),
      scrapePresidencia(),
      scrapeLaVicePress(),
    ]);

    const all = [
      ...(primatura.status === 'fulfilled' ? primatura.value : []),
      ...(gepress.status === 'fulfilled' ? gepress.value : []),
      ...(presidencia.status === 'fulfilled' ? presidencia.value : []),
      ...(lavice.status === 'fulfilled' ? lavice.value : []),
    ];

    // Primera ejecución: solo registrar URLs conocidas sin notificar
    if (govNewsSeenUrls.size === 0) {
      all.forEach(n => govNewsSeenUrls.add(n.url));
      console.log(`[GovNews] Scheduler iniciado. ${all.length} noticias registradas como conocidas.`);
      // Actualizar cache
      noticiasCache.data = all.map((n, i) => ({ id: `gov-${Date.now()}-${i}`, ...n, scrapedAt: Date.now() }));
      noticiasCache.timestamp = Date.now();
      return;
    }

    // Detectar noticias nuevas
    const nuevas = all.filter(n => !govNewsSeenUrls.has(n.url));
    nuevas.forEach(n => govNewsSeenUrls.add(n.url));

    if (nuevas.length > 0) {
      console.log(`[GovNews] ${nuevas.length} noticias nuevas detectadas!`);
      // Actualizar cache con todas las noticias
      noticiasCache.data = all.map((n, i) => ({ id: `gov-${Date.now()}-${i}`, ...n, scrapedAt: Date.now() }));
      noticiasCache.timestamp = Date.now();
      // Enviar push solo para las primeras 3 noticias nuevas (evitar spam)
      for (const noticia of nuevas.slice(0, 3)) {
        await sendGovNewsPush({ ...noticia, id: `gov-${Date.now()}` });
        await new Promise(r => setTimeout(r, 1500)); // pausa entre notificaciones
      }
    }
  } catch (e) {
    console.error('[GovNews] Error en scheduler:', e.message);
  }
}

function startGovNewsScheduler() {
  if (govNewsSchedulerStarted) return;
  govNewsSchedulerStarted = true;
  console.log('[GovNews] Scheduler iniciado — revisando cada 10 minutos');
  // Primera ejecución inmediata
  checkAndNotifyNewGovNews();
  // Luego cada 10 minutos
  setInterval(checkAndNotifyNewGovNews, 10 * 60 * 1000);
}

// Noticias de respaldo curadas (cuando las fuentes no responden)
const NOTICIAS_FALLBACK = [
  { title: 'El Ministerio de Sanidad presenta en Bata su Plan de Accion ante el Encargado de la Coordinacion Administrativa', url: 'https://primatura.gob.gq/el-ministerio-de-sanidad-presenta-en-bata-su-plan-de-accion/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Salud', publishedAt: '2025-10-08' },
  { title: 'Avanza con firmeza el Plan de Seguro Medico Universal en Guinea Ecuatorial', url: 'https://primatura.gob.gq/avanza-con-firmeza-el-plan-de-seguro-medico-universal-en-guinea-ecuatorial/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Salud', publishedAt: '2025-10-08' },
  { title: 'Guinea Ecuatorial asume la presidencia rotativa de la CEMAC para el periodo 2026-2027', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Diplomacia', publishedAt: '2026-01-15' },
  { title: 'Camerun y Guinea Ecuatorial firman acuerdo para extraccion conjunta de gas del campo Yoyo-Yolanda', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Energia', publishedAt: '2026-02-03' },
  { title: 'Guinea Ecuatorial anuncia oficialmente el cambio de capital de Malabo a Ciudad de la Paz', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Gobierno', publishedAt: '2026-01-03' },
  { title: 'El Papa Leon XIV visita Guinea Ecuatorial en la ultima etapa de su gira africana', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Internacional', publishedAt: '2026-04-21' },
  { title: 'Turquia amplia estrategia portuaria en Africa: Alport asume los puertos de Malabo y Bata', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Economia', publishedAt: '2026-04-20' },
  { title: 'TGS desarrollara datos sismicos actualizados para Guinea Ecuatorial', url: 'https://www.guineaecuatorialpress.com/', fuente: 'Guinea Ecuatorial Press', dominio: 'guineaecuatorialpress.com', color: '#0369a1', category: 'Energia', publishedAt: '2026-04-18' },
  { title: 'Nuevo programa de becas universitarias 2026: plazo de solicitud hasta el 30 de abril', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Educacion', publishedAt: '2026-04-10' },
  { title: 'Plan Nacional de Empleo Juvenil 2026: 10.000 puestos de trabajo para jovenes guineanos', url: 'https://primatura.gob.gq/', fuente: 'Presidencia del Gobierno', dominio: 'primatura.gob.gq', color: '#1e3a5f', category: 'Empleo', publishedAt: '2026-03-20' },
  { title: 'Vicepresidencia lanza programa de digitalizacion de servicios publicos en Guinea Ecuatorial', url: 'https://www.lavicepress.com/', fuente: 'La Vice Press', dominio: 'lavicepress.com', color: '#0d9488', category: 'Tecnologia', publishedAt: '2026-04-15' },
  { title: 'Presidencia del Gobierno aprueba nuevo plan de infraestructuras para Bata y Malabo', url: 'https://www.presidenciagobierno.gq/', fuente: 'Presidencia GQ', dominio: 'presidenciagobierno.gq', color: '#1e3a5f', category: 'Infraestructura', publishedAt: '2026-04-12' },
];

app.get('/api/noticias/gobierno', async (req, res) => {
  try {
    const now = Date.now();
    // Devolver cache si es reciente
    if (noticiasCache.data.length > 0 && now - noticiasCache.timestamp < NOTICIAS_TTL) {
      return res.json({ noticias: noticiasCache.data, fromCache: true, updatedAt: noticiasCache.timestamp });
    }

    // Intentar scraping en paralelo de todas las fuentes
    const [primatura, gepress, presidencia, lavice] = await Promise.allSettled([
      scrapePrimatura(),
      scrapeGEPress(),
      scrapePresidencia(),
      scrapeLaVicePress(),
    ]);

    const scraped = [
      ...(primatura.status === 'fulfilled' ? primatura.value : []),
      ...(gepress.status === 'fulfilled' ? gepress.value : []),
      ...(presidencia.status === 'fulfilled' ? presidencia.value : []),
      ...(lavice.status === 'fulfilled' ? lavice.value : []),
    ];

    // Si el scraping devuelve resultados, usarlos; si no, usar fallback
    const noticias = scraped.length >= 3 ? scraped : NOTICIAS_FALLBACK;

    // Añadir id y timestamp
    const result = noticias.map((n, i) => ({
      id: `gov-${Date.now()}-${i}`,
      ...n,
      publishedAt: n.publishedAt || new Date().toISOString().split('T')[0],
      scrapedAt: now,
    }));

    noticiasCache.data = result;
    noticiasCache.timestamp = now;

    res.json({ noticias: result, fromCache: false, updatedAt: now });
  } catch (e) {
    // En caso de error total, devolver fallback
    res.json({ noticias: NOTICIAS_FALLBACK.map((n, i) => ({ id: `gov-fb-${i}`, ...n, scrapedAt: Date.now() })), fromCache: false, updatedAt: Date.now() });
  }
});

// ── Endpoint de migración SQL (ejecutar una vez, luego eliminar) ──
const MIGRATION_KEY = 'egchat_migrate_v2_2026';
app.post('/api/admin/run-migration', async (req, res) => {
  const { key } = req.body;
  if (key !== MIGRATION_KEY) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const migrations = [
    // Task #1 — Doble check real
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent'`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_status ON chat_messages(chat_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_sender ON chat_messages(chat_id, sender_id)`,
    // Task #5 — E2E key backup
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_public_key TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_key_backup JSONB`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_backup_updated TIMESTAMPTZ`,
    // Task #7 — Stickers
    `CREATE TABLE IF NOT EXISTS sticker_packs (id VARCHAR(100) PRIMARY KEY, name VARCHAR(100) NOT NULL, author VARCHAR(100) DEFAULT 'EGChat', cover_url TEXT, stickers JSONB DEFAULT '[]', download_count INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS user_sticker_packs (user_id UUID REFERENCES users(id) ON DELETE CASCADE, pack_id VARCHAR(100) NOT NULL, installed_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(user_id, pack_id))`,
    `CREATE TABLE IF NOT EXISTS user_custom_stickers (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE, file_url TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `INSERT INTO sticker_packs (id, name, author, cover_url, stickers) VALUES ('egchat_classic','EGChat Clásico','EGChat','https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif','[{"id":"eg_hi","url":"https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif","label":"👋"}]') ON CONFLICT (id) DO NOTHING`,
    `INSERT INTO sticker_packs (id, name, author, cover_url, stickers) VALUES ('guinea_eq','Guinea Ecuatorial','EGChat','https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif','[{"id":"ge1","url":"https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif","label":"🇬🇶"}]') ON CONFLICT (id) DO NOTHING`,
    // Task #8 — Mini-apps
    `CREATE TABLE IF NOT EXISTS mini_apps (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, name VARCHAR(100) NOT NULL, description TEXT, icon_url TEXT, accent_color VARCHAR(20) DEFAULT '#00c8a0', url TEXT NOT NULL, category VARCHAR(50) DEFAULT 'utilities', permissions JSONB DEFAULT '[]', developer_name VARCHAR(100) DEFAULT 'EGChat', is_verified BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, installs_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS user_mini_apps (user_id UUID REFERENCES users(id) ON DELETE CASCADE, app_id UUID REFERENCES mini_apps(id) ON DELETE CASCADE, installed_at TIMESTAMPTZ DEFAULT NOW(), last_used_at TIMESTAMPTZ, PRIMARY KEY(user_id, app_id))`,
    // Task #9 — Pagos
    `CREATE TABLE IF NOT EXISTS payment_transactions (id TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, type VARCHAR(20) NOT NULL, amount DECIMAL(15,2) NOT NULL, currency VARCHAR(10) DEFAULT 'XAF', gateway VARCHAR(30) NOT NULL, gateway_txn_id TEXT, status VARCHAR(20) DEFAULT 'pending', metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS idx_payment_txns_user ON payment_transactions(user_id, created_at DESC)`,
    // Task #10 — Sesiones multi-dispositivo
    `CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, device_name VARCHAR(150), device_type VARCHAR(30), platform VARCHAR(80), last_seen TIMESTAMPTZ DEFAULT NOW(), is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, is_active)`,
    // Nuevas features — columnas delta
    `ALTER TABLE chats ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'`,
    `ALTER TABLE djangue_members ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member'`,
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS album_urls TEXT[] DEFAULT '{}'`,
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS voice_transcript TEXT`,
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded_from TEXT`,
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS story_reactions (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, story_id UUID NOT NULL, user_id UUID REFERENCES users(id) ON DELETE CASCADE, emoji VARCHAR(10) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(story_id, user_id))`,
    `ALTER TABLE djangue_notifications ADD COLUMN IF NOT EXISTS sent BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE djangue_notifications ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`,
  ];

  const results = [];
  for (const sql of migrations) {
    try {
      const { error } = await supabase.rpc('exec_sql', { sql }).catch(() => ({ error: null }));
      // Intentar directamente si exec_sql no existe
      if (error) {
        // Usar pg directamente
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        await pool.query(sql);
        await pool.end();
        results.push({ sql: sql.slice(0, 60), ok: true });
      } else {
        results.push({ sql: sql.slice(0, 60), ok: true });
      }
    } catch (e) {
      results.push({ sql: sql.slice(0, 60), ok: false, error: e.message });
    }
  }

  const allOk = results.every(r => r.ok);
  res.json({ ok: allOk, results, total: migrations.length, passed: results.filter(r => r.ok).length });
});

// ══════════════════════════════════════════════════════════════════════
// MI DJANGUE ROUTES — Sistema de tanda/caja de ahorro rotativo
// ══════════════════════════════════════════════════════════════════════
const djangueRoutes = require('./src/djangueRoutes');
app.use('/api', djangueRoutes);

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log('🚀 EGCHAT API + Mi Djangue v2.5.8 — Rutas activas');
    console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅ Conectado' : '❌ Sin configurar'}`);
    startGovNewsScheduler();
    console.log(`   Auth:   POST /api/auth/register | /api/auth/login`);
    console.log(`   Wallet: GET  /api/wallet/balance | POST /api/wallet/deposit`);
    console.log(`   Lia-25: POST /api/lia/chat`);
    console.log(`   🎯 Djangue: POST /api/djangue | GET /api/djangues (ACTIVO v2.5.8)\n`);

    // ── Auto-migración v2 al arrancar ──────────────────────────────
    // Se ejecuta solo una vez: si la tabla user_sessions no existe,
    // crea todas las tablas nuevas del roadmap WhatsApp/WeChat parity.
    const runAutoMigration = async () => {
      console.log('[migration] Verificando esquema v2...');
      const MIGRATIONS_V2 = [
        `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent'`,
        `CREATE INDEX IF NOT EXISTS idx_chat_messages_status ON chat_messages(chat_id, status)`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_public_key TEXT`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_key_backup JSONB`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2e_backup_updated TIMESTAMPTZ`,
        `CREATE TABLE IF NOT EXISTS sticker_packs (id VARCHAR(100) PRIMARY KEY, name VARCHAR(100) NOT NULL, author VARCHAR(100) DEFAULT 'EGChat', cover_url TEXT, stickers JSONB DEFAULT '[]', download_count INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS user_sticker_packs (user_id UUID REFERENCES users(id) ON DELETE CASCADE, pack_id VARCHAR(100) NOT NULL, installed_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY(user_id, pack_id))`,
        `CREATE TABLE IF NOT EXISTS user_custom_stickers (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE, file_url TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS mini_apps (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, name VARCHAR(100) NOT NULL, description TEXT, icon_url TEXT, accent_color VARCHAR(20) DEFAULT '#00c8a0', url TEXT NOT NULL, category VARCHAR(50) DEFAULT 'utilities', permissions JSONB DEFAULT '[]', developer_name VARCHAR(100) DEFAULT 'EGChat', is_verified BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, installs_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS user_mini_apps (user_id UUID REFERENCES users(id) ON DELETE CASCADE, app_id UUID REFERENCES mini_apps(id) ON DELETE CASCADE, installed_at TIMESTAMPTZ DEFAULT NOW(), last_used_at TIMESTAMPTZ, PRIMARY KEY(user_id, app_id))`,
        `CREATE TABLE IF NOT EXISTS payment_transactions (id TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, type VARCHAR(20) NOT NULL, amount DECIMAL(15,2) NOT NULL, currency VARCHAR(10) DEFAULT 'XAF', gateway VARCHAR(30) NOT NULL, gateway_txn_id TEXT, status VARCHAR(20) DEFAULT 'pending', metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE INDEX IF NOT EXISTS idx_payment_txns_user ON payment_transactions(user_id, created_at DESC)`,
        `CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL, device_name VARCHAR(150), device_type VARCHAR(30), platform VARCHAR(80), last_seen TIMESTAMPTZ DEFAULT NOW(), is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions(user_id, is_active)`,
        `INSERT INTO sticker_packs (id, name, author, cover_url, stickers) VALUES ('egchat_classic','EGChat Clasico','EGChat','https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif','[{"id":"eg_hi","url":"https://media.tenor.com/RHpFOybx63oAAAAi/hi-wave.gif","label":"wave"}]') ON CONFLICT (id) DO NOTHING`,
        `INSERT INTO sticker_packs (id, name, author, cover_url, stickers) VALUES ('guinea_eq','Guinea Ecuatorial','EGChat','https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif','[{"id":"ge1","url":"https://media.tenor.com/KWBXqCNb-0AAAAAi/party-celebration.gif","label":"GQ"}]') ON CONFLICT (id) DO NOTHING`,
      ];
      let ok = 0, fail = 0;
      for (const sql of MIGRATIONS_V2) {
        try {
          const result = await supabase.rpc('exec_sql', { sql });
          if (!result.error) { ok++; continue; }
        } catch {}
        // Fallback: usar pg directo si exec_sql no existe
        try {
          const { Pool } = require('pg');
          if (process.env.DATABASE_URL) {
            const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
            await pool.query(sql);
            await pool.end();
            ok++;
          } else { fail++; }
        } catch (e) {
          console.warn(`[migration] fallida: ${sql.slice(0, 50)} — ${e.message}`);
          fail++;
        }
      }
      console.log(`[migration] ✅ Completada: ${ok} OK, ${fail} skipped`);
    };
    setTimeout(runAutoMigration, 3000); // 3s después del arranque

    // Crear tabla call_sessions si no existe
    try {
      await supabase.rpc('exec_sql', { sql: `
        CREATE TABLE IF NOT EXISTS call_sessions (
          call_id VARCHAR(100) PRIMARY KEY,
          offer TEXT, answer TEXT,
          caller_candidates TEXT DEFAULT '[]',
          callee_candidates TEXT DEFAULT '[]',
          type VARCHAR(10) DEFAULT 'audio',
          caller_id TEXT NOT NULL,
          target_user_id TEXT NOT NULL,
          ended BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `}).catch(() => {});
    } catch {}
  });
  updateUserVersions();
}

// ════════════════════════════════════════════════════════════════════
// NUEVOS ENDPOINTS — Paridad WhatsApp/WeChat
// ════════════════════════════════════════════════════════════════════

// ── #1: EDITAR MENSAJE ──────────────────────────────────────────────
app.patch('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Texto requerido' });
    const { data, error } = await supabase
      .from('messages')
      .update({ text: text.trim(), edited: true, edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .eq('sender_id', req.user.id)
      .select()
      .single();
    if (error) return res.status(404).json({ error: 'Mensaje no encontrado o sin permiso' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #2: REACCIONES ──────────────────────────────────────────────────
app.post('/api/messages/:messageId/reactions', auth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji requerido' });
    const existing = await supabase
      .from('message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();
    if (existing.data) {
      await supabase.from('message_reactions').delete().eq('id', existing.data.id);
      return res.json({ added: false, emoji });
    }
    await supabase.from('message_reactions').insert({ message_id: messageId, user_id: req.user.id, emoji });

    // ── 4a: Emitir evento SSE al dueño del mensaje para notificación push ──
    try {
      const { data: msg } = await supabase
        .from('chat_messages')
        .select('sender_id, text, chat_id')
        .eq('id', messageId)
        .maybeSingle();
      if (msg && msg.sender_id && String(msg.sender_id) !== String(req.user.id)) {
        const { data: reactor } = await supabase
          .from('users').select('full_name').eq('id', req.user.id).single();
        emitToUser(String(msg.sender_id), {
          type: 'reaction_added',
          messageId,
          chatId: msg.chat_id,
          emoji,
          reactorName: reactor?.full_name || 'Alguien',
          messagePreview: msg.text || '',
          ts: Date.now(),
        });
      }
    } catch { /* no bloquear la respuesta */ }

    res.json({ added: true, emoji });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/:messageId/reactions', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('message_reactions')
      .select('emoji, user_id, created_at')
      .eq('message_id', req.params.messageId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #3: RECEIPTS DE LECTURA ─────────────────────────────────────────
app.post('/api/messages/:messageId/receipts/read', auth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { chat_id } = req.body;
    await supabase.from('message_receipts').upsert({
      message_id: messageId,
      chat_id: chat_id || '',
      user_id: req.user.id,
      read_at: new Date().toISOString(),
    }, { onConflict: 'message_id,user_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/:messageId/receipts', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('message_receipts')
      .select('user_id, delivered_at, read_at, users(full_name, avatar_url)')
      .eq('message_id', req.params.messageId);
    if (error) return res.status(500).json({ error: error.message });
    const result = (data || []).map(r => ({
      user_id: r.user_id,
      full_name: r.users?.full_name,
      avatar_url: r.users?.avatar_url,
      delivered_at: r.delivered_at,
      read_at: r.read_at,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #4: BÚSQUEDA GLOBAL ─────────────────────────────────────────────
app.get('/api/messages/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    if (!q || q.length < 2) return res.json([]);
    const { data: chats } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', req.user.id);
    const chatIds = (chats || []).map(c => c.chat_id);
    if (!chatIds.length) return res.json([]);
    const { data, error } = await supabase
      .from('messages')
      .select('id, chat_id, text, type, sender_id, created_at, sender:users!sender_id(full_name, avatar_url), chat:chats!chat_id(name, type, avatar_url)')
      .in('chat_id', chatIds)
      .ilike('text', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #5: MOMENTS ─────────────────────────────────────────────────────
app.get('/api/moments', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('moments')
      .select(`id, user_id, text, images, likes_count, created_at,
        user:users!user_id(full_name, avatar_url),
        comments:moment_comments(id, user_id, text, created_at, user:users!user_id(full_name))`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    const liked = await supabase.from('moment_likes').select('moment_id').eq('user_id', req.user.id);
    const likedIds = new Set((liked.data || []).map(l => l.moment_id));
    const result = (data || []).map(m => ({
      ...m,
      user_name: m.user?.full_name || 'Usuario',
      user_avatar: m.user?.avatar_url,
      liked_by_me: likedIds.has(m.id),
      comments: (m.comments || []).map(c => ({ ...c, user_name: c.user?.full_name || 'Usuario' })),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/moments', auth, async (req, res) => {
  try {
    const { text, images } = req.body;
    if (!text && (!images || !images.length)) return res.status(400).json({ error: 'Texto o imágenes requeridos' });
    const { data, error } = await supabase
      .from('moments')
      .insert({ user_id: req.user.id, text: text || null, images: images || [] })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    const me = await supabase.from('users').select('full_name, avatar_url').eq('id', req.user.id).single();
    res.json({ ...data, user_name: me.data?.full_name || 'Yo', user_avatar: me.data?.avatar_url, liked_by_me: false, likes: 0, comments: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/moments/:momentId/like', auth, async (req, res) => {
  try {
    const { momentId } = req.params;
    const existing = await supabase.from('moment_likes').select('moment_id').eq('moment_id', momentId).eq('user_id', req.user.id).maybeSingle();
    if (existing.data) {
      await supabase.from('moment_likes').delete().eq('moment_id', momentId).eq('user_id', req.user.id);
      await supabase.from('moments').update({ likes_count: supabase.raw('GREATEST(likes_count - 1, 0)') }).eq('id', momentId);
      return res.json({ liked: false });
    }
    await supabase.from('moment_likes').insert({ moment_id: momentId, user_id: req.user.id });
    await supabase.from('moments').update({ likes_count: supabase.raw('likes_count + 1') }).eq('id', momentId);
    res.json({ liked: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/moments/:momentId/comments', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto requerido' });
    const me = await supabase.from('users').select('full_name').eq('id', req.user.id).single();
    const { data, error } = await supabase
      .from('moment_comments')
      .insert({ moment_id: req.params.momentId, user_id: req.user.id, text })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ...data, user_name: me.data?.full_name || 'Usuario' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #6: CANALES OFICIALES ───────────────────────────────────────────
app.get('/api/channels', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('channels')
      .select('id, name, description, avatar_url, category, verified, followers_count')
      .order('followers_count', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const following = await supabase.from('channel_followers').select('channel_id').eq('user_id', req.user.id);
    const followedIds = new Set((following.data || []).map(f => f.channel_id));
    const posts = await supabase.from('channel_posts').select('channel_id, text, created_at').order('created_at', { ascending: false });
    const lastPost = {};
    (posts.data || []).forEach(p => { if (!lastPost[p.channel_id]) lastPost[p.channel_id] = p; });
    res.json((data || []).map(c => ({ ...c, followed: followedIds.has(c.id), last_post: lastPost[c.id] || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/channels/:channelId/follow', auth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const existing = await supabase.from('channel_followers').select('channel_id').eq('channel_id', channelId).eq('user_id', req.user.id).maybeSingle();
    if (existing.data) {
      await supabase.from('channel_followers').delete().eq('channel_id', channelId).eq('user_id', req.user.id);
      await supabase.from('channels').update({ followers_count: supabase.raw('GREATEST(followers_count - 1, 0)') }).eq('id', channelId);
      return res.json({ followed: false });
    }
    await supabase.from('channel_followers').insert({ channel_id: channelId, user_id: req.user.id });
    await supabase.from('channels').update({ followers_count: supabase.raw('followers_count + 1') }).eq('id', channelId);
    res.json({ followed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #7: PERFIL EMPRESARIAL ──────────────────────────────────────────
app.get('/api/business/profile', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('business_profiles').select('*').eq('user_id', req.user.id).maybeSingle();
    if (!data) return res.json(null);
    const catalog = await supabase.from('catalog_items').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json({ ...data, catalog: catalog.data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/business/profile', auth, async (req, res) => {
  try {
    const fields = ['name', 'category', 'description', 'phone', 'email', 'website', 'address', 'avatar_url'];
    const patch = {};
    fields.forEach(f => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (!patch.name) return res.status(400).json({ error: 'Nombre requerido' });
    const { data, error } = await supabase
      .from('business_profiles')
      .upsert({ user_id: req.user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/business/catalog', auth, async (req, res) => {
  try {
    const { name, price, currency, description, image, available } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const { data, error } = await supabase
      .from('catalog_items')
      .insert({ user_id: req.user.id, name, price: price || '0', currency: currency || 'XAF', description: description || '', image_url: image || null, available: available !== false })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/business/catalog/:itemId', auth, async (req, res) => {
  try {
    await supabase.from('catalog_items').delete().eq('id', req.params.itemId).eq('user_id', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #8: BACKUP EN LA NUBE ───────────────────────────────────────────
app.post('/api/backup/upload', auth, async (req, res) => {
  try {
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
    upload.single('backup')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
      const fileName = `backups/${req.user.id}/${Date.now()}.json`;
      const { error: upErr } = await supabase.storage
        .from('egchat-backups')
        .upload(fileName, req.file.buffer, { contentType: 'application/json', upsert: true });
      if (upErr) {
        // Fallback: guardar registro sin archivo real
        await supabase.from('user_backups').insert({
          user_id: req.user.id, file_path: fileName,
          file_size: req.file.size, chat_count: 0,
        }).catch(() => {});
        return res.json({ ok: true, url: null, size: req.file.size });
      }
      const { data: urlData } = supabase.storage.from('egchat-backups').getPublicUrl(fileName);
      await supabase.from('user_backups').insert({
        user_id: req.user.id, file_path: fileName,
        file_size: req.file.size, chat_count: 0,
      }).catch(() => {});
      res.json({ ok: true, url: urlData?.publicUrl, size: req.file.size });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── #9: OTP / VERIFICACIÓN SMS ──────────────────────────────────────
// Enviar código SMS de verificación
app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Teléfono requerido' });

    // Generar código de 6 dígitos
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutos

    // Guardar en memoria (en producción usar Redis o DB)
    if (!global.verificationCodes) global.verificationCodes = new Map();
    global.verificationCodes.set(phone, { code, expiresAt });

    // Intentar enviar SMS via Twilio
    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromPhone = process.env.TWILIO_PHONE;

      if (accountSid && authToken && fromPhone) {
        const twilio = require('twilio')(accountSid, authToken);
        await twilio.messages.create({
          body: `Tu código de verificación EGCHAT es: ${code}. Válido 10 minutos.`,
          from: fromPhone,
          to: phone
        });
        console.log(`[SMS] Código enviado a ${phone}: ${code}`);
        return res.json({ message: 'Código enviado', sent: true });
      }
    } catch (twilioError) {
      console.error('[SMS] Error Twilio:', twilioError.message);
    }

    // Si Twilio no está configurado o falló, devolver código en desarrollo
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] Código de verificación para ${phone}: ${code}`);
      return res.json({ message: 'Código generado (dev mode)', code, sent: false });
    }

    res.json({ message: 'Código generado', sent: false });
  } catch (e) {
    console.error('[SMS] Error:', e);
    res.status(500).json({ message: 'Error al enviar código' });
  }
});

// El endpoint /api/auth/verify-code ya existe (línea 423)
// Añadimos el de envío si no existe:

// ══════════════════════════════════════════════════════════════════
// MI DJANGUE — Tanda / Caja de Ahorro Grupal
// ══════════════════════════════════════════════════════════════════

// ── Helpers ───────────────────────────────────────────────────────
const calcNextPayoutDate = (frequency) => {
  const d = new Date();
  if (frequency === 'daily')   d.setDate(d.getDate() + 1);
  if (frequency === 'weekly')  d.setDate(d.getDate() + 7);
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  if (frequency === 'annual')  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
};

// ══════════════════════════════════════════════════════════════════
// ── NOTIFICACIONES PUSH (EXPO) ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const { Expo } = require('expo-server-sdk');
const expoPush = new Expo();

/*
 * NOTA: sendPushToUser ya está definida anteriormente en la línea 6203
 * Esta es una definición duplicada que se comenta para evitar conflictos
 */

// ══════════════════════════════════════════════════════════════════
// ── DJANGUE (TANDA / CAJA DE AHORRO GRUPAL) ───────────────────────
// ══════════════════════════════════════════════════════════════════

// ── GET /api/djangue — Mis djangues (como miembro o responsable) ──
app.get('/api/djangue', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Grupos donde soy miembro
    const { data: memberRows } = await supabase
      .from('djangue_members')
      .select('group_id')
      .eq('user_id', userId)
      .eq('status', 'active');

    const memberGroupIds = (memberRows || []).map(r => r.group_id);

    // Grupos donde soy dueño o secretario (aunque no esté en members)
    const { data: ownedGroups } = await supabase
      .from('djangue_groups')
      .select('id')
      .or(`owner_id.eq.${userId},secretary_id.eq.${userId}`);

    const ownedIds = (ownedGroups || []).map(r => r.id);
    const allIds   = [...new Set([...memberGroupIds, ...ownedIds])];

    if (!allIds.length) return res.json([]);

    const { data: groups, error } = await supabase
      .from('djangue_groups')
      .select(`
        id, name, description, frequency, quota_amount, currency,
        max_members, status, current_turn, total_turns, next_payout_at,
        owner_id, secretary_id, created_at,
        djangue_wallets (balance),
        djangue_members (count)
      `)
      .in('id', allIds)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enriquecer con info de si ya pagué este turno
    const enriched = await Promise.all((groups || []).map(async (g) => {
      const { data: myMember } = await supabase
        .from('djangue_members')
        .select('id, turn_order')
        .eq('group_id', g.id)
        .eq('user_id', userId)
        .maybeSingle();

      const { data: myContrib } = myMember ? await supabase
        .from('djangue_contributions')
        .select('status')
        .eq('group_id', g.id)
        .eq('user_id', userId)
        .eq('turn_number', g.current_turn)
        .maybeSingle() : { data: null };

      return {
        ...g,
        wallet_balance: g.djangue_wallets?.[0]?.balance ?? 0,
        member_count: g.djangue_members?.[0]?.count ?? 0,
        my_role: g.owner_id === userId ? 'owner' : g.secretary_id === userId ? 'secretary' : 'member',
        my_turn_order: myMember?.turn_order ?? null,
        my_paid_this_turn: myContrib?.status === 'paid',
        is_my_turn: myMember?.turn_order === g.current_turn,
      };
    }));

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /api/djangue/my-list — Lista separada admin/miembro ───────
// IMPORTANTE: debe ir ANTES de /:id para que Express no lo confunda con id="my-list"
app.get('/api/djangue/my-list', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Grupos donde soy dueño o secretario
    const { data: ownedGroups } = await supabase
      .from('djangue_groups')
      .select(`id, name, logo_url, frequency, quota_amount, currency,
               max_members, status, current_turn, total_turns, next_payout_at,
               owner_id, secretary_id, created_at,
               djangue_wallets (balance),
               djangue_members (count)`)
      .or(`owner_id.eq.${userId},secretary_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    // Grupos donde soy miembro pero no owner/secretary
    const { data: memberRows } = await supabase
      .from('djangue_members')
      .select('group_id')
      .eq('user_id', userId)
      .eq('status', 'active');

    const memberGroupIds = (memberRows || []).map(r => r.group_id);
    const ownedIds = (ownedGroups || []).map(g => g.id);
    const purelyMemberIds = memberGroupIds.filter(id => !ownedIds.includes(id));

    let memberGroups = [];
    if (purelyMemberIds.length > 0) {
      const { data } = await supabase
        .from('djangue_groups')
        .select(`id, name, logo_url, frequency, quota_amount, currency,
                 max_members, status, current_turn, total_turns, next_payout_at,
                 owner_id, secretary_id, created_at,
                 djangue_wallets (balance),
                 djangue_members (count)`)
        .in('id', purelyMemberIds)
        .order('created_at', { ascending: false });
      memberGroups = data || [];
    }

    const enrich = async (g, role) => {
      const { data: myMember } = await supabase
        .from('djangue_members')
        .select('id, turn_order')
        .eq('group_id', g.id)
        .eq('user_id', userId)
        .maybeSingle();

      const { data: myContrib } = myMember ? await supabase
        .from('djangue_contributions')
        .select('status')
        .eq('group_id', g.id)
        .eq('user_id', userId)
        .eq('turn_number', g.current_turn)
        .maybeSingle() : { data: null };

      return {
        ...g,
        wallet_balance: g.djangue_wallets?.[0]?.balance ?? 0,
        member_count: g.djangue_members?.[0]?.count ?? 0,
        my_role: role,
        my_turn_order: myMember?.turn_order ?? null,
        my_paid_this_turn: myContrib?.status === 'paid',
        is_my_turn: myMember?.turn_order === g.current_turn,
        next_payout_date: g.next_payout_at,
      };
    };

    const adminEnriched = await Promise.all(
      (ownedGroups || []).map(g =>
        enrich(g, g.owner_id === userId ? 'owner' : 'secretary')
      )
    );
    const memberEnriched = await Promise.all(
      memberGroups.map(g => enrich(g, 'member'))
    );

    res.json({ admin: adminEnriched, member: memberEnriched });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue — Crear grupo ───────────────────────────────
app.post('/api/djangue', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, frequency, quota_amount, max_members, secretary_phone } = req.body;

    if (!name || !frequency || !quota_amount)
      return res.status(400).json({ message: 'name, frequency y quota_amount son requeridos' });
    if (!['daily','weekly','monthly','annual'].includes(frequency))
      return res.status(400).json({ message: 'frequency debe ser: daily, weekly, monthly, annual' });
    if (quota_amount < 100)
      return res.status(400).json({ message: 'Cuota mínima: 100 XAF' });

    // Buscar secretario por teléfono (opcional)
    let secretaryId = null;
    if (secretary_phone) {
      const { data: sec } = await supabase
        .from('users').select('id').eq('phone', secretary_phone).maybeSingle();
      if (!sec) return res.status(404).json({ message: 'Secretario no encontrado. Verifica el teléfono.' });
      secretaryId = sec.id;
    }

    // Crear grupo
    const { data: group, error: gErr } = await supabase
      .from('djangue_groups')
      .insert({
        name, description, frequency,
        quota_amount: Number(quota_amount),
        max_members: max_members || 12,
        owner_id: userId,
        secretary_id: secretaryId,
        current_turn: 1,
        total_turns: 0,
        next_payout_at: calcNextPayoutDate(frequency),
      })
      .select()
      .single();
    if (gErr) throw gErr;

    // Crear monedero del djangue
    await supabase.from('djangue_wallets').insert({ group_id: group.id, balance: 0 });

    // Actualizar wallet_id en el grupo
    const { data: wallet } = await supabase
      .from('djangue_wallets').select('id').eq('group_id', group.id).single();
    await supabase.from('djangue_groups').update({ wallet_id: wallet.id }).eq('id', group.id);

    // Agregar al owner como primer miembro (turno 1)
    await supabase.from('djangue_members').insert({
      group_id: group.id, user_id: userId, turn_order: 1, status: 'active',
    });
    await supabase.from('djangue_groups').update({ total_turns: 1 }).eq('id', group.id);

    // Si hay secretario diferente al owner, agregarlo también
    if (secretaryId && secretaryId !== userId) {
      await supabase.from('djangue_members').insert({
        group_id: group.id, user_id: secretaryId, turn_order: 2, status: 'active',
      });
      await supabase.from('djangue_groups').update({ total_turns: 2 }).eq('id', group.id);
    }

    res.status(201).json({ ...group, wallet_id: wallet.id });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /api/djangue/:id — Detalle del grupo ──────────────────────
app.get('/api/djangue/:id', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group, error } = await supabase
      .from('djangue_groups')
      .select('*')
      .eq('id', groupId)
      .single();
    if (error || !group) return res.status(404).json({ message: 'Djangue no encontrado' });

    // Verificar que el usuario es miembro, owner o secretario
    const { data: myMember } = await supabase
      .from('djangue_members')
      .select('id, turn_order')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!myMember && group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'No eres miembro de este djangue' });

    // Obtener miembros con sus usuarios y estado de pago del turno actual
    const { data: members } = await supabase
      .from('djangue_members')
      .select('id, turn_order, status, user_id, joined_at')
      .eq('group_id', groupId)
      .eq('status', 'active')
      .order('turn_order');

    const membersWithInfo = await Promise.all((members || []).map(async (m) => {
      const { data: user } = await supabase
        .from('users').select('id, full_name, phone, avatar_url').eq('id', m.user_id).single();
      const { data: contrib } = await supabase
        .from('djangue_contributions')
        .select('status, amount, paid_at')
        .eq('group_id', groupId)
        .eq('user_id', m.user_id)
        .eq('turn_number', group.current_turn)
        .maybeSingle();
      return {
        ...m,
        user,
        paid_current_turn: contrib?.status === 'paid',
        contribution: contrib || null,
        is_current_beneficiary: m.turn_order === group.current_turn,
      };
    }));

    // Monedero del djangue
    const { data: wallet } = await supabase
      .from('djangue_wallets').select('balance, currency').eq('group_id', groupId).single();

    // Total cotizado este turno
    const { data: contribs } = await supabase
      .from('djangue_contributions')
      .select('amount, status')
      .eq('group_id', groupId)
      .eq('turn_number', group.current_turn);

    const totalPaidThisTurn = (contribs || [])
      .filter(c => c.status === 'paid')
      .reduce((sum, c) => sum + Number(c.amount), 0);

    const expectedTotal = group.quota_amount * (membersWithInfo.length - 1); // todos menos el beneficiario

    res.json({
      ...group,
      members: membersWithInfo,
      wallet,
      my_role: group.owner_id === userId ? 'owner' : group.secretary_id === userId ? 'secretary' : 'member',
      my_turn_order: myMember?.turn_order ?? null,
      is_my_turn: myMember?.turn_order === group.current_turn,
      total_paid_this_turn: totalPaidThisTurn,
      expected_total_this_turn: expectedTotal,
      paid_count: (contribs || []).filter(c => c.status === 'paid').length,
      pending_count: membersWithInfo.length - (contribs || []).filter(c => c.status === 'paid').length,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/members — Agregar miembro ───────────────
app.post('/api/djangue/:id/members', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;
    const { phone } = req.body;

    if (!phone) return res.status(400).json({ message: 'Teléfono requerido' });

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });

    // Solo owner o secretario pueden agregar
    if (group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Solo el responsable o secretario pueden agregar miembros' });

    // Buscar usuario por teléfono
    const { data: newUser } = await supabase
      .from('users').select('id, full_name, phone, avatar_url').eq('phone', phone).maybeSingle();
    if (!newUser) return res.status(404).json({ message: 'Usuario no encontrado con ese teléfono' });

    // Verificar que no sea ya miembro
    const { data: existing } = await supabase
      .from('djangue_members')
      .select('id').eq('group_id', groupId).eq('user_id', newUser.id).maybeSingle();
    if (existing) return res.status(409).json({ message: 'Este usuario ya es miembro del djangue' });

    // Verificar capacidad
    const { data: currentMembers } = await supabase
      .from('djangue_members').select('id').eq('group_id', groupId).eq('status', 'active');
    if ((currentMembers || []).length >= group.max_members)
      return res.status(400).json({ message: `El djangue está lleno (máx. ${group.max_members} miembros)` });

    const nextTurn = group.total_turns + 1;

    const { data: member, error } = await supabase
      .from('djangue_members')
      .insert({ group_id: groupId, user_id: newUser.id, turn_order: nextTurn, status: 'active' })
      .select().single();
    if (error) throw error;

    await supabase.from('djangue_groups')
      .update({ total_turns: nextTurn })
      .eq('id', groupId);

    res.status(201).json({ member, user: newUser });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/pay — Pagar cuota del turno actual ──────
app.post('/api/djangue/:id/pay', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.status !== 'active') return res.status(400).json({ message: 'Este djangue no está activo' });

    // Verificar que es miembro
    const { data: member } = await supabase
      .from('djangue_members')
      .select('id, turn_order').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
    if (!member) return res.status(403).json({ message: 'No eres miembro de este djangue' });

    // El beneficiario del turno actual no paga
    if (member.turn_order === group.current_turn)
      return res.status(400).json({ message: 'Es tu turno de recibir, no de pagar' });

    // Verificar que no haya pagado ya
    const { data: existing } = await supabase
      .from('djangue_contributions')
      .select('id, status').eq('group_id', groupId).eq('user_id', userId)
      .eq('turn_number', group.current_turn).maybeSingle();
    if (existing?.status === 'paid')
      return res.status(409).json({ message: 'Ya pagaste tu cuota para este turno' });

    // Verificar saldo en monedero personal
    const { data: wallet } = await supabase
      .from('wallets').select('id, balance').eq('user_id', userId).single();
    if (!wallet) return res.status(404).json({ message: 'Monedero no encontrado' });
    if (Number(wallet.balance) < Number(group.quota_amount))
      return res.status(400).json({ message: `Saldo insuficiente. Necesitas ${group.quota_amount} XAF` });

    // Monedero del djangue
    const { data: djangueWallet } = await supabase
      .from('djangue_wallets').select('id, balance').eq('group_id', groupId).single();

    // Descontar del monedero personal
    await supabase.from('wallets')
      .update({ balance: Number(wallet.balance) - Number(group.quota_amount) })
      .eq('id', wallet.id);

    // Agregar al monedero del djangue
    await supabase.from('djangue_wallets')
      .update({ balance: Number(djangueWallet.balance) + Number(group.quota_amount) })
      .eq('id', djangueWallet.id);

    // Registrar transacción en historial general
    const { data: tx } = await supabase.from('transactions').insert({
      user_id: userId,
      type: 'djangue_contribution',
      amount: -Number(group.quota_amount),
      currency: group.currency,
      description: `Cuota djangue "${group.name}" — Turno ${group.current_turn}`,
      status: 'completed',
    }).select('id').single();

    // Registrar contribución
    const { data: contrib, error: cErr } = await supabase
      .from('djangue_contributions')
      .upsert({
        group_id: groupId,
        member_id: member.id,
        user_id: userId,
        turn_number: group.current_turn,
        amount: group.quota_amount,
        status: 'paid',
        paid_at: new Date().toISOString(),
        transaction_id: tx?.id,
      }, { onConflict: 'group_id,member_id,turn_number' })
      .select().single();
    if (cErr) throw cErr;

    // Verificar si todos pagaron → ejecutar payout automático
    const { data: allMembers } = await supabase
      .from('djangue_members').select('id, turn_order, user_id')
      .eq('group_id', groupId).eq('status', 'active');

    const nonBeneficiaries = (allMembers || []).filter(m => m.turn_order !== group.current_turn);

    const { data: paidContribs } = await supabase
      .from('djangue_contributions')
      .select('user_id').eq('group_id', groupId)
      .eq('turn_number', group.current_turn).eq('status', 'paid');

    const allPaid = paidContribs?.length >= nonBeneficiaries.length;

    if (allPaid) {
      // Encontrar beneficiario
      const beneficiary = (allMembers || []).find(m => m.turn_order === group.current_turn);
      if (beneficiary) {
        const payoutAmount = Number(djangueWallet.balance) + Number(group.quota_amount); // incluye este pago

        // Transferir al monedero del beneficiario
        const { data: benWallet } = await supabase
          .from('wallets').select('id, balance').eq('user_id', beneficiary.user_id).single();

        if (benWallet) {
          await supabase.from('wallets')
            .update({ balance: Number(benWallet.balance) + payoutAmount })
            .eq('id', benWallet.id);

          // Vaciar monedero del djangue
          await supabase.from('djangue_wallets').update({ balance: 0 }).eq('group_id', groupId);

          // Registrar payout
          await supabase.from('djangue_payouts').insert({
            group_id: groupId, beneficiary_id: beneficiary.user_id,
            turn_number: group.current_turn, amount: payoutAmount,
            status: 'completed', paid_at: new Date().toISOString(),
          });

          // Registrar transacción para el beneficiario
          await supabase.from('transactions').insert({
            user_id: beneficiary.user_id,
            type: 'djangue_payout',
            amount: payoutAmount,
            currency: group.currency,
            description: `Turno ${group.current_turn} djangue "${group.name}"`,
            status: 'completed',
          });

          // Avanzar turno
          const nextTurn = group.current_turn + 1;
          const isCompleted = nextTurn > (allMembers || []).length;

          await supabase.from('djangue_groups').update({
            current_turn: isCompleted ? group.current_turn : nextTurn,
            status: isCompleted ? 'completed' : 'active',
            next_payout_at: isCompleted ? null : calcNextPayoutDate(group.frequency),
          }).eq('id', groupId);

          // Notificar al nuevo beneficiario (si hay siguiente turno)
          if (!isCompleted) {
            const nextBeneficiary = (allMembers || []).find(m => m.turn_order === nextTurn);
            if (nextBeneficiary) {
              // Enviar notificación push (función definida más abajo en el archivo)
              try {
                await sendPushToUser(
                  nextBeneficiary.user_id,
                  '🎉 ¡Es tu turno en Mi Djangue!',
                  `Este turno te toca recibir en "${group.name}". Espera a que todos paguen.`,
                  { type: 'djangue_turn', group_id: groupId, turn: nextTurn }
                );
              } catch (pushErr) {
                console.error('Error sending push notification:', pushErr);
                // No bloqueamos el pago si falla la notificación
              }
            }
          }
        }
      }
    }

    res.json({
      ok: true,
      contribution: contrib,
      all_paid: allPaid,
      new_balance: Number(wallet.balance) - Number(group.quota_amount),
      message: allPaid
        ? `¡Todos pagaron! El beneficiario recibió el fondo del turno ${group.current_turn}.`
        : `Cuota pagada correctamente (${group.quota_amount} ${group.currency})`,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/manual-payout — Pago manual al beneficiario (admin/secretario) ──
app.post('/api/djangue/:id/manual-payout', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });

    // Solo admin o secretario pueden forzar payout
    const { data: me } = await supabase
      .from('djangue_members').select('role').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
    if (!me || !['owner', 'secretary'].includes(me.role))
      return res.status(403).json({ message: 'Solo el administrador o secretario puede ejecutar el pago' });

    // Encontrar beneficiario del turno actual
    const { data: beneficiaryMember } = await supabase
      .from('djangue_members').select('user_id').eq('group_id', groupId)
      .eq('turn_order', group.current_turn).eq('status', 'active').maybeSingle();
    if (!beneficiaryMember) return res.status(400).json({ message: 'No se encontró el beneficiario del turno actual' });

    // Saldo del monedero del djangue
    const { data: djangueWallet } = await supabase
      .from('djangue_wallets').select('id, balance').eq('group_id', groupId).single();
    if (!djangueWallet || Number(djangueWallet.balance) <= 0)
      return res.status(400).json({ message: 'El monedero del djangue está vacío' });

    const payoutAmount = Number(djangueWallet.balance);

    // Transferir al beneficiario
    const { data: benWallet } = await supabase
      .from('wallets').select('id, balance').eq('user_id', beneficiaryMember.user_id).single();
    if (!benWallet) return res.status(404).json({ message: 'Monedero del beneficiario no encontrado' });

    await supabase.from('wallets')
      .update({ balance: Number(benWallet.balance) + payoutAmount })
      .eq('id', benWallet.id);

    // Vaciar monedero djangue
    await supabase.from('djangue_wallets').update({ balance: 0 }).eq('group_id', groupId);

    // Registrar payout
    await supabase.from('djangue_payouts').insert({
      group_id: groupId, beneficiary_id: beneficiaryMember.user_id,
      turn_number: group.current_turn, amount: payoutAmount,
      status: 'completed', paid_at: new Date().toISOString(),
    });

    // Registrar transacción
    await supabase.from('transactions').insert({
      user_id: beneficiaryMember.user_id,
      type: 'djangue_payout',
      amount: payoutAmount,
      currency: group.currency,
      description: `Pago manual turno ${group.current_turn} — "${group.name}"`,
      status: 'completed',
    });

    res.json({ ok: true, amount: payoutAmount, beneficiary_id: beneficiaryMember.user_id });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/advance-turn — Avanzar al siguiente turno ──────────
app.post('/api/djangue/:id/advance-turn', auth, async (req, res) => {
  try {
    const groupId = req.params.id;
    const userId = req.user.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });

    // Solo owner o secretary
    const { data: me } = await supabase
      .from('djangue_members').select('role').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
    if (!me || !['owner', 'secretary'].includes(me.role))
      return res.status(403).json({ message: 'Solo el administrador o secretario puede avanzar el turno' });

    const { data: members } = await supabase
      .from('djangue_members').select('id, user_id, turn_order').eq('group_id', groupId).eq('status', 'active');
    const totalMembers = members?.length || 1;
    const nextTurn = (group.current_turn % totalMembers) + 1;

    // Calcular próxima fecha según frecuencia
    const now = new Date();
    let nextDate = new Date(now);
    if (group.frequency === 'weekly')       nextDate.setDate(now.getDate() + 7);
    else if (group.frequency === 'biweekly') nextDate.setDate(now.getDate() + 14);
    else                                      nextDate.setMonth(now.getMonth() + 1);

    await supabase.from('djangue_groups').update({
      current_turn: nextTurn,
      period_end_date: nextDate.toISOString(),
    }).eq('id', groupId);

    // Notificar al nuevo beneficiario
    const newBeneficiary = members?.find(m => m.turn_order === nextTurn);
    if (newBeneficiary) {
      await supabase.from('djangue_notifications').insert({
        group_id: groupId,
        user_id: newBeneficiary.user_id,
        type: 'your_turn',
        message: `🎉 ¡Es tu turno! Recibirás el pote del djangue "${group.name}" al finalizar el período.`,
        sent: false,
        created_at: now.toISOString(),
      });
    }

    res.json({ ok: true, new_turn: nextTurn, period_end_date: nextDate.toISOString() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /api/djangue/:id/contributions — Ver quién ha pagado ──────
app.get('/api/djangue/:id/contributions', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });

    // Verificar acceso
    const { data: member } = await supabase
      .from('djangue_members').select('id').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
    if (!member && group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Sin acceso' });

    const turnNumber = req.query.turn ? Number(req.query.turn) : group.current_turn;

    const { data: contribs } = await supabase
      .from('djangue_contributions')
      .select('*, users(full_name, phone, avatar_url)')
      .eq('group_id', groupId)
      .eq('turn_number', turnNumber)
      .order('paid_at', { ascending: false });

    res.json({ turn_number: turnNumber, contributions: contribs || [] });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── DELETE /api/djangue/:id — Cancelar djangue (solo owner) ───────
app.delete('/api/djangue/:id', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('owner_id').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.owner_id !== userId) return res.status(403).json({ message: 'Solo el responsable puede cancelar' });

    await supabase.from('djangue_groups').update({ status: 'cancelled' }).eq('id', groupId);
    res.json({ ok: true, message: 'Djangue cancelado' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/push/register — Registrar token push ────────────────
app.post('/api/push/register', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;

    if (!token || !Expo.isExpoPushToken(token)) {
      return res.status(400).json({ message: 'Token Expo Push inválido' });
    }

    // Insertar o actualizar token
    await supabase.from('expo_push_tokens').upsert({
      user_id: userId,
      token,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,token' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/push/register-expo-token — Alias para compatibilidad ─
app.post('/api/push/register-expo-token', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { expoPushToken } = req.body;

    if (!expoPushToken || !Expo.isExpoPushToken(expoPushToken)) {
      return res.status(400).json({ message: 'Token Expo Push inválido' });
    }

    // Insertar o actualizar token
    await supabase.from('expo_push_tokens').upsert({
      user_id: userId,
      token: expoPushToken,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,token' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// DJANGUE — Rutas faltantes (v2)
// ══════════════════════════════════════════════════════════════════

// ── GET /api/djangue/:id/member-view — Vista del integrante ───────
app.get('/api/djangue/:id/member-view', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });

    const { data: myMember } = await supabase
      .from('djangue_members')
      .select('id, turn_order')
      .eq('group_id', groupId).eq('user_id', userId).maybeSingle();

    if (!myMember && group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'No eres miembro de este djangue' });

    const turnOrder = myMember?.turn_order ?? null;

    // Mis contribuciones históricas
    const { data: myContribs } = await supabase
      .from('djangue_contributions')
      .select('id, turn_number, amount, paid_at, status')
      .eq('group_id', groupId).eq('user_id', userId)
      .order('turn_number');

    // Mis payouts recibidos
    const { data: myPayouts } = await supabase
      .from('djangue_payouts')
      .select('id, turn_number, amount, paid_at')
      .eq('group_id', groupId).eq('beneficiary_id', userId)
      .order('turn_number');

    // Moras pendientes
    const { data: penalties } = await supabase
      .from('djangue_penalties')
      .select('id, penalty_amount, turn_number, status')
      .eq('group_id', groupId).eq('user_id', userId);

    const pendingPenalties = (penalties || [])
      .filter(p => p.status === 'pending')
      .reduce((sum, p) => sum + Number(p.penalty_amount || 0), 0);
    const totalPenaltiesPaid = (penalties || [])
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + Number(p.penalty_amount || 0), 0);

    // Contribución del turno actual
    const { data: currentContrib } = await supabase
      .from('djangue_contributions')
      .select('status, amount')
      .eq('group_id', groupId).eq('user_id', userId)
      .eq('turn_number', group.current_turn).maybeSingle();

    const paidCurrentTurn = currentContrib?.status === 'paid';

    // Calcular turnos hasta el mío
    const turnsUntilMine = turnOrder
      ? (turnOrder >= group.current_turn
          ? turnOrder - group.current_turn
          : group.total_turns - group.current_turn + turnOrder)
      : null;

    // Estimar fecha de mi turno
    let myTurnDateEstimate = null;
    if (turnsUntilMine !== null && group.next_payout_at) {
      const base = new Date(group.next_payout_at);
      const msPerTurn = {
        daily: 86400000, weekly: 604800000,
        monthly: 30 * 86400000, annual: 365 * 86400000,
      }[group.frequency] || 30 * 86400000;
      myTurnDateEstimate = new Date(base.getTime() + turnsUntilMine * msPerTurn).toISOString();
    }

    const totalPaid = (myContribs || []).filter(c => c.status === 'paid').reduce((s, c) => s + Number(c.amount), 0);
    const totalReceived = (myPayouts || []).reduce((s, p) => s + Number(p.amount), 0);
    const onTimePaid = (myContribs || []).filter(c => c.status === 'paid' && c.paid_at).length;
    const totalDue = (myContribs || []).filter(c => c.status !== 'justified').length;

    res.json({
      group_id: group.id,
      group_name: group.name,
      group_logo: group.logo_url,
      frequency: group.frequency,
      quota_amount: group.quota_amount,
      currency: group.currency,
      current_turn: group.current_turn,
      total_turns: group.total_turns,
      status: group.status,
      chat_group_id: group.chat_group_id,
      next_payout_at: group.next_payout_at,
      my_turn_order: turnOrder,
      is_my_turn: turnOrder === group.current_turn,
      paid_current_turn: paidCurrentTurn,
      amount_paid_current_turn: paidCurrentTurn ? Number(currentContrib?.amount || 0) : 0,
      amount_owed: paidCurrentTurn ? 0 : Number(group.quota_amount),
      turns_until_mine: turnsUntilMine,
      my_turn_date_estimate: myTurnDateEstimate,
      expected_payout: Number(group.quota_amount) * ((group.total_turns || 1) - 1),
      total_paid: totalPaid,
      turns_received: (myPayouts || []).length,
      total_received: totalReceived,
      payment_streak: onTimePaid,
      on_time_percentage: totalDue > 0 ? Math.round((onTimePaid / totalDue) * 100) : 100,
      my_contributions: myContribs || [],
      my_payouts: myPayouts || [],
      pending_penalties: pendingPenalties,
      total_penalties_paid: totalPenaltiesPaid,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /api/djangue/:id/secretary-view — Panel del secretario ────
app.get('/api/djangue/:id/secretary-view', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });

    if (group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Solo el secretario o administrador puede ver esta vista' });

    const { data: members } = await supabase
      .from('djangue_members')
      .select('id, turn_order, user_id')
      .eq('group_id', groupId).eq('status', 'active')
      .order('turn_order');

    const membersWithInfo = await Promise.all((members || []).map(async (m) => {
      const { data: user } = await supabase
        .from('users').select('id, full_name, phone, avatar_url').eq('id', m.user_id).single();
      const { data: contrib } = await supabase
        .from('djangue_contributions')
        .select('status, justification_note')
        .eq('group_id', groupId).eq('user_id', m.user_id)
        .eq('turn_number', group.current_turn).maybeSingle();
      return {
        ...m,
        user,
        paid_current_turn: contrib?.status === 'paid',
        has_justified: contrib?.status === 'justified',
        justification_note: contrib?.justification_note || null,
        is_current_beneficiary: m.turn_order === group.current_turn,
      };
    }));

    const paidCount    = membersWithInfo.filter(m => m.paid_current_turn).length;
    const pendingCount = membersWithInfo.filter(m => !m.paid_current_turn && !m.is_current_beneficiary && !m.has_justified).length;

    res.json({
      id: group.id,
      name: group.name,
      current_turn: group.current_turn,
      quota_amount: group.quota_amount,
      currency: group.currency,
      penalty_percent: group.penalty_percent,
      notification_days_before: group.notification_days_before,
      notification_final_days: group.notification_final_days,
      period_end_date: group.period_end_date,
      chat_group_id: group.chat_group_id,
      members: membersWithInfo,
      paid_count: paidCount,
      pending_count: pendingCount,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/justify — Integrante justifica ausencia ─
app.post('/api/djangue/:id/justify', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;
    const { note } = req.body;

    if (!note?.trim()) return res.status(400).json({ message: 'La justificación no puede estar vacía' });

    const { data: member } = await supabase
      .from('djangue_members')
      .select('id').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
    if (!member) return res.status(403).json({ message: 'No eres miembro de este djangue' });

    const { data: group } = await supabase
      .from('djangue_groups').select('current_turn').eq('id', groupId).single();

    await supabase.from('djangue_contributions').upsert({
      group_id: groupId,
      member_id: member.id,
      user_id: userId,
      turn_number: group.current_turn,
      amount: 0,
      status: 'justified',
      justification_note: note.trim(),
    }, { onConflict: 'group_id,member_id,turn_number' });

    res.json({ ok: true, message: 'Justificación registrada correctamente' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/justify-absence — Secretario justifica a un miembro ─
app.post('/api/djangue/:id/justify-absence', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;
    const { member_id, note } = req.body;

    if (!member_id || !note?.trim())
      return res.status(400).json({ message: 'member_id y note son requeridos' });

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Solo el secretario o administrador puede justificar ausencias' });

    const { data: targetMember } = await supabase
      .from('djangue_members')
      .select('id, user_id').eq('id', member_id).eq('group_id', groupId).maybeSingle();
    if (!targetMember) return res.status(404).json({ message: 'Miembro no encontrado' });

    await supabase.from('djangue_contributions').upsert({
      group_id: groupId,
      member_id: member_id,
      user_id: targetMember.user_id,
      turn_number: group.current_turn,
      amount: 0,
      status: 'justified',
      justification_note: note.trim(),
    }, { onConflict: 'group_id,member_id,turn_number' });

    res.json({ ok: true, message: 'Ausencia justificada correctamente' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/send-reminder — Enviar recordatorio ─────
app.post('/api/djangue/:id/send-reminder', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;
    const { type, member_id } = req.body;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Solo el secretario o administrador puede enviar recordatorios' });

    const pushPayload = {
      title: '⏰ Recordatorio — Djangue',
      body: `Recuerda pagar tu cuota del djangue "${group.name}" antes de que se cierre el turno ${group.current_turn}.`,
      data: { type: 'djangue_reminder', group_id: groupId },
    };

    if (member_id) {
      // Recordatorio a un solo miembro
      const { data: targetMember } = await supabase
        .from('djangue_members')
        .select('user_id').eq('id', member_id).eq('group_id', groupId).maybeSingle();
      if (!targetMember) return res.status(404).json({ message: 'Miembro no encontrado' });
      await sendPushToUser(targetMember.user_id, pushPayload);
    } else {
      // Recordatorio a todos los que no han pagado
      const { data: members } = await supabase
        .from('djangue_members')
        .select('id, user_id, turn_order')
        .eq('group_id', groupId).eq('status', 'active');

      const { data: paidContribs } = await supabase
        .from('djangue_contributions')
        .select('user_id')
        .eq('group_id', groupId).eq('turn_number', group.current_turn).eq('status', 'paid');

      const paidUserIds = new Set((paidContribs || []).map(c => c.user_id));

      const pending = (members || []).filter(m =>
        !paidUserIds.has(m.user_id) && m.turn_order !== group.current_turn
      );

      await Promise.allSettled(pending.map(m => sendPushToUser(m.user_id, pushPayload)));
    }

    res.json({ ok: true, message: 'Recordatorio(s) enviado(s)' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/djangue/:id/add-member — Alias de /members ──────────
app.post('/api/djangue/:id/add-member', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;
    const { phone } = req.body;

    if (!phone) return res.status(400).json({ message: 'Teléfono requerido' });

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Solo el responsable o secretario pueden agregar miembros' });

    const { data: newUser } = await supabase
      .from('users').select('id, full_name, phone, avatar_url').eq('phone', phone).maybeSingle();
    if (!newUser) return res.status(404).json({ message: 'Usuario no encontrado con ese teléfono' });

    const { data: existing } = await supabase
      .from('djangue_members')
      .select('id').eq('group_id', groupId).eq('user_id', newUser.id).maybeSingle();
    if (existing) return res.status(409).json({ message: 'Este usuario ya es miembro del djangue' });

    const { data: currentMembers } = await supabase
      .from('djangue_members').select('id').eq('group_id', groupId).eq('status', 'active');
    if ((currentMembers || []).length >= group.max_members)
      return res.status(400).json({ message: `El djangue está lleno (máx. ${group.max_members} miembros)` });

    const nextTurn = group.total_turns + 1;

    const { data: member, error } = await supabase
      .from('djangue_members')
      .insert({ group_id: groupId, user_id: newUser.id, turn_order: nextTurn, status: 'active' })
      .select().single();
    if (error) throw error;

    await supabase.from('djangue_groups').update({ total_turns: nextTurn }).eq('id', groupId);

    // Notificar al nuevo miembro
    try {
      await sendPushToUser(newUser.id, {
        title: '🎉 Te agregaron a un djangue',
        body: `Fuiste agregado al djangue "${group.name}". Tu turno es el #${nextTurn}.`,
        data: { type: 'djangue_added', group_id: groupId },
      });
    } catch {}

    res.status(201).json({ member, user: newUser });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── DELETE /api/djangue/:id/remove-member — Eliminar integrante ───
app.delete('/api/djangue/:id/remove-member', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;
    const { member_id } = req.body;

    if (!member_id) return res.status(400).json({ message: 'member_id requerido' });

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.owner_id !== userId && group.secretary_id !== userId)
      return res.status(403).json({ message: 'Solo el responsable o secretario pueden eliminar miembros' });

    const { data: target } = await supabase
      .from('djangue_members').select('id, turn_order').eq('id', member_id).eq('group_id', groupId).maybeSingle();
    if (!target) return res.status(404).json({ message: 'Miembro no encontrado' });

    // Marcar como removido (no borrar para preservar historial)
    await supabase.from('djangue_members').update({ status: 'removed' }).eq('id', member_id);

    // Actualizar total_turns
    const { data: activeMembers } = await supabase
      .from('djangue_members').select('id').eq('group_id', groupId).eq('status', 'active');
    await supabase.from('djangue_groups')
      .update({ total_turns: (activeMembers || []).length })
      .eq('id', groupId);

    res.json({ ok: true, message: 'Integrante eliminado del djangue' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── PATCH /api/djangue/:id — Actualizar configuración del djangue ─
app.patch('/api/djangue/:id', auth, async (req, res) => {
  try {
    const userId  = req.user.id;
    const groupId = req.params.id;

    const { data: group } = await supabase
      .from('djangue_groups').select('*').eq('id', groupId).single();
    if (!group) return res.status(404).json({ message: 'Djangue no encontrado' });
    if (group.owner_id !== userId)
      return res.status(403).json({ message: 'Solo el administrador puede modificar la configuración' });

    const {
      name, slogan, description, logo_url, penalty_percent,
      notification_days_before, notification_final_days, status,
      frequency, quota_amount, max_members,
    } = req.body;

    const updates = {};
    if (name !== undefined)                    updates.name = name;
    if (slogan !== undefined)                  updates.slogan = slogan;
    if (description !== undefined)             updates.description = description;
    if (logo_url !== undefined)                updates.logo_url = logo_url;
    if (penalty_percent !== undefined)         updates.penalty_percent = Number(penalty_percent);
    if (notification_days_before !== undefined) updates.notification_days_before = Number(notification_days_before);
    if (notification_final_days !== undefined)  updates.notification_final_days  = Number(notification_final_days);
    if (status !== undefined)                  updates.status = status;

    // Verificar si hay cotizaciones activas antes de cambiar aspectos financieros
    const { data: activePaidContribs } = await supabase
      .from('djangue_contributions')
      .select('id').eq('group_id', groupId).eq('status', 'paid').limit(1);

    const canModifyFinancial = !(activePaidContribs?.length > 0);

    if (canModifyFinancial) {
      if (frequency  !== undefined) updates.frequency   = frequency;
      if (quota_amount !== undefined) updates.quota_amount = Number(quota_amount);
      if (max_members !== undefined) updates.max_members  = Number(max_members);
    }

    const { data: updated, error } = await supabase
      .from('djangue_groups').update(updates).eq('id', groupId).select().single();
    if (error) throw error;

    res.json({ ...updated, can_modify_financial: canModifyFinancial });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/upload/djangue-logo — Subir logo ────────────────────
app.post('/api/upload/djangue-logo', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Recibir base64 o multipart
    let base64Data, mimeType, filename;

    if (req.headers['content-type']?.includes('application/json')) {
      // Body JSON con { base64, mimeType }
      base64Data = req.body.base64;
      mimeType   = req.body.mimeType || 'image/jpeg';
      filename   = `djangue-logo-${userId}-${Date.now()}.jpg`;
    } else {
      // Multipart form data — leer buffer
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      await new Promise(resolve => req.on('end', resolve));
      const buffer = Buffer.concat(chunks);
      base64Data = buffer.toString('base64');
      mimeType   = req.headers['content-type']?.split(';')[0] || 'image/jpeg';
      const ext  = mimeType.split('/')[1] || 'jpg';
      filename   = `djangue-logo-${userId}-${Date.now()}.${ext}`;
    }

    if (!base64Data) return res.status(400).json({ message: 'No se recibió imagen' });

    const buffer = Buffer.from(base64Data, 'base64');

    const { data, error } = await supabase.storage
      .from('avatars')
      .upload(`djangue/${filename}`, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (error) throw error;

    const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(`djangue/${filename}`);
    res.json({ ok: true, url: urlData.publicUrl });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = app;



