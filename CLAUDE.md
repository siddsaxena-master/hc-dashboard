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

## NEVER RUN 021 AFTER 015c (added 2026-09-10)

Migration 015c's header warns that 021 must not follow it. That warning is a
COMMENT ONLY: 015c installs no marker, no version row and no guard function, so
nothing stops it. Proved by execution in PGlite: after 015c, migrations 016, 017
and 018 apply cleanly and then 021 applies silently, replacing the corrected
hc_authorize_notification_device with a weaker one (no `for update of fw` roster
lock, no ever_issued_at write).

021 cannot run today because its own preflight demands 016/017/018, none applied.
The trap is for a future session following the numbered order. Same shape as the
027-after-029 trap. Fix properly by making 021 abort when
notification_device_security_state.ever_issued_at exists.

Also: 015c aborts on PostgreSQL 18 (fails safe, writes nothing). Production is
PostgreSQL 17.6 as of 2026-09-10. Run `select version()` before any future run.

## HC Field authentication rollout

- Never run migration 014. Migration 015 supersedes it and removes 014's
  unsafe anonymous attribution policies if they already exist.
- Migration 015 is the temporary compatibility stage. Test it in a disposable
  Supabase clone, back up production, and get Sidd's exact `yes do it` before
  running it in production.
- `migrations/015a_closed_live_activity_end_preservation.sql` runs after 015 and
  immediately before 016. It preserves only eligible closed-shift Apple END
  addresses with private rollback provenance. Freeze clock-ins, require zero
  open shifts, close the field apps, and run 015a plus 016 as one watched
  maintenance action. Do not edit migrations 015, 016, or 017.
- Migration 016 is the final cutoff. Run it only after every active phone has
  the authenticated app, notification rows are reconciled, physical-phone and
  service-role tests pass, and Sidd gives a separate exact approval.
- `migrations/016_field_auth_cutover_rollback.sql` is an emergency undo file,
  not a normal migration. It deliberately reopens the older anonymous phone
  access and cannot reconstruct notification tokens deleted by 016. Test it in
  a disposable clone before the cutover, and never run it without separate
  production review and Sidd's exact approval.
- After 017, the normal Worker and normal pushdrain are not schema-compatible
  yet. Use only `worker/end-drain-017.js` with
  `worker/wrangler.end-drain-017.toml` and `droplet/enddrain017.py`. The Worker
  has no public route, and the sender handles only `la_end`. Before 021, require
  zero closed Activity Update rows, zero live `device_id = id` rows, zero
  unfinished `la_end` rows, no blocked or exhausted END outcome, and visual
  confirmation that every owner or manager iPhone is clear. Then disable both
  temporary components.
- The disposable-project database rehearsal is
  `rehearsal/fake-apple-end-acceptance.mjs`. It is hard-locked to project
  `gfbtxfwavninuapjzksk`, requires the matching
  `HC_FAKE_APPLE_REHEARSAL_PROJECT` confirmation, invokes the real temporary
  producer, and substitutes a local accepted response for Apple. It never
  reads Apple credentials or contacts Apple. Run it only after rehearsal 013,
  with the disposable project's URL and service key already loaded in the
  process environment. It waits one full five-minute producer interval and
  requires both reviewed zero-count gates to pass.
