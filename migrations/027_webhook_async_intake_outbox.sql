-- ============================================================================
-- 027_webhook_async_intake_outbox.sql
-- Fast, private Microsoft Graph intake plus durable webhook Telegram delivery.
--
-- SAFE ROLLOUT ORDER: apply migrations 024 and 027, configure and restart the
-- compatible pushdrain, verify its startup log, then deploy the Worker and
-- enable providers. The new pushdrain requires columns created here, while the
-- old pushdrain must never see encrypted webhook_telegram rows. This migration
-- stores no provider secret or raw body.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_column text;
begin
  if pg_catalog.to_regclass('public.push_queue') is null
     or pg_catalog.to_regclass('public.webhook_delivery_receipts') is null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_webhook_delivery(text,text,integer)'
     ) is null
     or pg_catalog.to_regprocedure('auth.role()') is null
     or pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') is null then
    raise exception using
      errcode = '55000',
      message = '027 requires migrations 011 and 024 plus Supabase Auth';
  end if;

  foreach v_column in array array[
    'id', 'kind', 'payload', 'created_at', 'claimed_at', 'done_at',
    'attempts', 'last_error'
  ] loop
    if not exists (
      select 1
      from information_schema.columns as column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'push_queue'
        and column_info.column_name = v_column
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '027 requires migration 011 push_queue column %s',
          v_column
        );
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid = 'public.push_queue'::pg_catalog.regclass
      and table_info.relrowsecurity is true
  ) then
    raise exception using
      errcode = '42501',
      message = '027 requires migration 011 push_queue RLS';
  end if;
end
$preflight$;

alter table public.push_queue
  add column if not exists outbox_type text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists dead_letter_reason text;

update public.push_queue
set outbox_type = case
      when payload ? 'telegram_outbox' then 'webhook_telegram'
      else 'push'
    end
where outbox_type is null;

update public.push_queue
set next_attempt_at = coalesce(created_at, pg_catalog.clock_timestamp())
where next_attempt_at is null;

alter table public.push_queue
  alter column outbox_type set default 'push',
  alter column outbox_type set not null,
  alter column next_attempt_at set default pg_catalog.clock_timestamp(),
  alter column next_attempt_at set not null;

do $push_constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.push_queue'::pg_catalog.regclass
      and conname = 'push_queue_outbox_type_check'
  ) then
    alter table public.push_queue
      add constraint push_queue_outbox_type_check check (
        outbox_type in ('push', 'webhook_telegram')
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.push_queue'::pg_catalog.regclass
      and conname = 'push_queue_webhook_telegram_shape_check'
  ) then
    alter table public.push_queue
      add constraint push_queue_webhook_telegram_shape_check check (
        outbox_type <> 'webhook_telegram'
        or (
          kind = 'alert'
          and pg_catalog.jsonb_typeof(payload) = 'object'
          and payload ? 'telegram_outbox'
          and pg_catalog.jsonb_typeof(payload -> 'telegram_outbox') = 'object'
          and payload ? 'tokens'
          and pg_catalog.jsonb_typeof(payload -> 'tokens') = 'array'
          and payload -> 'tokens' = '[]'::jsonb
          and (payload -> 'telegram_outbox' ->> 'version')
                is not distinct from '2'
          and coalesce(
                payload -> 'telegram_outbox' ->> 'key_version', ''
              ) ~ '^[A-Za-z0-9._-]{1,32}$'
          and pg_catalog.char_length(coalesce(
                payload -> 'telegram_outbox' ->> 'nonce', ''
              )) between 16 and 64
          and pg_catalog.char_length(coalesce(
                payload -> 'telegram_outbox' ->> 'ciphertext', ''
              )) between 24 and 32768
          and not (payload -> 'telegram_outbox' ? 'chat_id')
          and not (payload -> 'telegram_outbox' ? 'text')
          and not (payload -> 'telegram_outbox' ? 'parse_mode')
          and not (payload ? 'telegram_text')
          and not (payload ? 'fallback_chat_ids')
        )
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.push_queue'::pg_catalog.regclass
      and conname = 'push_queue_dead_letter_shape_check'
  ) then
    alter table public.push_queue
      add constraint push_queue_dead_letter_shape_check check (
        (
          dead_lettered_at is null
          and dead_letter_reason is null
        ) or (
          outbox_type = 'webhook_telegram'
          and dead_lettered_at is not null
          and done_at is not null
          and dead_letter_reason is not null
          and pg_catalog.char_length(dead_letter_reason) between 1 and 300
        )
      );
  end if;
