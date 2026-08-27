-- ============================================================================
-- 026_delivery_confirmation_integrity.sql
-- Auth-ID queue isolation and replay-safe delivery confirmation.
--
-- Existing signature rows are preserved. They remain historical rows and are
-- never silently promoted to the new authoritative request contract.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.delivery_signatures') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regprocedure(
          'public.hc_claim_field_worker()'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_can_access_order_market(text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_confirm_order_delivery(uuid,timestamp with time zone,text,text,text)'
        ) is null then
    raise exception using
      errcode = '55000',
      message = '026 requires authenticated dashboard migrations 015 and 019';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'delivery_signed_at'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'delivery_signed_by'
  ) then
    raise exception using
      errcode = '55000',
      message = '026 requires the existing delivery stamp columns';
  end if;
end
$preflight$;

alter table public.delivery_signatures
  add column if not exists delivery_request_id uuid,
  add column if not exists actor_auth_user_id uuid,
  add column if not exists delivery_source text,
  add column if not exists is_authoritative boolean not null default false;

-- A partially prepared sandbox may have added this column without its final
-- nullability. Repair that shape without changing any prior signature data.
update public.delivery_signatures
set is_authoritative = false
where is_authoritative is null;

alter table public.delivery_signatures
  alter column is_authoritative set default false,
  alter column is_authoritative set not null;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.delivery_signatures'::pg_catalog.regclass
      and conname = 'delivery_signatures_request_id_key'
  ) then
    alter table public.delivery_signatures
      add constraint delivery_signatures_request_id_key
      unique (delivery_request_id);
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.delivery_signatures'::pg_catalog.regclass
      and conname = 'delivery_signatures_authoritative_shape_check'
  ) then
    alter table public.delivery_signatures
      add constraint delivery_signatures_authoritative_shape_check
      check (
        (
          is_authoritative is false
          and delivery_request_id is null
          and actor_auth_user_id is null
          and delivery_source is null
        ) or (
          is_authoritative is true
          and order_id is not null
          and delivery_request_id is not null
          and actor_auth_user_id is not null
          and delivery_source in ('dashboard', 'field-app')
        )
      ) not valid;
  end if;
end
$constraints$;

alter table public.delivery_signatures
  validate constraint delivery_signatures_authoritative_shape_check;

-- Prior migrations deliberately allowed multiple historical rows per order.
-- This partial unique index preserves them while permitting at most one row
-- under the new authoritative contract.
create unique index if not exists
  delivery_signatures_authoritative_order_uidx
on public.delivery_signatures (order_id)
where is_authoritative is true;

comment on column public.delivery_signatures.delivery_request_id is
  'Stable client request UUID. One UUID maps immutably to one confirmation payload.';
comment on column public.delivery_signatures.actor_auth_user_id is
  'Immutable Supabase Auth actor UUID captured when the confirmation is accepted.';
comment on column public.delivery_signatures.delivery_source is
  'Validated client source stored separately from the human-readable signed_via audit.';
comment on column public.delivery_signatures.is_authoritative is
  'True only for confirmations accepted through hc_confirm_order_delivery_v2.';

