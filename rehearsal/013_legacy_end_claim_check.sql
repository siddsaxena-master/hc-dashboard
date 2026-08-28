-- ============================================================================
-- SANDBOX ONLY: 013_legacy_end_claim_check.sql
--
-- Run after migration 017. It proves the durable END worker can claim the one
-- valid recovery address retained through 016. The claim is rolled back, and
-- no raw token is selected or printed. Never run this file against production.
-- ============================================================================

begin;

select pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

create temporary table hc_legacy_end_claim_check
on commit drop
as
select claimed.token_id, claimed.queue_id, claimed.shift_id
from public.hc_claim_live_activity_ends(
  clock_timestamp(),
  clock_timestamp() - interval '30 minutes',
  50
) as claimed;

do $assertions$
begin
  if not exists (
    select 1
    from hc_legacy_end_claim_check
    where token_id = '00000000-0000-4000-8000-000000001501'
      and shift_id = '00000000-0000-4000-8000-000000001511'
      and queue_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'SANDBOX ASSERTION: migration 017 could not claim the preserved END address';
  end if;
end
$assertions$;

rollback;
