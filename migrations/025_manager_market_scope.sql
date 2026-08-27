-- ============================================================================
-- 025_manager_market_scope.sql
-- Exact-market privacy for managers across shifts and notifications.
--
-- Owners remain global. Managers require one normalized, nonblank roster
-- market and may access only shifts in that exact normalized market. Team
-- members remain limited to their own shifts. Live Activity END is deliberately
-- unchanged, so a card that already started can still be ended durably.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if pg_catalog.to_regprocedure('public.hc_can_access_shift(uuid)') is null
     or pg_catalog.to_regprocedure(
          'public.hc_list_managed_shifts(timestamp with time zone,integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_list_managed_open_shift_ids()'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
        ) is null then
    raise exception using
      errcode = '55000',
      message = '025 requires authenticated shifts plus durable Live Activity START and END';
  end if;
end
$preflight$;

-- One fail-closed rule is reused everywhere. Blank manager markets and blank
-- shift markets never match. Owners do not need a market assignment.
create or replace function public.hc_management_can_access_shift_market(
  p_role text,
  p_roster_market text,
  p_shift_market text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case lower(trim(coalesce(p_role, '')))
    when 'owner' then true
    when 'manager' then
      nullif(lower(trim(coalesce(p_roster_market, ''))), '') is not null
      and nullif(lower(trim(coalesce(p_shift_market, ''))), '') is not null
      and lower(trim(p_roster_market)) = lower(trim(p_shift_market))
    else false
  end
$function$;

revoke all on function public.hc_management_can_access_shift_market(text, text, text)
  from public, anon, authenticated;
grant execute on function public.hc_management_can_access_shift_market(text, text, text)
  to authenticated, service_role;

-- Child-table policies call this yes/no helper. Team members get only their own
-- shift. Managers must match the shift market. Owners remain global.
create or replace function public.hc_can_access_shift(p_shift_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.shifts as shift_row
    join public.field_workers as worker
      on worker.auth_user_id = auth.uid()
     and worker.active is true
    where shift_row.id = p_shift_id
      and (
        (
          lower(trim(worker.role)) = 'team'
          and shift_row.field_worker_id = worker.id
        )
        or public.hc_management_can_access_shift_market(
          worker.role,
          worker.market,
          shift_row.market
        )
      )
  )
$function$;

revoke all on function public.hc_can_access_shift(uuid)
  from public, anon;
grant execute on function public.hc_can_access_shift(uuid)
  to authenticated, service_role;

-- Base shift rows contain payroll. Owners may read all. Team members may read
-- their own. A working manager may read only their own exact-market rows; the
-- Team tab must use hc_list_managed_shifts for its pay-free projection.
drop policy if exists shifts_authenticated_select on public.shifts;
create policy shifts_authenticated_select
on public.shifts
for select to authenticated
using (
  exists (
    select 1
    from public.field_workers as worker
    where worker.auth_user_id = auth.uid()
      and worker.active is true
      and (
        lower(trim(worker.role)) = 'owner'
        or (
          lower(trim(worker.role)) = 'team'
          and shifts.field_worker_id = worker.id
        )
        or (
          lower(trim(worker.role)) = 'manager'
          and shifts.field_worker_id = worker.id
          and public.hc_management_can_access_shift_market(
            worker.role,
            worker.market,
            shifts.market
          )
        )
      )
  )
);

-- Audit rows stay management-only, but a manager cannot read another market's
-- edits. Team members do not gain audit-log access through hc_can_access_shift.
drop policy if exists shift_edits_authenticated_select on public.shift_edits;
create policy shift_edits_authenticated_select
on public.shift_edits
for select to authenticated
using (
  public.hc_can_manage_shifts()
  and public.hc_can_access_shift(shift_edits.shift_id)
);

create or replace function public.hc_list_managed_shifts(
  p_since timestamptz,
  p_limit int default 60
)
returns table (
  id uuid,
  worker_name text,
  worker_email text,
  market text,
  clock_in_at timestamptz,
  clock_in_lat double precision,
  clock_in_lng double precision,
  clock_out_at timestamptz,
  clock_out_lat double precision,
  clock_out_lng double precision,
  device text,
  created_at timestamptz,
  is_paid boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_market text;
begin
  select lower(trim(worker.role)), lower(trim(worker.market))
  into v_role, v_market
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
  limit 1;

  if v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  if v_role = 'manager' and nullif(v_market, '') is null then
    raise exception using
      errcode = '42501',
      message = 'manager requires an assigned market';
  end if;

  return query
  select
    shift_row.id,
    shift_row.worker_name,
    shift_row.worker_email,
    shift_row.market,
    shift_row.clock_in_at,
    shift_row.clock_in_lat,
    shift_row.clock_in_lng,
    shift_row.clock_out_at,
    shift_row.clock_out_lat,
    shift_row.clock_out_lng,
    shift_row.device,
    shift_row.created_at,
    case
      when v_role = 'owner' then shift_row.paid_at is not null
      else null::boolean
    end as is_paid
  from public.shifts as shift_row
  where (p_since is null or shift_row.clock_in_at >= p_since)
    and public.hc_management_can_access_shift_market(
      v_role,
      v_market,
      shift_row.market
    )
  order by shift_row.clock_in_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 200));
