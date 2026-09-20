-- ============================================================================
-- 047_passed_leads_rollback.sql
-- Undo migration 047: drop the mark and reopen functions, the partial index,
-- the check constraint and the passed column on public.orders. Safe to run
-- twice. Touches nothing else: stage, cancelled_at, cancelled_reason and
-- every other orders column, policy and function stay as they are.
--
-- It REFUSES (55000) while any order still carries a passed record at stage
-- cancelled: dropping the column would lose the reason and the prior stage,
-- and the lead would be stranded as a plain cancelled order with no way to
-- put it back. Reopen those first (the phone's Reopen button, or
-- hc_reopen_passed_order as the owner), then run this again. The SELECT
-- that shows them:
--   select id, client_name, cancelled_reason, passed
--   from public.orders where passed is not null and stage = 'cancelled';
--
-- Until the phone is rebuilt without the feature it logs a missing function
-- on Mark passed and shows nothing for the badge; the worker's digest line
-- fails soft (a read error leaves the digest unchanged).
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_column_present boolean := false;
  v_passed_count integer := 0;
begin
  -- Dynamic SQL, so this block still parses when the column is already gone
  -- (the second run of this file).
  select exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.orders'::regclass
      and attname = 'passed'
      and attnum > 0
      and not attisdropped
  ) into v_column_present;
  if v_column_present then
    execute 'select pg_catalog.count(*)::integer from public.orders'
         || ' where passed is not null and stage = ''cancelled'''
       into v_passed_count;
  end if;
  if v_passed_count > 0 then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('047 rollback refuses while %s order(s) still carry a passed record at stage cancelled; reopen those first (hc_reopen_passed_order as the owner), then run again', v_passed_count);
  end if;
end
$preflight$;

drop function if exists public.hc_mark_order_passed(uuid, text, text, text);
drop function if exists public.hc_reopen_passed_order(uuid);

drop index if exists public.orders_passed_at_idx;

alter table public.orders
  drop constraint if exists orders_passed_check;

alter table public.orders
  drop column if exists passed;

do $postflight$
begin
  if pg_catalog.to_regprocedure('public.hc_mark_order_passed(uuid, text, text, text)') is not null
     or pg_catalog.to_regprocedure('public.hc_reopen_passed_order(uuid)') is not null
     or pg_catalog.to_regclass('public.orders_passed_at_idx') is not null
     or exists (
       select 1 from pg_catalog.pg_constraint as c
       where c.conrelid = 'public.orders'::regclass
         and c.conname = 'orders_passed_check'
     )
     or exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.orders'::regclass
         and attname = 'passed'
         and attnum > 0
         and not attisdropped
     ) then
    raise exception using errcode = '55000', message = '047 rollback postflight: something 047 installed is still present';
  end if;
end
$postflight$;

commit;
