-- EGChat - Lote E1: Espacio Dulce deja de ser decorativo.
--
-- Que esta pasando hoy: `ensureSpacesTable` (index.js:7153) y `ensureStoriesTable`
-- (index.js:7424) creaban sus tablas con `supabase.rpc('exec_sql', ...)`. Esa funcion
-- ya no existe en el esquema -- la retirada el Lote B y el propio codigo lo reconoce en
-- index.js:1826 --, y los dos `catch {}` vacios tragaban el error sin decir nada. Como
-- las rutas tampoco comprueban el resultado, el efecto es una pantalla vacia que parece
-- correcta: `GET /api/spaces` hace `res.json([])` al primer fallo (index.js:7233 y 7243),
-- igual que `GET /api/stories` (index.js:7545).
--
-- Medido en la base de pruebas: `spaces` tiene 3 columnas de 8, `space_posts` tiene 5 de 8,
-- y `space_follows`, `space_post_likes`, `space_post_comments` y `stories` no existen. O sea,
-- seguir un canal, dar like, comentar y publicar estados no funciona ni aqui. Los contadores
-- los mueven `space_followers_delta` / `space_likes_delta` / `space_comments_delta`, que si
-- estan creados (Lote B), pero actualizan columnas de tablas parciales.
--
-- Este lote crea lo que falta y completa lo que esta a medias. No mete contenido: en
-- produccion `spaces` tiene 0 filas y aqui se deja. La semilla que inventaba seguidores
-- (48200, 31500, 22100...) vive en index.js:7214-7219 y se quita del codigo, no de la base.
--
-- `live_streams` se suma aqui: la app llevaba meses haciendo `upsert` a una tabla que no
-- existia, el fallo se tragaba con `void` y la lista de directos salia vacia. El registro
-- (quien esta en directo y desde cuando) pasa a escribirlo el API; el video sigue yendo
-- por el canal de realtime.
--
-- Idempotente: `create table if not exists`, `add column if not exists`, defaults y checks
-- comprobados, indices estrictos y RLS sin politicas. Se puede pegar dos veces.
--
-- Sin emojis en el DDL: la columna `emoji` se queda sin default para que el archivo que se
-- pega sea ASCII. El API ya escribe su emoji al insertar (index.js:7253).

begin;

-- ── spaces: los canales y comunidades ────────────────────────────────────────
create table if not exists public.spaces (
  id              uuid default gen_random_uuid(),
  name            text,
  description     text,
  type            text,
  cover           text,
  emoji           text,
  owner_id        uuid,
  followers_count integer,
  created_at      timestamptz
);

alter table public.spaces add column if not exists description     text;
alter table public.spaces add column if not exists type            text;
alter table public.spaces add column if not exists cover           text;
alter table public.spaces add column if not exists emoji           text;
alter table public.spaces add column if not exists owner_id        uuid;
alter table public.spaces add column if not exists followers_count integer;
alter table public.spaces add column if not exists created_at      timestamptz;

-- Defaults e checks sobre las columnas que ya existian a secas.
alter table public.spaces alter column id              set default gen_random_uuid();
alter table public.spaces alter column type            set default 'publico';
alter table public.spaces alter column followers_count set default 0;
alter table public.spaces alter column created_at      set default now();

do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.spaces'::regclass and contype = 'p') then
    alter table public.spaces add constraint spaces_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.spaces'::regclass and contype = 'c'
                   and conname = 'spaces_type_check') then
    alter table public.spaces add constraint spaces_type_check
      check (type in ('publico', 'comunidad'));
  end if;
end $$;

-- ── space_follows: quien sigue cada canal (no existia) ───────────────────────
create table if not exists public.space_follows (
  id         uuid default gen_random_uuid() primary key,
  space_id   uuid,
  user_id    uuid,
  created_at timestamptz default now()
);

-- ── space_posts: las publicaciones del canal ─────────────────────────────────
create table if not exists public.space_posts (
  id             uuid default gen_random_uuid(),
  space_id       uuid,
  author_id      uuid,
  text           text,
  image_url      text,
  likes_count    integer,
  comments_count integer,
  created_at     timestamptz
);

alter table public.space_posts add column if not exists author_id      uuid;
alter table public.space_posts add column if not exists image_url      text;
alter table public.space_posts add column if not exists likes_count    integer;
alter table public.space_posts add column if not exists comments_count integer;
alter table public.space_posts add column if not exists created_at     timestamptz;

alter table public.space_posts alter column id             set default gen_random_uuid();
alter table public.space_posts alter column likes_count    set default 0;
alter table public.space_posts alter column comments_count set default 0;
alter table public.space_posts alter column created_at     set default now();

