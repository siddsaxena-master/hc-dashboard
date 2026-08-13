-- ════════════════════════════════════════════════════════════════
-- 013_invoice_pdf_url.sql - one-tap invoice PDFs for the field app
--
-- SAFE TO RUN ON PRODUCTION: only ADDS one nullable column. Nothing
-- is dropped or altered. Running twice is harmless.
--
-- WHY (Sidd 2026-08-13): tapping a calendar order should open the
-- invoice PDF itself, not Intuit's share page with a second click.
-- Jarvis fetches each invoice's PDF from QuickBooks and uploads it to
-- Supabase Storage (bucket "invoices", unguessable file names); this
-- column holds that file's public URL. The app prefers it over
-- external_invoice_url (the Intuit share page), which stays as the
-- fallback. Jarvis re-uploads to the SAME path on every invoice edit,
-- so stored URLs never go stale.
-- ════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists invoice_pdf_url text;
