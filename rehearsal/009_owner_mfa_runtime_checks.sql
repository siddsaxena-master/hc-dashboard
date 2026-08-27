-- ============================================================================
-- SANDBOX ONLY: 009_owner_mfa_runtime_checks.sql
--
-- Run only after migration 028 on hc-field-rehearsal. This script temporarily
-- changes the one sandbox roster identity between owner, manager, and team,
-- exercises every migration-028 wrapper plus the direct payroll, clock-out,
-- attribution, and RLS paths, and rolls back every fixture and change.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_auth_user_id uuid;
  v_worker_id uuid;
  v_worker_name text;
  v_worker_email text;
  v_rate_cents integer;
  v_order_ny constant uuid := '00000000-0000-4000-8000-000000002801';
  v_order_miami constant uuid := '00000000-0000-4000-8000-000000002802';
  v_managed_worker constant uuid := '00000000-0000-4000-8000-000000002803';
  v_pay_shift constant uuid := '00000000-0000-4000-8000-000000002811';
  v_managed_shift constant uuid := '00000000-0000-4000-8000-000000002812';
  v_device_id constant uuid := '00000000-0000-4000-8000-000000002821';
  v_delivery_request constant uuid := '00000000-0000-4000-8000-000000002831';
  v_apns_token constant text :=
    '91d6c1bc73964d7980a85a7302bf27ae91d6c1bc73964d7980a85a7302bf27ae';
  v_start_token constant text :=
    'a37f42d68c2e4f2b91a820615c0e97d4a37f42d68c2e4f2b91a820615c0e97d4';
  v_bootstrap record;
  v_profile record;
  v_rows jsonb;
  v_rejected boolean;
  v_wrapper_sql text;
  v_wrapper_count integer := 0;
  v_signature text;
  v_internal text;
  v_paid_count integer;
  v_attributed_count integer;
  v_confirmed boolean;
  v_self_shift uuid;
  v_clock_in timestamptz;
  v_clock_out timestamptz;
