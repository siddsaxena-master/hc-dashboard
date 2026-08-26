-- ============================================================================
-- 017_live_activity_end_delivery.sql
-- Durable, per-phone Live Activity end delivery.
--
-- LOCAL DRAFT. Do not run this against production until migrations 015 and 016
-- have passed their separate clone and canary gates.
--
-- Why this exists:
--   * A closed shift must request an ActivityKit END even when its Telegram
--     summary was already sent.
--   * One phone succeeding must not hide another phone's failed END.
--   * A token must remain available until Apple confirms that exact phone's
--     END, or says that exact token is permanently dead.
--
-- end_requested_at is a lease, not a delivered flag. The Cloudflare worker
-- stamps it only after claiming one phone for queue insertion. pushdrain
-- clears it after retry exhaustion so a later five-minute scan can try again.
-- A stale lease is also reclaimable by the worker after 30 minutes.
--
-- This migration preserves every row. It replaces the two old email-wide Live
-- Activity indexes and the token registration function so two phones signed
-- into the same account no longer overwrite one another. Null-device legacy
-- indexes preserve build-24 compatibility if the emergency 016 rollback is
-- later used. Existing policies and table grants remain unchanged.
-- ============================================================================

begin;

-- A guarded 017 rollback leaves this narrow legacy INSERT helper in place so
-- build 24 can rotate a null-device token after a later 016 emergency rollback
-- without token SELECT access. Reapplying 017 replaces it with the stronger
-- lease-aware trigger below.
drop trigger if exists live_activity_tokens_replace_legacy_insert
  on public.live_activity_tokens;
drop function if exists public.hc_replace_legacy_live_activity_token();

alter table public.live_activity_tokens
  add column if not exists end_requested_at timestamptz,
  add column if not exists end_queue_id uuid;

-- Migration 010 allowed only one row per EMAIL. Migration 015 added the right
-- device indexes but deliberately retained those older, stricter blockers for
-- transition. Cutover 016 guarantees every surviving secure-build row has a
-- device ID, so 017 can make physical device identity authoritative.
drop index if exists public.live_activity_tokens_p2s_uniq;
drop index if exists public.live_activity_tokens_upd_uniq;

-- If emergency rollback restores build-24 anonymous writes, those writes omit
-- device_id. Keep their old insert-then-PATCH conflict behavior in a separate
-- null-device lane without blocking two authenticated phones on one email.
create unique index if not exists live_activity_tokens_legacy_p2s_uidx
  on public.live_activity_tokens (email, token_type)
  where shift_id is null and device_id is null;

create unique index if not exists live_activity_tokens_legacy_update_uidx
  on public.live_activity_tokens (email, token_type, shift_id)
  where shift_id is not null and device_id is null;

-- Recreate only the 015 token-registration RPC, retaining all validation,
-- eligibility, shared-phone reclaim, and cleanup rules. The two ON CONFLICT
-- clauses now target the already-validated device indexes from 015/016.
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
    -- One ActivityKit token is one physical destination. Serialize exact-token
    -- reclaim so concurrent registrations with different regenerated device
    -- IDs cannot both pass the DELETE and then insert duplicate destinations.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('hc-live-activity:' || v_token, 0)
    );

    -- Exact-token reclaim also removes a same-email legacy/null row for this
    -- physical phone before the device-specific upsert below.
    delete from public.live_activity_tokens
    where lower(token) = v_token
      and (
        lower(email) <> v_email
        or device_id is distinct from p_device_id
      );
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
    on conflict (device_id, token_type)
      where shift_id is null and device_id is not null
    do update
    set email = excluded.email,
        token = excluded.token,
        updated_at = excluded.updated_at;

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
    on conflict (device_id, token_type, shift_id)
      where shift_id is not null and device_id is not null
    do update
    set email = excluded.email,
        token = excluded.token,
        updated_at = excluded.updated_at;
  end if;
end
$function$;

revoke all on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean)
  to authenticated, service_role;

-- The five-minute worker reads only activity-update tokens whose end lease is
-- absent or stale. This partial index keeps that recovery scan small.
create index if not exists live_activity_tokens_end_request_idx
  on public.live_activity_tokens (end_requested_at, end_queue_id, updated_at)
  where token_type = 'activity_update' and shift_id is not null;

