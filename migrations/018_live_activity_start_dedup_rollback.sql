-- ============================================================================
-- 018_live_activity_start_dedup_rollback.sql
-- Guarded rollback for 018_live_activity_start_dedup.sql.
--
-- ORDER IS REQUIRED:
--   1. Keep the 018 worker and pushdrain running during a maintenance window.
--   2. Clock out every open real shift and wait until all START rows are done.
--   3. Stop the 018 worker producer and pushdrain consumer.
--   4. Run all three verification queries below. They must return zero.
--   5. Run THIS rollback, then restore and restart the previous worker and
--      previous pushdrain versions together.
--
-- Read-only verification queries:
--   select count(*) as open_start_deliveries
--   from public.live_activity_start_deliveries as delivery
--   join public.shifts as shift_row on shift_row.id = delivery.shift_id
--   where shift_row.clock_out_at is null;
--
--   select count(*) as active_start_claims
--   from public.live_activity_start_deliveries
--   where claimed_at is not null and queued_at is null;
--
--   select count(*) as unfinished_la_start_rows
--   from public.push_queue
--   where kind = 'la_start' and done_at is null;
--
-- The open-shift guard matters because dropping the ledger and later reapplying
-- 018 during the same shift would forget its delivery receipt and start another
-- card. The transaction locks producer state from preflight through commit.
-- This rollback does not alter 017 token indexes, functions, or its build-24
-- compatibility lane. It also remains runnable if 017 was mistakenly rolled
-- back first, because 018 owns only the objects removed below.
-- ============================================================================

begin;

-- Check object existence before naming the ledger in LOCK TABLE. Otherwise a
-- missing or previously removed ledger would throw a low-level relation error
-- before this rollback can explain what is wrong.
do $object_preflight$
begin
  if pg_catalog.to_regclass(
       'public.live_activity_start_deliveries'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '018 rollback blocked: START delivery ledger is missing';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '018 rollback blocked: START claim RPC is missing';
  end if;
end
$object_preflight$;

lock table
  public.live_activity_start_deliveries,
  public.live_activity_tokens,
  public.push_queue,
  public.shifts
in share row exclusive mode;

do $state_preflight$
begin
  if exists (
    select 1
    from public.live_activity_start_deliveries as delivery
    join public.shifts as shift_row on shift_row.id = delivery.shift_id
    where shift_row.clock_out_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '018 rollback blocked: an open shift still has a START delivery receipt';
  end if;

  if exists (
    select 1
    from public.live_activity_start_deliveries
    where claimed_at is not null
      and queued_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '018 rollback blocked: active START delivery claims remain';
  end if;

  if exists (
    select 1
    from public.push_queue
    where kind = 'la_start'
      and done_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '018 rollback blocked: unfinished Live Activity START queue rows remain';
  end if;
end
$state_preflight$;

drop function public.hc_claim_live_activity_starts(
  timestamptz, timestamptz, timestamptz, integer
);

drop function public.hc_validate_live_activity_start_delivery(
  uuid, uuid, uuid, integer, text
);

drop trigger live_activity_tokens_reconcile_start_device
  on public.live_activity_tokens;
drop function public.hc_reconcile_live_activity_start_device();

drop trigger push_queue_validate_live_activity_start
  on public.push_queue;
drop function public.hc_validate_live_activity_start_queue();

drop trigger push_queue_retain_unconfirmed_live_activity_start
  on public.push_queue;
drop function public.hc_retain_unconfirmed_live_activity_start_queue();

drop trigger live_activity_start_deliveries_protect_identity
  on public.live_activity_start_deliveries;
drop function public.hc_protect_live_activity_start_delivery();

drop table public.live_activity_start_deliveries;

do $assertions$
begin
  if pg_catalog.to_regclass(
       'public.live_activity_start_deliveries'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_protect_live_activity_start_delivery()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_retain_unconfirmed_live_activity_start_queue()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_validate_live_activity_start_queue()'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_reconcile_live_activity_start_device()'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '018 rollback assertion failed: START delivery objects remain';
  end if;
end
$assertions$;

commit;
