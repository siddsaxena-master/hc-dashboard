-- ============================================================================
-- 040_order_departures.sql
-- The departure plan for each delivery: when to leave, from where, and what
-- has happened so far. Written after the 2026-09-12 Pridwin (Shelter Island)
-- wedding ran 2h45 late because nothing in the system knew a clock time, a
-- drive time, or when anyone should leave the garage.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- What this adds:
--   * public.order_departures: exactly ONE plan row per order (order_id is
--     the primary key). Claudia, the Cloudflare worker, writes it every five
--     minutes with the service key: the arrival time it could read, the
--     start point (NJ garage, or the clock-in spot in Vegas and Miami), the
--     destination, the drive time from Apple Maps or Google, the leave-by
--     time, what the GPS says the crew are doing, and a small "alerts" record
--     of which banners have already been sent so nothing is sent twice. The
--     row cascades away with its order.
--   * public.hc_departure_action(order, action): the ONE write path a phone
--     has into this table. "on_my_way" (an acknowledgement), "left_garage"
--     (the real departure signal; needs an open shift so the GPS can back it
--     up), "silence" / "unsilence" (owner or same-market manager: stop the
--     late nags for one job), and "reset_departure" (owner or manager: undo a
--     mis-tap). Everything else about the row is the worker's to write.
--
-- Reading: row level security plus a SELECT grant to the authenticated role
-- only. The rule is the one 019 already installs, hc_can_access_order_market:
-- owners see every market, active managers and team members see rows in
-- their own market. The market is COPIED onto the row so the policy never has
-- to look inside orders, which stays readable by the public dashboard key
-- until migration 020. anon and PUBLIC get nothing, so the dashboard's public
-- key cannot read where the crew are or when they left.
--
-- The row deliberately carries no email address and no phone token: a
-- same-market team member can read it, so it holds a display name (ack_name)
-- and an auth user id (ack_by) instead.
--
-- What this never touches: public.orders, public.shifts, public.field_workers
-- (nothing added, changed or read out to the caller beyond yes/no), payroll,
-- invoices, delivery_request, and every existing policy or function. Nothing
-- here changes a delivery time; that stays behind hc_set_delivery_request.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
begin
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_can_access_order_market(text)') is null then
    raise exception using
      errcode = '55000',
      message = '040 requires public.orders, public.shifts, public.field_workers, auth.uid() and public.hc_can_access_order_market(text) from migration 019';
  end if;

  -- Every shift column the action function reads.
  foreach v_column in array array['id', 'worker_email', 'market', 'clock_in_at', 'clock_out_at'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.shifts'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('040 requires column public.shifts.%s', v_column);
    end if;
  end loop;

  -- Every roster column the action function reads.
  foreach v_column in array array['id', 'auth_user_id', 'role', 'market', 'active', 'email', 'name'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.field_workers'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('040 requires field_workers.%s from migration 015', v_column);
    end if;
  end loop;

  -- A table already carrying this name must be the one 040 installs. Refuse
  -- rather than bolt policies and grants onto somebody else's table.
  if pg_catalog.to_regclass('public.order_departures') is not null then
    foreach v_column in array array[
      'order_id', 'plan_date', 'market', 'arrive_at', 'leave_by_at', 'movement', 'state', 'alerts'
    ] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.order_departures'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            '040 refuses an existing public.order_departures with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

-- One plan per order. Every timestamp is a real instant (timestamptz); the
-- plan_date is the delivery's calendar day in the market's own time zone and
-- is what the phones and the day-before banner filter on.
create table if not exists public.order_departures (
  order_id uuid primary key references public.orders(id) on delete cascade,
  plan_date date not null,
  market text,

  -- When the coconuts must be there, and where that time came from.
  --   arrive_kind: exact "2:00 PM", range "3:30/4 PM" (the earlier end wins),
  --   deadline "by 2 PM", assumed (no AM/PM given, the worker guessed and
  --   said so), none (nothing readable).
  arrive_at timestamptz,
  arrive_kind text check (arrive_kind is null or arrive_kind in ('exact', 'range', 'deadline', 'assumed', 'none')),
  arrive_source text check (arrive_source is null or arrive_source in ('delivery_request', 'invoice_window', 'none')),
  window_text text,
  -- A time a coordinator or venue email proposed that the owner has not yet
  -- accepted. The alarm uses the earlier of arrive_at and alt_arrive_at.
  alt_arrive_at timestamptz,
  alt_intake_id bigint,

  -- Where the drive starts: the NJ garage, the clocked-in worker's clock-in
  -- spot, the last clock-in spot seen in that market, or nothing known.
  origin_kind text check (origin_kind is null or origin_kind in ('garage', 'clock_in', 'last_clock_in', 'none')),
  origin_lat double precision,
  origin_lng double precision,
  origin_label text,
  origin_shift_id uuid references public.shifts(id) on delete set null,

  -- Where the drive ends, as the address text the route was asked for and
  -- the coordinates the router answered with.
  dest_source text,
  dest_address text,
  dest_lat double precision,
  dest_lng double precision,

  -- The route answer. drive_seconds includes live traffic; static_seconds
  -- is the same trip with no traffic. route_source says which service
  -- answered, or 'none' with route_error saying why not.
  drive_seconds integer check (drive_seconds is null or drive_seconds between 0 and 259200),
  static_seconds integer check (static_seconds is null or static_seconds between 0 and 259200),
  distance_meters integer check (distance_meters is null or distance_meters between 0 and 10000000),
  has_ferry boolean not null default false,
  route_source text not null default 'none' check (route_source in ('apple_maps', 'google_routes', 'none')),
  route_error text,

  -- The cushion: one hour always, plus half an hour for a ferry line.
  buffer_seconds integer not null default 3600 check (buffer_seconds between 0 and 86400),
  ferry_seconds integer not null default 0 check (ferry_seconds between 0 and 86400),
  leave_by_at timestamptz,
  eta_at timestamptz,

  -- What the crew are doing, from GPS or from a "left the garage" tap.
  movement text not null default 'nobody' check (movement in ('nobody', 'unknown', 'at_origin', 'moving_no_pickup', 'departed', 'arrived')),
  pickup_seen_at timestamptz,
  pickup_source text check (pickup_source is null or pickup_source in ('gps', 'claim')),
  en_route_shift_id uuid references public.shifts(id) on delete set null,

  -- Where the plan stands. needs_ampm, no_time, no_address, no_origin and
  -- no_route are honest "cannot plan" states the owner is told about.
  state text not null default 'pending' check (state in ('pending', 'planned', 'needs_ampm', 'no_time', 'no_address', 'no_origin', 'no_route', 'multi_stop', 'arrived', 'closed')),

  -- Taps from the phones. silenced stops the late nags for this one job;
  -- the acknowledgement names who said "on my way" or "left the garage".
  silenced_at timestamptz,
  silenced_by uuid,
  ack_at timestamptz,
  ack_by uuid,
  ack_name text check (ack_name is null or (pg_catalog.length(ack_name) between 1 and 80 and ack_name !~ '[[:cntrl:]]')),

  -- Which banners have gone out already, as {stage: {at, queue_id}} stamps,
  -- plus no_recipients_at and unreachable when nobody could be reached.
  alerts jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(alerts) = 'object'),

  computed_at timestamptz,
  next_refresh_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now()
);

-- The phones read a two-week window; the worker reads today and tomorrow.
create index if not exists order_departures_plan_date_idx
  on public.order_departures (plan_date);
create index if not exists order_departures_market_plan_date_idx
  on public.order_departures (market, plan_date);

alter table public.order_departures enable row level security;

-- Supabase grants new public tables to anon and authenticated by default.
-- Take that back before granting the one thing a phone needs: reading.
revoke all on table public.order_departures from public, anon, authenticated;
grant select on table public.order_departures to authenticated;
-- The worker writes with the service key.
grant select, insert, update, delete on table public.order_departures to service_role;

-- The single read rule, shared with the 019 order projection: owners see
-- every market, managers and team members see their own market only.
drop policy if exists order_departures_authenticated_select on public.order_departures;
create policy order_departures_authenticated_select
on public.order_departures
for select to authenticated
using (public.hc_can_access_order_market(order_departures.market));

-- The one write path a phone has into this table.
--   p_order_id  the order whose plan row to act on
--   p_action    on_my_way | left_garage | silence | unsilence | reset_departure
-- Returns the stored row as jsonb. The caller must be an active roster
-- worker in the row's market (owners reach every market).
create or replace function public.hc_departure_action(
  p_order_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_market text;
  v_email text;
  v_name text;
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_row public.order_departures%rowtype;
  v_row_market text;
  v_shift_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  -- Who is calling: one active roster row, role and market normalized the
  -- same way 019 and 038 normalize them.
  select pg_catalog.lower(pg_catalog.btrim(w.role)),
         nullif(pg_catalog.lower(pg_catalog.btrim(w.market)), ''),
         nullif(pg_catalog.lower(pg_catalog.btrim(w.email)), ''),
         nullif(pg_catalog.btrim(w.name), '')
  into v_role, v_market, v_email, v_name
  from public.field_workers as w
  where w.auth_user_id = v_uid
    and w.active is true
  limit 1;

  if v_role is null then
    raise exception using
      errcode = '42501',
      message = 'active field worker required';
  end if;

  if p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id is required';
  end if;

  -- Hold the row for the rest of this call so two taps cannot interleave.
  select d.* into v_row
  from public.order_departures as d
  where d.order_id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'no departure plan for this order';
  end if;

  v_row_market := nullif(pg_catalog.lower(pg_catalog.btrim(v_row.market)), '');

  -- Owners reach every market. Everyone else must match the row's market
  -- exactly; a blank market on either side never matches (fail closed).
  if v_role <> 'owner'
     and (v_market is null or v_row_market is null or v_market <> v_row_market) then
    raise exception using
      errcode = '42501',
      message = 'not your market';
  end if;

  if v_action = 'on_my_way' then
    update public.order_departures
       set ack_at = v_now,
           ack_by = v_uid,
           ack_name = coalesce(v_name, 'Field worker'),
           updated_at = v_now
     where order_id = p_order_id;

  elsif v_action = 'left_garage' then
    if v_row.state in ('arrived', 'closed') then
      raise exception using
        errcode = '22023',
        message = 'This job is already over';
    end if;

    -- The departure claim must be backed by an open shift for this caller in
    -- this market, so the GPS trail can confirm or contradict it. The Apple
    -- review login never counts.
    select s.id into v_shift_id
    from public.shifts as s
    where s.clock_out_at is null
      and v_email is not null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(s.worker_email, ''))) = v_email
      and pg_catalog.lower(pg_catalog.btrim(coalesce(s.worker_email, ''))) <> 'appreview@hamptonscoconuts.com'
      and nullif(pg_catalog.lower(pg_catalog.btrim(s.market)), '') is not distinct from v_row_market
    order by s.clock_in_at desc
    limit 1;

    if v_shift_id is null then
      raise exception using
        errcode = '22023',
        message = 'Clock in first so the app can see you move';
    end if;

    update public.order_departures
       set pickup_seen_at = coalesce(pickup_seen_at, v_now),
           pickup_source = 'claim',
           en_route_shift_id = v_shift_id,
           ack_at = v_now,
           ack_by = v_uid,
           ack_name = coalesce(v_name, 'Field worker'),
           updated_at = v_now
     where order_id = p_order_id;

  elsif v_action in ('silence', 'unsilence', 'reset_departure') then
    if v_role not in ('owner', 'manager') then
      raise exception using
        errcode = '42501',
        message = 'only an owner or manager can do that';
    end if;

    if v_action = 'silence' then
      update public.order_departures
         set silenced_at = coalesce(silenced_at, v_now),
             silenced_by = coalesce(silenced_by, v_uid),
             updated_at = v_now
       where order_id = p_order_id;
    elsif v_action = 'unsilence' then
      update public.order_departures
         set silenced_at = null,
             silenced_by = null,
             updated_at = v_now
       where order_id = p_order_id;
    else
      -- Undo a mis-tapped "left the garage" or "on my way".
      update public.order_departures
         set pickup_seen_at = null,
             pickup_source = null,
             en_route_shift_id = null,
             ack_at = null,
             ack_by = null,
             ack_name = null,
             updated_at = v_now
       where order_id = p_order_id;
    end if;

  else
    raise exception using
      errcode = '22023',
      message = pg_catalog.format('unknown departure action %L', p_action);
  end if;

  select d.* into v_row
  from public.order_departures as d
  where d.order_id = p_order_id;

  return pg_catalog.to_jsonb(v_row);
