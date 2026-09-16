-- ============================================================================
-- 045_order_address_proposals.sql
-- A drop off address found in a customer's email about a booked job, waiting
-- for the owner's Accept or Keep in the HC Field app. Written 2026-09-15
-- against PHASE2-ADDRESS-PROPOSALS-PLAN-2026-09-15.md section 3.
--
-- LOCAL PREPARATION ONLY until Sidd approves the production run.
--
-- Why: on 2026-09-15 invoice 2049 carried the customer's Englewood, NJ
-- address on one line, so QuickBooks taxed it as NYC. The address had been
-- sitting in her August email the whole time. Now the Claudia worker reads
-- the address out of the email (or its PDF) and this table is where that
-- reading waits for a human. Nothing here changes an invoice by itself:
-- approval-first (Sidd, 2026-07-25) stays the rule, and even the owner's
-- Accept only QUEUES the address; Jarvis writes it to QuickBooks on the
-- droplet, QuickBooks recomputes the tax, and the order is re-synced.
--
-- What this adds:
--   * public.intake_messages.replayed_at: set only by the one-time replay
--     script on old mail it re-reads. Every Telegram-facing worker query
--     filters it out, so a replayed row is never carded, digested or nagged.
--   * public.intake_messages.address_scanned_at: stamped by the worker once
--     the address branch has looked at the row, whatever the outcome, so the
--     extraction and the one geocode call run once per email.
--   * public.order_address_proposals: one row per intake email (intake_id is
--     the primary key), pointing at one order, holding the structured
--     address, the words for the row, the line it was read from, a snapshot
--     of what was on file, and the Jarvis apply state. Its own table, not a
--     kind column on order_time_proposals: 042's decision function updates
--     rows by intake_id alone, so a shared table would let a Time Accept
--     flip the same email's address row too. One email can hold one time
--     row (042) and one address row (here) side by side.
--   * One more hold reason on public.order_reconfirmations (044):
--     'pending_address_proposal' joins the hold_reasons check, so the
--     reconfirmation draft can hold while an Address? row is waiting.
--     Without it every reconfirmation insert or rewrite for such an order
--     would fail the check (23514) and the hold would never land.
--   * public.hc_decide_proposed_address(order, intake, decision): the
--     owner's Accept or Keep. Accept sets status accepted and apply_status
--     queued and writes NOTHING to orders, delivery_request or QuickBooks;
--     Jarvis applies it. It refuses to apply when the invoice on the order
--     changed, the delivery date moved, the on-file address moved after the
--     email arrived, the order is cancelled, or the address has no ZIP
--     (QuickBooks needs one), and says so instead of raising. Both
--     decisions dismiss the intake row so the Telegram queue stops nagging.
--     On a row Jarvis failed to apply, Keep is the Dismiss button.
--
-- Reading: owner only (row level security with public.hc_is_owner()), a
-- SELECT grant to the authenticated role, nothing for anon or PUBLIC.
-- Managers do not see proposals; the public dashboard key gets nothing.
--
-- What this never touches: order_time_proposals, hc_decide_proposed_time,
-- hc_set_delivery_request, orders, delivery_request, and every existing
-- policy or function. intake_messages only gains the two columns and the
-- status flip a decision makes. The one existing constraint it rewrites is
-- 044's hold_reasons check on order_reconfirmations (one word added, the
-- rest of 044's list kept word for word).
-- ============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_column text;
  v_check text;
  v_type text;
