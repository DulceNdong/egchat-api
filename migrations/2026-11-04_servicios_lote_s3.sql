-- EGPay - Lote S3 (v2): la prima del seguro la fija la tabla y la poliza queda escrita.
--
-- Lo que cierra:
--   - `/api/seguros/companias/:id/productos` fabricaba el precio con `(i+1)*5000`:
--     el catalogo dependia del orden de un array de JavaScript, no de ningun
--     acuerdo con la aseguradora.
--   - `/api/seguros/solicitar` guardaba `amount: 0` y `status: 'pending'`. No se
--     cobraba la prima y no quedaba poliza en ningun sitio: el cliente pulsaba
--     "contratar", veia el ticket de exito y la cartera no se enteraba.
--
-- A partir de aqui la prima vive en `service_tariffs` (service = compania,
-- variant = producto), el alta se asienta con `insurance_take_out()` por lo que
-- dice esa tabla, y la poliza es una fila en `insurance_policies` con su
-- `journal_id`. La contrapartida sigue siendo SYS-SUSPENSE: el operador retiene
-- esa prima hasta liquidarla con la aseguradora. No se inventa caja.
--
-- Los siniestros (`insurance_claims`) son solo registro: abrir una reclamacion no
-- devuelve dinero al usuario. La liquidacion la hace el operador en su propio
-- lote, con su propia clave de idempotencia.
--
-- Idempotente: el asiento lleva clave `INS-<compania>-<referencia>` y la poliza
-- tiene `policy_ref` unico, asi que un doble clic devuelve la poliza ya emitida en
-- vez de cobrar dos primas. La semilla usa `on conflict do nothing` para no pisar
-- primas que el operador ya haya corregido.
--
-- POR QUE ESTA REESCRITO. La v1 era `create table if not exists` sobre
-- `insurance_policies` e `insurance_claims`, y en la base real ESAS TABLAS YA
-- EXISTEN con la forma antigua (insurance_type, coverage_amount, duration_months,
-- monthly_premium, total_premium, start_date, end_date) y con filas dentro. Comprobado
-- en una copia con la forma antigua y 3 polizas: la v1 se ejecutaba sin error, su
-- propia autocomprobacion daba `tablas=2 | funciones=1 | cadenas_rotas=0` (todo
-- verde) y luego `insurance_take_out()` reventaba en el primer clic del boton
-- porque `policy_ref` no existia. Es decir: el lote mentia y dejaba la contratacion
-- de seguros inservible. Esta v2 ADDITIVA completa las columnas que faltan sobre la
-- tabla que haya, conserva las filas antiguas y normaliza su contenido.
--
-- Decision de modelado: en la via antigua las columnas nuevas quedan
-- NULLABLES (no `not null`). Si se forzaran a no nulo, la API todavia desplegada,
-- que escribe solo las columnas antiguas, dejaria de contratar seguros en el
-- intervalo entre pegar este lote y desplegar. El indice unico sobre `policy_ref`
-- si se pone, y `insurance_take_out()` nunca deja ninguna de esas columnas vacia.

-- ---------------------------------------------------------------------------
-- Todo el lote es UNA sola sentencia: el editor de Supabase parte el guion por
-- los punto y coma y ejecuta cada trozo en su propia transaccion, asi que un
-- bloque unico es lo unico que llega a produccion intacto y re-ejecutable.
-- ---------------------------------------------------------------------------
do $s3$
declare
  legado     boolean;
  hay_s2     boolean;
