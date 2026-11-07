-- EGChat - Esquema de Mi Djangue (tandas de ahorro rotativo).
--
-- Que esta pasando hoy: las 15 pantallas de djangue existen y se abren desde
-- Mensajeria y desde notificaciones, pero las 12 rutas del API respondian 404
-- (/api/djangue*, /api/upload/djangue-logo). Este lote crea las siete tablas
-- del esquema y el API ya las usa: la cuota se cobra con ledger_post contra el
-- monedero del integrante y la entrega del pozo se abona al beneficiario desde
-- SYS-SUSPENSE, asi que el dinero nunca se crea ni se pierde por el camino.
--
-- Hay dos formas conocidas de estas tablas en instalaciones anteriores. La de
-- `migrations/EJECUTAR_TODO_EN_UN_PASO.sql` llama a la columna de turno
-- `turn_order`; la de `djangue_tables_only.sql` (la que se pego en Supabase en
-- su momento) la llama `turn_number`. Este lote converge a `turn_order`: si
-- encuentra `turn_number`, lo copia, y deja un disparador que mantiene las dos
-- en sincronia para que un alta hecha por el API nunca choque con el NOT NULL
-- de la forma vieja. Todo es re-pegable.
--
-- Aditivo: no borra datos, no toca permisos ni RLS de las tablas existentes y
-- no modifica ninguna funcion del libro mayor. El API entra con service_role.

do $dj$
begin
execute $c$create table if not exists public.djangue_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  logo_url text,
  slogan text,
  frequency text not null check (frequency in ('daily','weekly','monthly','annual')),
  quota_amount numeric(12,2) not null,
  currency text not null default 'XAF',
  max_members int not null default 12,
  penalty_percent numeric(5,2) not null default 10.00,
  notification_days_before int not null default 10,
  notification_final_days int not null default 5,
  status text not null default 'active' check (status in ('active','paused','completed','cancelled')),
  owner_id uuid not null references public.users(id) on delete cascade,
  secretary_id uuid references public.users(id) on delete set null,
  chat_group_id uuid,
  wallet_id uuid,
  current_turn int not null default 1,
  total_turns int not null default 0,
  period_start_date timestamptz,
  period_end_date timestamptz,
  next_payout_at timestamptz,
  total_mora_collected numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_groups
  add column if not exists description text,
  add column if not exists logo_url text,
  add column if not exists slogan text,
  add column if not exists currency text default 'XAF',
  add column if not exists max_members int default 12,
  add column if not exists penalty_percent numeric(5,2) default 10.00,
  add column if not exists notification_days_before int default 10,
  add column if not exists notification_final_days int default 5,
  add column if not exists status text default 'active',
  add column if not exists secretary_id uuid,
  add column if not exists chat_group_id uuid,
  add column if not exists wallet_id uuid,
  add column if not exists current_turn int default 1,
  add column if not exists total_turns int default 0,
  add column if not exists period_start_date timestamptz,
  add column if not exists period_end_date timestamptz,
  add column if not exists next_payout_at timestamptz,
  add column if not exists total_mora_collected numeric(12,2) default 0,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now()$c$;
