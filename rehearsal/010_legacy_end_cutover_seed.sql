-- ============================================================================
-- SANDBOX ONLY: 010_legacy_end_cutover_seed.sql
--
-- Run in a fresh disposable Supabase clone after migration 015 and before
-- migration 015a. It creates the exact legacy-token truth table needed to
-- prove the 016 cutoff does not strand an already-running Lock Screen card.
-- Never run this file against production.
-- ============================================================================

begin;

do $guard$
begin
  if pg_catalog.to_regprocedure(
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or not pg_catalog.has_table_privilege(
       'anon', 'public.live_activity_tokens', 'INSERT'
     ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: run this after 015 and before 015a, 016, or 017';
  end if;

  if pg_catalog.to_regclass(
    'hc_migration_private.live_activity_end_015a'
  ) is not null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: 015a provenance already exists';
  end if;

  if not exists (
    select 1
    from public.field_workers as worker_row
    join auth.users as auth_user on auth_user.id = worker_row.auth_user_id
    where worker_row.active is true
      and worker_row.role = 'owner'
      and auth_user.email_confirmed_at is not null
      and lower(auth_user.email) = lower(worker_row.email)
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: one confirmed linked owner is required';
  end if;

  if exists (
    select 1
    from public.field_workers
    where active is true
      and auth_user_id is null
  ) or exists (
    select 1
    from public.shifts
    where clock_out_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: active roster links and a zero-open-shift baseline are required';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens
    where id in (
      '00000000-0000-4000-8000-000000001501',
      '00000000-0000-4000-8000-000000001502',
      '00000000-0000-4000-8000-000000001503',
      '00000000-0000-4000-8000-000000001504',
      '00000000-0000-4000-8000-000000001505'
    )
  ) or exists (
    select 1
    from public.shifts
    where id in (
      '00000000-0000-4000-8000-000000001511',
      '00000000-0000-4000-8000-000000001512',
      '00000000-0000-4000-8000-000000001513'
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX GUARD: legacy END fixture IDs already exist';
  end if;
end
$guard$;

with owner_row as (
  select
    worker_row.id,
    lower(worker_row.email) as email,
    worker_row.name,
    coalesce(nullif(lower(worker_row.market), ''), 'ny') as market
  from public.field_workers as worker_row
  join auth.users as auth_user on auth_user.id = worker_row.auth_user_id
  where worker_row.active is true
    and worker_row.role = 'owner'
    and auth_user.email_confirmed_at is not null
    and lower(auth_user.email) = lower(worker_row.email)
  order by worker_row.created_at asc nulls last, worker_row.id asc
  limit 1
), fixture(shift_id, clock_in_at, clock_out_at) as (
  values
    (
      '00000000-0000-4000-8000-000000001511'::uuid,
      '2026-08-27T12:00:00Z'::timestamptz,
      '2026-08-27T13:00:00Z'::timestamptz
    ),
    (
      '00000000-0000-4000-8000-000000001512'::uuid,
      '2026-08-27T14:00:00Z'::timestamptz,
      null::timestamptz
    ),
    (
      '00000000-0000-4000-8000-000000001513'::uuid,
      '2026-08-27T15:00:00Z'::timestamptz,
      '2026-08-27T16:00:00Z'::timestamptz
    )
)
insert into public.shifts (
  id,
  field_worker_id,
  worker_name,
  worker_email,
  market,
  clock_in_at,
  clock_out_at,
  device
)
select
  fixture.shift_id,
  owner_row.id,
  owner_row.name,
  owner_row.email,
  owner_row.market,
  fixture.clock_in_at,
  fixture.clock_out_at,
  'sandbox-legacy-end-fixture'
from owner_row
cross join fixture;

with owner_row as (
  select lower(worker_row.email) as email
  from public.field_workers as worker_row
  join auth.users as auth_user on auth_user.id = worker_row.auth_user_id
  where worker_row.active is true
    and worker_row.role = 'owner'
    and auth_user.email_confirmed_at is not null
    and lower(auth_user.email) = lower(worker_row.email)
  order by worker_row.created_at asc nulls last, worker_row.id asc
  limit 1
)
insert into public.live_activity_tokens (
  id, email, token_type, shift_id, token, updated_at, device_id
)
select
  fixture.token_id,
  owner_row.email,
  fixture.token_type,
  fixture.shift_id,
  fixture.token,
  clock_timestamp(),
  null
from owner_row
cross join (
  values
    (
      '00000000-0000-4000-8000-000000001501'::uuid,
      'activity_update'::text,
      '00000000-0000-4000-8000-000000001511'::uuid,
      repeat('a', 64)
    ),
    (
      '00000000-0000-4000-8000-000000001502'::uuid,
      'activity_update'::text,
      '00000000-0000-4000-8000-000000001512'::uuid,
      repeat('b', 64)
    ),
    (
      '00000000-0000-4000-8000-000000001503'::uuid,
      'activity_update'::text,
      '00000000-0000-4000-8000-0000000015ff'::uuid,
      repeat('c', 64)
    ),
    (
      '00000000-0000-4000-8000-000000001504'::uuid,
      'push_to_start'::text,
      null::uuid,
      repeat('d', 64)
    ),
    (
      '00000000-0000-4000-8000-000000001505'::uuid,
      'activity_update'::text,
      '00000000-0000-4000-8000-000000001513'::uuid,
      'bad-token'
    )
) as fixture(token_id, token_type, shift_id, token);

do $assertions$
begin
  if (
    select count(*)
    from public.live_activity_tokens
    where id between
      '00000000-0000-4000-8000-000000001501'::uuid
      and '00000000-0000-4000-8000-000000001505'::uuid
  ) <> 5 or exists (
    select 1
    from public.live_activity_tokens
    where id between
      '00000000-0000-4000-8000-000000001501'::uuid
      and '00000000-0000-4000-8000-000000001505'::uuid
      and device_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: five null-device truth-table rows were not created';
  end if;
end
$assertions$;

commit;
