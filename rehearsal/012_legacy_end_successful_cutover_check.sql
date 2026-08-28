-- ============================================================================
-- SANDBOX ONLY: 012_legacy_end_successful_cutover_check.sql
--
-- Run after 011 and the successful second application of migration 016.
-- It proves the valid closed END address survived while open, orphaned, and
-- future-start legacy rows were removed. This file is read-only and rolls back.
-- Never run it against production.
-- ============================================================================

begin;

do $assertions$
begin
  if pg_catalog.has_table_privilege(
    'anon', 'public.live_activity_tokens', 'INSERT'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: migration 016 is not active';
  end if;

  if not exists (
    select 1
    from public.live_activity_tokens
    where id = '00000000-0000-4000-8000-000000001501'
      and token_type = 'activity_update'
      and shift_id = '00000000-0000-4000-8000-000000001511'
      and device_id = id
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: valid closed END address did not survive 016';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens
    where id in (
      '00000000-0000-4000-8000-000000001502',
      '00000000-0000-4000-8000-000000001503',
      '00000000-0000-4000-8000-000000001504',
      '00000000-0000-4000-8000-000000001505'
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: an unsafe truth-table token survived 016';
  end if;
end
$assertions$;

rollback;
