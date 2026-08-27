-- ============================================================================
-- SANDBOX ONLY: 007_delivery_confirmation_runtime_checks.sql
--
-- Run only after migration 026 on hc-field-rehearsal. Synthetic orders and
-- temporary roster changes are exercised through the real RPC and rolled back.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_owner_auth_user_id uuid;
  v_owner_worker_id uuid;
  v_profile record;
  v_confirmed boolean;
  v_rejected boolean;
  v_signed_at timestamptz := pg_catalog.clock_timestamp() - interval '1 minute';
  v_stale_signed_at timestamptz := pg_catalog.clock_timestamp() - interval '2 minutes';

  v_order_good constant uuid := '00000000-0000-4000-8000-000000002601';
  v_order_other constant uuid := '00000000-0000-4000-8000-000000002602';
  v_order_signed constant uuid := '00000000-0000-4000-8000-000000002603';
  v_order_recurring constant uuid := '00000000-0000-4000-8000-000000002604';
  v_order_inquiry constant uuid := '00000000-0000-4000-8000-000000002605';
  v_order_cancelled constant uuid := '00000000-0000-4000-8000-000000002606';
  v_order_cross_market constant uuid := '00000000-0000-4000-8000-000000002607';

  v_request_good constant uuid := '00000000-0000-4000-8000-000000002611';
  v_request_different constant uuid := '00000000-0000-4000-8000-000000002612';
  v_request_stale constant uuid := '00000000-0000-4000-8000-000000002613';
  v_request_signed constant uuid := '00000000-0000-4000-8000-000000002614';
  v_request_recurring constant uuid := '00000000-0000-4000-8000-000000002615';
  v_request_inquiry constant uuid := '00000000-0000-4000-8000-000000002616';
  v_request_cancelled constant uuid := '00000000-0000-4000-8000-000000002617';
  v_request_cross_market constant uuid := '00000000-0000-4000-8000-000000002618';
