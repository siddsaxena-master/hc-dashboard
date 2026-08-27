-- ============================================================================
-- 024_webhook_delivery_receipts.sql
-- Durable, private claim ledger for authenticated provider webhooks.
--
-- LOCAL DRAFT. Run in the sandbox before production. Deploy this migration
-- before deploying the Worker that calls these RPCs.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regprocedure('auth.role()') is null
     or pg_catalog.to_regprocedure(
       'pg_catalog.gen_random_uuid()'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '024 requires Supabase Auth, pgcrypto UUIDs, and the orders table';
  end if;
end
$preflight$;

create table if not exists public.webhook_delivery_receipts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  provider text not null,
  event_key text not null,
  delivery_state text not null default 'processing',
  attempt_count bigint not null default 1,
  lease_token uuid,
  lease_expires_at timestamptz,
  first_received_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_claimed_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  constraint webhook_delivery_receipts_provider_event_key_key
    unique (provider, event_key),
  constraint webhook_delivery_receipts_provider_check check (
    provider in ('formspree', 'quo', 'ms_graph')
  ),
  constraint webhook_delivery_receipts_event_key_check check (
    event_key = pg_catalog.lower(event_key)
    and event_key ~ '^[0-9a-f]{64}$'
  ),
  constraint webhook_delivery_receipts_state_check check (
    delivery_state in ('processing', 'completed')
  ),
  constraint webhook_delivery_receipts_attempt_count_check check (
    attempt_count >= 1
  ),
  constraint webhook_delivery_receipts_time_order_check check (
    last_claimed_at >= first_received_at
    and (completed_at is null or completed_at >= first_received_at)
  ),
  constraint webhook_delivery_receipts_state_shape_check check (
    (
      delivery_state = 'processing'
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null
    ) or (
      delivery_state = 'completed'
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null
    )
  )
);

comment on table public.webhook_delivery_receipts is
  'Private webhook idempotency ledger. Stores no payload, raw body, provider ID, or secret.';

create index if not exists webhook_delivery_receipts_completed_at_idx
  on public.webhook_delivery_receipts (completed_at, id)
  where delivery_state = 'completed';

alter table public.webhook_delivery_receipts enable row level security;

-- No client or service token may read or mutate the ledger directly. The
-- narrowly scoped SECURITY DEFINER RPCs below are the only access path.
revoke all on table public.webhook_delivery_receipts
  from public, anon, authenticated, service_role;

