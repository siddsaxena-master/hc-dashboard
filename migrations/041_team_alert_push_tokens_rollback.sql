-- ============================================================================
-- 041_team_alert_push_tokens_rollback.sql
-- Puts public.hc_sync_notification_device back to the exact text migration
-- 015 installed (owner and manager only), removes the crew alert tokens 041
-- allowed, and drops the marker table.
--
-- REFUSES once any crew phone has been issued an alert token
-- (notification_team_push_state.ever_kept_team_token_at is set). From that
-- point the crew are relying on those banners; repair forward with a new
-- migration instead of stranding phones. This is the same rule 015c's
-- rollback applies to its capability secrets.
--
-- Never run this after 028: 028 renames the function and wraps it, so the
-- text below would create a second, unwrapped function.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_kept boolean := false;
begin
  if pg_catalog.to_regprocedure('public.hc_sync_notification_device_pre_mfa_028(uuid,text,boolean,boolean)') is not null then
    raise exception using
      errcode = '55000',
      message = '041 rollback blocked: migration 028 is installed; the function is wrapped and must be repaired forward';
  end if;

  -- Read the marker through dynamic SQL: on a second run the table is
  -- already gone and plpgsql would otherwise refuse to parse this block.
  if pg_catalog.to_regclass('public.notification_team_push_state') is not null then
    execute 'select exists (select 1 from public.notification_team_push_state'
         || ' where singleton is true and ever_kept_team_token_at is not null)'
    into v_kept;
  end if;

  if v_kept is true then
    raise exception using
      errcode = '55000',
      message = '041 rollback blocked: a crew phone has been issued an alert token; repair forward';
  end if;
end
$preflight$;

-- 015:1346-1465, byte for byte.
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

  if v_active is not true or v_role not in ('owner', 'manager') then
    -- Eligibility is account-wide. A deactivation or role downgrade removes
    -- every destination for that identity, including rows on another phone.
    delete from public.push_tokens
    where lower(email) = v_email;

    delete from public.live_activity_tokens
    where lower(email) = v_email;
    return;
  end if;

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

-- Crew tokens 041 allowed are no longer legal destinations.
delete from public.push_tokens as pt
where exists (
  select 1
  from public.field_workers as fw
  where lower(fw.email) = lower(pt.email)
    and fw.role = 'team'
);

drop table if exists public.notification_team_push_state;

do $postflight$
declare
  v_definition text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.hc_sync_notification_device(uuid,text,boolean,boolean)'));
begin
  if pg_catalog.strpos(v_definition, 'if v_role = ''team'' then') > 0
     or pg_catalog.to_regclass('public.notification_team_push_state') is not null then
    raise exception using errcode = '55000', message = '041 rollback postflight: the team branch or the marker table is still present';
  end if;
end
$postflight$;

commit;