-- Return the immutable Auth UUID together with the existing server-derived
-- roster profile. Calling the proven v1 claim keeps first-login linking rules in
-- one place and prevents a client-supplied email from influencing identity.
create or replace function public.hc_claim_field_worker_v2()
returns table (
  auth_user_id uuid,
  email text,
  name text,
  market text,
  role text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_auth_user_id uuid := auth.uid();
begin
  if v_auth_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  return query
  select
    v_auth_user_id,
    claimed.email,
    claimed.name,
    claimed.market,
    claimed.role
  from public.hc_claim_field_worker() as claimed;
end
$function$;

-- A request UUID and order row are both serialized. The advisory lock covers
-- the first insert race where no request row exists yet. The order lock covers
-- competing request UUIDs for the same delivery.
create or replace function public.hc_confirm_order_delivery_v2(
  p_delivery_request_id uuid,
  p_order_id uuid,
  p_signed_at timestamptz,
  p_signed_by text,
  p_signature_data_url text,
  p_signed_via text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_actor_auth_user_id uuid := auth.uid();
  v_actor_email text;
  v_signed_by text := nullif(pg_catalog.btrim(p_signed_by), '');
  v_source text := pg_catalog.lower(
    nullif(pg_catalog.btrim(p_signed_via), '')
  );
  v_order public.orders%rowtype;
  v_existing public.delivery_signatures%rowtype;
  v_updated integer;
begin
  if v_actor_auth_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(worker.email))
  into v_actor_email
  from public.field_workers as worker
  where worker.auth_user_id = v_actor_auth_user_id
    and worker.active is true
  limit 1;

  if nullif(v_actor_email, '') is null then
    raise exception using
      errcode = '42501',
      message = 'confirmed field worker identity required';
  end if;

  if p_delivery_request_id is null or p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'delivery request and order IDs are required';
  end if;

  if p_signed_at is null
     or p_signed_at < v_now - interval '30 days'
     or p_signed_at > v_now + interval '5 minutes' then
    raise exception using
      errcode = '22023',
      message = 'delivery signature timestamp is invalid';
  end if;

  if v_signed_by is null or pg_catalog.length(v_signed_by) > 200 then
    raise exception using
      errcode = '22023',
      message = 'delivery signer name is invalid';
  end if;

  if p_signature_data_url is null
     or pg_catalog.length(p_signature_data_url) > 2000000
     or p_signature_data_url !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' then
    raise exception using
      errcode = '22023',
      message = 'delivery signature image is invalid';
  end if;

  if v_source is null or v_source not in ('dashboard', 'field-app') then
    raise exception using
      errcode = '22023',
      message = 'delivery signature source is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hc-delivery-request:' || p_delivery_request_id::text,
      0
    )
  );

  select signature_row.*
  into v_existing
  from public.delivery_signatures as signature_row
  where signature_row.delivery_request_id = p_delivery_request_id
  for update;

  if found then
    if v_existing.is_authoritative is not true
       or v_existing.order_id is distinct from p_order_id
       or v_existing.actor_auth_user_id is distinct from v_actor_auth_user_id
       or v_existing.signed_at is distinct from p_signed_at
       or v_existing.signed_by is distinct from v_signed_by
       or v_existing.signature_data_url is distinct from p_signature_data_url
       or v_existing.delivery_source is distinct from v_source then
      raise exception using
        errcode = '23505',
        message = 'delivery request UUID is already bound to different data';
    end if;

    -- Exact retry after a lost HTTP response. It must not write a second row or
    -- touch the authoritative order stamp again.
    return true;
  end if;

  -- Only a new request needs current order authorization. An exact accepted
  -- retry above may clear its device queue even if an owner moved the order to
  -- another market after the original commit.
  select order_row.*
  into v_order
  from public.orders as order_row
  where order_row.id = p_order_id
    and public.hc_can_access_order_market(order_row.market)
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'order access denied';
  end if;

  if v_order.is_recurring is distinct from false
     or v_order.stage not in (
       'invoiced', 'deposit_paid', 'paid_full', 'fulfilled', 'complete'
     )
     or (
       v_order.delivery_at_utc is null
       and v_order.event_start_at is null
     )
     or v_order.cancelled_at is not null then
    raise exception using
      errcode = '22023',
      message = 'order is not eligible for delivery confirmation';
  end if;

  if v_order.delivery_signed_at is not null
     or v_order.delivery_signed_by is not null
     or exists (
       select 1
       from public.delivery_signatures as prior_signature
       where prior_signature.order_id = p_order_id
     ) then
    raise exception using
      errcode = '23505',
      message = 'order already has a delivery confirmation';
  end if;

  insert into public.delivery_signatures (
    order_id,
    signed_by,
    signed_at,
    signature_data_url,
    signed_via,
    delivery_request_id,
    actor_auth_user_id,
    delivery_source,
    is_authoritative
  ) values (
    p_order_id,
    v_signed_by,
    p_signed_at,
    p_signature_data_url,
    v_actor_email || ' via ' || v_source,
    p_delivery_request_id,
    v_actor_auth_user_id,
    v_source,
    true
  );

  update public.orders as order_row
  set delivery_signed_at = p_signed_at,
      delivery_signed_by = v_signed_by,
      updated_at = v_now
  where order_row.id = p_order_id
    and order_row.delivery_signed_at is null
    and order_row.delivery_signed_by is null;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception using
      errcode = '40001',
      message = 'delivery order changed while confirmation was recorded';
  end if;

  return true;