execute $c$create table if not exists public.djangue_wallets (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.djangue_groups(id) on delete cascade,
  balance numeric(12,2) not null default 0,
  currency text not null default 'XAF',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_wallets
  add column if not exists balance numeric(12,2) default 0,
  add column if not exists currency text default 'XAF',
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now()$c$;
execute $c$create table if not exists public.djangue_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.djangue_groups(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  turn_order int not null,
  status text not null default 'active' check (status in ('active','inactive','removed')),
  joined_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_members
  add column if not exists turn_order int,
  add column if not exists status text default 'active',
  add column if not exists joined_at timestamptz default now()$c$;
execute $c$create table if not exists public.djangue_contributions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.djangue_groups(id) on delete cascade,
  member_id uuid not null references public.djangue_members(id) on delete cascade,
  user_id uuid not null references public.users(id),
  turn_number int not null,
  amount numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending','paid','failed','justified')),
  justification_note text,
  paid_at timestamptz,
  transaction_id uuid,
  created_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_contributions
  add column if not exists amount numeric(12,2),
  add column if not exists status text default 'pending',
  add column if not exists justification_note text,
  add column if not exists paid_at timestamptz,
  add column if not exists transaction_id uuid,
  add column if not exists created_at timestamptz default now()$c$;
execute $c$create table if not exists public.djangue_penalties (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.djangue_groups(id) on delete cascade,
  member_id uuid not null references public.djangue_members(id) on delete cascade,
  user_id uuid not null references public.users(id),
  turn_number int not null,
  penalty_amount numeric(12,2) not null,
  penalty_percent numeric(5,2) not null,
  amount numeric(12,2),
  reason text,
  status text default 'pending' check (status in ('pending','paid')),
  paid_at timestamptz,
  payment_method text default 'wallet',
  applied_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_penalties
  add column if not exists amount numeric(12,2),
  add column if not exists reason text,
  add column if not exists status text default 'pending',
  add column if not exists paid_at timestamptz,
  add column if not exists payment_method text default 'wallet',
  add column if not exists applied_at timestamptz default now()$c$;
execute $c$create table if not exists public.djangue_notifications (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.djangue_groups(id) on delete cascade,
  user_id uuid not null references public.users(id),
  type text not null check (type in ('reminder_10days','reminder_daily','payment_received','turn_completed','penalty_applied')),
  title text not null,
  message text not null,
  read boolean not null default false,
  sent_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_notifications
  add column if not exists type text,
  add column if not exists title text,
  add column if not exists message text,
  add column if not exists read boolean default false,
  add column if not exists sent_at timestamptz default now()$c$;
execute $c$create table if not exists public.djangue_payouts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.djangue_groups(id) on delete cascade,
  beneficiary_id uuid not null references public.users(id),
  turn_number int not null,
  amount numeric(12,2) not null,
  expected_amount numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
)$c$;
execute $c$alter table public.djangue_payouts
  add column if not exists expected_amount numeric(12,2),
  add column if not exists status text default 'pending',
  add column if not exists paid_at timestamptz,
  add column if not exists created_at timestamptz default now()$c$;
if exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'djangue_members' and column_name = 'turn_number') then
  execute $c$update public.djangue_members set turn_order = turn_number where turn_order is null$c$;
  execute $c$create or replace function public.djangue_members_sync_turn() returns trigger language plpgsql as $g$
    begin
      if new.turn_order is null then new.turn_order := new.turn_number; end if;
      if new.turn_number is null then new.turn_number := new.turn_order; end if;
      return new;
    end $g$$c$;
  execute $c$drop trigger if exists djangue_members_sync_turn on public.djangue_members$c$;
  execute $c$create trigger djangue_members_sync_turn before insert or update on public.djangue_members
            for each row execute function public.djangue_members_sync_turn()$c$;
end if;
execute $c$create unique index if not exists djangue_wallets_group_uidx on public.djangue_wallets (group_id)$c$;
execute $c$create unique index if not exists djangue_members_group_user_uidx on public.djangue_members (group_id, user_id)$c$;
execute $c$create unique index if not exists djangue_members_group_turn_uidx on public.djangue_members (group_id, turn_order)$c$;
execute $c$create index if not exists idx_djangue_groups_owner on public.djangue_groups (owner_id)$c$;
execute $c$create index if not exists idx_djangue_members_group on public.djangue_members (group_id)$c$;
execute $c$create index if not exists idx_djangue_members_user on public.djangue_members (user_id)$c$;
execute $c$create index if not exists idx_djangue_contributions_group on public.djangue_contributions (group_id)$c$;
execute $c$create index if not exists idx_djangue_contributions_user on public.djangue_contributions (user_id)$c$;
execute $c$create index if not exists idx_djangue_penalties_user_status on public.djangue_penalties (user_id, status)$c$;
execute $c$create index if not exists idx_djangue_notifications_user on public.djangue_notifications (user_id)$c$;
execute $c$alter table public.chats add column if not exists group_type text default 'regular'$c$;
end $dj$;
select 'tablas' as medida, (select count(*) from information_schema.tables
  where table_schema='public' and table_name in ('djangue_groups','djangue_wallets','djangue_members','djangue_contributions','djangue_penalties','djangue_notifications','djangue_payouts'))::text as valor
union all
select 'columnas_grupo', (select count(*) from information_schema.columns where table_schema='public' and table_name='djangue_groups')::text
union all
select 'columnas_miembros', (select count(*) from information_schema.columns where table_schema='public' and table_name='djangue_members')::text
union all
select 'columna_turno', (select count(*) from information_schema.columns where table_schema='public' and table_name='djangue_members' and column_name in ('turn_order','turn_number'))::text
union all
select 'columnas_aportes', (select count(*) from information_schema.columns where table_schema='public' and table_name='djangue_contributions')::text
union all
select 'columnas_payouts', (select count(*) from information_schema.columns where table_schema='public' and table_name='djangue_payouts')::text
union all
select 'indices', (select count(*) from pg_indexes where schemaname='public' and indexname in ('djangue_wallets_group_uidx','djangue_members_group_user_uidx','djangue_members_group_turn_uidx','idx_djangue_groups_owner','idx_djangue_members_group','idx_djangue_members_user','idx_djangue_contributions_group','idx_djangue_contributions_user','idx_djangue_penalties_user_status','idx_djangue_notifications_user'))::text
union all
select 'chats_group_type', (select count(*) from information_schema.columns where table_schema='public' and table_name='chats' and column_name='group_type')::text
union all
select 'filas_djangue', (select count(*) from public.djangue_groups)::text;
