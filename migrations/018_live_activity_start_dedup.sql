-- ============================================================================
-- 018_live_activity_start_dedup.sql
-- Durable, per-phone Live Activity START delivery.
--
-- LOCAL DRAFT. Do not run this against production until migrations 015, 016,
-- and 017 have passed their separate clone and canary gates.
--
-- Why this exists:
--   * Retrying a normal clock-in banner must never start a second ActivityKit
--     card for the same shift on the same phone.
--   * A late owner or manager phone may still receive one card while the shift
--     is open.
--   * A lost queue INSERT response must retry the same queue UUID, never create
--     a second outbound START.
--
-- One ledger row owns one logical START generation for one (shift, physical
-- device). The exact push-to-start token is private receipt identity as well as
-- the device UUID. queue_id is stable within a generation. claimed_at is a
-- recoverable lease; queued_at means the stable push_queue row is durably
-- owned. A failed enqueue clears only claimed_at, preserving queue identity.
-- Only a definitive dead-token response may rearm the same device with a later
-- token and a new queue generation.
--
-- This migration does not alter legacy token rows or client token APIs. It
-- depends on 017's device-specific token model and leaves the 017 emergency
-- rollback compatibility lane untouched.
-- ============================================================================

begin;

do $preflight$
declare
  v_privilege text;
  v_register_signature constant text :=
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)';
begin
  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '018 requires migration 017 before Live Activity START deduplication';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'live_activity_tokens'
      and column_name = 'device_id'
      and data_type = 'uuid'
  ) then
    raise exception using
      errcode = '55000',
      message = '018 requires live_activity_tokens.device_id from migration 015';
  end if;

  if pg_catalog.to_regclass('public.live_activity_tokens_device_p2s_uidx') is null then
    raise exception using
      errcode = '55000',
      message = '018 requires the device-specific push-to-start index from migration 015';
  end if;

  if pg_catalog.to_regclass('public.push_queue') is null then
    raise exception using
      errcode = '55000',
      message = '018 requires push_queue from migration 011';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'field_workers'
      and column_name = 'auth_user_id'
      and data_type = 'uuid'
  ) then
    raise exception using
      errcode = '55000',
      message = '018 requires linked field-worker identities from migration 016';
  end if;

  -- START contains employee identity and location. Refuse installation unless
  -- migration 016's authenticated cutover is still intact. A token supplied
  -- through the old anonymous email-only lane must never become a recipient.
  if exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'live_activity_tokens'
      and (
        'public'::name = any(policy_info.roles)
        or 'anon'::name = any(policy_info.roles)
        or 'authenticated'::name = any(policy_info.roles)
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '018 requires migration 016: direct Live Activity token policies remain';
  end if;

  foreach v_privilege in array array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] loop
    if pg_catalog.has_table_privilege(
         'anon', 'public.live_activity_tokens', v_privilege
       )
       or pg_catalog.has_table_privilege(
         'authenticated', 'public.live_activity_tokens', v_privilege
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '018 requires migration 016: client role retains direct live_activity_tokens %s',
          v_privilege
        );
    end if;
  end loop;

  foreach v_privilege in array array[
    'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
  ] loop
    if pg_catalog.has_any_column_privilege(
         'anon', 'public.live_activity_tokens', v_privilege
       )
       or pg_catalog.has_any_column_privilege(
         'authenticated', 'public.live_activity_tokens', v_privilege
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '018 requires migration 016: client role retains a token column %s grant',
          v_privilege
        );
    end if;
  end loop;

  if pg_catalog.to_regprocedure(v_register_signature) is null
     or pg_catalog.has_function_privilege(
       'anon', v_register_signature, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', v_register_signature, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_register_signature, 'EXECUTE'
     )
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_register_signature)
         and function_info.prosecdef is true
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value like 'search_path=%'
         )
         and pg_catalog.pg_get_functiondef(function_info.oid) ~*
             'auth_user_id[[:space:]]*=[[:space:]]*auth[.]uid[(][)]'
     ) then
    raise exception using
      errcode = '42501',
      message = '018 requires migration 016 linked authenticated token registration';
  end if;
end
$preflight$;