end
$push_constraints$;

create index if not exists push_queue_webhook_outbox_pending_idx
  on public.push_queue (next_attempt_at, created_at, id)
  where done_at is null
    and dead_lettered_at is null
    and outbox_type = 'webhook_telegram';

-- Clients get nothing. The Worker needs SELECT/INSERT and pushdrain needs
-- SELECT/UPDATE/DELETE, so service_role receives only those four operations.
revoke all on table public.push_queue from public, anon, authenticated;
revoke all on table public.push_queue from service_role;
grant select, insert, update, delete on table public.push_queue to service_role;

create table if not exists public.webhook_intake_queue (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  provider text not null,
  event_key text not null,
  payload jsonb not null,
  delivery_state text not null default 'pending',
  attempt_count bigint not null default 0,
  next_attempt_at timestamptz not null default pg_catalog.clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  first_received_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  constraint webhook_intake_queue_provider_event_key_key
    unique (provider, event_key),
  constraint webhook_intake_queue_provider_check check (
    provider = 'ms_graph'
  ),
  constraint webhook_intake_queue_event_key_check check (
    event_key = pg_catalog.lower(event_key)
    and event_key ~ '^[0-9a-f]{64}$'
  ),
  constraint webhook_intake_queue_payload_check check (
    pg_catalog.jsonb_typeof(payload) = 'object'
    and not (payload ? 'clientState')
    and not (payload ? 'validationTokens')
    and payload::text !~ '"(clientState|validationTokens)"[[:space:]]*:'
    and pg_catalog.octet_length(payload::text) between 2 and 65536
  ),
  constraint webhook_intake_queue_state_check check (
    delivery_state in ('pending', 'processing', 'completed')
  ),
  constraint webhook_intake_queue_attempt_check check (
    attempt_count >= 0
  ),
  constraint webhook_intake_queue_error_check check (
    last_error is null
    or pg_catalog.char_length(last_error) between 1 and 300
  ),
  constraint webhook_intake_queue_state_shape_check check (
    (
      delivery_state = 'pending'
      and lease_token is null
      and lease_expires_at is null
      and completed_at is null
    ) or (
      delivery_state = 'processing'
      and lease_token is not null
      and lease_expires_at is not null
      and last_claimed_at is not null
      and completed_at is null
    ) or (
      delivery_state = 'completed'
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null
    )
  )
);

comment on table public.webhook_intake_queue is
  'Private sanitized Graph notification queue. Stores no raw body or clientState secret.';

create index if not exists webhook_intake_queue_claim_idx
  on public.webhook_intake_queue (next_attempt_at, first_received_at, id)
  where delivery_state in ('pending', 'processing');

alter table public.webhook_intake_queue enable row level security;

revoke all on table public.webhook_intake_queue
  from public, anon, authenticated, service_role;

