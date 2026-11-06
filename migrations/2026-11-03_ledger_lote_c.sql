-- EGPay - Lote C: el saldo de un cliente solo lo mueve el libro mayor.
--
-- Va encima de 2026-11-02_ledger_lote_b.sql, 2026-11-03_ledger_lote_b2.sql y
-- 2026-11-03_egpay_channels.sql.
--
-- POR CUANDO EL API NUEVO ESTÉ DESPLEGADO. El API desplegado hoy escribe
-- wallets.balance directamente (updateWalletBalance). Si este candado entra
-- antes, los pagos reales de la app se rechazan con
-- "solo lo mueve el libro mayor". Orden: B -> B-2 -> E -> desplegar API -> C.
--
-- Qué cierra:
--   - wallets.balance deja de ser un número editable. Nadie, ni un servicio con
--     permisos, puede cambiar un saldo sin que antes exista un asiento cerrado
--     que lo justifique. El único camino es ledger_post().
--   - un monedero nuevo nace en cero: el saldo de bienvenida existe porque un
--     asiento lo abonó, no porque alguien lo escribió en el alta.
--
-- Cómo sabe el candado quién puede escribir: la propia tabla de asientos avisa
-- (gatillo before update of status) de que va a aplicar deltas a los monederos,
-- y marca una bandera local de transacción. El API no puede encender esa
-- bandera: una petición HTTP normal es su propia transacción, y la bandera se
-- apaga al terminar. No se copia ni se modifica ledger_journal_apply_wallets.
--
-- Idempotente: se puede volver a pegar sin efecto adicional.

begin;

-- 1. El libro avisa antes de tocar un monedero. Solo cuando un asiento pasa a
--    'posted': un borrador o un rechazo no mueve nada.
create or replace function public.ledger_flag_wallet_apply() returns trigger
language plpgsql as $$
begin
  if new.status = 'posted' and old.status is distinct from 'posted' then
    perform set_config('ledger.applying_wallets', 'on', true);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ledger_flag_wallet_apply on public.ledger_journals;
create trigger trg_ledger_flag_wallet_apply
  before update of status on public.ledger_journals
  for each row execute function public.ledger_flag_wallet_apply();

-- 2. Nadie mueve un saldo fuera del libro.
create or replace function public.wallets_balance_locked() returns trigger
language plpgsql as $$
begin
  if new.balance is distinct from old.balance
     and coalesce(current_setting('ledger.applying_wallets', true), '') <> 'on' then
    raise exception 'El saldo del monedero de % solo lo mueve el libro mayor: use ledger_post()',
      old.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wallets_balance_locked on public.wallets;
create trigger trg_wallets_balance_locked
  before update of balance on public.wallets
  for each row execute function public.wallets_balance_locked();

-- 3. Un monedero nace en cero. El dinero que tiene entra por un asiento.
create or replace function public.wallets_insert_zero() returns trigger
language plpgsql as $$
begin
  if coalesce(new.balance, 0) <> 0 then
    raise exception 'Un monedero se abre en cero (%): el saldo lo abona un asiento', new.balance;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wallets_insert_zero on public.wallets;
create trigger trg_wallets_insert_zero
  before insert on public.wallets
  for each row execute function public.wallets_insert_zero();

-- 3b. Borrar un monedero no borra el dinero: el saldo seguiría vivo en el libro
--     y el cliente dejaría de verlo. El mismo hueco de purga de la migración B
--     (ledger.allow_purge) es lo único que lo permite, para mantenimiento.
create or replace function public.wallets_row_locked() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('ledger.allow_purge', true), '') <> 'on' then
    raise exception 'El monedero de % no se borra: su saldo está en el libro mayor', old.user_id;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_wallets_row_locked on public.wallets;
create trigger trg_wallets_row_locked
  before delete on public.wallets
  for each row execute function public.wallets_row_locked();

-- 4. Comprobación a la vista, dentro de subtransacciones que se deshacen solas:
--    el candado bloquea la mano suelta y el libro sigue pudiendo abonar.
--    El primer DO bloquea (no deja rastro). El segundo abona y se echa atrás a
--    propósito, así que la prueba no suelta dinero ni deja asientos. El tercero
--    prueba que borrar un monedero está cerrado y que la purga sí abre la vía.
do $$
declare u uuid; bloqueado boolean := false;
begin
  select user_id into u from public.wallets order by user_id limit 1;
  if u is null then
    raise notice 'CANDADO: sin monederos todavia, la prueba de bloqueo se omite';
    return;
  end if;
  begin
    execute 'update public.wallets set balance = balance + 0.01 where user_id = $1' using u;
  exception when others then
    bloqueado := true;
  end;
  if not bloqueado then
    raise exception 'Lote C: alguien pudo mover un saldo sin asiento (%)', u;
  end if;
  raise notice 'Lote C: el saldo de % quedo bloqueado fuera del libro', u;
