-- EGPay - Lote D (v2): dar de alta en el libro el dinero que ya existia.
--
-- Por que v2: el primer intento en el editor SQL de produccion fallo con
--   ERROR 42P01: relation "_lote_d_antes" does not exist
-- El editor parte el guion por su cuenta y la tabla temporal del snapshot vivo
-- solo en su transaccion, mientras el DO de la guarda llegaba en otra. Aqui no
-- hay tabla temporal, ni begin/commit propios, ni sentencias intermedias: todo
-- el lote cabe en UN bloque do y la autocomprobacion va por NOTICE.
--
-- Va encima de Lote B, B-2, E y C. Cierra el `4 | 35` del candado: 35 monederos
-- con saldo escrito a mano antes de que existiera el libro mayor.
--
-- Criterio contable: el saldo de un cliente es una deuda del operador (pasivo,
-- crece al Haber). Si ese pasivo existe pero nadie lo fundo, la contrapartida
-- honesta es un gasto por discrepancia, no caja. Cada apertura es
--   Debe   SYS-DISCREPANCY     importe
--   Haber  monedero del cliente
-- y nunca se toca SYS-CASH: afirmar que hay caja sin un extracto bancario que lo
-- respalde seria inventar un activo.
--
-- OJO al orden, es lo que impide duplicar el saldo. Cerrar un asiento es un
-- update de estado, y ese update dispara ledger_journal_apply_wallets, que suma
-- su delta al monedero. Asentar sobre el saldo que ya esta escrito llevaria al
-- cliente de 5.000 a 10.000. Por eso cada monedero se deja PRIMERO en lo que dice
-- el libro (por la misma bandera que usa el propio libro, ledger.applying_wallets)
-- y DESPUES se asienta: el asiento devuelve el monedero a su saldo real. Salida
-- neta: lo que ve el cliente no cambia ni un centimo y el libro pasa a conocerlo.
--
-- Guarda: se fotografia el saldo de todos los monederos antes de empezar y se
-- compara al final dentro del mismo bloque. Si alguno se movio, o si aparecio un
-- monedero nuevo, se lanza excepcion y la transaccion del editor echa el lote
-- entero atras.
--
-- Idempotente: la clave APERTURA-D-<usuario>-<moneda> hace que volver a pegarlo
-- no duplique ningun asiento.

do $lote_d$
declare
  w        record;
  r        jsonb;
  creados  int := 0;
  total    numeric := 0;
  mal      int;
  ejemplo  text;
  antes    jsonb;
