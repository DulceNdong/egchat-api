-- Djangue: ciclos, consentimiento explícito, liquidación de salida y borrado seguro.
-- Una sola sentencia DO para pegar en Supabase. No borra historial financiero.
do $dj$
declare
  g record;
  v_cycle uuid;
begin
  -- ── Tablas nuevas ──────────────────────────────────────────────────────
  create table if not exists public.djangue_cycles (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.djangue_groups(id) on delete cascade,
    cycle_number int not null,
    status text not null default 'active' check (status in ('forming','active','completed','cancelled')),
    quota_amount numeric(12,2) not null,
    total_turns int not null,
    settlement_balance numeric(12,2) not null default 0,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (group_id, cycle_number)
  );
  create table if not exists public.djangue_consents (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.djangue_groups(id) on delete cascade,
    cycle_id uuid references public.djangue_cycles(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    version text not null default 'v1',
    quota_amount numeric(12,2) not null,
    total_turns int not null,
    max_contribution numeric(12,2) not null,
    terms_hash text not null,
    accepted_at timestamptz not null default now(),
    unique (group_id, cycle_id, user_id)
  );
  create table if not exists public.djangue_invitations (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.djangue_groups(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    phone text not null,
    invited_by uuid not null references public.users(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending','accepted','declined','expired')),
    token uuid not null default gen_random_uuid(),
    created_at timestamptz not null default now(),
    responded_at timestamptz
  );
  create unique index if not exists djangue_invitations_pending_uidx
    on public.djangue_invitations (group_id, user_id) where status = 'pending';
  create table if not exists public.djangue_cycle_decisions (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.djangue_groups(id) on delete cascade,
    cycle_id uuid not null references public.djangue_cycles(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    decision text not null check (decision in ('continue','leave')),
    consent_snapshot jsonb,
    decided_at timestamptz not null default now(),
    unique (cycle_id, user_id)
  );
  create table if not exists public.djangue_settlements (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.djangue_groups(id) on delete cascade,
    cycle_id uuid references public.djangue_cycles(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    amount numeric(12,2) not null,
    breakdown jsonb not null,
    journal_id uuid,
    created_at timestamptz not null default now()
  );

  -- ── Columnas y checks ampliados ────────────────────────────────────────
  alter table public.djangue_groups add column if not exists current_cycle_id uuid references public.djangue_cycles(id);
  alter table public.djangue_groups add column if not exists archived_at timestamptz;
  alter table public.djangue_groups drop constraint if exists djangue_groups_status_check;
  alter table public.djangue_groups add constraint djangue_groups_status_check
    check (status in ('active','paused','completed','cancelled','archived'));
  alter table public.djangue_contributions add column if not exists cycle_id uuid references public.djangue_cycles(id);
  alter table public.djangue_payouts add column if not exists cycle_id uuid references public.djangue_cycles(id);
  alter table public.djangue_penalties add column if not exists cycle_id uuid references public.djangue_cycles(id);
  alter table public.djangue_notifications add column if not exists cycle_id uuid references public.djangue_cycles(id);
  alter table public.djangue_notifications drop constraint if exists djangue_notifications_type_check;
  alter table public.djangue_notifications add constraint djangue_notifications_type_check
    check (type in ('reminder_10days','reminder_daily','payment_received','turn_completed','penalty_applied',
                    'cycle_completed','cycle_started','invitation','member_left','settlement'));
  alter table public.djangue_members drop constraint if exists djangue_members_group_id_turn_order_key;
  create unique index if not exists djangue_members_active_turn_uidx
    on public.djangue_members (group_id, turn_order) where status <> 'removed';
  create index if not exists idx_djangue_contributions_cycle on public.djangue_contributions (cycle_id);
  create index if not exists idx_djangue_payouts_cycle on public.djangue_payouts (cycle_id);
  create index if not exists idx_djangue_consents_user on public.djangue_consents (user_id);
  create index if not exists idx_djangue_invitations_user on public.djangue_invitations (user_id);
  create index if not exists idx_djangue_decisions_cycle on public.djangue_cycle_decisions (cycle_id);

  -- ── Backfill: un ciclo inicial por grupo existente ─────────────────────
  for g in select * from public.djangue_groups where current_cycle_id is null loop
    insert into public.djangue_cycles (group_id, cycle_number, status, quota_amount, total_turns, completed_at)
    values (g.id, 1, case when g.status = 'completed' then 'completed' else 'active' end,
            g.quota_amount, greatest(g.total_turns, 1),
            case when g.status = 'completed' then now() else null end)
    returning id into v_cycle;
    update public.djangue_groups set current_cycle_id = v_cycle where id = g.id;
    update public.djangue_contributions set cycle_id = v_cycle where group_id = g.id and cycle_id is null;
    update public.djangue_payouts set cycle_id = v_cycle where group_id = g.id and cycle_id is null;
    update public.djangue_penalties set cycle_id = v_cycle where group_id = g.id and cycle_id is null;
    update public.djangue_notifications set cycle_id = v_cycle where group_id = g.id and cycle_id is null;
  end loop;

  create or replace function public.dj_guard_terms_update()
  returns trigger language plpgsql security invoker set search_path = public, pg_temp as $fn$
  begin
    if old.current_cycle_id is not null and
      (new.quota_amount, new.frequency, new.max_members, new.penalty_percent)
        is distinct from (old.quota_amount, old.frequency, old.max_members, old.penalty_percent) then
      raise exception 'CONSENT_TERMS_LOCKED: Las condiciones aceptadas no se pueden cambiar';
    end if;
    if old.status in ('completed','archived','cancelled') and new.status in ('active','paused')
      and new.current_cycle_id is not distinct from old.current_cycle_id then
      raise exception 'CYCLE_NOT_COMPLETED: Usa el inicio de un nuevo ciclo con las decisiones individuales';
    end if;
    return new;
  end $fn$;
  drop trigger if exists dj_guard_terms_update on public.djangue_groups;
  create trigger dj_guard_terms_update before update on public.djangue_groups
    for each row execute function public.dj_guard_terms_update();
  revoke all on function public.dj_guard_terms_update() from public, anon, authenticated;

  -- ── Helpers ───────────────────────────────────────────────────────────
  create or replace function public.dj_delete_chat_data(p_chat_id uuid)
  returns void language plpgsql security invoker set search_path = public, pg_temp as $fn$
  begin
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'message_deletions') then
      execute 'delete from public.message_deletions where message_id in (select id from public.messages where chat_id = $1)' using p_chat_id;
    end if;
    delete from public.messages where chat_id = p_chat_id;
    delete from public.message_reads where chat_id = p_chat_id;
    delete from public.chat_participants where chat_id = p_chat_id;
    delete from public.chats where id = p_chat_id;
  end $fn$;

  create or replace function public.dj_ensure_cycle(p_group_id uuid)
  returns uuid language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_id uuid; v_g public.djangue_groups;
  begin
    select current_cycle_id into v_id from public.djangue_groups where id = p_group_id;
    if v_id is not null then return v_id; end if;
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    insert into public.djangue_cycles (group_id, cycle_number, status, quota_amount, total_turns)
    values (p_group_id, 1, 'active', v_g.quota_amount, greatest(v_g.total_turns, 1))
    returning id into v_id;
    update public.djangue_groups set current_cycle_id = v_id where id = p_group_id;
    return v_id;
  end $fn$;

  create or replace function public.dj_consent_accept(p_group_id uuid, p_user_id uuid, p_cycle_id uuid default null)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_cycle uuid; v_g public.djangue_groups; v_hash text; v_row public.djangue_consents;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    if p_cycle_id is not null and p_cycle_id <> v_cycle then
      raise exception 'VALIDATION_ERROR: El ciclo indicado ya no es el actual';
    end if;
    if not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed') then
      raise exception 'FORBIDDEN: No participas en este djangue';
    end if;
    v_hash := md5('v1|' || p_group_id || '|' || v_cycle || '|' || v_g.quota_amount || '|' || v_g.max_members || '|' || v_g.frequency || '|' || v_g.penalty_percent);
    insert into public.djangue_consents (group_id, cycle_id, user_id, version, quota_amount, total_turns, max_contribution, terms_hash)
    values (p_group_id, v_cycle, p_user_id, 'v1', v_g.quota_amount, v_g.max_members,
            round(v_g.quota_amount * greatest(v_g.max_members - 1, 0), 2), v_hash)
    on conflict (group_id, cycle_id, user_id) do nothing;
    select * into v_row from public.djangue_consents where group_id = p_group_id and cycle_id = v_cycle and user_id = p_user_id;
    return to_jsonb(v_row);
  end $fn$;

  create or replace function public.dj_exit_quote(p_group_id uuid, p_user_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare
    v_cycle uuid; v_g public.djangue_groups; v_m public.djangue_members;
    v_due numeric := 0; v_future numeric := 0; v_pen numeric := 0;
    v_paid_due numeric := 0; v_expected_due int := 0; v_t int;
    v_received boolean;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select * into v_m from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed';
    if not found then return jsonb_build_object('ok', true, 'already_removed', true, 'total', 0); end if;
    for v_t in 1..v_g.current_turn loop
      if v_t <> v_m.turn_order then v_expected_due := v_expected_due + 1; end if;
    end loop;
    select coalesce(sum(amount), 0) into v_paid_due from public.djangue_contributions
      where group_id = p_group_id and cycle_id = v_cycle and user_id = p_user_id
        and status = 'paid' and turn_number <= v_g.current_turn and turn_number <> v_m.turn_order;
    v_due := greatest(0, round(v_g.quota_amount * v_expected_due - v_paid_due, 2));
    select exists (select 1 from public.djangue_payouts
      where group_id = p_group_id and cycle_id = v_cycle and beneficiary_id = p_user_id and status = 'completed')
      into v_received;
    if v_received then
      v_future := round(v_g.quota_amount * greatest(v_g.total_turns - v_g.current_turn, 0), 2);
    end if;
    select coalesce(sum(penalty_amount), 0) into v_pen from public.djangue_penalties
      where group_id = p_group_id and user_id = p_user_id and status <> 'paid';
    return jsonb_build_object('ok', true, 'cycle_id', v_cycle, 'current_turn', v_g.current_turn,
      'due', v_due, 'future', v_future, 'penalties', v_pen,
      'total', round(v_due + v_future + v_pen, 2), 'received_payout', v_received,
      'currency', v_g.currency, 'consent_required', (v_due + v_future + v_pen) > 0
        and not exists (select 1 from public.djangue_consents
          where group_id = p_group_id and cycle_id = v_cycle and user_id = p_user_id));
  end $fn$;

  create or replace function public.dj_settle_and_exit(p_group_id uuid, p_user_id uuid, p_actor_id uuid default null, p_remove_chat boolean default true)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare
    v_cycle uuid; v_g public.djangue_groups; v_m public.djangue_members;
    v_quote jsonb; v_total numeric; v_journal jsonb; v_journal_id uuid;
    v_actor uuid := coalesce(p_actor_id, p_user_id); v_manager uuid; v_later record;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if v_actor is distinct from p_user_id and ((v_actor is distinct from v_g.owner_id and v_actor is distinct from v_g.secretary_id)
      or not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = v_actor and status <> 'removed')) then
      raise exception 'FORBIDDEN: Solo el administrador puede expulsar';
    end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select * into v_m from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed' for update;
    if not found then return jsonb_build_object('ok', true, 'already_removed', true, 'settlement_amount', 0); end if;
    v_quote := public.dj_exit_quote(p_group_id, p_user_id);
    v_total := (v_quote->>'total')::numeric;
    if v_actor is distinct from p_user_id and (p_user_id = v_g.owner_id or v_total > 0) then
      raise exception 'DJANGUE_EXIT_REQUIRED: El integrante debe revisar y confirmar su propia liquidación antes de salir';
    end if;
    if v_g.status = 'active' and v_m.turn_order = v_g.current_turn
      and not exists (select 1 from public.djangue_payouts where group_id = p_group_id and cycle_id = v_cycle
        and turn_number = v_g.current_turn and status = 'completed') then
      raise exception 'PAYOUT_PENDING: Completa la entrega del turno que te corresponde antes de salir';
    end if;
    if v_total > 0 then
      if not exists (select 1 from public.djangue_consents where group_id = p_group_id and cycle_id = v_cycle and user_id = p_user_id) then
        raise exception 'CONSENT_REQUIRED: Debes aceptar los términos antes de liquidar la salida';
      end if;
      v_journal := public.ledger_post(p_user_id, 'pago_servicio',
        'DJEXIT-' || p_group_id || '-' || v_cycle || '-' || p_user_id,
        'Liquidación salida djangue ' || v_g.name,
        jsonb_build_array(
          jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'debit', 'amount', v_total),
          jsonb_build_object('account', 'SYS-SUSPENSE', 'entry_type', 'credit', 'amount', v_total)),
        p_group_id || ':' || v_cycle || ':exit:' || p_user_id);
      if (v_journal->>'status') <> 'posted' then
        raise exception 'CHARGE_FAILED: El asiento no quedó publicado';
      end if;
      v_journal_id := (v_journal->>'journal_id')::uuid;
      insert into public.djangue_settlements (group_id, cycle_id, user_id, amount, breakdown, journal_id)
      values (p_group_id, v_cycle, p_user_id, v_total, v_quote, v_journal_id);
      update public.djangue_cycles set settlement_balance = settlement_balance + v_total where id = v_cycle;
      update public.djangue_penalties set status = 'paid', paid_at = now()
        where group_id = p_group_id and user_id = p_user_id and status <> 'paid';
    end if;
    update public.djangue_members set status = 'removed' where id = v_m.id;
    if not exists (select 1 from public.djangue_members where group_id = p_group_id and status <> 'removed'
      and (user_id = v_g.owner_id or user_id = v_g.secretary_id)) then
      select user_id into v_manager from public.djangue_members where group_id = p_group_id and status <> 'removed' order by turn_order limit 1;
      update public.djangue_groups set secretary_id = v_manager where id = p_group_id;
      if v_manager is not null and v_g.chat_group_id is not null then
        update public.chat_participants set role = 'admin' where chat_id = v_g.chat_group_id and user_id = v_manager;
      end if;
    end if;
    if v_m.turn_order > v_g.current_turn then
      for v_later in select id from public.djangue_members
        where group_id = p_group_id and status <> 'removed' and turn_order > v_m.turn_order order by turn_order loop
        update public.djangue_members set turn_order = turn_order - 1 where id = v_later.id;
      end loop;
      update public.djangue_groups set total_turns = greatest(total_turns - 1, 1), updated_at = now() where id = p_group_id;
      update public.djangue_cycles set total_turns = greatest(total_turns - 1, 1) where id = v_cycle;
    end if;
    if p_remove_chat and v_g.chat_group_id is not null then
      delete from public.chat_participants where chat_id = v_g.chat_group_id and user_id = p_user_id;
      delete from public.message_reads where chat_id = v_g.chat_group_id and user_id = p_user_id;
    end if;
    insert into public.djangue_notifications (group_id, cycle_id, user_id, type, title, message)
    values (p_group_id, v_cycle, v_g.owner_id, 'member_left', 'Integrante salió',
            'Un integrante salió del djangue' || case when v_total > 0 then ' y liquidó ' || v_total || ' ' || v_g.currency else '' end || '.');
    return jsonb_build_object('ok', true, 'settlement_amount', v_total, 'journal_id', v_journal_id, 'breakdown', v_quote);
  end $fn$;

  create or replace function public.dj_delete_group(p_group_id uuid, p_user_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_g public.djangue_groups; v_cycle uuid; v_status text;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if v_g.owner_id <> p_user_id then raise exception 'FORBIDDEN: Solo el creador puede eliminar el djangue'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select status into v_status from public.djangue_cycles where id = v_cycle;
    if v_status = 'forming' and v_g.total_turns = 1
      and not exists (select 1 from public.djangue_contributions where group_id = p_group_id and cycle_id = v_cycle)
      and not exists (select 1 from public.djangue_payouts where group_id = p_group_id and cycle_id = v_cycle)
      and not exists (select 1 from public.djangue_settlements where group_id = p_group_id and cycle_id = v_cycle) then
      update public.djangue_cycles set status = 'cancelled', completed_at = now() where id = v_cycle;
    elsif v_status in ('forming','active') then
      raise exception 'CYCLE_ACTIVE: Completa o cancela el ciclo antes de eliminar';
    end if;
    if exists (select 1 from public.djangue_members m where m.group_id = p_group_id and m.status <> 'removed'
      and (public.dj_exit_quote(p_group_id, m.user_id)->>'total')::numeric > 0) then
      raise exception 'DEBTS_PENDING: Hay deudas pendientes de liquidar antes de eliminar';
    end if;
    if (select settlement_balance from public.djangue_cycles where id = v_cycle) > 0 then
      raise exception 'DEBTS_PENDING: Queda un fondo liquidado pendiente de entregar';
    end if;
    update public.djangue_members set status = 'removed' where group_id = p_group_id;
    update public.djangue_groups set status = 'archived', archived_at = now(), chat_group_id = null, updated_at = now() where id = p_group_id;
    if v_g.chat_group_id is not null then
      perform public.dj_delete_chat_data(v_g.chat_group_id);
    end if;
    return jsonb_build_object('ok', true, 'archived', true, 'chat_deleted', v_g.chat_group_id is not null);
  end $fn$;

  create or replace function public.dj_guard_chat_action(p_chat_id uuid, p_user_id uuid, p_target_id uuid, p_action text)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_group uuid;
  begin
    select id into v_group from public.djangue_groups where chat_group_id = p_chat_id and status <> 'archived';
    if v_group is null then return jsonb_build_object('ok', true, 'djangue', false); end if;
    if p_action = 'delete' then
      -- Solo el creador del djangue puede archivarlo; el resto liquida y sale.
      if exists (select 1 from public.djangue_groups where id = v_group and owner_id = p_user_id) then
        return public.dj_delete_group(v_group, p_user_id);
      end if;
      raise exception 'DJANGUE_EXIT_REQUIRED: Revisa la liquidación y confirma tu salida desde el panel del djangue';
    elsif p_action = 'leave' then
      raise exception 'DJANGUE_EXIT_REQUIRED: Revisa la liquidación y confirma tu salida desde el panel del djangue';
    elsif p_action = 'expel' then
      return public.dj_settle_and_exit(v_group, coalesce(p_target_id, p_user_id), p_user_id, true);
    end if;
    return jsonb_build_object('ok', true, 'djangue', true);
  end $fn$;

  create or replace function public.chat_safe_delete(p_chat_id uuid, p_user_id uuid, p_permanent boolean default false)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_chat public.chats; v_guard jsonb; v_count int;
  begin
    select * into v_chat from public.chats where id = p_chat_id for update;
    if not found then raise exception 'CHAT_NOT_FOUND: Chat no encontrado'; end if;
    if not exists (select 1 from public.chat_participants where chat_id = p_chat_id and user_id = p_user_id) then
      raise exception 'FORBIDDEN: No tienes acceso a este chat';
    end if;
    v_guard := public.dj_guard_chat_action(p_chat_id, p_user_id, p_user_id, case when p_permanent then 'delete' else 'leave' end);
    -- Djangue: archivar (creador) o liquidar y salir (resto).
    if v_guard ? 'archived' then
      return v_guard;
    end if;
    if v_guard ? 'settlement_amount' then
      return jsonb_build_object('ok', true, 'left', true, 'djangue', true, 'settlement', v_guard);
    end if;
    -- Chat normal: borrado permanente para privados o para el creador del grupo.
    if p_permanent and (v_chat.type <> 'group' or v_chat.created_by = p_user_id) then
      perform public.dj_delete_chat_data(p_chat_id);
      return jsonb_build_object('ok', true, 'deleted', true, 'permanent', true);
    end if;
    -- Salida simple (grupo no creador, o leave).
    delete from public.chat_participants where chat_id = p_chat_id and user_id = p_user_id;
    delete from public.message_reads where chat_id = p_chat_id and user_id = p_user_id;
    select count(*) into v_count from public.chat_participants where chat_id = p_chat_id;
    if v_count = 0 then
      perform public.dj_delete_chat_data(p_chat_id);
      return jsonb_build_object('ok', true, 'left', true, 'chat_deleted', true);
    end if;
    return jsonb_build_object('ok', true, 'left', true, 'chat_deleted', false);
  end $fn$;

  create or replace function public.dj_pay_quota(p_group_id uuid, p_user_id uuid, p_accept_terms boolean default false)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare
    v_cycle uuid; v_g public.djangue_groups; v_m public.djangue_members;
    v_prev public.djangue_contributions; v_journal jsonb; v_journal_id uuid;
    v_active int; v_paid int; v_quota numeric;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if v_g.status <> 'active' then raise exception 'GROUP_NOT_ACTIVE: El djangue no está activo'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select * into v_m from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed' for update;
    if not found then raise exception 'FORBIDDEN: No participas en este djangue'; end if;
    if v_m.turn_order = v_g.current_turn then raise exception 'BENEFICIARY_DOES_NOT_PAY: Este turno te toca recibir'; end if;
    if not exists (select 1 from public.djangue_consents where group_id = p_group_id and cycle_id = v_cycle and user_id = p_user_id) then
      if p_accept_terms then perform public.dj_consent_accept(p_group_id, p_user_id, v_cycle);
      else raise exception 'CONSENT_REQUIRED: Acepta los términos del djangue antes de pagar'; end if;
    end if;
    select * into v_prev from public.djangue_contributions
      where group_id = p_group_id and cycle_id = v_cycle and user_id = p_user_id and turn_number = v_g.current_turn;
    if found and v_prev.status = 'paid' then
      return jsonb_build_object('ok', true, 'already', true, 'amount', v_prev.amount, 'all_paid', false);
    end if;
    v_quota := round(v_g.quota_amount, 2);
    v_journal := public.ledger_post(p_user_id, 'pago_servicio',
      'DJG-' || p_group_id || '-' || v_cycle || '-T' || v_g.current_turn || '-' || p_user_id,
      'Cuota djangue ' || v_g.name || ' turno ' || v_g.current_turn,
      jsonb_build_array(
        jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'debit', 'amount', v_quota),
        jsonb_build_object('account', 'SYS-SUSPENSE', 'entry_type', 'credit', 'amount', v_quota)),
      p_group_id || ':' || v_cycle || ':T' || v_g.current_turn || ':' || p_user_id);
    if (v_journal->>'status') <> 'posted' then raise exception 'CHARGE_FAILED: El asiento no quedó publicado'; end if;
    v_journal_id := (v_journal->>'journal_id')::uuid;
    if found then
      update public.djangue_contributions set status = 'paid', amount = v_quota, paid_at = now(), transaction_id = v_journal_id where id = v_prev.id;
    else
      insert into public.djangue_contributions (group_id, cycle_id, member_id, user_id, turn_number, amount, status, paid_at, transaction_id)
      values (p_group_id, v_cycle, v_m.id, p_user_id, v_g.current_turn, v_quota, 'paid', now(), v_journal_id);
    end if;
    update public.djangue_wallets set balance = balance + v_quota, updated_at = now() where group_id = p_group_id;
    select count(*) into v_active from public.djangue_members where group_id = p_group_id and status <> 'removed';
    select count(*) into v_paid from public.djangue_contributions
      where group_id = p_group_id and cycle_id = v_cycle and turn_number = v_g.current_turn and status = 'paid';
    return jsonb_build_object('ok', true, 'amount', v_quota, 'journal_id', v_journal_id, 'all_paid', v_paid >= greatest(v_active - 1, 0));
  end $fn$;

  create or replace function public.dj_payout_turn(p_group_id uuid, p_actor_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare
    v_cycle uuid; v_g public.djangue_groups; v_c public.djangue_cycles;
    v_benef public.djangue_members; v_prev public.djangue_payouts;
    v_active int; v_base numeric; v_paid numeric; v_share numeric; v_amount numeric;
    v_remaining int; v_journal jsonb; v_journal_id uuid; v_row public.djangue_payouts;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if (p_actor_id is distinct from v_g.owner_id and p_actor_id is distinct from v_g.secretary_id)
      or not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_actor_id and status <> 'removed') then raise exception 'FORBIDDEN: Solo el administrador entrega el pozo'; end if;
    if v_g.status <> 'active' then raise exception 'GROUP_NOT_ACTIVE: El djangue no está activo'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select * into v_c from public.djangue_cycles where id = v_cycle for update;
    select * into v_prev from public.djangue_payouts where group_id = p_group_id and cycle_id = v_cycle and turn_number = v_g.current_turn and status = 'completed';
    if found then return jsonb_build_object('ok', true, 'already', true, 'payout', to_jsonb(v_prev), 'amount', v_prev.amount); end if;
    select * into v_benef from public.djangue_members where group_id = p_group_id and turn_order = v_g.current_turn and status <> 'removed';
    if not found then raise exception 'NO_BENEFICIARY: No hay beneficiario para este turno'; end if;
    select count(*) into v_active from public.djangue_members where group_id = p_group_id and status <> 'removed';
    v_base := round(v_g.quota_amount * greatest(v_active - 1, 0), 2);
    select coalesce(sum(amount), 0) into v_paid from public.djangue_contributions
      where group_id = p_group_id and cycle_id = v_cycle and turn_number = v_g.current_turn and status = 'paid';
    if exists (select 1 from public.djangue_members m
      where m.group_id = p_group_id and m.status <> 'removed' and m.user_id <> v_benef.user_id
        and not exists (select 1 from public.djangue_contributions c
          where c.group_id = p_group_id and c.cycle_id = v_cycle and c.turn_number = v_g.current_turn
            and c.user_id = m.user_id and c.status = 'paid' and c.amount >= v_g.quota_amount)) then
      raise exception 'POT_INCOMPLETE: Faltan cuotas por pagar en este turno';
    end if;
    v_remaining := greatest(v_c.total_turns - v_g.current_turn + 1, 1);
    if v_remaining = 1 then v_share := v_c.settlement_balance;
    else v_share := least(round(v_c.settlement_balance / v_remaining, 2), v_c.settlement_balance); end if;
    v_amount := round(v_paid + v_share, 2);
    if v_amount <= 0 then raise exception 'NOTHING_TO_PAY: No hay fondo que entregar'; end if;
    v_journal := public.ledger_post(v_benef.user_id, 'reembolso',
      'DJGP-' || p_group_id || '-' || v_cycle || '-T' || v_g.current_turn,
      'Entrega djangue ' || v_g.name || ' turno ' || v_g.current_turn,
      jsonb_build_array(
        jsonb_build_object('account', 'SYS-SUSPENSE', 'entry_type', 'debit', 'amount', v_amount),
        jsonb_build_object('wallet_user_id', v_benef.user_id, 'entry_type', 'credit', 'amount', v_amount)),
      p_group_id || ':' || v_cycle || ':payout:T' || v_g.current_turn);
    if (v_journal->>'status') <> 'posted' then raise exception 'PAYOUT_FAILED: El asiento no quedó publicado'; end if;
    v_journal_id := (v_journal->>'journal_id')::uuid;
    insert into public.djangue_payouts (group_id, cycle_id, beneficiary_id, turn_number, amount, expected_amount, status, paid_at)
    values (p_group_id, v_cycle, v_benef.user_id, v_g.current_turn, v_amount, round(v_base + v_share, 2), 'completed', now())
    returning * into v_row;
    update public.djangue_wallets set balance = greatest(balance - v_amount, 0), updated_at = now() where group_id = p_group_id;
    update public.djangue_cycles set settlement_balance = settlement_balance - v_share where id = v_cycle;
    return jsonb_build_object('ok', true, 'payout', to_jsonb(v_row), 'amount', v_amount, 'journal_id', v_journal_id, 'settlement_share', v_share);
  end $fn$;

  create or replace function public.dj_advance_turn(p_group_id uuid, p_actor_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare
    v_cycle uuid; v_g public.djangue_groups; v_c public.djangue_cycles;
    v_entregado boolean; v_next int; v_fin timestamptz; v_m record;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if (p_actor_id is distinct from v_g.owner_id and p_actor_id is distinct from v_g.secretary_id)
      or not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_actor_id and status <> 'removed') then raise exception 'FORBIDDEN: Solo el administrador avanza el turno'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select * into v_c from public.djangue_cycles where id = v_cycle for update;
    if v_g.status = 'completed' and v_c.status = 'completed' then
      return jsonb_build_object('ok', true, 'already', true, 'completed', true, 'new_turn', v_g.current_turn, 'cycle_id', v_cycle);
    end if;
    if v_g.status <> 'active' then raise exception 'GROUP_NOT_ACTIVE: El djangue no está activo'; end if;
    select exists (select 1 from public.djangue_payouts where group_id = p_group_id and cycle_id = v_cycle and turn_number = v_g.current_turn and status = 'completed') into v_entregado;
    if not v_entregado then raise exception 'PAYOUT_PENDING: Primero entrega el pozo de este turno'; end if;
    if v_g.current_turn >= v_c.total_turns then
      update public.djangue_cycles set status = 'completed', completed_at = now() where id = v_cycle;
      update public.djangue_groups set status = 'completed', updated_at = now() where id = p_group_id;
      for v_m in select user_id from public.djangue_members where group_id = p_group_id and status <> 'removed' loop
        insert into public.djangue_notifications (group_id, cycle_id, user_id, type, title, message)
        values (p_group_id, v_cycle, v_m.user_id, 'cycle_completed', 'Ciclo completado',
                'El djangue ' || v_g.name || ' completó su ciclo. Elige continuar o salir.');
      end loop;
      return jsonb_build_object('ok', true, 'completed', true, 'new_turn', v_g.current_turn, 'cycle_id', v_cycle);
    end if;
    v_next := v_g.current_turn + 1;
    v_fin := now() + (case v_g.frequency when 'daily' then interval '1 day' when 'weekly' then interval '7 days' when 'monthly' then interval '30 days' else interval '365 days' end);
    update public.djangue_groups set current_turn = v_next, period_start_date = now(), period_end_date = v_fin, next_payout_at = v_fin, updated_at = now() where id = p_group_id;
    return jsonb_build_object('ok', true, 'completed', false, 'new_turn', v_next, 'cycle_id', v_cycle);
  end $fn$;

  create or replace function public.dj_cycle_decision(p_group_id uuid, p_user_id uuid, p_decision text, p_accept_terms boolean default false)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_cycle uuid; v_g public.djangue_groups; v_status text; v_active int; v_snap jsonb;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    select status into v_status from public.djangue_cycles where id = v_cycle;
    if v_status <> 'completed' then raise exception 'CYCLE_NOT_COMPLETED: El ciclo aún no termina'; end if;
    if not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed') then
      raise exception 'FORBIDDEN: No participas en este djangue';
    end if;
    if p_decision = 'leave' then
      perform public.dj_settle_and_exit(p_group_id, p_user_id, p_user_id, true);
      insert into public.djangue_cycle_decisions (group_id, cycle_id, user_id, decision)
      values (p_group_id, v_cycle, p_user_id, 'leave') on conflict (cycle_id, user_id) do update set decision = 'leave', decided_at = now();
      return jsonb_build_object('ok', true, 'decision', 'left');
    elsif p_decision = 'continue' then
      if not p_accept_terms then raise exception 'CONSENT_REQUIRED: Acepta los términos del próximo ciclo'; end if;
      select count(*) into v_active from public.djangue_members where group_id = p_group_id and status <> 'removed';
      v_snap := jsonb_build_object('version', 'v1', 'quota_amount', v_g.quota_amount, 'total_turns', greatest(v_active, 2));
      insert into public.djangue_cycle_decisions (group_id, cycle_id, user_id, decision, consent_snapshot)
      values (p_group_id, v_cycle, p_user_id, 'continue', v_snap)
      on conflict (cycle_id, user_id) do update set decision = 'continue', consent_snapshot = v_snap, decided_at = now();
      return jsonb_build_object('ok', true, 'decision', 'continue');
    end if;
    raise exception 'VALIDATION_ERROR: Decisión no válida';
  end $fn$;

  create or replace function public.dj_confirm_exit(p_group_id uuid, p_user_id uuid, p_quote jsonb, p_completed boolean)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_g public.djangue_groups; v_quote jsonb;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed') then
      raise exception 'FORBIDDEN: No participas en este djangue';
    end if;
    v_quote := public.dj_exit_quote(p_group_id, p_user_id);
    if p_quote is null or v_quote is distinct from p_quote then
      raise exception 'QUOTE_CHANGED: La liquidacion ha cambiado; revisa y confirma el importe de nuevo';
    end if;
    if p_completed then return public.dj_cycle_decision(p_group_id, p_user_id, 'leave', false); end if;
    return public.dj_settle_and_exit(p_group_id, p_user_id, p_user_id, true);
  end $fn$;

  create or replace function public.dj_start_next_cycle(p_group_id uuid, p_actor_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare
    v_g public.djangue_groups; v_old uuid; v_new uuid; v_num int;
    v_active int; v_pending int; v_m record; v_idx int := 0; v_snap jsonb; v_end timestamptz;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_actor_id and status <> 'removed')
      or (p_actor_id is distinct from v_g.owner_id and (p_actor_id is distinct from v_g.secretary_id
        or exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = v_g.owner_id and status <> 'removed'))) then
      raise exception 'FORBIDDEN: Solo quien administra el djangue inicia el próximo ciclo';
    end if;
    if v_g.status <> 'completed' then raise exception 'CYCLE_NOT_COMPLETED: El djangue no admite otro ciclo'; end if;
    v_old := public.dj_ensure_cycle(p_group_id);
    if (select status from public.djangue_cycles where id = v_old) <> 'completed' then
      raise exception 'CYCLE_NOT_COMPLETED: El ciclo actual no ha terminado';
    end if;
    select count(*) into v_active from public.djangue_members where group_id = p_group_id and status <> 'removed';
    if v_active < 2 then raise exception 'NOT_ENOUGH_MEMBERS: Se necesitan al menos 2 integrantes'; end if;
    select count(*) into v_pending from public.djangue_members m
      where m.group_id = p_group_id and m.status <> 'removed'
        and not exists (select 1 from public.djangue_cycle_decisions d where d.cycle_id = v_old and d.user_id = m.user_id and d.decision = 'continue');
    if v_pending > 0 then raise exception 'DECISIONS_PENDING: Faltan integrantes por decidir'; end if;
    select coalesce(max(cycle_number), 0) + 1 into v_num from public.djangue_cycles where group_id = p_group_id;
    insert into public.djangue_cycles (group_id, cycle_number, status, quota_amount, total_turns)
    values (p_group_id, v_num, 'active', v_g.quota_amount, v_active) returning id into v_new;
    for v_m in select * from public.djangue_members where group_id = p_group_id and status <> 'removed' order by turn_order loop
      v_idx := v_idx + 1;
      update public.djangue_members set turn_order = v_idx where id = v_m.id;
      select consent_snapshot into v_snap from public.djangue_cycle_decisions where cycle_id = v_old and user_id = v_m.user_id;
      insert into public.djangue_consents (group_id, cycle_id, user_id, version, quota_amount, total_turns, max_contribution, terms_hash)
      values (p_group_id, v_new, v_m.user_id, coalesce(v_snap->>'version', 'v1'), v_g.quota_amount, v_g.max_members,
              round(v_g.quota_amount * greatest(v_g.max_members - 1, 0), 2),
              md5('v1|' || p_group_id || '|' || v_new || '|' || v_g.quota_amount || '|' || v_g.max_members || '|' || v_g.frequency || '|' || v_g.penalty_percent))
      on conflict (group_id, cycle_id, user_id) do nothing;
      insert into public.djangue_notifications (group_id, cycle_id, user_id, type, title, message)
      values (p_group_id, v_new, v_m.user_id, 'cycle_started', 'Nuevo ciclo', 'El djangue ' || v_g.name || ' inició un nuevo ciclo.');
    end loop;
    v_end := now() + (case v_g.frequency when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
      when 'monthly' then interval '30 days' else interval '365 days' end);
    update public.djangue_groups set current_cycle_id = v_new, current_turn = 1, total_turns = v_active,
      status = 'active', period_start_date = now(), period_end_date = v_end, next_payout_at = v_end, updated_at = now() where id = p_group_id;
    return jsonb_build_object('ok', true, 'cycle_id', v_new, 'cycle_number', v_num, 'total_turns', v_active);
  end $fn$;

  create or replace function public.dj_create_group(p_owner_id uuid, p_name text, p_frequency text, p_quota numeric,
    p_max_members integer, p_secretary_id uuid default null, p_description text default null, p_logo_url text default null)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_g public.djangue_groups; v_cycle uuid; v_inv jsonb; v_end timestamptz;
  begin
    if nullif(trim(p_name), '') is null or p_quota <= 0 or p_max_members not between 2 and 50
      or p_frequency not in ('daily', 'weekly', 'monthly', 'annual') then
      raise exception 'VALIDATION_ERROR: Datos del djangue no válidos';
    end if;
    v_end := now() + (case p_frequency when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
      when 'monthly' then interval '30 days' else interval '365 days' end);
    insert into public.djangue_groups (name, description, logo_url, frequency, quota_amount, currency,
      max_members, owner_id, secretary_id, current_turn, total_turns, period_start_date, period_end_date, next_payout_at)
    values (trim(p_name), p_description, p_logo_url, p_frequency, round(p_quota, 2), 'XAF', p_max_members,
      p_owner_id, p_secretary_id, 1, 1, now(), v_end, v_end) returning * into v_g;
    insert into public.djangue_wallets (group_id, balance, currency) values (v_g.id, 0, 'XAF');
    insert into public.djangue_members (group_id, user_id, turn_order, status) values (v_g.id, p_owner_id, 1, 'active');
    v_cycle := public.dj_ensure_cycle(v_g.id);
    update public.djangue_cycles set status = 'forming' where id = v_cycle;
    perform public.dj_consent_accept(v_g.id, p_owner_id, v_cycle);
    if p_secretary_id is not null and p_secretary_id <> p_owner_id then
      v_inv := public.dj_invite_member(v_g.id, p_owner_id, p_secretary_id);
    end if;
    select * into v_g from public.djangue_groups where id = v_g.id;
    return jsonb_build_object('group', to_jsonb(v_g), 'invitation', v_inv->'invitation');
  end $fn$;

  create or replace function public.dj_invite_member(p_group_id uuid, p_actor_id uuid, p_user_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_g public.djangue_groups; v_cycle uuid; v_row public.djangue_invitations; v_phone text;
  begin
    select * into v_g from public.djangue_groups where id = p_group_id for update;
    if not found then raise exception 'GROUP_NOT_FOUND: Djangue no encontrado'; end if;
    if (p_actor_id is distinct from v_g.owner_id and p_actor_id is distinct from v_g.secretary_id)
      or not exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_actor_id and status <> 'removed') then raise exception 'FORBIDDEN: Solo el administrador invita'; end if;
    if v_g.status <> 'active' then raise exception 'GROUP_NOT_ACTIVE: El djangue no está activo'; end if;
    v_cycle := public.dj_ensure_cycle(p_group_id);
    if exists (select 1 from public.djangue_contributions where group_id = p_group_id and cycle_id = v_cycle and status = 'paid')
       or exists (select 1 from public.djangue_payouts where group_id = p_group_id and cycle_id = v_cycle and status = 'completed') then
      raise exception 'ROSTER_LOCKED: El ciclo ya tiene pagos; no se pueden añadir integrantes';
    end if;
    if exists (select 1 from public.djangue_members where group_id = p_group_id and user_id = p_user_id and status <> 'removed') then
      raise exception 'ALREADY_MEMBER: Ese usuario ya es integrante';
    end if;
    if (select count(*) from public.djangue_members where group_id = p_group_id and status <> 'removed') >= v_g.max_members then
      raise exception 'GROUP_FULL: El djangue está lleno';
    end if;
    select phone into v_phone from public.users where id = p_user_id;
    if v_phone is null then raise exception 'USER_NOT_FOUND: Usuario no encontrado'; end if;
    insert into public.djangue_invitations (group_id, user_id, phone, invited_by)
    values (p_group_id, p_user_id, v_phone, p_actor_id)
    on conflict (group_id, user_id) where status = 'pending' do update set created_at = now(), invited_by = p_actor_id
    returning * into v_row;
    insert into public.djangue_notifications (group_id, cycle_id, user_id, type, title, message)
    values (p_group_id, v_cycle, p_user_id, 'invitation', 'Invitación a Djangue',
            'Te invitaron a ' || v_g.name || '. Abre la invitación y acepta los términos para entrar.');
    return jsonb_build_object('ok', true, 'invitation', to_jsonb(v_row));
  end $fn$;

  create or replace function public.dj_accept_invitation(p_invitation_id uuid, p_user_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_inv public.djangue_invitations; v_g public.djangue_groups; v_cycle uuid; v_next int; v_m public.djangue_members;
  begin
    select * into v_inv from public.djangue_invitations where id = p_invitation_id for update;
    if not found then raise exception 'INVITATION_NOT_FOUND: Invitación no encontrada'; end if;
    if v_inv.user_id <> p_user_id then raise exception 'FORBIDDEN: La invitación no es para ti'; end if;
    if v_inv.status <> 'pending' then raise exception 'INVITATION_CLOSED: La invitación ya fue respondida'; end if;
    select * into v_g from public.djangue_groups where id = v_inv.group_id for update;
    if v_g.status <> 'active' then raise exception 'GROUP_NOT_ACTIVE: El djangue no está activo'; end if;
    v_cycle := public.dj_ensure_cycle(v_inv.group_id);
    if exists (select 1 from public.djangue_contributions where group_id = v_inv.group_id and cycle_id = v_cycle and status = 'paid')
       or exists (select 1 from public.djangue_payouts where group_id = v_inv.group_id and cycle_id = v_cycle and status = 'completed') then
      raise exception 'ROSTER_LOCKED: El ciclo ya tiene pagos; la invitación caducó';
    end if;
    if (select count(*) from public.djangue_members where group_id = v_inv.group_id and status <> 'removed') >= v_g.max_members then
      raise exception 'GROUP_FULL: El djangue está lleno';
    end if;
    select coalesce(max(turn_order), 0) + 1 into v_next from public.djangue_members where group_id = v_inv.group_id and status <> 'removed';
    insert into public.djangue_members (group_id, user_id, turn_order, status)
    values (v_inv.group_id, p_user_id, v_next, 'active')
    on conflict (group_id, user_id) do update set status = 'active', turn_order = v_next, joined_at = now()
    returning * into v_m;
    update public.djangue_groups set total_turns = total_turns + 1, updated_at = now() where id = v_inv.group_id;
    update public.djangue_cycles set total_turns = total_turns + 1, status = 'active' where id = v_cycle;
    perform public.dj_consent_accept(v_inv.group_id, p_user_id, v_cycle);
    update public.djangue_invitations set status = 'accepted', responded_at = now() where id = p_invitation_id;
    if v_g.chat_group_id is not null then
      insert into public.chat_participants (chat_id, user_id, role)
      select v_g.chat_group_id, p_user_id, case when v_g.secretary_id = p_user_id then 'admin' else 'member' end
      where not exists (select 1 from public.chat_participants where chat_id = v_g.chat_group_id and user_id = p_user_id);
    end if;
    return jsonb_build_object('ok', true, 'member', to_jsonb(v_m), 'group_id', v_inv.group_id);
  end $fn$;

  create or replace function public.dj_decline_invitation(p_invitation_id uuid, p_user_id uuid)
  returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $fn$
  declare v_inv public.djangue_invitations;
  begin
    select * into v_inv from public.djangue_invitations where id = p_invitation_id for update;
    if not found then raise exception 'INVITATION_NOT_FOUND: Invitación no encontrada'; end if;
    if v_inv.user_id <> p_user_id then raise exception 'FORBIDDEN: La invitación no es para ti'; end if;
    if v_inv.status <> 'pending' then raise exception 'INVITATION_CLOSED: La invitación ya fue respondida'; end if;
    update public.djangue_invitations set status = 'declined', responded_at = now() where id = p_invitation_id;
    return jsonb_build_object('ok', true);
  end $fn$;

  -- ── Permisos: solo service_role (el dueño local conserva ejecución) ────
  revoke all on function public.dj_create_group(uuid, text, text, numeric, integer, uuid, text, text) from public, anon, authenticated;
  grant execute on function public.dj_create_group(uuid, text, text, numeric, integer, uuid, text, text) to service_role;
  revoke all on function public.dj_delete_chat_data(uuid) from public, anon, authenticated;
  grant execute on function public.dj_delete_chat_data(uuid) to service_role;
  revoke all on function public.dj_confirm_exit(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
  grant execute on function public.dj_confirm_exit(uuid, uuid, jsonb, boolean) to service_role;
  revoke all on function public.dj_ensure_cycle(uuid) from public, anon, authenticated;
  revoke all on function public.dj_consent_accept(uuid, uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_exit_quote(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_settle_and_exit(uuid, uuid, uuid, boolean) from public, anon, authenticated;
  revoke all on function public.dj_delete_group(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_guard_chat_action(uuid, uuid, uuid, text) from public, anon, authenticated;
  revoke all on function public.chat_safe_delete(uuid, uuid, boolean) from public, anon, authenticated;
  revoke all on function public.dj_pay_quota(uuid, uuid, boolean) from public, anon, authenticated;
  revoke all on function public.dj_payout_turn(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_advance_turn(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_cycle_decision(uuid, uuid, text, boolean) from public, anon, authenticated;
  revoke all on function public.dj_start_next_cycle(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_invite_member(uuid, uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_accept_invitation(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.dj_decline_invitation(uuid, uuid) from public, anon, authenticated;
  grant execute on function public.dj_ensure_cycle(uuid) to service_role;
  grant execute on function public.dj_consent_accept(uuid, uuid, uuid) to service_role;
  grant execute on function public.dj_exit_quote(uuid, uuid) to service_role;
  grant execute on function public.dj_settle_and_exit(uuid, uuid, uuid, boolean) to service_role;
  grant execute on function public.dj_delete_group(uuid, uuid) to service_role;
  grant execute on function public.dj_guard_chat_action(uuid, uuid, uuid, text) to service_role;
  grant execute on function public.chat_safe_delete(uuid, uuid, boolean) to service_role;
  grant execute on function public.dj_pay_quota(uuid, uuid, boolean) to service_role;
  grant execute on function public.dj_payout_turn(uuid, uuid) to service_role;
  grant execute on function public.dj_advance_turn(uuid, uuid) to service_role;
  grant execute on function public.dj_cycle_decision(uuid, uuid, text, boolean) to service_role;
  grant execute on function public.dj_start_next_cycle(uuid, uuid) to service_role;
  grant execute on function public.dj_invite_member(uuid, uuid, uuid) to service_role;
  grant execute on function public.dj_accept_invitation(uuid, uuid) to service_role;
  grant execute on function public.dj_decline_invitation(uuid, uuid) to service_role;

  alter table public.djangue_cycles enable row level security;
  alter table public.djangue_consents enable row level security;
  alter table public.djangue_invitations enable row level security;
  alter table public.djangue_cycle_decisions enable row level security;
  alter table public.djangue_settlements enable row level security;
  revoke all on table public.djangue_cycles, public.djangue_consents, public.djangue_invitations,
    public.djangue_cycle_decisions, public.djangue_settlements from public, anon, authenticated;
  grant select, insert, update, delete on table public.djangue_cycles, public.djangue_consents, public.djangue_invitations,
    public.djangue_cycle_decisions, public.djangue_settlements to service_role;
  perform pg_notify('pgrst', 'reload schema');
end $dj$;