-- Block shift, token, and queue writers until the first-install check and both
-- queue guards commit. A waiting old worker can open a later shift, but its
-- old-style START INSERT then fails closed under the new guard.
lock table
  public.shifts,
  public.live_activity_tokens,
  public.push_queue
in share row exclusive mode;

do $quiet_cutover$
begin

  -- The old worker has no per-phone START receipt. Installing 018 while a shift
  -- is already open cannot prove which phones received its old START and could
  -- create a second card. First installation therefore requires a quiet cutover
  -- with every shift closed. Once the ledger exists, idempotent re-runs are safe
  -- during open shifts and newly registered phones use the durable claim path.
  if pg_catalog.to_regclass(
       'public.live_activity_start_deliveries'
     ) is null
     and exists (
       select 1
       from public.shifts
       where clock_out_at is null
     ) then
    raise exception using
      errcode = '55000',
      message = '018 install blocked: clock out every open shift before START dedup cutover';
  end if;

  if pg_catalog.to_regclass(
       'public.live_activity_start_deliveries'
     ) is null
     and exists (
       select 1
       from public.push_queue
       where kind = 'la_start'
         and done_at is null
     ) then
    raise exception using
      errcode = '55000',
      message = '018 install blocked: drain every unfinished legacy START before dedup cutover';
  end if;
end
$quiet_cutover$;

create table if not exists public.live_activity_start_deliveries (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id) on delete cascade,
  device_id       uuid not null,
  start_token     text not null,
  queue_id        uuid not null default gen_random_uuid(),
  generation      integer not null default 1,
  claimed_at      timestamptz,
  queued_at       timestamptz,
  delivered_at    timestamptz,
  terminal_at     timestamptz,
  terminal_reason text,
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  constraint live_activity_start_deliveries_shift_device_key
    unique (shift_id, device_id),
  constraint live_activity_start_deliveries_shift_token_key
    unique (shift_id, start_token),
  constraint live_activity_start_deliveries_queue_key
    unique (queue_id),
  constraint live_activity_start_deliveries_token_check
    check (
      length(start_token) between 32 and 512
      and start_token ~ '^[0-9a-f]+$'
    ),
  constraint live_activity_start_deliveries_generation_check
    check (generation > 0),
  constraint live_activity_start_deliveries_terminal_check
    check (
      (terminal_at is null and terminal_reason is null)
      or (terminal_at is not null and terminal_reason is not null)
    ),
  constraint live_activity_start_deliveries_outcome_check
    check (delivered_at is null or terminal_at is null)
);

create index if not exists live_activity_start_deliveries_pending_idx
  on public.live_activity_start_deliveries (claimed_at, created_at)
  where queued_at is null
    and delivered_at is null
    and terminal_at is null;

alter table public.live_activity_start_deliveries enable row level security;

-- The ledger exposes device identity and delivery state. There are deliberately
-- no RLS policies. Only the service-role worker may claim or reconcile it.
revoke all on table public.live_activity_start_deliveries
  from public, anon, authenticated;
grant select, insert, update, delete on table public.live_activity_start_deliveries
  to service_role;

-- pushdrain normally purges completed queue rows after seven days. If APNs and
-- queue delivery succeeded but the worker never recorded queued_at (for example,
-- a long worker outage after its completion PATCH failed), deleting that one
-- stable queue row would let stale-claim recovery reinsert the same UUID and
-- start a duplicate. Retain only that narrow unresolved case. Once queued_at is
-- recorded, normal queue retention and purge behavior resumes.
create or replace function public.hc_retain_unconfirmed_live_activity_start_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.kind = 'la_start'
     and exists (
       select 1
       from public.live_activity_start_deliveries as delivery
       join public.shifts as shift_row on shift_row.id = delivery.shift_id
       where delivery.queue_id = old.id
         and delivery.queued_at is null
         and delivery.delivered_at is null
         and delivery.terminal_at is null
         and shift_row.clock_out_at is null
     ) then
    return null;
  end if;
  return old;
end
$function$;

revoke all on function public.hc_retain_unconfirmed_live_activity_start_queue()
  from public, anon, authenticated;

drop trigger if exists push_queue_retain_unconfirmed_live_activity_start
  on public.push_queue;
