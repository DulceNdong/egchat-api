'use strict';

// Costura con las pasarelas de canal: agregadores USSD, SMS y IVR.
//
// Mismo criterio que con los bancos (egpay-providers.js): mientras no haya un
// contrato firmado con una operadora, aquí no hay adaptadores, sólo el hueco.
// La diferencia es que el canal también necesita devolver el texto en el
// formato exacto que espera la pasarela, así que cada adaptador define tres
// cosas: cómo leer la petición, cómo verificar que es suya y cómo responder.
//
// `sandbox` existe para poder probar el flujo de extremo a extremo sin
// operadora. Sólo se registra con EGPAY_CHANNEL_SANDBOX=true: no depende de
// WALLET_MODE, porque el monedero de la app sigue en sandbox y la pasarela de
// pruebas no debe quedar abierta en producción.

const crypto = require('node:crypto');

const signHmac = (secret, material) =>
  crypto.createHmac('sha256', String(secret)).update(String(material)).digest('hex');

// extract: saca número, tecleo e idioma del cuerpo de la pasarela.
// verify: comprueba la firma de la pasarela antes de tocar el monedero.
// shape: cómo hay que devolver el prompt (muchas USSD esperan un campo
// concreto y un código de sesión propio).
const ADAPTER_DEFS = {
  // Ejemplo del contrato que hará falta el día que una operadora acepte:
  //
  // orange: {
  //   name: 'Orange Money USSD',
  //   extract: (body) => ({
  //     msisdn: body.msisdn, input: body.data || body.svcCode,
  //     sessionId: body.sessionId, locale: body.language,
  //   }),
  //   verify: (req, { apiSecret }) => {
  //     const material = `${req.method}\n${req.originalUrl}\n${JSON.stringify(req.body)}\n${req.headers['x-timestamp']}`;
  //     return signHmac(apiSecret, material) === req.headers['x-signature']
  //       ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
  //   },
  //   shape: (out) => ({ response: out.prompt, sessionId: out.session_key,
  //                       continueSession: !out.end_session }),
  //   deliver: null, // SMS/IVR añadirían aquí el envío fuera de banda
  // },
};

function sandboxAdapter() {
  return {
    id: 'sandbox',
    name: 'Pasarela de pruebas',
    live: false,
    extract: (body) => ({
      msisdn: body.msisdn || body.caller || body.phone,
      input: body.input == null ? (body.data || '') : body.input,
      sessionId: body.session_id || body.sessionId,
      locale: body.locale || body.language,
    }),
    verify: async () => ({ ok: true }),
    shape: (out) => out,
    deliver: null,
  };
}

function buildChannelRegistry({ env = process.env, log = console } = {}) {
  const registry = new Map();
  const warnings = [];

  // Solo con el opt-in explicito. Depende de WALLET_MODE no bastaba: el
  // monedero de la app sigue en sandbox, y eso dejaria abierta en produccion
  // una pasarela sin firma con la que se puede llamar al menu de cualquier
  // numero registrado.
  const sandboxOn = String(env.EGPAY_CHANNEL_SANDBOX || '') === 'true';
  if (sandboxOn) {
    registry.set('sandbox', sandboxAdapter());
    log.log('[CANAL] pasarela de pruebas activa (EGPAY_CHANNEL_SANDBOX=true)');
  }

  for (const id of String(env.EGPAY_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const def = ADAPTER_DEFS[id];
    if (!def) {
      warnings.push(`${id}: no hay adaptador escrito (falta en egpay-channel-providers.js)`);
      continue;
    }
    const envName = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const apiSecret = env[`CHANNEL_${envName}_SECRET`];
    if (!apiSecret) {
      warnings.push(`${id}: sin CHANNEL_${envName}_SECRET no se admiten peticiones de la pasarela`);
      continue;
    }
    registry.set(id, {
      ...def,
      id,
      live: true,
      apiSecret,
      baseUrl: env[`CHANNEL_${envName}_BASE_URL`] || null,
    });
    log.log(`[CANAL] registrado ${id} live=true`);
  }

  const real = Array.from(registry.values()).filter((p) => p.live);
  return {
    registry,
    get: (id) => registry.get(String(id)) || null,
    list: () => Array.from(registry.values()).map((p) => ({ id: p.id, name: p.name, live: p.live })),
    warnings,
    // Sin operadora firmada la plataforma no puede prometer menús USSD reales.
    has_real_channel: real.length > 0,
    channels: real.map((p) => p.id),
  };
}

module.exports = { buildChannelRegistry, ADAPTER_DEFS, signHmac };
