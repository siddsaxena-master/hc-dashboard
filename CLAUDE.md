# CLAUDE.md — HC Dashboard (maintainer playbook)

> This dashboard is FINISHED and LIVE (redesigned 2026-07-06 by Claude
> Fable 5). Future sessions on any model MAINTAIN it. Do not redesign,
> do not add frameworks — it is a single-file PWA on purpose.

## What this is

- `index.html` — the ENTIRE dashboard (styles, markup, JS in one file,
  ~3,700 lines). Live at https://siddsaxena-master.github.io/hc-dashboard/
- `worker/worker.js` — Cloudflare Worker "Claudia": AI proxy (Claude API
  key lives in Cloudflare, never in the browser) + the 8am Telegram
  "Daily Game Plan" digest (includes ORDER TODAY coconut reminders,
  2-day rule).
- `migrations/*.sql` — numbered Supabase migrations. Never edit an old
  one; add the next number.
- `sw.js` — the offline cache. **Any index.html change needs the CACHE
  version in sw.js bumped (v3 -> v4 -> ...) or phones keep the old page.**

## How to deploy (both need Sidd's "yes do it")

- Dashboard page: commit on a branch, merge to main, `git push` — GitHub
  Pages serves main automatically in about a minute.
- Worker: `cd worker; npx wrangler deploy` (wrangler is already
  authenticated to Sidd's Cloudflare account, ss6929@columbia.edu).
- Migrations: paste the SQL into the Supabase SQL editor in Sidd's
  Chrome (login is GitHub SSO). Verify afterwards with a REST call:
  `GET https://omdcfphbwuwsrffdszlg.supabase.co/rest/v1/<table>?limit=1`
  with the anon key from index.html — expect HTTP 200.

## Data flow (who writes what)

- Jarvis (hc-invoice-bot on the droplet) syncs QuickBooks invoices into
  the Supabase `orders` table (create/update/void).
- This dashboard reads/writes `orders` (jbPull/jbPush, merge-duplicates)
  and writes `delivery_signatures`.
- The HC Field iPhone app (hc-field-app/) reads `orders` and
  `field_workers`, writes `shifts` and `shift_locations`.
- The iPhone app's owner Home tab must AGREE with renderStats /
  renderTodos / renderOps here. If you change business math in one,
  change the other (see hc-field-app/CLAUDE.md "Business math parity").

## Hard-won rules

- Stage mapping between the UI and Supabase lives in SB_STAGE_TO_UI /
  UI_STAGE_TO_SB (~line 2285). UI 'passed' = Supabase 'cancelled'.
- "Pending payment" excludes completed AND passed (cancelled) — a
  cancelled order's unpaid balance is never coming. "Revenue collected"
  counts everything ever received, including kept deposits.
- delivery_time is dashboard-local only; it does NOT sync to Supabase
  (rows store the date with a fake T12:00:00Z; noon = "no time set").
- Owner-only elements are gated with .owner-lock / .team-view-only CSS
  classes; do not leak owner numbers into team view.
- The anon Supabase key in this file is public by design (row-level
  security limits what it can do).

## Order intake backstops (added 2026-07-19)

- `intake_messages` (migration 004) is a QUARANTINE table: every inbound
  order email (via n8n workflow wf_16 in the cold-email repo) and
  forwarded text lands there first, then Jarvis (hc-invoice-bot) turns
  it into an invoice when Sidd replies `invoice <id>` in the Jarvis
  Telegram chat.
- RLS is ON with ZERO policies ON PURPOSE. Raw customer messages are
  sensitive; the public anon key in index.html must get nothing. The
  dashboard page and the HC Field app never read this table. Do not
  add anon policies to it. Only service-role keys (this worker, Jarvis)
  and the n8n postgres role can reach it.
- The worker is the backstop, in a separate failure domain from n8n:
  - The 8am digest appends "Intake: N awaiting review (oldest Xh)" when
    anything is pending, plus a dead-man warning when no email intake
    has been seen in 24h (means wf_16 / the Gmail trigger is down).
  - The hourly cron sends one-shot plain-text nags when a pending row
    crosses 4h of age, and again at 24h (stateless: each run only
    alerts rows that crossed the threshold within the last hour).
- Deploying this change = worker only (`cd worker; npx wrangler deploy`
  with Sidd's "yes do it"). index.html is untouched, so NO sw.js cache
  bump is needed.
- Other halves of the feature: wf_16 + runbook docs/13_order_intake.md
  in the cold-email repo; the `invoice / show / skip` commands in
  hc-invoice-bot.

## Current uncommitted state (as of 2026-07-07)

index.html has the one-line pending-payment fix described above staged
locally, awaiting Sidd's "yes do it" to push + deploy (remember the
sw.js cache bump when it goes).
