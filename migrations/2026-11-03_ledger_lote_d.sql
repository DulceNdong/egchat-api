-- EGPay - Lote D: dar de alta en el libro el dinero que ya existía.
--
-- Va encima de Lote B, B-2, E y C. Cierra el `4 | 35` que devolvió el candado:
-- 35 monederos con saldo escrito a mano antes de que existiera el libro mayor.
--
-- Criterio contable: el saldo de un cliente es una deuda del operador (pasivo,
-- crece al Haber). Si ese pasivo existe pero nadie lo fundó, la contrapartida
-- honesta es un gasto por discrepancia, no caja. Cada apertura es
--   Debe   SYS-DISCREPANCY     importe
--   Haber  monedero del cliente
-- y nunca se toca SYS-CASH: afirmar que hay caja sin un extracto bancario que lo
-- respalde sería inventar un activo.
--
-- OJO al orden, es lo que impide duplicar el saldo. Cerrar un asiento es un
-- update de estado, y ese update dispara ledger_journal_apply_wallets, que suma
-- su delta al monedero. Asentar sobre el saldo que ya está escrito llevaría al
-- cliente de 5.000 a 10.000. Por eso cada monedero se deja PRIMERO en lo que dice
-- el libro (por la misma bandera que usa el propio libro, ledger.applying_wallets)
-- y DESPUÉS se asienta: el asiento devuelve el monedero a su saldo real. Salida
-- neta: lo que ve el cliente no cambia ni un céntimo y el libro pasa a conocerlo.
--
-- Guarda: se fotografía el saldo de todos los monederos antes de empezar y se
-- compara al final. Si alguno se movió, el lote entero se echa atrás. Un error de
-- signo aquí no puede llegar a producción.
--
-- Idempotente: la clave APERTURA-D-<usuario>-<moneda> hace que volver a pegarlo
-- no duplique ningún asiento.
--
-- Deja rastro: un asiento firmado por monedero, con la cadena de hash extendida.
-- Es una escritura, no un informe.

begin;

create temp table _lote_d_antes on commit drop as
  select user_id, currency, balance from public.wallets;

do $$
declare
  w       record;
  r       jsonb;
  creados int := 0;
  total   numeric := 0;
begin
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
    creados := creados + 1;
    total   := total + abs(w.diferencia);
  end loop;
  raise notice 'LOTE D: % asientos de apertura por % en total', creados, total;
end $$;

-- Guarda: ningún saldo de cliente puede haber cambiado. Si alguno se movió, esto
-- aborta la transacción y el lote no entra.
do $$
declare mal int; ejemplo text;
begin
  select count(*) into mal
    from public.wallets w
    join _lote_d_antes a on a.user_id = w.user_id and a.currency = w.currency
   where w.balance is distinct from a.balance;
  if mal > 0 then
    select w.user_id || ' pasaba de ' || a.balance || ' a ' || w.balance
      into ejemplo
      from public.wallets w
      join _lote_d_antes a on a.user_id = w.user_id and a.currency = w.currency
     where w.balance is distinct from a.balance
     limit 1;
    raise exception 'LOTE D abortado: % monederos cambiaron de saldo (%). El lote no entra.', mal, ejemplo;
  end if;
  if (select count(*) from public.wallets) <> (select count(*) from _lote_d_antes) then
    raise exception 'LOTE D abortado: el numero de monederos cambio durante el lote';
  end if;
  raise notice 'LOTE D: ningun saldo de cliente se movio (% monederos comprobados)',
    (select count(*) from _lote_d_antes);
end $$;

-- Comprobación final. Debe dar 4 gatillos, 0 desfasados, 0 cadenas rotas, y
-- `discrepancia` igual al dinero que ya había en los monederos.
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

commit;
