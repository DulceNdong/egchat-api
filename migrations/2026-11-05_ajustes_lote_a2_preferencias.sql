-- EGChat - Lote A2 (ajustes): preferencias, sesiones y borrado de cuenta.
--
-- Que esta pasando hoy: la pantalla Ajustes -> Privacidad manda los cambios a
-- `/api/auth/privacy`, `/api/auth/read-receipts`, `/api/auth/request-data-export`
-- y `/api/auth/delete-account`, y el menu de dispositivos llama a
-- `/api/auth/sessions*`. Ninguna de esas rutas existe en el backend: todas
-- responden 404 y el cliente se traga el error en silencio. El usuario elige
-- «nadie» para su ultima conexion, cierra la app, y al volver sigue en «todos»
-- porque el valor nunca salio del telefono. Los datos que esas rutas necesitan
-- tampoco existen en esta base: no hay tabla de preferencias, no hay tabla de
-- sesiones de dispositivo, no hay cola de exportaciones y `users` no tiene
-- ninguna marca de borrado.
--
-- Lote aditivo: tres tablas nuevas y una columna en `users`. No borra datos, no
-- toca permisos de las tablas que ya existen y no cambia ninguna funcion del
-- libro mayor. Las tablas se crean sin RLS activado porque el API entra con
-- service_role (que lo ignora) y porque el cliente nunca lee estas tablas por
-- Supabase directo, siempre por sus rutas.
--
-- Se reconcila columna a columna (`add column if not exists`) despues de cada
-- `create table if not exists`, de modo que si la instalacion ya tiene una de
-- estas tablas con otra forma, el lote añade las que falten en vez de saltarsela
-- en silencio.

-- ── 1. Preferencias de privacidad y confirmacion de lectura ─────────
create table if not exists public.user_preferences (
  user_id                uuid primary key,
  last_seen_visibility   text    not null default 'todos',
  photo_visibility       text    not null default 'todos',
  status_visibility      text    not null default 'todos',
  read_receipts_enabled  boolean not null default true,
  updated_at             timestamptz not null default now()
);

alter table public.user_preferences
  add column if not exists last_seen_visibility  text    not null default 'todos',
  add column if not exists photo_visibility      text    not null default 'todos',
  add column if not exists status_visibility     text    not null default 'todos',
  add column if not exists read_receipts_enabled boolean not null default true,
  add column if not exists updated_at            timestamptz not null default now();

-- ── 2. Sesiones por dispositivo ────────────────────────────────────
-- Un renglon por (usuario, dispositivo). El alta y el latido hacen upsert por
-- la clave unica; cerrar sesion no borra el renglon, pone `revoked_at`, para
-- que la lista pueda decir cuando se cerro.
create table if not exists public.device_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null,
  device_id   text        not null,
  device_name text,
  device_type text,
  platform    text,
  ip          text,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

alter table public.device_sessions
  add column if not exists device_name text,
  add column if not exists device_type text,
  add column if not exists platform    text,
  add column if not exists ip          text,
  add column if not exists last_seen   timestamptz not null default now(),
  add column if not exists created_at  timestamptz not null default now(),
  add column if not exists revoked_at  timestamptz;

-- Un indice unico en vez de constraint: es la misma garantia para el upsert del
-- API (`on conflict (user_id, device_id)`) y `create unique index if not exists`
-- es re-pegable aunque la tabla ya exista con otra forma.
create unique index if not exists device_sessions_user_device_uidx
  on public.device_sessions (user_id, device_id);

create index if not exists device_sessions_user_idx
  on public.device_sessions (user_id, last_seen desc);

-- ── 3. Cola de exportacion de datos ────────────────────────────────
-- La app pide la descarga y el backend responde «solicitud registrada». El
-- archivo se genera por lote, no en la peticion: una cuenta con historial puede
-- tardar mas de lo que aguanta una conexion HTTP.
create table if not exists public.data_export_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid    not null,
  status       text    not null default 'requested',
  error        text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.data_export_requests
  add column if not exists status       text    not null default 'requested',
  add column if not exists error        text,
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz;

create index if not exists data_export_requests_user_idx
  on public.data_export_requests (user_id, requested_at desc);

-- ── 4. Borrado logico de la cuenta ─────────────────────────────────
-- El libro mayor es inmutable y sus asientos tienen clave foranea a `users`.
-- Borrar la fila romper ia la contabilidad y desmontaria la auditoria, asi que
-- el borrado de cuenta es logico: `deleted_at` marca la cuenta y el login la
-- rechaza. Las rutas de lectura tambien la filtran para que el usuario borrado
-- desaparezca de las listas de otros.
alter table public.users
  add column if not exists deleted_at timestamptz;

create index if not exists users_deleted_at_idx
  on public.users (deleted_at) where deleted_at is not null;

-- ── Autocomprobacion (fila medida | valor) ─────────────────────────
select 'user_preferences_columnas' as medida,
       (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'user_preferences'
            and column_name in ('user_id', 'last_seen_visibility', 'photo_visibility',
                                'status_visibility', 'read_receipts_enabled', 'updated_at'))::text as valor
union all
select 'device_sessions_columnas',
       (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'device_sessions'
            and column_name in ('id', 'user_id', 'device_id', 'device_name', 'device_type',
                                'platform', 'ip', 'last_seen', 'created_at', 'revoked_at'))::text
union all
select 'device_sessions_clave_unica',
       (select count(*) from pg_indexes
          where schemaname = 'public'
            and indexname = 'device_sessions_user_device_uidx')::text
union all
select 'data_export_requests_columnas',
       (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'data_export_requests'
            and column_name in ('id', 'user_id', 'status', 'error',
                                'requested_at', 'completed_at'))::text
union all
select 'users_deleted_at',
       (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'users'
            and column_name = 'deleted_at')::text
union all
select 'indices_nuevos',
       (select count(*) from pg_indexes
          where schemaname = 'public'
            and indexname in ('device_sessions_user_idx', 'data_export_requests_user_idx',
                              'users_deleted_at_idx'))::text
union all
select 'cuentas_ya_borradas',
       (select count(*) from public.users where deleted_at is not null)::text;