create trigger push_queue_retain_unconfirmed_live_activity_start
before delete on public.push_queue
for each row
execute function public.hc_retain_unconfirmed_live_activity_start_queue();

-- Fail every old-style or malformed START closed. This runs at the actual queue
-- INSERT, after the migration's locks are released, so it also closes the
-- shift-close and role/token-change windows between claim and enqueue.
create or replace function public.hc_validate_live_activity_start_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_delivery_id uuid;
  v_shift_id uuid;
  v_device_id uuid;
  v_queue_id uuid;
  v_generation integer;
  v_claimed_at timestamptz;
  v_token text;
begin
  if new.kind <> 'la_start' then
    return new;
  end if;

  if pg_catalog.jsonb_typeof(new.payload) <> 'object'
     or pg_catalog.jsonb_typeof(new.payload -> 'tokens') <> 'array'
     or pg_catalog.jsonb_array_length(new.payload -> 'tokens') <> 1 then
    raise exception using
      errcode = '23514',
      message = 'rejected malformed Live Activity START queue row';
  end if;

  begin
    v_delivery_id := nullif(
      new.payload ->> 'live_activity_start_delivery_id', ''
    )::uuid;
    v_shift_id := nullif(
      new.payload ->> 'live_activity_start_shift_id', ''
    )::uuid;
    v_device_id := nullif(
      new.payload ->> 'live_activity_start_device_id', ''
    )::uuid;
    v_queue_id := nullif(
      new.payload ->> 'live_activity_start_queue_id', ''
    )::uuid;
    v_generation := nullif(
      new.payload ->> 'live_activity_start_generation', ''
    )::integer;
    v_claimed_at := nullif(
      new.payload ->> 'live_activity_start_claimed_at', ''
    )::timestamptz;
    v_token := nullif(lower(new.payload -> 'tokens' ->> 0), '');
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception using
        errcode = '23514',
        message = 'rejected invalid Live Activity START queue identity';
  end;

  if v_delivery_id is null
     or v_shift_id is null
     or v_device_id is null
     or v_queue_id is null
     or v_generation is null
     or v_claimed_at is null
     or v_token is null
     or new.id is distinct from v_queue_id
     or new.payload #>> '{headers,collapse_id}' is distinct from v_queue_id::text
     or new.payload #>> '{aps,event}' is distinct from 'start'
     or new.payload #>> '{aps,attributes,shiftId}' is distinct from v_shift_id::text
     or new.claimed_at is not null
     or new.done_at is not null
     or new.attempts is distinct from 0
     or not exists (
       select 1
       from public.live_activity_start_deliveries as delivery
       join public.shifts as shift_row
         on shift_row.id = delivery.shift_id
       join public.live_activity_tokens as token_row
         on token_row.token_type = 'push_to_start'
        and token_row.shift_id is null
        and lower(token_row.token) = delivery.start_token
       join public.field_workers as manager
         on lower(manager.email) = lower(token_row.email)
        and manager.active is true
        and manager.role in ('owner', 'manager')
        and manager.auth_user_id is not null
       where delivery.id = v_delivery_id
         and delivery.shift_id = v_shift_id
         and delivery.queue_id = v_queue_id
         and delivery.generation = v_generation
         and delivery.start_token = v_token
         and delivery.claimed_at = v_claimed_at
         and delivery.queued_at is null
         and delivery.delivered_at is null
         and delivery.terminal_at is null
         and shift_row.clock_out_at is null
         and lower(coalesce(shift_row.worker_email, '')) <>
             'appreview@hamptonscoconuts.com'
         and lower(token_row.email) <>
             lower(coalesce(shift_row.worker_email, ''))
         and not exists (
           select 1
           from public.live_activity_start_deliveries as occupied
           where occupied.shift_id = delivery.shift_id
             and occupied.device_id = token_row.device_id
             and occupied.id <> delivery.id
         )
     ) then
    raise exception using
      errcode = '23514',
      message = 'rejected ineligible or stale Live Activity START queue row';
  end if;

  return new;
end
$function$;

revoke all on function public.hc_validate_live_activity_start_queue()
  from public, anon, authenticated;

drop trigger if exists push_queue_validate_live_activity_start
  on public.push_queue;