begin
  -- order_time_proposals (042) proves this database is on the lineage the
  -- worker and the phone were built against.
  if pg_catalog.to_regclass('public.orders') is null
     or pg_catalog.to_regclass('public.intake_messages') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.to_regprocedure('public.hc_is_owner()') is null
     or pg_catalog.to_regclass('public.order_time_proposals') is null then
    raise exception using
      errcode = '55000',
      message = '045 requires orders, intake_messages, auth.uid(), public.hc_is_owner() (015) and public.order_time_proposals (042)';
  end if;

  -- A decision dismisses the intake row; the replay stamps classified_at;
  -- the reply scan matches on conversation_id (044).
  foreach v_column in array array['id', 'order_id', 'status', 'reviewed_at', 'error_detail', 'classified_at', 'conversation_id'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.intake_messages'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('045 requires column public.intake_messages.%s (004/005/044)', v_column);
    end if;
  end loop;

  -- The decision function reads these to refuse a stale proposal.
  foreach v_column in array array['id', 'stage', 'market', 'delivery_at_utc', 'event_start_at', 'invoice_fulfillment', 'external_invoice_id', 'delivery_notes', 'venue'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.orders'::regclass
        and attname = v_column
        and attnum > 0
        and not attisdropped
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('045 requires column public.orders.%s (034 adds invoice_fulfillment)', v_column);
    end if;
  end loop;

  -- A decision dismisses the intake row; the status list must allow it.
  select pg_catalog.pg_get_constraintdef(c.oid) into v_check
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.intake_messages'::regclass
    and c.conname = 'intake_messages_status_check';
  if v_check is null or pg_catalog.strpos(v_check, 'dismissed') = 0 then
    raise exception using
      errcode = '55000',
      message = '045 requires the intake_messages status list to admit ''dismissed'' (004/005)';
  end if;

  -- The reconfirmation draft holds while an Address? row is waiting (hold
  -- reason pending_address_proposal, plan section 5a). 044's check on
  -- order_reconfirmations.hold_reasons must admit that word, or every
  -- reconfirmation insert or rewrite for such an order fails with 23514
  -- and the hold never lands. Section A2 widens the check; here the 044
  -- shape is proved first (the constraint exists under its 044 name and
  -- already admits pending_time_proposal), so a foreign constraint is
  -- never rewritten. A second run of this file sees the widened list,
  -- which still names pending_time_proposal, and passes.
  if pg_catalog.to_regclass('public.order_reconfirmations') is null then
    raise exception using
      errcode = '55000',
      message = '045 requires public.order_reconfirmations (044)';
  end if;
  select pg_catalog.pg_get_constraintdef(c.oid) into v_check
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.order_reconfirmations'::regclass
    and c.conname = 'order_reconfirmations_hold_reasons_check'
    and c.contype = 'c';
  if v_check is null or pg_catalog.strpos(v_check, 'pending_time_proposal') = 0 then
    raise exception using
      errcode = '55000',
      message = '045 requires the 044 hold_reasons check on public.order_reconfirmations (constraint order_reconfirmations_hold_reasons_check admitting pending_time_proposal); review that table before applying';
  end if;

  -- A replayed_at or address_scanned_at that already exists must be a
  -- timestamptz, or the replay script and the worker would write into a
  -- column of the wrong shape and nobody would notice for days.
  foreach v_column in array array['replayed_at', 'address_scanned_at'] loop
    select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
    from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.intake_messages'::regclass
      and a.attname = v_column
      and a.attnum > 0
      and not a.attisdropped;
    if v_type is not null and v_type <> 'timestamp with time zone' then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('045 refuses an existing public.intake_messages.%s of type %s; review that column before applying', v_column, v_type);
    end if;
  end loop;

  if pg_catalog.to_regclass('public.order_address_proposals') is not null then
    foreach v_column in array array['intake_id', 'order_id', 'proposed_address', 'proposed_text', 'status', 'apply_status', 'apply_after', 'invoice_id_snapshot', 'delivery_day_snapshot', 'found_at'] loop
      if not exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'public.order_address_proposals'::regclass
          and attname = v_column
          and attnum > 0
          and not attisdropped
      ) then
        raise exception using
          errcode = '55000',
          message = pg_catalog.format(
            '045 refuses an existing public.order_address_proposals with no %s column; review that table before applying',
            v_column);
      end if;
    end loop;
  end if;
end
$preflight$;

-- A. Two nullable columns on the intake row. Rows the poller wrote before
-- this migration stay null on both.
alter table public.intake_messages
  add column if not exists replayed_at timestamptz;

alter table public.intake_messages
  add column if not exists address_scanned_at timestamptz;

comment on column public.intake_messages.replayed_at is
  'Set only by the one-time replay script (scripts/replay_intake_since.py) on old mail it re-reads, never by the live poller. Every Telegram-facing worker query (cards, digest, nag, reply scan) filters replayed_at is null, so a replayed row is never carded. Null on live mail.';

comment on column public.intake_messages.address_scanned_at is
  'Stamped by the Claudia worker once its address branch has evaluated the row, whatever the outcome (proposed, agreed, rejected, stale), so the address extraction and the one geocode call run once per email. Left null while the order has no invoice yet, so the row is read again once it is invoiced.';

-- A2. The reconfirmation hold for a waiting Address? row. 044's check on
-- order_reconfirmations.hold_reasons lists every reason the app can name;
-- pending_address_proposal joins that list (044's words, one more entry).
-- Dropped and re-added under the same name, so a re-run is harmless; the
-- rollback restores 044's list. Every existing row's reasons are a subset
-- of the old list, so the new check validates them without a rewrite.
alter table public.order_reconfirmations
  drop constraint if exists order_reconfirmations_hold_reasons_check;

alter table public.order_reconfirmations
  add constraint order_reconfirmations_hold_reasons_check check (hold_reasons <@ array[
    'count_missing', 'address_missing', 'cracking_unknown', 'pending_time_proposal',
    'pending_address_proposal', 'no_email', 'billing_email_only', 'too_many_emails',
    'date_unverified', 'owner_hold']::text[]);

-- B. One proposal per email. Cascades away with the email row.
create table if not exists public.order_address_proposals (
  intake_id bigint primary key references public.intake_messages(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  -- The address the email named, structured the way QuickBooks wants it:
  -- {line1, line2?, city, state, postal_code?, state_inferred?, state_from?}.
  -- State is a two-letter code; the ZIP is five digits or missing (the row
  -- then reads "no ZIP found" and Accept is refused until it is set by
  -- hand). The last two keys are worker-only hints: when the state was
  -- assumed from a town name (state_inferred true, state_from the town,
  -- geocode-confirmed) the phone prints "(state assumed NY from
  -- Southampton)" and Jarvis ignores them. Every read is wrapped in
  -- coalesce: a missing key would otherwise make the whole check NULL,
  -- and a NULL check passes.
  proposed_address jsonb not null check (
    pg_catalog.jsonb_typeof(proposed_address) = 'object'
    and coalesce(pg_catalog.jsonb_typeof(proposed_address -> 'line1'), '') = 'string'
    and pg_catalog.btrim(coalesce(proposed_address ->> 'line1', '')) <> ''
    and coalesce(pg_catalog.jsonb_typeof(proposed_address -> 'city'), '') = 'string'
    and pg_catalog.btrim(coalesce(proposed_address ->> 'city', '')) <> ''
    and coalesce(proposed_address ->> 'state', '') ~ '^[A-Z]{2}$'
    and (proposed_address ->> 'postal_code' is null or proposed_address ->> 'postal_code' ~ '^\d{5}$')),
  -- The same address as one line for the row title
  -- ('491 S Dean Street, Englewood, NJ 07631').
  proposed_text text not null check (pg_catalog.length(proposed_text) between 1 and 200 and proposed_text !~ '[[:cntrl:]]'),
  -- The line it was read from and where (body or attachment name). Never
  -- an email address or phone number: the worker strips those first.
  evidence_line text check (evidence_line is null or pg_catalog.length(evidence_line) <= 200),
  evidence_where text check (evidence_where is null or pg_catalog.length(evidence_where) <= 120),
  -- What the order said when the proposal was made (the address precedence
  -- the plan, the app and the email share: invoice, delivery notes, venue),
  -- so the app can say 're-check' if the on-file address moved meanwhile.
  on_file_address text check (on_file_address is null or pg_catalog.length(on_file_address) <= 400),
  on_file_source text check (on_file_source is null or on_file_source in ('invoice', 'delivery_notes', 'venue')),
  -- invoice_fulfillment.address_structured at scan time (null = unknown,
  -- the order was synced before Jarvis learned to record it).
  on_file_structured boolean,
  -- The invoice was edited after the email was received.
  on_file_newer boolean not null default false,
  -- orders.external_invoice_id and the delivery day at scan time. A decision
  -- refuses to apply when either moved since.
  invoice_id_snapshot text,
  delivery_day_snapshot date,
  found_at timestamptz not null default pg_catalog.now(),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'kept', 'superseded')),
  decided_at timestamptz,
  decided_by uuid,
  decided_via text check (decided_via is null or decided_via in ('app', 'owner_edit', 'invoice_changed', 'date_moved', 'newer_email', 'cancelled')),
  -- The Jarvis apply state of an accepted row: queued (waiting for the
  -- droplet), applying (claimed), applied (on the invoice and re-synced),
  -- failed (QuickBooks refused; error_detail says why; Keep is Dismiss).
  apply_status text check (apply_status is null or apply_status in ('queued', 'applying', 'applied', 'failed')),
  apply_after timestamptz,
  apply_claimed_at timestamptz,
  apply_attempts integer not null default 0,
  -- The QuickBooks write is done. Set while apply_status is still 'applying'
  -- means the dashboard re-sync is pending.
  applied_at timestamptz,
  -- 'Invoice #2049: tax 92.19 to 68.75, total 1342.19 to 1318.75' or
  -- 'already on the invoice'. Dollar figures live here, never in a banner.
  apply_note text check (apply_note is null or pg_catalog.length(apply_note) <= 300),
  -- QuickBooks' printed number (DocNumber), stamped by Jarvis at apply time,
  -- for the banner. orders.external_invoice_id is the internal Id, not this.
  invoice_doc_number text check (invoice_doc_number is null or pg_catalog.length(invoice_doc_number) <= 40),
  -- TotalAmt changed on the write (Jarvis).
  total_moved boolean not null default false,
  -- Automated tax answered 0 for a non-manual state (Jarvis).
  tax_zero boolean not null default false,
  error_detail text check (error_detail is null or pg_catalog.length(error_detail) <= 300),
  -- When the applied or failed push went out.
  notified_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  -- An accepted row always carries an apply state and nothing else ever
  -- does, so Dismiss (status kept) and every retirement must null
  -- apply_status; error_detail keeps the reason.
  constraint order_address_proposals_accepted_apply_check
    check ((status = 'accepted') = (apply_status is not null))
);