begin
  -- Guarda de dependencia: sin el Lote S2 no hay donde leer la prima.
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'service_tariffs'
                    and column_name = 'variant')
    into hay_s2;
  if not hay_s2 then
    raise exception 'LOTE S3 abortado: no existe service_tariffs.variant. Pega antes el Lote S2.';
  end if;

  -- 1) Las tablas, para una base limpia. Si ya existen (produccion) esto no las toca.
  execute $tbl$
    create table if not exists public.insurance_policies (
      id          uuid primary key default gen_random_uuid(),
      policy_ref  text   not null unique,
      user_id     uuid   not null references public.users(id) on delete cascade,
      company     text   not null,
      product     text   not null,
      premium     numeric(14,2) not null check (premium > 0),
      currency    text   not null default 'XAF',
      status      text   not null default 'active'
                        check (status in ('active','cancelled','expired')),
      insured     jsonb,
      journal_id  uuid   references public.ledger_journals(id),
      starts_at   timestamptz not null default now(),
      expires_at  timestamptz,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    )
  $tbl$;

  execute $clt$
    create table if not exists public.insurance_claims (
      id             uuid primary key default gen_random_uuid(),
      claim_ref      text   not null unique,
      policy_id      uuid   not null references public.insurance_policies(id) on delete cascade,
      user_id        uuid   not null references public.users(id) on delete cascade,
      amount_claimed numeric(14,2) not null check (amount_claimed > 0),
      status         text   not null default 'abierto'
                          check (status in ('abierto','en_revision','liquidado','rechazado')),
      notes          text,
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now()
    )
  $clt$;

  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'insurance_policies'
                    and column_name = 'insurance_type')
    into legado;

  if legado then
    -- 2) Forma antigua: se ANADEN las columnas que faltan. Nadie borra nada.
    execute $alt$
      alter table public.insurance_policies
        add column if not exists policy_ref text,
        add column if not exists company    text,
        add column if not exists product    text,
        add column if not exists premium    numeric(14,2),
        add column if not exists currency   text,
        add column if not exists insured    jsonb,
        add column if not exists journal_id uuid,
        add column if not exists starts_at  timestamptz,
        add column if not exists expires_at timestamptz,
        add column if not exists created_at timestamptz not null default now(),
        add column if not exists updated_at timestamptz not null default now()
    $alt$;

    -- Las antiguas dejan de ser obligatorias: la API nueva solo escribe las nuevas,
    -- y si se quedaran en `not null` el alta de poliza fallaria por columnas vacias.
    execute $dnn$
      alter table public.insurance_policies
        alter column insurance_type   drop not null,
        alter column coverage_amount  drop not null,
        alter column duration_months  drop not null,
        alter column monthly_premium  drop not null,
        alter column total_premium    drop not null,
        alter column user_id          set not null
    $dnn$;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.insurance_policies'::regclass
                      and conname  = 'fk_insurance_policy_journal') then
      execute $fk$
        alter table public.insurance_policies
          add constraint fk_insurance_policy_journal
          foreign key (journal_id) references public.ledger_journals(id)
      $fk$;
    end if;

    execute $altc$
      alter table public.insurance_claims
        add column if not exists claim_ref      text,
        add column if not exists amount_claimed numeric(14,2),
        add column if not exists notes          text,
        add column if not exists created_at     timestamptz not null default now(),
        add column if not exists updated_at     timestamptz not null default now(),
        alter column claim_type   drop not null,
        alter column amount       drop not null,
        alter column status       set default 'abierto'
    $altc$;

    -- La tabla heredada puede no tener fecha de creacion (medido en produccion el
    -- 2026-11-05: no la tenia). Recien anadida vale `now()`, pero si existia
    -- `submitted_at` esa es la fecha real del siniestro y no se sustituye.
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'insurance_claims'
                  and column_name = 'submitted_at') then
      execute $fcs$
        update public.insurance_claims
           set created_at = submitted_at
         where submitted_at is not null
      $fcs$;
    end if;

    -- 3) Las polizas viejas entran en el modelo nuevo: referencia propia, compania
    --    y producto sacados del tipo antiguo, y la prima que ya constaba.
    execute $bak$
      update public.insurance_policies
         set policy_ref = coalesce(policy_ref, 'LEG-' || id::text),
             company    = coalesce(company, insurance_type),
             product    = coalesce(product, insurance_type),
             premium    = coalesce(premium, total_premium,
                                   monthly_premium * greatest(coalesce(duration_months, 1), 1)),
             currency   = coalesce(currency, 'XAF'),
             starts_at  = coalesce(starts_at, start_date, created_at, now()),
             expires_at = coalesce(expires_at, end_date)
       where policy_ref   is null
          or company      is null
          or premium      is null
          or currency     is null
          or starts_at    is null
    $bak$;

    execute $bakc$
      update public.insurance_claims
         set claim_ref      = coalesce(claim_ref, 'LEGC-' || id::text),
             amount_claimed = coalesce(amount_claimed, amount),
             notes          = coalesce(notes, description)
       where claim_ref is null
          or amount_claimed is null
    $bakc$;

    -- Unicidad de la referencia, tambien en la tabla heredada.
    execute $uix$
      create unique index if not exists uix_insurance_policy_ref
        on public.insurance_policies (policy_ref)
    $uix$;
    execute $uixc$
      create unique index if not exists uix_insurance_claim_ref
        on public.insurance_claims (claim_ref)
    $uixc$;

    raise notice 'LOTE S3: forma antigua detectada y completada (polizas=%, siniestros=%)',
      (select count(*) from public.insurance_policies),
      (select count(*) from public.insurance_claims);
  else
    raise notice 'LOTE S3: tablas nuevas creadas con el modelo completo';
  end if;

  -- Indices con guarda: un indice sobre una columna que la tabla heredada no tenga
  -- abortaba el bloque ENTERO (eso es lo que paso en produccion) y hacia retroceder
  -- tambien las primas sembradas. Ahora se omite y se avisa, no revienta.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'insurance_policies'
                and column_name = 'user_id')
     and exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'insurance_policies'
                and column_name = 'created_at') then
    execute $idx$
      create index if not exists ix_insurance_polizas_usuario
        on public.insurance_policies (user_id, created_at desc)
    $idx$;
  else
    raise notice 'LOTE S3: se omite ix_insurance_polizas_usuario (faltan columnas)';
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'insurance_claims'
                and column_name = 'policy_id')
     and exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'insurance_claims'
                and column_name = 'created_at') then
    execute $idxc$
      create index if not exists ix_insurance_siniestros_poliza
        on public.insurance_claims (policy_id, created_at desc)
    $idxc$;
  else
    raise notice 'LOTE S3: se omite ix_insurance_siniestros_poliza (faltan columnas)';
  end if;

  -- 4) Las primas, leidas del acuerdo con cada compania. `on conflict do nothing`
  --    para no pisar una prima que el operador ya haya corregido.
  insert into public.service_tariffs (service, variant, amount, concept) values
    ('coge',    'vida',         25000, 'COGE Seguros - Vida, 12 meses'),
    ('coge',    'salud',        40000, 'COGE Seguros - Salud, 12 meses'),
    ('coge',    'auto',         60000, 'COGE Seguros - Auto, 12 meses'),
    ('coge',    'hogar',        18000, 'COGE Seguros - Hogar, 12 meses'),
    ('siat',    'auto',         55000, 'SIAT Guinea - Auto, 12 meses'),
    ('siat',    'empresarial', 120000, 'SIAT Guinea - Empresarial, 12 meses'),
    ('siat',    'transporte',  90000, 'SIAT Guinea - Transporte, 12 meses'),
    ('allianz', 'vida',         28000, 'Allianz GE - Vida, 12 meses'),
    ('allianz', 'salud',        45000, 'Allianz GE - Salud, 12 meses'),
    ('allianz', 'viaje',        15000, 'Allianz GE - Viaje, 12 meses')
  on conflict (service, variant) do nothing;

  -- 5) Unica puerta del alta de póliza. Lee la prima de service_tariffs, asienta
  --    con ledger_post (idempotente por clave) y escribe la póliza con su asiento.
  execute $fn$
    create or replace function public.insurance_take_out(
      p_user_id uuid,
      p_company text,
      p_product text,
      p_ref     text
    ) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $body$
    declare
      t   record;
      pol public.insurance_policies;
      r   jsonb;
    begin
      if p_user_id is null then
        raise exception 'insurance_take_out necesita el usuario que contrata';
      end if;
      if nullif(p_ref, '') is null then
        raise exception 'insurance_take_out necesita la referencia de la poliza';
      end if;

      select * into pol from public.insurance_policies where policy_ref = p_ref;
      if found then
        return jsonb_build_object('ok', true, 'idempotent', true,
          'policy_id', pol.id, 'policy_ref', pol.policy_ref,
          'company', pol.company, 'product', pol.product,
          'premium', pol.premium, 'currency', pol.currency,
          'journal_id', pol.journal_id, 'status', pol.status);
      end if;

      select * into t from public.service_tariffs
       where service = p_company and variant = p_product and active;
      if not found then
        return jsonb_build_object('ok', false, 'code', 'TARIFF_NOT_FOUND',
          'company', p_company, 'product', p_product);
      end if;

      r := public.ledger_post(
        p_user_id,
        'pago_servicio',
        'INS-' || upper(p_company) || '-' || upper(p_ref),
        coalesce(t.concept, p_company || ' ' || p_product),
        jsonb_build_array(
          jsonb_build_object('wallet_user_id', p_user_id, 'entry_type', 'debit',  'amount', t.amount),
          jsonb_build_object('account', 'SYS-SUSPENSE',    'entry_type', 'credit', 'amount', t.amount)
        ),
        p_company || ':' || p_ref
      );

      if coalesce(r ->> 'status', '') <> 'posted' then
        raise exception 'insurance_take_out: el asiento de % quedo en estado % en vez de posted. No se emite poliza.',
          p_ref, coalesce(r ->> 'status', 'sin respuesta');
      end if;

      insert into public.insurance_policies
        (policy_ref, user_id, company, product, premium, currency,
         insured, journal_id, starts_at, expires_at)
      values
        (p_ref, p_user_id, p_company, p_product, round(t.amount * 100) / 100,
         coalesce(t.currency, 'XAF'), null, (r ->> 'journal_id')::uuid,
         now(), now() + interval '12 months')
      returning * into pol;

      return jsonb_build_object(
        'ok', true,
        'policy_id', pol.id,
        'policy_ref', pol.policy_ref,
        'company', pol.company,
        'product', pol.product,
        'premium', pol.premium,
        'currency', pol.currency,
        'journal_id', pol.journal_id,
        'status', pol.status,
        'expires_at', to_char(pol.expires_at, 'YYYY-MM-DD')
      );
    end;
    $body$
  $fn$;

  -- 6) Permisos: la tabla y la funcion son del servicio. La app no escribe
  --    polizas por su cuenta; todo pasa por el API con service_role.
  execute $rls$ alter table public.insurance_policies enable row level security $rls$;
  execute $rlsc$ alter table public.insurance_claims  enable row level security $rlsc$;

  execute $gv$
    revoke all on public.insurance_policies, public.insurance_claims from anon, authenticated
  $gv$;
  execute $gr$
    grant select, insert, update, delete
      on public.insurance_policies, public.insurance_claims to service_role
  $gr$;
  execute $fr$
    revoke all on function public.insurance_take_out(uuid, text, text, text)
      from public, anon, authenticated
  $fr$;
  execute $fe$
    grant execute on function public.insurance_take_out(uuid, text, text, text) to service_role
  $fe$;

  raise notice 'LOTE S3 v2: primas=% | funcion=1 | rls activada en las dos tablas',
    (select count(*) from public.service_tariffs where service in ('coge','siat','allianz'));
