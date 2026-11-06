-- =====================================================================
-- EGPay - Lote B-2: plantillas de asiento y cadena de prueba dentro
-- de la base de datos.
--
-- Va encima de 2026-11-02_ledger_lote_b.sql (ya aplicado). No reescribe el
-- motor: añade (1) el catálogo de asientos que el canal básico y la
-- retención necesitan y (2) la cadena antimanipulación, resuelta con un
-- candado de fila en Postgres: no existe asiento a medio cerrar y dos
-- cierres simultáneos esperan en vez de fallar.
--
-- Idempotente: se puede volver a pegar sin efecto adicional.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Criptografía para el hash de cadena
-- ---------------------------------------------------------------------
-- En Supabase las extensiones viven en el esquema "extensions"; en un
-- Postgres pelado no existe. Se crea si falta para que las funciones con
-- search_path fijado resuelvan digest() sin depender de la ruta.
create schema if not exists extensions;
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create extension pgcrypto with schema extensions;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Columnas de cadena y de contexto del asiento
-- ---------------------------------------------------------------------
alter table public.ledger_journals add column if not exists prev_hash            text;
alter table public.ledger_journals add column if not exists hash                 text;
alter table public.ledger_journals add column if not exists chain_seq            bigint;
alter table public.ledger_journals add column if not exists counterparty_user_id uuid;
alter table public.ledger_journals add column if not exists provider             text;
alter table public.ledger_journals add column if not exists external_ref         text;
alter table public.ledger_journals add column if not exists meta                 jsonb not null default '{}'::jsonb;

-- Un eslabón por posición y una sola continuación de cada eslabón: la cadena
-- no se bifurca ni repite número.
create unique index if not exists uix_ledger_journals_chain_seq
  on public.ledger_journals (chain_seq) where chain_seq is not null;
create unique index if not exists uix_ledger_journals_prev_hash
  on public.ledger_journals (prev_hash) where prev_hash is not null;
create index if not exists ix_ledger_journals_kind
  on public.ledger_journals (operation, status, created_at desc);

-- Cabecera de la cadena: una única fila, movida con candado de fila.
create table if not exists public.ledger_head (
  id            text primary key check (id = 'head'),
  last_hash     text not null,
  journal_count bigint not null default 0,
  updated_at    timestamptz not null default now()
);

insert into public.ledger_head (id, last_hash)
  values ('head', 'EGPAY-GENESIS-000000000000000000000000')
  on conflict (id) do nothing;

-- Si la cabecera llega adelantada sin ni un solo asiento firmado (cadena heredada
-- de otro motor o de una purga anterior) se alinea: no puede haber eslabones
-- pendientes sobre una secuencia que no existe.
update public.ledger_head
   set last_hash   = 'EGPAY-GENESIS-000000000000000000000000',
       journal_count = 0,
       updated_at  = now()
 where id = 'head'
   and not exists (select 1 from public.ledger_journals where hash is not null);

-- ---------------------------------------------------------------------
-- 3. Receta única de firma: la misma al cerrar y al verificar
-- ---------------------------------------------------------------------
create or replace function public.ledger_canonical_lines(p_journal_id uuid)
returns text language sql stable security definer
set search_path = public, extensions, pg_temp as $$
  select coalesce(
    string_agg(
      a.code || '|' || e.entry_type || '|' ||
      to_char(round(e.amount, 2), 'FM99999999999999999990.00') || '|' || e.currency,
      E'\n' order by a.code, e.entry_type, e.line_no, e.id::text
    ), '')
  from public.ledger_entries e
  join public.ledger_accounts a on a.id = e.account_id
  where e.journal_id = p_journal_id;
$$;

-- meta, provider y external_ref quedan FUERA de la firma: son anotaciones que
-- se pueden completar después de cerrar; lo firmado es lo que mueve dinero.
create or replace function public.ledger_journal_hash(
  p_prev_hash text, p_operation text, p_idempotency_key text,
  p_user_id uuid, p_journal_id uuid
) returns text language sql stable security definer
set search_path = public, extensions, pg_temp as $$
  select encode(
    digest(
      coalesce(p_prev_hash, '')    || '#' ||
      coalesce(p_operation, '-')   || '#' ||
      coalesce(p_idempotency_key, '-') || '#' ||
      coalesce(p_user_id::text, '-')   || '#' ||
      public.ledger_canonical_lines(p_journal_id),
      'sha256'),
    'hex');
