-- SANDBOX ONLY. Never run this file against production.
--
-- The numbered migrations begin after the original orders table already
-- existed. This fixture recreates that pre-migration table so migrations
-- 001 through 013, then 015 through 018, can be tested on a fresh Supabase
-- project without copying any production customer data.
--
-- Intentionally omitted from this field-ops fixture:
--   * the orders.lead_id foreign key, because the sales leads schema is not
--     required by any HC Field migration;
--   * authenticated dashboard policies that depend on older dashboard helper
--     functions and event assignment tables outside this migration series.

begin;

create extension if not exists pgcrypto;

create table if not exists public.orders (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  client_name            text not null,
  client_email           text,
  client_phone           text,
  company                text,
  event_start_at         timestamptz,
  event_end_at           timestamptz,
  event_tz               text default 'America/New_York',
  event_type             text check (
    event_type in (
      'wedding', 'corporate', 'trade_show', 'hospitality',
      'cruise', 'wellness', 'other'
    )
  ),
  venue                  text,
  venue_type             text,
  headcount              integer check (headcount >= 0),
  coconuts_qty           integer,
  crack_type             text check (crack_type in ('straw', 'circle', 'whole')),
  stamp_design           text,
  stamp_status           text not null default 'not_ordered' check (
    stamp_status in ('not_ordered', 'ordered', 'received', 'not_needed')
  ),
  logo_received          boolean not null default false,
  logo_url               text,
  pre_tax_cents          bigint check (pre_tax_cents >= 0),
  tax_cents              bigint check (tax_cents >= 0),
  total_cents            bigint check (total_cents >= 0),
  deposit_cents          bigint not null default 0 check (deposit_cents >= 0),
  balance_cents          bigint,
  pay_notes              text,
  invoice_provider       text default 'quickbooks' check (
    invoice_provider in ('quickbooks', 'stripe', 'manual')
  ),
  external_invoice_id    text,
  external_invoice_url   text,
  stage                  text not null default 'inquiry' check (
    stage in (
      'inquiry', 'quoted', 'invoiced', 'deposit_paid', 'paid_full',
      'fulfilled', 'complete', 'cancelled'
    )
  ),
  source                 text check (
    source in ('website', 'referral', 'sales_engine', 'direct', 'recurring', 'other')
  ),
  referral_from_order_id uuid references public.orders(id) on delete set null,
  lead_id                uuid,
  delivery_at_utc        timestamptz,
  delivery_notes         text,
  coi_required           boolean not null default false,
  coi_submitted          boolean not null default false,
  coi_url                text,
  is_recurring           boolean not null default false,
  frequency              text check (
    frequency in ('weekly', 'biweekly', 'monthly', 'quarterly')
  ),
  next_order_date        date,
  parent_order_id        uuid references public.orders(id) on delete set null,
  market                 text default 'ny',
  notes                  text,
  cancelled_at           timestamptz,
  cancelled_reason       text,
  original_event_date    timestamptz
);

create index if not exists orders_stage_idx
  on public.orders (stage);
create index if not exists orders_event_start_idx
  on public.orders (event_start_at);
create index if not exists orders_created_at_idx
  on public.orders (created_at desc);
create index if not exists orders_client_email_idx
  on public.orders (client_email);
create index if not exists orders_recurring_idx
  on public.orders (next_order_date)
  where is_recurring;
create index if not exists orders_lead_id_idx
  on public.orders (lead_id);
create unique index if not exists orders_external_invoice_id_uidx
  on public.orders (external_invoice_id)
  where external_invoice_id is not null;

alter table public.orders enable row level security;

drop policy if exists anon_read_orders on public.orders;
create policy anon_read_orders on public.orders
  for select to anon using (true);

drop policy if exists orders_anon_select on public.orders;
create policy orders_anon_select on public.orders
  for select to anon using (true);

drop policy if exists orders_anon_insert on public.orders;
create policy orders_anon_insert on public.orders
  for insert to anon with check (true);

drop policy if exists orders_anon_update on public.orders;
create policy orders_anon_update on public.orders
  for update to anon using (true) with check (true);

drop policy if exists orders_anon_delete on public.orders;
create policy orders_anon_delete on public.orders
  for delete to anon using (true);

grant select, insert, update, delete on table public.orders to anon;
grant all on table public.orders to service_role;

commit;