end $$;

do $$
declare total int; u uuid; bloqueado boolean := false; purga_abierta boolean := false;
begin
  select count(*) into total from public.wallets;
  select user_id into u from public.wallets order by user_id limit 1;
  if u is null then
    raise notice 'BORRADO: sin monederos, la prueba se omite';
    return;
  end if;
  begin
    execute 'delete from public.wallets where user_id = $1' using u;
  exception when others then
    bloqueado := true;
  end;
  if not bloqueado then
    raise exception 'Lote C: se pudo borrar el monedero de % sin abrir la purga', u;
  end if;
  -- con la via de mantenimiento abierta sí deja, y la prueba se deshace sola
  begin
    perform set_config('ledger.allow_purge', 'on', true);
    execute 'delete from public.wallets where user_id = $1' using u;
    if (select count(*) from public.wallets) <> total - 1 then
      raise exception 'Lote C: la purga abierta no borro el monedero de %', u;
    end if;
    purga_abierta := true;
    raise exception 'Lote C-rollback';
  exception when others then
    if sqlerrm <> 'Lote C-rollback' then
      raise exception 'Lote C: la purga de mantenimiento no funciono: %', sqlerrm;
    end if;
    if not purga_abierta then
      raise exception 'Lote C: la comprobacion de purga no confirmo el borrado';
    end if;
  end;
  if (select count(*) from public.wallets) <> total then
    raise exception 'Lote C: la prueba de borrado dejo % monederos (habia %)',
      (select count(*) from public.wallets), total;
  end if;
  raise notice 'Lote C: borrar un monedero esta cerrado y la purga de mantenimiento lo permite';
end $$;

do $$
declare u uuid; c text; antes numeric; despues numeric; lineas jsonb; libro_ok boolean := false;
begin
  select user_id, currency into u, c from public.wallets
   where currency = 'XAF' order by user_id limit 1;
  if u is null then
    raise notice 'LIBRO: sin monedero en XAF, la prueba de abono se omite';
    return;
  end if;
  select balance into antes from public.wallets where user_id = u;
  lineas := jsonb_build_array(
    jsonb_build_object('account', 'SYS-CASH', 'entry_type', 'debit', 'amount', 1),
    jsonb_build_object('wallet_user_id', u, 'entry_type', 'credit', 'amount', 1));
  begin
    perform public.ledger_post(u, 'ajuste', 'LOTE-C-COMPROBACION',
      'Comprobacion del candado (no deja rastro)', lineas);
    select balance into despues from public.wallets where user_id = u;
    if despues <> antes + 1 then
      raise exception 'Lote C: el libro abono pero el monedero sigue en % (esperado %)',
        despues, antes + 1;
    end if;
    libro_ok := true;
    raise exception 'Lote C-rollback';
  exception when others then
    if sqlerrm <> 'Lote C-rollback' then
      raise exception 'Lote C: el libro no pudo mover el monedero: %', sqlerrm;
    end if;
    if not libro_ok then
      raise exception 'Lote C: la comprobacion del libro no confirmo el abono';
    end if;
  end;
  raise notice 'Lote C: el libro abono y la prueba se deshizo sola (monedero de % intacto)', u;
end $$;

-- Debe dar 4 gatillos y 0 monederos desfasados: el candado esta puesto y el
-- libro sigue cuadrando con los saldos que muestra la app.
select
  (select count(*) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and t.tgname in ('trg_wallets_balance_locked','trg_wallets_insert_zero',
                       'trg_wallets_row_locked','trg_ledger_flag_wallet_apply')) as gatillos,
  (select count(*) from wallets w
     join lateral (select coalesce(public.ledger_account_balance(
                 (select a.id from public.ledger_accounts a
                   where a.user_id = w.user_id and a.is_wallet and a.currency = w.currency limit 1)), 0) as esperado) x on true
    where w.balance <> x.esperado) as monederos_desfasados;

commit;