- Deploy the normal current Worker and pushdrain only after migration 029.
- The full reviewed sequence is in
  `../hc-field-app/PRODUCTION-ROLLOUT-2026-08-27.md`.

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
- Every Supabase read silently caps at 1000 rows. Reads of growable
  tables (orders is past 1100, shift_locations passes 1000 points on
  long shifts) must paginate — see worker.js readEvents and the shift
  summary route fetch for the offset-loop idiom. On a failed page
  return null/failure, never a partial list (a partial list is the
  same silent-miss bug in disguise).

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
  gets its card, with one extra line naming that sibling's id, SENDER
  and status ("check this is not a duplicate"), and the row stays
  pending_review. Sender is deliberately NOT part of the match: the
  2026-07-23 incident thread was answered by four people at three
  different companies. Naming the sender in the note is what lets Sidd
  tell a real thread reply from two unrelated leads that happen to
  share a subject line. A sibling
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
- **TG_WEBHOOK_SECRET is REQUIRED, not optional** (2026-07-25 security
  review). Without it the worker verifies nothing, and the only thing
  standing between the internet and a forged button tap is the chat id
  in the attacker's own JSON (`cb.message.chat.id`; `cb.from` is never
  consulted). A forged Skip would bury a real lead. It cannot cause a
  QuickBooks write (a draft still stops at Jarvis's CONFIRM, and the
  send at PDF_APPROVE, both needing Sidd's typed yes in his own chat),
  and this exposure predates the buttons for Claudia's chat commands,
  but close it: `wrangler secret put TG_WEBHOOK_SECRET` (long random
  value), `wrangler deploy`, then IMMEDIATELY register it:
  `curl -H "X-Setup-Secret: <value>" https://<worker-url>/setup-telegram-webhook`
  Use the header, not `?secret=` — a query string lands in Chrome
  history and Cloudflare logs. TIMING TRAP: between the deploy and that
  curl the worker 401s every real Telegram delivery, so Claudia is deaf
  to chat AND buttons until it lands. Telegram retries with backoff, so
  nothing is lost, but do not stop halfway.
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
  0. `cd worker && npx wrangler secret put TG_WEBHOOK_SECRET` (long
     random value; required, see the security bullet above).
  1. Run `migrations/005_intake_approvals.sql` in the Supabase SQL
     editor.
  2. Merge/deploy the Jarvis branch in hc-invoice-bot (autodeploy;
     verify the DEPLOYED line lands) so Jarvis understands `approved`.
  3. `cd worker && npx wrangler deploy`, then IMMEDIATELY
     `curl -H "X-Setup-Secret: <value>" https://<worker-url>/setup-telegram-webhook`
     (the worker 401s real Telegram traffic in between; do not stop
     between these two).
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

## NEVER RUN 016, 017 OR 022 AFTER 041 (added 2026-09-13)

Migration 041 lets crew phones (roster role team) keep ONE alert push token by
replacing `hc_sync_notification_device` with the 015 text plus a team branch.
Migrations 016, 017 and 022 each `create or replace` that same function with
the owner/manager-only rule and NO error, which silently strands every crew
phone again (proved by execution in `rehearsal/run-041-team-alert-push-pglite.mjs`,
scenario "THE TRAP DEMONSTRATED"). Rules:

- 015c before or after 041 is fine (015c never redefines this function).
- 016, 017 and 022 need REWRITTEN files that keep the team branch before they
  can ever run. 041's preflight refuses when 022's trigger function exists.
- 028 (owner MFA) is fine AFTER 041 and must never run before a 041 re-run;
  041's preflight refuses once 028 has renamed the function.
- A migration that drops the 008 anon policies on push_tokens (the D-L item)
  must stamp `notification_team_push_state.anon_push_policies_dropped_at` in
  the same transaction, or 041 refuses to re-apply.
- 041's rollback refuses once any crew token has been kept
  (`ever_kept_team_token_at`); repair forward.
- Rehearse: `node rehearsal/run-040-order-departures-pglite.mjs <pglite dir>`
  (38 scenarios) and `node rehearsal/run-041-team-alert-push-pglite.mjs <pglite dir>`
  (34 scenarios). Order in production: 040, then 041, each after Sidd's exact
  "yes do it". The worker's recipient rule (owners always; same-market
  managers; clocked-in team; every active team phone in the market when
  nobody is clocked in; App Review and inactive rows never) is written as SQL
  inside the 041 rehearsal and the worker query must match it.

## Departure plan: the worker's leave-by and LEAVE NOW banners (2026-09-13)

Built on `feature/departure-plan` after the Pridwin wedding miss. Spec:
`../DEPARTURE-PLAN-2026-09-12.md`. Rule from Sidd: no Telegram anywhere in
this feature; every message is an HC Field banner.

- `runDeparturePlanScan` runs LAST in the 5-minute chain. For every order in
  the next two days (stages quoted, invoiced, deposit_paid, paid_full) it
  reads the confirmed `delivery_request.window` (else the invoice window),
  parses a clock time, picks the destination (invoice address, then
  delivery_notes, then venue; incomplete addresses never reach a router),
  picks the start (NJ garage for ny; the clocked-in spot for vegas/miami),
  asks the router when `refreshDue` says so (at most 5 route calls a tick),
  writes ONE `order_departures` row per order, reads the crew's GPS trail
  for movement, and sends at most one banner per order per tick through
  `sendPushToMarket`. Honest states: no_time, needs_ampm, no_address,
  no_route, no_origin (one "Cannot plan" banner a day to owner + manager).
