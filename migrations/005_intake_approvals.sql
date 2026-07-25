-- ════════════════════════════════════════════════════════════════
-- 005_intake_approvals.sql - approve-by-button flow for intake emails
--
-- SAFE TO RUN ON PRODUCTION: swaps one status rule, adds one column,
-- and stamps a timestamp on rows that were already handled. Nothing
-- is dropped except the old rule (which is immediately re-added with
-- one more allowed value). Running twice is harmless.
--
-- What this is: the dashboard bot (Claudia, the Cloudflare worker)
-- now sends Sidd a plain-English card for each inbound order email,
-- with "Invoice it" / "Skip" buttons. Tapping "Invoice it" moves the
-- row to a NEW status, 'approved'. Jarvis (the invoice bot on the
-- droplet) drafts invoices ONLY for approved rows. This migration
-- teaches the table about that new status and adds the handshake
-- column the two bots use to stay out of each other's way.
-- ════════════════════════════════════════════════════════════════

-- Status meanings after this migration:
--   pending_review  awaiting Sidd (card sent or about to be)
--   approved        Sidd tapped "Invoice it"; Jarvis will draft it   (NEW)
--   drafting        Jarvis invoice conversation in progress
--   invoiced        QBO invoice created; external_invoice_id set
--   dismissed       Sidd tapped "Skip" (or sent "skip N" to Jarvis)
--   ignored         not an order, or a reply on a thread already handled
--   error           pipeline failure, error_detail says what

-- 1) Allow the new 'approved' status. A CHECK constraint is the list
--    of values the database will accept for a column. Postgres cannot
--    edit one in place, so we drop the old list and add the new one
--    with 'approved' included. No data changes here.
alter table public.intake_messages
  drop constraint if exists intake_messages_status_check;
alter table public.intake_messages
  add constraint intake_messages_status_check
  check (status in ('pending_review','approved','drafting','invoiced','dismissed','ignored','error'));

-- 2) New column: when Jarvis's classifier finished looking at the row.
--    (timestamptz = a date-and-time that remembers its timezone.)
--    The dashboard bot only sends a card once this is filled in, so a
--    card can never go out for an email Jarvis has not classified yet.
alter table public.intake_messages
  add column if not exists classified_at timestamptz;

-- 3) Backfill: stamp every row the OLD pipeline already processed, so
--    the new every-5-minutes card scan does not re-triage weeks of
--    history and flood the Telegram chat with stale cards. Any row
--    that is not a 'maybe_order', or that already had a Telegram card
--    sent, was clearly already handled. The "classified_at is null"
--    guard makes rerunning this statement a no-op.
update public.intake_messages
  set classified_at = now()
  where classified_at is null
    and (classification <> 'maybe_order' or telegram_message_id is not null);
