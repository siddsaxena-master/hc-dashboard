-- ════════════════════════════════════════════════════════════════
-- 014_shift_orders.sql - which orders each shift actually worked
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table, indexes, and
-- policies. Nothing dropped or altered. Running twice is harmless
-- (create-if-not-exists everywhere; policies use drop-then-create).
--
-- WHY (Sidd 2026-08-17): at clock-out the HC Field app shows the
-- worker a checklist of today's ship orders + tomorrow's prep orders
-- (the same lists My Day shows) and writes one row here per checked
-- order. This is the ground truth for per-worker pace. Phase A is
-- capture-only: nothing that exists today reads this table for math.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.shift_orders (
  id            uuid primary key default gen_random_uuid(),
  shift_id      uuid not null references public.shifts(id) on delete cascade,
  -- SET NULL, not CASCADE: the dashboard's merge-duplicates flow can
  -- delete an order row. The work still happened; the snapshot columns
  -- below keep the record readable forever.
  order_id      uuid references public.orders(id) on delete set null,
  -- 'delivery' = the shift's ship-day list (day D),
  -- 'prep'     = the shift's prep-day list (day D+1).
  -- Mirrors the prep-day rule: a shift on day D works ship(D)+prep(D+1).
  work_type     text not null check (work_type in ('delivery','prep')),
  -- SNAPSHOTS at link time, on purpose: orders.coconuts_qty and
  -- client_name can change later (dashboard edits, Jarvis re-sync,
  -- merge-duplicates). Metrics must reflect what the worker actually
  -- handled that night.
  coconuts_qty  int,
  client_name   text,
  worker_email  text,
  marked_at     timestamptz not null default now()
);

-- One row per (shift, order, work_type). The app treats a 409 as
-- success (double-tap / retry safety).
create unique index if not exists shift_orders_unique_idx
  on public.shift_orders (shift_id, order_id, work_type);

create index if not exists shift_orders_shift_idx
  on public.shift_orders (shift_id);
create index if not exists shift_orders_order_idx
  on public.shift_orders (order_id);

alter table public.shift_orders enable row level security;

-- Same posture as shift_edits (012): append-only for the anon key.
-- No UPDATE/DELETE: even a bug cannot rewrite attribution history.
-- Client names and box counts already reach team phones via the
-- orders anon SELECT, so anon SELECT here leaks nothing new.
drop policy if exists shift_orders_anon_insert on public.shift_orders;
create policy shift_orders_anon_insert on public.shift_orders
  for insert to anon with check (true);

drop policy if exists shift_orders_anon_select on public.shift_orders;
create policy shift_orders_anon_select on public.shift_orders
  for select to anon using (true);
