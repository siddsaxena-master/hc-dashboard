-- ============================================================================
-- SANDBOX ONLY: 010b_legacy_end_rollback_check.sql
--
-- Run after 010a, a successful migration 015a, and its guarded rollback. It
-- proves the token rows returned to their exact legacy-null state and the
-- private provenance table is empty. Then reapply 015a before testing 016.
-- Never run this file against production.
-- ============================================================================

begin;

do $assertions$
begin
  if pg_catalog.to_regclass(
    'hc_migration_private.live_activity_end_015a'
  ) is null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: rollback provenance table is missing';
  end if;

  if exists (
    select 1
    from hc_migration_private.live_activity_end_015a
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: rollback left private provenance rows';
  end if;

  if (
    select count(*)
    from public.live_activity_tokens
    where id between
      '00000000-0000-4000-8000-000000001501'::uuid
      and '00000000-0000-4000-8000-000000001505'::uuid
  ) <> 4 or exists (
    select 1
    from public.live_activity_tokens
    where id between
      '00000000-0000-4000-8000-000000001501'::uuid
      and '00000000-0000-4000-8000-000000001505'::uuid
      and device_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: rollback did not restore four legacy-null rows';
  end if;

  if not pg_catalog.has_table_privilege(
    'anon', 'public.live_activity_tokens', 'INSERT'
  ) or pg_catalog.to_regprocedure(
    'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
  ) is not null then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: rollback is outside the pre-016 and pre-017 window';
  end if;
end
$assertions$;

rollback;
