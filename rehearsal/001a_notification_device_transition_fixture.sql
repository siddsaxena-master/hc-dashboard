-- ============================================================================
-- SANDBOX ONLY: 001a_notification_device_transition_fixture.sql
--
-- Run only after rehearsal 001 and migration 021, then before migration 022,
-- on the disposable hc-field-rehearsal project. It authorizes the two fixed
-- Push-to-Start fixture devices so migration 022 can enforce device ownership.
-- The generated revoke capabilities are deliberately discarded inside this
-- transaction. No raw capability or notification token is selected or printed.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $fixture$
declare
  v_owner_auth_user_id uuid;
  v_owner_worker_id uuid;
  v_device_ids constant uuid[] := array[
    '00000000-0000-4000-8000-000000000401'::uuid,
    '00000000-0000-4000-8000-000000000402'::uuid
  ];
  v_device_id uuid;
begin
  if pg_catalog.to_regclass(
       'public.notification_device_authorizations'
     ) is null
     or pg_catalog.to_regclass(
       'public.notification_device_security_state'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_authorize_notification_device(uuid)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: migration 021 is not installed';
  end if;

  if not exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and cutover_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: run this before migration 022';
  end if;

  if (select pg_catalog.count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where pg_catalog.lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected exactly one confirmed Sidd Auth user';
  end if;

  if exists (
    select 1
    from public.field_workers
    where pg_catalog.lower(email) not in (
      'siddsaxena@gmail.com',
      'worker@sandbox.invalid'
    )
  ) or exists (
    select 1
    from public.orders
    where client_name not like 'Sandbox %'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: unrelated roster or order data exists';
  end if;

  select worker.auth_user_id, worker.id
  into v_owner_auth_user_id, v_owner_worker_id
  from public.field_workers as worker
  join auth.users as auth_user
    on auth_user.id = worker.auth_user_id
   and auth_user.email_confirmed_at is not null
   and pg_catalog.lower(auth_user.email) = pg_catalog.lower(worker.email)
  where worker.active is true
    and worker.role = 'owner'
    and pg_catalog.lower(worker.email) = 'siddsaxena@gmail.com'
  limit 1;

  if v_owner_auth_user_id is null or v_owner_worker_id is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: linked active owner is missing';
  end if;

  if not exists (
    select 1
    from public.field_workers
    where id = '00000000-0000-4000-8000-000000000103'::uuid
      and pg_catalog.lower(email) = 'worker@sandbox.invalid'
      and active is false
  ) or (
    select pg_catalog.count(*)
    from public.shifts
    where id in (
      '00000000-0000-4000-8000-000000000601'::uuid,
      '00000000-0000-4000-8000-000000000602'::uuid
    )
      and clock_out_at is null
      and device = 'sandbox-fixture'
  ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: rehearsal 001 fixture is missing';
  end if;

  if (
    select pg_catalog.count(*)
    from public.live_activity_tokens
    where id in (
      '00000000-0000-4000-8000-000000000501'::uuid,
      '00000000-0000-4000-8000-000000000502'::uuid
    )
      and pg_catalog.lower(email) = 'siddsaxena@gmail.com'
      and token_type = 'push_to_start'
      and shift_id is null
      and device_id = any(v_device_ids)
  ) <> 2
     or (select pg_catalog.count(*) from public.live_activity_tokens) <> 2
     or exists (select 1 from public.push_tokens) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: expected only the two fixed Push-to-Start rows';
  end if;

  if exists (
    select 1
    from public.notification_device_authorizations as device_auth
    where not (device_auth.device_id = any(v_device_ids))
       or device_auth.auth_user_id <> v_owner_auth_user_id
       or device_auth.field_worker_id <> v_owner_worker_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: unrelated or mismatched device authorization exists';
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

  foreach v_device_id in array v_device_ids loop
    -- PERFORM executes the authorization RPC while discarding its one-time
    -- capability. This fixture never selects or prints that secret.
    perform *
    from public.hc_authorize_notification_device(v_device_id);
  end loop;

  if (
    select pg_catalog.count(*)
    from public.notification_device_authorizations as device_auth
    where device_auth.device_id = any(v_device_ids)
      and device_auth.auth_user_id = v_owner_auth_user_id
      and device_auth.field_worker_id = v_owner_worker_id
      and pg_catalog.octet_length(device_auth.revoke_secret_hash) = 32
      and device_auth.secret_version >= 1
      and device_auth.revoked_at is null
  ) <> 2
     or (select pg_catalog.count(*)
         from public.notification_device_authorizations) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: both fixture devices were not authorized exactly';
  end if;

  if exists (
    select 1
    from public.push_tokens as token_row
    where not exists (
      select 1
      from public.notification_device_authorizations as device_auth
      join public.field_workers as worker
        on worker.id = device_auth.field_worker_id
       and worker.auth_user_id = device_auth.auth_user_id
       and worker.active is true
       and worker.role in ('owner', 'manager')
      where device_auth.device_id = token_row.device_id
        and device_auth.revoked_at is null
        and pg_catalog.lower(worker.email) = pg_catalog.lower(token_row.email)
    )
  ) or exists (
    select 1
    from public.live_activity_tokens as token_row
    where token_row.token_type = 'push_to_start'
      and token_row.shift_id is null
      and not exists (
        select 1
        from public.notification_device_authorizations as device_auth
        join public.field_workers as worker
          on worker.id = device_auth.field_worker_id
         and worker.auth_user_id = device_auth.auth_user_id
         and worker.active is true
         and worker.role in ('owner', 'manager')
        where device_auth.device_id = token_row.device_id
          and device_auth.revoked_at is null
          and pg_catalog.lower(worker.email) = pg_catalog.lower(token_row.email)
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: migration 022 authorization gate is not zero';
  end if;
end
$fixture$;

commit;
