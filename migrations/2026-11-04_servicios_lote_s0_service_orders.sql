-- EGPay - Lote S0: la tabla donde viven las solicitudes sin canal de cobro.
--
-- Por que hace falta: `service_orders` la usan las rutas del API
-- (index.js:5265, 5574, 5580, 5609, 5648, 5677, 5701, 5724, 5792) y hasta aqui
-- solo existia en la base de pruebas, creada a mano durante el desarrollo. Ninguna
-- migracion la creaba, asi que en produccion `/api/servicios/solicitud` responderia
-- 502 en cuanto el API desplegado intentara insertar la fila.
--
-- Forma identica a la fila local que proba el arnes S4 (22/22): order_ref unico
-- es la referencia que ve el cliente y la clave del reintento, amount numeric 0
-- significa "sin cobro", y payload/response guardan lo que envio cada modal.
--
-- RLS activada y sin politicas, igual que en S1/S2/S3: el unico acceso legitimo es
-- el API con la clave de servicio.

create table if not exists public.service_orders (
  id           uuid default gen_random_uuid(),
  order_ref    text,
  user_id      uuid,
  provider     text,
  service_type text,
  contract_ref text,
  amount       numeric,
  status       text,
  payload      jsonb default '{}'::jsonb,
  response     jsonb default '{}'::jsonb,
  created_at   timestamptz default now()
);

-- add column if not exists por si la base real ya tiene la tabla con otra forma.
alter table public.service_orders add column if not exists order_ref    text;
alter table public.service_orders add column if not exists user_id      uuid;
alter table public.service_orders add column if not exists provider     text;
alter table public.service_orders add column if not exists service_type text;
alter table public.service_orders add column if not exists contract_ref text;
alter table public.service_orders add column if not exists amount       numeric;
alter table public.service_orders add column if not exists status       text;
alter table public.service_orders add column if not exists payload      jsonb default '{}'::jsonb;
alter table public.service_orders add column if not exists response     jsonb default '{}'::jsonb;
alter table public.service_orders add column if not exists created_at   timestamptz default now();

-- Las llaves van comprobadas: si ya existian, el alter no las vuelve a crear y el
-- pegado no se corta a mitad.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.service_orders'::regclass and contype = 'p') then
    alter table public.service_orders add constraint service_orders_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.service_orders'::regclass
                   and conname = 'service_orders_order_ref_key') then
    alter table public.service_orders add constraint service_orders_order_ref_key unique (order_ref);
  end if;
end $$;

create index if not exists service_orders_user_created_idx
  on public.service_orders (user_id, created_at desc);

create index if not exists service_orders_provider_status_idx
  on public.service_orders (provider, status);

alter table public.service_orders enable row level security;
