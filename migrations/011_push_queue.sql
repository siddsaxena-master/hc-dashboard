-- ════════════════════════════════════════════════════════════════
-- 011_push_queue.sql - outbound push queue, drained by the droplet
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a table and one index.
-- Nothing is dropped or altered. Running twice is harmless.
--
-- What this is: Cloudflare Workers cannot deliver Apple push
-- notifications (their fetch speaks HTTP/1.1 and Apple's
-- api.push.apple.com requires HTTP/2; every send 500s), while
-- curl --http2 from our DigitalOcean droplet works. So the Claudia
-- worker no longer talks to Apple at all: it INSERTs one row here per
-- notification, and an always-on program on the droplet ("pushdrain",
-- hc-dashboard/droplet/pushdrain.py, a systemd service like the
-- outlook poller) reads this queue every ~20 seconds and does the real
-- send. If a push cannot be delivered, pushdrain sends the row's
-- telegram_text to fallback_chat_ids instead, so an owner alert is
-- never silently lost. Pushes are perishable: a row still undelivered
-- 15 minutes after creation is fallen back (if it has telegram_text)
-- and closed. pushdrain also purges done rows older than 7 days.
--
-- Row lifecycle:
--   claimed_at null, done_at null   waiting for pushdrain
--   claimed_at set,  done_at null   pushdrain is working on it (a claim
--                                   older than ~3 min means it died
--                                   mid-row; it re-claims those itself)
--   done_at set                     finished: delivered, fell back to
--                                   Telegram, or expired (last_error
--                                   says which when it was not a clean
--                                   delivery)
--   attempts / last_error           retry counter (max 5) and the most
--                                   recent failure text, for debugging
--
-- kind values:
--   alert      lock-screen banner to owner phones (push_tokens table)
--   la_start   Live Activity card start   (live_activity_tokens)
--   la_update  Live Activity card update  (live_activity_tokens)
--   la_end     Live Activity card end     (live_activity_tokens)
--
-- payload shape (written by worker.js, read by pushdrain.py):
--   {
--     "tokens": ["<hex apns device token>", ...],
--     "headers": {"topic": "...", "push_type": "alert|liveactivity",
--                 "priority": 10},
--     "aps": { ...the full aps dictionary Apple should receive... },
--     "telegram_text": "fallback text" or null (null = no fallback),
--     "fallback_chat_ids": ["123456789", ...]
--   }
--
-- SECURITY, ON PURPOSE (same posture as intake_messages, 004): row
-- level security is turned ON below and there are ZERO policies. That
-- is deliberate, not a mistake. Device push tokens are the addresses
-- of Sidd's lock screen and payloads carry worker names and pay
-- figures; the public "anon" key that ships inside the dashboard's
-- index.html and the field app's App.js must get NOTHING from this
-- table. Only service-role keys (the Claudia worker enqueues,
-- pushdrain on the droplet drains) can touch it, because those bypass
-- row level security. Do not add anon policies here.
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;  -- gen_random_uuid, already on in Supabase

create table if not exists public.push_queue (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('alert','la_start','la_update','la_end')),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  done_at     timestamptz,
  attempts    int not null default 0,
  last_error  text
);

alter table public.push_queue enable row level security;

-- pushdrain's every-20s poll filters on done_at + orders by created_at.
create index if not exists push_queue_pending_idx
  on public.push_queue (created_at) where done_at is null;
