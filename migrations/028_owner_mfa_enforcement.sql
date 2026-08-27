-- ============================================================================
-- 028_owner_mfa_enforcement.sql
-- Mandatory TOTP MFA for every owner session.
--
-- LOCAL DRAFT. Running this against Supabase is a production write and needs
-- Sidd's explicit "yes do it" confirmation at rollout time.
--
-- The aal claim is inside Supabase's signed access token. Client metadata,
-- request bodies, email text, and browser storage can never satisfy this gate.
-- Managers and team members keep their existing aal1 access and market scope.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.hc_claim_field_worker()',
    'public.hc_claim_field_worker_v2()',
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_list_managed_open_shift_ids()',
    'public.hc_list_orders_for_current_user(timestamp with time zone,timestamp with time zone,text[],integer,integer)',
    'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)',
    'public.hc_authorize_notification_device(uuid)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('028 requires missing function %s', v_signature);
    end if;
  end loop;

  if pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.orders') is null then
    raise exception using
      errcode = '55000',
      message = '028 requires authenticated field, management, and dashboard tables';
  end if;

  if exists (
    select 1
    from public.field_workers as worker
    where worker.active is true
      and pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
      and worker.auth_user_id is null
  ) then
    raise exception using
      errcode = '55000',
      message = '028 blocked: every active owner must be linked to Supabase Auth';
  end if;

  if not exists (
    select 1
    from public.field_workers as worker
    join auth.users as auth_user on auth_user.id = worker.auth_user_id
    where worker.active is true
      and pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
      and auth_user.email_confirmed_at is not null
      and pg_catalog.lower(auth_user.email) = pg_catalog.lower(worker.email)
  ) then
    raise exception using
      errcode = '55000',
      message = '028 blocked: no confirmed active owner Auth identity is linked';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_list_orders_for_current_user_pre_mfa_028(timestamp with time zone,timestamp with time zone,text[],integer,integer)'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '028 blocked: an earlier partial owner MFA wrapper exists';
  end if;
end
$preflight$;

lock table public.field_workers in share row exclusive mode;
lock table public.shifts in share row exclusive mode;
lock table public.orders in share row exclusive mode;

-- Only Supabase's signed aal2 claim can satisfy the owner step-up. A direct
-- service-role maintenance call remains outside user MFA, as it already has
-- unrestricted backend authority.
create or replace function public.hc_owner_session_is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select auth.role() = 'service_role'
    or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$function$;

create or replace function public.hc_session_allows_roster_role(p_role text)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case pg_catalog.lower(pg_catalog.btrim(coalesce(p_role, '')))
    when 'owner' then public.hc_owner_session_is_aal2()
    when 'manager' then true
    when 'team' then true
    else false
  end
$function$;

