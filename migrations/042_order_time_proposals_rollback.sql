-- ============================================================================
-- 042_order_time_proposals_rollback.sql
-- Removes the owner's decision function, the read policy and the proposals
-- table with every proposal in it. Safe to run twice. Touches nothing else:
-- orders, delivery_request, intake_messages (rows a decision already
-- dismissed stay dismissed) and 038's function are untouched. The worker's
-- proposal scan logs "proposals table missing" until it is redeployed
-- without the scan or the migration is reapplied.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

drop function if exists public.hc_decide_proposed_time(uuid, bigint, text);

drop policy if exists order_time_proposals_owner_select on public.order_time_proposals;

drop table if exists public.order_time_proposals;

do $postflight$
begin
  if pg_catalog.to_regclass('public.order_time_proposals') is not null
     or pg_catalog.to_regprocedure('public.hc_decide_proposed_time(uuid, bigint, text)') is not null then
    raise exception using errcode = '55000', message = '042 rollback postflight: something 042 installed is still present';
  end if;
end
$postflight$;

commit;
