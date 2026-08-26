-- ============================================================================
-- 017_live_activity_end_delivery_rollback.sql
-- Guarded rollback for 017_live_activity_end_delivery.sql.
--
-- ORDER IS REQUIRED:
--   1. Keep the 017 worker and pushdrain running during a maintenance window.
--      Wait until BOTH verification queries below return zero.
--   2. Stop the 017 worker producer and pushdrain consumer.
--   3. Run BOTH verification queries again. They must still return zero.
--   4. Run THIS rollback.
--   5. Only then run 016_field_auth_cutover_rollback.sql if still required.
--
-- Read-only verification queries:
--   select count(*) as unfinished_la_end_rows
--   from public.push_queue
--   where kind = 'la_end' and done_at is null;
--
--   select count(*) as active_end_links
--   from public.live_activity_tokens
--   where end_requested_at is not null or end_queue_id is not null;
--
-- Do not manually null these fields. The 017 trigger intentionally rejects a
-- casual client-side clear, and forced cleanup could strand a lock-screen card.
-- If either count does not reach zero, keep 017 in place and repair/restart the
-- worker or pushdrain recovery path first. The preflight below fails closed.
--
-- This file never deletes a token row to force old email-wide uniqueness. If
-- two devices now share one email/token lane, rollback stops and preserves all
-- rows. Resolve that operationally, or stay on 017. The final compatibility
-- trigger is deliberately retained for a later 016 emergency rollback: it lets
-- build 24 rotate its null-device token without SELECT privilege on the token
-- table. It becomes active only for a legacy INSERT with device_id null.
-- ============================================================================

begin;

-- Hold token and queue state still from preflight through commit. This prevents
-- a new lease, token rotation, or queue insert from racing the rollback checks.
lock table
  public.live_activity_tokens,
  public.push_queue
in share row exclusive mode;