end
$function$;

create or replace function public.hc_manage_clock_out(
  p_shift_id uuid,
  p_clock_out_at timestamptz default null,
  p_clock_out_lat double precision default null,
  p_clock_out_lng double precision default null
)
returns setof public.shifts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_editor_id uuid;
  v_editor text;
  v_role text;
  v_market text;
  v_before public.shifts%rowtype;
  v_after public.shifts%rowtype;
  v_stamp timestamptz := coalesce(p_clock_out_at, clock_timestamp());
begin
  select
    worker.id,
    lower(trim(worker.email)),
    lower(trim(worker.role)),
    lower(trim(worker.market))
  into v_editor_id, v_editor, v_role, v_market
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
  limit 1
  for share;

  if v_editor is null or v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  if v_role = 'manager' and nullif(v_market, '') is null then
    raise exception using
      errcode = '42501',
      message = 'manager requires an assigned market';
  end if;

  if (p_clock_out_lat is null) <> (p_clock_out_lng is null)
     or (p_clock_out_lat is not null and p_clock_out_lat not between -90 and 90)
     or (p_clock_out_lng is not null and p_clock_out_lng not between -180 and 180) then
    raise exception using
      errcode = '22023',
      message = 'invalid clock-out coordinates';
  end if;

  select *
  into v_before
  from public.shifts as shift_row
  where shift_row.id = p_shift_id
    and shift_row.clock_out_at is null
    and public.hc_management_can_access_shift_market(
      v_role,
      v_market,
      shift_row.market
    )
  for update;

  if not found then
    return;
  end if;

  if v_before.field_worker_id = v_editor_id then
    raise exception using
      errcode = '42501',
      message = 'use hc_clock_out_my_shift for your own shift';
  end if;

  if v_stamp < v_before.clock_in_at
     or v_stamp > clock_timestamp() + interval '1 minute' then
    raise exception using
      errcode = '22023',
      message = 'invalid managed clock-out time';
  end if;

  update public.shifts as shift_row
  set clock_out_at = v_stamp,
      clock_out_lat = p_clock_out_lat,
      clock_out_lng = p_clock_out_lng
  where shift_row.id = p_shift_id
    and shift_row.clock_out_at is null
  returning shift_row.* into v_after;

  if not found then
    return;
  end if;

  if v_role = 'manager' then
    v_after.paid_at := null;
    v_after.paid_cents := null;
    v_after.paid_minutes := null;
    v_after.summary_sent_at := null;
    v_after.clockin_notified_at := null;
  end if;

  insert into public.shift_edits (
    shift_id,
    editor_email,
    old_clock_in,
    old_clock_out,
    new_clock_in,
    new_clock_out,
    note
  ) values (
    p_shift_id,
    v_editor,
    v_before.clock_in_at,
    v_before.clock_out_at,
    v_after.clock_in_at,
    v_after.clock_out_at,
    'remote clock-out'
  );

  return next v_after;
end
$function$;

