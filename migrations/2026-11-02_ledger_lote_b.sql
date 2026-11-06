-- =====================================================================
-- EGPay - Lote B: libro mayor real ligado al monedero
-- y huecos de esquema que el API ya espera (feedback, muted_until,
-- idempotencia de mensajes, contadores de espacios).
-- Fecha: 2026-11-02
--
-- Uso: pegar ENTERO en el editor SQL de Supabase y ejecutar.
-- Es idempotente (se puede repetir sin estropear nada) y va dentro de
-- una transaccion: si algo falla, no se aplica ningun cambio.
-- No borra ni modifica saldos: solo crea estructura y reglas.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tabla que el API escribe pero no existia (/api/feedback daba 500)
-- ---------------------------------------------------------------------
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.users(id) on delete set null,
  category   text        not null default 'General',
  message    text        not null,
  created_at timestamptz not null default now()
);
create index if not exists ix_feedback_created on public.feedback(created_at desc);

-- ---------------------------------------------------------------------
-- 2. Columnas que el codigo ya usa y faltaban
-- ---------------------------------------------------------------------
-- silenciar un chat por participante (ruta /api/chats/:id/mute)
alter table public.chat_participants add column if not exists muted_until timestamptz;

-- clave de idempotencia del envio de mensajes: corta los mensajes
-- duplicados que se ven en produccion (dos filas iguales del mismo
-- remitente y chat con 3 milisegundos de diferencia)
alter table public.messages add column if not exists client_ref text;
create unique index if not exists uix_messages_client_ref
  on public.messages (chat_id, sender_id, client_ref)
  where client_ref is not null;

-- ---------------------------------------------------------------------
-- 3. Libro mayor: forma y reglas
--    (las cuatro tablas ya existen en produccion y estan vacias)
-- ---------------------------------------------------------------------
create table if not exists public.ledger_accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  code         text        not null,
  name         text        not null,
  account_type text        not null default 'asset',
  currency     text        not null default 'XAF',
  is_system    boolean     not null default false,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.ledger_journals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid,
  reference         text,
  concept           text,
  total_amount      numeric(18,2) not null default 0,
  status            text        not null default 'draft',
  requires_approval boolean     not null default false,
  created_by        uuid,
  approved_by       uuid,
  approved_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  journal_id         uuid not null,
  account_id         uuid not null,
  entry_type         text        not null,
  amount             numeric(18,2) not null,
  currency           text        not null default 'XAF',
  memo               text,
  counterparty_user_id uuid,
  created_at         timestamptz not null default now()
);

