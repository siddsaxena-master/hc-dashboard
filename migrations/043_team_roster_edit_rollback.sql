-- ============================================================================
-- 043_team_roster_edit_rollback.sql
-- Undo migration 043: drop the roster-edit function and the audit table.
-- Roster rows themselves are NOT restored: an edit made through the function
-- stays as edited (the audit rows tell what changed; copy them somewhere
-- first if that history matters). Safe to run twice.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

drop function if exists public.hc_update_field_worker(uuid, jsonb);
drop policy if exists field_worker_edits_owner_select on public.field_worker_edits;
drop table if exists public.field_worker_edits;

do $postflight$
begin
  if pg_catalog.to_regprocedure('public.hc_update_field_worker(uuid, jsonb)') is not null
     or pg_catalog.to_regclass('public.field_worker_edits') is not null then
    raise exception using errcode = '55000', message = '043 rollback postflight: objects still present';
  end if;
end
$postflight$;

commit;
