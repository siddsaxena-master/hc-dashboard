-- ============================================================================
-- 046_live_activity_claims.sql
-- The database half of the remote Live Activity START and END: the ledger
-- and the four functions the live Claudia worker and the live droplet
-- drainer already call every five minutes. Written 2026-09-17.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- WHAT SIDD'S "YES DO IT" COVERS. Three separate things; each can be
-- refused on its own, and the second one is one-way:
--   1. The Live Activity plumbing the live worker and the live drainer
--      already call: the START ledger, the END lease columns, the two
--      START claims, the END claim, the drainer's validator and the queue
--      and ledger guards. The rollback file removes all of it.
--   2. A ONE-WAY security change on the LIVE table live_activity_tokens:
--      the 010 anonymous lane is closed (the two anon policies dropped,
--      anon and PUBLIC table and column grants revoked). The worker never
--      calls this; it is what stops the public anon key in index.html from
--      choosing which phone receives a crew member's card once the START
--      path is alive (018's own preflight demanded the same closure). THE
--      ROLLBACK DOES NOT REOPEN IT. Preflight (8) refuses the whole file
--      (55000) while a token row with no device_id was written within 7
--      days (a phone older than the 2026-08-25 build); its message names
--      the SELECT that shows which phone. It stays in this file rather
--      than a 047 because a separate file would have to run BEFORE the
--      first START scan, and a file numbered after 046 that must run
--      before it is the 027-after-029 trap again.
--   3. LATENCY, so the expectation is right: the card lands on the
--      worker's next five-minute cron tick after the clock-in
--      (wrangler.toml "*/5 * * * *" is the only call site of
--      runLiveActivityStartScan) plus the drainer's poll, so "within about
--      five minutes of clock-in, without opening the app". Nothing runs
--      the START scan at clock-in time: the app clocks in through the
--      Supabase RPC hc_start_shift and never calls the worker. A card at
--      the moment of clock-in is a separate worker change (a clock-in
--      route that runs the scan, or a tighter cron), outside this file.
--
-- PAUSE WITHOUT ROLLBACK (the emergency lever: reversible, safe mid-shift,
-- no data loss). The rollback refuses while an open shift holds a START
-- receipt, so if the first live ticks misbehave during a shift, stop new
-- claims instead of rolling back:
--   revoke execute on function
--     public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer),
--     public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer),
--     public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer)
--   from service_role;
-- Within one tick the worker logs "Live Activity START claim failed" and
-- "live activity end claim failed" with a non-404 status and returns (it
-- falls back to the plain name only on 404 PGRST202), so no receipt is
-- seeded or leased and no END lease is taken. The drainer keeps finishing
-- rows already queued because hc_validate_live_activity_start_delivery is
-- left alone. Resume with the matching `grant execute on function ... to
-- service_role`, or by re-running this file (section H re-grants). Roll
-- back only once the shifts have closed. Rehearsed.
--
-- Why: Sidd wants the lock-screen shift card on his phone the moment a crew
-- member clocks in, without opening the app. The worker (version fd3befe9)
-- runs runLiveActivityStartScan and runLiveActivityEndScan every five
-- minutes and both die at the claim: the live database answers
-- 404 PGRST202 for hc_claim_live_activity_starts_v2,
-- hc_claim_live_activity_starts and hc_claim_live_activity_ends, and the
-- drainer's pre-send check hc_validate_live_activity_start_delivery is
-- missing too (it would park every START as "eligibility check unavailable"
-- and expire it after 15 minutes). Those functions were written in
-- migrations 017, 018, 022 and 025, none of which is live and none of which
-- may run as written any more: 017 rewrites hc_register_live_activity_token
-- and drops the 010 indexes the live registration RPC's ON CONFLICT targets,
-- 022 recreates hc_sync_notification_device without 041's team branch (which
-- strands every crew phone), 018's preflight demands 016's whole cutover
-- (it refuses the live anon policies, and after this file closes them it
-- still refuses authenticated's remaining Supabase default grants on the
-- token table, select first; a `revoke all ... from authenticated` would
-- let it install over this file, so 018 is retired as written),
-- and 025 rewrites the shift policies and RPCs and needs a helper that is
-- not live. This file carries ONLY the pieces the worker and the drainer
-- use, copied from those files, with the manager market rule inlined.
--
-- What this adds:
--   * The 010 anonymous lane on public.live_activity_tokens is CLOSED: the
--     two policies live_activity_tokens_anon_insert and _anon_update are
--     dropped and every table privilege is revoked from anon and PUBLIC
--     (the text 016:563-590 would have run). With that lane open, the
--     public anon key (the one in index.html) could rewrite the owner's
--     push_to_start token with an unfiltered PATCH or plant a push_to_start
--     row for a manager's email with any device id, and the START seed, the
--     claim and the drainer's validator below would then send that phone
--     the crew member's card (worker name, clock-in time, status). 018
--     refused to install beside this lane; 046 closes it. No phone loses
--     anything: every build since the 2026-08-25 secure-auth build
--     (hc-field-app commit a2986ed, App.js laWriteToken) writes tokens only
--     through the SECURITY DEFINER 015 RPC, which bypasses table grants,
--     and 015 had already revoked authenticated's direct writes. A phone
--     older than that wrote rows with the anon key and no device_id, rows
--     the START seed never picks anyway; the preflight refuses while such a
--     row was written within 7 days, so a legacy phone still in use is
--     noticed, not cut off silently. The 008 push_tokens policies are
--     041's business (its marker rule) and stay exactly as they are.
--   * public.live_activity_tokens.end_requested_at and .end_queue_id (017):
--     the END lease the worker stamps when it claims one phone's card for
--     an END push and the drainer clears after retry exhaustion. A partial
--     index for the END scan. A before-insert-or-update trigger that nulls
--     both on insert, clears them when the token, its type, shift, device or
--     email changes (a new destination needs its own END), and otherwise
--     preserves them for any caller that is not service_role (the phone's
--     015 upsert must never wipe a lease the worker owns).
--   * public.live_activity_start_deliveries (018): one row per (open shift,
--     owner or manager phone), the durable receipt for one START. claimed_at
--     is the worker's 30 minute lease, queued_at means the push_queue row
--     with that queue_id is durably owned, delivered_at or terminal_at is
--     Apple's answer as the drainer recorded it. Service role only, no
--     policies. A protect trigger keeps identity immutable (three narrow
--     transitions: device UUID reconcile, unsent token refresh, new
--     generation after a dead token) and makes outcomes one-way latches.
--   * public.hc_claim_live_activity_ends(p_claimed_at, p_stale_before,
--     p_limit): the END claim, 017's text.
--   * public.hc_claim_live_activity_starts(p_claimed_at, p_stale_before,
--     p_started_after, p_limit): the START claim, 018's text plus 025's
--     market rule (owners see every shift, a manager only a shift in their
--     own nonblank market, team never) written inline, so a manager is
--     never sent a card the worker's UPDATE path (partitionRecipients) would
--     then refuse to update.
--   * public.hc_claim_live_activity_starts_v2(same four parameters): 022's
--     wrapper, the same rows plus shifts.market, which the worker calls
--     first (it only falls back to the plain name on PGRST202) and reads
--     for the card's market label.
--   * public.hc_validate_live_activity_start_delivery(p_delivery_id,
--     p_shift_id, p_queue_id, p_generation, p_start_token): the drainer's
--     last check before Apple. Returns false, never raises, for a closed
--     shift, a delivered or dead row, a downgraded phone, a moved manager.
--   * Two push_queue triggers (018): a before-insert guard that fails a
--     malformed or stale START row closed (exact payload keys, id = queue
--     id, collapse id, the ledger row still leased with that claim stamp),
--     and a before-delete guard that keeps an la_start row whose receipt
--     never recorded queued_at, so the drainer's 7 day purge cannot open the
--     door to a duplicate card. A tokens trigger that re-homes receipts when
--     a reinstalled phone regenerates its device UUID.
--
-- What this never touches: hc_sync_notification_device (041),
-- hc_register_live_activity_token (015), hc_unregister_device (015),
-- hc_authorize_notification_device and hc_list_managed_open_shift_ids
-- (015c), the 010 and 015 token indexes, the token rows themselves, every
-- policy on every other table (the 008 push_tokens anon policies included),
-- authenticated's and service_role's grants on live_activity_tokens, the
-- shifts RPCs. The preflight snapshots those functions and the postflight
-- proves the snapshot is unchanged, so this file cannot repeat the 016/017/
-- 022 mistake by accident.
--
-- Lease release by hand. The reset trigger below keeps end_requested_at and
-- end_queue_id for any UPDATE that is not service_role, and the Supabase SQL
-- editor is not service_role (auth.role() is null there), so a plain
-- `update live_activity_tokens set end_requested_at = null, end_queue_id =
-- null` from the editor is a silent no-op. To release a lease by hand (the
-- worker and the drainer down, a rollback wanted), run in ONE transaction:
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   update public.live_activity_tokens
--      set end_requested_at = null, end_queue_id = null
--    where end_requested_at is not null or end_queue_id is not null;
--   commit;
-- The setting dies with the transaction. The rollback file repeats this.
--
-- Install note. There is no legacy START producer any more (the ledger scan
-- is the only writer of la_start rows), so an open shift does not block the
-- first install. But the first scan after this file seeds every open shift
-- that clocked in within 48 hours and pushes a START within five minutes; a
-- phone already showing a locally started card (build 31 and later) briefly
-- carries two cards until the app's next foreground sweep ends the
-- duplicate. Install with no open shift when you can. The first END scan
-- claims up to 50 activity_update tokens for already closed shifts and
-- pushes END to each; dead tokens are deleted by the drainer.
--
-- Superseded: 017, 018, 022 and 025 must never run after this file. 017 has
-- no preflight and would rewrite the token RPC and indexes; 025's preflight
-- passes once these functions exist and would replace the claim with a copy
-- that needs its own helper and rewrite the shift policies.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- The auth functions this file must not touch, fingerprinted before any
-- change (body, security definer, search_path and grants together). The
-- postflight compares. Only functions present are listed: the two 015c
-- functions are live but absent from the local rehearsal chain.
create temporary table hc_046_auth_function_snapshot (
  signature text primary key,
  fingerprint text not null
) on commit drop;

