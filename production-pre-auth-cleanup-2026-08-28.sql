-- Production-only release cleanup for the HC Field authenticated canary.
--
-- TARGET: Supabase production project omdcfphbwuwsrffdszlg.
-- DO NOT RUN without Sidd's explicit "yes do it" approval.
--
-- This transaction:
-- 1. Closes exactly four stale App Review test shifts at zero duration.
-- 2. Adds one audit-trail entry for each forced test-shift closure.
-- 3. Deactivates only the obsolete Gmail owner roster row.
-- 4. Removes only that Gmail identity's normal push and Push-to-Start rows.
-- 5. Preserves every closed-shift Activity Update row.
--
-- Every expected count and identity is checked before any change can commit.
-- This is intentionally one-shot and fail-closed. After a successful commit,
-- rerun only the final cleanup_proof SELECT, not the transaction above it.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Hold writes long enough to make the preflight checks and final changes one
-- atomic snapshot. A busy table makes the transaction fail instead of racing.
lock table
  public.shifts,
  public.shift_edits,
  public.field_workers,
  public.push_tokens,
  public.live_activity_tokens,
  auth.users
in share row exclusive mode;

do $cleanup$
declare
  v_count integer;
  v_activity_update_row_ids_before uuid[];
  v_activity_update_row_ids_after uuid[];
