-- ============================================================================
-- 016_field_auth_cutover.sql
-- Final authenticated cutover for the HC Field app.
--
-- LOCAL MIGRATION FILE ONLY. DO NOT RUN THIS FILE YET.
-- Running it against Supabase is a production write and needs Sidd's explicit
-- "yes do it" confirmation.
--
-- RELEASE GATE
-- Run only after migration 015 is live, the authenticated build has passed its
-- canary, and EVERY active field phone has upgraded. The database cannot prove
-- that a powered-off phone was upgraded. That operational check is mandatory.
-- An old anonymous build stops reading, starting, tracking, and closing shifts
-- as soon as this transaction commits.
--
-- SCOPE
-- 1. Fail closed if Auth links, open shifts, indexes, RPCs, or notification
--    identities are not safe for cutover.
-- 2. Remove every public, anon, and drifted authenticated policy on the eight
--    field tables, then recreate only the authenticated policies from 015.
-- 3. Remove public/anon field privileges and authenticated direct writes.
-- 4. Preserve bounded authenticated GPS inserts, required reads/RPCs, and
--    explicit service_role compatibility.
-- 5. Remove the legacy email-to-worker transition trigger. New shifts already
--    carry field_worker_id through hc_start_shift.
--
-- OUT OF SCOPE
-- public.orders and public.delivery_signatures are intentionally untouched.
-- The public-hosted dashboard still depends on their current access model.
-- ============================================================================

begin;

-- Abort instead of waiting indefinitely behind a phone or bot transaction.
set local lock_timeout = '15s';
set local statement_timeout = '2min';

-- --------------------------------------------------------------------------
-- 1. Structural preflight, migration 015 must be complete and undrifted
-- --------------------------------------------------------------------------

do $preflight$
declare
  v_table text;
  v_signature text;
  v_function_oid oid;
  v_arg_names text[];
  v_arg_types oid[];
  v_is_paid_position int;
