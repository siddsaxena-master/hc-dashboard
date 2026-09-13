-- ============================================================================
-- 041_team_alert_push_tokens.sql
-- Let a crew phone (roster role "team") keep ONE push token for alert banners.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- Why: on 2026-09-12 the Pridwin wedding delivery ran 2h45 late and nobody
-- could have been told to leave, because migration 015 deletes every push
-- destination for a team-role identity (015:1421-1430). The departure plan
-- (040 and the Claudia worker) sends "leave by", "LEAVE NOW" and late banners
-- to the clocked-in crew, so their phones must be reachable.
--
-- What this changes: ONE function, public.hc_sync_notification_device, the
-- RPC every HC Field build calls after login to say "here is my phone's push
-- token". The signature, the security settings, the owner and manager
-- behaviour and every check are byte for byte what 015 installed. The only
-- new branch is for role "team": keep one alert token row (push_tokens, one
-- row per email), and still delete every lock-screen card token
-- (live_activity_tokens), because crew phones never get the card.
--
-- What this adds: public.notification_team_push_state, a one-row marker that
-- records when the first crew token was kept. The rollback refuses once that
-- has happened (repair forward, never strand a phone), the same rule 015c
-- uses for its capability secrets.
--
-- ORDER RULES (also written into hc-dashboard/CLAUDE.md):
--   * 015c before or after 041 is fine; 015c never redefines this function.
--   * NEVER run 016, 017 or 022 after 041 as they are written: each one
--     re-creates this function with the owner/manager-only rule and no error,
--     which silently strands every crew phone again. The preflight below
--     refuses when 022 is already installed. The 016 purge and 022 need a
--     rewritten file that keeps the team branch.
--   * 028 (owner MFA) is fine AFTER 041 (its wrapper delegates to the renamed
--     body) and must never run BEFORE a 041 re-run; the preflight refuses.
--
-- What this never touches: push_tokens rows for owners and managers, the
-- live_activity_tokens rules, orders, shifts, payroll, or any policy.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_signature text := 'public.hc_sync_notification_device(uuid,text,boolean,boolean)';
  v_column text;
  v_marker_stamped boolean := false;
