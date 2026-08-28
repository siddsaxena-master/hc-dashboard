-- ============================================================================
-- Guarded rollback for 015a_closed_live_activity_end_preservation.sql.
-- Run only before migration 016. It clears only deterministic recovery IDs
-- recorded in 015a's private provenance table. It never deletes a token or
-- Lock Screen END address.
-- Production use needs Sidd's separate explicit "yes do it" confirmation.
-- ============================================================================

begin;

set local lock_timeout = '15s';
set local statement_timeout = '2min';

do $preflight$
begin
  if pg_catalog.to_regclass(
    'hc_migration_private.live_activity_end_015a'
  ) is null then
    raise exception using
      errcode = '55000',
      message = '015a rollback blocked: private provenance is missing';
  end if;

  if not pg_catalog.has_table_privilege(
    'anon', 'public.live_activity_tokens', 'INSERT'
  ) or pg_catalog.to_regprocedure(
    'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
  ) is not null then
    raise exception using
      errcode = '55000',
      message = '015a rollback blocked: migration 016 or 017 is already active';
  end if;
end
$preflight$;

lock table
  public.live_activity_tokens,
  public.shifts,
  hc_migration_private.live_activity_end_015a
in share row exclusive mode;

do $rollback$
declare
  v_expected integer;
  v_changed integer;
  v_markers_deleted integer;
begin
  if exists (
    select 1
    from hc_migration_private.live_activity_end_015a as marker
    left join public.live_activity_tokens as token_row
      on token_row.id = marker.token_id
     and token_row.shift_id = marker.shift_id
     and lower(token_row.email) = marker.email
     and token_row.token_type = 'activity_update'
     and token_row.device_id = token_row.id
    left join public.shifts as closed_shift
      on closed_shift.id = marker.shift_id
     and closed_shift.clock_out_at is not null
    where token_row.id is null
       or closed_shift.id is null
  ) then
    raise exception using
      errcode = '55000',
      message = '015a rollback blocked: provenance no longer matches the preserved rows';
  end if;

  select count(*)
  into v_expected
  from hc_migration_private.live_activity_end_015a;

  update public.live_activity_tokens as token_row
  set device_id = null
  from public.shifts as closed_shift,
       hc_migration_private.live_activity_end_015a as marker
  where token_row.id = marker.token_id
    and token_row.shift_id = marker.shift_id
    and lower(token_row.email) = marker.email
    and token_row.token_type = 'activity_update'
    and token_row.device_id = token_row.id
    and token_row.shift_id = closed_shift.id
    and closed_shift.clock_out_at is not null;

  get diagnostics v_changed = row_count;
  if v_changed <> v_expected then
    raise exception using
      errcode = '55000',
      message = '015a rollback failed: changed row count did not match provenance';
  end if;

  delete from hc_migration_private.live_activity_end_015a;
  get diagnostics v_markers_deleted = row_count;
  if v_markers_deleted <> v_expected then
    raise exception using
      errcode = '55000',
      message = '015a rollback failed: private provenance cleanup was incomplete';
  end if;
end
$rollback$;

commit;
