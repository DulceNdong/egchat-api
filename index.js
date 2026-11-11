// Cargar variables de entorno (solo en local, en Render vienen del dashboard)
try { 
  const dotenv = require('dotenv');
  dotenv.config();
} catch(e) {}
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { crearSalasDeLlamada, MAX_PARTICIPANTES: MAX_LLAMADA_GRUPAL } = require('./callRooms');

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1);

// El secreto debe venir del entorno (Render). Si falta, se deriva uno estable
// y privado: el anterior estaba hardcodeado en el repo y permitía falsificar tokens.
const JWT_SECRET = process.env.JWT_SECRET
  || crypto.createHash('sha256')
    .update(`egchat-jwt:${process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_URL || 'local'}`)
    .digest('hex');
if (!process.env.JWT_SECRET) {
  console.error('[SECURITY] JWT_SECRET no configurado en el entorno; usando secreto derivado.');
}

const verifyToken = (token) => jwt.verify(token, JWT_SECRET);
const APP_VERSION = '2.5.0';
const chatStreams = new Map();
const dependencyCache = { timestamp: 0, result: null };
const enableExternalNewsScraping = process.env.ENABLE_EXTERNAL_NEWS_SCRAPING === '1';
const localAuthUsers = new Map();

const getLocalAuthUser = (phone, fullName = 'Usuario EGCHAT', avatarUrl = null) => {
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone) return null;
  if (!localAuthUsers.has(cleanPhone)) {
    localAuthUsers.set(cleanPhone, {
      id: `local-${Buffer.from(cleanPhone).toString('hex').slice(0, 24)}`,
      phone: cleanPhone,
      full_name: fullName,
      avatar_url: avatarUrl,
      app_version: APP_VERSION,
    });
  }
  return localAuthUsers.get(cleanPhone);
};

const sendLocalAuth = (res, phone, fullName, avatarUrl, status = 200) => {
  const user = getLocalAuthUser(phone, fullName, avatarUrl);
  const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
  return res.status(status).json({ token, user });
};

const localChats = new Map();
const localMessages = new Map();

const isLocalUserId = (id) => String(id || '').startsWith('local-');
const getLocalUserById = (id) => Array.from(localAuthUsers.values()).find(user => user.id === id) || null;
const getDemoContactsFor = (userId) => Array.from(localAuthUsers.values())
  .filter(user => user.id !== userId)
  .map(user => ({
    id: `contact-${user.id}`,
    contact_user_id: user.id,
    name: user.full_name,
    phone: user.phone,
    avatar_url: user.avatar_url || '',
    is_blocked: false,
    is_favorite: false,
    created_at: new Date().toISOString(),
    user,
  }));

const getLocalPrivateChat = (a, b) => {
  const key = [a, b].sort().join('__');
  if (!localChats.has(key)) {
    localChats.set(key, {
      id: `local-chat-${Buffer.from(key).toString('hex').slice(0, 24)}`,
      key,
      type: 'private',
      participant_ids: [a, b],
      created_by: a,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  const chat = localChats.get(key);
  if (!localMessages.has(chat.id)) localMessages.set(chat.id, []);
  return chat;
};

const formatLocalChat = (chat) => {
  const messages = localMessages.get(chat.id) || [];
  return {
    id: chat.id,
    type: 'private',
    name: null,
    avatar_url: null,
    created_by: chat.created_by,
    participants: chat.participant_ids.map(userId => {
      const user = getLocalUserById(userId) || {};
      return {
        chat_id: chat.id,
        user_id: userId,
        full_name: user.full_name || '',
        phone: user.phone || '',
        avatar_url: user.avatar_url || '',
        user,
        users: user,
      };
    }),
    last_message: messages[messages.length - 1] || null,
    updated_at: chat.updated_at,
    unread_count: 0,
  };
};

// --- Supabase ---------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fqfxtjnfhvpggssbymdn.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
);

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
    // Permitir LAN local para probar web + iPhone desde el Mac
    if (/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin)) return callback(null, true);
    // Permitir cualquier subdominio de vercel.app (egchat-v2, egchat-app, etc.)
    if (/^https:\/\/egchat.*\.vercel\.app$/.test(origin)) return callback(null, true);
    return callback(new Error('CORS policy: origin not allowed'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Auth-Token'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight for all routes
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// Límites por IP. Se dejan holgados porque en redes móviles varios usuarios
// pueden compartir la misma IP pública (CGNAT).
const makeLimiter = (limit, windowMs, message) => rateLimit({
  windowMs,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message },
});
const authLimiter = makeLimiter(50, 15 * 60 * 1000, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
const walletLimiter = makeLimiter(60, 10 * 60 * 1000, 'Demasiadas operaciones. Espera unos minutos.');
const kycLimiter = makeLimiter(40, 60 * 60 * 1000, 'Demasiadas solicitudes de verificación. Espera una hora.');
const pinLimiter = makeLimiter(20, 15 * 60 * 1000, 'Demasiados intentos de PIN. Espera unos minutos.');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
// ── Saneador de texto mojibake ────────────────────────────────────
// El archivo histórico del API contiene literales codificados dos veces
// (p. ej. "CÁƒÂ³digo" en lugar de "Código"). Se reparan al serializar
// para que la app reciba siempre texto legible.
const CP1252_TO_BYTE = { 0x20AC:0x80, 0x201A:0x82, 0x0192:0x83, 0x201E:0x84, 0x2026:0x85, 0x2020:0x86, 0x2021:0x87, 0x02C6:0x88, 0x2030:0x89, 0x0160:0x8A, 0x2039:0x8B, 0x0152:0x8C, 0x017D:0x8E, 0x2018:0x91, 0x2019:0x92, 0x201C:0x93, 0x201D:0x94, 0x2022:0x95, 0x2013:0x96, 0x2014:0x97, 0x02DC:0x98, 0x2122:0x99, 0x0161:0x9A, 0x203A:0x9B, 0x0153:0x9C, 0x017E:0x9E, 0x0178:0x9F };

const isMojibakeChar = (char) => {
  const code = char.codePointAt(0);
  return (code >= 0x80 && code <= 0xFF) || CP1252_TO_BYTE[code] !== undefined;
};

const toMojibakeByte = (char) => {
  if (char === '\u00C1') return 0xC3; // 'Á' sustituyó a 'Ã' en el archivo histórico
  const code = char.codePointAt(0);
  if (CP1252_TO_BYTE[code] !== undefined) return CP1252_TO_BYTE[code];
  return code < 256 ? code : -1;
};

// Decodifica solo los tramos con bytes mal codificados, de modo que los
// caracteres legítimos (•, «, », °) sobrevivan intactos.
const decodeMojibakeRun = (run) => {
  let chars = Array.from(run);
  for (let pass = 0; pass < 4; pass++) {
    const bytes = chars.map(toMojibakeByte);
    if (bytes.some((byte) => byte < 0)) return chars.join('');
    let out = '';
    let index = 0;
    let changed = false;
    while (index < chars.length) {
      const lead = bytes[index];
      // Cuatro bytes: sin esta rama los emoji se quedaban doblemente
      // codificados, porque su secuencia arranca en 0xF0..0xF4 y antes solo se
      // reconocían tramos de 2 y 3.
      const size = lead >= 0xC2 && lead <= 0xDF ? 2
        : lead >= 0xE0 && lead <= 0xEF ? 3
        : lead >= 0xF0 && lead <= 0xF4 ? 4
        : 0;
      if (size && index + size <= bytes.length) {
        let valid = true;
        for (let offset = 1; offset < size; offset++) {
          if (bytes[index + offset] < 0x80 || bytes[index + offset] > 0xBF) { valid = false; break; }
        }
        if (valid) {
          const decoded = Buffer.from(bytes.slice(index, index + size)).toString('utf8');
          const original = chars.slice(index, index + size).join('');
          if (decoded && !decoded.includes('\uFFFD') && decoded !== original) {
            out += decoded;
            index += size;
            changed = true;
            continue;
          }
        }
      }
      out += chars[index];
      index += 1;
    }
    if (!changed) break;
    chars = Array.from(out);
  }
  return chars.join('');
};

const repairMojibake = (value) => {
  // El prefiltro no podía mirar solo Â/Ã: un emoji mal codificado arranca en
  // 0xF0 (su secuencia de continuaciones cae en 0x80..0xBF, así que nunca lleva
  // Â ni Ã y el reparador lo saltaba). Se añade ese lead exacto y no el rango
  // F0..F4, porque 0xF1 es la «ñ» y abrirlo corrompía texto legítimo como
  // «España Nº 5» (Ñ + º decodifican como secuencia UTF-8 válida).
  if (typeof value !== 'string' || !/[\u00C2\u00C3\u00F0]/.test(value)) return value;
  let out = '';
  let index = 0;
  while (index < value.length) {
    if (!isMojibakeChar(value[index])) {
      out += value[index];
      index += 1;
      continue;
    }
    let end = index;
    while (end < value.length && isMojibakeChar(value[end])) end += 1;
    out += decodeMojibakeRun(value.slice(index, end));
    index = end;
  }
  return out;
};

const repairDeep = (value, depth = 0) => {
  if (typeof value === 'string') return repairMojibake(value);
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => repairDeep(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) out[key] = repairDeep(value[key], depth + 1);
  return out;
};

app.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(repairDeep(body));
  next();
});


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

// Solo tokens emitidos por /auth/admin/login (type: 'admin').
// Los endpoints de KYC exponen datos personales y no deben aceptar tokens de usuario.
const requireAdmin = (req, res, next) => {
  const authHeader = parseBearerToken(req.headers.authorization);
  const xAuthToken = req.headers['x-auth-token'] || '';
  const queryT = typeof req.query._t === 'string' ? req.query._t : '';
  const token = authHeader || xAuthToken || queryT;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN', message: 'Token de administrador requerido' });
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token inválido o expirado' });
  }
  if (payload.type !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Se requieren permisos de administrador' });
  }
  req.admin = payload;
  next();
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

// Avisar de una señal de llamada a TODOS los dispositivos de los dos
// participantes. Antes solo se avisaba al otro usuario, así que el segundo
// iPhone del que contesta seguía timbrando sin que nadie le dijera nada.
// El SSE llega a las conexiones vivas; el push VoIP es lo único que despierta
// un iPhone suspendido con CallKit sonando.
const notifyCallPeer = async (callId, selfUserId, payload) => {
  try {
    const { data } = await supabase
      .from('call_sessions')
      .select('caller_id, target_user_id')
      .eq('call_id', callId)
      .maybeSingle();
    if (!data) return;
    const users = [...new Set([data.caller_id, data.target_user_id]
      .filter(Boolean).map((id) => String(id)))];
    emitToUsers(users, payload);
    sendVoipSignalToUsers(users, callId, payload.type, payload.reason).catch(() => {});
  } catch (e) {
    console.warn('[call/notify-peer]', e.message);
  }
};

const adminResetKey = process.env.ADMIN_RESET_KEY || null;
// Sin ADMIN_RESET_KEY las rutas administrativas quedan cerradas (antes caían
// al secreto JWT, que estaba publicado en el repositorio).
const isAdminKeyValid = (key) => {
  if (!adminResetKey || typeof key !== 'string') return false;
  const provided = Buffer.from(key);
  const expected = Buffer.from(adminResetKey);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
};
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
  if (!isAdminKeyValid(key)) return res.status(403).json({ message: 'No autorizado' });
  const results = [];
  results.push(await resetTable('message_reads', 'read_at'));
  results.push(await resetTable('messages', 'created_at'));
  results.push(await resetTable('chat_participants', 'joined_at'));
  results.push(await resetTable('chats', 'created_at'));
  results.push(await resetTable('contacts', 'created_at'));
  // wallets, transactions y recharge_codes quedan fuera a propósito: borrar el
  // historial financiero deja los saldos sin asiento que los respalde y anula
  // cualquier conciliación ante un supervisor.
  results.push(await resetTable('user_news_favorites', 'created_at'));
  results.push(await resetTable('insurance_claims', 'created_at'));
  results.push(await resetTable('insurance_policies', 'created_at'));
  results.push(await resetTable('lia_conversations', 'created_at'));
  results.push(await resetTable('notifications', 'created_at'));
  results.push(await resetTable('users', 'created_at'));
  return res.json({ message: 'Reset ejecutado', ok_tables: results.filter(r=>r.ok).map(r=>r.table), failed: results.filter(r=>!r.ok) });
});

app.post('/api/admin/users/update-version', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!isAdminKeyValid(key)) return res.status(403).json({ message: 'No autorizado' });
  const version = typeof req.body?.version === 'string' ? req.body.version : APP_VERSION;
  try {
    const { error } = await supabase.from('users').update({ app_version: version });
    if (error) return res.status(500).json({ message: 'No se pudo actualizar', detail: error.message });
    return res.json({ message: 'Versiones actualizadas', version });
  } catch (e) {
    return res.status(500).json({ message: 'Error interno', detail: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// EL TELEFONO ES LA IDENTIDAD DE LA CUENTA
// Guardarlo sin canonicar convierte '555570323' y '+240555570323' en dos
// usuarios distintos, cada uno con su monedero y sus chats.
// ════════════════════════════════════════════════════════════════════
const PHONE_PAIS = '240';

// Ventanas de digitos nacionales (despues del prefijo, sin el 0 de tráfico)
// por cada pais que la app ofrece en el selector. Son los planes de numeracion
// vigentes; donde el plan de verdad varia (Alemania, Italia, China, Argentina)
// la ventana es amplia, y donde es cerrado (Espana, Mexico, Ghana) no se
// admitsen ni uno de mas. Solo se exige en las altas: la resolucion de cuentas
// viejas sigue siendo tolerante para no dejar fuera a nadie.
const PHONE_PLANES = {
  '240': [9, 9],   // Guinea Ecuatorial: moviles 2/5, fijos 3
  '237': [9, 9],   // Camerun: 8 a 9 digitos desde 2014
  '241': [7, 8],   // Gabon
  '242': [8, 9],   // Congo-Brazzaville
  '236': [8, 8],   // Republica Centroafricana
  '235': [8, 8],   // Chad
  '244': [9, 9],   // Angola
  '243': [7, 10],  // RD Congo: el plan esta mal documentado
  '234': [10, 10], // Nigeria
  '221': [9, 9],   // Senegal
  '225': [8, 10],  // Costa de Marfil: paso de 8 a 10 en 2021
  '254': [9, 9],   // Kenia
  '233': [9, 9],   // Ghana: cerrado en 2010
  '27': [9, 9],    // Sudafrica
  '212': [8, 9],   // Marruecos
  '34': [9, 9],    // Espana
  '33': [9, 9],    // Francia
  '44': [9, 10],   // Reino Unido
  '49': [6, 13],   // Alemania: el largo varia por indicativo
  '39': [6, 12],   // Italia
  '351': [9, 9],   // Portugal
  '1': [10, 10],   // EE UU y Canada (NANP)
  '55': [10, 11],  // Brasil
  '52': [10, 10],  // Mexico
  '57': [10, 10],  // Colombia
  '54': [10, 11],  // Argentina
  '58': [10, 10],  // Venezuela
  '86': [10, 11],  // China
};
const PHONE_PREFIJOS = Object.keys(PHONE_PLANES).sort((a, b) => b.length - a.length);

const toE164 = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.length === 8 || digits.length === 9) return `+${PHONE_PAIS}${digits}`;
  // Cero de red por delante del numero nacional guineecuatorial: no es parte del
  // numero, asi que '+240 0555570323' es la misma cuenta que '+240555570323'.
  // El orden de estas ramas es el mismo que el de public.phone_key en la base.
  if (digits.startsWith(`${PHONE_PAIS}0`)) return `+${PHONE_PAIS}${digits.slice(PHONE_PAIS.length).replace(/^0+/, '')}`;
  if ((digits.length === 11 || digits.length === 12) && digits.startsWith(PHONE_PAIS)) return `+${digits}`;
  return `+${digits}`;
};

// Devuelve el prefijo y los digitos nacionales que ve el servidor, o el motivo
// por el que el numero no es de un pais que la app ofrece.
const desglosarTelefono = (phone) => {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return { motivo: 'El telefono no tiene digitos' };
  if (!raw.startsWith('+')) return { prefijo: PHONE_PAIS, nacional: digits };
  const prefijo = PHONE_PREFIJOS.find((p) => digits.startsWith(p));
  if (!prefijo) return { motivo: 'El prefijo no esta entre los paises disponibles en la app' };
  const nacional = digits.slice(prefijo.length);
  // En Guinea Ecuatorial el 0 inicial es prefijo de red, no parte del numero:
  // '+240 0555570323' y '+240555570323' son la misma cuenta. En los paises donde
  // el 0 si es parte del numero (Gabon, Costa de Marfil) no se toca.
  if (prefijo === PHONE_PAIS) return { prefijo, nacional: nacional.replace(/^0+/, '') };
  return { prefijo, nacional };
};

// El candado del alta: ni numeros inventados ni prefijos que la app no ofrece.
const telefonoValido = (phone) => {
  const partes = desglosarTelefono(phone);
  if (partes.motivo) return partes;
  const ventana = PHONE_PLANES[partes.prefijo];
  const n = partes.nacional.length;
  if (n < ventana[0] || n > ventana[1]) {
    return {
      ok: false,
      motivo: ventana[0] === ventana[1]
        ? `Los numeros de +${partes.prefijo} tienen ${ventana[0]} digitos`
        : `Los numeros de +${partes.prefijo} tienen entre ${ventana[0]} y ${ventana[1]} digitos`,
    };
  }
  return { ok: true, prefijo: partes.prefijo, nacional: partes.nacional };
};

// Formas en las que el mismo numero marcado puede estar guardado.
const phoneCandidates = (phone) => {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  const formas = [toE164(raw), raw, digits, `+${digits}`];
  if (digits.length === 8 || digits.length === 9) formas.push(`${PHONE_PAIS}${digits}`);
  // '+240…' tambien tiene que encontrar la fila guardada sin prefijo ('555570323');
  // si no, registrarse con el prefijo completo crea una cuenta hermana.
  if (digits.startsWith(PHONE_PAIS) && (digits.length === 11 || digits.length === 12)) {
    formas.push(digits.slice(PHONE_PAIS.length));
  }
  // Y la forma con el 0 de red dentro del nacional ('+240 0555570323'): es el
  // mismo numero que la canonica sin el, y sin esta forma quien lo marco asi se
  // queda fuera de su propia cuenta.
  if (digits.startsWith(PHONE_PAIS)) {
    const nacional = digits.slice(PHONE_PAIS.length);
    if (nacional.startsWith('0') && nacional.length >= 8 && nacional.length <= 10) {
      const limpia = nacional.replace(/^0+/, '');
      formas.push(`+${PHONE_PAIS}${limpia}`, limpia);
    }
  }
  return Array.from(new Set(formas.filter(Boolean)));
};

// Prefiere la fila canonica. Si hay varias y ninguna es canonica no elige:
// en auth una cuenta ambigua cuesta menos que un acceso equivocado.
// El limite va por encima de las formas que produce phoneCandidates: si se
// rellenara, un numero con 5 filas dejaria de verse ambiguo y se elegiria a ciegas.
const phoneRowLimit = (phone) => Math.max(6, phoneCandidates(phone).length + 2);

const findAuthUserByPhone = async (phone, columns = '*') => {
  const candidates = phoneCandidates(phone);
  if (!candidates.length) return { user: null, ambiguous: false };
  const { data, error } = await supabase
    .from('users')
    .select(columns)
    .in('phone', candidates)
    .limit(phoneRowLimit(phone));
  if (error) return { user: null, ambiguous: false };
  const filas = data || [];
  const canonica = toE164(phone);
  const elegido = filas.find((u) => u.phone === canonica) || (filas.length === 1 ? filas[0] : null);
  return { user: elegido || null, ambiguous: !elegido && filas.length > 1 };
};

const AMBIGUO_MENSAJE = 'Ese numero tiene varias cuentas. Entra con el formato completo +240…';

// Reset contraseña por admin
app.post('/api/admin/reset-password', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!isAdminKeyValid(key)) return res.status(403).json({ message: 'No autorizado' });
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ message: 'phone y newPassword requeridos' });
  const { user: objetivo, ambiguous } = await findAuthUserByPhone(phone);
  if (!objetivo) return res.status(404).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'Usuario no encontrado' });
  const hashed = await bcrypt.hash(newPassword, 10);
  const { data, error } = await supabase.from('users').update({ password_hash: hashed }).eq('id', objetivo.id).select('id, phone, full_name').single();
  if (error || !data) return res.status(404).json({ message: 'Usuario no encontrado', error: error?.message });
  res.json({ message: 'Contrasena reseteada', user: data });
});

// --- EMERGENCY PASSWORD RESET (token de un solo uso) ------------------
app.post('/api/emergency/reset-pw', authLimiter, async (req, res) => {
  const expected = process.env.EMERGENCY_RESET_TOKEN;
  if (!expected) return res.status(404).json({ message: 'No disponible' });
  const { token, phone, newPassword } = req.body || {};
  const tokenOk = typeof token === 'string'
    && token.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!tokenOk) return res.status(403).json({ message: 'No autorizado' });
  if (!phone || !newPassword) return res.status(400).json({ message: 'phone y newPassword requeridos' });
  if (String(newPassword).length < 8) return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres' });
  try {
    const { user: objetivo, ambiguous } = await findAuthUserByPhone(phone);
    if (!objetivo) return res.status(404).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'Usuario no encontrado' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const { data, error } = await supabase
      .from('users')
      .update({ password_hash: hashed })
      .eq('id', objetivo.id)
      .select('id, phone, full_name')
      .single();
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

app.get('/health', (req, res) => res.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  commit: process.env.RENDER_GIT_COMMIT ? String(process.env.RENDER_GIT_COMMIT).slice(0, 8) : null,
  branch: process.env.RENDER_GIT_REF || null,
}));

app.get('/api/system/dependencies', requireAdmin, async (_req, res) => {
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
// ════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { phone, password, full_name, avatar_url } = req.body;
    if (!phone || !password || !full_name)
      return res.status(400).json({ message: 'phone, password y full_name son requeridos' });

    const profileAvatar = avatar_url || null;
    const plan = telefonoValido(phone);
    if (!plan.ok) return res.status(400).json({ message: plan.motivo });
    const phoneCanonico = `+${plan.prefijo}${plan.nacional}`;

    // Verificar si ya existe, en cualquiera de las formas en que este numero
    // pueda estar guardado: si no, el registro crea una cuenta hermana.
    const { user: existing, ambiguous } = await findAuthUserByPhone(phone);
    if (existing || ambiguous) {
      return res.status(409).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'El teléfono ya está registrado' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ phone: phoneCanonico, full_name, password_hash: hashed, avatar_url: profileAvatar })
      .select('id, phone, full_name, avatar_url')
      .single();

    // Dos registros concurrentes del mismo numero pasan los dos la comprobacion
    // anterior; el indice unico es el que decide, y aqui se traduce a 409 en
    // lugar de un 500 con el mensaje crudo de Postgres.
    if (error && error.code === '23505') {
      return res.status(409).json({ message: 'El teléfono ya está registrado' });
    }
    if (error) throw error;

    // Monedero nuevo a cero: el saldo de bienvenida de las pruebas se abona con
    // su asiento, y la contrapartida es SYS-DISCREPANCY, no SYS-CASH: esos 5.000
    // los pone la casa, no un cliente que los haya depositado, y afirmar caja
    // sin extracto seria inventar un activo. Antes se insertaba el saldo a pelo
    // y el libro mayor no tenia ni idea de de donde salian.
    try {
      const { error: walletError } = await supabase.from('wallets').insert({
        user_id: user.id,
        balance: 0,
        currency: WALLET_CURRENCY,
      });
      if (!walletError && WALLET_SANDBOX) {
        await creditWallet(user.id, 5000, {
          operation: 'saldo_inicial',
          account: 'SYS-DISCREPANCY',
          concept: 'Saldo de bienvenida (modo pruebas)',
          key: `OPENING-${user.id}`,
          reference: `OPENING:${user.id}`,
        });
      }
    } catch {}

    const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { ...user, app_version: APP_VERSION } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/check-phone', authLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.json({ exists: false });
    const { user, ambiguous } = await findAuthUserByPhone(phone);
    res.json({ exists: Boolean(user) || ambiguous });
  } catch {
    res.json({ exists: false }); // En caso de error, dejar continuar
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ message: 'phone y password son requeridos' });

    // La contraseña es la que decide entre las filas del mismo numero: si no,
    // el dueno de una cuenta guardada sin prefijo se quedara fuera aunque la
    // sepa, y el prefijo +240 podria abrir la cuenta de otro pais. Entra la
    // unica que casa; si casan varias (mismas claves en dos cuentas), la
    // canonica. Ninguna = 401 sin delatar cuantas hay.
    const { data: filas } = await supabase
      .from('users').select('*').in('phone', phoneCandidates(phone)).limit(phoneRowLimit(phone));
    const casan = [];
    for (const candidato of filas || []) {
      if (candidato.password_hash && await bcrypt.compare(password, candidato.password_hash)) {
        casan.push(candidato);
      }
    }
    const canonica = toE164(phone);
    const user = casan.length === 0
      ? null
      : (casan.find((u) => u.phone === canonica) || (casan.length === 1 ? casan[0] : null));

    if (!user) {
      return res.status(401).json({ message: 'Credenciales incorrectas' });
    }

    // Después de comprobar la contraseña, no antes: si se rechazara antes del
    // bcrypt el 401 diría «esta sí existe», y el borrado es lógico, no público.
    if (user.deleted_at) {
      return res.status(401).json({ message: 'Esta cuenta fue eliminada' });
    }

    // Actualizar último acceso (ignorar si la columna no existe)
    try {
      await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    } catch {}

    const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url, app_version: user.app_version || APP_VERSION } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  if (String(req.user.id || '').startsWith('local-')) {
    const user = getLocalAuthUser(req.user.phone);
    return res.json(user);
  }
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, avatar_url, banner_url, created_at').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
  // Marcar como online
  supabase.from('users').update({ online_status: true, last_seen: new Date().toISOString() }).eq('id', req.user.id).then(() => {});
  res.json({ ...user, app_version: APP_VERSION });
});

// ── Rol y permisos del usuario ───────────────────────────────────
// users.role es la unica fuente: no existe tabla de roles ni de permisos.
// Las claves son exactamente las que consulta el cliente (useRole.ts y las
// pantallas del area de negocio), ninguna inventada.
const ROLE_PERMISSIONS = {
  user:        ['chat.send'],
  official:    ['chat.send', 'chat.broadcast', 'business.view_stats', 'services.view_orders'],
  business:    ['chat.send', 'chat.broadcast', 'business.view_stats', 'services.view_orders', 'wallet.view'],
  merchant:    ['chat.send', 'services.view_orders', 'wallet.view'],
  moderator:   ['chat.send', 'chat.broadcast', 'business.view_stats', 'services.view_orders', 'wallet.view'],
  admin:       ['chat.send', 'chat.broadcast', 'business.view_stats', 'services.view_orders', 'wallet.view', 'provider.operator', 'provider.director', 'admin.users'],
  super_admin: ['chat.send', 'chat.broadcast', 'business.view_stats', 'services.view_orders', 'wallet.view', 'provider.operator', 'provider.director', 'admin.users'],
};

// is_verified no tiene columna propia en users: se deriva del rol.
app.get('/api/me/role', auth, async (req, res) => {
  const minimo = { role: 'user', permissions: ROLE_PERMISSIONS.user, is_verified: false };
  try {
    const { data, error } = await supabase
      .from('users').select('role').eq('id', req.user.id).maybeSingle();
    // error = la migracion de users.role todavia no esta aplicada; !data = usuario borrado.
    if (error || !data) return res.json(minimo);
    const role = ROLE_PERMISSIONS[data.role] ? data.role : 'user';
    res.json({ role, permissions: ROLE_PERMISSIONS[role], is_verified: role !== 'user' });
  } catch {
    res.json(minimo);
  }
});

// Heartbeat — el cliente llama esto cada 30s para mantenerse "online"
app.post('/api/auth/heartbeat', auth, async (req, res) => {
  if (!String(req.user.id || '').startsWith('local-')) {
    // Se espera la escritura: si responde antes de guardar, el latido se pierde
    // cuando el proceso se recicla y la persona aparece desconectada.
    try {
      await supabase
        .from('users')
        .update({ online_status: true, last_seen: new Date().toISOString() })
        .eq('id', req.user.id);
    } catch (e) {
      console.warn('heartbeat:', e.message);
    }
  }
  res.json({ ok: true });
});

// ── PIN de seguridad del monedero ────────────────────────────────
// Se guarda hasheado en users.pin_hash. Sin PIN configurado las
// operaciones funcionan igual (útil mientras el monedero es de prueba).
app.get('/api/auth/has-pin', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('users').select('pin_hash').eq('id', req.user.id).maybeSingle();
    res.json({ hasPin: Boolean(data?.pin_hash) });
  } catch (e) {
    res.status(500).json({ message: 'No se pudo consultar el PIN' });
  }
});

app.post('/api/auth/setup-pin', auth, pinLimiter, async (req, res) => {
  try {
    const pin = String(req.body?.pin ?? '');
    const currentPin = req.body?.currentPin;
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ message: 'El PIN debe tener entre 4 y 6 dígitos' });
    }

    const { data: user } = await supabase
      .from('users').select('pin_hash').eq('id', req.user.id).maybeSingle();
    if (user?.pin_hash) {
      const valid = currentPin && await bcrypt.compare(String(currentPin), user.pin_hash);
      if (!valid) return res.status(403).json({ code: 'PIN_INVALID', message: 'PIN actual incorrecto' });
    }

    const pin_hash = await bcrypt.hash(pin, 10);
    const { error } = await supabase.from('users').update({ pin_hash }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: 'No se pudo guardar el PIN' });
  }
});

app.post('/api/auth/verify-pin', auth, pinLimiter, async (req, res) => {
  try {
    const pin = String(req.body?.pin ?? '');
    const result = await checkPinForOperation(req.user.id, pin);
    if (result.ok) return res.json({ valid: true });
    res.json({ valid: false, message: result.code === 'PIN_REQUIRED' ? 'Introduce tu PIN' : 'PIN incorrecto' });
  } catch (e) {
    res.status(500).json({ valid: false, message: 'No se pudo verificar el PIN' });
  }
});

// Registro de actividad del usuario
app.get('/api/auth/activity', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const activity = [];
    const now = new Date();

    // Último login (del campo last_login en users)
    const { data: user } = await supabase.from('users').select('last_login, created_at').eq('id', userId).single();
    if (user?.last_login) {
      activity.push({ id: 'login_1', type: 'login', action: 'Inicio de sesión', description: 'Sesión activa en este dispositivo', timestamp: user.last_login });
    }

    // Transacciones recientes. La tabla no tiene columna `description`: se pedía
    // y el consultor devolvía error, así que el listado salía vacío siempre.
    const { data: txs } = await supabase.from('transactions').select('id, type, amount, currency, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);
    (txs || []).forEach(tx => {
      activity.push({ id: `tx_${tx.id}`, type: 'transaction', action: tx.type === 'transfer' ? 'Transferencia' : tx.type === 'deposit' ? 'Recarga' : 'Pago', description: `${tx.amount} ${(tx.currency || 'XAF').toUpperCase()}`, timestamp: tx.created_at });
    });

    // Mensajes enviados recientes (como indicador de actividad de chat)
    const { data: msgs } = await supabase.from('messages').select('id, created_at, chat_id').eq('sender_id', userId).order('created_at', { ascending: false }).limit(3);
    if (msgs && msgs.length > 0) {
      activity.push({ id: 'chat_1', type: 'chat', action: 'Mensajes enviados', description: `${msgs.length} mensajes recientes`, timestamp: msgs[0].created_at });
    }

    // Ordenar por fecha
    activity.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    res.json(activity.slice(0, 20));
  } catch (e) {
    res.json([]);
  }
});

// Marcar offline al cerrar sesión
app.post('/api/auth/logout', auth, async (req, res) => {
  if (!String(req.user.id || '').startsWith('local-')) {
    supabase.from('users').update({ online_status: false, last_seen: new Date().toISOString() }).eq('id', req.user.id).then(() => {});
  }
  res.json({ message: 'Sesión cerrada' });
});

// Cambiar contraseña
app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ message: 'Contraseñas requeridas' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
    const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    const hash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id);
    res.json({ ok: true, message: 'Contraseña actualizada' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Enviar feedback/comentarios
app.post('/api/feedback', auth, async (req, res) => {
  try {
    const { category, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: 'Mensaje requerido' });
    await supabase.from('feedback').insert({
      user_id: req.user.id,
      category: category || 'General',
      message: message.trim(),
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true, message: 'Feedback recibido' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { full_name, avatar_url, banner_url } = req.body;
    const cambios = {};
    if (full_name !== undefined) cambios.full_name = full_name;
    if (avatar_url !== undefined) cambios.avatar_url = avatar_url;
    if (banner_url !== undefined) cambios.banner_url = banner_url;
    if (!Object.keys(cambios).length) return res.status(400).json({ message: 'Nada que actualizar' });
    const { data: user, error } = await supabase
      .from('users')
      .update(cambios)
      .eq('id', req.user.id)
      .select('id, phone, full_name, avatar_url, banner_url')
      .single();
    if (error) throw error;
    res.json(user);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// AJUSTES — preferencias de privacidad, sesiones por dispositivo y
// borrado de cuenta. Las llamadas ya existen en la app (Ajustes →
// Privacidad, Ajustes → Chat y Ajustes → Dispositivos); lo que faltaba
// era el otro lado del mostrador.
// ════════════════════════════════════════════════════════════════════

const PREFERENCIAS_DEFAULT = {
  last_seen_visibility: 'todos',
  photo_visibility: 'todos',
  status_visibility: 'todos',
  read_receipts_enabled: true,
};

// Los tres valores que ofrece la pantalla. Se filtran aquí porque la columna es
// texto libre: un valor inventado por otra clienta se leería después como si
// fuera una preferencia legítima y la app no sabría dibujarlo.
const VISIBILIDADES_ACEPTADAS = ['todos', 'contactos', 'nadie'];

const leerPreferencias = async (userId) => {
  const { data } = await supabase
    .from('user_preferences')
    .select('last_seen_visibility, photo_visibility, status_visibility, read_receipts_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  return { ...PREFERENCIAS_DEFAULT, ...(data || {}) };
};

// Escribe solo las claves que trae la petición. Upsert con las cuatro siempre
// aplastaría contra el default la preferencia que el otro dispositivo no tocó.
const guardarPreferencias = async (userId, cambios) => {
  const fila = { user_id: userId, updated_at: new Date().toISOString() };
  for (const campo of ['last_seen_visibility', 'photo_visibility', 'status_visibility']) {
    if (cambios[campo] !== undefined) {
      const valor = String(cambios[campo]);
      if (!VISIBILIDADES_ACEPTADAS.includes(valor)) {
        return { invalid: campo };
      }
      fila[campo] = valor;
    }
  }
  if (cambios.read_receipts_enabled !== undefined) {
    fila.read_receipts_enabled = Boolean(cambios.read_receipts_enabled);
  }
  if (Object.keys(fila).length <= 2) return { nothing: true };
  const { error } = await supabase
    .from('user_preferences')
    .upsert(fila, { onConflict: 'user_id' });
  if (error) throw error;
  return { fila };
};

app.get('/api/auth/privacy', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) return res.json(PREFERENCIAS_DEFAULT);
    res.json(await leerPreferencias(req.user.id));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH admite una o las cuatro claves: la pantalla de Privacidad manda una por
// una cada vez que el usuario toca un selector.
app.patch('/api/auth/privacy', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) {
      return res.json({ ok: true, ...PREFERENCIAS_DEFAULT, ...(req.body || {}) });
    }
    const r = await guardarPreferencias(req.user.id, req.body || {});
    if (r.invalid) {
      return res.status(400).json({
        message: `${r.invalid} debe ser todos, contactos o nadie`,
      });
    }
    res.json({ ok: true, ...(await leerPreferencias(req.user.id)) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// La pantalla de Chat manda esta ruta aparte, no dentro de /privacy.
app.patch('/api/auth/read-receipts', auth, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.read_receipts_enabled);
    if (isLocalUserId(req.user.id)) return res.json({ ok: true, read_receipts_enabled: enabled });
    const { error } = await supabase
      .from('user_preferences')
      .upsert({
        user_id: req.user.id,
        read_receipts_enabled: enabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ ok: true, read_receipts_enabled: enabled });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Sesiones de dispositivo ──────────────────────────────────────
// Un renglon por (usuario, dispositivo). El id del dispositivo lo fija la app en
// SecureStore y no se regenera, así que reinstalar la app abre sesión nueva en
// vez de reclamar la vieja.

const sesionPublica = (s) => ({
  id: s.id,
  deviceId: s.device_id,
  deviceName: s.device_name || '',
  deviceType: s.device_type || 'web',
  platform: s.platform || '',
  lastSeen: s.last_seen,
  createdAt: s.created_at,
});

app.post('/api/auth/sessions/register', auth, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ message: 'deviceId requerido' });
    if (isLocalUserId(req.user.id)) return res.json({ ok: true, local: true });

    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
      .split(',')[0].trim();
    const { error } = await supabase
      .from('device_sessions')
      .upsert({
        user_id: req.user.id,
        device_id: deviceId,
        device_name: req.body?.deviceName || null,
        device_type: req.body?.deviceType || null,
        platform: req.body?.platform || null,
        ip,
        last_seen: new Date().toISOString(),
        revoked_at: null,
      }, { onConflict: 'user_id,device_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// El latido no trae nombre de dispositivo: se envían solo las columnas que
// cambian para no pisar con null la ficha que escribió el registro.
app.post('/api/auth/sessions/heartbeat', auth, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ message: 'deviceId requerido' });
    if (isLocalUserId(req.user.id)) return res.json({ ok: true, local: true });
    const { error } = await supabase
      .from('device_sessions')
      .upsert({
        user_id: req.user.id,
        device_id: deviceId,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'user_id,device_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/sessions', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) return res.json([]);
    const { data, error } = await supabase
      .from('device_sessions')
      .select('*')
      .eq('user_id', req.user.id)
      .is('revoked_at', null)
      .order('last_seen', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(sesionPublica));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Declarada ANTES de /sessions/:sessionId: si no, Express casa
// 'all-except-current' con el parámetro y la revocación múltiple se convierte en
// un 404 por el orden de las rutas.
app.delete('/api/auth/sessions/all-except-current', auth, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ message: 'deviceId requerido' });
    if (isLocalUserId(req.user.id)) return res.json({ ok: true, revoked: 0 });

    const { data: otras, error: errorLista } = await supabase
      .from('device_sessions')
      .select('id, device_id')
      .eq('user_id', req.user.id)
      .neq('device_id', deviceId)
      .is('revoked_at', null);
    if (errorLista) throw errorLista;

    const ids = (otras || []).map(s => s.id);
    if (ids.length) {
      const { error } = await supabase
        .from('device_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .in('id', ids);
      if (error) throw error;
      (otras || []).forEach(s => {
        emitToUser(req.user.id, { type: 'session_revoked', deviceId: s.device_id });
      });
    }
    res.json({ ok: true, revoked: ids.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/auth/sessions/:sessionId', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) return res.json({ ok: true });
    const { data: sesion, error: errorBusca } = await supabase
      .from('device_sessions')
      .select('id, device_id, user_id')
      .eq('id', req.params.sessionId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (errorBusca) throw errorBusca;
    if (!sesion) return res.status(404).json({ message: 'Sesión no encontrada' });

    const { error } = await supabase
      .from('device_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', sesion.id);
    if (error) throw error;

    // El token firma 30 días y el middleware no lee la base, así que lo único
    // que corta la sesión remota al instante es este aviso por SSE: el cliente
    // lo escucha en _layout y hace logout.
    emitToUser(req.user.id, { type: 'session_revoked', deviceId: sesion.device_id });
    res.json({ ok: true, message: 'Sesión cerrada' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Exportación de datos ─────────────────────────────────────────
// Se encola, no se genera en la petición: una cuenta con historial tarda más de
// lo que aguanta una conexión HTTP y el resultado es un archivo, no un JSON.
app.post('/api/auth/request-data-export', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) {
      return res.json({ ok: true, status: 'requested', local: true });
    }
    const { data: pendiente } = await supabase
      .from('data_export_requests')
      .select('id, requested_at')
      .eq('user_id', req.user.id)
      .eq('status', 'requested')
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendiente) {
      return res.json({ ok: true, id: pendiente.id, status: 'requested', ya_pendiente: true });
    }
    const { data, error } = await supabase
      .from('data_export_requests')
      .insert({ user_id: req.user.id, status: 'requested' })
      .select('id, status, requested_at')
      .single();
    if (error) throw error;
    res.json({ ok: true, id: data.id, status: 'requested' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Borrado de cuenta ────────────────────────────────────────────
// Es lógico, no físico. El libro mayor es inmutable y sus asientos apuntan a
// users con clave foránea: borrar la fila rompería la contabilidad y borraría la
// pista de auditoría de todos los movimientos de esa cuenta.
app.delete('/api/auth/delete-account', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) {
      return res.json({ ok: true, message: 'Cuenta eliminada' });
    }

    // El saldo es la guarda real: una cuenta con dinero no se cierra, porque el
    // asiento que lo respalda se quedaría huérfano. Se lee la fila, no se crea
    // monedero si no existe (getWallet lo alta).
    const { data: wallet } = await supabase
      .from('wallets').select('balance').eq('user_id', req.user.id).maybeSingle();
    const saldo = Number(wallet?.balance || 0);
    if (saldo !== 0) {
      return res.status(409).json({
        message: `Tu monedero tiene ${saldo} ${WALLET_CURRENCY}. Retira o transfiere el saldo antes de eliminar la cuenta.`,
        balance: saldo,
      });
    }

    const { error: errorUsuario } = await supabase
      .from('users')
      .update({ deleted_at: new Date().toISOString(), online_status: false })
      .eq('id', req.user.id);
    if (errorUsuario) throw errorUsuario;

    const { data: sesiones } = await supabase
      .from('device_sessions')
      .select('device_id')
      .eq('user_id', req.user.id)
      .is('revoked_at', null);
    if (sesiones?.length) {
      await supabase
        .from('device_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', req.user.id);
    }
    emitToUser(req.user.id, { type: 'session_revoked' });

    res.json({ ok: true, message: 'Cuenta eliminada' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Verificar/crear buckets de storage ───────────────────────────
app.post('/api/storage/init', auth, async (_req, res) => {
  try {
    const results = [];
    for (const bucketName of ['chat-files', 'avatars']) {
      const { data: list } = await supabase.storage.listBuckets();
      const exists = (list || []).some(b => b.name === bucketName);
      if (!exists) {
        const { error } = await supabase.storage.createBucket(bucketName, { public: true });
        results.push({ bucket: bucketName, created: !error, error: error?.message });
      } else {
        await supabase.storage.updateBucket(bucketName, { public: true }).catch(() => {});
        results.push({ bucket: bucketName, created: false, exists: true });
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Cifrado E2E — claves públicas ─────────────────────────────────────────────
app.post('/api/auth/e2e-key', auth, async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ message: 'publicKey requerida' });
    await supabase.from('users').update({ e2e_public_key: publicKey }).eq('id', req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/users/:userId/e2e-key', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('users').select('e2e_public_key').eq('id', req.params.userId).single();
    res.json({ publicKey: data?.e2e_public_key || null });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Login QR desde PC ────────────────────────────────────────────────────────
// Almacén en memoria: sessionId → { token, userId, expiresAt, confirmed }
const qrSessions = new Map();

// PC llama esto para generar un QR
app.post('/api/auth/qr-create', async (req, res) => {
  const sessionId = require('crypto').randomBytes(16).toString('hex');
  qrSessions.set(sessionId, {
    token: null,
    userId: null,
    confirmed: false,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutos
  });
  // Limpiar sesiones expiradas
  for (const [id, s] of qrSessions.entries()) {
    if (s.expiresAt < Date.now()) qrSessions.delete(id);
  }
  res.json({
    sessionId,
    qrData: `egchat://qr-login/${sessionId}`,
    expiresIn: 300,
  });
});

// App móvil escanea el QR y confirma la sesión
app.post('/api/auth/qr-confirm', auth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ message: 'sessionId requerido' });

  const session = qrSessions.get(sessionId);
  if (!session) return res.status(404).json({ message: 'QR no encontrado o expirado' });
  if (session.expiresAt < Date.now()) {
    qrSessions.delete(sessionId);
    return res.status(410).json({ message: 'QR expirado' });
  }

  // Generar token de sesión para el PC
  const pcToken = jwt.sign(
    { id: req.user.id, phone: req.user.phone, via: 'qr' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  session.token   = pcToken;
  session.userId  = req.user.id;
  session.confirmed = true;
  qrSessions.set(sessionId, session);

  res.json({ ok: true, message: 'Sesión confirmada desde el móvil' });
});

// PC hace polling para saber si el QR fue escaneado
app.get('/api/auth/qr-status/:sessionId', async (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'expired' });
  if (session.expiresAt < Date.now()) {
    qrSessions.delete(req.params.sessionId);
    return res.json({ status: 'expired' });
  }
  if (session.confirmed) {
    const token = session.token;
    const userId = session.userId;
    qrSessions.delete(req.params.sessionId); // Usar solo una vez
    const { data: user } = await supabase
      .from('users').select('id, phone, full_name, avatar_url').eq('id', userId).single();
    return res.json({ status: 'confirmed', token, user });
  }
  res.json({ status: 'pending' });
});

// ── Recuperación de contraseña ────────────────────────────────────────────────
// Almacén temporal en memoria: { phone -> { code, expiresAt } }
const resetCodes = new Map();

app.post('/api/auth/send-verification', authLimiter, async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Teléfono requerido' });
    // La clave del codigo y el destino del SMS van en forma canonica: si no,
    // quien se registro sin el +240 no puede recuperar su cuenta.
    phone = toE164(phone) || phone;

    // Verificar que el usuario existe
    const { user, ambiguous } = await findAuthUserByPhone(phone);
    if (!user) {
      return res.status(ambiguous ? 409 : 404).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'No existe ninguna cuenta con ese número' });
    }

    // Generar código de 6 dígitos
    const code = String(Math.floor(100000 + Math.random() * 900000));
    resetCodes.set(phone, { code, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min

    // Sin las tres variables no hay canal de SMS: antes se respondia `sent:true` igual
    // y el usuario se quedaba esperando un código que nunca salió.
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const fromPhone  = process.env.TWILIO_PHONE;
    if (!accountSid || !authToken || !fromPhone) {
      resetCodes.delete(phone);
      const faltan = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE'].filter(k => !process.env[k]);
      console.error('SMS de recuperacion sin configurar: faltan', faltan.join(', '));
      return res.status(503).json({ sent: false, message: 'No podemos enviar el SMS en este momento. Inténtalo más tarde.' });
    }
    try {
      const twilio = require('twilio')(accountSid, authToken);
      await twilio.messages.create({
        body: `Tu código de recuperación EGCHAT es: ${code}. Válido 10 minutos.`,
        from: fromPhone,
        to: phone,
      });
    } catch (smsErr) {
      resetCodes.delete(phone);
      console.error('Twilio rechazo el SMS de recuperacion:', smsErr.message);
      return res.status(502).json({ sent: false, message: 'El envío del código falló. Inténtalo más tarde.' });
    }

    // El código es la credencial del reset: nunca va al log.
    res.json({ sent: true, message: 'Código enviado' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/verify-code', authLimiter, async (req, res) => {
  try {
    let { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ message: 'Teléfono y código requeridos' });
    phone = toE164(phone) || phone;

    const entry = resetCodes.get(phone);
    if (!entry) return res.status(400).json({ verified: false, message: 'No hay código activo para este número' });
    if (Date.now() > entry.expiresAt) {
      resetCodes.delete(phone);
      return res.status(400).json({ verified: false, message: 'El código ha expirado. Solicita uno nuevo.' });
    }
    if (entry.code !== String(code)) return res.status(400).json({ verified: false, message: 'Código incorrecto' });

    res.json({ verified: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    let { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) return res.status(400).json({ message: 'Faltan datos' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    phone = toE164(phone) || phone;

    // Verificar código
    const entry = resetCodes.get(phone);
    if (!entry) return res.status(400).json({ message: 'Código no válido o expirado' });
    if (Date.now() > entry.expiresAt) {
      resetCodes.delete(phone);
      return res.status(400).json({ message: 'El código ha expirado. Solicita uno nuevo.' });
    }
    if (entry.code !== String(code)) return res.status(400).json({ message: 'Código incorrecto' });

    // Actualizar contraseña. Por id: el numero puede estar guardado en su forma
    // antigua ('555570323') y un update por el canonico no tocaba ninguna fila,
    // devolviendo «Contraseña actualizada» sin haberla actualizado.
    const { user } = await findAuthUserByPhone(phone);
    if (!user) return res.status(404).json({ message: 'No existe ninguna cuenta con ese número' });
    const hash = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', user.id);
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
  // Priorizar avatar del join users, luego del campo directo
  const avatar_url = user.avatar_url || part.avatar_url || '';
  return {
    chat_id: part.chat_id,
    user_id: part.user_id || user.id,
    full_name: part.full_name || user.full_name || '',
    phone: part.phone || user.phone || '',
    avatar_url,
    user: { ...user, avatar_url },
    users: { ...user, avatar_url },
  };
};

const getChatParticipants = async (chatId) => {
  const { data: parts } = await supabase
    .from('chat_participants')
    .select('chat_id, user_id')
    .eq('chat_id', chatId);
  if (!parts || parts.length === 0) return [];
  const userIds = parts.map(p => p.user_id);
  const { data: users } = await supabase.from('users').select('id, phone, full_name, avatar_url').in('id', userIds);
  const usersById = {};
  (users || []).forEach(u => { usersById[String(u.id)] = u; });
  return parts.map(part => {
    const u = usersById[String(part.user_id)] || {};
    return {
      chat_id: part.chat_id,
      user_id: part.user_id,
      full_name: u.full_name || '',
      phone: u.phone || '',
      avatar_url: u.avatar_url || '',
      user: u,
      users: u,
    };
  });
};

// Una tabla auxiliar que la instalación no tiene no es un fallo de la operación:
// PostgREST lo avisa con PGRST205 y «Could not find the table», y el motor con
// 42P01. Las dos formas significan lo mismo.
const tablaAuxiliarAusente = (error) => {
  if (!error) return false;
  return /PGRST20\d|42P01|Could not find the table|does not exist/i
    .test(`${error.code || ''} ${error.message || ''}`);
};

// Obtener todos los chats del usuario
app.get('/api/chats', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) {
      const chats = Array.from(localChats.values())
        .filter(chat => chat.participant_ids.includes(req.user.id))
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .map(formatLocalChat);
      return res.json(chats);
    }

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

    const [{ data: rawParticipants }, { data: messages }] = await Promise.all([
      supabase.from('chat_participants')
        .select('chat_id, user_id, unread_count')
        .in('chat_id', chatIds),
      supabase.from('messages')
        .select('id, text, type, created_at, sender_id, chat_id')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false })
    ]);

    // Obtener info de usuarios en consulta separada (más robusto que FK join)
    const allUserIds = [...new Set((rawParticipants || []).map(p => p.user_id))];
    const { data: usersData } = allUserIds.length > 0
      ? await supabase.from('users').select('id, phone, full_name, avatar_url').in('id', allUserIds)
      : { data: [] };

    const usersById = {};
    (usersData || []).forEach(u => { usersById[String(u.id)] = u; });

    const participantsByChat = (rawParticipants || []).reduce((acc, part) => {
      const chatId = part.chat_id;
      if (!acc[chatId]) acc[chatId] = [];
      const u = usersById[String(part.user_id)] || {};
      acc[chatId].push({
        chat_id: chatId,
        user_id: part.user_id,
        full_name: u.full_name || '',
        phone: u.phone || '',
        avatar_url: u.avatar_url || '',
        user: u,
        users: u,
      });
      return acc;
    }, {});

    const lastMessageByChat = (messages || []).reduce((acc, message) => {
      if (!acc[message.chat_id]) acc[message.chat_id] = message;
      return acc;
    }, {});

    // Foto del djangue: si el grupo no tiene foto propia, manda el logo que
    // se subio al abrir el djangue. Se busca por chat vinculado y, si el
    // vinculo falta, por el nombre "💰 Nombre" con el que se crea el chat.
    const logoDjangue = {};
    const chatsSinFoto = chats.filter(c => (c.type || 'private') === 'group' && !c.avatar_url);
    if (chatsSinFoto.length) {
      try {
        const { data: ligados } = await supabase
          .from('djangue_groups')
          .select('chat_group_id, logo_url')
          .in('chat_group_id', chatsSinFoto.map(c => c.id));
        (ligados || []).forEach(g => {
          if (g.chat_group_id && g.logo_url) logoDjangue[String(g.chat_group_id)] = g.logo_url;
        });

        const sinVinculo = chatsSinFoto.filter(c =>
          !logoDjangue[String(c.id)] && String(c.name || '').startsWith('💰'));
        if (sinVinculo.length) {
          const nombres = [...new Set(sinVinculo.map(c => String(c.name).replace(/^💰\s*/, '')))];
          const { data: porNombre } = await supabase
            .from('djangue_groups')
            .select('name, logo_url')
            .in('name', nombres);
          const logoPorNombre = {};
          (porNombre || []).forEach(g => { if (g.name && g.logo_url) logoPorNombre[g.name] = g.logo_url; });
          sinVinculo.forEach(c => {
            const n = String(c.name || '').replace(/^💰\s*/, '');
            if (logoPorNombre[n]) logoDjangue[String(c.id)] = logoPorNombre[n];
          });
        }
      } catch (e) {
        console.warn('[CHATS] logo del djangue:', e.message);
      }
    }

    // No leídos reales por chat: el servidor los acumula al entrar cada mensaje
    const unreadByChat = {};
    (rawParticipants || []).forEach(p => {
      if (String(p.user_id) === String(req.user.id)) {
        unreadByChat[p.chat_id] = Number(p.unread_count ?? 0);
      }
    });

    const result = chats.map(chat => ({
      id: chat.id,
      type: chat.type || 'private',
      name: chat.name,
      avatar_url: chat.avatar_url || logoDjangue[String(chat.id)] || null,
      description: chat.description || null,
      created_by: chat.created_by || null,
      participants: participantsByChat[chat.id] || [],
      last_message: lastMessageByChat[chat.id] || null,
      updated_at: chat.updated_at,
      unread_count: unreadByChat[chat.id] ?? 0,
      broadcast_mode: !!chat.broadcast_mode,
      ephemeral_seconds: Number(chat.ephemeral_seconds || 0)
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
    if (isLocalUserId(req.user.id)) {
      const chat = Array.from(localChats.values()).find(item => item.id === chatId);
      if (!chat || !chat.participant_ids.includes(req.user.id)) return res.status(403).json({ message: 'No tienes acceso a este chat' });
      return res.json(localMessages.get(chatId) || []);
    }

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

    // El plazo de autodestruccion vive en el chat: se aplica al leer, asi que
    // vale para todos y no solo para el que lo configuro en su telefono.
    // select('*') y no la columna suelta: si el codigo sale antes que el SQL,
    // la pantalla de mensajes no se queda vacia esperando la migracion.
    const { data: chatEfimero } = await supabase
      .from('chats')
      .select('*')
      .eq('id', chatId)
      .maybeSingle();
    const segundosEfimeros = Number(chatEfimero?.ephemeral_seconds || 0);

    const { data: messages } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    // Filtrar mensajes que el usuario eliminó para sí mismo
    const { data: deletions } = await supabase
      .from('message_deletions')
      .select('message_id')
      .eq('user_id', req.user.id);

    const deletedIds = new Set((deletions || []).map((d) => d.message_id));
    const limiteEfimero = segundosEfimeros > 0 ? Date.now() - segundosEfimeros * 1000 : null;
    const filtered = (messages || []).filter(m => {
      if (deletedIds.has(m.id)) return false;
      if (limiteEfimero && new Date(m.created_at).getTime() < limiteEfimero) return false;
      return true;
    });

    // Obtener info de senders en consulta separada (más robusto que FK join)
    const senderIds = [...new Set(filtered.map(m => m.sender_id).filter(Boolean))];
    const { data: senders } = senderIds.length > 0
      ? await supabase.from('users').select('id, full_name, avatar_url').in('id', senderIds)
      : { data: [] };
    const sendersById = {};
    (senders || []).forEach(u => { sendersById[String(u.id)] = u; });

    // Normalizar sender para que el cliente lo use directamente
    const normalized = filtered.map(m => {
      const senderUser = sendersById[String(m.sender_id)] || {};
      return {
        ...m,
        edited: !!m.edited_at,
        sender: senderUser?.id ? {
          id: senderUser.id,
          full_name: senderUser.full_name || '',
          avatar_url: senderUser.avatar_url || '',
        } : undefined,
      };
    });

    res.json(normalized.reverse());
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
    if (isLocalUserId(req.user.id)) {
      const chat = Array.from(localChats.values()).find(item => item.id === chatId);
      if (!chat || !chat.participant_ids.includes(req.user.id)) return res.status(403).json({ message: 'Sin acceso' });
      const sender = getLocalUserById(req.user.id) || {};
      const message = {
        id: `local-msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        chat_id: chatId,
        sender_id: req.user.id,
        text: text || null,
        type,
        reply_to: reply_to || null,
        file_url: file_url || null,
        status: 'sent',
        created_at: new Date().toISOString(),
        sender: { id: sender.id, full_name: sender.full_name || '', avatar_url: sender.avatar_url || '' },
      };
      localMessages.set(chatId, [...(localMessages.get(chatId) || []), message]);
      chat.updated_at = message.created_at;
      emitToUsers(chat.participant_ids, { type: 'new_message', chatId, message });
      emitToUsers(chat.participant_ids, { type: 'chat_updated', chatId, ts: Date.now() });
      return res.status(201).json(message);
    }

    // Verificar acceso
    const { data: part } = await supabase
      .from('chat_participants').select('chat_id').eq('chat_id', chatId).eq('user_id', req.user.id).single();
    if (!part) return res.status(403).json({ message: 'Sin acceso' });

    // Modo difusion: en un grupo broadcast solo escriben los administradores
    const { data: chatCfg } = await supabase
      .from('chats').select('broadcast_mode').eq('id', chatId).maybeSingle();
    if (chatCfg && chatCfg.broadcast_mode && !(await esAdminDeChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'Solo los administradores pueden escribir en este grupo' });
    }

    const seleccion = 'id, text, type, created_at, sender_id, status, file_url';
    // client_ref es la clave que manda el emisor: el indice unico
    // (chat_id, sender_id, client_ref) corta el reintento que duplicaba el
    // mensaje en la pantalla del destinatario.
    const clientRef = req.body?.client_ref ? String(req.body.client_ref).slice(0, 64) : null;
    const fila = {
      chat_id: chatId,
      sender_id: req.user.id,
      text: text || null,
      type,
      reply_to: reply_to || null,
      file_url: file_url || null,
      status: 'sent',
    };
    if (clientRef) fila.client_ref = clientRef;

    let { data: message, error } = await supabase
      .from('messages')
      .insert(fila)
      .select(seleccion)
      .single();

    if (error && (error.code === '23505' || /uix_messages_client_ref|duplicate key/.test(String(error.message)))) {
      const { data: existente } = await supabase.from('messages').select(seleccion)
        .eq('chat_id', chatId).eq('sender_id', req.user.id).eq('client_ref', clientRef)
        .maybeSingle();
      if (existente) return res.json({ ...existente, duplicated: true });
    }

    if (error) throw error;

    await supabase.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', chatId);

    // Obtener datos del sender para incluir en el evento
    const { data: senderData } = await supabase
      .from('users').select('id, full_name, avatar_url').eq('id', req.user.id).single();

    const messageWithSender = {
      ...message,
      sender: senderData ? {
        id: senderData.id,
        full_name: senderData.full_name || '',
        avatar_url: senderData.avatar_url || '',
      } : undefined,
    };

    // Emitir evento en tiempo real a todos los participantes del chat
    try {
      const targets = await getChatPushTargets(chatId, req.user.id);
      const targetUsers = targets.map(t => t.userId);
      emitToUsers(targetUsers, { type: 'new_message', chatId, message: messageWithSender });
      emitToUsers(targetUsers, { type: 'chat_updated', chatId, ts: Date.now() });

      // El contador de no leídos vive en el servidor: es el badge real del destinatario
      await Promise.allSettled(
        targets.map(t => supabase
          .from('chat_participants')
          .update({ unread_count: t.unread })
          .eq('chat_id', chatId)
          .eq('user_id', t.userId))
      );

      const senderName = senderData?.full_name || 'Alguien';
      const msgType = message.type || 'text';
      const bodyText = msgType === 'text'
        ? (message.text || 'Nuevo mensaje')
        : msgType === 'image' ? '📷 Foto'
        : msgType === 'audio' ? '🎵 Mensaje de voz'
        : msgType === 'video' ? '🎥 Video'
        : '📎 Archivo adjunto';

      const pushPayload = {
        title: senderName,
        body: bodyText,
        icon: senderData?.avatar_url || '/favicon.svg',
        tag: `chat-${chatId}`,
        url: '/',
        chatId,
        notificationType: 'message',
        // Datos para notificaciones ricas nativas
        senderName,
        // La extensión de iOS lee `senderId` para construir el INPerson del
        // remitente; sin él todos los contactos comparten el identificador
        // "unknown" y el banner nunca puede pintar su foto de perfil.
        senderId: String(senderData?.id || ''),
        senderAvatar: senderData?.avatar_url || '',
        messageType: msgType,
        imageUrl: msgType === 'image' ? (message.file_url || '') : '',
        'mutable-content': 1,
      };

      // Los chats silenciados no notifican, pero sí acumulan no leídos
      await Promise.allSettled(
        targets
          .filter(t => !t.muted)
          .map(t => sendPushToUser(t.userId, { ...pushPayload, badge: t.unread }))
      );
    } catch (e) {
      console.warn('Realtime/push al enviar mensaje:', e.message);
    }

    res.status(201).json(messageWithSender);
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

    if (isLocalUserId(req.user.id)) {
      if (!targetId && phone) {
        const target = getLocalAuthUser(phone);
        targetId = target?.id;
      }
      const target = getLocalUserById(targetId);
      if (!target) return res.status(404).json({ message: 'Usuario no encontrado con ese número' });
      if (target.id === req.user.id) return res.status(400).json({ message: 'No puedes crear un chat contigo mismo' });
      const chat = getLocalPrivateChat(req.user.id, target.id);
      return res.status(201).json(formatLocalChat(chat));
    }

    if (!targetId && phone) {
      const found = await findUserByPhone(phone);

      if (!found) {
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

    // Insertar participantes en chat_participants para que aparezca en getChats.
    // El creador entra como admin: antes todos entraban sin rol y el grupo
    // recien creado se quedaba sin administrador en la base.
    const idsUnicos = [...new Set(participant_ids.map(String))];
    const participantRows = idsUnicos.map(uid => ({
      chat_id: chat.id,
      user_id: uid,
      role: String(uid) === String(req.user.id) ? 'admin' : 'member',
    }));
    const { error: partError } = await supabase.from('chat_participants').insert(participantRows);
    if (partError) {
      // Sin participantes el grupo no aparece en ninguna lista: mejor no
      // dejar el chat huerfano que devolver un 201 de algo inservible.
      await supabase.from('chats').delete().eq('id', chat.id);
      throw partError;
    }

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
// Upload avatar de grupo — recibe base64, sube a Supabase Storage
// ════════════════════════════════════════════════════════════════════
app.post('/api/chats/:chatId/avatar', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { base64, mimeType = 'image/jpeg' } = req.body;

    if (!base64) return res.status(400).json({ message: 'base64 requerido' });

    // Solo quien puede editar la info (admin o permiso edit_info='all') cambia la foto
    if (!(await puedeEditarInfoChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'No tienes permiso para cambiar la foto del grupo' });
    }

    // Convertir base64 a buffer
    const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = mimeType.split('/')[1] || 'jpg';
    const fileName = `group-avatars/${chatId}-${Date.now()}.${ext}`;

    // Subir a Supabase Storage (bucket: avatars)
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(fileName, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      // Si falla Storage, guardar el base64 directamente en la BD como fallback
      const { data: updated } = await supabase
        .from('chats')
        .update({ avatar_url: base64, updated_at: new Date().toISOString() })
        .eq('id', chatId)
        .select('avatar_url')
        .single();
      return res.json({ avatar_url: updated?.avatar_url || base64 });
    }

    // Obtener URL pública
    const { data: publicData } = supabase.storage
      .from('avatars')
      .getPublicUrl(fileName);

    const publicUrl = publicData?.publicUrl || '';

    // Actualizar en la BD
    await supabase
      .from('chats')
      .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', chatId);

    res.json({ avatar_url: publicUrl });
  } catch (e) {
    console.error('Upload group avatar error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Portada del grupo: la imagen ancha que se ve detras de la foto del perfil.
app.post('/api/chats/:chatId/cover', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { base64, mimeType = 'image/jpeg' } = req.body || {};

    if (!base64) return res.status(400).json({ message: 'base64 requerido' });

    if (!(await puedeEditarInfoChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'No tienes permiso para cambiar la portada del grupo' });
    }

    const buffer = Buffer.from(String(base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ message: 'Imagen inválida' });
    if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ message: 'Imagen demasiado grande' });

    const ext = (String(mimeType).split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
    const fileName = `group-covers/${chatId}-${Date.now()}.${ext}`;

    let publicUrl = base64;
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(fileName, buffer, { contentType: mimeType, upsert: true });

    if (!uploadError) {
      const { data: publicData } = supabase.storage.from('avatars').getPublicUrl(fileName);
      publicUrl = publicData?.publicUrl || base64;
    }

    const { error } = await supabase
      .from('chats')
      .update({ cover_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', chatId);

    if (error) {
      if (/cover_url/.test(String(error.message || ''))) {
        return res.status(503).json({ message: 'Falta la columna chats.cover_url' });
      }
      throw error;
    }

    res.json({ cover_url: publicUrl });
  } catch (e) {
    console.error('Upload group cover error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/chats/:chatId/cover', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    if (!(await puedeEditarInfoChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'No tienes permiso para cambiar la portada del grupo' });
    }

    const { error } = await supabase
      .from('chats')
      .update({ cover_url: null, updated_at: new Date().toISOString() })
      .eq('id', chatId);

    if (error) {
      if (/cover_url/.test(String(error.message || ''))) {
        return res.status(503).json({ message: 'Falta la columna chats.cover_url' });
      }
      throw error;
    }

    res.json({ cover_url: null });
  } catch (e) {
    console.error('Delete group cover error:', e);
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

// Borra un chat privado de raíz: sus mensajes, sus participantes y el propio
// chat. La app ofrece esta acción como irreversible («se eliminará el chat,
// todos los mensajes y el contacto asociado»), así que no basta con sacarlo de
// la lista local. En grupos la misma llamada la usa la app para dos intenciones
// distintas —«salir del grupo» y «eliminar grupo»— sin distinguirlas, así que
// aquí decide el chat: solo el creador lo destruye; para los demás es una salida
// y los mensajes del resto se conservan. `message_reads` cae por clave foránea,
// pero se borra a mano también por si la instalación no tiene la clave puesta.
app.delete('/api/chats/:chatId', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    const { data: miParticipacion } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!miParticipacion) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { data: chat } = await supabase
      .from('chats')
      .select('id, type, created_by')
      .eq('id', chatId)
      .maybeSingle();
    if (!chat) return res.status(404).json({ message: 'Chat no encontrado' });

    if (chat.type === 'group') {
      const esCreador = String(chat.created_by || '') === String(req.user.id);
      const { data: restantes } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('chat_id', chatId)
        .neq('user_id', req.user.id);
      const seguidores = (restantes || []).length;

      if (!esCreador && seguidores > 0) {
        const { error: errorSalida } = await supabase
          .from('chat_participants')
          .delete()
          .eq('chat_id', chatId)
          .eq('user_id', req.user.id);
        if (errorSalida) throw errorSalida;
        return res.json({ message: 'Has salido del grupo', left: true });
      }
    }

    let otroUsuario = null;
    if (chat.type === 'private') {
      const { data: otros } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('chat_id', chatId)
        .neq('user_id', req.user.id);
      otroUsuario = otros?.[0]?.user_id || null;
    }

    const { data: mensajes } = await supabase
      .from('messages').select('id').eq('chat_id', chatId);
    const idsDeMensajes = (mensajes || []).map((m) => m.id);

    if (idsDeMensajes.length) {
      const { error: errorBorrado } = await supabase
        .from('message_deletions').delete().in('message_id', idsDeMensajes);
      if (errorBorrado && !tablaAuxiliarAusente(errorBorrado)) throw errorBorrado;
    }

    const { error: errorMensajes } = await supabase.from('messages').delete().eq('chat_id', chatId);
    if (errorMensajes) throw errorMensajes;
    const { error: errorLecturas } = await supabase.from('message_reads').delete().eq('chat_id', chatId);
    if (errorLecturas && !tablaAuxiliarAusente(errorLecturas)) throw errorLecturas;
    const { error: errorParticipantes } = await supabase.from('chat_participants').delete().eq('chat_id', chatId);
    if (errorParticipantes) throw errorParticipantes;
    const { error: errorChat } = await supabase.from('chats').delete().eq('id', chatId);
    if (errorChat) throw errorChat;

    if (otroUsuario) {
      const { error: errorContacto } = await supabase
        .from('contacts')
        .delete()
        .eq('user_id', req.user.id)
        .eq('contact_user_id', otroUsuario);
      if (errorContacto) {
        console.warn('Delete chat: el contacto asociado no se pudo borrar:', errorContacto.message);
      }
    }

    res.json({ message: 'Chat eliminado', messages_deleted: idsDeMensajes.length });
  } catch (e) {
    console.error('Delete chat error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// Obtener participantes de un grupo
// ════════════════════════════════════════════════════════════════════
app.get('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    // Verificar acceso
    const { data: myPart } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!myPart) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    // Obtener IDs de participantes con su rol real
    const { data: parts, error: partsError } = await supabase
      .from('chat_participants')
      .select('user_id, role')
      .eq('chat_id', chatId);

    if (partsError) throw partsError;
    if (!parts || parts.length === 0) return res.json([]);

    // El creador del grupo siempre es administrador aunque su fila diga lo contrario
    const { data: chatRow } = await supabase
      .from('chats').select('created_by').eq('id', chatId).maybeSingle();
    const creadorId = chatRow && chatRow.created_by ? String(chatRow.created_by) : null;

    // Obtener info completa de usuarios en consulta separada (más robusto que FK join)
    const userIds = parts.map(p => p.user_id);
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, full_name, phone, avatar_url, online_status, last_seen')
      .in('id', userIds);

    if (usersError) throw usersError;

    const usersMap = {};
    (users || []).forEach(u => { usersMap[String(u.id)] = u; });

    // La visibilidad de la última conexión es del dueño del dato, no del que
    // mira. Se lee de una para todos los demás: 'nadie' borra la marca, y
    // 'contactos' solo se la enseña a quien tiene a ese usuario en su agenda.
    const otrosIds = (parts || [])
      .map(p => String(p.user_id))
      .filter(uid => uid !== String(req.user.id));
    const visMap = {};
    if (otrosIds.length) {
      const { data: prefsRows } = await supabase
        .from('user_preferences')
        .select('user_id, last_seen_visibility')
        .in('user_id', otrosIds);
      (prefsRows || []).forEach(p => { visMap[String(p.user_id)] = p.last_seen_visibility; });
    }

    let misContactos = new Set();
    if (Object.values(visMap).includes('contactos')) {
      const { data: miaAgenda } = await supabase
        .from('contacts')
        .select('contact_user_id')
        .eq('user_id', req.user.id);
      misContactos = new Set((miaAgenda || []).map(c => String(c.contact_user_id)));
    }

    const yoId = String(req.user.id);
    const members = parts.map(p => {
      const uid = String(p.user_id);
      const u = usersMap[uid] || {};
      const vis = visMap[uid] || 'todos';
      const oculta = uid !== yoId
        && (vis === 'nadie' || (vis === 'contactos' && !misContactos.has(uid)));
      return {
        id: uid,
        user_id: uid,
        full_name: u.full_name || '',
        phone: u.phone || '',
        avatar_url: u.avatar_url || '',
        online_status: oculta ? false : estaEnLineaAhora(u.last_seen),
        last_seen: oculta ? null : (u.last_seen || null),
        role: p.role === 'admin' || (creadorId && uid === creadorId) ? 'admin' : 'member',
        is_creator: !!creadorId && uid === creadorId,
      };
    });

    res.json(members);
  } catch (e) {
    console.error('Get participants error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Lecturas reales de un chat ────────────────────────────────────────────
// Un solo camino para /read y /read-all: deja constancia en message_reads,
// pone status='read' en los mensajes de otros y avisa a cada emisor por SSE
// para que su doble check se vuelva azul.
const applyChatRead = async (chatId, userId, upToMessageId) => {
  const { data: part } = await supabase
    .from('chat_participants')
    .select('id')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .single();
  if (!part) return { forbidden: true, messageIds: [] };

  let boundaryId = upToMessageId || null;
  let boundaryDate = null;

  if (boundaryId) {
    const { data: anchor } = await supabase
      .from('messages')
      .select('created_at')
      .eq('id', boundaryId)
      .eq('chat_id', chatId)
      .maybeSingle();
    boundaryDate = anchor?.created_at || null;
    if (!boundaryDate) return { messageIds: [] };
  } else {
    const { data: newest } = await supabase
      .from('messages')
      .select('id, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!newest) return { messageIds: [] };
    boundaryId = newest.id;
    boundaryDate = newest.created_at;
  }

  // status es anidable: con .neq('status','read') los NULL quedarían fuera de
  // la comparación en SQL y nunca se marcarían como leídos.
  const { data: unread } = await supabase
    .from('messages')
    .select('id, sender_id, status')
    .eq('chat_id', chatId)
    .neq('sender_id', userId)
    .lte('created_at', boundaryDate);

  const unreadMsgs = (unread || []).filter(m => m.status !== 'read');
  const messageIds = unreadMsgs.map(m => m.id);

  // Con las confirmaciones de lectura apagadas, el lector sí consume sus mensajes
  // (su badge se limpia y queda su posición en message_reads), pero no se lo
  // dice a nadie: ni se toca status, que es lo que pinta el doble check azul al
  // recargar, ni se emite el evento SSE.
  const prefs = await leerPreferencias(userId);

  if (messageIds.length > 0 && prefs.read_receipts_enabled) {
    const { error: statusError } = await supabase
      .from('messages')
      .update({ status: 'read' })
      .in('id', messageIds);
    if (statusError) throw statusError;
  }

  await supabase
    .from('message_reads')
    .upsert(
      {
        chat_id: chatId,
        user_id: userId,
        last_read_message_id: boundaryId,
        read_at: new Date().toISOString(),
      },
      { onConflict: 'chat_id,user_id' }
    );

  await supabase
    .from('chat_participants')
    .update({ unread_count: 0 })
    .eq('chat_id', chatId)
    .eq('user_id', userId);

  // Cada emisor recibe solo los ids de sus propios mensajes leídos
  const bySender = {};
  unreadMsgs.forEach(m => {
    const key = String(m.sender_id);
    if (!bySender[key]) bySender[key] = [];
    bySender[key].push(m.id);
  });
  if (prefs.read_receipts_enabled) {
    Object.keys(bySender).forEach(senderId => {
      emitToUser(senderId, {
        type: 'read',
        chatId,
        readerId: String(userId),
        messageIds: bySender[senderId],
      });
    });
  }

  return { messageIds };
};

// Marcar hasta un mensaje concreto: lo usa el cliente al recibir un mensaje
app.post('/api/chats/:chatId/read', auth, async (req, res) => {
  try {
    const r = await applyChatRead(req.params.chatId, req.user.id, req.body?.message_id);
    if (r.forbidden) return res.status(403).json({ message: 'Sin acceso a este chat' });
    res.json({ message: 'Mensajes marcados como leídos', read: r.messageIds.length });
  } catch (e) {
    console.error('Mark as read error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Marcar todo el chat como leído: lo usa el cliente al abrir el chat
app.post('/api/chats/:chatId/read-all', auth, async (req, res) => {
  try {
    const r = await applyChatRead(req.params.chatId, req.user.id, null);
    if (r.forbidden) return res.status(403).json({ message: 'Sin acceso a este chat' });
    res.json({ message: 'Chat marcado como leído', read: r.messageIds.length });
  } catch (e) {
    console.error('Mark chat as read error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Silenciar / reactivar un chat en el servidor, para que el push lo respete
// La columna la crea la migracion 2026-11-02_ledger_lote_b.sql; aquí solo se
// comprueba que esté, porque exec_sql ya no existe en el esquema.
const ensureChatMuteColumn = async () => {
  try {
    const { error } = await supabase.from('chat_participants').select('muted_until').limit(1);
    if (error) console.warn('ensureChatMuteColumn: falta la migracion de esquema:', error.message);
  } catch (e) {
    console.warn('ensureChatMuteColumn:', e.message);
  }
};
ensureChatMuteColumn();

app.post('/api/chats/:chatId/mute', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const minutes = Number(req.body?.minutes ?? 0);

    const patch = { muted_until: minutes > 0
      ? new Date(Date.now() + minutes * 60000).toISOString()
      : null };

    const { data, error } = await supabase
      .from('chat_participants')
      .update(patch)
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id)
      .select('chat_id, user_id, muted_until')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(403).json({ message: 'No tienes acceso a este chat' });
    res.json({ muted: minutes > 0, muted_until: data.muted_until });
  } catch (e) {
    console.error('Mute chat error:', e);
    res.status(501).json({ message: `Silencio no disponible en la base: ${e.message}` });
  }
});

// Participantes con sus banderas de push; si muted_until aún no existe,
// se degrada a no filtrar ninguno en vez de romper el envío.
const getChatPushTargets = async (chatId, excludeUserId) => {
  const withMute = await supabase
    .from('chat_participants')
    .select('user_id, unread_count, muted_until')
    .eq('chat_id', chatId);

  let rows = withMute.data;
  if (!rows) {
    const plain = await supabase
      .from('chat_participants')
      .select('user_id, unread_count')
      .eq('chat_id', chatId);
    rows = plain.data || [];
  }

  return (rows || [])
    .filter(p => String(p.user_id) !== String(excludeUserId))
    .map(p => ({
      userId: p.user_id,
      unread: Number(p.unread_count ?? 0) + 1,
      muted: !!p.muted_until && new Date(p.muted_until).getTime() > Date.now(),
    }));
};

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

const phoneLookupCandidates = (phone = '') => {
  const trimmed = String(phone || '').trim();
  const digits = trimmed.replace(/\D/g, '');
  const candidates = new Set([trimmed]);
  if (digits) {
    candidates.add(digits);
    candidates.add(`+${digits}`);
    if (digits.startsWith('240')) {
      candidates.add(digits.slice(3));
      candidates.add(`+${digits.slice(3)}`);
    } else {
      candidates.add(`240${digits}`);
      candidates.add(`+240${digits}`);
    }
    if (digits.length > 9) {
      const last9 = digits.slice(-9);
      candidates.add(last9);
      candidates.add(`240${last9}`);
      candidates.add(`+240${last9}`);
    }
  }
  return Array.from(candidates).filter(Boolean);
};

async function findUserByPhone(phone) {
  const candidates = phoneLookupCandidates(phone);
  if (!candidates.length) return null;
  const { data: exact } = await supabase
    .from('users')
    .select('id, phone, full_name, avatar_url')
    .in('phone', candidates)
    .limit(1);
  if (exact?.[0]) return exact[0];

  const digits = String(phone || '').replace(/\D/g, '');
  const suffixes = [digits, digits.slice(-9), digits.slice(-8)].filter(v => v && v.length >= 6);
  for (const suffix of suffixes) {
    const { data } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .ilike('phone', `%${suffix}`)
      .limit(1);
    if (data?.[0]) return data[0];
  }
  return null;
}

// Obtener todos los contactos del usuario
app.get('/api/contacts', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) {
      return res.json(getDemoContactsFor(req.user.id));
    }

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

    if (isLocalUserId(req.user.id)) {
      if (!targetId && phone) {
        const target = getLocalAuthUser(phone, nickname || 'Usuario EGCHAT');
        targetId = target?.id;
      }
      const target = getLocalUserById(targetId);
      if (!target || target.id === req.user.id) return res.status(404).json({ message: 'Usuario no encontrado con ese número' });
      return res.json({
        id: `contact-${target.id}`,
        contact_user_id: target.id,
        name: nickname || target.full_name,
        phone: target.phone,
        avatar_url: target.avatar_url || '',
        is_blocked: false,
        is_favorite: false,
        created_at: new Date().toISOString(),
        user: target,
      });
    }

    if (!targetId && phone) {
      const targetUser = await findUserByPhone(phone);

      console.log('[ADD CONTACT] phone search result:', targetUser);

      if (!targetUser) {
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

// Lista de bloqueados: la pide Ajustes → Privacidad. Devuelve el id de la fila
// de `contacts` (no el del usuario) porque es el que la pantalla reenvía a
// /contacts/:contactId/unblock, que busca por contacts.id.
app.get('/api/contacts/blocked', auth, async (req, res) => {
  try {
    if (isLocalUserId(req.user.id)) return res.json([]);

    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('id, contact_user_id, nickname, phone, created_at')
      .eq('user_id', req.user.id)
      .eq('is_blocked', true)
      .order('created_at', { ascending: false });
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
      contact_user_id: c.contact_user_id,
      full_name: c.nickname || usersMap[c.contact_user_id]?.full_name || '',
      phone: usersMap[c.contact_user_id]?.phone || c.phone || '',
      avatar_url: usersMap[c.contact_user_id]?.avatar_url || '',
      blocked_at: c.created_at,
    })));
  } catch (e) {
    console.error('Get blocked contacts error:', e);
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
    if (isLocalUserId(req.user.id)) return res.json([]);

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
    if (isLocalUserId(req.user.id)) {
      const term = String(q || '').toLowerCase().trim();
      const users = Array.from(localAuthUsers.values())
        .filter(user => user.id !== req.user.id)
        .filter(user => !term || user.phone.includes(term) || user.full_name.toLowerCase().includes(term))
        .slice(0, 50)
        .map(({ id, phone, full_name, avatar_url }) => ({ id, phone, full_name, avatar_url }));
      return res.json(users);
    }

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
  try {
    let { data: wallet, error } = await supabase
      .from('wallets')
      .select('balance, currency')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) {
      console.warn('Wallet lookup error:', error.message);
    }

    if (!wallet) {
      const { data, error: insertError } = await supabase
        .from('wallets')
        .insert({ user_id: req.user.id, balance: 0, currency: WALLET_CURRENCY })
        .select('balance, currency')
        .maybeSingle();

      if (insertError) {
        console.warn('Wallet create error:', insertError.message);
      }

      wallet = data || { balance: 0, currency: WALLET_CURRENCY };
    }

    res.json({
      balance: Number(wallet.balance || 0),
      currency: wallet.currency || WALLET_CURRENCY,
      mode: WALLET_MODE,
      sandbox: WALLET_SANDBOX,
    });
  } catch (e) {
    console.error('Wallet balance error:', e);
    res.json({ balance: 0, currency: WALLET_CURRENCY, mode: WALLET_MODE, sandbox: WALLET_SANDBOX });
  }
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const from = (page - 1) * limit;

  const { data: transactions, count } = await supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user.id)
    .eq('status', 'completed')
    .neq('ledger_link', 'previa')
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);

  res.json({ transactions: transactions || [], total: count || 0 });
});

app.post('/api/wallet/deposit', auth, walletLimiter, async (req, res) => {
  try {
    const { method, reference } = req.body || {};
    const amount = roundAmount(req.body?.amount);
    if (!isValidTransferAmount(amount)) return res.status(400).json({ message: 'Importe inválido' });

    if (!WALLET_SANDBOX) {
      return res.status(501).json({
        code: 'PAYMENTS_NOT_CONFIGURED',
        message: 'Las recargas reales todavía no están disponibles. Usa el modo de pruebas o espera a la integración bancaria.',
      });
    }

    const quotaError = await walletQuotaError(req.user.id, 'deposit', amount);
    if (quotaError) return res.status(400).json({ message: quotaError, code: 'LIMIT_EXCEEDED' });

    const credit = await creditWallet(req.user.id, amount, {
      operation: 'recarga',
      account: 'SYS-CASH',
      concept: `Recarga de ${method || 'monedero'}`,
      reference,
    });
    if (!credit.ok) return transferErrorResponse(res, credit.code);

    const { data: tx } = await supabase.from('transactions').insert({
      user_id: req.user.id, type: 'deposit', amount, method,
      reference, status: 'completed', ledger_journal_id: credit.journal_id
    }).select().single();

    res.json({ balance: credit.balance, transaction: tx, sandbox: WALLET_SANDBOX });
  } catch (e) {
    console.error('Deposit error:', e.message);
    res.status(500).json({ message: 'Error al procesar la recarga' });
  }
});

app.post('/api/wallet/withdraw', auth, walletLimiter, async (req, res) => {
  try {
    const { method, destination, pin } = req.body || {};
    const amount = roundAmount(req.body?.amount);
    if (!isValidTransferAmount(amount)) return res.status(400).json({ message: 'Importe inválido' });

    if (!WALLET_SANDBOX) {
      return res.status(501).json({
        code: 'PAYMENTS_NOT_CONFIGURED',
        message: 'Las retiradas reales todavía no están disponibles. Espera a la integración bancaria.',
      });
    }

    const pinCheck = await checkPinForOperation(req.user.id, pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    const quotaError = await walletQuotaError(req.user.id, 'withdraw', amount);
    if (quotaError) return res.status(400).json({ message: quotaError, code: 'LIMIT_EXCEEDED' });

    const debit = await debitWallet(req.user.id, amount, {
      operation: 'retiro',
      account: 'SYS-CASH',
      concept: `Retirada por ${method || 'pasarela'}`,
      reference: destination,
    });
    if (!debit.ok) {
      if (debit.code === 'WALLET_NOT_FOUND') return res.status(404).json({ message: 'Monedero no encontrado' });
      return transferErrorResponse(res, debit.code);
    }

    const { data: tx } = await supabase.from('transactions').insert({
      user_id: req.user.id, type: 'withdraw', amount, method,
      reference: destination, status: 'completed', ledger_journal_id: debit.journal_id
    }).select().single();

    res.json({ balance: debit.balance, transaction: tx, sandbox: WALLET_SANDBOX });
  } catch (e) {
    console.error('Withdraw error:', e.message);
    res.status(500).json({ message: 'Error al procesar la retirada' });
  }
});

// ── Transferencias entre usuarios ────────────────────────────────────
const TRANSFER_TTL_MS = 72 * 60 * 60 * 1000; // 72 h para aceptar
const MAX_TRANSFER_AMOUNT = 5000000;
const PENDING_TRANSFER_PREFIX = 'P2P';
// Cobros de servicios de la propia plataforma (no existe usuario receptor).
const PLATFORM_MERCHANTS = new Set(['barcos']);

const roundAmount = (value) => Math.round(Number(value) * 100) / 100;
const isValidTransferAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= MAX_TRANSFER_AMOUNT;
};

const findUserByRef = async (ref) => {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  if (isUuid) {
    const { data } = await supabase
      .from('users').select('id, phone, full_name, avatar_url').eq('id', raw).maybeSingle();
    return data || null;
  }
  // Un traspaso no puede adivinar el destinatario: si el numero esta duplicado
  // y ninguna fila lleva la forma canonica, se devuelve null y el pago no sale.
  const { user } = await findAuthUserByPhone(raw, 'id, phone, full_name, avatar_url');
  return user || null;
};

const getWallet = async (userId) => {
  const { data } = await supabase.from('wallets').select('id, balance').eq('user_id', userId).maybeSingle();
  return data || null;
};

const ensureWallet = async (userId) => {
  const existing = await getWallet(userId);
  if (existing) return existing;
  const { data, error } = await supabase
    .from('wallets')
    .insert({ user_id: userId, balance: 0, currency: 'XAF' })
    .select('id, balance')
    .maybeSingle();
  return error ? null : data;
};

// El libro mayor es lo que mueve wallets.balance (el disparador
// ledger_journal_apply_wallets de la migracion 2026-11-02_ledger_lote_b.sql
// aplica el delta al cerrar el asiento). Debitar o abonar desde JS es, por
// tanto, crear su asiento: si el JS escribiera el saldo aparte, el mismo euro
// se movería dos veces.
// Criterio contable: el saldo de un cliente es pasivo del operador (crece al
// Haber); SYS-CASH es activo (crece al Debe), SYS-FEES ingreso y SYS-SUSPENSE
// es lo que se debe a proveedores y lo retenido en pendientes.
const ledgerPost = async ({ userId, operation, key = null, concept, lines, reference = null, requiresApproval = false }) => {
  const { data, error } = await supabase.rpc('ledger_post', {
    p_user_id: userId,
    p_operation: String(operation),
    p_idempotency_key: key,
    p_concept: String(concept || operation).slice(0, 200),
    p_lines: lines,
    p_reference: reference ? String(reference).slice(0, 120) : null,
    p_requires_approval: requiresApproval === true,
  });
  if (error) {
    const msg = String(error.message || '');
    const code = /saldo insuficiente/i.test(msg) ? 'INSUFFICIENT_BALANCE'
      : /no tiene monedero|unificarlos antes/i.test(msg) ? 'WALLET_NOT_FOUND'
      : 'LEDGER_REJECTED';
    if (code === 'LEDGER_REJECTED') console.error('[LEDGER] asiento rechazado:', operation, key, msg);
    return { ok: false, code, message: msg };
  }
  if (!data?.journal_id) return { ok: false, code: 'LEDGER_REJECTED', message: 'El libro mayor no devolvió ningún asiento' };
  if (data.status === 'pending_approval') {
    return { ok: false, code: 'PENDING_APPROVAL', journal_id: data.journal_id };
  }
  return { ok: true, journal_id: data.journal_id, already_posted: data.already_posted === true };
};

const readWalletBalance = async (userId) => {
  const wallet = await getWallet(userId);
  return Number(wallet?.balance || 0);
};

// La misma puerta, pero con la plantilla de asiento resuelta dentro de la base
// de datos (migracion 2026-11-03_ledger_lote_b2.sql). La usan los canales sin
// telefono inteligente: un menu USSD no puede reconstruir el debe y el haber,
// asi que pide el asiento por su tipo y el libro lo diseña.
const ledgerPostKind = async ({ kind, userId, amount, fee = 0, counterpartyUserId = null, key = null, concept = null, reference = null, provider = null, requiresApproval = false }) => {
  const { data, error } = await supabase.rpc('ledger_post_kind', {
    p_kind: String(kind),
    p_user_id: userId,
    p_amount: roundAmount(amount),
    p_idempotency_key: key ? String(key) : null,
    p_fee: roundAmount(fee),
    p_counterparty_id: counterpartyUserId,
    p_concept: String(concept || kind).slice(0, 200),
    p_reference: reference ? String(reference).slice(0, 120) : null,
    p_provider: provider ? String(provider).slice(0, 60) : null,
    p_requires_approval: requiresApproval === true,
  });
  if (error) {
    const msg = String(error.message || '');
    const code = /saldo insuficiente/i.test(msg) ? 'INSUFFICIENT_BALANCE'
      : /no tiene monedero|unificarlos antes/i.test(msg) ? 'WALLET_NOT_FOUND'
      : 'LEDGER_REJECTED';
    if (code === 'LEDGER_REJECTED') console.error('[LEDGER] plantilla rechazada:', kind, key, msg);
    return { ok: false, code, message: msg };
  }
  if (!data?.journal_id) return { ok: false, code: 'LEDGER_REJECTED', message: 'El libro mayor no devolvió ningún asiento' };
  if (data.status === 'pending_approval') return { ok: false, code: 'PENDING_APPROVAL', journal_id: data.journal_id };
  return { ok: true, journal_id: data.journal_id, already_posted: data.already_posted === true };
};

const debitWallet = async (userId, amount, opts = {}) => {
  const amt = roundAmount(Number(amount || 0));
  if (!(amt > 0)) return { ok: false, code: 'INVALID_AMOUNT' };
  const wallet = await getWallet(userId);
  if (!wallet) return { ok: false, code: 'WALLET_NOT_FOUND' };
  const res = await ledgerPost({
    userId,
    operation: opts.operation || 'pago_servicio',
    key: opts.key || null,
    concept: opts.concept || `Cargo de ${amt} XAF`,
    reference: opts.reference || null,
    lines: [
      { wallet_user_id: userId, entry_type: 'debit', amount: amt },
      { account: opts.account || 'SYS-SUSPENSE', entry_type: 'credit', amount: amt },
    ],
  });
  if (!res.ok) return res;
  return { ok: true, balance: await readWalletBalance(userId), journal_id: res.journal_id, already_posted: res.already_posted };
};

const creditWallet = async (userId, amount, opts = {}) => {
  const amt = roundAmount(Number(amount || 0));
  if (!(amt > 0)) return { ok: false, code: 'INVALID_AMOUNT' };
  const wallet = await ensureWallet(userId);
  if (!wallet) return { ok: false, code: 'WALLET_NOT_FOUND' };
  const res = await ledgerPost({
    userId,
    operation: opts.operation || 'recarga',
    key: opts.key || null,
    concept: opts.concept || `Abono de ${amt} XAF`,
    reference: opts.reference || null,
    lines: [
      { wallet_user_id: userId, entry_type: 'credit', amount: amt },
      { account: opts.account || 'SYS-CASH', entry_type: 'debit', amount: amt },
    ],
  });
  if (!res.ok) return res;
  return { ok: true, balance: await readWalletBalance(userId), journal_id: res.journal_id, already_posted: res.already_posted };
};

// Traspaso entre dos monederos: un solo asiento de dos patas. Si se hiciera con
// un débito y un crédito separados, cada mitad quedaría obligada con una cuenta
// del operador y el libro mentiría sobre de dónde vino el dinero.
const moveWallets = async (fromUserId, toUserId, amount, opts = {}) => {
  const amt = roundAmount(Number(amount || 0));
  if (!(amt > 0)) return { ok: false, code: 'INVALID_AMOUNT' };
  const wallet = await getWallet(fromUserId);
  if (!wallet) return { ok: false, code: 'WALLET_NOT_FOUND' };
  await ensureWallet(toUserId);
  const res = await ledgerPost({
    userId: fromUserId,
    operation: opts.operation || 'transferencia_p2p',
    key: opts.key || null,
    concept: opts.concept || `Transferencia de ${amt} XAF`,
    reference: opts.reference || null,
    lines: [
      { wallet_user_id: toUserId, entry_type: 'credit', amount: amt },
      { wallet_user_id: fromUserId, entry_type: 'debit', amount: amt },
    ],
  });
  if (!res.ok) return res;
  return {
    ok: true,
    balance: await readWalletBalance(fromUserId),
    to_balance: await readWalletBalance(toUserId),
    journal_id: res.journal_id,
    already_posted: res.already_posted,
  };
};

// Traspaso por plantilla SQL: el mismo asiento `p2p_send` que dibuja
// ledger_lines(), pero pedido por su tipo. Es la primitiva de dinero de los
// canales sin telefono inteligente, donde no hay codigo cliente que decida
// cuantas patas tiene un pago.
const sendP2PByKind = async (fromUserId, toUserId, amount, opts = {}) => {
  const amt = roundAmount(Number(amount || 0));
  if (!(amt > 0)) return { ok: false, code: 'INVALID_AMOUNT' };
  const wallet = await getWallet(fromUserId);
  if (!wallet) return { ok: false, code: 'WALLET_NOT_FOUND' };
  await ensureWallet(toUserId);
  const res = await ledgerPostKind({
    kind: 'p2p_send',
    userId: fromUserId,
    amount: amt,
    counterpartyUserId: toUserId,
    key: opts.key || null,
    concept: opts.concept || `Transferencia de ${amt} XAF`,
    reference: opts.reference || null,
    provider: opts.provider || null,
  });
  if (!res.ok) return { ...res, balance: await readWalletBalance(fromUserId) };
  return {
    ok: true,
    balance: await readWalletBalance(fromUserId),
    to_balance: await readWalletBalance(toUserId),
    journal_id: res.journal_id,
    already_posted: res.already_posted,
  };
};

const buildPendingReference = (recipientId, concept) =>
  `${PENDING_TRANSFER_PREFIX}:${recipientId}:${Buffer.from(String(concept || ''), 'utf8').toString('base64')}`;

const parsePendingReference = (reference) => {
  const parts = String(reference || '').split(':');
  if (parts.length < 3 || parts[0] !== PENDING_TRANSFER_PREFIX) return null;
  let concept = '';
  try { concept = Buffer.from(parts.slice(2).join(':'), 'base64').toString('utf8'); } catch {}
  return { recipientId: parts[1], concept };
};

const transferErrorResponse = (res, code) => {
  if (code === 'INSUFFICIENT_BALANCE') {
    return res.status(400).json({ message: 'Saldo insuficiente', code });
  }
  if (code === 'WALLET_NOT_FOUND') {
    return res.status(409).json({ message: 'Necesitas un monedero antes de operar con dinero', code });
  }
  if (code === 'PENDING_APPROVAL') {
    return res.status(202).json({ message: 'El asiento quedó pendiente de la segunda firma de un administrador', code });
  }
  return res.status(409).json({ message: 'No se pudo completar la operación. Inténtalo de nuevo.', code });
};

// ── Modo del monedero ────────────────────────────────────────────────
// sandbox: saldo de prueba, pasarelas simuladas. live: solo dinero real,
// activado cuando existan las integraciones bancarias.
const WALLET_MODE = process.env.WALLET_MODE === 'live' ? 'live' : 'sandbox';
const WALLET_SANDBOX = WALLET_MODE === 'sandbox';
const WALLET_CURRENCY = 'XAF';

const WALLET_LIMITS = {
  dailyDeposit: 5000000,
  dailyWithdraw: 3000000,
  dailyTransfer: 3000000,
  perTxTransfer: 1000000,
};

const startOfTodayIso = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const sumTodayByType = async (userId) => {
  const { data } = await supabase
    .from('transactions')
    .select('type, amount')
    .eq('user_id', userId)
    .gte('created_at', startOfTodayIso())
    .in('type', ['deposit', 'withdraw', 'transfer_sent']);

  const totals = { deposit: 0, withdraw: 0, transfer: 0 };
  (data || []).forEach((tx) => {
    const type = String(tx.type || '').toLowerCase();
    if (type === 'transfer_sent') totals.transfer += Number(tx.amount || 0);
    else if (type in totals) totals[type] += Number(tx.amount || 0);
  });
  return totals;
};

const walletQuotaError = async (userId, kind, amount) => {
  if (kind === 'transfer' && amount > WALLET_LIMITS.perTxTransfer) {
    return `El máximo por transferencia es ${WALLET_LIMITS.perTxTransfer.toLocaleString('es-ES')} XAF`;
  }
  const limit = {
    deposit: WALLET_LIMITS.dailyDeposit,
    withdraw: WALLET_LIMITS.dailyWithdraw,
    transfer: WALLET_LIMITS.dailyTransfer,
  }[kind];
  if (!limit) return null;
  const totals = await sumTodayByType(userId);
  const used = kind === 'transfer' ? totals.transfer : totals[kind];
  if (used + amount <= limit) return null;
  return `Has alcanzado el límite diario de ${limit.toLocaleString('es-ES')} XAF para esta operación`;
};

const checkPinForOperation = async (userId, pin) => {
  const { data: user } = await supabase
    .from('users').select('pin_hash').eq('id', userId).maybeSingle();
  if (!user || !user.pin_hash) return { ok: true, configured: false };
  if (!pin) return { ok: false, code: 'PIN_REQUIRED' };
  const valid = await bcrypt.compare(String(pin), user.pin_hash);
  return valid ? { ok: true, configured: true } : { ok: false, code: 'PIN_INVALID' };
};

const pinErrorResponse = (res, code) => res.status(403).json({
  code,
  message: code === 'PIN_REQUIRED'
    ? 'Introduce tu PIN de seguridad para continuar'
    : 'PIN incorrecto',
});

const notifyMoney = (userId, title, body, extra = {}) => {
  sendPushToUser(userId, {
    title,
    body,
    notificationType: 'wallet',
    ...extra,
  }).catch((e) => console.warn('[WALLET] push error:', e.message));
};

app.post('/api/wallet/transfer', auth, walletLimiter, async (req, res) => {
  try {
    const { to, concept, pin } = req.body || {};
    const amount = roundAmount(req.body?.amount);

    if (!isValidTransferAmount(amount)) return res.status(400).json({ message: 'Importe inválido' });
    if (!to) return res.status(400).json({ message: 'Destinatario requerido' });

    const pinCheck = await checkPinForOperation(req.user.id, pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    const quotaError = await walletQuotaError(req.user.id, 'transfer', amount);
    if (quotaError) return res.status(400).json({ message: quotaError, code: 'LIMIT_EXCEEDED' });

    const isPlatformMerchant = PLATFORM_MERCHANTS.has(String(to).trim().toLowerCase());
    const recipient = isPlatformMerchant ? null : await findUserByRef(to);
    if (!recipient && !isPlatformMerchant) return res.status(404).json({ message: 'Destinatario no encontrado' });
    if (recipient && String(recipient.id) === String(req.user.id)) {
      return res.status(400).json({ message: 'No puedes transferirte a ti mismo' });
    }

    // Un traspaso entre personas es un solo asiento: sale de un monedero y entra
    // en el otro. El pago a un comercio de la plataforma sí pasa por la cuenta
    // puente, porque la deuda con ese proveedor todavía no está liquidada.
    const key = req.body?.client_ref ? `P2P-${String(req.body.client_ref)}` : null;
    const detailRef = concept ? String(concept).slice(0, 140) : null;
    const traspaso = recipient
      ? await moveWallets(req.user.id, recipient.id, amount, {
          key,
          concept: `Transferencia a ${recipient.phone || recipient.full_name || recipient.id}`,
          reference: detailRef,
        })
      : await debitWallet(req.user.id, amount, {
          operation: 'pago_servicio',
          account: 'SYS-SUSPENSE',
          concept: `Pago a ${to}`,
          key,
          reference: detailRef,
        });
    if (!traspaso.ok) return transferErrorResponse(res, traspaso.code);

    const detail = concept ? ` · ${String(concept).slice(0, 140)}` : '';
    // El libro ya conocia este client_ref: el asiento se devolvio sin mover
    // dinero, asi que tampoco hay que escribir una segunda vez la historia.
    const yaHecho = traspaso.already_posted === true;
    let sent = null;
    if (yaHecho) {
      const { data: previa } = await supabase.from('transactions')
        .select('*').eq('user_id', req.user.id).eq('type', 'transfer_sent')
        .eq('ledger_journal_id', traspaso.journal_id).maybeSingle();
      sent = previa;
    } else {
      const { data: creada } = await supabase.from('transactions').insert({
        user_id: req.user.id,
        type: 'transfer_sent',
        amount,
        method: 'EGCHAT',
        reference: recipient ? `A: ${recipient.phone || recipient.id}${detail}` : `Servicio: ${to}${detail}`,
        status: 'completed',
        ledger_journal_id: traspaso.journal_id,
      }).select().single();
      sent = creada;
    }

    if (recipient && !yaHecho) {
      await supabase.from('transactions').insert({
        user_id: recipient.id,
        type: 'transfer_received',
        amount,
        method: 'EGCHAT',
        reference: `DE: ${req.user.phone || req.user.id}${detail}`,
        status: 'completed',
        ledger_journal_id: traspaso.journal_id,
      });
      notifyMoney(
        recipient.id,
        'Has recibido dinero',
        `${req.user.phone || 'Un contacto'} te envió ${amount.toLocaleString('es-ES')} XAF`,
        { amount, senderPhone: req.user.phone || '', transactionId: sent?.id || '' },
      );
    }

    res.json({
      balance: traspaso.balance,
      transaction: sent,
      recipient: recipient
        ? { id: recipient.id, name: recipient.full_name }
        : { id: String(to), name: String(to) },
      sandbox: WALLET_SANDBOX,
    });
  } catch (e) {
    console.error('Transfer error:', e.message);
    res.status(500).json({ message: 'Error al procesar la transferencia' });
  }
});

// Transferencia pendiente: el emisor aparta el saldo y el receptor acepta.
app.post('/api/wallet/transfer/pending', auth, walletLimiter, async (req, res) => {
  try {
    const { to, concept, pin } = req.body || {};
    const amount = roundAmount(req.body?.amount);

    if (!isValidTransferAmount(amount)) return res.status(400).json({ message: 'Importe inválido' });
    if (!to) return res.status(400).json({ message: 'Destinatario requerido' });

    const pinCheck = await checkPinForOperation(req.user.id, pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    const quotaError = await walletQuotaError(req.user.id, 'transfer', amount);
    if (quotaError) return res.status(400).json({ message: quotaError, code: 'LIMIT_EXCEEDED' });

    const recipient = await findUserByRef(to);
    if (!recipient) return res.status(404).json({ message: 'Destinatario no encontrado' });
    if (String(recipient.id) === String(req.user.id)) {
      return res.status(400).json({ message: 'No puedes transferirte a ti mismo' });
    }

    // Primero se crea la transferencia y después se aparta el saldo, con el id
    // del movimiento como clave de idempotencia: un reintento del mismo pedido
    // devuelve el asiento ya hecho en vez de apartar el dinero otra vez.
    const { data: transfer, error } = await supabase.from('transactions').insert({
      user_id: req.user.id,
      type: 'transfer_sent',
      amount,
      method: 'EGCHAT',
      reference: buildPendingReference(recipient.id, concept),
      status: 'pending',
    }).select().single();

    if (error || !transfer) {
      return res.status(500).json({ message: 'No se pudo crear la transferencia' });
    }

    const debit = await debitWallet(req.user.id, amount, {
      operation: 'transferencia_p2p',
      account: 'SYS-SUSPENSE',
      concept: `Saldo apartado para ${recipient.phone || recipient.full_name || recipient.id}`,
      key: `PEND-${transfer.id}`,
      reference: `PEND:${transfer.id}`,
    });
    if (!debit.ok) {
      await supabase.from('transactions').update({ status: 'cancelled' }).eq('id', transfer.id).eq('status', 'pending');
      return transferErrorResponse(res, debit.code);
    }
    await supabase.from('transactions')
      .update({ ledger_journal_id: debit.journal_id })
      .eq('id', transfer.id);

    notifyMoney(
      recipient.id,
      'Tienes una transferencia pendiente',
      `${req.user.phone || 'Un contacto'} quiere enviarte ${amount.toLocaleString('es-ES')} XAF`,
      { amount, transferId: transfer.id, senderPhone: req.user.phone || '', pending: true },
    );

    res.json({
      success: true,
      transferId: transfer.id,
      balance: debit.balance,
      recipient: recipient.full_name || recipient.phone,
      message: 'Transferencia enviada. El destinatario debe aceptarla.',
      sandbox: WALLET_SANDBOX,
    });
  } catch (e) {
    console.error('Pending transfer error:', e.message);
    res.status(500).json({ message: 'Error al procesar la transferencia' });
  }
});

// Devuelve al emisor las transferencias pendientes que caducaron.
const expirePendingTransfer = async (transfer) => {
  const { data: claimed } = await supabase.from('transactions')
    .update({ status: 'expired' })
    .eq('id', transfer.id)
    .eq('status', 'pending')
    .select('id, user_id, amount')
    .maybeSingle();
  if (claimed) {
    // Se libera la retención: la cuenta puente era la que guardaba el saldo.
    await creditWallet(claimed.user_id, Number(claimed.amount), {
      operation: 'ajuste',
      account: 'SYS-SUSPENSE',
      concept: 'Transferencia pendiente caducada',
      key: `PEND-EXP-${claimed.id}`,
      reference: `PEND-EXP:${claimed.id}`,
    });
  }
  return Boolean(claimed);
};

app.get('/api/wallet/pending-transfers', auth, async (req, res) => {
  try {
    const userId = String(req.user.id);
    const [{ data: outgoing }, { data: incoming }] = await Promise.all([
      supabase.from('transactions')
        .select('id, user_id, amount, reference, status, created_at')
        .eq('user_id', req.user.id).eq('status', 'pending').like('reference', `${PENDING_TRANSFER_PREFIX}:%`)
        .order('created_at', { ascending: false }).limit(50),
      supabase.from('transactions')
        .select('id, user_id, amount, reference, status, created_at')
        .eq('status', 'pending')
        .like('reference', `${PENDING_TRANSFER_PREFIX}:${userId}:%`)
        .order('created_at', { ascending: false }).limit(50),
    ]);

    const now = Date.now();
    const active = [];
    for (const tx of [...(outgoing || []), ...(incoming || [])]) {
      const createdAt = new Date(tx.created_at).getTime();
      const isExpired = Number.isFinite(createdAt) && now - createdAt > TRANSFER_TTL_MS;
      if (isExpired) {
        await expirePendingTransfer(tx);
        continue;
      }
      active.push({ tx, isExpired });
    }

    const ids = new Set();
    for (const { tx } of active) {
      ids.add(String(tx.user_id));
      const parsed = parsePendingReference(tx.reference);
      if (parsed) ids.add(String(parsed.recipientId));
    }
    const { data: users } = ids.size
      ? await supabase.from('users').select('id, full_name, avatar_url').in('id', Array.from(ids))
      : { data: [] };
    const userMap = new Map((users || []).map((u) => [String(u.id), u]));

    const transfers = active
      .filter(({ tx }) => tx.status === 'pending')
      .map(({ tx }) => {
        const parsed = parsePendingReference(tx.reference) || {};
        const isIncoming = String(parsed.recipientId || '') === userId;
        const sender = userMap.get(String(tx.user_id)) || {};
        const recipient = userMap.get(String(parsed.recipientId)) || {};
        const createdAt = new Date(tx.created_at);
        return {
          id: tx.id,
          direction: isIncoming ? 'incoming' : 'outgoing',
          amount: Number(tx.amount),
          concept: parsed.concept || null,
          status: tx.status,
          expiresAt: new Date(createdAt.getTime() + TRANSFER_TTL_MS).toISOString(),
          createdAt: tx.created_at,
          isExpired: false,
          senderName: sender.full_name || '',
          senderAvatar: sender.avatar_url || null,
          recipientName: recipient.full_name || '',
          recipientAvatar: recipient.avatar_url || null,
        };
      });

    res.json({ transfers });
  } catch (e) {
    console.error('Pending transfers list error:', e.message);
    res.status(500).json({ message: 'Error al obtener las transferencias pendientes' });
  }
});

app.post('/api/wallet/transfer/accept/:id', auth, walletLimiter, async (req, res) => {
  try {
    const { data: transfer } = await supabase.from('transactions')
      .select('id, user_id, amount, reference, status, created_at')
      .eq('id', req.params.id).eq('status', 'pending')
      .maybeSingle();

    if (!transfer) return res.status(404).json({ message: 'Transferencia no encontrada o ya procesada' });

    const parsed = parsePendingReference(transfer.reference);
    if (!parsed) return res.status(404).json({ message: 'Transferencia no encontrada o ya procesada' });
    if (String(parsed.recipientId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Esta transferencia no está dirigida a ti' });
    }
    if (Date.now() - new Date(transfer.created_at).getTime() > TRANSFER_TTL_MS) {
      await expirePendingTransfer(transfer);
      return res.status(410).json({ message: 'La transferencia ha caducado' });
    }

    // Reclamo atómico: solo una petición puede pasar de pending a completed.
    const { data: claimed } = await supabase.from('transactions')
      .update({ status: 'completed' })
      .eq('id', transfer.id).eq('status', 'pending')
      .select('id').maybeSingle();
    if (!claimed) return res.status(409).json({ message: 'La transferencia ya fue procesada' });

    const amount = Number(transfer.amount);
    // El dinero sale de la cuenta puente donde quedó apartado al crear la
    // transferencia; la clave la fija el id del movimiento, así un doble clic
    // del receptor no puede cobrarla dos veces.
    const credit = await creditWallet(req.user.id, amount, {
      operation: 'transferencia_p2p',
      account: 'SYS-SUSPENSE',
      concept: `Transferencia recibida de ${transfer.user_id}`,
      key: `PEND-ACK-${transfer.id}`,
      reference: `PEND-ACK:${transfer.id}`,
    });
    if (!credit.ok) {
      // Se devuelve a pendiente para que el receptor pueda reintentar: si el
      // asiento se rechaza, el abono tampoco llegó al monedero.
      await supabase.from('transactions').update({ status: 'pending' }).eq('id', transfer.id);
      return transferErrorResponse(res, credit.code);
    }

    await supabase.from('transactions').insert({
      user_id: req.user.id,
      type: 'transfer_received',
      amount,
      method: 'EGCHAT',
      reference: `DE: ${transfer.user_id}${parsed.concept ? ` · ${parsed.concept.slice(0, 140)}` : ''}`,
      status: 'completed',
      ledger_journal_id: credit.journal_id,
    });

    notifyMoney(
      transfer.user_id,
      'Transferencia aceptada',
      `${req.user.phone || 'El destinatario'} aceptó tu transferencia de ${amount.toLocaleString('es-ES')} XAF`,
      { amount, transferId: transfer.id, accepted: true },
    );

    res.json({ success: true, balance: credit.balance, message: 'Transferencia aceptada', sandbox: WALLET_SANDBOX });
  } catch (e) {
    console.error('Accept transfer error:', e.message);
    res.status(500).json({ message: 'Error al aceptar la transferencia' });
  }
});

app.post('/api/wallet/transfer/cancel/:id', auth, walletLimiter, async (req, res) => {
  try {
    const { data: transfer } = await supabase.from('transactions')
      .select('id, user_id, amount, reference, status')
      .eq('id', req.params.id).eq('user_id', req.user.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (!transfer || !parsePendingReference(transfer.reference)) {
      return res.status(404).json({ message: 'Transferencia no encontrada o ya procesada' });
    }

    const { data: claimed } = await supabase.from('transactions')
      .update({ status: 'cancelled' })
      .eq('id', transfer.id).eq('status', 'pending')
      .select('id').maybeSingle();
    if (!claimed) return res.status(409).json({ message: 'La transferencia ya fue procesada' });

    // Devolución del saldo apartado: mismo asiento en sentido contrario que el
    // de la aceptación, y clave fija por el id para no poder devolver dos veces.
    const devolucion = await creditWallet(req.user.id, Number(transfer.amount), {
      operation: 'ajuste',
      account: 'SYS-SUSPENSE',
      concept: 'Transferencia pendiente cancelada',
      key: `PEND-CANCEL-${transfer.id}`,
      reference: `PEND-CANCEL:${transfer.id}`,
    });
    if (!devolucion.ok) {
      await supabase.from('transactions').update({ status: 'pending' }).eq('id', transfer.id).eq('status', 'cancelled');
      return transferErrorResponse(res, devolucion.code);
    }
    res.json({ success: true, message: 'Transferencia cancelada y saldo devuelto', balance: devolucion.balance });
  } catch (e) {
    console.error('Cancel transfer error:', e.message);
    res.status(500).json({ message: 'Error al cancelar la transferencia' });
  }
});

// Redención de un código de recarga. Un único camino para la app y para los
// canales sin teléfono inteligente: si el canal tuviera su propia versión, el
// histórico y el libro mayor se escribirían distinto según por dónde entrara.
// Devuelve códigos, no respuestas HTTP.
const redeemRechargeCode = async ({ userId, code }) => {
  const raw = String(code || '').trim();
  if (raw.replace(/-/g, '').length !== 16) return { ok: false, code: 'CODE_INVALID' };

  const { data: row } = await supabase
    .from('recharge_codes').select('*').eq('code', raw).maybeSingle();
  if (!row) return { ok: false, code: 'CODE_NOT_FOUND' };
  if (row.used || row.is_used) return { ok: false, code: 'CODE_USED' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false, code: 'CODE_EXPIRED' };

  const amount = roundAmount(Number(row.amount || 5000));

  // Reclamo atómico: solo la primera petición que encuentre el código sin usar
  // consigue la fila actualizada; las demás reciben data = null.
  const { data: claimed } = await supabase
    .from('recharge_codes')
    .update({ used: true, used_by: userId, used_at: new Date().toISOString() })
    .eq('code', raw)
    .or('used.eq.false,used.is.null')
    .select('id')
    .maybeSingle();
  if (!claimed) return { ok: false, code: 'CODE_USED' };

  // El código ya está reclamado (used=true) antes de abonar: la clave del
  // asiento es el id del código, así que aunque la petición se repita el
  // importe entra una sola vez.
  const credit = await creditWallet(userId, amount, {
    operation: 'recarga',
    account: 'SYS-CASH',
    concept: `Recarga con código ${raw}`,
    key: `RECHARGE-${claimed.id}`,
    reference: raw,
  });
  if (!credit.ok) {
    await supabase.from('recharge_codes')
      .update({ used: false, used_by: null, used_at: null })
      .eq('code', raw);
    return { ok: false, code: credit.code };
  }

  await supabase.from('transactions').insert({
    user_id: userId, type: 'deposit', amount, method: 'Código de recarga',
    reference: raw, status: 'completed', ledger_journal_id: credit.journal_id,
  });
  return { ok: true, amount, balance: credit.balance };
};

app.post('/api/wallet/recharge-code', auth, walletLimiter, async (req, res) => {
  const out = await redeemRechargeCode({ userId: req.user.id, code: req.body?.code });
  if (!out.ok) {
    const messages = {
      CODE_INVALID: 'Código inválido',
      CODE_NOT_FOUND: 'Código no válido',
      CODE_USED: 'Código ya utilizado',
      CODE_EXPIRED: 'Código expirado',
    };
    return res.status(400).json({
      message: messages[out.code] || 'No se pudo completar la recarga',
      code: out.code,
    });
  }
  res.json({
    balance: out.balance,
    amount: out.amount,
    message: `${out.amount.toLocaleString()} XAF añadidos`,
    sandbox: WALLET_SANDBOX,
  });
});

// ── Pasarela de pagos ────────────────────────────────────────────────
// Mientras WALLET_MODE=sandbox las pasarelas se simulan sobre
// payment_transactions. En modo live rechazan la operación hasta que
// exista la integración real con el banco u operador.
const PAYMENT_GATEWAYS = new Set([
  'stripe', 'orange_money', 'mtn_mobile', 'bank_transfer',
  'cash_agent', 'recharge_code', 'egchat_transfer',
]);
const MIN_DEPOSIT_AMOUNT = 500;
const SANDBOX_USSD = { orange_money: '*144#', mtn_mobile: '*126#' };

const createPaymentId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

const sandboxPaymentsOnly = (res) => {
  if (WALLET_SANDBOX) return true;
  res.status(501).json({
    code: 'PAYMENTS_NOT_CONFIGURED',
    message: 'Los pagos reales todavía no están disponibles. Espera a la integración bancaria.',
  });
  return false;
};

const getPaymentRow = async (id, userId) => {
  const { data } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
};

app.post('/api/payments/deposit/intent', auth, walletLimiter, async (req, res) => {
  try {
    if (!sandboxPaymentsOnly(res)) return;
    const gateway = String(req.body?.gateway || '');
    const amount = roundAmount(req.body?.amount);
    const phone = req.body?.phone ? String(req.body.phone) : null;

    if (!PAYMENT_GATEWAYS.has(gateway)) return res.status(400).json({ message: 'Pasarela no válida' });
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_AMOUNT || amount > MAX_TRANSFER_AMOUNT) {
      return res.status(400).json({ message: `El importe debe estar entre ${MIN_DEPOSIT_AMOUNT} y ${MAX_TRANSFER_AMOUNT.toLocaleString('es-ES')} XAF` });
    }
    if ((gateway === 'orange_money' || gateway === 'mtn_mobile') && !phone) {
      return res.status(400).json({ message: 'Número de teléfono requerido' });
    }

    const quotaError = await walletQuotaError(req.user.id, 'deposit', amount);
    if (quotaError) return res.status(400).json({ message: quotaError, code: 'LIMIT_EXCEEDED' });

    const id = createPaymentId('pay');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error } = await supabase.from('payment_transactions').insert({
      id,
      user_id: req.user.id,
      type: 'deposit',
      amount,
      currency: WALLET_CURRENCY,
      gateway,
      status: 'processing',
      metadata: {
        sandbox: true,
        phone,
        description: req.body?.description || 'Recarga EGChat',
        expires_at: expiresAt,
      },
    });
    if (error) throw error;

    res.json({
      id,
      amount,
      currency: WALLET_CURRENCY,
      gateway,
      status: 'processing',
      clientSecret: gateway === 'stripe' ? `sbx_${id}_secret` : undefined,
      ussdCode: SANDBOX_USSD[gateway],
      expiresAt,
      sandbox: true,
    });
  } catch (e) {
    console.error('Payment intent error:', e.message);
    res.status(500).json({ message: 'No se pudo crear la operación de pago' });
  }
});

app.post('/api/payments/deposit/confirm', auth, walletLimiter, async (req, res) => {
  try {
    if (!sandboxPaymentsOnly(res)) return;
    const intentId = String(req.body?.intentId || '');
    if (!intentId) return res.status(400).json({ message: 'intentId requerido' });

    const intent = await getPaymentRow(intentId, req.user.id);
    if (!intent || intent.type !== 'deposit') return res.status(404).json({ message: 'Operación no encontrada' });

    const wallet = await ensureWallet(req.user.id);
    if (intent.status === 'completed') {
      return res.json({ ok: true, transactionId: intent.id, newBalance: Number(wallet?.balance || 0), sandbox: true });
    }
    if (intent.status !== 'processing') {
      return res.status(409).json({ message: 'La operación ya no está pendiente' });
    }

    const { data: claimed } = await supabase.from('payment_transactions')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', intent.id).eq('status', 'processing')
      .select('id').maybeSingle();
    if (!claimed) return res.status(409).json({ message: 'La operación ya fue procesada' });

    const credit = await creditWallet(req.user.id, roundAmount(intent.amount), {
      operation: 'recarga',
      account: 'SYS-CASH',
      concept: `Recarga por ${intent.gateway || 'pasarela'}`,
      key: `PAY-${intent.id}`,
      reference: intent.id,
    });
    if (!credit.ok) {
      await supabase.from('payment_transactions')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return transferErrorResponse(res, credit.code);
    }

    const { data: tx } = await supabase.from('transactions').insert({
      user_id: req.user.id,
      type: 'deposit',
      amount: roundAmount(intent.amount),
      method: intent.gateway,
      reference: intent.id,
      status: 'completed',
      ledger_journal_id: credit.journal_id,
    }).select().single();

    res.json({ ok: true, transactionId: tx?.id || intent.id, newBalance: credit.balance, sandbox: true });
  } catch (e) {
    console.error('Payment confirm error:', e.message);
    res.status(500).json({ message: 'No se pudo confirmar el pago' });
  }
});

app.get('/api/payments/status/:id', auth, async (req, res) => {
  try {
    const intent = await getPaymentRow(req.params.id, req.user.id);
    if (!intent) return res.status(404).json({ message: 'Operación no encontrada' });
    const wallet = await getWallet(req.user.id);
    res.json({
      status: intent.status,
      balance: Number(wallet?.balance || 0),
      transactionId: intent.status === 'completed' ? intent.id : undefined,
      sandbox: WALLET_SANDBOX,
    });
  } catch (e) {
    res.status(500).json({ message: 'No se pudo consultar el estado' });
  }
});

app.post('/api/payments/withdraw/intent', auth, walletLimiter, async (req, res) => {
  try {
    if (!sandboxPaymentsOnly(res)) return;
    const gateway = String(req.body?.gateway || '');
    const amount = roundAmount(req.body?.amount);
    const destination = req.body?.destination || {};

    if (!PAYMENT_GATEWAYS.has(gateway)) return res.status(400).json({ message: 'Pasarela no válida' });
    if (!isValidTransferAmount(amount)) return res.status(400).json({ message: 'Importe inválido' });

    const quotaError = await walletQuotaError(req.user.id, 'withdraw', amount);
    if (quotaError) return res.status(400).json({ message: quotaError, code: 'LIMIT_EXCEEDED' });

    const wallet = await getWallet(req.user.id);
    if (Number(wallet?.balance || 0) < amount) {
      return res.status(400).json({ message: 'Saldo insuficiente', code: 'INSUFFICIENT_BALANCE' });
    }

    const id = createPaymentId('wd');
    const { error } = await supabase.from('payment_transactions').insert({
      id,
      user_id: req.user.id,
      type: 'withdrawal',
      amount,
      currency: WALLET_CURRENCY,
      gateway,
      status: 'processing',
      metadata: { sandbox: true, destination },
    });
    if (error) throw error;

    res.json({
      id,
      amount,
      currency: WALLET_CURRENCY,
      gateway,
      status: 'processing',
      estimatedTime: 'Inmediato',
      fee: 0,
      netAmount: amount,
      sandbox: true,
    });
  } catch (e) {
    console.error('Withdraw intent error:', e.message);
    res.status(500).json({ message: 'No se pudo crear la retirada' });
  }
});

app.post('/api/payments/withdraw/confirm/:id', auth, walletLimiter, async (req, res) => {
  try {
    if (!sandboxPaymentsOnly(res)) return;
    const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    const intent = await getPaymentRow(req.params.id, req.user.id);
    if (!intent || intent.type !== 'withdrawal') return res.status(404).json({ message: 'Operación no encontrada' });
    if (intent.status !== 'processing') return res.status(409).json({ message: 'La operación ya no está pendiente' });

    const { data: claimed } = await supabase.from('payment_transactions')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', intent.id).eq('status', 'processing')
      .select('id').maybeSingle();
    if (!claimed) return res.status(409).json({ message: 'La operación ya fue procesada' });

    const debit = await debitWallet(req.user.id, roundAmount(intent.amount), {
      operation: 'retiro',
      account: 'SYS-CASH',
      concept: `Retirada por ${intent.gateway || 'pasarela'}`,
      key: `PAY-${intent.id}`,
      reference: intent.id,
    });
    if (!debit.ok) {
      await supabase.from('payment_transactions')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return transferErrorResponse(res, debit.code);
    }

    const { data: tx } = await supabase.from('transactions').insert({
      user_id: req.user.id,
      type: 'withdraw',
      amount: roundAmount(intent.amount),
      method: intent.gateway,
      reference: intent.id,
      status: 'completed',
      ledger_journal_id: debit.journal_id,
    }).select().single();

    res.json({ ok: true, transactionId: tx?.id || intent.id, newBalance: debit.balance, sandbox: true });
  } catch (e) {
    console.error('Withdraw confirm error:', e.message);
    res.status(500).json({ message: 'No se pudo confirmar la retirada' });
  }
});

app.get('/api/payments/history', auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const from = (page - 1) * limit;

    const { data } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    res.json((data || []).map((row) => ({
      id: row.id,
      type: row.type === 'withdrawal' ? 'withdrawal' : 'deposit',
      amount: Number(row.amount),
      currency: row.currency || WALLET_CURRENCY,
      gateway: row.gateway,
      gatewayTxnId: row.gateway_txn_id || undefined,
      status: row.status,
      description: row.metadata?.description || '',
      createdAt: row.created_at,
    })));
  } catch (e) {
    console.error('Payment history error:', e.message);
    res.status(500).json({ message: 'No se pudo obtener el historial' });
  }
});

const getWalletSafe = async (userId) => {
  let { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).maybeSingle();
  if (!wallet) {
    const { data } = await supabase
      .from('wallets')
      .insert({ user_id: userId, balance: 0, currency: WALLET_CURRENCY })
      .select()
      .single();
    wallet = data;
  }
  return wallet;
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

app.post('/api/wallet/hold', auth, walletLimiter, async (req, res) => {
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

app.post('/api/wallet/hold/:id/capture', auth, walletLimiter, async (req, res) => {
  const holdId = req.params.id;
  const { data: hold } = await supabase.from('transactions').select('*')
    .eq('id', holdId).eq('user_id', req.user.id).eq('type', 'hold').maybeSingle();
  if (!hold) return res.status(404).json({ message: 'Retención no encontrada' });
  if (hold.status !== 'pending') return res.status(400).json({ message: 'Retención ya procesada' });

  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

  const amount = Number(hold.amount || 0);
  // Reclamar la retención antes de mover dinero: dos peticiones simultáneas no
  // pueden capturar la misma retención dos veces.
  const { data: claimed } = await supabase.from('transactions')
    .update({ status: 'captured' })
    .eq('id', holdId).eq('user_id', req.user.id).eq('status', 'pending')
    .select().maybeSingle();
  if (!claimed) return res.status(409).json({ message: 'Retención ya en proceso' });

  const debit = await debitWallet(req.user.id, amount, {
    operation: 'pago_servicio',
    account: 'SYS-SUSPENSE',
    concept: `Captura de retención ${hold.reference || holdId}`,
    key: `HOLD-CAP-${holdId}`,
    reference: `CAPTURE:${hold.reference || holdId}`,
  });
  if (!debit.ok) {
    await supabase.from('transactions').update({ status: 'pending' }).eq('id', holdId);
    return transferErrorResponse(res, debit.code);
  }

  const { data: tx } = await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'payment_capture', amount, method: 'EGCHAT',
    reference: `CAPTURE:${hold.reference || holdId}`, status: 'completed',
    ledger_journal_id: debit.journal_id
  }).select().single();
  res.json({ balance: debit.balance, transaction: tx });
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

// No existe ya una ruta de reversión para el usuario: acreditaba el importe al
// emisor sin descontarlo del receptor, que ya lo había cobrado, y cualquiera con
// sesión podía ejecutarla. Las devoluciones se harán por el libro mayor, como
// asiento de dos patas y con aprobación de administrador.

const LEDGER_APPROVAL_THRESHOLD = Number(process.env.LEDGER_APPROVAL_THRESHOLD || 1000000);

// El plan contable del operador (SYS-CASH, SYS-FEES, SYS-SUSPENSE,
// SYS-DISCREPANCY) lo siembra la migracion 2026-11-02_ledger_lote_b.sql. Antes
// lo upserteaba este código sin índice unico en ledger_accounts.code: fallaba en
// silencio y no quedaba ni plan contable.
const makeAccountCode = (userId) => `USR-${String(userId).slice(0, 8)}-${Date.now()}`;

app.get('/api/wallet/ledger/config', auth, async (_req, res) => {
  res.json({
    approval_threshold: LEDGER_APPROVAL_THRESHOLD,
    currency: 'XAF',
    modes: ['draft', 'posted', 'pending_approval', 'rejected', 'reversed']
  });
});

app.get('/api/wallet/ledger/accounts', auth, async (req, res) => {
  const scope = String(req.query.scope || 'mine');
  let query = supabase.from('ledger_accounts').select('*').order('created_at', { ascending: false });
  if (scope === 'system') query = query.eq('is_system', true);
  else if (scope === 'all') query = query.or(`is_system.eq.true,user_id.eq.${req.user.id}`);
  else query = query.eq('user_id', req.user.id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ message: error.message });
  res.json(data || []);
});

// Alta de cuentas del plan contable: solo administrador. La cuenta-monedero de
// un cliente la crea ledger_post() en su primera operación, no esta ruta.
app.post('/api/wallet/ledger/accounts', requireAdmin, async (req, res) => {
  const { name, account_type, currency, user_id } = req.body || {};
  if (!name || !account_type) return res.status(400).json({ message: 'name y account_type son requeridos' });
  const payload = {
    user_id: user_id || null,
    code: makeAccountCode(user_id || req.admin.id),
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

// Único camino para abrir un asiento desde fuera del monedero: ledger_post, que
// cuadra, sella y mueve los monederos en la misma transacción. Antes esta ruta
// insertaba journal + entries a mano con cualquier token de usuario, así que un
// cliente podía asentarse el saldo que quisiera.
app.post('/api/wallet/ledger/journals', requireAdmin, async (req, res) => {
  const { concept, reference, lines, operation, idempotency_key, user_id } = req.body || {};
  if (!concept || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ message: 'concept y al menos 2 líneas son requeridos' });
  }

  let debit = 0;
  let credit = 0;
  const normalized = [];
  for (const l of lines) {
    const amount = roundAmount(Number(l?.amount || 0));
    const entryType = String(l?.entry_type || '').toLowerCase();
    const code = String(l?.account || '').trim().toUpperCase();
    const walletUser = String(l?.wallet_user_id || '').trim();
    if (!['debit', 'credit'].includes(entryType) || !(amount > 0) || (!code && !walletUser)) {
      return res.status(400).json({
        message: 'Líneas inválidas: cada una necesita account (código) o wallet_user_id, entry_type y amount > 0',
      });
    }
    if (entryType === 'debit') debit += amount;
    else credit += amount;
    normalized.push({
      ...(code ? { account: code } : { wallet_user_id: walletUser }),
      entry_type: entryType,
      amount,
      currency: String(l?.currency || 'XAF'),
      memo: l?.memo ? String(l.memo) : null,
      counterparty_user_id: l?.counterparty_user_id || null,
    });
  }
  if (Math.abs(roundAmount(debit) - roundAmount(credit)) >= 0.005) {
    return res.status(400).json({ message: `Asiento no balanceado: debe ${debit} / haber ${credit}` });
  }

  const total = roundAmount(debit);
  const asiento = await ledgerPost({
    userId: user_id || req.admin.id,
    operation: String(operation || 'ajuste'),
    key: idempotency_key ? String(idempotency_key) : `MANUAL-${req.admin.id}-${Date.now()}`,
    concept,
    reference,
    lines: normalized,
    requiresApproval: total >= LEDGER_APPROVAL_THRESHOLD,
  });
  if (!asiento.ok) return transferErrorResponse(res, asiento.code);

  const { data: journal } = await supabase.from('ledger_journals')
    .select('id, status, total_amount, requires_approval, posted_at')
    .eq('id', asiento.journal_id)
    .maybeSingle();
  res.status(201).json({
    ...(journal || { id: asiento.journal_id }),
    already_posted: asiento.already_posted === true,
  });
});

// Devolver un asiento cerrado: asiento espejo, el original queda 'reversed' y
// sigue visible. Solo administrador y con la segunda firma de otro administrador.
app.post('/api/wallet/ledger/journals/:id/reverse', requireAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ message: 'reason es obligatorio en una reversión' });
  const { data, error } = await supabase.rpc('ledger_reverse_journal', {
    p_journal_id: req.params.id,
    p_admin_id: req.admin.id,
    p_reason: String(reason).slice(0, 200),
  });
  if (error) return res.status(400).json({ message: error.message, code: 'REVERSE_FAILED' });
  res.json(data || { journal_id: req.params.id });
});

// Cuadre monedero-libro: los monederos cuyo saldo no tiene asiento detrás.
app.get('/api/wallet/ledger/reconciliation', requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from('ledger_wallet_reconciliation_v')
    .select('user_id, currency, wallet_balance, ledger_balance, drift')
    .order('drift', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ message: error.message });
  const desfases = (data || []).filter((r) => Math.abs(Number(r.drift || 0)) >= 0.005);
  res.json({ total: (data || []).length, con_desfase: desfases.length, filas: desfases.slice(0, 100) });
});

app.post('/api/wallet/ledger/journals/:id/approve', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { reason } = req.body || {};

  // La comprobación maker-checker y el cierre del asiento los hace la base de
  // datos en ledger_approve_journal: desde aquí no se puede aprobar moviendo el
  // saldo a mano.
  const { data, error } = await supabase.rpc('ledger_approve_journal', {
    p_journal_id: id,
    p_admin_id: req.admin.id,
    p_reason: reason ? String(reason).slice(0, 200) : null,
  });
  if (error) return res.status(400).json({ message: error.message, code: 'APPROVE_FAILED' });
  if (data?.approved === false) {
    return res.status(400).json({ message: 'El asiento no está pendiente de aprobación', status: data.status });
  }
  res.json({ message: 'Asiento aprobado y contabilizado', journal_id: id, status: data.status });
});

app.post('/api/wallet/ledger/journals/:id/reject', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { reason } = req.body || {};
  const { data: journal } = await supabase
    .from('ledger_journals')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!journal) return res.status(404).json({ message: 'Asiento no encontrado' });
  if (journal.status !== 'pending_approval') return res.status(400).json({ message: 'El asiento no está pendiente de aprobación' });
  if (String(journal.created_by) === String(req.admin.id)) {
    return res.status(403).json({ message: 'Maker-checker activo: el creador no puede rechazar su propio asiento' });
  }

  const updatedAt = new Date().toISOString();
  // Rechazar no mueve dinero: el asiento nunca llegó a cerrarse, así que el
  // disparador de aplicación no intervino. Las líneas quedan intactas y
  // selladas como 'rejected' para que el intento quede auditable.
  const { error } = await supabase.from('ledger_journals').update({
    status: 'rejected',
    approved_by: req.admin.id,
    approved_at: updatedAt,
  }).eq('id', id).eq('status', 'pending_approval');
  await supabase.from('ledger_approvals').upsert({
    journal_id: id,
    requested_by: journal.created_by,
    approved_by: req.admin.id,
    status: 'rejected',
    reason: reason || 'Rechazado por validador',
    updated_at: updatedAt,
  }, { onConflict: 'journal_id' });

  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: 'Asiento rechazado', journal_id: id });
});

// Anuncio y exigencia son los mismos numeros: una llamada directa no pasa por la pantalla.
const CEMAC_MIN_AMOUNT = 1000;
const CEMAC_MAX_AMOUNT = 1000000;

app.get('/api/cemac/rates', auth, async (_req, res) => {
  try {
    const comision = await readTariff('cemac', 'fee');
    res.json({
      base: 'XAF',
      countries: ['GQ', 'CM', 'GA', 'CG', 'TD', 'CF'],
      transfer_fee_flat: comision ? Number(comision.amount) : null,
      sandbox: true,
      max_amount: CEMAC_MAX_AMOUNT,
      min_amount: CEMAC_MIN_AMOUNT
    });
  } catch (error) {
    console.error('CEMAC rates error:', error);
    res.status(500).json({ message: 'Error al obtener tasas', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/cemac/transfers', auth, walletLimiter, async (req, res) => {
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

    const importeCemac = Number(amount);
    if (!Number.isFinite(importeCemac) || importeCemac < CEMAC_MIN_AMOUNT || importeCemac > CEMAC_MAX_AMOUNT) {
      return res.status(400).json({
        message: `El importe debe estar entre ${CEMAC_MIN_AMOUNT} y ${CEMAC_MAX_AMOUNT.toLocaleString('es-ES')} XAF`,
        code: 'AMOUNT_OUT_OF_RANGE',
      });
    }
    
    const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    // Reintentar el mismo pedido devuelve la transferencia ya creada.
    if (external_id) {
      const { data: existing } = await supabase.from('cemac_transfers')
        .select('*').eq('transfer_ref', external_id).eq('user_id', req.user.id).maybeSingle();
      if (existing) return res.json({ transfer: existing, idempotent: true });
    }

    const comision = await readTariff('cemac', 'fee');
    if (!comision) return res.status(502).json({ message: 'Comision CEMAC no disponible', code: 'TARIFF_UNAVAILABLE' });
    const fee = Number(comision.amount);
    const total = roundAmount(Number(amount) + fee);
    const transferRef = external_id || safeRef('CEMAC');

    // Sin fila no hay cargo: antes el dinero salia del monedero aunque la
    // transferencia solo existiera en la memoria del proceso.
    const { data: transfer, error: insertError } = await supabase.from('cemac_transfers').insert({
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
    }).select().single();
    if (insertError || !transfer) {
      console.error('CEMAC transfer insert:', insertError?.message);
      return res.status(502).json({ message: 'No se pudo registrar la transferencia', code: 'TRANSFER_NOT_SAVED' });
    }

    // El cargo se asienta después de crear la transferencia y con su referencia
    // como clave de idempotencia: repetir el mismo pedido devuelve el asiento ya
    // hecho en lugar de volver a cobrar. La comisión se reconoce como ingreso
    // del operador y solo lo enviado al beneficiario queda obligado en la cuenta
    // puente; antes se debitaba el total y se asentaba solo el importe.
    const asiento = await ledgerPost({
      userId: req.user.id,
      operation: 'pago_servicio',
      key: `CEMAC-${transferRef}`,
      concept: `Transferencia CEMAC ${from_country}->${to_country} a ${beneficiary_name}`,
      reference: `CEMAC:${transferRef}`,
      lines: [
        { wallet_user_id: req.user.id, entry_type: 'debit', amount: total },
        { account: 'SYS-SUSPENSE', entry_type: 'credit', amount: roundAmount(Number(amount)) },
        { account: 'SYS-FEES', entry_type: 'credit', amount: fee },
      ],
    });
    if (!asiento.ok) {
      await supabase.from('cemac_transfers').update({ status: 'failed' }).eq('transfer_ref', transferRef);
      return transferErrorResponse(res, asiento.code);
    }
    const journalId = asiento.journal_id;
    await supabase.from('cemac_transfers').update({ journal_id: journalId }).eq('id', transfer.id);
    await supabase.from('transactions').insert({
      user_id: req.user.id,
      type: 'cemac_transfer',
      amount: total,
      method: 'EGCHAT',
      reference: `CEMAC:${transferRef}`,
      status: 'completed',
      ledger_journal_id: journalId,
    });
    
    await logAudit(req.user.id, 'cemac_transfer_create', 'cemac', transfer.id, { transfer_ref: transferRef, amount: Number(amount), fee });

    res.status(201).json({ transfer, ledger_journal_id: journalId, balance: await readWalletBalance(req.user.id) });
  } catch (e) {
    console.error('CEMAC transfer error:', e);
    res.status(500).json({ message: e?.message || 'Error interno', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/cemac/transfers', auth, async (req, res) => {
  try {
    const { data: transfers, error } = await supabase.from('cemac_transfers')
      .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(502).json({ message: 'No se pudieron listar las transferencias', code: 'TRANSFERS_UNAVAILABLE' });

    res.json(transfers || []);
  } catch (e) {
    console.error('CEMAC transfers error:', e);
    res.status(500).json({ message: e?.message || 'Error interno', code: 'INTERNAL_ERROR' });
  }
});

// ════════════════════════════════════════════════════════════════════
// LIA-25 — asistente de EGCHAT
// Responde con datos reales de la app (saldo, movimientos, noticias,
// tiempo, salud, supermercados, taxi, transferencias). Si el servidor
// tiene GROQ_API_KEY u OPENAI_API_KEY, usa el modelo para preguntas
// abiertas; si no, responde con el motor de intenciones.
// ════════════════════════════════════════════════════════════════════
const LIA_LANGS = ['es', 'fr', 'en', 'pt'];
const LIA_LANG_NAMES = { es: 'español', fr: 'francés', en: 'inglés', pt: 'portugués' };

const liaNorm = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

const liaMoney = (amount) => `${String(Math.round(Number(amount) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} XAF`;

const liaFill = (template, vars) =>
  String(template).replace(/\{(\w+)\}/g, (_match, key) => (vars[key] === undefined ? '' : vars[key]));

const LIA_COPY = {
  es: {
    emptyMessage: 'Escribe un mensaje para Lia-25.',
    tooLong: 'El mensaje es demasiado largo (máximo 2000 caracteres).',
    greeting: '¡Hola! Soy Lia-25, tu asistente de EGCHAT. Puedo decirte tus notificaciones y mensajes pendientes, si debes pagar tu Djangue, tu saldo y tus movimientos, las noticias y el tiempo, y guiarte para pedir un taxi o enviar dinero. ¿Qué necesitas?',
    balance: 'Tu saldo actual es *{balance}*.',
    balanceWithMovements: 'Tu saldo actual es *{balance}*.\n\nTus últimos movimientos:\n{movements}',
    movementsTitle: 'Tus últimos movimientos:\n{movements}',
    noMovements: 'Todavía no tienes movimientos registrados. Puedes recargar desde Cartera → Recargar.',
    newsTitle: 'Noticias de hoy:\n{list}',
    noNews: 'Ahora mismo no hay noticias publicadas. Vuelve a mirar más tarde.',
    weather: 'El tiempo en {city}: {temp} °C, {desc}. Viento de {wind} km/h y humedad del {humidity} %.',
    weatherError: 'No he podido consultar el tiempo ahora mismo. Inténtalo de nuevo en un minuto.',
    healthTitle: 'Centros de salud y farmacias:\n{list}',
    marketTitle: 'Supermercados disponibles:\n{list}',
    atmTitle: 'Cajeros disponibles:\n{list}',
    ratesTitle: 'Tipo de cambio:\n{list}',
    card: 'Puedes ver y gestionar tus tarjetas en Cartera → Tarjetas. Si pierdes una, bloquéala ahí mismo al instante.',
    bank: 'Consulta las entidades y cajeros disponibles en Servicios → Bancos.',
    closed: 'cerrado',
    taxi: 'Para pedir un taxi abre MiTaxi, indica el origen y el destino y confirma.\nTarifas: moto 800 XAF, básico 1 500 XAF, premium 3 500 XAF.',
    transfer: 'Para enviar dinero entra en Cartera → Enviar; para retirar, Cartera → Retirar; para recargar, Cartera → Recargar.\nSi quieres, antes te digo tu saldo.',
    thanks: '¡De nada! Estoy aquí para lo que necesites.',
    help: 'Puedo hacer esto por ti:\n• Consultar tu saldo y tus últimos movimientos.\n• Decirte tus notificaciones y mensajes pendientes.\n• Comprobar si debes pagar tu Djangue o si te toca cobrar.\n• Darte las noticias del día y el tiempo de tu ciudad.\n• Buscar hospitales, farmacias y supermercados.\n• Explicarte cómo pedir un taxi o enviar dinero.\nEscríbemelo o usa los botones de abajo.',
    notificationsTitle: 'Tus notificaciones:\n{list}',
    noNotifications: 'No tienes notificaciones ni mensajes pendientes ahora mismo.',
    djangueTitle: 'Tus djangues:\n{list}',
    noDjangue: 'Todavía no participas en ningún djangue. Puedes crear uno o unirte desde Mi Djangue.',
    djangueOwe: 'En {name} te falta la cuota del turno actual: {quota}. Puedes pagarla en Mi Djangue.',
    djanguePaid: 'En {name} ya pagaste la cuota de este turno.',
    djangueMyTurn: 'En {name} te toca cobrar este turno.',
    unknown: 'No estoy seguro de haberte entendido. Prueba con: "mi saldo", "últimos movimientos", "noticias", "el tiempo", "taxi" o "hospitales".',
    serviceError: 'No he podido obtener esa información ahora mismo. Inténtalo de nuevo en unos segundos.',
    movementTypes: { deposit: 'Recarga', withdraw: 'Retiro', transfer: 'Transferencia', transfer_sent: 'Envío', transfer_received: 'Recibido', shopping_payment: 'Compra', payment: 'Pago', refund: 'Reembolso', default: 'Movimiento' },
  },
  fr: {
    emptyMessage: 'Écrivez un message à Lia-25.',
    tooLong: 'Le message est trop long (2000 caractères maximum).',
    greeting: 'Bonjour ! Je suis Lia-25, votre assistante EGCHAT. Je peux vous dire vos notifications et messages en attente, si vous devez payer votre Djangue, votre solde et vos opérations, les actualités et la météo, et vous guider pour commander un taxi ou envoyer de l\'argent. Que puis-je faire ?',
    balance: 'Votre solde actuel est de *{balance}*.',
    balanceWithMovements: 'Votre solde actuel est de *{balance}*.\n\nVos dernières transactions :\n{movements}',
    movementsTitle: 'Vos dernières transactions :\n{movements}',
    noMovements: 'Vous n\'avez pas encore de transactions. Vous pouvez recharger depuis Portefeuille → Recharger.',
    newsTitle: 'Actualités du jour :\n{list}',
    noNews: 'Aucune actualité publiée pour le moment. Revenez plus tard.',
    weather: 'Météo à {city} : {temp} °C, {desc}. Vent de {wind} km/h et humidité de {humidity} %.',
    weatherError: 'Impossible de consulter la météo pour le moment. Réessayez dans une minute.',
    healthTitle: 'Centres de santé et pharmacies :\n{list}',
    marketTitle: 'Supermarchés disponibles :\n{list}',
    atmTitle: 'Distributeurs disponibles :\n{list}',
    ratesTitle: 'Taux de change :\n{list}',
    card: 'Vous pouvez consulter et gérer vos cartes dans Portefeuille → Cartes. En cas de perte, bloquez-la immédiatement depuis cet écran.',
    bank: 'Consultez les banques et distributeurs disponibles dans Services → Banques.',
    closed: 'fermé',
    taxi: 'Pour commander un taxi, ouvrez MiTaxi, indiquez le départ et la destination puis confirmez.\nTarifs : moto 800 XAF, basique 1 500 XAF, premium 3 500 XAF.',
    transfer: 'Pour envoyer de l\'argent, allez dans Portefeuille → Envoyer ; pour retirer, Portefeuille → Retirer ; pour recharger, Portefeuille → Recharger.\nJe peux d\'abord vous indiquer votre solde.',
    thanks: 'Avec plaisir ! Je suis là pour vous aider.',
    help: 'Voici ce que je peux faire :\n• Consulter votre solde et vos dernières transactions.\n• Vous dire vos notifications et messages en attente.\n• Vérifier si vous devez payer votre Djangue ou si c\'est votre tour de recevoir.\n• Donner les actualités du jour et la météo de votre ville.\n• Chercher des hôpitaux, pharmacies et supermarchés.\n• Vous expliquer comment commander un taxi ou envoyer de l\'argent.\nÉcrivez-moi ou utilisez les boutons ci-dessous.',
    notificationsTitle: 'Vos notifications :\n{list}',
    noNotifications: 'Vous n\'avez aucune notification ni message en attente pour le moment.',
    djangueTitle: 'Vos djangues :\n{list}',
    noDjangue: 'Vous ne participez encore à aucun djangue. Vous pouvez en créer un ou en rejoindre un depuis Mi Djangue.',
    djangueOwe: 'Dans {name}, il vous manque la cotisation du tour actuel : {quota}. Vous pouvez la payer dans Mi Djangue.',
    djanguePaid: 'Dans {name}, vous avez déjà payé la cotisation de ce tour.',
    djangueMyTurn: 'Dans {name}, c\'est à vous de recevoir ce tour.',
    unknown: 'Je ne suis pas sûr de comprendre. Essayez : « mon solde », « dernières transactions », « actualités », « météo », « taxi » ou « hôpitaux ».',
    serviceError: 'Je n\'ai pas pu obtenir cette information. Réessayez dans quelques secondes.',
    movementTypes: { deposit: 'Rechargement', withdraw: 'Retrait', transfer: 'Transfert', transfer_sent: 'Envoi', transfer_received: 'Reçu', shopping_payment: 'Achat', payment: 'Paiement', refund: 'Remboursement', default: 'Mouvement' },
  },
  en: {
    emptyMessage: 'Write a message to Lia-25.',
    tooLong: 'The message is too long (2000 characters maximum).',
    greeting: 'Hi! I am Lia-25, your EGCHAT assistant. I can tell you your pending notifications and messages, whether you need to pay your Djangue, your balance and transactions, the news and weather, and guide you to request a taxi or send money. What do you need?',
    balance: 'Your current balance is *{balance}*.',
    balanceWithMovements: 'Your current balance is *{balance}*.\n\nYour latest transactions:\n{movements}',
    movementsTitle: 'Your latest transactions:\n{movements}',
    noMovements: 'You have no transactions yet. You can top up from Wallet → Top up.',
    newsTitle: 'Today\'s news:\n{list}',
    noNews: 'There is no news published right now. Check again later.',
    weather: 'Weather in {city}: {temp} °C, {desc}. Wind {wind} km/h, humidity {humidity}%.',
    weatherError: 'I could not check the weather right now. Please try again in a minute.',
    healthTitle: 'Health centers and pharmacies:\n{list}',
    marketTitle: 'Available supermarkets:\n{list}',
    atmTitle: 'Available ATMs:\n{list}',
    ratesTitle: 'Exchange rates:\n{list}',
    card: 'You can view and manage your cards in Wallet → Cards. If a card is lost, block it there right away.',
    bank: 'Check available banks and ATMs in Services → Banks.',
    closed: 'closed',
    taxi: 'To request a taxi, open MiTaxi, set your pickup and destination, then confirm.\nFares: moto 800 XAF, basic 1 500 XAF, premium 3 500 XAF.',
    transfer: 'To send money go to Wallet → Send; to withdraw, Wallet → Withdraw; to top up, Wallet → Top up.\nI can tell you your balance first.',
    thanks: 'You are welcome! I am here to help.',
    help: 'Here is what I can do:\n• Check your balance and latest transactions.\n• Tell you your pending notifications and messages.\n• Check if you need to pay your Djangue or if it is your turn to receive.\n• Give you today\'s news and your city\'s weather.\n• Find hospitals, pharmacies and supermarkets.\n• Explain how to request a taxi or send money.\nType it or use the buttons below.',
    notificationsTitle: 'Your notifications:\n{list}',
    noNotifications: 'You have no pending notifications or messages right now.',
    djangueTitle: 'Your djangues:\n{list}',
    noDjangue: 'You are not in any djangue yet. You can create or join one from Mi Djangue.',
    djangueOwe: 'In {name} your contribution for the current turn is still due: {quota}. You can pay it in Mi Djangue.',
    djanguePaid: 'In {name} you already paid this turn\'s contribution.',
    djangueMyTurn: 'In {name} it is your turn to receive.',
    unknown: 'I am not sure I understood. Try: "my balance", "latest transactions", "news", "weather", "taxi" or "hospitals".',
    serviceError: 'I could not get that information right now. Please try again in a few seconds.',
    movementTypes: { deposit: 'Top-up', withdraw: 'Withdrawal', transfer: 'Transfer', transfer_sent: 'Sent', transfer_received: 'Received', shopping_payment: 'Purchase', payment: 'Payment', refund: 'Refund', default: 'Transaction' },
  },
  pt: {
    emptyMessage: 'Escreva uma mensagem para a Lia-25.',
    tooLong: 'A mensagem é demasiado longa (máximo 2000 caracteres).',
    greeting: 'Olá! Sou a Lia-25, a sua assistente EGCHAT. Posso dizer-lhe as suas notificações e mensagens pendentes, se tem de pagar o seu Djangue, o seu saldo e as suas transações, as notícias e o tempo, e orientá-lo para pedir um táxi ou enviar dinheiro. O que precisa?',
    balance: 'O seu saldo atual é *{balance}*.',
    balanceWithMovements: 'O seu saldo atual é *{balance}*.\n\nÚltimas transações:\n{movements}',
    movementsTitle: 'Últimas transações:\n{movements}',
    noMovements: 'Ainda não tem transações. Pode recarregar em Carteira → Recarregar.',
    newsTitle: 'Notícias de hoje:\n{list}',
    noNews: 'Não há notícias publicadas neste momento. Volte mais tarde.',
    weather: 'Tempo em {city}: {temp} °C, {desc}. Vento de {wind} km/h e humidade de {humidity} %.',
    weatherError: 'Não consegui consultar o tempo agora. Tente novamente num minuto.',
    healthTitle: 'Centros de saúde e farmácias:\n{list}',
    marketTitle: 'Supermercados disponíveis:\n{list}',
    atmTitle: 'Caixas automáticos disponíveis:\n{list}',
    ratesTitle: 'Taxas de câmbio:\n{list}',
    card: 'Pode ver e gerir os seus cartões em Carteira → Cartões. Se perder um cartão, bloqueie-o de imediato nesse ecrã.',
    bank: 'Consulte os bancos e caixas automáticos disponíveis em Serviços → Bancos.',
    closed: 'fechado',
    taxi: 'Para pedir um táxi, abra o MiTaxi, indique a origem e o destino e confirme.\nTarifas: moto 800 XAF, básico 1 500 XAF, premium 3 500 XAF.',
    transfer: 'Para enviar dinheiro vá a Carteira → Enviar; para levantar, Carteira → Levantar; para recarregar, Carteira → Recarregar.\nPosso dizer-lhe primeiro o seu saldo.',
    thanks: 'De nada! Estou aqui para ajudar.',
    help: 'Posso fazer isto por si:\n• Consultar o saldo e as últimas transações.\n• Dizer-lhe as suas notificações e mensagens pendentes.\n• Verificar se tem de pagar o seu Djangue ou se é a sua vez de receber.\n• Dar as notícias do dia e o tempo da sua cidade.\n• Procurar hospitais, farmácias e supermercados.\n• Explicar como pedir um táxi ou enviar dinheiro.\nEscreva ou use os botões abaixo.',
    notificationsTitle: 'As suas notificações:\n{list}',
    noNotifications: 'Não tem notificações nem mensagens pendentes de momento.',
    djangueTitle: 'Os seus djangues:\n{list}',
    noDjangue: 'Ainda não participa em nenhum djangue. Pode criar ou entrar num em Mi Djangue.',
    djangueOwe: 'No {name} falta a sua quota do turno atual: {quota}. Pode pagá-la em Mi Djangue.',
    djanguePaid: 'No {name} já pagou a quota deste turno.',
    djangueMyTurn: 'No {name} é a sua vez de receber.',
    unknown: 'Não tenho a certeza de ter entendido. Tente: "o meu saldo", "últimas transações", "notícias", "tempo", "táxi" ou "hospitais".',
    serviceError: 'Não consegui obter essa informação agora. Tente novamente em alguns segundos.',
    movementTypes: { deposit: 'Recarregamento', withdraw: 'Levantamento', transfer: 'Transferência', transfer_sent: 'Envio', transfer_received: 'Recebido', shopping_payment: 'Compra', payment: 'Pagamento', refund: 'Reembolso', default: 'Movimento' },
  },
};

const LIA_INTENTS = [
  ['djangue', ['djangue', 'djangues', 'tanda', 'tandas', 'cuota', 'cuotas', 'ahorro rotativo', 'cote', 'cotisation', 'tontine', 'poupanca', 'poupança']],
  ['notifications', ['notificacion', 'notificaciones', 'notification', 'notifications', 'aviso', 'avisos', 'pendiente', 'pendientes', 'mensajes nuevos', 'mensaje nuevo', 'nao lidas', 'nao lidos', 'não lidas', 'não lidos', 'non lus', 'non lues', 'unread']],
  ['activity', ['actividad', 'movimiento', 'movimientos', 'transaccion', 'transacciones', 'resumen', 'historico', 'extracto', 'transaction', 'transactions', 'activity', 'summary', 'historique', 'activite', 'atividade', 'movimentos', 'resumo']],
  ['balance', ['saldo', 'balance', 'solde', 'sald', 'dinero', 'cuanto tengo', 'cuanto dinero', 'tengo en la cuenta', 'cartera', 'wallet', 'argent', 'money', 'dinheiro', 'carteira', 'portefeuille', 'efectivo', 'cash']],
  ['news', ['noticia', 'noticias', 'actualidad', 'actualite', 'actualites', 'news', 'novidade', 'novidades', 'partido', 'futbol', 'deporte', 'deportes', 'match', 'football', 'esporte', 'esportes', 'jogo']],
  ['weather', ['tiempo', 'clima', 'meteo', 'weather', 'tempo', 'temps', 'lluvia', 'chuva', 'pluie', 'rain', 'temperatura', 'climat']],
  ['health', ['salud', 'hospital', 'hospitales', 'hopital', 'hopitaux', 'medico', 'doctor', 'clinica', 'urgencias', 'farmacia', 'farmacias', 'sante', 'health', 'saude', 'pharmacie', 'pharmacy', 'medical']],
  ['markets', ['supermercado', 'supermercados', 'supermarche', 'mercado', 'mercados', 'market', 'compra', 'compras', 'achat', 'shopping', 'supermarket']],
  ['atm', ['cajero', 'cajeros', 'atm', 'distributeur', 'cash machine', 'caixa automatico', 'multibanco']],
  ['rates', ['tipo de cambio', 'cotizacion', 'exchange rate', 'exchange', 'taux de change', 'taxa de cambio', 'divisa', 'divisas', 'currency', 'moeda estrangeira', 'moneda', 'cuanto esta', 'cuanto estan', 'cuanto vale', 'cuanto valen', 'how much is', 'how much are', 'a cuanto', 'conversion', 'euro', 'dolar', 'dollar', 'pound', 'libra', 'franco', 'yuan', 'xaf', 'xof', 'fcfa']],
  ['card', ['tarjeta', 'tarjetas', 'card', 'cards', 'carte', 'cartes', 'cartao', 'cartoes']],
  ['banks', ['banco', 'bancos', 'bank', 'banque', 'sucursal', 'agence']],
  ['taxi', ['taxi', 'carrera', 'ride', 'course', 'corrida']],
  ['transfer', ['transferir', 'transferencia', 'enviar', 'envoyer', 'send', 'transfer', 'recargar', 'recargo', 'recharger', 'recarregar', 'recharge', 'recarga', 'top up', 'topup', 'deposito', 'deposit', 'retirar', 'retrait', 'withdraw', 'pagar', 'payer', 'pay', 'pagamento', 'factura', 'facture', 'invoice', 'fatura']],
  ['thanks', ['gracias', 'merci', 'thanks', 'thank', 'obrigado', 'obrigada', 'valeu']],
  ['help', ['ayuda', 'ayudame', 'help', 'aide', 'ajuda', 'capacidades', 'funciones', 'que puedes', 'que sabes', 'quien eres', 'que eres', 'como te llamas', 'tu nombre', 'who are you', 'what can you', 'what do you do', 'how can you help', 'qui es tu', 'qui etes vous', 'quem es tu', 'quem e voce', 'que podes fazer', 'o que voce faz', 'o que fazes']],
  ['greeting', ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'bonjour', 'salut', 'hello', 'hey', 'ola', 'bom dia', 'boa tarde', 'boa noite']],
];

// Frases completas que deben ganar a las palabras sueltas de otras intenciones
// ("enviar dinero" contiene "dinero", que por sí sola es de saldo).
const LIA_PRIORITY_INTENTS = [
  ['transfer', ['send money', 'i want to send', 'i need to send', 'transfer money', 'withdraw money', 'enviar dinero', 'enviar plata', 'enviar dinheiro', 'hacer una transferencia', 'transferir dinero', 'retirar dinero', 'retirar dinheiro', 'levantar dinheiro', 'envoyer de l argent', 'faire un virement', 'je veux envoyer']],
];

// Operaciones sencillas que se responden localmente, sin pasar por la IA:
// así una pregunta matemática nunca arrastra el tema anterior.
const LIA_MATH_NUMBERS = {
  cero: 0, zero: 0,
  un: 1, uno: 1, una: 1, une: 1, one: 1, um: 1, uma: 1,
  dos: 2, deux: 2, dois: 2, duas: 2, two: 2,
  tres: 3, trois: 3, three: 3,
  cuatro: 4, quatre: 4, quatro: 4, four: 4,
  cinco: 5, cinq: 5, five: 5,
  seis: 6, six: 6,
  siete: 7, sept: 7, seven: 7, sete: 7,
  ocho: 8, huit: 8, eight: 8, oito: 8,
  nueve: 9, neuf: 9, nine: 9, nove: 9,
  diez: 10, dix: 10, ten: 10, dez: 10,
  once: 11, onze: 11, eleven: 11,
  doce: 12, douze: 12, twelve: 12, doze: 12,
  trece: 13, treize: 13, thirteen: 13, treze: 13,
  catorce: 14, quatorze: 14, fourteen: 14, catorze: 14,
  quince: 15, quinze: 15, fifteen: 15,
  dieciseis: 16, seize: 16, sixteen: 16, dezesseis: 16,
  diecisiete: 17, dixsept: 17, seventeen: 17, dezessete: 17,
  dieciocho: 18, dixhuit: 18, eighteen: 18, dezoito: 18,
  diecinueve: 19, dixneuf: 19, nineteen: 19, dezenove: 19,
  veinte: 20, vingt: 20, twenty: 20, vinte: 20,
  veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29,
  treinta: 30, trente: 30, thirty: 30, trinta: 30,
  cuarenta: 40, quarante: 40, forty: 40, quarenta: 40,
  cincuenta: 50, cinquante: 50, fifty: 50, cinquenta: 50,
  sesenta: 60, soixante: 60, sixty: 60, sessenta: 60,
  setenta: 70, seventy: 70,
  ochenta: 80, eighty: 80, oitenta: 80,
  noventa: 90, ninety: 90,
  cien: 100, ciento: 100, cent: 100, cem: 100, cento: 100, hundred: 100,
  mil: 1000, mille: 1000, thousand: 1000,
};

const LIA_MATH_COPY = {
  es: { divideByZero: 'No se puede dividir entre cero.' },
  fr: { divideByZero: 'La division par zéro est impossible.' },
  en: { divideByZero: 'Division by zero is not possible.' },
  pt: { divideByZero: 'Não é possível dividir por zero.' },
};

const liaDetectMath = (message) => {
  const raw = liaNorm(message).replace(/[^a-z0-9+\-*/()., x×]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  let expr = ` ${raw} `;
  Object.entries(LIA_MATH_NUMBERS)
    .sort((a, b) => b[0].length - a[0].length)
    .forEach(([word, value]) => {
      expr = expr.replace(new RegExp(`\\b${word}\\b`, 'g'), ` ${value} `);
    });
  expr = expr
    .replace(/\b(plus|mas|mais|sumado a|additionne|ajouter)\b/g, ' + ')
    .replace(/\b(menos|moins|minus|sustraido|retirer)\b/g, ' - ')
    .replace(/\b(por|fois|times|multiplie|vezes)\b/g, ' * ')
    .replace(/\b(entre|divise|divided by|dividido por|dividir)\b/g, ' / ')
    .replace(/(\d)\s*[x×]\s*(\d)/g, '$1 * $2')
    .replace(/(\d),(\d)/g, '$1.$2');
  const match = expr.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const asksResult = /(cuanto|cuanta|combien|how much|how many|quanto|quantos|resultado|resuelve|resolve|calcula|calcule|calculate|solve|compute)/.test(raw);
  if (!asksResult && !/^\d/.test(raw)) return null;
  return { a: Number(match[1]), op: match[2], b: Number(match[3]) };
};

const liaMathReply = (message, lang) => {
  const parsed = liaDetectMath(message);
  if (!parsed) return null;
  const { a, op, b } = parsed;
  if (op === '/' && b === 0) return LIA_MATH_COPY[lang].divideByZero;
  const result = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
  const rounded = Math.round(result * 1e6) / 1e6;
  const symbol = op === '*' ? '×' : op === '/' ? '÷' : op;
  const fmt = (value) => (lang === 'en' ? String(value) : String(value).replace('.', ','));
  return `${fmt(a)} ${symbol} ${fmt(b)} = ${fmt(rounded)}`;
};

const liaDetectIntent = (message) => {
  if (liaDetectMath(message)) return 'math';
  const norm = ` ${liaNorm(message).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  for (const [intent, phrases] of LIA_PRIORITY_INTENTS) {
    if (phrases.some((phrase) => norm.includes(phrase))) return intent;
  }
  for (const [intent, words] of LIA_INTENTS) {
    if (words.some((word) => (word.length > 3 ? norm.includes(word) : norm.includes(` ${word} `)))) {
      return intent;
    }
  }
  return 'unknown';
};

const LIA_WEATHER_DESC = {
  clear: { es: 'cielo despejado', fr: 'ciel dégagé', en: 'clear sky', pt: 'céu limpo' },
  partly: { es: 'parcialmente nublado', fr: 'partiellement nuageux', en: 'partly cloudy', pt: 'parcialmente nublado' },
  cloudy: { es: 'nublado', fr: 'nuageux', en: 'cloudy', pt: 'nublado' },
  fog: { es: 'niebla', fr: 'brouillard', en: 'fog', pt: 'nevoeiro' },
  drizzle: { es: 'llovizna', fr: 'bruine', en: 'drizzle', pt: 'chuvisco' },
  rain: { es: 'lluvia', fr: 'pluie', en: 'rain', pt: 'chuva' },
  snow: { es: 'nieve', fr: 'neige', en: 'snow', pt: 'neve' },
  showers: { es: 'chubascos', fr: 'averses', en: 'showers', pt: 'aguaceiros' },
  storm: { es: 'tormenta', fr: 'orage', en: 'thunderstorm', pt: 'trovoada' },
};

const liaWeatherKey = (code) => {
  const c = Number(code);
  if (c === 0) return 'clear';
  if (c <= 2) return 'partly';
  if (c === 3) return 'cloudy';
  if (c <= 48) return 'fog';
  if (c <= 55) return 'drizzle';
  if (c <= 65) return 'rain';
  if (c <= 77) return 'snow';
  if (c <= 82) return 'showers';
  return 'storm';
};

const LIA_CITIES = [
  { name: 'Malabo', lat: 3.75, lon: 8.78 },
  { name: 'Bata', lat: 1.86, lon: 9.77 },
  { name: 'Mongomo', lat: 1.63, lon: 11.31 },
  { name: 'Ebebiyín', lat: 2.15, lon: 11.32 },
  { name: 'Annobón', lat: -1.44, lon: 5.63 },
];

const LIA_ATMS = [
  { bank: 'BANGE', addr: 'Av. de la Independencia 12, Malabo', fee: '500 XAF' },
  { bank: 'CCEI Bank', addr: 'Centro Comercial Malabo', fee: '0 XAF' },
  { bank: 'BGFI Bank', addr: 'Calle Rey Malabo 45', fee: '750 XAF' },
  { bank: 'Ecobank', addr: 'Aeropuerto Internacional de Malabo', fee: '1 000 XAF' },
];

const LIA_RATES = { EUR: 0.001524, USD: 0.001648, GBP: 0.001302, CHF: 0.001489, CNY: 0.011920 };

const liaPickCity = (message, city) => {
  const norm = liaNorm(message);
  const fromMessage = LIA_CITIES.find((item) => norm.includes(liaNorm(item.name)));
  if (fromMessage) return fromMessage;
  const fromProfile = city && LIA_CITIES.find((item) => liaNorm(item.name) === liaNorm(city));
  return fromProfile || LIA_CITIES[0];
};

const liaProvider = () => {
  if (process.env.GROQ_API_KEY) {
    return {
      name: 'groq',
      key: process.env.GROQ_API_KEY,
      base: 'https://api.groq.com/openai/v1',
      chatModel: process.env.LIA_CHAT_MODEL || 'openai/gpt-oss-120b',
      sttModel: process.env.LIA_STT_MODEL || 'whisper-large-v3-turbo',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: 'openai',
      key: process.env.OPENAI_API_KEY,
      base: 'https://api.openai.com/v1',
      chatModel: process.env.LIA_CHAT_MODEL || 'gpt-4o-mini',
      sttModel: 'whisper-1',
    };
  }
  return null;
};

const liaGetWallet = async (userId) => {
  try {
    const { data } = await supabase.from('wallets').select('balance, currency').eq('user_id', userId).maybeSingle();
    return { balance: Number(data?.balance || 0), currency: data?.currency || 'XAF' };
  } catch (e) {
    console.warn('LIA wallet error:', e?.message || e);
    return { balance: 0, currency: 'XAF' };
  }
};

const liaGetTransactions = async (userId, limit) => {
  try {
    const { data } = await supabase
      .from('transactions')
      .select('type, amount, description, reference, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('LIA transactions error:', e?.message || e);
    return [];
  }
};

const liaExpenseSummary = async (userId, days) => {
  const windowMs = days * 86400000;
  const now = Date.now();
  const { data } = await supabase
    .from('transactions')
    .select('type, amount, description, created_at')
    .eq('user_id', userId)
    .gte('created_at', new Date(now - 2 * windowMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(2000);
  const rows = Array.isArray(data) ? data : [];
  const inTypes = ['transfer_received', 'deposit', 'refund'];
  const outTypes = ['transfer_sent', 'withdraw', 'payment'];
  const inWindow = (from, to) => rows.filter((row) => {
    const at = new Date(row.created_at).getTime();
    return !Number.isNaN(at) && at >= from && at < to;
  });
  const current = inWindow(now - windowMs, now + 1);
  const previous = inWindow(now - 2 * windowMs, now - windowMs);
  const sum = (list, types) => list.filter((row) => types.includes(row.type)).reduce((acc, row) => acc + Number(row.amount || 0), 0);
  const byType = {};
  current.forEach((row) => {
    const key = String(row.type || 'otros');
    byType[key] = byType[key] || { total: 0, operaciones: 0 };
    byType[key].total += Number(row.amount || 0);
    byType[key].operaciones += 1;
  });
  const entradas = sum(current, inTypes);
  const salidas = sum(current, outTypes);
  const salidasPrevias = sum(previous, outTypes);
  const porConcepto = {};
  current
    .filter((row) => outTypes.includes(row.type))
    .forEach((row) => {
      const key = String(row.description || 'sin descripción').slice(0, 60);
      porConcepto[key] = (porConcepto[key] || 0) + Number(row.amount || 0);
    });
  return {
    periodo_dias: days,
    entradas,
    salidas,
    neto: entradas - salidas,
    operaciones: current.length,
    por_tipo: byType,
    top_conceptos: Object.entries(porConcepto)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([concepto, total]) => ({ concepto, total })),
    variacion_salidas_pct: salidasPrevias > 0 ? Math.round(((salidas - salidasPrevias) / salidasPrevias) * 1000) / 10 : null,
  };
};

const liaContactSearch = async (userId, term) => {
  const clean = String(term || '').trim().replace(/[^A-Za-zÁ-ÿ0-9 ]+/g, ' ').trim();
  if (clean.length < 2) return [];
  const { data: links } = await supabase
    .from('contacts')
    .select('contact_user_id')
    .eq('user_id', userId)
    .limit(500);
  const ids = (links || []).map((row) => row.contact_user_id).filter(Boolean);
  if (!ids.length) return [];
  const { data } = await supabase
    .from('users')
    .select('id, full_name, phone')
    .in('id', ids)
    .or(`full_name.ilike.%${clean}%,phone.ilike.%${clean}%`)
    .limit(5);
  return Array.isArray(data) ? data : [];
};

const liaMovementLine = (tx, lang) => {
  const types = LIA_COPY[lang].movementTypes;
  const label = types[tx?.type] || types.default;
  const date = tx?.created_at ? new Date(tx.created_at) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? ` · ${date.getDate()}/${date.getMonth() + 1}`
    : '';
  return `• ${label}: ${liaMoney(tx?.amount)}${when}`;
};

const liaWeatherData = async (cityName, lang) => {
  const target = (cityName && LIA_CITIES.find((item) => liaNorm(item.name) === liaNorm(cityName))) || LIA_CITIES[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${target.lat}&longitude=${target.lon}`
      + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=Africa%2FMalabo';
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`weather ${response.status}`);
    const current = (await response.json())?.current || {};
    if (typeof current.temperature_2m !== 'number') throw new Error('weather empty');
    return {
      ciudad: target.name,
      temperatura_c: Math.round(current.temperature_2m),
      descripcion: LIA_WEATHER_DESC[liaWeatherKey(current.weather_code)][lang],
      viento_kmh: Math.round(Number(current.wind_speed_10m) || 0),
      humedad_pct: Math.round(Number(current.relative_humidity_2m) || 0),
    };
  } finally {
    clearTimeout(timer);
  }
};

const liaWeatherReply = async (message, lang, city) => {
  const copy = LIA_COPY[lang];
  const target = liaPickCity(message, city);
  try {
    const data = await liaWeatherData(target.name, lang);
    return liaFill(copy.weather, {
      city: data.ciudad,
      temp: data.temperatura_c,
      desc: data.descripcion,
      wind: data.viento_kmh,
      humidity: data.humedad_pct,
    });
  } catch (e) {
    console.warn('LIA weather error:', e?.message || e);
    return copy.weatherError;
  }
};

// El ancla de idioma va en el propio idioma destino: un system prompt entero
// en español empujaba al modelo a responder en español (o a saltar al
// portugués) aunque la app estuviera en francés o inglés.
const LIA_LANG_PIN = {
  es: 'IDIOMA OBLIGATORIO: español. Responde SIEMPRE en español, aunque el usuario escriba en otro idioma o el historial esté en otra lengua. Nunca cambies de idioma a mitad de la conversación.',
  fr: 'LANGUE OBLIGATOIRE : français. Réponds TOUJOURS en français, même si l\'utilisateur écrit dans une autre langue ou si l\'historique est dans une autre langue. Ne change jamais de langue en cours de conversation.',
  en: 'MANDATORY LANGUAGE: English. ALWAYS reply in English, even if the user writes in another language or the history is in another language. Never switch languages mid-conversation.',
  pt: 'IDIOMA OBRIGATÓRIO: português. Responde SEMPRE em português, mesmo que o utilizador escreva noutro idioma ou o histórico esteja noutra língua. Nunca mudes de idioma a meio da conversa.',
};

const liaBuildSystem = (lang, profile, wallet) => [
  LIA_LANG_PIN[lang] || LIA_LANG_PIN.es,
  `Eres Lia-25, la asistente de EGCHAT, una superapp de Guinea Ecuatorial: dinero móvil en XAF, chat, Mi Djangue (tandas de ahorro rotativo), MiTaxi, Salud, Supermercados, Noticias, Seguros y zona CEMAC.`,
  `Eres internacional: entiendes mensajes escritos en cualquier idioma y puedes hablar de cualquier país del mundo; para divisas extranjeras usa convertir_moneda. Pero tu respuesta sale siempre en el idioma obligatorio de arriba.`,
  `Forma de trabajar:`,
  `1. Antes de dar cualquier dato de la cuenta, precios, noticias o lugares, consulta la herramienta correspondiente y responde con lo que devuelva. No inventes cifras, direcciones, teléfonos, horarios ni comisiones.`,
  `2. Si falta un dato imprescindible para resolver o ejecutar (importe, destinatario, ciudad), haz una sola pregunta corta con las opciones concretas.`,
  `3. Si piden varias cosas, resuélvelas en orden. Si la petición es ambigua, interpreta la opción más probable dentro de EGCHAT y dilo en una frase.`,
  `4. Para enviar dinero: si el destinatario es un nombre, resuélvelo antes con buscar_destinatario y, si hay varios iguales, pregunta cuál; luego usa preparar_transferencia, muestra el resumen y pide confirmación con el PIN en la app. Nunca afirmes que ya enviaste, pediste o compraste algo.`,
  `5. Para abrir una pantalla usa abrir_pantalla y dile al usuario que la tiene lista; no digas que ya está abierta.`,
  `6. Para «en qué he gastado», «cuánto entra/sale» o comparar periodos usa analizar_gastos. Para «cuánto puedo enviar/retirar hoy» usa consultar_limites. Para cualquier conversión usa convertir_moneda: no hagas la cuenta de memoria.`,
  `7. Para «qué tengo pendiente», «mis notificaciones» o «tengo mensajes nuevos» usa consultar_notificaciones. Para «debo pagar el djangue», «mi tanda» o «mi cuota» usa consultar_djangue y di con claridad si debe pagar, cuánto y en qué tanda; si ya pagó o le toca cobrar, dilo también.`,
  `8. Responde solo a la última petición del usuario; si el tema cambió, ignora el anterior por completo.`,
  `9. Sé precisa y breve (máximo 90 palabras salvo que pidan detalle). No expliques tu proceso, no menciones herramientas, JSON, errores técnicos ni el modelo.`,
  `Datos reales del usuario (no los inventes ni los cambies): saldo ${liaMoney(wallet.balance)}; nombre ${profile?.full_name || 'no indicado'}; ciudad ${profile?.city || 'no indicada'}.`,
  `Datos de referencia de la app: tarifas MiTaxi moto 800 XAF, básico 1 500 XAF, premium 3 500 XAF (tarifa plana por viaje, no por km).`,
  `Pantallas de la app: Cartera (saldo, recargar, retirar, enviar), Mi Djangue, MiTaxi, Salud, Supermercados, Noticias, Seguros, CEMAC, Bancos, Tarjetas.`,
  `Responde SIEMPRE en ${LIA_LANG_NAMES[lang] || 'español'}, de forma clara y amable, con negritas solo cuando aporten.`,
  `Si no puedes resolver algo, dilo en una frase y ofrece la pantalla exacta donde se hace.`,
].join('\n');

// ── Candado de idioma ───────────────────────────────────────────────
// El modelo a veces contesta en portugués cuando la app está en español.
// Se puntúa la lengua real de la respuesta y, si no coincide con la pedida,
// se reescribe una sola vez en el idioma correcto antes de entregarla.
const LIA_LANG_STOPWORDS = {
  es: ['el', 'la', 'los', 'las', 'tu', 'tus', 'puedes', 'gracias', 'hola', 'qué', 'cómo', 'está', 'estás', 'esto', 'ahora', 'tienes', 'tiene', 'aquí', 'todavía', 'consulta', 'puedo', 'quieres', 'según'],
  fr: ['le', 'les', 'votre', 'vos', 'vous', 'est', 'pour', 'avec', 'bonjour', 'merci', 'des', 'une', 'nous', 'êtes', 'votre', 'solde', 'français', 'maintenant', 'peux', 'veux', 'consultez'],
  en: ['the', 'your', 'you', 'is', 'are', 'balance', 'thanks', 'hello', 'please', 'what', 'how', 'can', 'with', 'and', 'have', 'this', 'now', 'check', 'want', 'english'],
  pt: ['você', 'seu', 'sua', 'seus', 'suas', 'olá', 'obrigado', 'obrigada', 'não', 'também', 'então', 'está', 'isto', 'agora', 'pode', 'posso', 'consulta', 'português', 'ainda', 'aqui'],
};
const LIA_LANG_MARKS = {
  es: /[ñ¿¡]/g,
  fr: /[èêëùûœç]/g,
  en: null,
  pt: /[ãõ]/g,
};

const liaLangScores = (text) => {
  const s = ` ${String(text || '').toLowerCase().replace(/[.,;:!?"'(){}\[\]…—–*]/g, ' ').replace(/\s+/g, ' ')} `;
  const scores = {};
  for (const lang of LIA_LANGS) {
    let n = LIA_LANG_STOPWORDS[lang].reduce((acc, w) => (s.includes(` ${w} `) ? acc + 1 : acc), 0);
    const marks = LIA_LANG_MARKS[lang];
    if (marks) n += (s.match(marks) || []).length * 2;
    scores[lang] = n;
  }
  return scores;
};

const liaEnsureLang = async (text, lang) => {
  if (!text || text.length < 60) return text;
  const scores = liaLangScores(text);
  const best = LIA_LANGS.slice().sort((a, b) => scores[b] - scores[a])[0];
  if (best === lang || scores[best] < 3 || scores[best] <= (scores[lang] || 0) + 1) return text;
  const provider = liaProvider();
  if (!provider) return text;
  const targetNames = { es: 'Spanish', fr: 'French', en: 'English', pt: 'European Portuguese' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${provider.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
      body: JSON.stringify({
        model: provider.chatModel,
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: 'system', content: `You are a translation editor. Rewrite the assistant text into ${targetNames[lang] || 'Spanish'}. Keep EXACTLY the same data, numbers, names, currency amounts and **bold** formatting. Do not add, remove or comment anything. Output only the rewritten text.` },
          { role: 'user', content: text.slice(0, 3000) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return text;
    const rewritten = (await response.json())?.choices?.[0]?.message?.content;
    return typeof rewritten === 'string' && rewritten.trim() ? rewritten.trim() : text;
  } catch (e) {
    console.warn('LIA language guard failed:', e?.message || e);
    return text;
  } finally {
    clearTimeout(timer);
  }
};

// ── Datos de la app para LIA ────────────────────────────────────────
// Mensajes sin leer y avisos de djangue: lo mismo que ve la pantalla de
// notificaciones, para que LIA pueda decir qué tiene pendiente el usuario.
const liaGetNotifications = async (userId, limit = 8) => {
  const out = [];
  try {
    const { data: parts } = await supabase.from('chat_participants').select('chat_id').eq('user_id', userId);
    const chatIds = (parts || []).map((p) => p.chat_id);
    if (chatIds.length) {
      const { data: msgs } = await supabase.from('messages')
        .select('id, text, chat_id, sender_id, created_at')
        .in('chat_id', chatIds)
        .neq('sender_id', userId)
        .eq('status', 'sent')
        .order('created_at', { ascending: false })
        .limit(limit);
      const senderIds = [...new Set((msgs || []).map((m) => m.sender_id).filter(Boolean))];
      const { data: senders } = senderIds.length
        ? await supabase.from('users').select('id, full_name').in('id', senderIds)
        : { data: [] };
      const byId = Object.fromEntries((senders || []).map((u) => [String(u.id), u.full_name]));
      (msgs || []).forEach((m) => out.push({
        tipo: 'mensaje',
        de: byId[String(m.sender_id)] || 'un contacto',
        texto: String(m.text || '').slice(0, 120),
        fecha: m.created_at,
      }));
    }
  } catch (e) {
    console.warn('LIA notifications messages error:', e?.message || e);
  }
  try {
    const { data: dj } = await supabase.from('djangue_notifications')
      .select('title, message, sent_at, type')
      .eq('user_id', userId)
      .eq('read', false)
      .order('sent_at', { ascending: false })
      .limit(limit);
    (dj || []).forEach((n) => out.push({
      tipo: 'djangue',
      de: n.title,
      texto: String(n.message || '').slice(0, 160),
      fecha: n.sent_at,
    }));
  } catch (e) {
    console.warn('LIA notifications djangue error:', e?.message || e);
  }
  out.sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
  return out.slice(0, limit);
};

// Estado de cada tanda del usuario: si ya pagó el turno actual, cuánto debe,
// si le toca cobrar y las multas pendientes.
const liaDjangueSummary = async (userId) => {
  const { data: filas, error } = await supabase.from('djangue_members')
    .select('group_id, turn_order, status')
    .eq('user_id', userId)
    .neq('status', 'removed');
  if (error) {
    return { error: djFaltaEsquema(error) ? 'El esquema de djangue no está en la base' : 'No se pudieron leer tus djangues' };
  }
  const ids = [...new Set((filas || []).map((f) => f.group_id))];
  if (!ids.length) return { djangues: [] };
  const [{ data: grupos }, { data: contribs }, { data: multas }] = await Promise.all([
    supabase.from('djangue_groups').select('*').in('id', ids),
    supabase.from('djangue_contributions').select('group_id,user_id,turn_number,status').in('group_id', ids),
    supabase.from('djangue_penalties').select('group_id,penalty_amount,status').eq('user_id', userId).in('group_id', ids),
  ]);
  const djangues = (grupos || []).map((g) => {
    const turno = Number(g.current_turn) || 1;
    const mia = (contribs || []).find((c) => c.group_id === g.id && c.user_id === userId && Number(c.turn_number) === turno);
    const pagada = !!mia && mia.status === 'paid';
    const justificada = !!mia && mia.status === 'justified';
    const esMiTurno = (filas || []).some((f) => f.group_id === g.id && Number(f.turn_order) === turno);
    const multa = (multas || [])
      .filter((p) => p.group_id === g.id && p.status !== 'paid')
      .reduce((s, p) => s + djNum(p.penalty_amount), 0);
    return {
      nombre: g.name,
      cuota: djNum(g.quota_amount),
      moneda: g.currency || 'XAF',
      frecuencia: g.frequency,
      estado: g.status || 'active',
      turno_actual: turno,
      mi_rol: g.owner_id === userId ? 'owner' : g.secretary_id === userId ? 'secretary' : 'member',
      es_mi_turno: esMiTurno,
      cuota_pagada: pagada,
      cuota_justificada: justificada,
      debo_pagar: !esMiTurno && !pagada && !justificada && (g.status || 'active') === 'active',
      multas_pendientes: roundAmount(multa),
      proxima_entrega: g.next_payout_at || null,
    };
  });
  return { djangues };
};

// ── Herramientas de LIA ─────────────────────────────────────────────
// Cada herramienta devuelve datos reales y el modelo decide cuál usar.
const LIA_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'consultar_saldo',
      description: 'Saldo actual y moneda del usuario.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_movimientos',
      description: 'Últimos movimientos de la cartera, del más reciente al más antiguo.',
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'integer', description: 'Cantidad de movimientos, entre 1 y 10.', minimum: 1, maximum: 10 },
          tipo: { type: 'string', description: 'Filtro opcional por tipo: deposit, withdraw, transfer_sent, transfer_received, payment, refund.' },
        },
        required: ['limite'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_noticias',
      description: 'Titulares de noticias del día, con fuente y categoría.',
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'integer', description: 'Cantidad de titulares, entre 1 y 6.' },
          categoria: { type: 'string', description: 'Categoría opcional: Política, Finanzas, Salud, Tecnología, Deportes.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_tiempo',
      description: 'Tiempo actual (temperatura, viento, humedad) en una ciudad de Guinea Ecuatorial.',
      parameters: {
        type: 'object',
        properties: {
          ciudad: { type: 'string', description: 'Malabo, Bata, Mongomo, Ebebiyín o Annobón.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_centros_salud',
      description: 'Hospitales y farmacias con ciudad y teléfono.',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['hospital', 'farmacia', 'todos'] },
          ciudad: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_supermercados',
      description: 'Supermercados disponibles con dirección, teléfono y si están abiertos.',
      parameters: {
        type: 'object',
        properties: { ciudad: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_cajeros',
      description: 'Cajeros automáticos con banco, dirección y comisión.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_tasas_cambio',
      description: 'Tipo de cambio de las divisas frente al XAF.',
      parameters: {
        type: 'object',
        properties: { moneda: { type: 'string', description: 'EUR, USD, GBP, CHF o CNY.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preparar_transferencia',
      description: 'Valida un envío de dinero y devuelve el resumen para que el usuario lo confirme con su PIN. No ejecuta el envío.',
      parameters: {
        type: 'object',
        properties: {
          monto: { type: 'number', description: 'Importe en XAF.' },
          destinatario: { type: 'string', description: 'Teléfono, nombre de usuario o nombre del destinatario.' },
          concepto: { type: 'string', description: 'Motivo opcional del envío.' },
        },
        required: ['monto', 'destinatario'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analizar_gastos',
      description: 'Resume el dinero que entró y salió en un periodo, con desglose por tipo, los conceptos más caros y la variación frente al periodo anterior.',
      parameters: {
        type: 'object',
        properties: {
          dias: { type: 'integer', description: 'Días a analizar, entre 1 y 180. Por defecto 30.', minimum: 1, maximum: 180 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_limites',
      description: 'Límites de la cartera, lo usado y lo que queda disponible hoy, más el estado de verificación de la cuenta.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_destinatario',
      description: 'Busca entre los contactos del usuario por nombre o teléfono para resolver un envío. Devuelve candidatos, nunca datos de desconocidos.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', description: 'Nombre o parte del nombre, o teléfono del contacto.' },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convertir_moneda',
      description: 'Convierte un importe entre XAF, XOF y las divisas soportadas con las tasas que usa la app.',
      parameters: {
        type: 'object',
        properties: {
          monto: { type: 'number', description: 'Importe a convertir.' },
          desde: { type: 'string', description: 'Moneda de origen: XAF, XOF, EUR, USD, GBP, CHF, CNY.' },
          a: { type: 'string', description: 'Moneda de destino: XAF, XOF, EUR, USD, GBP, CHF, CNY.' },
        },
        required: ['monto', 'desde', 'a'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'abrir_pantalla',
      description: 'Prepara la pantalla de la app que resuelve la petición (ej. cartera, enviar, recargar, taxi).',
      parameters: {
        type: 'object',
        properties: {
          pantalla: {
            type: 'string',
            enum: ['cartera', 'enviar', 'recargar', 'retirar', 'taxi', 'salud', 'supermercados', 'noticias', 'bancos', 'tarjetas', 'seguros', 'cemac', 'djangue'],
          },
        },
        required: ['pantalla'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_notificaciones',
      description: 'Notificaciones y mensajes sin leer del usuario: quién le escribió, qué dice y avisos de sus djangues.',
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'integer', description: 'Cantidad entre 1 y 10. Por defecto 8.', minimum: 1, maximum: 10 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_djangue',
      description: 'Tandas de ahorro (djangue) del usuario: cuota, si ya pagó el turno actual, si debe pagar, si le toca cobrar y multas pendientes.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const LIA_TOOL_NAMES = LIA_TOOL_DEFS.map((tool) => tool.function.name);

// El modelo a veces escribe un nombre de herramienta con una letra de más o de
// menos; si la diferencia es mínima se ejecuta la correcta en lugar de fallar.
const liaResolveToolName = (raw) => {
  const wanted = String(raw || '').trim().toLowerCase();
  if (!wanted) return raw;
  if (LIA_TOOL_NAMES.includes(wanted)) return wanted;
  const distance = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
    for (let y = 1; y <= a.length; y += 1) {
      const row = [y];
      for (let x = 1; x <= b.length; x += 1) {
        row[x] = Math.min(prev[x] + 1, row[x - 1] + 1, prev[x - 1] + (a[y - 1] === b[x - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[b.length];
  };
  let best = null;
  let bestScore = 3;
  LIA_TOOL_NAMES.forEach((candidate) => {
    const score = distance(wanted, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  });
  return best || raw;
};

const liaRunTool = async (name, args, userId, lang) => {
  const a = args && typeof args === 'object' ? args : {};
  const cityFilter = (item) => !a.ciudad || liaNorm(item.city || '') === liaNorm(a.ciudad);

  switch (name) {
    case 'consultar_saldo': {
      const wallet = await liaGetWallet(userId);
      return { saldo: wallet.balance, moneda: wallet.currency };
    }
    case 'consultar_movimientos': {
      const limite = Math.min(Math.max(Number(a.limite) || 5, 1), 10);
      let rows = await liaGetTransactions(userId, a.tipo ? 40 : limite);
      if (a.tipo) rows = rows.filter((tx) => String(tx.type) === String(a.tipo)).slice(0, limite);
      return rows.map((tx) => ({
        tipo: tx.type, importe: tx.amount, descripcion: tx.description || tx.reference || '',
        fecha: tx.created_at,
      }));
    }
    case 'consultar_noticias': {
      const limite = Math.min(Math.max(Number(a.limite) || 5, 1), 6);
      const items = NOTICIAS.filter((n) => !a.categoria || liaNorm(n.category) === liaNorm(a.categoria)).slice(0, limite);
      return items.map((n) => ({ titulo: n.title, fuente: n.source, categoria: n.category, hora: n.time }));
    }
    case 'consultar_tiempo':
      return liaWeatherData(a.ciudad || '', lang);
    case 'buscar_centros_salud': {
      const tipo = a.tipo || 'todos';
      const items = [];
      if (tipo !== 'farmacia') {
        HOSPITALES.filter(cityFilter).forEach((h) => items.push({
          tipo: 'hospital', nombre: h.name, ciudad: h.city, telefono: h.phone, urgencias: Boolean(h.emergency),
        }));
      }
      if (tipo !== 'hospital') {
        FARMACIAS.filter(cityFilter).forEach((f) => items.push({
          tipo: 'farmacia', nombre: f.name, ciudad: f.city, telefono: f.phone, abierto_24h: Boolean(f.open24h),
        }));
      }
      return items;
    }
    case 'buscar_supermercados':
      return SUPERMERCADOS.filter(cityFilter).map((s) => ({
        nombre: s.name, ciudad: s.city, direccion: s.address, telefono: s.phone, abierto: s.open !== false,
      }));
    case 'consultar_cajeros':
      return LIA_ATMS.map((item) => ({ banco: item.bank, direccion: item.addr, comision: item.fee }));
    case 'consultar_tasas_cambio': {
      const entries = Object.entries(LIA_RATES)
        .filter(([currency]) => !a.moneda || currency === String(a.moneda).toUpperCase());
      return entries.map(([currency, rate]) => ({ moneda: currency, xaf_por_unidad: Math.round(1 / rate) }));
    }
    case 'preparar_transferencia': {
      const amount = Math.round(Number(a.monto) || 0);
      if (!(amount > 0)) return { error: 'Importe inválido', falta: 'monto' };
      if (!a.destinatario) return { error: 'Falta el destinatario', falta: 'destinatario' };
      const to = String(a.destinatario).trim();
      const recipient = PLATFORM_MERCHANTS.has(to.toLowerCase()) ? null : await findUserByRef(to);
      const wallet = await liaGetWallet(userId);
      if (!recipient) {
        return { error: 'Destinatario no encontrado', destinatario_buscado: to, saldo: wallet.balance };
      }
      if (String(recipient.id) === String(userId)) return { error: 'No puedes enviarte dinero a ti mismo' };
      return {
        destinatario: recipient.full_name || recipient.phone || to,
        telefono: recipient.phone || null,
        importe: amount,
        concepto: a.concepto ? String(a.concepto).slice(0, 140) : null,
        saldo_actual: wallet.balance,
        saldo_despues: wallet.balance - amount,
        requiere_pin: true,
        ejecutado: false,
        siguiente_paso: 'El usuario confirma con el PIN en Cartera → Enviar.',
      };
    }
    case 'analizar_gastos': {
      const dias = Math.min(Math.max(Number(a.dias) || 30, 1), 180);
      return await liaExpenseSummary(userId, dias);
    }
    case 'consultar_limites': {
      const today = await sumTodayByType(userId);
      const { data: perfil } = await supabase
        .from('users')
        .select('wallet_kyc_status')
        .eq('id', userId)
        .maybeSingle();
      return {
        limites: WALLET_LIMITS,
        usado_hoy: today,
        disponible_hoy: {
          deposit: Math.max(0, WALLET_LIMITS.dailyDeposit - today.deposit),
          withdraw: Math.max(0, WALLET_LIMITS.dailyWithdraw - today.withdraw),
          transfer: Math.max(0, WALLET_LIMITS.dailyTransfer - today.transfer),
        },
        verificacion: perfil?.wallet_kyc_status || 'sin_datos',
      };
    }
    case 'buscar_destinatario': {
      const found = await liaContactSearch(userId, a.consulta);
      if (!found.length) {
        return { contactos: [], nota: 'Ningún contacto coincide. Pide el teléfono exacto o usa la agenda de la app.' };
      }
      return {
        contactos: found.map((row) => ({ nombre: row.full_name || 'sin nombre', telefono: row.phone })),
      };
    }
    case 'convertir_moneda': {
      const amount = Number(a.monto);
      const from = String(a.desde || 'XAF').toUpperCase();
      const to = String(a.a || 'XAF').toUpperCase();
      const supported = ['XAF', 'XOF', ...Object.keys(LIA_RATES)];
      if (!Number.isFinite(amount) || amount <= 0) return { error: 'Importe inválido' };
      if (!supported.includes(from) || !supported.includes(to)) {
        return { error: `Divisa no soportada. Disponibles: ${supported.join(', ')}` };
      }
      const toXaf = (code) => (code === 'XAF' || code === 'XOF' ? 1 : 1 / LIA_RATES[code]);
      const xafValue = amount * toXaf(from);
      const result = xafValue * (to === 'XAF' || to === 'XOF' ? 1 : LIA_RATES[to]);
      const decimals = to === 'XAF' || to === 'XOF' ? 0 : 2;
      return {
        desde: from,
        monto_desde: amount,
        a: to,
        monto_a: Number(result.toFixed(decimals)),
        tasa: `1 ${from} = ${(toXaf(from) * (to === 'XAF' || to === 'XOF' ? 1 : LIA_RATES[to])).toFixed(decimals)} ${to}`,
      };
    }
    case 'abrir_pantalla':
      return { pantalla: a.pantalla, abrir_en_app: true, ejecutado: false };
    case 'consultar_notificaciones': {
      const limite = Math.min(Math.max(Number(a.limite) || 8, 1), 10);
      const items = await liaGetNotifications(userId, limite);
      return { total: items.length, notificaciones: items };
    }
    case 'consultar_djangue':
      return await liaDjangueSummary(userId);
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
};

const LIA_AGENT_ROUNDS = 4;

const liaAgent = async ({ lang, message, history, userId, profile, wallet }) => {
  const provider = liaProvider();
  if (!provider) return null;
  const system = liaBuildSystem(lang, profile, wallet);
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .slice(-6)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 600) }));
  const messages = [{ role: 'system', content: system }, ...safeHistory, { role: 'user', content: message.slice(0, 1000) }];
  const used = [];
  let nav = null;
  let transfer = null;
  let lastStatus = 0;
  let toolGlitch = false;

  const call = async (withTools) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
        body: JSON.stringify({
          model: provider.chatModel,
          temperature: 0.2,
          max_tokens: 700,
          messages,
          ...(withTools ? { tools: LIA_TOOL_DEFS, tool_choice: 'auto' } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastStatus = response.status;
        const body = (await response.text().catch(() => '')) || '';
        // Groq anula toda la respuesta si el modelo escribe mal un nombre de herramienta.
        toolGlitch = withTools && body.includes('tool_use_failed');
        console.warn('LIA agent error:', provider.name, response.status, body.slice(0, 200));
        return null;
      }
      return (await response.json())?.choices?.[0]?.message || null;
    } catch (e) {
      console.warn('LIA agent exception:', e?.message || e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  for (let round = 0; round < LIA_AGENT_ROUNDS; round += 1) {
    toolGlitch = false;
    let reply = await call(true);
    if (!reply && toolGlitch) reply = await call(true);
    if (!reply) {
      // Solo se reintenta sin herramientas si el proveedor las rechazó de forma explícita.
      const toolsRejected = lastStatus >= 400 && lastStatus < 500 && lastStatus !== 429;
      if (toolsRejected) {
        const plain = await call(false);
        const plainText = typeof plain?.content === 'string' ? plain.content.trim() : '';
        return plainText ? { text: plainText, used, nav, transfer } : null;
      }
      return null;
    }
    const toolCalls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
    if (!toolCalls.length) {
      const text = typeof reply.content === 'string' ? reply.content.trim() : '';
      return text ? { text, used, nav, transfer } : null;
    }
    messages.push({ role: 'assistant', content: reply.content || '', tool_calls: toolCalls });
    for (const toolCall of toolCalls) {
      const name = liaResolveToolName(toolCall?.function?.name);
      let args = {};
      try { args = JSON.parse(toolCall?.function?.arguments || '{}'); } catch { args = {}; }
      let result;
      try {
        result = await liaRunTool(name, args, userId, lang);
      } catch (e) {
        console.warn('LIA tool failed:', name, e?.message || e);
        result = { error: 'No se pudo consultar ese dato ahora mismo' };
      }
      used.push(name);
      if (name === 'abrir_pantalla' && result && result.pantalla) nav = result.pantalla;
      if (name === 'preparar_transferencia' && result && !result.error && result.ejecutado === false) {
        transfer = {
          destinatario: result.destinatario,
          telefono: result.telefono || null,
          importe: result.importe,
          concepto: result.concepto || null,
        };
      }
      const payload = JSON.stringify(result);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: payload.length > 4000 ? JSON.stringify({ resultado_recortado: payload.slice(0, 3500) }) : payload,
      });
    }
  }

  // Se agotaron las rondas: pedir una respuesta final sin herramientas.
  const finalReply = await call(false);
  const text = typeof finalReply?.content === 'string' ? finalReply.content.trim() : '';
  return text ? { text, used, nav, transfer } : null;
};

const liaAnswer = async (intent, message, lang, userId, history) => {
  const copy = LIA_COPY[lang];
  switch (intent) {
    case 'balance': {
      const [wallet, movements] = await Promise.all([liaGetWallet(userId), liaGetTransactions(userId, 3)]);
      if (!movements.length) return liaFill(copy.balance, { balance: liaMoney(wallet.balance) });
      return liaFill(copy.balanceWithMovements, {
        balance: liaMoney(wallet.balance),
        movements: movements.map((tx) => liaMovementLine(tx, lang)).join('\n'),
      });
    }
    case 'activity': {
      const movements = await liaGetTransactions(userId, 5);
      if (!movements.length) return copy.noMovements;
      return liaFill(copy.movementsTitle, { movements: movements.map((tx) => liaMovementLine(tx, lang)).join('\n') });
    }
    case 'notifications': {
      const items = await liaGetNotifications(userId, 6);
      if (!items.length) return copy.noNotifications;
      const list = items.map((n) => `• ${n.de}: ${n.texto}`).join('\n');
      return liaFill(copy.notificationsTitle, { list });
    }
    case 'djangue': {
      const res = await liaDjangueSummary(userId);
      if (res.error) return res.error;
      if (!res.djangues.length) return copy.noDjangue;
      const lines = res.djangues.map((d) => {
        if (d.es_mi_turno) return liaFill(copy.djangueMyTurn, { name: d.nombre });
        if (d.debo_pagar) return liaFill(copy.djangueOwe, { name: d.nombre, quota: liaMoney(d.cuota) });
        return liaFill(copy.djanguePaid, { name: d.nombre });
      });
      return liaFill(copy.djangueTitle, { list: lines.join('\n') });
    }
    case 'news': {
      if (!Array.isArray(NOTICIAS) || !NOTICIAS.length) return copy.noNews;
      const list = NOTICIAS.slice(0, 5).map((item) => `• ${item.title} (${item.source})`).join('\n');
      return liaFill(copy.newsTitle, { list });
    }
    case 'weather': {
      let city = '';
      try {
        const { data: profile } = await supabase.from('users').select('city').eq('id', userId).maybeSingle();
        city = profile?.city || '';
      } catch (e) {
        console.warn('LIA profile lookup failed:', e?.message || e);
      }
      return liaWeatherReply(message, lang, city);
    }
    case 'health': {
      const list = [
        ...HOSPITALES.map((item) => `• ${item.name} (${item.city}) · ${item.phone}`),
        ...FARMACIAS.map((item) => `• ${item.name} (${item.city}) · ${item.phone}`),
      ].join('\n');
      return liaFill(copy.healthTitle, { list });
    }
    case 'markets': {
      const list = SUPERMERCADOS
        .map((item) => `• ${item.name} · ${item.city} · ${item.address}${item.open === false ? ` (${copy.closed})` : ''}`)
        .join('\n');
      return liaFill(copy.marketTitle, { list });
    }
    case 'atm': {
      const list = LIA_ATMS.map((item) => `• ${item.bank} · ${item.addr} · ${item.fee}`).join('\n');
      return liaFill(copy.atmTitle, { list });
    }
    case 'rates': {
      const list = Object.entries(LIA_RATES)
        .map(([currency, rate]) => `• 1 ${currency} = ${Math.round(1 / rate)} XAF`)
        .concat('• 1 XAF = 1 XOF')
        .join('\n');
      return liaFill(copy.ratesTitle, { list });
    }
    case 'card':
      return copy.card;
    case 'banks':
      return copy.bank;
    case 'taxi':
      return copy.taxi;
    case 'transfer':
      return copy.transfer;
    case 'thanks':
      return copy.thanks;
    case 'help':
      return copy.help;
    case 'greeting':
      return copy.greeting;
    case 'math':
      return liaMathReply(message, lang) || copy.unknown;
    default: {
      return copy.unknown;
    }
  }
};

app.post('/api/lia/chat', auth, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const requestedLang = String(req.body?.lang || '').toLowerCase();
  const lang = LIA_LANGS.includes(requestedLang) ? requestedLang : 'es';
  const copy = LIA_COPY[lang];

  if (!message) return res.status(400).json({ message: copy.emptyMessage, code: 'VALIDATION_ERROR' });
  if (message.length > 2000) return res.status(400).json({ message: copy.tooLong, code: 'VALIDATION_ERROR' });

  const intent = liaDetectIntent(message);
  let reply = copy.serviceError;
  let action = intent;
  let tools = [];
  let nav = null;
  let transfer = null;

  try {
    if (intent === 'math') {
      reply = liaMathReply(message, lang) || copy.unknown;
    } else {
      // El modelo es el cerebro: decide qué consultar y con qué argumentos.
      // El motor de intenciones queda solo como respaldo si el proveedor falla.
      const [{ data: profile }, wallet] = await Promise.all([
        supabase.from('users').select('full_name, city').eq('id', req.user.id).maybeSingle(),
        liaGetWallet(req.user.id),
      ]);
      const agent = await liaAgent({
        lang, message, history: req.body?.history, userId: req.user.id, profile, wallet,
      });
      if (agent) {
        reply = await liaEnsureLang(agent.text, lang);
        tools = agent.used;
        nav = agent.nav || null;
        transfer = agent.transfer || null;
        action = tools.length ? tools[tools.length - 1] : 'ai';
      } else {
        reply = await liaAnswer(intent, message, lang, req.user.id, req.body?.history);
        action = 'rules';
      }
    }
  } catch (e) {
    console.error('LIA chat error:', e);
    action = 'error';
  }

  // La persistencia nunca debe bloquear ni romper la respuesta.
  // Los usuarios locales de demostración tienen id no-uuid y no se pueden guardar.
  if (!isLocalUserId(req.user.id)) {
    try {
      const { error } = await supabase.from('lia_conversations').insert({ user_id: req.user.id, message, reply });
      if (error) console.warn('LIA history save failed:', error.message);
    } catch (e) {
      console.warn('LIA history save failed:', e?.message || e);
    }
  }

  res.json({ reply, action, tools, nav, transfer, lang, timestamp: new Date().toISOString() });
});

app.get('/api/lia/history', auth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  if (isLocalUserId(req.user.id)) return res.json({ messages: [] });
  const readHistory = async (columns) => supabase
    .from('lia_conversations')
    .select(columns)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  try {
    let rows = [];
    let result = await readHistory('message, reply, created_at');
    if (result.error) {
      // Instalaciones antiguas pueden no tener created_at: no perder el historial.
      result = await supabase
        .from('lia_conversations')
        .select('message, reply')
        .eq('user_id', req.user.id)
        .limit(limit);
    }
    if (result.error) throw result.error;
    rows = result.data || [];

    const messages = [];
    rows.slice().reverse().forEach((row) => {
      if (row.message) messages.push({ role: 'user', content: row.message, time: row.created_at });
      if (row.reply) messages.push({ role: 'assistant', content: row.reply, time: row.created_at });
    });
    res.json({ messages });
  } catch (e) {
    console.warn('LIA history error:', e?.message || e);
    res.json({ messages: [] });
  }
});

app.get('/api/lia/status', auth, (_req, res) => {
  const provider = liaProvider();
  res.json({
    engine: provider ? provider.name : 'rules',
    model: provider ? provider.chatModel : null,
    mode: provider ? 'agent' : 'rules',
    tools: LIA_TOOL_DEFS.map((tool) => tool.function.name),
    dictation: Boolean(provider),
    languages: LIA_LANGS,
    features: ['balance', 'movements', 'spending_analysis', 'limits', 'contacts', 'conversion', 'news', 'weather', 'health', 'markets', 'atm', 'banks', 'rates', 'cards', 'taxi', 'transfers', 'notifications', 'djangue', 'languages', 'help', 'attachments', 'vision', 'documents'],
  });
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
  if (!isAdminKeyValid(key)) return res.status(403).json({ message: 'No autorizado' });
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword) return res.status(400).json({ message: 'phone y newPassword requeridos' });
  const { user: objetivo, ambiguous } = await findAuthUserByPhone(phone);
  if (!objetivo) return res.status(404).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'Usuario no encontrado' });
  const hashed = await bcrypt.hash(newPassword, 10);
  const { data, error } = await supabase.from('users').update({ password_hash: hashed }).eq('id', objetivo.id).select('id, phone, full_name').single();
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
  // try/catch y no `.catch()`: el constructor de consultas de supabase-js 2.101
  // es thenable pero no tiene método catch, así que encadenarlo lanza TypeError.
  try {
    await supabase.from('audit_logs').insert({
      user_id: userId,
      action,
      module,
      entity_id: entityId || null,
      details: details || {}
    });
  } catch (e) {
    console.warn('[audit] registro no guardado:', e.message);
  }
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

// Los tres proveedores de facturas (luz, agua, impuestos) comparten camino: la
// deuda vive en service_bills y el importe lo fija esa tabla, nunca el cliente.
const SERVICE_BILL_PROVIDERS = { segesa: 'SEGESA', snge: 'SNGE', dgi: 'DGI' };

// El importe de un servicio ya no vive en el codigo ni en el cuerpo de la
// peticion: vive en service_tariffs / service_products. El cliente manda que
// variant contrata y la referencia de su pedido; la base de datos pone el precio
// y asienta la deuda con el proveedor.
const tariffError = (msg) => (/saldo insuficiente/i.test(String(msg || ''))
  ? { ok: false, http: 400, code: 'INSUFFICIENT_BALANCE', message: 'Saldo insuficiente' }
  : { ok: false, http: 500, code: 'CHARGE_FAILED', message: 'No se pudo completar el cargo' });

const serviceCharge = async (userId, service, variant, ref) => {
  const { data, error } = await supabase.rpc('service_charge', {
    p_user_id: userId,
    p_service: String(service),
    p_variant: String(variant),
    p_ref: String(ref),
  });
  if (error) return tariffError(error.message);
  return data || { ok: false, code: 'CHARGE_FAILED' };
};

const serviceBasketCharge = async (userId, ref, items, service = 'supermercado') => {
  const { data, error } = await supabase.rpc('service_basket_charge', {
    p_user_id: userId,
    p_ref: String(ref),
    p_items: items,
    p_service: String(service),
  });
  if (error) return tariffError(error.message);
  return data || { ok: false, code: 'CHARGE_FAILED' };
};

const serviceRefund = async (userId, service, ref, amount) => {
  const { data, error } = await supabase.rpc('service_refund', {
    p_user_id: userId,
    p_service: String(service),
    p_ref: String(ref),
    p_amount: roundAmount(amount),
  });
  if (error) return tariffError(error.message);
  return data || { ok: false, code: 'REFUND_FAILED' };
};

// Unidad de precio del pedido: se lee, nunca se envia desde la app.
const readTariff = async (service, variant) => {
  const { data, error } = await supabase
    .from('service_tariffs')
    .select('service, variant, amount, currency, concept')
    .eq('service', service).eq('variant', variant).eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  return data;
};

// Catalogo de precios: la tabla que cobra es la misma que se muestra, para que
// la app no pueda pintar un importe y pagar otro.
const readProducts = async ({ category, notCategory, q } = {}) => {
  let query = supabase
    .from('service_products')
    .select('id, name, category, price, currency')
    .eq('active', true)
    .order('id');
  if (category) query = query.eq('category', category);
  if (notCategory) query = query.neq('category', notCategory);
  if (q) query = query.ilike('name', `%${String(q)}%`);
  const { data, error } = await query;
  if (error) return null;
  return data || [];
};

// Lista de tarifas y catalogo: la app deja de llevar sus numeros en el codigo.
app.get('/api/servicios/tarifas', auth, async (_req, res) => {
  const { data: tarifas, error } = await supabase
    .from('service_tariffs')
    .select('service, variant, amount, currency, concept')
    .eq('active', true)
    .order('service').order('variant');
  if (error) return res.status(502).json({ message: error.message, code: 'TARIFFS_UNAVAILABLE' });
  const { data: productos } = await supabase
    .from('service_products')
    .select('id, name, category, price, currency')
    .eq('active', true)
    .order('category').order('name');
  res.json({ tarifas: tarifas || [], productos: productos || [] });
});

const serviceConsult = async (provider, ref, userId) => {
  const { data, error } = await supabase
    .from('service_bills')
    .select('id, contract_ref, amount, currency, period, concept, due_date, status')
    .eq('provider', provider)
    .eq('contract_ref', ref)
    .eq('status', 'pending')
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order('due_date', { ascending: true });

  if (error) {
    console.error('serviceConsult error:', error.message);
    return { ok: false, code: 'BILLS_UNAVAILABLE', message: 'No se pudo consultar la deuda. Inténtalo de nuevo.' };
  }

  const facturas = data || [];
  const importe = facturas.reduce((s, f) => s + Number(f.amount || 0), 0);
  return {
    ok: true,
    contract: ref,
    importe,
    estado: facturas.length ? 'pendiente' : 'sin_deuda',
    facturas,
  };
};

const servicePay = async (provider, billId, userId) => {
  const { data, error } = await supabase.rpc('service_pay_bill', {
    p_bill_id: billId,
    p_user_id: userId,
  });

  if (error) {
    console.error('servicePay error:', error.message);
    if (/Saldo insuficiente/i.test(error.message || '')) {
      return { ok: false, code: 'INSUFFICIENT_BALANCE', message: 'Saldo insuficiente' };
    }
    return { ok: false, code: 'PAY_FAILED', message: 'No se pudo completar el pago. Inténtalo de nuevo.' };
  }

  const r = data || {};
  if (!r.ok) {
    const codes = { BILL_NOT_FOUND: 404, BILL_NOT_PENDING: 409, BILL_OTHER_USER: 403 };
    return { ok: false, http: codes[r.code] || 400, code: r.code || 'PAY_FAILED', ...r };
  }

  const balance = await readWalletBalance(userId);
  const label = SERVICE_BILL_PROVIDERS[provider] || provider.toUpperCase();
  await supabase.from('transactions').insert({
    user_id: userId,
    type: 'service_payment',
    amount: Number(r.amount),
    method: 'EGCHAT',
    reference: `${label}-${r.contract_ref}`,
    status: 'completed',
    ledger_journal_id: r.journal_id || null,
  });
  await logAudit(userId, 'service_bill_paid', 'services', r.bill_id, r);

  return {
    ok: true,
    response: {
      success: true,
      provider,
      bill_id: r.bill_id,
      importe: Number(r.amount),
      balance,
      journal_id: r.journal_id,
      message: `Pago de ${label} completado`,
    },
  };
};

app.post('/api/servicios/segesa/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Numero de contrato requerido', code: 'VALIDATION_ERROR' });
  const out = await serviceConsult('segesa', String(contrato), req.user.id);
  if (!out.ok) return res.status(502).json(out);
  await createServiceOrder(req.user.id, 'segesa', 'consultar', 0, String(contrato), req.body, out);
  res.json(out);
});

app.post('/api/servicios/segesa/pagar', auth, walletLimiter, async (req, res) => {
  const { factura_id } = req.body;
  if (!factura_id) return res.status(400).json({
    message: 'factura_id requerido: se paga una factura consultada, no un importe libre',
    code: 'BILL_ID_REQUIRED',
  });
  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
  const out = await servicePay('segesa', factura_id, req.user.id);
  if (!out.ok) return res.status(out.http || 400).json(out);
  await createServiceOrder(req.user.id, 'segesa', 'pagar', out.response.importe, out.response.bill_id, req.body, out.response);
  res.json(out.response);
});

app.post('/api/servicios/snge/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Numero de contrato requerido', code: 'VALIDATION_ERROR' });
  const out = await serviceConsult('snge', String(contrato), req.user.id);
  if (!out.ok) return res.status(502).json(out);
  await createServiceOrder(req.user.id, 'snge', 'consultar', 0, String(contrato), req.body, out);
  res.json(out);
});

app.post('/api/servicios/snge/pagar', auth, walletLimiter, async (req, res) => {
  const { factura_id } = req.body;
  if (!factura_id) return res.status(400).json({
    message: 'factura_id requerido: se paga una factura consultada, no un importe libre',
    code: 'BILL_ID_REQUIRED',
  });
  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
  const out = await servicePay('snge', factura_id, req.user.id);
  if (!out.ok) return res.status(out.http || 400).json(out);
  await createServiceOrder(req.user.id, 'snge', 'pagar', out.response.importe, out.response.bill_id, req.body, out.response);
  res.json(out.response);
});

app.post('/api/servicios/dgi/consultar', auth, async (req, res) => {
  const { nif } = req.body;
  if (!nif) return res.status(400).json({ message: 'NIF requerido', code: 'VALIDATION_ERROR' });
  const out = await serviceConsult('dgi', String(nif), req.user.id);
  if (!out.ok) return res.status(502).json(out);
  await createServiceOrder(req.user.id, 'dgi', 'consultar', 0, String(nif), req.body, out);
  res.json(out);
});

app.post('/api/servicios/dgi/pagar', auth, walletLimiter, async (req, res) => {
  const { factura_id } = req.body;
  if (!factura_id) return res.status(400).json({
    message: 'factura_id requerido: se paga una factura consultada, no un importe libre',
    code: 'BILL_ID_REQUIRED',
  });
  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
  const out = await servicePay('dgi', factura_id, req.user.id);
  if (!out.ok) return res.status(out.http || 400).json(out);
  await createServiceOrder(req.user.id, 'dgi', 'pagar', out.response.importe, out.response.bill_id, req.body, out.response);
  res.json(out.response);
});

// Las deudas las trae el proveedor (fichero, ventanilla o integración), jamás la
// app. Cada fila repetida del mismo fichero se ignora por el indice unico.
app.post('/api/servicios/facturas/cargar', auth, requireAdmin, async (req, res) => {
  const filas = Array.isArray(req.body?.facturas) ? req.body.facturas : [];
  if (!filas.length) return res.status(400).json({ message: 'facturas[] requerido', code: 'VALIDATION_ERROR' });

  let creadas = 0, repetidas = 0, invalidas = 0;
  for (const f of filas) {
    const provider = String(f?.provider || '').toLowerCase();
    const ref = String(f?.contract_ref ?? f?.contrato ?? f?.nif ?? '').trim();
    const amount = roundAmount(Number(f?.amount ?? f?.importe ?? 0));
    if (!SERVICE_BILL_PROVIDERS[provider] || !ref || !(amount > 0)) { invalidas++; continue; }
    const { error } = await supabase.from('service_bills').insert({
      provider,
      contract_ref: ref,
      user_id: f?.user_id || null,
      amount,
      currency: f?.currency || WALLET_CURRENCY,
      period: f?.period || null,
      concept: f?.concept || null,
      due_date: f?.due_date || null,
    });
    if (error) {
      if (/duplicate key|already exists/i.test(error.message || '')) { repetidas++; continue; }
      console.error('cargar facturas error:', error.message);
      invalidas++;
      continue;
    }
    creadas++;
  }

  await logAudit(req.user.id, 'service_bills_loaded', 'services', 'carga', { filas: filas.length, creadas, repetidas, invalidas });
  res.json({ filas: filas.length, creadas, repetidas, invalidas });
});

// Deuda del usuario en todos los proveedores, para que la app no tenga que
// adivinar contratos. Con estado=todas o estado=pagadas también devuelve lo
// abonado, así la pantalla de facturas puede enseñar el historial sin inventar.
app.get('/api/servicios/facturas', auth, async (req, res) => {
  const estado = String(req.query.estado || 'pendientes').toLowerCase();
  let query = supabase
    .from('service_bills')
    .select('id, provider, contract_ref, amount, currency, period, concept, due_date, status, paid_at')
    .or(`user_id.eq.${req.user.id},user_id.is.null`)
    .order('due_date', { ascending: true });
  if (estado === 'pendientes') query = query.eq('status', 'pending');
  else if (estado === 'pagadas') query = query.eq('status', 'paid');

  const { data, error } = await query;
  if (error) return res.status(502).json({ message: error.message, code: 'BILLS_UNAVAILABLE' });
  const facturas = data || [];
  const pendientes = facturas.filter(f => f.status === 'pending');
  res.json({
    facturas,
    total: pendientes.reduce((s, f) => s + Number(f.amount || 0), 0),
    por_proveedor: pendientes.reduce((acc, f) => {
      acc[f.provider] = (acc[f.provider] || 0) + Number(f.amount || 0);
      return acc;
    }, {}),
  });
});

// Servicios que aun no tienen canal de cobro (matricula, reserva de hotel,
// vuelo, inversion...). La solicitud queda registrada en service_orders con
// importe 0 para que el comercio la revise: aqui no sale dinero de la cartera
// y, sin fila insertada, la app no puede dar por confirmada nada.
const SOLICITUD_SERVICIOS = [
  'educacion', 'hoteles', 'restaurantes', 'comida', 'vuelos', 'inversiones',
  'bancos', 'internet', 'canales', 'lavanderia', 'belleza', 'gasolineras', 'tienda',
  'recarga',
];

app.post('/api/servicios/solicitud', auth, async (req, res) => {
  const { provider, tipo, referencia, datos, external_id } = req.body || {};
  const servicio = String(provider || '').toLowerCase();
  if (!SOLICITUD_SERVICIOS.includes(servicio)) {
    return res.status(400).json({ message: 'Servicio no reconocido', code: 'VALIDATION_ERROR' });
  }

  // Repetir la misma referencia no duplica la solicitud.
  const ref = String(external_id || '').trim() || safeRef(servicio.toUpperCase());
  const { data: previa } = await supabase.from('service_orders')
    .select('order_ref, status').eq('order_ref', ref).eq('user_id', req.user.id).maybeSingle();
  if (previa) {
    return res.json({ solicitudId: previa.order_ref, status: previa.status, idempotent: true, message: 'La solicitud ya estaba registrada' });
  }

  const { data: orden, error } = await supabase.from('service_orders').insert({
    order_ref: ref,
    user_id: req.user.id,
    provider: servicio,
    service_type: String(tipo || 'solicitud'),
    contract_ref: referencia ? String(referencia) : null,
    amount: 0,
    status: 'pending',
    payload: datos || {},
    response: { needs_confirmation: true },
  }).select('order_ref, status, created_at').maybeSingle();
  if (error || !orden) {
    console.error('Solicitud de servicio:', error?.message);
    return res.status(502).json({ message: 'No se pudo registrar la solicitud', code: 'REQUEST_NOT_SAVED' });
  }

  await logAudit(req.user.id, 'service_request', servicio, orden.order_ref, { tipo, referencia });
  res.status(201).json({
    solicitudId: orden.order_ref,
    status: orden.status,
    message: 'Solicitud registrada. El comercio debe confirmarla; todavia no se ha cobrado nada.',
  });
});

// Listado de solicitudes del usuario para que la app enseñe el historial desde
// la base de datos y no desde un array que se pierde al cerrar la pantalla.
app.get('/api/servicios/solicitudes', auth, async (req, res) => {
  const provider = String(req.query.provider || '').toLowerCase();
  let query = supabase
    .from('service_orders')
    .select('order_ref, provider, service_type, contract_ref, amount, status, payload, response, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (provider) query = query.eq('provider', provider);
  const { data, error } = await query;
  if (error) return res.status(502).json({ message: 'No se pudieron listar las solicitudes', code: 'REQUESTS_UNAVAILABLE' });
  res.json(data || []);
});

app.post('/api/servicios/correos/enviar', auth, walletLimiter, async (req, res) => {
  const { destinatario, peso, tipo } = req.body;
  if (!destinatario) return res.status(400).json({ message: 'destinatario requerido', code: 'VALIDATION_ERROR' });
  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
  const variant = ['nacional', 'express', 'internacional', 'apartado'].includes(tipo) ? tipo : 'nacional';

  const tarifa = await readTariff('correos', variant);
  if (!tarifa) return res.status(502).json({ message: 'Tarifa de Correos no disponible', code: 'TARIFF_UNAVAILABLE' });

  const tracking = `EG${Date.now()}`;
  const cargo = await serviceCharge(req.user.id, 'correos', variant, tracking);
  if (!cargo.ok) return res.status(cargo.http || 400).json(cargo);

  const balance = await readWalletBalance(req.user.id);
  const response = {
    tracking,
    tarifa: Number(cargo.amount),
    variante: variant,
    estimado: variant === 'express' ? '1-2 dias' : '3-5 dias',
    destinatario,
    journal_id: cargo.journal_id,
    balance,
    message: 'Paquete registrado y pagado',
  };
  await createServiceOrder(req.user.id, 'correos', 'enviar', Number(cargo.amount), destinatario, { destinatario, peso, tipo: variant }, response);
  res.json(response);
});

app.get('/api/servicios/orders', auth, async (req, res) => {
  const { data } = await supabase.from('service_orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

// ════════════════════════════════════════════════════════════════════
// SUPERMERCADOS
// ════════════════════════════════════════════════════════════════════
const SUPERMERCADOS = [
  { id: '1', name: 'Supermarket Malabo', city: 'Malabo', address: 'Calle de la Independencia', phone: '+240 222 001', open: true },
  { id: '2', name: 'Tienda Bata Centro', city: 'Bata', address: 'Av. Hassan II', phone: '+240 333 001', open: true },
  { id: '3', name: 'Mercado Mongomo', city: 'Mongomo', address: 'Plaza Central', phone: '+240 444 001', open: false },
];
app.get('/api/supermarkets', auth, async (req, res) => {
  const { city } = req.query;
  const result = city ? SUPERMERCADOS.filter(s => s.city.toLowerCase() === city.toLowerCase()) : SUPERMERCADOS;
  res.json(result);
});

app.get('/api/supermarkets/:smId/products', auth, async (req, res) => {
  const productos = await readProducts(req.query.cat
    ? { category: req.query.cat }
    : { notCategory: 'Medicamentos' });
  if (productos === null) return res.status(502).json({ message: 'Catalogo no disponible', code: 'CATALOG_UNAVAILABLE' });
  res.json(productos);
});

app.post('/api/supermarkets/orders', auth, walletLimiter, async (req, res) => {
  const { items, supermarketId, address, external_id } = req.body;
  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
  if (external_id) {
    const { data: existing } = await supabase.from('service_orders').select('*').eq('order_ref', external_id).eq('user_id', req.user.id).maybeSingle();
    if (existing) return res.json({ orderId: existing.order_ref, status: existing.status, total: existing.amount, balance: null, eta: '30-45 min', idempotent: true });
  }
  // El cuerpo puede traer precios: se ignoran. El total lo pone service_products.
  const pedido = (Array.isArray(items) ? items : []).map(i => ({
    product_id: String(i?.product_id ?? i?.id ?? '').trim(),
    qty: Number(i?.qty ?? i?.cantidad ?? 1),
  })).filter(i => i.product_id && i.qty > 0);
  if (!pedido.length) {
    return res.status(400).json({ message: 'Pedido vacio: cada linea necesita product_id y cantidad', code: 'VALIDATION_ERROR' });
  }

  const orderId = external_id || safeRef('ORD');
  const cargo = await serviceBasketCharge(req.user.id, orderId, pedido);
  if (!cargo.ok) {
    return res.status(cargo.http || 400).json({
      message: cargo.code === 'PRODUCT_NOT_FOUND' ? 'Algun producto ya no esta en el catalogo'
        : cargo.message || 'No se pudo completar el pedido',
      code: cargo.code || 'ORDER_FAILED',
    });
  }

  const total = Number(cargo.amount);
  const balance = await readWalletBalance(req.user.id);
  await supabase.from('service_orders').upsert({
    order_ref: orderId,
    user_id: req.user.id,
    provider: 'supermarkets',
    service_type: 'order',
    contract_ref: String(supermarketId || ''),
    amount: total,
    status: 'completed',
    payload: { items: cargo.lines || pedido, address: address || '' },
    response: { eta: '30-45 min', journal_id: cargo.journal_id }
  }, { onConflict: 'order_ref' });
  await logAudit(req.user.id, 'supermarket_order_create', 'supermarkets', orderId, { total, supermarketId, journal_id: cargo.journal_id });
  res.json({ orderId, status: 'confirmed', total, balance, eta: '30-45 min', journal_id: cargo.journal_id });
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
  const meds = await readProducts({ category: 'Medicamentos', q: req.query.q });
  if (meds === null) return res.status(502).json({ message: 'Catalogo no disponible', code: 'CATALOG_UNAVAILABLE' });
  res.json(meds);
});

app.post('/api/salud/medicamentos/pedido', auth, walletLimiter, async (req, res) => {
  const { items, farmaciaId, direccion, external_id } = req.body || {};
  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
  const pedido = (Array.isArray(items) ? items : []).map(i => ({
    product_id: String(i?.product_id ?? i?.id ?? '').trim(),
    qty: Number(i?.qty ?? i?.cantidad ?? 1),
  })).filter(i => i.product_id && i.qty > 0);
  if (!pedido.length) {
    return res.status(400).json({ message: 'Pedido vacio: cada linea necesita product_id y cantidad', code: 'VALIDATION_ERROR' });
  }

  const orderId = external_id || safeRef('MED');
  const cargo = await serviceBasketCharge(req.user.id, orderId, pedido, 'farmacia');
  if (!cargo.ok) {
    return res.status(cargo.http || 400).json({
      message: cargo.code === 'PRODUCT_NOT_FOUND' ? 'Algun producto ya no esta en el catalogo'
        : cargo.message || 'No se pudo completar el pedido',
      code: cargo.code || 'ORDER_FAILED',
    });
  }

  const total = Number(cargo.amount);
  await supabase.from('service_orders').upsert({
    order_ref: orderId,
    user_id: req.user.id,
    provider: 'salud',
    service_type: 'medicamentos',
    contract_ref: String(farmaciaId || ''),
    amount: total,
    status: 'completed',
    payload: { items: cargo.lines || pedido, direccion: direccion || '' },
    response: { eta: '20-30 min', journal_id: cargo.journal_id }
  }, { onConflict: 'order_ref' });
  await logAudit(req.user.id, 'medicament_order_create', 'salud', orderId, { total, farmaciaId, journal_id: cargo.journal_id });
  res.json({ orderId, status: 'confirmed', total, balance: await readWalletBalance(req.user.id), eta: '20-30 min', journal_id: cargo.journal_id, message: 'Pedido de medicamentos confirmado y pagado' });
});

// ════════════════════════════════════════════════════════════════════
// TAXI
// ════════════════════════════════════════════════════════════════════
app.post('/api/taxi/request', auth, walletLimiter, async (req, res) => {
  try {
    const { origin, dest, type } = req.body;
    if (!origin || !dest) return res.status(400).json({ message: 'origin y dest requeridos', code: 'VALIDATION_ERROR' });
    const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);
    const variant = ['moto', 'basic', 'premium'].includes(type) ? type : 'basic';

    const tarifa = await readTariff('taxi', variant);
    if (!tarifa) return res.status(502).json({ message: 'Tarifa de taxi no disponible', code: 'TARIFF_UNAVAILABLE' });

    const rideId = safeRef('RIDE');
    const driver = { name: 'Carlos Mba', phone: '+240 222 555', rating: 4.8, plate: 'GE-1234', vehicle: variant === 'moto' ? 'Moto Honda' : 'Toyota Corolla' };

    // El viaje se escribe antes de cobrar: si no queda fila, no hay cargo.
    const { data: ride, error: rideError } = await supabase.from('taxi_rides').insert({
      ride_ref: rideId,
      user_id: req.user.id,
      origin,
      destination: dest,
      ride_type: variant,
      fare: Number(tarifa.amount),
      status: 'searching',
      driver,
    }).select().maybeSingle();
    if (rideError || !ride) {
      console.error('taxi_rides insert:', rideError?.message || 'sin fila insertada');
      return res.status(502).json({ message: 'No se pudo registrar el viaje', code: 'RIDE_NOT_SAVED' });
    }

    const cargo = await serviceCharge(req.user.id, 'taxi', variant, rideId);
    if (!cargo.ok) {
      await supabase.from('taxi_rides').update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', ride.id).eq('charged_at', null);
      return res.status(cargo.http || 400).json(cargo.code === 'INSUFFICIENT_BALANCE'
        ? { message: 'Saldo insuficiente', code: 'INSUFFICIENT_BALANCE' }
        : { message: 'No se pudo cobrar el viaje', code: cargo.code || 'CHARGE_FAILED' });
    }

    await supabase.from('taxi_rides')
      .update({ status: 'assigned', charged_at: new Date().toISOString(), journal_id: cargo.journal_id })
      .eq('id', ride.id);
    await logAudit(req.user.id, 'taxi_request', 'taxi', ride.id, { fare: Number(cargo.amount), variant });

    res.json({
      rideId,
      driver,
      eta: Math.floor(Math.random() * 8) + 3,
      tarifa: Number(cargo.amount),
      type: variant,
      status: 'assigned',
      balance: await readWalletBalance(req.user.id),
      journal_id: cargo.journal_id,
    });
  } catch (error) {
    console.error('Taxi request error:', error);
    res.status(500).json({ message: 'Error al solicitar taxi', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/taxi/:rideId/status', auth, async (req, res) => {
  try {
    const { data: ride } = await supabase.from('taxi_rides')
      .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
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
    const { data: ride } = await supabase.from('taxi_rides')
      .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
    if (!ride) return res.status(404).json({ message: 'Viaje no encontrado', code: 'RIDE_NOT_FOUND' });

    // Un viaje cobrado se devuelve con su propio asiento, una sola vez: la clave
    // de reembolso lleva el id del viaje, así que cancelar dos veces no devuelve
    // dinero dos veces.
    let reembolsado = 0;
    if (ride.charged_at && !ride.refunded_at) {
      const dev = await serviceRefund(req.user.id, 'taxi', ride.ride_ref, Number(ride.fare));
      if (!dev.ok) return res.status(dev.http || 500).json({ message: 'No se pudo devolver el viaje', code: dev.code || 'REFUND_FAILED' });
      reembolsado = Number(dev.amount);
    }

    // Si no se devolvio nada, refunded_at no se toca: ponerlo a null dejaria el
    // viaje otra vez reembolsable al tercer clic.
    await supabase.from('taxi_rides')
      .update(reembolsado
        ? { status: 'cancelled', refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        : { status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', ride.id);
    await logAudit(req.user.id, 'taxi_cancel', 'taxi', ride.id, { ride_ref: ride.ride_ref, reembolsado });

    res.json({ message: 'Viaje cancelado', rideId: req.params.rideId, reembolsado, balance: await readWalletBalance(req.user.id) });
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

    const { data: ride } = await supabase.from('taxi_rides')
      .select('*').eq('user_id', req.user.id).eq('ride_ref', req.params.rideId).maybeSingle();
    if (!ride) {
      return res.status(404).json({ message: 'Viaje no encontrado', code: 'RIDE_NOT_FOUND' });
    }

    // Valorar cierra el viaje: el cobro ya se hizo al solicitarlo, aqui solo
    // queda la opinion del cliente y el estado.
    await supabase.from('taxi_rides').update({
      rating: Number(rating),
      rating_comment: comment || null,
      status: 'completed',
      updated_at: new Date().toISOString()
    }).eq('id', ride.id);

    await logAudit(req.user.id, 'taxi_rate', 'taxi', ride.id, { ride_ref: ride.ride_ref, rating });

    res.json({
      message: 'Valoracion enviada',
      rating: Number(rating),
      rideId: req.params.rideId,
      balance: await readWalletBalance(req.user.id)
    });
  } catch (error) {
    console.error('Taxi rate error:', error);
    res.status(500).json({ message: 'Error al valorar viaje', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/taxi/rides', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('taxi_rides')
      .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(502).json({ message: 'No se pudieron listar los viajes', code: 'RIDES_UNAVAILABLE' });
    res.json(data || []);
  } catch (error) {
    console.error('Taxi rides error:', error);
    res.status(500).json({ message: 'Error al obtener viajes', code: 'INTERNAL_ERROR' });
  }
});

// Alta de conductor. No existe flota que asignar todavía, así que la solicitud
// se registra como orden de servicio (importe 0: no mueve dinero) y el operador
// la revisa desde service_orders. Sin fila no hay solicitud: antes la app
// confirmaba el alta con solo haber llamado a la ruta.
app.post('/api/taxi/drivers/register', auth, async (req, res) => {
  try {
    const { name, phone, license, vehicle } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ message: 'Nombre y telefono requeridos', code: 'VALIDATION_ERROR' });
    }
    if (!vehicle || !vehicle.plate) {
      return res.status(400).json({ message: 'Matricula requerida', code: 'VALIDATION_ERROR' });
    }

    const ref = safeRef('DRV');
    const { data: orden, error } = await supabase.from('service_orders').insert({
      order_ref: ref,
      user_id: req.user.id,
      provider: 'taxi',
      service_type: 'conductor',
      contract_ref: String(vehicle.plate),
      amount: 0,
      status: 'pending',
      payload: { name, phone, license: license || null, vehicle },
      response: { status: 'pending_review' },
    }).select('order_ref, status, created_at').maybeSingle();
    if (error || !orden) {
      console.error('Taxi driver register:', error?.message);
      return res.status(502).json({ message: 'No se pudo registrar la solicitud', code: 'APPLICATION_NOT_SAVED' });
    }

    await logAudit(req.user.id, 'taxi_driver_register', 'taxi', orden.order_ref, { plate: vehicle.plate });
    res.status(201).json({
      driverId: orden.order_ref,
      status: orden.status,
      message: 'Solicitud registrada. El equipo de MiTaxi la revisara y te contactara.',
    });
  } catch (error) {
    console.error('Taxi driver register error:', error);
    res.status(500).json({ message: 'Error al registrar conductor', code: 'INTERNAL_ERROR' });
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
app.post('/api/insurance/contract', auth, walletLimiter, async (req, res) => {
  try {
    const { insurance_type, coverage_amount, duration_months, payment_method } = req.body;

    if (!insurance_type || !coverage_amount || !duration_months) {
      return res.status(400).json({ message: 'Datos incompletos para contratar' });
    }

    const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

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

    // Cobrar antes de emitir: dos peticiones simultáneas no pueden quedarse con
    // dos pólizas pagando una sola vez.
    const debit = await debitWallet(req.user.id, total_premium, {
      operation: 'pago_servicio',
      account: 'SYS-SUSPENSE',
      concept: `Prima de seguro ${insurance_type} ${duration_months} meses`,
      key: req.body?.client_ref ? `INS-${String(req.body.client_ref)}` : null,
    });
    if (!debit.ok) return transferErrorResponse(res, debit.code);

    // Crear pÁƒÂ³liza
    const { data: policy, error: policyError } = await supabase
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
    if (policyError) {
      // Anulamos la prima con el asiento contrario (mismo origen y destino) para
      // que el libro refleje el cobro y la devolución, no un saldo suelto.
      await creditWallet(req.user.id, total_premium, {
        operation: 'ajuste',
        account: 'SYS-SUSPENSE',
        concept: 'Devolución de prima no emitida',
        key: `INS-VOID-${req.params?.id || Date.now()}`,
      });
      return res.status(500).json({ message: 'No se pudo emitir la póliza' });
    }

    // Registrar transacciÁƒÂ³n
    // La póliza queda atada al asiento que la cobró: sin eso, el libro y la
    // historia del cliente no tienen forma de encontrarse.
    await supabase
      .from('insurance_policies')
      .update({ ledger_journal_id: debit.journal_id })
      .eq('id', policy.id);

    await supabase
      .from('transactions')
      .insert({
        user_id: req.user.id,
        type: 'insurance_payment',
        amount: total_premium,
        method: payment_method,
        reference: `INSURANCE-${policy.id}`,
        status: 'completed',
        ledger_journal_id: debit.journal_id,
      });

    res.json({
      message: 'Seguro contratado exitosamente',
      policy,
      balance: debit.balance
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
  { id: 'coge', name: 'COGE Seguros' },
  { id: 'siat', name: 'SIAT Guinea' },
  { id: 'allianz', name: 'Allianz GE' },
];

app.get('/api/seguros/companias', auth, async (_req, res) => res.json(ASEGURADORAS));

// La prima no la decide el orden de un array: la lee el servidor de
// service_tariffs (service = compañía, variant = producto) y es exactamente esa
// cifra la que insurance_take_out() asienta al contratar.
app.get('/api/seguros/companias/:companyId/productos', auth, async (req, res) => {
  const company = ASEGURADORAS.find(a => a.id === req.params.companyId);
  if (!company) return res.status(404).json({ message: 'Aseguradora no encontrada', code: 'COMPANY_NOT_FOUND' });
  const { data, error } = await supabase
    .from('service_tariffs')
    .select('variant, amount, currency, concept')
    .eq('service', company.id).eq('active', true)
    .order('variant');
  if (error || !data) return res.status(502).json({ message: 'Primas no disponibles', code: 'TARIFFS_UNAVAILABLE' });
  res.json(data.map(p => ({
    id: p.variant,
    name: p.concept ? p.concept.split(' - ')[1] || p.variant : p.variant,
    price: Number(p.amount),
    currency: p.currency,
    coverage: '12 meses',
  })));
});

app.post('/api/seguros/solicitar', auth, walletLimiter, async (req, res) => {
  const { companyId, producto, datos, external_id } = req.body || {};
  if (!companyId || !producto) return res.status(400).json({ message: 'companyId y producto requeridos', code: 'VALIDATION_ERROR' });
  if (!ASEGURADORAS.some(a => a.id === companyId)) return res.status(400).json({ message: 'Aseguradora no encontrada', code: 'COMPANY_NOT_FOUND' });

  const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
  if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

  const ref = String(external_id || '').trim() || safeRef('POL');
  const { data, error } = await supabase.rpc('insurance_take_out', {
    p_user_id: req.user.id,
    p_company: String(companyId),
    p_product: String(producto),
    p_ref: ref,
  });
  if (error) {
    console.error('insurance_take_out error:', error.message);
    const fallo = tariffError(error.message);
    return res.status(fallo.http).json(fallo);
  }
  const r = data || {};
  if (!r.ok) {
    return res.status(r.code === 'TARIFF_NOT_FOUND' ? 400 : 500).json({
      message: r.code === 'TARIFF_NOT_FOUND' ? 'Prima no disponible para ese producto' : 'No se pudo emitir la póliza',
      code: r.code || 'POLICY_FAILED',
    });
  }

  const balance = await readWalletBalance(req.user.id);
  await createServiceOrder(req.user.id, 'seguros', 'solicitar', Number(r.premium), r.policy_ref,
    { companyId, producto, datos: datos || null }, { ...r, balance });
  await logAudit(req.user.id, 'insurance_request', 'seguros', r.policy_id, { companyId, producto, premium: r.premium, journal_id: r.journal_id });
  res.json({
    solicitudId: r.policy_ref,
    policyId: r.policy_id,
    premium: Number(r.premium),
    currency: r.currency,
    expires_at: r.expires_at,
    balance,
    journal_id: r.journal_id,
    status: r.status,
    message: `Póliza emitida por ${Number(r.premium).toLocaleString()} ${r.currency || 'XAF'}`,
  });
});

app.get('/api/seguros/polizas', auth, async (req, res) => {
  const { data: polizas, error } = await supabase
    .from('insurance_policies')
    .select('id, policy_ref, company, product, premium, currency, status, insured, journal_id, starts_at, expires_at, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(502).json({ message: 'No se pudieron listar las pólizas', code: 'POLICIES_UNAVAILABLE' });
  res.json(polizas || []);
});

// Abrir un siniestro es un registro, no un abono: aquí no sale dinero de la
// cartera. La liquidación la hace el operador con su propio asiento.
app.post('/api/seguros/polizas/:policyId/siniestros', auth, async (req, res) => {
  const { amount, notes } = req.body || {};
  const reclamado = roundAmount(Number(amount || 0));
  if (!(reclamado > 0)) return res.status(400).json({ message: 'Importe reclamado requerido', code: 'VALIDATION_ERROR' });

  const { data: pol } = await supabase.from('insurance_policies')
    .select('id, policy_ref, status').eq('id', req.params.policyId).eq('user_id', req.user.id).maybeSingle();
  if (!pol) return res.status(404).json({ message: 'Póliza no encontrada', code: 'POLICY_NOT_FOUND' });

  const claimRef = safeRef('SIN');
  const { data: claim, error } = await supabase.from('insurance_claims').insert({
    claim_ref: claimRef,
    policy_id: pol.id,
    user_id: req.user.id,
    amount_claimed: reclamado,
    notes: notes ? String(notes) : null,
  }).select('id, claim_ref, policy_id, amount_claimed, status, created_at').maybeSingle();
  if (error || !claim) return res.status(502).json({ message: 'No se pudo registrar el siniestro', code: 'CLAIM_FAILED' });

  await logAudit(req.user.id, 'insurance_claim', 'seguros', claim.id, { policy_ref: pol.policy_ref, amount_claimed: reclamado });
  res.status(201).json({ ...claim, message: 'Siniestro registrado. La aseguradora lo revisará.' });
});

// ════════════════════════════════════════════════════════════════════
// DJANGUE — tandas de ahorro rotativo
// ════════════════════════════════════════════════════════════════════
// Esquema: migrations/EJECUTAR_TODO_EN_UN_PASO.sql (djangue_groups,
// djangue_members, djangue_contributions, djangue_penalties, djangue_payouts,
// djangue_wallets, djangue_notifications). El dinero no se inventa aqui: cada
// cuota se debita con ledger_post y cada entrega se abona con otro asiento
// balanceado contra SYS-SUSPENSE, que es donde queda el pozo mientras se reparte.

const DJ_FRECUENCIAS = {
  daily:   { dias: 1,   etiqueta: 'diaria' },
  weekly:  { dias: 7,   etiqueta: 'semanal' },
  monthly: { dias: 30,  etiqueta: 'mensual' },
  annual:  { dias: 365, etiqueta: 'anual' },
};

const djNum = (v) => Number(v || 0);
const djFrecuencia = (f) => DJ_FRECUENCIAS[String(f || '').toLowerCase()] || null;
const djFechaFin = (frecuencia, desde) => {
  const dias = (djFrecuencia(frecuencia) || DJ_FRECUENCIAS.monthly).dias;
  return new Date(new Date(desde || Date.now()).getTime() + dias * 86400000);
};
const djSoloDigitos = (v) => String(v || '').replace(/\D/g, '');

// Las rutas existen antes que el SQL en algunos entornos: si falta una tabla se
// responde 502 con un codigo propio en vez de un 500 mudo, para saber que hay
// que pegar el esquema.
const djFaltaEsquema = (error) =>
  /relation .* does not exist|no existe la relaci[oó]n|Could not find the table/i.test(String(error && error.message || ''));
const djFalloEsquema = (res, error) => {
  if (djFaltaEsquema(error)) {
    res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    return true;
  }
  return false;
};

const djUsuarios = async (ids) => {
  const limpios = [...new Set((ids || []).filter(Boolean))];
  if (!limpios.length) return {};
  const { data } = await supabase.from('users').select('id, full_name, phone, avatar_url').in('id', limpios);
  return Object.fromEntries((data || []).map(u => [u.id, u]));
};

const djBuscarUsuarioPorTelefono = async (telefono) => {
  const digitos = djSoloDigitos(telefono);
  if (digitos.length < 6) return null;
  const cola = digitos.slice(-9);
  const { data } = await supabase.from('users').select('id, full_name, phone, avatar_url')
    .like('phone', `%${cola}`).limit(5);
  const fila = (data || []).find(u => djSoloDigitos(u.phone).slice(-9) === cola);
  return fila || null;
};

// Carga todo lo que necesitan el detalle, el pago y las vistas de rol.
const djCargar = async (userId, groupId) => {
  const { data: grupo, error } = await supabase.from('djangue_groups').select('*').eq('id', groupId).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { djSchema: djFaltaEsquema(error) });
  if (!grupo) return null;

  const [{ data: miembros }, { data: wallet }, { data: contribuciones }, { data: pagos }, { data: moras }] = await Promise.all([
    supabase.from('djangue_members').select('*').eq('group_id', groupId).order('turn_order', { ascending: true }),
    supabase.from('djangue_wallets').select('*').eq('group_id', groupId).maybeSingle(),
    supabase.from('djangue_contributions').select('*').eq('group_id', groupId).order('created_at', { ascending: true }),
    supabase.from('djangue_payouts').select('*').eq('group_id', groupId).order('created_at', { ascending: true }),
    supabase.from('djangue_penalties').select('*').eq('group_id', groupId),
  ]);

  const filas = miembros || [];
  const activos = filas.filter(m => m.status !== 'removed');
  const usuarios = await djUsuarios(filas.map(m => m.user_id));
  const miFila = filas.find(m => m.user_id === userId) || null;
  const miRol = grupo.owner_id === userId ? 'owner'
    : grupo.secretary_id === userId ? 'secretary'
      : miFila && miFila.status !== 'removed' ? 'member' : 'visitante';
  const beneficiario = activos.find(m => Number(m.turn_order) === Number(grupo.current_turn)) || null;
  const turnoActual = Number(grupo.current_turn) || 1;
  const delTurno = (contribuciones || []).filter(c => Number(c.turn_number) === turnoActual);

  return {
    grupo,
    miembros: filas,
    activos,
    usuarios,
    wallet: wallet || null,
    contribuciones: contribuciones || [],
    pagos: pagos || [],
    moras: moras || [],
    miFila,
    miRol,
    beneficiario,
    turnoActual,
    delTurno,
  };
};

const djPozoEsperado = (grupo, activos) => {
  // El beneficiario del turno no aporta: recibe la cuota de los demas.
  const aportantes = Math.max(0, activos.length - 1);
  return roundAmount(djNum(grupo.quota_amount) * aportantes);
};

// Un asiento por cuota. La clave de idempotencia lleva grupo, turno y usuario:
// reintentar el pago no cobra dos veces.
const djCobrarCuota = async ({ grupo, userId }) => {
  const quota = roundAmount(djNum(grupo.quota_amount));
  const key = `DJG-${grupo.id}-T${grupo.current_turn}-${userId}`;
  const { data, error } = await supabase.rpc('ledger_post', {
    p_user_id: userId,
    p_operation: 'pago_servicio',
    p_idempotency_key: key,
    p_concept: `Cuota djangue ${grupo.name} turno ${grupo.current_turn}`,
    p_lines: [
      { wallet_user_id: userId, entry_type: 'debit', amount: quota },
      { account: 'SYS-SUSPENSE', entry_type: 'credit', amount: quota },
    ],
    p_reference: `${grupo.id}:${key}`,
  });
  if (error) {
    const sinSaldo = /saldo insuficiente/i.test(error.message || '');
    return { ok: false, http: sinSaldo ? 400 : 500, code: sinSaldo ? 'INSUFFICIENT_BALANCE' : 'CHARGE_FAILED', message: sinSaldo ? 'Saldo insuficiente' : 'No se pudo cobrar la cuota' };
  }
  return { ok: true, journal: data || {} };
};

const djEntregarPozo = async ({ grupo, beneficiario, monto }) => {
  const key = `DJGP-${grupo.id}-T${grupo.current_turn}`;
  const { data, error } = await supabase.rpc('ledger_post', {
    p_user_id: beneficiario.user_id,
    p_operation: 'reembolso',
    p_idempotency_key: key,
    p_concept: `Entrega djangue ${grupo.name} turno ${grupo.current_turn}`,
    p_lines: [
      { account: 'SYS-SUSPENSE', entry_type: 'debit', amount: roundAmount(monto) },
      { wallet_user_id: beneficiario.user_id, entry_type: 'credit', amount: roundAmount(monto) },
    ],
    p_reference: `${grupo.id}:${key}`,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, journal: data || {} };
};

// GET /api/djangue/my-list — va antes que /:id para que no lo capture el comodin.
app.get('/api/djangue/my-list', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: filas, error } = await supabase.from('djangue_members').select('*').eq('user_id', uid).neq('status', 'removed');
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: 'No se pudieron leer tus djangues', code: 'DJANGUE_UNAVAILABLE' }); }
    const ids = (filas || []).map(f => f.group_id);
    if (!ids.length) return res.json({ admin: [], member: [] });

    const [{ data: grupos }, { data: miembros }, { data: wallets }, { data: contribs }] = await Promise.all([
      supabase.from('djangue_groups').select('*').in('id', ids),
      supabase.from('djangue_members').select('group_id,user_id,turn_order,status').in('group_id', ids),
      supabase.from('djangue_wallets').select('group_id,balance,currency').in('group_id', ids),
      supabase.from('djangue_contributions').select('group_id,user_id,turn_number,status').in('group_id', ids),
    ]);

    const admin = [], member = [];
    for (const g of grupos || []) {
      const propios = (miembros || []).filter(m => m.group_id === g.id && m.status !== 'removed');
      const wallet = (wallets || []).find(w => w.group_id === g.id);
      const turno = Number(g.current_turn) || 1;
      const beneficiario = propios.find(m => Number(m.turn_order) === turno);
      const mio = propios.find(m => m.user_id === uid);
      const pagada = (contribs || []).some(c => c.group_id === g.id && c.user_id === uid && Number(c.turn_number) === turno && c.status === 'paid');
      const rol = g.owner_id === uid ? 'owner' : g.secretary_id === uid ? 'secretary' : 'member';
      const fila = {
        id: g.id,
        name: g.name,
        logo_url: g.logo_url,
        frequency: g.frequency,
        quota_amount: djNum(g.quota_amount),
        currency: g.currency,
        my_role: rol,
        my_turn_order: mio ? Number(mio.turn_order) : null,
        current_turn: turno,
        total_turns: Number(g.total_turns) || 0,
        is_my_turn: !!beneficiario && beneficiario.user_id === uid,
        paid_current_turn: pagada,
        my_paid_this_turn: pagada,
        member_count: propios.length,
        wallet_balance: wallet ? djNum(wallet.balance) : 0,
        next_payout_at: g.next_payout_at,
        status: g.status,
      };
      (rol === 'owner' || rol === 'secretary' ? admin : member).push(fila);
    }
    res.json({ admin, member });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/djangues — directorio plano de MIS tandas con mi papel en cada una.
// No se listan las tandas ajenas: cualquiera podria leer nombres y telefonos.
app.get('/api/djangues', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: mias, error: errMias } = await supabase.from('djangue_members')
      .select('group_id').eq('user_id', uid).neq('status', 'removed');
    if (errMias) { if (djFalloEsquema(res, errMias)) return; return res.status(502).json({ message: 'No se pudieron listar los djangues', code: 'DJANGUE_UNAVAILABLE' }); }
    const ids = [...new Set((mias || []).map(m => m.group_id))];
    if (!ids.length) return res.json([]);

    const { data: grupos, error } = await supabase.from('djangue_groups').select('*')
      .in('id', ids).order('created_at', { ascending: false });
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: 'No se pudieron listar los djangues', code: 'DJANGUE_UNAVAILABLE' }); }

    const [{ data: miembros }, { data: wallets }, { data: contribs }] = await Promise.all([
      supabase.from('djangue_members').select('group_id,user_id,turn_order,status').in('group_id', ids),
      supabase.from('djangue_wallets').select('group_id,balance,currency').in('group_id', ids),
      supabase.from('djangue_contributions').select('group_id,user_id,turn_number,status').in('group_id', ids),
    ]);

    const salida = (grupos || []).map(g => {
      const propios = (miembros || []).filter(m => m.group_id === g.id && m.status !== 'removed');
      const wallet = (wallets || []).find(w => w.group_id === g.id);
      const turno = Number(g.current_turn) || 1;
      const beneficiario = propios.find(m => Number(m.turn_order) === turno);
      const mio = propios.find(m => m.user_id === uid);
      const rol = g.owner_id === uid ? 'owner' : g.secretary_id === uid ? 'secretary' : mio ? 'member' : 'visitante';
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        logo_url: g.logo_url,
        frequency: g.frequency,
        quota_amount: djNum(g.quota_amount),
        currency: g.currency,
        status: g.status,
        current_turn: turno,
        total_turns: Number(g.total_turns) || 0,
        next_payout_at: g.next_payout_at,
        wallet_balance: wallet ? djNum(wallet.balance) : 0,
        member_count: propios.length,
        my_role: rol,
        my_turn_order: mio ? Number(mio.turn_order) : null,
        my_paid_this_turn: (contribs || []).some(c => c.group_id === g.id && c.user_id === uid && Number(c.turn_number) === turno && c.status === 'paid'),
        is_my_turn: !!beneficiario && beneficiario.user_id === uid,
      };
    });
    res.json(salida);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue — crear la tanda. El dueno entra como primer turno.
app.post('/api/djangue', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { name, description, frequency, quota_amount, max_members, secretary_phone, logo_url } = req.body || {};
    const freq = djFrecuencia(frequency);
    const quota = roundAmount(djNum(quota_amount));
    const maxMiembros = Number(max_members) || 12;
    if (!String(name || '').trim()) return res.status(400).json({ message: 'El nombre es obligatorio', code: 'VALIDATION_ERROR' });
    if (!freq) return res.status(400).json({ message: 'Frecuencia no valida', code: 'VALIDATION_ERROR' });
    if (!(quota > 0)) return res.status(400).json({ message: 'La cuota debe ser mayor que cero', code: 'VALIDATION_ERROR' });
    if (maxMiembros < 2 || maxMiembros > 50) return res.status(400).json({ message: 'El maximo de integrantes va de 2 a 50', code: 'VALIDATION_ERROR' });

    let secretario = null;
    if (secretary_phone && String(secretary_phone).trim()) {
      secretario = await djBuscarUsuarioPorTelefono(secretary_phone);
      if (!secretario) return res.status(400).json({ message: 'No hay ningun usuario con ese telefono', code: 'SECRETARY_NOT_FOUND' });
      if (secretario.id === uid) secretario = null;
    }

    const inicio = new Date();
    const fin = djFechaFin(freq.dias === 1 ? 'daily' : frequency, inicio);
    const { data: grupo, error } = await supabase.from('djangue_groups').insert({
      name: String(name).trim(),
      description: description ? String(description).trim() : null,
      logo_url: logo_url ? String(logo_url) : null,
      frequency: String(frequency).toLowerCase(),
      quota_amount: quota,
      currency: 'XAF',
      max_members: maxMiembros,
      owner_id: uid,
      secretary_id: secretario ? secretario.id : null,
      current_turn: 1,
      total_turns: secretario ? 2 : 1,
      period_start_date: inicio.toISOString(),
      period_end_date: fin.toISOString(),
      next_payout_at: fin.toISOString(),
    }).select('*').maybeSingle();
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'GROUP_CREATE_FAILED' }); }

    await supabase.from('djangue_wallets').insert({ group_id: grupo.id, balance: 0, currency: 'XAF' });
    const filas = [{ group_id: grupo.id, user_id: uid, turn_order: 1, status: 'active' }];
    if (secretario) filas.push({ group_id: grupo.id, user_id: secretario.id, turn_order: 2, status: 'active' });
    const { error: errMiembros } = await supabase.from('djangue_members').insert(filas);
    if (errMiembros) {
      await supabase.from('djangue_groups').delete().eq('id', grupo.id);
      if (djFalloEsquema(res, errMiembros)) return;
      return res.status(502).json({ message: errMiembros.message, code: 'GROUP_CREATE_FAILED' });
    }
    await supabase.from('djangue_groups').update({ total_turns: filas.length }).eq('id', grupo.id);

    await logAudit(uid, 'djangue_create', 'djangue', grupo.id, { quota, frequency, max_members: maxMiembros });
    res.status(201).json({ ...grupo, total_turns: filas.length, group: { ...grupo, total_turns: filas.length }, id: grupo.id });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/djangue/:id — detalle completo (lo comparten detalle, chat-info, pagos y ajustes).
app.get('/api/djangue/:id', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol === 'visitante') return res.status(403).json({ message: 'No participas en este djangue', code: 'FORBIDDEN' });
    const g = d.grupo;
    const pagadas = d.contribuciones.filter(c => c.status === 'paid');
    const pagadasTurno = d.delTurno.filter(c => c.status === 'paid');
    res.json({
      ...g,
      quota_amount: djNum(g.quota_amount),
      total_turns: Number(g.total_turns) || 0,
      current_turn: d.turnoActual,
      my_role: d.miRol,
      my_turn_number: d.miFila ? d.miFila.turn_order : null,
      is_my_turn: !!d.beneficiario && d.beneficiario.user_id === req.user.id,
      wallet: {
        balance: d.wallet ? djNum(d.wallet.balance) : 0,
        currency: (d.wallet && d.wallet.currency) || g.currency || 'XAF',
      },
      members: d.miembros.filter(m => m.status !== 'removed').map(m => ({
        id: m.id,
        user_id: m.user_id,
        turn_order: m.turn_order,
        turn_number: m.turn_order,
        status: m.status,
        users: d.usuarios[m.user_id] || null,
      })),
      current_turn_contributions: d.delTurno.map(c => ({
        id: c.id,
        status: c.status,
        amount: djNum(c.amount),
        user_id: c.user_id,
        justification_note: c.justification_note || null,
        djangue_members: { user_id: c.user_id, turn_number: c.turn_number },
      })),
      paid_count: pagadas.length,
      paid_count_this_turn: pagadasTurno.length,
      total_paid_this_turn: roundAmount(pagadasTurno.reduce((s, c) => s + djNum(c.amount), 0)),
      expected_total_this_turn: djPozoEsperado(g, d.activos),
    });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// PATCH /api/djangue/:id — ajustes. Lo financiero se cierra en cuanto hay un pago.
app.patch('/api/djangue/:id', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador puede cambiar el djangue', code: 'FORBIDDEN' });

    const b = req.body || {};
    const parche = {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return res.status(400).json({ message: 'El nombre no puede quedar vacio', code: 'VALIDATION_ERROR' });
      parche.name = String(b.name).trim();
    }
    if (b.slogan !== undefined) parche.slogan = b.slogan ? String(b.slogan) : null;
    if (b.description !== undefined) parche.description = b.description ? String(b.description) : null;
    if (b.logo_url !== undefined) parche.logo_url = b.logo_url ? String(b.logo_url) : null;
    if (b.penalty_percent !== undefined) parche.penalty_percent = Math.max(0, Math.min(100, djNum(b.penalty_percent)));
    if (b.notification_days_before !== undefined) parche.notification_days_before = Math.max(0, Number(b.notification_days_before) || 0);
    if (b.notification_final_days !== undefined) parche.notification_final_days = Math.max(0, Number(b.notification_final_days) || 0);
    if (b.status === 'active' || b.status === 'paused') parche.status = b.status;

    const yaPago = d.contribuciones.some(c => c.status === 'paid');
    if (!yaPago) {
      if (b.frequency !== undefined) {
        if (!djFrecuencia(b.frequency)) return res.status(400).json({ message: 'Frecuencia no valida', code: 'VALIDATION_ERROR' });
        parche.frequency = String(b.frequency).toLowerCase();
      }
      if (b.quota_amount !== undefined) {
        if (!(djNum(b.quota_amount) > 0)) return res.status(400).json({ message: 'La cuota debe ser mayor que cero', code: 'VALIDATION_ERROR' });
        parche.quota_amount = roundAmount(djNum(b.quota_amount));
      }
      if (b.max_members !== undefined) {
        const max = Number(b.max_members);
        if (max < d.activos.length) return res.status(400).json({ message: `Ya hay ${d.activos.length} integrantes`, code: 'MAX_MEMBERS' });
        if (max > 50) return res.status(400).json({ message: 'El maximo es 50', code: 'VALIDATION_ERROR' });
        parche.max_members = max;
      }
    }
    parche.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('djangue_groups').update(parche).eq('id', d.grupo.id).select('*').maybeSingle();
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'GROUP_UPDATE_FAILED' }); }
    await logAudit(req.user.id, 'djangue_update', 'djangue', d.grupo.id, { campos: Object.keys(parche), bloqueado_por_pagos: yaPago });
    res.json({ ...data, financiero_editable: !yaPago });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue/:id/members y /add-member — la app usa las dos para lo mismo.
const djAgregarMiembro = async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador puede agregar integrantes', code: 'FORBIDDEN' });

    const persona = await djBuscarUsuarioPorTelefono((req.body || {}).phone);
    if (!persona) return res.status(404).json({ message: 'No hay ningun usuario con ese telefono', code: 'USER_NOT_FOUND' });
    if (d.grupo.owner_id === persona.id) return res.status(400).json({ message: 'El dueno ya esta en el djangue', code: 'ALREADY_MEMBER' });

    const existente = d.miembros.find(m => m.user_id === persona.id);
    if (existente && existente.status !== 'removed') return res.status(400).json({ message: 'Ese usuario ya es integrante', code: 'ALREADY_MEMBER' });
    if (d.activos.length >= Number(d.grupo.max_members || 12)) return res.status(400).json({ message: 'El djangue ya esta lleno', code: 'GROUP_FULL' });

    const siguiente = d.miembros.reduce((max, m) => Math.max(max, Number(m.turn_order) || 0), 0) + 1;
    let miembro;
    if (existente) {
      const { data, error } = await supabase.from('djangue_members')
        .update({ status: 'active', turn_order: siguiente, joined_at: new Date().toISOString() })
        .eq('id', existente.id).select('*').maybeSingle();
      if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'MEMBER_ADD_FAILED' }); }
      miembro = data;
    } else {
      const { data, error } = await supabase.from('djangue_members')
        .insert({ group_id: d.grupo.id, user_id: persona.id, turn_order: siguiente, status: 'active' })
        .select('*').maybeSingle();
      if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'MEMBER_ADD_FAILED' }); }
      miembro = data;
    }
    await supabase.from('djangue_groups').update({ total_turns: d.activos.length + 1, updated_at: new Date().toISOString() }).eq('id', d.grupo.id);
    await logAudit(req.user.id, 'djangue_add_member', 'djangue', d.grupo.id, { user_id: persona.id, turn_order: siguiente });
    res.status(201).json({ member: miembro, user: persona, turn_order: siguiente });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
};
app.post('/api/djangue/:id/members', auth, djAgregarMiembro);
app.post('/api/djangue/:id/add-member', auth, djAgregarMiembro);

// DELETE /api/djangue/:id/remove-member — el id es el del renglon de miembro.
app.delete('/api/djangue/:id/remove-member', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador puede quitar integrantes', code: 'FORBIDDEN' });

    const memberId = (req.body || {}).member_id;
    const fila = d.miembros.find(m => m.id === memberId);
    if (!fila) return res.status(404).json({ message: 'Ese integrante no esta en el djangue', code: 'MEMBER_NOT_FOUND' });
    if (fila.user_id === d.grupo.owner_id) return res.status(400).json({ message: 'El dueno no se puede quitar', code: 'OWNER_PROTECTED' });
    if (Number(fila.turn_order) === d.turnoActual) return res.status(400).json({ message: 'No se puede quitar al integrante que recibe este turno', code: 'BENEFICIARY_PROTECTED' });

    const { error } = await supabase.from('djangue_members').update({ status: 'removed' }).eq('id', fila.id);
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'MEMBER_REMOVE_FAILED' }); }
    await supabase.from('djangue_groups').update({ total_turns: Math.max(1, d.activos.length - 1), updated_at: new Date().toISOString() }).eq('id', d.grupo.id);
    await logAudit(req.user.id, 'djangue_remove_member', 'djangue', d.grupo.id, { member_id: fila.id, user_id: fila.user_id });
    res.json({ ok: true, member_id: fila.id });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue/:id/ensure-chat — vincula el chat que el cliente acaba de crear.
app.post('/api/djangue/:id/ensure-chat', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.grupo.chat_group_id) return res.json({ chat_group_id: d.grupo.chat_group_id });

    let chatId = (req.body || {}).chat_group_id || null;
    if (chatId) {
      const { data: chat } = await supabase.from('chats').select('id, created_by').eq('id', chatId).maybeSingle();
      if (!chat || chat.created_by !== req.user.id) chatId = null;
    }
    if (!chatId) {
      const { data: chats } = await supabase.from('chats').select('id, name, created_at')
        .eq('created_by', req.user.id).eq('type', 'group')
        .order('created_at', { ascending: false }).limit(20);
      const buscado = `💰 ${d.grupo.name}`;
      const encontrado = (chats || []).find(c => c.name === buscado);
      chatId = encontrado ? encontrado.id : null;
    }
    if (!chatId) return res.status(400).json({ message: 'No se encontro el chat del djangue', code: 'CHAT_NOT_FOUND' });

    const { error } = await supabase.from('djangue_groups').update({ chat_group_id: chatId, updated_at: new Date().toISOString() }).eq('id', d.grupo.id);
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'CHAT_LINK_FAILED' }); }
    res.json({ ok: true, chat_group_id: chatId });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// GET /api/djangue/:id/member-view — lo que ve un integrante raso.
app.get('/api/djangue/:id/member-view', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (!d.miFila || d.miFila.status === 'removed') return res.status(403).json({ message: 'No participas en este djangue', code: 'FORBIDDEN' });

    const g = d.grupo;
    const uid = req.user.id;
    const cuota = djNum(g.quota_amount);
    const activos = d.activos.length;
    const totalTurnos = Number(g.total_turns) || activos;
    const miTurno = Number(d.miFila.turn_order);
    const esBeneficiario = !!d.beneficiario && d.beneficiario.user_id === uid;
    const miContribucion = d.delTurno.find(c => c.user_id === uid) || null;
    const pagada = !!miContribucion && miContribucion.status === 'paid';
    const justificada = !!miContribucion && miContribucion.status === 'justified';
    const vueltas = ((miTurno - d.turnoActual) % Math.max(totalTurnos, 1) + Math.max(totalTurnos, 1)) % Math.max(totalTurnos, 1);
    const misContribuciones = d.contribuciones.filter(c => c.user_id === uid && c.status === 'paid');
    const misPagos = d.pagos.filter(p => p.beneficiary_id === uid && p.status === 'completed');
    const moras = d.moras.filter(p => p.user_id === uid && p.status !== 'paid');
    const fechaBase = g.next_payout_at ? new Date(g.next_payout_at) : new Date();
    const fechaMia = new Date(fechaBase.getTime() + vueltas * (djFrecuencia(g.frequency) || DJ_FRECUENCIAS.monthly).dias * 86400000);

    res.json({
      group_id: g.id,
      group_name: g.name,
      group_logo: g.logo_url,
      frequency: g.frequency,
      currency: g.currency,
      quota_amount: cuota,
      chat_group_id: g.chat_group_id,
      status: g.status,
      current_turn: d.turnoActual,
      total_turns: totalTurnos,
      my_turn_order: miTurno,
      is_my_turn: esBeneficiario,
      turns_until_mine: esBeneficiario ? 0 : vueltas,
      my_turn_date_estimate: esBeneficiario ? null : fechaMia.toISOString(),
      expected_payout: roundAmount(cuota * Math.max(0, activos - 1)),
      paid_current_turn: esBeneficiario ? true : pagada,
      amount_paid_current_turn: pagada ? djNum(miContribucion.amount) : 0,
      amount_owed: esBeneficiario || pagada || justificada ? 0 : cuota,
      has_justified: justificada,
      total_paid: roundAmount(misContribuciones.reduce((s, c) => s + djNum(c.amount), 0)),
      total_received: roundAmount(misPagos.reduce((s, p) => s + djNum(p.amount), 0)),
      turns_received: misPagos.length,
      payment_streak: misContribuciones.length,
      on_time_percentage: misContribuciones.length + moras.length
        ? Math.round((misContribuciones.length / (misContribuciones.length + moras.length)) * 100) : 100,
      pending_penalties: roundAmount(moras.reduce((s, p) => s + djNum(p.penalty_amount), 0)),
      total_penalties_paid: roundAmount(moras.filter(p => p.status === 'paid').reduce((s, p) => s + djNum(p.penalty_amount), 0)),
      my_contributions: d.contribuciones.filter(c => c.user_id === uid).map(c => ({
        id: c.id, turn_number: c.turn_number, amount: djNum(c.amount), status: c.status, paid_at: c.paid_at,
      })).sort((a, b) => new Date(b.paid_at || 0) - new Date(a.paid_at || 0)),
      my_payouts: misPagos.map(p => ({
        id: p.id, turn_number: p.turn_number, amount: djNum(p.amount), received_at: p.paid_at,
      })),
    });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// GET /api/djangue/:id/secretary-view — cobros del turno, con `user` en singular.
app.get('/api/djangue/:id/secretary-view', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador ve el panel', code: 'FORBIDDEN' });

    const g = d.grupo;
    const miembros = d.activos.map(m => {
      const contrib = d.delTurno.find(c => c.user_id === m.user_id) || null;
      const usuario = d.usuarios[m.user_id] || {};
      return {
        id: m.id,
        user_id: m.user_id,
        turn_order: m.turn_order,
        status: m.status,
        user: { id: m.user_id, full_name: usuario.full_name || null, phone: usuario.phone || null, avatar_url: usuario.avatar_url || null },
        paid_current_turn: !!contrib && contrib.status === 'paid',
        has_justified: !!contrib && contrib.status === 'justified',
        justification_note: contrib ? contrib.justification_note || null : null,
        is_current_beneficiary: !!d.beneficiario && d.beneficiario.user_id === m.user_id,
      };
    });
    const pagados = miembros.filter(m => m.paid_current_turn).length;
    res.json({
      id: g.id,
      name: g.name,
      current_turn: d.turnoActual,
      total_turns: Number(g.total_turns) || miembros.length,
      quota_amount: djNum(g.quota_amount),
      currency: g.currency,
      penalty_percent: djNum(g.penalty_percent),
      notification_days_before: Number(g.notification_days_before) || 0,
      notification_final_days: Number(g.notification_final_days) || 0,
      period_end_date: g.period_end_date,
      chat_group_id: g.chat_group_id,
      status: g.status,
      members: miembros,
      paid_count: pagados,
      pending_count: miembros.filter(m => !m.paid_current_turn && !m.is_current_beneficiary && !m.has_justified).length,
    });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// GET /api/djangue/:id/admin-stats — agregados de la tanda.
app.get('/api/djangue/:id/admin-stats', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador ve las estadisticas', code: 'FORBIDDEN' });

    const g = d.grupo;
    const cuota = djNum(g.quota_amount);
    const totalTurnos = Number(g.total_turns) || d.activos.length || 1;
    const pagadas = d.contribuciones.filter(c => c.status === 'paid');
    const entregas = d.pagos.filter(p => p.status === 'completed');
    const moras = d.moras;
    const cumplidas = new Set(entregas.map(p => Number(p.turn_number))).size;

    const porUsuario = {};
    for (const c of pagadas) {
      porUsuario[c.user_id] = porUsuario[c.user_id] || { total: 0, pagos: 0 };
      porUsuario[c.user_id].total += djNum(c.amount);
      porUsuario[c.user_id].pagos += 1;
    }
    const morasPorUsuario = {};
    for (const p of moras.filter(x => x.status !== 'paid')) {
      morasPorUsuario[p.user_id] = (morasPorUsuario[p.user_id] || 0) + djNum(p.penalty_amount);
    }

    const periodoDias = (djFrecuencia(g.frequency) || DJ_FRECUENCIAS.monthly).dias;
    const basePago = g.next_payout_at ? new Date(g.next_payout_at).getTime() : Date.now();
    const proximos = d.activos
      .filter(m => Number(m.turn_order) >= d.turnoActual)
      .sort((a, b) => Number(a.turn_order) - Number(b.turn_order))
      .slice(0, 5)
      .map((m) => ({
        turn_number: Number(m.turn_order),
        beneficiary_name: (d.usuarios[m.user_id] || {}).full_name || null,
        beneficiary_avatar: (d.usuarios[m.user_id] || {}).avatar_url || null,
        estimated_date: new Date(basePago + (Number(m.turn_order) - d.turnoActual) * periodoDias * 86400000).toISOString(),
        expected_amount: roundAmount(cuota * Math.max(0, d.activos.length - 1)),
      }));

    const onTime = pagadas.length;
    const late = moras.length;
    res.json({
      group_id: g.id,
      group_name: g.name,
      group_logo: g.logo_url,
      currency: g.currency,
      total_collected: roundAmount(pagadas.reduce((s, c) => s + djNum(c.amount), 0)),
      total_delivered: roundAmount(entregas.reduce((s, p) => s + djNum(p.amount), 0)),
      total_penalties: roundAmount(moras.reduce((s, p) => s + djNum(p.penalty_amount), 0)),
      active_members: d.activos.length,
      completed_turns: cumplidas,
      total_turns: totalTurnos,
      current_turn: d.turnoActual,
      overall_compliance_rate: onTime + late ? Math.round((onTime / (onTime + late)) * 100) : 100,
      on_time_payments: onTime,
      late_payments: late,
      upcoming_turns: proximos,
      recent_payouts: entregas.slice(-5).reverse().map(p => ({
        turn_number: p.turn_number,
        beneficiary_name: (d.usuarios[p.beneficiary_id] || {}).full_name || null,
        amount: djNum(p.amount),
        delivered_at: p.paid_at,
      })),
      top_contributors: Object.entries(porUsuario)
        .sort((a, b) => b[1].total - a[1].total).slice(0, 5)
        .map(([userId, v]) => ({
          user_name: (d.usuarios[userId] || {}).full_name || null,
          total_contributed: roundAmount(v.total),
          on_time_rate: v.pagos ? 100 : 0,
        })),
      members_with_penalties: Object.entries(morasPorUsuario).map(([userId, total]) => ({
        user_name: (d.usuarios[userId] || {}).full_name || null,
        pending_amount: roundAmount(total),
      })),
    });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue/:id/pay — el integrante paga su cuota del turno actual.
app.post('/api/djangue/:id/pay', auth, walletLimiter, async (req, res) => {
  try {
    const uid = req.user.id;
    const d = await djCargar(uid, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (!d.miFila || d.miFila.status === 'removed') return res.status(403).json({ message: 'No participas en este djangue', code: 'FORBIDDEN' });
    if (d.grupo.status !== 'active') return res.status(400).json({ message: 'El djangue no esta activo', code: 'GROUP_NOT_ACTIVE' });
    if (d.beneficiario && d.beneficiario.user_id === uid) {
      return res.status(400).json({ message: 'Este turno te toca recibir, no pagar', code: 'BENEFICIARY_DOES_NOT_PAY' });
    }

    const previa = d.delTurno.find(c => c.user_id === uid) || null;
    if (previa && previa.status === 'paid') {
      return res.json({ ok: true, already: true, amount: djNum(previa.amount), new_balance: await readWalletBalance(uid), all_paid: false, message: 'Tu cuota de este turno ya estaba pagada' });
    }

    const pinCheck = await checkPinForOperation(uid, req.body?.pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    const cobro = await djCobrarCuota({ grupo: d.grupo, userId: uid });
    if (!cobro.ok) return res.status(cobro.http).json({ message: cobro.message, code: cobro.code });

    const journalId = cobro.journal && cobro.journal.journal_id ? cobro.journal.journal_id : null;
    const importe = roundAmount(djNum(d.grupo.quota_amount));
    const ahora = new Date().toISOString();
    if (previa) {
      await supabase.from('djangue_contributions').update({
        status: 'paid', amount: importe, paid_at: ahora, transaction_id: journalId,
      }).eq('id', previa.id);
    } else {
      await supabase.from('djangue_contributions').insert({
        group_id: d.grupo.id,
        member_id: d.miFila.id,
        user_id: uid,
        turn_number: d.turnoActual,
        amount: importe,
        status: 'paid',
        paid_at: ahora,
        transaction_id: journalId,
      });
    }
    const wallet = await supabase.from('djangue_wallets').select('balance').eq('group_id', d.grupo.id).maybeSingle();
    await supabase.from('djangue_wallets').update({
      balance: roundAmount(djNum(wallet.data && wallet.data.balance) + importe), updated_at: ahora,
    }).eq('group_id', d.grupo.id);

    const esperados = Math.max(0, d.activos.length - 1);
    const pagadasAhora = d.delTurno.filter(c => c.status === 'paid').length + (previa && previa.status === 'paid' ? 0 : 1);
    const allPaid = pagadasAhora >= esperados;
    await logAudit(uid, 'djangue_pay', 'djangue', d.grupo.id, { turn: d.turnoActual, amount: importe, journal_id: journalId });

    res.json({
      ok: true,
      amount: importe,
      new_balance: await readWalletBalance(uid),
      all_paid: allPaid,
      journal_id: journalId,
      message: allPaid
        ? `Todos pagaron el turno ${d.turnoActual}. El secretario ya puede entregar el pozo.`
        : `Cuota del turno ${d.turnoActual} pagada`,
    });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue/:id/justify — el integrante avisa de que no puede pagar.
const djJustificar = async (req, res, aFavorDeOtro) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    const body = req.body || {};
    let objetivo = d.miFila;
    if (aFavorDeOtro) {
      if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador justifica a otro', code: 'FORBIDDEN' });
      objetivo = d.miembros.find(m => m.id === body.member_id) || null;
      if (!objetivo) return res.status(404).json({ message: 'Ese integrante no esta en el djangue', code: 'MEMBER_NOT_FOUND' });
    } else if (!objetivo || objetivo.status === 'removed') {
      return res.status(403).json({ message: 'No participas en este djangue', code: 'FORBIDDEN' });
    }
    const nota = String(body.note || '').trim();
    if (!nota) return res.status(400).json({ message: 'Escribe el motivo', code: 'VALIDATION_ERROR' });

    const previa = d.delTurno.find(c => c.user_id === objetivo.user_id) || null;
    if (previa && previa.status === 'paid') return res.status(400).json({ message: 'Esa cuota ya esta pagada', code: 'ALREADY_PAID' });

    if (previa) {
      await supabase.from('djangue_contributions').update({ status: 'justified', justification_note: nota }).eq('id', previa.id);
    } else {
      await supabase.from('djangue_contributions').insert({
        group_id: d.grupo.id,
        member_id: objetivo.id,
        user_id: objetivo.user_id,
        turn_number: d.turnoActual,
        amount: roundAmount(djNum(d.grupo.quota_amount)),
        status: 'justified',
        justification_note: nota,
      });
    }
    await logAudit(req.user.id, 'djangue_justify', 'djangue', d.grupo.id, { user_id: objetivo.user_id, turn: d.turnoActual, note: nota });
    res.json({ ok: true, status: 'justified', justification_note: nota });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
};
app.post('/api/djangue/:id/justify', auth, (req, res) => djJustificar(req, res, false));
app.post('/api/djangue/:id/justify-absence', auth, (req, res) => djJustificar(req, res, true));

// POST /api/djangue/:id/send-reminder — deja el recordatorio en la bandeja.
// El CHECK de djangue_notifications no admite 'secretary_manual': se usa un tipo valido.
app.post('/api/djangue/:id/send-reminder', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador envia recordatorios', code: 'FORBIDDEN' });

    const body = req.body || {};
    let destinatarios;
    if (body.member_id) {
      const fila = d.miembros.find(m => m.id === body.member_id);
      if (!fila) return res.status(404).json({ message: 'Ese integrante no esta en el djangue', code: 'MEMBER_NOT_FOUND' });
      destinatarios = [fila];
    } else {
      destinatarios = d.activos.filter(m => {
        const c = d.delTurno.find(x => x.user_id === m.user_id);
        const esBeneficiario = !!d.beneficiario && d.beneficiario.user_id === m.user_id;
        return !esBeneficiario && (!c || (c.status !== 'paid' && c.status !== 'justified'));
      });
    }
    if (!destinatarios.length) return res.json({ ok: true, sent: 0, message: 'No hay cuotas pendientes' });

    const filas = destinatarios.map(m => ({
      group_id: d.grupo.id,
      user_id: m.user_id,
      type: 'reminder_daily',
      title: `Cuota pendiente - ${d.grupo.name}`,
      message: `Te falta la cuota del turno ${d.turnoActual} (${roundAmount(djNum(d.grupo.quota_amount))} ${d.grupo.currency}).`,
    }));
    const { error } = await supabase.from('djangue_notifications').insert(filas);
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'REMINDER_FAILED' }); }
    await logAudit(req.user.id, 'djangue_reminder', 'djangue', d.grupo.id, { enviados: filas.length, turn: d.turnoActual });
    res.json({ ok: true, sent: filas.length });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue/:id/manual-payout — entrega el pozo del turno al beneficiario.
app.post('/api/djangue/:id/manual-payout', auth, walletLimiter, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador entrega el pozo', code: 'FORBIDDEN' });
    if (!d.beneficiario) return res.status(400).json({ message: 'No hay beneficiario para este turno', code: 'NO_BENEFICIARY' });

    const pinCheck = await checkPinForOperation(req.user.id, req.body?.pin);
    if (!pinCheck.ok) return pinErrorResponse(res, pinCheck.code);

    const previo = d.pagos.find(p => Number(p.turn_number) === d.turnoActual && p.status === 'completed');
    if (previo) return res.json({ ok: true, already: true, payout: previo, amount: djNum(previo.amount) });

    const monto = roundAmount(d.delTurno.filter(c => c.status === 'paid').reduce((s, c) => s + djNum(c.amount), 0));
    if (!(monto > 0)) return res.status(400).json({ message: 'Todavia no hay cuotas cobradas en este turno', code: 'NOTHING_TO_PAY' });

    const entrega = await djEntregarPozo({ grupo: d.grupo, beneficiario: d.beneficiario, monto });
    if (!entrega.ok) return res.status(502).json({ message: entrega.message, code: 'PAYOUT_FAILED' });

    const ahora = new Date().toISOString();
    const { data: pago } = await supabase.from('djangue_payouts').insert({
      group_id: d.grupo.id,
      beneficiary_id: d.beneficiario.user_id,
      turn_number: d.turnoActual,
      amount: monto,
      expected_amount: djPozoEsperado(d.grupo, d.activos),
      status: 'completed',
      paid_at: ahora,
    }).select('*').maybeSingle();

    await supabase.from('djangue_wallets').update({
      balance: roundAmount(Math.max(0, djNum(d.wallet && d.wallet.balance) - monto)), updated_at: ahora,
    }).eq('group_id', d.grupo.id);
    await logAudit(req.user.id, 'djangue_payout', 'djangue', d.grupo.id, { turn: d.turnoActual, amount: monto, beneficiary: d.beneficiario.user_id, journal_id: entrega.journal.journal_id });
    res.json({ ok: true, payout: pago, amount: monto, journal_id: entrega.journal.journal_id });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/djangue/:id/advance-turn — cierra el turno y pasa al siguiente.
app.post('/api/djangue/:id/advance-turn', auth, async (req, res) => {
  try {
    const d = await djCargar(req.user.id, req.params.id);
    if (!d) return res.status(404).json({ message: 'Djangue no encontrado', code: 'GROUP_NOT_FOUND' });
    if (d.miRol !== 'owner' && d.miRol !== 'secretary') return res.status(403).json({ message: 'Solo el administrador avanza el turno', code: 'FORBIDDEN' });

    const entregado = d.pagos.some(p => Number(p.turn_number) === d.turnoActual && p.status === 'completed');
    if (!entregado) return res.status(400).json({ message: 'Primero entrega el pozo de este turno', code: 'PAYOUT_PENDING' });

    const totalTurnos = Number(d.grupo.total_turns) || d.activos.length || 1;
    const siguiente = d.turnoActual + 1;
    const fin = siguiente > totalTurnos ? d.grupo.period_end_date : djFechaFin(d.grupo.frequency).toISOString();
    const parche = siguiente > totalTurnos
      ? { status: 'completed', updated_at: new Date().toISOString() }
      : {
        current_turn: siguiente,
        period_start_date: new Date().toISOString(),
        period_end_date: fin,
        next_payout_at: fin,
        updated_at: new Date().toISOString(),
      };
    const { error } = await supabase.from('djangue_groups').update(parche).eq('id', d.grupo.id);
    if (error) { if (djFalloEsquema(res, error)) return; return res.status(502).json({ message: error.message, code: 'TURN_ADVANCE_FAILED' }); }

    await logAudit(req.user.id, 'djangue_advance', 'djangue', d.grupo.id, { desde: d.turnoActual, hacia: siguiente, completado: siguiente > totalTurnos });
    res.json({
      ok: true,
      new_turn: siguiente > totalTurnos ? d.turnoActual : siguiente,
      completed: siguiente > totalTurnos,
      message: siguiente > totalTurnos ? 'El djangue termino todos sus turnos' : `Ahora turno #${siguiente}`,
    });
  } catch (e) {
    if (e.djSchema) return res.status(502).json({ message: 'El esquema de djangue no esta en la base', code: 'DJANGUE_SCHEMA' });
    res.status(500).json({ message: e.message });
  }
});

// POST /api/upload/djangue-logo — multipart con campo `file`, devuelve `{ url }`.
app.post('/api/upload/djangue-logo', auth, async (req, res) => {
  try {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ message: 'Se espera multipart/form-data con el campo file', code: 'MULTIPART_REQUIRED' });
    }
    const busboy = require('busboy');
    const subida = await new Promise((resolve, reject) => {
      const bb = busboy({ headers: req.headers, limits: { fileSize: 8 * 1024 * 1024 } });
      let buffer = null;
      let mime = 'image/png';
      let nombre = 'logo.png';
      let visto = false;
      bb.on('file', (_campo, stream, info) => {
        visto = true;
        mime = info.mimeType || mime;
        nombre = info.filename || nombre;
        const trozos = [];
        stream.on('data', (t) => trozos.push(t));
        stream.on('limit', () => reject(new Error('La imagen supera 8 MB')));
        stream.on('end', () => { buffer = Buffer.concat(trozos); });
      });
      bb.on('filesLimit', () => reject(new Error('Solo se admite un archivo')));
      bb.on('finish', () => {
        if (!visto || !buffer || !buffer.length) return reject(new Error('No llego ningun archivo'));
        resolve({ buffer, mime, nombre });
      });
      bb.on('error', reject);
      req.pipe(bb);
    });

    const extension = (subida.nombre.match(/\.(png|jpe?g|webp|gif)$/i) || ['.png'])[0].toLowerCase();
    const ruta = `djangue/${req.user.id}/logo_${Date.now()}${extension}`;
    const { error: upErr } = await supabase.storage.from('chat-files').upload(ruta, subida.buffer, {
      contentType: subida.mime, upsert: true,
    });
    if (upErr) return res.status(502).json({ message: upErr.message, code: 'UPLOAD_FAILED' });
    const { data: urlData } = supabase.storage.from('chat-files').getPublicUrl(ruta);
    res.json({ url: urlData.publicUrl, path: ruta });
  } catch (e) {
    res.status(400).json({ message: e.message, code: 'UPLOAD_FAILED' });
  }
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

// Análisis rápido: intención detectada + respuesta que daría Lia.
const liaAnalyzeHandler = async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message
    : typeof req.body?.text === 'string' ? req.body.text : '';
  if (!message.trim()) {
    return res.status(400).json({ message: 'Falta el texto a analizar', code: 'VALIDATION_ERROR' });
  }
  const requestedLang = String(req.body?.lang || '').toLowerCase();
  const lang = LIA_LANGS.includes(requestedLang) ? requestedLang : 'es';
  const intent = liaDetectIntent(message);
  try {
    const reply = await liaAnswer(intent, message, lang, req.user.id, []);
    res.json({
      analysis: reply,
      reply,
      intent,
      lang,
      words: message.trim().split(/\s+/).length,
      characters: message.length,
    });
  } catch (e) {
    console.error('LIA analyze error:', e);
    res.status(500).json({ message: 'No se pudo analizar el texto', code: 'ANALYZE_ERROR' });
  }
};

app.post('/lia/analyze', auth, liaAnalyzeHandler);
app.post('/api/lia/analyze', auth, liaAnalyzeHandler);

const liaReadAudio = (req) => new Promise((resolve, reject) => {
  const busboy = require('busboy');
  const bb = busboy({ headers: req.headers, limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  let audio = null;
  const fields = {};
  bb.on('file', (_name, stream, info) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('limit', () => reject(new Error('AUDIO_TOO_LARGE')));
    stream.on('end', () => {
      audio = {
        buffer: Buffer.concat(chunks),
        filename: info?.filename || 'audio.m4a',
        mimeType: info?.mimeType || 'audio/m4a',
      };
    });
  });
  bb.on('field', (name, value) => { fields[name] = value; });
  bb.on('error', reject);
  bb.on('finish', () => resolve({ audio, fields }));
  req.pipe(bb);
});

const liaTranscribeHandler = async (req, res) => {
  const provider = liaProvider();
  if (!provider) {
    return res.status(501).json({
      message: 'El dictado necesita una clave de transcripción en el servidor (GROQ_API_KEY u OPENAI_API_KEY).',
      code: 'DICTATION_NOT_CONFIGURED',
    });
  }
  try {
    if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
      return res.status(400).json({ message: 'Envía el audio como multipart/form-data', code: 'VALIDATION_ERROR' });
    }
    const { audio, fields } = await liaReadAudio(req);
    if (!audio || !audio.buffer.length) {
      return res.status(400).json({ message: 'Audio vacío', code: 'VALIDATION_ERROR' });
    }

    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mimeType }), audio.filename);
    form.append('model', provider.sttModel);
    const requestedLang = String(fields.lang || '').toLowerCase();
    if (LIA_LANGS.includes(requestedLang)) form.append('language', requestedLang);

    const response = await fetch(`${provider.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.key}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn('LIA transcribe error:', provider.name, response.status, detail.slice(0, 200));
      return res.status(502).json({ message: 'No se pudo transcribir el audio', code: 'STT_FAILED' });
    }
    const data = await response.json();
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) {
      return res.status(422).json({ message: 'No se ha reconocido voz en el audio', code: 'STT_EMPTY' });
    }
    res.json({ text });
  } catch (e) {
    if (e?.message === 'AUDIO_TOO_LARGE') {
      return res.status(413).json({ message: 'El audio supera 15 MB', code: 'AUDIO_TOO_LARGE' });
    }
    console.error('LIA transcribe exception:', e);
    res.status(500).json({ message: 'Error al transcribir el audio', code: 'STT_ERROR' });
  }
};

app.post('/lia/transcribe', auth, liaTranscribeHandler);
app.post('/api/lia/transcribe', auth, liaTranscribeHandler);

// ── LIA: lectura de imágenes y documentos ─────────────────────────
const LIA_ATTACH_COPY = {
  es: {
    notConfigured: 'La lectura de archivos necesita una clave de IA en el servidor.',
    empty: 'El archivo llegó vacío. Inténtalo de nuevo.',
    tooLarge: 'El archivo supera 20 MB. Envíame uno más pequeño.',
    unsupported: 'No pude leer este archivo. Puedo con fotos, PDF, Word, Excel, TXT, CSV y RTF.',
    readError: 'No pude analizar el archivo ahora mismo. Inténtalo de nuevo en un momento.',
    video: 'Los vídeos todavía no se pueden analizar. Envíame una foto o un documento.',
    imagePrompt: 'Analiza esta imagen. Si contiene texto, transcríbelo; si es un recibo, factura o documento, resume los datos importantes (importes, fechas, nombres, números).',
    documentPrompt: 'Lee este documento y explícame lo importante de forma breve. Si el usuario hizo una pregunta, respóndela con el contenido.',
    rules: 'Acabas de recibir un archivo del usuario. Basa tu respuesta SOLO en su contenido real; no inventes datos que no aparezcan. Si el archivo no se puede leer, dilo con claridad. Si el usuario pide una acción de la app, explica en qué pantalla se hace.',
  },
  fr: {
    notConfigured: 'La lecture de fichiers nécessite une clé d\'IA sur le serveur.',
    empty: 'Le fichier est arrivé vide. Réessaie.',
    tooLarge: 'Le fichier dépasse 20 Mo. Envoie-moi un fichier plus petit.',
    unsupported: 'Je n\'ai pas pu lire ce fichier. Je peux lire les photos, PDF, Word, Excel, TXT, CSV et RTF.',
    readError: 'Je n\'ai pas pu analyser le fichier pour le moment. Réessaie dans un instant.',
    video: 'Les vidéos ne peuvent pas encore être analysées. Envoie-moi une photo ou un document.',
    imagePrompt: 'Analyse cette image. Si elle contient du texte, transcris-le ; s\'il s\'agit d\'un reçu, d\'une facture ou d\'un document, résume les informations importantes (montants, dates, noms, numéros).',
    documentPrompt: 'Lis ce document et explique-moi l\'essentiel brièvement. Si l\'utilisateur a posé une question, réponds-y à partir du contenu.',
    rules: 'Tu viens de recevoir un fichier de l\'utilisateur. Fonde ta réponse UNIQUEMENT sur son contenu réel ; n\'invente pas de données absentes. Si le fichier est illisible, dis-le clairement. Si l\'utilisateur demande une action de l\'app, explique sur quel écran elle se fait.',
  },
  en: {
    notConfigured: 'File reading needs an AI key on the server.',
    empty: 'The file arrived empty. Please try again.',
    tooLarge: 'The file is over 20 MB. Send me a smaller one.',
    unsupported: 'I couldn\'t read this file. I can read photos, PDF, Word, Excel, TXT, CSV and RTF.',
    readError: 'I couldn\'t analyze the file right now. Please try again in a moment.',
    video: 'Videos can\'t be analyzed yet. Send me a photo or a document.',
    imagePrompt: 'Analyze this image. If it contains text, transcribe it; if it\'s a receipt, invoice or document, summarize the important details (amounts, dates, names, numbers).',
    documentPrompt: 'Read this document and briefly explain what matters. If the user asked a question, answer it from the content.',
    rules: 'You just received a file from the user. Base your answer ONLY on its real content; do not invent details that aren\'t there. If the file can\'t be read, say so clearly. If the user asks for an app action, explain which screen does it.',
  },
  pt: {
    notConfigured: 'A leitura de ficheiros precisa de uma chave de IA no servidor.',
    empty: 'O ficheiro chegou vazio. Tenta novamente.',
    tooLarge: 'O ficheiro tem mais de 20 MB. Envia-me um mais pequeno.',
    unsupported: 'Não consegui ler este ficheiro. Consigo ler fotos, PDF, Word, Excel, TXT, CSV e RTF.',
    readError: 'Não consegui analisar o ficheiro agora. Tenta novamente daqui a pouco.',
    video: 'Os vídeos ainda não podem ser analisados. Envia-me uma foto ou um documento.',
    imagePrompt: 'Analisa esta imagem. Se contiver texto, transcreve-o; se for um recibo, fatura ou documento, resume os dados importantes (valores, datas, nomes, números).',
    documentPrompt: 'Lê este documento e explica-me o essencial de forma breve. Se o utilizador fez uma pergunta, responde com base no conteúdo.',
    rules: 'Acabaste de receber um ficheiro do utilizador. Baseia a tua resposta APENAS no conteúdo real; não inventes dados que não apareçam. Se o ficheiro não puder ser lido, diz isso com clareza. Se o utilizador pedir uma ação da app, explica em que ecrã se faz.',
  },
};

const liaReadUpload = (req) => new Promise((resolve, reject) => {
  const busboy = require('busboy');
  const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  let file = null;
  const fields = {};
  bb.on('file', (_name, stream, info) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => { size += chunk.length; chunks.push(chunk); });
    stream.on('limit', () => {
      const err = new Error('FILE_TOO_LARGE');
      err.fields = fields;
      reject(err);
    });
    stream.on('end', () => {
      file = {
        buffer: Buffer.concat(chunks),
        filename: info?.filename || 'archivo',
        mimeType: info?.mimeType || 'application/octet-stream',
        size,
      };
    });
  });
  bb.on('field', (name, value) => { fields[name] = value; });
  bb.on('error', reject);
  bb.on('finish', () => resolve({ file, fields }));
  req.pipe(bb);
});

const liaExtractDocumentText = async (buffer, filename, mimeType) => {
  const lower = String(filename || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  const ext = (lower.split('.').pop() || '').trim();
  if (mime === 'application/pdf' || ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return parsed?.text || '';
  }
  if (mime.includes('wordprocessingml') || ext === 'docx') {
    const mammoth = require('mammoth');
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed?.value || '';
  }
  if (mime.includes('spreadsheetml') || ['xlsx', 'xls', 'ods'].includes(ext)) {
    const XLSX = require('xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    return (book.SheetNames || []).slice(0, 8).map((sheet) => {
      const csv = XLSX.utils.sheet_to_csv(book.Sheets[sheet]);
      return `# ${sheet}\n${csv}`;
    }).join('\n\n');
  }
  if (ext === 'rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    return buffer.toString('utf8')
      .replace(/\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\[a-z]+-?\d* ?/gi, ' ')
      .replace(/[{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (mime.startsWith('text/') || ['txt', 'csv', 'md', 'json', 'xml', 'html', 'htm', 'log', 'srt', 'vtt'].includes(ext)) {
    return buffer.toString('utf8');
  }
  return '';
};

const liaVisionModels = (provider) => {
  if (provider.name === 'openai') return [process.env.LIA_VISION_MODEL || 'gpt-4o-mini'];
  return [...new Set([
    process.env.LIA_VISION_MODEL,
    'qwen/qwen3.8-27b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
  ].filter(Boolean))];
};

const liaAttachHandler = async (req, res) => {
  try {
    if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
      return res.status(400).json({ message: 'Envía el archivo como multipart/form-data', code: 'VALIDATION_ERROR' });
    }
    const { file, fields } = await liaReadUpload(req);
    const requestedLang = String(fields.lang || '').toLowerCase();
    const lang = LIA_LANGS.includes(requestedLang) ? requestedLang : 'es';
    const copy = LIA_ATTACH_COPY[lang];
    const provider = liaProvider();
    if (!provider) return res.status(501).json({ message: copy.notConfigured, code: 'ATTACH_NOT_CONFIGURED' });
    if (!file || !file.buffer.length) return res.status(400).json({ message: copy.empty, code: 'VALIDATION_ERROR' });

    const caption = String(fields.prompt || '').trim().slice(0, 1000);
    const mime = String(file.mimeType || '').toLowerCase();
    const ext = (String(file.filename || '').toLowerCase().split('.').pop() || '').trim();
    const isImage = mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp'].includes(ext);
    const isVideo = mime.startsWith('video/') || ['mp4', 'mov', 'm4v', 'avi', 'webm', 'mkv', '3gp'].includes(ext);
    if (isVideo) return res.status(415).json({ message: copy.video, code: 'ATTACH_VIDEO_UNSUPPORTED' });

    let userContent;
    let models;
    let attachmentKind = 'document';

    if (isImage) {
      attachmentKind = 'image';
      const imageMime = mime.startsWith('image/') ? mime : (ext === 'png' ? 'image/png' : 'image/jpeg');
      userContent = [
        { type: 'text', text: caption ? `${caption}\n\n${copy.imagePrompt}` : copy.imagePrompt },
        { type: 'image_url', image_url: { url: `data:${imageMime};base64,${file.buffer.toString('base64')}` } },
      ];
      models = liaVisionModels(provider);
    } else {
      let text = await liaExtractDocumentText(file.buffer, file.filename, file.mimeType);
      text = String(text || '').replace(/\u0000/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
      if (!text) return res.status(422).json({ message: copy.unsupported, code: 'ATTACH_UNSUPPORTED' });
      userContent = `${caption || copy.documentPrompt}\n\n--- ${file.filename} ---\n${text.slice(0, 20000)}`;
      models = [provider.chatModel];
    }

    const [{ data: profile }, wallet] = await Promise.all([
      supabase.from('users').select('full_name, city').eq('id', req.user.id).maybeSingle(),
      liaGetWallet(req.user.id),
    ]);
    const system = `${liaBuildSystem(lang, profile, wallet)}\n${copy.rules}`;

    let reply = null;
    let lastStatus = 0;
    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(`${provider.base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 700,
            messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          lastStatus = response.status;
          console.warn('LIA attach LLM error:', provider.name, model, response.status, (await response.text().catch(() => '')).slice(0, 200));
          continue;
        }
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) { reply = text.trim(); break; }
      } finally {
        clearTimeout(timer);
      }
    }
    if (!reply) {
      return res.status(502).json({ message: copy.readError, code: 'ATTACH_LLM_FAILED' });
    }
    reply = await liaEnsureLang(reply, lang);

    if (!isLocalUserId(req.user.id)) {
      try {
        const { error } = await supabase.from('lia_conversations').insert({
          user_id: req.user.id,
          message: `[${attachmentKind === 'image' ? 'Imagen' : 'Documento'}] ${file.filename}${caption ? `: ${caption}` : ''}`,
          reply,
        });
        if (error) console.warn('LIA attach history save failed:', error.message);
      } catch (e) {
        console.warn('LIA attach history save failed:', e?.message || e);
      }
    }

    res.json({
      reply,
      action: 'attachment',
      lang,
      attachment: { name: file.filename, kind: attachmentKind, mime: file.mimeType, size: file.size },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    if (e?.message === 'FILE_TOO_LARGE') {
      const requestedLang = String(e.fields?.lang || '').toLowerCase();
      const copy = LIA_ATTACH_COPY[LIA_LANGS.includes(requestedLang) ? requestedLang : 'es'];
      return res.status(413).json({ message: copy.tooLarge, code: 'FILE_TOO_LARGE' });
    }
    console.error('LIA attach exception:', e);
    res.status(500).json({ message: 'Error al analizar el archivo', code: 'ATTACH_ERROR' });
  }
};

app.post('/lia/attach', auth, liaAttachHandler);
app.post('/api/lia/attach', auth, liaAttachHandler);

// ════════════════════════════════════════════════════════════════════
// GRUPOS DE CHAT
// ════════════════════════════════════════════════════════════════════
// Añadir participante a grupo
app.post('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    // Añadir miembros lo decide el permiso add_members: por defecto cualquiera,
    // con 'admins' solo administradores o el creador.
    if (!(await esAdminDeChat(req.params.chatId, req.user.id))) {
      const { data: c } = await supabase
        .from('chats').select('settings').eq('id', req.params.chatId).maybeSingle();
      if (chatPermisos(c).add_members !== 'all') {
        return res.status(403).json({ message: 'Solo un administrador puede añadir miembros' });
      }
    }
    // Reañadir al que ya está no debe duplicar la fila: sin onConflict, PostgREST
    // intenta el alta por clave primaria (id), que aqui no llega.
    const { error } = await supabase
      .from('chat_participants')
      .upsert({ chat_id: req.params.chatId, user_id }, { onConflict: 'chat_id,user_id' });
    if (error) throw error;
    res.json({ message: 'Participante añadido' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Nota: GET /api/chats/:chatId/participants está definido arriba (única implementación)

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
// GRUPOS: salir, expulsar, ascender, ajustes y enlace de invitacion
// ════════════════════════════════════════════════════════════════════
// La app ya llamaba a estas rutas y ninguna existia. `fetch` no lanza con un
// 404, asi que la pantalla daba por hecho lo que el servidor nunca hizo:
// decia «has salido del grupo» sin salir, «admin asignado» sin asignar.
const participacionEnChat = async (chatId, userId) => {
  // limit(1) y no maybeSingle: una fila duplicada hacia que la consulta
  // fallara y el socio quedara fuera de su propio grupo.
  const { data } = await supabase
    .from('chat_participants')
    .select('id, role')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .limit(1);
  return (data && data[0]) || null;
};

const esAdminDeChat = async (chatId, userId) => {
  const part = await participacionEnChat(chatId, userId);
  if (!part) return false;
  if (part.role === 'admin') return true;
  const { data: chat } = await supabase.from('chats').select('created_by').eq('id', chatId).maybeSingle();
  return !!chat && String(chat.created_by) === String(userId);
};

// Permisos granulares del grupo. Viven en chats.settings (JSONB); cuando la
// columna aun no existe en la base se devuelven los valores por defecto.
const PERMISOS_GRUPO_DEFECTO = { edit_info: 'admins', add_members: 'all', invite_admins_only: false };
const chatPermisos = (chat) => {
  const s = chat && chat.settings && typeof chat.settings === 'object' ? chat.settings : {};
  return {
    edit_info: s.edit_info === 'all' ? 'all' : 'admins',
    add_members: s.add_members === 'admins' ? 'admins' : 'all',
    invite_admins_only: !!s.invite_admins_only,
  };
};
const puedeEditarInfoChat = async (chatId, userId) => {
  if (await esAdminDeChat(chatId, userId)) return true;
  const { data: c } = await supabase.from('chats').select('settings').eq('id', chatId).maybeSingle();
  return chatPermisos(c).edit_info === 'all';
};

// El cliente manda PATCH para renombrar; el servidor solo tenia PUT.
// Ademas del nombre admite descripcion y respeta el permiso edit_info.
app.patch('/api/chats/:chatId', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { name, avatar_url, description } = req.body || {};

    if (!(await puedeEditarInfoChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'No tienes permiso para editar este grupo' });
    }

    const { data: chat } = await supabase
      .from('chats')
      .select('id, type')
      .eq('id', chatId)
      .maybeSingle();
    if (!chat) return res.status(404).json({ message: 'Chat no encontrado' });
    if (chat.type !== 'group') return res.status(400).json({ message: 'Solo se pueden editar grupos' });

    const updates = { updated_at: new Date().toISOString() };
    if (typeof name === 'string' && name.trim() !== '') updates.name = name.trim();
    if (typeof avatar_url === 'string' && avatar_url !== '') updates.avatar_url = avatar_url;
    if (typeof description === 'string') updates.description = description.trim() || null;
    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ message: 'Nada que actualizar' });
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
    console.error('Patch group error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Salir de un grupo: se borra mi participacion, no el grupo ni los mensajes
// de los demas. Si era el ultimo, el chat se queda sin nadie y se borra.
app.post('/api/chats/:chatId/leave', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    const mia = await participacionEnChat(chatId, req.user.id);
    if (!mia) return res.status(404).json({ message: 'No participas en este chat' });

    const { error } = await supabase
      .from('chat_participants')
      .delete()
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);
    if (error) throw error;

    await supabase.from('message_reads').delete().eq('chat_id', chatId).eq('user_id', req.user.id);

    const { data: quedan } = await supabase
      .from('chat_participants')
      .select('id')
      .eq('chat_id', chatId);

    let chatBorrado = false;
    if (!quedan || quedan.length === 0) {
      // La tabla messages no declara FK a chats: si se borra el chat a secas,
      // los mensajes quedan huerfanos y nadie puede leerlos. Se limpian antes.
      await supabase.from('messages').delete().eq('chat_id', chatId);
      const { error: delErr } = await supabase.from('chats').delete().eq('id', chatId);
      chatBorrado = !delErr;
    }

    res.json({ message: 'Has salido del grupo', left: true, chat_deleted: chatBorrado });
  } catch (e) {
    console.error('Leave chat error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Expulsar a un miembro: solo un administrador o el creador, y nunca al creador.
app.delete('/api/chats/:chatId/participants/:userId', auth, async (req, res) => {
  try {
    const { chatId, userId } = req.params;

    if (!(await esAdminDeChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'Solo un administrador puede expulsar' });
    }
    if (String(userId) === String(req.user.id)) {
      return res.status(400).json({ message: 'Para irte usa salir del grupo' });
    }

    const { data: chat } = await supabase.from('chats').select('created_by').eq('id', chatId).maybeSingle();
    if (chat && String(chat.created_by) === String(userId)) {
      return res.status(400).json({ message: 'No se puede expulsar al creador del grupo' });
    }

    const { data: borrado, error } = await supabase
      .from('chat_participants')
      .delete()
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!borrado) return res.status(404).json({ message: 'Ese usuario no esta en el grupo' });

    await supabase.from('message_reads').delete().eq('chat_id', chatId).eq('user_id', userId);

    res.json({ message: 'Participante eliminado', removed: true });
  } catch (e) {
    console.error('Remove participant error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Cambiar el rol de un miembro. El creador no se toca desde aqui.
app.patch('/api/chats/:chatId/participants/:userId/role', auth, async (req, res) => {
  try {
    const { chatId, userId } = req.params;
    const role = String(req.body?.role || '').trim();

    if (role !== 'admin' && role !== 'member') {
      return res.status(400).json({ message: 'Rol no valido' });
    }
    if (!(await esAdminDeChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'Solo un administrador puede cambiar roles' });
    }

    const { data: chat } = await supabase.from('chats').select('created_by').eq('id', chatId).maybeSingle();
    if (chat && String(chat.created_by) === String(userId)) {
      return res.status(400).json({ message: 'El creador del grupo siempre es administrador' });
    }

    const { data: actualizado, error } = await supabase
      .from('chat_participants')
      .update({ role })
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .select('id, role')
      .maybeSingle();
    if (error) throw error;
    if (!actualizado) return res.status(404).json({ message: 'Ese usuario no esta en el grupo' });

    res.json({ message: 'Rol actualizado', role: actualizado.role });
  } catch (e) {
    console.error('Change role error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Ajustes del grupo: modo difusion + permisos granulares (quien edita la
// info, quien añade miembros y quien puede generar el enlace de invitacion).
app.patch('/api/chats/:chatId/settings', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    if (!(await esAdminDeChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'Solo un administrador puede cambiar los ajustes' });
    }

    const { data: chatRow } = await supabase
      .from('chats').select('id, broadcast_mode, settings').eq('id', chatId).maybeSingle();
    if (!chatRow) return res.status(404).json({ message: 'Chat no encontrado' });

    const prev = chatPermisos(chatRow);
    const permissions = {
      edit_info: req.body?.edit_info === 'all' || req.body?.edit_info === 'admins' ? req.body.edit_info : prev.edit_info,
      add_members: req.body?.add_members === 'all' || req.body?.add_members === 'admins' ? req.body.add_members : prev.add_members,
      invite_admins_only: typeof req.body?.invite_admins_only === 'boolean' ? req.body.invite_admins_only : prev.invite_admins_only,
    };
    const broadcast = typeof req.body?.broadcast_mode === 'boolean' ? req.body.broadcast_mode : !!chatRow.broadcast_mode;

    const updates = {
      updated_at: new Date().toISOString(),
      broadcast_mode: broadcast,
      settings: permissions,
    };
    let actualizado = null;
    let error = null;
    ({ data: actualizado, error } = await supabase
      .from('chats').update(updates).eq('id', chatId).select('broadcast_mode, settings').maybeSingle());
    if (error && /settings/.test(String(error.message || ''))) {
      // La columna settings todavia no esta en la base: se guarda lo esencial.
      ({ data: actualizado, error } = await supabase
        .from('chats')
        .update({ updated_at: updates.updated_at, broadcast_mode: broadcast })
        .eq('id', chatId).select('broadcast_mode').maybeSingle());
    }
    if (error) throw error;
    if (!actualizado) return res.status(404).json({ message: 'Chat no encontrado' });

    res.json({
      message: 'Ajustes guardados',
      broadcast_mode: !!actualizado.broadcast_mode,
      permissions: chatPermisos(actualizado),
    });
  } catch (e) {
    console.error('Chat settings error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Ficha completa del grupo en una sola llamada: datos, permisos reales,
// participantes con rol verdadero y, si el chat esta ligado a un djangue,
// sus cuotas del turno. Los miembros del djangue se fusionan con los
// participantes del chat para que un grupo vinculado nunca abra vacio.
app.get('/api/chats/:chatId/info', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const miId = String(req.user.id);

    const { data: chat } = await supabase.from('chats').select('*').eq('id', chatId).maybeSingle();
    if (!chat) return res.status(404).json({ message: 'Chat no encontrado' });

    // Djangue vinculado a este chat (si existe el esquema). Si el vinculo no
    // esta escrito, se busca por el nombre "💰 Nombre" del chat del djangue.
    let d = null;
    try {
      const { data: djRow } = await supabase
        .from('djangue_groups').select('id').eq('chat_group_id', chatId).maybeSingle();
      let djId = djRow?.id || null;
      if (!djId && String(chat.name || '').startsWith('💰')) {
        const { data: porNombre } = await supabase
          .from('djangue_groups').select('id')
          .eq('name', String(chat.name).replace(/^💰\s*/, '')).maybeSingle();
        djId = porNombre?.id || null;
      }
      if (djId) d = await djCargar(req.user.id, djId);
    } catch { d = null; }
    const enDjangue = !!d && ((d.miFila && d.miFila.status !== 'removed') || d.miRol === 'owner' || d.miRol === 'secretary');

    const mia = await participacionEnChat(chatId, req.user.id);
    const soyCreador = !!chat.created_by && String(chat.created_by) === miId;
    if (!mia && !soyCreador && !enDjangue) {
      return res.status(403).json({ message: 'No tienes acceso a este grupo' });
    }

    // Participantes del chat con su rol real
    const { data: parts } = await supabase
      .from('chat_participants').select('user_id, role').eq('chat_id', chatId);
    const roleMap = {};
    (parts || []).forEach(p => { roleMap[String(p.user_id)] = p.role; });
    const creador = chat.created_by ? String(chat.created_by) : null;

    // Los miembros activos del djangue entran tambien aunque el chat viejo
    // no tenga filas en chat_participants
    const djIds = enDjangue ? (d.activos || []).map(m => String(m.user_id)) : [];
    const todosIds = [...new Set([...(parts || []).map(p => String(p.user_id)), ...djIds])];

    const { data: usersRows } = todosIds.length
      ? await supabase.from('users').select('id, full_name, phone, avatar_url, online_status, last_seen').in('id', todosIds)
      : { data: [] };
    const uMap = {};
    (usersRows || []).forEach(u => { uMap[String(u.id)] = u; });

    // Visibilidad de ultima conexion: la decide el dueno del dato
    const otrosIds = todosIds.filter(uid => uid !== miId);
    const visMap = {};
    if (otrosIds.length) {
      const { data: prefsRows } = await supabase
        .from('user_preferences').select('user_id, last_seen_visibility').in('user_id', otrosIds);
      (prefsRows || []).forEach(p => { visMap[String(p.user_id)] = p.last_seen_visibility; });
    }
    let misContactos = new Set();
    if (Object.values(visMap).includes('contactos')) {
      const { data: agenda } = await supabase
        .from('contacts').select('contact_user_id').eq('user_id', req.user.id);
      misContactos = new Set((agenda || []).map(c => String(c.contact_user_id)));
    }

    // Estado de cuota del turno por miembro del djangue
    const djByUser = {};
    if (enDjangue) {
      (d.activos || []).forEach(m => {
        const contrib = (d.delTurno || []).find(c => String(c.user_id) === String(m.user_id));
        djByUser[String(m.user_id)] = {
          turn_order: Number(m.turn_order) || null,
          paid_current_turn: !!contrib && contrib.status === 'paid',
          has_justified: !!contrib && contrib.status === 'justified',
          is_current_beneficiary: !!d.beneficiario && String(d.beneficiario.user_id) === String(m.user_id),
        };
      });
    }

    const turnoDe = (uid) => djByUser[uid] && djByUser[uid].turn_order != null ? djByUser[uid].turn_order : 9999;
    const participants = todosIds.map(uid => {
      const u = uMap[uid] || {};
      const esAdminGrupo = roleMap[uid] === 'admin' || (!!creador && uid === creador);
      const vis = visMap[uid] || 'todos';
      const oculta = uid !== miId && (vis === 'nadie' || (vis === 'contactos' && !misContactos.has(uid)));
      return {
        user_id: uid,
        full_name: u.full_name || '',
        phone: u.phone || '',
        avatar_url: u.avatar_url || '',
        role: esAdminGrupo ? 'admin' : 'member',
        is_creator: !!creador && uid === creador,
        online_status: oculta ? false : estaEnLineaAhora(u.last_seen),
        last_seen: oculta ? null : (u.last_seen || null),
        djangue: djByUser[uid] || null,
      };
    }).sort((a, b) =>
      (b.role === 'admin' ? 1 : 0) - (a.role === 'admin' ? 1 : 0) ||
      turnoDe(a.user_id) - turnoDe(b.user_id) ||
      (a.full_name || '').localeCompare(b.full_name || ''));

    // Resumen financiero del djangue para la ficha del grupo
    let djangue = null;
    if (enDjangue) {
      const g = d.grupo;
      const activos = d.activos || [];
      const delTurno = d.delTurno || [];
      const pagados = activos.filter(m => {
        const c = delTurno.find(x => String(x.user_id) === String(m.user_id));
        return c && c.status === 'paid';
      }).length;
      const b = d.beneficiario;
      const usuB = b ? (d.usuarios?.[b.user_id] || {}) : {};
      djangue = {
        id: g.id,
        name: g.name,
        logo_url: g.logo_url || null,
        quota_amount: djNum(g.quota_amount),
        currency: g.currency || 'XAF',
        frequency: g.frequency || 'monthly',
        penalty_percent: djNum(g.penalty_percent),
        current_turn: d.turnoActual || 1,
        total_turns: Number(g.total_turns) || activos.length,
        status: g.status || 'active',
        period_end_date: g.period_end_date || null,
        beneficiary: b ? { user_id: b.user_id, full_name: usuB.full_name || null, avatar_url: usuB.avatar_url || null } : null,
        paid_count: pagados,
        pending_count: Math.max(0, activos.length - pagados - (b ? 1 : 0)),
        expected_payout: djPozoEsperado(g, activos),
        my: djByUser[miId] || null,
      };
    }

    res.json({
      id: chat.id,
      type: chat.type || 'group',
      name: chat.name,
      description: chat.description || null,
      avatar_url: chat.avatar_url || d?.grupo?.logo_url || null,
      cover_url: chat.cover_url || null,
      created_by: chat.created_by || null,
      created_at: chat.created_at || null,
      broadcast_mode: !!chat.broadcast_mode,
      ephemeral_seconds: Number(chat.ephemeral_seconds || 0),
      permissions: chatPermisos(chat),
      my_role: (roleMap[miId] === 'admin' || (!!creador && miId === creador)) ? 'admin' : 'member',
      participants,
      djangue,
    });
  } catch (e) {
    console.error('Chat info error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Enlace de invitacion: el token vive en el chat y no caduca hasta que se
// cambie. La entrada la da POST /api/chats/join.
app.post('/api/chats/:chatId/invite-link', auth, async (req, res) => {
  try {
    const { chatId } = req.params;

    if (!(await participacionEnChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'No participas en este chat' });
    }

    const { data: chatPerm } = await supabase
      .from('chats').select('settings').eq('id', chatId).maybeSingle();
    if (chatPermisos(chatPerm).invite_admins_only && !(await esAdminDeChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'Solo un administrador puede generar el enlace' });
    }

    let { data: chat } = await supabase
      .from('chats')
      .select('id, invite_token')
      .eq('id', chatId)
      .maybeSingle();
    if (!chat) return res.status(404).json({ message: 'Chat no encontrado' });

    if (!chat.invite_token) {
      const token = require('crypto').randomBytes(12).toString('hex');
      const { data: guardado, error } = await supabase
        .from('chats')
        .update({ invite_token: token })
        .eq('id', chatId)
        .select('invite_token')
        .maybeSingle();
      if (error) throw error;
      chat = { ...chat, invite_token: guardado?.invite_token || token };
    }

    const link = `https://egchat.app/join/${chat.invite_token}`;
    res.json({ link, invite_link: link, token: chat.invite_token });
  } catch (e) {
    console.error('Invite link error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Entrar a un grupo con el token del enlace.
app.post('/api/chats/join', auth, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ message: 'Token requerido' });

    const { data: chat } = await supabase
      .from('chats')
      .select('id, name, type')
      .eq('invite_token', token)
      .maybeSingle();
    if (!chat) return res.status(404).json({ message: 'Enlace no valido' });

    const yaDentro = await participacionEnChat(chat.id, req.user.id);
    if (!yaDentro) {
      const { error } = await supabase
        .from('chat_participants')
        .insert({ chat_id: chat.id, user_id: req.user.id });
      if (error) throw error;
    }

    res.json({ message: 'Dentro del grupo', chat_id: chat.id, chat_name: chat.name || null });
  } catch (e) {
    console.error('Join chat error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Mensajes que se autodestruyen: el plazo se guarda en el chat y se aplica al
// leer, que es lo unico que hace que valga para todos y no solo para el que lo
// configuro.
const PLAZOS_EFIMEROS = [0, 30, 60, 300, 3600, 86400, 604800, 7776000];
app.patch('/api/chats/:chatId/ephemeral', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const segundos = Number(req.body?.duration_seconds);

    if (!(await participacionEnChat(chatId, req.user.id))) {
      return res.status(403).json({ message: 'No participas en este chat' });
    }
    if (!PLAZOS_EFIMEROS.includes(segundos)) {
      return res.status(400).json({ message: 'Plazo no valido' });
    }

    const { data: actualizado, error } = await supabase
      .from('chats')
      .update({ ephemeral_seconds: segundos, updated_at: new Date().toISOString() })
      .eq('id', chatId)
      .select('ephemeral_seconds')
      .maybeSingle();
    if (error) throw error;
    if (!actualizado) return res.status(404).json({ message: 'Chat no encontrado' });

    res.json({ duration_seconds: actualizado.ephemeral_seconds });
  } catch (e) {
    console.error('Ephemeral error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// MENSAJES: reacciones, acuses de lectura, busqueda y edicion
// ════════════════════════════════════════════════════════════════════
const mensajeConAcceso = async (messageId, userId) => {
  const { data: msg } = await supabase
    .from('messages')
    .select('id, chat_id, sender_id, text, created_at')
    .eq('id', messageId)
    .maybeSingle();
  if (!msg) return { msg: null, acceso: false };
  const acceso = !!(await participacionEnChat(msg.chat_id, userId));
  return { msg, acceso };
};

app.get('/api/messages/:messageId/reactions', auth, async (req, res) => {
  try {
    const { msg, acceso } = await mensajeConAcceso(req.params.messageId, req.user.id);
    if (!msg) return res.status(404).json({ message: 'Mensaje no encontrado' });
    if (!acceso) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { data, error } = await supabase
      .from('message_reactions')
      .select('emoji, user_id, created_at')
      .eq('message_id', msg.id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    res.json(data || []);
  } catch (e) {
    console.error('Get reactions error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Alterna mi reaccion: si ya estaba, la quita; si no, la pone.
app.post('/api/messages/:messageId/reactions', auth, async (req, res) => {
  try {
    const emoji = String(req.body?.emoji || '').trim();
    if (!emoji || emoji.length > 16) return res.status(400).json({ message: 'Emoji no valido' });

    const { msg, acceso } = await mensajeConAcceso(req.params.messageId, req.user.id);
    if (!msg) return res.status(404).json({ message: 'Mensaje no encontrado' });
    if (!acceso) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { data: existente } = await supabase
      .from('message_reactions')
      .select('id')
      .eq('message_id', msg.id)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .maybeSingle();

    if (existente) {
      const { error } = await supabase.from('message_reactions').delete().eq('id', existente.id);
      if (error) throw error;
      return res.json({ added: false, emoji });
    }

    const { error } = await supabase
      .from('message_reactions')
      .insert({ message_id: msg.id, user_id: req.user.id, emoji });
    if (error) throw error;

    res.json({ added: true, emoji });
  } catch (e) {
    console.error('Toggle reaction error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/messages/:messageId/reactions/:emoji', auth, async (req, res) => {
  try {
    const emoji = String(req.params.emoji || '').trim();
    if (!emoji) return res.status(400).json({ message: 'Emoji no valido' });

    const { msg, acceso } = await mensajeConAcceso(req.params.messageId, req.user.id);
    if (!msg) return res.status(404).json({ message: 'Mensaje no encontrado' });
    if (!acceso) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { error } = await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', msg.id)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji);
    if (error) throw error;

    res.json({ removed: true, emoji });
  } catch (e) {
    console.error('Delete reaction error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Acuses: quien ha leido este mensaje. `message_reads` guarda el ultimo
// mensaje leido por persona, no una fila por mensaje.
app.get('/api/messages/:messageId/receipts', auth, async (req, res) => {
  try {
    const { msg, acceso } = await mensajeConAcceso(req.params.messageId, req.user.id);
    if (!msg) return res.status(404).json({ message: 'Mensaje no encontrado' });
    if (!acceso) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const { data: parts } = await supabase
      .from('chat_participants')
      .select('user_id')
      .eq('chat_id', msg.chat_id);
    const otros = (parts || [])
      .map(p => p.user_id)
      .filter(id => String(id) !== String(req.user.id));
    if (otros.length === 0) return res.json([]);

    const { data: lecturas } = await supabase
      .from('message_reads')
      .select('user_id, last_read_message_id, read_at')
      .eq('chat_id', msg.chat_id)
      .in('user_id', otros);

    const lecturasPorUsuario = {};
    (lecturas || []).forEach(l => { lecturasPorUsuario[String(l.user_id)] = l; });

    const { data: usuarios } = await supabase
      .from('users')
      .select('id, full_name, avatar_url')
      .in('id', otros);
    const usuariosPorId = {};
    (usuarios || []).forEach(u => { usuariosPorId[String(u.id)] = u; });

    const leidoEn = new Date(msg.created_at).getTime();
    const receipts = otros.map(id => {
      const lectura = lecturasPorUsuario[String(id)];
      const porId = lectura && String(lectura.last_read_message_id) === String(msg.id);
      const porFecha = lectura && lectura.read_at && new Date(lectura.read_at).getTime() >= leidoEn;
      const u = usuariosPorId[String(id)] || {};
      return {
        user_id: id,
        full_name: u.full_name || '',
        avatar_url: u.avatar_url || '',
        read_at: porId || porFecha ? (lectura.read_at || new Date().toISOString()) : null,
      };
    });

    res.json(receipts);
  } catch (e) {
    console.error('Receipts error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Busqueda de mensajes solo en los chats donde participo.
app.get('/api/messages/search', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const limite = Math.min(parseInt(req.query.limit) || 30, 50);

    const { data: parts } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', req.user.id);
    const chatIds = (parts || []).map(p => p.chat_id);
    if (chatIds.length === 0) return res.json([]);

    const { data: msgs, error } = await supabase
      .from('messages')
      .select('id, chat_id, sender_id, text, type, created_at')
      .in('chat_id', chatIds)
      .ilike('text', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(limite);
    if (error) throw error;

    const encontrados = msgs || [];
    if (encontrados.length === 0) return res.json([]);

    const senderIds = [...new Set(encontrados.map(m => m.sender_id).filter(Boolean))];
    const chatIdsConResultado = [...new Set(encontrados.map(m => m.chat_id))];

    const [{ data: senders }, { data: chats }] = await Promise.all([
      supabase.from('users').select('id, full_name, avatar_url').in('id', senderIds),
      supabase.from('chats').select('id, name, type, avatar_url').in('id', chatIdsConResultado),
    ]);
    const senderPorId = {};
    (senders || []).forEach(u => { senderPorId[String(u.id)] = u; });
    const chatPorId = {};
    (chats || []).forEach(c => { chatPorId[String(c.id)] = c; });

    res.json(encontrados.map(m => ({
      ...m,
      sender: senderPorId[String(m.sender_id)] || null,
      chat: chatPorId[String(m.chat_id)] || null,
      edited: false,
    })));
  } catch (e) {
    console.error('Search messages error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Editar un mensaje: solo el que lo escribio y solo el texto.
app.patch('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ message: 'Texto requerido' });
    if (text.length > 4096) return res.status(400).json({ message: 'Texto demasiado largo' });

    const { data: msg } = await supabase
      .from('messages')
      .select('id, chat_id, sender_id')
      .eq('id', req.params.messageId)
      .maybeSingle();
    if (!msg) return res.status(404).json({ message: 'Mensaje no encontrado' });
    if (String(msg.sender_id) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Solo puedes editar tus mensajes' });
    }

    const { data: editado, error } = await supabase
      .from('messages')
      .update({ text, edited_at: new Date().toISOString() })
      .eq('id', msg.id)
      .select('id, chat_id, sender_id, text, type, created_at, edited_at')
      .maybeSingle();
    if (error) throw error;

    const { data: sender } = await supabase
      .from('users')
      .select('id, full_name, avatar_url')
      .eq('id', msg.sender_id)
      .maybeSingle();

    res.json({ ...editado, edited: true, sender: sender || null });
  } catch (e) {
    console.error('Edit message error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// STICKERS
// ════════════════════════════════════════════════════════════════════
// El panel de stickers pedia este catalogo y no existia: cada apertura caia
// al catalogo local y los packs del servidor no aparecian nunca. Si la tabla
// no esta, se responde error para que el cliente use el catalogo local en vez
// de pintar una lista vacia.
app.get('/api/stickers/catalog', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sticker_packs')
      .select('*')
      .order('name', { ascending: true });
    if (error) {
      return res.status(502).json({ error: 'STICKERS_SIN_TABLA', message: error.message });
    }
    res.json((data || []).filter(p => p.is_active !== false));
  } catch (e) {
    res.status(502).json({ error: 'STICKERS_FALLO', message: e.message });
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
      .select('id, text, chat_id, sender_id, created_at')
      .in('chat_id', chatIds)
      .neq('sender_id', req.user.id)
      .eq('status', 'sent')
      .order('created_at', { ascending: false })
      .limit(20);

    // Obtener senders en consulta separada
    const senderIds = [...new Set((msgs || []).map(m => m.sender_id).filter(Boolean))];
    const { data: senders } = senderIds.length > 0
      ? await supabase.from('users').select('id, full_name, avatar_url').in('id', senderIds)
      : { data: [] };
    const sendersById = {};
    (senders || []).forEach(u => { sendersById[String(u.id)] = u; });
    const msgsWithSender = (msgs || []).map(m => ({
      ...m,
      users: sendersById[String(m.sender_id)] || null,
    }));

    res.json(msgsWithSender);
  } catch (e) { res.json([]); }
});

// ════════════════════════════════════════════════════════════════════
// CONTACTOS CON FOTO Y PERFIL
// ════════════════════════════════════════════════════════════════════
// Perfil público de un usuario. La pantalla de chat consulta aqui cada 15s
// para pintar "en linea" y "visto por ultima vez": antes la consulta no traia
// ni online_status ni last_seen, asi que todo el mundo salia desconectado.
const VENTANA_EN_LINEA_MS = 150000;

const estaEnLineaAhora = (lastSeen) => {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < VENTANA_EN_LINEA_MS;
};

app.get('/api/users/:userId', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url, created_at, online_status, last_seen')
      .eq('id', req.params.userId)
      .single();
    if (!data) return res.status(404).json({ message: 'Usuario no encontrado' });

    const uid = String(data.id);
    const yoId = String(req.user.id);
    if (uid === yoId) {
      return res.json({ ...data, online_status: true, last_seen_visibility: 'todos' });
    }

    // La visibilidad la decide el dueño del dato: 'nadie' oculta siempre y
    // 'contactos' solo enseña a quien lo tiene en su agenda.
    const { data: pref } = await supabase
      .from('user_preferences')
      .select('last_seen_visibility')
      .eq('user_id', uid)
      .maybeSingle();
    let vis = pref?.last_seen_visibility || 'todos';
    if (!['todos', 'contactos', 'nadie'].includes(vis)) vis = 'todos';

    let oculta = vis === 'nadie';
    if (vis === 'contactos') {
      const { data: enAgenda } = await supabase
        .from('contacts')
        .select('id')
        .eq('user_id', req.user.id)
        .eq('contact_user_id', uid)
        .maybeSingle();
      oculta = !enAgenda;
    }

    // online_status se queda en true desde el ultimo latido y nadie lo apaga:
    // lo que vale es la marca de tiempo, no la bandera.
    res.json({
      ...data,
      online_status: oculta ? false : estaEnLineaAhora(data.last_seen),
      last_seen: oculta ? null : (data.last_seen || null),
      last_seen_visibility: vis,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// ESPACIO DULCE — Canales y Comunidades
// ════════════════════════════════════════════════════════════════════

// Auto-crear tablas de espacios
// Las creaba `exec_sql`, que ya no existe en el esquema (ver nota en
// ensureChatMuteColumn). El DDL vivo esta en
// migrations/2026-11-05_espacio_dulce_lote_e1.sql; aqui solo se comprueba que el
// esquema esta puesto, porque antes el catch vacio tragaba el error y la pantalla
// salia vacia sin que nadie supiera por que.
const ensureSpacesSchema = async () => {
  const faltan = [];
  for (const t of ['spaces', 'space_follows', 'space_posts', 'space_post_likes', 'space_post_comments', 'stories',
                   'moments', 'moment_likes', 'moment_comments', 'live_streams']) {
    try {
      // moment_likes nace con clave compuesta (moment_id, user_id) y sin `id` en
      // la base que ya tenia la tabla antes de E1: sondear `id` la daba por rota.
      const { error } = await supabase.from(t).select(t === 'moment_likes' ? 'moment_id' : 'id').limit(1);
      if (error) faltan.push(`${t}: ${error.message}`);
    } catch (e) {
      faltan.push(`${t}: ${e.message}`);
    }
  }
  if (faltan.length > 0) {
    console.warn('ensureSpacesSchema: falta el esquema de Espacio Dulce, pegar migrations/2026-11-05_espacio_dulce_lote_e1.sql ->', faltan.join(' | '));
  }
};
ensureSpacesSchema();

// Los cinco canales por defecto, creados solo si la tabla esta vacia.
// Los seguidores que llevaba antes (48200, 31500, 22100...) eran inventados: no hay
// nadie detras de esas cuentas todavia, y empezar con una audiencia falsa es peor
// que empezar con cero. Ahora nacen en 0 y suben con space_followers_delta.
const seedDefaultSpaces = async () => {
  try {
    const { data, error } = await supabase.from('spaces').select('id').limit(1);
    if (error) return;
    if (data && data.length > 0) return; // ya existen
    const defaults = [
      { name: 'Gobierno GE', description: 'Canal reservado para comunicados oficiales. Todavia sin redactor.', type: 'publico', cover: 'linear-gradient(135deg,#1e3a5f,#0369a1)', emoji: '🏛️', followers_count: 0 },
      { name: 'Musica GQ', description: 'Lo mejor de la musica de Guinea Ecuatorial y Africa Central', type: 'comunidad', cover: 'linear-gradient(135deg,#7c3aed,#db2777)', emoji: '🎵', followers_count: 0 },
      { name: 'Mercado Malabo', description: 'Compra, vende e intercambia en Guinea Ecuatorial', type: 'comunidad', cover: 'linear-gradient(135deg,#059669,#0d9488)', emoji: '🛒', followers_count: 0 },
      { name: 'Deportes GQ', description: 'Futbol, baloncesto y todos los deportes de Guinea Ecuatorial', type: 'publico', cover: 'linear-gradient(135deg,#dc2626,#f59e0b)', emoji: '⚽', followers_count: 0 },
      { name: 'Tecnologia GE', description: 'Innovacion, startups y tecnologia en Guinea Ecuatorial', type: 'comunidad', cover: 'linear-gradient(135deg,#1e40af,#7c3aed)', emoji: '💻', followers_count: 0 },
    ];
    await supabase.from('spaces').insert(defaults);
  } catch (e) {
    console.warn('seedDefaultSpaces:', e.message);
  }
};
setTimeout(seedDefaultSpaces, 3000);

// Un fallo de esquema no es un listado vacio. Mientras devolvia `[]`, la pantalla
// no tenia forma de saber que estaba rota y la web tapaba el hueco con canales y
// posts inventados. 502 con codigo para que el cliente pueda avisar de verdad.
const espacioFallo = (res, e) => res.status(502).json({
  error: 'ESPACIO_ESQUEMA_FALLO',
  message: (e && e.message) ? e.message : 'No se pudo leer el esquema de Espacio Dulce.',
});

// GET /api/spaces — listar todos los espacios con estado de seguimiento del usuario
app.get('/api/spaces', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: spaces, error } = await supabase
      .from('spaces')
      .select('*')
      .order('followers_count', { ascending: false });
    if (error) return espacioFallo(res, error);

    // Qué espacios sigue el usuario
    const { data: follows } = await supabase
      .from('space_follows')
      .select('space_id')
      .eq('user_id', userId);
    const followedIds = new Set((follows || []).map(f => f.space_id));

    res.json((spaces || []).map(s => ({ ...s, following: followedIds.has(s.id) })));
  } catch (e) { espacioFallo(res, e); }
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
    await supabase.from('space_follows').insert({ space_id: data.id, user_id: req.user.id });
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
      // El contador lo mueve la base de datos con un delta: antes esta línea
      // escribía `followers_count: undefined` (no-op) y además un UPDATE en
      // cadena que se pisaba con los demás seguidores.
      await supabase.rpc('space_followers_delta', { p_space_id: id, p_delta: -1 });
      res.json({ following: false });
    } else {
      await supabase.from('space_follows').insert({ space_id: id, user_id: userId });
      await supabase.rpc('space_followers_delta', { p_space_id: id, p_delta: 1 });
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

    const { data: posts, error: postsError } = await supabase
      .from('space_posts')
      .select('*')
      .eq('space_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (postsError) return espacioFallo(res, postsError);
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
  } catch (e) { espacioFallo(res, e); }
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
      await supabase.rpc('space_likes_delta', { p_post_id: postId, p_delta: -1 });
      res.json({ liked: false });
    } else {
      await supabase.from('space_post_likes').insert({ post_id: postId, user_id: userId });
      await supabase.rpc('space_likes_delta', { p_post_id: postId, p_delta: 1 });
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
  } catch (e) { espacioFallo(res, e); }
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
    await supabase.rpc('space_comments_delta', { p_post_id: postId, p_delta: 1 });
    const { data: author } = await supabase.from('users').select('full_name, avatar_url').eq('id', req.user.id).single();
    res.status(201).json({ id: data.id, author: author?.full_name || 'Usuario', avatar: (author?.full_name||'U').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(), avatarUrl: author?.avatar_url||'', text: data.text, time: 'ahora' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE /api/spaces/posts/:postId — eliminar post (autor o dueno del espacio)
app.delete('/api/spaces/posts/:postId', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;
    const { data: post } = await supabase
      .from('space_posts').select('id, author_id, space_id').eq('id', postId).single();
    if (!post) return res.status(404).json({ error: 'NO_ENCONTRADO', message: 'Ese post no existe.' });

    let puede = post.author_id === userId;
    if (!puede) {
      const { data: espacio } = await supabase
        .from('spaces').select('owner_id').eq('id', post.space_id).single();
      puede = espacio && espacio.owner_id === userId;
    }
    if (!puede) return res.status(403).json({ error: 'NO_ES_TUYO', message: 'Solo el autor o el dueño del canal pueden borrarlo.' });

    const { data: borrados, error } = await supabase
      .from('space_posts').delete().eq('id', postId).select('id');
    if (error) throw error;
    if (!borrados || borrados.length === 0) {
      return res.status(403).json({ error: 'NO_ES_TUYO', message: 'No se ha podido borrar el post.' });
    }
    res.json({ ok: true, id: borrados[0].id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// MOMENTOS / MURO DE ESPACIO DULCE
// ════════════════════════════════════════════════════════════════════
// `app/moments.tsx` y la seccion de muro de `app/stories.tsx` llaman a estas
// seis rutas. Hasta ahora no existian: la pantalla se quedaba en vacio y el
// cliente lo tapaba con su caché local. Las tablas las crea
// migrations/2026-11-05_espacio_dulce_lote_e1.sql.
// Los likes y los comentarios se cuentan al leer, no se guardan contados: un
// numero escrito aparte es un numero que puede mentir.

// Contactos del usuario, con el mismo criterio que usa GET /api/stories:
// tabla contacts por cualquiera de sus dos puntas mas los compañeros de chat.
const contactosDeUsuario = async (userId) => {
  const ids = new Set();
  const { data: contacts } = await supabase
    .from('contacts')
    .select('contact_user_id, contact_id')
    .or(`user_id.eq.${userId},contact_id.eq.${userId}`)
    .eq('is_blocked', false);
  (contacts || []).forEach(c => {
    if (c.contact_user_id && c.contact_user_id !== userId) ids.add(c.contact_user_id);
    if (c.contact_id && c.contact_id !== userId) ids.add(c.contact_id);
  });

  const { data: chatParts } = await supabase
    .from('chat_participants').select('chat_id').eq('user_id', userId);
  if (chatParts && chatParts.length > 0) {
    const { data: otherParts } = await supabase
      .from('chat_participants')
      .select('user_id')
      .in('chat_id', chatParts.map(c => c.chat_id))
      .neq('user_id', userId);
    (otherParts || []).forEach(p => ids.add(p.user_id));
  }
  return Array.from(ids);
};

const momentoSinComentarios = (m, usersMap, likedSet) => {
  const autor = usersMap[m.user_id] || {};
  const comoLista = (v) => {
    let out = v;
    if (typeof out === 'string') { try { out = JSON.parse(out); } catch { out = []; } }
    return Array.isArray(out) ? out : [];
  };
  return {
    id: m.id,
    user_id: m.user_id,
    user_name: autor.full_name || 'Usuario',
    user_avatar: autor.avatar_url || '',
    text: m.text || '',
    images: comoLista(m.images),
    videos: comoLista(m.videos),
    likes: 0,
    liked_by_me: likedSet.has(m.id),
    comments: [],
    created_at: m.created_at,
  };
};

app.get('/api/moments', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const autores = [userId, ...(await contactosDeUsuario(userId))];

    const { data: moments, error } = await supabase
      .from('moments')
      .select('*')
      .in('user_id', autores)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return espacioFallo(res, error);
    if (!moments || moments.length === 0) return res.json([]);

    const ids = moments.map(m => m.id);
    const userMap = {};
    const authorIds = [...new Set(moments.map(m => m.user_id))];
    const [likesRes, commentsRes, authorsRes] = await Promise.all([
      supabase.from('moment_likes').select('moment_id, user_id').in('moment_id', ids),
      supabase.from('moment_comments').select('*').in('moment_id', ids).order('created_at', { ascending: true }),
      supabase.from('users').select('id, full_name, avatar_url').in('id', authorIds),
    ]);
    if (authorsRes.error) return espacioFallo(res, authorsRes.error);
    (authorsRes.data || []).forEach(u => { userMap[u.id] = u; });

    const likesCount = {};
    (likesRes.data || []).forEach(l => { likesCount[l.moment_id] = (likesCount[l.moment_id] || 0) + 1; });
    const likedMine = new Set((likesRes.data || []).filter(l => l.user_id === userId).map(l => l.moment_id));

    const commentNames = {};
    const cIds = [...new Set((commentsRes.data || []).map(c => c.user_id))];
    if (cIds.length > 0) {
      const { data: cUsers } = await supabase.from('users').select('id, full_name').in('id', cIds);
      (cUsers || []).forEach(u => { commentNames[u.id] = u.full_name || 'Usuario'; });
    }

    const out = moments.map(m => {
      const p = momentoSinComentarios(m, userMap, likedMine);
      p.likes = likesCount[m.id] || 0;
      p.comments = (commentsRes.data || [])
        .filter(c => c.moment_id === m.id)
        .map(c => ({
          id: c.id, user_id: c.user_id, user_name: commentNames[c.user_id] || 'Usuario',
          text: c.text, created_at: c.created_at,
        }));
      return p;
    });
    res.json(out);
  } catch (e) { espacioFallo(res, e); }
});

app.post('/api/moments', auth, async (req, res) => {
  try {
    const { text, images, videos } = req.body;
    const limpio = (text || '').trim();
    const fotos = Array.isArray(images) ? images.filter(u => typeof u === 'string' && u.length > 0) : [];
    const clips = Array.isArray(videos) ? videos.filter(u => typeof u === 'string' && u.length > 0) : [];
    if (!limpio && fotos.length === 0 && clips.length === 0)
      return res.status(400).json({ message: 'texto o foto requeridos' });

    const { data, error } = await supabase
      .from('moments')
      .insert({ user_id: req.user.id, text: limpio, images: fotos, videos: clips })
      .select().single();
    if (error) return espacioFallo(res, error);

    const { data: me } = await supabase
      .from('users').select('id, full_name, avatar_url').eq('id', req.user.id).single();
    res.status(201).json(momentoSinComentarios(data, { [req.user.id]: me || {} }, new Set()));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// PATCH /api/moments/:id — editar el propio. El boton de editar existe en la app
// y llamaba a esta ruta: sin ella el modal guardaba, la pantalla mostraba el
// texto nuevo y al volver a abrir el momento seguia igual.
app.patch('/api/moments/:id', auth, async (req, res) => {
  try {
    const { data: actual } = await supabase
      .from('moments').select('id, user_id').eq('id', req.params.id).single();
    if (!actual) return res.status(404).json({ error: 'NO_ENCONTRADO', message: 'Ese momento no existe.' });
    if (actual.user_id !== req.user.id) {
      return res.status(403).json({ error: 'NO_ES_TUYO', message: 'Solo el autor edita su momento.' });
    }

    const cambios = {};
    if (typeof req.body?.text === 'string') cambios.text = req.body.text.trim();
    if (Array.isArray(req.body?.images)) cambios.images = req.body.images.filter(u => typeof u === 'string' && u.length > 0);
    if (Array.isArray(req.body?.videos)) cambios.videos = req.body.videos.filter(u => typeof u === 'string' && u.length > 0);
    if (Object.keys(cambios).length === 0)
      return res.status(400).json({ message: 'nada que guardar' });

    const { data, error } = await supabase
      .from('moments').update(cambios).eq('id', req.params.id).select().single();
    if (error) throw error;

    const { data: autor } = await supabase
      .from('users').select('id, full_name, avatar_url').eq('id', data.user_id).single();
    const { data: misLikes } = await supabase
      .from('moment_likes').select('moment_id').eq('moment_id', data.id).eq('user_id', req.user.id).maybeSingle();
    res.json(momentoSinComentarios(data, { [data.user_id]: autor || {} }, new Set(misLikes ? [data.id] : [])));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/moments/:id', auth, async (req, res) => {
  try {
    // `.eq('user_id', ...)` ya filtra, pero si no borra nada habria que decirlo:
    // responder `ok` con cero filas eliminadas es mentirle a la pantalla.
    const { data: borrados, error } = await supabase
      .from('moments').delete().eq('id', req.params.id).eq('user_id', req.user.id).select('id');
    if (error) throw error;
    if (!borrados || borrados.length === 0) {
      return res.status(403).json({ error: 'NO_ES_TUYO', message: 'Ese momento no es tuyo o ya no existe.' });
    }
    res.json({ ok: true, id: borrados[0].id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/moments/:id/like', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    // La clave del like es el par (moment_id, user_id): esa tabla puede no tener
    // columna `id`, y pedirla hacia que el alta saliera como error de columna y
    // el borrado del like existente no encontrara nada.
    const { data: existing } = await supabase
      .from('moment_likes').select('moment_id').eq('moment_id', id).eq('user_id', userId).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('moment_likes').delete().eq('moment_id', id).eq('user_id', userId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('moment_likes').insert({ moment_id: id, user_id: userId });
      if (error) throw error;
    }
    const { count } = await supabase
      .from('moment_likes').select('moment_id', { count: 'exact', head: true }).eq('moment_id', id);
    res.json({ liked: !existing, likes: count || 0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/moments/:id/comments', auth, async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('moment_comments').select('*').eq('moment_id', req.params.id).order('created_at', { ascending: true });
    if (error) return espacioFallo(res, error);
    if (!comments || comments.length === 0) return res.json([]);
    const ids = [...new Set(comments.map(c => c.user_id))];
    const { data: users } = await supabase.from('users').select('id, full_name').in('id', ids);
    const names = {};
    (users || []).forEach(u => { names[u.id] = u.full_name || 'Usuario'; });
    res.json(comments.map(c => ({
      id: c.id, user_id: c.user_id, user_name: names[c.user_id] || 'Usuario',
      text: c.text, created_at: c.created_at,
    })));
  } catch (e) { espacioFallo(res, e); }
});

app.post('/api/moments/:id/comments', auth, async (req, res) => {
  try {
    const limpio = (req.body?.text || '').trim();
    if (!limpio) return res.status(400).json({ message: 'texto requerido' });
    const { data, error } = await supabase
      .from('moment_comments')
      .insert({ moment_id: req.params.id, user_id: req.user.id, text: limpio })
      .select().single();
    if (error) return espacioFallo(res, error);
    const { data: me } = await supabase.from('users').select('full_name').eq('id', req.user.id).single();
    res.status(201).json({
      id: data.id, user_id: req.user.id, user_name: me?.full_name || 'Usuario',
      text: data.text, created_at: data.created_at,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// CONTENIDO NUEVO Y AVISOS DE ESPACIO DULCE
// ════════════════════════════════════════════════════════════════════

// Lo nuevo de las ultimas 24 horas, para el punto verde de la barra de
// mensajeria. La app llama a estas dos rutas cada 30 segundos: si responden 404
// el indicador nunca sale y el usuario no se entera de que alguien publico.
const desdeHace24h = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const nombresAutores = async (userIds) => {
  const map = {};
  if (userIds.length === 0) return map;
  const { data } = await supabase.from('users').select('id, full_name').in('id', userIds);
  (data || []).forEach(u => { map[u.id] = u.full_name || 'Usuario'; });
  return map;
};

app.get('/api/moments/contacts-new', auth, async (req, res) => {
  try {
    const contactos = await contactosDeUsuario(req.user.id);
    if (contactos.length === 0) return res.json([]);
    const { data, error } = await supabase
      .from('moments')
      .select('id, user_id, created_at')
      .in('user_id', contactos)
      .gte('created_at', desdeHace24h())
      .order('created_at', { ascending: false });
    if (error) return espacioFallo(res, error);
    const nombres = await nombresAutores([...new Set((data || []).map(m => m.user_id))]);
    res.json((data || []).map(m => ({ ...m, user_name: nombres[m.user_id] || 'Usuario' })));
  } catch (e) { espacioFallo(res, e); }
});

app.get('/api/stories/contacts-new', auth, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data: mine } = await supabase
      .from('stories')
      .select('user_id')
      .eq('user_id', req.user.id)
      .gte('created_at', desdeHace24h())
      .gt('expires_at', now);
    const ignorados = new Set((mine || []).map(s => s.user_id));
    const contactos = (await contactosDeUsuario(req.user.id)).filter(id => !ignorados.has(id));
    if (contactos.length === 0) return res.json([]);
    const { data, error } = await supabase
      .from('stories')
      .select('id, user_id, created_at')
      .in('user_id', contactos)
      .gte('created_at', desdeHace24h())
      .gt('expires_at', now)
      .order('created_at', { ascending: false });
    if (error) return espacioFallo(res, error);
    const nombres = await nombresAutores([...new Set((data || []).map(s => s.user_id))]);
    res.json((data || []).map(s => ({ ...s, user_name: nombres[s.user_id] || 'Usuario' })));
  } catch (e) { espacioFallo(res, e); }
});

// El aviso sale del servidor porque la lista de contactos y sus tokens de push
// solo viven aqui. El autor se excluye a si mismo y el dueno de la publicacion
// es el unico que puede dispararlo: si no, cualquiera avisaria a la agenda de
// otro usuario de un contenido que no es suyo.
const notificarContactos = async (userId, tabla, idParam, ruta, texto, columnaDueno = 'user_id') => {
  const { data: fila } = await supabase.from(tabla).select(`id, ${columnaDueno}`).eq('id', idParam).single();
  if (!fila) return { estado: 404, cuerpo: { error: 'NO_ENCONTRADO', message: `Ese ${ruta} no existe.` } };
  if (fila[columnaDueno] !== userId) return { estado: 403, cuerpo: { error: 'NO_ES_TUYO', message: `Ese ${ruta} no es tuyo.` } };

  const destinatarios = await contactosDeUsuario(userId);
  await Promise.allSettled(
    destinatarios.map(contactoId => sendPushToUser(contactoId, texto))
  );
  // No se cuenta como "enviados": sendPushToUser se traga sus propios errores y
  // un fulfilled aqui no significa que el telefono haya sonado. Lo que si es
  // cierto es a cuantos contactos se dirigio el aviso.
  return {
    estado: 200,
    cuerpo: { ok: true, destinatarios: destinatarios.length },
  };
};

app.post('/api/moments/:id/notify', auth, async (req, res) => {
  try {
    const nombre = (req.body?.authorName || 'Un contacto').toString().slice(0, 60);
    const preview = (req.body?.preview || 'Nuevo momento').toString().slice(0, 120);
    const r = await notificarContactos(req.user.id, 'moments', req.params.id, 'momento', {
      title: `${nombre} publico un momento`,
      body: preview,
      notificationType: 'moment_new',
      url: '/moments',
      tag: `momento-${req.params.id}`,
      momentId: req.params.id,
      senderName: nombre,
    });
    res.status(r.estado).json(r.cuerpo);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/stories/:storyId/notify', auth, async (req, res) => {
  try {
    const nombre = (req.body?.authorName || 'Un contacto').toString().slice(0, 60);
    const r = await notificarContactos(req.user.id, 'stories', req.params.storyId, 'estado', {
      title: `${nombre} publico un estado`,
      body: 'Toca para verlo',
      notificationType: 'story_new',
      url: '/stories',
      tag: `estado-${req.params.storyId}`,
      storyId: req.params.storyId,
      senderName: nombre,
    });
    res.status(r.estado).json(r.cuerpo);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// DIRECTOS (LIVE) — el registro, no el video
// ════════════════════════════════════════════════════════════════════
// El video viaja por los canales de realtime del telefono. Lo que faltaba era el
// registro: sin live_streams la pestaña de vivos no tenia donde leer quien estaba
// en directo, y el cliente inventaba un id y se lo apuntaba a si mismo.
// No hay columna de espectadores: nadie sabe ese numero hasta que exista presencia
// real, y un conteo escrito aparte es un numero que puede mentir.

app.post('/api/live/start', auth, async (req, res) => {
  try {
    const titulo = (req.body?.title || 'Directo').toString().slice(0, 80);
    // Un usuario no puede tener dos directos abiertos: si no se cierra el anterior
    // la lista de activos queda duplicada y nunca se apaga.
    await supabase.from('live_streams')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('host_id', req.user.id).eq('is_active', true);
    const { data, error } = await supabase
      .from('live_streams').insert({ host_id: req.user.id, title: titulo }).select().single();
    if (error) return espacioFallo(res, error);
    const { data: anfitrion } = await supabase
      .from('users').select('full_name, avatar_url').eq('id', req.user.id).single();
    res.status(201).json({
      liveId: data.id,
      host_id: req.user.id,
      host_name: anfitrion?.full_name || 'Usuario',
      host_avatar: anfitrion?.avatar_url || '',
      started_at: data.started_at,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/live/active', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('live_streams')
      .select('id, host_id, title, started_at')
      .eq('is_active', true)
      .gte('started_at', desdeHace24h())
      .order('started_at', { ascending: false });
    if (error) return espacioFallo(res, error);
    const hosts = [...new Set((data || []).map(l => l.host_id))];
    let perfiles = [];
    if (hosts.length > 0) {
      const r = await supabase.from('users').select('id, full_name, avatar_url').in('id', hosts);
      perfiles = r.data || [];
    }
    const mapa = {};
    perfiles.forEach(u => { mapa[u.id] = u; });
    res.json((data || []).map(l => ({
      live_id: l.id,
      id: l.id,
      host_id: l.host_id,
      host_name: mapa[l.host_id]?.full_name || 'Usuario',
      host_avatar: mapa[l.host_id]?.avatar_url || '',
      title: l.title,
      started_at: l.started_at,
    })));
  } catch (e) { espacioFallo(res, e); }
});

// POST /api/live/:liveId/end — lo llama el propio anfitrion al colgar. Antes el
// telefono hacia el update contra la tabla: sin un registro compartido el directo
// se quedaba activo para los demas aunque el dueno ya hubiera salido.
app.post('/api/live/:liveId/end', auth, async (req, res) => {
  try {
    const { data: directo } = await supabase
      .from('live_streams').select('id, host_id').eq('id', req.params.liveId).single();
    if (!directo) return res.status(404).json({ error: 'NO_ENCONTRADO', message: 'Ese directo no existe.' });
    if (directo.host_id !== req.user.id) {
      return res.status(403).json({ error: 'NO_ES_TUYO', message: 'Ese directo no es tuyo.' });
    }
    const { data, error } = await supabase
      .from('live_streams')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('id', req.params.liveId).eq('host_id', req.user.id).eq('is_active', true)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'NO_ENCONTRADO', message: 'Ese directo ya termino.' });
    }
    res.json({ ok: true, id: data[0].id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/live/:liveId/notify', auth, async (req, res) => {
  try {
    const nombre = (req.body?.hostName || 'Un contacto').toString().slice(0, 60);
    const r = await notificarContactos(req.user.id, 'live_streams', req.params.liveId, 'directo', {
      title: `${nombre} esta en directo`,
      body: 'Toca para unirte',
      notificationType: 'live_new',
      url: '/stories',
      tag: `directo-${req.params.liveId}`,
      liveId: req.params.liveId,
      senderName: nombre,
    }, 'host_id');
    res.status(r.estado).json(r.cuerpo);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// La tabla `stories` la crea tambien
// migrations/2026-11-05_espacio_dulce_lote_e1.sql y su presencia la comprueba
// ensureSpacesSchema arriba. Antes intentaba crearse ella sola con `exec_sql`, que
// ya no existe: el catch vacio se tragaba el fallo y los estados no salian.


app.get('/api/stories', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date().toISOString();

    // 1. Mis propios estados
    const { data: mine, error: mineError } = await supabase
      .from('stories')
      .select('*')
      .eq('user_id', userId)
      .gt('expires_at', now)
      .order('created_at', { ascending: false });

    if (mineError) return espacioFallo(res, mineError);

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
        replies: s.replies || [],
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
  } catch (e) { espacioFallo(res, e); }
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
        .insert({ user_id: req.user.id, media: newSlides, type, views: 0, reactions: [], replies: [], expires_at: expiresAt })
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

app.post('/api/stories/:storyId/reply', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: 'text requerido' });

    const { data: story, error: storyErr } = await supabase
      .from('stories')
      .select('id, user_id, replies')
      .eq('id', req.params.storyId)
      .single();

    if (storyErr || !story) return res.status(404).json({ message: 'Story no encontrada' });

    const replies = Array.isArray(story.replies) ? story.replies : [];
    const replyPayload = {
      id: `reply-${Date.now()}`,
      storyId: req.params.storyId,
      userId: req.user.id,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };

    const updatedReplies = [...replies, replyPayload];
    const { error: updateErr } = await supabase
      .from('stories')
      .update({ replies: updatedReplies })
      .eq('id', req.params.storyId);

    if (updateErr) throw updateErr;

    res.json({ ok: true, reply: replyPayload, replies: updatedReplies });
  } catch (e) { res.status(500).json({ message: e.message || 'No se pudo guardar la respuesta' }); }
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

// ─── WebRTC Signaling — persistido en Supabase ───────────────────────────────

// TURN token endpoint — credenciales temporales de relay
//
// Orden de preferencia: Cloudflare Realtime (los primeros 1.000 GB/mes son gratis y
// el relay solo se pisa cuando falla la conexion directa) → Twilio NTS → STUN publico.
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID  || '';
const TWILIO_API_KEY_SID  = process.env.TWILIO_API_KEY_SID  || '';
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || '';
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN   || '';
const CF_TURN_KEY_ID    = process.env.CF_TURN_KEY_ID || '';
// La doc de Cloudflare llama a este valor TURN_KEY_API_TOKEN y nosotros CF_TURN_KEY_SECRET en el
// panel; se aceptan los dos nombres para que un pegado con cualquiera de las dos letras funcione.
const CF_TURN_KEY_TOKEN = process.env.CF_TURN_KEY_SECRET || process.env.CF_TURN_KEY_API_TOKEN || '';
const CF_TURN_TTL       = parseInt(process.env.CF_TURN_TTL || '86400', 10);

async function getCloudflareIceServers() {
  if (!CF_TURN_KEY_ID || !CF_TURN_KEY_TOKEN) throw new Error('sin CF_TURN_KEY_ID + CF_TURN_KEY_SECRET');
  TURN_VIA = 'cloudflare';
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method:  'POST',
      headers: { authorization: `Bearer ${CF_TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
      body:    JSON.stringify({ ttl: CF_TURN_TTL }),
      signal:  AbortSignal.timeout(8000),
    }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // rtc.live responde {"error":"texto"}, no el envoltorio errors[] del API de Cloudflare.
    const e = data?.errors?.[0]?.message
      ?? (typeof data?.error === 'string' ? data.error : data?.error?.message)
      ?? data?.message;
    throw Object.assign(new Error(`Cloudflare ${r.status}: ${String(e ?? 'respuesta sin detalle').slice(0, 120)}`), { status: r.status });
  }
  // Devuelve el bloque ya en la forma {urls, username, credential} que lee useWebRTC.
  const servers = (Array.isArray(data.iceServers) ? data.iceServers : []).map(s => ({
    urls: s.urls,
    ...(s.username   ? { username:   s.username }   : {}),
    ...(s.credential ? { credential: s.credential } : {}),
  }));
  if (!servers.some(s => String(s.urls).includes('turn:'))) throw new Error('Cloudflare respondio sin entradas TURN');
  return servers;
}

async function getTwilioIceServers() {
  // La via limpia es una API key propia de NTS. Si no existe, el SDK tambien acepta
  // el token maestro de SMS como credenciales REST, asi que el TURN funciona sin
  // secretos nuevos: se avisa en el log, no es un reemplazo silencioso.
  const conApiKey = !!(TWILIO_ACCOUNT_SID && TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET);
  if (!conApiKey && !(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)) {
    throw new Error('sin credenciales de Twilio en el servicio');
  }
  if (!conApiKey) {
    console.warn('[turn] sin API key de NTS: los tokens salen del token maestro de SMS (TWILIO_AUTH_TOKEN)');
  }
  TURN_VIA = conApiKey ? 'apikey' : 'maestro';
  const client = require('twilio')(
    conApiKey ? TWILIO_API_KEY_SID : TWILIO_ACCOUNT_SID,
    conApiKey ? TWILIO_API_KEY_SECRET : TWILIO_AUTH_TOKEN,
    { accountSid: TWILIO_ACCOUNT_SID }
  );
  const token = await client.tokens.create({ ttl: 86400 });
  return token.iceServers.map(s => ({
    urls: s.url || s.urls,
    username: s.username,
    credential: s.credential,
  }));
}

// Prueba un proveedor y despues el siguiente; el error acumulado dice por que cada uno
// cayo, que es lo que necesita quien lea `turn.ultimo` en voip-status.
async function getIceServers() {
  const caidas = [];
  let http = null, codigo = null;
  for (const [nombre, fn] of [['cloudflare', getCloudflareIceServers], ['twilio', getTwilioIceServers]]) {
    try { return await fn(); }
    catch (e) {
      caidas.push(`${nombre}: ${redactarSecretos(e.message).slice(0, 120)}`);
      // Se guarda el primer estado HTTP que respondio un proveedor: es el que dice si la
      // clave TURN existe, si Twilio rechazó la credencial o si fue un fallo de red.
      if (http === null && e.status !== undefined) { http = e.status; codigo = e.code ?? null; }
    }
  }
  throw Object.assign(new Error(caidas.join(' | ')), { status: http ?? undefined, code: codigo ?? undefined });
}

// Solo STUN publicos: un TURN abierto y sin probar (openrelay) aporta candidatos
// muertos que retrasan la negociacion ICE en lugar de ayudar. El TURN real lo
// devuelven getCloudflareIceServers() o getTwilioIceServers().
const FALLBACK_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

// Estado del ultimo intento de TURN, para diagnosticar sin leer los logs del servicio.
// Nunca guarda valores de secretos: los mensajes se redactan antes de guardarse.
let TURN_VIA = null;
let TURN_ULTIMO = null;
const redactarSecretos = (s) => [TWILIO_AUTH_TOKEN, TWILIO_API_KEY_SECRET, TWILIO_ACCOUNT_SID, CF_TURN_KEY_TOKEN]
  .filter(Boolean)
  .reduce((acc, v) => acc.split(v).join('[secreto]'), String(s || ''));

// Ruta principal usada por el frontend
app.get('/api/turn-token', auth, async (req, res) => {
  try {
    const iceServers = await getIceServers();
    TURN_ULTIMO = {
      ok: true,
      en: new Date().toISOString(),
      via: TURN_VIA,
      servidores: iceServers.length,
      conTurn: iceServers.some(s => String(s.urls).includes('turn:')),
      // Solo las URLs: username y credential son la credencial del relay y no salen del proceso.
      urls: iceServers.flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls]),
    };
    res.json({ iceServers });
  } catch (e) {
    // Sin ningun proveedor el ICE se queda solo con STUN publico: la llamada timbra pero
    // el audio puede no conectar entre redes distintas. `e.message` ya trae por que cayo
    // cada proveedor, redactado y con nomes de variable.
    TURN_ULTIMO = {
      ok: false,
      en: new Date().toISOString(),
      via: TURN_VIA,
      codigo: e.code ?? null,
      http: e.status ?? null,
      mensaje: redactarSecretos(e.message).slice(0, 240),
    };
    console.error('TURN sin relay, se devuelven solo STUN publicos ·', TURN_ULTIMO.mensaje);
    res.json({ iceServers: FALLBACK_ICE });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH VoIP (PushKit → CallKit)
//
// Es la única forma de que un iPhone con la app cerrada muestre la ventana de
// llamada entrante: un banner normal de APNs no levanta la UI de CallKit, así
// que sin este push la llamada "llega como notificación" y no se puede contestar.
//
// Requiere en Render las variables de entorno:
//   APNS_KEY_P8   · contenido del AuthKey_XXXXXXXX.p8 (PEM de una línea o base64)
//   APNS_KEY_ID   · 10 caracteres (el nombre del archivo sin extensión)
//   APNS_TEAM_ID  · 10 caracteres
//   APNS_BUNDLE_ID· opcional, por defecto com.jallzstores.egchat
//   APNS_ENV      · opcional: production | sandbox
// Sin APNS_KEY_P8 la función devuelve configured:false y el llamador mantiene
// el comportamiento anterior (banner por Expo Push).
// ─────────────────────────────────────────────────────────────────────────────
const http2  = require('node:http2');

const APNS_VOIP_HOSTS = {
  production: 'api.push.apple.com',
  sandbox:    'api.sandbox.push.apple.com',
};

let _apnsVoipJwt    = null;
let _apnsVoipJwtIat = 0;

/** Convierte un callId arbitrario ("call_1698…") en el UUID que exige iOS 16. */
const uuidFromCallId = (callId) => {
  const h = crypto.createHash('md5').update(String(callId || '')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const getApnsVoipJwt = () => {
  const keyId  = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const raw    = process.env.APNS_KEY_P8;
  if (!keyId || !teamId || !raw) return null;

  const now = Math.floor(Date.now() / 1000);
  if (_apnsVoipJwt && now - _apnsVoipJwtIat < 3000) return _apnsVoipJwt;

  // Render no admite valores multilínea: se acepta PEM con "\n" literal o base64
  let keyP8 = raw.includes('BEGIN PRIVATE KEY') ? raw.replace(/\\n/g, '\n')
                                                : Buffer.from(raw, 'base64').toString('utf8');
  if (!keyP8.includes('BEGIN PRIVATE KEY')) return null;

  try {
    _apnsVoipJwt = jwt.sign({ iss: teamId, iat: now }, keyP8, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId },
    });
    _apnsVoipJwtIat = now;
    return _apnsVoipJwt;
  } catch (e) {
    console.error('[voip] JWT APNs no generado:', e.message);
    return null;
  }
};

/** Un POST a APNs para un token device. Nunca rechaza: devuelve {ok, reason}. */
const sendApnsVoip = (deviceToken, apnsJwt, payload) => new Promise((resolve) => {
  const host   = APNS_VOIP_HOSTS[process.env.APNS_ENV] || APNS_VOIP_HOSTS.production;
  const bundle = process.env.APNS_BUNDLE_ID || 'com.jallzstores.egchat';
  const client = http2.connect(`https://${host}`);

  let settled = false;
  const settle = (ok, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { client.destroy(); } catch {}
    resolve({ ok, reason });
  };
  const timer = setTimeout(() => settle(false, 'TIMEOUT'), 6000);

  client.on('error', (e) => settle(false, e.message));

  const req = client.request({
    ':method':          'POST',
    ':path':            `/3/device/${deviceToken}`,
    ':authority':       host,
    'authorization':    `bearer ${apnsJwt}`,
    'apns-push-type':   'voip',
    'apns-topic':       `${bundle}.voip`,
    'apns-priority':    '10',
    'apns-expiration':  String(Math.floor(Date.now() / 1000) + 90),
    'content-type':     'application/json',
  });

  let status = 0;
  let body   = '';
  req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
  req.on('data',     (d) => { body += d; });
  req.on('error',    (e) => settle(false, e.message));
  req.on('end',      () => {
    if (status === 200) return settle(true, null);
    let reason = `HTTP ${status}`;
    try { reason = JSON.parse(body).reason || reason; } catch {}
    settle(false, reason);
  });
  req.end(JSON.stringify(payload));
});

const sendVoipPushToUser = async (userId, call) => {
  try {
    const apnsJwt = getApnsVoipJwt();
    if (!apnsJwt) return { configured: false, delivered: false, reason: 'no_credentials' };

    const { data: voipSubs } = await supabase
      .from('expo_push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('token_type', 'voip')
      .neq('is_active', false);

    if (!voipSubs || voipSubs.length === 0) {
      console.log(`[voip] sin token para user=${String(userId).slice(0, 8)}: la llamada sale por otro canal`);
      return { configured: true, delivered: false, reason: 'no_voip_token' };
    }

    const payload = {
      aps: { 'content-available': 1 },
      'call-id':      String(call.callId),
      'call-uuid':    uuidFromCallId(call.callId),
      'call-timeout': 60,
      callId:         String(call.callId),
      callerName:     call.callerName || 'EGCHAT',
      callerAvatar:   call.callerAvatar || '',
      callType:       call.callType || 'audio',
      callerId:       call.callerId || '',
      ...(call.offer ? { offer: call.offer } : {}),
    };
    // APNs limita los pushes VoIP a 5KB. Si el offer SDP no cabe, el callee ya
    // lo recupera por polling (_fetchOfferWithRetry), así que se omite.
    if (Buffer.byteLength(JSON.stringify(payload)) > 4800) delete payload.offer;

    const results   = await Promise.all(voipSubs.map(s => sendApnsVoip(s.token, apnsJwt, payload)));
    const delivered = results.some(r => r.ok);
    if (delivered) console.log(`[voip] entregado por APNs a user=${String(userId).slice(0, 8)} (${voipSubs.length} token(s))`);
    else console.warn(`[voip] ${voipSubs.length} token(s), 0 entregados:`, results.map(r => r.reason).join(' | '));
    return { configured: true, delivered, reason: delivered ? null : (results[0] && results[0].reason) || 'failed' };
  } catch (e) {
    console.error('[voip] error:', e.message);
    return { configured: true, delivered: false, reason: e.message };
  }
};

/**
 * Push VoIP de señalización (aviso de respuesta o de fin), sin offer: es pequeño
 * y cabe siempre. La app lo traduce en CallKit: corta el timbre si la llamada
 * aún no estaba conectada. Sin este push, un iPhone suspendido no se entera de
 * que otra máquina contestó y sigue sonando hasta que caduca la sesión.
 */
const sendVoipSignalToUsers = async (userIds, callId, type, reason) => {
  try {
    // Un VoIP push obliga al binario a reportar una interacción de CallKit. Los
    // iPhone con 126/127 no leen `notificationType` y abrirían una llamada
    // fantasma, así que la señal no se emite solo porque existan las claves
    // APNs: hace falta además VOIP_SIGNAL_ENABLED=1, cuando el grupo esté en 129.
    if (process.env.VOIP_SIGNAL_ENABLED !== '1') {
      return { configured: false, delivered: false, reason: 'signal_disabled' };
    }
    const apnsJwt = getApnsVoipJwt();
    if (!apnsJwt) return { configured: false, delivered: false };

    const tokens = [];
    for (const id of userIds) {
      const { data } = await supabase
        .from('expo_push_tokens')
        .select('token')
        .eq('user_id', id)
        .eq('token_type', 'voip')
        .neq('is_active', false);
      (data || []).forEach(s => s.token && tokens.push(s.token));
    }
    const uniq = [...new Set(tokens)];
    if (uniq.length === 0) return { configured: true, delivered: false, reason: 'no_voip_token' };

    // El binario de TestFlight decide con estos dos campos si debe colgar la
    // llamada que ya está sonando: `notificationType` (los dos valores que
    // emite notifyCallPeer) o `status` (answered/ended/rejected/cancelled/
    // missed). Son alternativas en el cliente, así que se mandan los dos.
    const status = type === 'call_answered' ? 'answered'
      : (['rejected', 'cancelled', 'missed'].includes(String(reason || '')) ? String(reason) : 'ended');
    const payload = {
      aps: { 'content-available': 1 },
      callId:           String(callId),
      'call-uuid':      uuidFromCallId(callId),
      notificationType: type,
      status,
      reason: reason || status,
    };
    const results   = await Promise.all(uniq.map(t => sendApnsVoip(t, apnsJwt, payload)));
    const delivered = results.some(r => r.ok);
    if (!delivered) console.warn(`[voip-signal] ${type} ${callId}: 0/${uniq.length} entregados`);
    return { configured: true, delivered };
  } catch (e) {
    console.error('[voip-signal] error:', e.message);
    return { configured: true, delivered: false, reason: e.message };
  }
};

/**
 * Entrega una llamada entrante por el mejor canal disponible, en este orden:
 *   1. APNs VoIP directo (abre la ventana de CallKit con el teléfono bloqueado)
 *   2. Edge Function deliver-call-push (si Render tiene SERVICE_TOKEN configurado)
 *   3. Banner por Expo Push (comportamiento clásico)
 * Solo se usa un canal: si el anterior entregó, se corta para no timbrar dos veces.
 */
const deliverIncomingCall = async (targetUserId, call) => {
  const voip = await sendVoipPushToUser(targetUserId, call);
  if (voip.delivered) return { channel: 'voip', delivered: true };

  const edgeFnUrl = process.env.SUPABASE_URL
    ? `${process.env.SUPABASE_URL}/functions/v1/deliver-call-push`
    : null;

  if (edgeFnUrl && process.env.SERVICE_TOKEN) {
    try {
      const edgeRes = await fetch(edgeFnUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-token': process.env.SERVICE_TOKEN },
        body: JSON.stringify({
          callId:     call.callId,
          callerId:   call.callerId,
          callerName: call.callerName,
          callerAvatar: call.callerAvatar,
          calleeId:   targetUserId,
          callType:   call.callType || 'audio',
          offer:      call.offer || null,
        }),
      });
      if (edgeRes.ok) {
        const r = await edgeRes.json().catch(() => ({}));
        const s = r.results_summary || {};
        if (s.voip_sent > 0) return { channel: 'edge-voip', delivered: true };
        if (s.fcm_sent > 0 || s.expo_sent > 0) return { channel: 'edge-banner', delivered: true };
      }
    } catch (e) {
      console.warn('[deliver] Edge Function falló, se usa banner:', e.message);
    }
  }

  const isVideo = call.callType === 'video';
  await sendPushToUser(targetUserId, {
    title: isVideo ? `📹 Videollamada de ${call.callerName}` : `📞 Llamada de ${call.callerName}`,
    body:  isVideo ? 'Toca para responder la videollamada' : 'Toca para responder la llamada',
    tag: `call-${call.callId}`, requireInteraction: true,
    ...call,
    notificationType: 'incoming_call',
  });
  return { channel: 'banner', delivered: true };
};

// Iniciar llamada — caller envía offer + push al destinatario
// ─────────────────────────────────────────────────────────────────────────────
// LLAMADAS WebRTC — Señalización y gestión de estado
//
// FUENTE DE VERDAD: Supabase PostgreSQL via RPCs atómicas con FOR UPDATE.
//
// RACE CONDITIONS RESUELTAS:
//   Accept + Accept → solo uno hace la transición, el otro recibe 'idempotent'
//   Cancel + Accept → accept_call falla con invalid_transition
//   End + End       → end_call es idempotente
//   Dos dispositivos del callee → el primero acepta, el resto recibe 409
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/call/offer', auth, async (req, res) => {
  const { callId, offer, targetUserId, type, groupId } = req.body;
  if (!callId || !offer) return res.status(400).json({ error: 'callId y offer requeridos' });
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId requerido' });
  try {
    const nonce = `${callId}_${req.user.id}`;
    const { data: callData, error: callErr } = await supabase.rpc('initiate_call', {
      p_call_id:   callId,
      p_caller_id: req.user.id,
      p_callee_id: targetUserId,
      p_call_type: type || 'audio',
      p_offer:     offer,
      p_chat_id:   req.body.chatId || null,
      p_nonce:     nonce,
    });

    if (callErr) {
      if (callErr.message && callErr.message.includes('caller_already_in_call')) {
        return res.status(409).json({ error: 'El llamante ya tiene una llamada activa' });
      }
      // Fallback si la RPC no existe aún (migración no ejecutada)
      await supabase.from('call_sessions').upsert({
        call_id: callId, offer: JSON.stringify(offer), answer: null,
        caller_candidates: '[]', callee_candidates: '[]',
        type: type || 'audio', caller_id: req.user.id,
        target_user_id: targetUserId, ended: false,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        ...(groupId ? { group_id: groupId } : {}),
      }, { onConflict: 'call_id' });
    } else {
      // Guardar offer como texto para polling legacy
      await supabase.from('call_sessions').update({
        offer: JSON.stringify(offer), updated_at: new Date().toISOString(),
        ...(groupId ? { group_id: groupId } : {}),
      }).eq('call_id', callId);
    }

    let delivery = null;
    if (targetUserId) {
      try {
        const { data: caller } = await supabase
          .from('users').select('full_name, avatar_url').eq('id', req.user.id).single();
        const callInfo = {
          callId, callerId: req.user.id,
          callerName:   caller?.full_name || 'Alguien',
          callerAvatar: caller?.avatar_url || '',
          callType: type || 'audio', offer,
        };
        delivery = await deliverIncomingCall(targetUserId, callInfo);
        console.log(`[call/offer] ${callId} entregada por ${delivery.channel}`);
      } catch (pushErr) { console.warn('[call/offer] Push failed:', pushErr.message); }
    }

    res.json({ ok: true, delivery, idempotent: callData && callData.idempotent ? true : false });
  } catch (e) {
    console.error('[call/offer]', e.message);
    res.status(500).json({ error: 'Error iniciando llamada' });
  }
});

// Callee responde con answer — usa RPC atómica accept_call (FOR UPDATE)
app.post('/api/call/answer', auth, async (req, res) => {
  const { callId, answer } = req.body;
  if (!callId) return res.status(400).json({ error: 'callId requerido' });
  try {
    const { data, error } = await supabase.rpc('accept_call', {
      p_call_id:   callId,
      p_callee_id: req.user.id,
      p_answer:    answer || null,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('not_authorized'))        return res.status(403).json({ error: 'No autorizado' });
      if (msg.includes('call_not_found'))        return res.status(404).json({ error: 'Llamada no encontrada' });
      if (msg.includes('call_expired'))          return res.status(410).json({ error: 'La llamada ha caducado' });
      if (msg.includes('invalid_transition'))    return res.status(409).json({ error: 'Transición inválida: ' + msg });
      if (msg.includes('concurrent_modification')) return res.status(409).json({ error: 'La llamada ya fue respondida en otro dispositivo' });
      // Fallback si la RPC no existe
      const { data: existing } = await supabase.from('call_sessions').select('call_id, target_user_id').eq('call_id', callId).eq('ended', false).single();
      if (!existing) return res.status(404).json({ error: 'Llamada no encontrada' });
      if (String(existing.target_user_id) !== String(req.user.id)) return res.status(403).json({ error: 'No autorizado' });
      const fallbackUpdate = await supabase.from('call_sessions').update({
        answer: answer ? JSON.stringify(answer) : null,
        status: 'accepted',
        ended: false,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('call_id', callId).eq('target_user_id', String(req.user.id));
      if (fallbackUpdate.error) throw fallbackUpdate.error;
      await notifyCallPeer(callId, req.user.id, { type: 'call_answered', callId, reason: 'answered', ts: Date.now() });
      return res.json({ ok: true });
    }

    if (answer) {
      await supabase.from('call_sessions').update({
        answer: JSON.stringify(answer), updated_at: new Date().toISOString(),
      }).eq('call_id', callId);
    }

    // FIX: Enviar broadcast instantáneo CON EL ANSWER para parar el tono y conectar inmediatamente
    // Esto es mucho más rápido (< 50ms) que postgres_changes (200-500ms) + elimina el fetch extra
    try {
      const channel = supabase.channel(`call-state:${callId}`, {
        config: { broadcast: { self: false } }
      });
      await channel.subscribe();
      await channel.send({
        type: 'broadcast',
        event: 'call_status',
        payload: { 
          status: 'accepted', 
          callId,
          answer: answer ? JSON.parse(JSON.stringify(answer)) : null  // Incluir el answer en el broadcast
        }
      });
      console.log(`[call/answer] Broadcast sent: accepted with answer for ${callId}`);
      // Limpiar el canal después de enviar
      setTimeout(() => supabase.removeChannel(channel), 1000);
    } catch (broadcastErr) {
      console.warn('[call/answer] Broadcast failed:', broadcastErr.message);
    }

    await notifyCallPeer(callId, req.user.id, { type: 'call_answered', callId, reason: 'answered', ts: Date.now() });

    res.json({ ok: true, idempotent: data && data.idempotent ? true : false });
  } catch (e) {
    console.error('[call/answer]', e.message);
    res.status(500).json({ error: 'Error aceptando llamada' });
  }
});

// ICE candidates
app.post('/api/call/ice', auth, async (req, res) => {
  const { callId, candidate, role } = req.body;
  if (!callId || !candidate) return res.status(400).json({ error: 'callId y candidate requeridos' });
  try {
    const { data } = await supabase.from('call_sessions')
      .select('caller_candidates, callee_candidates, status, ended')
      .eq('call_id', callId).single();
    if (!data) return res.status(404).json({ error: 'Llamada no encontrada' });
    const status = data.status || '';
    if (data.ended || ['ended','rejected','missed','failed'].includes(status)) {
      return res.json({ ok: true, skipped: true });
    }
    const field = role === 'caller' ? 'caller_candidates' : 'callee_candidates';
    const arr = JSON.parse(data[field] || '[]');
    arr.push(candidate);
    await supabase.from('call_sessions').update({ [field]: JSON.stringify(arr), updated_at: new Date().toISOString() }).eq('call_id', callId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[call/ice]', e.message);
    res.status(500).json({ error: 'Error ICE' });
  }
});

// Polling — estado completo con campos nuevos
app.get('/api/call/:callId', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('call_sessions').select('*').eq('call_id', req.params.callId).maybeSingle();
    // Fila ya barrida: se devuelve estado terminal en vez de 404, que el cliente confundía con corte de red.
    if (!data) {
      return res.json({
        offer: null, answer: null, callerCandidates: [], calleeCandidates: [],
        type: null, callerId: null, targetUserId: null,
        ended: true, status: 'ended', connectedAt: null, endedAt: null,
        version: 0, gone: true,
      });
    }
    const ringExpired = !data.ended && !data.answer
      && ['new', 'calling', 'ringing'].includes(String(data.status || 'ringing'))
      && !!data.expires_at && new Date(data.expires_at).getTime() < Date.now();
    res.json({
      offer:            JSON.parse(data.offer || 'null'),
      answer:           data.answer ? JSON.parse(data.answer) : null,
      callerCandidates: JSON.parse(data.caller_candidates || '[]'),
      calleeCandidates: JSON.parse(data.callee_candidates || '[]'),
      type:             data.type,
      callerId:         data.caller_id,
      targetUserId:     data.target_user_id,
      ended:            ringExpired ? true : data.ended,
      status:           ringExpired ? 'missed' : (data.status || (data.ended ? 'ended' : 'ringing')),
      connectedAt:      data.connected_at || null,
      endedAt:          data.ended_at || null,
      version:          data.version || 1,
    });
  } catch (e) {
    console.error('[call/get]', e.message);
    res.status(500).json({ error: 'Error obteniendo estado' });
  }
});

// Terminar llamada — usa RPC end_call (idempotente)
app.delete('/api/call/:callId', auth, async (req, res) => {
  try {
    const reason = req.query.reason || 'normal';
    const { data, error } = await supabase.rpc('end_call', {
      p_call_id: req.params.callId,
      p_user_id: req.user.id,
      p_reason:  reason,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('not_authorized')) return res.status(403).json({ error: 'No autorizado' });
      if (msg.includes('call_not_found')) return res.json({ ok: true, idempotent: true });
      // Fallback
      await supabase.from('call_sessions').update({ ended: true, updated_at: new Date().toISOString() }).eq('call_id', req.params.callId);
    }

    await notifyCallPeer(req.params.callId, req.user.id, { type: 'call_ended', callId: req.params.callId, reason, ts: Date.now() });

    res.json({ ok: true, idempotent: data && data.idempotent ? true : false, duration_seconds: data && data.duration_seconds ? data.duration_seconds : 0 });
  } catch (e) {
    console.error('[call/delete]', e.message);
    res.status(500).json({ error: 'Error terminando llamada' });
  }
});

// Rechazar llamada — usa RPC reject_call
app.post('/api/call/reject', auth, async (req, res) => {
  const { callId } = req.body;
  if (!callId) return res.status(400).json({ error: 'callId requerido' });
  try {
    const { data, error } = await supabase.rpc('reject_call', { p_call_id: callId, p_callee_id: req.user.id });
    if (error) {
      const msg = error.message || '';
      if (msg.includes('not_authorized'))    return res.status(403).json({ error: 'No autorizado' });
      if (msg.includes('call_not_found'))    return res.status(404).json({ error: 'No encontrada' });
      if (msg.includes('invalid_transition')) return res.status(409).json({ error: msg });
      // Compatibilidad con instalaciones donde aún no existe reject_call.
      const { data: existing } = await supabase.from('call_sessions')
        .select('call_id, target_user_id, status, ended').eq('call_id', callId).maybeSingle();
      if (!existing) return res.status(404).json({ error: 'No encontrada' });
      if (String(existing.target_user_id) !== String(req.user.id)) return res.status(403).json({ error: 'No autorizado' });
      if (existing.ended || ['accepted', 'rejected', 'ended', 'missed', 'failed'].includes(existing.status)) {
        return res.json({ ok: true, idempotent: true });
      }
      const fallbackUpdate = await supabase.from('call_sessions').update({
        status: 'rejected', ended: true, ended_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('call_id', callId).eq('target_user_id', String(req.user.id));
      if (fallbackUpdate.error) throw fallbackUpdate.error;
      await notifyCallPeer(callId, req.user.id, { type: 'call_ended', callId, reason: 'rejected', ts: Date.now() });
      return res.json({ ok: true, idempotent: false });
    }
    await notifyCallPeer(callId, req.user.id, { type: 'call_ended', callId, reason: 'rejected', ts: Date.now() });
    res.json({ ok: true, idempotent: data && data.idempotent ? true : false });
  } catch (e) {
    console.error('[call/reject]', e.message);
    res.status(500).json({ error: 'Error rechazando llamada' });
  }
});

// Cancelar llamada (caller) — usa RPC cancel_call
app.post('/api/call/cancel', auth, async (req, res) => {
  const { callId } = req.body;
  if (!callId) return res.status(400).json({ error: 'callId requerido' });
  try {
    const { data, error } = await supabase.rpc('cancel_call', { p_call_id: callId, p_caller_id: req.user.id });
    if (error) {
      const msg = error.message || '';
      if (msg.includes('not_authorized'))    return res.status(403).json({ error: 'No autorizado' });
      if (msg.includes('call_not_found'))    return res.json({ ok: true, idempotent: true });
      if (msg.includes('invalid_transition')) return res.status(409).json({ error: msg });
      // Compatibilidad con instalaciones donde aún no existe cancel_call.
      const { data: existing } = await supabase.from('call_sessions')
        .select('call_id, caller_id, status, ended').eq('call_id', callId).maybeSingle();
      if (!existing) return res.json({ ok: true, idempotent: true });
      if (String(existing.caller_id) !== String(req.user.id)) return res.status(403).json({ error: 'No autorizado' });
      if (existing.ended || ['rejected', 'ended', 'missed', 'failed'].includes(existing.status)) {
        return res.json({ ok: true, idempotent: true });
      }
      const fallbackUpdate = await supabase.from('call_sessions').update({
        status: 'ended', ended: true, ended_at: new Date().toISOString(), end_reason: 'cancelled_by_caller', updated_at: new Date().toISOString(),
      }).eq('call_id', callId).eq('caller_id', String(req.user.id));
      if (fallbackUpdate.error) throw fallbackUpdate.error;
      await notifyCallPeer(callId, req.user.id, { type: 'call_ended', callId, reason: 'cancelled', ts: Date.now() });
      return res.json({ ok: true, idempotent: false });
    }
    await notifyCallPeer(callId, req.user.id, { type: 'call_ended', callId, reason: 'cancelled', ts: Date.now() });
    res.json({ ok: true, idempotent: data && data.idempotent ? true : false });
  } catch (e) {
    console.error('[call/cancel]', e.message);
    res.status(500).json({ error: 'Error cancelando llamada' });
  }
});

// Marcar connected — usa RPC mark_call_connected
app.post('/api/call/connected', auth, async (req, res) => {
  const { callId } = req.body;
  if (!callId) return res.status(400).json({ error: 'callId requerido' });
  try {
    const { data, error } = await supabase.rpc('mark_call_connected', { p_call_id: callId, p_user_id: req.user.id });
    if (error) { return res.json({ ok: true, skipped: true }); }
    res.json({ ok: true, idempotent: data && data.idempotent ? true : false });
  } catch (e) {
    res.json({ ok: true, skipped: true });
  }
});

// Reclamar llamada: el callee confirma antes de aceptar que la llamada sigue
// siendo suya. Evita que dos dispositivos del mismo usuario, o una UI abierta
// tarde desde CallKit, crean aceptar una llamada ya resuelta o caducada.
app.post('/api/calls/claim', auth, async (req, res) => {
  const { callId } = req.body;
  if (!callId) return res.status(400).json({ error: 'callId requerido' });
  try {
    const { data } = await supabase
      .from('call_sessions')
      .select('call_id, caller_id, target_user_id, status, ended, answer, expires_at')
      .eq('call_id', callId)
      .maybeSingle();
    if (!data) return res.status(404).json({ error: 'Llamada no encontrada', alreadyAccepted: true });
    if (String(data.target_user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'No autorizado', alreadyAccepted: true });
    }
    const taken = data.ended
      || !!data.answer
      || ['accepted', 'connecting', 'connected', 'ended', 'rejected', 'missed', 'failed', 'expired'].includes(data.status)
      || (data.expires_at && new Date(data.expires_at).getTime() < Date.now());
    if (taken) return res.json({ alreadyAccepted: true, status: data.status });

    await supabase.from('call_events').insert({
      call_id: callId,
      user_id: req.user.id,
      event: 'accepted',
      metadata: { claimed: true },
    });
    res.json({ alreadyAccepted: false, status: data.status });
  } catch (e) {
    console.error('[calls/claim]', e.message);
    // Si la consulta falla no se bloquea la aceptación: el cliente ignora este error.
    res.status(500).json({ error: 'Error reclamando llamada' });
  }
});

// Llamadas entrantes — solo status='ringing' y no expiradas
app.get('/api/call/incoming/:userId', auth, async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.userId)) return res.status(403).json({ error: 'No autorizado' });
    const { data } = await supabase.from('call_sessions')
      .select('*')
      .eq('target_user_id', req.params.userId)
      .in('status', ['ringing'])
      .eq('ended', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(3);
    if (!data || data.length === 0) return res.json([]);
    const callerIds = [...new Set(data.map(s => s.caller_id).filter(Boolean))];
    const { data: callers } = await supabase.from('users').select('id, full_name, avatar_url').in('id', callerIds);
    const callersById = new Map((callers || []).map(user => [String(user.id), user]));
    res.json(data.map(s => ({
      callId: s.call_id, callerId: s.caller_id,
      type: s.type, offer: JSON.parse(s.offer || 'null'), status: s.status,
      callerName: callersById.get(String(s.caller_id))?.full_name || 'Usuario',
      callerAvatar: callersById.get(String(s.caller_id))?.avatar_url || '',
    })));
  } catch (e) {
    console.error('[call/incoming]', e.message);
    res.json([]);
  }
});

// ════════════════════════════════════════════════════════════════════
// LLAMADAS GRUPALES — mesh WebRTC (hasta 9) con senalizacion por REST
// ════════════════════════════════════════════════════════════════════
// `group-call.tsx` y `useSFUGroupCall` ya existian en la app y pedian estas
// seis rutas; el servidor no las tenia, asi que la pantalla nunca llegaba a
// conectar. La app arma el roomId como `group_<chatId>_<Date.now()>`, distinto
// en cada arranque: se normaliza a `group_<chatId>` para que todos los del
// grupo caigan en la misma sala sin tocar la app ya instalada.
const salasLlamada = crearSalasDeLlamada();

const salaDeLlamada = (roomId) => {
  const m = /^group_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:_\d+)?$/
    .exec(String(roomId || ''));
  return m ? { sala: `group_${m[1]}`, chatId: m[1] } : null;
};

// Cada cliente solo reconoce el roomId con el que arranco, asi que el aviso
// se emite uno a uno con el suyo, no con el canonico.
const avisarSala = (sala, excepto, payload) => {
  for (const m of salasLlamada.miembros(sala)) {
    if (String(m.userId) === String(excepto)) continue;
    emitToUser(m.userId, { ...payload, roomId: m.roomIdCrudo });
  }
};

app.post('/api/call/room/:roomId/join', auth, async (req, res) => {
  try {
    const ref = salaDeLlamada(req.params.roomId);
    if (!ref) return res.status(400).json({ error: 'ROOM_INVALIDO', message: 'Sala de llamada invalida' });

    const mia = await participacionEnChat(ref.chatId, req.user.id);
    if (!mia) return res.status(403).json({ error: 'FORBIDDEN', message: 'No perteneces a este grupo' });

    let nombre = String(req.body?.name || '').trim();
    const avatar = String(req.body?.avatar || '');
    if (!nombre) {
      const { data: u } = await supabase.from('users').select('full_name').eq('id', req.user.id).maybeSingle();
      nombre = u?.full_name || 'Usuario';
    }

    const r = salasLlamada.unirse(ref.sala, req.user.id, {
      name: nombre,
      avatar,
      callType: req.body?.callType,
      roomIdCrudo: req.params.roomId,
    });
    if (!r.ok) {
      return res.status(409).json({ error: r.error, message: 'La llamada ya esta completa' });
    }

    // Quien ya estaba solo se entera; las offers las envia el recien llegado.
    avisarSala(ref.sala, req.user.id, {
      type: 'group_call_participant_joined',
      chatId: ref.chatId,
      userId: String(req.user.id),
      name: nombre,
      avatar,
    });

    console.log(`[call/room] ${ref.sala} entra ${req.user.id} (${r.participants.length + 1}/${MAX_LLAMADA_GRUPAL})`);
    res.json({ roomId: ref.sala, chatId: ref.chatId, participants: r.participants, max: MAX_LLAMADA_GRUPAL });
  } catch (e) {
    console.error('[call/room/join]', e.message);
    res.status(500).json({ error: 'Error al entrar en la llamada' });
  }
});

const rutaSenalSala = (tipo) => async (req, res) => {
  try {
    const ref = salaDeLlamada(req.params.roomId);
    if (!ref) return res.status(400).json({ error: 'ROOM_INVALIDO', message: 'Sala de llamada invalida' });

    const destino = String(req.body?.toUserId || '');
    const dato = tipo === 'ice' ? req.body?.candidate : req.body?.sdp;
    const ok = salasLlamada.senal(ref.sala, req.user.id, tipo, destino,
      tipo === 'ice' ? { candidate: dato } : { sdp: dato });
    if (!ok) return res.status(409).json({ error: 'SIN_DESTINO', message: 'El destinatario ya no esta en la llamada' });

    salasLlamada.tocar(ref.sala, req.user.id);
    // Adelanto por SSE; el sondeo de 800 ms sigue siendo la red de seguridad.
    const m = salasLlamada.miembros(ref.sala).find(x => String(x.userId) === destino);
    if (m) {
      emitToUser(destino, {
        type: 'group_call_signal',
        roomId: m.roomIdCrudo,
        from: String(req.user.id),
        signalType: tipo,
        ...(tipo === 'ice' ? { candidate: dato } : { sdp: dato }),
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(`[call/room/${tipo}]`, e.message);
    res.status(500).json({ error: 'Error enviando la senal' });
  }
};

app.post('/api/call/room/:roomId/offer', auth, rutaSenalSala('offer'));
app.post('/api/call/room/:roomId/answer', auth, rutaSenalSala('answer'));
app.post('/api/call/room/:roomId/ice', auth, rutaSenalSala('ice'));

app.get('/api/call/room/:roomId/signals', auth, (req, res) => {
  const ref = salaDeLlamada(req.params.roomId);
  if (!ref) return res.status(400).json({ error: 'ROOM_INVALIDO', message: 'Sala de llamada invalida' });
  // El sondeo cada 800 ms es tambien la senal de vida que renueva el TTL.
  salasLlamada.tocar(ref.sala, req.user.id);
  res.json(salasLlamada.pendientes(ref.sala, req.user.id));
});

app.delete('/api/call/room/:roomId/leave', auth, (req, res) => {
  const ref = salaDeLlamada(req.params.roomId);
  if (!ref) return res.status(400).json({ error: 'ROOM_INVALIDO', message: 'Sala de llamada invalida' });
  const r = salasLlamada.salir(ref.sala, req.user.id);
  if (r.ok) {
    avisarSala(ref.sala, req.user.id, {
      type: 'group_call_participant_left',
      chatId: ref.chatId,
      userId: String(req.user.id),
    });
  }
  res.json({ ok: true, left: r.ok, remaining: r.otros.length });
});

// Aviso al resto del grupo de que hay llamada en curso. La app lo llama al
// entrar en la sala; sin esto solo se enteraba quien pulsara llamar a la vez.
app.post('/api/call/room/:roomId/invite', auth, async (req, res) => {
  try {
    const ref = salaDeLlamada(req.params.roomId);
    if (!ref) return res.status(400).json({ error: 'ROOM_INVALIDO', message: 'Sala de llamada invalida' });

    const dentro = salasLlamada.miembros(ref.sala).map(m => String(m.userId));
    if (!dentro.includes(String(req.user.id))) {
      return res.status(409).json({ error: 'NO_ESTAS_EN_LA_SALA', message: 'Entra en la llamada antes de invitar' });
    }

    const { data: partes } = await supabase
      .from('chat_participants').select('user_id').eq('chat_id', ref.chatId);
    const destinos = [...new Set((partes || []).map(p => String(p.user_id)))]
      .filter(id => !dentro.includes(id));

    const callType = req.body?.callType === 'video' ? 'video' : 'audio';
    const nombre = String(req.body?.name || '').trim() || 'Alguien';
    for (const id of destinos) {
      emitToUser(id, {
        type: 'group_call_invited',
        roomId: ref.sala,
        chatId: ref.chatId,
        fromUserId: String(req.user.id),
        name: nombre,
        callType,
      });
      // Si tiene la app cerrada, el aviso llega como notificacion normal.
      sendPushToUser(id, {
        title: `${nombre} · ${callType === 'video' ? 'videollamada grupal' : 'llamada de grupo'}`,
        body: 'Toca para unirte',
        notificationType: 'group_call_invited',
        roomId: ref.sala,
        chatId: ref.chatId,
        callType,
      }).catch(() => {});
    }
    res.json({ ok: true, invited: destinos.length, roomId: ref.sala });
  } catch (e) {
    console.error('[call/room/invite]', e.message);
    res.status(500).json({ error: 'Error invitando al grupo' });
  }
});

setInterval(() => salasLlamada.barrer(), 60000).unref?.();

// Limpieza periódica usando RPC expire_stale_calls
setInterval(async () => {
  try {
    await supabase.rpc('expire_stale_calls');
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await supabase.from('call_sessions').delete()
      .in('status', ['ended','rejected','missed','failed'])
      .lt('ended_at', cutoff);
  } catch (e) { console.warn('[cleanup]', e.message); }
}, 300000);
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Ejecutar migraciones SQL (temporal, usar una sola vez)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/admin/run-migration', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!isAdminKeyValid(key)) return res.status(403).json({ message: 'No autorizado' });
  const { migration } = req.body; // 'calls' | 'tokens'
  const results = [];

  // Migración 1: sistema de llamadas (tablas + RPCs atómicas)
  const callsMigration = `
    -- Ampliar call_sessions
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='status') THEN
        ALTER TABLE call_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','accepted','connecting','connected','reconnecting','rejected','missed','ended','failed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='expires_at') THEN
        ALTER TABLE call_sessions ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='connected_at') THEN
        ALTER TABLE call_sessions ADD COLUMN connected_at TIMESTAMPTZ;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='ended_at') THEN
        ALTER TABLE call_sessions ADD COLUMN ended_at TIMESTAMPTZ;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='duration_seconds') THEN
        ALTER TABLE call_sessions ADD COLUMN duration_seconds INTEGER;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='end_reason') THEN
        ALTER TABLE call_sessions ADD COLUMN end_reason TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='version') THEN
        ALTER TABLE call_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='chat_id') THEN
        ALTER TABLE call_sessions ADD COLUMN chat_id UUID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='offer_nonce') THEN
        ALTER TABLE call_sessions ADD COLUMN offer_nonce TEXT;
      END IF;
    END $$;

    -- Tabla call_participants
    CREATE TABLE IF NOT EXISTS call_participants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id VARCHAR(100) NOT NULL REFERENCES call_sessions(call_id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('caller','callee')),
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      left_at TIMESTAMPTZ,
      UNIQUE (call_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id, call_id);

    -- Tabla call_signals
    CREATE TABLE IF NOT EXISTS call_signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id VARCHAR(100) NOT NULL REFERENCES call_sessions(call_id) ON DELETE CASCADE,
      from_user UUID NOT NULL,
      to_user UUID,
      signal_type TEXT NOT NULL CHECK (signal_type IN ('offer','answer','ice','restart_ice')),
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      nonce TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_call_signals_call ON call_signals(call_id, created_at);

    -- Tabla call_events
    CREATE TABLE IF NOT EXISTS call_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id VARCHAR(100) NOT NULL REFERENCES call_sessions(call_id) ON DELETE CASCADE,
      user_id UUID,
      event TEXT NOT NULL CHECK (event IN ('initiated','push_sent','ringing','accepted','connecting','connected','reconnecting','ended','rejected','missed','failed','expired')),
      metadata JSONB DEFAULT '{}',
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id, occurred_at);

    -- Índices adicionales
    CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_call_sessions_caller ON call_sessions(caller_id, status);
    CREATE INDEX IF NOT EXISTS idx_call_sessions_expires ON call_sessions(expires_at) WHERE status NOT IN ('ended','rejected','missed','failed');
  `;

  // RPC initiate_call
  const rpcInitiate = `
    CREATE OR REPLACE FUNCTION initiate_call(p_call_id TEXT, p_caller_id UUID, p_callee_id UUID, p_call_type TEXT DEFAULT 'audio', p_offer JSONB DEFAULT NULL, p_chat_id UUID DEFAULT NULL, p_nonce TEXT DEFAULT NULL)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_existing call_sessions%ROWTYPE; v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '90 seconds';
    BEGIN
      IF p_nonce IS NOT NULL THEN
        SELECT * INTO v_existing FROM call_sessions WHERE offer_nonce = p_nonce LIMIT 1;
        IF FOUND THEN RETURN jsonb_build_object('call_id', v_existing.call_id, 'status', v_existing.status, 'idempotent', true); END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM call_sessions WHERE caller_id = p_caller_id::TEXT AND status NOT IN ('ended','rejected','missed','failed') AND expires_at > NOW()) THEN
        RAISE EXCEPTION 'caller_already_in_call';
      END IF;
      INSERT INTO call_sessions (call_id, offer, caller_candidates, callee_candidates, type, caller_id, target_user_id, ended, status, expires_at, chat_id, offer_nonce, created_at, updated_at, version)
      VALUES (p_call_id, CASE WHEN p_offer IS NOT NULL THEN p_offer::TEXT ELSE NULL END, '[]', '[]', p_call_type, p_caller_id::TEXT, p_callee_id::TEXT, FALSE, 'ringing', v_expires_at, p_chat_id, p_nonce, NOW(), NOW(), 1)
      ON CONFLICT (call_id) DO NOTHING;
      INSERT INTO call_participants (call_id, user_id, role) VALUES (p_call_id, p_caller_id, 'caller'), (p_call_id, p_callee_id, 'callee') ON CONFLICT (call_id, user_id) DO NOTHING;
      INSERT INTO call_events (call_id, user_id, event, metadata) VALUES (p_call_id, p_caller_id, 'initiated', jsonb_build_object('type', p_call_type));
      RETURN jsonb_build_object('call_id', p_call_id, 'status', 'ringing', 'expires_at', v_expires_at, 'idempotent', false);
    END; $$;
  `;

  const rpcAccept = `
    CREATE OR REPLACE FUNCTION accept_call(p_call_id TEXT, p_callee_id UUID, p_answer JSONB DEFAULT NULL)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_session call_sessions%ROWTYPE;
    BEGIN
      SELECT * INTO v_session FROM call_sessions WHERE call_id = p_call_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'call_not_found'; END IF;
      IF v_session.target_user_id <> p_callee_id::TEXT THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF v_session.expires_at < NOW() THEN
        UPDATE call_sessions SET status='missed', ended=TRUE, ended_at=NOW(), updated_at=NOW() WHERE call_id=p_call_id;
        RAISE EXCEPTION 'call_expired';
      END IF;
      IF v_session.status <> 'ringing' THEN
        IF v_session.status = 'accepted' THEN RETURN jsonb_build_object('call_id', p_call_id, 'status', 'accepted', 'idempotent', true); END IF;
        RAISE EXCEPTION 'invalid_transition: %', v_session.status;
      END IF;
      UPDATE call_sessions SET status='accepted', answer=CASE WHEN p_answer IS NOT NULL THEN p_answer::TEXT ELSE answer END, expires_at=NOW()+INTERVAL '30 minutes', updated_at=NOW(), version=version+1 WHERE call_id=p_call_id AND version=v_session.version;
      IF NOT FOUND THEN RAISE EXCEPTION 'concurrent_modification'; END IF;
      INSERT INTO call_events (call_id, user_id, event) VALUES (p_call_id, p_callee_id, 'accepted');
      RETURN jsonb_build_object('call_id', p_call_id, 'status', 'accepted', 'idempotent', false);
    END; $$;
  `;

  const rpcReject = `
    CREATE OR REPLACE FUNCTION reject_call(p_call_id TEXT, p_callee_id UUID)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_session call_sessions%ROWTYPE;
    BEGIN
      SELECT * INTO v_session FROM call_sessions WHERE call_id=p_call_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'call_not_found'; END IF;
      IF v_session.target_user_id <> p_callee_id::TEXT THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF v_session.status IN ('rejected','ended','missed','failed') THEN RETURN jsonb_build_object('call_id',p_call_id,'status',v_session.status,'idempotent',true); END IF;
      IF v_session.status NOT IN ('ringing') THEN RAISE EXCEPTION 'invalid_transition: %', v_session.status; END IF;
      UPDATE call_sessions SET status='rejected',ended=TRUE,ended_at=NOW(),updated_at=NOW(),version=version+1 WHERE call_id=p_call_id AND version=v_session.version;
      INSERT INTO call_events (call_id, user_id, event) VALUES (p_call_id, p_callee_id, 'rejected');
      RETURN jsonb_build_object('call_id',p_call_id,'status','rejected');
    END; $$;
  `;

  const rpcCancel = `
    CREATE OR REPLACE FUNCTION cancel_call(p_call_id TEXT, p_caller_id UUID)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_session call_sessions%ROWTYPE;
    BEGIN
      SELECT * INTO v_session FROM call_sessions WHERE call_id=p_call_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'call_not_found'; END IF;
      IF v_session.caller_id <> p_caller_id::TEXT THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF v_session.status IN ('ended','rejected','missed','failed') THEN RETURN jsonb_build_object('call_id',p_call_id,'status',v_session.status,'idempotent',true); END IF;
      UPDATE call_sessions SET status='ended',ended=TRUE,ended_at=NOW(),end_reason='cancelled_by_caller',updated_at=NOW(),version=version+1 WHERE call_id=p_call_id AND version=v_session.version;
      INSERT INTO call_events (call_id, user_id, event, metadata) VALUES (p_call_id, p_caller_id, 'ended', '{"reason":"cancelled_by_caller"}');
      RETURN jsonb_build_object('call_id',p_call_id,'status','ended');
    END; $$;
  `;

  const rpcMarkConnected = `
    CREATE OR REPLACE FUNCTION mark_call_connected(p_call_id TEXT, p_user_id UUID)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_session call_sessions%ROWTYPE;
    BEGIN
      SELECT * INTO v_session FROM call_sessions WHERE call_id=p_call_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'call_not_found'; END IF;
      IF v_session.caller_id <> p_user_id::TEXT AND v_session.target_user_id <> p_user_id::TEXT THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF v_session.status = 'connected' THEN RETURN jsonb_build_object('call_id',p_call_id,'status','connected','idempotent',true); END IF;
      IF v_session.status NOT IN ('accepted','connecting','reconnecting') THEN RAISE EXCEPTION 'invalid_transition: %', v_session.status; END IF;
      UPDATE call_sessions SET status='connected',connected_at=COALESCE(connected_at,NOW()),updated_at=NOW(),version=version+1 WHERE call_id=p_call_id AND version=v_session.version;
      INSERT INTO call_events (call_id, user_id, event) VALUES (p_call_id, p_user_id, 'connected');
      RETURN jsonb_build_object('call_id',p_call_id,'status','connected');
    END; $$;
  `;

  const rpcEnd = `
    CREATE OR REPLACE FUNCTION end_call(p_call_id TEXT, p_user_id UUID, p_reason TEXT DEFAULT 'normal')
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_session call_sessions%ROWTYPE; v_duration INTEGER := 0; v_final_status TEXT;
    BEGIN
      SELECT * INTO v_session FROM call_sessions WHERE call_id=p_call_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('call_id',p_call_id,'status','ended','idempotent',true); END IF;
      IF v_session.caller_id <> p_user_id::TEXT AND v_session.target_user_id <> p_user_id::TEXT THEN RAISE EXCEPTION 'not_authorized'; END IF;
      IF v_session.status IN ('ended','rejected','missed','failed') THEN RETURN jsonb_build_object('call_id',p_call_id,'status',v_session.status,'idempotent',true); END IF;
      v_final_status := CASE WHEN p_reason='ice_failed' THEN 'failed' WHEN p_reason='missed' THEN 'missed' ELSE 'ended' END;
      IF v_session.connected_at IS NOT NULL THEN v_duration := EXTRACT(EPOCH FROM (NOW()-v_session.connected_at))::INTEGER; END IF;
      UPDATE call_sessions SET status=v_final_status,ended=TRUE,ended_at=NOW(),end_reason=p_reason,duration_seconds=CASE WHEN v_duration>0 THEN v_duration ELSE NULL END,updated_at=NOW(),version=version+1 WHERE call_id=p_call_id AND version=v_session.version;
      INSERT INTO call_events (call_id, user_id, event, metadata) VALUES (p_call_id, p_user_id, CASE WHEN v_final_status='failed' THEN 'failed' WHEN v_final_status='missed' THEN 'missed' ELSE 'ended' END, jsonb_build_object('reason',p_reason,'duration_seconds',v_duration));
      RETURN jsonb_build_object('call_id',p_call_id,'status',v_final_status,'duration_seconds',v_duration);
    END; $$;
  `;

  const rpcExpire = `
    CREATE OR REPLACE FUNCTION expire_stale_calls()
    RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_count INTEGER;
    BEGIN
      WITH expired AS (UPDATE call_sessions SET status='missed',ended=TRUE,ended_at=NOW(),end_reason='timeout',updated_at=NOW() WHERE status NOT IN ('ended','rejected','missed','failed') AND expires_at < NOW() RETURNING call_id, caller_id)
      INSERT INTO call_events (call_id, user_id, event, metadata) SELECT call_id, caller_id::UUID, 'expired', '{"reason":"timeout"}' FROM expired;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      RETURN v_count;
    END; $$;
  `;

  const rpcGetState = `
    CREATE OR REPLACE FUNCTION get_call_state(p_call_id TEXT, p_user_id UUID)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE v_session call_sessions%ROWTYPE;
    BEGIN
      SELECT * INTO v_session FROM call_sessions WHERE call_id=p_call_id;
      IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
      IF v_session.caller_id <> p_user_id::TEXT AND v_session.target_user_id <> p_user_id::TEXT THEN RAISE EXCEPTION 'not_authorized'; END IF;
      RETURN jsonb_build_object('found',true,'call_id',v_session.call_id,'status',v_session.status,'ended',v_session.ended,'type',v_session.type,'caller_id',v_session.caller_id,'target_user_id',v_session.target_user_id,'offer',CASE WHEN v_session.offer IS NOT NULL THEN v_session.offer::JSONB ELSE NULL END,'answer',CASE WHEN v_session.answer IS NOT NULL THEN v_session.answer::JSONB ELSE NULL END,'caller_candidates',v_session.caller_candidates::JSONB,'callee_candidates',v_session.callee_candidates::JSONB,'expires_at',v_session.expires_at,'connected_at',v_session.connected_at,'version',v_session.version);
    END; $$;
  `;

  const stepsToRun = migration === 'tokens' ? [] : [
    ['create tables', callsMigration],
    ['rpc initiate_call', rpcInitiate],
    ['rpc accept_call', rpcAccept],
    ['rpc reject_call', rpcReject],
    ['rpc cancel_call', rpcCancel],
    ['rpc mark_call_connected', rpcMarkConnected],
    ['rpc end_call', rpcEnd],
    ['rpc expire_stale_calls', rpcExpire],
    ['rpc get_call_state', rpcGetState],
  ];

  for (const [label, sql] of stepsToRun) {
    try {
      const { error } = await supabase.rpc('exec_sql', { sql });
      if (error) {
        results.push({ step: label, ok: false, error: error.message });
      } else {
        results.push({ step: label, ok: true });
      }
    } catch(e) {
      results.push({ step: label, ok: false, error: e.message });
    }
  }

  // Migración de tokens de dispositivo (más simple)
  if (!migration || migration === 'tokens') {
    const tokenMigration = `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expo_push_tokens' AND column_name='token_type') THEN
          ALTER TABLE expo_push_tokens ADD COLUMN token_type TEXT NOT NULL DEFAULT 'expo' CHECK (token_type IN ('expo','fcm','apns','voip'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expo_push_tokens' AND column_name='is_active') THEN
          ALTER TABLE expo_push_tokens ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expo_push_tokens' AND column_name='failure_count') THEN
          ALTER TABLE expo_push_tokens ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expo_push_tokens' AND column_name='device_id') THEN
          ALTER TABLE expo_push_tokens ADD COLUMN device_id TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expo_push_tokens' AND column_name='last_used_at') THEN
          ALTER TABLE expo_push_tokens ADD COLUMN last_used_at TIMESTAMPTZ DEFAULT NOW();
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_expo_push_tokens_active ON expo_push_tokens(user_id, is_active, token_type) WHERE is_active = TRUE;
    `;
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: tokenMigration });
      results.push({ step: 'token_migration', ok: !error, note: error?.message });
    } catch(e) {
      results.push({ step: 'token_migration', ok: false, error: e.message });
    }
  }

  res.json({ results, message: 'Migración ejecutada. Verificar resultados.' });
});

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
      .select('token, token_type')
      .eq('user_id', userId)
      .in('token_type', ['expo', 'fcm', 'apns'])
      .neq('is_active', false);

    // Se envían TODOS los tokens guardados, incluidos los APNs crudos (64 hex):
    // exp.host los entrega con la clave APNs del proyecto, y muchos iPhone están
    // registrados así. Filtrar solo por forma Expo dejó esos dispositivos sin
    // ninguna notificación (2026-11-02).
    const expoTokens = [...new Set((expoSubs || []).map(s => s.token).filter(Boolean))];

    if (expoTokens.length > 0) {
      const expoMessages = expoTokens.map(token => ({
        to: token,
        title: payload.title || 'EGChat',
        body: payload.body || (isCall ? 'Llamada entrante' : 'Nuevo mensaje'),
        // El nombre debe coincidir con el archivo que la app instala en
        // Library/Sounds del contenedor (useSounds.installIosPushSound).
        sound: isCall ? 'default' : 'egchat-message.wav',
        badge: isCall ? 0 : Number(payload.badge ?? 1),
        channelId: isCall ? 'egchat-calls-v2' : 'egchat-messages',
        // En iOS el channelId no existe: la categoría con acciones (Aceptar /
        // Rechazar) se registra desde la app con setNotificationCategoryAsync.
        ...(isCall ? { categoryIdentifier: 'EGCHAT_CALL' } : {}),
        priority: isCall ? 'high' : 'normal',
        // Campo EXACTO que acepta la API REST de Expo (no "_mutableContent"):
        // exp.host lo traduce a aps["mutable-content"]=1 y hace que iOS lance
        // la Notification Service Extension, donde se descarga y pega la foto.
        // El "mutable-content" de dentro de `data` NO sirve: cae en el diccionario
        // data, no en aps, y la extensión nunca corre. En llamadas no se activa
        // para no interferir con CallKit.
        ...(!isCall ? { mutableContent: true } : {}),
        data: {
          ...payload,
          'mutable-content': 1,
          // Asegurar que notificationType siempre está presente para que el cliente
          // pueda distinguir mensajes de llamadas
          notificationType: payload.notificationType || 'message',
          imageUrl: payload.imageUrl || payload.callerAvatar || payload.icon || '',
          senderName: payload.senderName || payload.callerName || '',
          senderAvatar: payload.senderAvatar || payload.callerAvatar || payload.icon || '',
          messageType: payload.messageType || 'text',
          chatId: payload.chatId || '',
          // Llamadas: incluir el offer en el push para que el callee
          // no tenga que esperar a Render al despertar
          ...(isCall && payload.offer ? { offer: payload.offer } : {}),
          ...(isCall ? {
            callId: payload.callId || '',
            callerId: payload.callerId || '',
            callerName: payload.callerName || '',
            callType: payload.callType || 'audio',
          } : {}),
        },
        // richContent es un campo de web-push (PWA), Expo lo ignora en nativo;
        // la foto nativa la pone la extensión gracias a mutableContent arriba.
        // Se mantiene solo para la PWA.
        ...(!isCall && (payload.callerAvatar || payload.senderAvatar || payload.imageUrl || (typeof payload.icon === 'string' && /^https?:\/\//.test(payload.icon)))
          ? { richContent: { image: payload.callerAvatar || payload.senderAvatar || payload.imageUrl || payload.icon } }
          : {}),
        // Llamadas: TTL de 120s
        ...(isCall ? { ttl: 120, expiration: Math.floor(Date.now() / 1000) + 120 } : {}),
      }));

      for (let i = 0; i < expoMessages.length; i += 100) {
        const batch = expoMessages.slice(i, i + 100);
        try {
          const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              // Con Expo Access Token el envío usa la vía autenticada de la
              // cuenta; sin él se queda en el modo anónimo y limitado.
              ...(process.env.EXPO_ACCESS_TOKEN
                ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
                : {}),
            },
            body: JSON.stringify(batch),
          });
          const result = await expoRes.json();
          if (result.errors?.length) {
            console.warn(`[Push Expo] user=${userId} exp.host rechazó el lote:`, JSON.stringify(result.errors).slice(0, 400));
          }
          if (result.data) {
            const tickets = result.data
              .map((r, idx) => ({ r, token: batch[idx].to }));
            const invalid = tickets
              .filter(({ r }) => r.status === 'error' && r.details?.error === 'DeviceNotRegistered');
            if (invalid.length > 0) {
              await Promise.allSettled(
                invalid.map(({ token }) => supabase.from('expo_push_tokens').delete().eq('token', token))
              );
            }
            // Cualquier otro fallo se registra con el usuario: antes desaparecía
            // en silencio y no sabíamos si el mensaje llegó o no al teléfono.
            tickets
              .filter(({ r }) => r.status === 'error' && r.details?.error !== 'DeviceNotRegistered')
              .forEach(({ r, token }) => {
                console.warn(`[Push Expo] user=${userId} token=${String(token).slice(0, 22)}… error=${r.details?.error || 'desconocido'}: ${r.message || ''}`);
              });
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
// ── Registrar token push (Expo, FCM, APNs, VoIP) ──────────────────────────
// Punto de entrada unificado para todos los tipos de token.
// Delega a la Supabase Edge Function register-device-token.
app.post('/api/push/register-expo-token', auth, async (req, res) => {
  try {
    const { expoPushToken, platform, tokenType } = req.body;
    const token = expoPushToken || req.body.token;

    if (!token || token.length < 10) {
      return res.status(400).json({ message: 'Token inválido' });
    }

    // Determinar tipo de token automáticamente si no se especifica
    const isExpoToken = token.startsWith('ExponentPushToken');
    const isHexAPNs = token.length === 64 && /^[0-9a-f]+$/i.test(token);
    const type = tokenType || (isExpoToken ? 'expo' : isHexAPNs ? 'apns' : 'fcm');
    // Tokens APNs nativos: guardar en DB pero no enviar directo a APNs.
    // El ExponentPushToken iOS usa APNs via Expo internamente (correcto).
    console.log(`[Push] Registrando token tipo=${type} platform=${platform||'unknown'} user=${req.user.id}`);

    // Intentar via Edge Function primero (tiene soporte completo de tipos)
    const edgeFnUrl = process.env.SUPABASE_URL
      ? `${process.env.SUPABASE_URL}/functions/v1/register-device-token`
      : null;

    if (edgeFnUrl) {
      try {
        const edgeRes = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${req.headers.authorization?.replace('Bearer ', '')}`,
          },
          body: JSON.stringify({
            token,
            tokenType:  type,
            platform:   platform || 'android',
            deviceId:   req.body.deviceId || null,
          }),
        });
        if (edgeRes.ok) {
          return res.json({ message: 'Token registrado', tokenType: type });
        }
      } catch (edgeErr) {
        console.warn('[push/register] Edge Function falló, usando fallback:', edgeErr.message);
      }
    }

    // Fallback: upsert directo en Supabase (compatibilidad hacia atrás)
    await supabase.from('expo_push_tokens').upsert({
      user_id:    req.user.id,
      token,
      token_type: type,
      platform:   platform || 'android',
      is_active:  true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token' });

    res.json({ message: 'Token registrado', tokenType: type });
  } catch (e) {
    console.error('Token register error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// ── Registrar token VoIP (iOS PushKit) ────────────────────────────────────
app.post('/api/push/register-voip-token', auth, async (req, res) => {
  try {
    const { voipToken } = req.body;
    if (!voipToken || voipToken.length < 32) {
      return res.status(400).json({ message: 'Token VoIP inválido' });
    }
    await supabase.from('expo_push_tokens').upsert({
      user_id:    req.user.id,
      token:      voipToken,
      token_type: 'voip',
      platform:   'ios',
      is_active:  true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token' });
    // Solo longitudes: el token VoIP es un secreto de dispositivo y los logs de
    // Render son legibles por cualquiera con acceso al servicio.
    console.log(`[voip] token registrado user=${String(req.user.id).slice(0, 8)} len=${voipToken.length}`);
    res.json({ message: 'Token VoIP registrado' });
  } catch (e) {
    console.error('VoIP token register error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// ── Diagnóstico del canal de llamadas ──────────────────────────────────────
// Devuelve solo booleanos y conteos (nunca valores de secretos ni tokens):
// permite ver desde la app por qué una llamada se entrega como banner.
app.get('/api/push/voip-status', auth, async (req, res) => {
  try {
    const { data: subs } = await supabase
      .from('expo_push_tokens')
      .select('token_type')
      .eq('user_id', req.user.id)
      .neq('is_active', false);
    const counts = {};
    for (const s of (subs || [])) counts[s.token_type] = (counts[s.token_type] || 0) + 1;

    res.json({
      apnsConfigured:   !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID),
      signalEnabled:    process.env.VOIP_SIGNAL_ENABLED === '1',
      apnsEnv:          process.env.APNS_ENV || 'production',
      apnsBundle:       process.env.APNS_BUNDLE_ID || 'com.jallzstores.egchat',
      edgeFnConfigured: !!(process.env.SUPABASE_URL && process.env.SERVICE_TOKEN),
      tokens:           counts,
      turn: {
        conCloudflare: !!(process.env.CF_TURN_KEY_ID && (process.env.CF_TURN_KEY_SECRET || process.env.CF_TURN_KEY_API_TOKEN)),
        conApiKey:  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET),
        conMaestro: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
        ultimo:     TURN_ULTIMO,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Entregar llamada entrante via push ────────────────────────────────────
// deliverIncomingCall elige el canal: VoIP nativo → Edge Function → banner Expo.
app.post('/api/push/voip-call', auth, async (req, res) => {
  try {
    const { targetUserId, callId, callType, offer, callerName: bodyCallerName } = req.body;

    if (!targetUserId || !callId) {
      return res.status(400).json({ message: 'targetUserId y callId son requeridos' });
    }

    // Obtener nombre del caller si no viene en el body
    let callerName = bodyCallerName;
    if (!callerName) {
      const { data: caller } = await supabase
        .from('users')
        .select('full_name, avatar_url')
        .eq('id', req.user.id)
        .single();
      callerName = caller?.full_name || 'EGChat';
    }

    const delivery = await deliverIncomingCall(targetUserId, {
      callId, callerId: req.user.id, callerName,
      callType: callType || 'audio', offer: offer || null,
    });

    res.json({
      voipPushSent: delivery.channel === 'voip' || delivery.channel === 'edge-voip',
      expoPushSent: delivery.channel === 'banner' || delivery.channel === 'edge-banner',
      delivered:    delivery.delivered,
      channel:      delivery.channel,
    });
  } catch (e) {
    console.error('/api/push/voip-call error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────

// Admin: verificar suscripciones por teléfono
app.get('/api/push/check/:phone', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!isAdminKeyValid(key)) {
    return res.status(403).json({ message: 'No autorizado' });
  }
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { user, ambiguous } = await findAuthUserByPhone(phone, 'id, full_name, phone');
    if (!user) return res.status(404).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'Usuario no encontrado' });
    const { data: subs } = await supabase.from('push_subscriptions').select('id, endpoint, updated_at').eq('user_id', user.id);
    res.json({ user: { id: user.id, name: user.full_name, phone: user.phone }, subscriptions: (subs || []).length, details: (subs || []).map(s => ({ id: s.id, endpoint: s.endpoint.slice(0, 80) + '...', updated_at: s.updated_at })) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Admin: enviar push de prueba por teléfono
app.post('/api/push/send-test/:phone', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!isAdminKeyValid(key)) {
    return res.status(403).json({ message: 'No autorizado' });
  }
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { user, ambiguous } = await findAuthUserByPhone(phone, 'id, full_name');
    if (!user) return res.status(404).json({ message: ambiguous ? AMBIGUO_MENSAJE : 'Usuario no encontrado' });
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
  if (!enableExternalNewsScraping) {
    console.log('[GovNews] Scheduler desactivado por ENABLE_EXTERNAL_NEWS_SCRAPING!=1');
    return;
  }
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
    if (!enableExternalNewsScraping) {
      return res.json({
        noticias: NOTICIAS_FALLBACK.map((n, i) => ({ id: `gov-fb-${i}`, ...n, scrapedAt: Date.now() })),
        fromCache: true,
        updatedAt: Date.now(),
        externalScrapingDisabled: true,
      });
    }
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

const RSS_FEEDS_PROXY = [
  { url: 'https://lagacetadeguinea.com/feed/', source: 'La Gaceta de Guinea' },
  { url: 'https://www.guineaecuatorialpress.com/feed/', source: 'Guinea Ecuatorial Press' },
];

function stripXmlText(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function parseRssItems(xml, source) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (let index = 0; index < blocks.length && items.length < 12; index++) {
    const block = blocks[index];
    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || block.match(/<dc:date>([\s\S]*?)<\/dc:date>/i);
    const title = titleMatch ? stripXmlText(titleMatch[1]) : '';
    if (!title || title.length < 4) continue;
    let time = 'Reciente';
    if (pubMatch) {
      const date = new Date(pubMatch[1].trim());
      if (!Number.isNaN(date.getTime())) {
        const hours = Math.round((Date.now() - date.getTime()) / 3600000);
        time = hours < 1 ? 'Hace un momento' : hours < 24 ? `Hace ${hours} h` : 'Ayer';
      }
    }
    items.push({
      id: `rss-${source}-${index}`,
      title,
      source,
      time,
      url: linkMatch ? stripXmlText(linkMatch[1]) : undefined,
    });
  }
  return items;
}

async function fetchRssFeed(feed) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(feed.url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Mozilla/5.0 (compatible; EGChatProxy/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, feed.source);
  } catch (err) {
    return [];
  }
}

app.get('/api/news/rss', async (req, res) => {
  try {
    if (!enableExternalNewsScraping) {
      return res.json({ news: [], externalScrapingDisabled: true });
    }
    const results = await Promise.allSettled(RSS_FEEDS_PROXY.map(fetchRssFeed));
    const news = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const uniqueNews = news.filter((item, idx, arr) => arr.findIndex(x => x.title === item.title) === idx).slice(0, 12);
    return res.json({ news: uniqueNews });
  } catch (e) {
    return res.json({ news: [] });
  }
});

if (require.main === module) {
  // ── Servidor HTTP + WebSocket SFU ──────────────────────────────
  const http = require('http');
  const { WebSocketServer } = require('ws');

  const httpServer = http.createServer(app);

  // Salas SFU: roomId → Map<userId, { ws, userId, name, avatar }>
  const sfuRooms = new Map();

  const wss = new WebSocketServer({ server: httpServer, path: '/api/call/sfu-ws' });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const roomId = url.searchParams.get('roomId') || '';
    const token  = url.searchParams.get('token') || '';

    let myUserId = '';
    let myName   = 'Usuario';

    // Verificar token
    try { const decoded = verifyToken(token); myUserId = String(decoded.id); }
    catch { ws.close(4001, 'Token inválido'); return; }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {

          case 'join': {
            myName = msg.name || 'Usuario';
            const avatar = msg.avatar || '';

            if (!sfuRooms.has(roomId)) sfuRooms.set(roomId, new Map());
            const room = sfuRooms.get(roomId);

            // Enviar estado actual de la sala al nuevo participante
            const currentParticipants = [...room.values()].map(p => ({
              userId: p.userId, name: p.name, avatar: p.avatar,
            }));
            ws.send(JSON.stringify({ type: 'room_state', participants: currentParticipants }));

            // Notificar a todos de la llegada
            room.forEach(p => {
              if (p.ws.readyState === p.ws.OPEN) {
                p.ws.send(JSON.stringify({
                  type: 'participant_joined', userId: myUserId, name: myName, avatar,
                }));
              }
            });

            room.set(myUserId, { ws, userId: myUserId, name: myName, avatar });
            break;
          }

          case 'offer':
          case 'answer':
          case 'ice': {
            const room = sfuRooms.get(roomId);
            const target = room?.get(msg.to);
            if (target?.ws?.readyState === target.ws.OPEN) {
              target.ws.send(JSON.stringify({ ...msg, from: myUserId }));
            }
            break;
          }

          case 'mute_update': {
            const room = sfuRooms.get(roomId);
            room?.forEach(p => {
              if (p.userId !== myUserId && p.ws.readyState === p.ws.OPEN) {
                p.ws.send(JSON.stringify({
                  type: 'mute_update', userId: myUserId,
                  isMuted: msg.isMuted, isCamOff: msg.isCamOff,
                }));
              }
            });
            break;
          }

          case 'leave': handleLeave(); break;
        }
      } catch {}
    });

    function handleLeave() {
      const room = sfuRooms.get(roomId);
      if (!room) return;
      room.delete(myUserId);
      room.forEach(p => {
        if (p.ws.readyState === p.ws.OPEN) {
          p.ws.send(JSON.stringify({ type: 'participant_left', userId: myUserId }));
        }
      });
      if (room.size === 0) sfuRooms.delete(roomId);
    }

    ws.on('close', handleLeave);
    ws.on('error', handleLeave);
  });

  httpServer.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n😎 EGCHAT API + WebSocket SFU en http://0.0.0.0:${PORT}`);
    console.log(`   SFU WebSocket: ws://0.0.0.0:${PORT}/api/call/sfu-ws`);
    console.log(`   Max participantes por sala: 9`);
    console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅ Conectado' : '❌ Sin configurar'}`);
    // Iniciar scheduler de noticias del gobierno
    startGovNewsScheduler();
    console.log(`   Auth:   POST /api/auth/register | /api/auth/login`);
    console.log(`   Wallet: GET  /api/wallet/balance | POST /api/wallet/deposit`);
    console.log(`   Lia-25: POST /api/lia/chat\n`);
    // Crear buckets si no existen (avatares + archivos de chat)
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketList = buckets || [];

      for (const bucketName of ['chat-files', 'avatars']) {
        const exists = bucketList.some(b => b.name === bucketName);
        if (!exists) {
          const { error: bErr } = await supabase.storage.createBucket(bucketName, {
            public: true,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'audio/m4a', 'application/octet-stream'],
            fileSizeLimit: 52428800, // 50MB
          });
          if (bErr) console.log(`Bucket ${bucketName} ya existe o error:`, bErr.message);
          else console.log(`✅ Bucket ${bucketName} creado`);
        } else {
          // Asegurar que sea público
          await supabase.storage.updateBucket(bucketName, { public: true }).catch(() => {});
          console.log(`✅ Bucket ${bucketName} OK (público)`);
        }
      }
    } catch (e) {
      console.log('Bucket check error:', e.message);
    }

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
      `});
    } catch {}
  });
}

// ══════════════════════════════════════════════════════════════════
// ADMIN AUTH — Login de administradores KYC (email + password)
// Tabla: admin_users (creada por migración 008_kyc_aml_complete.sql)
// ══════════════════════════════════════════════════════════════════

app.post('/auth/admin/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'email y password son requeridos' });

    if (!supabase)
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Base de datos no disponible' });

    const { data: admin, error } = await supabase
      .from('admin_users')
      .select('*')
      .eq('email', email.trim().toLowerCase())
      .eq('is_active', true)
      .maybeSingle();

    if (error || !admin)
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email o contraseña incorrectos' });

    // Verificar contraseña con bcrypt
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok)
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email o contraseña incorrectos' });

    // Actualizar last_login
    await supabase.from('admin_users').update({ last_login: new Date().toISOString() }).eq('id', admin.id);

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, entity: admin.entity, type: 'admin' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({
      access_token: token,
      token_type:   'bearer',
      expires_in:   8 * 3600,
      admin_id:     admin.id,
      role:         admin.role,
      entity:       admin.entity,
    });
  } catch (e) {
    console.error('[Admin login error]', e.message);
    res.status(500).json({ error: 'SERVER_ERROR', message: e.message });
  }
});

app.get('/auth/admin/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'NO_TOKEN', message: 'Token requerido' });

    let payload;
    try { payload = verifyToken(token); } catch {
      return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token inválido o expirado' });
    }

    if (payload.type !== 'admin')
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Token de usuario no válido aquí' });

    if (!supabase)
      return res.json({ id: payload.id, email: payload.email, role: payload.role, entity: payload.entity, is_active: true, last_login: null });

    const { data: admin } = await supabase
      .from('admin_users')
      .select('id, email, role, entity, is_active, last_login')
      .eq('id', payload.id)
      .maybeSingle();

    if (!admin)
      return res.status(401).json({ error: 'ADMIN_NOT_FOUND', message: 'Admin no encontrado' });

    res.json(admin);
  } catch (e) {
    res.status(500).json({ error: 'SERVER_ERROR', message: e.message });
  }
});

app.post('/auth/admin/logout', async (req, res) => {
  // JWT stateless — el cliente descarta el token
  res.status(204).end();
});

// ── Estadísticas KYC para el dashboard ───────────────────────────
app.get('/admin/kyc/stats', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.json({ total_applications:0, pending_review:0, approved_today:0, rejected_today:0, avg_risk_score:0, high_risk_count:0, screening_hits_unreviewed:0, sars_overdue:0 });

    const today = new Date(); today.setHours(0,0,0,0);

    const [total, pending, approvedToday, rejectedToday, highRisk, sarsOverdue] = await Promise.all([
      supabase.from('kyc_verifications').select('id', { count: 'exact', head: true }),
      supabase.from('kyc_verifications').select('id', { count: 'exact', head: true })
        .in('status', ['submitted','PENDING_REVIEW','under_review','MANUAL_REVIEW']),
      supabase.from('kyc_verifications').select('id', { count: 'exact', head: true })
        .in('status', ['approved','APPROVED','AUTO_APPROVED'])
        .gte('reviewed_at', today.toISOString()),
      supabase.from('kyc_verifications').select('id', { count: 'exact', head: true })
        .in('status', ['rejected','REJECTED'])
        .gte('reviewed_at', today.toISOString()),
      supabase.from('kyc_verifications').select('id', { count: 'exact', head: true })
        .in('risk_level', ['high','HIGH']),
      supabase.from('suspicious_activity_reports').select('id', { count: 'exact', head: true })
        .not('status', 'in', '("SENT_TO_ANIF","ACKNOWLEDGED","CLOSED")')
        .lt('detected_at', new Date(Date.now() - 72*3600*1000).toISOString()),
    ]);

    res.json({
      total_applications:        total.count          ?? 0,
      pending_review:            pending.count        ?? 0,
      approved_today:            approvedToday.count  ?? 0,
      rejected_today:            rejectedToday.count  ?? 0,
      avg_risk_score:            0,
      high_risk_count:           highRisk.count       ?? 0,
      screening_hits_unreviewed: 0,
      sars_overdue:              sarsOverdue.count    ?? 0,
    });
  } catch (e) {
    console.error('[KYC stats error]', e.message);
    res.status(500).json({ error: 'SERVER_ERROR', message: e.message });
  }
});

// ── Lista KYC pendientes ──────────────────────────────────────────
app.get('/admin/kyc/pending', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.json({ items:[], total:0, page:1, page_size:20, pages:0 });

    const page      = parseInt(req.query.page) || 1;
    const pageSize  = parseInt(req.query.page_size) || 20;
    const status    = req.query.status;
    const riskLevel = req.query.risk_level;

    const defaultStatuses = ['submitted','PENDING_REVIEW','under_review','MANUAL_REVIEW'];
    const statuses = status ? [status] : defaultStatuses;

    let query = supabase
      .from('kyc_verifications')
      .select(`id, session_id, status, risk_level, risk_score, bank_decision, submitted_at, created_at,
               full_name, nationality, doc_type,
               users:user_id (id, phone, status)`,
              { count: 'exact' })
      .in('status', statuses)
      .order('submitted_at', { ascending: true, nullsFirst: false })
      .range((page-1)*pageSize, page*pageSize - 1);

    if (riskLevel) query = query.eq('risk_level', riskLevel);

    const { data, count, error } = await query;
    if (error) throw error;

    const items = (data || []).map((a) => ({
      application_id:   a.id,
      session_id:       a.session_id,
      status:           a.status,
      risk_level:       a.risk_level || 'low',
      risk_score:       a.risk_score || 0,
      bank_decision:    a.bank_decision,
      submitted_at:     a.submitted_at,
      created_at:       a.created_at,
      user_phone:       a.users?.phone,
      user_status:      a.users?.status,
      full_name:        a.full_name,
      nationality:      a.nationality,
      document_type:    a.doc_type,
      ocr_confidence:   null,
      face_match_score: null,
      liveness_passed:  null,
      screening_hits:   0,
    }));

    res.json({ items, total: count || 0, page, page_size: pageSize, pages: Math.ceil((count || 0) / pageSize) });
  } catch (e) {
    console.error('[KYC pending error]', e.message);
    res.status(500).json({ error: 'SERVER_ERROR', message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// FIN ADMIN AUTH
// ══════════════════════════════════════════════════════════════════

// ── Helpers de KYC ───────────────────────────────────────────────
const KYC_STATUS = {
  NONE:         'none',
  PENDING:      'pending',
  APPROVED:     'approved',
  REJECTED:     'rejected',
  SUSPENDED:    'suspended',
};

const KYC_DB_STATUS = {
  DRAFT:        'draft',
  SUBMITTED:    'submitted',
  UNDER_REVIEW: 'under_review',
  APPROVED:     'approved',
  REJECTED:     'rejected',
  SUSPENDED:    'suspended',
};

// Inicializar bucket kyc-docs en Supabase Storage (idempotente)
async function ensureKycBucket() {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = (buckets || []).some(b => b.name === 'kyc-docs');
    if (!exists) {
      await supabase.storage.createBucket('kyc-docs', {
        public: false, // privado — solo accesible con token de servicio
        allowedMimeTypes: ['image/jpeg','image/png','image/webp','application/pdf'],
        fileSizeLimit: 10 * 1024 * 1024, // 10 MB por documento
      });
      console.log('✅ Bucket kyc-docs creado');
    }
  } catch (e) {
    console.warn('[KYC] ensureKycBucket:', e.message);
  }
}
ensureKycBucket();

// ── GET /api/kyc/status — estado actual del KYC del usuario ───────
app.get('/api/kyc/status', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Primero intentar con Supabase
    if (supabase) {
      const { data: kyc, error } = await supabase
        .from('kyc_verifications')
        .select('id, status, rejection_reason, submitted_at, reviewed_at, full_name, doc_type, doc_number')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;

      // Obtener wallet_kyc_status del usuario
      const { data: userData } = await supabase
        .from('users')
        .select('wallet_kyc_status, wallet_kyc_reject_reason')
        .eq('id', userId)
        .maybeSingle();

      return res.json({
        kyc_status: userData?.wallet_kyc_status || KYC_STATUS.NONE,
        kyc_record: kyc || null,
        rejection_reason: userData?.wallet_kyc_reject_reason || kyc?.rejection_reason || null,
        wallet_enabled: userData?.wallet_kyc_status === KYC_STATUS.APPROVED,
      });
    }

    // Fallback local
    return res.json({ kyc_status: KYC_STATUS.NONE, kyc_record: null, wallet_enabled: false });
  } catch (e) {
    console.error('[KYC] status error:', e.message);
    res.status(500).json({ message: 'Error al obtener estado KYC', error: e.message });
  }
});

// ── POST /api/kyc/draft — guardar borrador (pasos 1 y 2) ─────────
// Permite guardar progreso sin enviar definitivamente
app.post('/api/kyc/draft', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      full_name, birth_date, nationality, gender,
      address, city, occupation,
      doc_type, doc_number, doc_expiry,
    } = req.body;

    if (!supabase) {
      return res.json({ success: true, message: 'Borrador guardado (modo local)' });
    }

    // Upsert: un solo registro por usuario
    const { data, error } = await supabase
      .from('kyc_verifications')
      .upsert({
        user_id:    userId,
        status:     KYC_DB_STATUS.DRAFT,
        full_name:  full_name?.trim() || '',
        birth_date: birth_date || null,
        nationality: nationality || 'GQ',
        gender:     gender || null,
        address:    address?.trim() || null,
        city:       city?.trim() || null,
        occupation: occupation?.trim() || null,
        doc_type:   doc_type || 'dni',
        doc_number: doc_number?.trim() || '',
        doc_expiry: doc_expiry || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select('id')
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, kyc_id: data?.id });
  } catch (e) {
    console.error('[KYC] draft error:', e.message);
    res.status(500).json({ message: 'Error al guardar borrador KYC', error: e.message });
  }
});

// ── POST /api/kyc/submit — envío final (paso 3, con selfie lista) ─
app.post('/api/kyc/submit', auth, kycLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      full_name, birth_date, nationality, gender,
      address, city, occupation,
      doc_type, doc_number, doc_expiry,
      doc_front_url, doc_back_url, selfie_url,
      device_info,
    } = req.body;

    // Validaciones mínimas
    if (!full_name?.trim())   return res.status(400).json({ message: 'Nombre completo requerido' });
    if (!birth_date)           return res.status(400).json({ message: 'Fecha de nacimiento requerida' });
    if (!doc_number?.trim())  return res.status(400).json({ message: 'Número de documento requerido' });
    if (!doc_front_url)        return res.status(400).json({ message: 'Foto del documento requerida' });
    if (!selfie_url)           return res.status(400).json({ message: 'Selfie de verificación requerida' });

    if (!supabase) {
      // Modo local: simular aprobación inmediata en entorno de desarrollo
      return res.json({
        success: true,
        kyc_status: KYC_STATUS.PENDING,
        message: 'Solicitud enviada. Revisaremos tu identidad en 24-48 horas.',
      });
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('kyc_verifications')
      .upsert({
        user_id:       userId,
        status:        KYC_DB_STATUS.SUBMITTED,
        full_name:     full_name.trim(),
        birth_date,
        nationality:   nationality || 'GQ',
        gender:        gender || null,
        address:       address?.trim() || null,
        city:          city?.trim() || null,
        occupation:    occupation?.trim() || null,
        doc_type:      doc_type || 'dni',
        doc_number:    doc_number.trim(),
        doc_expiry:    doc_expiry || null,
        doc_front_url: doc_front_url || null,
        doc_back_url:  doc_back_url || null,
        selfie_url:    selfie_url || null,
        device_info:   device_info || {},
        submitted_at:  now,
        updated_at:    now,
      }, { onConflict: 'user_id' })
      .select('id')
      .maybeSingle();

    if (error) throw error;

    // El trigger sync_user_kyc_status actualizará users.wallet_kyc_status automáticamente

    res.json({
      success: true,
      kyc_id: data?.id,
      kyc_status: KYC_STATUS.PENDING,
      message: 'Solicitud enviada correctamente. Revisaremos tu identidad en 24-48 horas hábiles.',
    });
  } catch (e) {
    console.error('[KYC] submit error:', e.message);
    res.status(500).json({ message: 'Error al enviar solicitud KYC', error: e.message });
  }
});

// ── POST /api/kyc/upload — subir imagen de documento o selfie ─────
// Recibe form-data con campo "file" y tipo "doc_front"|"doc_back"|"selfie"
app.post('/api/kyc/upload', auth, kycLimiter, async (req, res) => {
  try {
    const userId = req.user.id;

    // Usar multer en memoria para procesar el archivo
    const multer = (() => { try { return require('multer'); } catch { return null; } })();
    if (!multer) {
      return res.status(500).json({ message: 'Módulo multer no disponible en el servidor' });
    }

    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ message: 'Error al procesar archivo', error: err.message });
      if (!req.file) return res.status(400).json({ message: 'No se recibió ningún archivo' });

      const docType   = (req.body.doc_type || 'doc_front').replace(/[^a-z_]/g, '');
      const ext       = req.file.mimetype === 'application/pdf' ? 'pdf' : 'jpg';
      const filePath  = `${userId}/${docType}_${Date.now()}.${ext}`;

      if (!supabase) {
        return res.json({ success: true, url: `local://${filePath}`, path: filePath });
      }

      const { data, error: upErr } = await supabase.storage
        .from('kyc-docs')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      if (upErr) throw upErr;

      // URL firmada válida por 1 año (para revisión interna)
      const { data: signedData } = await supabase.storage
        .from('kyc-docs')
        .createSignedUrl(filePath, 365 * 24 * 3600);

      const url = signedData?.signedUrl || data?.path || filePath;
      res.json({ success: true, url, path: filePath });
    });
  } catch (e) {
    console.error('[KYC] upload error:', e.message);
    res.status(500).json({ message: 'Error al subir archivo KYC', error: e.message });
  }
});

// ── GET /api/kyc/draft — recuperar borrador guardado ─────────────
app.get('/api/kyc/draft', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!supabase) return res.json({ draft: null });

    const { data, error } = await supabase
      .from('kyc_verifications')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    res.json({ draft: data || null });
  } catch (e) {
    console.error('[KYC] get-draft error:', e.message);
    res.status(500).json({ message: 'Error al recuperar borrador', error: e.message });
  }
});

// ── POST /api/kyc/resubmit — reintentar tras rechazo ─────────────
app.post('/api/kyc/resubmit', auth, kycLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!supabase) return res.json({ success: true });

    // Verificar que el estado sea "rejected" para poder reintentar
    const { data: existing } = await supabase
      .from('kyc_verifications')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing && existing.status !== KYC_DB_STATUS.REJECTED) {
      return res.status(400).json({
        message: `No puedes reintentar en estado: ${existing.status}`,
      });
    }

    // Resetear a draft para que pueda volver a rellenar
    await supabase
      .from('kyc_verifications')
      .update({
        status: KYC_DB_STATUS.DRAFT,
        rejection_reason: null,
        reviewer_notes: null,
        submitted_at: null,
        reviewed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    res.json({ success: true, message: 'Puedes enviar una nueva solicitud KYC' });
  } catch (e) {
    console.error('[KYC] resubmit error:', e.message);
    res.status(500).json({ message: 'Error al reiniciar KYC', error: e.message });
  }
});

// ── [ADMIN/BANCO] POST /api/kyc/review — aprobar o rechazar ──────
// Solo accesible por revisores autorizados (rol admin en JWT o tabla)
app.post('/api/kyc/review', requireAdmin, async (req, res) => {
  try {
    const reviewerId = req.admin.id;
    const { kyc_id, decision, rejection_reason, notes } = req.body;

    if (!kyc_id)   return res.status(400).json({ message: 'kyc_id requerido' });
    if (!decision) return res.status(400).json({ message: 'decision requerida (approved|rejected|suspended)' });
    if (!['approved','rejected','suspended'].includes(decision)) {
      return res.status(400).json({ message: 'decision debe ser: approved, rejected o suspended' });
    }
    if (decision === 'rejected' && !rejection_reason?.trim()) {
      return res.status(400).json({ message: 'rejection_reason requerida al rechazar' });
    }

    if (!supabase) return res.json({ success: true, message: 'Revisión aplicada (modo local)' });

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('kyc_verifications')
      .update({
        status:           decision,
        rejection_reason: decision === 'rejected' ? rejection_reason : null,
        reviewer_notes:   notes || null,
        reviewer_id:      reviewerId,
        reviewed_at:      now,
        updated_at:       now,
      })
      .eq('id', kyc_id);

    if (error) throw error;
    // El trigger sync_user_kyc_status se encarga de actualizar users y el historial

    res.json({ success: true, message: `KYC marcado como ${decision}` });
  } catch (e) {
    console.error('[KYC] review error:', e.message);
    res.status(500).json({ message: 'Error al revisar KYC', error: e.message });
  }
});

// ── [ADMIN] GET /api/kyc/pending — lista KYC pendientes ──────────
app.get('/api/kyc/pending', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.json({ verifications: [] });

    const { data, error } = await supabase
      .from('kyc_verifications')
      .select(`
        id, status, submitted_at, full_name, doc_type, doc_number,
        doc_front_url, doc_back_url, selfie_url, risk_level,
        users:user_id (id, phone, full_name, avatar_url)
      `)
      .in('status', [KYC_DB_STATUS.SUBMITTED, KYC_DB_STATUS.UNDER_REVIEW])
      .order('submitted_at', { ascending: true })
      .limit(100);

    if (error) throw error;
    res.json({ verifications: data || [] });
  } catch (e) {
    console.error('[KYC] pending list error:', e.message);
    res.status(500).json({ message: 'Error al obtener KYC pendientes', error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// FIN KYC
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// Canales sin teléfono inteligente (USSD / SMS / IVR)
// ══════════════════════════════════════════════════════════════════
// El menú de marcación lee y mueve dinero por la misma primitiva que la app —
// sendP2PByKind() termina en ledger_post_kind(), la plantilla de asiento que
// vive dentro de la base de datos—, así que no existe un segundo monedero ni
// una contabilidad aparte para los teléfonos básicos. Sin operadora firmada,
// egpayChannelInfo.has_real_channel es false y la app no puede prometer menús
// USSD reales: sólo funciona el canal de pruebas.
const { buildChannelRegistry } = require('./egpay-channel-providers');
const egpayChannelInfo = buildChannelRegistry({ env: process.env, log: console });
const egpayChannels = require('./egpay-channels')({
  supabase,
  money: {
    sendP2P: sendP2PByKind,
    balanceOf: readWalletBalance,
  },
  resolveUser: async (phone) => findUserByRef(phone),
  // Se valida contra el hash del usuario y no se guarda: la sesión sólo
  // recuerda que se superó, nunca el número tecleado.
  verifyPin: async (userId, pin) => checkPinForOperation(userId, pin),
  applyRechargeCode: async ({ userId, code }) => redeemRechargeCode({ userId, code }),
  log: console,
  sessionTtlMinutes: Number(process.env.CHANNEL_SESSION_TTL_MINUTES || 10),
  maxPinAttempts: Number(process.env.CHANNEL_MAX_PIN_ATTEMPTS || 3),
  maxPerPayment: Number(process.env.CHANNEL_MAX_PAYMENT || 250000),
  maxDaily: Number(process.env.CHANNEL_MAX_DAILY || 500000),
});

const egpayChannelRoutes = require('./egpayChannelRoutes')({
  express,
  supabase,
  requireAdmin,
  auth,
  channels: egpayChannels,
  channelInfo: egpayChannelInfo,
  log: console,
});
app.use('/api/egpay/channel', egpayChannelRoutes.gateway);
app.use('/api/wallet', egpayChannelRoutes.user);
app.use('/api/egpay', egpayChannelRoutes.admin);

// Las sesiones caducadas se devuelven al menú en lote: una cola marcada a
// medias no mueve dinero, pero impediría empezar un recorrido nuevo.
if (supabase) {
  setInterval(() => {
    egpayChannels.closeStale().catch((e) => console.error('[CANAL] cierre de sesiones:', e.message));
  }, 5 * 60 * 1000).unref();
}

module.exports = app;