begin
  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table)) is null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('cutover blocked: public.%I is missing', v_table);
    end if;
  end loop;

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
      message = 'cutover blocked: field_workers.auth_user_id from 015 is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shifts'
      and column_name = 'field_worker_id'
      and data_type = 'uuid'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: shifts.field_worker_id from 015 is missing';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'push_tokens'
      and column_name = 'device_id'
      and data_type = 'uuid'
      and is_nullable = 'YES'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: push_tokens.device_id from 015 is missing or incompatible';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'live_activity_tokens'
      and column_name = 'device_id'
      and data_type = 'uuid'
      and is_nullable = 'YES'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: live_activity_tokens.device_id from 015 is missing or incompatible';
  end if;

  foreach v_signature in array array[
    'public.hc_claim_field_worker()',
    'public.hc_current_worker_id()',
    'public.hc_current_worker_email()',
    'public.hc_current_worker_role()',
    'public.hc_is_active_worker()',
    'public.hc_can_manage_shifts()',
    'public.hc_is_owner()',
    'public.hc_can_access_shift(uuid)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_clock_out_my_shift(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_mark_shifts_paid(jsonb)',
    'public.hc_record_shift_orders(uuid,jsonb)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
    'public.hc_unregister_device(uuid)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('cutover blocked: required RPC %s is missing', v_signature);
    end if;
  end loop;

  -- The old overloads cannot prove which physical phone is acting. A stale
  -- callable copy would bypass the device-scoped reconciliation model.
  foreach v_signature in array array[
    'public.hc_register_push_token(text,text)',
    'public.hc_register_live_activity_token(text,uuid,text)',
    'public.hc_unregister_device()'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is not null then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('cutover blocked: obsolete RPC %s still exists', v_signature);
    end if;
  end loop;

  v_function_oid := pg_catalog.to_regprocedure(
    'public.hc_mark_shifts_paid(jsonb)'
  );
  if not exists (
    select 1
    from pg_catalog.pg_proc as p
    where p.oid = v_function_oid
      and p.prorettype = pg_catalog.to_regtype('integer')::oid
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: hc_mark_shifts_paid must return integer';
  end if;

  -- Managers need only a boolean edit latch. Any payroll field in this RPC is
  -- a privacy regression and blocks the cutover.
  v_function_oid := pg_catalog.to_regprocedure(
    'public.hc_list_managed_shifts(timestamp with time zone,integer)'
  );

  select p.proargnames, p.proallargtypes
  into v_arg_names, v_arg_types
  from pg_catalog.pg_proc as p
  where p.oid = v_function_oid;

  v_is_paid_position := pg_catalog.array_position(v_arg_names, 'is_paid');
  if v_is_paid_position is null
     or v_arg_types[v_is_paid_position] <> pg_catalog.to_regtype('boolean')::oid then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: hc_list_managed_shifts must return is_paid boolean';
  end if;

  if v_arg_names && array[
    'paid_at',
    'paid_cents',
    'paid_minutes',
    'hourly_rate_cents'
  ]::text[] then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: managed-shift RPC exposes payroll fields';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.field_workers'::pg_catalog.regclass
      and c.conname = 'field_workers_auth_user_id_fkey'
      and c.contype = 'f'
      and c.convalidated is true
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: validated field worker Auth foreign key is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.shifts'::pg_catalog.regclass
      and c.conname = 'shifts_field_worker_id_fkey'
      and c.contype = 'f'
      and c.convalidated is true
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: validated shift worker foreign key is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.field_workers_email_lower_uidx')
      and i.indrelid = 'public.field_workers'::pg_catalog.regclass
      and i.indisunique is true
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'lower(email)'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: case-insensitive worker email index is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.field_workers_auth_user_uidx')
      and i.indrelid = 'public.field_workers'::pg_catalog.regclass
      and i.indisunique is true
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'auth_user_id'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%auth_user_id is not null%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: unique worker Auth link index is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.shifts_one_open_worker_email_uidx')
      and i.indrelid = 'public.shifts'::pg_catalog.regclass
      and i.indisunique is true
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'lower(worker_email)'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%clock_out_at is null%'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%worker_email is not null%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: open-shift email index is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.shifts_one_open_worker_uidx')
      and i.indrelid = 'public.shifts'::pg_catalog.regclass
      and i.indisunique is true
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'field_worker_id'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%clock_out_at is null%'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%field_worker_id is not null%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: open-shift worker ID index is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.push_tokens_device_uidx')
      and i.indrelid = 'public.push_tokens'::pg_catalog.regclass
      and i.indisunique is true
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'device_id'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%device_id is not null%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: unique push device index is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.live_activity_tokens_device_p2s_uidx')
      and i.indrelid = 'public.live_activity_tokens'::pg_catalog.regclass
      and i.indisunique is true
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'device_id'
      and pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) = 'token_type'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%shift_id is null%'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%device_id is not null%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: unique push-to-start device index is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as i
    where i.indexrelid = pg_catalog.to_regclass('public.live_activity_tokens_device_update_uidx')
      and i.indrelid = 'public.live_activity_tokens'::pg_catalog.regclass
      and i.indisunique is true
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'device_id'
      and pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) = 'token_type'
      and pg_catalog.pg_get_indexdef(i.indexrelid, 3, true) = 'shift_id'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%shift_id is not null%'
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) ilike '%device_id is not null%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: unique activity-update device index is missing';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and c.relrowsecurity is false
  ) then
    raise exception using
      errcode = '55000',
      message = 'cutover blocked: row level security is disabled on a field table';
  end if;
end
$preflight$;

-- Block concurrent field writes between the data checks and privilege cutover.
-- Reads remain available while the transaction is preparing the final state.
lock table
  public.app_config,
  public.field_workers,
  public.live_activity_tokens,
  public.push_tokens,
  public.shift_edits,
  public.shift_locations,
  public.shift_orders,
  public.shifts
