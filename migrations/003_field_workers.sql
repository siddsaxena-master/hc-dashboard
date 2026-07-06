-- ════════════════════════════════════════════════════════════════
-- 003_field_workers.sql — email allowlist + roles for the HC Field app
-- SAFE ON PRODUCTION: additive only; re-runnable.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.field_workers (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text not null,
  market     text not null default 'ny',      -- ny | miami
  role       text not null default 'team',    -- owner | team
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.field_workers enable row level security;

drop policy if exists "anon read field_workers" on public.field_workers;
create policy "anon read field_workers" on public.field_workers
  for select to anon using (true);

-- Seed the owner (idempotent).
insert into public.field_workers (email, name, market, role)
values ('siddsaxena@gmail.com', 'Sidd', 'ny', 'owner')
on conflict (email) do update set role = 'owner', active = true;
