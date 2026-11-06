do $c2$
begin
  execute $fn$
    create or replace function public.ledger_journals_immutable()
    returns trigger
    language plpgsql
    as $body$
    begin
      if tg_op = 'DELETE' then
        raise exception 'ledger_journals es inmutable: un asiento no se borra, se corrige con ledger_reverse_journal';
      end if;

      if old.status = 'reversed' then
        raise exception 'el asiento % ya esta revertido y no se vuelve a tocar', old.id;
      end if;

      if old.status = 'posted' then
        if new.status is distinct from old.status and new.status <> 'reversed' then
          raise exception 'el asiento % no se reabre (% -> %): se corrige con un abono',
            old.id, old.status, new.status;
        end if;
        if new.reference        is distinct from old.reference
           or new.idempotency_key is distinct from old.idempotency_key
           or new.hash            is distinct from old.hash
           or new.prev_hash       is distinct from old.prev_hash
           or new.chain_seq       is distinct from old.chain_seq
           or new.total_amount    is distinct from old.total_amount
           or new.user_id         is distinct from old.user_id then
          raise exception 'la identidad contable del asiento % no se modifica', old.id;
        end if;
      end if;

      return new;
    end;
    $body$
  $fn$;

  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.ledger_journals'::regclass
                   and tgname  = 'trg_ledger_journals_immutable') then
    execute $trg$
      create trigger trg_ledger_journals_immutable
        before update or delete on public.ledger_journals
        for each row execute function public.ledger_journals_immutable()
    $trg$;
  end if;

  raise notice 'C-2 | disparador=% | funcion=% | posted=% | apertura=%',
    (select count(*) from pg_trigger
       where tgrelid = 'public.ledger_journals'::regclass
         and tgname = 'trg_ledger_journals_immutable'),
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'ledger_journals_immutable'),
    (select count(*) from public.ledger_journals where status = 'posted'),
    (select count(*) from public.ledger_journals where operation = 'apertura');
end
$c2$;