$$;

-- ---------------------------------------------------------------------
-- 4. Cierre encadenado
-- ---------------------------------------------------------------------
-- BEFORE, para que la firma viaje en la propia actualización de estado:
-- un asiento publicado está firmado sí o sí, sin estado intermedio.
create or replace function public.ledger_journal_chain_on_close()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  cab public.ledger_head;
begin
  if NEW.status = 'posted' and OLD.status is distinct from 'posted' then
    -- El candado de fila serializa los cierres: dos asientos concurrentes no
    -- pueden reclamar el mismo eslabón anterior; el segundo espera.
    select * into cab from public.ledger_head where id = 'head' for update;
    NEW.prev_hash := cab.last_hash;
    NEW.chain_seq := cab.journal_count + 1;
    NEW.hash := public.ledger_journal_hash(
      cab.last_hash, NEW.operation, NEW.idempotency_key, NEW.user_id, NEW.id);
    if NEW.hash is null then
      raise exception 'No se pudo firmar el asiento %', NEW.id;
    end if;
    update public.ledger_head
       set last_hash = NEW.hash, journal_count = NEW.chain_seq, updated_at = now()
     where id = 'head';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ledger_journal_chain_on_close on public.ledger_journals;
create trigger trg_ledger_journal_chain_on_close
  before update of status on public.ledger_journals
  for each row execute function public.ledger_journal_chain_on_close();

-- 4.1 La firma ya puesta no se reescribe. Sin esto, borrar el rastro de un
-- asiento falso sería tan fácil como cambiarle el hash y el anterior.
create or replace function public.ledger_journal_chain_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if OLD.hash is null then
    return NEW;  -- el cierre que estampa la firma, o el relleno histórico
  end if;
  if NEW.hash       is distinct from OLD.hash
    or NEW.prev_hash is distinct from OLD.prev_hash
    or NEW.chain_seq is distinct from OLD.chain_seq
    or NEW.operation is distinct from OLD.operation
    or NEW.idempotency_key is distinct from OLD.idempotency_key then
    raise exception 'La firma de un asiento firmado no se modifica: %',
      coalesce(NEW.id, OLD.id);
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ledger_journal_chain_immutable on public.ledger_journals;
create trigger trg_ledger_journal_chain_immutable
  before update on public.ledger_journals
  for each row execute function public.ledger_journal_chain_immutable();

-- ---------------------------------------------------------------------
-- 5. Firmar lo que ya estaba cerrado antes de esta migración
-- ---------------------------------------------------------------------
-- Sin esto, el libro nacería con un agujero: los asientos anteriores al lote
-- B-2 quedarían fuera de la cadena y la conciliación no podría afirmar nada
-- sobre ellos.
do $$
declare
  ids  uuid[];
  iid  uuid;
  j    record;
  cab  record;
  h    text;
  n    bigint := 0;
begin
  select coalesce(array_agg(id order by coalesce(posted_at, created_at), id), '{}'::uuid[])
    into ids
    from public.ledger_journals
   where status in ('posted','reversed') and hash is null;

  if ids is null or array_length(ids, 1) is null then
    return;
  end if;

  select last_hash, journal_count into cab from public.ledger_head where id = 'head' for update;

  foreach iid in array ids loop
    select operation, idempotency_key, user_id
      into j
      from public.ledger_journals where id = iid;
    n := n + 1;
    h := public.ledger_journal_hash(cab.last_hash, j.operation, j.idempotency_key, j.user_id, iid);
    update public.ledger_journals
       set prev_hash = cab.last_hash, hash = h, chain_seq = cab.journal_count + n
     where id = iid;
    cab.last_hash := h;
  end loop;

  update public.ledger_head
     set last_hash = cab.last_hash, journal_count = cab.journal_count + n, updated_at = now()
   where id = 'head';
  raise notice 'Cadena completada: % asientos históricos firmados', n;
end $$;

-- ---------------------------------------------------------------------
-- 6. Verificación de la cadena
-- ---------------------------------------------------------------------
create or replace function public.ledger_verify_chain()
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  j        record;
  cab      public.ledger_head;
  prev     text := 'EGPAY-GENESIS-000000000000000000000000';
  esperado text;
  rotos    jsonb := '[]'::jsonb;
  n        bigint := 0;