end
$s3$;

-- Autocomprobacion en lista vertical (una fila por medida, sin desplazar columnas).
-- Las dos primeras deben dar `cierta`: es la prueba de que la tabla ya tiene la
-- forma nueva, que es justo lo que la v1 no hacia.
with s as (
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'insurance_policies'
                    and column_name = 'policy_ref')
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'insurance_policies'
                    and column_name = 'journal_id') as forma_ok,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'insurance_claims'
                  and column_name = 'claim_ref') as siniestros_ok
)
select 'forma_polizas_ok' as medida, s.forma_ok::text as valor from s
union all
select 'forma_siniestros_ok', s.siniestros_ok::text from s
union all
select 'polizas', (select count(*) from public.insurance_policies)::text
union all
select 'polizas_sin_asiento',
       (select count(*) from public.insurance_policies
         where journal_id is null or policy_ref is null)::text
union all
select 'polizas_ref_duplicada',
       (select count(*) from (select policy_ref from public.insurance_policies
                               group by policy_ref having count(*) > 1) d)::text
union all
select 'siniestros', (select count(*) from public.insurance_claims)::text
union all
select 'siniestros_sin_ref',
       (select count(*) from public.insurance_claims
         where claim_ref is null or amount_claimed is null)::text
union all
select 'primas_en_tabla',
       (select count(*) from public.service_tariffs
         where service in ('coge','siat','allianz'))::text
union all
select 'funcion_viva',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'insurance_take_out')::text
union all
select 'cadenas_rotas',
       (select (v ->> 'rotos')::int from public.ledger_verify_chain() v)::text;