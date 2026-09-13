-- ============================================================================
-- 039_inventory_counts.sql
-- The unbranded-coconut reading a field worker gives when a shift ends.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- What this adds:
--   * public.inventory_counts: exactly ONE reading per shift (shift_id is
--     unique), so a correction overwrites the number instead of piling up a
--     second answer. The row remembers who counted and when. It cascades away
--     with the shift it belongs to, so a deleted shift leaves no orphan
--     reading.
--   * public.hc_record_inventory_count(shift, count, note): the ONE write
--     path. The caller must be an active roster worker. They may record for
--     their own shift; an owner may record for anyone; a manager may record
--     for a shift in their own market so a miscount can be corrected. It
--     upserts on shift_id, stamps counted_by from auth.uid() and counted_at
--     from now(), and returns the stored row as jsonb. The same number sent
--     twice is harmless: still one row, same count.
--   * public.hc_can_access_shift_inventory(shift): the yes/no rule the write
--     path and the read policy SHARE, so what a phone may record and what it
--     may read can never drift apart. It answers from public.shifts without
--     handing the caller shift rows (the pattern 015 uses for
--     hc_can_access_shift), because the shift table carries payroll.
--
-- Reading: owners see every reading, a manager sees readings for shifts in
-- their own market, a worker sees their own. That is row-level security plus
-- a SELECT grant to the authenticated role only. anon and PUBLIC get nothing
-- at all, so the public dashboard key cannot read stock levels or notes.
--
-- What this never touches: public.shifts (no column is added, changed, or
-- read out to the caller), payroll, orders, invoices, and every existing
-- policy or function. Nothing here decides pay or delivery.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
begin
  if pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null then
    raise exception using
      errcode = '55000',
      message = '039 requires public.shifts, public.field_workers, auth.uid() and public.hc_is_owner() from migration 015';
  end if;

  -- Every shift column the access rule reads.
  foreach v_column in array array['id', 'field_worker_id', 'market'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.shifts'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('039 requires column public.shifts.%s (015 adds field_worker_id)', v_column);
    end if;
  end loop;

  -- Every roster column the access rule reads, not just the link column.
  foreach v_column in array array['id', 'auth_user_id', 'role', 'market', 'active'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.field_workers'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('039 requires field_workers.%s from migration 015', v_column);
    end if;
  end loop;

  -- A table already carrying this name must be the one 039 installs. Refuse
  -- rather than bolt policies and grants onto somebody else's table.
  if pg_catalog.to_regclass('public.inventory_counts') is not null then
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
            '039 refuses an existing public.inventory_counts with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

-- One reading per shift. unbranded_coconuts is a physical stock observation,
-- not an order quantity and not a billing fact. The range and the note shape
-- are enforced here as well as in the function, so a service-role backfill
-- cannot write a number or a note the phones could not have produced.
create table if not exists public.inventory_counts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  shift_id uuid not null unique references public.shifts(id) on delete cascade,
  counted_by uuid not null,
  counted_at timestamptz not null default pg_catalog.now(),
  unbranded_coconuts integer not null check (unbranded_coconuts between 0 and 100000),
  note text check (note is null or (pg_catalog.length(note) between 1 and 200 and note !~ '[[:cntrl:]]'))
);

-- The owner's running history is read newest first.
create index if not exists inventory_counts_counted_at_idx
  on public.inventory_counts (counted_at desc);

alter table public.inventory_counts enable row level security;

-- Supabase grants new public tables to anon and authenticated by default.
-- Take that back before granting the one thing a phone needs: reading.
revoke all on table public.inventory_counts from public, anon, authenticated;
grant select on table public.inventory_counts to authenticated;

-- The single access rule. Reading public.shifts here bypasses that table's own
-- row security just long enough to answer yes or no, exactly as 015 documents
-- for hc_can_access_shift, so a manager never receives payroll columns.
create or replace function public.hc_can_access_shift_inventory(p_shift_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.shifts as shift_row
    join public.field_workers as worker
      on worker.auth_user_id = auth.uid()
     and worker.active is true
    where shift_row.id = p_shift_id
      and (
        -- their own shift, whatever their role or market
        shift_row.field_worker_id = worker.id
        -- an owner reaches every market (and, once 028 is live, must be signed
        -- in at the stronger owner assurance level)
        or public.hc_is_owner()
        -- a manager reaches their own exact market; a blank market on either
        -- side never matches, the same fail-closed rule 025 and 036 use
        or (
          pg_catalog.lower(pg_catalog.btrim(worker.role)) = 'manager'
          and nullif(pg_catalog.lower(pg_catalog.btrim(worker.market)), '') is not null
          and nullif(pg_catalog.lower(pg_catalog.btrim(shift_row.market)), '') is not null
          and pg_catalog.lower(pg_catalog.btrim(worker.market))
              = pg_catalog.lower(pg_catalog.btrim(shift_row.market))
        )
      )
  )
$function$;

revoke all on function public.hc_can_access_shift_inventory(uuid)
  from public, anon, authenticated;
-- The read policy below evaluates this as the calling phone, so the
-- authenticated role needs execute. anon and PUBLIC do not.
grant execute on function public.hc_can_access_shift_inventory(uuid)
  to authenticated;

drop policy if exists inventory_counts_authenticated_select on public.inventory_counts;
create policy inventory_counts_authenticated_select
on public.inventory_counts
for select to authenticated
using (public.hc_can_access_shift_inventory(inventory_counts.shift_id));

-- Records (or corrects) the unbranded coconut count for one shift.
--   p_shift_id  the shift the reading belongs to
--   p_unbranded whole coconuts left, 0..100000
--   p_note      optional plain-text note, trimmed, up to 200 characters;
--               blank is stored as no note at all
-- Returns the stored row as jsonb. Sending the same number again is harmless.
create or replace function public.hc_record_inventory_count(
  p_shift_id uuid,
  p_unbranded integer,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_worker public.field_workers%rowtype;
  v_shift public.shifts%rowtype;
  -- Whitespace runs (including line breaks) collapse to one space, then the
  -- ends are trimmed. A blank note becomes no note.
  v_note text := nullif(pg_catalog.btrim(
    pg_catalog.regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), '');
  v_row public.inventory_counts%rowtype;
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  select worker.* into v_worker
  from public.field_workers as worker
  where worker.auth_user_id = v_uid
    and worker.active is true
  limit 1;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'active field worker required';
  end if;

  if p_shift_id is null then
    raise exception using
      errcode = '22023',
      message = 'a shift id is required';
  end if;

  if p_unbranded is null then
    raise exception using
      errcode = '22023',
      message = 'enter how many unbranded coconuts are left: a whole number from 0 to 100000';
  end if;

  if p_unbranded < 0 or p_unbranded > 100000 then
    raise exception using
      errcode = '22023',
      message = pg_catalog.format(
        'the unbranded coconut count must be a whole number from 0 to 100000, and %s is outside that range',
        p_unbranded);
  end if;

  if v_note is not null and v_note ~ '[[:cntrl:]]' then
    raise exception using
      errcode = '22023',
      message = 'the note must be plain text';
  end if;

  if v_note is not null and pg_catalog.length(v_note) > 200 then
    raise exception using
      errcode = '22023',
      message = 'the note must be 200 characters or fewer';
  end if;

  -- Hold the shift's identity for the rest of this call so it cannot be
  -- deleted between the check and the write. KEY SHARE is the same lock the
  -- foreign key takes, so an ordinary clock-out update is never blocked.
  select shift_row.* into v_shift
  from public.shifts as shift_row
  where shift_row.id = p_shift_id
  for key share;

  if not found then
    if public.hc_is_owner() then
      raise exception using
        errcode = '22023',
        message = 'shift not found';
    end if;
    -- Anyone else learns nothing about shifts they cannot reach.
    raise exception using
      errcode = '42501',
      message = 'shift access denied';
  end if;

  if not public.hc_can_access_shift_inventory(p_shift_id) then
    raise exception using
      errcode = '42501',
      message = 'only the worker on this shift, an owner, or a manager in the same market can record this count';
  end if;

  insert into public.inventory_counts (
    shift_id, counted_by, counted_at, unbranded_coconuts, note
  ) values (
    p_shift_id, v_uid, pg_catalog.now(), p_unbranded, v_note
  )
  on conflict (shift_id) do update
    set counted_by = excluded.counted_by,
        counted_at = excluded.counted_at,
        unbranded_coconuts = excluded.unbranded_coconuts,
        note = excluded.note
  returning * into v_row;

  -- counted_at is rendered ISO 8601 in UTC (the shape JavaScript produces) so
  -- the answer does not depend on the session timezone.
  return pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'shift_id', v_row.shift_id,
    'counted_by', v_row.counted_by,
    'counted_at', pg_catalog.to_char(
      v_row.counted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'unbranded_coconuts', v_row.unbranded_coconuts,
    'note', v_row.note
  );
end
$function$;

revoke all on function public.hc_record_inventory_count(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.hc_record_inventory_count(uuid, integer, text)
  to authenticated;

comment on table public.inventory_counts is
  'One unbranded-coconut stock reading per shift, given by the crew at clock-out. shift_id is unique, so a correction overwrites the number and the history stays one reading per shift. counted_by is the auth user who recorded it and counted_at is server time. A physical observation only: it is not an order quantity, not billing, not payroll, and it never decides delivery. Written only through hc_record_inventory_count; read by owners everywhere, managers inside their own market, and workers for their own shifts.';

comment on function public.hc_record_inventory_count(uuid, integer, text) is
  'Records or corrects the unbranded coconut count for one shift. The caller must be an active field_workers row and may record for their own shift, or, as an owner (any market) or a manager whose market equals the shift market, for someone else so a miscount can be fixed. p_unbranded is a whole number 0..100000; null or out of range raises 22023 with a plain-English message. p_note is whitespace-collapsed and trimmed, blank becomes null, control characters and more than 200 characters raise 22023. Upserts on shift_id, stamps counted_by = auth.uid() and counted_at = now(), and returns the stored row as jsonb with counted_at as ISO 8601 UTC. Sending the same number twice is harmless.';

comment on function public.hc_can_access_shift_inventory(uuid) is
  'Yes or no: may the signed-in worker record and read the inventory count for this shift. Own shift, or owner anywhere, or manager in the exact same nonblank market. Shared by hc_record_inventory_count and the inventory_counts read policy so writing and reading can never drift apart. Reads public.shifts as definer to avoid handing the caller payroll columns, the pattern 015 uses for hc_can_access_shift.';

do $postflight$
declare
  v_record constant text := 'public.hc_record_inventory_count(uuid,integer,text)';
  v_access constant text := 'public.hc_can_access_shift_inventory(uuid)';
  v_signature text;
  v_definition text;
begin
  if pg_catalog.to_regclass('public.inventory_counts') is null
     or not exists (
       select 1 from pg_catalog.pg_class
       where oid = 'public.inventory_counts'::regclass
         and relrowsecurity
     ) then
    raise exception using
      errcode = '55000',
      message = '039 assertion failed: the inventory table is missing or row security is off';
  end if;

  if not exists (
       select 1 from pg_catalog.pg_constraint
       where conrelid = 'public.inventory_counts'::regclass
         and contype = 'u'
         and pg_catalog.pg_get_constraintdef(oid) like '%UNIQUE (shift_id)%'
     )
     or not exists (
       select 1 from pg_catalog.pg_constraint
       where conrelid = 'public.inventory_counts'::regclass
         and contype = 'f'
         and confrelid = 'public.shifts'::regclass
         and confdeltype = 'c'
     )
     or not exists (
       select 1 from pg_catalog.pg_constraint
       where conrelid = 'public.inventory_counts'::regclass
         and contype = 'c'
         and pg_catalog.pg_get_constraintdef(oid) like '%unbranded_coconuts%100000%'
     ) then
    raise exception using
      errcode = '55000',
      message = '039 assertion failed: one reading per shift, the shift cascade, or the 0..100000 range is missing';
  end if;

  -- The public dashboard key must reach nothing here, and a phone may only
  -- read. Every write goes through the checked function.
  if pg_catalog.has_table_privilege('anon', 'public.inventory_counts', 'SELECT')
     or pg_catalog.has_table_privilege('anon', 'public.inventory_counts', 'INSERT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.inventory_counts', 'SELECT')
     or pg_catalog.has_table_privilege('authenticated', 'public.inventory_counts', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.inventory_counts', 'UPDATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.inventory_counts', 'DELETE')
     -- grantee 0 is PUBLIC: nobody may reach this through a default grant.
     or exists (
       select 1
       from pg_catalog.pg_class as c
       cross join lateral pg_catalog.aclexplode(c.relacl) as a
       where c.oid = 'public.inventory_counts'::regclass
         and a.grantee = 0
     ) then
    raise exception using
      errcode = '42501',
      message = '039 assertion failed: inventory table grants are unsafe';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_counts'
      and policyname = 'inventory_counts_authenticated_select'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and qual like '%hc_can_access_shift_inventory%'
  ) then
    raise exception using
      errcode = '55000',
      message = '039 assertion failed: the authenticated read policy is not the expected market-scoped rule';
  end if;

  foreach v_signature in array array[v_record, v_access] loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or exists (
         select 1
         from pg_catalog.pg_proc as p
         cross join lateral pg_catalog.aclexplode(p.proacl) as a
         where p.oid = v_signature::regprocedure
           and a.grantee = 0
       )
       or not exists (
         select 1 from pg_catalog.pg_proc as p
         where p.oid = v_signature::regprocedure
           and p.prosecdef is true
           and pg_catalog.array_to_string(p.proconfig, ',') ~ 'search_path='
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format('039 assertion failed: grants or settings on %s are unsafe', v_signature);
    end if;
  end loop;

  v_definition := pg_catalog.pg_get_functiondef(v_record::regprocedure);
  if v_definition !~ 'on conflict \(shift_id\) do update'
     or v_definition !~ 'hc_can_access_shift_inventory'
     or v_definition !~ '100000'
     or v_definition !~ 'for key share'
     or v_definition ~ 'update public\.shifts' then
    raise exception using
      errcode = '55000',
      message = '039 assertion failed: the recording function definition drifted';
  end if;
end
$postflight$;

commit;
