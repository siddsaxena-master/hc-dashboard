-- ════════════════════════════════════════════════════════════════
-- 009_app_config.sql - non-secret operational constants (key/value)
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table and one policy.
-- Nothing is dropped or altered. Running twice is harmless (the
-- drop-then-create on the policy is what makes it re-runnable;
-- CREATE POLICY has no IF NOT EXISTS).
--
-- What this is: tiny operational constants the HC Field app and the
-- Claudia worker read at runtime. First consumer: the Day P&L
-- feature reads key 'coconut_cost_cents' (value = integer cents per
-- coconut as text, e.g. '150' = $1.50 each). NO row is inserted
-- here ON PURPOSE: absence means "not set", and both surfaces then
-- show "cost not set" plus profit before coconut cost. To set or
-- change a value later, run in the SQL editor:
--   insert into public.app_config (key, value)
--   values ('coconut_cost_cents', '150')
--   on conflict (key) do update
--     set value = excluded.value, updated_at = now();
--
-- SECURITY, ON PURPOSE: row level security is ON and the public
-- anon key (the one shipped in App.js and index.html) gets SELECT
-- only, so the app can read constants but nothing can write them
-- from a phone or a browser. Writes happen only in the Supabase SQL
-- editor or with a service-role key (the Claudia worker's key also
-- reads through RLS because service role bypasses it). Never put a
-- secret in this table: anon can read every row.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

drop policy if exists app_config_anon_select on public.app_config;
create policy app_config_anon_select on public.app_config
  for select to anon using (true);
