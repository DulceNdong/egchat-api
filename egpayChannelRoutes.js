'use strict';

// Rutas de los canales sin smartphone.
//
// Tres grupos con naturalezas distintas:
//   gateway — lo que llama la pasarela (USSD/SMS/IVR). No hay sesión de
//             usuario: se autoriza por la firma de la operadora.
//   user    — el móvil del cliente consulta su histórico de canal.
//   admin   — ver qué pasarelas hay, cerrar sesiones colgadas y el detalle.
//
// Ninguna de ellas abre un monedero paralelo: todo pasa por el mismo núcleo.

module.exports = function egpayChannelRoutes(deps) {
  const {
    express,
    supabase,
    requireAdmin,
    auth,
    channels,
    channelInfo,
    rateKey = null,
    log = console,
  } = deps;

  const gateway = express.Router();
  const user = express.Router();
  const admin = express.Router();

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      log.error('[EGPAY-CANAL]', e.message);
      // En un canal no hay pantalla donde explicar un 500: se devuelve texto
      // neutro para que la pasarela lo locute sin prometer nada.
      res.status(500).json({ prompt: channels.TEXT.failed[channels.LOCALES.includes(req.channelLocale) ? req.channelLocale : 'es'] });
    }
  };

  // El tecleo viaja en el cuerpo. Limitar el tamaño es suficiente para un
  // puerto que sólo debería recibir unos pocos dígitos.
  const MAX_INPUT = 24;

  gateway.post('/:provider/session', wrap(async (req, res) => {
    const providerId = String(req.params.provider || '');
    const provider = channelInfo.get(providerId);
    if (!provider) {
      return res.status(404).json({ message: 'Pasarela desconocida', code: 'CHANNEL_NOT_CONFIGURED' });
    }

    const verified = await provider.verify(req, provider);
    if (!verified || !verified.ok) {
      try {
        // Se registra el intento fallido: una pasarela que firma mal repetidas
        // veces es un incidente, no un detalle.
        await supabase.from(channels.EVENTS).insert({
          session_key: `gateway:${providerId}`,
          channel: providerId,
          msisdn_ref: '****',
          kind: 'auth',
          outcome: (verified && verified.code) || 'rejected',
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        log.error('[CANAL] no se pudo registrar el intento sin firma:', e.message);
      }
      log.error('[CANAL] petición no autorizada de', providerId, (verified && verified.code) || '');
      return res.status(401).json({ message: 'Petición no autorizada', code: (verified && verified.code) || 'UNAUTHORIZED' });
    }

    const extracted = provider.extract(req.body || {});
    const msisdn = String(extracted.msisdn || '').replace(/\D/g, '');
    if (msisdn.length < 6) {
      return res.status(400).json({ message: 'Número no válido', code: 'MSISDN_INVALID' });
    }
    if (rateKey && rateKey.isBlocked && await rateKey.isBlocked(`channel:${msisdn}`)) {
      return res.status(429).json({ message: 'Demasiadas solicitudes', code: 'RATE_LIMITED' });
    }

    const out = await channels.handle({
      msisdn,
      channel: extracted.channel || providerId,
      input: String(extracted.input == null ? '' : extracted.input).slice(0, MAX_INPUT),
      locale: extracted.locale,
      sessionId: extracted.sessionId,
    });
    req.channelLocale = out.locale;
    return res.json(provider.shape ? provider.shape(out) : out);
  }));

  user.get('/canales', auth, wrap(async (req, res) => {
    const { data } = await supabase.from(channels.SESSIONS).select('channel, state, locale, created_at, expires_at')
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(10);
    res.json({
      sesiones: data || [],
      disponibles: channelInfo.list(),
      idiomas: channels.LOCALES,
    });
  }));

  admin.get('/channels', requireAdmin, wrap(async (_req, res) => {
    res.json({
      // `disponible:false` es el estado hoy: no hay operadora firmada. La app
      // lo lee antes de ofrecer un menú USSD que no podría contestar.
      disponible: channelInfo.has_real_channel === true,
      pasarelas: channelInfo.list(),
      avisos: channelInfo.warnings || [],
      limites: channels.limits,
      texto_en: Object.keys(channels.TEXT).length,
      idiomas: channels.LOCALES,
    });
  }));

  admin.get('/channels/active', requireAdmin, wrap(async (_req, res) => {
    const { data } = await supabase.from(channels.SESSIONS).select('session_key, channel, state, locale, expires_at')
      .neq('state', 'menu').order('expires_at');
    res.json({
      total: (data || []).length,
      sesiones: (data || []).slice(0, 100),
      nota: 'Una sesión a medias no mueve dinero: el pago sólo se ejecuta tras confirmar con 1.',
    });
  }));

  admin.post('/channels/close-stale', requireAdmin, wrap(async (_req, res) => {
    res.json(await channels.closeStale());
  }));

  return { gateway, user, admin };
};
