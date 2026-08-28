-- ============================================================================
-- 015a_closed_live_activity_end_preservation.sql
-- Preserve legacy Apple Activity Update addresses across migration 016.
--
-- LOCAL MIGRATION FILE ONLY. Run after 015 and before 016. Running this
-- against Supabase is a production write and needs Sidd's explicit
-- "yes do it" confirmation.
--
-- A closed shift's Activity Update token is the only remote address that can
-- dismiss an already-running Lock Screen card. Migration 016 correctly removes
-- every null-device destination, so this narrow bridge gives each valid closed
-- token a deterministic, unique recovery ID before that cutoff. The recovery
-- ID is the token row's own UUID. It is not treated as an authorized phone and
-- cannot create a new Live Activity. Migration 017 can still claim the token,
-- send Apple the final END, and delete the exact row after acceptance.
-- ============================================================================

begin;

set local lock_timeout = '15s';
set local statement_timeout = '2min';

do $preflight$
begin
  if pg_catalog.to_regclass('public.live_activity_tokens') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regprocedure(
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '015a requires migration 015';
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
      message = '015a requires migration 015 device identity';
  end if;

  if not pg_catalog.has_table_privilege(
    'anon', 'public.live_activity_tokens', 'INSERT'
  ) then
    raise exception using
      errcode = '55000',
      message = '015a must run before migration 016';
  end if;

  if pg_catalog.to_regprocedure(
    'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
  ) is not null then
    raise exception using
      errcode = '55000',
      message = '015a must run before migration 017';
  end if;
end
$preflight$;

-- Keep an owner-only provenance record. The table stores roster metadata, not
-- the Apple token. It is the proof a self-equal device_id came from 015a and
-- makes the rollback incapable of touching a coincidental pre-existing row.
create schema if not exists hc_migration_private;
revoke all on schema hc_migration_private from public, anon, authenticated, service_role;

create table if not exists hc_migration_private.live_activity_end_015a (
  token_id uuid primary key,
  shift_id uuid not null,
  email text not null,
  marked_at timestamptz not null default clock_timestamp(),
  constraint live_activity_end_015a_email_normalized
    check (email = lower(trim(email)) and length(email) between 3 and 320)
);
revoke all on table hc_migration_private.live_activity_end_015a
  from public, anon, authenticated, service_role;

lock table
  public.live_activity_tokens,
  public.push_tokens,
  public.shifts,
  public.field_workers,
  auth.users,
  hc_migration_private.live_activity_end_015a
in share row exclusive mode;

-- Migration 016 removes every token whose roster identity is missing,
-- inactive, unlinked, or outside an owner/manager role. Refuse to mark a
-- closed-shift END address unless it is already guaranteed to survive that
-- predicate. Auth confirmation is checked here too because 016 requires it.
do $eligibility_guard$
begin
  if exists (
    select 1
    from public.shifts
    where clock_out_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '015a blocked: every shift must be clocked out for the maintenance cutover';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens as token_row
    where token_row.device_id = token_row.id
      and not exists (
        select 1
        from hc_migration_private.live_activity_end_015a as marker
        where marker.token_id = token_row.id
          and marker.shift_id = token_row.shift_id
          and marker.email = lower(token_row.email)
      )
  ) then
    raise exception using
      errcode = '55000',
      message = '015a blocked: an unrecorded self-equal device identity already exists';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens as candidate
    join public.shifts as closed_shift
      on closed_shift.id = candidate.shift_id
     and closed_shift.clock_out_at is not null
    where candidate.token_type = 'activity_update'
      and candidate.device_id is null
      and not exists (
        select 1
        from public.field_workers as worker_row
        join auth.users as auth_user
          on auth_user.id = worker_row.auth_user_id
        where lower(worker_row.email) = lower(candidate.email)
          and worker_row.active is true
          and worker_row.role in ('owner', 'manager')
          and auth_user.email_confirmed_at is not null
          and auth_user.email is not null
          and lower(auth_user.email) = lower(worker_row.email)
      )
  ) then
    raise exception using
      errcode = '23514',
      message = '015a blocked: a closed-shift END address would not survive migration 016';
  end if;

  if exists (
    select 1
    from hc_migration_private.live_activity_end_015a as marker
    left join public.live_activity_tokens as token_row
      on token_row.id = marker.token_id
     and token_row.shift_id = marker.shift_id
     and lower(token_row.email) = marker.email
     and token_row.token_type = 'activity_update'
    left join public.shifts as closed_shift
      on closed_shift.id = marker.shift_id
     and closed_shift.clock_out_at is not null
    where token_row.id is null
       or closed_shift.id is null
       or (
         token_row.device_id is not null
         and token_row.device_id <> token_row.id
       )
  ) then
    raise exception using
      errcode = '55000',
      message = '015a blocked: its provenance record does not match the preserved rows';
  end if;
end
$eligibility_guard$;

-- A recovery ID must never collide with an existing physical-phone ID. The
-- guard fails the whole transaction instead of transferring ownership.
do $guard$
begin
  if exists (
    select 1
    from public.live_activity_tokens as candidate
    join public.shifts as closed_shift
      on closed_shift.id = candidate.shift_id
     and closed_shift.clock_out_at is not null
    where candidate.token_type = 'activity_update'
      and candidate.device_id is null
      and (
        exists (
          select 1
          from public.push_tokens as push_row
          where push_row.device_id = candidate.id
        )
        or exists (
          select 1
          from public.live_activity_tokens as other_token
          where other_token.id <> candidate.id
            and other_token.device_id = candidate.id
        )
      )
  ) then
    raise exception using
      errcode = '23505',
      message = '015a blocked: a recovery ID collides with a physical phone ID';
  end if;
end
$guard$;

insert into hc_migration_private.live_activity_end_015a (
  token_id,
  shift_id,
  email
)
select
  token_row.id,
  token_row.shift_id,
  lower(token_row.email)
from public.live_activity_tokens as token_row
join public.shifts as closed_shift
  on closed_shift.id = token_row.shift_id
 and closed_shift.clock_out_at is not null
where token_row.token_type = 'activity_update'
  and token_row.device_id is null
on conflict (token_id) do nothing;

update public.live_activity_tokens as token_row
set device_id = token_row.id
from public.shifts as closed_shift,
     hc_migration_private.live_activity_end_015a as marker
where token_row.token_type = 'activity_update'
  and token_row.device_id is null
  and token_row.shift_id = closed_shift.id
  and closed_shift.clock_out_at is not null
  and marker.token_id = token_row.id
  and marker.shift_id = token_row.shift_id
  and marker.email = lower(token_row.email);

do $assertions$
begin
  if exists (
    select 1
    from public.live_activity_tokens as token_row
    join public.shifts as closed_shift
      on closed_shift.id = token_row.shift_id
     and closed_shift.clock_out_at is not null
    where token_row.token_type = 'activity_update'
      and token_row.device_id is null
  ) then
    raise exception using
      errcode = '55000',
      message = '015a assertion failed: a closed-shift END address is still legacy-null';
  end if;

  if exists (
    select 1
    from hc_migration_private.live_activity_end_015a as marker
    left join public.live_activity_tokens as token_row
      on token_row.id = marker.token_id
     and token_row.shift_id = marker.shift_id
     and lower(token_row.email) = marker.email
     and token_row.token_type = 'activity_update'
     and token_row.device_id = token_row.id
    where token_row.id is null
  ) then
    raise exception using
      errcode = '55000',
      message = '015a assertion failed: a provenance marker lacks its exact preserved row';
  end if;
end
$assertions$;

commit;