create trigger push_queue_validate_live_activity_start
before insert on public.push_queue
for each row
execute function public.hc_validate_live_activity_start_queue();

-- Identity is immutable except for three narrowly proven transitions: the same
-- exact token moving to a regenerated device UUID, an unsent token refresh when
-- no queue row exists, and a new generation after Apple definitively rejected
-- the prior token. Outcome timestamps are one-way latches.
create or replace function public.hc_protect_live_activity_start_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_reconcile boolean;
  v_unsent_token_refresh boolean;
  v_terminal_rotation boolean;
begin
  if new.id is distinct from old.id
     or new.shift_id is distinct from old.shift_id
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '55000',
      message = 'Live Activity START identity is immutable';
  end if;

  v_device_reconcile :=
    new.device_id is distinct from old.device_id
    and new.start_token = old.start_token
    and new.queue_id = old.queue_id
    and new.generation = old.generation
    and new.claimed_at is not distinct from old.claimed_at
    and new.queued_at is not distinct from old.queued_at
    and new.delivered_at is not distinct from old.delivered_at
    and new.terminal_at is not distinct from old.terminal_at
    and new.terminal_reason is not distinct from old.terminal_reason;

  v_unsent_token_refresh :=
    new.device_id = old.device_id
    and new.start_token is distinct from old.start_token
    and new.queue_id = old.queue_id
    and new.generation = old.generation
    and old.claimed_at is null
    and old.queued_at is null
    and old.delivered_at is null
    and old.terminal_at is null
    and new.claimed_at is null
    and new.queued_at is null
    and new.delivered_at is null
    and new.terminal_at is null
    and new.terminal_reason is null
    and not exists (
      select 1 from public.push_queue where id = old.queue_id
    );

  v_terminal_rotation :=
    new.device_id = old.device_id
    and new.start_token is distinct from old.start_token
    and new.queue_id is distinct from old.queue_id
    and new.generation = old.generation + 1
    and old.delivered_at is null
    and old.terminal_at is not null
    and new.claimed_at is null
    and new.queued_at is null
    and new.delivered_at is null
    and new.terminal_at is null
    and new.terminal_reason is null
    and not exists (
      select 1
      from public.push_queue
      where id = old.queue_id
        and done_at is null
    );

  if (new.device_id is distinct from old.device_id
      or new.start_token is distinct from old.start_token
      or new.queue_id is distinct from old.queue_id
      or new.generation is distinct from old.generation)
     and not (v_device_reconcile or v_unsent_token_refresh or v_terminal_rotation) then
    raise exception using
      errcode = '55000',
      message = 'Live Activity START identity transition is not allowed';
  end if;

  if not v_terminal_rotation
     and (
       (old.queued_at is not null and new.queued_at is distinct from old.queued_at)
       or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
       or (old.terminal_at is not null and new.terminal_at is distinct from old.terminal_at)
       or (old.terminal_reason is not null and
           new.terminal_reason is distinct from old.terminal_reason)
     ) then
    raise exception using
      errcode = '55000',
      message = 'Live Activity START outcome is immutable';
  end if;

  new.updated_at := clock_timestamp();
  return new;
end
$function$;

revoke all on function public.hc_protect_live_activity_start_delivery()
  from public, anon, authenticated;

drop trigger if exists live_activity_start_deliveries_protect_identity
  on public.live_activity_start_deliveries;
create trigger live_activity_start_deliveries_protect_identity
before update on public.live_activity_start_deliveries
for each row
execute function public.hc_protect_live_activity_start_delivery();

-- Device UUIDs can regenerate on reinstall. The exact Apple token is the
-- physical destination during that handoff, so move every matching receipt to
-- the new UUID immediately while preserving its queue generation and outcome.
-- If the new UUID already owns a receipt for the shift, keep both historical
-- rows unchanged and let the queue/validation guards suppress another START.
create or replace function public.hc_reconcile_live_activity_start_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.token_type = 'push_to_start'
     and new.shift_id is null
     and new.device_id is not null then
    update public.live_activity_start_deliveries as delivery
    set device_id = new.device_id
    where delivery.start_token = lower(new.token)
      and delivery.device_id <> new.device_id
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = new.device_id
          and occupied.id <> delivery.id
      );
  end if;
  return new;