create or replace function public.hc_enqueue_webhook_intake(
  p_items jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.octet_length(p_items::text) > 262144 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook intake batch';
  end if;

  v_item_count := pg_catalog.jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 100 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook intake batch size';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as input_item(value)
    where pg_catalog.jsonb_typeof(input_item.value) <> 'object'
       or input_item.value ->> 'provider' <> 'ms_graph'
       or coalesce(input_item.value ->> 'event_key', '')
            !~ '^[0-9a-f]{64}$'
       or pg_catalog.jsonb_typeof(input_item.value -> 'payload') <> 'object'
       or input_item.value -> 'payload' ? 'clientState'
       or input_item.value -> 'payload' ? 'validationTokens'
       or (input_item.value -> 'payload')::text
            ~ '"(clientState|validationTokens)"[[:space:]]*:'
       or pg_catalog.octet_length(
            (input_item.value -> 'payload')::text
          ) > 65536
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook intake item';
  end if;

  insert into public.webhook_intake_queue (
    provider,
    event_key,
    payload
  )
  select
    input_item.value ->> 'provider',
    input_item.value ->> 'event_key',
    input_item.value -> 'payload'
  from pg_catalog.jsonb_array_elements(p_items) as input_item(value)
  on conflict (provider, event_key) do nothing;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as input_item(value)
    left join public.webhook_intake_queue as queued
      on queued.provider = input_item.value ->> 'provider'
     and queued.event_key = input_item.value ->> 'event_key'
    where queued.id is null
       or queued.payload is distinct from input_item.value -> 'payload'
  ) then
    raise exception using
      errcode = '23505',
      message = 'webhook intake identity already has different payload';
  end if;

  return v_item_count;
end
$function$;

