-- ============================================================================
-- SANDBOX ONLY: 002_notification_device_authorization_checks.sql
--
-- Run only after migrations 021 and 022 on the disposable hc-field-rehearsal
-- project. The guard requires the fixed sandbox fixture from 001. The whole
-- test ends with ROLLBACK, so no authorization, token, claim, or secret remains.
-- The generated capability stays inside this DO block and is never selected.
-- ============================================================================

begin;

do $test$
declare
  v_owner_auth_user_id uuid;
  v_owner_worker_id uuid;
  v_owner_email text;
  v_device_id constant uuid := '00000000-0000-4000-8000-000000002101';
  v_shift_id constant uuid := '00000000-0000-4000-8000-000000000601';
  v_app_review_shift_id constant uuid :=
    '00000000-0000-4000-8000-000000000602';
  v_apns_token constant text :=
    '91d6c1bc73964d7980a85a7302bf27ae91d6c1bc73964d7980a85a7302bf27ae';
  v_start_token constant text :=
    'a37f42d68c2e4f2b91a820615c0e97d4a37f42d68c2e4f2b91a820615c0e97d4';
  v_update_token constant text :=
    'c64e90bf108448b9a6f09f8a3db4215ec64e90bf108448b9a6f09f8a3db4215e';
  v_secret_1 text;
  v_secret_2 text;
  v_secret_3 text;
  v_version_1 integer;
  v_version_2 integer;
  v_claim record;
begin
  if not exists (
    select 1
    from public.field_workers
    where lower(email) = 'worker@sandbox.invalid'
  ) or not exists (
    select 1
    from public.shifts
    where id = v_shift_id
      and clock_out_at is null
      and device = 'sandbox-fixture'
  ) or not exists (
    select 1
    from public.shifts
    where id = v_app_review_shift_id
      and lower(worker_email) = 'appreview@hamptonscoconuts.com'
      and clock_out_at is null
      and device = 'sandbox-fixture'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: 001 post-cutover fixture is missing';
  end if;

  select fw.auth_user_id, fw.id, lower(fw.email)
  into v_owner_auth_user_id, v_owner_worker_id, v_owner_email
  from public.field_workers as fw
  where fw.active is true
    and fw.role = 'owner'
    and fw.auth_user_id is not null
  order by fw.created_at asc nulls last, fw.id asc
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

  select device_auth.revoke_secret, device_auth.secret_version
  into v_secret_1, v_version_1
  from public.hc_authorize_notification_device(v_device_id) as device_auth;

  select device_auth.revoke_secret, device_auth.secret_version
  into v_secret_2, v_version_2
  from public.hc_authorize_notification_device(v_device_id) as device_auth;

  if v_secret_1 is null
     or v_secret_2 is null
     or v_secret_1 = v_secret_2
     or length(v_secret_1) <> 64
     or length(v_secret_2) <> 64
     or v_secret_1 !~ '^[0-9a-f]{64}$'
     or v_secret_2 !~ '^[0-9a-f]{64}$'
     or v_version_2 <> v_version_1 + 1 then
    raise exception using
      errcode = '55000',
      message = 'authorization secret rotation failed';
  end if;

  if not exists (
    select 1
    from public.notification_device_authorizations
    where device_id = v_device_id
      and auth_user_id = v_owner_auth_user_id
      and field_worker_id = v_owner_worker_id
      and octet_length(revoke_secret_hash) = 32
      and secret_version = v_version_2
      and revoked_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'authorization row does not store the expected hashed identity';
  end if;

  -- A rotated secret must immediately lose revoke authority.
  if public.hc_revoke_notification_device(v_device_id, v_secret_1) then
    raise exception using
      errcode = '55000',
      message = 'rotated capability secret still revoked the device';
  end if;

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
  perform public.hc_register_live_activity_token(
    'activity_update',
    v_shift_id,
    v_update_token,
    v_device_id,
    true
  );

  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'service_role')::text,
    true
  );

  select claim.*
  into v_claim
  from public.hc_claim_live_activity_starts_v2(
    clock_timestamp(),
    clock_timestamp() - interval '30 minutes',
    clock_timestamp() - interval '48 hours',
    200
  ) as claim
  where claim.device_id = v_device_id
    and claim.shift_id = v_shift_id;

  if v_claim.delivery_id is null
     or v_claim.market is distinct from (
       select shift_row.market
       from public.shifts as shift_row
       where shift_row.id = v_shift_id
     ) then
    raise exception using
      errcode = '55000',
      message = 'START v2 did not return the claimed device and market';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'anon', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'anon')::text,
    true
  );

  if not public.hc_revoke_notification_device(v_device_id, v_secret_2)
     or not public.hc_revoke_notification_device(v_device_id, v_secret_2) then
    raise exception using
      errcode = '55000',
      message = 'exact capability revoke was not idempotent';
  end if;

  if exists (
    select 1 from public.push_tokens where device_id = v_device_id
  ) or exists (
    select 1
    from public.live_activity_tokens
    where device_id = v_device_id
      and token_type = 'push_to_start'
  ) or not exists (
    select 1
    from public.live_activity_tokens
    where device_id = v_device_id
      and token_type = 'activity_update'
      and shift_id = v_shift_id
      and lower(token) = v_update_token
  ) then
    raise exception using
      errcode = '55000',
      message = 'capability revoke did not preserve only the END token';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('role', 'service_role')::text,
    true
  );

  if public.hc_validate_live_activity_start_delivery(
    v_claim.delivery_id,
    v_claim.shift_id,
    v_claim.queue_id,
    v_claim.generation,
    v_start_token
  ) then
    raise exception using
      errcode = '55000',
      message = 'revoked pending START remained valid before Apple send';
  end if;

  -- Reauthorize, then prove the authenticated unregister path creates the same
  -- durable state without deleting the existing activity-update END token.
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_owner_auth_user_id::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object(
      'sub', v_owner_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  select device_auth.revoke_secret
  into v_secret_3
  from public.hc_authorize_notification_device(v_device_id) as device_auth;

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
  perform public.hc_unregister_device(v_device_id);

  if v_secret_3 is null
     or not exists (
       select 1
       from public.notification_device_authorizations
       where device_id = v_device_id
         and revoked_at is not null
         and revoked_reason = 'authenticated sign-out'
     )
     or exists (
       select 1 from public.push_tokens where device_id = v_device_id
     )
     or exists (
       select 1
       from public.live_activity_tokens
       where device_id = v_device_id
         and token_type = 'push_to_start'
     )
     or not exists (
       select 1
       from public.live_activity_tokens
       where device_id = v_device_id
         and token_type = 'activity_update'
         and shift_id = v_shift_id
     ) then
    raise exception using
      errcode = '55000',
      message = 'authenticated unregister was not a durable END-safe revoke';
  end if;

  if exists (
    select 1
    from public.hc_list_managed_open_shift_ids()
    where shift_id = v_app_review_shift_id
  ) or not exists (
    select 1
    from public.hc_list_managed_open_shift_ids()
    where shift_id = v_shift_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'open-shift truth did not exclude only App Review';
  end if;
end
$test$;

rollback;