- Router: Apple Maps Server API (secrets APPLE_MAPS_KEY_ID, APPLE_MAPS_TEAM_ID,
  APPLE_MAPS_PRIVATE_KEY), Google Routes only as a fallback
  (GOOGLE_ROUTES_API_KEY). No key: `route_error 'key missing'`, no alerts,
  never a guessed number. Ferry = a directions step mentioning "ferry";
  verify with ONE real Shelter Island call after the key lands.
- Cadence: hourly from 30 h out, every 15 min inside 3 h to leave-by, every
  5 min inside the last hour or once departed. Buffers 60 min + 30 min ferry.
- Stages and stamps (`order_departures.alerts`): heads_up (60 min before),
  leave_now (inside 5 min), late_10/30/60/120/180, moving_no_pickup,
  running_late (departed, ETA 15+ min late, repeated only when the ETA moves
  10+ min after 30 min), missed (arrival + 15 min). Silenced jobs stamp but
  never send the nag stages; missed and running_late always send. A changed
  arrival time resets the stamps and lifts the silence. Recipients are
  resolved BEFORE the claim; zero phones = no claim + `no_recipients_at`.
- Recipients: owners always; same-market managers; the clocked-in team in
  that market, or every ACTIVE team phone in the market when nobody is
  clocked in; App Review and inactive rows never; a blank market = owners
  only. Crew phones need migration 041 to hold a token.
- `runDayBeforeDepartureScan` runs on the hourly cron: per market, at that
  market's 18:00 to 21:00, one owner/manager body and one crew body, stable
  queue ids so a repeat is a no-op.
- The lock-screen card: `runShiftStatusScan` prints the plan's words
  ("Leave by 10:55a", "LEAVE NOW · Pridwin", "Late 30m · Pridwin",
  "ETA 4:45p · Pridwin"); "Stopped" always wins.
- The crew's taps (on_my_way, left_garage, silence, unsilence,
  reset_departure) come through `hc_departure_action` (migration 040); the
  scan echoes each tap to owner + manager once.
