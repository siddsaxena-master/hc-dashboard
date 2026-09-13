-- ============================================================================
-- 039_inventory_counts_rollback.sql
-- Undo 039: drop the recording function, the shared access rule, and the
-- public.inventory_counts table.
--
-- GUARDED. Dropping the table destroys stock readings, so this refuses while
-- any reading exists; export or delete them in a separate reviewed step
-- first. It also refuses a table of that name that is not the one 039
-- installed, and refuses while another table or view depends on it. Running
-- it again after a clean rollback is harmless.
--
-- public.shifts, payroll, orders, and every object from earlier migrations
-- are left exactly as they are: 039 never changed them.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
  v_rows bigint;
begin
  if pg_catalog.to_regclass('public.inventory_counts') is null then
    -- Nothing installed, or already rolled back. The drops below are no-ops.
    return;
  end if;

  foreach v_column in array array[
    'id', 'shift_id', 'counted_by', 'counted_at', 'unbranded_coconuts', 'note'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.inventory_counts'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          '039 rollback blocked: public.inventory_counts is not the table 039 installs (no %s column)',
          v_column);
    end if;
  end loop;

  select pg_catalog.count(*) into v_rows from public.inventory_counts;
  if v_rows > 0 then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        '039 rollback blocked: %s inventory reading(s) recorded; export or delete them in a reviewed step first',
        v_rows);
  end if;

  -- Anything built on this table must be removed by its own script, not
  -- silently cascaded away here.
  if exists (
       select 1 from pg_catalog.pg_constraint as fk
       where fk.confrelid = 'public.inventory_counts'::regclass
         and fk.conrelid <> 'public.inventory_counts'::regclass
     )
     or exists (
       select 1
       from pg_catalog.pg_depend as d
       join pg_catalog.pg_rewrite as r on r.oid = d.objid
       where d.classid = 'pg_rewrite'::regclass
         and d.refobjid = 'public.inventory_counts'::regclass
         and r.ev_class <> 'public.inventory_counts'::regclass
     ) then
    raise exception using
      errcode = '55000',
      message = '039 rollback blocked: another table or view depends on public.inventory_counts';
  end if;
end
$preflight$;

-- Order matters: the function that writes the table, then the table (which
-- takes its own read policy with it), then the access rule that policy used.
drop function if exists public.hc_record_inventory_count(uuid, integer, text);
drop table if exists public.inventory_counts;
drop function if exists public.hc_can_access_shift_inventory(uuid);

do $postflight$
begin
  if pg_catalog.to_regclass('public.inventory_counts') is not null
     or pg_catalog.to_regprocedure('public.hc_record_inventory_count(uuid,integer,text)') is not null
     or pg_catalog.to_regprocedure('public.hc_can_access_shift_inventory(uuid)') is not null then
    raise exception using
      errcode = '55000',
      message = '039 rollback assertion failed: inventory objects remain';
  end if;

  if pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.field_workers') is null then
    raise exception using
      errcode = '55000',
      message = '039 rollback assertion failed: a table 039 never owned is missing';
  end if;
end
$postflight$;

commit;