begin
  if (select pg_catalog.count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where pg_catalog.lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     )
     or exists (
       select 1
       from public.orders
       where client_name not like 'Sandbox %'
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected the isolated one-user rehearsal project';
  end if;

  select
    worker.auth_user_id,
    worker.id,
    worker.name,
    pg_catalog.lower(worker.email),
    coalesce(worker.hourly_rate_cents, 2500)
  into v_auth_user_id, v_worker_id, v_worker_name, v_worker_email, v_rate_cents
  from public.field_workers as worker
  where worker.active is true
    and pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
    and worker.auth_user_id is not null
  order by worker.created_at asc nulls last, worker.id asc
  limit 1;

  if v_auth_user_id is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: linked active owner is missing';
  end if;

  -- Remove any prior owner open-shift collision inside this transaction only.
  update public.shifts
  set clock_out_at = greatest(clock_in_at, pg_catalog.clock_timestamp())
  where field_worker_id = v_worker_id
    and clock_out_at is null;

  update public.field_workers
  set hourly_rate_cents = v_rate_cents,
      market = 'ny'
  where id = v_worker_id;

  insert into public.field_workers (
    id,
    email,
    name,
    market,
    role,
    active,
    hourly_rate_cents,
    auth_user_id
  ) values (
    v_managed_worker,
    'managed-worker-028@sandbox.invalid',
    'Sandbox Managed Worker',
    'ny',
    'team',
    true,
    2400,
    null
  );

  insert into public.shifts (
    id,
    field_worker_id,
    worker_name,
    worker_email,
    market,
    clock_in_at,
    clock_out_at,
    device
  ) values (
    v_pay_shift,
    v_worker_id,
    v_worker_name,
    v_worker_email,
    'ny',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() - interval '1 hour',
    'sandbox-mfa-payroll'
  );

  insert into public.shifts (
    id,
    field_worker_id,
    worker_name,
    worker_email,
    market,
    clock_in_at,
    clock_out_at,
    device
  ) values (
    v_managed_shift,
    v_managed_worker,
    'Sandbox Managed Worker',
    'managed-worker-028@sandbox.invalid',
    'ny',
    pg_catalog.clock_timestamp() - interval '30 minutes',
    null,
    'sandbox-mfa-managed-clockout'
  );

  insert into public.shift_locations (
    shift_id, at, lat, lng, accuracy_m, speed_mps
  ) values (
    v_pay_shift,
    pg_catalog.clock_timestamp() - interval '90 minutes',
    40.7128,
    -74.0060,
    5,
    0
  );

  insert into public.app_config (key, value)
  values ('hc_mfa_rehearsal_fixture', 'private-owner-config')
  on conflict (key) do update
  set value = excluded.value,
      updated_at = pg_catalog.clock_timestamp();

  insert into public.orders (
    id,
    client_name,
    client_email,
    client_phone,
    company,
    venue,
    coconuts_qty,
    delivery_at_utc,
    delivery_notes,
    stage,
    market,
    total_cents,
    external_invoice_id,
    notes
  )
  values
    (
      v_order_ny,
      'Sandbox MFA NY',
      'private-mfa-ny@sandbox.invalid',
      '+15555550281',
      'Private MFA NY Company',
      'Sandbox MFA NY Venue',
      100,
      (
        (pg_catalog.timezone('America/New_York', pg_catalog.clock_timestamp())::date + 1)::timestamp
        + interval '12 hours'
      ) at time zone 'UTC',
      'Private NY delivery note',
      'paid_full',
      'ny',
      10000,
      'sandbox-mfa-private-ny',
      'private MFA owner note ny'
    ),
    (
      v_order_miami,
      'Sandbox MFA Miami',
      'private-mfa-miami@sandbox.invalid',
      '+15555550282',
      'Private MFA Miami Company',
      'Sandbox MFA Miami Venue',
      200,
      (
        (pg_catalog.timezone('America/New_York', pg_catalog.clock_timestamp())::date + 2)::timestamp
        + interval '12 hours'
      ) at time zone 'UTC',
      'Private Miami delivery note',
      'paid_full',
      'miami',
      20000,
      'sandbox-mfa-private-miami',
      'private MFA owner note miami'
    );

  -- An owner at AAL1 may learn only that the TOTP step is required. Nested
  -- metadata that falsely claims AAL2 cannot override the signed top-level AAL.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_auth_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal1',
      'user_metadata', pg_catalog.json_build_object(
        'role', 'manager',
        'market', 'miami',
        'aal', 'aal2'
      ),
      'app_metadata', pg_catalog.json_build_object(
        'role', 'owner',
        'aal', 'aal2'
      )
    )::text,
    true
  );

  select * into v_bootstrap from public.hc_get_auth_bootstrap();
  if v_bootstrap.auth_user_id is distinct from v_auth_user_id
     or v_bootstrap.role is distinct from 'owner'
     or v_bootstrap.mfa_required is not true
     or public.hc_owner_session_is_aal2()
     or public.hc_is_owner()
     or public.hc_current_worker_role() is not null
     or public.hc_can_access_order_market('ny') then
    raise exception using
      errcode = '55000',
      message = 'owner AAL1 bootstrap or signed-AAL denial failed';
  end if;

  v_rejected := false;
  begin
    perform * from public.hc_claim_field_worker_v2();
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'owner AAL1 received a full profile claim';
  end if;

  -- Every public wrapper added by migration 028 must reject the owner before
  -- reaching its renamed implementation. Typed literals avoid overload drift.
  foreach v_wrapper_sql in array array[
    'select * from public.hc_start_shift(null::double precision, null::double precision, ''sandbox-owner-aal1'')',
    'select * from public.hc_list_managed_shifts(pg_catalog.clock_timestamp() - interval ''1 day'', 10)',
    'select * from public.hc_manage_clock_out(''00000000-0000-4000-8000-000000002811''::uuid, null::timestamptz, null::double precision, null::double precision)',
    'select * from public.hc_edit_shift_times(''00000000-0000-4000-8000-000000002811''::uuid, null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz, ''aal1 denied'')',
    'select * from public.hc_list_managed_open_shift_ids()',
    'select * from public.hc_list_orders_for_current_user(null::timestamptz, null::timestamptz, null::text[], 0, 500)',
    'select public.hc_confirm_order_delivery_v2(''00000000-0000-4000-8000-000000002831''::uuid, ''00000000-0000-4000-8000-000000002801''::uuid, pg_catalog.clock_timestamp(), ''Sandbox Receiver'', ''data:image/png;base64,AA=='', ''dashboard'')',
    'select * from public.hc_authorize_notification_device(''00000000-0000-4000-8000-000000002821''::uuid)',
    'select public.hc_sync_notification_device(''00000000-0000-4000-8000-000000002821''::uuid, ''91d6c1bc73964d7980a85a7302bf27ae91d6c1bc73964d7980a85a7302bf27ae'', true, true)',
    'select public.hc_register_live_activity_token(''push_to_start'', null::uuid, ''a37f42d68c2e4f2b91a820615c0e97d4a37f42d68c2e4f2b91a820615c0e97d4'', ''00000000-0000-4000-8000-000000002821''::uuid, true)'
  ] loop
    v_rejected := false;
    begin
      execute v_wrapper_sql;
    exception when insufficient_privilege then
      v_rejected := true;
    end;
    if not v_rejected then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('owner AAL1 reached protected wrapper: %s', v_wrapper_sql);
    end if;
    v_wrapper_count := v_wrapper_count + 1;
  end loop;

  if v_wrapper_count <> 10 then
    raise exception using
      errcode = '55000',
      message = 'owner AAL1 wrapper matrix did not execute all ten paths';
  end if;

  foreach v_wrapper_sql in array array[
    'select public.hc_mark_shifts_paid(''[]''::jsonb, null::text)',
    'select * from public.hc_clock_out_my_shift(''00000000-0000-4000-8000-000000002811''::uuid, pg_catalog.clock_timestamp(), null::double precision, null::double precision)',
    'select public.hc_record_shift_orders(''00000000-0000-4000-8000-000000002811''::uuid, ''[]''::jsonb)'
  ] loop
    v_rejected := false;
    begin
      execute v_wrapper_sql;
    exception when insufficient_privilege then
      v_rejected := true;
    end;
    if not v_rejected then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('owner AAL1 reached protected direct RPC: %s', v_wrapper_sql);
    end if;
  end loop;

  -- The signed top-level AAL2 claim unlocks the full owner profile and global
  -- owner order projection.
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  select * into v_profile from public.hc_claim_field_worker_v2();
  if v_profile.auth_user_id is distinct from v_auth_user_id
     or pg_catalog.lower(pg_catalog.btrim(v_profile.role)) <> 'owner'
     or not public.hc_owner_session_is_aal2()
     or not public.hc_is_owner() then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 profile claim failed';
  end if;

  select pg_catalog.jsonb_agg(order_row order by order_row->>'id')
  into v_rows
  from public.hc_list_orders_for_current_user(
    null, null, null, 0, 500
  ) as order_row
  where order_row->>'id' in (v_order_ny::text, v_order_miami::text);

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 2
     or not exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_rows) as item(value)
       where item.value->>'id' = v_order_ny::text
         and item.value->>'total_cents' = '10000'
         and item.value->>'notes' = 'private MFA owner note ny'
     )
     or not exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_rows) as item(value)
       where item.value->>'id' = v_order_miami::text
         and item.value->>'total_cents' = '20000'
     ) then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 did not retain complete global order access';
  end if;

  -- Prove the same wrappers still preserve their intended behavior after the
  -- signed AAL2 claim. One shift uses the worker-owned clock-out path and one
  -- uses the owner management wrapper.
  select started.id
  into v_self_shift
  from public.hc_start_shift(null, null, 'sandbox-mfa-self-clockout') as started
  limit 1;

  if v_self_shift is null then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 start-shift wrapper returned no shift';
  end if;

  perform *
  from public.hc_clock_out_my_shift(
    v_self_shift,
    pg_catalog.clock_timestamp(),
    null,
    null
  );

  select public.hc_record_shift_orders(
    v_self_shift,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'order_id', v_order_ny,
        'work_type', 'prep'
      )
    )
  ) into v_attributed_count;

  if v_attributed_count <> 1
     or not exists (
       select 1
       from public.shift_orders
       where shift_id = v_self_shift
         and order_id = v_order_ny
         and work_type = 'prep'
         and worker_email = v_worker_email
     ) then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 self clock-out or order attribution failed';
  end if;

  perform *
  from public.hc_manage_clock_out(
    v_managed_shift,
    pg_catalog.clock_timestamp(),
    null,
    null
  );

  select clock_in_at, clock_out_at
  into v_clock_in, v_clock_out
  from public.shifts
  where id = v_managed_shift;

  perform *
  from public.hc_edit_shift_times(
    v_managed_shift,
    v_clock_in,
    v_clock_out,
    v_clock_in - interval '5 minutes',
    v_clock_out,
    'MFA rehearsal edit'
  );
  perform * from public.hc_list_managed_shifts(
    pg_catalog.clock_timestamp() - interval '1 day',
    60
  );
  perform * from public.hc_list_managed_open_shift_ids();

  select clock_in_at, clock_out_at
  into v_clock_in, v_clock_out
  from public.shifts
  where id = v_pay_shift;

  select public.hc_mark_shifts_paid(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'shift_id', v_pay_shift,
        'expected_clock_in_at', v_clock_in,
        'expected_clock_out_at', v_clock_out,
        'expected_rate_cents', v_rate_cents
      )
    ),
    'MFA rehearsal only'
  ) into v_paid_count;

  if v_paid_count <> 1
     or not exists (
       select 1
       from public.shift_payment_records
       where shift_id = v_pay_shift
         and field_worker_id = v_worker_id
         and payer_auth_user_id = v_auth_user_id
         and worker_email = v_worker_email
         and payer_email = v_worker_email
         and payment_note = 'MFA rehearsal only'
     ) then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 payroll or immutable payment audit failed';
  end if;

  select public.hc_confirm_order_delivery_v2(
    v_delivery_request,
    v_order_ny,
    pg_catalog.clock_timestamp() - interval '1 minute',
    'Sandbox MFA Receiver',
    'data:image/png;base64,AA==',
    'dashboard'
  ) into v_confirmed;

  if v_confirmed is not true
     or not exists (
       select 1
       from public.delivery_signatures
       where delivery_request_id = v_delivery_request
         and order_id = v_order_ny
     ) then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 delivery-v2 wrapper failed';
  end if;

  -- The raw revoke capability is deliberately discarded and never selected.
  perform 1
  from public.hc_authorize_notification_device(v_device_id);
  perform public.hc_sync_notification_device(
    v_device_id,
    v_apns_token,
    true,
    true
  );
  perform public.hc_register_live_activity_token(
    'push_to_start',
    null,
    v_start_token,
    v_device_id,
    true
  );

  if not exists (
       select 1
       from public.notification_device_authorizations
       where device_id = v_device_id
         and auth_user_id = v_auth_user_id
         and revoked_at is null
     )
     or not exists (
       select 1
       from public.push_tokens
       where device_id = v_device_id
         and pg_catalog.lower(email) = v_worker_email
     )
     or not exists (
       select 1
       from public.live_activity_tokens
       where device_id = v_device_id
         and token_type = 'push_to_start'
         and pg_catalog.lower(email) = v_worker_email
     ) then
    raise exception using
      errcode = '55000',
      message = 'owner AAL2 notification authorization, sync, or registration failed';
  end if;

  -- Managers remain at AAL1 and retain only their existing exact-market,
  -- operational projection. Spoofed owner metadata remains ineffective.
  update public.field_workers
  set role = 'manager', market = 'ny'
  where id = v_worker_id;

  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal1',
      'user_metadata', pg_catalog.json_build_object(
        'role', 'owner',
        'market', 'miami',
        'aal', 'aal2'
      )
    )::text,
    true
  );

  select * into v_bootstrap from public.hc_get_auth_bootstrap();
  select * into v_profile from public.hc_claim_field_worker_v2();
  if v_bootstrap.role is distinct from 'manager'
     or v_bootstrap.mfa_required is not false
     or pg_catalog.lower(pg_catalog.btrim(v_profile.role)) <> 'manager'
     or public.hc_is_owner()
     or not public.hc_can_access_order_market('ny')
     or public.hc_can_access_order_market('miami') then
    raise exception using
      errcode = '55000',
      message = 'manager AAL1 routing or exact-market scope failed';
  end if;

  select pg_catalog.jsonb_agg(order_row order by order_row->>'id')
  into v_rows
  from public.hc_list_orders_for_current_user(
    null, null, null, 0, 500
  ) as order_row
  where order_row->>'id' in (v_order_ny::text, v_order_miami::text);

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 1
     or v_rows->0->>'id' <> v_order_ny::text
     or v_rows->0 ?| array[
       'client_email',
       'client_phone',
       'company',
       'total_cents',
       'external_invoice_id',
       'notes',
       'delivery_signed_by'
     ] then
    raise exception using
      errcode = '55000',
      message = 'manager AAL1 order projection leaked fields or crossed markets';
  end if;

  -- Team remains at AAL1 with its prior market order projection, but cannot
  -- call a management-only RPC.
  update public.field_workers
  set role = 'team', market = 'ny'
  where id = v_worker_id;

  select * into v_bootstrap from public.hc_get_auth_bootstrap();
  select * into v_profile from public.hc_claim_field_worker_v2();
  if v_bootstrap.role is distinct from 'team'
     or v_bootstrap.mfa_required is not false
     or pg_catalog.lower(pg_catalog.btrim(v_profile.role)) <> 'team'
     or public.hc_is_owner()
     or not public.hc_can_access_order_market('ny')
     or public.hc_can_access_order_market('miami') then
    raise exception using
      errcode = '55000',
      message = 'team AAL1 routing or exact-market scope failed';
  end if;

  select pg_catalog.jsonb_agg(order_row order by order_row->>'id')
  into v_rows
  from public.hc_list_orders_for_current_user(
    null, null, null, 0, 500
  ) as order_row
  where order_row->>'id' in (v_order_ny::text, v_order_miami::text);

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 1
     or v_rows->0->>'id' <> v_order_ny::text
     or v_rows->0 ? 'total_cents' then
    raise exception using
      errcode = '55000',
      message = 'team AAL1 order projection leaked fields or crossed markets';
  end if;

  v_rejected := false;
  begin
    perform * from public.hc_list_managed_shifts(
      pg_catalog.clock_timestamp() - interval '1 day', 10
    );
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'team AAL1 reached a management-only RPC';
  end if;

  -- Every public wrapper remains available to authenticated PostgREST calls,
  -- while anon receives none of them.
  foreach v_signature in array array[
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
    if not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('wrapper grant mismatch: %s', v_signature);
    end if;
  end loop;

  foreach v_signature in array array[
    'public.hc_start_shift(double precision,double precision,text)',
    'public.hc_list_managed_shifts(timestamp with time zone,integer)',
    'public.hc_manage_clock_out(uuid,timestamp with time zone,double precision,double precision)',
    'public.hc_edit_shift_times(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text)',
    'public.hc_list_managed_open_shift_ids()',
    'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)',
    'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
    'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'
  ] loop
    if not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('service-role wrapper grant missing: %s', v_signature);
    end if;
  end loop;

  -- No PostgREST client role may call a renamed pre-MFA implementation.
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
    if pg_catalog.has_function_privilege('anon', v_internal, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_internal, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_internal, 'EXECUTE') then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('hidden implementation remains executable: %s', v_internal);
    end if;
  end loop;

  if pg_catalog.has_function_privilege('anon', 'public.hc_get_auth_bootstrap()', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.hc_claim_field_worker_v2()', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_get_auth_bootstrap()', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_claim_field_worker_v2()', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_mark_shifts_paid(jsonb,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_clock_out_my_shift(uuid,timestamp with time zone,double precision,double precision)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_record_shift_orders(uuid,jsonb)', 'EXECUTE') then
    raise exception using
      errcode = '42501',
      message = 'identity or direct-RPC grant matrix is incorrect';
  end if;

  -- Leave real fixture rows in place, but restore the linked identity to owner
  -- AAL1 for the authenticated-role RLS checks below.
  update public.field_workers
  set role = 'owner', market = 'ny'
  where id = v_worker_id;

  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal1'
    )::text,
    true
  );
  perform pg_catalog.set_config('hc.rehearsal_auth_user_id', v_auth_user_id::text, true);
  perform pg_catalog.set_config('hc.rehearsal_pay_shift_id', v_pay_shift::text, true);
  perform pg_catalog.set_config('hc.rehearsal_order_id', v_order_ny::text, true);