create or replace function public.hc_claim_webhook_delivery(
  p_provider text,
  p_event_key text,
  p_lease_seconds integer default 300
)
returns table (
  claim_state text,
  receipt_id uuid,
  claim_token uuid,
  claim_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_claim_token uuid := pg_catalog.gen_random_uuid();
  v_receipt_id uuid;
  v_delivery_state text;
  v_lease_expires_at timestamptz;
  v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_provider is null
     or p_provider not in ('formspree', 'quo', 'ms_graph')
     or p_event_key is null
     or p_event_key <> pg_catalog.lower(p_event_key)
     or p_event_key !~ '^[0-9a-f]{64}$'
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 900 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook claim';
  end if;

  insert into public.webhook_delivery_receipts (
    provider,
    event_key,
    delivery_state,
    attempt_count,
    lease_token,
    lease_expires_at,
    first_received_at,
    last_claimed_at
  ) values (
    p_provider,
    p_event_key,
    'processing',
    1,
    v_claim_token,
    v_now + pg_catalog.make_interval(secs => p_lease_seconds),
    v_now,
    v_now
  )
  on conflict (provider, event_key) do nothing
  returning id into v_receipt_id;

  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return query
    select
      'claimed'::text,
      v_receipt_id,
      v_claim_token,
      v_now + pg_catalog.make_interval(secs => p_lease_seconds);
    return;
  end if;

  select
    receipt.id,
    receipt.delivery_state,
    receipt.lease_expires_at
  into
    v_receipt_id,
    v_delivery_state,
    v_lease_expires_at
  from public.webhook_delivery_receipts as receipt
  where receipt.provider = p_provider
    and receipt.event_key = p_event_key
  for update;

  if v_receipt_id is null then
    raise exception using
      errcode = '40001',
      message = 'webhook receipt changed during claim';
  end if;

  if v_delivery_state = 'completed' then
    return query
    select 'completed'::text, v_receipt_id, null::uuid, null::timestamptz;
    return;
  end if;

  if v_lease_expires_at > v_now then
    return query
    select 'busy'::text, v_receipt_id, null::uuid, v_lease_expires_at;
    return;
  end if;

  update public.webhook_delivery_receipts as receipt
  set attempt_count = receipt.attempt_count + 1,
      lease_token = v_claim_token,
      lease_expires_at =
        v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      last_claimed_at = v_now
  where receipt.id = v_receipt_id;

  return query
  select
    'claimed'::text,
    v_receipt_id,
    v_claim_token,
    v_now + pg_catalog.make_interval(secs => p_lease_seconds);
end
$function$;

create or replace function public.hc_finish_webhook_delivery(
  p_provider text,
  p_event_key text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_provider is null
     or p_provider not in ('formspree', 'quo', 'ms_graph')
     or p_event_key is null
     or p_event_key <> pg_catalog.lower(p_event_key)
     or p_event_key !~ '^[0-9a-f]{64}$'
     or p_claim_token is null then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook finish';
  end if;

  update public.webhook_delivery_receipts as receipt
  set delivery_state = 'completed',
      lease_token = null,
      lease_expires_at = null,
      completed_at = pg_catalog.clock_timestamp()
  where receipt.provider = p_provider
    and receipt.event_key = p_event_key
    and receipt.delivery_state = 'processing'
    and receipt.lease_token = p_claim_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

create or replace function public.hc_release_webhook_delivery(
  p_provider text,
  p_event_key text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_provider is null
     or p_provider not in ('formspree', 'quo', 'ms_graph')
     or p_event_key is null
     or p_event_key <> pg_catalog.lower(p_event_key)
     or p_event_key !~ '^[0-9a-f]{64}$'
     or p_claim_token is null then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook release';
  end if;

  update public.webhook_delivery_receipts as receipt
  set lease_expires_at = pg_catalog.clock_timestamp()
  where receipt.provider = p_provider
    and receipt.event_key = p_event_key
    and receipt.delivery_state = 'processing'
    and receipt.lease_token = p_claim_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

revoke all on function public.hc_claim_webhook_delivery(text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_finish_webhook_delivery(text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_release_webhook_delivery(text, text, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.hc_claim_webhook_delivery(text, text, integer)
  to service_role;
grant execute on function public.hc_finish_webhook_delivery(text, text, uuid)
  to service_role;
grant execute on function public.hc_release_webhook_delivery(text, text, uuid)
  to service_role;

do $postflight$
declare
  v_constraint text;
  v_signature text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.webhook_delivery_receipts'::pg_catalog.regclass
      and table_info.relrowsecurity is true
  ) then
    raise exception using
      errcode = '42501',
      message = '024 assertion failed: receipt RLS is disabled';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'webhook_delivery_receipts'
  ) then
    raise exception using
      errcode = '42501',
      message = '024 assertion failed: receipt table must have no client policy';
  end if;

  foreach v_constraint in array array[
    'webhook_delivery_receipts_pkey',
    'webhook_delivery_receipts_provider_event_key_key',
    'webhook_delivery_receipts_provider_check',
    'webhook_delivery_receipts_event_key_check',
    'webhook_delivery_receipts_state_check',
    'webhook_delivery_receipts_attempt_count_check',
    'webhook_delivery_receipts_time_order_check',
    'webhook_delivery_receipts_state_shape_check'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conrelid =
            'public.webhook_delivery_receipts'::pg_catalog.regclass
        and constraint_info.conname = v_constraint
        and constraint_info.convalidated is true
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '024 assertion failed: receipt constraint %s is missing',
          v_constraint
        );
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.columns as column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'webhook_delivery_receipts'
      and column_info.column_name ~ '(raw|body|payload|secret|provider_event_id)'
  ) then
    raise exception using
      errcode = '42501',
      message = '024 assertion failed: receipt table exposes sensitive payload material';
  end if;

  if exists (
    select 1
    from information_schema.table_privileges as privilege_info
    where privilege_info.table_schema = 'public'
      and privilege_info.table_name = 'webhook_delivery_receipts'
      and privilege_info.grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role'
      )
      and privilege_info.privilege_type in (
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '024 assertion failed: direct receipt access leaked';
  end if;

  foreach v_signature in array array[
    'public.hc_claim_webhook_delivery(text,text,integer)',
    'public.hc_finish_webhook_delivery(text,text,uuid)',
    'public.hc_release_webhook_delivery(text,text,uuid)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or pg_catalog.has_function_privilege(
         'authenticated', v_signature, 'EXECUTE'
       )
       or not pg_catalog.has_function_privilege(
         'service_role', v_signature, 'EXECUTE'
       )
       or not exists (
         select 1
         from pg_catalog.pg_proc as function_info
         where function_info.oid = pg_catalog.to_regprocedure(v_signature)
           and function_info.prosecdef is true
           and exists (
             select 1
             from pg_catalog.unnest(function_info.proconfig) as setting(value)
             where setting.value ~ '^search_path=(|"")$'
           )
       )
       or exists (
         select 1
         from pg_catalog.pg_proc as function_acl
         cross join lateral pg_catalog.aclexplode(
           coalesce(
             function_acl.proacl,
             pg_catalog.acldefault('f', function_acl.proowner)
           )
         ) as privilege_info
         where function_acl.oid = pg_catalog.to_regprocedure(v_signature)
           and privilege_info.grantee = 0
           and privilege_info.privilege_type = 'EXECUTE'
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '024 assertion failed: receipt RPC %s is not service-only',
          v_signature
        );
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_proc as function_info
    where function_info.oid = pg_catalog.to_regprocedure(
      'public.hc_claim_webhook_delivery(text,text,integer)'
    )
      and function_info.proargnames = array[
        'p_provider',
        'p_event_key',
        'p_lease_seconds',
        'claim_state',
        'receipt_id',
        'claim_token',
        'claim_expires_at'
      ]
      and function_info.pronargdefaults = 1
  ) then
    raise exception using
      errcode = '42501',
      message = '024 assertion failed: receipt claim return contract drifted';
  end if;
end
$postflight$;

commit;