begin
  select * into cab from public.ledger_head where id = 'head';
  for j in select id, operation, idempotency_key, user_id, prev_hash, hash
              from public.ledger_journals
             where hash is not null
             order by chain_seq
  loop
    n := n + 1;
    if j.prev_hash is distinct from prev then
      rotos := rotos || jsonb_build_object('journal_id', j.id, 'motivo', 'eslabón',
                                           'esperado', prev, 'encontrado', j.prev_hash);
    else
      esperado := public.ledger_journal_hash(prev, j.operation, j.idempotency_key, j.user_id, j.id);
      if j.hash is distinct from esperado then
        rotos := rotos || jsonb_build_object('journal_id', j.id, 'motivo', 'contenido',
                                             'esperado', esperado, 'encontrado', j.hash);
      end if;
    end if;
    prev := j.hash;
  end loop;

  if n > 0 and cab.last_hash is distinct from prev then
    rotos := rotos || jsonb_build_object('journal_id', null, 'motivo', 'cabecera',
                                         'esperado', cab.last_hash, 'encontrado', prev);
  end if;

  return jsonb_build_object('firmados', n, 'rotos', jsonb_array_length(rotos),
                            'fallos', rotos, 'secuencia', cab.journal_count);
end $$;

-- ---------------------------------------------------------------------
-- 7. Catálogo de asientos
-- ---------------------------------------------------------------------
-- Un monedero es PASIVO del operador: crece al Haber. Las plantillas deciden
-- las patas; quien llama sólo nombra la operación. ledger_post sigue siendo
-- el único camino que escribe, comprueba el cuadre y mueve los monederos.
create or replace function public.ledger_line(p_target jsonb, p_type text, p_amount numeric, p_memo text)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select p_target || jsonb_build_object(
    'entry_type', p_type,
    'amount',     round(coalesce(p_amount, 0), 2),
    'memo',       p_memo);
$$;

create or replace function public.ledger_lines(
  p_kind            text,
  p_user_id         uuid,
  p_amount          numeric,
  p_fee             numeric,
  p_counterparty_id uuid,
  p_memo            text
) returns jsonb language plpgsql immutable set search_path = public, extensions, pg_temp as $$
declare
  a    numeric := round(coalesce(p_amount, 0), 2);
  f    numeric := round(coalesce(p_fee, 0), 2);
  w    jsonb;
  otro jsonb;
  li   jsonb := '[]'::jsonb;
begin
  if p_user_id is null then raise exception 'ledger_lines: falta el usuario'; end if;
  if p_kind = 'fee_only' then
    if f <= 0 then raise exception 'ledger_lines: fee_only necesita comision positiva'; end if;
  elsif a <= 0 then
    raise exception 'ledger_lines: importe no positivo';
  end if;
  if f < 0 then raise exception 'ledger_lines: comisión negativa'; end if;

  w    := jsonb_build_object('wallet_user_id', p_user_id);
  otro := case when p_counterparty_id is not null
               then jsonb_build_object('wallet_user_id', p_counterparty_id) end;

  -- El monedero del usuario baja
  if p_kind in ('withdraw','p2p_send','service_payment','p2p_escrow',
                'payout_pending','offline_payment_sync','unclassified_out') then
    li := li || public.ledger_line(w, 'debit', a + f, p_memo);
  end if;
  -- El monedero del usuario sube
  if p_kind in ('deposit','p2p_release','payout_cancelled','refund',
                'opening','unclassified_in') then
    li := li || public.ledger_line(w, 'credit', a, p_memo);
  end if;

  if p_kind = 'deposit' then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-CASH'), 'debit', a + f, p_memo);

  elsif p_kind = 'withdraw' then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-CASH'), 'credit', a, p_memo);

  elsif p_kind = 'p2p_send' then
    if otro is null then raise exception 'p2p_send necesita destinatario'; end if;
    li := li || public.ledger_line(otro, 'credit', a, p_memo);

  -- El dinero pasa a responsabilidad de la plataforma: retención de una
  -- pendiente, pago a proveedor, payout sin liquidar o cobro offline.
  elsif p_kind in ('service_payment','p2p_escrow','payout_pending','offline_payment_sync') then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-SUSPENSE'), 'credit', a, p_memo);

  -- Y sale de esa responsabilidad: se libera, se cancela o se devuelve.
  elsif p_kind in ('p2p_release','payout_cancelled','refund') then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-SUSPENSE'), 'debit', a, p_memo);

  elsif p_kind in ('opening','unclassified_in') then
    -- No se afirma que el efectivo esté en un banco: se registra que el saldo
    -- existe y aún no está respaldado.
    li := li || public.ledger_line(jsonb_build_object('account','SYS-DISCREPANCY'), 'debit', a, p_memo);

  elsif p_kind = 'unclassified_out' then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-DISCREPANCY'), 'credit', a, p_memo);

  -- Salida de dinero en dos tiempos: al liquidar, el puente se descarga contra
  -- el efectivo de la entidad autorizada.
  elsif p_kind = 'payout_settled' then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-SUSPENSE'), 'debit', a, p_memo)
             || public.ledger_line(jsonb_build_object('account','SYS-CASH'), 'credit', a, p_memo);

  elsif p_kind = 'fee_only' then
    li := li || public.ledger_line(w, 'debit', f, p_memo)
             || public.ledger_line(jsonb_build_object('account','SYS-FEES'), 'credit', f, p_memo);

  else
    raise exception 'Tipo de asiento desconocido: %', p_kind;
  end if;

  if f > 0 and p_kind not in ('fee_only','payout_settled') then
    li := li || public.ledger_line(jsonb_build_object('account','SYS-FEES'), 'credit', f, p_memo);
  end if;

  return li;