create index if not exists order_address_proposals_order_status_idx
  on public.order_address_proposals (order_id, status);

-- Jarvis's queue read: accepted rows by apply state and earliest apply time.
create index if not exists order_address_proposals_apply_idx
  on public.order_address_proposals (apply_status, apply_after)
  where status = 'accepted';

-- C. Grants and row security, the 042 shape.
alter table public.order_address_proposals enable row level security;

revoke all on table public.order_address_proposals from public, anon, authenticated;
grant select on table public.order_address_proposals to authenticated;
grant select, insert, update, delete on table public.order_address_proposals to service_role;

drop policy if exists order_address_proposals_owner_select on public.order_address_proposals;
create policy order_address_proposals_owner_select
on public.order_address_proposals
for select to authenticated
using (public.hc_is_owner());

-- D. The owner's decision. Returns jsonb:
--   { applied: true,  outcome: 'accepted' | 'kept', row }
--   { applied: false, outcome: 'accepted' | 'kept' | 'superseded' | 'refused'
--                   | 'cancelled' | 'failed', message, row }
-- Accept queues the address for Jarvis (status accepted, apply_status
-- queued); nothing is written to orders, delivery_request or QuickBooks
-- here. Never raises for a state the app should simply show; raises 42501
-- for the wrong caller and 22023 for a malformed call.
create or replace function public.hc_decide_proposed_address(
  p_order_id uuid,
  p_intake_id bigint,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_decision text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_decision, '')));
  v_p public.order_address_proposals%rowtype;
  v_stage text;
  v_invoice_id text;
  v_delivery_at timestamptz;
  v_event_start timestamptz;
  v_fulfillment jsonb;
  v_delivery_notes text;
  v_venue text;
  v_day date;
  v_on_file text;
  v_snapshot text;
  -- The Unicode spaces the worker's collapseSpaces folds (JavaScript's \s:
  -- no-break space U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029,
  -- U+202F, U+205F, U+3000 and the byte order mark U+FEFF). Postgres' \s
  -- leaves them alone, so both sides translate them to a plain space first,
  -- or a no-break space pasted into QuickBooks would make every tap answer
  -- 'The invoice address changed after this email arrived'.
  v_ws constant text := pg_catalog.chr(160) || pg_catalog.chr(5760)
    || pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194) || pg_catalog.chr(8195)
    || pg_catalog.chr(8196) || pg_catalog.chr(8197) || pg_catalog.chr(8198) || pg_catalog.chr(8199)
    || pg_catalog.chr(8200) || pg_catalog.chr(8201) || pg_catalog.chr(8202)
    || pg_catalog.chr(8232) || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287)
    || pg_catalog.chr(12288) || pg_catalog.chr(65279);
  v_ws_to constant text := pg_catalog.repeat(' ', 19);
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_uid is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated field worker required';
  end if;

  if not public.hc_is_owner() then
    raise exception using
      errcode = '42501',
      message = 'only the owner can decide a proposed address';
  end if;

  if v_decision not in ('accept', 'keep') then
    raise exception using
      errcode = '22023',
      message = 'decision must be accept or keep';
  end if;

  if p_order_id is null or p_intake_id is null then
    raise exception using
      errcode = '22023',
      message = 'an order id and an intake id are required';
  end if;

  select p.* into v_p
  from public.order_address_proposals as p
  where p.intake_id = p_intake_id
    and p.order_id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'No such proposal';
  end if;

  -- Jarvis could not put it on the invoice. Keep is the Dismiss button: the
  -- row leaves the accepted state (the check constraint demands a null
  -- apply_status then) and error_detail keeps QuickBooks' reason. Accept
  -- again would only fail the same way, so it is reported, not queued.
  if v_p.status = 'accepted' and v_p.apply_status = 'failed' then
    if v_decision = 'accept' then
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'failed',
        'message', 'QuickBooks refused this one. Put the address on the invoice in the Jarvis chat.',
        'row', pg_catalog.to_jsonb(v_p));
    end if;
    update public.order_address_proposals
       set status = 'kept', decided_via = 'app', apply_status = null,
           decided_at = v_now, decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    -- The email was answered when the owner first accepted; this is a
    -- guarded no-op unless something reopened it.
    update public.intake_messages
       set status = 'dismissed',
           reviewed_at = v_now,
           error_detail = 'address proposal ' || v_p.status || ' by the owner in HC Field'
     where id = p_intake_id
       and status = 'pending_review';
    return pg_catalog.jsonb_build_object(
      'applied', true, 'outcome', v_p.status, 'row', pg_catalog.to_jsonb(v_p));
  end if;

  -- Already decided (including accepted rows Jarvis is working on or has
  -- applied): report it, write nothing.
  if v_p.status <> 'pending' then
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', v_p.status, 'decided_at', v_p.decided_at,
      'message', 'Already decided.', 'row', pg_catalog.to_jsonb(v_p));
  end if;

  select o.stage, o.external_invoice_id, o.delivery_at_utc, o.event_start_at,
         o.invoice_fulfillment, o.delivery_notes, o.venue
  into v_stage, v_invoice_id, v_delivery_at, v_event_start,
       v_fulfillment, v_delivery_notes, v_venue
  from public.orders as o
  where o.id = p_order_id;

  if v_stage = 'cancelled' then
    update public.order_address_proposals
       set status = 'superseded', decided_via = 'cancelled', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'cancelled',
      'message', 'This order is cancelled.', 'row', pg_catalog.to_jsonb(v_p));
  end if;

  -- The invoice on the order is not the one the proposal was read against:
  -- Jarvis would write to the wrong document.
  if v_invoice_id is distinct from v_p.invoice_id_snapshot then
    update public.order_address_proposals
       set status = 'superseded', decided_via = 'invoice_changed', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'superseded',
      'message', 'The invoice on this order changed after this email. Set the address through Jarvis.',
      'row', pg_catalog.to_jsonb(v_p));
  end if;

  -- The delivery day the way the app buckets days (038): the UTC calendar
  -- date of the delivery marker, else of the event start. Reading it
  -- through 'UTC' keeps the answer the same whatever timezone the session has.
  v_day := coalesce(
    (v_delivery_at at time zone 'UTC')::date,
    (v_event_start at time zone 'UTC')::date);
  if v_day is distinct from v_p.delivery_day_snapshot then
    update public.order_address_proposals
       set status = 'superseded', decided_via = 'date_moved', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'superseded',
      'message', 'The delivery date moved after this email arrived. Set the address through Jarvis.',
      'row', pg_catalog.to_jsonb(v_p));
  end if;

  -- The address on file now, with the precedence the worker's
  -- departureDestination uses: the invoice ship address when it was read
  -- completely, else the delivery notes, else the venue. Each value is
  -- collapsed (Unicode spaces to plain spaces first, then runs of
  -- whitespace to one space, trimmed) so a blank or whitespace-only value
  -- is skipped the way collapseSpaces skips it, then both sides are
  -- lower-cased and cut at 400 characters (departureDestination slices
  -- there). When that differs from the snapshot the owner changed the
  -- address after this email arrived, and their word wins.
  v_on_file := coalesce(
    case when v_fulfillment ->> 'read_status' = 'complete'
         then nullif(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(coalesce(v_fulfillment ->> 'address', ''), v_ws, v_ws_to), '\s+', ' ', 'g')), '')
         else null end,
    nullif(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(coalesce(v_delivery_notes, ''), v_ws, v_ws_to), '\s+', ' ', 'g')), ''),
    nullif(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(coalesce(v_venue, ''), v_ws, v_ws_to), '\s+', ' ', 'g')), ''));
  v_on_file := pg_catalog.lower(pg_catalog.left(v_on_file, 400));
  -- The worker stored the snapshot already collapsed; collapsing again
  -- changes nothing and keeps the two sides symmetric.
  v_snapshot := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.translate(coalesce(v_p.on_file_address, ''), v_ws, v_ws_to), '\s+', ' ', 'g')), '');
  v_snapshot := pg_catalog.lower(pg_catalog.left(v_snapshot, 400));
  if v_on_file is distinct from v_snapshot then
    update public.order_address_proposals
       set status = 'superseded', decided_via = 'owner_edit', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
    return pg_catalog.jsonb_build_object(
      'applied', false, 'outcome', 'superseded',
      'message', 'The invoice address changed after this email arrived. Open the Calendar.',
      'row', pg_catalog.to_jsonb(v_p));
  end if;

  if v_decision = 'accept' then
    -- QuickBooks needs a ZIP to tax the address; Jarvis would refuse the
    -- write, so the phone never queues it. The row is left untouched for
    -- the owner to finish in the Jarvis chat and then Dismiss.
    if v_p.proposed_address ->> 'postal_code' is null then
      return pg_catalog.jsonb_build_object(
        'applied', false, 'outcome', 'refused',
        'message', 'No ZIP on this address. Put it on the invoice in the Jarvis chat, then Dismiss.',
        'row', pg_catalog.to_jsonb(v_p));
    end if;
    -- Queue it for Jarvis. NOTHING is written to orders, delivery_request
    -- or QuickBooks here.
    update public.order_address_proposals
       set status = 'accepted', apply_status = 'queued', apply_after = v_now,
           decided_via = 'app', decided_at = v_now, decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
  else
    update public.order_address_proposals
       set status = 'kept', decided_via = 'app', decided_at = v_now,
           decided_by = v_uid, updated_at = v_now
     where intake_id = p_intake_id
     returning * into v_p;
  end if;

  -- The email is answered either way; the Telegram queue stops nagging.
  -- Status-guarded: a row the time decision or the replay already
  -- dismissed is left alone.
  update public.intake_messages
     set status = 'dismissed',
         reviewed_at = v_now,
         error_detail = 'address proposal ' || v_p.status || ' by the owner in HC Field'
   where id = p_intake_id
     and status = 'pending_review';

  return pg_catalog.jsonb_build_object(
    'applied', true, 'outcome', v_p.status, 'row', pg_catalog.to_jsonb(v_p));