begin
  if pg_catalog.to_regprocedure(
       'public.hc_claim_field_worker_v2()'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_confirm_order_delivery_v2(uuid,uuid,timestamp with time zone,text,text,text)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: migration 026 is not installed';
  end if;

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

  select worker.auth_user_id, worker.id
  into v_owner_auth_user_id, v_owner_worker_id
  from public.field_workers as worker
  where worker.active is true
    and pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'owner'
    and worker.auth_user_id is not null
  order by worker.created_at asc nulls last, worker.id asc
  limit 1;

  if v_owner_auth_user_id is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: linked active owner is missing';
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

  select *
  into v_profile
  from public.hc_claim_field_worker_v2();

  if v_profile.auth_user_id is distinct from v_owner_auth_user_id
     or pg_catalog.lower(v_profile.email) <> 'siddsaxena@gmail.com'
     or pg_catalog.lower(pg_catalog.btrim(v_profile.role)) <> 'owner' then
    raise exception using
      errcode = '55000',
      message = 'v2 profile claim did not bind the immutable Auth UUID';
  end if;

  insert into public.orders (
    id,
    client_name,
    event_start_at,
    delivery_at_utc,
    stage,
    market,
    is_recurring,
    cancelled_at,
    delivery_signed_at,
    delivery_signed_by
  ) values
    (
      v_order_good,
      'Sandbox Delivery Good',
      pg_catalog.clock_timestamp() + interval '1 day',
      pg_catalog.clock_timestamp() + interval '1 day',
      'paid_full',
      'ny',
      false,
      null,
      null,
      null
    ),
    (
      v_order_other,
      'Sandbox Delivery Other',
      pg_catalog.clock_timestamp() + interval '2 days',
      null,
      'invoiced',
      'ny',
      false,
      null,
      null,
      null
    ),
    (
      v_order_signed,
      'Sandbox Delivery Already Signed',
      pg_catalog.clock_timestamp() + interval '3 days',
      null,
      'deposit_paid',
      'ny',
      false,
      null,
      pg_catalog.clock_timestamp() - interval '1 day',
      'Prior Receiver'
    ),
    (
      v_order_recurring,
      'Sandbox Delivery Recurring',
      pg_catalog.clock_timestamp() + interval '4 days',
      null,
      'paid_full',
      'ny',
      true,
      null,
      null,
      null
    ),
    (
      v_order_inquiry,
      'Sandbox Delivery Inquiry',
      pg_catalog.clock_timestamp() + interval '5 days',
      null,
      'inquiry',
      'ny',
      false,
      null,
      null,
      null
    ),
    (
      v_order_cancelled,
      'Sandbox Delivery Cancelled',
      pg_catalog.clock_timestamp() + interval '6 days',
      null,
      'cancelled',
      'ny',
      false,
      pg_catalog.clock_timestamp(),
      null,
      null
    ),
    (
      v_order_cross_market,
      'Sandbox Delivery Cross Market',
      pg_catalog.clock_timestamp() + interval '7 days',
      null,
      'fulfilled',
      'nj',
      false,
      null,
      null,
      null
    );

  select public.hc_confirm_order_delivery_v2(
    v_request_good,
    v_order_good,
    v_signed_at,
    'Sandbox Receiver',
    'data:image/png;base64,AA==',
    'dashboard'
  ) into v_confirmed;

  if v_confirmed is not true then
    raise exception using
      errcode = '55000',
      message = 'initial delivery confirmation was rejected';
  end if;

  -- Exact retry models a committed RPC whose HTTP response was lost.
  select public.hc_confirm_order_delivery_v2(
    v_request_good,
    v_order_good,
    v_signed_at,
    'Sandbox Receiver',
    'data:image/png;base64,AA==',
    'dashboard'
  ) into v_confirmed;

  if v_confirmed is not true
     or (
       select pg_catalog.count(*)
       from public.delivery_signatures
       where order_id = v_order_good
     ) <> 1
     or not exists (
       select 1
       from public.delivery_signatures
       where order_id = v_order_good
         and delivery_request_id = v_request_good
         and actor_auth_user_id = v_owner_auth_user_id
         and delivery_source = 'dashboard'
         and is_authoritative is true
         and signed_at = v_signed_at
         and signed_by = 'Sandbox Receiver'
         and signature_data_url = 'data:image/png;base64,AA=='
     )
     or not exists (
       select 1
       from public.orders
       where id = v_order_good
         and delivery_signed_at = v_signed_at
         and delivery_signed_by = 'Sandbox Receiver'
     ) then
    raise exception using
      errcode = '55000',
      message = 'lost-response retry was not exactly idempotent';
  end if;

  -- The same request UUID cannot be rebound to a changed payload.
  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_good,
      v_order_good,
      v_signed_at,
      'Different Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when unique_violation then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'same request UUID accepted a mismatched payload';
  end if;

  -- The same request UUID cannot be rebound to another order.
  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_good,
      v_order_other,
      v_signed_at,
      'Sandbox Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when unique_violation then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'same request UUID accepted a different order';
  end if;

  -- A second request and an older stale request cannot replace the winner.
  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_different,
      v_order_good,
      v_signed_at,
      'Sandbox Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when unique_violation then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'different request replaced an authoritative confirmation';
  end if;

  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_stale,
      v_order_good,
      v_stale_signed_at,
      'Stale Receiver',
      'data:image/png;base64,AQ==',
      'dashboard'
    );
  exception
    when unique_violation then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'stale request overwrote a newer confirmation';
  end if;

  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_signed,
      v_order_signed,
      v_signed_at,
      'Second Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when unique_violation then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'already-signed order accepted another confirmation';
  end if;

  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_recurring,
      v_order_recurring,
      v_signed_at,
      'Recurring Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when invalid_parameter_value then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'recurring template accepted a delivery confirmation';
  end if;

  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_inquiry,
      v_order_inquiry,
      v_signed_at,
      'Inquiry Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when invalid_parameter_value then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'inquiry accepted a delivery confirmation';
  end if;

  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_cancelled,
      v_order_cancelled,
      v_signed_at,
      'Cancelled Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when invalid_parameter_value then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'cancelled order accepted a delivery confirmation';
  end if;

  update public.field_workers
  set role = 'manager',
      market = 'ny'
  where id = v_owner_worker_id;

  -- An exact accepted request can clear a lost-response queue even if an owner
  -- moved the order after the first commit. It returns no order data and writes
  -- nothing on replay.
  update public.orders
  set market = 'nj'
  where id = v_order_good;

  select public.hc_confirm_order_delivery_v2(
    v_request_good,
    v_order_good,
    v_signed_at,
    'Sandbox Receiver',
    'data:image/png;base64,AA==',
    'dashboard'
  ) into v_confirmed;

  if v_confirmed is not true
     or (
       select pg_catalog.count(*)
       from public.delivery_signatures
       where order_id = v_order_good
     ) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'exact replay failed after a later order market change';
  end if;

  v_rejected := false;
  begin
    perform public.hc_confirm_order_delivery_v2(
      v_request_cross_market,
      v_order_cross_market,
      v_signed_at,
      'Cross Market Receiver',
      'data:image/png;base64,AA==',
      'dashboard'
    );
  exception
    when insufficient_privilege then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception using
      errcode = '55000',
      message = 'manager confirmed a delivery outside the exact roster market';
  end if;

  if (
       select pg_catalog.count(*)
       from public.delivery_signatures
       where order_id in (
         v_order_good,
         v_order_other,
         v_order_signed,
         v_order_recurring,
         v_order_inquiry,
         v_order_cancelled,
         v_order_cross_market
       )
     ) <> 1
     or not exists (
       select 1
       from public.orders
       where id = v_order_good
         and delivery_signed_at = v_signed_at
         and delivery_signed_by = 'Sandbox Receiver'
     ) then
    raise exception using
      errcode = '55000',
      message = 'a rejected scenario left a partial signature or changed the winner';
  end if;
end
$test$;

rollback;

select
  'passed'::text as delivery_confirmation_integrity_rehearsal,
  12::integer as scenarios_checked;
