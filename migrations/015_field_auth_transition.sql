-- ============================================================================
-- 015_field_auth_transition.sql
-- Authenticated transition path for the HC Field app.
--
-- LOCAL MIGRATION FILE ONLY. Running this against Supabase is a production
-- write and needs Sidd's explicit "yes do it" confirmation.
--
-- PURPOSE
-- 1. Link field_workers rows to Supabase Auth identities.
-- 2. Add authenticated RLS policies beside the existing anon policies.
-- 3. Move sensitive writes into server-controlled RPC functions.
-- 4. Create shift_orders safely, without the anon policies in the unrun 014.
--
-- TRANSITION RULE
-- Existing anon policies on existing tables remain in place here so the
-- currently installed app does not stop working before the authenticated app
-- is on every phone. A later cutover migration must drop those anon policies,
-- revoke anon table privileges, and remove direct authenticated writes that
-- have been replaced by these RPCs.
--
-- MIGRATION 014
-- Do not run 014_shift_orders.sql. This migration supersedes it and repeats
-- its table/index creation. If 014 was run accidentally, this migration drops
-- its two unsafe anon policies and revokes anon access to shift_orders.
--
-- SERVICE ROLE
-- Claudia, Jarvis, Mark, and pushdrain use the Supabase service-role key. This
-- migration does not revoke service_role privileges or change its RLS bypass.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- 1. Auth identity link
-- --------------------------------------------------------------------------

alter table public.field_workers
  add column if not exists auth_user_id uuid;

-- A case-insensitive duplicate would make first-login identity claiming
-- ambiguous. Stop with a clear error instead of linking the wrong person.
do $migration$
begin
  if exists (
    select 1
    from public.field_workers
    group by lower(email)
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'field_workers contains duplicate emails that differ only by case';
  end if;
end
$migration$;

create unique index if not exists field_workers_email_lower_uidx
  on public.field_workers (lower(email));

-- Add the FK separately so a re-run also repairs a column that may have been
-- added manually without its constraint.
do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.field_workers'::regclass
      and conname = 'field_workers_auth_user_id_fkey'
  ) then
    alter table public.field_workers
      add constraint field_workers_auth_user_id_fkey
      foreign key (auth_user_id)
      references auth.users(id)
      on delete set null
      not valid;
  end if;
end
$migration$;

alter table public.field_workers
  validate constraint field_workers_auth_user_id_fkey;

-- Link roster rows for people who already completed a Supabase Auth login.
update public.field_workers as fw
set auth_user_id = au.id
from auth.users as au
where fw.auth_user_id is null
  and au.email is not null
  and au.email_confirmed_at is not null
  and lower(fw.email) = lower(au.email);