begin
  select jsonb_agg(jsonb_build_object('u', x.user_id, 'c', x.currency, 'b', x.balance))
    into antes
    from public.wallets x;

  perform set_config('ledger.applying_wallets', 'on', true);

  for w in
    select x.user_id, x.currency, x.diferencia
      from (
        select w2.user_id, w2.currency,
               w2.balance - coalesce(public.ledger_account_balance(
                 (select a.id from public.ledger_accounts a
                   where a.user_id = w2.user_id and a.is_wallet and a.currency = w2.currency
                   limit 1)), 0) as diferencia
          from public.wallets w2
      ) x
     where x.diferencia <> 0
     order by x.user_id, x.currency
  loop
    -- 1) el monedero queda en lo que el libro dice (en los casos reales, cero)
    update public.wallets
       set balance = balance - w.diferencia
     where user_id = w.user_id and currency = w.currency;

    -- 2) el asiento de apertura lo devuelve a su saldo real y lo deja firmado
    if w.diferencia > 0 then
      r := public.ledger_post(
        w.user_id,
        'apertura',
        'APERTURA-D-' || w.user_id || '-' || w.currency,
        'Saldo previo al libro mayor: alta como discrepancia (Lote D)',
        jsonb_build_array(
          jsonb_build_object('account', 'SYS-DISCREPANCY', 'entry_type', 'debit',  'amount', w.diferencia),
          jsonb_build_object('wallet_user_id', w.user_id,  'entry_type', 'credit', 'amount', w.diferencia)
        ),
        'LOTE-D'
      );
    else
      r := public.ledger_post(
        w.user_id,
        'apertura',
        'APERTURA-D-' || w.user_id || '-' || w.currency,
        'Saldo previo al libro mayor: el monedero estaba por debajo del libro (Lote D)',
        jsonb_build_array(
          jsonb_build_object('account', 'SYS-DISCREPANCY', 'entry_type', 'credit', 'amount', -w.diferencia),
          jsonb_build_object('wallet_user_id', w.user_id,  'entry_type', 'debit',  'amount', -w.diferencia)
        ),
        'LOTE-D'
      );
    end if;

    if coalesce(r->>'status', '') <> 'posted' then
      raise exception 'LOTE D abortado: el asiento de % (%) por % quedo en estado % en vez de posted. El lote no entra.',
        w.user_id, w.currency, abs(w.diferencia), coalesce(r->>'status', 'sin respuesta');
    end if;

    creados := creados + 1;
    total   := total + abs(w.diferencia);
  end loop;

  -- Guarda 1: ningún saldo de cliente puede haber cambiado.
  select count(*) into mal
    from public.wallets ww
    join lateral (
      select (el->>'b')::numeric as balance
        from jsonb_array_elements(antes) el
       where (el->>'u')::uuid = ww.user_id and el->>'c' = ww.currency
    ) a on true
   where ww.balance is distinct from a.balance;

  select coalesce(string_agg(ww.user_id || ' paso de ' || a.balance || ' a ' || ww.balance, ' | '), '')
    into ejemplo
    from public.wallets ww
    join lateral (
      select (el->>'b')::numeric as balance
        from jsonb_array_elements(antes) el
       where (el->>'u')::uuid = ww.user_id and el->>'c' = ww.currency
    ) a on true
   where ww.balance is distinct from a.balance;

  if mal > 0 then
    raise exception 'LOTE D abortado: % monederos cambiaron de saldo (%). El lote no entra.', mal, ejemplo;
  end if;

  -- Guarda 2: no puede haber aparecido un monedero durante el lote.
  if (select count(*) from public.wallets) <> jsonb_array_length(antes) then
    raise exception 'LOTE D abortado: el numero de monederos cambio durante el lote (% -> %)',
      jsonb_array_length(antes), (select count(*) from public.wallets);
  end if;

  raise notice 'LOTE D v2 | apertura_creados=% | importe_total=% | monederos_comprobados=% | desfasados_finales=%',
    creados,
    total,
    jsonb_array_length(antes),
    (select count(*) from public.wallets ww
      where ww.balance <> coalesce(public.ledger_account_balance(
        (select a.id from public.ledger_accounts a
          where a.user_id = ww.user_id and a.is_wallet and a.currency = ww.currency limit 1)), 0));
end
$lote_d$;

-- Comprobacion aparte, despues de que el lote este dentro.
select
  (select count(*) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and t.tgname in ('trg_wallets_balance_locked','trg_wallets_insert_zero',
                       'trg_wallets_row_locked','trg_ledger_flag_wallet_apply')) as gatillos,
  (select count(*) from public.wallets w
     join lateral (select coalesce(public.ledger_account_balance(
                 (select a.id from public.ledger_accounts a
                   where a.user_id = w.user_id and a.is_wallet and a.currency = w.currency limit 1)), 0) as esperado) x on true
    where w.balance <> x.esperado) as monederos_desfasados,
  (select (v->>'rotos')::int from public.ledger_verify_chain() v) as cadenas_rotas,
  (select count(*) from public.ledger_journals where operation = 'apertura') as asientos_apertura,
  (select coalesce(sum(balance), 0) from public.wallets) as saldo_clientes,
  (select coalesce(public.ledger_account_balance(id), 0)
     from public.ledger_accounts where code = 'SYS-DISCREPANCY') as discrepancia;
