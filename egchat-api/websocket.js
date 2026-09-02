/**
 * websocket.js  —  Servidor WebSocket para EGCHAT
 *
 * Reemplaza el polling de 30 segundos por push real-time.
 *
 * Eventos que el servidor envía al cliente:
 *   new_message      → nuevo mensaje en un chat
 *   chat_updated     → último mensaje / unread count cambiaron
 *   message_status   → estado de un mensaje cambió (sent/delivered/read)
 *   wallet_updated   → balance del wallet cambió
 *   user_online      → un contacto se conectó
 *   user_offline     → un contacto se desconectó
 *   ping             → keepalive del servidor
 *
 * Eventos que el cliente envía al servidor:
 *   auth             → autenticarse con JWT
 *   subscribe_chat   → suscribirse a un chat específico
 *   unsubscribe_chat → desuscribirse de un chat
 *   typing           → el usuario está escribiendo
 *   ping             → keepalive del cliente
 */

const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');

const JWT_SECRET          = process.env.JWT_SECRET
  || 'EGchat2025!xK9mP3nQ7rL2vW8tY4uJ6hF1bN5cA0dE_prod_secret';
const PING_INTERVAL_MS    = 25_000;   // ping cada 25s
const AUTH_TIMEOUT_MS     = 10_000;   // 10s para autenticarse tras conectar

// ── Mapas de estado ───────────────────────────────────────────────

// userId → Set<WebSocket>  (un usuario puede tener múltiples pestañas/dispositivos)
const userSockets  = new Map();

// wsClient → { userId, subscribedChats: Set<string>, isAlive: boolean }
const clientMeta   = new Map();

// ── Helpers ───────────────────────────────────────────────────────

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function send(ws, type, data) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type, ...data, ts: Date.now() })); } catch {}
}

function broadcastToUser(userId, type, data) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  for (const ws of sockets) send(ws, type, data);
}

function broadcastToChatParticipants(chatId, type, data, excludeUserId) {
  for (const [uid, sockets] of userSockets) {
    if (uid === excludeUserId) continue;
    for (const ws of sockets) {
      const meta = clientMeta.get(ws);
      if (meta?.subscribedChats?.has(chatId)) {
        send(ws, type, data);
      }
    }
  }
}

// ── Inicialización ────────────────────────────────────────────────

