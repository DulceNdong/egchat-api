// ══════════════════════════════════════════════════════════════════
// EGCHAT API — Firebase Edition (reemplaza Render + Supabase)
// Deploy en: Railway (sin cold starts, sin cuota de Supabase)
// v1.0.0-firebase
// ══════════════════════════════════════════════════════════════════
try { require('dotenv').config(); } catch {}

const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const admin      = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Firebase Admin Init ───────────────────────────────────────────
// En Railway: pegar el JSON del service account en la variable
// FIREBASE_SERVICE_ACCOUNT (como string JSON)
let firebaseApp;
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./firebase-service-account.json'); // fallback local

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`,
    databaseURL: process.env.FIREBASE_DATABASE_URL
      || `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`,
  });
} else {
  firebaseApp = admin.app();
}

const db      = admin.firestore();
const rtdb    = admin.database();   // Realtime DB para presencia online
const bucket  = admin.storage().bucket();
const fcm     = admin.messaging();

// ── Firestore helpers ─────────────────────────────────────────────
const col   = (name) => db.collection(name);
const docId = () => db.collection('_').doc().id; // genera un ID único


// ── JWT ───────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET
  || 'EGchat2025!xK9mP3nQ7rL2vW8tY4uJ6hF1bN5cA0dE_prod_secret';

const verifyToken = (token) => {
  try { return jwt.verify(token, JWT_SECRET); } catch {
    throw new Error('Token inválido o expirado');
  }
};

const APP_VERSION = '1.0.0-firebase';

// ── CORS ──────────────────────────────────────────────────────────
const allowedOrigins = (
  process.env.CORS_ALLOWED_ORIGINS
  || 'https://egchat-app.vercel.app,https://egchat-v2.vercel.app,http://localhost:5173,http://localhost:3001,http://localhost:3000,http://localhost:8081,http://localhost:19006'
).split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    if (/^https:\/\/egchat.*\.vercel\.app$/.test(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ── Auth middleware ───────────────────────────────────────────────
const parseBearerToken = (h) => {
  if (typeof h !== 'string') return '';
  const m = h.match(/^\s*Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
};

const auth = (req, res, next) => {
  const token = parseBearerToken(req.headers.authorization)
    || req.headers['x-auth-token'] || '';
  if (!token) return res.status(401).json({ message: 'Token requerido' });
  try { req.user = verifyToken(token); next(); }
  catch { res.status(401).json({ message: 'Token inválido o expirado' }); }
};

const authFromQuery = (req, res, next) => {
  const token = req.query.token || req.query._t
    || parseBearerToken(req.headers.authorization) || '';
  if (!token) return res.status(401).json({ message: 'Token requerido' });
  try { req.user = verifyToken(token); next(); }
  catch { res.status(401).json({ message: 'Token inválido o expirado' }); }
};


// ── SSE streams (realtime para clientes) ─────────────────────────
const chatStreams = new Map(); // userId → Set<res>

const emitToUser = (userId, payload) => {
  const streams = chatStreams.get(String(userId));
  if (!streams || !streams.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of streams) { try { res.write(data); } catch {} }
};

const emitToUsers = (userIds, payload) => {
  [...new Set((userIds || []).map(String))].forEach(id => emitToUser(id, payload));
};

// ── Wallet helper ─────────────────────────────────────────────────
const getWalletSafe = async (userId) => {
  const ref = col('wallets').doc(String(userId));
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  // crear wallet inicial
  const wallet = { user_id: userId, balance: 5000, currency: 'XAF', updated_at: new Date().toISOString() };
  await ref.set(wallet);
  return wallet;
};

const debitWalletWithTx = async (userId, amount, method, reference, txType = 'payment') => {
  const wallet = await getWalletSafe(userId);
  if (amount > Number(wallet.balance || 0)) return { ok: false, message: 'Saldo insuficiente' };
  const newBalance = Number(wallet.balance) - Number(amount);
  await col('wallets').doc(String(userId)).update({ balance: newBalance, updated_at: new Date().toISOString() });
  const txRef = await col('transactions').add({
    user_id: userId, type: txType, amount, method: method || 'EGCHAT',
    reference, status: 'completed', created_at: new Date().toISOString(),
  });
  return { ok: true, balance: newBalance, txId: txRef.id };
};

const safeRef = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

// ── Push FCM ──────────────────────────────────────────────────────
const sendPushToUser = async (userId, payload) => {
  try {
    const tokensSnap = await col('expo_push_tokens')
      .where('user_id', '==', String(userId)).get();
    if (tokensSnap.empty) return;
    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return;
    await Promise.allSettled(tokens.map(token =>
      fcm.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: { chatId: String(payload.chatId || ''), url: payload.url || '/' },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'notification.wav' } } },
      })
    ));
  } catch (e) { console.warn('[FCM] push error:', e.message); }
};


// ════════════════════════════════════════════════════════════════════
// ROOT / HEALTH
// ════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  message: 'EGCHAT API — Firebase Edition',
  version: APP_VERSION,
  database: 'Firebase Firestore',
  status: 'active',
}));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/debug', (req, res) => res.json({
  firebase: admin.apps.length > 0 ? '✅ initialized' : '❌ not initialized',
  jwt_secret: process.env.JWT_SECRET ? '✅ set' : '⚠️ using fallback',
  node_env: process.env.NODE_ENV || 'not set',
  port: PORT,
}));

// ── SSE stream ────────────────────────────────────────────────────
app.get('/api/chat/stream', authFromQuery, (req, res) => {
  const userId = String(req.user.id);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!chatStreams.has(userId)) chatStreams.set(userId, new Set());
  chatStreams.get(userId).add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', userId, ts: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const streams = chatStreams.get(userId);
    if (streams) { streams.delete(res); if (!streams.size) chatStreams.delete(userId); }
    // Marcar offline en RTDB
    rtdb.ref(`presence/${userId}`).set({ online: false, last_seen: Date.now() }).catch(() => {});
  });

  // Marcar online en RTDB
  rtdb.ref(`presence/${userId}`).set({ online: true, last_seen: Date.now() }).catch(() => {});
});


// ════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, full_name, avatar_url } = req.body;
    if (!phone || !password || !full_name)
      return res.status(400).json({ message: 'phone, password y full_name son requeridos' });

    // Verificar si ya existe
    const existing = await col('users').where('phone', '==', phone).limit(1).get();
    if (!existing.empty) return res.status(409).json({ message: 'El teléfono ya está registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const userId = docId();
    const now = new Date().toISOString();
    const user = {
      id: userId, phone, full_name, password_hash: hashed,
      avatar_url: avatar_url || null, status: 'offline',
      app_version: APP_VERSION, created_at: now, last_login: now, is_active: true,
    };
    await col('users').doc(userId).set(user);

    // Crear wallet inicial
    await col('wallets').doc(userId).set({ user_id: userId, balance: 5000, currency: 'XAF', updated_at: now });

    const token = jwt.sign({ id: userId, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: userId, phone, full_name, avatar_url: user.avatar_url, app_version: APP_VERSION } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.json({ exists: false });
    const snap = await col('users').where('phone', '==', phone).limit(1).get();
    res.json({ exists: !snap.empty });
  } catch { res.json({ exists: false }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ message: 'phone y password son requeridos' });

    const snap = await col('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) return res.status(401).json({ message: 'Credenciales incorrectas' });

    const userDoc = snap.docs[0];
    const user = userDoc.data();
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Credenciales incorrectas' });

    await userDoc.ref.update({ last_login: new Date().toISOString() });

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url, app_version: APP_VERSION } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const snap = await col('users').doc(String(req.user.id)).get();
    if (!snap.exists) return res.status(404).json({ message: 'Usuario no encontrado' });
    const user = snap.data();
    res.json({ id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url, created_at: user.created_at, app_version: APP_VERSION });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { full_name, avatar_url } = req.body;
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    await col('users').doc(String(req.user.id)).update(updates);
    const snap = await col('users').doc(String(req.user.id)).get();
    const user = snap.data();
    res.json({ id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/auth/logout', auth, (req, res) => res.json({ message: 'Sesión cerrada' }));

app.put('/api/user/profile', auth, async (req, res) => {
  try {
    const { full_name, avatar_url, city } = req.body;
    const updates = {};
    if (full_name) updates.full_name = full_name;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (city) updates.city = city;
    await col('users').doc(String(req.user.id)).update(updates);
    const snap = await col('users').doc(String(req.user.id)).get();
    res.json({ ...snap.data(), app_version: APP_VERSION });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/user/profile', auth, async (req, res) => {
  try {
    const snap = await col('users').doc(String(req.user.id)).get();
    if (!snap.exists) return res.status(404).json({ message: 'No encontrado' });
    const user = snap.data();
    res.json({ id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url, created_at: user.created_at, app_version: APP_VERSION });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/user/change-password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const snap = await col('users').doc(String(req.user.id)).get();
    const user = snap.data();
    const ok = await bcrypt.compare(oldPassword, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await col('users').doc(String(req.user.id)).update({ password_hash: hashed });
    res.json({ message: 'Contraseña actualizada' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});


// ════════════════════════════════════════════════════════════════════
// WALLET
// ════════════════════════════════════════════════════════════════════
app.get('/api/wallet/balance', auth, async (req, res) => {
  try {
    const wallet = await getWalletSafe(req.user.id);
    res.json({ balance: wallet.balance, currency: wallet.currency });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const snap = await col('transactions')
      .where('user_id', '==', String(req.user.id))
      .orderBy('created_at', 'desc').limit(limit).offset((page - 1) * limit).get();
    const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ transactions, total: transactions.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const { amount, method, reference } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe inválido' });
    const wallet = await getWalletSafe(req.user.id);
    const newBalance = Number(wallet.balance || 0) + amount;
    await col('wallets').doc(String(req.user.id)).update({ balance: newBalance, updated_at: new Date().toISOString() });
    const txRef = await col('transactions').add({
      user_id: req.user.id, type: 'deposit', amount, method, reference, status: 'completed',
      created_at: new Date().toISOString(),
    });
    res.json({ balance: newBalance, transaction: { id: txRef.id, ...{ user_id: req.user.id, type: 'deposit', amount, method, reference, status: 'completed' } } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const { amount, method, destination } = req.body;
    const wallet = await getWalletSafe(req.user.id);
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe inválido' });
    if (amount > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });
    const newBalance = wallet.balance - amount;
    await col('wallets').doc(String(req.user.id)).update({ balance: newBalance });
    const txRef = await col('transactions').add({
      user_id: req.user.id, type: 'withdraw', amount, method, reference: destination, status: 'completed',
      created_at: new Date().toISOString(),
    });
    res.json({ balance: newBalance, transaction: { id: txRef.id } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/wallet/recharge-code', auth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Código inválido' });
    const snap = await col('recharge_codes').where('code', '==', code).limit(1).get();
    if (snap.empty) return res.status(400).json({ message: 'Código no válido' });
    const codeDoc = snap.docs[0];
    const codeData = codeDoc.data();
    if (codeData.used) return res.status(400).json({ message: 'Código ya utilizado' });
    const amount = codeData.amount || 5000;
    await codeDoc.ref.update({ used: true, used_by: req.user.id, used_at: new Date().toISOString() });
    const wallet = await getWalletSafe(req.user.id);
    const newBalance = Number(wallet.balance || 0) + amount;
    await col('wallets').doc(String(req.user.id)).update({ balance: newBalance });
    await col('transactions').add({
      user_id: req.user.id, type: 'deposit', amount, method: 'Código de recarga',
      reference: code, status: 'completed', created_at: new Date().toISOString(),
    });
    res.json({ balance: newBalance, amount, message: `${amount.toLocaleString()} XAF añadidos` });
  } catch (e) { res.status(500).json({ message: e.message }); }
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
    const senderWallet = await getWalletSafe(req.user.id);
    if (amount > Number(senderWallet.balance || 0)) {
      return res.status(400).json({ message: 'Saldo insuficiente' });
    }

    // Buscar destinatario por teléfono o ID
    let recipientId = null;
    let recipientName = to;

    // Intentar buscar por ID primero
    if (to.match(/^[0-9a-f-]{20,}$/i)) {
      const userSnap = await col('users').doc(to).get();
      if (userSnap.exists) {
        recipientId = userSnap.id;
        recipientName = userSnap.data().full_name || to;
      }
    }

    // Si no se encontró, buscar por teléfono
    if (!recipientId && to.match(/^\+?[0-9\s()-]+$/)) {
      const cleanPhone = to.replace(/[^0-9+]/g, '');
      const phoneSnap = await col('users').where('phone', '==', cleanPhone).limit(1).get();
      if (!phoneSnap.empty) {
        const userDoc = phoneSnap.docs[0];
        recipientId = userDoc.id;
        recipientName = userDoc.data().full_name || cleanPhone;
      }
    }

    // Verificar que no sea auto-transferencia
    if (recipientId && recipientId === req.user.id) {
      return res.status(400).json({ message: 'No puedes transferir dinero a ti mismo' });
    }

    // Actualizar balance del remitente
    const newBalance = Number(senderWallet.balance) - amount;
    await col('wallets').doc(String(req.user.id)).update({
      balance: newBalance,
      updated_at: new Date().toISOString()
    });

    // Si se encontró destinatario, actualizar su wallet
    if (recipientId) {
      const recipientWallet = await getWalletSafe(recipientId);
      const recipientNewBalance = Number(recipientWallet.balance || 0) + amount;
      await col('wallets').doc(String(recipientId)).update({
        balance: recipientNewBalance,
        updated_at: new Date().toISOString()
      });
    }

    // Registrar transacción del remitente
    const txRef = await col('transactions').add({
      user_id: req.user.id,
      type: 'transfer_sent',
      amount: -amount,
      method: 'EGCHAT',
      reference: `Transferencia a: ${recipientName}${concept ? ' · ' + concept : ''}`,
      status: 'completed',
      created_at: new Date().toISOString()
    });

    // Si hay destinatario registrado, crear su transacción de ingreso
    if (recipientId) {
      await col('transactions').add({
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
      transaction: { id: txRef.id },
      recipient: recipientName,
      message: 'Transferencia completada exitosamente'
    });
  } catch (e) {
    console.error('POST /api/wallet/transfer error:', e);
    res.status(500).json({ message: e.message || 'Error al procesar la transferencia' });
  }
});


// ════════════════════════════════════════════════════════════════════
// CONTACTS
// ════════════════════════════════════════════════════════════════════
app.get('/api/contacts', auth, async (req, res) => {
  try {
    const snap = await col('contacts').where('user_id', '==', String(req.user.id))
      .orderBy('created_at', 'desc').get();
    const contacts = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Enriquecer con datos de usuario
    const userIds = [...new Set(contacts.map(c => c.contact_user_id).filter(Boolean))];
    const userDocs = userIds.length
      ? await Promise.all(userIds.map(uid => col('users').doc(uid).get()))
      : [];
    const usersMap = {};
    userDocs.forEach(d => { if (d.exists) usersMap[d.id] = d.data(); });

    res.json(contacts.map(c => ({
      id: c.id,
      contact_user_id: c.contact_user_id,
      name: c.nickname || usersMap[c.contact_user_id]?.full_name || 'Sin nombre',
      phone: usersMap[c.contact_user_id]?.phone || '',
      avatar_url: usersMap[c.contact_user_id]?.avatar_url || '',
      is_blocked: c.is_blocked || false,
      is_favorite: c.is_favorite || false,
      created_at: c.created_at,
      user: usersMap[c.contact_user_id] || null,
    })));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/contacts', auth, async (req, res) => {
  try {
    const { contact_user_id, nickname, phone } = req.body;
    let targetId = contact_user_id;

    if (!targetId && phone) {
      const snap = await col('users').where('phone', '==', phone).limit(1).get();
      if (snap.empty) return res.status(404).json({ message: 'Usuario no encontrado' });
      targetId = snap.docs[0].id;
    }
    if (!targetId) return res.status(400).json({ message: 'ID o teléfono requerido' });

    const targetSnap = await col('users').doc(targetId).get();
    if (!targetSnap.exists) return res.status(404).json({ message: 'Usuario no encontrado' });
    const targetUser = targetSnap.data();

    const existing = await col('contacts')
      .where('user_id', '==', String(req.user.id))
      .where('contact_user_id', '==', targetId).limit(1).get();
    if (!existing.empty) return res.status(409).json({ message: 'El usuario ya es tu contacto' });

    const now = new Date().toISOString();
    const ref = await col('contacts').add({
      user_id: String(req.user.id), contact_user_id: targetId,
      nickname: nickname || targetUser.full_name,
      is_blocked: false, is_favorite: false, created_at: now,
    });
    res.json({ id: ref.id, contact_user_id: targetId, name: nickname || targetUser.full_name,
      phone: targetUser.phone, avatar_url: targetUser.avatar_url || '', is_blocked: false, is_favorite: false });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/contacts/:contactId/block', auth, async (req, res) => {
  try {
    const ref = col('contacts').doc(req.params.contactId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().user_id !== String(req.user.id))
      return res.status(404).json({ message: 'Contacto no encontrado' });
    await ref.update({ is_blocked: true });
    res.json({ message: 'Contacto bloqueado' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/contacts/:contactId/unblock', auth, async (req, res) => {
  try {
    const ref = col('contacts').doc(req.params.contactId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().user_id !== String(req.user.id))
      return res.status(404).json({ message: 'Contacto no encontrado' });
    await ref.update({ is_blocked: false });
    res.json({ message: 'Contacto desbloqueado' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/contacts/:contactId', auth, async (req, res) => {
  try {
    const ref = col('contacts').doc(req.params.contactId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().user_id !== String(req.user.id))
      return res.status(404).json({ message: 'Contacto no encontrado' });
    await ref.delete();
    res.json({ message: 'Contacto eliminado' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/contacts/:contactId/favorite', auth, async (req, res) => {
  try {
    await col('contacts').doc(req.params.contactId).update({ is_favorite: true });
    res.json({ message: 'Marcado como favorito' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/contacts/:contactId/favorite', auth, async (req, res) => {
  try {
    await col('contacts').doc(req.params.contactId).update({ is_favorite: false });
    res.json({ message: 'Desmarcado como favorito' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/contacts/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    let snap;
    if (q && q.length >= 2) {
      snap = await col('users').orderBy('phone').startAt(q).endAt(q + '\uf8ff').limit(50).get();
      if (snap.empty) {
        snap = await col('users').orderBy('full_name').startAt(q).endAt(q + '\uf8ff').limit(50).get();
      }
    } else {
      snap = await col('users').limit(50).get();
    }
    const users = snap.docs
      .filter(d => d.id !== String(req.user.id))
      .map(d => ({ id: d.id, ...d.data(), password_hash: undefined }));
    res.json(users);
  } catch (e) { res.status(500).json({ message: e.message }); }
});


// ════════════════════════════════════════════════════════════════════
// CHATS & MENSAJES
// ════════════════════════════════════════════════════════════════════
app.get('/api/chats', auth, async (req, res) => {
  try {
    const partSnap = await col('chat_participants').where('user_id', '==', String(req.user.id)).get();
    if (partSnap.empty) return res.json([]);
    const chatIds = partSnap.docs.map(d => d.data().chat_id);

    const chats = await Promise.all(chatIds.map(async (chatId) => {
      const chatSnap = await col('chats').doc(chatId).get();
      if (!chatSnap.exists) return null;
      const chat = chatSnap.data();

      // Participantes
      const pSnap = await col('chat_participants').where('chat_id', '==', chatId).get();
      const participants = await Promise.all(pSnap.docs.map(async d => {
        const p = d.data();
        const uSnap = await col('users').doc(p.user_id).get();
        const u = uSnap.exists ? uSnap.data() : {};
        return { user_id: p.user_id, full_name: u.full_name || '', phone: u.phone || '', avatar_url: u.avatar_url || '' };
      }));

      // Último mensaje
      const msgSnap = await col('messages').where('chat_id', '==', chatId)
        .orderBy('created_at', 'desc').limit(1).get();
      const last_message = msgSnap.empty ? null : { id: msgSnap.docs[0].id, ...msgSnap.docs[0].data() };

      return { id: chatId, type: chat.type || 'private', name: chat.name || null,
        avatar_url: chat.avatar_url || null, participants, last_message,
        updated_at: chat.updated_at, unread_count: 0 };
    }));

    res.json(chats.filter(Boolean).sort((a, b) =>
      new Date(b.updated_at || 0) - new Date(a.updated_at || 0)));
  } catch (e) {
    console.error('Get chats error:', e.message);
    res.json([]);
  }
});

app.post('/api/chats/private', auth, async (req, res) => {
  try {
    const { participant_id, phone } = req.body;
    let targetId = participant_id;

    if (!targetId && phone) {
      const snap = await col('users').where('phone', '==', phone).limit(1).get();
      if (snap.empty) return res.status(404).json({ message: 'Usuario no encontrado' });
      targetId = snap.docs[0].id;
    }
    if (!targetId) return res.status(400).json({ message: 'participant_id o phone requerido' });
    if (targetId === String(req.user.id)) return res.status(400).json({ message: 'No puedes chatear contigo mismo' });

    // Buscar chat existente
    const myParts = await col('chat_participants').where('user_id', '==', String(req.user.id)).get();
    const theirParts = await col('chat_participants').where('user_id', '==', targetId).get();
    const myIds = new Set(myParts.docs.map(d => d.data().chat_id));
    const common = theirParts.docs.map(d => d.data().chat_id).filter(id => myIds.has(id));

    for (const chatId of common) {
      const chatSnap = await col('chats').doc(chatId).get();
      if (chatSnap.exists && chatSnap.data().type === 'private') {
        const pSnap = await col('chat_participants').where('chat_id', '==', chatId).get();
        if (pSnap.size === 2) {
          const participants = pSnap.docs.map(d => ({ user_id: d.data().user_id }));
          return res.json({ id: chatId, type: 'private', participants, last_message: null, unread_count: 0 });
        }
      }
    }

    // Crear nuevo chat
    const now = new Date().toISOString();
    const chatRef = col('chats').doc();
    await chatRef.set({ type: 'private', created_by: String(req.user.id), created_at: now, updated_at: now });
    await col('chat_participants').add({ chat_id: chatRef.id, user_id: String(req.user.id), joined_at: now });
    await col('chat_participants').add({ chat_id: chatRef.id, user_id: targetId, joined_at: now });

    const targetSnap = await col('users').doc(targetId).get();
    const targetUser = targetSnap.exists ? targetSnap.data() : {};
    res.status(201).json({
      id: chatRef.id, type: 'private',
      participants: [
        { user_id: String(req.user.id) },
        { user_id: targetId, full_name: targetUser.full_name, phone: targetUser.phone, avatar_url: targetUser.avatar_url },
      ],
      last_message: null, unread_count: 0,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/chats/group', auth, async (req, res) => {
  try {
    const { name, participant_ids, avatar_url } = req.body;
    if (!name || !participant_ids?.length) return res.status(400).json({ message: 'name y participantes requeridos' });
    const ids = [...new Set([...participant_ids, String(req.user.id)])];
    const now = new Date().toISOString();
    const chatRef = col('chats').doc();
    await chatRef.set({ type: 'group', name, avatar_url: avatar_url || null, created_by: String(req.user.id), created_at: now, updated_at: now });
    await Promise.all(ids.map(uid => col('chat_participants').add({ chat_id: chatRef.id, user_id: uid, joined_at: now })));
    res.status(201).json({ id: chatRef.id, type: 'group', name, participants: ids.map(uid => ({ user_id: uid })), last_message: null });
  } catch (e) { res.status(500).json({ message: e.message }); }
});



app.get('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    const pSnap = await col('chat_participants')
      .where('chat_id', '==', chatId).where('user_id', '==', String(req.user.id)).limit(1).get();
    if (pSnap.empty) return res.status(403).json({ message: 'No tienes acceso a este chat' });

    const msgSnap = await col('messages').where('chat_id', '==', chatId)
      .orderBy('created_at', 'desc').limit(limit).offset((page - 1) * limit).get();

    // Filtrar eliminados para este usuario
    const delSnap = await col('message_deletions').where('user_id', '==', String(req.user.id)).get();
    const deletedIds = new Set(delSnap.docs.map(d => d.data().message_id));

    const messages = msgSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => !deletedIds.has(m.id))
      .reverse();

    res.json(messages);
  } catch (e) { res.json([]); }
});

app.post('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text, type = 'text', reply_to, file_url } = req.body;
    if (!text && !file_url) return res.status(400).json({ message: 'Texto o archivo requerido' });

    const pSnap = await col('chat_participants')
      .where('chat_id', '==', chatId).where('user_id', '==', String(req.user.id)).limit(1).get();
    if (pSnap.empty) return res.status(403).json({ message: 'Sin acceso' });

    const now = new Date().toISOString();
    const msgRef = await col('messages').add({
      chat_id: chatId, sender_id: String(req.user.id), text: text || null,
      type, reply_to: reply_to || null, file_url: file_url || null,
      status: 'sent', created_at: now,
    });
    const message = { id: msgRef.id, chat_id: chatId, sender_id: String(req.user.id), text: text || null, type, status: 'sent', created_at: now };

    await col('chats').doc(chatId).update({ updated_at: now });

    // Emitir SSE a participantes
    const allParts = await col('chat_participants').where('chat_id', '==', chatId).get();
    const targetUsers = allParts.docs.map(d => d.data().user_id);
    emitToUsers(targetUsers, { type: 'new_message', chatId, message });
    emitToUsers(targetUsers, { type: 'chat_updated', chatId, ts: Date.now() });

    // FCM push a usuarios que no son el remitente
    const otherUsers = targetUsers.filter(uid => uid !== String(req.user.id));
    const senderSnap = await col('users').doc(String(req.user.id)).get();
    const senderName = senderSnap.exists ? senderSnap.data().full_name : 'Alguien';
    await Promise.allSettled(otherUsers.map(uid => sendPushToUser(uid, {
      title: senderName,
      body: type === 'text' ? (text || 'Nuevo mensaje') : '📎 Archivo adjunto',
      chatId, url: '/',
    })));

    res.status(201).json(message);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/chats/:chatId/read-all', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const readerId = String(req.user.id);

    const msgSnap = await col('messages').where('chat_id', '==', chatId)
      .where('status', '!=', 'read').get();
    const unread = msgSnap.docs.filter(d => d.data().sender_id !== readerId);

    if (!unread.length) return res.json({ ok: true, updated: 0 });

    const batch = db.batch();
    unread.forEach(d => batch.update(d.ref, { status: 'read' }));
    await batch.commit();

    // Notificar a emisores via SSE
    const senderIds = [...new Set(unread.map(d => d.data().sender_id))];
    for (const senderId of senderIds) {
      const ids = unread.filter(d => d.data().sender_id === senderId).map(d => d.id);
      emitToUser(senderId, { type: 'read', chatId, messageIds: ids, readerId, ts: Date.now() });
    }

    res.json({ ok: true, updated: unread.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/messages/:messageId/for-me', auth, async (req, res) => {
  try {
    await col('message_deletions').add({ message_id: req.params.messageId, user_id: String(req.user.id) });
    res.json({ message: 'Mensaje eliminado para ti' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const snap = await col('messages').doc(req.params.messageId).get();
    if (!snap.exists) return res.status(404).json({ message: 'Mensaje no encontrado' });
    if (snap.data().sender_id !== String(req.user.id)) return res.status(403).json({ message: 'Sin permiso' });
    await snap.ref.delete();
    res.json({ message: 'Mensaje eliminado' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const chatSnap = await col('chats').doc(chatId).get();
    const creatorId = chatSnap.exists ? chatSnap.data().created_by : null;

    const pSnap = await col('chat_participants').where('chat_id', '==', chatId).get();
    const members = await Promise.all(pSnap.docs.map(async d => {
      const uid = d.data().user_id;
      const uSnap = await col('users').doc(uid).get();
      const u = uSnap.exists ? uSnap.data() : {};
      return { id: uid, user_id: uid, full_name: u.full_name || '', phone: u.phone || '',
        avatar_url: u.avatar_url || '', role: uid === creatorId ? 'admin' : 'member' };
    }));
    res.json(members);
  } catch (e) { res.status(500).json({ message: e.message }); }
});


// ════════════════════════════════════════════════════════════════════
// UPLOAD (Firebase Storage)
// ════════════════════════════════════════════════════════════════════
app.post('/api/chats/:chatId/upload', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const pSnap = await col('chat_participants')
      .where('chat_id', '==', chatId).where('user_id', '==', String(req.user.id)).limit(1).get();
    if (pSnap.empty) return res.status(403).json({ message: 'Sin acceso' });

    let buffer, fileContentType, fileName;
    const rawContentType = req.headers['content-type'] || '';

    if (rawContentType.includes('multipart/form-data')) {
      const busboy = require('busboy');
      const bb = busboy({ headers: req.headers });
      const fileData = await new Promise((resolve, reject) => {
        let buf = null, mime = 'application/octet-stream', name = `file_${Date.now()}`;
        bb.on('file', (_, file, info) => {
          name = info.filename || name;
          mime = info.mimeType || mime;
          const chunks = [];
          file.on('data', d => chunks.push(d));
          file.on('end', () => { buf = Buffer.concat(chunks); });
        });
        bb.on('close', () => resolve({ buffer: buf, mime, name }));
        bb.on('error', reject);
        req.pipe(bb);
      });
      buffer = fileData.buffer;
      fileContentType = fileData.mime;
      fileName = fileData.name;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
      fileContentType = rawContentType.split(';')[0].trim() || 'application/octet-stream';
      fileName = req.headers['x-file-name']
        ? decodeURIComponent(req.headers['x-file-name']) : `file_${Date.now()}`;
    }

    if (!buffer?.length) return res.status(400).json({ message: 'Archivo vacío' });

    const storagePath = `chats/${chatId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const fileRef = bucket.file(storagePath);
    await fileRef.save(buffer, { metadata: { contentType: fileContentType } });
    await fileRef.makePublic();

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    res.json({ file_url: publicUrl, file_name: fileName, file_type: fileContentType, file_size: buffer.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// RECOVERY (contraseña)
// ════════════════════════════════════════════════════════════════════
const resetCodes = new Map();

app.post('/api/auth/send-verification', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Teléfono requerido' });
    const snap = await col('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) return res.status(404).json({ message: 'No existe cuenta con ese número' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    resetCodes.set(phone, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
    console.log(`[RESET] Código para ${phone}: ${code}`);
    res.json({ sent: true, message: 'Código enviado' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/auth/verify-code', async (req, res) => {
  const { phone, code } = req.body;
  const entry = resetCodes.get(phone);
  if (!entry) return res.status(400).json({ verified: false, message: 'No hay código activo' });
  if (Date.now() > entry.expiresAt) { resetCodes.delete(phone); return res.status(400).json({ verified: false, message: 'Código expirado' }); }
  if (entry.code !== String(code)) return res.status(400).json({ verified: false, message: 'Código incorrecto' });
  res.json({ verified: true });
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) return res.status(400).json({ message: 'Faltan datos' });
    const entry = resetCodes.get(phone);
    if (!entry || Date.now() > entry.expiresAt || entry.code !== String(code))
      return res.status(400).json({ message: 'Código inválido o expirado' });
    const hash = await bcrypt.hash(newPassword, 10);
    const snap = await col('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) return res.status(404).json({ message: 'Usuario no encontrado' });
    await snap.docs[0].ref.update({ password_hash: hash });
    resetCodes.delete(phone);
    res.json({ success: true, message: 'Contraseña actualizada' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});


// ════════════════════════════════════════════════════════════════════
// LIA-25
// ════════════════════════════════════════════════════════════════════
app.post('/api/lia/chat', auth, async (req, res) => {
  const { message } = req.body;
  const lower = message.toLowerCase();
  const wallet = await getWalletSafe(req.user.id);
  const balance = wallet?.balance || 0;

  let reply;
  if (lower.includes('saldo') || lower.includes('balance'))
    reply = `Tu saldo actual es **${balance.toLocaleString()} XAF**.`;
  else if (lower.includes('hola') || lower.includes('buenos'))
    reply = '¡Hola! Soy Lia-25, tu asistente de EGCHAT. ¿En qué puedo ayudarte?';
  else if (lower.includes('taxi'))
    reply = 'Puedo ayudarte a pedir un taxi. Ve a la sección MiTaxi.';
  else if (lower.includes('transferir') || lower.includes('enviar dinero'))
    reply = 'Para enviar dinero ve a Mi Monedero → Enviar.';
  else if (lower.includes('seguro'))
    reply = 'Puedes contratar seguros en la sección Seguros.';
  else if (lower.includes('gracias'))
    reply = '¡De nada! ¿Hay algo más en lo que pueda ayudarte?';
  else
    reply = `Entendido: "${message}". Puedo ayudarte con saldo, transferencias, taxi, salud, seguros y noticias.`;

  await col('lia_conversations').add({ user_id: String(req.user.id), message, reply, created_at: new Date().toISOString() });
  res.json({ reply, timestamp: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════════
// SERVICIOS (SEGESA, SNGE, DGI, etc.)
// ════════════════════════════════════════════════════════════════════
const createServiceOrder = async (userId, provider, serviceType, amount, contractRef, payload, response) => {
  const orderRef = safeRef(provider.toUpperCase());
  const ref = await col('service_orders').add({
    order_ref: orderRef, user_id: userId, provider, service_type: serviceType,
    contract_ref: contractRef || null, amount: Number(amount || 0),
    status: 'completed', payload: payload || {}, response: response || {},
    created_at: new Date().toISOString(),
  });
  return { orderRef, id: ref.id };
};

app.post('/api/servicios/segesa/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Número de contrato requerido' });
  const response = { contrato, titular: 'Cliente SEGESA', importe: Math.floor(Math.random() * 15000) + 5000, estado: 'pendiente' };
  await createServiceOrder(req.user.id, 'segesa', 'consultar', 0, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/segesa/pagar', auth, async (req, res) => {
  const { contrato, importe } = req.body;
  if (!contrato || Number(importe) <= 0) return res.status(400).json({ message: 'Datos inválidos' });
  const deb = await debitWalletWithTx(req.user.id, Number(importe), 'EGCHAT', `SEGESA-${contrato}`, 'service_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message });
  const response = { success: true, balance: deb.balance, referencia: safeRef('SEG'), message: 'Pago de electricidad completado' };
  await createServiceOrder(req.user.id, 'segesa', 'pagar', importe, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/snge/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Número de contrato requerido' });
  const response = { contrato, titular: 'Cliente SNGE', importe: Math.floor(Math.random() * 8000) + 2000, estado: 'pendiente' };
  await createServiceOrder(req.user.id, 'snge', 'consultar', 0, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/snge/pagar', auth, async (req, res) => {
  const { contrato, importe } = req.body;
  if (!contrato || Number(importe) <= 0) return res.status(400).json({ message: 'Datos inválidos' });
  const deb = await debitWalletWithTx(req.user.id, Number(importe), 'EGCHAT', `SNGE-${contrato}`, 'service_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message });
  const response = { success: true, balance: deb.balance, referencia: safeRef('SNGE'), message: 'Pago de agua completado' };
  await createServiceOrder(req.user.id, 'snge', 'pagar', importe, contrato, req.body, response);
  res.json(response);
});

app.post('/api/servicios/dgi/pagar', auth, async (req, res) => {
  const { nif, importe } = req.body;
  if (!nif || Number(importe) <= 0) return res.status(400).json({ message: 'Datos inválidos' });
  const deb = await debitWalletWithTx(req.user.id, Number(importe), 'EGCHAT', `DGI-${nif}`, 'tax_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message });
  const response = { success: true, balance: deb.balance, referencia: safeRef('DGI'), message: 'Pago de impuesto completado' };
  await createServiceOrder(req.user.id, 'dgi', 'pagar', importe, nif, req.body, response);
  res.json(response);
});

app.get('/api/servicios/orders', auth, async (req, res) => {
  const snap = await col('service_orders').where('user_id', '==', String(req.user.id))
    .orderBy('created_at', 'desc').get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});


// ════════════════════════════════════════════════════════════════════
// TAXI
// ════════════════════════════════════════════════════════════════════
const TAXI_FARES = { moto: { base: 300, perKm: 150, minFare: 500 }, taxi: { base: 500, perKm: 250, minFare: 1000 }, suv: { base: 800, perKm: 400, minFare: 2000 } };
const ETA_BY_TYPE = { moto: 2, taxi: 4, suv: 5 };
const haversineKm = (a, b) => {
  if (!a || !b) return 3;
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const hav = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
};
const calcTaxiFare = (type, distanceKm) => {
  const f = TAXI_FARES[type] || TAXI_FARES.taxi;
  const km = Math.max(1, distanceKm || 3);
  const total = f.base + f.perKm * km;
  return Math.max(f.minFare, Math.round(total / 100) * 100);
};

app.post('/api/taxi/estimate', auth, async (req, res) => {
  try {
    const { type, originLat, originLng, destLat, destLng, distanceKm } = req.body;
    const km = distanceKm || haversineKm(originLat ? { lat: originLat, lng: originLng } : null, destLat ? { lat: destLat, lng: destLng } : null);
    const tarifa = calcTaxiFare(type || 'taxi', km);
    const eta = ETA_BY_TYPE[type] || 4;
    res.json({ tarifa, distanceKm: Math.round(km * 10) / 10, eta, currency: 'XAF' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/taxi/request', auth, async (req, res) => {
  try {
    const { origin, dest, type, originLat, originLng, destLat, destLng, paymentMethod = 'wallet' } = req.body;
    if (!origin || !dest) return res.status(400).json({ message: 'origin y dest requeridos' });
    const km = haversineKm(originLat ? { lat: originLat, lng: originLng } : null, destLat ? { lat: destLat, lng: destLng } : null);
    const tarifa = calcTaxiFare(type || 'taxi', km);
    const eta = ETA_BY_TYPE[type] || 4;

    if (paymentMethod === 'wallet') {
      const wallet = await getWalletSafe(req.user.id);
      if (tarifa > wallet.balance) return res.status(400).json({ message: `Saldo insuficiente. Se necesitan ${tarifa.toLocaleString()} XAF.` });
    }

    const rideId = safeRef('RIDE');
    const driver = { name: 'Carlos Mba', rating: 4.9, plate: 'GE-1234', vehicle: 'Toyota Corolla', phone: '+240 222 400 100', initials: 'CM' };
    await col('taxi_rides').add({
      ride_ref: rideId, user_id: String(req.user.id), origin, destination: dest, ride_type: type || 'taxi',
      fare: tarifa, distance_km: Math.round(km * 10) / 10, eta_minutes: eta, status: 'searching',
      payment_method: paymentMethod, driver_name: driver.name, driver_rating: driver.rating,
      driver_plate: driver.plate, driver_vehicle: driver.vehicle, driver_phone: driver.phone,
      created_at: new Date().toISOString(),
    });

    setTimeout(async () => {
      const snap = await col('taxi_rides').where('ride_ref', '==', rideId).limit(1).get();
      if (!snap.empty) await snap.docs[0].ref.update({ status: 'matched' });
    }, 5000);

    res.json({ rideId, driver, eta, tarifa, distanceKm: Math.round(km * 10) / 10, type: type || 'taxi', status: 'searching', paymentMethod });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/taxi/:rideId/status', auth, async (req, res) => {
  try {
    const snap = await col('taxi_rides').where('user_id', '==', String(req.user.id))
      .where('ride_ref', '==', req.params.rideId).limit(1).get();
    if (snap.empty) return res.status(404).json({ message: 'Viaje no encontrado' });
    const ride = snap.docs[0].data();
    res.json({
      rideId: ride.ride_ref, status: ride.status || 'processing',
      eta: ride.status === 'completed' ? 0 : (ride.eta_minutes || 4),
      distanceKm: ride.distance_km || 3, fare: ride.fare,
      driver: { name: ride.driver_name, rating: ride.driver_rating, plate: ride.driver_plate, vehicle: ride.driver_vehicle, phone: ride.driver_phone, initials: ride.driver_name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'CM' },
      driver_location: { lat: 3.752 + Math.random() * 0.005, lng: 8.774 + Math.random() * 0.005 },
      paymentMethod: ride.payment_method || 'wallet',
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/taxi/:rideId/cancel', auth, async (req, res) => {
  try {
    const snap = await col('taxi_rides').where('user_id', '==', String(req.user.id))
      .where('ride_ref', '==', req.params.rideId).limit(1).get();
    if (snap.empty) return res.status(404).json({ message: 'Viaje no encontrado' });
    await snap.docs[0].ref.update({ status: 'cancelled', updated_at: new Date().toISOString() });
    res.json({ message: 'Viaje cancelado', rideId: req.params.rideId });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/taxi/:rideId/rate', auth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating 1-5' });
    const snap = await col('taxi_rides').where('user_id', '==', String(req.user.id))
      .where('ride_ref', '==', req.params.rideId).limit(1).get();
    if (snap.empty) return res.status(404).json({ message: 'Viaje no encontrado' });
    const ride = snap.docs[0].data();
    await snap.docs[0].ref.update({ rating, rating_comment: comment || null, status: 'completed', updated_at: new Date().toISOString() });
    if (ride.payment_method !== 'cash') await debitWalletWithTx(req.user.id, ride.fare || 0, 'TAXI', `TAXI-${req.params.rideId}`, 'taxi');
    res.json({ message: 'Valoración enviada', rating, rideId: req.params.rideId });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/taxi/rides', auth, async (req, res) => {
  try {
    const snap = await col('taxi_rides').where('user_id', '==', String(req.user.id))
      .orderBy('created_at', 'desc').limit(20).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
// CEMAC, SUPERMERCADOS, SALUD (stubs compactos)
// ════════════════════════════════════════════════════════════════════
app.get('/api/cemac/rates', auth, (req, res) => res.json({ base: 'XAF', countries: ['GQ', 'CM', 'GA', 'CG', 'TD', 'CF'], transfer_fee_flat: 750, sandbox: true }));
app.post('/api/cemac/transfers', auth, async (req, res) => {
  const { from_country, to_country, beneficiary_name, beneficiary_account, amount } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ message: 'Datos inválidos' });
  const total = Number(amount) + 750;
  const deb = await debitWalletWithTx(req.user.id, total, 'EGCHAT', `CEMAC-${to_country}`, 'cemac_transfer');
  if (!deb.ok) return res.status(400).json({ message: deb.message });
  const ref = safeRef('CEMAC');
  await col('cemac_transfers').add({ transfer_ref: ref, user_id: String(req.user.id), from_country, to_country, beneficiary_name, beneficiary_account, amount: Number(amount), fee: 750, status: 'processing', created_at: new Date().toISOString() });
  res.status(201).json({ transfer: { id: ref, status: 'processing' }, balance: deb.balance });
});

app.get('/api/cemac/transfers', auth, async (req, res) => {
  const snap = await col('cemac_transfers').where('user_id', '==', String(req.user.id)).orderBy('created_at', 'desc').get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.get('/api/supermarkets', auth, (req, res) => res.json([{ id: '1', name: 'Supermarket Malabo', city: 'Malabo' }]));
app.get('/api/supermarkets/:id/products', auth, (req, res) => res.json([{ id: '1', name: 'Arroz 5kg', price: 3500 }]));
app.post('/api/supermarkets/orders', auth, async (req, res) => {
  const { items, supermarketId, external_id } = req.body;
  const total = items?.reduce((s, i) => s + (i.price * i.qty), 0) || 0;
  const deb = await debitWalletWithTx(req.user.id, total, 'EGCHAT', `SUPER-${supermarketId}`, 'shopping_payment');
  if (!deb.ok) return res.status(400).json({ message: deb.message });
  const orderId = external_id || safeRef('ORD');
  await col('service_orders').add({ order_ref: orderId, user_id: String(req.user.id), provider: 'supermarkets', service_type: 'order', amount: total, status: 'completed', created_at: new Date().toISOString() });
  res.json({ orderId, status: 'confirmed', total, balance: deb.balance });
});

app.get('/api/salud/hospitales', auth, (req, res) => res.json([{ id: '1', name: 'Hospital General de Malabo', city: 'Malabo' }]));
app.get('/api/salud/farmacias', auth, (req, res) => res.json([{ id: '1', name: 'Farmacia Central Malabo', city: 'Malabo' }]));
app.post('/api/salud/citas', auth, async (req, res) => {
  const { hospitalId, especialidad, fecha, motivo } = req.body;
  const citaId = safeRef('CITA');
  await createServiceOrder(req.user.id, 'salud', 'cita', 0, hospitalId, req.body, { citaId, confirmado: true });
  res.json({ citaId, confirmado: true, message: 'Cita médica confirmada' });
});

app.get('/api/salud/medicamentos', auth, (req, res) => res.json([{ id: '1', name: 'Paracetamol 500mg', price: 500 }]));

// ════════════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ EGCHAT API (Firebase) escuchando en puerto ${PORT}`);
  console.log(`🔥 Firebase Firestore: conectado`);
  console.log(`📦 Firebase Storage: ${bucket.name}`);
  console.log(`💾 Firebase Realtime DB: conectado`);
});

module.exports = app;
