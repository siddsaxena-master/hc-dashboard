-- ════════════════════════════════════════════════════════════════
-- 007_clockin_alerts.sql - clock-in Telegram alert claim column
--
-- SAFE TO RUN ON PRODUCTION: only ADDS a column. Nothing is dropped
-- or altered. Running twice is harmless (if not exists).
-- ════════════════════════════════════════════════════════════════

-- Set once per shift by the Claudia worker when it sends the owner's
-- "clocked in" Telegram ping. It doubles as the claim that stops
-- double-sends: the worker only proceeds if its guarded PATCH
-- (clockin_notified_at is still null) returns the row.
-- Exactly the same pattern as shifts.summary_sent_at (migration 006).
alter table public.shifts
  add column if not exists clockin_notified_at timestamptz;

-- Access: nothing to change, on purpose. Only the Claudia worker
-- (service-role key) writes this column; the app never touches it.
