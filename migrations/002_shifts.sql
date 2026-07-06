-- ════════════════════════════════════════════════════════════════
-- 002_shifts.sql — field team clock in/out + GPS route trails
--
-- SAFE TO RUN ON PRODUCTION: only ADDS tables, indexes, policies.
-- Nothing is dropped or altered. Running twice is harmless.
-- ════════════════════════════════════════════════════════════════

-- One row per work shift (clock in -> clock out).
create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  worker_name   text not null,           -- who (from the app's login)
  worker_email  text,
  market        text,                    -- ny | miami
  clock_in_at   timestamptz not null default now(),
  clock_in_lat  double precision,
  clock_in_lng  double precision,
  clock_out_at  timestamptz,
  clock_out_lat double precision,
  clock_out_lng double precision,
  device        text,                    -- phone model, app version
  created_at    timestamptz not null default now()
);

-- GPS breadcrumbs recorded while clocked in (one row ~ every 1-2 min).
create table if not exists public.shift_locations (
  id         bigint generated always as identity primary key,
  shift_id   uuid references public.shifts(id) on delete cascade,
  at         timestamptz not null default now(),
  lat        double precision not null,
  lng        double precision not null,
  accuracy_m double precision,           -- GPS accuracy in meters
  speed_mps  double precision            -- speed if the phone reports it
);

create index if not exists shift_locations_shift_idx
  on public.shift_locations (shift_id, at);
create index if not exists shifts_clock_in_idx
  on public.shifts (clock_in_at desc);

-- Access: same model as delivery_signatures — the apps use the anon key.
alter table public.shifts enable row level security;
alter table public.shift_locations enable row level security;

drop policy if exists "anon insert shifts" on public.shifts;
create policy "anon insert shifts" on public.shifts
  for insert to anon with check (true);
drop policy if exists "anon read shifts" on public.shifts;
create policy "anon read shifts" on public.shifts
  for select to anon using (true);
drop policy if exists "anon update shifts" on public.shifts;
create policy "anon update shifts" on public.shifts
  for update to anon using (true);

drop policy if exists "anon insert shift_locations" on public.shift_locations;
create policy "anon insert shift_locations" on public.shift_locations
  for insert to anon with check (true);
drop policy if exists "anon read shift_locations" on public.shift_locations;
create policy "anon read shift_locations" on public.shift_locations
  for select to anon using (true);