end
$test$;

-- Run the direct table checks as the same database role PostgREST assigns to a
-- signed-in browser or phone. This prevents the SQL editor's owner role from
-- bypassing RLS and proves that real fixture rows are invisible at owner AAL1.
set local role authenticated;

do $rls$
declare
  v_auth_user_id uuid := pg_catalog.current_setting('hc.rehearsal_auth_user_id')::uuid;
  v_pay_shift uuid := pg_catalog.current_setting('hc.rehearsal_pay_shift_id')::uuid;
  v_order_id uuid := pg_catalog.current_setting('hc.rehearsal_order_id')::uuid;
  v_table text;
  v_visible bigint;
  v_affected bigint;
  v_rejected boolean := false;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', v_auth_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal1'
    )::text,
    true
  );

  foreach v_table in array array[
    'field_workers',
    'shifts',
    'shift_locations',
    'shift_edits',
    'shift_orders',
    'orders',
    'app_config',
    'shift_payment_records'
  ] loop
    execute pg_catalog.format('select pg_catalog.count(*) from public.%I', v_table)
      into v_visible;
    if v_visible <> 0 then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('owner AAL1 direct RLS read leaked rows from %s', v_table);
    end if;
  end loop;

  begin
    insert into public.shift_locations (
      shift_id, at, lat, lng, accuracy_m, speed_mps
    ) values (
      v_pay_shift, pg_catalog.clock_timestamp(), 40.7, -74.0, 5, 0
    );
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '42501',
      message = 'owner AAL1 inserted a direct GPS child row';
  end if;

  update public.orders
  set notes = 'owner AAL1 direct update should not apply'
  where id = v_order_id;
  get diagnostics v_affected = row_count;
  if v_affected <> 0 then
    raise exception using
      errcode = '42501',
      message = 'owner AAL1 updated an order through direct RLS';
  end if;
end
$rls$;

reset role;

rollback;

select
  'passed'::text as owner_mfa_runtime_rehearsal,
  32::integer as scenarios_checked;
