-- ============================================================================
-- 022_notification_device_authorization_cutover.sql
-- Enforce durable notification-device authorization.
--
-- LOCAL DRAFT. Running this against Supabase is a production write and needs
-- Sidd's explicit "yes do it" confirmation.
--
-- REQUIRED BEFORE RUNNING
--   * Migration 021 is live.
--   * The capability-aware app build is installed on every notification phone.
--   * Every current normal-push and push-to-start row passes these read-only
--     checks. Each query must return zero:
--
--   select count(*) from public.push_tokens as token_row
--   where not exists (
--     select 1
--     from public.notification_device_authorizations as device_auth
--     join public.field_workers as worker
--       on worker.id = device_auth.field_worker_id
--      and worker.auth_user_id = device_auth.auth_user_id
--      and worker.active is true
--      and worker.role in ('owner', 'manager')
--     where device_auth.device_id = token_row.device_id
--       and device_auth.revoked_at is null
--       and lower(worker.email) = lower(token_row.email)
--   );
--
--   select count(*) from public.live_activity_tokens as token_row
--   where token_row.token_type = 'push_to_start'
--     and token_row.shift_id is null
--     and not exists (
--       select 1
--       from public.notification_device_authorizations as device_auth
--       join public.field_workers as worker
--         on worker.id = device_auth.field_worker_id
--        and worker.auth_user_id = device_auth.auth_user_id
--        and worker.active is true
--        and worker.role in ('owner', 'manager')
--       where device_auth.device_id = token_row.device_id
--         and device_auth.revoked_at is null
--         and lower(worker.email) = lower(token_row.email)
--     );
--
-- The transaction repeats those checks under locks and aborts instead of
-- deleting an old build's destinations. Once installed, registration requires
-- both a valid Supabase session and an active authorization for that exact
-- auth.uid()/device pair. Revocation never removes activity-update tokens, so
-- migration 017 can still deliver END for a card after session loss.
-- ============================================================================

begin;