insert into hc_046_auth_function_snapshot (signature, fingerprint)
select required.signature,
       pg_catalog.md5(
         pg_catalog.pg_get_functiondef(function_info.oid)
         || coalesce(function_info.proacl::text, ''))
from pg_catalog.unnest(array[
       'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
       'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
       'public.hc_unregister_device(uuid)',
       'public.hc_authorize_notification_device(uuid)',
       'public.hc_list_managed_open_shift_ids()'
     ]) as required(signature)
join pg_catalog.pg_proc as function_info
  on function_info.oid = pg_catalog.to_regprocedure(required.signature);

do $preflight$
declare
  v_sync_signature constant text := 'public.hc_sync_notification_device(uuid,text,boolean,boolean)';
  v_register_signature constant text := 'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)';
  v_definition text;
  v_column text;
  v_type text;
  v_required record;
begin
  -- (1) 041 is live: its marker table and its team branch in the sync RPC.
  -- 046 exists because 016, 017 and 022 must never run after 041; a
  -- database without 041 is not the lineage this file was written for.
  if pg_catalog.to_regclass('public.notification_team_push_state') is null
     or pg_catalog.to_regprocedure(v_sync_signature) is null then
    raise exception using
      errcode = '55000',
      message = '046 requires migration 041 (public.notification_team_push_state and hc_sync_notification_device with the team branch)';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_sync_signature));
  if pg_catalog.strpos(v_definition, 'if v_role = ''team'' then') = 0
     or pg_catalog.strpos(v_definition, 'ever_kept_team_token_at') = 0 then
    raise exception using
      errcode = '55000',
      message = '046 requires migration 041: hc_sync_notification_device does not carry the team branch';
  end if;

  -- (4) 022 installed (its trigger function exists) or 028 installed (the
  -- sync RPC renamed): not the lineage this file was written for, and both
  -- rewrite functions this file promises not to touch.
  if pg_catalog.to_regprocedure('public.hc_enforce_notification_destination_authorization()') is not null then
    raise exception using
      errcode = '55000',
      message = '046 blocked: migration 022 is installed (its trigger function exists); 046 was written for a database without it';
  end if;
  if pg_catalog.to_regprocedure('public.hc_sync_notification_device_pre_mfa_028(uuid,text,boolean,boolean)') is not null then
    raise exception using
      errcode = '55000',
      message = '046 blocked: migration 028 is installed (hc_sync_notification_device_pre_mfa_028 exists); review the sync RPC lineage before applying';
  end if;

  -- (2) the tables and columns the functions read, with their types.
  if pg_catalog.to_regclass('public.live_activity_tokens') is null
     or pg_catalog.to_regclass('public.shifts') is null
     or pg_catalog.to_regclass('public.shift_locations') is null
     or pg_catalog.to_regclass('public.field_workers') is null
     or pg_catalog.to_regclass('public.push_queue') is null then
    raise exception using
      errcode = '55000',
      message = '046 requires live_activity_tokens (010), shifts and shift_locations (002), field_workers (003) and push_queue (011)';
  end if;
  for v_required in
    select required.table_name, required.column_name, required.udt_name
    from (values
        ('live_activity_tokens', 'id', 'uuid'),
        ('live_activity_tokens', 'email', 'text'),
        ('live_activity_tokens', 'token_type', 'text'),
        ('live_activity_tokens', 'shift_id', 'uuid'),
        ('live_activity_tokens', 'token', 'text'),
        ('live_activity_tokens', 'updated_at', 'timestamptz'),
        ('live_activity_tokens', 'device_id', 'uuid'),
        ('shifts', 'id', 'uuid'),
        ('shifts', 'worker_name', 'text'),
        ('shifts', 'worker_email', 'text'),
        ('shifts', 'market', 'text'),
        ('shifts', 'clock_in_at', 'timestamptz'),
        ('shifts', 'clock_in_lat', 'float8'),
        ('shifts', 'clock_in_lng', 'float8'),
        ('shifts', 'clock_out_at', 'timestamptz'),
        ('shift_locations', 'id', 'int8'),
        ('shift_locations', 'shift_id', 'uuid'),
        ('shift_locations', 'at', 'timestamptz'),
        ('shift_locations', 'lat', 'float8'),
        ('shift_locations', 'lng', 'float8'),
        ('field_workers', 'id', 'uuid'),
        ('field_workers', 'email', 'text'),
        ('field_workers', 'role', 'text'),
        ('field_workers', 'active', 'bool'),
        ('field_workers', 'market', 'text'),
        ('field_workers', 'auth_user_id', 'uuid'),
        ('push_queue', 'id', 'uuid'),
        ('push_queue', 'kind', 'text'),
        ('push_queue', 'payload', 'jsonb'),
        ('push_queue', 'created_at', 'timestamptz'),
        ('push_queue', 'claimed_at', 'timestamptz'),
        ('push_queue', 'done_at', 'timestamptz'),
        ('push_queue', 'attempts', 'int4'),
        ('push_queue', 'last_error', 'text'),
        ('push_queue', 'outbox_type', 'text')
      ) as required(table_name, column_name, udt_name)
    left join information_schema.columns as column_info
      on column_info.table_schema = 'public'
     and column_info.table_name = required.table_name
     and column_info.column_name = required.column_name
     and column_info.udt_name = required.udt_name
    where column_info.column_name is null
  loop
    raise exception using
      errcode = '55000',
      message = pg_catalog.format('046 requires column public.%s.%s of type %s (002/003/010/011/015/027)',
        v_required.table_name, v_required.column_name, v_required.udt_name);
  end loop;
  if pg_catalog.to_regclass('public.live_activity_tokens_device_p2s_uidx') is null then
    raise exception using
      errcode = '55000',
      message = '046 requires the device-specific push-to-start index live_activity_tokens_device_p2s_uidx (015)';
  end if;
  if pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') is null
     or pg_catalog.to_regprocedure('auth.role()') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception using
      errcode = '55000',
      message = '046 requires gen_random_uuid(), auth.role() and auth.uid()';
  end if;

  -- (3) the live registration RPC (015) is there and hardened, so every
  -- push_to_start row the phone writes carries a device_id (015 refuses a
  -- null p_device_id) and the ledger's device identity is trustworthy.
  if pg_catalog.to_regprocedure(v_register_signature) is null
     or pg_catalog.has_function_privilege('anon', v_register_signature, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_register_signature, 'EXECUTE')
     or not exists (
       select 1
       from pg_catalog.pg_proc as function_info
       where function_info.oid = pg_catalog.to_regprocedure(v_register_signature)
         and function_info.prosecdef is true
         and exists (
           select 1
           from pg_catalog.unnest(function_info.proconfig) as setting(value)
           where setting.value like 'search_path=%'
         )
     ) then
    raise exception using
      errcode = '55000',
      message = '046 requires the hardened migration-015 RPC hc_register_live_activity_token(text,uuid,text,uuid,boolean) (security definer, search_path set, no anon execute)';
  end if;
  -- 015:561 took authenticated's direct writes off the token table so a
  -- signed-in phone can only register through that RPC. If that grant came
  -- back, a crew phone could plant a push_to_start row for the owner's
  -- email and be sent the card. Refuse rather than quietly re-revoke.
  if pg_catalog.has_table_privilege('authenticated', 'public.live_activity_tokens', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.live_activity_tokens', 'UPDATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.live_activity_tokens', 'DELETE') then
    raise exception using
      errcode = '55000',
      message = '046 requires migration 015''s shape: authenticated must hold no direct insert, update or delete on public.live_activity_tokens';
  end if;

  -- (5) a lease column that already exists must have the right shape, or
  -- the worker and the drainer would write into a column of the wrong type.
  for v_required in
    select required.column_name, required.type_name
    from (values
        ('end_requested_at', 'timestamp with time zone'),
        ('end_queue_id', 'uuid')
      ) as required(column_name, type_name)
  loop
    select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
    from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.live_activity_tokens'::regclass
      and a.attname = v_required.column_name
      and a.attnum > 0
      and not a.attisdropped;
    if v_type is not null and v_type <> v_required.type_name then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('046 refuses an existing public.live_activity_tokens.%s of type %s; review that column before applying', v_required.column_name, v_type);
    end if;
  end loop;

  -- A ledger that already exists must carry every column the worker, the
  -- drainer and the functions read.
  if pg_catalog.to_regclass('public.live_activity_start_deliveries') is not null then
    foreach v_column in array array['id', 'shift_id', 'device_id', 'start_token', 'queue_id', 'generation', 'claimed_at', 'queued_at', 'delivered_at', 'terminal_at', 'terminal_reason', 'created_at', 'updated_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.live_activity_start_deliveries'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            '046 refuses an existing public.live_activity_start_deliveries with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;

  -- (7) first install only: an unfinished la_start row could only have come
  -- from a producer this file knows nothing about; refuse rather than seed a
  -- ledger beside it. Re-runs skip this (the ledger exists).
  if pg_catalog.to_regclass('public.live_activity_start_deliveries') is null
     and exists (
       select 1
       from public.push_queue
       where kind = 'la_start'
         and done_at is null
     ) then
    raise exception using
      errcode = '55000',
      message = '046 install blocked: drain every unfinished la_start push_queue row before the first install';
  end if;

  -- (8) the anonymous lane this file closes must not still be in use. A
  -- phone older than the 2026-08-25 secure-auth build writes token rows
  -- with the anon key and no device_id (the 015 RPC refuses a null device,
  -- so no other writer leaves that column empty). Such a row written
  -- within 7 days means a legacy phone is alive: refuse and name it rather
  -- than cut it off silently. Checked only while the lane is still open, so
  -- a re-run after the close never trips on an old row.
  if exists (
       select 1
       from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename = 'live_activity_tokens'
         and policyname in ('live_activity_tokens_anon_insert', 'live_activity_tokens_anon_update')
     )
     and exists (
       select 1
       from public.live_activity_tokens
       where device_id is null
         and updated_at >= pg_catalog.clock_timestamp() - interval '7 days'
     ) then
    raise exception using
      errcode = '55000',
      message = '046 install blocked: a live_activity_tokens row with no device_id was written within 7 days, so a phone older than the 2026-08-25 secure-auth build still uses the anonymous lane this file closes; update or retire that phone (select email, token_type, updated_at from public.live_activity_tokens where device_id is null), then apply';
  end if;
end
$preflight$;

-- A. Close the 010 anonymous lane on the token table (the policy drops and
-- the revoke 016:563-590 would have run). See the header: with this lane
-- open, the public anon key could choose which phone receives a crew
-- member's card. Idempotent: drop if exists, and a revoke of nothing is a
-- no-op. Authenticated keeps 015's shape (a default select grant, no
-- policy, no writes); service_role keeps its direct access (the worker's
-- END release PATCH and the drainer's token deletes need it). The postflight
-- proves all three. push_tokens is not touched.
drop policy if exists live_activity_tokens_anon_insert on public.live_activity_tokens;
drop policy if exists live_activity_tokens_anon_update on public.live_activity_tokens;
revoke all on table public.live_activity_tokens from public, anon;

-- A column-level grant is its own thing (016:683-717 clears them for the
-- same reason): take every column back from anon and PUBLIC as well, so the
-- postflight's has_any_column_privilege check cannot be met by a stray
-- `grant select (token)` nobody remembers.
do $anon_columns$
declare
  v_column_list text;
begin
  select pg_catalog.string_agg(pg_catalog.format('%I', c.column_name), ', ' order by c.ordinal_position)
    into v_column_list
  from information_schema.columns as c
  where c.table_schema = 'public'
    and c.table_name = 'live_activity_tokens';
  execute pg_catalog.format(
    'revoke all privileges (%s) on table public.live_activity_tokens from public, anon',
    v_column_list);
end
$anon_columns$;

-- B. The END lease on the update-token row (017:37-39, 220-222).
alter table public.live_activity_tokens
  add column if not exists end_requested_at timestamptz;

alter table public.live_activity_tokens
  add column if not exists end_queue_id uuid;

comment on column public.live_activity_tokens.end_requested_at is
  'END lease stamp, service role only: set by hc_claim_live_activity_ends when the worker claims this phone''s card for an END push, cleared by the drainer after retry exhaustion or by the worker when the enqueue failed. Reclaimable after 30 minutes. Null on push_to_start rows.';

comment on column public.live_activity_tokens.end_queue_id is
  'The push_queue.id the worker inserts the END row under; stable while the lease lives, regenerated only when that queue row already exists (a completed generation cannot be reopened).';

-- The five-minute END scan reads only activity_update tokens whose lease is
-- absent or stale. This partial index keeps that recovery scan small.
create index if not exists live_activity_tokens_end_request_idx
  on public.live_activity_tokens (end_requested_at, end_queue_id, updated_at)
  where token_type = 'activity_update' and shift_id is not null;

-- ActivityKit update tokens may rotate while a card is alive. A genuinely new
-- token is a new delivery destination, so it must receive a fresh END. A
-- repeated registration of the same token must NOT clear the lease, otherwise
-- routine foreground reconciliation could create duplicate END rows. 017's
-- trigger without its build-24 null-device delete lane. Note the last
-- branch: a hand UPDATE from the Supabase SQL editor is not service_role
-- either (auth.role() is null there) and is silently kept too; the header
-- carries the one-transaction set_config recipe for a manual release.
create or replace function public.hc_reset_live_activity_end_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
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
    -- authenticated app upsert must preserve the old delivery identity when
    -- the destination did not rotate.
    new.end_requested_at := old.end_requested_at;
    new.end_queue_id := old.end_queue_id;
  end if;
  return new;
end
$function$;

revoke all on function public.hc_reset_live_activity_end_request()
  from public, anon, authenticated, service_role;

drop trigger if exists live_activity_tokens_reset_end_request
  on public.live_activity_tokens;
create trigger live_activity_tokens_reset_end_request
before insert or update
on public.live_activity_tokens
for each row
execute function public.hc_reset_live_activity_end_request();

-- C. The START ledger (018:214-263).
create table if not exists public.live_activity_start_deliveries (
  id              uuid primary key default pg_catalog.gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id) on delete cascade,
  device_id       uuid not null,
  start_token     text not null,
  queue_id        uuid not null default pg_catalog.gen_random_uuid(),
  generation      integer not null default 1,
  claimed_at      timestamptz,
  queued_at       timestamptz,
  delivered_at    timestamptz,
  terminal_at     timestamptz,
  terminal_reason text,
  created_at      timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at      timestamptz not null default pg_catalog.clock_timestamp(),
  constraint live_activity_start_deliveries_shift_device_key
    unique (shift_id, device_id),
  constraint live_activity_start_deliveries_shift_token_key
    unique (shift_id, start_token),
  constraint live_activity_start_deliveries_queue_key
    unique (queue_id),
  constraint live_activity_start_deliveries_token_check
    check (
      pg_catalog.length(start_token) between 32 and 512
      and start_token ~ '^[0-9a-f]+$'
    ),
  constraint live_activity_start_deliveries_generation_check
    check (generation > 0),
  constraint live_activity_start_deliveries_terminal_check
    check (
      (terminal_at is null and terminal_reason is null)
      or (terminal_at is not null and terminal_reason is not null)
    ),
  constraint live_activity_start_deliveries_outcome_check
    check (delivered_at is null or terminal_at is null)
);

create index if not exists live_activity_start_deliveries_pending_idx
  on public.live_activity_start_deliveries (claimed_at, created_at)
  where queued_at is null
    and delivered_at is null
    and terminal_at is null;

alter table public.live_activity_start_deliveries enable row level security;

-- The ledger exposes device identity and delivery state. There are deliberately
-- no RLS policies. Only the service-role worker and drainer may claim or
-- reconcile it (the drainer PATCHes with return=representation, so it needs
-- select as well).
revoke all on table public.live_activity_start_deliveries
  from public, anon, authenticated;
grant select, insert, update, delete on table public.live_activity_start_deliveries
  to service_role;

comment on table public.live_activity_start_deliveries is
  'One durable START receipt per (open shift, owner or manager phone). claimed_at is the worker''s 30 minute lease, queued_at means the push_queue row with queue_id is owned, delivered_at or terminal_at is Apple''s answer as the drainer recorded it. Service role only; identity immutable (see the protect trigger).';

-- pushdrain normally purges completed queue rows after seven days. If APNs and
-- queue delivery succeeded but the worker never recorded queued_at (for example,
-- a long worker outage after its completion PATCH failed), deleting that one
-- stable queue row would let stale-claim recovery reinsert the same UUID and
-- start a duplicate. Retain only that narrow unresolved case. Once queued_at is
-- recorded, normal queue retention and purge behavior resumes.
create or replace function public.hc_retain_unconfirmed_live_activity_start_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.kind = 'la_start'
     and exists (
       select 1
       from public.live_activity_start_deliveries as delivery
       join public.shifts as shift_row on shift_row.id = delivery.shift_id
       where delivery.queue_id = old.id
         and delivery.queued_at is null
         and delivery.delivered_at is null
         and delivery.terminal_at is null
         and shift_row.clock_out_at is null
     ) then
    return null;
  end if;
  return old;
end
$function$;

revoke all on function public.hc_retain_unconfirmed_live_activity_start_queue()
  from public, anon, authenticated, service_role;

drop trigger if exists push_queue_retain_unconfirmed_live_activity_start
  on public.push_queue;
create trigger push_queue_retain_unconfirmed_live_activity_start
before delete on public.push_queue
for each row
execute function public.hc_retain_unconfirmed_live_activity_start_queue();

-- Fail every malformed or stale START closed. This runs at the actual queue
-- INSERT, so it also closes the shift-close and role/token/market-change
-- windows between claim and enqueue. It checks the worker's exact payload
-- keys (worker.js runLiveActivityStartScan) and re-evaluates the market rule.
create or replace function public.hc_validate_live_activity_start_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_delivery_id uuid;
  v_shift_id uuid;
  v_device_id uuid;
  v_queue_id uuid;
  v_generation integer;
  v_claimed_at timestamptz;
  v_token text;
begin
  if new.kind <> 'la_start' then
    return new;
  end if;

  if pg_catalog.jsonb_typeof(new.payload) <> 'object'
     or pg_catalog.jsonb_typeof(new.payload -> 'tokens') <> 'array'
     or pg_catalog.jsonb_array_length(new.payload -> 'tokens') <> 1 then
    raise exception using
      errcode = '23514',
      message = 'rejected malformed Live Activity START queue row';
  end if;

  begin
    v_delivery_id := nullif(
      new.payload ->> 'live_activity_start_delivery_id', ''
    )::uuid;
    v_shift_id := nullif(
      new.payload ->> 'live_activity_start_shift_id', ''
    )::uuid;
    v_device_id := nullif(
      new.payload ->> 'live_activity_start_device_id', ''
    )::uuid;
    v_queue_id := nullif(
      new.payload ->> 'live_activity_start_queue_id', ''
    )::uuid;
    v_generation := nullif(
      new.payload ->> 'live_activity_start_generation', ''
    )::integer;
    v_claimed_at := nullif(
      new.payload ->> 'live_activity_start_claimed_at', ''
    )::timestamptz;
    v_token := nullif(lower(new.payload -> 'tokens' ->> 0), '');
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception using
        errcode = '23514',
        message = 'rejected invalid Live Activity START queue identity';
  end;

  if v_delivery_id is null
     or v_shift_id is null
     or v_device_id is null
     or v_queue_id is null
     or v_generation is null
     or v_claimed_at is null
     or v_token is null
     or new.id is distinct from v_queue_id
     or new.payload #>> '{headers,collapse_id}' is distinct from v_queue_id::text
     or new.payload #>> '{aps,event}' is distinct from 'start'
     or new.payload #>> '{aps,attributes,shiftId}' is distinct from v_shift_id::text
     or new.claimed_at is not null
     or new.done_at is not null
     or new.attempts is distinct from 0
     or not exists (
       select 1
       from public.live_activity_start_deliveries as delivery
       join public.shifts as shift_row
         on shift_row.id = delivery.shift_id
       join public.live_activity_tokens as token_row
         on token_row.token_type = 'push_to_start'
        and token_row.shift_id is null
        and lower(token_row.token) = delivery.start_token
       join public.field_workers as manager
         on lower(trim(manager.email)) = lower(trim(token_row.email))
        and manager.active is true
        and manager.auth_user_id is not null
        and (
          lower(trim(coalesce(manager.role, ''))) = 'owner'
          or (
            lower(trim(coalesce(manager.role, ''))) = 'manager'
            and nullif(lower(trim(coalesce(manager.market, ''))), '') is not null
            and nullif(lower(trim(coalesce(shift_row.market, ''))), '') is not null
            and lower(trim(manager.market)) = lower(trim(shift_row.market))
          )
        )
       where delivery.id = v_delivery_id
         and delivery.shift_id = v_shift_id
         and delivery.queue_id = v_queue_id
         and delivery.generation = v_generation
         and delivery.start_token = v_token
         and delivery.claimed_at = v_claimed_at
         and delivery.queued_at is null
         and delivery.delivered_at is null
         and delivery.terminal_at is null
         and shift_row.clock_out_at is null
         and lower(trim(coalesce(shift_row.worker_email, ''))) <>
             'appreview@hamptonscoconuts.com'
         and lower(trim(token_row.email)) <>
             lower(trim(coalesce(shift_row.worker_email, '')))
         and not exists (
           select 1
           from public.live_activity_start_deliveries as occupied
           where occupied.shift_id = delivery.shift_id
             and occupied.device_id = token_row.device_id
             and occupied.id <> delivery.id
         )
     ) then
    raise exception using
      errcode = '23514',
      message = 'rejected ineligible or stale Live Activity START queue row';
  end if;

  return new;
end
$function$;

revoke all on function public.hc_validate_live_activity_start_queue()
  from public, anon, authenticated, service_role;

drop trigger if exists push_queue_validate_live_activity_start
  on public.push_queue;
create trigger push_queue_validate_live_activity_start
before insert on public.push_queue
for each row
execute function public.hc_validate_live_activity_start_queue();

-- Identity is immutable except for three narrowly proven transitions: the same
-- exact token moving to a regenerated device UUID, an unsent token refresh when
-- no queue row exists, and a new generation after Apple definitively rejected
-- the prior token. Outcome timestamps are one-way latches. The drainer never
-- repeats a change (its PATCH filters delivered_at and terminal_at is null).
create or replace function public.hc_protect_live_activity_start_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_reconcile boolean;
  v_unsent_token_refresh boolean;
  v_terminal_rotation boolean;
begin
  if new.id is distinct from old.id
     or new.shift_id is distinct from old.shift_id
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '55000',
      message = 'Live Activity START identity is immutable';
  end if;

  v_device_reconcile :=
    new.device_id is distinct from old.device_id
    and new.start_token = old.start_token
    and new.queue_id = old.queue_id
    and new.generation = old.generation
    and new.claimed_at is not distinct from old.claimed_at
    and new.queued_at is not distinct from old.queued_at
    and new.delivered_at is not distinct from old.delivered_at
    and new.terminal_at is not distinct from old.terminal_at
    and new.terminal_reason is not distinct from old.terminal_reason;

  v_unsent_token_refresh :=
    new.device_id = old.device_id
    and new.start_token is distinct from old.start_token
    and new.queue_id = old.queue_id
    and new.generation = old.generation
    and old.claimed_at is null
    and old.queued_at is null
    and old.delivered_at is null
    and old.terminal_at is null
    and new.claimed_at is null
    and new.queued_at is null
    and new.delivered_at is null
    and new.terminal_at is null
    and new.terminal_reason is null
    and not exists (
      select 1 from public.push_queue where id = old.queue_id
    );

  v_terminal_rotation :=
    new.device_id = old.device_id
    and new.start_token is distinct from old.start_token
    and new.queue_id is distinct from old.queue_id
    and new.generation = old.generation + 1
    and old.delivered_at is null
    and old.terminal_at is not null
    and new.claimed_at is null
    and new.queued_at is null
    and new.delivered_at is null
    and new.terminal_at is null
    and new.terminal_reason is null
    and not exists (
      select 1
      from public.push_queue
      where id = old.queue_id
        and done_at is null
    );

  if (new.device_id is distinct from old.device_id
      or new.start_token is distinct from old.start_token
      or new.queue_id is distinct from old.queue_id
      or new.generation is distinct from old.generation)
     and not (v_device_reconcile or v_unsent_token_refresh or v_terminal_rotation) then
    raise exception using
      errcode = '55000',
      message = 'Live Activity START identity transition is not allowed';
  end if;

  if not v_terminal_rotation
     and (
       (old.queued_at is not null and new.queued_at is distinct from old.queued_at)
       or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
       or (old.terminal_at is not null and new.terminal_at is distinct from old.terminal_at)
       or (old.terminal_reason is not null and
           new.terminal_reason is distinct from old.terminal_reason)
     ) then
    raise exception using
      errcode = '55000',
      message = 'Live Activity START outcome is immutable';
  end if;

  new.updated_at := clock_timestamp();
  return new;
end
$function$;

revoke all on function public.hc_protect_live_activity_start_delivery()
  from public, anon, authenticated, service_role;

drop trigger if exists live_activity_start_deliveries_protect_identity
  on public.live_activity_start_deliveries;
create trigger live_activity_start_deliveries_protect_identity
before update on public.live_activity_start_deliveries
for each row
execute function public.hc_protect_live_activity_start_delivery();

-- Device UUIDs can regenerate on reinstall. The exact Apple token is the
-- physical destination during that handoff, so move every matching receipt to
-- the new UUID immediately while preserving its queue generation and outcome.
-- If the new UUID already owns a receipt for the shift, keep both historical
-- rows unchanged and let the queue/validation guards suppress another START.
create or replace function public.hc_reconcile_live_activity_start_device()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.token_type = 'push_to_start'
     and new.shift_id is null
     and new.device_id is not null then
    update public.live_activity_start_deliveries as delivery
    set device_id = new.device_id
    where delivery.start_token = lower(new.token)
      and delivery.device_id <> new.device_id
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = new.device_id
          and occupied.id <> delivery.id
      );
  end if;
  return new;