do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_posts'::regclass and contype = 'p') then
    alter table public.space_posts add constraint space_posts_pkey primary key (id);
  end if;
end $$;

-- ── likes y comentarios (no existian) ────────────────────────────────────────
create table if not exists public.space_post_likes (
  id         uuid default gen_random_uuid() primary key,
  post_id    uuid,
  user_id    uuid,
  created_at timestamptz default now()
);

create table if not exists public.space_post_comments (
  id         uuid default gen_random_uuid() primary key,
  post_id    uuid,
  author_id  uuid,
  text       text,
  created_at timestamptz default now()
);

-- ── stories: los estados de 24 horas (no existia) ────────────────────────────
create table if not exists public.stories (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid,
  media      jsonb,
  type       text default 'text',
  views      integer default 0,
  reactions  jsonb default '[]'::jsonb,
  replies    jsonb default '[]'::jsonb,
  expires_at timestamptz,
  created_at timestamptz default now()
);

alter table public.stories add column if not exists media      jsonb;
alter table public.stories add column if not exists type       text default 'text';
alter table public.stories add column if not exists views      integer default 0;
alter table public.stories add column if not exists reactions  jsonb default '[]'::jsonb;
alter table public.stories add column if not exists replies    jsonb default '[]'::jsonb;
alter table public.stories add column if not exists expires_at timestamptz;
alter table public.stories add column if not exists created_at timestamptz default now();

