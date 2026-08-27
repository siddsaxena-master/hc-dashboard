-- ============================================================================
-- 021_notification_device_authorization_transition.sql
-- Durable notification-device authorization, transition stage.
--
-- LOCAL DRAFT. Running this against Supabase is a production write and needs
-- Sidd's explicit "yes do it" confirmation.
--
-- ROLLOUT ORDER
--   1. Run 021 while the currently installed authenticated build is live.
--   2. Ship one app build that calls hc_authorize_notification_device once per
--      install, stores the returned revoke secret in SecureStore, and calls
--      hc_revoke_notification_device if the Supabase session disappears.
--   3. Confirm every notification phone has one active authorization.
--   4. Run 022 to require that authorization for every future registration.
--
-- This transition does not change the signatures or behavior of the existing
-- notification registration RPCs. The old authenticated build therefore keeps
-- working until 022. A capability revoke is effective immediately: it removes
-- normal push and push-to-start destinations for only that physical device.
-- Activity-update tokens are deliberately retained so a closed shift can still
-- deliver its final ActivityKit END after the app session has disappeared.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

do $preflight$
begin
  if pg_catalog.to_regprocedure(
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '021 requires migrations 015 through 018';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pgcrypto'
  ) then
    raise exception using
      errcode = '55000',
      message = '021 requires pgcrypto';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension as extension_info
    join pg_catalog.pg_proc as function_info
      on function_info.pronamespace = extension_info.extnamespace
    where extension_info.extname = 'pgcrypto'
      and function_info.proname = 'gen_random_bytes'
      and pg_catalog.pg_get_function_identity_arguments(function_info.oid) =
          'integer'
  ) or not exists (
    select 1
    from pg_catalog.pg_extension as extension_info
    join pg_catalog.pg_proc as function_info
      on function_info.pronamespace = extension_info.extnamespace
    where extension_info.extname = 'pgcrypto'
      and function_info.proname = 'digest'
      and pg_catalog.pg_get_function_identity_arguments(function_info.oid) =
          'bytea, text'
  ) then
    raise exception using
      errcode = '55000',
      message = '021 requires pgcrypto gen_random_bytes(integer) and digest(bytea,text)';
  end if;
end
$preflight$;

-- pgcrypto lives in the extensions schema on Supabase but may live in public
-- on a local PostgreSQL clone. These two private wrappers resolve the installed
-- extension schema from pg_catalog instead of trusting search_path.
create or replace function public.hc_notification_random_secret()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_extension_schema text;
  v_secret text;
begin
  select namespace_info.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = extension_info.extnamespace
  where extension_info.extname = 'pgcrypto';

  if v_extension_schema is null then
    raise exception using
      errcode = '55000',
      message = 'pgcrypto extension is unavailable';
  end if;

  execute pg_catalog.format(
    'select pg_catalog.encode(%I.gen_random_bytes(32), ''hex'')',
    v_extension_schema
  ) into v_secret;

  if v_secret is null
     or length(v_secret) <> 64
     or v_secret !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '55000',
      message = 'failed to generate a 32-byte notification capability';
  end if;

  return v_secret;
end
$function$;

create or replace function public.hc_notification_secret_hash(p_secret text)
returns bytea
language plpgsql
stable
strict
security definer
set search_path = ''
as $function$
declare
  v_extension_schema text;
  v_hash bytea;
begin
  select namespace_info.nspname
  into v_extension_schema
  from pg_catalog.pg_extension as extension_info
  join pg_catalog.pg_namespace as namespace_info
    on namespace_info.oid = extension_info.extnamespace
  where extension_info.extname = 'pgcrypto';

  if v_extension_schema is null then
    raise exception using
      errcode = '55000',
      message = 'pgcrypto extension is unavailable';
  end if;

  execute pg_catalog.format(
    'select %I.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256'')',
    v_extension_schema
  ) into v_hash using p_secret;

  return v_hash;
end
$function$;

revoke all on function public.hc_notification_random_secret()
  from public, anon, authenticated;
revoke all on function public.hc_notification_secret_hash(text)
  from public, anon, authenticated;