end
$function$;

revoke all on function public.hc_reconcile_live_activity_start_device()
  from public, anon, authenticated, service_role;

drop trigger if exists live_activity_tokens_reconcile_start_device
  on public.live_activity_tokens;
create trigger live_activity_tokens_reconcile_start_device
after insert or update of device_id, token, token_type, shift_id
on public.live_activity_tokens
for each row
execute function public.hc_reconcile_live_activity_start_device();

-- D. The END claim (017:284-372). Atomically claim ONLY closed-shift update
-- tokens. Filtering and LIMIT happen in the database after the shifts join,
-- so any number of open or orphan rows can never starve a closed token. SKIP
-- LOCKED lets overlapping cron runs split work without claiming the same
-- phone twice. p_claimed_at is stored unchanged: the worker and the drainer
-- filter end_requested_at=eq.<that exact string> afterwards.
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

-- E. The START claim (018:587-841 with 025's market rule inlined). Seed only
-- recent open shifts, but recover every already-seeded pending row regardless
-- of age. Before seeding, reconcile only unsent identities and rotate a queue
-- generation only after Apple definitively rejected the prior token. Eligible
-- phone: an active linked owner (any shift), or an active linked manager
-- whose nonblank roster market equals the shift's nonblank market; never the
-- shift worker's own phone; never an App Review shift.
create or replace function public.hc_claim_live_activity_starts(
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
  generation integer
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
     or p_started_after is null
     or p_stale_before >= p_claimed_at
     or p_started_after > p_claimed_at then
    raise exception using
      errcode = '22023',
      message = 'valid claim, stale, and recent-window timestamps are required';
  end if;

  -- Once a shift is closed this function can never enqueue its START again.
  -- Clear an abandoned pre-close lease so rollback checks and the normal queue
  -- purge cannot remain blocked after an enqueue-completion response was lost.
  update public.live_activity_start_deliveries as delivery
  set claimed_at = null
  from public.shifts as shift_row
  where shift_row.id = delivery.shift_id
    and shift_row.clock_out_at is not null
    and delivery.queued_at is null
    and delivery.claimed_at is not null;

  -- The app stores a device UUID, but an install can regenerate it. If the
  -- exact Apple token is unchanged, it is the same physical destination. This
  -- repairs every outcome state if the registration trigger was unavailable.
  update public.live_activity_start_deliveries as delivery
  set device_id = token_row.device_id
  from public.live_activity_tokens as token_row
  where token_row.token_type = 'push_to_start'
    and token_row.shift_id is null
    and token_row.device_id is not null
    and lower(token_row.token) = delivery.start_token
    and token_row.device_id <> delivery.device_id
    and not exists (
      select 1
      from public.live_activity_start_deliveries as occupied
      where occupied.shift_id = delivery.shift_id
        and occupied.device_id = token_row.device_id
        and occupied.id <> delivery.id
    );

  -- A token may rotate after the ledger was seeded but before any queue row
  -- exists. Refresh that pristine receipt in place. Its queue UUID remains
  -- stable, so overlapping workers still converge on one INSERT.
  update public.live_activity_start_deliveries as delivery
  set start_token = lower(token_row.token)
  from public.live_activity_tokens as token_row
  where token_row.token_type = 'push_to_start'
    and token_row.shift_id is null
    and token_row.device_id = delivery.device_id
    and lower(token_row.token) <> delivery.start_token
    and delivery.claimed_at is null
    and delivery.queued_at is null
    and delivery.delivered_at is null
    and delivery.terminal_at is null
    and not exists (
      select 1 from public.push_queue where id = delivery.queue_id
    )
    and not exists (
      select 1
      from public.live_activity_start_deliveries as occupied
      where occupied.shift_id = delivery.shift_id
        and occupied.start_token = lower(token_row.token)
        and occupied.id <> delivery.id
    );

  -- Only Apple's permanent dead-token result earns a second generation. A
  -- timeout, topic rejection, role change, or routine token rotation never
  -- rearms a START and therefore cannot manufacture a duplicate banner.
  update public.live_activity_start_deliveries as delivery
  set start_token = lower(token_row.token),
      queue_id = gen_random_uuid(),
      generation = delivery.generation + 1,
      claimed_at = null,
      queued_at = null,
      delivered_at = null,
      terminal_at = null,
      terminal_reason = null
  from public.live_activity_tokens as token_row
  where token_row.token_type = 'push_to_start'
    and token_row.shift_id is null
    and token_row.device_id = delivery.device_id
    and lower(token_row.token) <> delivery.start_token
    and delivery.delivered_at is null
    and delivery.terminal_at is not null
    and not exists (
      select 1
      from public.push_queue as pending
      where pending.id = delivery.queue_id
        and pending.done_at is null
    )
    and not exists (
      select 1
      from public.live_activity_start_deliveries as occupied
      where occupied.shift_id = delivery.shift_id
        and occupied.start_token = lower(token_row.token)
        and occupied.id <> delivery.id
    );

  -- This is intentionally a separate statement from RETURN QUERY. PostgreSQL
  -- data-changing CTE siblings share one snapshot and expose new rows only via
  -- RETURNING; a following statement in this same function sees the inserts and
  -- can claim a newly registered late phone immediately.
  insert into public.live_activity_start_deliveries (
    shift_id, device_id, start_token
  )
  select distinct shift_row.id, token_row.device_id, lower(token_row.token)
  from public.shifts as shift_row
  join public.live_activity_tokens as token_row
    on token_row.token_type = 'push_to_start'
   and token_row.shift_id is null
   and token_row.device_id is not null
  where shift_row.clock_out_at is null
    and shift_row.clock_in_at >= p_started_after
    and lower(trim(coalesce(shift_row.worker_email, ''))) <>
        'appreview@hamptonscoconuts.com'
    and lower(trim(token_row.email)) <>
        lower(trim(coalesce(shift_row.worker_email, '')))
    and exists (
      select 1
      from public.field_workers as manager
      where lower(trim(manager.email)) = lower(trim(token_row.email))
        and manager.active is true
        and manager.auth_user_id is not null
        and (
          lower(trim(coalesce(manager.role, ''))) = 'owner'
          or (
            lower(trim(coalesce(manager.role, ''))) = 'manager'
            and nullif(lower(trim(coalesce(manager.market, ''))), '') is not null
            and nullif(lower(trim(coalesce(shift_row.market, ''))), '') is not null
            and lower(trim(manager.market)) = lower(trim(shift_row.market))
          )
        )
    )
  on conflict do nothing;

  return query
  with eligible_pairs as materialized (
    select distinct
      delivery.id as delivery_id,
      shift_row.id as shift_id,
      token_row.device_id,
      lower(trim(token_row.email)) as email,
      lower(token_row.token) as token,
      shift_row.worker_name,
      lower(trim(shift_row.worker_email)) as worker_email,
      shift_row.clock_in_at,
      coalesce(latest.at, shift_row.clock_in_at) as report_at,
      coalesce(latest.lat, shift_row.clock_in_lat) as report_lat,
      coalesce(latest.lng, shift_row.clock_in_lng) as report_lng
    from public.live_activity_start_deliveries as delivery
    join public.shifts as shift_row
      on shift_row.id = delivery.shift_id
    join public.live_activity_tokens as token_row
      on token_row.token_type = 'push_to_start'
     and token_row.shift_id is null
     and lower(token_row.token) = delivery.start_token
    left join lateral (
      select location_row.at, location_row.lat, location_row.lng
      from public.shift_locations as location_row
      where location_row.shift_id = shift_row.id
      order by location_row.at desc, location_row.id desc
      limit 1
    ) as latest on true
    where shift_row.clock_out_at is null
      and lower(trim(coalesce(shift_row.worker_email, ''))) <>
          'appreview@hamptonscoconuts.com'
      and lower(trim(token_row.email)) <>
          lower(trim(coalesce(shift_row.worker_email, '')))
      and exists (
        select 1
        from public.field_workers as manager
        where lower(trim(manager.email)) = lower(trim(token_row.email))
          and manager.active is true
          and manager.auth_user_id is not null
          and (
            lower(trim(coalesce(manager.role, ''))) = 'owner'
            or (
              lower(trim(coalesce(manager.role, ''))) = 'manager'
              and nullif(lower(trim(coalesce(manager.market, ''))), '') is not null
              and nullif(lower(trim(coalesce(shift_row.market, ''))), '') is not null
              and lower(trim(manager.market)) = lower(trim(shift_row.market))
            )
          )
      )
      and not exists (
        select 1
        from public.live_activity_start_deliveries as occupied
        where occupied.shift_id = delivery.shift_id
          and occupied.device_id = token_row.device_id
          and occupied.id <> delivery.id
      )
  ), candidate_ids as materialized (
    select delivery.id
    from public.live_activity_start_deliveries as delivery
    join eligible_pairs as pair
      on pair.delivery_id = delivery.id
    where delivery.queued_at is null
      and delivery.delivered_at is null
      and delivery.terminal_at is null
      and (
        delivery.claimed_at is null
        or delivery.claimed_at < p_stale_before
      )
    order by pair.clock_in_at asc, delivery.created_at asc, delivery.id asc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of delivery skip locked
  ), claimed as (
    update public.live_activity_start_deliveries as delivery
    set claimed_at = p_claimed_at
    from candidate_ids as candidate
    where delivery.id = candidate.id
    returning
      delivery.id,
      delivery.queue_id,
      delivery.device_id,
      delivery.shift_id,
      delivery.start_token,
      delivery.generation
  )
  select
    claimed.id,
    claimed.queue_id,
    claimed.device_id,
    pair.email,
    pair.token,
    claimed.shift_id,
    pair.worker_name,
    pair.worker_email,
    pair.clock_in_at,
    pair.report_at,
    pair.report_lat,
    pair.report_lng,
    claimed.generation
  from claimed
  join eligible_pairs as pair
    on pair.delivery_id = claimed.id
  order by pair.clock_in_at asc, claimed.id asc;
end
$function$;

-- F. The wrapper the worker calls first (022:684-748): the same rows plus
-- shifts.market for the card's market label. The underlying claim executes
-- exactly once; every original column keeps its name, type and meaning.
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

-- G. The drainer's check immediately before contacting Apple (018:854-919
-- with the market rule and the device match from 022/025). It closes the
-- queue-time race with clock-out, role removal, a market move, self
-- reassignment, or token rotation. A database read failure is
-- distinguishable from false in the drainer and remains retryable without
-- sending; false, never an error, for a stale row.
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
    join public.field_workers as manager
      on lower(trim(manager.email)) = lower(trim(token_row.email))
     and manager.active is true
     and manager.auth_user_id is not null
     and (
       lower(trim(coalesce(manager.role, ''))) = 'owner'
       or (
         lower(trim(coalesce(manager.role, ''))) = 'manager'
         and nullif(lower(trim(coalesce(manager.market, ''))), '') is not null
         and nullif(lower(trim(coalesce(shift_row.market, ''))), '') is not null
         and lower(trim(manager.market)) = lower(trim(shift_row.market))
       )
     )
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
      and lower(trim(coalesce(shift_row.worker_email, ''))) <>
          'appreview@hamptonscoconuts.com'
      and lower(trim(token_row.email)) <>
          lower(trim(coalesce(shift_row.worker_email, '')))
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

-- H. Grants. Supabase default privileges hand execute on every new public
-- function to anon, authenticated AND service_role, and create or replace
-- keeps whatever grants a function already had. Take every default back on
-- every run, then grant the one caller: the service key (the worker and the
-- drainer). Nothing here is ever called by a phone.
revoke all on function public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer)
  to service_role;

