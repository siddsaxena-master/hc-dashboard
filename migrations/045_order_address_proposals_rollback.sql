-- ============================================================================
-- 045_order_address_proposals_rollback.sql
-- Undo migration 045: drop the owner's decision function, the read policy,
-- the address proposals table with every proposal and apply note in it, the
-- two columns on intake_messages (replayed_at, address_scanned_at), and put
-- 044's hold_reasons check back on order_reconfirmations (the word
-- pending_address_proposal leaves the list). Safe to run twice. Touches
-- nothing else: orders, intake rows themselves (rows a decision already
-- dismissed stay dismissed), delivery_request, order_time_proposals, the
-- reconfirmation rows and every other function stay as they are.
--
-- It REFUSES (55000) while any accepted row is queued or applying: a
-- QuickBooks write may be in flight on the droplet, and dropping the row
-- under it would lose the outcome. Let Jarvis finish (the row reads applied
-- or failed), or turn JARVIS_ADDRESS_APPLY off and wait for the applying
-- rows to settle, then run this again.
--
-- It also REFUSES (55000) while any order_reconfirmations row still holds
-- with pending_address_proposal: 044's narrower check could not be put
-- back over such a row. Let the worker (deployed without the feature)
-- rewrite those rows, or clear the reason by hand, then run this again.
--
-- Dropping replayed_at loses the card-suppression marks on replayed rows:
-- a worker without 045's filters would card every replayed row still in
-- pending_review within minutes. Run this only after replayed rows are
-- dismissed (the scan dismisses them on their first address-scanned tick,
-- and a replayed row on a cancelled order on its cancelled path, both with
-- ADDRESS_PROPOSALS on; check
-- intake_messages?status=eq.pending_review&replayed_at=not.is.null
-- is empty first). Rows the scan never reads stay pending_review on their
-- own: a replayed row on a job whose delivery day passed before its first
-- address pass, or on a quoted job never invoiced. Those need the same
-- one-line dismissal by stamp the replay's undo sentence describes
-- (PATCH intake_messages?replayed_at=eq.<run stamp>&status=eq.pending_review
-- to status dismissed, error_detail 'replay: <reason>', its own "yes do
-- it") before this file runs. Until the worker, Jarvis and the phone are
-- redeployed without the feature they log a missing table or column and
-- propose, apply or show nothing.
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_in_flight boolean := false;
  v_held boolean := false;
begin
  -- Dynamic SQL, so this block still parses when the table is already gone
  -- (the second run of this file).
  if pg_catalog.to_regclass('public.order_address_proposals') is not null then
    execute 'select exists (select 1 from public.order_address_proposals'
         || ' where status = ''accepted'' and apply_status in (''queued'', ''applying''))'
       into v_in_flight;
  end if;
  if v_in_flight then
    raise exception using
      errcode = '55000',
      message = '045 rollback refuses while an accepted address proposal is queued or applying (a QuickBooks write may be in flight); let Jarvis finish or turn JARVIS_ADDRESS_APPLY off and wait for those rows to settle, then run again';
  end if;
  -- 044's narrower hold_reasons check cannot go back over a row that still
  -- holds with the 045 reason.
  if pg_catalog.to_regclass('public.order_reconfirmations') is not null then
    execute 'select exists (select 1 from public.order_reconfirmations'
         || ' where ''pending_address_proposal'' = any(hold_reasons))'
       into v_held;
  end if;
  if v_held then
    raise exception using
      errcode = '55000',
      message = '045 rollback refuses while an order_reconfirmations row holds with pending_address_proposal; let the worker rewrite those rows (or clear the reason by hand), then run again';
  end if;
end
$preflight$;

-- 044's hold_reasons list, word for word. Dynamic SQL, so this file still
-- parses when order_reconfirmations itself is gone (044 rolled back first).
do $holds$
begin
  if pg_catalog.to_regclass('public.order_reconfirmations') is not null then
    execute 'alter table public.order_reconfirmations drop constraint if exists order_reconfirmations_hold_reasons_check';
    execute 'alter table public.order_reconfirmations add constraint order_reconfirmations_hold_reasons_check check (hold_reasons <@ array['
         || '''count_missing'', ''address_missing'', ''cracking_unknown'', ''pending_time_proposal'','
         || ' ''no_email'', ''billing_email_only'', ''too_many_emails'', ''date_unverified'','
         || ' ''owner_hold'']::text[])';
  end if;
end
$holds$;

drop function if exists public.hc_decide_proposed_address(uuid, bigint, text);

drop policy if exists order_address_proposals_owner_select on public.order_address_proposals;

drop table if exists public.order_address_proposals;

alter table public.intake_messages
  drop column if exists replayed_at;

alter table public.intake_messages
  drop column if exists address_scanned_at;

do $postflight$
declare
  v_check text;
begin
  if pg_catalog.to_regclass('public.order_address_proposals') is not null
     or pg_catalog.to_regprocedure('public.hc_decide_proposed_address(uuid, bigint, text)') is not null
     or exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = 'public.intake_messages'::regclass
         and attname in ('replayed_at', 'address_scanned_at')
         and attnum > 0
         and not attisdropped
     ) then
    raise exception using errcode = '55000', message = '045 rollback postflight: something 045 installed is still present';
  end if;
  if pg_catalog.to_regclass('public.order_reconfirmations') is not null then
    select pg_catalog.pg_get_constraintdef(c.oid) into v_check
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.order_reconfirmations'::regclass
      and c.conname = 'order_reconfirmations_hold_reasons_check'
      and c.contype = 'c';
    if v_check is null
       or pg_catalog.strpos(v_check, 'pending_address_proposal') > 0
       or pg_catalog.strpos(v_check, 'pending_time_proposal') = 0 then
      raise exception using errcode = '55000', message = '045 rollback postflight: order_reconfirmations.hold_reasons is not back on 044''s list';
    end if;
  end if;
end
$postflight$;

commit;
