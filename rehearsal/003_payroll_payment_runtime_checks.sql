-- ============================================================================
-- SANDBOX ONLY: 003_payroll_payment_runtime_checks.sql
--
-- Run only after migration 023 on the disposable hc-field-rehearsal project.
-- The fixed fixture IDs and one-user guard prevent accidental use elsewhere.
-- Every payment, timestamp change, and audit assertion is rolled back.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_owner_auth_user_id uuid;
  v_shift_1 constant uuid := '00000000-0000-4000-8000-000000000201';
  v_shift_2 constant uuid := '00000000-0000-4000-8000-000000000202';
  v_shift_3 constant uuid := '00000000-0000-4000-8000-000000000203';
  v_clock_in timestamptz;
  v_clock_out timestamptz;
  v_rate_cents integer;
  v_paid_count integer;
  v_batch_items jsonb;
begin
  if (select count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     )
     or not exists (
       select 1
       from public.field_workers
       where id = '00000000-0000-4000-8000-000000000103'::uuid
         and lower(email) = 'worker@sandbox.invalid'
     )
     or (
       select count(*)
       from public.shifts
       where id in (v_shift_1, v_shift_2, v_shift_3)
         and device = 'sandbox-fixture'
     ) <> 3 then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: fixed payroll fixture is missing';
  end if;

  if exists (
    select 1
    from public.shifts
    where id in (v_shift_1, v_shift_2, v_shift_3)
      and paid_at is not null
  ) or exists (
    select 1
    from public.shift_payment_records
    where shift_id in (v_shift_1, v_shift_2, v_shift_3)
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: payroll fixture is already paid';
  end if;

  select fw.auth_user_id
  into v_owner_auth_user_id
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

  select s.clock_in_at, s.clock_out_at, fw.hourly_rate_cents
  into v_clock_in, v_clock_out, v_rate_cents
  from public.shifts as s
  join public.field_workers as fw on fw.id = s.field_worker_id
  where s.id = v_shift_1;

  select public.hc_mark_shifts_paid(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'shift_id', v_shift_1,
        'expected_clock_in_at', v_clock_in,
        'expected_clock_out_at', v_clock_out,
        'expected_rate_cents', v_rate_cents
      )
    ),
    null
  )
  into v_paid_count;

  if v_paid_count <> 1
     or not exists (
       select 1
       from public.shifts
       where id = v_shift_1
         and paid_at is not null
         and paid_minutes = 60
         and paid_cents = 2400
     )
     or not exists (
       select 1
       from public.shift_payment_records
       where shift_id = v_shift_1
         and paid_minutes = 60
         and hourly_rate_cents = 2400
         and paid_cents = 2400
         and worker_email = 'worker@sandbox.invalid'
         and payer_email = 'siddsaxena@gmail.com'
         and payment_note is null
     ) then
    raise exception using
      errcode = '55000',
      message = 'individual shift payment or audit snapshot is incorrect';
  end if;

  begin
    perform public.hc_mark_shifts_paid(
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'shift_id', v_shift_1,
          'expected_clock_in_at', v_clock_in,
          'expected_clock_out_at', v_clock_out,
          'expected_rate_cents', v_rate_cents
        )
      ),
      null
    );
    raise exception using
      errcode = '55000',
      message = 'already-paid shift was accepted';
  exception
    when unique_violation then
      null;
  end;

  update public.shifts
  set clock_out_at = clock_in_at
  where id = v_shift_2;

  select s.clock_in_at, s.clock_out_at, fw.hourly_rate_cents
  into v_clock_in, v_clock_out, v_rate_cents
  from public.shifts as s
  join public.field_workers as fw on fw.id = s.field_worker_id
  where s.id = v_shift_2;

  begin
    perform public.hc_mark_shifts_paid(
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'shift_id', v_shift_2,
          'expected_clock_in_at', v_clock_in,
          'expected_clock_out_at', v_clock_out,
          'expected_rate_cents', v_rate_cents
        )
      ),
      null
    );
    raise exception using
      errcode = '55000',
      message = 'zero-minute shift was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  update public.shifts
  set clock_out_at = clock_in_at + interval '25 hours'
  where id = v_shift_3;

  select s.clock_in_at, s.clock_out_at, fw.hourly_rate_cents
  into v_clock_in, v_clock_out, v_rate_cents
  from public.shifts as s
  join public.field_workers as fw on fw.id = s.field_worker_id
  where s.id = v_shift_3;

  begin
    perform public.hc_mark_shifts_paid(
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'shift_id', v_shift_3,
          'expected_clock_in_at', v_clock_in,
          'expected_clock_out_at', v_clock_out,
          'expected_rate_cents', v_rate_cents
        )
      ),
      null
    );
    raise exception using
      errcode = '55000',
      message = 'shift longer than 24 hours was accepted';
  exception
    when invalid_parameter_value then
      null;
  end;

  update public.shifts
  set clock_out_at = case id
    when v_shift_2 then '2026-08-25T17:00:00Z'::timestamptz
    when v_shift_3 then '2026-08-25T19:30:00Z'::timestamptz
  end
  where id in (v_shift_2, v_shift_3);

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'shift_id', s.id,
      'expected_clock_in_at', s.clock_in_at,
      'expected_clock_out_at', s.clock_out_at,
      'expected_rate_cents', case
        when s.id = v_shift_3 then fw.hourly_rate_cents + 1
        else fw.hourly_rate_cents
      end
    ) order by s.id
  )
  into v_batch_items
  from public.shifts as s
  join public.field_workers as fw on fw.id = s.field_worker_id
  where s.id in (v_shift_2, v_shift_3);

  begin
    perform public.hc_mark_shifts_paid(v_batch_items, null);
    raise exception using
      errcode = '55000',
      message = 'stale mixed batch was accepted';
  exception
    when serialization_failure then
      null;
  end;

  if exists (
    select 1
    from public.shifts
    where id in (v_shift_2, v_shift_3)
      and paid_at is not null
  ) or exists (
    select 1
    from public.shift_payment_records
    where shift_id in (v_shift_2, v_shift_3)
  ) then
    raise exception using
      errcode = '55000',
      message = 'rejected mixed batch was not atomic';
  end if;

  begin
    update public.shift_payment_records
    set payment_note = 'tampered'
    where shift_id = v_shift_1;
    raise exception using
      errcode = '55000',
      message = 'payment audit update was accepted';
  exception
    when insufficient_privilege then
      null;
  end;

  if (
    select count(*)
    from public.shifts
    where id in (v_shift_1, v_shift_2, v_shift_3)
      and paid_at is not null
  ) <> 1 or (
    select count(*)
    from public.shift_payment_records
    where shift_id in (v_shift_1, v_shift_2, v_shift_3)
  ) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'final payroll test counts are incorrect';
  end if;
end
$test$;

rollback;

select
  'passed'::text as payroll_runtime_rehearsal,
  5::integer as scenarios_checked;