create or replace function public.hc_edit_shift_times(
  p_shift_id uuid,
  p_expected_clock_in timestamptz,
  p_expected_clock_out timestamptz,
  p_new_clock_in timestamptz,
  p_new_clock_out timestamptz,
  p_note text default null
)
returns setof public.shifts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_editor_id uuid;
  v_editor text;
  v_role text;
  v_market text;
  v_before public.shifts%rowtype;
  v_after public.shifts%rowtype;
  v_old_span interval;
  v_new_span interval;
begin
  select
    worker.id,
    lower(trim(worker.email)),
    lower(trim(worker.role)),
    lower(trim(worker.market))
  into v_editor_id, v_editor, v_role, v_market
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
  limit 1
  for share;

  if v_editor is null or v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  if v_role = 'manager' and nullif(v_market, '') is null then
    raise exception using
      errcode = '42501',
      message = 'manager requires an assigned market';
  end if;

  if p_expected_clock_in is null
     or p_expected_clock_out is null
     or p_new_clock_in is null
     or p_new_clock_out is null then
    raise exception using
      errcode = '22004',
      message = 'all clock timestamps are required';
  end if;

  select *
  into v_before
  from public.shifts as shift_row
  where shift_row.id = p_shift_id
    and shift_row.clock_in_at = p_expected_clock_in
    and shift_row.clock_out_at = p_expected_clock_out
    and public.hc_management_can_access_shift_market(
      v_role,
      v_market,
      shift_row.market
    )
  for update;

  if not found then
    return;
  end if;

  if v_role = 'manager'
     and v_before.field_worker_id = v_editor_id then
    raise exception using
      errcode = '42501',
      message = 'managers cannot edit their own shifts';
  end if;

  if v_role = 'manager' and v_before.paid_at is not null then
    raise exception using
      errcode = '42501',
      message = 'managers cannot edit paid shifts';
  end if;

  v_old_span := v_before.clock_out_at - v_before.clock_in_at;
  v_new_span := p_new_clock_out - p_new_clock_in;

  if p_new_clock_in >= p_new_clock_out
     or p_new_clock_out > clock_timestamp()
     or (
       v_new_span > interval '24 hours'
       and v_new_span >= v_old_span
     ) then
    raise exception using
      errcode = '22023',
      message = 'invalid edited shift times';
  end if;

  update public.shifts as shift_row
  set clock_in_at = p_new_clock_in,
      clock_out_at = p_new_clock_out
  where shift_row.id = p_shift_id
    and shift_row.clock_in_at = p_expected_clock_in
    and shift_row.clock_out_at = p_expected_clock_out
  returning shift_row.* into v_after;

  if not found then
    return;
  end if;

  insert into public.shift_edits (
    shift_id,
    editor_email,
    old_clock_in,
    old_clock_out,
    new_clock_in,
    new_clock_out,
    note
  ) values (
    p_shift_id,
    v_editor,
    v_before.clock_in_at,
    v_before.clock_out_at,
    v_after.clock_in_at,
    v_after.clock_out_at,
    nullif(left(trim(p_note), 500), '')
  );

  if v_role = 'manager' then
    v_after.paid_at := null;
    v_after.paid_cents := null;
    v_after.paid_minutes := null;
    v_after.summary_sent_at := null;
    v_after.clockin_notified_at := null;
  end if;

  return next v_after;
end
$function$;

