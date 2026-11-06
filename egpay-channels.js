'use strict';

// Canales sin smartphone: USSD, SMS y IVR sobre el mismo monedero.
//
// Este módulo no conoce ningún saldo: pide dinero prestado al mismo camino que
// usa la app (`money.sendP2P`), que termina en ledger_post_kind(). Un pago
// marcado en un teléfono básico queda asentado en el mismo libro mayor, con la
// misma plantilla de asiento y la misma cuenta puente que un pago desde el
// móvil. No hay segundo monedero ni contabilidad aparte.
//
// Reglas que se aplican aquí:
//  - El PIN se verifica una sola vez, dentro del recorrido, y no se guarda: la
//    sesión sólo recuerda que se superó (`pin_verified`). Por un canal tan poco
//    cifrado como USSD no puede quedar nada recuperable.
//  - El número se registra ofuscado (`msisdn_ref`): la huata permite cruzar las
//    sesiones de un mismo teléfono sin conservar el número en claro.
//  - Nada de esto condiciona las comunicaciones: si el monedero falla, los
//    mensajes y las llamadas siguen funcionando igual.
//  - Todos los textos existen en es/fr/en/pt y el menú se numera igual en todos
//    los idiomas: un teléfono básico no tiene pantalla donde desplegar.

const crypto = require('node:crypto');

const LOCALES = ['es', 'fr', 'en', 'pt'];
const DEFAULT_LOCALE = 'es';
const CURRENCY = 'XAF';

// Texto corto: las pantallas de estos teléfonos muestran ~26 caracteres por
// línea y muchas pasarelas cortan el mensaje.
const TEXT = {
  welcome: {
    es: 'EGPay 1 Saldo 2 Pagar 3 Movim. 4 Recargar 9 Idioma 0 Salir',
    fr: 'EGPay 1 Solde 2 Payer 3 Mvt 4 Recharger 9 Langue 0 Quitter',
    en: 'EGPay 1 Balance 2 Pay 3 Activity 4 Top-up 9 Lang 0 Exit',
    pt: 'EGPay 1 Saldo 2 Pagar 3 Movim. 4 Recarga 9 Idioma 0 Sair',
  },
  language: {
    es: 'Idioma 1 ES 2 FR 3 EN 4 PT',
    fr: 'Langue 1 ES 2 FR 3 EN 4 PT',
    en: 'Language 1 ES 2 FR 3 EN 4 PT',
    pt: 'Idioma 1 ES 2 FR 3 EN 4 PT',
  },
  amount: {
    es: 'Importe {cur}. 0 cancelar',
    fr: 'Montant {cur}. 0 annuler',
    en: 'Amount {cur}. 0 cancel',
    pt: 'Valor {cur}. 0 cancelar',
  },
  payee: {
    es: 'Teléfono a pagar. 0 cancelar',
    fr: 'Téléphone à payer. 0 annuler',
    en: 'Phone to pay. 0 cancel',
    pt: 'Telefone a pagar. 0 cancelar',
  },
  pin: {
    es: 'PIN de 4 dígitos',
    fr: 'Code PIN à 4 chiffres',
    en: '4-digit PIN',
    pt: 'PIN de 4 dígitos',
  },
  confirm: {
    es: 'Pagar {amount} {cur} a {name}? 1 sí 0 no',
    fr: 'Payer {amount} {cur} à {name}? 1 oui 0 non',
    en: 'Pay {amount} {cur} to {name}? 1 yes 0 no',
    pt: 'Pagar {amount} {cur} a {name}? 1 sim 0 não',
  },
  // El saldo que devuelve el libro ya tiene fuera lo retenido en pendientes,
  // así que aquí no existe un "libre" aparte que possa confundir.
  balance: {
    es: 'Saldo {amount} {cur}',
    fr: 'Solde {amount} {cur}',
    en: 'Balance {amount} {cur}',
    pt: 'Saldo {amount} {cur}',
  },
  paid: {
    es: 'Pagado {amount} {cur} a {name}',
    fr: 'Payé {amount} {cur} à {name}',
    en: 'Paid {amount} {cur} to {name}',
    pt: 'Pago {amount} {cur} a {name}',
  },
  activity: {
    es: 'Últimos: {list}',
    fr: 'Derniers: {list}',
    en: 'Recent: {list}',
    pt: 'Últimos: {list}',
  },
  no_activity: {
    es: 'Sin movimientos',
    fr: 'Aucun mouvement',
    en: 'No activity',
    pt: 'Sem movimentos',
  },
  topup_ok: {
    es: 'Recarga {amount} {cur}',
    fr: 'Recharge {amount} {cur}',
    en: 'Top-up {amount} {cur}',
    pt: 'Recarga {amount} {cur}',
  },
  code: {
    es: 'Código de recarga. 0 cancelar',
    fr: 'Code de recharge. 0 annuler',
    en: 'Top-up code. 0 cancel',
    pt: 'Código de recarga. 0 cancelar',
  },
  bad_input: {
    es: 'Opción no válida',
    fr: 'Option non valide',
    en: 'Invalid option',
    pt: 'Opção inválida',
  },
  not_found: {
    es: 'Destinatario no encontrado',
    fr: 'Destinataire introuvable',
    en: 'Recipient not found',
    pt: 'Destinatário não encontrado',
  },
  wrong_pin: {
    es: 'PIN incorrecto',
    fr: 'PIN incorrect',
    en: 'Wrong PIN',
    pt: 'PIN incorreto',
  },
  denied: {
    es: 'No permitido: {reason}',
    fr: 'Non autorisé: {reason}',
    en: 'Not allowed: {reason}',
    pt: 'Não permitido: {reason}',
  },
  failed: {
    es: 'No se pudo completar. Saldo intacto',
    fr: 'Échec. Solde intact',
    en: 'Failed. Balance unchanged',
    pt: 'Falhou. Saldo intacto',
  },
  expired: {
    es: 'Sesión expirada. Marque de nuevo',
    fr: 'Session expirée. Recomposez',
    en: 'Session expired. Dial again',
    pt: 'Sessão expirada. Marque de novo',
  },
  bye: {
    es: 'Hasta luego',
    fr: 'À bientôt',
    en: 'Goodbye',
    pt: 'Até logo',
  },
};

