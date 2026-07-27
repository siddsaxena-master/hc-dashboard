-- ════════════════════════════════════════════════════════════════
-- 006_payroll_and_shift_summaries.sql — payroll columns for shift
-- summaries + pay card
--
-- SAFE TO RUN ON PRODUCTION: only ADDS columns. Nothing is dropped
-- or altered. Running twice is harmless (if not exists everywhere).
-- ════════════════════════════════════════════════════════════════

-- Set once per shift by the Claudia worker when it sends the owner's
-- Telegram shift summary. It is also the claim that stops double-sends:
-- the worker only proceeds if its guarded PATCH (summary_sent_at is
-- still null) returns the row.
alter table public.shifts
  add column if not exists summary_sent_at timestamptz;

-- Stamped by the owner's "Mark paid" button in the HC Field app.
alter table public.shifts
  add column if not exists paid_at timestamptz;

-- Pay rate in cents per hour (e.g. 2200 = $22.00/hr). Null = not set;
-- payroll reports the hours but never dollars until it is set.
alter table public.field_workers
  add column if not exists hourly_rate_cents integer;

-- Access: NOTHING to change, on purpose.
-- shifts already has a TABLE-WIDE anon update policy ("anon update
-- shifts", migration 002) riding Supabase's default schema grants, so
-- the app's anon key can already write paid_at and clock_out_at.
-- (Recon confirmed: no column-scoped GRANTs exist in 001-005.)
-- field_workers stays READ-ONLY for anon: no insert/update/delete
-- policy is added here, so hourly rates can only be edited with a
-- service-role key or in the Supabase dashboard, never from the app.
