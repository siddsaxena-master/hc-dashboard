-- ════════════════════════════════════════════════════════════════
-- 001_delivery_signatures.sql
-- Adds delivery-signature capture to the Hamptons Coconuts dashboard.
--
-- SAFE TO RUN ON PRODUCTION: this script only ADDS a table, columns,
-- an index, and access policies. It never drops, deletes, or alters
-- any existing data. Running it twice is harmless (everything uses
-- "if not exists" / "drop policy if exists").
-- ════════════════════════════════════════════════════════════════

-- 1) Record WHEN a delivery was signed and WHO signed it, right on the order.
--    These are lightweight so they come down with the normal orders list.
alter table public.orders
  add column if not exists delivery_signed_at timestamptz,
  add column if not exists delivery_signed_by text;

-- 2) Store the actual signature drawing in its own table, so the main
--    orders list stays fast and small. One order can have one signature
--    (or more, if re-signed); we keep them all.
create table if not exists public.delivery_signatures (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid references public.orders(id) on delete cascade,
  signed_by          text,                       -- name of the person who signed
  signed_at          timestamptz not null default now(),
  signature_data_url text not null,              -- the signature image (PNG data URL)
  signed_via         text,                       -- which device/user captured it
  created_at         timestamptz not null default now()
);

create index if not exists delivery_signatures_order_id_idx
  on public.delivery_signatures (order_id);

-- 3) Access rules. The dashboard talks to Supabase from the browser using
--    the public "anon" key (this is the same way it already reads and writes
--    the orders table). We mirror that here: the app can add a signature and
--    read signatures back. Tighten later if you move to logged-in DB users.
alter table public.delivery_signatures enable row level security;

drop policy if exists "anon insert delivery_signatures" on public.delivery_signatures;
create policy "anon insert delivery_signatures"
  on public.delivery_signatures
  for insert
  to anon
  with check (true);

drop policy if exists "anon read delivery_signatures" on public.delivery_signatures;
create policy "anon read delivery_signatures"
  on public.delivery_signatures
  for select
  to anon
  using (true);
