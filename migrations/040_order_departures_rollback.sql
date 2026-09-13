-- ============================================================================
-- 040_order_departures_rollback.sql
-- Removes everything 040 installed: the phone action function, the read
-- policy, and the order_departures table with every plan row in it.
--
-- Safe to run twice. Touches nothing else: orders, shifts, field_workers,
-- delivery_request and the 019 access function all stay exactly as they were.
-- The worker keeps running; with the table gone its departure scan logs
-- "no_route"-style errors on every tick until it is redeployed without the
-- scan or the migration is reapplied.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

drop function if exists public.hc_departure_action(uuid, text);

drop policy if exists order_departures_authenticated_select on public.order_departures;

drop table if exists public.order_departures;

do $postflight$
begin
  if pg_catalog.to_regclass('public.order_departures') is not null
     or pg_catalog.to_regprocedure('public.hc_departure_action(uuid, text)') is not null then
    raise exception using errcode = '55000', message = '040 rollback postflight: something 040 installed is still present';
  end if;
end
$postflight$;

commit;