end
$function$;

revoke all on function public.hc_departure_action(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hc_departure_action(uuid, text)
  to authenticated;

comment on function public.hc_departure_action(uuid, text) is
  'The one phone write into order_departures: on_my_way (any active roster member in the row market), left_garage (same, needs an open non-review shift in that market; records the departure claim), silence / unsilence / reset_departure (owner or same-market manager). Owners reach every market. Never changes a delivery time.';

comment on table public.order_departures is
  'One departure plan per order, written by the Claudia worker every five minutes: arrival time read from the order, start point, destination, drive time with traffic, leave-by time, GPS movement, and the alerts already sent. Readable per market by the phones; no emails or tokens on the row.';

do $postflight$
begin
  if pg_catalog.to_regclass('public.order_departures') is null then
    raise exception using errcode = '55000', message = '040 postflight: public.order_departures is missing';
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.order_departures'::regclass) then
    raise exception using errcode = '55000', message = '040 postflight: row level security is off on order_departures';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'order_departures'
      and policyname = 'order_departures_authenticated_select'
  ) then
    raise exception using errcode = '55000', message = '040 postflight: the select policy is missing';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.order_departures', 'select')
     or pg_catalog.has_table_privilege('anon', 'public.order_departures', 'insert') then
    raise exception using errcode = '55000', message = '040 postflight: anon can still reach order_departures';
  end if;

  if not pg_catalog.has_table_privilege('authenticated', 'public.order_departures', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_departures', 'insert')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_departures', 'update') then
    raise exception using errcode = '55000', message = '040 postflight: authenticated must be able to select and nothing else';
  end if;

  if not pg_catalog.has_table_privilege('service_role', 'public.order_departures', 'update') then
    raise exception using errcode = '55000', message = '040 postflight: service_role cannot write order_departures';
  end if;

  if pg_catalog.to_regprocedure('public.hc_departure_action(uuid, text)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_departure_action(uuid, text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_departure_action(uuid, text)', 'execute') then
    raise exception using errcode = '55000', message = '040 postflight: hc_departure_action grants are wrong';
  end if;
end
$postflight$;

commit;
