-- EGPay - Lote S2: el precio lo fija una tabla, no el cliente ni el código.
--
-- Lo que cierra:
--   - `/api/supermarkets/orders` (index.js:5610) sumaba `items[].price` llegada
--     del cuerpo de la petición y debitaba el monedero con ese total. Quien
--     llama decide cuánto vale un saco de arroz: puede pagar 1 XAF por un pedido
--     de 20.000 y el operador queda debiendo al comercio la diferencia.
--   - `/api/servicios/correos/enviar` (index.js:5565) y `/api/taxi/request`
--     (index.js:5715) cotizan 2.500/5.000 y 800/1.500/3.500 guardados dentro de
--     un `if` de JavaScript y **no cobran nada**: registran el servicio y
--     devuelven la tarifa como si el viaje o el paquete estuvieran pagados.
--   - La comisión CEMAC (index.js:3984) es un 750 literal en el código.
--
-- A partir de aquí el precio vive en `service_tariffs` / `service_products`, la
-- única forma de cargos es `service_charge()` / `service_basket_charge()` (leen
-- la tabla y asientan por lo que dice la tabla), y la contrapartida vuelve a ser
-- SYS-SUSPENSE: el operador retiene hasta liquidar con el proveedor. No se
-- inventa caja.
--
-- `taxi_rides` se crea aquí porque el cobro del viaje exige que el viaje exista
-- como fila: sin tabla, la ruta caía al almacén en memoria y se habría cobrado
-- por un viaje que no está escrito en ningún sitio.
--
-- Idempotente: el cargo lleva clave `SER-<servicio>-<referencia>`, así que un
-- reintento del mismo pedido devuelve el asiento ya hecho en vez de cobrar otra
-- vez. Las semillas usan `on conflict do nothing` para no pisar tarifas que el
-- operador ya haya corregido.

begin;

create table if not exists public.service_tariffs (
  service    text        not null,
  variant    text        not null,
  amount     numeric(14,2) not null check (amount > 0),
  currency   text        not null default 'XAF',
  concept    text,
  active     boolean     not null default true,
  updated_at timestamptz not null default now(),
  primary key (service, variant)
);