do $object_preflight$
begin
  if pg_catalog.to_regclass(
       'public.notification_device_authorizations'
     ) is null
     or pg_catalog.to_regclass(
       'public.notification_device_security_state'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_authorize_notification_device(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_revoke_notification_device(uuid,text)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '022 requires migration 021';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
     ) is null then
    raise exception using
      errcode = '55000',
      message = '022 requires migration 018';
  end if;
end
$object_preflight$;

lock table
  public.notification_device_authorizations,
  public.notification_device_security_state,
  public.field_workers,
  public.push_tokens,
  public.live_activity_tokens,
  public.live_activity_start_deliveries,
  public.push_queue
in share row exclusive mode;

do $state_preflight$
begin
  if not exists (
    select 1
    from public.notification_device_authorizations as device_auth
    join public.field_workers as worker
      on worker.id = device_auth.field_worker_id
     and worker.auth_user_id = device_auth.auth_user_id
     and worker.active is true
     and worker.role in ('owner', 'manager')
    where device_auth.revoked_at is null
  ) and not exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and cutover_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = '022 cutover blocked: no active authorized owner or manager phone exists';
  end if;

  if exists (
    select 1
    from public.push_tokens as token_row
    where token_row.device_id is null
       or not exists (
         select 1
         from public.notification_device_authorizations as device_auth
         join public.field_workers as worker
           on worker.id = device_auth.field_worker_id
          and worker.auth_user_id = device_auth.auth_user_id
          and worker.active is true
          and worker.role in ('owner', 'manager')
         where device_auth.device_id = token_row.device_id
           and device_auth.revoked_at is null
           and lower(worker.email) = lower(token_row.email)
       )
  ) then
    raise exception using
      errcode = '55000',
      message = '022 cutover blocked: normal push row lacks active device authorization';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens as token_row
    where token_row.token_type = 'push_to_start'
      and token_row.shift_id is null
      and (
        token_row.device_id is null
        or not exists (
          select 1
          from public.notification_device_authorizations as device_auth
          join public.field_workers as worker
            on worker.id = device_auth.field_worker_id
           and worker.auth_user_id = device_auth.auth_user_id
           and worker.active is true
           and worker.role in ('owner', 'manager')
          where device_auth.device_id = token_row.device_id
            and device_auth.revoked_at is null
            and lower(worker.email) = lower(token_row.email)
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = '022 cutover blocked: push-to-start row lacks active device authorization';
  end if;
end
$state_preflight$;

-- Enforce the authorization invariant for every new or identity/token-changing
-- destination write, including activity-update registration. The trigger does
-- not fire for END lease-only updates or deletes, so an already stored update
-- token still survives revocation and Auth loss until END finishes.
create or replace function public.hc_enforce_notification_destination_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.device_id is null
     or not exists (
       select 1
       from public.notification_device_authorizations as device_auth
       join public.field_workers as worker
         on worker.id = device_auth.field_worker_id
        and worker.auth_user_id = device_auth.auth_user_id
        and worker.active is true
        and worker.role in ('owner', 'manager')
       where device_auth.device_id = new.device_id
         and device_auth.revoked_at is null
         and lower(worker.email) = lower(new.email)
     ) then
    raise exception using
      errcode = '42501',
      message = 'active notification-device authorization required';
  end if;

  return new;
end
$function$;

revoke all on function public.hc_enforce_notification_destination_authorization()
  from public, anon, authenticated;

drop trigger if exists push_tokens_require_device_authorization
  on public.push_tokens;
create trigger push_tokens_require_device_authorization
before insert or update of email, apns_token, platform, device_id
on public.push_tokens
for each row
execute function public.hc_enforce_notification_destination_authorization();

drop trigger if exists live_activity_tokens_require_device_authorization
  on public.live_activity_tokens;
create trigger live_activity_tokens_require_device_authorization
before insert or update of email, token_type, shift_id, token, device_id
on public.live_activity_tokens
for each row
execute function public.hc_enforce_notification_destination_authorization();

-- Normal push reconciliation now requires a current authorization for the
-- caller's exact Auth identity, roster identity, and physical device.
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
  v_worker_id uuid;
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
     and (
       length(v_token) < 32
       or length(v_token) > 512
       or v_token !~ '^[0-9a-f]+$'
     ) then
    raise exception using
      errcode = '22023',
      message = 'invalid APNs token';
  end if;

  select fw.id, lower(fw.email), fw.role, fw.active
  into v_worker_id, v_email, v_role, v_active
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
  limit 1;

  if v_worker_id is null then
    raise exception using
      errcode = '42501',
      message = 'linked field worker identity required';
  end if;

  if v_active is not true or v_role not in ('owner', 'manager') then
    update public.notification_device_authorizations as device_auth
    set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
        revoked_reason = coalesce(
          device_auth.revoked_reason,
          'field worker is no longer notification eligible'
        ),
        updated_at = clock_timestamp()
    where device_auth.device_id = p_device_id
      and device_auth.auth_user_id = auth.uid();
    return;
  end if;

  if not exists (
    select 1
    from public.notification_device_authorizations as device_auth
    where device_auth.device_id = p_device_id
      and device_auth.auth_user_id = auth.uid()
      and device_auth.field_worker_id = v_worker_id
      and device_auth.revoked_at is null
  ) then
    raise exception using
      errcode = '42501',
      message = 'active notification-device authorization required';
  end if;

  -- Reclaim only future notification channels from a prior login. A prior
  -- identity's activity-update token is retained until END delivery completes.
  delete from public.push_tokens
  where device_id = p_device_id
    and lower(email) <> v_email;

  delete from public.live_activity_tokens
  where device_id = p_device_id
    and token_type = 'push_to_start'
    and shift_id is null
    and lower(email) <> v_email;

  if v_token is not null then
    delete from public.push_tokens
    where lower(apns_token) = v_token
      and lower(email) <> v_email;
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
    delete from public.push_tokens
    where lower(email) = v_email
      and device_id = p_device_id;
  end if;

  if p_live_supported is not true then
    delete from public.live_activity_tokens
    where lower(email) = v_email
      and device_id = p_device_id
      and token_type = 'push_to_start'
      and shift_id is null;
  end if;

  update public.notification_device_authorizations as device_auth
  set last_registered_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where device_auth.device_id = p_device_id
    and device_auth.auth_user_id = auth.uid()
    and device_auth.field_worker_id = v_worker_id
    and device_auth.revoked_at is null;
end
$function$;

-- Live Activity registration retains migration 017's per-device token model,
-- exact-token serialization, and END lease behavior. It adds authorization
-- enforcement and preserves activity-update tokens during disable/revoke.
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
  v_worker_id uuid;
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
     and (
       length(v_token) < 32
       or length(v_token) > 512
       or v_token !~ '^[0-9a-f]+$'
     ) then
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

  select fw.id, lower(fw.email), fw.role, fw.active
  into v_worker_id, v_email, v_role, v_active
  from public.field_workers as fw
  where fw.auth_user_id = auth.uid()
  limit 1;

  if v_worker_id is null then
    raise exception using
      errcode = '42501',
      message = 'linked field worker identity required';
  end if;

  if v_active is not true or v_role not in ('owner', 'manager') then
    update public.notification_device_authorizations as device_auth
    set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
        revoked_reason = coalesce(
          device_auth.revoked_reason,
          'field worker is no longer notification eligible'
        ),
        updated_at = clock_timestamp()
    where device_auth.device_id = p_device_id
      and device_auth.auth_user_id = auth.uid();
    return;
  end if;

  if not exists (
    select 1
    from public.notification_device_authorizations as device_auth
    where device_auth.device_id = p_device_id
      and device_auth.auth_user_id = auth.uid()
      and device_auth.field_worker_id = v_worker_id
      and device_auth.revoked_at is null
  ) then
    raise exception using
      errcode = '42501',
      message = 'active notification-device authorization required';
  end if;

  if p_supported is not true then
    delete from public.live_activity_tokens
    where lower(email) = v_email
      and device_id = p_device_id
      and token_type = 'push_to_start'
      and shift_id is null;

    update public.notification_device_authorizations as device_auth
    set last_registered_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where device_auth.device_id = p_device_id
      and device_auth.auth_user_id = auth.uid()
      and device_auth.field_worker_id = v_worker_id
      and device_auth.revoked_at is null;
    return;
  end if;

  -- One ActivityKit token is one physical destination. Serialize exact-token
  -- repair so regenerated device IDs cannot create duplicate destinations.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hc-live-activity:' || v_token, 0)
  );

  delete from public.live_activity_tokens
  where lower(token) = v_token
    and (
      device_id is distinct from p_device_id
      or lower(email) <> v_email
    );

  if v_type = 'push_to_start' then
    if p_shift_id is not null then
      raise exception using
        errcode = '22023',
        message = 'push_to_start token must not have a shift ID';
    end if;

    -- Only the future START channel is reclaimed from a prior login.
    delete from public.live_activity_tokens
    where device_id = p_device_id
      and token_type = 'push_to_start'
      and shift_id is null
      and lower(email) <> v_email;

    insert into public.live_activity_tokens (
      email, token_type, shift_id, token, updated_at, device_id
    ) values (
      v_email, 'push_to_start', null, v_token, clock_timestamp(), p_device_id
    )
    on conflict (device_id, token_type)
      where shift_id is null and device_id is not null
    do update
    set email = excluded.email,
        token = excluded.token,
        updated_at = excluded.updated_at;

  elsif v_type = 'activity_update' then
    if p_shift_id is null
       or not exists (
         select 1 from public.shifts where id = p_shift_id
       ) then
      raise exception using
        errcode = '22023',
        message = 'activity_update token requires a valid shift ID';
    end if;

    insert into public.live_activity_tokens (
      email, token_type, shift_id, token, updated_at, device_id
    ) values (
      v_email,
      'activity_update',
      p_shift_id,
      v_token,
      clock_timestamp(),
      p_device_id
    )
    on conflict (device_id, token_type, shift_id)
      where shift_id is not null and device_id is not null
    do update
    set email = excluded.email,
        token = excluded.token,
        updated_at = excluded.updated_at;
  end if;

  update public.notification_device_authorizations as device_auth
  set last_registered_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where device_auth.device_id = p_device_id
    and device_auth.auth_user_id = auth.uid()
    and device_auth.field_worker_id = v_worker_id
    and device_auth.revoked_at is null;
end
$function$;

-- Authenticated sign-out now records a durable revoke. It mirrors the
-- post-session capability RPC but proves ownership through auth.uid().
create or replace function public.hc_unregister_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
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

  update public.notification_device_authorizations as device_auth
  set revoked_at = coalesce(device_auth.revoked_at, clock_timestamp()),
      revoked_reason = coalesce(
        device_auth.revoked_reason,
        'authenticated sign-out'
      ),
      updated_at = case
        when device_auth.revoked_at is null
          then clock_timestamp()
        else device_auth.updated_at
      end
  where device_auth.device_id = p_device_id
    and device_auth.auth_user_id = auth.uid();
end
$function$;

-- This is pushdrain's last database check immediately before Apple. The
-- authorization join is intentional even though revocation also deletes the
-- push-to-start token. It makes a queued START fail closed if token cleanup was
-- interrupted or a service-role repair left a stale row behind.
create or replace function public.hc_validate_live_activity_start_delivery(
  p_delivery_id uuid,
  p_shift_id uuid,
  p_queue_id uuid,
  p_generation integer,
  p_start_token text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  if p_delivery_id is null
     or p_shift_id is null
     or p_queue_id is null
     or p_generation is null
     or p_generation < 1
     or nullif(lower(trim(p_start_token)), '') is null then
    return false;
  end if;

  return exists (
    select 1
    from public.live_activity_start_deliveries as delivery
    join public.shifts as shift_row
      on shift_row.id = delivery.shift_id
    join public.live_activity_tokens as token_row
      on token_row.token_type = 'push_to_start'
     and token_row.shift_id is null
     and lower(token_row.token) = delivery.start_token
    join public.notification_device_authorizations as device_auth
      on device_auth.device_id = token_row.device_id
     and device_auth.revoked_at is null
    join public.field_workers as manager
      on manager.id = device_auth.field_worker_id
     and manager.auth_user_id = device_auth.auth_user_id
     and manager.active is true
     and manager.role in ('owner', 'manager')
     and lower(manager.email) = lower(token_row.email)
    where delivery.id = p_delivery_id
      and delivery.shift_id = p_shift_id
      and delivery.queue_id = p_queue_id
      and delivery.generation = p_generation
      and delivery.start_token = lower(trim(p_start_token))
      and delivery.device_id = token_row.device_id
      and delivery.delivered_at is null
      and delivery.terminal_at is null
      and (
        delivery.queued_at is not null
        or delivery.claimed_at is not null
      )
      and shift_row.clock_out_at is null
      and lower(coalesce(shift_row.worker_email, '')) <>
          'appreview@hamptonscoconuts.com'
      and lower(token_row.email) <>
          lower(coalesce(shift_row.worker_email, ''))
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = token_row.device_id
          and occupied.id <> delivery.id
      )
  );
end
$function$;

-- Version the START claim API instead of dropping and recreating migration
-- 018's proven function merely to change its return type. The worker can move
-- to this service-only wrapper when it adds marketLabel to the banner. The
-- underlying claim executes exactly once, and every original column keeps its
-- name, type, and meaning.
create or replace function public.hc_claim_live_activity_starts_v2(
  p_claimed_at timestamptz,
  p_stale_before timestamptz,
  p_started_after timestamptz,
  p_limit integer default 50
)
returns table (
  delivery_id uuid,
  queue_id uuid,
  device_id uuid,
  email text,
  token text,
  shift_id uuid,
  worker_name text,
  worker_email text,
  clock_in_at timestamptz,
  report_at timestamptz,
  report_lat double precision,
  report_lng double precision,
  generation integer,
  market text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'service role required';
  end if;

  return query
  with claimed as materialized (
    select *
    from public.hc_claim_live_activity_starts(
      p_claimed_at,
      p_stale_before,
      p_started_after,
      p_limit
    )
  )
  select
    claimed.delivery_id,
    claimed.queue_id,
    claimed.device_id,
    claimed.email,
    claimed.token,
    claimed.shift_id,
    claimed.worker_name,
    claimed.worker_email,
    claimed.clock_in_at,
    claimed.report_at,
    claimed.report_lat,
    claimed.report_lng,
    claimed.generation,
    shift_row.market
  from claimed
  join public.shifts as shift_row
    on shift_row.id = claimed.shift_id
  order by claimed.clock_in_at asc, claimed.delivery_id asc;
end
$function$;

-- Reassert every RPC grant because CREATE OR REPLACE preserves old grants and
-- SECURITY DEFINER functions otherwise default to executable by PUBLIC.
alter function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  security definer set search_path = '';
alter function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  security definer set search_path = '';
alter function public.hc_unregister_device(uuid)
  security definer set search_path = '';
alter function public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text)
  security definer set search_path = '';
alter function public.hc_claim_live_activity_starts_v2(
  timestamptz, timestamptz, timestamptz, integer
) security definer set search_path = '';

revoke all on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.hc_unregister_device(uuid)
  from public, anon, authenticated;
revoke all on function public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.hc_claim_live_activity_starts_v2(
  timestamptz, timestamptz, timestamptz, integer
) from public, anon, authenticated;

grant execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean)
  to authenticated, service_role;
grant execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  to authenticated, service_role;
grant execute on function public.hc_unregister_device(uuid)
  to authenticated, service_role;
grant execute on function public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text)
  to service_role;