end $$;

-- Post por plantilla: resuelve las patas, delega en ledger_post y anota el
-- contexto del proveedor. La anotación va después del cierre porque no forma
-- parte de lo firmado.
create or replace function public.ledger_post_kind(
  p_kind              text,
  p_user_id           uuid,
  p_amount            numeric,
  p_idempotency_key   text,
  p_fee               numeric default 0,
  p_counterparty_id   uuid    default null,
  p_concept           text    default null,
  p_reference         text    default null,
  p_provider          text    default null,
  p_external_ref      text    default null,
  p_meta              jsonb   default '{}'::jsonb,
  p_requires_approval boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  res jsonb;
begin
  res := public.ledger_post(
    p_user_id, p_kind, p_idempotency_key, coalesce(p_concept, p_kind),
    public.ledger_lines(p_kind, p_user_id, p_amount, p_fee, p_counterparty_id, p_concept),
    p_reference, p_requires_approval);

  update public.ledger_journals
     set counterparty_user_id = coalesce(counterparty_user_id, p_counterparty_id),
         provider             = coalesce(provider, p_provider),
         external_ref         = coalesce(external_ref, p_external_ref),
         meta                 = coalesce(meta, '{}'::jsonb) || coalesce(p_meta, '{}'::jsonb)
   where id = (res->>'journal_id')::uuid;

  return res;
end $$;

-- ---------------------------------------------------------------------
-- 8. Permisos: las funciones contables siguen siendo de servidor
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.ledger_canonical_lines(uuid)',
    'public.ledger_journal_hash(text,text,text,uuid,uuid)',
    'public.ledger_verify_chain()',
    'public.ledger_line(jsonb,text,numeric,text)',
    'public.ledger_lines(text,uuid,numeric,numeric,uuid,text)',
    'public.ledger_post_kind(text,uuid,numeric,text,numeric,uuid,text,text,text,text,jsonb,boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

alter table public.ledger_head enable row level security;
revoke all on public.ledger_head from anon, authenticated;
grant select, insert, update on public.ledger_head to service_role;

-- ---------------------------------------------------------------------
-- 9. Cuadre por operación: cuánto movió cada tipo de asiento y si alguno
--    publicado se quedó sin firmar.
-- ---------------------------------------------------------------------
create or replace view public.ledger_operations_v as
select j.operation,
       count(*)                                    as asientos,
       coalesce(sum(j.total_amount), 0)            as importe,
       count(*) filter (where j.status = 'posted') as cerrados,
       count(*) filter (where j.status = 'posted'
                              and j.hash is null)  as sin_firmar
  from public.ledger_journals j
 group by j.operation;

-- ---------------------------------------------------------------------
-- 10. Comprobación a la vista
-- ---------------------------------------------------------------------
select
  (select journal_count from public.ledger_head where id = 'head')                       as secuencia,
  (select count(*) from public.ledger_journals where hash is not null)                   as firmados,
  (select ((v->'rotos') #>> '{}')::int from public.ledger_verify_chain() v)             as cadena_rota,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ledger_post_kind','ledger_verify_chain','ledger_lines','ledger_line')) as funciones_nuevas;

commit;