-- One row represents one app-generated physical-device UUID. Only a SHA-256
-- hash of the 32-byte capability is stored. The raw capability is returned
-- once to the authenticated app and belongs in iOS SecureStore, never SQL.
create table if not exists public.notification_device_authorizations (
  device_id          uuid primary key,
  auth_user_id       uuid not null references auth.users(id) on delete cascade,
  field_worker_id    uuid not null references public.field_workers(id) on delete cascade,
  revoke_secret_hash bytea not null,
  secret_version     integer not null default 1,
  authorized_at      timestamptz not null default clock_timestamp(),
  last_registered_at timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  constraint notification_device_authorizations_hash_check
    check (octet_length(revoke_secret_hash) = 32),
  constraint notification_device_authorizations_version_check
    check (secret_version > 0),
  constraint notification_device_authorizations_revoke_check
    check (
      (revoked_at is null and revoked_reason is null)
      or (
        revoked_at is not null
        and nullif(pg_catalog.btrim(revoked_reason), '') is not null
        and length(revoked_reason) <= 120
      )
    )
);

create index if not exists notification_device_authorizations_user_idx
  on public.notification_device_authorizations (auth_user_id, revoked_at);

create index if not exists notification_device_authorizations_worker_idx
  on public.notification_device_authorizations (field_worker_id, revoked_at);

alter table public.notification_device_authorizations enable row level security;

-- No client gets direct table access. Security-definer RPCs below are the only
-- client entry points, and neither RPC can return the stored hash.
revoke all on table public.notification_device_authorizations
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.notification_device_authorizations to service_role;

create table if not exists public.notification_device_security_state (
  singleton             boolean primary key default true,
  transition_installed_at timestamptz not null default clock_timestamp(),
  cutover_at            timestamptz,
  constraint notification_device_security_state_singleton_check
    check (singleton is true)
);

insert into public.notification_device_security_state (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.notification_device_security_state enable row level security;
revoke all on table public.notification_device_security_state
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.notification_device_security_state to service_role;

-- Revoking or deleting one authorization always removes only that device's
-- ordinary push and push-to-start addresses. Activity-update rows survive for
-- the END recovery worker.
create or replace function public.hc_purge_revoked_notification_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_id uuid;
  v_should_purge boolean := false;
begin
  if tg_op = 'DELETE' then
    v_device_id := old.device_id;
    v_should_purge := true;
  else
    v_device_id := new.device_id;
    v_should_purge := new.revoked_at is not null
      or new.auth_user_id is distinct from old.auth_user_id
      or new.field_worker_id is distinct from old.field_worker_id;
  end if;

  if v_should_purge then
    delete from public.push_tokens
    where device_id = v_device_id;

    delete from public.live_activity_tokens
    where device_id = v_device_id
      and token_type = 'push_to_start'
      and shift_id is null;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

revoke all on function public.hc_purge_revoked_notification_device()
  from public, anon, authenticated;

drop trigger if exists notification_device_authorizations_purge
  on public.notification_device_authorizations;
create trigger notification_device_authorizations_purge
after update of auth_user_id, field_worker_id, revoked_at
or delete on public.notification_device_authorizations
for each row
execute function public.hc_purge_revoked_notification_device();

-- A roster downgrade, deactivation, identity relink, or email change revokes
-- every physical device for that worker. This closes the gap where a dashboard
-- edit could otherwise leave a normal push token eligible indefinitely.
create or replace function public.hc_revoke_ineligible_worker_devices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.active is not true
     or new.role not in ('owner', 'manager')
     or new.auth_user_id is null
     or new.auth_user_id is distinct from old.auth_user_id
     or lower(new.email) is distinct from lower(old.email) then
    update public.notification_device_authorizations as device_auth
    set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
        revoked_reason = coalesce(
          device_auth.revoked_reason,
          'field worker eligibility changed'
        ),
        updated_at = clock_timestamp()
    where device_auth.field_worker_id = old.id;
  end if;

  return new;
end
$function$;

revoke all on function public.hc_revoke_ineligible_worker_devices()
  from public, anon, authenticated;

drop trigger if exists field_workers_revoke_notification_devices
  on public.field_workers;
create trigger field_workers_revoke_notification_devices
after update of active, role, auth_user_id, email
on public.field_workers
for each row
execute function public.hc_revoke_ineligible_worker_devices();

-- Active, linked owners and managers can create or rotate a capability. Each
-- call returns a new 64-character hex encoding of 32 random bytes and replaces
-- the stored hash. A lost response is safe: retrying rotates again and returns
-- the only secret that remains valid.
create or replace function public.hc_authorize_notification_device(
  p_device_id uuid
)
returns table (
  device_id uuid,
  revoke_secret text,
  secret_version integer,
  authorized_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker_id uuid;
  v_prior_auth_user_id uuid;
  v_secret text;
  v_hash bytea;
  v_secret_version integer;
  v_authorized_at timestamptz := clock_timestamp();
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

  select fw.id
  into v_worker_id
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
    and fw.active is true
    and fw.role in ('owner', 'manager')
  limit 1;

  if v_worker_id is null then
    raise exception using
      errcode = '42501',
      message = 'active owner or manager required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hc-notification-device:' || p_device_id::text,
      0
    )
  );

  select device_auth.auth_user_id
  into v_prior_auth_user_id
  from public.notification_device_authorizations as device_auth
  where device_auth.device_id = p_device_id
  for update;

  v_secret := public.hc_notification_random_secret();
  v_hash := public.hc_notification_secret_hash(v_secret);

  insert into public.notification_device_authorizations as device_auth (
    device_id,
    auth_user_id,
    field_worker_id,
    revoke_secret_hash,
    secret_version,
    authorized_at,
    last_registered_at,
    revoked_at,
    revoked_reason,
    updated_at
  ) values (
    p_device_id,
    auth.uid(),
    v_worker_id,
    v_hash,
    1,
    v_authorized_at,
    null,
    null,
    null,
    v_authorized_at
  )
  on conflict on constraint notification_device_authorizations_pkey do update
  set auth_user_id = excluded.auth_user_id,
      field_worker_id = excluded.field_worker_id,
      revoke_secret_hash = excluded.revoke_secret_hash,
      secret_version = device_auth.secret_version + 1,
      authorized_at = excluded.authorized_at,
      last_registered_at = case
        when device_auth.auth_user_id = excluded.auth_user_id
         and device_auth.field_worker_id = excluded.field_worker_id
          then device_auth.last_registered_at
        else null
      end,
      revoked_at = null,
      revoked_reason = null,
      updated_at = excluded.updated_at
  returning device_auth.secret_version
  into v_secret_version;

  -- The row trigger performs this purge when identity changed. Keep this
  -- explicit branch as defense if the trigger was disabled during repair.
  if v_prior_auth_user_id is not null
     and v_prior_auth_user_id is distinct from auth.uid() then
    delete from public.push_tokens as push_token
    where push_token.device_id = p_device_id;
    delete from public.live_activity_tokens as live_token
    where live_token.device_id = p_device_id
      and live_token.token_type = 'push_to_start'
      and live_token.shift_id is null;
  end if;

  return query
  select p_device_id, v_secret, v_secret_version, v_authorized_at;