in share row exclusive mode;

-- Legacy rows cannot be attributed to a physical phone. Rows for a missing,
-- inactive, unlinked, or non-notification roster identity are categorically
-- ineligible. Remove only those known-stale destinations after the locks are
-- held. Malformed tokens, invalid shifts, and ambiguous duplicates still fail
-- the strict data checks below instead of being silently discarded.
delete from public.push_tokens as pt
where pt.device_id is null
   or not exists (
     select 1
     from public.field_workers as fw
     where lower(fw.email) = lower(pt.email)
       and fw.active is true
       and fw.auth_user_id is not null
       and fw.role in ('owner', 'manager')
   );

delete from public.live_activity_tokens as lat
where lat.device_id is null
   or not exists (
     select 1
     from public.field_workers as fw
     where lower(fw.email) = lower(lat.email)
       and fw.active is true
       and fw.auth_user_id is not null
       and fw.role in ('owner', 'manager')
   );

-- --------------------------------------------------------------------------
-- 2. Data preflight, fail closed instead of transferring or orphaning access
-- --------------------------------------------------------------------------

do $preflight$
begin
  if exists (
    select 1
    from public.field_workers
    group by lower(email)
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cutover blocked: duplicate case-insensitive field worker emails';
  end if;

  if exists (
    select 1
    from public.field_workers
    where auth_user_id is not null
    group by auth_user_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cutover blocked: one Auth user is linked to multiple workers';
  end if;

  if exists (
    select 1
    from public.field_workers as fw
    where fw.active is true
      and fw.auth_user_id is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'cutover blocked: every active field worker must claim Supabase Auth';
  end if;

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
      message = 'cutover blocked: a worker Auth link is missing, unconfirmed, or email-mismatched';
  end if;

  if exists (
    select 1
    from public.shifts as s
    left join public.field_workers as fw on fw.id = s.field_worker_id
    where s.clock_out_at is null
      and (
        s.field_worker_id is null
        or s.worker_email is null
        or fw.id is null
        or fw.active is not true
        or fw.auth_user_id is null
        or lower(s.worker_email) <> lower(fw.email)
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'cutover blocked: every open shift must identify one active authenticated worker';
  end if;

  if exists (
    select 1
    from public.shifts
    where clock_out_at is null
    group by field_worker_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cutover blocked: duplicate open shifts for one worker ID';
  end if;

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
      message = 'cutover blocked: duplicate open shifts for one worker email';
  end if;

  -- APNs rows must point only to active notification roles. A team login in
  -- the canary build should already have reclaimed a shared phone's token.
  if exists (
    select 1
    from public.push_tokens as pt
    left join public.field_workers as fw
      on lower(fw.email) = lower(pt.email)
    where fw.id is null
       or fw.active is not true
       or fw.auth_user_id is null
       or fw.role not in ('owner', 'manager')
       or pt.device_id is null
       or lower(pt.platform) <> 'ios'
       or length(pt.apns_token) < 32
       or length(pt.apns_token) > 512
       or lower(pt.apns_token) !~ '^[0-9a-f]+$'
  ) then
    raise exception using
      errcode = '23514',
      message = 'cutover blocked: push token has an unsafe owner, role, platform, or format';
  end if;

  if exists (
    select 1
    from public.push_tokens
    group by lower(apns_token)
    having count(distinct lower(email)) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cutover blocked: one APNs token belongs to multiple emails';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens as lat
    left join public.field_workers as fw
      on lower(fw.email) = lower(lat.email)
    left join public.shifts as s on s.id = lat.shift_id
    where fw.id is null
       or fw.active is not true
       or fw.auth_user_id is null
       or fw.role not in ('owner', 'manager')
       or lat.device_id is null
       or length(lat.token) < 32
       or length(lat.token) > 512
       or lower(lat.token) !~ '^[0-9a-f]+$'
       or (lat.token_type = 'push_to_start' and lat.shift_id is not null)
       or (
         lat.token_type = 'activity_update'
         and (lat.shift_id is null or s.id is null)
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'cutover blocked: Live Activity token has an unsafe owner, role, format, or shift';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens
    group by lower(token)
    having count(distinct lower(email)) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cutover blocked: one Live Activity token belongs to multiple emails';
  end if;

  -- A stable phone identity must resolve to the same roster email across push
  -- and Live Activity rows, even when the row types or shift IDs differ.
  if exists (
    select 1
    from (
      select pt.device_id, lower(pt.email) as email
      from public.push_tokens as pt
      union all
      select lat.device_id, lower(lat.email) as email
      from public.live_activity_tokens as lat
    ) as destinations
    group by destinations.device_id
    having count(distinct destinations.email) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'cutover blocked: one device ID belongs to multiple notification identities';
  end if;
end
$preflight$;

-- --------------------------------------------------------------------------
-- 3. Replace all phone-facing policies with the authenticated final state
-- --------------------------------------------------------------------------

-- Remove known and drifted policies that apply to PUBLIC, anon, or
-- authenticated. The replacement policies below are the complete allowlist.
do $policies$
declare
  v_policy record;
begin
  for v_policy in
    select p.tablename, p.policyname
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and (
        'public'::name = any(p.roles)
        or 'anon'::name = any(p.roles)
        or 'authenticated'::name = any(p.roles)
      )
  loop
    execute pg_catalog.format(
      'drop policy %I on public.%I',
      v_policy.policyname,
      v_policy.tablename
    );
  end loop;
end
$policies$;

create policy field_workers_authenticated_select
on public.field_workers
for select to authenticated
using (
  (auth_user_id = auth.uid() and active is true)
  or public.hc_is_owner()
);

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

-- Managers intentionally receive team routes and order attribution through
-- child tables. They receive other workers' shift rows only through
-- hc_list_managed_shifts, whose is_paid latch contains no payroll details.
create policy shift_locations_authenticated_select
on public.shift_locations
for select to authenticated
using (
  public.hc_is_active_worker()
  and public.hc_can_access_shift(shift_locations.shift_id)
);

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

create policy shift_edits_authenticated_select
on public.shift_edits
for select to authenticated
using (public.hc_can_manage_shifts());

create policy shift_orders_authenticated_select
on public.shift_orders
for select to authenticated
using (
  public.hc_is_active_worker()
  and public.hc_can_access_shift(shift_orders.shift_id)
);

create policy app_config_authenticated_owner_select
on public.app_config
for select to authenticated
using (public.hc_is_owner());

-- No direct authenticated policies exist for push_tokens or
-- live_activity_tokens. Their RPCs own every client write.

-- --------------------------------------------------------------------------
-- 4. Reset table and column privileges to a narrow authenticated allowlist
-- --------------------------------------------------------------------------

revoke all privileges on table
  public.app_config,
  public.field_workers,
  public.live_activity_tokens,
  public.push_tokens,
  public.shift_edits,
  public.shift_locations,
  public.shift_orders,
  public.shifts
from public, anon, authenticated;

-- Table-level revokes do not remove a prior column-level grant. Clear every
-- field-table column explicitly, then restore only the GPS insert columns.
do $privileges$
declare
  v_table record;
begin
  for v_table in
    select
      c.table_name,
      pg_catalog.string_agg(
        pg_catalog.format('%I', c.column_name),
        ', ' order by c.ordinal_position
      ) as column_list
    from information_schema.columns as c
    where c.table_schema = 'public'
      and c.table_name::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
    group by c.table_name
  loop
    execute pg_catalog.format(
      'revoke all privileges (%s) on table public.%I from public, anon, authenticated',
      v_table.column_list,
      v_table.table_name
    );
  end loop;
end
$privileges$;

revoke all privileges on sequence public.shift_locations_id_seq
  from public, anon, authenticated;

grant select on table public.field_workers to authenticated;
grant select on table public.shifts to authenticated;
grant select on table public.shift_locations to authenticated;
grant select on table public.shift_edits to authenticated;
grant select on table public.shift_orders to authenticated;
grant select on table public.app_config to authenticated;

grant insert (shift_id, at, lat, lng, accuracy_m, speed_mps)
  on table public.shift_locations to authenticated;
grant usage, select on sequence public.shift_locations_id_seq to authenticated;

-- Service-role integrations continue using direct table access and bypass RLS.
-- No Cloudflare Worker, Claudia, Jarvis, Mark, or pushdrain query is moved here.
grant all privileges on table
  public.app_config,
  public.field_workers,
  public.live_activity_tokens,
  public.push_tokens,
  public.shift_edits,
  public.shift_locations,
  public.shift_orders,
  public.shifts
to service_role;
grant all privileges on sequence public.shift_locations_id_seq to service_role;

-- --------------------------------------------------------------------------
-- 5. Re-lock SECURITY DEFINER RPCs and preserve their execution allowlist
-- --------------------------------------------------------------------------

alter function public.hc_claim_field_worker() security definer set search_path = '';
alter function public.hc_current_worker_id() security definer set search_path = '';
alter function public.hc_current_worker_email() security definer set search_path = '';
alter function public.hc_current_worker_role() security definer set search_path = '';
alter function public.hc_is_active_worker() security definer set search_path = '';
alter function public.hc_can_manage_shifts() security definer set search_path = '';
alter function public.hc_is_owner() security definer set search_path = '';
alter function public.hc_can_access_shift(uuid) security definer set search_path = '';
alter function public.hc_list_managed_shifts(timestamptz, integer) security definer set search_path = '';
alter function public.hc_start_shift(double precision, double precision, text) security definer set search_path = '';
alter function public.hc_clock_out_my_shift(uuid, timestamptz, double precision, double precision) security definer set search_path = '';
alter function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision) security definer set search_path = '';
alter function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text) security definer set search_path = '';
alter function public.hc_mark_shifts_paid(jsonb) security definer set search_path = '';
alter function public.hc_record_shift_orders(uuid, jsonb) security definer set search_path = '';
alter function public.hc_sync_notification_device(uuid, text, boolean, boolean) security definer set search_path = '';
alter function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean) security definer set search_path = '';
alter function public.hc_unregister_device(uuid) security definer set search_path = '';

revoke all on function public.hc_claim_field_worker() from public, anon, authenticated;
revoke all on function public.hc_current_worker_id() from public, anon, authenticated;
revoke all on function public.hc_current_worker_email() from public, anon, authenticated;
revoke all on function public.hc_current_worker_role() from public, anon, authenticated;
revoke all on function public.hc_is_active_worker() from public, anon, authenticated;
revoke all on function public.hc_can_manage_shifts() from public, anon, authenticated;
revoke all on function public.hc_is_owner() from public, anon, authenticated;
revoke all on function public.hc_can_access_shift(uuid) from public, anon, authenticated;
revoke all on function public.hc_list_managed_shifts(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.hc_start_shift(double precision, double precision, text) from public, anon, authenticated;
revoke all on function public.hc_clock_out_my_shift(uuid, timestamptz, double precision, double precision) from public, anon, authenticated;
revoke all on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision) from public, anon, authenticated;
revoke all on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.hc_mark_shifts_paid(jsonb) from public, anon, authenticated;
revoke all on function public.hc_record_shift_orders(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.hc_sync_notification_device(uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.hc_unregister_device(uuid) from public, anon, authenticated;

grant execute on function public.hc_claim_field_worker() to authenticated, service_role;
grant execute on function public.hc_current_worker_id() to authenticated, service_role;
grant execute on function public.hc_current_worker_email() to authenticated, service_role;
grant execute on function public.hc_current_worker_role() to authenticated, service_role;
grant execute on function public.hc_is_active_worker() to authenticated, service_role;
grant execute on function public.hc_can_manage_shifts() to authenticated, service_role;
grant execute on function public.hc_is_owner() to authenticated, service_role;
grant execute on function public.hc_can_access_shift(uuid) to authenticated, service_role;
grant execute on function public.hc_list_managed_shifts(timestamptz, integer) to authenticated, service_role;
grant execute on function public.hc_start_shift(double precision, double precision, text) to authenticated, service_role;
grant execute on function public.hc_clock_out_my_shift(uuid, timestamptz, double precision, double precision) to authenticated, service_role;
grant execute on function public.hc_manage_clock_out(uuid, timestamptz, double precision, double precision) to authenticated, service_role;
grant execute on function public.hc_edit_shift_times(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function public.hc_mark_shifts_paid(jsonb) to authenticated, service_role;
grant execute on function public.hc_record_shift_orders(uuid, jsonb) to authenticated, service_role;
grant execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean) to authenticated, service_role;
grant execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean) to authenticated, service_role;
grant execute on function public.hc_unregister_device(uuid) to authenticated, service_role;

-- All phone writes now use authenticated RPCs except bounded GPS inserts. The
-- email-resolving compatibility trigger is no longer needed and would let a
-- future trusted direct insert silently recover mutable-email ownership.
drop trigger if exists shifts_assign_field_worker on public.shifts;
drop function if exists public.hc_assign_shift_worker();
drop function if exists public.hc_mark_shift_paid(uuid);

-- --------------------------------------------------------------------------
-- 6. Final assertions, any failure rolls the entire cutover back
-- --------------------------------------------------------------------------

do $assertions$
declare
  v_table text;
  v_privilege text;
  v_signature text;
begin
  if exists (
    select 1
    from pg_catalog.pg_policies as p
    where p.schemaname = 'public'
      and p.tablename::text = any(array[
        'field_workers',
        'shifts',
        'shift_locations',
        'shift_edits',
        'shift_orders',
        'push_tokens',
        'live_activity_tokens',
        'app_config'
      ])
      and (
        'public'::name = any(p.roles)
        or 'anon'::name = any(p.roles)
      )
  ) then
    raise exception using
      errcode = '42501',
      message = 'cutover assertion failed: public or anon field policy remains';
  end if;

  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'push_tokens',
    'live_activity_tokens',
    'app_config'
  ] loop
    foreach v_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if pg_catalog.has_table_privilege(
        'anon',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'cutover assertion failed: anon retains %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if pg_catalog.has_any_column_privilege(
        'anon',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'cutover assertion failed: anon retains column %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    foreach v_privilege in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if pg_catalog.has_table_privilege(
        'authenticated',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'cutover assertion failed: authenticated retains direct %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    foreach v_privilege in array array['UPDATE', 'REFERENCES'] loop
      if pg_catalog.has_any_column_privilege(
        'authenticated',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'cutover assertion failed: authenticated retains column %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;

    if v_table <> 'shift_locations'
       and pg_catalog.has_any_column_privilege(
         'authenticated',
         pg_catalog.format('public.%I', v_table),
         'INSERT'
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: authenticated retains column INSERT on public.%I',
          v_table
        );
    end if;

    if v_table = any(array[
      'field_workers',
      'shifts',
      'shift_locations',
      'shift_edits',
      'shift_orders',
      'app_config'
    ]) then
      if not pg_catalog.has_table_privilege(
        'authenticated',
        pg_catalog.format('public.%I', v_table),
        'SELECT'
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'cutover assertion failed: authenticated lost SELECT on public.%I',
            v_table
          );
      end if;
    elsif pg_catalog.has_any_column_privilege(
      'authenticated',
      pg_catalog.format('public.%I', v_table),
      'SELECT'
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: authenticated can directly read public.%I',
          v_table
        );
    end if;

    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not pg_catalog.has_table_privilege(
        'service_role',
        pg_catalog.format('public.%I', v_table),
        v_privilege
      ) then
        raise exception using
          errcode = '42501',
          message = pg_catalog.format(
            'cutover assertion failed: service_role lost %s on public.%I',
            v_privilege,
            v_table
          );
      end if;
    end loop;
  end loop;

  foreach v_privilege in array array['USAGE', 'SELECT', 'UPDATE'] loop
    if pg_catalog.has_sequence_privilege(
      'anon',
      'public.shift_locations_id_seq',
      v_privilege
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: anon retains GPS sequence %s',
          v_privilege
        );
    end if;

    if not pg_catalog.has_sequence_privilege(
      'service_role',
      'public.shift_locations_id_seq',
      v_privilege
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: service_role lost GPS sequence %s',
          v_privilege
        );
    end if;
  end loop;

  if not pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'USAGE'
  ) or not pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'SELECT'
  ) or pg_catalog.has_sequence_privilege(
    'authenticated',
    'public.shift_locations_id_seq',
    'UPDATE'
  ) then
    raise exception using
      errcode = '42501',
      message = 'cutover assertion failed: authenticated GPS sequence grants are wrong';
  end if;

  if not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'shift_id',
    'INSERT'
  ) or not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'at',
    'INSERT'
  ) or not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'lat',
    'INSERT'
  ) or not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'lng',
    'INSERT'
  ) or not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'accuracy_m',
    'INSERT'
  ) or not pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'speed_mps',
    'INSERT'
  ) or pg_catalog.has_column_privilege(
    'authenticated',
    'public.shift_locations',
    'id',
    'INSERT'
  ) then
    raise exception using
      errcode = '42501',
      message = 'cutover assertion failed: authenticated GPS column grants are wrong';
  end if;

  foreach v_signature in array array[
    'public.hc_claim_field_worker()',
    'public.hc_current_worker_id()',
    'public.hc_current_worker_email()',
    'public.hc_current_worker_role()',
    'public.hc_is_active_worker()',
    'public.hc_can_manage_shifts()',
    'public.hc_is_owner()',
    'public.hc_can_access_shift(uuid)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_clock_out_my_shift(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_mark_shifts_paid(jsonb)',
    'public.hc_record_shift_orders(uuid,jsonb)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
    'public.hc_unregister_device(uuid)'
  ] loop
    if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: RPC execution grants are wrong for %s',
          v_signature
        );
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_proc as p
      where p.oid = pg_catalog.to_regprocedure(v_signature)
        and p.prosecdef is true
        and exists (
          select 1
          from pg_catalog.unnest(p.proconfig) as setting(value)
          where setting.value like 'search_path=%'
        )
    ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: SECURITY DEFINER/search_path lock is wrong for %s',
          v_signature
        );
    end if;
  end loop;

  foreach v_signature in array array[
    'public.hc_register_push_token(text,text)',
    'public.hc_register_live_activity_token(text,uuid,text)',
    'public.hc_unregister_device()'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is not null then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          'cutover assertion failed: obsolete RPC %s still exists',
          v_signature
        );
    end if;
  end loop;
end
$assertions$;

commit;

-- POST-CUTOVER, REQUIRED MANUAL TESTS
-- 1. anon SELECT/INSERT/UPDATE on every field table returns permission denied.
-- 2. authenticated team can claim identity, start, upload own GPS, clock out,
--    attribute eligible orders, and read only their own base shifts.
-- 3. manager can list safe team shifts with is_paid, see routes/attribution,
--    edit only another worker's unpaid shift, and cannot read payroll columns.
-- 4. owner can edit, mark paid, and reconcile device-scoped notification tokens.
-- 5. a team/inactive login on a former owner phone removes that phone's push
--    and Live Activity mappings, while an older phone cannot unregister a newer one.
-- 6. Claudia/Cloudflare, Jarvis, Mark, and pushdrain service-role reads/writes
--    still work. Public dashboard orders and signatures remain unchanged.