end
$function$;

revoke all on function public.hc_reconcile_live_activity_start_device()
  from public, anon, authenticated;

drop trigger if exists live_activity_tokens_reconcile_start_device
  on public.live_activity_tokens;
create trigger live_activity_tokens_reconcile_start_device
after insert or update of device_id, token, token_type, shift_id
on public.live_activity_tokens
for each row
execute function public.hc_reconcile_live_activity_start_device();

-- Seed only recent open shifts, but recover every already-seeded pending row
-- regardless of age. This keeps first contact bounded without abandoning a
-- receipt after a worker or pushdrain outage longer than 48 hours. Before
-- seeding, reconcile only unsent identities and rotate a queue generation only
-- after Apple definitively rejected the prior token.
create or replace function public.hc_claim_live_activity_starts(
  p_claimed_at timestamptz,
  p_stale_before timestamptz,
  p_started_after timestamptz,
  p_limit integer default 50
)
returns table (
  delivery_id uuid,
  queue_id uuid,
  device_id uuid,
  email text,
  token text,
  shift_id uuid,
  worker_name text,
  worker_email text,
  clock_in_at timestamptz,
  report_at timestamptz,
  report_lat double precision,
  report_lng double precision,
  generation integer
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_claimed_at is null
     or p_stale_before is null
     or p_started_after is null
     or p_stale_before >= p_claimed_at
     or p_started_after > p_claimed_at then
    raise exception using
      errcode = '22023',
      message = 'valid claim, stale, and recent-window timestamps are required';
  end if;

  -- Once a shift is closed this function can never enqueue its START again.
  -- Clear an abandoned pre-close lease so rollback checks and the normal queue
  -- purge cannot remain blocked after an enqueue-completion response was lost.
  update public.live_activity_start_deliveries as delivery
  set claimed_at = null
  from public.shifts as shift_row
  where shift_row.id = delivery.shift_id
    and shift_row.clock_out_at is not null
    and delivery.queued_at is null
    and delivery.claimed_at is not null;

  -- The app stores a device UUID, but an install can regenerate it. If the
  -- exact Apple token is unchanged, it is the same physical destination. This
  -- repairs every outcome state if the registration trigger was unavailable.
  update public.live_activity_start_deliveries as delivery
  set device_id = token_row.device_id
  from public.live_activity_tokens as token_row
  where token_row.token_type = 'push_to_start'
    and token_row.shift_id is null
    and token_row.device_id is not null
    and lower(token_row.token) = delivery.start_token
    and token_row.device_id <> delivery.device_id
    and not exists (
      select 1
      from public.live_activity_start_deliveries as occupied
      where occupied.shift_id = delivery.shift_id
        and occupied.device_id = token_row.device_id
        and occupied.id <> delivery.id
    );

  -- A token may rotate after the ledger was seeded but before any queue row
  -- exists. Refresh that pristine receipt in place. Its queue UUID remains
  -- stable, so overlapping workers still converge on one INSERT.
  update public.live_activity_start_deliveries as delivery
  set start_token = lower(token_row.token)
  from public.live_activity_tokens as token_row
  where token_row.token_type = 'push_to_start'
    and token_row.shift_id is null
    and token_row.device_id = delivery.device_id
    and lower(token_row.token) <> delivery.start_token
    and delivery.claimed_at is null
    and delivery.queued_at is null
    and delivery.delivered_at is null
    and delivery.terminal_at is null
    and not exists (
      select 1 from public.push_queue where id = delivery.queue_id
    )
    and not exists (
      select 1
      from public.live_activity_start_deliveries as occupied
      where occupied.shift_id = delivery.shift_id
        and occupied.start_token = lower(token_row.token)
        and occupied.id <> delivery.id
    );

  -- Only Apple's permanent dead-token result earns a second generation. A
  -- timeout, topic rejection, role change, or routine token rotation never
  -- rearms a START and therefore cannot manufacture a duplicate banner.
  update public.live_activity_start_deliveries as delivery
  set start_token = lower(token_row.token),
      queue_id = gen_random_uuid(),
      generation = delivery.generation + 1,
      claimed_at = null,
      queued_at = null,
      delivered_at = null,
      terminal_at = null,
      terminal_reason = null
  from public.live_activity_tokens as token_row
  where token_row.token_type = 'push_to_start'
    and token_row.shift_id is null
    and token_row.device_id = delivery.device_id
    and lower(token_row.token) <> delivery.start_token
    and delivery.delivered_at is null
    and delivery.terminal_at is not null
    and not exists (
      select 1
      from public.push_queue as pending
      where pending.id = delivery.queue_id
        and pending.done_at is null
    )
    and not exists (
      select 1
      from public.live_activity_start_deliveries as occupied
      where occupied.shift_id = delivery.shift_id
        and occupied.start_token = lower(token_row.token)
        and occupied.id <> delivery.id
    );

  -- This is intentionally a separate statement from RETURN QUERY. PostgreSQL
  -- data-changing CTE siblings share one snapshot and expose new rows only via
  -- RETURNING; a following statement in this same function sees the inserts and
  -- can claim a newly registered late phone immediately.
  insert into public.live_activity_start_deliveries (
    shift_id, device_id, start_token
  )
  select distinct s.id, lat.device_id, lower(lat.token)
  from public.shifts as s
  join public.live_activity_tokens as lat
    on lat.token_type = 'push_to_start'
   and lat.shift_id is null
   and lat.device_id is not null
  where s.clock_out_at is null
    and s.clock_in_at >= p_started_after
    and lower(coalesce(s.worker_email, '')) <>
        'appreview@hamptonscoconuts.com'
    and lower(lat.email) <>
        lower(coalesce(s.worker_email, ''))
    and exists (
      select 1
      from public.field_workers as fw
      where lower(fw.email) = lower(lat.email)
        and fw.active is true
        and fw.role in ('owner', 'manager')
        and fw.auth_user_id is not null
    )
  on conflict do nothing;

  return query
  with eligible_pairs as materialized (
    select distinct
      delivery.id as delivery_id,
      s.id as shift_id,
      lat.device_id,
      lower(lat.email) as email,
      lower(lat.token) as token,
      s.worker_name,
      lower(s.worker_email) as worker_email,
      s.clock_in_at,
      coalesce(latest.at, s.clock_in_at) as report_at,
      coalesce(latest.lat, s.clock_in_lat) as report_lat,
      coalesce(latest.lng, s.clock_in_lng) as report_lng
    from public.live_activity_start_deliveries as delivery
    join public.shifts as s
      on s.id = delivery.shift_id
    join public.live_activity_tokens as lat
      on lat.token_type = 'push_to_start'
     and lat.shift_id is null
     and lower(lat.token) = delivery.start_token
    left join lateral (
      select loc.at, loc.lat, loc.lng
      from public.shift_locations as loc
      where loc.shift_id = s.id
      order by loc.at desc, loc.id desc
      limit 1
    ) as latest on true
    where s.clock_out_at is null
      and lower(coalesce(s.worker_email, '')) <>
          'appreview@hamptonscoconuts.com'
      and lower(lat.email) <>
          lower(coalesce(s.worker_email, ''))
      and exists (
        select 1
        from public.field_workers as fw
        where lower(fw.email) = lower(lat.email)
          and fw.active is true
          and fw.role in ('owner', 'manager')
          and fw.auth_user_id is not null
      )
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = lat.device_id
          and occupied.id <> delivery.id
      )
  ), candidate_ids as materialized (
    select delivery.id
    from public.live_activity_start_deliveries as delivery
    join eligible_pairs as pair
      on pair.delivery_id = delivery.id
    where delivery.queued_at is null
      and delivery.delivered_at is null
      and delivery.terminal_at is null
      and (
        delivery.claimed_at is null
        or delivery.claimed_at < p_stale_before
      )
    order by pair.clock_in_at asc, delivery.created_at asc, delivery.id asc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of delivery skip locked
  ), claimed as (
    update public.live_activity_start_deliveries as delivery
    set claimed_at = p_claimed_at
    from candidate_ids as candidate
    where delivery.id = candidate.id
    returning
      delivery.id,
      delivery.queue_id,
      delivery.device_id,
      delivery.shift_id,
      delivery.start_token,
      delivery.generation
  )
  select
    claimed.id,
    claimed.queue_id,
    claimed.device_id,
    pair.email,
    pair.token,
    claimed.shift_id,
    pair.worker_name,
    pair.worker_email,
    pair.clock_in_at,
    pair.report_at,
    pair.report_lat,
    pair.report_lng,
    claimed.generation
  from claimed
  join eligible_pairs as pair
    on pair.delivery_id = claimed.id
  order by pair.clock_in_at asc, claimed.id asc;