begin
  -- This file belongs before account creation and before any part of 015.
  select count(*)
  into v_count
  from auth.users;

  if v_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'pre-auth cleanup requires zero Auth users, found %s',
        v_count
      );
  end if;

  if to_regprocedure('public.hc_claim_field_worker()') is not null
     or exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'field_workers'
         and column_name = 'auth_user_id'
     )
     or exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'shifts'
         and column_name = 'field_worker_id'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'migration 015 appears partially or fully applied; stop and investigate';
  end if;

  -- Stop if anyone has started a real shift since the read-only audit.
  select count(*)
  into v_count
  from public.shifts
  where clock_out_at is null;

  if v_count <> 4 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected exactly 4 total open shifts before cleanup, found %s',
        v_count
      );
  end if;

  -- Match the four audited App Review rows by both immutable ID and timestamp.
  with expected(id, clock_in_at) as (
    values
      (
        'dcb2d664-421f-4fb6-9e2c-360857e767e2'::uuid,
        '2026-08-06T23:05:01.787553+00:00'::timestamptz
      ),
      (
        '2bc8ffa9-aac6-47a3-8754-1541ade36b76'::uuid,
        '2026-08-08T06:04:12.493502+00:00'::timestamptz
      ),
      (
        'c5776606-323c-4dc1-b844-3064840fb03d'::uuid,
        '2026-08-09T22:41:16.603667+00:00'::timestamptz
      ),
      (
        '6efe5333-596d-483d-a4c3-505f811cb350'::uuid,
        '2026-08-14T21:17:50.502023+00:00'::timestamptz
      )
  )
  select count(*)
  into v_count
  from expected
  join public.shifts as shift
    on shift.id = expected.id
   and shift.clock_in_at = expected.clock_in_at
  where shift.clock_out_at is null
    and lower(shift.worker_email) = 'appreview@hamptonscoconuts.com'
    and lower(shift.worker_name) = 'app review'
    and shift.paid_at is null;

  if v_count <> 4 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected all 4 audited App Review shifts to remain open, matched %s',
        v_count
      );
  end if;

  -- Confirm both owner identities before changing the obsolete one.
  select count(*)
  into v_count
  from public.field_workers
  where id = '22df0463-aead-43d0-801b-bc9c4b58a302'::uuid
    and lower(email) = 'siddsaxena@gmail.com'
    and lower(trim(role)) = 'owner'
    and active is true;

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'obsolete Gmail owner row no longer matches the approved cleanup';
  end if;

  select count(*)
  into v_count
  from public.push_tokens as obsolete
  join public.push_tokens as canonical
    on lower(canonical.email) = 'sidd@hamptonscoconuts.com'
   and canonical.apns_token is not distinct from obsolete.apns_token
  where lower(obsolete.email) = 'siddsaxena@gmail.com';

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'obsolete Gmail normal push row is not one exact duplicate of the canonical owner row; matched %s',
        v_count
      );
  end if;

  select count(*)
  into v_count
  from public.field_workers
  where id = '1e93f7bf-e232-4b36-a58a-5f1d0210f397'::uuid
    and lower(email) = 'sidd@hamptonscoconuts.com'
    and lower(trim(role)) = 'owner'
    and active is true;

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'canonical company owner row no longer matches the approved cleanup';
  end if;

  -- The read-only audit found exactly one obsolete normal push destination and
  -- one obsolete Push-to-Start destination. Abort if that scope changed.
  select count(*)
  into v_count
  from public.push_tokens
  where lower(email) = 'siddsaxena@gmail.com';

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected 1 obsolete Gmail normal push row, found %s',
        v_count
      );
  end if;

  select count(*)
  into v_count
  from public.live_activity_tokens
  where lower(email) = 'siddsaxena@gmail.com'
    and token_type = 'push_to_start'
    and shift_id is null;

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected 1 obsolete Gmail Push-to-Start row, found %s',
        v_count
      );
  end if;

  select count(*)
  into v_count
  from public.live_activity_tokens
  where lower(email) = 'siddsaxena@gmail.com';

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected exactly 1 total obsolete Gmail Live Activity row, found %s',
        v_count
      );
  end if;

  select count(*)
  into v_count
  from public.live_activity_tokens as obsolete
  join public.live_activity_tokens as canonical
    on lower(canonical.email) = 'sidd@hamptonscoconuts.com'
   and canonical.token_type = 'push_to_start'
   and canonical.shift_id is null
   and canonical.token is not distinct from obsolete.token
  where lower(obsolete.email) = 'siddsaxena@gmail.com'
    and obsolete.token_type = 'push_to_start'
    and obsolete.shift_id is null;

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'obsolete Gmail Push-to-Start row is not one exact duplicate of the canonical owner row; matched %s',
        v_count
      );
  end if;

  select array_agg(id order by id)
  into v_activity_update_row_ids_before
  from public.live_activity_tokens
  where token_type = 'activity_update'
    and shift_id is not null;

  if coalesce(cardinality(v_activity_update_row_ids_before), 0) <> 8 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected exactly 8 closed-shift Activity Update rows, found %s',
        coalesce(cardinality(v_activity_update_row_ids_before), 0)
      );
  end if;

  with expected(shift_id) as (
    values
      ('25adbc4a-59cd-45db-a5a9-05e09c8e6118'::uuid),
      ('d2f1a4c4-3598-4ad0-82ba-59ffa0bdf9ec'::uuid),
      ('84a22a42-c241-4c44-a129-337aea624429'::uuid),
      ('5a2642f6-3044-4a34-ae46-ef9f22287845'::uuid),
      ('cce0902b-df50-473a-9b9a-e57d75028c06'::uuid),
      ('84e22070-e9dd-44c2-bcb2-8b6958f85b46'::uuid),
      ('7de8e5a6-b6e4-4a3c-81ca-d7ba704c6419'::uuid),
      ('a21f91fd-1e1b-4741-a8fa-7df5ddd7732b'::uuid)
  )
  select count(distinct token.shift_id)
  into v_count
  from expected
  join public.live_activity_tokens as token
    on token.shift_id = expected.shift_id
   and token.token_type = 'activity_update'
  join public.shifts as shift on shift.id = expected.shift_id
  where shift.clock_out_at is not null;

  if v_count <> 8 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'expected all 8 audited Activity Update rows to belong to closed shifts, matched %s',
        v_count
      );
  end if;

  update public.shifts
  set clock_out_at = clock_in_at,
      clock_out_lat = null,
      clock_out_lng = null
  where id in (
      'dcb2d664-421f-4fb6-9e2c-360857e767e2'::uuid,
      '2bc8ffa9-aac6-47a3-8754-1541ade36b76'::uuid,
      'c5776606-323c-4dc1-b844-3064840fb03d'::uuid,
      '6efe5333-596d-483d-a4c3-505f811cb350'::uuid
    )
    and lower(worker_email) = 'appreview@hamptonscoconuts.com'
    and clock_out_at is null;

  get diagnostics v_count = row_count;
  if v_count <> 4 then
    raise exception using
      errcode = 'P0001',
      message = format('expected to close 4 App Review shifts, closed %s', v_count);
  end if;

  insert into public.shift_edits (
    shift_id,
    editor_email,
    old_clock_in,
    old_clock_out,
    new_clock_in,
    new_clock_out,
    note
  )
  select
    shift.id,
    'sidd@hamptonscoconuts.com',
    shift.clock_in_at,
    null,
    shift.clock_in_at,
    shift.clock_out_at,
    'pre-auth release cleanup: close stale App Review test shift'
  from public.shifts as shift
  where shift.id in (
      'dcb2d664-421f-4fb6-9e2c-360857e767e2'::uuid,
      '2bc8ffa9-aac6-47a3-8754-1541ade36b76'::uuid,
      'c5776606-323c-4dc1-b844-3064840fb03d'::uuid,
      '6efe5333-596d-483d-a4c3-505f811cb350'::uuid
    )
    and shift.clock_out_at = shift.clock_in_at;

  get diagnostics v_count = row_count;
  if v_count <> 4 then
    raise exception using
      errcode = 'P0001',
      message = format('expected to audit 4 App Review closures, audited %s', v_count);
  end if;

  update public.field_workers
  set active = false
  where id = '22df0463-aead-43d0-801b-bc9c4b58a302'::uuid
    and lower(email) = 'siddsaxena@gmail.com'
    and lower(trim(role)) = 'owner'
    and active is true;

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format('expected to deactivate 1 Gmail owner row, changed %s', v_count);
  end if;

  delete from public.push_tokens
  where lower(email) = 'siddsaxena@gmail.com';

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format('expected to remove 1 Gmail normal push row, removed %s', v_count);
  end if;

  delete from public.live_activity_tokens
  where lower(email) = 'siddsaxena@gmail.com'
    and token_type = 'push_to_start'
    and shift_id is null;

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format('expected to remove 1 Gmail Push-to-Start row, removed %s', v_count);
  end if;

  -- Final invariants. Any failure rolls back every change above.
  select count(*)
  into v_count
  from public.shifts
  where clock_out_at is null;

  if v_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = format('expected zero open shifts after cleanup, found %s', v_count);
  end if;

  select count(*)
  into v_count
  from public.field_workers
  where active is true
    and lower(trim(role)) = 'owner';

  if v_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format('expected exactly 1 active owner after cleanup, found %s', v_count);
  end if;

  select array_agg(id order by id)
  into v_activity_update_row_ids_after
  from public.live_activity_tokens
  where token_type = 'activity_update'
    and shift_id is not null;

  if v_activity_update_row_ids_after is distinct from v_activity_update_row_ids_before then
    raise exception using
      errcode = 'P0001',
      message = 'closed-shift Activity Update row identities changed unexpectedly';
  end if;
end
$cleanup$;

commit;

select jsonb_pretty(jsonb_build_object(
  'open_shift_count', (
    select count(*) from public.shifts where clock_out_at is null
  ),
  'active_owner_emails', (
    select jsonb_agg(lower(email) order by lower(email))
    from public.field_workers
    where active is true and lower(trim(role)) = 'owner'
  ),
  'obsolete_gmail_push_rows', (
    select count(*)
    from public.push_tokens
    where lower(email) = 'siddsaxena@gmail.com'
  ),
  'obsolete_gmail_live_rows', (
    select count(*)
    from public.live_activity_tokens
    where lower(email) = 'siddsaxena@gmail.com'
  ),
  'closed_activity_update_rows', (
    select count(*)
    from public.live_activity_tokens
    where token_type = 'activity_update' and shift_id is not null
  )
)) as cleanup_proof;