create or replace function public.hc_claim_webhook_intake(
  p_limit integer default 10,
  p_lease_seconds integer default 300
)
returns table (
  intake_id uuid,
  provider text,
  event_key text,
  payload jsonb,
  attempt_count bigint,
  claim_token uuid,
  claim_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 25
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 900 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook intake claim';
  end if;

  return query
  with candidates as (
    select queued.id
    from public.webhook_intake_queue as queued
    where (
        queued.delivery_state = 'pending'
        and queued.next_attempt_at <= v_now
      ) or (
        queued.delivery_state = 'processing'
        and queued.lease_expires_at <= v_now
      )
    order by queued.next_attempt_at asc,
             queued.first_received_at asc,
             queued.id asc
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.webhook_intake_queue as queued
    set delivery_state = 'processing',
        attempt_count = queued.attempt_count + 1,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at =
          v_now + pg_catalog.make_interval(secs => p_lease_seconds),
        last_claimed_at = v_now,
        last_error = null
    from candidates
    where queued.id = candidates.id
    returning queued.*
  )
  select
    claimed.id,
    claimed.provider,
    claimed.event_key,
    claimed.payload,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.lease_expires_at
  from claimed
  order by claimed.first_received_at asc, claimed.id asc;
end
$function$;

create or replace function public.hc_finish_webhook_intake(
  p_intake_id uuid,
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

  if p_intake_id is null or p_claim_token is null then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook intake finish';
  end if;

  update public.webhook_intake_queue as queued
  set delivery_state = 'completed',
      lease_token = null,
      lease_expires_at = null,
      completed_at = pg_catalog.clock_timestamp(),
      last_error = null
  where queued.id = p_intake_id
    and queued.delivery_state = 'processing'
    and queued.lease_token = p_claim_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

create or replace function public.hc_release_webhook_intake(
  p_intake_id uuid,
  p_claim_token uuid,
  p_retry_after_seconds integer,
  p_error text default 'processing failed'
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

  if p_intake_id is null
     or p_claim_token is null
     or p_retry_after_seconds is null
     or p_retry_after_seconds < 5
     or p_retry_after_seconds > 3600
     or p_error is null
     or pg_catalog.char_length(p_error) < 1
     or pg_catalog.char_length(p_error) > 300 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook intake release';
  end if;

  update public.webhook_intake_queue as queued
  set delivery_state = 'pending',
      next_attempt_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_retry_after_seconds),
      lease_token = null,
      lease_expires_at = null,
      last_error = p_error
  where queued.id = p_intake_id
    and queued.delivery_state = 'processing'
    and queued.lease_token = p_claim_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

-- Long-running classifiers must prove they still own an unexpired receipt
-- before any durable order or alert write. A stale token cannot be revived.
create or replace function public.hc_renew_webhook_delivery(
  p_provider text,
  p_event_key text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
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
     or p_claim_token is null
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 900 then
    raise exception using
      errcode = '22023',
      message = 'invalid webhook renewal';
  end if;

  update public.webhook_delivery_receipts as receipt
  set lease_expires_at =
        v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      last_claimed_at = v_now
  where receipt.provider = p_provider
    and receipt.event_key = p_event_key
    and receipt.delivery_state = 'processing'
    and receipt.claim_token = p_claim_token
    and receipt.lease_expires_at > v_now;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$function$;

revoke all on function public.hc_enqueue_webhook_intake(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_claim_webhook_intake(integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_finish_webhook_intake(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_release_webhook_intake(uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_renew_webhook_delivery(text, text, uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.hc_enqueue_webhook_intake(jsonb)
  to service_role;
grant execute on function public.hc_claim_webhook_intake(integer, integer)
  to service_role;
grant execute on function public.hc_finish_webhook_intake(uuid, uuid)
  to service_role;
grant execute on function public.hc_release_webhook_intake(uuid, uuid, integer, text)
  to service_role;
grant execute on function public.hc_renew_webhook_delivery(text, text, uuid, integer)
  to service_role;

do $postflight$
declare
  v_constraint text;
  v_signature text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid = 'public.webhook_intake_queue'::pg_catalog.regclass
      and table_info.relrowsecurity is true
  ) or exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'webhook_intake_queue'
  ) then
    raise exception using
      errcode = '42501',
      message = '027 assertion failed: intake queue privacy is wrong';
  end if;

  if exists (
    select 1
    from information_schema.table_privileges as privilege_info
    where privilege_info.table_schema = 'public'
      and privilege_info.table_name = 'webhook_intake_queue'
      and privilege_info.grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role'
      )
      and privilege_info.privilege_type in (
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '027 assertion failed: intake table has direct access';
  end if;

  foreach v_constraint in array array[
    'webhook_intake_queue_pkey',
    'webhook_intake_queue_provider_event_key_key',
    'webhook_intake_queue_provider_check',
    'webhook_intake_queue_event_key_check',
    'webhook_intake_queue_payload_check',
    'webhook_intake_queue_state_check',
    'webhook_intake_queue_attempt_check',
    'webhook_intake_queue_error_check',
    'webhook_intake_queue_state_shape_check',
    'push_queue_outbox_type_check',
    'push_queue_webhook_telegram_shape_check',
    'push_queue_dead_letter_shape_check'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_info
      where constraint_info.conname = v_constraint
        and constraint_info.convalidated is true
        and constraint_info.conrelid in (
          'public.webhook_intake_queue'::pg_catalog.regclass,
          'public.push_queue'::pg_catalog.regclass
        )
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '027 assertion failed: constraint %s is missing',
          v_constraint
        );
    end if;
  end loop;

  if pg_catalog.has_table_privilege('anon', 'public.push_queue', 'SELECT')
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.push_queue', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.push_queue', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.push_queue', 'TRUNCATE'
     ) then
    raise exception using
      errcode = '42501',
      message = '027 assertion failed: push_queue ACL matrix is wrong';
  end if;

  foreach v_signature in array array[
    'public.hc_enqueue_webhook_intake(jsonb)',
    'public.hc_claim_webhook_intake(integer,integer)',
    'public.hc_finish_webhook_intake(uuid,uuid)',
    'public.hc_release_webhook_intake(uuid,uuid,integer,text)',
    'public.hc_renew_webhook_delivery(text,text,uuid,integer)'
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
          '027 assertion failed: intake RPC %s is not service-only',
          v_signature
        );
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_indexes as index_info
    where index_info.schemaname = 'public'
      and index_info.indexname = 'push_queue_webhook_outbox_pending_idx'
      and index_info.indexdef like '%next_attempt_at%'
      and index_info.indexdef like '%webhook_telegram%'
  ) or not exists (
    select 1
    from pg_catalog.pg_indexes as index_info
    where index_info.schemaname = 'public'
      and index_info.indexname = 'webhook_intake_queue_claim_idx'
      and index_info.indexdef like '%next_attempt_at%'
  ) then
    raise exception using
      errcode = '55000',
      message = '027 assertion failed: queue claim indexes are missing';
  end if;
end
$postflight$;

commit;