-- A partially applied or manually edited transition must not retain an
-- unconfirmed or email-mismatched Auth link.
do $migration$
begin
  if exists (
    select 1
    from public.field_workers as fw
    left join auth.users as au on au.id = fw.auth_user_id
    where fw.auth_user_id is not null
      and (
        au.id is null
        or au.email is null
        or au.email_confirmed_at is null
        or lower(au.email) <> lower(fw.email)
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'field_workers has an unconfirmed or email-mismatched Auth link';
  end if;
end
$migration$;

create unique index if not exists field_workers_auth_user_uidx
  on public.field_workers (auth_user_id)
  where auth_user_id is not null;

-- Keep shift ownership on an immutable roster ID. Email and display name are
-- still retained as historical snapshots for the current app and reports.
alter table public.shifts
  add column if not exists field_worker_id uuid;

update public.shifts as s
set field_worker_id = fw.id
from public.field_workers as fw
where s.field_worker_id is null
  and s.worker_email is not null
  and lower(s.worker_email) = lower(fw.email);

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.shifts'::regclass
      and conname = 'shifts_field_worker_id_fkey'
  ) then
    alter table public.shifts
      add constraint shifts_field_worker_id_fkey
      foreign key (field_worker_id)
      references public.field_workers(id)
      on delete restrict
      not valid;
  end if;
end
$migration$;

alter table public.shifts
  validate constraint shifts_field_worker_id_fkey;

create index if not exists shifts_field_worker_idx
  on public.shifts (field_worker_id, clock_in_at desc);

-- Stop safely if old data already has two open shifts for one email. After
-- cleanup, these indexes protect both the legacy email path and the new ID
-- path, including races between an old app and an authenticated app.
do $migration$
begin
  if exists (
    select 1
    from public.shifts
    where clock_out_at is null
      and worker_email is not null
    group by lower(worker_email)
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'shifts contains duplicate open shifts for one worker email';
  end if;
end
$migration$;

create unique index if not exists shifts_one_open_worker_email_uidx
  on public.shifts (lower(worker_email))
  where clock_out_at is null and worker_email is not null;

create unique index if not exists shifts_one_open_worker_uidx
  on public.shifts (field_worker_id)
  where clock_out_at is null and field_worker_id is not null;

-- The legacy app still inserts with worker_email during this transition. This
-- trigger resolves that email once, stores the immutable roster ID, and then
-- prevents later updates from changing the shift's worker identity.
create or replace function public.hc_assign_shift_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker_id uuid;
begin
  if tg_op = 'UPDATE' then
    -- Existing ownership is immutable. For an unmatched historical row, keep
    -- it unmatched so service-role summary/status updates remain compatible.
    new.worker_email := old.worker_email;
    if old.field_worker_id is not null then
      new.field_worker_id := old.field_worker_id;
    else
      select fw.id
      into v_worker_id
      from public.field_workers as fw
      where lower(fw.email) = lower(old.worker_email)
      limit 1;
      new.field_worker_id := v_worker_id;
    end if;
    return new;
  end if;

  select fw.id
  into v_worker_id
  from public.field_workers as fw
  where fw.active is true
    and lower(fw.email) = lower(new.worker_email)
  limit 1;

  if v_worker_id is null then
    raise exception using
      errcode = '23503',
      message = 'shift worker email is not on the active field roster';
  end if;

  new.field_worker_id := v_worker_id;
  new.worker_email := lower(new.worker_email);
  return new;
end
$function$;

revoke all on function public.hc_assign_shift_worker()
  from public, anon, authenticated;

drop trigger if exists shifts_assign_field_worker on public.shifts;
create trigger shifts_assign_field_worker
before insert or update on public.shifts
for each row execute function public.hc_assign_shift_worker();

-- --------------------------------------------------------------------------
-- 2. shift_orders, secure replacement for the unrun migration 014
-- --------------------------------------------------------------------------

create table if not exists public.shift_orders (
  id            uuid primary key default gen_random_uuid(),
  shift_id      uuid not null references public.shifts(id) on delete cascade,
  order_id      uuid references public.orders(id) on delete set null,
  work_type     text not null check (work_type in ('delivery', 'prep')),
  coconuts_qty  int,
  client_name   text,
  worker_email  text,
  marked_at     timestamptz not null default now()
);

create unique index if not exists shift_orders_unique_idx
  on public.shift_orders (shift_id, order_id, work_type);

create index if not exists shift_orders_shift_idx
  on public.shift_orders (shift_id);

create index if not exists shift_orders_order_idx
  on public.shift_orders (order_id);

alter table public.shift_orders enable row level security;

-- These are the unsafe policies from 014. Removing them is safe during the
-- transition because no production build uses shift_orders yet.
drop policy if exists shift_orders_anon_insert on public.shift_orders;
drop policy if exists shift_orders_anon_select on public.shift_orders;
revoke all on table public.shift_orders from public, anon;

-- Keep explicit service-role compatibility for the Claudia summary reader.
grant all on table public.shift_orders to service_role;

-- --------------------------------------------------------------------------
-- 3. Small authenticated identity helpers
-- --------------------------------------------------------------------------

-- First verified login claims the one active roster row whose email matches
-- Supabase Auth's protected user record, not a client request body or an
-- unverified JWT field. A linked row can never be claimed by another user.
create or replace function public.hc_claim_field_worker()
returns table (
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
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  -- Resolve identity from Auth's protected table. A JWT email claim alone is
  -- not enough because a project can issue sessions before email confirmation.
  select lower(au.email)
  into v_email
  from auth.users as au
  where au.id = v_uid
    and au.email is not null
    and au.email_confirmed_at is not null;

  if v_email is null then
    raise exception using
      errcode = '42501',
      message = 'confirmed Supabase email required';
  end if;

  update public.field_workers as fw
  set auth_user_id = v_uid
  where fw.auth_user_id is null
    and fw.active is true
    and lower(fw.email) = v_email;

  return query
  select lower(fw.email), fw.name, fw.market, fw.role
  from public.field_workers as fw
  where fw.auth_user_id = v_uid
    and fw.active is true
  limit 1;
end
$function$;

create or replace function public.hc_current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select fw.id
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
  limit 1
$function$;

create or replace function public.hc_current_worker_email()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select lower(fw.email)
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
  limit 1
$function$;

create or replace function public.hc_current_worker_role()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select fw.role
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
  limit 1
$function$;

create or replace function public.hc_is_active_worker()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.field_workers as fw
    where fw.auth_user_id = auth.uid()
      and fw.active is true
  )
$function$;

create or replace function public.hc_can_manage_shifts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(public.hc_current_worker_role() in ('owner', 'manager'), false)
$function$;

create or replace function public.hc_is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(public.hc_current_worker_role() = 'owner', false)
$function$;

-- Used by child-table policies. This bypasses the shifts table's own RLS only
-- long enough to answer yes/no, so managers can read routes and attribution
-- without receiving payroll columns from the parent shift row.
create or replace function public.hc_can_access_shift(p_shift_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.shifts as s
    join public.field_workers as fw
      on fw.auth_user_id = auth.uid()
     and fw.active is true
    where s.id = p_shift_id
      and (
        s.field_worker_id = fw.id
        or fw.role in ('owner', 'manager')
      )
  )
$function$;

-- Functions are executable by PUBLIC by default in Postgres. Remove that
-- default before granting only the roles that need them.
revoke all on function public.hc_claim_field_worker() from public, anon;
revoke all on function public.hc_current_worker_id() from public, anon;
revoke all on function public.hc_current_worker_email() from public, anon;
revoke all on function public.hc_current_worker_role() from public, anon;
revoke all on function public.hc_is_active_worker() from public, anon;
revoke all on function public.hc_can_manage_shifts() from public, anon;
revoke all on function public.hc_is_owner() from public, anon;
revoke all on function public.hc_can_access_shift(uuid) from public, anon;

grant execute on function public.hc_claim_field_worker() to authenticated, service_role;
grant execute on function public.hc_current_worker_id() to authenticated, service_role;
grant execute on function public.hc_current_worker_email() to authenticated, service_role;
grant execute on function public.hc_current_worker_role() to authenticated, service_role;
grant execute on function public.hc_is_active_worker() to authenticated, service_role;
grant execute on function public.hc_can_manage_shifts() to authenticated, service_role;
grant execute on function public.hc_is_owner() to authenticated, service_role;
grant execute on function public.hc_can_access_shift(uuid) to authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. Authenticated read and GPS policies
-- --------------------------------------------------------------------------

alter table public.field_workers enable row level security;
alter table public.shifts enable row level security;
alter table public.shift_locations enable row level security;
alter table public.shift_edits enable row level security;
alter table public.app_config enable row level security;
alter table public.push_tokens enable row level security;
alter table public.live_activity_tokens enable row level security;

drop policy if exists field_workers_authenticated_select on public.field_workers;
create policy field_workers_authenticated_select
on public.field_workers
for select to authenticated
using (
  (auth_user_id = auth.uid() and active is true)
  or public.hc_is_owner()
);

drop policy if exists shifts_authenticated_select on public.shifts;
create policy shifts_authenticated_select
on public.shifts
for select to authenticated
using (
  public.hc_is_active_worker()
  and (
    field_worker_id = public.hc_current_worker_id()
    or public.hc_is_owner()
  )
);

drop policy if exists shift_locations_authenticated_select on public.shift_locations;
create policy shift_locations_authenticated_select
on public.shift_locations
for select to authenticated
using (
  public.hc_is_active_worker()
  and public.hc_can_access_shift(shift_locations.shift_id)
);

-- GPS is the one direct authenticated write retained. Points must belong to
-- the caller's shift and fit inside its recorded time window. The five-minute
-- allowance covers timestamp and upload timing skew without allowing points
-- on unrelated shifts.
drop policy if exists shift_locations_authenticated_insert on public.shift_locations;
create policy shift_locations_authenticated_insert
on public.shift_locations
for insert to authenticated
with check (
  public.hc_is_active_worker()
  and shift_id is not null
  and lat between -90 and 90
  and lng between -180 and 180
  and (accuracy_m is null or accuracy_m >= 0)
  and exists (
    select 1
    from public.shifts as s
    where s.id = shift_locations.shift_id
      and s.field_worker_id = public.hc_current_worker_id()
      and shift_locations.at >= s.clock_in_at - interval '5 minutes'
      and shift_locations.at <= coalesce(s.clock_out_at, now()) + interval '5 minutes'
  )
);

drop policy if exists shift_edits_authenticated_select on public.shift_edits;
create policy shift_edits_authenticated_select
on public.shift_edits
for select to authenticated
using (public.hc_can_manage_shifts());

drop policy if exists shift_orders_authenticated_select on public.shift_orders;
create policy shift_orders_authenticated_select
on public.shift_orders
for select to authenticated
using (
  public.hc_is_active_worker()
  and public.hc_can_access_shift(shift_orders.shift_id)
);

drop policy if exists app_config_authenticated_owner_select on public.app_config;
create policy app_config_authenticated_owner_select
on public.app_config
for select to authenticated
using (public.hc_is_owner());

-- No authenticated table policies are added for push_tokens or
-- live_activity_tokens. Authenticated clients use the RPCs below, and the
-- service role keeps its direct access.

grant select on table public.field_workers to authenticated;
grant select on table public.shifts to authenticated;
grant select on table public.shift_locations to authenticated;
grant select on table public.shift_edits to authenticated;
grant select on table public.shift_orders to authenticated;
grant select on table public.app_config to authenticated;

-- Remove any broad default write grants before restoring the one intentional
-- direct write: bounded GPS inserts. Shift, audit, attribution, and token
-- writes must use the functions below from the first authenticated build.
revoke insert, update, delete on table public.field_workers from authenticated;
revoke insert, update, delete on table public.shifts from authenticated;
revoke insert, update, delete on table public.shift_edits from authenticated;
revoke insert, update, delete on table public.shift_orders from authenticated;
revoke insert, update, delete on table public.push_tokens from authenticated;
revoke insert, update, delete on table public.live_activity_tokens from authenticated;
revoke insert, update, delete on table public.app_config from authenticated;
revoke insert, update, delete on table public.shift_locations from authenticated;
revoke insert (id, shift_id, at, lat, lng, accuracy_m, speed_mps)
  on table public.shift_locations from authenticated;
grant insert (shift_id, at, lat, lng, accuracy_m, speed_mps)
  on table public.shift_locations to authenticated;
grant usage, select on sequence public.shift_locations_id_seq to authenticated;

-- --------------------------------------------------------------------------
-- 5. Secure shift write RPCs
-- --------------------------------------------------------------------------

-- Managers need the Team tab but must not receive payroll snapshots or the
-- worker-only claim fields on the base shifts table. Owners may also call this
-- endpoint, although the owner policy above permits their full-table reads.
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
begin
  if not public.hc_can_manage_shifts() then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  return query
  select
    s.id,
    s.worker_name,
    s.worker_email,
    s.market,
    s.clock_in_at,
    s.clock_in_lat,
    s.clock_in_lng,
    s.clock_out_at,
    s.clock_out_lat,
    s.clock_out_lng,
    s.device,
    s.created_at,
    s.paid_at is not null as is_paid
  from public.shifts as s
  where p_since is null or s.clock_in_at >= p_since
  order by s.clock_in_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 200));