-- ── moments: el muro de la app, que lo pedia en /api/moments y no existia ─────
-- `app/moments.tsx` y `app/channels.tsx` llaman a /api/moments y /api/channels.
-- Los dos devuelven 404 en produccion: no hay ruta ni tabla. Aqui se crea el
-- almacen; las rutas van en index.js detras de este lote.
-- No hay contadores de likes ni de comentarios: se cuentan al leer. Un numero
-- escrito aparte es un numero que puede mentir, y `space_*_delta` ya demuestra
-- que mantenerlo cuesta.
create table if not exists public.moments (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid,
  text       text,
  images     jsonb default '[]'::jsonb,
  videos     jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.moment_likes (
  id         uuid default gen_random_uuid() primary key,
  moment_id  uuid,
  user_id    uuid,
  created_at timestamptz default now()
);

create table if not exists public.moment_comments (
  id         uuid default gen_random_uuid() primary key,
  moment_id  uuid,
  user_id    uuid,
  text       text,
  created_at timestamptz default now()
);

alter table public.moments add column if not exists user_id    uuid;
alter table public.moments add column if not exists text       text;
alter table public.moments add column if not exists images     jsonb default '[]'::jsonb;
alter table public.moments add column if not exists videos     jsonb default '[]'::jsonb;
alter table public.moments add column if not exists created_at timestamptz default now();

alter table public.moment_likes add column if not exists moment_id  uuid;
alter table public.moment_likes add column if not exists user_id    uuid;
alter table public.moment_likes add column if not exists created_at timestamptz default now();

alter table public.moment_comments add column if not exists moment_id  uuid;
alter table public.moment_comments add column if not exists user_id    uuid;
alter table public.moment_comments add column if not exists text       text;
alter table public.moment_comments add column if not exists created_at timestamptz default now();

-- ── live_streams: el registro del directo, no el video ───────────────────────
-- La app escribia esta tabla desde el telefono y leia una copia propia. No
-- existia: el upsert fallaba en silencio y la lista de vivos salia vacia.
-- Aqui vive solo el registro (quien esta en directo y desde cuando). El video
-- va por el canal de realtime de Supabase, igual que las reacciones.
-- Sin `viewer_count`: un conteo escrito aparte es un numero que puede mentir.
create table if not exists public.live_streams (
  id         uuid default gen_random_uuid() primary key,
  host_id    uuid,
  title      text,
  started_at timestamptz default now(),
  ended_at   timestamptz,
  is_active  boolean default true
);

alter table public.live_streams add column if not exists host_id    uuid;
alter table public.live_streams add column if not exists title      text;
alter table public.live_streams add column if not exists started_at timestamptz default now();
alter table public.live_streams add column if not exists ended_at   timestamptz;
alter table public.live_streams add column if not exists is_active  boolean default true;

-- ── relaciones: un solo seguimiento y un solo like por usuario y post ────────
-- Las claves unicas son lo que impide que un doble clic cuente dos veces.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_follows'::regclass and contype = 'u') then
    alter table public.space_follows add constraint space_follows_space_id_user_id_key
      unique (space_id, user_id);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_post_likes'::regclass and contype = 'u') then
    alter table public.space_post_likes add constraint space_post_likes_post_id_user_id_key
      unique (post_id, user_id);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.moment_likes'::regclass and contype = 'u') then
    alter table public.moment_likes add constraint moment_likes_moment_id_user_id_key
      unique (moment_id, user_id);
  end if;
end $$;

-- Las FK se añaden solo si no queda ninguna fila huerfana. Si las hay, este lote NO
-- borra filas del cliente: lo dice en el aviso y deja las claves para el siguiente
-- pegado, cuando se sepa de donde vienen esas filas.
do $$
declare
  h int := 0;
begin
  select
      (select count(*) from public.space_follows f
        where not exists (select 1 from public.users u where u.id = f.user_id)
           or not exists (select 1 from public.spaces s where s.id = f.space_id))
    + (select count(*) from public.space_post_likes l
        where not exists (select 1 from public.users u where u.id = l.user_id)
           or not exists (select 1 from public.space_posts p where p.id = l.post_id))
    + (select count(*) from public.space_post_comments c
        where not exists (select 1 from public.users u where u.id = c.author_id)
           or not exists (select 1 from public.space_posts p where p.id = c.post_id))
    + (select count(*) from public.space_posts p
        where not exists (select 1 from public.spaces s where s.id = p.space_id)
           or (p.author_id is not null and not exists (select 1 from public.users u where u.id = p.author_id)))
    + (select count(*) from public.spaces s
        where s.owner_id is not null and not exists (select 1 from public.users u where u.id = s.owner_id))
    + (select count(*) from public.stories t
        where not exists (select 1 from public.users u where u.id = t.user_id))
    + (select count(*) from public.moments m
        where not exists (select 1 from public.users u where u.id = m.user_id))
    + (select count(*) from public.moment_likes l
        where not exists (select 1 from public.users u where u.id = l.user_id)
           or not exists (select 1 from public.moments m where m.id = l.moment_id))
    + (select count(*) from public.moment_comments c
        where not exists (select 1 from public.users u where u.id = c.user_id)
           or not exists (select 1 from public.moments m where m.id = c.moment_id))
    + (select count(*) from public.live_streams v
        where not exists (select 1 from public.users u where u.id = v.host_id))
  into h;

  if h > 0 then
    raise notice 'ESACIO DULCE: % filas huerfanas. Las claves foraneas quedan sin crear; revisa de donde vienen antes de volver a pegar.', h;
    return;
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.spaces'::regclass and conname = 'spaces_owner_id_fkey') then
    alter table public.spaces add constraint spaces_owner_id_fkey
      foreign key (owner_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_follows'::regclass and conname = 'space_follows_space_id_fkey') then
    alter table public.space_follows add constraint space_follows_space_id_fkey
      foreign key (space_id) references public.spaces(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_follows'::regclass and conname = 'space_follows_user_id_fkey') then
    alter table public.space_follows add constraint space_follows_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_posts'::regclass and conname = 'space_posts_space_id_fkey') then
    alter table public.space_posts add constraint space_posts_space_id_fkey
      foreign key (space_id) references public.spaces(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_posts'::regclass and conname = 'space_posts_author_id_fkey') then
    alter table public.space_posts add constraint space_posts_author_id_fkey
      foreign key (author_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_post_likes'::regclass and conname = 'space_post_likes_post_id_fkey') then
    alter table public.space_post_likes add constraint space_post_likes_post_id_fkey
      foreign key (post_id) references public.space_posts(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_post_likes'::regclass and conname = 'space_post_likes_user_id_fkey') then
    alter table public.space_post_likes add constraint space_post_likes_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_post_comments'::regclass and conname = 'space_post_comments_post_id_fkey') then
    alter table public.space_post_comments add constraint space_post_comments_post_id_fkey
      foreign key (post_id) references public.space_posts(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.space_post_comments'::regclass and conname = 'space_post_comments_author_id_fkey') then
    alter table public.space_post_comments add constraint space_post_comments_author_id_fkey
      foreign key (author_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.stories'::regclass and conname = 'stories_user_id_fkey') then
    alter table public.stories add constraint stories_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.moments'::regclass and conname = 'moments_user_id_fkey') then
    alter table public.moments add constraint moments_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.moment_likes'::regclass and conname = 'moment_likes_moment_id_fkey') then
    alter table public.moment_likes add constraint moment_likes_moment_id_fkey
      foreign key (moment_id) references public.moments(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.moment_likes'::regclass and conname = 'moment_likes_user_id_fkey') then
    alter table public.moment_likes add constraint moment_likes_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.moment_comments'::regclass and conname = 'moment_comments_moment_id_fkey') then
    alter table public.moment_comments add constraint moment_comments_moment_id_fkey
      foreign key (moment_id) references public.moments(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.moment_comments'::regclass and conname = 'moment_comments_user_id_fkey') then
    alter table public.moment_comments add constraint moment_comments_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.live_streams'::regclass and conname = 'live_streams_host_id_fkey') then
    alter table public.live_streams add constraint live_streams_host_id_fkey
      foreign key (host_id) references public.users(id) on delete cascade;
  end if;
end $$;

-- ── indices de las lecturas que hace la app ──────────────────────────────────
create index if not exists idx_spaces_type             on public.spaces (type);
create index if not exists idx_space_follows_user      on public.space_follows (user_id);
create index if not exists idx_space_posts_space       on public.space_posts (space_id, created_at desc);
create index if not exists idx_space_posts_created     on public.space_posts (created_at desc);
create index if not exists idx_space_likes_post        on public.space_post_likes (post_id);
create index if not exists idx_space_comments_post     on public.space_post_comments (post_id, created_at);
create index if not exists idx_stories_user_id         on public.stories (user_id);
create index if not exists idx_stories_expires_at      on public.stories (expires_at);
create index if not exists idx_moments_created         on public.moments (created_at desc);
create index if not exists idx_moments_user            on public.moments (user_id, created_at desc);
create index if not exists idx_moment_likes_moment     on public.moment_likes (moment_id);
create index if not exists idx_moment_comments_moment  on public.moment_comments (moment_id, created_at);
create index if not exists idx_live_active             on public.live_streams (is_active, started_at desc);
create index if not exists idx_live_host               on public.live_streams (host_id, started_at desc);

-- El unico acceso legitimo es el API con la clave de servicio: RLS sin politicas,
-- igual que en S1/S2/S3. `space_*_delta` ya estan revocadas a anon/authenticated.
alter table public.spaces               enable row level security;
alter table public.space_follows        enable row level security;
alter table public.space_posts          enable row level security;
alter table public.space_post_likes     enable row level security;
alter table public.space_post_comments  enable row level security;
alter table public.stories              enable row level security;
alter table public.moments              enable row level security;
alter table public.moment_likes         enable row level security;
alter table public.moment_comments      enable row level security;
alter table public.live_streams         enable row level security;

-- ── autocomprobacion ─────────────────────────────────────────────────────────
-- `columnas` tiene que dar 9 en spaces, 8 en space_posts, 4 en space_follows y
-- space_post_likes, 5 en space_post_comments, 9 en stories, 6 en moments, 4 en
-- moment_likes, 5 en moment_comments y 6 en live_streams. `claves_foraneas` tiene
-- que dar 1 en spaces, stories, moments y live_streams, 2 en el resto.
-- `huerfanas_cero` es el numero de filas sin dueno: si no es 0, las claves
-- foraneas no se crearon.
with t(tabla) as (
  values ('spaces'), ('space_follows'), ('space_posts'), ('space_post_likes'),
         ('space_post_comments'), ('stories'), ('moments'), ('moment_likes'),
         ('moment_comments'), ('live_streams')
)
select 'huerfanas_cero' as medida,
       ((select count(*) from public.space_follows f
          where not exists (select 1 from public.users u where u.id = f.user_id)
             or not exists (select 1 from public.spaces s where s.id = f.space_id))
        + (select count(*) from public.space_post_likes l
          where not exists (select 1 from public.users u where u.id = l.user_id)
             or not exists (select 1 from public.space_posts p where p.id = l.post_id))
        + (select count(*) from public.space_post_comments c
          where not exists (select 1 from public.users u where u.id = c.author_id)
             or not exists (select 1 from public.space_posts p where p.id = c.post_id))
        + (select count(*) from public.space_posts p
          where not exists (select 1 from public.spaces s where s.id = p.space_id)
             or (p.author_id is not null and not exists (select 1 from public.users u where u.id = p.author_id)))
        + (select count(*) from public.stories s2
          where not exists (select 1 from public.users u where u.id = s2.user_id))
        + (select count(*) from public.moments m
          where not exists (select 1 from public.users u where u.id = m.user_id))
        + (select count(*) from public.live_streams v
          where not exists (select 1 from public.users u where u.id = v.host_id)))::text as valor
union all
select 'columnas_' || t.tabla,
       (select count(*) from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = t.tabla)::text
  from t
union all
select 'claves_foraneas_' || t.tabla,
       (select count(*) from pg_constraint k
          where k.conrelid = ('public.' || t.tabla)::regclass and k.contype = 'f')::text
  from t
order by 1;

commit;
