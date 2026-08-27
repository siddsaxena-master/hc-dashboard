-- ============================================================================
-- SANDBOX ONLY: 005_manager_market_scope_runtime_checks.sql
--
-- Run only after migration 025 on hc-field-rehearsal. Every synthetic roster,
-- shift, token, ledger, queue, and claim change is rolled back.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $test$
declare
  v_owner_auth_user_id uuid;
  v_owner_worker_id uuid;
  v_fixture_worker_id uuid;
  v_ny_closed constant uuid := '00000000-0000-4000-8000-000000002501';
  v_miami_closed constant uuid := '00000000-0000-4000-8000-000000002502';
  v_ny_open constant uuid := '00000000-0000-4000-8000-000000002503';
  v_miami_open constant uuid := '00000000-0000-4000-8000-000000002504';
  v_app_review_open constant uuid := '00000000-0000-4000-8000-000000002505';
  v_team_self constant uuid := '00000000-0000-4000-8000-000000002506';
  v_device_id constant uuid := '00000000-0000-4000-8000-000000002541';
  v_p2s_token_id constant uuid := '00000000-0000-4000-8000-000000002551';
  v_update_token_id constant uuid := '00000000-0000-4000-8000-000000002552';
  v_wrong_delivery_id constant uuid := '00000000-0000-4000-8000-000000002561';
  v_wrong_queue_id constant uuid := '00000000-0000-4000-8000-000000002571';
  v_p2s_token constant text :=
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  v_update_token constant text :=
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  v_rows jsonb;
  v_ids uuid[];
  v_count integer;
  v_claimed_at timestamptz := clock_timestamp();
  v_queue_rejected boolean := false;
  v_presend_allowed boolean;