-- This is the sole AAL1-safe identity route. It links the confirmed Auth email
-- once, then returns only immutable Auth ID, normalized role, and MFA routing.
-- It never exposes email, name, market, pay, orders, shifts, or configuration.
create or replace function public.hc_get_auth_bootstrap()
returns table (
  auth_user_id uuid,
  role text,
  mfa_required boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null or auth.role() not in ('authenticated', 'service_role') then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  select pg_catalog.lower(auth_user.email)
  into v_email
  from auth.users as auth_user
  where auth_user.id = v_uid
    and auth_user.email is not null
    and auth_user.email_confirmed_at is not null;

  if v_email is null then
    raise exception using
      errcode = '42501',
      message = 'confirmed Supabase email required';
  end if;

  update public.field_workers as worker
  set auth_user_id = v_uid
  where worker.auth_user_id is null
    and worker.active is true
    and pg_catalog.lower(worker.email) = v_email;

  return query
  select
    v_uid,
    pg_catalog.lower(pg_catalog.btrim(worker.role)),
    pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
  from public.field_workers as worker
  where worker.auth_user_id = v_uid
    and worker.active is true
    and pg_catalog.lower(pg_catalog.btrim(worker.role)) in ('owner', 'manager', 'team')
  limit 1;
end
$function$;

-- Full profile claims are not bootstrap routes. An owner receives no full
-- profile until the signed session is aal2. The Worker AI owner check calls
-- this existing function, so it becomes MFA-enforced without trusting the UI.
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
  v_bootstrap record;
begin
  select * into v_bootstrap from public.hc_get_auth_bootstrap();
  if not found then return; end if;

  if not public.hc_session_allows_roster_role(v_bootstrap.role) then
    raise exception using
      errcode = '42501',
      message = 'owner MFA required';
  end if;

  return query
  select
    pg_catalog.lower(worker.email),
    worker.name,
    worker.market,
    pg_catalog.lower(pg_catalog.btrim(worker.role))
  from public.field_workers as worker
  where worker.auth_user_id = v_bootstrap.auth_user_id
    and worker.active is true
  limit 1;
end
$function$;

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
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  return query
  select v_uid, claimed.email, claimed.name, claimed.market, claimed.role
  from public.hc_claim_field_worker() as claimed;
end
$function$;

-- Identity helpers are used by RLS and many older RPCs. Returning null or false
-- for an owner at aal1 closes those paths centrally while preserving all AAL1
-- team and manager behavior.
create or replace function public.hc_current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select worker.id
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
    and public.hc_session_allows_roster_role(worker.role)
  limit 1
$function$;

create or replace function public.hc_current_worker_email()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.lower(worker.email)
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
    and public.hc_session_allows_roster_role(worker.role)
  limit 1
$function$;

create or replace function public.hc_current_worker_role()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.lower(pg_catalog.btrim(worker.role))
  from public.field_workers as worker
  where worker.auth_user_id = auth.uid()
    and worker.active is true
    and public.hc_session_allows_roster_role(worker.role)
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
    from public.field_workers as worker
    where worker.auth_user_id = auth.uid()
      and worker.active is true
      and public.hc_session_allows_roster_role(worker.role)
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
  select exists (
    select 1
    from public.field_workers as worker
    where worker.auth_user_id = auth.uid()
      and worker.active is true
      and pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
      and public.hc_owner_session_is_aal2()
  )
$function$;

create or replace function public.hc_current_roster_session_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.role() = 'service_role' or exists (
    select 1
    from public.field_workers as worker
    where worker.auth_user_id = auth.uid()
      and worker.active is true
      and public.hc_session_allows_roster_role(worker.role)
  )
$function$;

-- The central management helper now evaluates the signed owner AAL. All
-- manager market normalization and exact-match behavior stays unchanged.
create or replace function public.hc_management_can_access_shift_market(
  p_role text,
  p_roster_market text,
  p_shift_market text
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case pg_catalog.lower(pg_catalog.btrim(coalesce(p_role, '')))
    when 'owner' then public.hc_owner_session_is_aal2()
    when 'manager' then
      nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_roster_market, ''))), '') is not null
      and nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_shift_market, ''))), '') is not null
      and pg_catalog.lower(pg_catalog.btrim(p_roster_market)) =
          pg_catalog.lower(pg_catalog.btrim(p_shift_market))
    else false
  end
$function$;

create or replace function public.hc_can_access_order_market(p_market text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.field_workers as worker
    where worker.auth_user_id = auth.uid()
      and worker.active is true
      and public.hc_session_allows_roster_role(worker.role)
      and (
        pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
        or (
          pg_catalog.lower(pg_catalog.btrim(worker.role)) in ('manager', 'team')
          and nullif(pg_catalog.lower(pg_catalog.btrim(p_market)), '') is not null
          and pg_catalog.lower(pg_catalog.btrim(worker.market)) =
              pg_catalog.lower(pg_catalog.btrim(p_market))
        )
      )
  )
$function$;

