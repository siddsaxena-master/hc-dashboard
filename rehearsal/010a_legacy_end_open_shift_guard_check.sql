-- ============================================================================
-- SANDBOX ONLY: 010a_legacy_end_open_shift_guard_check.sql
--
-- Run after 010 and one EXPECTED-TO-FAIL attempt at migration 015a. It proves
-- the maintenance gate rolled the entire transaction back while a shift was
-- open. It then removes only that fixed open-shift fixture so 015a can run.
-- Never run this file against production.
-- ============================================================================

begin;

do $assertions$
begin
  if not pg_catalog.has_table_privilege(
    'anon', 'public.live_activity_tokens', 'INSERT'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: failed 015a did not preserve the pre-016 state';
  end if;

  if not exists (
    select 1
    from public.shifts
    where id = '00000000-0000-4000-8000-000000001512'
      and clock_out_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: the open-shift blocker is missing';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens
    where id between
      '00000000-0000-4000-8000-000000001501'::uuid
      and '00000000-0000-4000-8000-000000001505'::uuid
      and device_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: failed 015a changed a recovery identity';
  end if;

  if pg_catalog.to_regclass(
    'hc_migration_private.live_activity_end_015a'
  ) is not null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: failed 015a committed provenance';
  end if;
end
$assertions$;

do $cleanup$
declare
  v_changed integer;
begin
  delete from public.live_activity_tokens
  where id = '00000000-0000-4000-8000-000000001502';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'SANDBOX CLEANUP: open-shift token row was not unique';
  end if;

  delete from public.shifts
  where id = '00000000-0000-4000-8000-000000001512';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'SANDBOX CLEANUP: open-shift row was not unique';
  end if;

  if exists (
    select 1
    from public.shifts
    where clock_out_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX CLEANUP: an open shift remains';
  end if;
end
$cleanup$;

commit;
