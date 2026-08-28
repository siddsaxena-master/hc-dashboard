-- ============================================================================
-- SANDBOX ONLY: 011_legacy_end_failed_cutover_check.sql
--
-- Run after 010, the expected failed-015a check in 010a, migration 015a, and
-- one EXPECTED-TO-FAIL attempt at migration 016. It proves 016 rolled back
-- fully because the malformed closed token was rejected. It then removes only
-- that known malformed sandbox row so 016 can be tried again. Never run this
-- file against production.
-- ============================================================================

begin;

do $assertions$
begin
  if not pg_catalog.has_table_privilege(
    'anon', 'public.live_activity_tokens', 'INSERT'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: migration 016 did not roll back';
  end if;

  if (
    select count(*)
    from public.live_activity_tokens
    where id between
      '00000000-0000-4000-8000-000000001501'::uuid
      and '00000000-0000-4000-8000-000000001505'::uuid
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: failed 016 did not restore every fixture row';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens
    where id in (
      '00000000-0000-4000-8000-000000001501',
      '00000000-0000-4000-8000-000000001505'
    )
      and device_id is distinct from id
  ) or exists (
    select 1
    from public.live_activity_tokens
    where id in (
      '00000000-0000-4000-8000-000000001503',
      '00000000-0000-4000-8000-000000001504'
    )
      and device_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: migration 015a changed the wrong truth-table row';
  end if;
end
$assertions$;

do $cleanup$
declare
  v_changed integer;
begin
  delete from public.live_activity_tokens
  where id = '00000000-0000-4000-8000-000000001505';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'SANDBOX CLEANUP: malformed token row was not unique';
  end if;

  delete from public.shifts
  where id = '00000000-0000-4000-8000-000000001513';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'SANDBOX CLEANUP: malformed-token shift was not unique';
  end if;
end
$cleanup$;

commit;