end
$function$;

-- Supabase default privileges hand execute on a new function to anon,
-- authenticated AND service_role. Take every default back, then grant the
-- one caller: a logged-in phone (the function checks the owner role
-- itself). The worker and Jarvis never call this.
revoke all on function public.hc_decide_proposed_address(uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hc_decide_proposed_address(uuid, bigint, text)
  to authenticated;

comment on function public.hc_decide_proposed_address(uuid, bigint, text) is
  'Owner-only Accept or Keep of a drop off address proposed by a customer email about a booked job. Accept queues the address (status accepted, apply_status queued) for Jarvis to write to the QuickBooks invoice; nothing is written to orders, delivery_request or QuickBooks here. A changed invoice, a moved delivery date, a moved on-file address, a cancelled order or a missing ZIP is reported as not applied, never raised. Keep on a row Jarvis failed to apply is the Dismiss button. Both decisions dismiss the intake row.';

comment on table public.order_address_proposals is
  'One proposed drop off address per intake email about a booked job (found by the Claudia worker in the email or its PDF), waiting for the owner''s Accept or Keep in HC Field, then applied to the QuickBooks invoice by Jarvis. Owner-readable only. Never changes an order or an invoice by itself.';

-- E. Postflight.
do $postflight$
declare
  v_check text;
begin
  -- The widened hold_reasons check (A2) is what lets the worker hold a
  -- reconfirmation draft on a waiting Address? row.
  select pg_catalog.pg_get_constraintdef(c.oid) into v_check
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.order_reconfirmations'::regclass
    and c.conname = 'order_reconfirmations_hold_reasons_check'
    and c.contype = 'c';
  if v_check is null
     or pg_catalog.strpos(v_check, 'pending_address_proposal') = 0
     or pg_catalog.strpos(v_check, 'pending_time_proposal') = 0 then
    raise exception using errcode = '55000', message = '045 postflight: order_reconfirmations.hold_reasons does not admit pending_address_proposal';
  end if;
  if pg_catalog.to_regclass('public.order_address_proposals') is null
     or not (select c.relrowsecurity from pg_catalog.pg_class as c where c.oid = 'public.order_address_proposals'::regclass) then
    raise exception using errcode = '55000', message = '045 postflight: the table or its row security is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'order_address_proposals'
      and policyname = 'order_address_proposals_owner_select'
  ) then
    raise exception using errcode = '55000', message = '045 postflight: the owner select policy is missing';
  end if;
  -- A name is not enough. The body uses "if not exists" so a re-run is
  -- harmless, which also means a table that already existed could lack the
  -- accepted/apply constraint or carry a second, wider read policy.
  if (select pg_catalog.count(*) from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'order_address_proposals') <> 1 then
    raise exception using errcode = '55000', message = '045 postflight: order_address_proposals must carry exactly one policy (the owner select)';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.order_address_proposals'::regclass
      and c.conname = 'order_address_proposals_accepted_apply_check'
      and c.contype = 'c'
  ) then
    raise exception using errcode = '55000', message = '045 postflight: the accepted/apply_status check constraint is missing';
  end if;
  if pg_catalog.to_regclass('public.order_address_proposals_order_status_idx') is null
     or pg_catalog.to_regclass('public.order_address_proposals_apply_idx') is null then
    raise exception using errcode = '55000', message = '045 postflight: an index on order_address_proposals is missing';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.order_address_proposals', 'select')
     or not pg_catalog.has_table_privilege('authenticated', 'public.order_address_proposals', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.order_address_proposals', 'update')
     or not pg_catalog.has_table_privilege('service_role', 'public.order_address_proposals', 'insert') then
    raise exception using errcode = '55000', message = '045 postflight: table grants are wrong';
  end if;
  if pg_catalog.to_regprocedure('public.hc_decide_proposed_address(uuid, bigint, text)') is null
     or pg_catalog.has_function_privilege('anon', 'public.hc_decide_proposed_address(uuid, bigint, text)', 'execute')
     or pg_catalog.has_function_privilege('public', 'public.hc_decide_proposed_address(uuid, bigint, text)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'public.hc_decide_proposed_address(uuid, bigint, text)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.hc_decide_proposed_address(uuid, bigint, text)', 'execute') then
    raise exception using errcode = '55000', message = '045 postflight: hc_decide_proposed_address grants are wrong';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.intake_messages'::regclass
      and a.attname = 'replayed_at'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
  ) or not exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = 'public.intake_messages'::regclass
      and a.attname = 'address_scanned_at'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
  ) then
    raise exception using errcode = '55000', message = '045 postflight: intake_messages.replayed_at or address_scanned_at is missing';
  end if;
end
$postflight$;

commit;
