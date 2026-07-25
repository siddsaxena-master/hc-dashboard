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

## Order intake: Claudia's half (approval-first redesign, 2026-07-24)

- `intake_messages` (migrations 004 + 005) is a QUARANTINE table: every
  inbound order email lands there first via Jarvis's outlook_poller
  (Microsoft 365 mailbox — the wf_16/Gmail plan is DEAD, see
  hc-invoice-bot CLAUDE.md). Jarvis classifies each row every 2 minutes
  and stamps `classified_at`; THIS worker is now the card sender:
  every 5 minutes (`runIntakeCardScan`, cron `*/5 * * * *`) it sends
  Sidd a one-sentence natural-language card (Haiku summary,
  injection-fenced, plain text, fail-open to the subject line) with
  inline buttons: Invoice it / Skip / Full email. Button taps arrive
  as callback_query updates on the bot's EXISTING root webhook
  (`handleIntakeCallback`): Invoice it -> status 'approved' (Jarvis
  drafts ONLY approved rows, through its normal confirm gates), Skip
  -> 'dismissed', Full email -> chunked raw text. Guarded PATCHes
  everywhere; a decided card loses its buttons.
- Thread matching lives HERE (not in Jarvis) and it NEVER suppresses a
  card. A row whose normalized subject (Re:/Fw: stacks stripped, 14-day
  window) matches an invoiced/approved/drafting/final sibling still
  gets its card, with one extra line naming the sibling ("I did not
  start a draft for it"), and the row stays pending_review. A sibling
  that was merely carded and is still undecided does NOT count as
  handled — the follow-up email is usually the one carrying the real
  order details. Rows from @hamptonscoconuts.com skip thread matching
  entirely: those are the website's GoDaddy form notifications (same
  subject, each a DIFFERENT lead; never suppress them).
- A card also warns when the row carries an `external_invoice_id` while
  back in pending_review: that means Jarvis created an invoice from this
  email and then voided it at the PDF gate ("Heads up: invoice #N was
  created from this email earlier and then voided"). Approving again is
  allowed on purpose — under approval-first, Sidd's tap IS the
  authorization.
- Run the suppression tests before touching that logic:
  `node worker/test-intake-suppression.mjs` (no framework, no network,
  exits non-zero on failure). `normalizeSubject` and
  `findHandledThreadSibling` are named exports for exactly this.
- Telegram allows ONE webhook per bot. Buttons and chat messages share
  the root entry point ON PURPOSE; never re-point the webhook to a new
  path or pass `allowed_updates` to setWebhook (omitting it preserves
  the previous setting; filtering would silently kill Claudia's chat).
  Optional hardening: `wrangler secret put TG_WEBHOOK_SECRET` then curl
  `/setup-telegram-webhook?secret=...` — the root handler requires
  Telegram's secret header only when the secret is configured.
- RLS is ON with ZERO policies ON PURPOSE. Raw customer messages are
  sensitive; the public anon key in index.html must get nothing. The
  dashboard page and the HC Field app never read this table. Do not
  add anon policies to it. Only service-role keys (this worker, Jarvis)
  and the n8n postgres role can reach it.
- The worker is the backstop, in a separate failure domain from n8n.
  Both in-flight statuses are watched — pending_review is waiting on
  Sidd, `approved` is waiting on Jarvis — because a tapped row that
  Jarvis never picks up would otherwise be invisible forever:
  - The 8am digest appends "Intake: N awaiting review (oldest Xh)" when
    anything is pending, a SEPARATE "Intake: N approved and still
    waiting on Jarvis" line when any approved row exists, plus a
    dead-man warning when no email intake has been seen in 24h (means
    the outlook-poller is down).
  - The hourly cron sends one-shot plain-text nags when a pending OR
    approved row crosses 4h of age, and again at 24h (stateless: each
    run only alerts rows that crossed the threshold within the last
    hour). Approved rows are worded differently ("approved but Jarvis
    has not drafted it yet") and add a line pointing at the jarvis-bot
    service.
- Deploying this change is CROSS-REPO and ORDER MATTERS (each step needs
  Sidd's "yes do it"):
  1. Run `migrations/005_intake_approvals.sql` in the Supabase SQL
     editor.
  2. Merge/deploy the Jarvis branch in hc-invoice-bot (autodeploy;
     verify the DEPLOYED line lands) so Jarvis understands `approved`.
  3. `cd worker && npx wrangler deploy`.
  `JARVIS_INTAKE_AUTODRAFT` must be ON in the droplet's .env or a tap
  moves the row to `approved` and nothing drafts it (the digest and nag
  lines above are what surface that).
  Rollback runs the other way: once THIS worker is live, reverting
  Jarvis to a version that does not understand `approved` strands every
  tapped row (old Jarvis's manual `invoice N` refuses them). So roll the
  worker back too, or re-run Jarvis's deploy. index.html is untouched
  either way, so NO sw.js cache bump is needed.
- Other halves of the feature: wf_16 + runbook docs/13_order_intake.md
  in the cold-email repo; the `invoice / show / skip` commands in
  hc-invoice-bot.

## Current uncommitted state (as of 2026-07-07)

index.html has the one-line pending-payment fix described above staged
locally, awaiting Sidd's "yes do it" to push + deploy (remember the
sw.js cache bump when it goes).