-- Direct owner branches in these base policies must use the same signed AAL
-- gate. The owner AAL1 path can reach only hc_get_auth_bootstrap().
drop policy if exists field_workers_authenticated_select on public.field_workers;
create policy field_workers_authenticated_select
on public.field_workers
for select to authenticated
using (
  (
    auth_user_id = auth.uid()
    and active is true
    and public.hc_session_allows_roster_role(role)
  )
  or public.hc_is_owner()
);

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
      and public.hc_session_allows_roster_role(worker.role)
      and (
        pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
        or (
          pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'team'
          and shifts.field_worker_id = worker.id
        )
        or (
          pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'manager'
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

-- Rename the proven implementations and place one small mandatory gate in
-- front of each. The renamed implementations are executable only through
-- these SECURITY DEFINER wrappers, so direct PostgREST calls cannot bypass MFA.
alter function public.hc_start_shift(double precision, double precision, text)
  rename to hc_start_shift_pre_mfa_028;
alter function public.hc_list_managed_shifts(timestamptz, integer)
  rename to hc_list_managed_shifts_pre_mfa_028;
alter function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  rename to hc_manage_clock_out_pre_mfa_028;
alter function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  rename to hc_edit_shift_times_pre_mfa_028;
alter function public.hc_list_managed_open_shift_ids()
  rename to hc_list_managed_open_shift_ids_pre_mfa_028;
alter function public.hc_list_orders_for_current_user(timestamptz, timestamptz, text[], integer, integer)
  rename to hc_list_orders_for_current_user_pre_mfa_028;
alter function public.hc_confirm_order_delivery_v2(uuid, uuid, timestamptz, text, text, text)
  rename to hc_confirm_order_delivery_v2_pre_mfa_028;
alter function public.hc_authorize_notification_device(uuid)
  rename to hc_authorize_notification_device_pre_mfa_028;
alter function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  rename to hc_sync_notification_device_pre_mfa_028;
alter function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  rename to hc_register_live_activity_token_pre_mfa_028;

create function public.hc_start_shift(
  p_clock_in_lat double precision default null,
  p_clock_in_lng double precision default null,
  p_device text default null
)
returns setof public.shifts
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active field access required';
  end if;
  return query select * from public.hc_start_shift_pre_mfa_028(
    p_clock_in_lat, p_clock_in_lng, p_device
  );
end
$function$;

create function public.hc_list_managed_shifts(
  p_since timestamptz,
  p_limit integer default 60
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
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  return query select *
  from public.hc_list_managed_shifts_pre_mfa_028(p_since, p_limit);
end
$function$;

create function public.hc_manage_clock_out(
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
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  return query select * from public.hc_manage_clock_out_pre_mfa_028(
    p_shift_id, p_clock_out_at, p_clock_out_lat, p_clock_out_lng
  );
end
$function$;

create function public.hc_edit_shift_times(
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
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  return query select * from public.hc_edit_shift_times_pre_mfa_028(
    p_shift_id,
    p_expected_clock_in,
    p_expected_clock_out,
    p_new_clock_in,
    p_new_clock_out,
    p_note
  );
end
$function$;

create function public.hc_list_managed_open_shift_ids()
returns table (shift_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  return query select * from public.hc_list_managed_open_shift_ids_pre_mfa_028();
end
$function$;

create function public.hc_list_orders_for_current_user(
  p_delivery_from timestamptz default null,
  p_delivery_before timestamptz default null,
  p_stages text[] default null,
  p_offset integer default 0,
  p_limit integer default 500
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active field access required';
  end if;
  return query select * from public.hc_list_orders_for_current_user_pre_mfa_028(
    p_delivery_from, p_delivery_before, p_stages, p_offset, p_limit
  );
end
$function$;

create function public.hc_confirm_order_delivery_v2(
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
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active field access required';
  end if;
  return public.hc_confirm_order_delivery_v2_pre_mfa_028(
    p_delivery_request_id,
    p_order_id,
    p_signed_at,
    p_signed_by,
    p_signature_data_url,
    p_signed_via
  );
end
$function$;

create function public.hc_authorize_notification_device(p_device_id uuid)
returns table (
  device_id uuid,
  revoke_secret text,
  secret_version integer,
  authorized_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  return query select *
  from public.hc_authorize_notification_device_pre_mfa_028(p_device_id);
end
$function$;

create function public.hc_sync_notification_device(
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
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  perform public.hc_sync_notification_device_pre_mfa_028(
    p_device_id, p_apns_token, p_push_allowed, p_live_supported
  );
end
$function$;

create function public.hc_register_live_activity_token(
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
begin
  if not public.hc_current_roster_session_allowed() then
    raise exception using errcode = '42501', message = 'owner MFA or active management access required';
  end if;
  perform public.hc_register_live_activity_token_pre_mfa_028(
    p_token_type, p_shift_id, p_token, p_device_id, p_supported
  );
end
$function$;

-- Every function is executable by PUBLIC when first created unless revoked.
-- Remove all defaults, hide renamed implementations, then grant only the
-- exact client roles used before this migration.
revoke all on function public.hc_owner_session_is_aal2()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_session_allows_roster_role(text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_current_roster_session_allowed()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_get_auth_bootstrap()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_claim_field_worker()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_claim_field_worker_v2()
  from public, anon, authenticated, service_role;

grant execute on function public.hc_owner_session_is_aal2()
  to authenticated, service_role;
grant execute on function public.hc_session_allows_roster_role(text)
  to authenticated, service_role;
grant execute on function public.hc_current_roster_session_allowed()
  to authenticated, service_role;
grant execute on function public.hc_get_auth_bootstrap()
  to authenticated;
grant execute on function public.hc_claim_field_worker()
  to authenticated, service_role;
grant execute on function public.hc_claim_field_worker_v2()
  to authenticated, service_role;

revoke all on function public.hc_current_worker_id() from public, anon;
revoke all on function public.hc_current_worker_email() from public, anon;
revoke all on function public.hc_current_worker_role() from public, anon;
revoke all on function public.hc_is_active_worker() from public, anon;
revoke all on function public.hc_can_manage_shifts() from public, anon;
revoke all on function public.hc_is_owner() from public, anon;
revoke all on function public.hc_management_can_access_shift_market(text, text, text)
  from public, anon;
revoke all on function public.hc_can_access_order_market(text) from public, anon;

grant execute on function public.hc_current_worker_id() to authenticated, service_role;
grant execute on function public.hc_current_worker_email() to authenticated, service_role;
grant execute on function public.hc_current_worker_role() to authenticated, service_role;
grant execute on function public.hc_is_active_worker() to authenticated, service_role;
grant execute on function public.hc_can_manage_shifts() to authenticated, service_role;
grant execute on function public.hc_is_owner() to authenticated, service_role;
grant execute on function public.hc_management_can_access_shift_market(text, text, text)
  to authenticated, service_role;
grant execute on function public.hc_can_access_order_market(text)
  to authenticated, service_role;

revoke all on function public.hc_start_shift_pre_mfa_028(double precision, double precision, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_list_managed_shifts_pre_mfa_028(timestamptz, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_manage_clock_out_pre_mfa_028(uuid, timestamptz, double precision, double precision)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_edit_shift_times_pre_mfa_028(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_list_managed_open_shift_ids_pre_mfa_028()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_list_orders_for_current_user_pre_mfa_028(timestamptz, timestamptz, text[], integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_confirm_order_delivery_v2_pre_mfa_028(uuid, uuid, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_authorize_notification_device_pre_mfa_028(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_sync_notification_device_pre_mfa_028(uuid, text, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_register_live_activity_token_pre_mfa_028(text, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function public.hc_start_shift(double precision, double precision, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_list_managed_shifts(timestamptz, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_list_managed_open_shift_ids()
  from public, anon, authenticated, service_role;
revoke all on function public.hc_list_orders_for_current_user(timestamptz, timestamptz, text[], integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_confirm_order_delivery_v2(uuid, uuid, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_authorize_notification_device(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.hc_start_shift(double precision, double precision, text)
  to authenticated, service_role;
grant execute on function public.hc_list_managed_shifts(timestamptz, integer)
  to authenticated, service_role;
grant execute on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision)
  to authenticated, service_role;
grant execute on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text)
  to authenticated, service_role;
grant execute on function public.hc_list_managed_open_shift_ids()
  to authenticated, service_role;
grant execute on function public.hc_list_orders_for_current_user(timestamptz, timestamptz, text[], integer, integer)
  to authenticated;
grant execute on function public.hc_confirm_order_delivery_v2(uuid, uuid, timestamptz, text, text, text)
  to authenticated, service_role;
grant execute on function public.hc_authorize_notification_device(uuid)
  to authenticated;
grant execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  to authenticated, service_role;
grant execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  to authenticated, service_role;

do $postflight$
declare
  v_signature text;
  v_internal text;
begin
  foreach v_signature in array array[
    'public.hc_get_auth_bootstrap()',
    'public.hc_claim_field_worker()',
    'public.hc_claim_field_worker_v2()',
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_list_managed_open_shift_ids()',
    'public.hc_list_orders_for_current_user(timestamp with time zone,timestamp with time zone,text[],integer,integer)',
    'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)',
    'public.hc_authorize_notification_device(uuid)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('028 assertion failed: unsafe client grant on %s', v_signature);
    end if;
  end loop;

  foreach v_internal in array array[
    'public.hc_start_shift_pre_mfa_028(double precision,double precision,text)',
    'public.hc_list_managed_shifts_pre_mfa_028(timestamp with time zone,integer)',
    'public.hc_manage_clock_out_pre_mfa_028(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times_pre_mfa_028(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_list_managed_open_shift_ids_pre_mfa_028()',
    'public.hc_list_orders_for_current_user_pre_mfa_028(timestamp with time zone,timestamp with time zone,text[],integer,integer)',
    'public.hc_confirm_order_delivery_v2_pre_mfa_028(uuid,uuid,timestamp with time zone,text,text,text)',
    'public.hc_authorize_notification_device_pre_mfa_028(uuid)',
    'public.hc_sync_notification_device_pre_mfa_028(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token_pre_mfa_028(text,uuid,text,uuid,boolean)'
  ] loop
    if pg_catalog.to_regprocedure(v_internal) is null
       or pg_catalog.has_function_privilege('authenticated', v_internal, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_internal, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('028 assertion failed: internal MFA bypass on %s', v_internal);
    end if;
  end loop;

  if pg_catalog.pg_get_functiondef(
       'public.hc_owner_session_is_aal2()'::regprocedure
     ) !~ 'auth[.]jwt[(][)] ->> ''aal'''
     or pg_catalog.lower(pg_catalog.pg_get_function_result(
       'public.hc_get_auth_bootstrap()'::regprocedure
     )) <> 'table(auth_user_id uuid, role text, mfa_required boolean)'
     or pg_catalog.pg_get_functiondef(
       'public.hc_get_auth_bootstrap()'::regprocedure
     ) ~* 'worker[.]name|worker[.]market|hourly_rate|paid_|public[.]orders|public[.]shifts'
     or pg_catalog.pg_get_functiondef(
       'public.hc_claim_field_worker()'::regprocedure
     ) !~ 'hc_session_allows_roster_role' then
    raise exception using
      errcode = '55000',
      message = '028 assertion failed: signed AAL or minimal bootstrap contract drifted';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'field_workers'
      and policy_info.policyname = 'field_workers_authenticated_select'
      and policy_info.qual like '%hc_session_allows_roster_role%'
  ) or not exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename = 'shifts'
      and policy_info.policyname = 'shifts_authenticated_select'
      and policy_info.qual like '%hc_session_allows_roster_role%'
  ) then
    raise exception using
      errcode = '55000',
      message = '028 assertion failed: direct owner RLS gates are missing';
  end if;
end
$postflight$;

commit;