revoke all on function public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer)
  to service_role;

revoke all on function public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer)
  to service_role;

revoke all on function public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text)
  to service_role;

comment on function public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer) is
  'Service role only. Leases up to p_limit activity_update tokens of closed shifts whose END lease is absent or older than p_stale_before and whose queue row is not still pending; stamps end_requested_at = p_claimed_at unchanged and a stable end_queue_id. Called by the worker''s five-minute END scan.';

comment on function public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer) is
  'Service role only. Seeds one START receipt per (open shift clocked in since p_started_after, eligible owner or manager phone) and leases up to p_limit unsent receipts whose claim is absent or older than p_stale_before, stamping claimed_at = p_claimed_at unchanged. Managers only for a shift in their own market. The worker calls the _v2 wrapper first.';

comment on function public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer) is
  'Service role only. hc_claim_live_activity_starts plus shifts.market per row, for the card''s market label. Runs the claim exactly once.';

comment on function public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text) is
  'Service role only. The drainer''s check immediately before sending one START to Apple: true while the receipt is leased or queued, undelivered, the shift open and the phone still an eligible owner or in-market manager; false (never an error) otherwise.';

-- I. Postflight.
do $postflight$
declare
  v_signature text;
  v_definition text;
  v_snapshot record;
  v_type text;
