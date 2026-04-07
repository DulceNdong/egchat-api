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

// ── Supabase ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Middleware auth ───────────────────────────────────────────────
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

// ── ROOT ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  message: 'EGCHAT API funcionando!',
  version: '2.0.0',
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

// ══════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, full_name } = req.body;
    if (!phone || !password || !full_name)
      return res.status(400).json({ message: 'phone, password y full_name son requeridos' });

    // Verificar si ya existe
    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).single();
    if (existing) return res.status(409).json({ message: 'El teléfono ya está registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ phone, full_name, password_hash: hashed })
      .select('id, phone, full_name')
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
      .from('users').select('*').eq('phone', phone).single();

    if (error || !user) return res.status(401).json({ message: 'Credenciales incorrectas' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Credenciales incorrectas' });

    // Actualizar último acceso
    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, full_name: user.full_name } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, created_at').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
  res.json(user);
});

app.post('/api/auth/logout', auth, (req, res) => res.json({ message: 'Sesión cerrada' }));

// ========================================================================
// CHAT / MENSJERÍA COMPLETA
// ========================================================================

// Obtener todos los chats del usuario
app.get('/api/chats', auth, async (req, res) => {
  try {
    const { data: chats, error } = await supabase
      .from('chats')
      .select(`
        *,
        participants!inner(
          user_id,
          users(id, phone, full_name, avatar_url)
        ),
        last_message:messages(id, text, type, created_at, sender_id)
      `)
      .contains('participants', JSON.stringify([{ user_id: req.user.id }]));

    if (error) throw error;

    // Formatear los datos
    const formattedChats = chats.map(chat => ({
      id: chat.id,
      type: chat.type, // 'private', 'group'
      name: chat.name,
      avatar_url: chat.avatar_url,
      participants: chat.participants.map(p => ({
        user_id: p.user_id,
        ...p.users
      })),
      last_message: chat.last_message?.[0] || null,
      updated_at: chat.updated_at,
      unread_count: chat.unread_count || 0
    }));

    res.json(formattedChats);
  } catch (e) {
    console.error('Get chats error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Obtener mensajes de un chat específico
app.get('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const from = (page - 1) * limit;

    // Verificar que el usuario pertenece al chat
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('id')
      .eq('id', chatId)
      .contains('participants', JSON.stringify([{ user_id: req.user.id }]))
      .single();

    if (chatError || !chat) {
      return res.status(403).json({ message: 'No tienes acceso a este chat' });
    }

    // Obtener mensajes
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select(`
        id,
        text,
        type,
        created_at,
        updated_at,
        sender_id,
        status,
        reply_to,
        file_url,
        file_type,
        file_size,
        thumbnail_url,
        sender:users(id, phone, full_name, avatar_url)
      `)
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (msgError) throw msgError;

    res.json(messages.reverse()); // Mensajes más antiguos primero
  } catch (e) {
    console.error('Get messages error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Enviar mensaje
app.post('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text, type = 'text', reply_to, file_url, file_type, file_size, thumbnail_url } = req.body;

    if (!text && !file_url) {
      return res.status(400).json({ message: 'El texto o archivo es requerido' });
    }

    // Verificar acceso al chat
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('id, participants')
      .eq('id', chatId)
      .contains('participants', JSON.stringify([{ user_id: req.user.id }]))
      .single();

    if (chatError || !chat) {
      return res.status(403).json({ message: 'No tienes acceso a este chat' });
    }

    // Crear mensaje
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        sender_id: req.user.id,
        text: text || null,
        type,
        reply_to: reply_to || null,
        file_url: file_url || null,
        file_type: file_type || null,
        file_size: file_size || null,
        thumbnail_url: thumbnail_url || null,
        status: 'sent',
        created_at: new Date().toISOString()
      })
      .select(`
        id,
        text,
        type,
        created_at,
        sender_id,
        status,
        reply_to,
        file_url,
        file_type,
        file_size,
        thumbnail_url,
        sender:users(id, phone, full_name, avatar_url)
      `)
      .single();

    if (msgError) throw msgError;

    // Actualizar último mensaje del chat
    await supabase
      .from('chats')
      .update({ 
        updated_at: new Date().toISOString(),
        last_message_id: message.id
      })
      .eq('id', chatId);

    // Incrementar contador de no leídos para otros participantes
    const otherParticipants = chat.participants
      .filter(p => p.user_id !== req.user.id)
      .map(p => p.user_id);

    if (otherParticipants.length > 0) {
      await supabase.rpc('increment_unread_count', {
        chat_id_param: chatId,
        user_ids: otherParticipants
      });
    }

    res.status(201).json(message);
  } catch (e) {
    console.error('Send message error:', e);
    res.status(500).json({ message: e.message });
  }
});

// Crear chat privado
app.post('/api/chats/private', auth, async (req, res) => {
  try {
    const { participant_id } = req.body;

    if (!participant_id) {
      return res.status(400).json({ message: 'El ID del participante es requerido' });
    }

    if (participant_id === req.user.id) {
      return res.status(400).json({ message: 'No puedes crear un chat contigo mismo' });
    }

    // Verificar si ya existe un chat privado entre estos usuarios
    const { data: existingChat, error: checkError } = await supabase
      .from('chats')
      .select('id')
      .eq('type', 'private')
      .contains('participants', JSON.stringify([
        { user_id: req.user.id },
        { user_id: participant_id }
      ]))
      .single();

    if (existingChat) {
      return res.json(existingChat);
    }

    // Obtener información del otro usuario
    const { data: otherUser, error: userError } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url')
      .eq('id', participant_id)
      .single();

    if (userError || !otherUser) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    // Crear nuevo chat privado
    const { data: chat, error: createError } = await supabase
      .from('chats')
      .insert({
        type: 'private',
        participants: [
          { user_id: req.user.id },
          { user_id: participant_id }
        ],
        created_by: req.user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) throw createError;

    // Formatear respuesta con información de participantes
    const formattedChat = {
      ...chat,
      participants: [
        { user_id: req.user.id },
        { user_id: participant_id, ...otherUser }
      ],
      last_message: null,
      unread_count: 0
    };

    res.status(201).json(formattedChat);
  } catch (e) {
    console.error('Create private chat error:', e);
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
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('id')
      .eq('id', chatId)
      .contains('participants', JSON.stringify([{ user_id: req.user.id }]))
      .single();

    if (chatError || !chat) {
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

    // Resetear contador de no leídos
    await supabase
      .from('chat_participants')
      .update({ unread_count: 0 })
      .eq('chat_id', chatId)
      .eq('user_id', req.user.id);

    res.json({ message: 'Mensajes marcados como leídos' });
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
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('id')
      .eq('id', chatId)
      .contains('participants', JSON.stringify([{ user_id: req.user.id }]))
      .single();

    if (chatError || !chat) {
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

// Obtener contactos para chat
app.get('/api/contacts/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ message: 'La búsqueda debe tener al menos 2 caracteres' });
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

// ══════════════════════════════════════════════════════════════════
// WALLET
// ══════════════════════════════════════════════════════════════════
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
  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe inválido' });

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

  if (!amount || amount <= 0) return res.status(400).json({ message: 'Importe inválido' });
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
    reference: `A: ${to} · ${concept || ''}`, status: 'completed'
  }).select().single();

  res.json({ balance: newBalance, transaction: tx });
});

app.post('/api/wallet/recharge-code', auth, async (req, res) => {
  const { code } = req.body;
  if (!code || code.replace(/-/g, '').length !== 16)
    return res.status(400).json({ message: 'Código inválido' });

  // Verificar si el código ya fue usado
  const { data: usedCode } = await supabase
    .from('recharge_codes').select('*').eq('code', code).single();

  if (!usedCode) return res.status(400).json({ message: 'Código no válido' });
  if (usedCode.used || usedCode.is_used) return res.status(400).json({ message: 'Código ya utilizado' });
  if (usedCode.expires_at && new Date(usedCode.expires_at) < new Date())
    return res.status(400).json({ message: 'Código expirado' });

  const amount = usedCode?.amount || 5000;

  // Marcar como usado
  if (usedCode) {
    await supabase.from('recharge_codes').update({ used: true, used_by: req.user.id, used_at: new Date().toISOString() }).eq('code', code);
  }

  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
  const newBalance = (wallet?.balance || 0) + amount;
  await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id, type: 'deposit', amount, method: 'Código de recarga',
    reference: code, status: 'completed'
  });

  res.json({ balance: newBalance, amount, message: `${amount.toLocaleString()} XAF añadidos` });
});

// ══════════════════════════════════════════════════════════════════
// LIA-25
// ══════════════════════════════════════════════════════════════════
app.post('/api/lia/chat', auth, async (req, res) => {
  const { message } = req.body;
  const lower = message.toLowerCase();

  const { data: wallet } = await supabase
    .from('wallets').select('balance').eq('user_id', req.user.id).single();
  const balance = wallet?.balance || 0;

  let reply = '';
  if (lower.includes('saldo') || lower.includes('balance'))
    reply = `Tu saldo actual es **${balance.toLocaleString()} XAF**. ¿Deseas recargar o retirar?`;
  else if (lower.includes('hola') || lower.includes('buenos'))
    reply = '¡Hola! Soy Lia-25, tu asistente inteligente de EGCHAT. ¿En qué puedo ayudarte hoy?';
  else if (lower.includes('taxi'))
    reply = 'Puedo ayudarte a pedir un taxi. Ve a la sección MiTaxi desde el menú principal.';
  else if (lower.includes('salud') || lower.includes('hospital'))
    reply = 'En la sección Salud encontrarás hospitales, farmacias y puedes pedir citas médicas.';
  else if (lower.includes('supermercado') || lower.includes('compra'))
    reply = 'Puedes hacer compras en línea desde la sección Supermercados. Tenemos tiendas en Malabo y Bata.';
  else if (lower.includes('transferir') || lower.includes('enviar dinero'))
    reply = 'Para enviar dinero, ve a Mi Monedero → Enviar, o dime el número y el importe.';
  else if (lower.includes('gracias'))
    reply = '¡De nada! Estoy aquí para ayudarte. ¿Hay algo más?';
  else
    reply = `Entendido: "${message}". Puedo ayudarte con saldo, transferencias, taxi, salud, supermercados y más.`;

  // Guardar conversación en Supabase
  await supabase.from('lia_conversations').insert({
    user_id: req.user.id, message, reply
  }).catch(() => {});

  res.json({ reply, timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════════
// USER
// ══════════════════════════════════════════════════════════════════
app.get('/api/user/profile', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('id, phone, full_name, created_at, last_login').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ message: 'No encontrado' });
  res.json(user);
});

app.put('/api/user/profile', auth, async (req, res) => {
  const { full_name } = req.body;
  const { data: user } = await supabase
    .from('users').update({ full_name }).eq('id', req.user.id).select('id, phone, full_name').single();
  res.json(user);
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

// ══════════════════════════════════════════════════════════════════
// CONTACTOS
// ══════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════
// SERVICIOS PÚBLICOS (simulados con datos reales de GE)
// ══════════════════════════════════════════════════════════════════
app.post('/api/servicios/segesa/consultar', auth, async (req, res) => {
  const { contrato } = req.body;
  if (!contrato) return res.status(400).json({ message: 'Número de contrato requerido' });
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
  if (!contrato) return res.status(400).json({ message: 'Número de contrato requerido' });
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
  res.json({ tracking: `EG${Date.now()}`, tarifa, estimado: tipo === 'express' ? '1-2 días' : '3-5 días', destinatario, message: 'Paquete registrado correctamente' });
});

// ══════════════════════════════════════════════════════════════════
// SUPERMERCADOS
// ══════════════════════════════════════════════════════════════════
const SUPERMERCADOS = [
  { id: '1', name: 'Supermarket Malabo', city: 'Malabo', address: 'Calle de la Independencia', phone: '+240 222 001', open: true },
  { id: '2', name: 'Tienda Bata Centro', city: 'Bata', address: 'Av. Hassan II', phone: '+240 333 001', open: true },
  { id: '3', name: 'Mercado Mongomo', city: 'Mongomo', address: 'Plaza Central', phone: '+240 444 001', open: false },
];
const PRODUCTOS = [
  { id: '1', name: 'Arroz 5kg', price: 3500, category: 'Alimentación', stock: 50 },
  { id: '2', name: 'Aceite 1L', price: 1200, category: 'Alimentación', stock: 30 },
  { id: '3', name: 'Agua 6x1.5L', price: 2000, category: 'Bebidas', stock: 100 },
  { id: '4', name: 'Leche 1L', price: 800, category: 'Lácteos', stock: 20 },
  { id: '5', name: 'Pan de molde', price: 600, category: 'Panadería', stock: 15 },
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

// ══════════════════════════════════════════════════════════════════
// SALUD
// ══════════════════════════════════════════════════════════════════
const HOSPITALES = [
  { id: '1', name: 'Hospital General de Malabo', city: 'Malabo', phone: '+240 222 100', emergency: true, specialties: ['Urgencias', 'Cirugía', 'Pediatría'] },
  { id: '2', name: 'Clínica Santa Isabel', city: 'Malabo', phone: '+240 222 200', emergency: false, specialties: ['Medicina General', 'Ginecología'] },
  { id: '3', name: 'Hospital Regional de Bata', city: 'Bata', phone: '+240 333 100', emergency: true, specialties: ['Urgencias', 'Traumatología'] },
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
  res.json({ citaId: `CITA-${Date.now()}`, hospital: hospital.name, especialidad, fecha, motivo, confirmado: true, message: 'Cita médica confirmada' });
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

// ══════════════════════════════════════════════════════════════════
// TAXI
// ══════════════════════════════════════════════════════════════════
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
  res.json({ message: 'Valoración enviada', rating, rideId: req.params.rideId });
});

// ══════════════════════════════════════════════════════════════════
// SEGUROS
// ══════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════
// NOTICIAS
// ══════════════════════════════════════════════════════════════════
const NOTICIAS = [
  { id: '1', title: 'Presidente anuncia nuevas medidas económicas para 2026', source: 'Presidencia GE', category: 'Política', time: '14:30', isLive: true },
  { id: '2', title: 'CEMAC aprueba nuevo marco financiero regional', source: 'Noticias CEMAC', category: 'Finanzas', time: '13:45' },
  { id: '3', title: 'Ministerio de Salud reporta avances en vacunación', source: 'Ministerio de Información', category: 'Salud', time: '12:20' },
  { id: '4', title: 'Nueva tecnología 5G llega a Malabo', source: 'TVGE', category: 'Tecnología', time: '11:15' },
  { id: '5', title: 'Selección nacional se prepara para eliminatorias', source: 'Radio Nacional', category: 'Deportes', time: '10:30' },
  { id: '6', title: 'BEAC anuncia nuevas políticas monetarias', source: 'BEAC', category: 'Finanzas', time: '09:00' },
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

// ══════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 EGCHAT API + Supabase en http://localhost:${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅ Conectado' : '⚠️  Sin configurar'}`);
  console.log(`   Auth:   POST /api/auth/register | /api/auth/login`);
  console.log(`   Wallet: GET  /api/wallet/balance | POST /api/wallet/deposit`);
  console.log(`   Lia-25: POST /api/lia/chat\n`);
});