begin
  if (select count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where lower(email) = 'siddsaxena@gmail.com'
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

  select worker.auth_user_id, worker.id
  into v_owner_auth_user_id, v_owner_worker_id
  from public.field_workers as worker
  where worker.active is true
    and lower(trim(worker.role)) = 'owner'
    and worker.auth_user_id is not null
  order by worker.created_at asc nulls last, worker.id asc
  limit 1;

  select worker.id
  into v_fixture_worker_id
  from public.field_workers as worker
  where lower(worker.email) = 'worker@sandbox.invalid'
  limit 1;

  if v_owner_auth_user_id is null or v_fixture_worker_id is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: linked owner or fixture worker is missing';
  end if;

  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_owner_auth_user_id::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  -- The shared sandbox baseline may already contain one open App Review shift.
  -- Close it inside this transaction so the exact-email exclusion fixture can
  -- be inserted without colliding with the one-open-shift safety index.
  update public.shifts
  set clock_out_at = clock_timestamp()
  where clock_out_at is null
    and lower(trim(coalesce(worker_email, ''))) =
        'appreview@hamptonscoconuts.com';

  insert into public.shifts (
    id,
    field_worker_id,
    worker_name,
    worker_email,
    market,
    clock_in_at,
    clock_out_at,
    device,
    paid_at,
    paid_cents,
    paid_minutes
  )
  values
    (
      v_ny_closed,
      v_fixture_worker_id,
      'Sandbox NY Closed',
      'worker@sandbox.invalid',
      ' ny ',
      clock_timestamp() - interval '4 hours',
      clock_timestamp() - interval '3 hours',
      'sandbox-market-scope',
      clock_timestamp() - interval '2 hours',
      2400,
      60
    ),
    (
      v_miami_closed,
      v_fixture_worker_id,
      'Sandbox Miami Closed',
      'worker@sandbox.invalid',
      'MIAMI',
      clock_timestamp() - interval '3 hours',
      clock_timestamp() - interval '2 hours',
      'sandbox-market-scope',
      clock_timestamp() - interval '1 hour',
      2400,
      60
    ),
    (
      v_ny_open,
      null,
      'Sandbox NY Open',
      'ny-open@sandbox.invalid',
      'NY',
      clock_timestamp() - interval '50 minutes',
      null,
      'sandbox-market-scope',
      null,
      null,
      null
    ),
    (
      v_miami_open,
      null,
      'Sandbox Miami Open',
      'miami-open@sandbox.invalid',
      ' miami ',
      clock_timestamp() - interval '45 minutes',
      null,
      'sandbox-market-scope',
      null,
      null,
      null
    ),
    (
      v_app_review_open,
      null,
      'App Review',
      'appreview@hamptonscoconuts.com',
      'ny',
      clock_timestamp() - interval '40 minutes',
      null,
      'sandbox-market-scope',
      null,
      null,
      null
    );

  -- Owners remain global and retain the complete managed payment indicator.
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(managed_row))
  into v_rows
  from public.hc_list_managed_shifts(null, 200) as managed_row
  where managed_row.id in (
    v_ny_closed,
    v_miami_closed,
    v_ny_open,
    v_miami_open,
    v_app_review_open
  );

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 5
     or not exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_rows) as item(value)
       where item.value->>'id' = v_ny_closed::text
         and item.value->>'is_paid' = 'true'
     )
     or public.hc_can_access_shift(v_ny_closed) is not true
     or public.hc_can_access_shift(v_miami_closed) is not true then
    raise exception using
      errcode = '55000',
      message = 'owner did not retain global shift access';
  end if;

  select pg_catalog.array_agg(open_row.shift_id order by open_row.shift_id)
  into v_ids
  from public.hc_list_managed_open_shift_ids() as open_row
  where open_row.shift_id in (v_ny_open, v_miami_open, v_app_review_open);

  if coalesce(v_ids, array[]::uuid[]) <> array[v_ny_open, v_miami_open] then
    raise exception using
      errcode = '55000',
      message = 'owner open-shift truth crossed the App Review exclusion';
  end if;

  -- Authorize one synthetic management phone while the identity is still an
  -- owner. The raw capability secret is returned once and deliberately discarded.
  perform 1
  from public.hc_authorize_notification_device(v_device_id);

  insert into public.live_activity_tokens (
    id,
    email,
    token_type,
    shift_id,
    token,
    device_id,
    updated_at
  ) values (
    v_p2s_token_id,
    'siddsaxena@gmail.com',
    'push_to_start',
    null,
    v_p2s_token,
    v_device_id,
    clock_timestamp()
  );

  update public.field_workers
  set role = 'manager',
      market = ' NY '
  where id = v_owner_worker_id;

  -- The NY manager sees only normalized NY rows. is_paid stays JSON null and
  -- no payroll snapshot key exists in the projection.
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(managed_row))
  into v_rows
  from public.hc_list_managed_shifts(null, 200) as managed_row
  where managed_row.id in (
    v_ny_closed,
    v_miami_closed,
    v_ny_open,
    v_miami_open,
    v_app_review_open
  );

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 3
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_rows) as item(value)
       where lower(trim(item.value->>'market')) <> 'ny'
          or item.value->>'is_paid' is not null
          or item.value ?| array['paid_at', 'paid_cents', 'paid_minutes']
     )
     or public.hc_can_access_shift(v_ny_closed) is not true
     or public.hc_can_access_shift(v_miami_closed) is not false then
    raise exception using
      errcode = '55000',
      message = 'NY manager read crossed markets or leaked payroll';
  end if;

  select pg_catalog.array_agg(open_row.shift_id order by open_row.shift_id)
  into v_ids
  from public.hc_list_managed_open_shift_ids() as open_row
  where open_row.shift_id in (v_ny_open, v_miami_open, v_app_review_open);

  if coalesce(v_ids, array[]::uuid[]) <> array[v_ny_open] then
    raise exception using
      errcode = '55000',
      message = 'NY manager open-shift truth crossed market or App Review scope';
  end if;

  select count(*)
  into v_count
  from public.hc_manage_clock_out(
    v_miami_open,
    clock_timestamp(),
    null,
    null
  );

  if v_count <> 0
     or exists (
       select 1
       from public.shifts
       where id = v_miami_open
         and clock_out_at is not null
     ) then
    raise exception using
      errcode = '55000',
      message = 'cross-market managed clock-out was not denied atomically';
  end if;

  select count(*)
  into v_count
  from public.hc_edit_shift_times(
    v_miami_closed,
    (select clock_in_at from public.shifts where id = v_miami_closed),
    (select clock_out_at from public.shifts where id = v_miami_closed),
    (select clock_in_at + interval '5 minutes' from public.shifts where id = v_miami_closed),
    (select clock_out_at from public.shifts where id = v_miami_closed),
    'must be denied by market'
  );

  if v_count <> 0
     or exists (
       select 1
       from public.shift_edits
       where shift_id = v_miami_closed
         and note = 'must be denied by market'
     ) then
    raise exception using
      errcode = '55000',
      message = 'cross-market time edit was not denied atomically';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'service_role'
    )::text,
    true
  );

  select
    pg_catalog.array_agg(claimed.shift_id order by claimed.shift_id),
    pg_catalog.bool_and(lower(trim(claimed.market)) = 'ny')
  into v_ids, v_presend_allowed
  from public.hc_claim_live_activity_starts_v2(
    v_claimed_at,
    v_claimed_at - interval '31 minutes',
    v_claimed_at - interval '2 hours',
    200
  ) as claimed
  where claimed.device_id = v_device_id
    and claimed.shift_id in (v_ny_open, v_miami_open, v_app_review_open);

  if coalesce(v_ids, array[]::uuid[]) <> array[v_ny_open]
     or v_presend_allowed is not true then
    raise exception using
      errcode = '55000',
      message = 'START claim crossed manager market or App Review scope';
  end if;

  -- Simulate a stale pre-025 cross-market START receipt. Both the actual queue
  -- INSERT trigger and pushdrain's pre-send RPC must now reject it.
  insert into public.live_activity_start_deliveries (
    id,
    shift_id,
    device_id,
    start_token,
    queue_id,
    generation,
    claimed_at
  ) values (
    v_wrong_delivery_id,
    v_miami_open,
    v_device_id,
    v_p2s_token,
    v_wrong_queue_id,
    1,
    v_claimed_at
  );

  begin
    insert into public.push_queue (id, kind, payload)
    values (
      v_wrong_queue_id,
      'la_start',
      pg_catalog.jsonb_build_object(
        'tokens', pg_catalog.jsonb_build_array(v_p2s_token),
        'headers', pg_catalog.jsonb_build_object(
          'collapse_id', v_wrong_queue_id::text
        ),
        'aps', pg_catalog.jsonb_build_object(
          'event', 'start',
          'attributes', pg_catalog.jsonb_build_object(
            'shiftId', v_miami_open::text
          )
        ),
        'live_activity_start_delivery_id', v_wrong_delivery_id,
        'live_activity_start_shift_id', v_miami_open,
        'live_activity_start_device_id', v_device_id,
        'live_activity_start_queue_id', v_wrong_queue_id,
        'live_activity_start_generation', 1,
        'live_activity_start_claimed_at', v_claimed_at
      )
    );
  exception
    when check_violation then
      v_queue_rejected := true;
  end;

  select public.hc_validate_live_activity_start_delivery(
    v_wrong_delivery_id,
    v_miami_open,
    v_wrong_queue_id,
    1,
    v_p2s_token
  ) into v_presend_allowed;

  if v_queue_rejected is not true
     or v_presend_allowed is not false
     or exists (
       select 1
       from public.push_queue
       where id = v_wrong_queue_id
     ) then
    raise exception using
      errcode = '55000',
      message = 'cross-market START queue or pre-send validation was accepted';
  end if;

  -- Prove the positive write path too. Seed payment values only in this rolled
  -- back fixture, then confirm the manager can close the NY shift without any
  -- of those values appearing in the returned public.shifts composite.
  update public.shifts
  set paid_at = clock_timestamp(),
      paid_cents = 3600,
      paid_minutes = 90
  where id = v_ny_open;

  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(closed_row))
  into v_rows
  from public.hc_manage_clock_out(
    v_ny_open,
    clock_timestamp(),
    null,
    null
  ) as closed_row;

  if pg_catalog.jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 1
     or v_rows->0->>'id' <> v_ny_open::text
     or v_rows->0->>'paid_at' is not null
     or v_rows->0->>'paid_cents' is not null
     or v_rows->0->>'paid_minutes' is not null
     or not exists (
       select 1
       from public.shifts
       where id = v_ny_open
         and clock_out_at is not null
         and paid_at is not null
         and paid_cents = 3600
         and paid_minutes = 90
     ) then
    raise exception using
      errcode = '55000',
      message = 'same-market manager clock-out failed or leaked payroll';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'service_role'
    )::text,
    true
  );

  -- An activity-update token represents a card that already started. It must
  -- survive the new market scope and still receive END after the shift closes.
  insert into public.live_activity_tokens (
    id,
    email,
    token_type,
    shift_id,
    token,
    device_id,
    updated_at
  ) values (
    v_update_token_id,
    'siddsaxena@gmail.com',
    'activity_update',
    v_miami_open,
    v_update_token,
    v_device_id,
    clock_timestamp()
  );

  update public.shifts
  set clock_out_at = clock_timestamp()
  where id = v_miami_open;

  select count(*)
  into v_count
  from public.hc_claim_live_activity_ends(
    clock_timestamp(),
    clock_timestamp() - interval '31 minutes',
    200
  ) as ending
  where ending.token_id = v_update_token_id
    and ending.shift_id = v_miami_open;

  if v_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'durable END did not claim an already-started cross-market card';
  end if;

  -- Last, prove a non-management team identity remains self-only. This role
  -- change intentionally revokes the synthetic notification authorization,
  -- which is harmless because every notification assertion above is complete.
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  update public.field_workers
  set role = 'team',
      market = 'ny'
  where id = v_owner_worker_id;

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
    v_team_self,
    v_owner_worker_id,
    'Sandbox Team Self',
    'siddsaxena@gmail.com',
    'ny',
    clock_timestamp() - interval '20 minutes',
    clock_timestamp() - interval '10 minutes',
    'sandbox-market-scope'
  );

  if public.hc_can_access_shift(v_team_self) is not true
     or public.hc_can_access_shift(v_ny_closed) is not false
     or public.hc_can_access_shift(v_miami_closed) is not false then
    raise exception using
      errcode = '55000',
      message = 'team identity was not limited to its own shift';
  end if;
end
$test$;

rollback;

select
  'passed'::text as manager_market_scope_runtime_rehearsal,
  11::integer as scenarios_checked;