end
$function$;

create or replace function public.hc_start_shift(
  p_clock_in_lat double precision default null,
  p_clock_in_lng double precision default null,
  p_device text default null
)
returns setof public.shifts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker public.field_workers%rowtype;
  v_shift public.shifts%rowtype;
begin
  select *
  into v_worker
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
  limit 1;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'active field worker required';
  end if;

  if (p_clock_in_lat is null) <> (p_clock_in_lng is null)
     or (p_clock_in_lat is not null and p_clock_in_lat not between -90 and 90)
     or (p_clock_in_lng is not null and p_clock_in_lng not between -180 and 180) then
    raise exception using
      errcode = '22023',
      message = 'invalid clock-in coordinates';
  end if;

  -- Serialize starts for this immutable roster ID and refuse a second open
  -- shift. The unique indexes above are the database-wide race backstop.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_worker.id::text, 0)
  );

  if exists (
    select 1
    from public.shifts as s
    where (
        s.field_worker_id = v_worker.id
        or lower(s.worker_email) = lower(v_worker.email)
      )
      and s.clock_out_at is null
  ) then
    raise exception using
      errcode = '23505',
      message = 'worker already has an open shift';
  end if;

  insert into public.shifts (
    field_worker_id,
    worker_name,
    worker_email,
    market,
    clock_in_lat,
    clock_in_lng,
    device
  ) values (
    v_worker.id,
    v_worker.name,
    lower(v_worker.email),
    v_worker.market,
    p_clock_in_lat,
    p_clock_in_lng,
    left(p_device, 200)
  )
  returning * into v_shift;

  return next v_shift;
