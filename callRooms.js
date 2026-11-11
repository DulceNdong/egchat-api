// Salas de llamada grupal (mesh WebRTC, hasta 9 personas).
//
// La app ya trae la pantalla y el hook (`useSFUGroupCall`): pide /join, intercambia
// offer/answer/ICE por REST y sondea /signals cada 800 ms. Faltaba el servidor.
// El estado vive en memoria: una llamada en curso no sobrevive a un reinicio de
// Render, y eso esta bien; lo que no puede quedarse es la sala llena de fantasmas,
// de ahi el TTL por participante (el sondeo lo refresca).
'use strict';

const MAX_PARTICIPANTES = 9;
const TTL_MS = 90_000;

function crearSalasDeLlamada({ ttlMs = TTL_MS, maxParticipantes = MAX_PARTICIPANTES, ahora = Date.now } = {}) {
  const salas = new Map();

  const limpiar = () => {
    for (const [id, sala] of salas) {
      for (const [uid, p] of sala.participantes) {
        if (ahora() - p.lastSeen > ttlMs) sala.participantes.delete(uid);
      }
      if (sala.participantes.size === 0) salas.delete(id);
    }
  };

  const obtener = (roomId, crear) => {
    let sala = salas.get(roomId);
    if (!sala && crear) {
      sala = { participantes: new Map(), senales: new Map() };
      salas.set(roomId, sala);
    }
    return sala || null;
  };

  const buzon = (sala, uid) => {
    let b = sala.senales.get(uid);
    if (!b) {
      b = { offers: [], answers: [], ice: [] };
      sala.senales.set(uid, b);
    }
    return b;
  };

  return {
    unirse(roomId, userId, datos = {}) {
      limpiar();
      const sala = obtener(roomId, true);
      if (sala.participantes.size >= maxParticipantes && !sala.participantes.has(userId)) {
        return { ok: false, error: 'SALA_LLENA' };
      }
      const previos = [...sala.participantes.values()]
        .filter(p => p.userId !== userId)
        .map(({ userId: id, name, avatar }) => ({ userId: id, name, avatar }));
      sala.participantes.set(userId, {
        userId,
        name: String(datos.name || '').slice(0, 80),
        avatar: String(datos.avatar || '').slice(0, 500),
        callType: datos.callType === 'video' ? 'video' : 'audio',
        // El cliente compara el roomId del SSE con el suyo, y el suyo lleva la
        // marca de tiempo del arranque. Se guarda el crudo de cada uno para
        // poder devolverle un evento que reconozca.
        roomIdCrudo: String(datos.roomIdCrudo || roomId).slice(0, 120),
        lastSeen: ahora(),
      });
      return { ok: true, participants: previos };
    },

    tocar(roomId, userId) {
      const sala = obtener(roomId);
      const p = sala && sala.participantes.get(userId);
      if (p) p.lastSeen = ahora();
    },

    salir(roomId, userId) {
      limpiar();
      const sala = obtener(roomId);
      if (!sala) return { ok: false, otros: [] };
      const estaba = sala.participantes.delete(userId);
      sala.senales.delete(userId);
      const otros = [...sala.participantes.keys()];
      if (sala.participantes.size === 0) salas.delete(roomId);
      return { ok: estaba, otros };
    },

    senal(roomId, fromUserId, tipo, toUserId, payload = {}) {
      limpiar();
      const sala = obtener(roomId);
      if (!sala) return false;
      if (!sala.participantes.has(fromUserId) || !sala.participantes.has(toUserId)) return false;
      const b = buzon(sala, toUserId);
      if (tipo === 'offer' && payload.sdp) b.offers.push({ from: fromUserId, sdp: payload.sdp });
      else if (tipo === 'answer' && payload.sdp) b.answers.push({ from: fromUserId, sdp: payload.sdp });
      else if (tipo === 'ice' && payload.candidate) b.ice.push({ from: fromUserId, candidate: payload.candidate });
      else return false;
      return true;
    },

    // Se entrega una vez: el cliente sondea cada 800 ms y espera la bandeja vacia
    // despues de leerla, no la misma offer repetida en cada vuelta.
    pendientes(roomId, userId) {
      limpiar();
      const sala = obtener(roomId);
      const b = sala && sala.senales.get(userId);
      if (!b) return { offers: [], answers: [], iceCandidates: [] };
      sala.senales.delete(userId);
      const agrupado = new Map();
      for (const c of b.ice) {
        if (!agrupado.has(c.from)) agrupado.set(c.from, []);
        agrupado.get(c.from).push(c.candidate);
      }
      return {
        offers: b.offers,
        answers: b.answers,
        iceCandidates: [...agrupado].map(([from, candidates]) => ({ from, candidates })),
      };
    },

    tamano(roomId) {
      limpiar();
      const sala = obtener(roomId);
      return sala ? sala.participantes.size : 0;
    },

    // Para avisar por SSE con el roomId que cada cliente reconoce como suyo.
    miembros(roomId) {
      limpiar();
      const sala = obtener(roomId);
      if (!sala) return [];
      return [...sala.participantes.values()].map(({ userId, roomIdCrudo }) => ({ userId, roomIdCrudo }));
    },

    // Barrido periódico: una sala en la que ya nadie habla tampoco se toca,
    // asi que sus fantasmas solo caen si alguien pasa por delante.
    barrer() {
      limpiar();
    },
  };
}

module.exports = { crearSalasDeLlamada, MAX_PARTICIPANTES, TTL_MS };
