-- ============================================================================
-- 043_team_roster_edit.sql
-- The owner edits the team from the phone: name, role, market, hourly rate,
-- and Active on or off. Written 2026-09-14 when Hashim left and Sidd asked
-- for "some way to edit team members and change their access".
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- What this adds:
--   * public.hc_update_field_worker(worker, patch): the ONE phone write into
--     public.field_workers. Owner only. The patch is a jsonb object with any
--     of: name, role (owner | manager | team), market (ny | vegas | miami),
--     active (true | false), hourly_rate_cents (0 to 25000). Email never
--     changes here (it is the login identity; a wrong email is a new row).
--     Guards: you cannot change your own role or your own access; the last
--     active owner can never be demoted or switched off; the Apple review
--     login (appreview@) keeps its role, market and access so App Review
--     keeps working; a worker who is still clocked in cannot be switched off
--     (clock them out first, the manager screen does that); switching a
--     worker off also deletes their phone tokens (no more banners, no more
--     lock-screen card), and demoting to team deletes the card tokens (crew
--     never get the card). Every change writes one audit row.
--   * public.field_worker_edits: the audit trail (who, when, which keys, the
--     before and after values). Owner-readable, service_role only for writes
--     outside the function.
--
-- What this never touches: shifts, pay, orders, auth.users (a deactivated
-- worker's login still exists but every role check reads active = true, so
-- the app refuses them at the door), push_queue.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
begin
  if pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.push_tokens') is null
     or pg_catalog.to_regclass('public.live_activity_tokens') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null then
    raise exception using
      errcode = '55000',
      message = '043 requires field_workers, shifts, push_tokens, live_activity_tokens, auth.uid() and hc_is_owner() from migration 015';
  end if;

  foreach v_column in array array['id', 'email', 'name', 'role', 'market', 'active', 'hourly_rate_cents', 'auth_user_id'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.field_workers'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('043 requires column public.field_workers.%s', v_column);
    end if;
  end loop;

  foreach v_column in array array['worker_email', 'clock_out_at'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.shifts'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('043 requires column public.shifts.%s', v_column);
    end if;
  end loop;

  if pg_catalog.to_regclass('public.field_worker_edits') is not null then
    foreach v_column in array array['id', 'worker_id', 'edited_by', 'changes', 'created_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.field_worker_edits'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format('043 refuses an existing public.field_worker_edits with no %s column; review that table before applying', v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

-- The audit trail. One row per successful edit; the row names the worker
-- (by id, cascades away with the roster row) and the owner who edited (auth
-- user id), and carries {key: {before, after}} for the keys that changed.
create table if not exists public.field_worker_edits (
  id bigint generated always as identity primary key,
  worker_id uuid not null references public.field_workers(id) on delete cascade,
  edited_by uuid,
  edited_by_name text check (edited_by_name is null or pg_catalog.length(edited_by_name) between 1 and 80),
  changes jsonb not null check (pg_catalog.jsonb_typeof(changes) = 'object'),
  created_at timestamptz not null default pg_catalog.now()
);

create index if not exists field_worker_edits_worker_idx
  on public.field_worker_edits (worker_id, created_at desc);

alter table public.field_worker_edits enable row level security;

revoke all on table public.field_worker_edits from public, anon, authenticated;
grant select on table public.field_worker_edits to authenticated;
grant select, insert on table public.field_worker_edits to service_role;

drop policy if exists field_worker_edits_owner_select on public.field_worker_edits;
create policy field_worker_edits_owner_select
on public.field_worker_edits
for select to authenticated
using (public.hc_is_owner());

-- The one phone write into the roster.
--   p_worker_id  the roster row to change
--   p_patch      jsonb object with any of name, role, market, active,
--                hourly_rate_cents
-- Returns jsonb { applied, changes, row }. Raises 42501 for the wrong caller
-- or a forbidden change, 22023 for a malformed patch or an impossible one.
create or replace function public.hc_update_field_worker(
  p_worker_id uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_me public.field_workers%rowtype;
  v_row public.field_workers%rowtype;
  v_key text;
  v_text text;
  v_name text;
  v_role text;
  v_market text;
  v_active boolean;
  v_rate integer;
  v_changes jsonb := '{}'::jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_review_email constant text := 'appreview@hamptonscoconuts.com';
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  select w.* into v_me
  from public.field_workers as w
  where w.auth_user_id = v_uid
    and w.active is true
  limit 1;

  if v_me.id is null or pg_catalog.lower(pg_catalog.btrim(coalesce(v_me.role, ''))) <> 'owner' then
    raise exception using
      errcode = '42501',
      message = 'only the owner can edit the team';
  end if;

  if p_worker_id is null then
    raise exception using
      errcode = '22023',
      message = 'a worker id is required';
  end if;

  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'the patch must be an object';
  end if;

  for v_key in select pg_catalog.jsonb_object_keys(p_patch) loop
    if v_key not in ('name', 'role', 'market', 'active', 'hourly_rate_cents') then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('unknown field %L', v_key);
    end if;
  end loop;

  -- Hold the row for the rest of this call so two taps cannot interleave.
  select w.* into v_row
  from public.field_workers as w
  where w.id = p_worker_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such team member';
  end if;

  -- Start from what is stored; overwrite with what the patch names.
  v_name := v_row.name;
  v_role := pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.role, '')));
  v_market := pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.market, '')));
  v_active := v_row.active;
  v_rate := v_row.hourly_rate_cents;

  if p_patch ? 'name' then
    if pg_catalog.jsonb_typeof(p_patch -> 'name') <> 'string' then
      raise exception using errcode = '22023', message = 'name must be text';
    end if;
    v_text := pg_catalog.btrim(pg_catalog.regexp_replace(p_patch ->> 'name', '\s+', ' ', 'g'));
    if pg_catalog.length(v_text) < 1 or pg_catalog.length(v_text) > 80 or v_text ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'name must be 1 to 80 plain characters';
    end if;
    v_name := v_text;
  end if;

  if p_patch ? 'role' then
    if pg_catalog.jsonb_typeof(p_patch -> 'role') <> 'string' then
      raise exception using errcode = '22023', message = 'role must be text';
    end if;
    v_text := pg_catalog.lower(pg_catalog.btrim(p_patch ->> 'role'));
    if v_text not in ('owner', 'manager', 'team') then
      raise exception using errcode = '22023', message = 'role must be owner, manager or team';
    end if;
    v_role := v_text;
  end if;

  if p_patch ? 'market' then
    if pg_catalog.jsonb_typeof(p_patch -> 'market') <> 'string' then
      raise exception using errcode = '22023', message = 'market must be text';
    end if;
    v_text := pg_catalog.lower(pg_catalog.btrim(p_patch ->> 'market'));
    if v_text not in ('ny', 'vegas', 'miami') then
      raise exception using errcode = '22023', message = 'market must be ny, vegas or miami';
    end if;
    v_market := v_text;
  end if;

  if p_patch ? 'active' then
    if pg_catalog.jsonb_typeof(p_patch -> 'active') <> 'boolean' then
      raise exception using errcode = '22023', message = 'active must be true or false';
    end if;
    v_active := (p_patch ->> 'active')::boolean;
  end if;

  if p_patch ? 'hourly_rate_cents' then
    if pg_catalog.jsonb_typeof(p_patch -> 'hourly_rate_cents') not in ('number', 'null') then
      raise exception using errcode = '22023', message = 'hourly_rate_cents must be a whole number of cents';
    end if;
    if pg_catalog.jsonb_typeof(p_patch -> 'hourly_rate_cents') = 'null' then
      v_rate := null;
    else
      if (p_patch ->> 'hourly_rate_cents') !~ '^\d+$' then
        raise exception using errcode = '22023', message = 'hourly_rate_cents must be a whole number of cents';
      end if;
      v_rate := (p_patch ->> 'hourly_rate_cents')::integer;
      if v_rate < 0 or v_rate > 25000 then
        raise exception using errcode = '22023', message = 'hourly_rate_cents must be between 0 and 25000';
      end if;
    end if;
  end if;

  -- Your own row: name and rate are fine; role and access are not. An owner
  -- who locks themselves out has nobody left to unlock them.
  if v_row.id = v_me.id
     and (v_role <> pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.role, ''))) or v_active <> v_row.active) then
    raise exception using
      errcode = '42501',
      message = 'you cannot change your own role or access';
  end if;

  -- The Apple review login keeps working no matter what.
  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.email, ''))) = v_review_email
     and (v_role <> pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.role, '')))
          or v_market <> pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.market, '')))
          or v_active <> v_row.active) then
    raise exception using
      errcode = '42501',
      message = 'the App Review login keeps its role, market and access';
  end if;

  -- Never lose the last active owner.
  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.role, ''))) = 'owner' and v_row.active is true
     and (v_role <> 'owner' or v_active is not true)
     and not exists (
       select 1 from public.field_workers as w
       where w.id <> v_row.id
         and w.active is true
         and pg_catalog.lower(pg_catalog.btrim(coalesce(w.role, ''))) = 'owner'
     ) then
    raise exception using
      errcode = '42501',
      message = 'this is the last owner; add another owner first';
  end if;

  -- Switching someone off while they are clocked in would strand an open
  -- shift nobody can close from the phone.
  if v_row.active is true and v_active is not true and exists (
       select 1 from public.shifts as s
       where s.clock_out_at is null
         and pg_catalog.lower(pg_catalog.btrim(coalesce(s.worker_email, ''))) = pg_catalog.lower(pg_catalog.btrim(coalesce(v_row.email, '')))
     ) then
    raise exception using
      errcode = '22023',
      message = 'still clocked in; clock them out first';
  end if;

  -- What actually changes.
  if v_name is distinct from v_row.name then
    v_changes := v_changes || pg_catalog.jsonb_build_object('name', pg_catalog.jsonb_build_object('before', v_row.name, 'after', v_name));
  end if;
  if v_role is distinct from v_row.role then
    v_changes := v_changes || pg_catalog.jsonb_build_object('role', pg_catalog.jsonb_build_object('before', v_row.role, 'after', v_role));
  end if;
  if v_market is distinct from v_row.market then
    v_changes := v_changes || pg_catalog.jsonb_build_object('market', pg_catalog.jsonb_build_object('before', v_row.market, 'after', v_market));
  end if;
  if v_active is distinct from v_row.active then
    v_changes := v_changes || pg_catalog.jsonb_build_object('active', pg_catalog.jsonb_build_object('before', v_row.active, 'after', v_active));
  end if;
  if v_rate is distinct from v_row.hourly_rate_cents then
    v_changes := v_changes || pg_catalog.jsonb_build_object('hourly_rate_cents', pg_catalog.jsonb_build_object('before', v_row.hourly_rate_cents, 'after', v_rate));
  end if;

  if v_changes = '{}'::jsonb then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'changes', v_changes,
      'row', pg_catalog.jsonb_build_object('id', v_row.id, 'email', v_row.email, 'name', v_row.name, 'role', v_row.role,
        'market', v_row.market, 'active', v_row.active, 'hourly_rate_cents', v_row.hourly_rate_cents));
  end if;

  update public.field_workers
     set name = v_name,
         role = v_role,
         market = v_market,
         active = v_active,
         hourly_rate_cents = v_rate
   where id = v_row.id
   returning * into v_row;

  -- A switched-off worker gets no banners and no card. A worker demoted to
  -- team keeps alert banners (041) but never the lock-screen card.
  if v_row.active is not true then
    delete from public.push_tokens where pg_catalog.lower(email) = pg_catalog.lower(v_row.email);
    delete from public.live_activity_tokens where pg_catalog.lower(email) = pg_catalog.lower(v_row.email);
  elsif v_role = 'team' and v_changes ? 'role' then
    delete from public.live_activity_tokens where pg_catalog.lower(email) = pg_catalog.lower(v_row.email);
  end if;

  insert into public.field_worker_edits (worker_id, edited_by, edited_by_name, changes, created_at)
  values (v_row.id, v_uid, pg_catalog.left(coalesce(v_me.name, 'Owner'), 80), v_changes, v_now);

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'changes', v_changes,
    'row', pg_catalog.jsonb_build_object('id', v_row.id, 'email', v_row.email, 'name', v_row.name, 'role', v_row.role,
      'market', v_row.market, 'active', v_row.active, 'hourly_rate_cents', v_row.hourly_rate_cents));