do $preflight$
declare
  v_duplicate_groups integer;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'live_activity_tokens'
      and column_name = 'end_requested_at'
      and data_type = 'timestamp with time zone'
  ) then
    raise exception using
      errcode = '55000',
      message = '017 rollback blocked: end_requested_at is missing or incompatible';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'live_activity_tokens'
      and column_name = 'end_queue_id'
      and data_type = 'uuid'
  ) then
    raise exception using
      errcode = '55000',
      message = '017 rollback blocked: end_queue_id is missing or incompatible';
  end if;

  -- This enforces rollback order. Migration 016 cutover revoked these rights;
  -- its emergency rollback restores them. If they are already present, 016 was
  -- rolled back too early and this transaction must not continue.
  if pg_catalog.has_table_privilege(
       'anon', 'public.live_activity_tokens', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'anon', 'public.live_activity_tokens', 'UPDATE'
     ) then
    raise exception using
      errcode = '42501',
      message = '017 rollback blocked: run it before the 016 rollback restores anonymous token writes';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'live_activity_tokens'
      and ('anon' = any(roles) or 'public' = any(roles))
  ) then
    raise exception using
      errcode = '42501',
      message = '017 rollback blocked: anonymous token policy already exists; rollback order is wrong';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens
    where end_requested_at is not null
       or end_queue_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = '017 rollback blocked: Live Activity END leases are still active';
  end if;

  if exists (
    select 1
    from public.push_queue
    where kind = 'la_end'
      and done_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '017 rollback blocked: unfinished Live Activity END queue rows remain';
  end if;

  select count(*)
  into v_duplicate_groups
  from (
    select email, token_type
    from public.live_activity_tokens
    where shift_id is null
    group by email, token_type
    having count(*) > 1
    union all
    select email, token_type
    from public.live_activity_tokens
    where shift_id is not null
    group by email, token_type, shift_id
    having count(*) > 1
  ) as duplicate_groups;

  if v_duplicate_groups > 0 then
    raise exception using
      errcode = '23505',
      message = '017 rollback blocked: multiple physical phones share an email/token lane; no rows were deleted';
  end if;
end
$preflight$;

drop function if exists public.hc_claim_live_activity_ends(
  timestamptz, timestamptz, integer
);
drop function if exists public.hc_list_managed_open_shift_ids();

drop trigger if exists live_activity_tokens_reset_end_request
  on public.live_activity_tokens;
drop function if exists public.hc_reset_live_activity_end_request();

drop index if exists public.live_activity_tokens_end_request_idx;
drop index if exists public.live_activity_tokens_legacy_p2s_uidx;
drop index if exists public.live_activity_tokens_legacy_update_uidx;

-- Restore migration 010's email-wide conflict targets. The preflight above
-- guarantees these indexes never discard or merge a phone row.
create unique index live_activity_tokens_p2s_uniq
  on public.live_activity_tokens (email, token_type)
  where shift_id is null;

create unique index live_activity_tokens_upd_uniq
  on public.live_activity_tokens (email, token_type, shift_id)
  where shift_id is not null;

-- Restore the 015/016 registration behavior whose ON CONFLICT clauses depend
-- on the email-wide indexes above.
create or replace function public.hc_register_live_activity_token(
  p_token_type text,
  p_shift_id uuid,
  p_token text,
  p_device_id uuid,
  p_supported boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_role text;
  v_active boolean;
  v_type text := lower(trim(p_token_type));
  v_token text := nullif(lower(trim(p_token)), '');
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated Supabase user required';
  end if;

  if p_device_id is null then
    raise exception using
      errcode = '22023',
      message = 'device ID is required';
  end if;

  if p_supported is null then
    raise exception using
      errcode = '22023',
      message = 'Live Activity support state is required';
  end if;

  if v_token is not null
     and (length(v_token) < 32
     or length(v_token) > 512
     or v_token !~ '^[0-9a-f]+$') then
    raise exception using
      errcode = '22023',
      message = 'invalid Live Activity token';
  end if;

  if v_type not in ('push_to_start', 'activity_update') then
    raise exception using
      errcode = '22023',
      message = 'unsupported Live Activity token type';
  end if;

  if p_supported is true and v_token is null then
    raise exception using
      errcode = '22023',
      message = 'Live Activity token is required when supported';
  end if;

  select lower(fw.email), fw.role, fw.active
  into v_email, v_role, v_active
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
  limit 1;

  if v_email is null then
    raise exception using
      errcode = '42501',
      message = 'linked field worker identity required';
  end if;

  delete from public.live_activity_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  if v_token is not null then
    delete from public.live_activity_tokens
    where lower(token) = v_token
      and lower(email) <> v_email;
  end if;

  if v_active is not true or v_role not in ('owner', 'manager') then
    delete from public.push_tokens
    where lower(email) = v_email;

    delete from public.live_activity_tokens
    where lower(email) = v_email;
    return;
  end if;

  if p_supported is not true then
    delete from public.live_activity_tokens
    where lower(email) = v_email
      and (device_id = p_device_id or device_id is null);
    return;
  end if;

  if v_type = 'push_to_start' then
    if p_shift_id is not null then
      raise exception using
        errcode = '22023',
        message = 'push_to_start token must not have a shift ID';
    end if;

    insert into public.live_activity_tokens (
      email, token_type, shift_id, token, updated_at, device_id
    ) values (
      v_email, 'push_to_start', null, v_token, clock_timestamp(), p_device_id
    )
    on conflict (email, token_type) where shift_id is null do update
    set token = excluded.token,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id;

  elsif v_type = 'activity_update' then
    if p_shift_id is null
       or not exists (select 1 from public.shifts where id = p_shift_id) then
      raise exception using
        errcode = '22023',
        message = 'activity_update token requires a valid shift ID';
    end if;

    insert into public.live_activity_tokens (
      email, token_type, shift_id, token, updated_at, device_id
    ) values (
      v_email, 'activity_update', p_shift_id, v_token,
      clock_timestamp(), p_device_id
    )
    on conflict (email, token_type, shift_id) where shift_id is not null do update
    set token = excluded.token,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id;
  end if;
end
$function$;

revoke all on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  to authenticated, service_role;

alter table public.live_activity_tokens
  drop column end_requested_at,
  drop column end_queue_id;

-- Build 24 cannot SELECT token rows, so its documented 409-then-PATCH path is
-- not reliable under row-level security. This narrow owner-run trigger avoids
-- the conflict: a null-device INSERT replaces exactly the old email/type/shift
-- lane before the unique index is checked. It grants no table visibility.
create or replace function public.hc_replace_legacy_live_activity_token()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.device_id is null then
    delete from public.live_activity_tokens as existing
    where existing.email = new.email
      and existing.token_type = new.token_type
      and existing.shift_id is not distinct from new.shift_id;
  end if;
  return new;
end
$function$;

revoke all on function public.hc_replace_legacy_live_activity_token()
  from public, anon, authenticated;

create trigger live_activity_tokens_replace_legacy_insert
before insert on public.live_activity_tokens
for each row
execute function public.hc_replace_legacy_live_activity_token();

do $assertions$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'live_activity_tokens'
      and column_name in ('end_requested_at', 'end_queue_id')
  ) then
    raise exception using
      errcode = '55000',
      message = '017 rollback assertion failed: end_requested_at still exists';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.hc_list_managed_open_shift_ids()'
     ) is not null then
    raise exception using
      errcode = '55000',
      message = '017 rollback assertion failed: forward-only RPC remains';
  end if;

  if pg_catalog.to_regclass('public.live_activity_tokens_p2s_uniq') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_upd_uniq') is null then
    raise exception using
      errcode = '55000',
      message = '017 rollback assertion failed: email-wide token indexes are missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as t
    where t.tgrelid = 'public.live_activity_tokens'::regclass
      and t.tgname = 'live_activity_tokens_replace_legacy_insert'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '017 rollback assertion failed: legacy INSERT compatibility trigger is missing';
  end if;

  if pg_catalog.has_function_privilege(
       'anon', 'public.hc_replace_legacy_live_activity_token()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.hc_replace_legacy_live_activity_token()', 'EXECUTE'
     )
     or exists (
       select 1
       from pg_catalog.pg_proc as p
       cross join lateral pg_catalog.aclexplode(
         coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) as privilege
       where p.oid = pg_catalog.to_regprocedure(
         'public.hc_replace_legacy_live_activity_token()'
       )
         and privilege.grantee = 0
         and privilege.privilege_type = 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '017 rollback assertion failed: compatibility trigger function is executable by a client role';
  end if;

  if pg_catalog.has_table_privilege(
       'anon', 'public.live_activity_tokens', 'SELECT'
     )
     or exists (
       select 1
       from information_schema.table_privileges as privilege
       where privilege.table_schema = 'public'
         and privilege.table_name = 'live_activity_tokens'
         and privilege.grantee = 'PUBLIC'
         and privilege.privilege_type = 'SELECT'
     ) then
    raise exception using
      errcode = '42501',
      message = '017 rollback assertion failed: token SELECT access was exposed';
  end if;
end
$assertions$;

commit;