const pick = (key, locale) => TEXT[key][LOCALES.includes(locale) ? locale : DEFAULT_LOCALE];
const fill = (tpl, vars) =>
  String(tpl).replace(/\{(\w+)\}/g, (_m, k) => (vars[k] == null ? '' : String(vars[k])));

const group = (value) => {
  const n = Math.round(Number(value || 0));
  return Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '0';
};

const maskMsisdn = (msisdn) => {
  const digits = String(msisdn || '').replace(/\D/g, '');
  if (digits.length < 4) return '****';
  const hash = crypto.createHash('sha256').update(`${digits}|egpay-channel`).digest('hex').slice(0, 12);
  return `${hash}|${digits.slice(-4)}`;
};

const parseAmount = (raw) => {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

module.exports = function makeChannels(deps) {
  const {
    supabase,
    money,
    resolveUser,
    verifyPin,
    applyRechargeCode = null,
    sessionTtlMinutes = Number(deps.sessionTtlMinutes || 10),
    maxPinAttempts = Number(deps.maxPinAttempts || 3),
    maxPerPayment = Number(deps.limits?.maxPerPayment || 250000),
    maxDaily = Number(deps.limits?.maxDaily || 500000),
    log = console,
    now = () => Date.now(),
  } = deps;

  const SESSIONS = 'channel_sessions';
  const EVENTS = 'channel_events';

  const sessionKeyOf = ({ channel, phone, sessionId }) =>
    String(sessionId || `${String(channel || 'ussd').toLowerCase()}:${phone}`);

  const blank = (key, channel, phone, locale) => ({
    session_key: key,
    channel: String(channel || 'ussd').toLowerCase(),
    msisdn_ref: maskMsisdn(phone),
    locale: LOCALES.includes(locale) ? locale : DEFAULT_LOCALE,
    state: 'menu',
    draft: {},
    pin_verified: false,
    attempts: 0,
    user_id: null,
    created_at: new Date(now()).toISOString(),
    expires_at: new Date(now() + sessionTtlMinutes * 60000).toISOString(),
  });

  // Cada paso devuelve el estado nuevo de la sesión junto al texto. Así es
  // imposible que la respuesta y lo que se guarda diverjan.
  const step = (session, prompt, extra = {}) => ({ session, prompt, ...extra });

  const menuOf = (session) => step(session, pick('welcome', session.locale));

  const load = async (key) => {
    const { data } = await supabase.from(SESSIONS).select('*').eq('session_key', key).maybeSingle();
    if (!data) return { session: null };
    if (new Date(data.expires_at).getTime() < now()) return { session: null, expired: true, row: data };
    return { session: data };
  };

  const save = async (session) => {
    const payload = {
      session_key: session.session_key,
      channel: session.channel,
      msisdn_ref: session.msisdn_ref,
      locale: session.locale,
      state: session.state,
      draft: session.draft || {},
      pin_verified: Boolean(session.pin_verified),
      attempts: session.attempts || 0,
      user_id: session.user_id || null,
      expires_at: new Date(now() + sessionTtlMinutes * 60000).toISOString(),
      updated_at: new Date(now()).toISOString(),
    };
    const { error } = await supabase.from(SESSIONS).upsert(payload, { onConflict: 'session_key' });
    if (error) log.error('[CHANNEL] sesión no guardada:', error.message);
    return payload;
  };

  const toMenu = (session) => ({ ...session, state: 'menu', draft: {}, pin_verified: false, attempts: 0 });

  const trace = async (session, kind, outcome, details = {}) => {
    try {
      await supabase.from(EVENTS).insert({
        session_key: session.session_key,
        channel: session.channel,
        msisdn_ref: session.msisdn_ref,
        kind,
        outcome,
        amount: details.amount ?? null,
        reference: details.reference ?? null,
        created_at: new Date(now()).toISOString(),
      });
    } catch (e) {
      log.error('[CHANNEL] traza no escrita:', e.message);
    }
  };

  const spentToday = async (userId) => {
    const since = new Date(new Date(now()).setHours(0, 0, 0, 0)).toISOString();
    const { data } = await supabase.from('transactions').select('amount')
      .eq('user_id', userId).eq('type', 'transfer_sent').gte('created_at', since);
    return Math.round((data || []).reduce((s, t) => s + Number(t.amount || 0), 0));
  };

  // ── Pasos ──────────────────────────────────────────────────────────
  const askPayee = (session) =>
    step({ ...session, state: 'payee' }, pick('payee', session.locale));

  const askAmount = (session, payee) =>
    step({ ...session, state: 'pay_amount', draft: { ...session.draft, payee } },
      fill(pick('amount', session.locale), { cur: CURRENCY }));

  const askPin = (session, amount) =>
    step({ ...session, state: 'pay_pin', draft: { ...session.draft, amount } }, pick('pin', session.locale));

  const askConfirm = (session) => step(
    { ...session, state: 'pay_confirm', pin_verified: true, attempts: 0 },
    fill(pick('confirm', session.locale), {
      amount: group(session.draft.amount),
      cur: CURRENCY,
      name: session.draft.payee?.name || session.draft.payee?.id,
    }),
  );

  const executePayment = async (session, user) => {
    const locale = session.locale;
    const amount = Number(session.draft.amount || 0);
    const payeeId = String(session.draft.payee?.id || '');
    if (!amount || !payeeId) return step(toMenu(session), pick('bad_input', locale));

    const daily = await spentToday(user.id);
    if (daily + amount > maxDaily) {
      await trace(session, 'pay', 'daily_limit', { amount });
      return step(toMenu(session), fill(pick('denied', locale), { reason: `diario ${group(maxDaily)}` }));
    }

    // La clave idempotente depende del destinatario y del importe, no de un
    // azar: si la pasarela repite la petición porque se cortó la cobertura, el
    // segundo intento reusa la misma clave y el libro devuelve el asiento ya
    // hecho en vez de cobrar dos veces.
    const channel = String(session.channel).toUpperCase();
    const idem = `${channel}:${session.session_key}:${crypto.createHash('sha1').update(`${payeeId}:${amount}`).digest('hex').slice(0, 12)}`;
    const payeeLabel = session.draft.payee?.name || session.draft.payee?.phone || payeeId;

    const out = await money.sendP2P(user.id, payeeId, amount, {
      key: idem,
      concept: `Pago a ${payeeLabel} por ${channel}`,
      reference: `${channel}:${session.session_key}`,
      provider: session.channel,
    });
    if (!out.ok) {
      await trace(session, 'pay', `failed_${out.code}`, { amount });
      if (out.code === 'INSUFFICIENT_BALANCE') {
        return step(toMenu(session), fill(pick('denied', locale), { reason: `saldo ${group(out.balance || 0)}` }));
      }
      return step(toMenu(session), pick('failed', locale));
    }

    // Un reintento de la pasarela sobre la misma clave ya no escribe histórico:
    // el asiento existe y el dinero se movió una sola vez.
    if (!out.already_posted) {
      // El histórico usa las mismas columnas y el mismo `A:` / `DE:` que escribe
      // la app. Añadir campos que la tabla no tiene hace que el lote entero
      // falle y el dinero se mueva sin dejar rastro.
      const payerLabel = user.phone || user.id;
      await supabase.from('transactions').insert([
        { user_id: user.id, type: 'transfer_sent', amount, method: channel, reference: `A: ${payeeLabel} · ${channel}`, status: 'completed' },
        { user_id: payeeId, type: 'transfer_received', amount, method: channel, reference: `DE: ${payerLabel} · ${channel}`, status: 'completed' },
      ]);
    }

    await trace(session, 'pay', 'ok', { amount, reference: idem });
    return step(toMenu(session), fill(pick('paid', locale), {
      amount: group(amount), cur: CURRENCY, name: payeeLabel,
    }));
  };

  const payFlow = async (session, user, input) => {
    if (session.state === 'payee') {
      const phone = String(input).replace(/[^\d+]/g, '');
      if (phone.length < 6) return step(session, pick('bad_input', session.locale));
      const payee = await resolveUser(phone);
      if (!payee) {
        await trace(session, 'pay', 'payee_not_found');
        return step({ ...session, state: 'menu' }, pick('not_found', session.locale));
      }
      if (String(payee.id) === String(user.id)) return step(session, pick('bad_input', session.locale));
      return askAmount(session, { id: String(payee.id), name: payee.full_name || payee.phone });
    }

    if (session.state === 'pay_amount') {
      const amount = parseAmount(input);
      if (!amount) return step(session, pick('bad_input', session.locale));
      if (amount > maxPerPayment) {
        await trace(session, 'pay', 'limit', { amount });
        return step(toMenu(session), fill(pick('denied', session.locale), { reason: `máx ${group(maxPerPayment)}` }));
      }
      return askPin(session, amount);
    }

    if (session.state === 'pay_pin') {
      const pin = String(input).replace(/\D/g, '');
      if (pin.length < 4) return step(session, pick('bad_input', session.locale));
      const checked = await verifyPin(user.id, pin);
      if (!checked || !checked.ok) {
        const attempts = (session.attempts || 0) + 1;
        if (attempts >= maxPinAttempts) {
          await trace(session, 'pay', 'pin_blocked');
          // Se vuelve al principio: a la cuarta no se confirma nada, se rehace
          // el pago desde el destinatario.
          return step(toMenu(session), fill(pick('denied', session.locale), { reason: 'PIN' }));
        }
        return step({ ...session, attempts, pin_verified: false }, pick('wrong_pin', session.locale));
      }
      return askConfirm(session);
    }

    if (session.state === 'pay_confirm') {
      if (String(input).trim() !== '1') {
        await trace(session, 'pay', 'cancelled', { amount: session.draft.amount });
        return menuOf(toMenu(session));
      }
      if (!session.pin_verified) return step(toMenu(session), pick('failed', session.locale));
      return executePayment(session, user);
    }

    return step(session, pick('bad_input', session.locale));
  };

  const topupFlow = async (session, user, input) => {
    const locale = session.locale;
    if (!applyRechargeCode) {
      await trace(session, 'topup', 'unavailable');
      return step(toMenu(session), fill(pick('denied', locale), { reason: 'recarga' }));
    }
    if (session.state !== 'topup_code') {
      return step({ ...session, state: 'topup_code' }, pick('code', locale));
    }
    const code = String(input).trim();
    if (!code) return step(session, pick('bad_input', locale));
    const out = await applyRechargeCode({ userId: user.id, code, channel: session.channel });
    if (!out || !out.ok) {
      await trace(session, 'topup', `failed_${(out && out.code) || 'x'}`);
      return step(toMenu(session), pick('failed', locale));
    }
    await trace(session, 'topup', 'ok', { amount: out.amount });
    return step(toMenu(session), fill(pick('topup_ok', locale), { amount: group(out.amount), cur: CURRENCY }));
  };

  const balanceStep = async (session, user) => {
    const balance = await money.balanceOf(user.id);
    await trace(session, 'balance', 'ok');
    return step(toMenu(session), fill(pick('balance', session.locale), {
      amount: group(balance), cur: CURRENCY,
    }));
  };

  const activityStep = async (session, user) => {
    const { data } = await supabase.from('transactions').select('type,amount')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(3);
    const rows = data || [];
    await trace(session, 'activity', 'ok');
    return step(toMenu(session), rows.length
      ? fill(pick('activity', session.locale), { list: rows.map((t) => `${String(t.type).slice(0, 4)} ${group(t.amount)}`).join(', ') })
      : pick('no_activity', session.locale));
  };

  const routeChoice = (input) => {
    const choice = String(input || '').replace(/[^0-9#]/g, '');
    if (choice === '1') return 'balance';
    if (choice === '2') return 'pay';
    if (choice === '3') return 'activity';
    if (choice === '4') return 'topup';
    if (choice === '9') return 'language';
    if (choice === '0') return 'exit';
    return 'invalid';
  };

  const applyLanguage = (session, input) => {
    const map = { 1: 'es', 2: 'fr', 3: 'en', 4: 'pt' };
    const locale = map[String(input)] || session.locale;
    return menuOf({ ...session, locale, state: 'menu' });
  };

  // Punto de entrada único: la pasarela manda el número y lo tecleado; aquí se
  // decide el estado y el texto que hay que mostrar o locutar.
  const handle = async ({ msisdn, channel = 'ussd', input = '', locale, sessionId } = {}) => {
    const phone = String(msisdn || '').replace(/\D/g, '');
    const fallbackLocale = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
    if (phone.length < 6) {
      return { ok: false, code: 'MSISDN_INVALID', prompt: pick('bad_input', fallbackLocale) };
    }

    const key = sessionKeyOf({ channel, phone, sessionId });
    const existing = await load(key);

    if (existing.expired) {
      // Un borrador viejo no puede ejecutarse sobre un saldo que ya cambió.
      const fresh = toMenu(blank(key, channel, phone, existing.row.locale));
      await save(fresh);
      return { ok: true, session_key: key, locale: fresh.locale, state: fresh.state, prompt: pick('expired', fresh.locale) };
    }

    if (!existing.session) {
      const fresh = blank(key, channel, phone, fallbackLocale);
      await save(fresh);
      return { ok: true, session_key: key, locale: fresh.locale, state: fresh.state, prompt: pick('welcome', fresh.locale) };
    }

    const session = { ...blank(key, channel, phone, existing.session.locale), ...existing.session };
    const choice = String(input).trim();

    // "0" en cualquier paso vuelve al menú; en el menú cierra la sesión.
    if (choice === '0') {
      const back = toMenu(session);
      // Un "0" a mitad de un pago se registra como abandono: el histórico del
      // canal tiene que poder distinguir "cancelé yo" de "nunca marqué nada".
      if (session.state.startsWith('pay_') && session.draft?.amount) {
        await trace(session, 'pay', 'cancelled', { amount: session.draft.amount });
      }
      await save(back);
      if (session.state === 'menu') {
        await trace(session, 'exit', 'ok');
        return { ok: true, session_key: key, locale: back.locale, state: 'closed', prompt: pick('bye', back.locale), end_session: true };
      }
      return { ok: true, session_key: key, locale: back.locale, state: back.state, prompt: pick('welcome', back.locale) };
    }

    let out;
    if (session.state === 'language') {
      out = applyLanguage(session, choice);
    } else if (session.state === 'menu') {
      const action = routeChoice(choice);
      if (action === 'invalid') {
        await save(session);
        // Se vuelve a ofrecer el menú: en estos teléfonos la ayuda no puede
        // estar en otra pantalla, se muestra junto al aviso.
        return {
          ok: true,
          session_key: key,
          locale: session.locale,
          state: session.state,
          prompt: `${pick('bad_input', session.locale)}\n${pick('welcome', session.locale)}`,
        };
      }
      if (action === 'language') {
        const next = { ...session, state: 'language' };
        await save(next);
        return { ok: true, session_key: key, locale: next.locale, state: next.state, prompt: pick('language', next.locale) };
      }
      const user = await resolveUser(phone);
      if (!user) {
        await trace(session, 'unknown_msisdn', 'rejected');
        await save(toMenu(session));
        return { ok: true, session_key: key, locale: session.locale, state: 'menu',
          prompt: fill(pick('denied', session.locale), { reason: 'EGPay' }) };
      }
      if (action === 'balance') out = await balanceStep({ ...session, user_id: user.id }, user);
      else if (action === 'activity') out = await activityStep({ ...session, user_id: user.id }, user);
      else if (action === 'topup') out = await topupFlow({ ...session, user_id: user.id }, user, '');
      else out = askPayee({ ...session, user_id: user.id });
    } else {
      const user = await resolveUser(phone);
      if (!user) {
        await save(toMenu(session));
        return { ok: true, session_key: key, locale: session.locale, state: 'menu',
          prompt: fill(pick('denied', session.locale), { reason: 'EGPay' }) };
      }
      out = session.state === 'topup_code'
        ? await topupFlow({ ...session, user_id: user.id }, user, choice)
        : await payFlow({ ...session, user_id: user.id }, user, choice);
    }

    await save(out.session);
    return {
      ok: true,
      session_key: key,
      locale: out.session.locale,
      state: out.session.state,
      prompt: out.prompt,
    };
  };

  // Sesiones abandonadas a mitad de un paso: se devuelven al menú. No toca
  // dinero ninguno — el pago sólo se ejecuta tras confirmar con 1 — pero una
  // sesión colgada impediría empezar un pago nuevo.
  const closeStale = async (limit = 200) => {
    const cutoff = new Date(now()).toISOString();
    const { data } = await supabase.from(SESSIONS).select('session_key, state, channel, msisdn_ref')
      .lt('expires_at', cutoff).neq('state', 'menu').limit(limit);
    const rows = data || [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from(SESSIONS)
        .update({ state: 'menu', draft: {}, pin_verified: false, attempts: 0, closed_at: cutoff })
        .eq('session_key', row.session_key).neq('state', 'menu');
      // eslint-disable-next-line no-await-in-loop
      await trace(row, 'session', 'closed_stale');
    }
    return { closed: rows.length };
  };

  return {
    LOCALES,
    CURRENCY,
    SESSIONS,
    EVENTS,
    TEXT,
    handle,
    closeStale,
    maskMsisdn,
    parseAmount,
    limits: { maxPerPayment, maxDaily, sessionTtlMinutes, maxPinAttempts },
  };
};

module.exports.TEXT = TEXT;
module.exports.LOCALES = LOCALES;
module.exports.maskMsisdn = maskMsisdn;
module.exports.parseAmount = parseAmount;