-- ActivityKit update tokens may rotate while a card is alive. A genuinely new
-- token is a new delivery destination, so it must receive a fresh END. A
-- repeated registration of the same token must NOT clear the lease, otherwise
-- routine foreground reconciliation could create duplicate END rows.
create or replace function public.hc_reset_live_activity_end_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    -- Emergency rollback may temporarily restore build-24 anonymous INSERTs.
    -- Replace only its prior null-device row here, under the table owner's
    -- authority, so the installed build never needs unsafe token SELECT access
    -- for its old 409-then-PATCH rotation path.
    if new.device_id is null then
      delete from public.live_activity_tokens as existing
      where existing.device_id is null
        and lower(existing.email) = lower(new.email)
        and existing.token_type = new.token_type
        and existing.shift_id is not distinct from new.shift_id;
    end if;
    new.end_requested_at := null;
    new.end_queue_id := null;
    return new;
  end if;

  if new.token is distinct from old.token
     or new.token_type is distinct from old.token_type
     or new.shift_id is distinct from old.shift_id
     or new.device_id is distinct from old.device_id
     or lower(new.email) is distinct from lower(old.email) then
    new.end_requested_at := null;
    new.end_queue_id := null;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    -- Both fields belong only to the worker/pushdrain service flow. An
    -- authenticated app upsert, or emergency anonymous PATCH, must preserve
    -- the old delivery identity when the destination did not rotate.
    new.end_requested_at := old.end_requested_at;
    new.end_queue_id := old.end_queue_id;
  end if;
  return new;
end
$function$;

revoke all on function public.hc_reset_live_activity_end_request() from public;

drop trigger if exists live_activity_tokens_reset_end_request
  on public.live_activity_tokens;
create trigger live_activity_tokens_reset_end_request
before insert or update
on public.live_activity_tokens
for each row
execute function public.hc_reset_live_activity_end_request();

-- Atomically claim ONLY closed-shift update tokens. Filtering and LIMIT happen
-- in the database after the shifts join, so any number of open or orphan rows
-- can never starve a closed token. SKIP LOCKED lets overlapping cron runs split
-- work without claiming the same phone twice.
create or replace function public.hc_claim_live_activity_ends(
  p_claimed_at timestamptz,
  p_stale_before timestamptz,
  p_limit integer default 50
)
returns table (
  token_id uuid,
  queue_id uuid,
  email text,
  token text,
  shift_id uuid,
  clock_in_at timestamptz,
  clock_out_at timestamptz
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

  if p_claimed_at is null
     or p_stale_before is null
     or p_stale_before >= p_claimed_at then
    raise exception using
      errcode = '22023',
      message = 'valid claim and stale timestamps are required';
  end if;

  return query
  with candidate_ids as materialized (
    select lat.id
    from public.live_activity_tokens as lat
    join public.shifts as s
      on s.id = lat.shift_id
     and s.clock_out_at is not null
    where lat.token_type = 'activity_update'
      and lat.shift_id is not null
      and (
        lat.end_requested_at is null
        or lat.end_requested_at < p_stale_before
      )
      -- A stale token lease is not abandoned while its exact queue row is
      -- still pending. This is what makes a pushdrain outage longer than the
      -- 30-minute lease safe.
      and not exists (
        select 1
        from public.push_queue as pending
        where pending.id = lat.end_queue_id
          and pending.done_at is null
      )
    order by lat.updated_at asc, lat.id asc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of lat skip locked
  ), claimed as (
    update public.live_activity_tokens as lat
    set end_requested_at = p_claimed_at,
        end_queue_id = case
          when lat.end_queue_id is null then gen_random_uuid()
          -- A completed prior queue generation cannot be re-opened. Create a
          -- fresh ID. If no row ever committed, reuse the prior ID safely.
          when exists (
            select 1
            from public.push_queue as prior
            where prior.id = lat.end_queue_id
          ) then gen_random_uuid()
          else lat.end_queue_id
        end
    from candidate_ids as candidate
    where lat.id = candidate.id
    returning lat.id, lat.end_queue_id, lat.email, lat.token, lat.shift_id
  )
  select
    claimed.id,
    claimed.end_queue_id,
    claimed.email,
    claimed.token,
    claimed.shift_id,
    s.clock_in_at,
    s.clock_out_at
  from claimed
  join public.shifts as s on s.id = claimed.shift_id
  order by s.clock_out_at asc, claimed.id asc;
end
$function$;

revoke all on function public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer)
  to service_role;

-- The app's local stale-card cleanup needs a complete truth set. The general
-- Team-tab RPC is deliberately paginated and date-bounded, so it cannot safely
-- answer "which shifts are open right now?" for ActivityKit reconciliation.
-- Return UUIDs only, which avoids exposing payroll or worker details.
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
  order by s.clock_in_at asc, s.id asc;
end
$function$;

-- SECURITY DEFINER functions are executable by PUBLIC unless explicitly
-- revoked. Revoke every client role first, then grant the narrow allowlist.
revoke all on function public.hc_list_managed_open_shift_ids()
  from public, anon, authenticated;
grant execute on function public.hc_list_managed_open_shift_ids()
  to authenticated, service_role;

commit;
