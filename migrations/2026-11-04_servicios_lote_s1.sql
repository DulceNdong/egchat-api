-- EGPay - Lote S1: la factura existe en la base y el pago vale lo que dice la
-- factura.
--
-- Qué cierra el agujero de hoy: `consultar` devolvía un importe sacado de
-- Math.random() (index.js:5368, 5386, 5404) y `pagar` debitaba el importe que
-- mandaba el cliente (index.js:5374-5376). Es decir: el usuario fijaba cuánto
-- pagaba de una deuda que la plataforma no conocía. Se podía liquidar una
-- factura de 15.000 pagando 1 XAF, o pagar la misma dos veces.
--
-- A partir de aquí:
--   - service_bills guarda la deuda real (proveedor, contrato, importe, periodo,
--     vencimiento, estado). Una factura pendiente es única por
--     (proveedor, contrato, periodo, importe): repetir el mismo fichero de
--     morosos no duplica deudas.
--   - service_pay_bill() es la única forma de pagar. Bloquea la fila (for
--     update), verifica que sigue pendiente, debita POR LO QUE DICE LA FILA —
--     nunca por lo que mande el cliente — y la marca pagada con el asiento que
--     la liquidó. Dos pulsaciones simultáneas del mismo botón: la segunda
--     encuentra 'paid' y no mueve dinero.
--   - La contrapartida sigue siendo SYS-SUSPENSE: el operador retiene ese dinero
--     hasta que lo liquide con SEGESA/SNGE/DGI. No se inventa caja.
--
-- Nadie puede editar el importe de una factura ya pagada: la función de guarda
-- lo corta. Las facturas entran por carga del proveedor (service_role), no por
-- la app.

begin;

create table if not exists public.service_bills (
  id           uuid primary key default gen_random_uuid(),
  provider     text   not null check (provider in ('segesa','snge','dgi')),
  contract_ref text   not null,
  user_id      uuid   references public.users(id) on delete set null,
  amount       numeric(14,2) not null check (amount > 0),
  currency     text   not null default 'XAF',
  period       text,
  concept      text,
  due_date     date,
  status       text   not null default 'pending'
                          check (status in ('pending','paid','void')),
  paid_at      timestamptz,
  journal_id   uuid   references public.ledger_journals(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Una misma deuda no se carga dos veces. period admite null, así que se
-- normaliza con coalesce para que el indice unico la trate tambien.
create unique index if not exists uix_service_bills_unica
  on public.service_bills (provider, contract_ref, coalesce(period, ''), amount)
  where status <> 'void';

create index if not exists ix_service_bills_deuda
  on public.service_bills (provider, contract_ref, status);
create index if not exists ix_service_bills_usuario
  on public.service_bills (user_id, status);

-- Nadie toca el saldo de una factura pagada, ni el importe, ni el asiento.
create or replace function public.service_bills_inmutable() returns trigger
language plpgsql as $$
begin
  if old.status = 'paid' then
    raise exception 'La factura % ya esta pagada: no se edita ni se anula', old.id;
  end if;
  if new.amount is distinct from old.amount then
    raise exception 'El importe de una factura no se cambia: anula (void) y carga otra';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_service_bills_inmutable on public.service_bills;
create trigger trg_service_bills_inmutable
  before update on public.service_bills
  for each row execute function public.service_bills_inmutable();

-- La unica puerta del pago de servicios. Devuelve ok/fallo sin reventar cuando
-- la factura ya esta pagada, para que el boton duplicado sea inofensivo.
create or replace function public.service_pay_bill(
  p_bill_id uuid,
  p_user_id uuid,
  p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b   public.service_bills;
  r   jsonb;
  key text;
begin
  if p_user_id is null then
    raise exception 'service_pay_bill necesita el usuario que paga';
  end if;

  select * into b from public.service_bills where id = p_bill_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BILL_NOT_FOUND', 'bill_id', p_bill_id);
  end if;
  if b.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'BILL_NOT_PENDING',
      'status', b.status, 'bill_id', b.id, 'journal_id', b.journal_id);
  end if;
  if b.user_id is not null and b.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'BILL_OTHER_USER', 'bill_id', b.id);
  end if;

  key := coalesce(nullif(p_idempotency_key, ''), 'BILL-' || b.id);

  -- El asiento es el que mueve el dinero: debe el monedero del cliente, haber la
  -- cuenta puente del proveedor. ledger_post es idempotente por clave.
  r := public.ledger_post(
    p_user_id,
    'pago_servicio',
    key,
    b.provider || ' ' || b.contract_ref || coalesce(' - ' || b.period, ''),
    jsonb_build_array(
      jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'debit',  'amount', b.amount),
      jsonb_build_object('account', 'SYS-SUSPENSE',    'entry_type', 'credit', 'amount', b.amount)
    ),
    'BILL-' || b.id
  );

  update public.service_bills
     set status = 'paid',
         paid_at = now(),
         journal_id = (r->>'journal_id')::uuid,
         updated_at = now()
   where id = b.id;

  return jsonb_build_object(
    'ok', true,
    'bill_id', b.id,
    'provider', b.provider,
    'contract_ref', b.contract_ref,
    'amount', b.amount,
    'currency', b.currency,
    'period', b.period,
    'journal_id', r->>'journal_id',
    'status', 'paid'
  );
end;
$$;

-- Permisos: la tabla y la funcion son del servicio. La app no escribe facturas
-- y tampoco las lee por su cuenta: todo pasa por el API con service_role, asi
-- que RLS se queda en "denegar todo" y no hace falta politica para anon o
-- authenticated.
alter table public.service_bills enable row level security;

revoke all on public.service_bills from anon, authenticated;
grant select, insert, update, delete on public.service_bills to service_role;
revoke all on function public.service_pay_bill(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_pay_bill(uuid, uuid, text) to service_role;

-- Comprobacion del pegado, en lista vertical: una fila por medida. Espera
-- tabla=1, indices=4 (las tres de este lote mas la clave primaria), gatillos=1,
-- pagadas=0, funcion=1, cadenas_rotas=0.
select 'tabla' as medida,
       (select count(*) from information_schema.tables
          where table_schema = 'public' and table_name = 'service_bills')::text as valor
union all
select 'indices',
       (select count(*) from pg_indexes
          where schemaname = 'public' and tablename = 'service_bills')::text
union all
select 'gatillos',
       (select count(*) from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'service_bills'
           and not t.tgisinternal)::text
union all
select 'pagadas', (select count(*) from public.service_bills where status = 'paid')::text
union all
select 'funcion',
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'service_pay_bill')::text
union all
select 'cadenas_rotas',
       (select (v->>'rotos')::int from public.ledger_verify_chain() v)::text;

commit;