end
$function$;

-- This is a bearer-capability RPC. It intentionally works after the Auth JWT
-- has vanished. A caller must supply both the physical-device UUID and the
-- exact 256-bit secret. Wrong, malformed, old, or rotated secrets change no
-- state. Repeating the correct revoke is idempotent.
create or replace function public.hc_revoke_notification_device(
  p_device_id uuid,
  p_revoke_secret text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_hash bytea;
  v_matched boolean := false;
begin
  if p_device_id is null
     or p_revoke_secret is null
     or length(p_revoke_secret) <> 64
     or p_revoke_secret !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  v_hash := public.hc_notification_secret_hash(p_revoke_secret);

  update public.notification_device_authorizations as device_auth
  set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
      revoked_reason = coalesce(
        device_auth.revoked_reason,
        'device capability revoked'
      ),
      updated_at = case
        when device_auth.revoked_at is null
          then clock_timestamp()
        else device_auth.updated_at
      end
  where device_auth.device_id = p_device_id
    and device_auth.revoke_secret_hash = v_hash
  returning true into v_matched;

  -- The authorization trigger removes normal and START destinations. This
  -- repeat makes revocation fail closed even if that trigger was disabled by
  -- an operator. It never touches activity_update rows.
  if v_matched then
    delete from public.push_tokens where device_id = p_device_id;
    delete from public.live_activity_tokens
    where device_id = p_device_id
      and token_type = 'push_to_start'
      and shift_id is null;
  end if;

  return v_matched;
end
$function$;

revoke all on function public.hc_authorize_notification_device(uuid)
  from public, anon, authenticated;
revoke all on function public.hc_revoke_notification_device(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hc_authorize_notification_device(uuid)
  to authenticated;
grant execute on function public.hc_revoke_notification_device(uuid, text)
  to anon, authenticated;

-- App Review shifts are synthetic and must never keep a real owner's local
-- card alive during foreground truth reconciliation.
create or replace function public.hc_list_managed_open_shift_ids()
returns table (shift_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.hc_can_manage_shifts() then
    raise exception using
      errcode = '42501',
      message = 'owner or manager required';
  end if;

  return query
  select s.id as shift_id
  from public.shifts as s
  where s.clock_out_at is null
    and lower(coalesce(s.worker_email, '')) <>
        'appreview@hamptonscoconuts.com'
  order by s.clock_in_at asc, s.id asc;
end
$function$;

revoke all on function public.hc_list_managed_open_shift_ids()
  from public, anon, authenticated;
grant execute on function public.hc_list_managed_open_shift_ids()
  to authenticated, service_role;

do $assertions$
declare
  v_privilege text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.notification_device_authorizations'::regclass
      and table_info.relrowsecurity
  ) or not exists (
    select 1
    from pg_catalog.pg_class as table_info
    where table_info.oid =
          'public.notification_device_security_state'::regclass
      and table_info.relrowsecurity
  ) then
    raise exception using
      errcode = '42501',
      message = '021 assertion failed: authorization RLS is disabled';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_device_authorizations'
      and column_name in ('revoke_secret', 'capability_secret', 'secret')
  ) then
    raise exception using
      errcode = '42501',
      message = '021 assertion failed: plaintext capability column exists';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policies as policy_info
    where policy_info.schemaname = 'public'
      and policy_info.tablename in (
        'notification_device_authorizations',
        'notification_device_security_state'
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '021 assertion failed: private notification table has a policy';
  end if;

  foreach v_privilege in array array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ] loop
    if pg_catalog.has_table_privilege(
         'anon', 'public.notification_device_authorizations', v_privilege
       )
       or pg_catalog.has_table_privilege(
         'authenticated',
         'public.notification_device_authorizations',
         v_privilege
       )
       or pg_catalog.has_table_privilege(
         'anon', 'public.notification_device_security_state', v_privilege
       )
       or pg_catalog.has_table_privilege(
         'authenticated',
         'public.notification_device_security_state',
         v_privilege
       ) then
      raise exception using
        errcode = '42501',
        message = pg_catalog.format(
          '021 assertion failed: client retains authorization table %s',
          v_privilege
        );
    end if;
  end loop;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_authorize_notification_device(uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_authorize_notification_device(uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'anon',
       'public.hc_revoke_notification_device(uuid,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_revoke_notification_device(uuid,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.hc_notification_secret_hash(text)', 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '021 assertion failed: notification RPC grants are wrong';
  end if;

  if exists (
    select 1
    from (
      values
        ('public.hc_authorize_notification_device(uuid)'),
        ('public.hc_revoke_notification_device(uuid,text)')
    ) as required(signature)
    where not exists (
      select 1
      from pg_catalog.pg_proc as function_info
      where function_info.oid =
            pg_catalog.to_regprocedure(required.signature)
        and function_info.prosecdef is true
        and exists (
          select 1
          from pg_catalog.unnest(function_info.proconfig) as setting(value)
          where setting.value like 'search_path=%'
        )
    )
  ) then
    raise exception using
      errcode = '42501',
      message = '021 assertion failed: notification RPC hardening is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid =
          'public.notification_device_authorizations'::regclass
      and trigger_info.tgname =
          'notification_device_authorizations_purge'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) or not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.field_workers'::regclass
      and trigger_info.tgname = 'field_workers_revoke_notification_devices'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '021 assertion failed: durable revocation trigger is missing';
  end if;

  if pg_catalog.pg_get_functiondef(
       'public.hc_authorize_notification_device(uuid)'::regprocedure
     ) !~* 'on conflict[[:space:]]+on constraint[[:space:]]+notification_device_authorizations_pkey'
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::regprocedure
     ) !~ 'token_type = ''push_to_start'''
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::regprocedure
     ) ~ 'token_type = ''activity_update'''
     or pg_catalog.pg_get_functiondef(
       'public.hc_list_managed_open_shift_ids()'::regprocedure
     ) !~ 'appreview@hamptonscoconuts[.]com' then
    raise exception using
      errcode = '55000',
      message = '021 assertion failed: safe upsert, revoke preservation, or App Review exclusion is missing';
  end if;
end
$assertions$;

commit;
