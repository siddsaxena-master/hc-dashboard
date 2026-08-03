-- ════════════════════════════════════════════════════════════════
-- 010_live_activity_tokens.sql - Live Activity push tokens for the
-- owner lock-screen shift card
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table, two partial unique
-- indexes, and two policies. Nothing is dropped or altered. Running
-- twice is harmless (create-if-not-exists everywhere, plus the
-- drop-then-create on each policy; CREATE POLICY has no IF NOT
-- EXISTS).
--
-- What this is: the HC Field iPhone app (owner phones, iOS 17.2+)
-- writes ActivityKit push tokens here. Two kinds per owner email:
--   push_to_start   (shift_id null): lets the Cloudflare worker START
--                                    the lock-screen card on clock-in
--   activity_update (shift_id set):  lets the worker update/end THAT
--                                    shift's card
--
-- SECURITY, ON PURPOSE (posture copied from push_tokens, 008): row
-- level security is ON and the public "anon" key (the one that ships
-- inside the field app's App.js and the dashboard's index.html) gets
-- INSERT and UPDATE only. There is deliberately NO SELECT policy: a
-- push token is the address of someone's lock screen, and the anon
-- key must never be able to enumerate them. There is also NO anon
-- DELETE policy: cleanup is the worker's job (service role bypasses
-- RLS): after an event:end it deletes that shift's activity_update
-- rows, and any send that comes back 410 / BadDeviceToken /
-- Unregistered deletes that token row.
--
-- INSERT-THEN-PATCH RULE: because anon has no SELECT, the app MUST
-- write with a plain INSERT (Prefer: return=minimal) and, on a 409
-- from one of the partial unique indexes below, a plain PATCH by the
-- same key columns (also return=minimal). A merge-duplicates upsert
-- can NEVER work here: ON CONFLICT DO UPDATE needs to see the
-- existing row, and PostgREST's on_conflict parameter cannot target
-- PARTIAL unique indexes at all, so 409-then-PATCH is the only
-- correct write path. Never ask the row back.
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;  -- gen_random_uuid, already on in Supabase

create table if not exists public.live_activity_tokens (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  token_type  text not null check (token_type in ('push_to_start', 'activity_update')),
  shift_id    uuid,           -- null for push_to_start rows, shifts.id for activity_update rows
  token       text not null,  -- hex APNs token from ActivityKit
  updated_at  timestamptz not null default now()
);

-- These two partial unique indexes are what make insert-then-patch
-- work: a duplicate INSERT hits one of them and PostgREST returns
-- 409, which the app answers with a PATCH by the same key columns.

-- one push_to_start row per owner email (one device per email, same
-- limitation as push_tokens' email primary key)
create unique index if not exists live_activity_tokens_p2s_uniq
  on public.live_activity_tokens (email, token_type)
  where shift_id is null;

-- one activity_update row per owner email per shift
create unique index if not exists live_activity_tokens_upd_uniq
  on public.live_activity_tokens (email, token_type, shift_id)
  where shift_id is not null;

alter table public.live_activity_tokens enable row level security;

drop policy if exists live_activity_tokens_anon_insert on public.live_activity_tokens;
create policy live_activity_tokens_anon_insert on public.live_activity_tokens
  for insert to anon with check (true);

drop policy if exists live_activity_tokens_anon_update on public.live_activity_tokens;
create policy live_activity_tokens_anon_update on public.live_activity_tokens
  for update to anon using (true) with check (true);
