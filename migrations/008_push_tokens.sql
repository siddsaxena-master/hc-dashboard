-- ════════════════════════════════════════════════════════════════
-- 008_push_tokens.sql - APNs device tokens for owner push alerts
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table and two policies.
-- Nothing is dropped or altered. Running twice is harmless (the
-- drop-then-create on each policy is what makes it re-runnable;
-- CREATE POLICY has no IF NOT EXISTS).
--
-- What this is: the HC Field iPhone app registers its raw APNs device
-- token here right after login (one row per email, upserted via
-- PostgREST with Prefer: resolution=merge-duplicates). The Cloudflare
-- worker reads this table with the SERVICE ROLE key and sends native
-- lock-screen banners to owner phones on clock-in / clock-out.
--
-- SECURITY, ON PURPOSE: row level security is turned ON below and the
-- public "anon" key (the one that ships inside the field app's App.js
-- and the dashboard's index.html) gets INSERT and UPDATE only, so the
-- app can upsert its OWN token. There is deliberately NO SELECT policy:
-- a device token is the address of someone's lock screen, and the anon
-- key must never be able to enumerate them. Only service-role keys
-- (the Cloudflare worker, Jarvis) can read rows, because those bypass
-- row level security. Do not add an anon SELECT policy here. The app
-- must upsert with Prefer: return=minimal - asking for the row back
-- would need SELECT and would 401.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.push_tokens (
  email text primary key,
  apns_token text not null,
  platform text not null default 'ios',
  updated_at timestamptz not null default now()
);

alter table public.push_tokens enable row level security;

drop policy if exists push_tokens_anon_insert on public.push_tokens;
create policy push_tokens_anon_insert on public.push_tokens
  for insert to anon with check (true);

drop policy if exists push_tokens_anon_update on public.push_tokens;
create policy push_tokens_anon_update on public.push_tokens
  for update to anon using (true) with check (true);