grant execute on function public.hc_claim_live_activity_starts_v2(
  timestamptz, timestamptz, timestamptz, integer
) to service_role;

update public.notification_device_security_state
set cutover_at = coalesce(cutover_at, clock_timestamp())
where singleton is true;

do $assertions$
declare
  v_privilege text;
begin
  if exists (
    select 1
    from public.push_tokens as token_row
    where token_row.device_id is null
       or not exists (
         select 1
         from public.notification_device_authorizations as device_auth
         join public.field_workers as worker
           on worker.id = device_auth.field_worker_id
          and worker.auth_user_id = device_auth.auth_user_id
          and worker.active is true
          and worker.role in ('owner', 'manager')
         where device_auth.device_id = token_row.device_id
           and device_auth.revoked_at is null
           and lower(worker.email) = lower(token_row.email)
       )
  ) then
    raise exception using
      errcode = '42501',
      message = '022 assertion failed: unauthorized normal push row remains';
  end if;

  if exists (
    select 1
    from public.live_activity_tokens as token_row
    where token_row.token_type = 'push_to_start'
      and token_row.shift_id is null
      and (
        token_row.device_id is null
        or not exists (
          select 1
          from public.notification_device_authorizations as device_auth
          join public.field_workers as worker
            on worker.id = device_auth.field_worker_id
           and worker.auth_user_id = device_auth.auth_user_id
           and worker.active is true
           and worker.role in ('owner', 'manager')
          where device_auth.device_id = token_row.device_id
            and device_auth.revoked_at is null
            and lower(worker.email) = lower(token_row.email)
        )
      )
  ) then
    raise exception using
      errcode = '42501',
      message = '022 assertion failed: unauthorized push-to-start row remains';
  end if;

  if not exists (
    select 1
    from public.notification_device_security_state
    where singleton is true
      and cutover_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = '022 assertion failed: cutover marker is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.push_tokens'::regclass
      and trigger_info.tgname = 'push_tokens_require_device_authorization'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) or not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_info
    where trigger_info.tgrelid = 'public.live_activity_tokens'::regclass
      and trigger_info.tgname =
          'live_activity_tokens_require_device_authorization'
      and not trigger_info.tgisinternal
      and trigger_info.tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = '022 assertion failed: destination authorization trigger is missing';
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
          '022 assertion failed: client retains authorization table %s',
          v_privilege
        );
    end if;
  end loop;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.hc_unregister_device(uuid)', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.hc_unregister_device(uuid)', 'EXECUTE'
     ) then
    raise exception using
      errcode = '42501',
      message = '022 assertion failed: registration RPC grants are wrong';
  end if;

  if pg_catalog.pg_get_functiondef(
       'public.hc_sync_notification_device(uuid,text,boolean,boolean)'::regprocedure
     ) !~ 'notification_device_authorizations'
     or pg_catalog.pg_get_functiondef(
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)'::regprocedure
     ) !~ 'notification_device_authorizations'
     or pg_catalog.pg_get_functiondef(
       'public.hc_unregister_device(uuid)'::regprocedure
     ) !~ 'notification_device_authorizations'
     or pg_catalog.pg_get_functiondef(
       'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'::regprocedure
     ) !~ 'notification_device_authorizations' then
    raise exception using
      errcode = '55000',
      message = '022 assertion failed: an authorization gate is missing';
  end if;

  if pg_catalog.to_regprocedure(
       'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
     ) is null
     or pg_catalog.has_function_privilege(
       'anon',
       'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
       'EXECUTE'
     )
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(
         'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
       )
         and function_info.prosecdef is true
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
            where setting.value like 'search_path=%'
          )
     )
     or pg_catalog.pg_get_function_result(
       pg_catalog.to_regprocedure(
         'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'
       )
     ) !~ 'market text' then
    raise exception using
      errcode = '42501',
      message = '022 assertion failed: START v2 RPC security is wrong';
  end if;

  if pg_catalog.pg_get_functiondef(
       'public.hc_unregister_device(uuid)'::regprocedure
     ) ~ 'token_type = ''activity_update'''
     or pg_catalog.pg_get_functiondef(
       'public.hc_revoke_notification_device(uuid,text)'::regprocedure
     ) ~ 'token_type = ''activity_update''' then
    raise exception using
      errcode = '55000',
      message = '022 assertion failed: revocation can remove an END token';
  end if;
end
$assertions$;

commit;
