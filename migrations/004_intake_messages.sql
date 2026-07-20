-- ════════════════════════════════════════════════════════════════
-- 004_intake_messages.sql - quarantine inbox for inbound order messages
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table and an index.
-- Nothing is dropped or altered. Running twice is harmless.
--
-- What this is: every customer email (and forwarded text) that might be
-- an order lands HERE first, before anything is classified or dropped.
-- The n8n workflow wf_16 inserts the raw message, asks Claude if it
-- looks like an order, and sends Sidd a numbered card in the Jarvis
-- Telegram chat. Sidd replies "invoice <id>" and Jarvis takes it from
-- there. Insert-before-classify means nothing is ever silently lost.
--
-- SECURITY, ON PURPOSE: row level security is turned ON below and there
-- are ZERO policies. That is deliberate, not a mistake. Raw customer
-- messages are sensitive, and the public "anon" key that ships inside
-- the dashboard's index.html and the field app's App.js must get
-- NOTHING from this table. The dashboard and the field app never read
-- it. Only the service-role key (Jarvis, the Cloudflare worker) and the
-- n8n postgres role can touch it, because those bypass row level
-- security. Do not add anon policies here.
-- ════════════════════════════════════════════════════════════════

-- Status meanings (how a message moves through the pipeline):
--   pending_review  awaiting Sidd (card sent or about to be)
--   drafting        Sidd sent "invoice N", Jarvis conversation in progress
--   invoiced        QBO invoice created; external_invoice_id set
--   dismissed       Sidd sent "skip N"
--   ignored         classifier said not_order (kept for audit, no card sent)
--   error           pipeline failure, error_detail says what

create table if not exists public.intake_messages (
  id bigint generated always as identity primary key,
  channel text not null default 'email' check (channel in ('email','sms_forward')),
  source_msg_id text unique,
  from_addr text,
  subject text,
  raw_text text not null,
  classification text not null default 'maybe_order'
    check (classification in ('order','maybe_order','not_order')),
  status text not null default 'pending_review'
    check (status in ('pending_review','drafting','invoiced','dismissed','ignored','error')),
  external_invoice_id text,
  order_id uuid references public.orders(id) on delete set null,
  telegram_message_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.intake_messages enable row level security;
create index if not exists intake_messages_status_idx on public.intake_messages (status, created_at);
