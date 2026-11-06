-- EGPay - Lote E: canales sin telefono inteligente (USSD, SMS, IVR).
--
-- Va encima de 2026-11-02_ledger_lote_b.sql y 2026-11-03_ledger_lote_b2.sql
-- (ambos ya aplicados). No anade contabilidad: el dinero de un pago marcado en
-- un telefonobasico se asienta con ledger_post_kind(), la misma plantilla y el
-- mismo libro que usa la app.
--
-- Que representa:
--   channel_sessions - el estado del menu marcado por cada numero. Es una
--                      maquina de estados, no un monedero: no guarda saldos.
--   channel_events   - traza de lo ocurrido en el canal (consultas, pagos
--                      cancelados, PIN bloqueado). Sirve para auditar sin
--                      conservar el telefono en claro ni el PIN en ningun sitio.
--
-- Reglas de integridad:
--   - session_key unica: dos peticiones del mismo numero comparten sesion, y por
--     eso un reintento de la pasarela no abre un recorrido paralelo.
--   - Nada de estas tablas guarda un numero completo ni un PIN: msisdn_ref es
--     una huella corta y `draft` solo lleva el destinatario y el importe.
--   - Los eventos no se editan ni se borran: son prueba de lo marcado.
--   - Solo el API (service_role) las lee. anon y authenticated no tienen acceso:
--     una sesion de USSD ajena no puede leerse desde la API publica.
--
-- Idempotente: se puede volver a pegar sin efecto adicional.

begin;

create table if not exists public.channel_sessions (
  id           uuid primary key default gen_random_uuid(),
  session_key  text not null,
  -- sandbox | ussd | sms | ivr | el id de la pasarela que registro el canal
  channel      text not null,
  -- huella corta + ultimos 4 digitos. Nunca el numero completo.
  msisdn_ref   text not null,
  user_id      uuid references public.users(id) on delete set null,
  locale       text not null default 'es' check (locale in ('es','fr','en','pt')),
  -- menu | payee | pay_amount | pay_pin | pay_confirm | topup_code | language
  state        text not null default 'menu'
               check (state in ('menu','payee','pay_amount','pay_pin','pay_confirm','topup_code','language','closed')),
  -- Borrador del recorrido en curso: destinatario e importe. Sin secretos.
  draft        jsonb not null default '{}'::jsonb,
  pin_verified boolean not null default false,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  closed_at    timestamptz
);

create unique index if not exists uq_channel_sessions_key
  on public.channel_sessions (session_key);
create index if not exists ix_channel_sessions_user
  on public.channel_sessions (user_id, created_at desc);
create index if not exists ix_channel_sessions_stale
  on public.channel_sessions (expires_at)
  where state <> 'menu';

create table if not exists public.channel_events (
  id           uuid primary key default gen_random_uuid(),
  session_key  text not null,
  channel      text not null,
  msisdn_ref   text not null,
  -- balance | activity | pay | topup | auth | session | exit | unknown_msisdn
  kind         text not null,
  -- ok | cancelled | failed_* | pin_blocked | payee_not_found | daily_limit | ...
  outcome      text not null,
  amount       numeric(18,2),
  reference    text,
  created_at   timestamptz not null default now()
);

create index if not exists ix_channel_events_session
  on public.channel_events (session_key, created_at desc);
create index if not exists ix_channel_events_problem
  on public.channel_events (outcome, created_at desc)
  where outcome not in ('ok');

-- El registro del canal es prueba de lo marcado: no se edita ni se borra.
create or replace function public.channel_events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'el registro del canal es inmutable';
end;
$$;

drop trigger if exists channel_events_no_update on public.channel_events;
create trigger channel_events_no_update
  before update or delete on public.channel_events
  for each row execute function public.channel_events_immutable();

-- Una sesion cerrada no vuelve a abrirse: la pasarela debe empezar una nueva.
-- Un borrador caducado sobre un saldo que ya cambio no puede ejecutarse.
create or replace function public.channel_sessions_no_resurrect() returns trigger
language plpgsql as $$
begin
  if old.state = 'closed' and new.state is distinct from old.state then
    raise exception 'una sesion cerrada no vuelve a abrirse; la pasarela debe empezar una nueva';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists channel_sessions_stay_closed on public.channel_sessions;
create trigger channel_sessions_stay_closed
  before update on public.channel_sessions
  for each row execute function public.channel_sessions_no_resurrect();

-- Sesiones vivas a mitad de un recorrido: lo que ve la cola administrativa.
create or replace view public.channel_sessions_active as
  select session_key, channel, msisdn_ref, user_id, locale, state, expires_at, updated_at
    from public.channel_sessions
   where state <> 'menu'
     and expires_at > now()
   order by expires_at asc;

-- Nadie mas que el API toca estas tablas. El servicio lee y escribe; anon y
-- authenticated quedan fuera (una sesion de canal ajena no es consultable).
alter table public.channel_sessions enable row level security;
alter table public.channel_events  enable row level security;

revoke all on table public.channel_sessions from public, anon, authenticated;
revoke all on table public.channel_events  from public, anon, authenticated;
revoke all on public.channel_sessions_active from public, anon, authenticated;

grant select, insert, update, delete on table public.channel_sessions to service_role;
grant select, insert               on table public.channel_events  to service_role;
grant select on public.channel_sessions_active to service_role;

-- Comprobacion a la vista: las dos tablas existen, el registro del canal es
-- inmutable y la proteccion esta activa. Debe dar 2 | 2 | 2 | 0.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('channel_sessions','channel_events')) as tablas,
  (select count(*) from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and c.relname in ('channel_sessions','channel_events')) as gatillos,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('channel_sessions','channel_events')
      and c.relrowsecurity) as rls_activa,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('channel_sessions','channel_events')
      and grantee in ('anon','authenticated')) as accesos_publicos;

commit;