begin
  -- Nothing this file promised not to touch has changed: same body, same
  -- hardening, same grants, and the 041 team branch is still there.
  for v_snapshot in select signature, fingerprint from hc_046_auth_function_snapshot loop
    if pg_catalog.to_regprocedure(v_snapshot.signature) is null
       or v_snapshot.fingerprint is distinct from (
         select pg_catalog.md5(
                  pg_catalog.pg_get_functiondef(function_info.oid)
                  || coalesce(function_info.proacl::text, ''))
         from pg_catalog.pg_proc as function_info
         where function_info.oid = pg_catalog.to_regprocedure(v_snapshot.signature)
       ) then
      raise exception using errcode = '55000',
        message = pg_catalog.format('046 postflight: %s changed during this migration; it must not', v_snapshot.signature);
    end if;
  end loop;
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.hc_sync_notification_device(uuid,text,boolean,boolean)'));
  if pg_catalog.strpos(v_definition, 'if v_role = ''team'' then') = 0
     or pg_catalog.strpos(v_definition, 'ever_kept_team_token_at') = 0 then
    raise exception using errcode = '55000', message = '046 postflight: the 041 team branch is no longer in hc_sync_notification_device';
  end if;

  -- The ledger, its three unique constraints, its index, RLS with no policy,
  -- and its grants.
  if pg_catalog.to_regclass('public.live_activity_start_deliveries') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.live_activity_start_deliveries'::regclass) then
    raise exception using errcode = '55000', message = '046 postflight: the START ledger or its row security is missing';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'live_activity_start_deliveries'
  ) then
    raise exception using errcode = '55000', message = '046 postflight: the START ledger must carry no policy (service role only)';
  end if;
  if pg_catalog.to_regclass('public.live_activity_start_deliveries_shift_device_key') is null
     or pg_catalog.to_regclass('public.live_activity_start_deliveries_shift_token_key') is null
     or pg_catalog.to_regclass('public.live_activity_start_deliveries_queue_key') is null
     or pg_catalog.to_regclass('public.live_activity_start_deliveries_pending_idx') is null then
    raise exception using errcode = '55000', message = '046 postflight: durable START uniqueness or the pending index is missing';
  end if;
  if not exists (
       select 1 from pg_catalog.pg_constraint as c
       where c.conrelid = 'public.live_activity_start_deliveries'::regclass
         and c.conname = 'live_activity_start_deliveries_outcome_check'
         and c.contype = 'c'
     )
     or not exists (
       select 1 from pg_catalog.pg_constraint as c
       where c.conrelid = 'public.live_activity_start_deliveries'::regclass
         and c.conname = 'live_activity_start_deliveries_terminal_check'
         and c.contype = 'c'
     )
     or not exists (
       select 1 from pg_catalog.pg_constraint as c
       where c.conrelid = 'public.live_activity_start_deliveries'::regclass
         and c.conname = 'live_activity_start_deliveries_token_check'
         and c.contype = 'c'
     ) then
    raise exception using errcode = '55000', message = '046 postflight: a START ledger check constraint is missing';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.live_activity_start_deliveries', 'select')
     or pg_catalog.has_table_privilege('anon', 'public.live_activity_start_deliveries', 'update')
     or pg_catalog.has_table_privilege('authenticated', 'public.live_activity_start_deliveries', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.live_activity_start_deliveries', 'update')
     or pg_catalog.has_table_privilege('public', 'public.live_activity_start_deliveries', 'select')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_start_deliveries', 'select')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_start_deliveries', 'insert')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_start_deliveries', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_start_deliveries', 'delete') then
    raise exception using errcode = '55000', message = '046 postflight: START ledger grants are wrong';
  end if;

  -- The 010 anonymous lane is closed (018:86-136's shape for anon): no
  -- policy on live_activity_tokens names anon or PUBLIC, anon holds no
  -- table or column privilege, authenticated still cannot write (015), and
  -- the service key keeps the direct access the worker's END release PATCH
  -- and the drainer's token deletes and END release use.
  if exists (
       select 1 from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = 'live_activity_tokens'
         and ('anon'::name = any(roles) or 'public'::name = any(roles))
     ) then
    raise exception using errcode = '55000', message = '046 postflight: a policy for anon or PUBLIC is still on live_activity_tokens';
  end if;
  foreach v_signature in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if pg_catalog.has_table_privilege('anon', 'public.live_activity_tokens', v_signature)
       or pg_catalog.has_table_privilege('public', 'public.live_activity_tokens', v_signature) then
      raise exception using errcode = '55000',
        message = pg_catalog.format('046 postflight: anon or PUBLIC still holds %s on live_activity_tokens', v_signature);
    end if;
  end loop;
  foreach v_signature in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
    if pg_catalog.has_any_column_privilege('anon', 'public.live_activity_tokens', v_signature) then
      raise exception using errcode = '55000',
        message = pg_catalog.format('046 postflight: anon still holds a column %s grant on live_activity_tokens', v_signature);
    end if;
  end loop;
  if pg_catalog.has_table_privilege('authenticated', 'public.live_activity_tokens', 'insert')
     or pg_catalog.has_table_privilege('authenticated', 'public.live_activity_tokens', 'update')
     or pg_catalog.has_table_privilege('authenticated', 'public.live_activity_tokens', 'delete')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_tokens', 'select')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_tokens', 'insert')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_tokens', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.live_activity_tokens', 'delete') then
    raise exception using errcode = '55000', message = '046 postflight: live_activity_tokens grants are wrong (authenticated must not write, service_role must keep select, insert, update and delete)';
  end if;

  -- The two lease columns with the exact types the worker and drainer write.
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.live_activity_tokens'::regclass
    and a.attname = 'end_requested_at' and a.attnum > 0 and not a.attisdropped;
  if v_type is distinct from 'timestamp with time zone' then
    raise exception using errcode = '55000', message = '046 postflight: live_activity_tokens.end_requested_at is not a timestamptz';
  end if;
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.live_activity_tokens'::regclass
    and a.attname = 'end_queue_id' and a.attnum > 0 and not a.attisdropped;
  if v_type is distinct from 'uuid' then
    raise exception using errcode = '55000', message = '046 postflight: live_activity_tokens.end_queue_id is not a uuid';
  end if;
  if pg_catalog.to_regclass('public.live_activity_tokens_end_request_idx') is null then
    raise exception using errcode = '55000', message = '046 postflight: live_activity_tokens_end_request_idx is missing';
  end if;
  -- The 010 and 015 token indexes the live registration RPC targets are
  -- untouched (017 would have dropped the first two).
  if pg_catalog.to_regclass('public.live_activity_tokens_p2s_uniq') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_upd_uniq') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_device_p2s_uidx') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_device_update_uidx') is null then
    raise exception using errcode = '55000', message = '046 postflight: a 010 or 015 live_activity_tokens index is missing';
  end if;

  -- Every trigger enabled.
  foreach v_signature in array array[
    'push_queue:push_queue_retain_unconfirmed_live_activity_start',
    'push_queue:push_queue_validate_live_activity_start',
    'live_activity_tokens:live_activity_tokens_reset_end_request',
    'live_activity_tokens:live_activity_tokens_reconcile_start_device',
    'live_activity_start_deliveries:live_activity_start_deliveries_protect_identity'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_trigger as trigger_info
      where trigger_info.tgrelid = ('public.' || pg_catalog.split_part(v_signature, ':', 1))::regclass
        and trigger_info.tgname = pg_catalog.split_part(v_signature, ':', 2)
        and not trigger_info.tgisinternal
        and trigger_info.tgenabled <> 'D'
    ) then
      raise exception using errcode = '55000',
        message = pg_catalog.format('046 postflight: trigger %s is missing or disabled', v_signature);
    end if;
  end loop;

  -- The four callable functions: service_role only, hardened.
  foreach v_signature in array array[
    'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)',
    'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
    'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
    'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or pg_catalog.has_function_privilege('anon', v_signature, 'execute')
       or pg_catalog.has_function_privilege('authenticated', v_signature, 'execute')
       or pg_catalog.has_function_privilege('public', v_signature, 'execute')
       or not pg_catalog.has_function_privilege('service_role', v_signature, 'execute')
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
      raise exception using errcode = '55000',
        message = pg_catalog.format('046 postflight: %s is missing, not hardened, or its grants are wrong', v_signature);
    end if;
  end loop;

  -- The trigger functions: nobody may call them directly.
  foreach v_signature in array array[
    'public.hc_reset_live_activity_end_request()',
    'public.hc_retain_unconfirmed_live_activity_start_queue()',
    'public.hc_validate_live_activity_start_queue()',
    'public.hc_protect_live_activity_start_delivery()',
    'public.hc_reconcile_live_activity_start_device()'
  ] loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or pg_catalog.has_function_privilege('anon', v_signature, 'execute')
       or pg_catalog.has_function_privilege('authenticated', v_signature, 'execute')
       or pg_catalog.has_function_privilege('public', v_signature, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_signature, 'execute') then
      raise exception using errcode = '55000',
        message = pg_catalog.format('046 postflight: trigger function %s is missing or callable by a client role', v_signature);
    end if;
  end loop;
end
$postflight$;

commit;