function initWebSocket(server) {
  const wss = new WebSocket.Server({
    server,
    path: '/ws',
    // Verificación de origen
    verifyClient: ({ origin, req }, done) => {
      const allowed = [
        'https://egchat-app.vercel.app',
        'https://egchat-v2.vercel.app',
        'http://localhost:3001',
        'http://localhost:5173',
        'capacitor://localhost',
        'https://localhost',
      ];
      // En producción verificar origen; en dev permitir todo
      if (!origin || allowed.some(a => origin.startsWith(a))) {
        done(true);
      } else {
        done(true); // permisivo — ajustar en producción si es necesario
      }
    },
  });

  console.log('[WS] Servidor WebSocket iniciado en /ws');

  // ── Keepalive global ─────────────────────────────────────────
  const pingInterval = setInterval(() => {
    for (const [ws, meta] of clientMeta) {
      if (!meta.isAlive) {
        // Cliente no respondió al ping anterior — desconectar
        _disconnect(ws);
        continue;
      }
      meta.isAlive = false;
      send(ws, 'ping', {});
    }
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(pingInterval));

  // ── Conexión nueva ────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    clientMeta.set(ws, {
      userId:          null,
      subscribedChats: new Set(),
      isAlive:         true,
    });

    // Timeout de autenticación
    const authTimeout = setTimeout(() => {
      if (!clientMeta.get(ws)?.userId) {
        send(ws, 'error', { code: 'AUTH_TIMEOUT', message: 'Autenticación requerida' });
        ws.terminate();
      }
    }, AUTH_TIMEOUT_MS);

    // ── Mensajes del cliente ────────────────────────────────────
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const meta = clientMeta.get(ws);
      if (!meta) return;
      meta.isAlive = true; // cualquier mensaje cuenta como pong

      switch (msg.type) {

        case 'auth': {
          clearTimeout(authTimeout);
          const payload = verifyToken(msg.token);
          if (!payload) {
            send(ws, 'error', { code: 'AUTH_FAILED', message: 'Token inválido' });
            ws.terminate();
            return;
          }
          const userId = payload.id?.toString() || payload.sub?.toString();
          meta.userId  = userId;

          // Registrar socket del usuario
          if (!userSockets.has(userId)) userSockets.set(userId, new Set());
          userSockets.get(userId).add(ws);

          send(ws, 'authenticated', { userId });
          // Notificar presencia online a contactos
          _broadcastPresence(userId, true);
          console.log(`[WS] Usuario conectado: ${userId}`);
          break;
        }

        case 'subscribe_chat': {
          if (!meta.userId) return;
          meta.subscribedChats.add(msg.chatId?.toString());
          send(ws, 'subscribed', { chatId: msg.chatId });
          break;
        }

        case 'unsubscribe_chat': {
          meta.subscribedChats.delete(msg.chatId?.toString());
          break;
        }

        case 'typing': {
          if (!meta.userId || !msg.chatId) return;
          // Reenviar a otros participantes del chat
          broadcastToChatParticipants(msg.chatId, 'typing', {
            chatId: msg.chatId,
            userId: meta.userId,
            isTyping: !!msg.isTyping,
          }, meta.userId);
          break;
        }

        case 'pong':
        case 'ping': {
          meta.isAlive = true;
          if (msg.type === 'ping') send(ws, 'pong', {});
          break;
        }
      }
    });

    // ── Desconexión ─────────────────────────────────────────────
    ws.on('close', () => {
      clearTimeout(authTimeout);
      _disconnect(ws);
    });

    ws.on('error', () => {
      clearTimeout(authTimeout);
      _disconnect(ws);
    });
  });

  // ── Helpers internos ──────────────────────────────────────────

  function _disconnect(ws) {
    const meta = clientMeta.get(ws);
    if (!meta) return;

    const { userId } = meta;
    clientMeta.delete(ws);

    if (userId) {
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          userSockets.delete(userId);
          // Notificar presencia offline cuando no quedan conexiones
          _broadcastPresence(userId, false);
          console.log(`[WS] Usuario desconectado: ${userId}`);
        }
      }
    }
    try { ws.terminate(); } catch {}
  }

  function _broadcastPresence(userId, isOnline) {
    // TODO: obtener contactos del usuario desde Supabase y notificarles
    // Por ahora se hace broadcast a todos los conectados (simplificado)
    for (const [uid] of userSockets) {
      if (uid !== userId) {
        broadcastToUser(uid, isOnline ? 'user_online' : 'user_offline', { userId });
      }
    }
  }

  // ── API pública del módulo ────────────────────────────────────
  return {
    wss,

    /** Notificar nuevo mensaje a todos los participantes del chat */
    notifyNewMessage(chatId, message, senderId) {
      broadcastToChatParticipants(chatId, 'new_message', { chatId, message }, null);
      // También al propio sender (para sync entre dispositivos)
      broadcastToUser(senderId, 'message_sent', { chatId, message });
    },

    /** Notificar cambio de estado de un mensaje */
    notifyMessageStatus(chatId, messageId, status, toUserId) {
      broadcastToUser(toUserId, 'message_status', { chatId, messageId, status });
    },

    /** Notificar que el chat fue actualizado (nuevo último mensaje) */
    notifyChatUpdated(userId, chatData) {
      broadcastToUser(userId, 'chat_updated', { chat: chatData });
    },

    /** Notificar cambio de balance del wallet */
    notifyWalletUpdated(userId, balance) {
      broadcastToUser(userId, 'wallet_updated', { balance });
    },

    /** Obtener número de conexiones activas */
    getStats() {
      return {
        connectedUsers:   userSockets.size,
        totalConnections: clientMeta.size,
      };
    },
  };
}

module.exports = { initWebSocket };
