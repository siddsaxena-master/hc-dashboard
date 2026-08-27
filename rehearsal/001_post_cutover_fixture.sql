-- SANDBOX ONLY. Never run this file against production.
--
-- Synthetic rows for migration 016 through 018 behavior tests. Run only after
-- 015, 016, 017, and 018 are active in the hc-field-rehearsal project.

begin;

do $guard$
begin
  if (select count(*) from auth.users) <> 1
     or not exists (
       select 1
       from auth.users
       where lower(email) = 'siddsaxena@gmail.com'
         and email_confirmed_at is not null
     ) then
    raise exception using
      errcode = '55000',
      message = 'sandbox fixture blocked: expected exactly one confirmed Sidd Auth user';
  end if;

  if exists (
    select 1
    from public.field_workers
    where lower(email) not in (
      'siddsaxena@gmail.com',
      'worker@sandbox.invalid'
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'sandbox fixture blocked: unrelated roster rows exist';
  end if;

  if exists (
    select 1
    from public.orders
    where client_name not like 'Sandbox %'
  ) then
    raise exception using
      errcode = '55000',
      message = 'sandbox fixture blocked: non-sandbox orders exist';
  end if;
end
$guard$;

insert into public.field_workers (
  id,
  email,
  name,
  market,
  role,
  active,
  hourly_rate_cents
)
values (
  '00000000-0000-4000-8000-000000000103',
  'worker@sandbox.invalid',
  'Sandbox Worker',
  'ny',
  'team',
  false,
  2400
)
on conflict (id) do update
set email = excluded.email,
    name = excluded.name,
    market = excluded.market,
    role = excluded.role,
    active = excluded.active,
    hourly_rate_cents = excluded.hourly_rate_cents,
    auth_user_id = null;

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
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000103',
    'Sandbox Worker',
    'worker@sandbox.invalid',
    'ny',
    '2026-08-25T13:00:00Z',
    '2026-08-25T14:00:00Z',
    'sandbox-fixture',
    null,
    null,
    null
  ),
  (
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000103',
    'Sandbox Worker',
    'worker@sandbox.invalid',
    'ny',
    '2026-08-25T15:00:00Z',
    '2026-08-25T17:00:00Z',
    'sandbox-fixture',
    null,
    null,
    null
  ),
  (
    '00000000-0000-4000-8000-000000000203',
    '00000000-0000-4000-8000-000000000103',
    'Sandbox Worker',
    'worker@sandbox.invalid',
    'ny',
    '2026-08-25T18:00:00Z',
    '2026-08-25T19:30:00Z',
    'sandbox-fixture',
    null,
    null,
    null
  ),
  (
    '00000000-0000-4000-8000-000000000601',
    '00000000-0000-4000-8000-000000000103',
    'Sandbox Worker',
    'worker@sandbox.invalid',
    'ny',
    now() - interval '30 minutes',
    null,
    'sandbox-fixture',
    null,
    null,
    null
  ),
  (
    '00000000-0000-4000-8000-000000000602',
    null,
    'App Review',
    'appreview@hamptonscoconuts.com',
    'ny',
    now() - interval '20 minutes',
    null,
    'sandbox-fixture',
    null,
    null,
    null
  )
on conflict (id) do update
set field_worker_id = excluded.field_worker_id,
    worker_name = excluded.worker_name,
    worker_email = excluded.worker_email,
    market = excluded.market,
    clock_in_at = excluded.clock_in_at,
    clock_out_at = excluded.clock_out_at,
    device = excluded.device,
    paid_at = null,
    paid_cents = null,
    paid_minutes = null;

insert into public.live_activity_tokens (
  id,
  email,
  token_type,
  shift_id,
  token,
  device_id,
  updated_at
)
values
  (
    '00000000-0000-4000-8000-000000000501',
    'siddsaxena@gmail.com',
    'push_to_start',
    null,
    repeat('a', 64),
    '00000000-0000-4000-8000-000000000401',
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000502',
    'siddsaxena@gmail.com',
    'push_to_start',
    null,
    repeat('b', 64),
    '00000000-0000-4000-8000-000000000402',
    now()
  )
on conflict (id) do update
set email = excluded.email,
    token_type = excluded.token_type,
    shift_id = excluded.shift_id,
    token = excluded.token,
    device_id = excluded.device_id,
    updated_at = excluded.updated_at,
    end_requested_at = null,
    end_queue_id = null;

commit;
