-- EGPay - Lote F: que la historia que ve el cliente sepa si esta fundada.
--
-- Que pasa: GET /api/wallet/transactions muestra las filas de `transactions`
-- con status='completed'. El libro mayor no existia antes del 2026-11-02, asi
-- que los 54 movimientos de la beta aparecen en pantalla como si fueran asiento
-- contable cuando no lo son: el libro solo tiene los 35 de apertura. Medido en
-- produccion el 2026-11-05 (sondeo): asientos=35, apertura=35.
--
-- Criterio (no por fecha, que mentia): la fila dice ella misma como se fundo.
--   'libro'    tiene asiento detras (el API nuevo lo escribe al mover el dinero)
--   'previa'   movimiento de la era sin libro: no se puede fundar, se oculta
--   'anomala'  posterior al libro pero sin asiento: aqui hay que mirar
-- Marcar por fecha daria 'fundada' a cualquier fila nueva que el API escriba sin
-- vinculo, que es justo lo que se quiere detectar.
--
-- Este lote no borra nada. Deja visible la historia actual (solo se ocultan las
-- 'previa') y añade ledger_journal_id, que el API rellena desde ahora. Es
-- reversible: borrar la columna y volver a mostrar todo.
--
-- Idempotente: add column if not exists, el marcado solo toca filas sin valor, y
-- la FK se anade como NOT VALID para no reescanear la tabla.

alter table public.transactions
  add column if not exists ledger_link text not null default 'libro';

comment on column public.transactions.ledger_link is
  'libro = tiene asiento; previa = movimiento anterior al libro mayor; anomala = deberia tenerlo y no lo tiene';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_transactions_ledger_link'
                                          and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions
      add constraint ck_transactions_ledger_link
      check (ledger_link in ('libro', 'previa', 'anomala'));
  end if;
end $$;

alter table public.transactions
  add column if not exists ledger_journal_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_transactions_ledger_journal'
                                           and conrelid = 'public.transactions'::regclass) then
    alter table public.transactions
      add constraint fk_transactions_ledger_journal
      foreign key (ledger_journal_id) references public.ledger_journals (id)
      not valid;
  end if;
end $$;

create index if not exists ix_transactions_ledger_link
  on public.transactions (user_id, ledger_link, created_at desc);

-- Las filas anteriores al despliegue del API que contabiliza (commit bb542a57,
-- 2026-11-03) no tienen vinculo posible: el libro no estaba escrito.
update public.transactions
   set ledger_link = 'previa'
 where ledger_journal_id is null
   and created_at < timestamp with time zone '2026-11-03 00:00:00+01';

-- Y las posteriores sin vinculo son un defecto del API, no historia antigua:
-- se quedan visibles (el cliente las cobro) pero contadas como anomalias.
update public.transactions
   set ledger_link = 'anomala'
 where ledger_journal_id is null
   and created_at >= timestamp with time zone '2026-11-03 00:00:00+01';

-- Con asiento escrito, siempre 'libro', sin importar la fecha.
update public.transactions
   set ledger_link = 'libro'
 where ledger_journal_id is not null
   and ledger_link <> 'libro';

-- Autocomprobacion: seis lineas de nombre y valor, para leerlas sin desplazar.
select 'transacciones' as medida, (select count(*) from public.transactions)::text as valor
union all
select 'con_asiento', (select count(*) from public.transactions where ledger_link = 'libro')::text
union all
select 'era_sin_libro', (select count(*) from public.transactions where ledger_link = 'previa')::text
union all
select 'anomalas', (select count(*) from public.transactions where ledger_link = 'anomala')::text
union all
select 'asientos_huerfanos',
       (select count(*) from public.transactions t
          where t.ledger_journal_id is not null
            and not exists (select 1 from public.ledger_journals j
                             where j.id = t.ledger_journal_id))::text
union all
select 'columnas_del_lote',
       (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'transactions'
            and column_name in ('ledger_link', 'ledger_journal_id'))::text;
