-- ============================================================================
-- 046_live_activity_claims_rollback.sql
-- Undo migration 046: drop the two START claims, the END claim, the
-- drainer's validator, the push_queue guards, the token triggers, the START
-- ledger with every receipt in it, the END lease index and the two END
-- lease columns on live_activity_tokens. Safe to run twice. Touches nothing
-- else: hc_register_live_activity_token, hc_sync_notification_device,
-- hc_unregister_device, the 015c functions, the 010 and 015 token indexes,
-- every policy, the token rows themselves and push_queue rows all stay.
--
-- PAUSE WITHOUT ROLLBACK first. This file refuses while an open shift
-- holds a START receipt. To stop new claims mid-shift without dropping
-- anything (reversible, no data loss), revoke execute on the three claims
-- from service_role instead:
--   revoke execute on function
--     public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer),
--     public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer),
--     public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer)
--   from service_role;
-- The worker's scans return on the non-404 error within one tick, the
-- drainer keeps finishing rows already queued (the validator is left
-- alone), and the matching grant (or a 046 re-run) resumes. Run this file
-- only once the shifts have closed.
--
-- It does NOT reopen the 010 anonymous lane on live_activity_tokens that
-- 046 closed (the two anon policies and anon's table grants). No phone has
-- written through that lane since the 2026-08-25 secure-auth build, and
-- putting it back would restore the exposure 046 closed (the public anon
-- key choosing which phone receives a crew member's card). If a phone that
-- old ever needs it again, that is a separate, deliberate migration
-- (016's rollback file carries the text).
--
-- It REFUSES (55000) while a START receipt is claimed but not yet queued
-- and Apple has not answered it (a worker enqueue may be in flight; a
-- receipt Apple already answered delivered or terminal keeps its lease
-- stamp by design and never blocks), while a receipt on an open shift is
-- queued but Apple has not answered (a push may be in flight on the
-- droplet), while an open shift still has any receipt at all (a re-apply
-- would seed that shift again and send a second card to a phone already
-- showing one), while push_queue holds an unfinished la_start or la_end
-- row, and while any token row still carries an END lease. Let the shifts
-- close and the worker and the drainer settle (the queue rows finish, the
-- drainer records delivered or terminal, the END leases clear when the
-- tokens are deleted or released), then run this again. The tables are
-- locked from the checks through the drops so a new claim cannot race them.
--
-- Releasing an END lease by hand (the worker and the drainer down, the
-- usual reason to roll back): 046's reset trigger keeps end_requested_at
-- and end_queue_id for any UPDATE that is not service_role, and the
-- Supabase SQL editor is not service_role (auth.role() is null there), so
-- a plain UPDATE from the editor is a silent no-op and this file keeps
-- refusing. Run in ONE transaction instead:
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   update public.live_activity_tokens
--      set end_requested_at = null, end_queue_id = null
--    where end_requested_at is not null or end_queue_id is not null;
--   commit;
-- The setting dies with the transaction. Deleting the leased
-- activity_update rows of closed shifts (the phones' cards are over) is the
-- other way; both need Sidd's "yes do it".
--
-- After this file the worker's five-minute scans log 404 PGRST202 again
-- and no remote card starts or ends; a locally started card still ends on
-- the phone's own foreground sweep.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Object preflight through dynamic SQL, so this file still parses when the
-- ledger or the columns are already gone (the second run of this file).
do $preflight$
declare
  v_ledger boolean := pg_catalog.to_regclass('public.live_activity_start_deliveries') is not null;
  v_lease_columns boolean := exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.live_activity_tokens'::regclass
      and attname in ('end_requested_at', 'end_queue_id')
      and attnum > 0
      and not attisdropped);
  v_blocked boolean := false;
begin
  -- Hold token, ledger, queue and shift state still from here to commit.
  if v_ledger then
    execute 'lock table public.live_activity_start_deliveries in share row exclusive mode';
  end if;
  execute 'lock table public.live_activity_tokens, public.push_queue, public.shifts in share row exclusive mode';

  if v_ledger then
    -- A receipt Apple already answered (delivered_at or terminal_at set)
    -- cannot have an enqueue in flight: its queue row committed and was
    -- drained. The worker keeps the lease stamp on such a row by design
    -- (an unknown enqueue outcome never releases), so it is excluded here.
    execute 'select exists (select 1 from public.live_activity_start_deliveries'
         || ' where claimed_at is not null and queued_at is null'
         || ' and delivered_at is null and terminal_at is null)'
       into v_blocked;
    if v_blocked then
      raise exception using
        errcode = '55000',
        message = '046 rollback refuses while a START receipt is claimed, not queued and unanswered (a worker enqueue may be in flight); let the claim complete, or let the shift close and the worker tick once (its START scan clears pre-close leases; with the worker down, null claimed_at by hand on receipts of closed shifts), then run again';
    end if;
    execute 'select exists (select 1 from public.live_activity_start_deliveries as delivery'
         || ' join public.shifts as shift_row on shift_row.id = delivery.shift_id'
         || ' where shift_row.clock_out_at is null'
         || ' and delivery.queued_at is not null and delivery.delivered_at is null and delivery.terminal_at is null)'
       into v_blocked;
    if v_blocked then
      raise exception using
        errcode = '55000',
        message = '046 rollback refuses while a START receipt is queued but Apple has not answered (a push may be in flight on the droplet); let the drainer record delivered or terminal, then run again';
    end if;
    execute 'select exists (select 1 from public.live_activity_start_deliveries as delivery'
         || ' join public.shifts as shift_row on shift_row.id = delivery.shift_id'
         || ' where shift_row.clock_out_at is null)'
       into v_blocked;
    if v_blocked then
      raise exception using
        errcode = '55000',
        message = '046 rollback refuses while an open shift still has a START receipt (a re-apply would seed that shift again and send a second card); wait for the shift to clock out, then run again';
    end if;
  end if;

  if exists (
    select 1
    from public.push_queue
    where kind in ('la_start', 'la_end')
      and done_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = '046 rollback refuses while push_queue holds an unfinished la_start or la_end row; let the drainer finish them, then run again';
  end if;

  if v_lease_columns then
    execute 'select exists (select 1 from public.live_activity_tokens'
         || ' where end_requested_at is not null or end_queue_id is not null)'
       into v_blocked;
    if v_blocked then
      raise exception using
        errcode = '55000',
        message = '046 rollback refuses while a live_activity_tokens row still carries an END lease; let the drainer deliver or release it, or release it by hand in ONE transaction (a plain UPDATE from the SQL editor is silently kept by the reset trigger): begin; select set_config(''request.jwt.claim.role'', ''service_role'', true); update public.live_activity_tokens set end_requested_at = null, end_queue_id = null where end_requested_at is not null or end_queue_id is not null; commit; then run again';
    end if;
  end if;
end
$preflight$;

drop function if exists public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer);
drop function if exists public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer);
drop function if exists public.hc_validate_live_activity_start_delivery(uuid, uuid, uuid, integer, text);
drop function if exists public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer);

drop trigger if exists push_queue_validate_live_activity_start on public.push_queue;
drop function if exists public.hc_validate_live_activity_start_queue();

drop trigger if exists push_queue_retain_unconfirmed_live_activity_start on public.push_queue;
drop function if exists public.hc_retain_unconfirmed_live_activity_start_queue();

drop trigger if exists live_activity_tokens_reconcile_start_device on public.live_activity_tokens;
drop function if exists public.hc_reconcile_live_activity_start_device();

drop trigger if exists live_activity_tokens_reset_end_request on public.live_activity_tokens;
drop function if exists public.hc_reset_live_activity_end_request();

-- The ledger and its protect trigger go together (dynamic, the table may be
-- gone already).
do $ledger$
begin
  if pg_catalog.to_regclass('public.live_activity_start_deliveries') is not null then
    execute 'drop trigger if exists live_activity_start_deliveries_protect_identity on public.live_activity_start_deliveries';
    execute 'drop table public.live_activity_start_deliveries';
  end if;
end
$ledger$;
drop function if exists public.hc_protect_live_activity_start_delivery();

drop index if exists public.live_activity_tokens_end_request_idx;

-- Only after the lease checks above passed.
alter table public.live_activity_tokens
  drop column if exists end_requested_at;

alter table public.live_activity_tokens
  drop column if exists end_queue_id;

do $postflight$
declare
  v_definition text;
begin
  if pg_catalog.to_regclass('public.live_activity_start_deliveries') is not null
     or pg_catalog.to_regclass('public.live_activity_tokens_end_request_idx') is not null
     or pg_catalog.to_regprocedure('public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)') is not null
     or pg_catalog.to_regprocedure('public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)') is not null
     or pg_catalog.to_regprocedure('public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)') is not null
     or pg_catalog.to_regprocedure('public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)') is not null
     or pg_catalog.to_regprocedure('public.hc_validate_live_activity_start_queue()') is not null
     or pg_catalog.to_regprocedure('public.hc_retain_unconfirmed_live_activity_start_queue()') is not null
     or pg_catalog.to_regprocedure('public.hc_reconcile_live_activity_start_device()') is not null
     or pg_catalog.to_regprocedure('public.hc_reset_live_activity_end_request()') is not null
     or pg_catalog.to_regprocedure('public.hc_protect_live_activity_start_delivery()') is not null
     or exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.live_activity_tokens'::regclass
         and attname in ('end_requested_at', 'end_queue_id')
         and attnum > 0
         and not attisdropped
     ) then
    raise exception using errcode = '55000', message = '046 rollback postflight: something 046 installed is still present';
  end if;
  -- What this file must leave alone.
  if pg_catalog.to_regprocedure('public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)') is null
     or pg_catalog.to_regprocedure('public.hc_sync_notification_device(uuid,text,boolean,boolean)') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_p2s_uniq') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_upd_uniq') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_device_p2s_uidx') is null
     or pg_catalog.to_regclass('public.live_activity_tokens_device_update_uidx') is null then
    raise exception using errcode = '55000', message = '046 rollback postflight: a 015 function or a 010/015 token index is missing; this file never drops those';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.hc_sync_notification_device(uuid,text,boolean,boolean)'));
  if pg_catalog.strpos(v_definition, 'if v_role = ''team'' then') = 0
     or pg_catalog.strpos(v_definition, 'ever_kept_team_token_at') = 0 then
    raise exception using errcode = '55000', message = '046 rollback postflight: the 041 team branch is no longer in hc_sync_notification_device';
  end if;
end
$postflight$;

commit;