end
$function$;

-- Disable the five-argument implementation. Leaving it executable would let a
-- caller bypass every request-ID and one-confirmation invariant above.
revoke all on function public.hc_confirm_order_delivery(
  uuid, timestamptz, text, text, text
) from public, anon, authenticated, service_role;

revoke all on function public.hc_claim_field_worker_v2()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_confirm_order_delivery_v2(
  uuid, uuid, timestamptz, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.hc_claim_field_worker_v2()
  to authenticated, service_role;
grant execute on function public.hc_confirm_order_delivery_v2(
  uuid, uuid, timestamptz, text, text, text
) to authenticated, service_role;

do $postflight$
declare
  v_definition text;
  v_index_predicate text;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_signatures'
      and column_name = 'delivery_request_id'
      and data_type = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_signatures'
      and column_name = 'actor_auth_user_id'
      and data_type = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_signatures'
      and column_name = 'delivery_source'
      and data_type = 'text'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_signatures'
      and column_name = 'is_authoritative'
      and data_type = 'boolean'
      and is_nullable = 'NO'
  ) then
    raise exception using
      errcode = '55000',
      message = '026 assertion failed: delivery audit columns are incomplete';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.delivery_signatures'::pg_catalog.regclass
      and conname = 'delivery_signatures_request_id_key'
      and contype = 'u'
      and convalidated is true
  ) or not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.delivery_signatures'::pg_catalog.regclass
      and conname = 'delivery_signatures_authoritative_shape_check'
      and contype = 'c'
      and convalidated is true
  ) then
    raise exception using
      errcode = '55000',
      message = '026 assertion failed: request uniqueness or shape constraint is missing';
  end if;

  select pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid)
  into v_index_predicate
  from pg_catalog.pg_index as index_info
  where index_info.indexrelid =
        'public.delivery_signatures_authoritative_order_uidx'::pg_catalog.regclass
    and index_info.indisunique is true;

  if v_index_predicate is null
     or v_index_predicate !~ 'is_authoritative' then
    raise exception using
      errcode = '55000',
      message = '026 assertion failed: authoritative order uniqueness is missing';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_claim_field_worker_v2()'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)'
     ) is null
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_claim_field_worker_v2()',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_claim_field_worker_v2()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_confirm_order_delivery(uuid,timestamp with time zone,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_confirm_order_delivery(uuid,timestamp with time zone,text,text,text)',
       'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '026 assertion failed: delivery or profile RPC grants are unsafe';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)'::pg_catalog.regprocedure
  ) into v_definition;

  if v_definition !~ 'pg_advisory_xact_lock'
     or v_definition !~ 'for update'
     or v_definition !~ 'delivery_request_id = p_delivery_request_id'
     or v_definition !~ 'actor_auth_user_id is distinct from v_actor_auth_user_id'
     or v_definition !~ 'is_recurring is distinct from false'
     or v_definition !~ '''invoiced'', ''deposit_paid'', ''paid_full'', ''fulfilled'', ''complete'''
     or v_definition !~ 'delivery_at_utc is null'
     or v_definition !~ 'event_start_at is null'
     or v_definition !~ 'is_authoritative' then
    raise exception using
      errcode = '55000',
      message = '026 assertion failed: delivery integrity definition drifted';
  end if;
end
$postflight$;

commit;