end
$function$;

create or replace function public.hc_clock_out_my_shift(
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
  v_worker_id uuid := public.hc_current_worker_id();
  v_email text := public.hc_current_worker_email();
  v_before public.shifts%rowtype;
  v_shift public.shifts%rowtype;
  v_now timestamptz := clock_timestamp();
  v_stamp timestamptz := coalesce(p_clock_out_at, v_now);
begin
  if v_worker_id is null or v_email is null then
    raise exception using
      errcode = '42501',
      message = 'active field worker required';
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
  from public.shifts as s
  where s.id = p_shift_id
    and s.field_worker_id = v_worker_id
    and s.clock_out_at is null
  for update;

  if not found then
    return;
  end if;

  if v_stamp < v_before.clock_in_at
     or v_stamp > v_now + interval '1 minute'
     or v_stamp < v_now - interval '15 minutes' then
    raise exception using
      errcode = '22023',
      message = 'clock-out time is outside the allowed server window';
  end if;

  update public.shifts as s
  set clock_out_at = v_stamp,
      clock_out_lat = p_clock_out_lat,
      clock_out_lng = p_clock_out_lng
  where s.id = p_shift_id
    and s.field_worker_id = v_worker_id
    and s.clock_out_at is null
  returning s.* into v_shift;

  if found then
    return next v_shift;
  end if;
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
  v_editor_id uuid := public.hc_current_worker_id();
  v_editor text := public.hc_current_worker_email();
  v_role text := public.hc_current_worker_role();
  v_before public.shifts%rowtype;
  v_after public.shifts%rowtype;
  v_stamp timestamptz := coalesce(p_clock_out_at, clock_timestamp());
begin
  if v_editor is null or v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
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
  from public.shifts as s
  where s.id = p_shift_id
    and s.clock_out_at is null
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

  update public.shifts as s
  set clock_out_at = v_stamp,
      clock_out_lat = p_clock_out_lat,
      clock_out_lng = p_clock_out_lng
  where s.id = p_shift_id
    and s.clock_out_at is null
  returning s.* into v_after;

  if not found then
    return;
  end if;

  -- A manager may control the row but does not receive payroll snapshots.
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
  v_editor_id uuid := public.hc_current_worker_id();
  v_editor text := public.hc_current_worker_email();
  v_role text := public.hc_current_worker_role();
  v_before public.shifts%rowtype;
  v_after public.shifts%rowtype;
  v_old_span interval;
  v_new_span interval;
begin
  if v_editor is null or v_role not in ('owner', 'manager') then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
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
  from public.shifts as s
  where s.id = p_shift_id
    and s.clock_in_at = p_expected_clock_in
    and s.clock_out_at = p_expected_clock_out
  for update;

  -- Empty result is the optimistic-concurrency signal used by the app.
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

  update public.shifts as s
  set clock_in_at = p_new_clock_in,
      clock_out_at = p_new_clock_out
  where s.id = p_shift_id
    and s.clock_in_at = p_expected_clock_in
    and s.clock_out_at = p_expected_clock_out
  returning s.* into v_after;

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

  -- A manager may control the row but does not receive payroll snapshots.
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

-- Batch contract:
-- p_items = [{
--   "shift_id": "uuid",
--   "expected_clock_in_at": "timestamptz",
--   "expected_clock_out_at": "timestamptz",
--   "expected_rate_cents": 2200
-- }]
-- Returns the number of shifts atomically marked paid. Any missing, duplicate,
-- already-paid, changed, unmatched, or invalid item raises before any update.
drop function if exists public.hc_mark_shift_paid(uuid);

create or replace function public.hc_mark_shifts_paid(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item_count int;
  v_updated_count int;
  v_shift_id uuid;
  v_worker_id uuid;
  v_paid_at timestamptz;
begin
  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'owner required';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'p_items must be a JSON array';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 200 then
    raise exception using
      errcode = '22023',
      message = 'p_items must contain between 1 and 200 shifts';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents int
    )
    where item.shift_id is null
  ) then
    raise exception using
      errcode = '22023',
      message = 'every pay item requires a shift_id';
  end if;

  if (
    select count(*) <> count(distinct item.shift_id)
    from jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents int
    )
  ) then
    raise exception using
      errcode = '23505',
      message = 'duplicate shift_id in p_items';
  end if;

  -- Lock every existing target shift in UUID order. Competing batch calls take
  -- locks in the same order, avoiding a batch-to-batch deadlock.
  for v_shift_id in
    select item.shift_id
    from jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents int
    )
    order by item.shift_id
  loop
    perform 1
    from public.shifts as s
    where s.id = v_shift_id
    for update;
  end loop;

  -- Lock every referenced rate row in the same deterministic order. A roster
  -- rate edit cannot slip between validation and the payroll snapshot.
  for v_worker_id in
    select distinct s.field_worker_id
    from jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents int
    )
    join public.shifts as s on s.id = item.shift_id
    where s.field_worker_id is not null
    order by s.field_worker_id
  loop
    perform 1
    from public.field_workers as fw
    where fw.id = v_worker_id
    for update;
  end loop;

  -- Validate the complete batch after all locks and before the first update.
  -- IS NOT DISTINCT FROM makes null expectations explicit and race-safe.
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents int
    )
    left join public.shifts as s on s.id = item.shift_id
    left join public.field_workers as fw on fw.id = s.field_worker_id
    where s.id is null
       or s.field_worker_id is null
       or fw.id is null
       or s.clock_out_at is null
       or s.clock_out_at < s.clock_in_at
       or s.paid_at is not null
       or fw.hourly_rate_cents is null
       or fw.hourly_rate_cents < 0
       or not (
         s.clock_in_at is not distinct from item.expected_clock_in_at
       )
       or not (
         s.clock_out_at is not distinct from item.expected_clock_out_at
       )
       or not (
         fw.hourly_rate_cents is not distinct from item.expected_rate_cents
       )
  ) then
    raise exception using
      errcode = '22023',
      message = 'one or more pay items are missing, changed, already paid, or invalid';
  end if;

  -- Take one shared timestamp only after every item passes validation.
  v_paid_at := clock_timestamp();

  with items as (
    select *
    from jsonb_to_recordset(p_items) as item(
      shift_id uuid,
      expected_clock_in_at timestamptz,
      expected_clock_out_at timestamptz,
      expected_rate_cents int
    )
  )
  update public.shifts as s
  set paid_at = v_paid_at,
      paid_minutes = greatest(
        0,
        floor(extract(epoch from (s.clock_out_at - s.clock_in_at)) / 60)::int
      ),
      paid_cents = round(
        greatest(
          0,
          floor(extract(epoch from (s.clock_out_at - s.clock_in_at)) / 60)::int
        )::numeric * fw.hourly_rate_cents::numeric / 60
      )::int
  from items as item
  join public.field_workers as fw
    on fw.hourly_rate_cents is not distinct from item.expected_rate_cents
  where s.id = item.shift_id
    and fw.id = s.field_worker_id
    and s.paid_at is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_item_count then
    raise exception using
      errcode = '40001',
      message = 'pay batch changed during update; no shifts were marked paid';
  end if;

  return v_updated_count;