end
$function$;

-- Supabase default privileges hand execute on a new function to anon,
-- authenticated AND service_role (seen 2026-09-13 before 042). Take every
-- default back, then grant the one caller: a logged-in phone (the function
-- checks the owner role itself). The worker never calls this.
revoke all on function public.hc_update_field_worker(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_update_field_worker(uuid, jsonb)
  to authenticated;

comment on function public.hc_update_field_worker(uuid, jsonb) is
  'Owner-only roster edit from the phone: name, role, market, active, hourly_rate_cents. Never your own role or access, never the last owner, never the App Review login, never someone still clocked in. Switching off deletes phone tokens. One audit row per change in field_worker_edits.';

comment on table public.field_worker_edits is
  'Audit trail of roster edits made through hc_update_field_worker: who, when, and {key: {before, after}}. Owner-readable.';

do $postflight$
begin
  if pg_catalog.to_regclass('public.field_worker_edits') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.field_worker_edits'::regclass) then
    raise exception using errcode = '55000', message = '043 postflight: the audit table or its row security is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'field_worker_edits'
      and policyname = 'field_worker_edits_owner_select'
  ) then
    raise exception using errcode = '55000', message = '043 postflight: the owner select policy is missing';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.field_worker_edits', 'select')
     or not pg_catalog.has_table_privilege('authenticated', 'public.field_worker_edits', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.field_worker_edits', 'insert')
     or not pg_catalog.has_table_privilege('service_role', 'public.field_worker_edits', 'insert') then
    raise exception using errcode = '55000', message = '043 postflight: audit table grants are wrong';
  end if;
  if pg_catalog.to_regprocedure('public.hc_update_field_worker(uuid, jsonb)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_update_field_worker(uuid, jsonb)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'public.hc_update_field_worker(uuid, jsonb)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_update_field_worker(uuid, jsonb)', 'execute') then
    raise exception using errcode = '55000', message = '043 postflight: hc_update_field_worker grants are wrong';
  end if;
  -- The roster itself stays read-only for phones: the function is the door.
  if pg_catalog.has_table_privilege('authenticated', 'public.field_workers', 'update') then
    raise exception using errcode = '55000', message = '043 postflight: authenticated must not update field_workers directly';
  end if;
end
$postflight$;

commit;
