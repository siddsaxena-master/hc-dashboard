-- ════════════════════════════════════════════════════════════════
-- 012_edit_trail_paid_snapshot.sql - who changed shift times, and
-- what was actually paid
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table and two columns.
-- Nothing is dropped or altered. Running twice is harmless
-- (create-if-not-exists everywhere; policies use drop-then-create).
--
-- WHY: payroll best practice, requested by Sidd 2026-08-06.
-- 1. shift_edits is an append-only log: every clock-time edit made in
--    the app writes one row (who edited, when, old times, new times).
--    Rows are never updated or deleted - the anon key gets INSERT and
--    SELECT only, so even a bug cannot rewrite history.
-- 2. shifts.paid_cents / paid_minutes freeze the amount at the moment
--    the owner taps "Mark paid". Pay was previously recomputed live,
--    so a time edit AFTER payday silently changed the record of what
--    was paid. Now the app shows a visible discrepancy instead.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.shift_edits (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null,
  editor_email text not null,
  edited_at    timestamptz not null default now(),
  old_clock_in  timestamptz,
  old_clock_out timestamptz,
  new_clock_in  timestamptz,
  new_clock_out timestamptz,
  note         text
);

create index if not exists shift_edits_shift_idx
  on public.shift_edits (shift_id, edited_at desc);

alter table public.shift_edits enable row level security;

drop policy if exists shift_edits_anon_insert on public.shift_edits;
create policy shift_edits_anon_insert on public.shift_edits
  for insert to anon with check (true);

drop policy if exists shift_edits_anon_select on public.shift_edits;
create policy shift_edits_anon_select on public.shift_edits
  for select to anon using (true);

-- No UPDATE or DELETE policies, on purpose: the log is append-only for
-- everyone except service-role keys.

-- Frozen at "Mark paid" time by the app. Null = paid before this
-- feature existed (or not yet paid); the app falls back to live math.
alter table public.shifts
  add column if not exists paid_cents int;
alter table public.shifts
  add column if not exists paid_minutes int;