create table if not exists public.service_products (
  id         text primary key,
  name       text        not null,
  category   text,
  price      numeric(14,2) not null check (price > 0),
  currency   text        not null default 'XAF',
  active     boolean     not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.taxi_rides (
  id          uuid primary key default gen_random_uuid(),
  ride_ref    text not null unique,
  user_id     uuid not null references public.users(id) on delete cascade,
  origin      text not null,
  destination text not null,
  ride_type   text not null default 'basic',
  fare        numeric(14,2) not null check (fare >= 0),
  status      text not null default 'searching'
              check (status in ('searching','assigned','arrived','completed','cancelled')),
  charged_at  timestamptz,
  refunded_at timestamptz,
  journal_id  uuid references public.ledger_journals(id),
  driver      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists ix_taxi_rides_usuario on public.taxi_rides (user_id, created_at desc);

-- La valoracion del viaje tambien vive en la fila: la ruta /rate escribia estas
-- dos columnas cuando la tabla no existia.
alter table public.taxi_rides add column if not exists rating int check (rating between 1 and 5);
alter table public.taxi_rides add column if not exists rating_comment text;

-- La ruta CEMAC debitaba el monedero y, si no habia tabla, guardaba la
-- transferencia en un Map del proceso: dinero fuera, movimiento escrito en ningun
-- sitio. Con esta tabla el cargo siempre tiene su fila detras.
create table if not exists public.cemac_transfers (
  id                  uuid primary key default gen_random_uuid(),
  transfer_ref        text not null unique,
  user_id             uuid not null references public.users(id) on delete cascade,
  from_country        text not null,
  to_country          text not null,
  beneficiary_name    text not null,
  beneficiary_account text not null,
  amount              numeric(14,2) not null check (amount > 0),
  fee                 numeric(14,2) not null default 0 check (fee >= 0),
  status              text not null default 'processing'
                      check (status in ('processing','completed','failed','cancelled')),
  journal_id          uuid references public.ledger_journals(id),
  metadata            jsonb,
  created_by          uuid references public.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists ix_cemac_transfers_usuario on public.cemac_transfers (user_id, created_at desc);

-- Tarifas: son los numeros que hoy estan dentro del codigo de la ruta.
insert into public.service_tariffs (service, variant, amount, concept) values
  ('correos',  'nacional',      2500,  'Envio nacional, 3-5 dias'),
  ('correos',  'express',       5000,  'Envio express, 1-2 dias'),
  ('correos',  'internacional', 15000, 'Envio internacional'),
  ('correos',  'apartado',      5000,  'Apartado postal, 1 anio'),
  ('taxi',     'moto',          800,   'Via en moto'),
  ('taxi',     'basic',         1500,  'Via en taxi'),
  ('taxi',     'premium',       3500,  'Via premium'),
  ('cemac',    'fee',           750,   'Comision fija por transferencia CEMAC')
on conflict (service, variant) do nothing;

-- Catalogo del supermercado: el mismo que estaba hardcodeado en index.js, con
-- las categorias escritas como deben leerse.
insert into public.service_products (id, name, category, price) values
  ('P1', 'Arroz 5kg',    'Alimentacion', 3500),
  ('P2', 'Aceite 1L',    'Alimentacion', 1200),
  ('P3', 'Agua 6x1.5L',  'Bebidas',      2000),
  ('P4', 'Leche 1L',     'Lacteos',       800),
  ('P5', 'Pan de molde', 'Panaderia',     600),
  ('MED1', 'Paracetamol 500mg',  'Medicamentos',  500),
  ('MED2', 'Ibuprofeno 400mg',   'Medicamentos',  800),
  ('MED3', 'Amoxicilina 500mg',  'Medicamentos', 1500),
  ('MED4', 'Omeprazol 20mg',     'Medicamentos', 1200)
on conflict (id) do nothing;

-- Un cargo de servicio: lee la tarifa y asienta exactamente eso.
create or replace function public.service_charge(
  p_user_id uuid,
  p_service text,
  p_variant text,
  p_ref     text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t     public.service_tariffs;
  r     jsonb;
  total numeric;
begin
  if p_user_id is null then
    raise exception 'service_charge necesita el usuario que paga';
  end if;
  if nullif(p_ref, '') is null then
    raise exception 'service_charge necesita una referencia del pedido';
  end if;

  select * into t from public.service_tariffs
   where service = p_service and variant = p_variant and active;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'TARIFF_NOT_FOUND',
      'service', p_service, 'variant', p_variant);
  end if;

  total := round(t.amount * 100) / 100;

  r := public.ledger_post(
    p_user_id,
    'pago_servicio',
    'SER-' || upper(p_service) || '-' || upper(p_ref),
    coalesce(t.concept, p_service || ' ' || p_variant),
    jsonb_build_array(
      jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'debit',  'amount', total),
      jsonb_build_object('account', 'SYS-SUSPENSE',    'entry_type', 'credit', 'amount', total)
    ),
    p_service || ':' || p_ref
  );

  return jsonb_build_object(
    'ok', true,
    'service', p_service,
    'variant', p_variant,
    'amount', total,
    'currency', t.currency,
    'journal_id', r->>'journal_id'
  );
end;
$$;

-- Un pedido de varias lineas: el precio de cada linea sale de service_products.
-- El cliente manda producto y cantidad; nunca manda importe. p_service solo
-- etiqueta el asiento (supermercado, farmacia...), el precio sigue de la tabla.
drop function if exists public.service_basket_charge(uuid, text, jsonb);
create or replace function public.service_basket_charge(
  p_user_id uuid,
  p_ref     text,
  p_items   jsonb,
  p_service text default 'supermercado'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  item   jsonb;
  prod   public.service_products;
  qty    numeric;
  total  numeric := 0;
  r      jsonb;
  lineas jsonb := '[]';
begin
  if p_user_id is null then
    raise exception 'service_basket_charge necesita el usuario que paga';
  end if;
  if nullif(p_ref, '') is null then
    raise exception 'service_basket_charge necesita una referencia del pedido';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or p_items = '[]'::jsonb then
    return jsonb_build_object('ok', false, 'code', 'BASKET_EMPTY');
  end if;

  for item in select * from jsonb_array_elements(p_items)
  loop
    select * into prod from public.service_products
     where id = item->>'product_id' and active;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'PRODUCT_NOT_FOUND',
        'product_id', item->>'product_id');
    end if;
    qty := coalesce(nullif(item->>'qty', '')::numeric, 1);
    if qty <= 0 then
      return jsonb_build_object('ok', false, 'code', 'BAD_QTY', 'product_id', prod.id);
    end if;
    total  := total + round(prod.price * qty * 100) / 100;
    lineas := lineas || jsonb_build_object(
      'product_id', prod.id, 'name', prod.name, 'price', prod.price, 'qty', qty);
  end loop;

  if total <= 0 then
    return jsonb_build_object('ok', false, 'code', 'BASKET_EMPTY');
  end if;

  r := public.ledger_post(
    p_user_id,
    'pago_servicio',
    'SER-' || upper(p_service) || '-' || upper(p_ref),
    'Pedido ' || p_service || ' ' || p_ref,
    jsonb_build_array(
      jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'debit',  'amount', total),
      jsonb_build_object('account', 'SYS-SUSPENSE',    'entry_type', 'credit', 'amount', total)
    ),
    p_service || ':' || p_ref
  );

  return jsonb_build_object(
    'ok', true,
    'service', p_service,
    'amount', total,
    'lines', lineas,
    'journal_id', r->>'journal_id'
  );
end;
$$;

-- El reembolso no es un descargo contable: devuelve el dinero al monedero con su
-- propio asiento, y solo puede hacerse una vez por viaje.
create or replace function public.service_refund(
  p_user_id uuid,
  p_service text,
  p_ref     text,
  p_amount  numeric
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb;
begin
  if p_user_id is null or nullif(p_ref, '') is null or coalesce(p_amount, 0) <= 0 then
    raise exception 'service_refund necesita usuario, referencia e importe';
  end if;

  r := public.ledger_post(
    p_user_id,
    'reembolso',
    'SER-R-' || upper(p_service) || '-' || upper(p_ref),
    'Devolucion de ' || p_service || ' ' || p_ref,
    jsonb_build_array(
      jsonb_build_object('account', 'SYS-SUSPENSE',    'entry_type', 'debit',  'amount', p_amount),
      jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'credit', 'amount', p_amount)
    ),
    p_service || ':' || p_ref
  );

  return jsonb_build_object('ok', true, 'amount', p_amount, 'journal_id', r->>'journal_id');
end;
$$;

-- RLS: niega todo al mundo exterior. El API entra con service_role, que salta
-- las politicas; anon y authenticated no leen tarifas ni escriben pedidos.
alter table public.service_tariffs  enable row level security;
alter table public.service_products enable row level security;
alter table public.taxi_rides       enable row level security;
alter table public.cemac_transfers  enable row level security;

revoke all on public.service_tariffs, public.service_products, public.taxi_rides, public.cemac_transfers from anon, authenticated;
grant select, insert, update, delete on public.service_tariffs, public.service_products to service_role;
grant select, insert, update, delete on public.taxi_rides, public.cemac_transfers to service_role;

revoke all on function public.service_charge(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.service_basket_charge(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.service_refund(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function public.service_charge(uuid, text, text, text) to service_role;
grant execute on function public.service_basket_charge(uuid, text, jsonb, text) to service_role;
grant execute on function public.service_refund(uuid, text, text, numeric) to service_role;

-- Comprobacion del pegado. Debe dar: 4 tablas, 8 tarifas, 9 productos y 3 funciones.
-- Comprobacion en lista vertical: una fila por medida. Espera tablas=4,
-- tarifas=8, productos=9, funciones=3, cadenas_rotas=0.
select 'tablas' as medida,
       (select count(*) from information_schema.tables
          where table_schema = 'public'
            and table_name in ('service_tariffs','service_products','taxi_rides','cemac_transfers'))::text as valor
union all
select 'tarifas', (select count(*) from public.service_tariffs)::text
union all
select 'productos', (select count(*) from public.service_products)::text
union all
select 'funciones',
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('service_charge','service_basket_charge','service_refund'))::text
union all
select 'cadenas_rotas',
       (select (v->>'rotos')::int from public.ledger_verify_chain() v)::text;

commit;