begin
  -- (a) the 015 function must be there to replace
  if pg_catalog.to_regprocedure(v_signature) is null then
    raise exception using
      errcode = '55000',
      message = '041 blocked: migration-015 RPC public.hc_sync_notification_device(uuid,text,boolean,boolean) is missing';
  end if;

  -- (b) and it must still be hardened the way 015 left it (the 015c checks,
  -- copied for this one signature)
  if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_signature)
         and function_info.prosecdef is true
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value like 'search_path=%'
         )
     ) then
    raise exception using
      errcode = '55000',
      message = '041 blocked: migration-015 RPC hc_sync_notification_device is not hardened as 015 left it';
  end if;

  -- (c) migration 022 installs a trigger function and rewrites this RPC to
  -- owner/manager only; 041 as written would be undone by it
  if pg_catalog.to_regprocedure('public.hc_enforce_notification_destination_authorization()') is not null then
    raise exception using
      errcode = '55000',
      message = '041 blocked: migration 022 is installed (its trigger function exists); write a replacement that keeps the team branch';
  end if;

  -- (d) migration 028 renames this RPC and wraps it; 041 would then edit the
  -- wrong function
  if pg_catalog.to_regprocedure('public.hc_sync_notification_device_pre_mfa_028(uuid,text,boolean,boolean)') is not null then
    raise exception using
      errcode = '55000',
      message = '041 blocked: migration 028 is installed; rewrite 041 as a change to hc_sync_notification_device_pre_mfa_028 so the MFA wrapper survives';
  end if;

  -- (e) migration 016's cutover drops the 008 anon policies on push_tokens
  -- and purges team rows. If that policy is gone and nobody stamped the
  -- marker to say a deliberate later migration removed it, refuse. The
  -- marker is read through dynamic SQL because on a first run the table
  -- does not exist yet and plpgsql would otherwise refuse to parse the block.
  if not exists (
       select 1 from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = 'push_tokens'
         and policyname = 'push_tokens_anon_insert'
     ) then
    if pg_catalog.to_regclass('public.notification_team_push_state') is not null then
      execute 'select exists (select 1 from public.notification_team_push_state'
           || ' where singleton is true and anon_push_policies_dropped_at is not null)'
      into v_marker_stamped;
    end if;
    if v_marker_stamped is not true then
      raise exception using
        errcode = '55000',
        message = '041 blocked: the migration-016 cutover appears installed (the 008 push_tokens policies are gone); write a replacement that checks notification_team_push_state';
    end if;
  end if;

  -- the tables and columns the function reads
  if pg_catalog.to_regclass('public.push_tokens') is null
     or pg_catalog.to_regclass('public.live_activity_tokens') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception using
      errcode = '55000',
      message = '041 requires push_tokens, live_activity_tokens, field_workers and auth.uid()';
  end if;

  foreach v_column in array array['email', 'apns_token', 'platform', 'updated_at', 'device_id'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.push_tokens'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('041 requires column public.push_tokens.%s (015 adds device_id)', v_column);
    end if;
  end loop;

  foreach v_column in array array['auth_user_id', 'email', 'role', 'active'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.field_workers'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('041 requires field_workers.%s from migration 015', v_column);
    end if;
  end loop;
end
$preflight$;

-- The marker. One row, service_role only, never read by a phone.
create table if not exists public.notification_team_push_state (
  singleton boolean primary key default true,
  installed_at timestamptz not null default pg_catalog.clock_timestamp(),
  -- stamped the first time a crew phone's token is kept; the rollback
  -- refuses from then on
  ever_kept_team_token_at timestamptz,
  -- stamped by a later, deliberate migration that removes the 008 anon
  -- policies, so this file's preflight (e) still passes on a re-run
  anon_push_policies_dropped_at timestamptz,
  constraint notification_team_push_state_singleton_check check (singleton is true)
);

alter table public.notification_team_push_state enable row level security;
revoke all on table public.notification_team_push_state from public, anon, authenticated, service_role;
grant select, update on table public.notification_team_push_state to service_role;

insert into public.notification_team_push_state (singleton)
values (true)
on conflict (singleton) do nothing;

-- The 015 function with one new branch. Everything outside the block marked
-- "041" is 015:1346-1465 verbatim.
create or replace function public.hc_sync_notification_device(
  p_device_id uuid,
  p_apns_token text,
  p_push_allowed boolean,
  p_live_supported boolean
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
  v_token text := nullif(lower(trim(p_apns_token)), '');
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

  if p_push_allowed is null or p_live_supported is null then
    raise exception using
      errcode = '22023',
      message = 'notification capability state is required';
  end if;

  if v_token is not null
     and (length(v_token) < 32
     or length(v_token) > 512
     or v_token !~ '^[0-9a-f]+$') then
    raise exception using
      errcode = '22023',
      message = 'invalid APNs token';
  end if;

  -- Resolve the roster row even when it is inactive. That lets a deactivated
  -- or downgraded account authenticate once and remove every stale destination.
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

  -- Possession of the stable device ID reclaims both notification channels
  -- from a prior login. Possession of the exact APNs token also repairs a
  -- legacy push row that predates device IDs.
  delete from public.push_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  delete from public.live_activity_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  if v_token is not null then
    delete from public.push_tokens
    where lower(apns_token) = v_token
      and lower(email) <> v_email;
  end if;

  -- 041: team joins the eligible roles for ALERT tokens only.
  if v_active is not true or v_role not in ('owner', 'manager', 'team') then
    -- Eligibility is account-wide. A deactivation or role downgrade removes
    -- every destination for that identity, including rows on another phone.
    delete from public.push_tokens
    where lower(email) = v_email;

    delete from public.live_activity_tokens
    where lower(email) = v_email;
    return;
  end if;

  if v_role = 'team' then
    -- 041: crew phones get alert banners only. Never a lock-screen card token.
    delete from public.live_activity_tokens
    where lower(email) = v_email;

    if p_push_allowed is true and v_token is not null then
      insert into public.push_tokens (
        email,
        apns_token,
        platform,
        updated_at,
        device_id
      ) values (
        v_email,
        v_token,
        'ios',
        clock_timestamp(),
        p_device_id
      )
      on conflict (email) do update
      set apns_token = excluded.apns_token,
          platform = excluded.platform,
          updated_at = excluded.updated_at,
          device_id = excluded.device_id;

      update public.notification_team_push_state
      set ever_kept_team_token_at = coalesce(ever_kept_team_token_at, clock_timestamp())
      where singleton is true;
      if not found then
        raise exception using
          errcode = '55000',
          message = 'notification team push state is missing';
      end if;
    elsif p_push_allowed is not true then
      -- Same rule as the owner branch below: a granted permission with no
      -- Apple token yet changes nothing; a denial removes this phone and any
      -- legacy null-device row.
      delete from public.push_tokens
      where lower(email) = v_email
        and (device_id = p_device_id or device_id is null);
    end if;
    return;
  end if;
  -- end 041

  if p_push_allowed is true and v_token is not null then
    insert into public.push_tokens (
      email,
      apns_token,
      platform,
      updated_at,
      device_id
    ) values (
      v_email,
      v_token,
      'ios',
      clock_timestamp(),
      p_device_id
    )
    on conflict (email) do update
    set apns_token = excluded.apns_token,
        platform = excluded.platform,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id;
  elsif p_push_allowed is not true then
    -- Preserve a newer phone for the same account. A null device ID is the
    -- legacy one-phone row and is safe to remove under the retained model.
    delete from public.push_tokens
    where lower(email) = v_email
      and (device_id = p_device_id or device_id is null);
  end if;

  if p_live_supported is not true then
    delete from public.live_activity_tokens
    where lower(email) = v_email
      and (device_id = p_device_id or device_id is null);
  end if;
end
$function$;

revoke all on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  to authenticated, service_role;

comment on function public.hc_sync_notification_device(uuid, text, boolean, boolean) is
  'Per-login reconciliation of one phone''s push destinations (015, extended by 041). Owners and managers: one alert token row and their lock-screen card tokens, as 015. Team: one alert token row only; card tokens are always deleted. Inactive or unknown roles lose every destination.';

do $postflight$
declare
  v_signature text := 'public.hc_sync_notification_device(uuid,text,boolean,boolean)';
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.hc_sync_notification_device(uuid,text,boolean,boolean)'));
begin
  if pg_catalog.strpos(v_definition, 'if v_role = ''team'' then') = 0
     or pg_catalog.strpos(v_definition, 'ever_kept_team_token_at') = 0 then
    raise exception using errcode = '55000', message = '041 postflight: the team branch is not in the installed function';
  end if;

  if pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_signature)
         and function_info.prosecdef is true
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value like 'search_path=%'
         )
     ) then
    raise exception using errcode = '55000', message = '041 postflight: the function grants or hardening are wrong';
  end if;

  if (select count(*) from public.notification_team_push_state) <> 1 then
    raise exception using errcode = '55000', message = '041 postflight: notification_team_push_state must hold exactly one row';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.notification_team_push_state', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.notification_team_push_state', 'select') then
    raise exception using errcode = '55000', message = '041 postflight: the marker table must be service_role only';
  end if;
end
$postflight$;

commit;