- Proposed times (migration 042): `runProposalScan` (5-minute chain, just
  before the departure scan) reads a clock time out of every pending intake
  email Jarvis linked to an order (`extractArrivalTimes` over the FULL
  raw_text, PDF sections included). More than 15 minutes from the time on
  file, or nothing parsable on file: one `order_time_proposals` row, older
  pending proposals for that order retired as `newer_email`, one "Time
  change?" banner to the owner (full body) and same-market managers (short
  body), never crew. No readable time: one "Coordinator email" banner and the
  intake row marked `linked_no_time notified <iso>` in error_detail. The
  owner decides in the app through `hc_decide_proposed_time` (Accept goes
  through 038 under the owner's login; Keep changes nothing; both dismiss
  the intake row). `runStillWaitingScan` (hourly) nags the owner only:
  hourly inside 24 h, every 4 h from 72 h, quiet 22:00 to 07:00 market
  time, and retires a proposal the owner overtook by hand or whose order is
  cancelled. While a proposal is pending the departure alarm uses the
  EARLIER time (`alt_arrive_at`); an alt-only change keeps the nags already
  sent. Before 042 is applied the scan logs "proposals table missing" and
  does nothing. Telegram intake cards for linked rows only say to decide in
  the app; there are no Accept/Keep buttons on Telegram, ever (Sidd's rule).
- Tests: `node worker/test-departure-plan.mjs` (pure functions, shared
  vectors in `worker/test-vectors/window-parse.json`),
  `node worker/test-departure-scan.mjs` (the scan against a fake network) and
  `node worker/test-proposal-scan.mjs` (proposals, still waiting, alt time).
- Deploy order, each after Sidd's exact "yes do it": migration 040, then 041,
  then the droplet drainer swap (the deployed 26 KB copy cannot pass
  `payload.body` or collapse ids to Apple), then `npx wrangler deploy` from
  feature/departure-plan (NEVER main), then the Apple Maps secrets. Until the
  secrets exist the scan reports "routing unavailable" and sends nothing but
  the once-a-day cannot-plan banner.

## Departure plan, stage 0 truth checks (recorded 2026-09-13, read-only)

Plan: `../DEPARTURE-PLAN-2026-09-12.md` (original + the app-only revision).
Probed from the droplet with the app's exact parameter names.

- `hc_set_delivery_request(p_order_id,p_window)` = 401: migration 038 IS live.
- `hc_authorize_notification_device(p_device_id)` = 401: migration 015c IS live
  (applied 2026-09-10). Do not paste it again.
- `hc_enforce_notification_destination_authorization` = 404 (022 absent) and
  `hc_sync_notification_device_pre_mfa_028` = 404 (028 absent): 041's preflight
  can pass. 016/017/022 must NEVER run after 041 as written; 028 only after 041.
- push_tokens columns: apns_token, device_id, email, platform, updated_at.
  Rows on 2026-09-13: Sidd (device id set, refreshed 04:15Z), Jayden (device id
  set, refreshed 00:54Z, he is role MANAGER not team), Veronika (device id NULL,
  legacy 2026-08-05 row). Lian (team, vegas) has NO row: that is what 041 fixes.
- field_workers: App Review team/ny, Hashim Nadir team/ny, Jayden Martin
  MANAGER/ny, Lian Alpuerto team/vegas, Sidd owner/ny (+ one inactive duplicate),
  Veronika Bo team/ny (unpaid tester, deliberate $0/hr).
- push_queue columns: id, kind, outbox_type, payload, attempts, claimed_at,
  created_at, next_attempt_at, done_at, last_error, dead_lettered_at,
  dead_letter_reason. There is NO delivered_at; done_at is the success stamp.
- Deployed droplet drainer: /opt/jarvis-invoice-bot/pushdrain.py = 26,084 bytes,
  sha1 cb11c963b3226d032cd16ee6e990dbc519081787 (the 2026-08-04 original). It
  imports cryptography, has no la_update handling, forwards neither
  apns-collapse-id nor apns-expiration, and cannot carry content.data. The repo
  copy is 67,068 bytes, sha1 563c1acabdb2aee522c09350b56ef980b8c0ceae. Swap it
  before the departure worker deploy (stage 1), Sidd watching.
- No ghost 'Canelle' inquiry rows; only the real order 567ba3a6.
- Worker branch fix/worker-intake-and-vegas tip db94db4; the departure work
  continues on feature/departure-plan cut from it. main has no field-ops code.
- Postgres 17.6. Cloudflare plan tier and Google Cloud billing: not checked
  (Sidd's accounts).
- 2026-09-13 evening: MIGRATION 040 IS LIVE (Sidd's "yes do it, run 040").
  Pasted byte-for-byte (19,181 bytes, sha1 db63d7774dfd9123a879ecc15d3fe427cb47fcd3),
  "Success. No rows returned". Verified: RLS on, one select policy for
  authenticated, anon has nothing, service_role writes, hc_departure_action
  executable by authenticated only (anon and public false), 42 columns, 3
  indexes, 0 rows; from the droplet: service GET 200 `[]`, no-bearer GET and
  RPC both 401/42501. 041 (notification_team_push_state) and 042
  (order_time_proposals) still 404: not applied. Do not paste 040 again; a
  re-run is harmless (idempotent) but pointless.
- 2026-09-13 20:47 UTC: MIGRATION 041 IS LIVE (Sidd's "yes do it, run 041").
  Pasted byte-for-byte (15,903 bytes, sha1 d03cd8f21be5032baf68d0ad1f31f0fcb0c922a7).
  Verified: hc_sync_notification_device carries the team branch and the
  ever_kept_team_token_at stamp, grants unchanged (anon none, authenticated
  and service_role execute); notification_team_push_state one row, service
  only; push_tokens rows untouched (3), 008 anon policy still present; 022 and
  028 absent. From now on 016, 017 and 022 must NEVER run as written (see the
  section above). 042 still 404.
- SQL editor paste trap (seen on 041): a migration with `drop` or `revoke`
  makes Supabase open a "Potential issue detected" dialog after Run, and the
  Chrome extension can go blind (page-script calls time out) while it is up.
  The database tells the truth: probe the new object from the droplet. If the
  page is blind, send the Return key (the dialog's default is "Run query");
  never click Run a second time without knowing the state.