create table if not exists public.ledger_approvals (
  id           uuid primary key default gen_random_uuid(),
  journal_id   uuid not null,
  requested_by uuid,
  approved_by  uuid,
  status       text        not null default 'pending',
  reason       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 3.1 columnas nuevas
alter table public.ledger_accounts  add column if not exists is_wallet boolean not null default false;
alter table public.ledger_journals  add column if not exists idempotency_key text;
alter table public.ledger_journals  add column if not exists posted_at timestamptz;
alter table public.ledger_journals  add column if not exists operation text;
alter table public.ledger_journals  add column if not exists reversal_of uuid references public.ledger_journals(id);
alter table public.ledger_entries   add column if not exists line_no int;

-- 3.2 claves ajenas (solo si aun no existen)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_accounts_user_fkey') then
    alter table public.ledger_accounts
      add constraint ledger_accounts_user_fkey foreign key (user_id)
      references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_entries_journal_fkey') then
    alter table public.ledger_entries
      add constraint ledger_entries_journal_fkey foreign key (journal_id)
      references public.ledger_journals(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_entries_account_fkey') then
    alter table public.ledger_entries
      add constraint ledger_entries_account_fkey foreign key (account_id)
      references public.ledger_accounts(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_journals_user_fkey') then
    alter table public.ledger_journals
      add constraint ledger_journals_user_fkey foreign key (user_id)
      references public.users(id) on delete set null;
  end if;
end $$;

-- 3.3 reglas de dominio
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_accounts_type_check') then
    alter table public.ledger_accounts
      add constraint ledger_accounts_type_check
      check (account_type in ('asset','liability','income','expense','equity'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_journals_status_check') then
    alter table public.ledger_journals
      add constraint ledger_journals_status_check
      check (status in ('draft','pending_approval','posted','rejected','reversed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_entries_type_check') then
    alter table public.ledger_entries
      add constraint ledger_entries_type_check check (entry_type in ('debit','credit'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ledger_entries_amount_check') then
    alter table public.ledger_entries
      add constraint ledger_entries_amount_check check (amount > 0);
  end if;
end $$;

-- 3.4 unicidad e indices
create unique index if not exists uix_ledger_accounts_code     on public.ledger_accounts(code);
create unique index if not exists uix_ledger_accounts_wallet   on public.ledger_accounts(user_id, currency) where is_wallet;
create unique index if not exists uix_ledger_journals_idem     on public.ledger_journals(idempotency_key) where idempotency_key is not null;
create unique index if not exists uix_ledger_approvals_journal on public.ledger_approvals(journal_id);
create index        if not exists ix_ledger_entries_journal    on public.ledger_entries(journal_id);
create index        if not exists ix_ledger_entries_account    on public.ledger_entries(account_id);
create index        if not exists ix_ledger_journals_user      on public.ledger_journals(user_id, created_at desc);
create index        if not exists ix_ledger_journals_status    on public.ledger_journals(status);

-- Un monedero por usuario y divisa. Sin esto, un asiento aplicado a dos
-- filas del mismo usuario duplicaria el dinero.
do $$ begin
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='uix_wallets_user_currency') then
    if exists (select 1 from public.wallets group by user_id, currency having count(*) > 1) then
      raise notice 'AVISO: hay usuarios con mas de un monedero en la misma divisa. Hay que unificarlos (Lote D) y volver a ejecutar este script.';
    else
      create unique index uix_wallets_user_currency on public.wallets(user_id, currency);
    end if;
  end if;
end $$;

-- 3.5 plan contable del operador
--     Son las cuentas que el API ya usa (index.js ensureSystemLedgerAccounts).
--     El upsert sobre code require el indice unico de arriba: sin el, fallaba
--     en silencio y no quedaba ni plan contable ni asientos.
insert into public.ledger_accounts (user_id, code, name, account_type, currency, is_system, is_wallet, is_active) values
  (null, 'SYS-CASH',         'Caja Operativa',                'asset',     'XAF', true, false, true),
  (null, 'SYS-FEES',         'Ingresos por Comisiones',       'income',    'XAF', true, false, true),
  (null, 'SYS-SUSPENSE',     'Cuenta Puente',                 'liability', 'XAF', true, false, true),
  (null, 'SYS-DISCREPANCY',  'Diferencias por Aclarar',       'expense',   'XAF', true, false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 4. Funciones de calculo
-- ---------------------------------------------------------------------
create or replace function public.ledger_journal_debit(p_journal_id uuid)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(amount), 0) from public.ledger_entries
  where journal_id = p_journal_id and entry_type = 'debit';
$$;

create or replace function public.ledger_journal_credit(p_journal_id uuid)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(amount), 0) from public.ledger_entries
  where journal_id = p_journal_id and entry_type = 'credit';
$$;

create or replace function public.ledger_journal_is_balanced(p_journal_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select abs(public.ledger_journal_debit(p_journal_id) - public.ledger_journal_credit(p_journal_id)) < 0.005;
$$;

-- Saldo con signo de una cuenta: activo y gasto debitan; pasivo, ingreso
-- y patrimonio creditan. Solo cuentan asientos cerrados o revertidos.
create or replace function public.ledger_account_balance(p_account_id uuid)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(
    case when a.account_type in ('asset','expense') then
           (case when e.entry_type = 'debit' then  e.amount else -e.amount end)
         else
           (case when e.entry_type = 'credit' then  e.amount else -e.amount end)
    end), 0)
  from public.ledger_entries e
  join public.ledger_accounts a on a.id = e.account_id
  join public.ledger_journals j on j.id = e.journal_id
  where e.account_id = p_account_id
    and j.status in ('posted','reversed');
$$;

-- Cuenta-monedero de un usuario; la crea si no existe. Usa el mismo codigo
-- que el API (USR-CASH- + 8 primeros caracteres del uuid), asi las dos rutas
-- caen en la misma cuenta y no se duplica el plan contable.
create or replace function public.ledger_wallet_account(p_user_id uuid, p_currency text default 'XAF')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare acc uuid;
begin
  if p_user_id is null then raise exception 'ledger_wallet_account necesita un usuario'; end if;
  select id into acc from public.ledger_accounts
   where is_wallet and user_id = p_user_id and currency = p_currency;
  if acc is null then
    insert into public.ledger_accounts (user_id, code, name, account_type, currency, is_system, is_wallet, is_active)
    values (p_user_id, 'USR-CASH-' || left(p_user_id::text, 8),
            'Saldo de cliente', 'liability', p_currency, false, true, true)
    returning id into acc;
  end if;
  return acc;
end $$;

-- ---------------------------------------------------------------------
-- 5. Reglas que impone la base de datos, no el codigo de la app
-- ---------------------------------------------------------------------
-- 5.0.a Dejar el conjunto de gatillos en un estado conocido: sobre estas
--       cuatro tablas existian reglas de versiones anteriores y las tablas
--       estan vacias, asi que se retiran todas antes de poner las definitive.
--       Solo las anteriores: las que empiezan por trg_ledger_ son las de este
--       lote y de los que van despues (B-2, C). Barrerlas tambien dejaria un
--       monedero sin su candado al volver a pegar el lote B.
do $$
declare r record;
begin
  for r in
    select tg.tgname, c.relname
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('ledger_accounts','ledger_journals','ledger_entries','ledger_approvals')
      and not tg.tgisinternal
      and tg.tgname not like 'trg\_ledger\_%'
  loop
    execute format('drop trigger %I on public.%I', r.tgname, r.relname);
    raise notice 'Gatillo anterior retirado: %.%', r.relname, r.tgname;
  end loop;
end $$;

-- 5.0 el dinero solo entra por ledger_post(). Un asiento insertado a mano
--     con estado 'posted' o 'pending_approval' no mueve monedero y, por
--     tanto, miente: se rechaza. Los 'draft' si se permiten (borradores).
create or replace function public.ledger_journal_source_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if NEW.status in ('posted','pending_approval') and NEW.operation is null then
    raise exception 'El asiento % se inserta como % sin operacion: use ledger_post()',
      coalesce(NEW.id, 'nuevo'), NEW.status;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ledger_journal_source_guard on public.ledger_journals;
create trigger trg_ledger_journal_source_guard
  before insert or update of status, operation on public.ledger_journals
  for each row execute function public.ledger_journal_source_guard();

-- 5.1 un asiento cerrado es inmutable
create or replace function public.ledger_entries_immutable()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare st text;
begin
  -- Via de purga explicita para mantenimiento (set ledger.allow_purge = 'on').
  -- Sin ella, borrar un asiento cerrado por cascada tambien estaria bloqueado.
  if coalesce(current_setting('ledger.allow_purge', true), '') = 'on' then
    return coalesce(NEW, OLD);
  end if;
  select status into st from public.ledger_journals
   where id = coalesce(NEW.journal_id, OLD.journal_id);
  if st in ('posted','reversed','rejected') then
    raise exception 'El asiento % esta cerrado (estado %): sus lineas son inmutables',
      coalesce(NEW.journal_id, OLD.journal_id), st;
  end if;
  return coalesce(NEW, OLD);
end $$;

drop trigger if exists trg_ledger_entries_immutable on public.ledger_entries;
create trigger trg_ledger_entries_immutable
  before update or delete on public.ledger_entries
  for each row execute function public.ledger_entries_immutable();

-- 5.2 cerrar un asiento exige dos patas y cuadre exacto
create or replace function public.ledger_journal_post_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare n_lines int;
begin
  if NEW.status = 'posted' and OLD.status is distinct from 'posted' then
    select count(*) into n_lines from public.ledger_entries where journal_id = NEW.id;
    if n_lines < 2 then
      raise exception 'Asiento % con % lineas: hace falta al menos un debe y un haber', NEW.id, n_lines;
    end if;
    if not public.ledger_journal_is_balanced(NEW.id) then
      raise exception 'Asiento descuadrado: debe % / haber %',
        public.ledger_journal_debit(NEW.id), public.ledger_journal_credit(NEW.id);
    end if;
    NEW.total_amount := public.ledger_journal_debit(NEW.id);
    NEW.posted_at    := coalesce(OLD.posted_at, now());
  end if;
  if OLD.status = 'posted' and NEW.total_amount is distinct from OLD.total_amount then
    raise exception 'No se puede cambiar el total de un asiento ya cerrado';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ledger_journal_post_guard on public.ledger_journals;
create trigger trg_ledger_journal_post_guard
  before update on public.ledger_journals
  for each row execute function public.ledger_journal_post_guard();

-- 5.3 al cerrar el asiento, el monedero se mueve con el:
--     el libro mayor pasa a ser la unica fuente del saldo.
create or replace function public.ledger_journal_apply_wallets()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r       record;
  act     numeric;
  gemelos int;
begin
  if NEW.status = 'posted' and OLD.status is distinct from 'posted' then
    for r in
      -- mismo criterio de signo que ledger_account_balance: un saldo de cliente
      -- es pasivo del operador, por eso aumenta con el Haber
      select a.id as account_id, a.user_id, a.currency,
             sum(case when a.account_type in ('asset','expense') then
                        (case when e.entry_type = 'debit' then  e.amount else -e.amount end)
                      else
                        (case when e.entry_type = 'credit' then  e.amount else -e.amount end)
                   end) as delta
      from public.ledger_entries e
      join public.ledger_accounts a on a.id = e.account_id
      where e.journal_id = NEW.id and a.is_wallet and a.user_id is not null
      group by a.id, a.user_id, a.currency
    loop
      select count(*) into gemelos from public.wallets
       where user_id = r.user_id and currency = r.currency;
      if gemelos > 1 then
        raise exception 'El usuario % tiene % monederos en %: unificarlos antes de asentuar',
          r.user_id, gemelos, r.currency;
      end if;
      if gemelos = 0 then
        raise exception 'El usuario % no tiene monedero en %', r.user_id, r.currency;
      end if;

      -- for update: dos pagos simultaneos del mismo monedero no pueden pasar
      -- el control con el saldo viejo y dejarlo en negativo
      select balance into act from public.wallets
       where user_id = r.user_id and currency = r.currency
       for update;
      if act + r.delta < 0 then
        raise exception 'Saldo insuficiente: % + % daria negativo', act, r.delta;
      end if;
      update public.wallets
         set balance = balance + r.delta, updated_at = now()
       where user_id = r.user_id and currency = r.currency;
    end loop;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ledger_journal_apply_wallets on public.ledger_journals;
create trigger trg_ledger_journal_apply_wallets
  after update of status on public.ledger_journals
  for each row execute function public.ledger_journal_apply_wallets();

-- ---------------------------------------------------------------------
-- 6. Unica puerta de entrada del dinero: ledger_post()
--    Doble partida, cuadre obligatorio, idempotente por clave.
--    p_lines: [{"account":"SYS-SUSPENSE","entry_type":"credit","amount":800},
--              {"wallet_user_id":"<uuid>","entry_type":"debit","amount":800}]
--    Criterio: el saldo de un cliente es pasivo del operador (crece al Haber);
--    SYS-CASH es activo (crece al Debe) y SYS-FEES ingreso (crece al Haber).
--    Una linea va al monedero de un usuario con "wallet_user_id" y a una
--    cuenta del plan contable con "account" (por codigo).
--    Operaciones esperadas: recarga, pago_servicio, transferencia_p2p,
--    comision, saldo_inicial, ajuste, reversión.
-- ---------------------------------------------------------------------
create or replace function public.ledger_post(
  p_user_id           uuid,
  p_operation         text,
  p_idempotency_key   text,
  p_concept           text,
  p_lines             jsonb,
  p_reference         text default null,
  p_requires_approval boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j        public.ledger_journals;
  previa   public.ledger_journals;
  ln       jsonb;
  acc      uuid;
  v_code   text;
  etype    text;
  amt      numeric;
  cur      text;
  total_d  numeric := 0;
  total_c  numeric := 0;
  i        int := 0;
begin
  if p_idempotency_key is not null then
    begin
      select * into strict previa from public.ledger_journals where idempotency_key = p_idempotency_key;
      return jsonb_build_object(
        'journal_id', previa.id, 'status', previa.status,
        'total_amount', previa.total_amount, 'already_posted', true);
      exception when no_data_found then null;
    end;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'Hacen falta al menos 2 lineas en p_lines';
  end if;

  insert into public.ledger_journals
    (user_id, reference, concept, total_amount, status, requires_approval,
     created_by, operation, idempotency_key)
  values
    (p_user_id, coalesce(p_reference, p_operation || '-' || gen_random_uuid()::text),
     p_concept, 0, case when p_requires_approval then 'pending_approval' else 'draft' end,
     p_requires_approval, p_user_id, p_operation, p_idempotency_key)
  returning * into j;

  for ln in select * from jsonb_array_elements(p_lines)
  loop
    i     := i + 1;
    v_code := nullif(trim(coalesce(ln->>'account', '')), '');
    etype := lower(trim(coalesce(ln->>'entry_type', '')));
    amt   := coalesce((ln->>'amount')::numeric, 0);
    cur   := upper(coalesce(nullif(trim(ln->>'currency'), ''), 'XAF'));

    if amt <= 0 or etype not in ('debit','credit') then
      raise exception 'Linea % invalida: entry_type debe ser debit o credit y amount > 0', i;
    end if;
    if amt <> round(amt, 2) then
      raise exception 'Linea % con mas de 2 decimales (%): el XAF no admite fraccion', i, amt;
    end if;
    if v_code is null and ln->>'wallet_user_id' is null then
      raise exception 'Linea % sin cuenta: usa "account" (codigo) o "wallet_user_id"', i;
    end if;

    if ln->>'wallet_user_id' is not null then
      acc := public.ledger_wallet_account((ln->>'wallet_user_id')::uuid, cur);
    else
      select id into acc from public.ledger_accounts where code = upper(v_code);
      if acc is null then raise exception 'Cuenta % inexistente', upper(v_code); end if;
    end if;

    insert into public.ledger_entries
      (journal_id, account_id, entry_type, amount, currency, memo, counterparty_user_id, line_no)
    values
      (j.id, acc, etype, amt, cur, ln->>'memo', (ln->>'counterparty_user_id')::uuid, i);

    if etype = 'debit' then total_d := total_d + amt; else total_c := total_c + amt; end if;
  end loop;

  if abs(total_d - total_c) >= 0.005 then
    -- se anula todo: no queda asiento basura ni dinero movido
    raise exception 'Asiento descuadrado: debe % / haber %', total_d, total_c;
  end if;

  if p_requires_approval then
    insert into public.ledger_approvals (journal_id, requested_by, status)
    values (j.id, p_user_id, 'pending')
    on conflict (journal_id) do nothing;
    return jsonb_build_object('journal_id', j.id, 'status', 'pending_approval',
                              'total_amount', total_d, 'already_posted', false);
  end if;

  update public.ledger_journals set status = 'posted' where id = j.id;
  select * into j from public.ledger_journals where id = j.id;
  return jsonb_build_object('journal_id', j.id, 'status', j.status,
                            'total_amount', j.total_amount, 'already_posted', false);

exception when unique_violation then
  -- Dos reintentos simultaneos de la misma operacion pelean por el indice unico
  -- de idempotencia: el que llega segundo no debe reventar, debe devolver el
  -- asiento del primero. La subtransaccion ya ha deshecho el asiento nuestro.
  if p_idempotency_key is not null then
    select * into previa from public.ledger_journals where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('journal_id', previa.id, 'status', previa.status,
                                'total_amount', previa.total_amount, 'already_posted', true);
    end if;
  end if;
  raise;
end $$;

-- Aprobar ( maker/checker dentro de la base: el creador no puede aprobarse )
create or replace function public.ledger_approve_journal(
  p_journal_id uuid, p_admin_id uuid, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.ledger_journals;
begin
  select * into strict j from public.ledger_journals where id = p_journal_id for update;
  if j.status <> 'pending_approval' then
    return jsonb_build_object('journal_id', j.id, 'status', j.status, 'approved', false);
  end if;
  if j.created_by = p_admin_id then
    raise exception 'El creador no puede aprobar su propio asiento';
  end if;
  update public.ledger_journals
     set status = 'posted', approved_by = p_admin_id, approved_at = now()
   where id = p_journal_id;
  update public.ledger_approvals
     set status = 'approved', approved_by = p_admin_id, reason = p_reason, updated_at = now()
   where journal_id = p_journal_id;
  return jsonb_build_object('journal_id', p_journal_id, 'status', 'posted', 'approved', true);
end $$;

-- Devolucion: asiento espejo. El original queda como 'reversed' y no se borra.
create or replace function public.ledger_reverse_journal(
  p_journal_id uuid, p_admin_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j     public.ledger_journals;
  lineas jsonb;
  res  jsonb;
begin
  select * into strict j from public.ledger_journals where id = p_journal_id;
  if j.status <> 'posted' then raise exception 'Solo se pueden revertir asientos cerrados'; end if;
  if exists (select 1 from public.ledger_journals where reversal_of = p_journal_id) then
    raise exception 'Ese asiento ya fue revertido';
  end if;

  select jsonb_agg(jsonb_build_object(
    'account',      case when a.is_wallet then null else a.code end,
    'wallet_user_id', case when a.is_wallet then a.user_id::text else null end,
    'entry_type',   case when e.entry_type = 'debit' then 'credit' else 'debit' end,
    'amount',       e.amount,
    'currency',     e.currency,
    'memo',         'Reversion de ' || p_journal_id::text,
    'counterparty_user_id', e.counterparty_user_id
  )) into lineas
  from public.ledger_entries e
  join public.ledger_accounts a on a.id = e.account_id
  where e.journal_id = p_journal_id;

  res := public.ledger_post(j.user_id, 'reversion', 'REV-' || p_journal_id::text,
           'Reversion: ' || coalesce(p_reason, ''), lineas,
           'REV-' || p_journal_id::text, false);

  update public.ledger_journals set reversal_of = p_journal_id where id = (res->>'journal_id')::uuid;
  update public.ledger_journals set status = 'reversed' where id = p_journal_id;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- 7. Conciliacion: monedero contra libro mayor
-- ---------------------------------------------------------------------
create or replace view public.ledger_wallet_reconciliation_v as
select w.user_id,
       w.currency,
       w.balance                                            as wallet_balance,
       coalesce(public.ledger_account_balance(a.id), 0)     as ledger_balance,
       w.balance - coalesce(public.ledger_account_balance(a.id), 0) as drift,
       a.id                                                 as wallet_account_id
from public.wallets w
left join public.ledger_accounts a
       on a.user_id = w.user_id and a.is_wallet and a.currency = w.currency;

create or replace view public.ledger_trial_balance_v as
select a.code, a.name, a.account_type, a.currency,
       public.ledger_account_balance(a.id) as balance,
       count(e.id) as lineas
from public.ledger_accounts a
left join public.ledger_entries e on e.account_id = a.id
group by a.id, a.code, a.name, a.account_type, a.currency
order by a.account_type, a.code;

-- ---------------------------------------------------------------------
-- 8. Contadores de espacios: sustituyen al RPC exec_sql (no existe).
--    SQL fijo en cada funcion: sin concatenacion, sin inyeccion.
-- ---------------------------------------------------------------------
create or replace function public.space_followers_delta(p_space_id uuid, p_delta int)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.spaces
     set followers_count = greatest(0, coalesce(followers_count, 0) + p_delta)
   where id = p_space_id;
$$;

create or replace function public.space_likes_delta(p_post_id uuid, p_delta int)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.space_posts
     set likes_count = greatest(0, coalesce(likes_count, 0) + p_delta)
   where id = p_post_id;
$$;

create or replace function public.space_comments_delta(p_post_id uuid, p_delta int)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.space_posts
     set comments_count = greatest(0, coalesce(comments_count, 0) + p_delta)
   where id = p_post_id;
$$;

-- ---------------------------------------------------------------------
-- 9. Cerrar la superficie: RLS sin politicas para los roles de la app.
--    El API entra con service_role (bypasea RLS), asi que no se rompe
--    nada; antes de esto cualquier usuario con sesion podia escribir
--    asientos y aprobarlos por REST.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ledger_accounts','ledger_journals','ledger_entries','ledger_approvals','feedback']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.ledger_post(uuid,text,text,text,jsonb,text,boolean)',
    'public.ledger_approve_journal(uuid,uuid,text)',
    'public.ledger_reverse_journal(uuid,uuid,text)',
    'public.ledger_wallet_account(uuid,text)',
    'public.space_followers_delta(uuid,int)',
    'public.space_likes_delta(uuid,int)',
    'public.space_comments_delta(uuid,int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

revoke all on public.ledger_wallet_reconciliation_v from anon, authenticated;
revoke all on public.ledger_trial_balance_v         from anon, authenticated;
grant select on public.ledger_wallet_reconciliation_v to service_role;
grant select on public.ledger_trial_balance_v          to service_role;

-- ---------------------------------------------------------------------
-- 10. Comprobacion a la vista, antes de confirmar
-- ---------------------------------------------------------------------
select
  (select count(*) from public.ledger_accounts where is_system)                  as cuentas_sistema,
  (select count(*) from public.ledger_journals)                                  as asientos,
  (select count(*) from public.ledger_wallet_reconciliation_v)                    as monederos,
  (select count(*) from pg_indexes where schemaname='public' and indexname in
     ('uix_wallets_user_currency','uix_ledger_journals_idem',
      'uix_messages_client_ref','uix_ledger_accounts_wallet'))                    as indices_clave;

commit;
