-- EGChat - Lote A1-b: el indice que faltaba para que el fondo se guarde.
--
-- Que esta pasando hoy: el A1 anadio `wallpaper_type`, `wallpaper_value` y
-- `wallpaper_settings` a `chat_participants`, y con eso el POST dejo de fallar
-- por columna inexistente. Pero la ruta hace
-- `upsert(..., { onConflict: 'chat_id,user_id' })` y la tabla solo tiene clave
-- primaria en `id`. PostgREST responde
-- «there is no unique or exclusion constraint matching the ON CONFLICT
-- specification» y el fondo sigue sin guardarse: medido en la base de pruebas,
-- el POST da 500 y el GET devuelve `default` para siempre.
--
-- Mismo fallo en `POST /api/chats/:chatId/participants` (index.js:7482), que hace
-- el mismo upsert sin onConflict. Ahi de momento pasa porque PostgREST lo resuelve
-- como alta, pero reañadir al mismo duplica la fila.
--
-- El indice tiene que ser NORMAL, no parcial. Probado en la base de pruebas: con
-- `create unique index ... where chat_id is not null and user_id is not null`
-- PostgREST NO lo reconoce para inferir el ON CONFLICT y el POST sigue dando 500.
-- Sin el `where`, el mismo indice hace que el POST conteste «Fondo guardado
-- correctamente» y que el GET devuelva el fondo elegido.
--
-- Unico riesgo: si ya hay parejas repetidas el indice no se puede crear. El bloque
-- lo comprueba antes y avisa por NOTICE en vez de reventar; no borra ninguna fila,
-- porque decidir cual de las repetidas se queda es otra decision.

do $a1b$ begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and tablename  = 'chat_participants'
                    and indexname  = 'chat_participants_chat_user_uidx') then
    if (select count(*) from (
          select 1 from public.chat_participants
           where chat_id is not null and user_id is not null
           group by chat_id, user_id having count(*) > 1) d) > 0 then
      raise notice 'A1-b: hay parejas duplicadas; no se pone el indice';
    else
      execute $u$
        create unique index if not exists chat_participants_chat_user_uidx
          on public.chat_participants (chat_id, user_id)
      $u$;
      raise notice 'A1-b: indice unico de participante puesto';
    end if;
  else
    raise notice 'A1-b: el indice ya existe';
  end if;
end
$a1b$;

-- Autocomprobacion en lista vertical. `indice_unico` debe dar 1 y
-- `parejas_duplicadas` 0; si duplicadas sale distinto de 0 hay que limpiar antes.
select 'indice_unico' as medida,
       (select count(*) from pg_indexes
          where schemaname = 'public' and tablename = 'chat_participants'
            and indexname = 'chat_participants_chat_user_uidx')::text as valor
union all
select 'parejas_duplicadas',
       (select count(*) from (
          select 1 from public.chat_participants
           where chat_id is not null and user_id is not null
           group by chat_id, user_id having count(*) > 1) d)::text
union all
select 'filas_participantes', (select count(*) from public.chat_participants)::text
union all
select 'filas_sin_pareja',
       (select count(*) from public.chat_participants
          where chat_id is null or user_id is null)::text
union all
select 'con_fondo_guardado',
       (select count(*) from public.chat_participants
          where wallpaper_type is not null)::text;