end
$function$;

-- --------------------------------------------------------------------------
-- 6. Secure attribution and notification token RPCs
-- --------------------------------------------------------------------------

-- A stable app-generated UUID lets a later login or sign-out prove which
-- phone it is reconciling. Existing rows stay nullable during the canary so
-- old installed builds keep working until the final cutover.
alter table public.push_tokens
  add column if not exists device_id uuid;

alter table public.live_activity_tokens
  add column if not exists device_id uuid;

-- Keep the existing one-phone-per-email rules for this security transition.
-- These additional indexes prevent one non-null device ID from being claimed
-- by two identities for the same notification destination.
create unique index if not exists push_tokens_device_uidx
  on public.push_tokens (device_id)
  where device_id is not null;

create unique index if not exists live_activity_tokens_device_p2s_uidx
  on public.live_activity_tokens (device_id, token_type)
  where shift_id is null and device_id is not null;

create unique index if not exists live_activity_tokens_device_update_uidx
  on public.live_activity_tokens (device_id, token_type, shift_id)
  where shift_id is not null and device_id is not null;

create or replace function public.hc_record_shift_orders(
  p_shift_id uuid,
  p_links jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker_id uuid := public.hc_current_worker_id();
  v_email text := public.hc_current_worker_email();
  v_shift public.shifts%rowtype;
  v_shift_day date;
  v_count int := 0;
begin
  if v_worker_id is null or v_email is null then
    raise exception using
      errcode = '42501',
      message = 'active field worker required';
  end if;

  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'p_links must be a JSON array';
  end if;

  if jsonb_array_length(p_links) > 100 then
    raise exception using
      errcode = '22023',
      message = 'no more than 100 shift-order links are allowed';
  end if;

  select *
  into v_shift
  from public.shifts as s
  where s.id = p_shift_id
    and s.field_worker_id = v_worker_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'shift does not belong to the current worker';
  end if;

  if v_shift.clock_out_at is null then
    raise exception using
      errcode = '22023',
      message = 'shift must be closed before order attribution';
  end if;

  if v_shift.clock_out_at < clock_timestamp() - interval '30 days' then
    raise exception using
      errcode = '22023',
      message = 'shift is older than the 30-day attribution window';
  end if;

  if v_shift.market is null then
    raise exception using
      errcode = '22023',
      message = 'shift market is required for order attribution';
  end if;

  v_shift_day := pg_catalog.timezone(
    'America/New_York',
    v_shift.clock_in_at
  )::date;

  -- Reject the entire request if even one submitted ID is not on the exact
  -- server-derived delivery or prep list. Null order markets retain the
  -- dashboard's existing shared-market behavior.
  if exists (
    select 1
    from jsonb_to_recordset(p_links)
      as links(order_id uuid, work_type text)
    left join public.orders as o on o.id = links.order_id
    where o.id is null
       or links.work_type not in ('delivery', 'prep')
       or not (
         o.market is null
         or lower(o.market) = lower(v_shift.market)
       )
       or not coalesce(
         (
           links.work_type = 'delivery'
           and o.stage in ('invoiced', 'deposit_paid', 'paid_full', 'fulfilled', 'complete')
           and pg_catalog.timezone('UTC', o.delivery_at_utc)::date = v_shift_day
         )
         or (
           links.work_type = 'prep'
           and o.stage in ('invoiced', 'deposit_paid', 'paid_full')
           and pg_catalog.timezone('UTC', o.delivery_at_utc)::date = v_shift_day + 1
         ),
         false
       )
  ) then
    raise exception using
      errcode = '22023',
      message = 'one or more orders are not eligible for this shift';
  end if;

  insert into public.shift_orders (
    shift_id,
    order_id,
    work_type,
    coconuts_qty,
    client_name,
    worker_email,
    marked_at
  )
  select
    p_shift_id,
    o.id,
    links.work_type,
    o.coconuts_qty,
    o.client_name,
    v_email,
    clock_timestamp()
  from jsonb_to_recordset(p_links) as links(order_id uuid, work_type text)
  join public.orders as o on o.id = links.order_id
  on conflict (shift_id, order_id, work_type) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

-- These pre-device overloads must not survive a partial re-run. They cannot
-- distinguish an old phone signing out from a newer phone on the same account.
drop function if exists public.hc_register_push_token(text, text);
drop function if exists public.hc_register_live_activity_token(text, uuid, text);
drop function if exists public.hc_unregister_device();

create or replace function public.hc_sync_notification_device(
  p_device_id uuid,
  p_apns_token text,
  p_push_allowed boolean,
  p_live_supported boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_role text;
  v_active boolean;
  v_token text := nullif(lower(trim(p_apns_token)), '');
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  if p_device_id is null then
    raise exception using
      errcode = '22023',
      message = 'device ID is required';
  end if;

  if p_push_allowed is null or p_live_supported is null then
    raise exception using
      errcode = '22023',
      message = 'notification capability state is required';
  end if;

  if v_token is not null
     and (length(v_token) < 32
     or length(v_token) > 512
     or v_token !~ '^[0-9a-f]+$') then
    raise exception using
      errcode = '22023',
      message = 'invalid APNs token';
  end if;

  -- Resolve the roster row even when it is inactive. That lets a deactivated
  -- or downgraded account authenticate once and remove every stale destination.
  select lower(fw.email), fw.role, fw.active
  into v_email, v_role, v_active
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
  limit 1;

  if v_email is null then
    raise exception using
      errcode = '42501',
      message = 'linked field worker identity required';
  end if;

  -- Possession of the stable device ID reclaims both notification channels
  -- from a prior login. Possession of the exact APNs token also repairs a
  -- legacy push row that predates device IDs.
  delete from public.push_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  delete from public.live_activity_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  if v_token is not null then
    delete from public.push_tokens
    where lower(apns_token) = v_token
      and lower(email) <> v_email;
  end if;

  if v_active is not true or v_role not in ('owner', 'manager') then
    -- Eligibility is account-wide. A deactivation or role downgrade removes
    -- every destination for that identity, including rows on another phone.
    delete from public.push_tokens
    where lower(email) = v_email;

    delete from public.live_activity_tokens
    where lower(email) = v_email;
    return;
  end if;

  if p_push_allowed is true and v_token is not null then
    insert into public.push_tokens (
      email,
      apns_token,
      platform,
      updated_at,
      device_id
    ) values (
      v_email,
      v_token,
      'ios',
      clock_timestamp(),
      p_device_id
    )
    on conflict (email) do update
    set apns_token = excluded.apns_token,
        platform = excluded.platform,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id;
  elsif p_push_allowed is not true then
    -- Preserve a newer phone for the same account. A null device ID is the
    -- legacy one-phone row and is safe to remove under the retained model.
    delete from public.push_tokens
    where lower(email) = v_email
      and (device_id = p_device_id or device_id is null);
  end if;

  if p_live_supported is not true then
    delete from public.live_activity_tokens
    where lower(email) = v_email
      and (device_id = p_device_id or device_id is null);
  end if;
end
$function$;

create or replace function public.hc_register_live_activity_token(
  p_token_type text,
  p_shift_id uuid,
  p_token text,
  p_device_id uuid,
  p_supported boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_role text;
  v_active boolean;
  v_type text := lower(trim(p_token_type));
  v_token text := nullif(lower(trim(p_token)), '');
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  if p_device_id is null then
    raise exception using
      errcode = '22023',
      message = 'device ID is required';
  end if;

  if p_supported is null then
    raise exception using
      errcode = '22023',
      message = 'Live Activity support state is required';
  end if;

  if v_token is not null
     and (length(v_token) < 32
     or length(v_token) > 512
     or v_token !~ '^[0-9a-f]+$') then
    raise exception using
      errcode = '22023',
      message = 'invalid Live Activity token';
  end if;

  if v_type not in ('push_to_start', 'activity_update') then
    raise exception using
      errcode = '22023',
      message = 'unsupported Live Activity token type';
  end if;

  if p_supported is true and v_token is null then
    raise exception using
      errcode = '22023',
      message = 'Live Activity token is required when supported';
  end if;

  select lower(fw.email), fw.role, fw.active
  into v_email, v_role, v_active
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
  limit 1;

  if v_email is null then
    raise exception using
      errcode = '42501',
      message = 'linked field worker identity required';
  end if;

  -- Reclaim this phone from a prior login before eligibility/support decides
  -- whether a new destination may be stored. Exact-token cleanup also repairs
  -- a legacy row whose device ID is still null.
  delete from public.live_activity_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  if v_token is not null then
    delete from public.live_activity_tokens
    where lower(token) = v_token
      and lower(email) <> v_email;
  end if;

  if v_active is not true or v_role not in ('owner', 'manager') then
    delete from public.push_tokens
    where lower(email) = v_email;

    delete from public.live_activity_tokens
    where lower(email) = v_email;
    return;
  end if;

  if p_supported is not true then
    delete from public.live_activity_tokens
    where lower(email) = v_email
      and (device_id = p_device_id or device_id is null);
    return;
  end if;

  if v_type = 'push_to_start' then
    if p_shift_id is not null then
      raise exception using
        errcode = '22023',
        message = 'push_to_start token must not have a shift ID';
    end if;

    insert into public.live_activity_tokens (
      email,
      token_type,
      shift_id,
      token,
      updated_at,
      device_id
    ) values (
      v_email,
      'push_to_start',
      null,
      v_token,
      clock_timestamp(),
      p_device_id
    )
    on conflict (email, token_type) where shift_id is null do update
    set token = excluded.token,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id;

  elsif v_type = 'activity_update' then
    if p_shift_id is null
       or not exists (select 1 from public.shifts where id = p_shift_id) then
      raise exception using
        errcode = '22023',
        message = 'activity_update token requires a valid shift ID';
    end if;

    insert into public.live_activity_tokens (
      email,
      token_type,
      shift_id,
      token,
      updated_at,
      device_id
    ) values (
      v_email,
      'activity_update',
      p_shift_id,
      v_token,
      clock_timestamp(),
      p_device_id
    )
    on conflict (email, token_type, shift_id) where shift_id is not null do update
    set token = excluded.token,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id;

  end if;
end
$function$;

-- Sign-out cleanup works even after deactivation and is scoped to the phone
-- that signed out. Null-device rows are legacy one-phone records and are also
-- removed for the current identity during the transition.
create or replace function public.hc_unregister_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
begin
  if p_device_id is null then
    raise exception using
      errcode = '22023',
      message = 'device ID is required';
  end if;

  select lower(fw.email)
  into v_email
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
  limit 1;

  if v_email is null then
    return;
  end if;

  delete from public.push_tokens
  where lower(email) = v_email
    and (device_id = p_device_id or device_id is null);

  delete from public.live_activity_tokens
  where lower(email) = v_email
    and (device_id = p_device_id or device_id is null);
end
$function$;

-- --------------------------------------------------------------------------
-- 7. Lock down RPC execution and grant authenticated entry points
-- --------------------------------------------------------------------------

revoke all on function public.hc_start_shift(double precision, double precision, text)
  from public, anon;
revoke all on function public.hc_list_managed_shifts(timestamptz, integer)
  from public, anon;
revoke all on function public.hc_clock_out_my_shift(uuid, timestamptz, double precision, double precision)
  from public, anon;
revoke all on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  from public, anon;
revoke all on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  from public, anon;
revoke all on function public.hc_mark_shifts_paid(jsonb)
  from public, anon;
revoke all on function public.hc_record_shift_orders(uuid, jsonb)
  from public, anon;
revoke all on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.hc_unregister_device(uuid)
  from public, anon, authenticated;

grant execute on function public.hc_start_shift(double precision, double precision, text)
  to authenticated, service_role;
grant execute on function public.hc_list_managed_shifts(timestamptz, integer)
  to authenticated, service_role;
grant execute on function public.hc_clock_out_my_shift(uuid, timestamptz, double precision, double precision)
  to authenticated, service_role;
grant execute on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  to authenticated, service_role;
grant execute on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  to authenticated, service_role;
grant execute on function public.hc_mark_shifts_paid(jsonb)
  to authenticated, service_role;
grant execute on function public.hc_record_shift_orders(uuid, jsonb)
  to authenticated, service_role;
grant execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  to authenticated, service_role;
grant execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  to authenticated, service_role;
grant execute on function public.hc_unregister_device(uuid)
  to authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. Deferred cutover checklist
-- --------------------------------------------------------------------------
-- A separate migration must be run only after the authenticated build is on
-- every active phone. That migration must, in one transaction:
--
-- 1. Drop the old anon policies from field_workers, shifts,
--    shift_locations, shift_edits, push_tokens, live_activity_tokens, and
--    app_config.
-- 2. Revoke anon table privileges on those tables.
-- 3. Preserve the authenticated RPC grants, bounded GPS INSERT, and the
--    authenticated SELECT grants protected by the policies above.
-- 4. Audit any unmatched historical shifts whose field_worker_id stayed null.
--    They remain owner-visible but are intentionally not claimable by email.
-- 5. Add a controlled owner-only roster email-change RPC so Auth and
--    notification identity stay aligned.
-- 6. The stable device ID now scopes sign-out and reclaims stale push and Live
--    Activity rows after an account switch. Migration 016 must remove legacy
--    null-device rows before the final authenticated-only cutover. Supporting
--    multiple phones for one email remains a separate future schema change.
-- 7. Leave orders and delivery_signatures unchanged until the public-hosted
--    dashboard has moved its database access behind an authenticated Worker.

commit;
