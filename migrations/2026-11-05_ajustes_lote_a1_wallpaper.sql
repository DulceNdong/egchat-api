-- EGChat - Lote A1: el fondo de pantalla de un chat se guarda de verdad.
--
-- Que esta pasando hoy: `/api/chats/:chatId/wallpaper` escribe y lee
-- `wallpaper_type`, `wallpaper_value` y `wallpaper_settings` en `chat_participants`
-- (index.js:7086 y index.js:7116), pero la tabla no tiene ninguna de esas tres
-- columnas. El POST falla dentro de su propio `catch` y el consultor del GET
-- devuelve error de columna inexistente, que el codigo tambie traga. Resultado:
-- el usuario elige un fondo, la app lo muestra hasta que cierra la pantalla, y al
-- volver esta el por defecto. No se ha guardado nunca un fondo en esta base.
--
-- Lote aditivo y peque: anade las tres columnas a la tabla que ya existe. No toca
-- datos, no borra columnas y no cambia permisos. `chat_participants` ya tiene RLS y
-- el API entra con service_role, asi que aqui no hay nada que re-permitir.
--
-- Unico bloque: el editor de Supabase parte el guion por los punto y coma y ejecuta
-- cada trozo en su propia transaccion, asi que el lote entero es una sentencia.

do $a1$ begin
  execute $alt$
    alter table public.chat_participants
      add column if not exists wallpaper_type    text,
      add column if not exists wallpaper_value   text,
      add column if not exists wallpaper_settings jsonb
  $alt$;

  -- Los tres valores posibles que usa la app. Se comprueba antes de poner el
  -- candado por si ya hay filas escritas por otra via con otro valor.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.chat_participants'::regclass
                    and conname  = 'chat_participants_wallpaper_type_check') then
    if (select count(*) from public.chat_participants
         where wallpaper_type is not null
           and wallpaper_type not in ('default', 'image', 'color')) = 0 then
      execute $chk$
        alter table public.chat_participants
          add constraint chat_participants_wallpaper_type_check
          check (wallpaper_type is null or wallpaper_type in ('default', 'image', 'color'))
      $chk$;
      raise notice 'A1: candado de tipos de fondo puesto';
    else
      raise notice 'A1: hay tipos de fondo fuera de default/image/color; se deja sin candado';
    end if;
  end if;

  raise notice 'A1: columnas de fondo comprobadas (filas con fondo=%)',
    (select count(*) from public.chat_participants where wallpaper_type is not null);
end
$a1$;

-- Autocomprobacion en lista vertical. `columnas_fondo` debe dar 3.
select 'columnas_fondo' as medida,
       (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'chat_participants'
            and column_name in ('wallpaper_type', 'wallpaper_value', 'wallpaper_settings'))::text as valor
union all
select 'candado_tipos',
       (select count(*) from pg_constraint
          where conrelid = 'public.chat_participants'::regclass
            and conname = 'chat_participants_wallpaper_type_check')::text
union all
select 'filas_en_chat_participants', (select count(*) from public.chat_participants)::text
union all
select 'con_fondo_guardado',
       (select count(*) from public.chat_participants where wallpaper_type is not null)::text;