end
$function$;

revoke all on function public.hc_claim_live_activity_starts(
  timestamptz, timestamptz, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.hc_claim_live_activity_starts(
  timestamptz, timestamptz, timestamptz, integer
) to service_role;

-- pushdrain calls this immediately before contacting Apple. It closes the
-- unavoidable queue-time race with clock-out, role removal, self reassignment,
-- or token rotation. A database read failure is distinguishable from false in
-- pushdrain and remains retryable without sending.
create or replace function public.hc_validate_live_activity_start_delivery(
  p_delivery_id uuid,
  p_shift_id uuid,
  p_queue_id uuid,
  p_generation integer,
  p_start_token text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_delivery_id is null
     or p_shift_id is null
     or p_queue_id is null
     or p_generation is null
     or p_generation < 1
     or nullif(lower(trim(p_start_token)), '') is null then
    return false;
  end if;

  return exists (
    select 1
    from public.live_activity_start_deliveries as delivery
    join public.shifts as shift_row
      on shift_row.id = delivery.shift_id
    join public.live_activity_tokens as token_row
      on token_row.token_type = 'push_to_start'
     and token_row.shift_id is null
     and lower(token_row.token) = delivery.start_token
    join public.field_workers as manager
      on lower(manager.email) = lower(token_row.email)
     and manager.active is true
     and manager.role in ('owner', 'manager')
     and manager.auth_user_id is not null
    where delivery.id = p_delivery_id
      and delivery.shift_id = p_shift_id
      and delivery.queue_id = p_queue_id
      and delivery.generation = p_generation
      and delivery.start_token = lower(trim(p_start_token))
      and delivery.delivered_at is null
      and delivery.terminal_at is null
      and (delivery.queued_at is not null or delivery.claimed_at is not null)
      and shift_row.clock_out_at is null
      and lower(coalesce(shift_row.worker_email, '')) <>
          'appreview@hamptonscoconuts.com'
      and lower(token_row.email) <>
          lower(coalesce(shift_row.worker_email, ''))
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = token_row.device_id
          and occupied.id <> delivery.id
      )
  );
end
$function$;

revoke all on function public.hc_validate_live_activity_start_delivery(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.hc_validate_live_activity_start_delivery(
  uuid, uuid, uuid, integer, text
) to service_role;

do $assertions$
begin
  if pg_catalog.to_regclass(
       'public.live_activity_start_deliveries_shift_device_key'
     ) is null
     or pg_catalog.to_regclass(
       'public.live_activity_start_deliveries_shift_token_key'
     ) is null
     or pg_catalog.to_regclass(
       'public.live_activity_start_deliveries_queue_key'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '018 assertion failed: durable START uniqueness is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.live_activity_start_deliveries'::regclass
      and table_info.relrowsecurity
  ) then
    raise exception using
      errcode = '42501',
      message = '018 assertion failed: START ledger row-level security is disabled';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.push_queue'::regclass
      and trigger_info.tgname =
          'push_queue_retain_unconfirmed_live_activity_start'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '018 assertion failed: unresolved START queue purge guard is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.push_queue'::regclass
      and trigger_info.tgname =
          'push_queue_validate_live_activity_start'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '018 assertion failed: START queue insert guard is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.live_activity_tokens'::regclass
      and trigger_info.tgname =
          'live_activity_tokens_reconcile_start_device'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '018 assertion failed: START device reconciliation trigger is missing';
  end if;

  if pg_catalog.has_table_privilege(
       'anon', 'public.live_activity_start_deliveries', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.live_activity_start_deliveries', 'SELECT'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)',
       'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '018 assertion failed: a client role can inspect or claim START delivery';
  end if;
end
$assertions$;

commit;