create or replace function public.hc_list_managed_open_shift_ids()
returns table (shift_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_market text;
begin
  select lower(trim(worker.role)), lower(trim(worker.market))
  into v_role, v_market
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
  limit 1;

  if v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  if v_role = 'manager' and nullif(v_market, '') is null then
    raise exception using
      errcode = '42501',
      message = 'manager requires an assigned market';
  end if;

  return query
  select shift_row.id as shift_id
  from public.shifts as shift_row
  where shift_row.clock_out_at is null
    and lower(trim(coalesce(shift_row.worker_email, ''))) <>
        'appreview@hamptonscoconuts.com'
    and public.hc_management_can_access_shift_market(
      v_role,
      v_market,
      shift_row.market
    )
  order by shift_row.clock_in_at asc, shift_row.id asc;
end
$function$;

-- Rebuild the proven 018 claim with one added eligibility rule. Its lease,
-- stable queue UUID, token-rotation, and duplicate prevention behavior stays
-- unchanged.
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

  update public.live_activity_start_deliveries as delivery
  set claimed_at = null
  from public.shifts as shift_row
  where shift_row.id = delivery.shift_id
    and shift_row.clock_out_at is not null
    and delivery.queued_at is null
    and delivery.claimed_at is not null;

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

  insert into public.live_activity_start_deliveries (
    shift_id, device_id, start_token
  )
  select distinct shift_row.id, token_row.device_id, lower(token_row.token)
  from public.shifts as shift_row
  join public.live_activity_tokens as token_row
    on token_row.token_type = 'push_to_start'
   and token_row.shift_id is null
   and token_row.device_id is not null
  where shift_row.clock_out_at is null
    and shift_row.clock_in_at >= p_started_after
    and lower(trim(coalesce(shift_row.worker_email, ''))) <>
        'appreview@hamptonscoconuts.com'
    and lower(trim(token_row.email)) <>
        lower(trim(coalesce(shift_row.worker_email, '')))
    and exists (
      select 1
      from public.field_workers as manager
      where lower(trim(manager.email)) = lower(trim(token_row.email))
        and manager.active is true
        and manager.auth_user_id is not null
        and public.hc_management_can_access_shift_market(
          manager.role,
          manager.market,
          shift_row.market
        )
    )
  on conflict do nothing;

  return query
  with eligible_pairs as materialized (
    select distinct
      delivery.id as delivery_id,
      shift_row.id as shift_id,
      token_row.device_id,
      lower(trim(token_row.email)) as email,
      lower(token_row.token) as token,
      shift_row.worker_name,
      lower(trim(shift_row.worker_email)) as worker_email,
      shift_row.clock_in_at,
      coalesce(latest.at, shift_row.clock_in_at) as report_at,
      coalesce(latest.lat, shift_row.clock_in_lat) as report_lat,
      coalesce(latest.lng, shift_row.clock_in_lng) as report_lng
    from public.live_activity_start_deliveries as delivery
    join public.shifts as shift_row
      on shift_row.id = delivery.shift_id
    join public.live_activity_tokens as token_row
      on token_row.token_type = 'push_to_start'
     and token_row.shift_id is null
     and lower(token_row.token) = delivery.start_token
    left join lateral (
      select location_row.at, location_row.lat, location_row.lng
      from public.shift_locations as location_row
      where location_row.shift_id = shift_row.id
      order by location_row.at desc, location_row.id desc
      limit 1
    ) as latest on true
    where shift_row.clock_out_at is null
      and lower(trim(coalesce(shift_row.worker_email, ''))) <>
          'appreview@hamptonscoconuts.com'
      and lower(trim(token_row.email)) <>
          lower(trim(coalesce(shift_row.worker_email, '')))
      and exists (
        select 1
        from public.field_workers as manager
        where lower(trim(manager.email)) = lower(trim(token_row.email))
          and manager.active is true
          and manager.auth_user_id is not null
          and public.hc_management_can_access_shift_market(
            manager.role,
            manager.market,
            shift_row.market
          )
      )
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = token_row.device_id
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

-- The queue INSERT is the last Worker-side check. It re-evaluates the current
-- role and exact market after claiming, so a market change cannot race a START.
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
         on lower(trim(manager.email)) = lower(trim(token_row.email))
        and manager.active is true
        and manager.auth_user_id is not null
        and public.hc_management_can_access_shift_market(
          manager.role,
          manager.market,
          shift_row.market
        )
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
         and lower(trim(coalesce(shift_row.worker_email, ''))) <>
             'appreview@hamptonscoconuts.com'
         and lower(trim(token_row.email)) <>
             lower(trim(coalesce(shift_row.worker_email, '')))
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

-- pushdrain repeats the same market test immediately before contacting Apple.
-- This blocks a queued START if the manager moved markets after enqueue.
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
    join public.notification_device_authorizations as device_auth
      on device_auth.device_id = token_row.device_id
     and device_auth.revoked_at is null
    join public.field_workers as manager
      on manager.id = device_auth.field_worker_id
     and manager.auth_user_id = device_auth.auth_user_id
     and manager.active is true
     and lower(trim(manager.email)) = lower(trim(token_row.email))
     and public.hc_management_can_access_shift_market(
       manager.role,
       manager.market,
       shift_row.market
     )
    where delivery.id = p_delivery_id
      and delivery.shift_id = p_shift_id
      and delivery.queue_id = p_queue_id
      and delivery.generation = p_generation
      and delivery.start_token = lower(trim(p_start_token))
      and delivery.device_id = token_row.device_id
      and delivery.delivered_at is null
      and delivery.terminal_at is null
      and (
        delivery.queued_at is not null
        or delivery.claimed_at is not null
      )
      and shift_row.clock_out_at is null
      and lower(trim(coalesce(shift_row.worker_email, ''))) <>
          'appreview@hamptonscoconuts.com'
      and lower(trim(token_row.email)) <>
          lower(trim(coalesce(shift_row.worker_email, '')))
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

-- Reassert all affected grants. CREATE OR REPLACE preserves old privileges.
revoke all on function public.hc_list_managed_shifts(timestamptz, integer)
  from public, anon;
revoke all on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  from public, anon;
revoke all on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  from public, anon;
revoke all on function public.hc_list_managed_open_shift_ids()
  from public, anon;
revoke all on function public.hc_claim_live_activity_starts(
  timestamptz, timestamptz, timestamptz, integer
) from public, anon, authenticated;
revoke all on function public.hc_validate_live_activity_start_queue()
  from public, anon, authenticated;
revoke all on function public.hc_validate_live_activity_start_delivery(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated;

grant execute on function public.hc_list_managed_shifts(timestamptz, integer)
  to authenticated, service_role;
grant execute on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  to authenticated, service_role;
grant execute on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  to authenticated, service_role;
grant execute on function public.hc_list_managed_open_shift_ids()
  to authenticated, service_role;
grant execute on function public.hc_claim_live_activity_starts(
  timestamptz, timestamptz, timestamptz, integer
) to service_role;
grant execute on function public.hc_validate_live_activity_start_delivery(
  uuid, uuid, uuid, integer, text
) to service_role;

do $assertions$
declare
  v_definition text;
  v_policy text;
begin
  if public.hc_management_can_access_shift_market('owner', null, null) is not true
     or public.hc_management_can_access_shift_market('manager', ' NY ', 'ny') is not true
     or public.hc_management_can_access_shift_market('manager', 'ny', 'miami') is not false
     or public.hc_management_can_access_shift_market('manager', '', '') is not false
     or public.hc_management_can_access_shift_market('team', 'ny', 'ny') is not false then
    raise exception using
      errcode = '55000',
      message = '025 assertion failed: normalized market rule is incorrect';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.hc_list_managed_shifts(timestamp with time zone,integer)'::regprocedure
  ) into v_definition;
  if v_definition !~ 'else null::boolean'
     or v_definition !~ 'hc_management_can_access_shift_market' then
    raise exception using
      errcode = '55000',
      message = '025 assertion failed: managed shift projection leaks pay or market scope';
  end if;

  select pg_catalog.pg_get_expr(policy_info.polqual, policy_info.polrelid)
  into v_policy
  from pg_catalog.pg_policy as policy_info
  where policy_info.polrelid = 'public.shift_edits'::regclass
    and policy_info.polname = 'shift_edits_authenticated_select';
  if v_policy is null
     or v_policy !~ 'hc_can_manage_shifts'
     or v_policy !~ 'hc_can_access_shift' then
    raise exception using
      errcode = '55000',
      message = '025 assertion failed: shift edit audit is not market scoped';
  end if;

  foreach v_definition in array array[
    pg_catalog.pg_get_functiondef(
      'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'::regprocedure
    ),
    pg_catalog.pg_get_functiondef(
      'public.hc_validate_live_activity_start_queue()'::regprocedure
    ),
    pg_catalog.pg_get_functiondef(
      'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'::regprocedure
    )
  ] loop
    if v_definition !~ 'hc_management_can_access_shift_market'
       or v_definition !~ 'appreview@hamptonscoconuts.com' then
      raise exception using
        errcode = '55000',
        message = '025 assertion failed: START path lacks market or App Review guard';
    end if;
  end loop;

  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '025 assertion failed: durable END RPC changed';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_list_managed_shifts(timestamp with time zone,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)',
       'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '025 assertion failed: an unsafe function grant remains';
  end if;
end
$assertions$;

commit;
