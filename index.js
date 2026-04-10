// dotenv solo en local (en Render las vars vienen del dashboard)
try { require('dotenv').config(); } catch(e) {}
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'egchat_secret_2026';
const chatStreams = new Map();

// --- Supabase ---------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

app.use(cors({ origin: '*' }));
app.use(express.json());

// --- Middleware auth --------------------------------------------------
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
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
  const tokenFromHeader = req.headers.authorization?.replace('Bearer ', '') || '';
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

// --- ROOT -------------------------------------------------------------
app.get('/', (req, res) => res.json({
  message: 'EGCHAT API funcionando!',
  version: '2.5.0',
  database: 'Supabase',
  status: 'active'
}));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/debug', (req, res) => res.json({
  supabase_url: process.env.SUPABASE_URL ? '✅ set' : '❌ missing',
  supabase_key: process.env.SUPABASE_SERVICE_KEY ? '✅ set' : '❌ missing',
  jwt_secret: process.env.JWT_SECRET ? '✅ set' : '❌ missing',
  node_env: process.env.NODE_ENV || 'not set',
  port: PORT
}));

app.get('/api/system/dependencies', async (_req, res) => {
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
    'lia_conversations'
  ];
  const checks = await Promise.all(required.map(checkTable));
  const missing = checks.filter((c) => !c.ok);
  res.json({
    ok: missing.length === 0,
    required_tables: required.length,
    ready_tables: checks.filter((c) => c.ok).length,
    missing,
    hint: missing.length ? 'Ejecuta egchat-api/full_dependencies.sql en Supabase SQL Editor.' : 'Backend listo y sincronizado.'
  });
});

// Reset completo de datos para reinicio limpio (usuarios/chats/contactos/etc.)
app.post('/api/admin/reset-all', async (req, res) => {
  const keyFromHeader = req.headers['x-admin-key'];
  const keyFromBody = req.body?.adminKey;
  const providedKey = typeof keyFromHeader === 'string' ? keyFromHeader : keyFromBody;
  if (!providedKey || providedKey !== adminResetKey) {
    return res.status(403).json({ message: 'No autorizado' });
  }

  const results = [];
  // Orden importante por claves foráneas (hijos -> padres)
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

  const ok = results.filter((r) => r.ok).map((r) => r.table);
  const failed = results.filter((r) => !r.ok);
  return res.json({
    message: 'Reset ejecutado',
    ok_tables: ok,
    failed
  });
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
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, full_name, avatar_url } = req.body;
    if (!phone || !password || !full_name || !avatar_url)
      return res.status(400).json({ message: 'phone, password, full_name y avatar_url son requeridos' });

    // Verificar si ya existe
    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).maybeSingle();
    if (existing) return res.status(409).json({ message: 'El teléfono ya está registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ phone, full_name, password_hash: hashed, avatar_url })
      .select('id, phone, full_name, avatar_url')
      .single();

    if (error) throw error;

    // Crear wallet inicial
    await supabase.from('wallets').insert({ user_id: user.id, balance: 5000, currency: 'XAF' });

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user });
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

    // Actualizar último acceso
    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, full_name: user.full_name, avatar_url: user.avatar_url } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, avatar_url, created_at').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
  res.json(user);
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONTACTOS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/contacts', auth, async (req, res) => {
  try {
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, contact_user_id, name, phone, is_blocked, created_at, users(id, phone, full_name, avatar_url)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    res.json(contacts || []);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/contacts', auth, async (req, res) => {
  try {
    const { contact_user_id, name, phone } = req.body;
    // Verificar que no sea el mismo usuario
    if (contact_user_id === req.user.id) return res.status(400).json({ message: 'No puedes agregarte a ti mismo como contacto' });
    
    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({ user_id: req.user.id, contact_user_id, name: name || '', phone })
      .select('id, contact_user_id, name, phone, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(contact);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/contacts/:contactId', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', req.params.contactId)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ message: 'Contacto eliminado' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/contacts/:contactId/block', auth, async (req, res) => {
  try {
    const { data: contact, error } = await supabase
      .from('contacts')
      .update({ is_blocked: true })
      .eq('id', req.params.contactId)
      .eq('user_id', req.user.id)
      .select('id, is_blocked')
      .single();
    if (error) throw error;
    res.json(contact);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ========================================================================
// CHAT / MENSAJERÍA COMPLETA
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

    // Para cada chat, obtener participantes y Ãºltimo mensaje
    const result = await Promise.all(chats.map(async (chat) => {
      const { data: parts } = await supabase
        .from('chat_participants')
        .select('user_id, users(id, phone, full_name)')
        .eq('chat_id', chat.id);

      const { data: lastMsgs } = await supabase
        .from('messages')
        .select('id, text, type, created_at, sender_id')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(1);

      return {
        id: chat.id,
        type: chat.type || 'private',
        name: chat.name,
        participants: parts || [],
        last_message: lastMsgs?.[0] || null,
        updated_at: chat.updated_at,
        unread_count: 0
      };
    }));

    res.json(result);
  } catch (e) {
    console.error('Get chats error:', e.message);
    res.json([]); // Devolver vacío en vez de 500
  }
});

// Obtener mensajes de un chat especÃ­fico
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
// Crear chat privado â€” usa chat_participants
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
        return res.status(404).json({ message: 'Usuario no encontrado con ese número' });
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

    // Resetear contador de no leÃ­dos
    await supabase
      .from('chat_participants')
      .update({ unread_count: 0 })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);

    res.json({ message: 'Mensajes marcados como leÃ­dos' });
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

    // Aquí iría la lógica de subida de archivos a un servicio como AWS S3
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONTACTOS - GESTIÃ“N COMPLETA
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Obtener todos los contactos del usuario
app.get('/api/contacts', auth, async (req, res) => {
  try {
    const { data: contacts, error } = await supabase
      .from('contacts')
      .select(`
        *,
        contact_user:users!contact_user_id_fkey(
          id, phone, full_name, avatar_url, last_seen, status
        )
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Formatear contactos
    const formattedContacts = contacts.map(contact => ({
      id: contact.id,
      contact_user_id: contact.contact_user_id,
      nickname: contact.nickname,
      is_blocked: contact.is_blocked,
      is_favorite: contact.is_favorite,
      created_at: contact.created_at,
      user: contact.contact_user
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
        return res.status(404).json({ message: 'Usuario no encontrado con ese número' });
      }

      targetId = targetUser.id;
    }

    if (!targetId) {
      return res.status(400).json({ message: 'ID de contacto o teléfono requerido' });
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
        contact_user_id: targetId,
        nickname: nickname || targetUser.full_name
      })
      .select(`
        *,
        contact_user:users!contact_user_id_fkey(
          id, phone, full_name, avatar_url, last_seen, status
        )
      `)
      .single();

    if (error) throw error;

    res.json({
      id: contact.id,
      contact_user_id: contact.contact_user_id,
      nickname: contact.nickname,
      is_blocked: contact.is_blocked,
      is_favorite: contact.is_favorite,
      created_at: contact.created_at,
      user: contact.contact_user
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

// Obtener contactos para chat
app.get('/api/contacts/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ message: 'La bÃºsqueda debe tener al menos 2 caracteres' });
    }

    // Buscar usuarios por teléfono o nombre
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// WALLET
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe invÃ¡lido' });

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

  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe invÃ¡lido' });
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
    reference: `A: ${to} Â· ${concept || ''}`, status: 'completed'
  }).select().single();

  res.json({ balance: newBalance, transaction: tx });
});

app.post('/api/wallet/recharge-code', auth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.replace(/-/g, '').length !== 16)
    return res.status(400).json({ message: 'CÃ³digo invÃ¡lido' });

  // Verificar si el cÃ³digo ya fue usado
  const { data: usedCode } = await supabase
    .from('recharge_codes').select('*').eq('code', code).single();

  if (!usedCode) return res.status(400).json({ message: 'CÃ³digo no vÃ¡lido' });
  if (usedCode.used || usedCode.is_used) return res.status(400).json({ message: 'CÃ³digo ya utilizado' });
  if (usedCode.expires_at && new Date(usedCode.expires_at) < new Date())
    return res.status(400).json({ message: 'CÃ³digo expirado' });

  const amount = usedCode?.amount || 5000;

  // Marcar como usado
  if (usedCode) {
    await supabase.from('recharge_codes').update({ used: true, used_by: req.user.id, used_at: new Date().toISOString() }).eq('code', code);
  }

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const newBalance = (wallet?.balance || 0) + amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'deposit', amount, method: 'CÃ³digo de recarga',
    reference: code, status: 'completed'
  });

  res.json({ balance: newBalance, amount, message: `${amount.toLocaleString()} XAF aÃ±adidos` });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LIA-25
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/lia/chat', auth, async (req, res) => {
  const { message } = req.body;
  const lower = message.toLowerCase();

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const balance = wallet?.balance || 0;

  let reply = '';
  if (lower.includes('saldo') || lower.includes('balance'))
    reply = `Tu saldo actual es **${balance.toLocaleString()} XAF**. Â¿Deseas recargar o retirar?`;
  else if (lower.includes('hola') || lower.includes('buenos'))
    reply = 'Â¡Hola! Soy Lia-25, tu asistente inteligente de EGCHAT. Â¿En quÃ© puedo ayudarte hoy?';
  else if (lower.includes('taxi'))
    reply = 'Puedo ayudarte a pedir un taxi. Ve a la secciÃ³n MiTaxi desde el menÃº principal.';
  else if (lower.includes('salud') || lower.includes('hospital'))
    reply = 'En la secciÃ³n Salud encontrarÃ¡s hospitales, farmacias y puedes pedir citas mÃ©dicas.';
  else if (lower.includes('supermercado') || lower.includes('compra'))
    reply = 'Puedes hacer compras en lÃ­nea desde la secciÃ³n Supermercados. Tenemos tiendas en Malabo y Bata.';
  else if (lower.includes('transferir') || lower.includes('enviar dinero'))
    reply = 'Para enviar dinero, ve a Mi Monedero â†’ Enviar, o dime el nÃºmero y el importe.';
  else if (lower.includes('seguro'))
    reply = 'Puedes contratar seguros de salud, vehÃ­culo, vida y hogar en la secciÃ³n Seguros.';
  else if (lower.includes('noticias'))
    reply = 'Las Ãºltimas noticias de Guinea Ecuatorial y del mundo estÃ¡n en la secciÃ³n Noticias.';
  else if (lower.includes('gracias'))
    reply = 'Â¡De nada! Estoy aquÃ­ para ayudarte. Â¿Hay algo mÃ¡s?';
  else
    reply = `Entendido: "${message}". Puedo ayudarte con saldo, transferencias, taxi, salud, supermercados, seguros y noticias.`;

  // Guardar conversaciÃ³n en Supabase
  await supabase.from('lia_conversations').insert({
    user_id: req.user.id, message, reply
  }).catch(() => {});

  res.json({ reply, timestamp: new Date().toISOString() });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// USER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/user/profile', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, created_at, last_login').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'No encontrado' });
  res.json(user);
});

app.put('/api/user/profile', auth, async (req, res) => {
  const { full_name, avatar_url, city } = req.body;
  const updates = {};
  if (full_name) updates.full_name = full_name;
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;
  if (city) updates.city = city;
  const { data: user } = await supabase
    .from('users').update(updates).eq('id', req.user.id).select('id, phone, full_name, avatar_url').single();
  res.json(user);
});

app.post('/api/user/change-password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if (!ok) return res.status(401).json({ message: 'ContraseÃ±a actual incorrecta' });
  const hashed = await bcrypt.hash(newPassword, 10);
  await supabase.from('users').update({ password_hash: hashed }).eq('id', req.user.id);
  res.json({ message: 'ContraseÃ±a actualizada' });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONTACTOS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/contacts', auth, async (req, res) => {
  const { data } = await supabase.from('contacts')
    .select('*, contact:contact_id(id, phone, full_name, avatar_url)')
    .eq('user_id', req.user.id);
  res.json(data || []);
});

app.post('/api/contacts', auth, async (req, res) => {
  const { phone, name } = req.body;
  const { data: found } = await supabase.from('users').select('id, phone, full_name').eq('phone', phone).single();
  if (!found) return res.status(404).json({ message: 'Usuario no encontrado' });
  const { data } = await supabase.from('contacts')
    .upsert({ user_id: req.user.id, contact_id: found.id, nickname: name || found.full_name })
    .select().single();
  res.json(data);
});

app.delete('/api/contacts/:id', auth, async (req, res) => {
  await supabase.from('contacts').delete().eq('user_id', req.user.id).eq('contact_id', req.params.id);
  res.json({ message: 'Contacto eliminado' });
});

app.put('/api/contacts/:id/block', auth, async (req, res) => {
  await supabase.from('contacts').upsert({ user_id: req.user.id, contact_id: req.params.id, is_blocked: true });
  res.json({ message: 'Contacto bloqueado' });
});

app.put('/api/contacts/:id/unblock', auth, async (req, res) => {
  await supabase.from('contacts').update({ is_blocked: false }).eq('user_id', req.user.id).eq('contact_id', req.params.id);
  res.json({ message: 'Contacto desbloqueado' });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SERVICIOS PÃšBLICOS (simulados con datos reales de GE)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/servicios/segesa/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'NÃºmero de contrato requerido' });
  res.json({ contrato, titular: 'Cliente SEGESA', importe: Math.floor(Math.random()*15000)+5000, vencimiento: '2026-04-30', estado: 'pendiente', direccion: 'Malabo, Guinea Ecuatorial' });
});

app.post('/api/servicios/segesa/pagar', auth, async (req, res) => {
  const { contrato, importe, metodo } = req.body;
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  if (!wallet || importe > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });
  const newBalance = wallet.balance - importe;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
  await supabase.from('transactions').insert({ user_id: req.user.id, type: 'payment', amount: importe, method: metodo || 'EGCHAT', reference: `SEGESA-${contrato}`, status: 'completed' });
  res.json({ success: true, balance: newBalance, referencia: `SEG-${Date.now()}`, message: 'Pago de electricidad completado' });
});

app.post('/api/servicios/snge/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'NÃºmero de contrato requerido' });
  res.json({ contrato, titular: 'Cliente SNGE', importe: Math.floor(Math.random()*8000)+2000, vencimiento: '2026-04-30', estado: 'pendiente', direccion: 'Malabo, Guinea Ecuatorial' });
});

app.post('/api/servicios/snge/pagar', auth, async (req, res) => {
  const { contrato, importe, metodo } = req.body;
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  if (!wallet || importe > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });
  const newBalance = wallet.balance - importe;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
  await supabase.from('transactions').insert({ user_id: req.user.id, type: 'payment', amount: importe, method: metodo || 'EGCHAT', reference: `SNGE-${contrato}`, status: 'completed' });
  res.json({ success: true, balance: newBalance, referencia: `SNGE-${Date.now()}`, message: 'Pago de agua completado' });
});

app.post('/api/servicios/dgi/consultar', auth, async (req, res) => {
  const { nif, tipo } = req.body;
  res.json({ nif, tipo, importe: Math.floor(Math.random()*50000)+10000, periodo: '2026-T1', estado: 'pendiente', descripcion: `Impuesto ${tipo || 'general'}` });
});

app.post('/api/servicios/dgi/pagar', auth, async (req, res) => {
  const { nif, importe, referencia } = req.body;
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  if (!wallet || importe > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });
  const newBalance = wallet.balance - importe;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
  await supabase.from('transactions').insert({ user_id: req.user.id, type: 'payment', amount: importe, method: 'EGCHAT', reference: `DGI-${nif}-${referencia}`, status: 'completed' });
  res.json({ success: true, balance: newBalance, referencia: `DGI-${Date.now()}`, message: 'Pago de impuesto completado' });
});

app.post('/api/servicios/correos/enviar', auth, async (req, res) => {
  const { destinatario, peso, tipo } = req.body;
  const tarifa = tipo === 'express' ? 5000 : 2500;
  res.json({ tracking: `EG${Date.now()}`, tarifa, estimado: tipo === 'express' ? '1-2 dÃ­as' : '3-5 dÃ­as', destinatario, message: 'Paquete registrado correctamente' });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SUPERMERCADOS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const SUPERMERCADOS = [
  { id: '1', name: 'Supermarket Malabo', city: 'Malabo', address: 'Calle de la Independencia', phone: '+240 222 001', open: true },
  { id: '2', name: 'Tienda Bata Centro', city: 'Bata', address: 'Av. Hassan II', phone: '+240 333 001', open: true },
  { id: '3', name: 'Mercado Mongomo', city: 'Mongomo', address: 'Plaza Central', phone: '+240 444 001', open: false },
];
const PRODUCTOS = [
  { id: '1', name: 'Arroz 5kg', price: 3500, category: 'AlimentaciÃ³n', stock: 50 },
  { id: '2', name: 'Aceite 1L', price: 1200, category: 'AlimentaciÃ³n', stock: 30 },
  { id: '3', name: 'Agua 6x1.5L', price: 2000, category: 'Bebidas', stock: 100 },
  { id: '4', name: 'Leche 1L', price: 800, category: 'LÃ¡cteos', stock: 20 },
  { id: '5', name: 'Pan de molde', price: 600, category: 'PanaderÃ­a', stock: 15 },
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
  const { items, supermarketId, address } = req.body;
  const total = items?.reduce((s, i) => s + (i.price * i.qty), 0) || 0;
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  if (!wallet || total > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });
  const newBalance = wallet.balance - total;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
  await supabase.from('transactions').insert({ user_id: req.user.id, type: 'payment', amount: total, method: 'EGCHAT', reference: `SUPER-${supermarketId}`, status: 'completed' });
  res.json({ orderId: `ORD-${Date.now()}`, status: 'confirmed', total, balance: newBalance, eta: '30-45 min' });
});

app.get('/api/supermarkets/orders', auth, async (req, res) => {
  const { data } = await supabase.from('transactions').select('*').eq('user_id', req.user.id).like('reference', 'SUPER-%').order('created_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/supermarkets/orders/:id', auth, async (req, res) => {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('id', req.params.id)
    .maybeSingle();
  if (!data) return res.status(404).json({ message: 'Pedido no encontrado' });
  res.json(data);
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SALUD
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const HOSPITALES = [
  { id: '1', name: 'Hospital General de Malabo', city: 'Malabo', phone: '+240 222 100', emergency: true, specialties: ['Urgencias', 'CirugÃ­a', 'PediatrÃ­a'] },
  { id: '2', name: 'ClÃ­nica Santa Isabel', city: 'Malabo', phone: '+240 222 200', emergency: false, specialties: ['Medicina General', 'GinecologÃ­a'] },
  { id: '3', name: 'Hospital Regional de Bata', city: 'Bata', phone: '+240 333 100', emergency: true, specialties: ['Urgencias', 'TraumatologÃ­a'] },
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
  res.json({ citaId: `CITA-${Date.now()}`, hospital: hospital.name, especialidad, fecha, motivo, confirmado: true, message: 'Cita mÃ©dica confirmada' });
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
  const { items, farmaciaId, direccion } = req.body;
  const total = items?.reduce((s, i) => s + (i.price * i.qty), 0) || 0;
  res.json({ orderId: `MED-${Date.now()}`, status: 'confirmed', total, eta: '20-30 min', message: 'Pedido de medicamentos confirmado' });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TAXI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/taxi/request', auth, async (req, res) => {
  const { origin, dest, type } = req.body;
  const tarifa = type === 'premium' ? 3500 : type === 'moto' ? 800 : 1500;
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  if (!wallet || tarifa > wallet.balance) return res.status(400).json({ message: 'Saldo insuficiente' });
  res.json({
    rideId: `RIDE-${Date.now()}`,
    driver: { name: 'Carlos Mba', phone: '+240 222 555', rating: 4.8, plate: 'GE-1234', vehicle: type === 'moto' ? 'Moto Honda' : 'Toyota Corolla' },
    eta: Math.floor(Math.random() * 8) + 3,
    tarifa, type,
    status: 'searching'
  });
});

app.get('/api/taxi/:rideId/status', auth, async (req, res) => {
  res.json({ rideId: req.params.rideId, status: 'en_route', eta: 2, driver_location: { lat: 3.75, lng: 8.78 } });
});

app.post('/api/taxi/:rideId/cancel', auth, async (req, res) => {
  res.json({ message: 'Viaje cancelado', rideId: req.params.rideId });
});

app.post('/api/taxi/:rideId/rate', auth, async (req, res) => {
  const { rating, comment } = req.body;
  res.json({ message: 'ValoraciÃ³n enviada', rating, rideId: req.params.rideId });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SEGUROS - COTIZACIONES, PÃ“LIZAS, RECLAMACIONES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Obtener tipos de seguros disponibles
app.get('/api/insurance/types', auth, async (req, res) => {
  try {
    const insuranceTypes = [
      {
        id: 'salud',
        name: 'Seguro de Salud',
        icon: 'ðŸ¥',
        description: 'Cobertura mÃ©dica completa',
        coverage: ['consultas', 'urgencias', 'hospitalizaciÃ³n', 'medicamentos'],
        starting_price: 5000
      },
      {
        id: 'vehiculo',
        name: 'Seguro de VehÃ­culo',
        icon: 'ðŸš—',
        description: 'ProtecciÃ³n para tu vehÃ­culo',
        coverage: ['colisiÃ³n', 'robo', 'daÃ±os', 'responsabilidad civil'],
        starting_price: 8000
      },
      {
        id: 'vida',
        name: 'Seguro de Vida',
        icon: 'ðŸ›¡ï¸',
        description: 'Seguridad para tu familia',
        coverage: ['fallecimiento', 'invalidez', 'enfermedades graves'],
        starting_price: 3000
      },
      {
        id: 'hogar',
        name: 'Seguro de Hogar',
        icon: 'ðŸ ',
        description: 'ProtecciÃ³n para tu vivienda',
        coverage: ['incendio', 'robo', 'daÃ±os estructurales', 'responsabilidad civil'],
        starting_price: 4000
      }
    ];

    res.json(insuranceTypes);
  } catch (e) {
    console.error('Get insurance types error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener cotizaciÃ³n de seguro
app.post('/api/insurance/quote', auth, async (req, res) => {
  try {
    const { insurance_type, coverage_amount, duration_months } = req.body;

    if (!insurance_type || !coverage_amount || !duration_months) {
      return res.status(400).json({ message: 'Datos incompletos para cotizaciÃ³n' });
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

    // Crear pÃ³liza
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

    // Registrar transacciÃ³n
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

// Obtener pÃ³lizas del usuario
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

// Presentar reclamaciÃ³n
app.post('/api/insurance/claim', auth, async (req, res) => {
  try {
    const { policy_id, claim_type, description, amount } = req.body;

    if (!policy_id || !claim_type || !description) {
      return res.status(400).json({ message: 'Datos incompletos para reclamaciÃ³n' });
    }

    // Verificar que la pÃ³liza pertenece al usuario
    const { data: policy } = await supabase
      .from('insurance_policies')
      .select('id, user_id, status')
      .eq('id', policy_id)
      .single();

    if (!policy || policy.user_id !== req.user.id) {
      return res.status(404).json({ message: 'PÃ³liza no encontrada' });
    }

    if (policy.status !== 'active') {
      return res.status(400).json({ message: 'La pÃ³liza no estÃ¡ activa' });
    }

    // Crear reclamaciÃ³n
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
      message: 'ReclamaciÃ³n presentada exitosamente',
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NOTICIAS - CATEGORÃAS, FEEDS, BÃšSQUEDA, PERSONALIZACIÃ“N
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Obtener categorÃ­as de noticias
app.get('/api/news/categories', auth, async (req, res) => {
  try {
    const categories = [
      {
        id: 'nacional',
        name: 'Nacional',
        icon: 'ðŸ‡¬ðŸ‡¶',
        description: 'Noticias de Guinea Ecuatorial'
      },
      {
        id: 'internacional',
        name: 'Internacional',
        icon: 'ðŸŒ',
        description: 'Noticias del mundo'
      },
      {
        id: 'deportes',
        name: 'Deportes',
        icon: 'âš½',
        description: 'FÃºtbol y otros deportes'
      },
      {
        id: 'economia',
        name: 'EconomÃ­a',
        icon: 'ðŸ’°',
        description: 'Finanzas y negocios'
      },
      {
        id: 'tecnologia',
        name: 'TecnologÃ­a',
        icon: 'ðŸ’»',
        description: 'TecnologÃ­a y ciencia'
      },
      {
        id: 'cultura',
        name: 'Cultura',
        icon: 'ðŸŽ­',
        description: 'Arte y entretenimiento'
      }
    ];

    res.json(categories);
  } catch (e) {
    console.error('Get news categories error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener noticias por categorÃ­a
app.get('/api/news', auth, async (req, res) => {
  try {
    const { category, page = 1, limit = 20 } = req.query;

    // Noticias simuladas (en producciÃ³n vendrÃ­an de una API real)
    const allNews = [
      {
        id: '1',
        title: 'EGCHAT lanza nueva funcionalidad de mensajería instantánea',
        category: 'tecnologia',
        summary: 'La aplicaciÃ³n EGCHAT anuncia importantes mejoras...',
        content: '...',
        image_url: 'https://example.com/egchat-news.jpg',
        published_at: new Date().toISOString(),
        source: 'TechGE'
      },
      {
        id: '2',
        title: 'EconomÃ­a de Guinea Ecuatorial muestra crecimiento',
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
      return res.status(400).json({ message: 'La bÃºsqueda debe tener al menos 2 caracteres' });
    }

    // Noticias simuladas para bÃºsqueda
    const searchResults = [
      {
        id: 'search1',
        title: `Resultados para "${q}" en EGCHAT`,
        category: category || 'todos',
        summary: `Se encontraron artÃ­culos relacionados con ${q}...`,
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SEGUROS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

app.post('/api/seguros/solicitar', auth, async (req, res) => {
  const { companyId, producto, datos } = req.body;
  res.json({ solicitudId: `SEG-${Date.now()}`, status: 'pending', message: 'Solicitud de seguro enviada. Te contactaremos en 24h.' });
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NOTICIAS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const NOTICIAS = [
  { id: '1', title: 'Presidente anuncia nuevas medidas econÃ³micas para 2026', source: 'Presidencia GE', category: 'PolÃ­tica', time: '14:30', isLive: true },
  { id: '2', title: 'CEMAC aprueba nuevo marco financiero regional', source: 'Noticias CEMAC', category: 'Finanzas', time: '13:45' },
  { id: '3', title: 'Ministerio de Salud reporta avances en vacunaciÃ³n', source: 'Ministerio de InformaciÃ³n', category: 'Salud', time: '12:20' },
  { id: '4', title: 'Nueva tecnologÃ­a 5G llega a Malabo', source: 'TVGE', category: 'TecnologÃ­a', time: '11:15' },
  { id: '5', title: 'SelecciÃ³n nacional se prepara para eliminatorias', source: 'Radio Nacional', category: 'Deportes', time: '10:30' },
  { id: '6', title: 'BEAC anuncia nuevas polÃ­ticas monetarias', source: 'BEAC', category: 'Finanzas', time: '09:00' },
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
  res.json({ analysis: 'Análisis completado.' });
});

app.post('/lia/transcribe', auth, async (_req, res) => {
  res.json({ text: 'Transcripción completada.' });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// GRUPOS DE CHAT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/chats/group', auth, async (req, res) => {
  try {
    const { name, participant_ids, avatar_url } = req.body;
    if (!name || !participant_ids?.length) return res.status(400).json({ message: 'Nombre y participantes requeridos' });

    const { data: chat, error } = await supabase.from('chats')
      .insert({ type: 'group', name, avatar_url: avatar_url || null, created_by: req.user.id })
      .select().single();
    if (error) throw error;

    const allIds = [...new Set([req.user.id, ...participant_ids])];
    await supabase.from('chat_participants').insert(allIds.map(uid => ({ chat_id: chat.id, user_id: uid })));

    res.json({ ...chat, participants: allIds });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// AÃ±adir participante a grupo
app.post('/api/chats/:chatId/participants', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    await supabase.from('chat_participants').upsert({ chat_id: req.params.chatId, user_id });
    res.json({ message: 'Participante aÃ±adido' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NOTIFICACIONES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/notifications', auth, async (req, res) => {
  try {
    // Mensajes no leÃ­dos como notificaciones
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

// Marcar mensajes como leÃ­dos
app.post('/api/chats/:chatId/read', auth, async (req, res) => {
  try {
    await supabase.from('messages')
      .update({ status: 'read' })
      .eq('chat_id', req.params.chatId)
      .neq('sender_id', req.user.id);
    res.json({ message: 'Mensajes marcados como leÃ­dos' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONTACTOS CON FOTO Y PERFIL
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/api/contacts', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('contacts').select('*').eq('user_id', req.user.id);
    if (!data || data.length === 0) return res.json([]);
    // Obtener info de cada contacto
    const contactIds = data.map(c => c.contact_id);
    const { data: users } = await supabase.from('users').select('id, phone, full_name, avatar_url').in('id', contactIds);
    const userMap = Object.fromEntries((users||[]).map(u => [u.id, u]));
    res.json(data.map(c => ({
      id: c.contact_id,
      name: c.nickname || userMap[c.contact_id]?.full_name || 'Contacto',
      phone: userMap[c.contact_id]?.phone || '',
      avatar_url: userMap[c.contact_id]?.avatar_url || '',
      addedDate: c.created_at,
    })));
  } catch (e) { res.json([]); }
});

app.post('/api/contacts', auth, async (req, res) => {
  try {
    const { phone, name } = req.body;
    const { data: found } = await supabase.from('users').select('id, phone, full_name, avatar_url').eq('phone', phone).single();
    if (!found) return res.status(404).json({ message: 'Usuario no encontrado' });
    await supabase.from('contacts').upsert({ user_id: req.user.id, contact_id: found.id, nickname: name || found.full_name });
    res.json({ id: found.id, name: found.full_name, phone: found.phone, avatar_url: found.avatar_url });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Perfil pÃºblico de un usuario
app.get('/api/users/:userId', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('id, phone, full_name, avatar_url, created_at').eq('id', req.params.userId).single();
    if (!data) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// START
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.listen(PORT, () => {
  console.log(`\nðŸš€ EGCHAT API + Supabase en http://localhost:${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL ? 'âœ… Conectado' : 'âš ï¸  Sin configurar'}`);
  console.log(`   Auth:   POST /api/auth/register | /api/auth/login`);
  console.log(`   Wallet: GET  /api/wallet/balance | POST /api/wallet/deposit`);
  console.log(`   Lia-25: POST /api/lia/chat\n`);
});

