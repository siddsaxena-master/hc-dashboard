// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-046-live-activity-claims-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/046_live_activity_claims.sql (the START ledger, the
// END lease columns, the two START claims, the END claim and the drainer's
// validator that the live worker and the live droplet drainer already call,
// and the close of the 010 anonymous lane on live_activity_tokens)
// and its rollback on the shape production is in on 2026-09-17: the 001-013
// base chain, 015, 015b, 019, 024, 026, 027, 029, 034-038 and 040-045 (015c
// and 030 are live too but refuse to apply on this sandbox, so the main
// chain leaves them out; one branch adds 015c under the PostgreSQL 18 shim
// from run-041 to prove 046 leaves its functions alone as well). Real
// migration files are executed as written and never rewritten on disk. The
// worker's and the drainer's exact calls are replayed as SQL with the
// service role: the claims with the parameter names the live log quotes,
// the ledger PATCHes with their exact filters, the push_queue INSERT with
// the payload worker.js builds. Every shift, phone, token and person here
// is fake.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = process.argv[2];
assert.ok(packageDir && isAbsolute(packageDir) && process.argv.length === 3,
  'Pass only the absolute local PGlite package directory');
const packageInfo = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.equal(packageInfo.name, '@electric-sql/pglite');
assert.equal(packageInfo.version, '0.5.8');
const { PGlite } = await import(pathToFileURL(join(packageDir, 'dist/index.js')).href);
const { pgcrypto } = await import(pathToFileURL(join(packageDir, 'dist/contrib/pgcrypto.js')).href);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8').then(text => text.replace(/\r\n/g, '\n'));
// The worker's own payload builders, so the queue rows here are byte for
// byte what runLiveActivityStartScan and runLiveActivityEndScan insert.
const { buildLiveActivityPushPayload, buildLiveActivityContentState, partitionRecipients } =
  await import(pathToFileURL(join(root, 'worker', 'worker.js')).href);
const workerSource = await read('worker/worker.js');
const drainerSource = await read('droplet/pushdrain.py');

const BASE_CHAIN = [
  '001_delivery_signatures', '002_shifts', '003_field_workers', '004_intake_messages',
  '005_intake_approvals', '006_payroll_and_shift_summaries', '007_clockin_alerts',
  '008_push_tokens', '009_app_config', '010_live_activity_tokens', '011_push_queue',
  '012_edit_trail_paid_snapshot', '013_invoice_pdf_url',
];
const APPLIED_CHAIN = [
  '015_field_auth_transition', '015b_payroll_payment_rpc_compatibility',
  '019_dashboard_auth_transition', '024_webhook_delivery_receipts', '026_delivery_confirmation_integrity',
  '027_webhook_async_intake_outbox', '029_webhook_delivery_lease_renewal_fix',
  '034_calendar_delivery_details', '035_order_logo_assets', '036_order_prep_workflow',
  '037_order_box_progress', '038_delivery_request_owner_edit', '040_order_departures',
  '041_team_alert_push_tokens', '042_order_time_proposals', '043_team_roster_edit',
  '044_order_reconfirmations', '045_order_address_proposals',
];
const [supabaseBootstrap, ordersBaseline, migration015c, migration018, migration025, migration, rollback] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/015c_notification_device_api_compatibility.sql'),
  read('migrations/018_live_activity_start_dedup.sql'),
  read('migrations/025_manager_market_scope.sql'),
  read('migrations/046_live_activity_claims.sql'),
  read('migrations/046_live_activity_claims_rollback.sql'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));
assert.ok(!/[\u2013\u2014]/.test(migration + rollback), 'no em or en dashes in the 046 files');

// The 015c PostgreSQL 18 shim (see run-015c-notification-bridge-pglite.mjs
// and run-041): PGlite 0.5.8 is PostgreSQL 18, whose pg_constraint also lists
// NOT NULL rows, so four count(*) predicates inside 015c get a
// `contype <> 'n'` shim (a no-op on the PostgreSQL 17 Supabase runs).
const CONSTRAINT_COUNT = /(select count\(\*\)\n(\s*)from pg_catalog\.pg_constraint as constraint_info\n\s*where constraint_info\.conrelid =\n\s*'public\.notification_device_[a-z_]+'::pg_catalog\.regclass\n)(\s*\) <> [0-9]+)/g;
const SHIM_LINE = "and constraint_info.contype <> 'n'";
const migration015cPg18 = migration015c.replace(CONSTRAINT_COUNT,
  (whole, head, indent, tail) => `${head}${indent}  ${SHIM_LINE}\n${tail}`);
assert.equal(migration015cPg18.split(SHIM_LINE).length, 5, '015c shim must hit exactly four predicates');

// The parameter names the worker and the drainer send, read out of their
// source so the call shape here cannot drift from the live one.
function rpcBodyKeysNear(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `the source must still call ${marker}`);
  const before = source.lastIndexOf('JSON.stringify({', at);
  const after = source.indexOf('JSON.stringify({', at);
  const start = (before > 0 && at - before < 800) ? before : after;
  const end = source.indexOf('})', start);
  return [...source.slice(start, end).matchAll(/[{,\n]\s*(p_[a-z_]+)\s*:/g)].map(m => m[1]);
}
const START_KEYS = rpcBodyKeysNear(workerSource, "'/rest/v1/rpc/hc_claim_live_activity_starts_v2'");
const END_KEYS = rpcBodyKeysNear(workerSource, "'/rest/v1/rpc/hc_claim_live_activity_ends'");
assert.deepEqual(START_KEYS, ['p_claimed_at', 'p_stale_before', 'p_started_after', 'p_limit']);
assert.deepEqual(END_KEYS, ['p_claimed_at', 'p_stale_before', 'p_limit']);
assert.ok(workerSource.includes("'/rest/v1/rpc/hc_claim_live_activity_starts',"), 'the PGRST202 fallback still names the plain claim');
// The documented latency: both scans have exactly one call site, the
// five-minute cron branch. Nothing runs them at clock-in time (the app
// clocks in through the Supabase RPC hc_start_shift, never through the
// worker), so the card lands on the next tick, not at the clock-in.
const wranglerSource = await read('worker/wrangler.toml');
assert.ok(wranglerSource.includes('"*/5 * * * *"'), 'the five-minute cron is still scheduled');
assert.equal((workerSource.match(/await runLiveActivityStartScan\(env\)/g) || []).length, 1, 'one START scan call site');
assert.equal((workerSource.match(/await runLiveActivityEndScan\(env\)/g) || []).length, 1, 'one END scan call site');
const cronBranchAt = workerSource.indexOf("cron === '*/5 * * * *'");
assert.ok(cronBranchAt > 0 && cronBranchAt < workerSource.indexOf('await runLiveActivityStartScan(env)'), 'and it is the five-minute cron branch');
// The two headers carry what Sidd's approval covers and the pause lever.
const headerText = text => text.replace(/\n-- ?/g, ' ').replace(/\s+/g, ' ');
assert.ok(headerText(migration).includes('WHAT SIDD\'S "YES DO IT" COVERS'), 'the 046 header names the approval items');
assert.ok(headerText(migration).includes('THE ROLLBACK DOES NOT REOPEN IT'), 'the 046 header says the lane closure is one-way');
for (const text of [migration, rollback]) {
  assert.ok(headerText(text).includes('PAUSE WITHOUT ROLLBACK'), 'both headers name the pause lever');
  assert.ok(headerText(text).includes('public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer) from service_role;'), 'with the three-function revoke');
}
const validateAt = drainerSource.indexOf('_sb_rpc("hc_validate_live_activity_start_delivery", {');
assert.ok(validateAt > 0, 'pushdrain.py must still call hc_validate_live_activity_start_delivery');
const VALIDATE_KEYS = [...drainerSource.slice(validateAt, drainerSource.indexOf('})', validateAt)).matchAll(/"(p_[a-z_]+)":/g)].map(m => m[1]);
assert.deepEqual(VALIDATE_KEYS, ['p_delivery_id', 'p_shift_id', 'p_queue_id', 'p_generation', 'p_start_token']);
for (const piece of ["'live_activity_start_deliveries' +", "'?id=eq.'", "'&shift_id=eq.'", "'&queue_id=eq.'", "'&generation=eq.'", "'&start_token=eq.'", "'&claimed_at=eq.'", "'&queued_at=is.null'"]) {
  assert.ok(workerSource.includes(piece), `worker ledger PATCH filter still has ${piece}`);
}
for (const piece of ['"delivered_at": "is.null"', '"terminal_at": "is.null"', 'if key != "device_id"', '"end_queue_id": "eq." + queue_id', '"end_requested_at": "eq." + claim_stamp']) {
  assert.ok(drainerSource.includes(piece), `drainer filter still has ${piece}`);
}
const START_SQL = `select * from public.hc_claim_live_activity_starts_v2(${START_KEYS.map((k, i) => `${k} => $${i + 1}${k === 'p_limit' ? '::integer' : '::timestamptz'}`).join(', ')})`;
const START_PLAIN_SQL = START_SQL.replace('hc_claim_live_activity_starts_v2', 'hc_claim_live_activity_starts');
const END_SQL = `select * from public.hc_claim_live_activity_ends(${END_KEYS.map((k, i) => `${k} => $${i + 1}${k === 'p_limit' ? '::integer' : '::timestamptz'}`).join(', ')})`;
const VALIDATE_SQL = `select public.hc_validate_live_activity_start_delivery(${VALIDATE_KEYS.map((k, i) => `${k} => $${i + 1}${k === 'p_generation' ? '::integer' : k === 'p_start_token' ? '::text' : '::uuid'}`).join(', ')}) as value`;
const REGISTER_SQL = 'select public.hc_register_live_activity_token(p_token_type => $1, p_shift_id => $2::uuid, p_token => $3, p_device_id => $4::uuid, p_supported => $5) as value';
const START_COLUMNS = ['delivery_id', 'queue_id', 'device_id', 'email', 'token', 'shift_id', 'worker_name', 'worker_email', 'clock_in_at', 'report_at', 'report_lat', 'report_lng', 'generation'];
const END_COLUMNS = ['token_id', 'queue_id', 'email', 'token', 'shift_id', 'clock_in_at', 'clock_out_at'];
const AUTH_SIGNATURES = [
  'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
  'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
  'public.hc_unregister_device(uuid)',
  'public.hc_authorize_notification_device(uuid)',
  'public.hc_list_managed_open_shift_ids()',
];
const SYNC_SIG = AUTH_SIGNATURES[0];

const OWNER = { authUserId: '00000000-0000-4000-8000-000000000001', email: 'siddsaxena@gmail.com' };
const MANAGER = { authUserId: '20000000-0000-4000-8000-000000000002', email: 'manager@example.invalid' };
const TEAM = { authUserId: '20000000-0000-4000-8000-000000000003', email: 'team@example.invalid' };
const STALE = { authUserId: '20000000-0000-4000-8000-000000000004', email: 'exmanager@example.invalid' };
const VEGAS = { authUserId: '20000000-0000-4000-8000-000000000005', email: 'vegas@example.invalid' };
const REVIEW = { authUserId: '20000000-0000-4000-8000-000000000006', email: 'appreview@hamptonscoconuts.com' };
// 015 allows one open shift per worker, so concurrent shifts need distinct crew.
const CREW2 = { authUserId: '20000000-0000-4000-8000-000000000007', email: 'crew2@example.invalid' };
const CREW_VEGAS = { authUserId: '20000000-0000-4000-8000-000000000008', email: 'crew.vegas@example.invalid' };
const ID = {
  manager: '10000000-0000-4000-8000-000000000002',
  team: '10000000-0000-4000-8000-000000000003',
  stale: '10000000-0000-4000-8000-000000000004',
  vegas: '10000000-0000-4000-8000-000000000005',
  review: '10000000-0000-4000-8000-000000000006',
  crew2: '10000000-0000-4000-8000-000000000007',
  crewVegas: '10000000-0000-4000-8000-000000000008',
};
const DEVICE = {
  owner: '70000000-0000-4000-8000-000000000001',
  manager: '70000000-0000-4000-8000-000000000002',
  vegas: '70000000-0000-4000-8000-000000000005',
  team: '70000000-0000-4000-8000-000000000003',
  ownerRegenerated: '70000000-0000-4000-8000-000000000011',
};
// Apple tokens are lower-case hex, 32 to 512 characters.
const TOKEN = {
  ownerStart: 'a0'.repeat(32), ownerStart2: 'a1'.repeat(32), ownerStart3: 'a2'.repeat(32),
  managerStart: 'b0'.repeat(32), managerStart2: 'b1'.repeat(32),
  vegasStart: 'c0'.repeat(32),
  teamStart: 'd0'.repeat(32),
  ownerUpdate: 'e0'.repeat(32), ownerUpdate2: 'e1'.repeat(32),
  managerUpdate: 'f0'.repeat(32),
};
const GARAGE = { lat: 40.586659, lng: -74.323824 };

const STORAGE_STUB = `
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text not null,
  owner uuid, metadata jsonb, created_at timestamptz not null default now());
alter table storage.objects enable row level security;
grant select on storage.objects to anon, authenticated;`;

// Loaded BEFORE 015 so 015 links each roster row to its Auth identity.
const SEED = `
insert into auth.users (id, email, email_confirmed_at) values
  ('${MANAGER.authUserId}', '${MANAGER.email}', '2026-01-02T00:00:00Z'),
  ('${TEAM.authUserId}', '${TEAM.email}', '2026-01-03T00:00:00Z'),
  ('${STALE.authUserId}', '${STALE.email}', '2026-01-04T00:00:00Z'),
  ('${VEGAS.authUserId}', '${VEGAS.email}', '2026-01-05T00:00:00Z'),
  ('${REVIEW.authUserId}', '${REVIEW.email}', '2026-01-06T00:00:00Z'),
  ('${CREW2.authUserId}', '${CREW2.email}', '2026-01-07T00:00:00Z'),
  ('${CREW_VEGAS.authUserId}', '${CREW_VEGAS.email}', '2026-01-08T00:00:00Z');
insert into public.field_workers (id, email, name, market, role, active, hourly_rate_cents) values
  ('${ID.manager}', '${MANAGER.email}', 'Sandbox Manager', 'ny', 'manager', true, 1900),
  ('${ID.team}', '${TEAM.email}', 'Sandbox Team', 'ny', 'team', true, 1800),
  ('${ID.stale}', '${STALE.email}', 'Sandbox Ex-manager', 'ny', 'manager', false, null),
  ('${ID.vegas}', '${VEGAS.email}', 'Sandbox Vegas Manager', 'vegas', 'manager', true, 1900),
  ('${ID.review}', '${REVIEW.email}', 'App Review', 'ny', 'team', true, 0),
  ('${ID.crew2}', '${CREW2.email}', 'Sandbox Crew Two', 'ny', 'team', true, 1800),
  ('${ID.crewVegas}', '${CREW_VEGAS.email}', 'Sandbox Vegas Crew', 'vegas', 'team', true, 1800);`;

let passed = 0;
const pass = message => { passed++; console.log(`PASS: ${message}`); };
const q = (h, sql, params = []) => h.query(sql, params);
const scalarOn = async (h, sql, params = []) => (await q(h, sql, params)).rows[0]?.value;
const rowsOn = async (h, sql, params = []) => (await q(h, sql, params)).rows;
const ident = new Map();
async function identityOn(h, options = {}) {
  const { role = 'postgres', sub = null } = options;
  ident.set(h, options);
  await h.exec('reset role;');
  const jwtRole = role === 'postgres' ? '' : role;
  await q(h, "select set_config('request.jwt.claim.role', $1, false)", [jwtRole]);
  await q(h, "select set_config('request.jwt.claim.sub', $1, false)", [sub ?? '']);
  await q(h, "select set_config('request.jwt.claims', $1, false)",
    [sub || jwtRole ? JSON.stringify({ sub: sub || null, role: jwtRole || null }) : '']);
  if (role !== 'postgres') await h.exec(`set role ${role};`);
}
async function asPostgres(h, work) {
  const saved = ident.get(h) ?? {};
  await identityOn(h);
  try { return await work(); } finally { await identityOn(h, saved); }
}
async function asServiceRole(h, work) {
  const saved = ident.get(h) ?? {};
  await identityOn(h, { role: 'service_role' });
  try { return await work(); } finally { await identityOn(h, saved); }
}
async function asUser(h, who, work) {
  const saved = ident.get(h) ?? {};
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  try { return await work(); } finally { await identityOn(h, saved); }
}
async function deniedOn(h, label, sql, params = [], code = '42501', message = null) {
  await assert.rejects(h.query(sql, params), error => error.code === code && (!message || message.test(error.message)), label);
  pass(label);
}
async function refusesOn(h, label, sql, code, message) {
  let seen = null;
  await assert.rejects(h.exec(sql), error => { seen = error; return error.code === code && message.test(error.message); }, label);
  try { await h.exec('rollback;'); } catch { /* nothing open */ }
  pass(`${label} (${seen.code}: ${seen.message})`);
}
const iso = ms => new Date(ms).toISOString();
const seconds = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);

// The phone's registration (App.js laWriteToken), through the live 015 RPC.
const register = (h, who, type, shiftId, token, device, supported = true) =>
  asUser(h, who, () => q(h, REGISTER_SQL, [type, shiftId, token, device, supported]));
// The worker's START claim, with the service key, exactly as the cron does it
// (v2 first; the plain name is what the PGRST202 fallback would call).
const claimStartsAs = (h, sql, stamp, options = {}) => asServiceRole(h, () => rowsOn(h, sql, [
  stamp, options.staleBefore ?? iso(new Date(stamp).getTime() - 30 * 60000),
  options.startedAfter ?? iso(new Date(stamp).getTime() - 48 * 3600000), options.limit ?? 50]));
const claimStarts = (h, stamp, options) => claimStartsAs(h, START_SQL, stamp, options);
const claimEnds = (h, stamp, options = {}) => asServiceRole(h, () => rowsOn(h, END_SQL, [
  stamp, options.staleBefore ?? iso(new Date(stamp).getTime() - 30 * 60000), options.limit ?? 50]));
// The drainer's pre-send check.
const validate = (h, row) => asServiceRole(h, () => scalarOn(h, VALIDATE_SQL,
  [row.delivery_id, row.shift_id, row.queue_id, row.generation, row.token]));
// The worker's ledger PATCHes (liveActivityStartIdentityQuery + body).
const START_IDENTITY = 'id = $1 and shift_id = $2 and queue_id = $3 and generation = $4 and start_token = $5 and claimed_at = $6::timestamptz and queued_at is null';
const completeStart = (h, row, stamp) => asServiceRole(h, () => rowsOn(h,
  `update public.live_activity_start_deliveries set claimed_at = null, queued_at = $7::timestamptz where ${START_IDENTITY} returning id`,
  [row.delivery_id, row.shift_id, row.queue_id, row.generation, row.token.toLowerCase(), stamp, iso(Date.now())]));
const releaseStart = (h, row, stamp) => asServiceRole(h, () => rowsOn(h,
  `update public.live_activity_start_deliveries set claimed_at = null where ${START_IDENTITY} returning id`,
  [row.delivery_id, row.shift_id, row.queue_id, row.generation, row.token.toLowerCase(), stamp]));
// The drainer's result PATCH (device_id deliberately dropped from the filter)
// with Prefer return=representation, and its confirmation GET.
const DRAIN_IDENTITY = 'id = $1 and shift_id = $2 and queue_id = $3 and generation = $4 and start_token = $5';
const recordDelivered = (h, row) => asServiceRole(h, () => rowsOn(h,
  `update public.live_activity_start_deliveries set delivered_at = $6::timestamptz where ${DRAIN_IDENTITY} and delivered_at is null and terminal_at is null returning id, delivered_at, terminal_at, terminal_reason`,
  [row.delivery_id, row.shift_id, row.queue_id, row.generation, row.token.toLowerCase(), iso(Date.now())]));
const recordTerminal = (h, row, reason) => asServiceRole(h, () => rowsOn(h,
  `update public.live_activity_start_deliveries set terminal_at = $6::timestamptz, terminal_reason = $7 where ${DRAIN_IDENTITY} and delivered_at is null and terminal_at is null returning id, delivered_at, terminal_at, terminal_reason`,
  [row.delivery_id, row.shift_id, row.queue_id, row.generation, row.token.toLowerCase(), iso(Date.now()), reason]));
const resultPresent = (h, row) => asServiceRole(h, () => rowsOn(h,
  `select id, delivered_at, terminal_at, terminal_reason from public.live_activity_start_deliveries where ${DRAIN_IDENTITY} limit 1`,
  [row.delivery_id, row.shift_id, row.queue_id, row.generation, row.token.toLowerCase()]));
const deleteStartToken = (h, token) => asServiceRole(h, () => rowsOn(h,
  "delete from public.live_activity_tokens where token_type = 'push_to_start' and shift_id is null and token = $1 returning id", [token]));
// The worker's push_queue INSERT (enqueuePush: Prefer resolution=ignore-duplicates).
function startQueuePayload(row, stamp) {
  const name = row.worker_name || 'Team';
  const contentState = buildLiveActivityContentState('At NJ Garage', 0, row.report_at || row.clock_in_at, row.market);
  const payload = buildLiveActivityPushPayload([row.token], 'start', contentState, {
    attributes: { workerName: name, clockInISO: new Date(row.clock_in_at).toISOString(), shiftId: row.shift_id },
    alert: { title: name + ' is on shift', body: 'Shift card is live' },
    metadata: {
      live_activity_start_delivery_id: row.delivery_id,
      live_activity_start_shift_id: row.shift_id,
      live_activity_start_device_id: row.device_id,
      live_activity_start_queue_id: row.queue_id,
      live_activity_start_generation: row.generation,
      live_activity_start_claimed_at: stamp,
    },
  });
  return { ...payload, headers: { ...payload.headers, collapse_id: row.queue_id } };
}
function endQueuePayload(row, stamp) {
  return buildLiveActivityPushPayload([row.token], 'end', { status: 'Clocked out', statusMinutes: 135, boxesLine: 'Shift ended' }, {
    dismissalDate: Math.floor(Date.now() / 1000) - 1, priority: 10,
    metadata: {
      live_activity_token_id: row.token_id, live_activity_shift_id: row.shift_id,
      live_activity_queue_id: row.queue_id, live_activity_end_requested_at: stamp,
    },
  });
}
const ENQUEUE_SQL = "insert into public.push_queue (id, kind, payload, outbox_type) values ($1, $2, $3::jsonb, 'push') on conflict do nothing returning id";
const enqueue = (h, id, kind, payload) => asServiceRole(h, () => rowsOn(h, ENQUEUE_SQL, [id, kind, JSON.stringify(payload)]));
const queueRow = (h, id) => asPostgres(h, async () => (await rowsOn(h, 'select id, kind, claimed_at, done_at, attempts from public.push_queue where id = $1', [id]))[0]);
const finishQueue = (h, id) => asServiceRole(h, () => q(h, 'update public.push_queue set done_at = now(), claimed_at = null where id = $1', [id]));
const purgeQueue = (h, id) => asServiceRole(h, () => rowsOn(h, 'delete from public.push_queue where id = $1 returning id', [id]));
// The worker's END release and the drainer's END delete/release, by full identity.
const END_IDENTITY = "id = $1 and token = $2 and token_type = 'activity_update' and shift_id = $3 and end_queue_id = $4 and end_requested_at = $5::timestamptz";
const releaseEnd = (h, row, stamp) => asServiceRole(h, () => rowsOn(h,
  `update public.live_activity_tokens set end_requested_at = null, end_queue_id = null where ${END_IDENTITY} returning id`,
  [row.token_id, row.token, row.shift_id, row.queue_id, stamp]));
const deleteEndToken = (h, row, stamp) => asServiceRole(h, () => rowsOn(h,
  `delete from public.live_activity_tokens where ${END_IDENTITY} returning id`,
  [row.token_id, row.token, row.shift_id, row.queue_id, stamp]));
const ledger = (h, where = 'true', params = []) => asPostgres(h, () => rowsOn(h,
  `select id, shift_id, device_id, start_token, queue_id, generation, claimed_at, queued_at, delivered_at, terminal_at, terminal_reason, created_at, updated_at
     from public.live_activity_start_deliveries where ${where} order by created_at, id`, params));
const tokens = (h, where = 'true', params = []) => asPostgres(h, () => rowsOn(h,
  `select id, email, token_type, shift_id, token, device_id, end_requested_at, end_queue_id from public.live_activity_tokens where ${where} order by email, token_type, shift_id`, params));
const roster = h => asPostgres(h, () => rowsOn(h, "select email, role, market from public.field_workers where role in ('owner', 'manager') and active = true"));
let shiftSeq = 0;
async function openShift(h, who, market = 'ny', minutesAgo = 10) {
  shiftSeq++;
  return asPostgres(h, () => scalarOn(h,
    `insert into public.shifts (worker_name, worker_email, market, clock_in_at, clock_in_lat, clock_in_lng, device)
     values ($1, $2, $3, now() - ($4::int * interval '1 minute'), $5, $6, 'sandbox') returning id as value`,
    [`Sandbox ${shiftSeq}`, who.email, market, minutesAgo, GARAGE.lat, GARAGE.lng]));
}
const closeShift = (h, shiftId) => asPostgres(h, () => q(h, 'update public.shifts set clock_out_at = now() where id = $1', [shiftId]));
const locate = (h, shiftId, lat, lng, minutesAgo) => asPostgres(h, () => q(h,
  "insert into public.shift_locations (shift_id, at, lat, lng) values ($1, now() - ($2::int * interval '1 minute'), $3, $4)", [shiftId, minutesAgo, lat, lng]));
const fingerprints = h => asPostgres(h, async () => Object.fromEntries((await rowsOn(h,
  `select required.signature, pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') as definition
     from unnest($1::text[]) as required(signature)
     join pg_proc as p on p.oid = to_regprocedure(required.signature)`, [AUTH_SIGNATURES])).map(r => [r.signature, r.definition])));
const fnExists = (h, signature) => scalarOn(h, 'select to_regprocedure($1) is not null as value', [signature]);
const tableExists = (h, name) => scalarOn(h, 'select to_regclass($1) is not null as value', [`public.${name}`]);
const columnType = (h, table, column) => scalarOn(h,
  'select format_type(atttypid, atttypmod) as value from pg_attribute where attrelid = $1::regclass and attname = $2 and attnum > 0 and not attisdropped',
  [`public.${table}`, column]);
const triggerEnabled = (h, table, name) => scalarOn(h,
  "select exists (select 1 from pg_trigger where tgrelid = $1::regclass and tgname = $2 and not tgisinternal and tgenabled <> 'D') as value", [`public.${table}`, name]);
const policyCount = (h, table) => scalarOn(h, "select count(*)::int as value from pg_policies where schemaname = 'public' and tablename = $1", [table]);
const hasExecute = (h, role, signature) => scalarOn(h, "select has_function_privilege($1, $2, 'execute') as value", [role, signature]);
const hasTable = (h, role, table, priv) => scalarOn(h, 'select has_table_privilege($1, $2, $3) as value', [role, `public.${table}`, priv]);
const SIGNATURES = {
  v2: 'public.hc_claim_live_activity_starts_v2(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
  plain: 'public.hc_claim_live_activity_starts(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
  ends: 'public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)',
  validate: 'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)',
};
const TRIGGER_FUNCTIONS = [
  'public.hc_reset_live_activity_end_request()', 'public.hc_retain_unconfirmed_live_activity_start_queue()',
  'public.hc_validate_live_activity_start_queue()', 'public.hc_protect_live_activity_start_delivery()',
  'public.hc_reconcile_live_activity_start_device()',
];

async function productionShaped(options = {}) {
  const { skip = [], with015c = false } = options;
  const h = await PGlite.create({ extensions: { pgcrypto } });
  await h.exec(supabaseBootstrap);
  await h.exec(STORAGE_STUB);
  await h.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await h.exec(baseFiles[name]);
  await h.exec(SEED);
  for (const name of APPLIED_CHAIN) if (!skip.includes(name)) await h.exec(baseFiles[name]);
  if (with015c) await h.exec(migration015cPg18);
  await identityOn(h);
  return h;
}

const handles = [];
try {
  const db = await productionShaped();
  handles.push(db);
  const ident0 = (await q(db, 'select current_database() as name, version() as version')).rows[0];
  assert.ok(ident0.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  const owner = await asPostgres(db, async () => (await rowsOn(db,
    'select id, email, name, role, active, auth_user_id from public.field_workers where lower(email) = $1', [OWNER.email]))[0]);
  assert.ok(owner && owner.role === 'owner' && owner.active === true && owner.auth_user_id === OWNER.authUserId, 'the bootstrap must carry the linked owner row');
  ID.owner = owner.id;

  // ── before 046: the worker's exact calls fail the way the live log says ──
  // PostgREST turns "function does not exist" (42883) into 404 PGRST202.
  await identityOn(db, { role: 'service_role' });
  const stamp0 = iso(Date.now());
  await deniedOn(db, 'before 046, the worker\'s v2 START claim (p_claimed_at, p_stale_before, p_started_after, p_limit) is 42883, the live 404 PGRST202', START_SQL, [stamp0, iso(Date.now() - 1800000), iso(Date.now() - 48 * 3600000), 50], '42883');
  await deniedOn(db, 'before 046, the plain START claim the fallback would call is 42883 too', START_PLAIN_SQL, [stamp0, iso(Date.now() - 1800000), iso(Date.now() - 48 * 3600000), 50], '42883');
  await deniedOn(db, 'before 046, the END claim (p_claimed_at, p_stale_before, p_limit) is 42883', END_SQL, [stamp0, iso(Date.now() - 1800000), 50], '42883');
  await deniedOn(db, 'before 046, the drainer\'s validator is 42883 (every START would park as "eligibility check unavailable")', VALIDATE_SQL, [DEVICE.owner, DEVICE.owner, DEVICE.owner, 1, TOKEN.ownerStart], '42883');
  await identityOn(db);
  assert.equal(await columnType(db, 'live_activity_tokens', 'end_requested_at'), undefined);
  assert.equal(await tableExists(db, 'live_activity_start_deliveries'), false);
  const before = await fingerprints(db);
  assert.deepEqual(Object.keys(before).sort(), AUTH_SIGNATURES.slice(0, 3).sort(), 'the main chain carries the three 015 functions (015c is on its own branch)');
  assert.ok(before[SYNC_SIG].includes("if v_role = 'team' then"), '041 is live on this chain');

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  for (const signature of Object.values(SIGNATURES)) assert.equal(await fnExists(db, signature), true, signature);
  assert.equal(await tableExists(db, 'live_activity_start_deliveries'), true);
  assert.equal(await columnType(db, 'live_activity_tokens', 'end_requested_at'), 'timestamp with time zone');
  assert.equal(await columnType(db, 'live_activity_tokens', 'end_queue_id'), 'uuid');
  for (const [table, name] of [['push_queue', 'push_queue_retain_unconfirmed_live_activity_start'], ['push_queue', 'push_queue_validate_live_activity_start'],
    ['live_activity_tokens', 'live_activity_tokens_reset_end_request'], ['live_activity_tokens', 'live_activity_tokens_reconcile_start_device'],
    ['live_activity_start_deliveries', 'live_activity_start_deliveries_protect_identity']]) {
    assert.equal(await triggerEnabled(db, table, name), true, name);
  }
  assert.equal(await tableExists(db, 'live_activity_tokens_end_request_idx'), true);
  assert.equal(await tableExists(db, 'live_activity_start_deliveries_pending_idx'), true);
  pass('046 applies twice on the production-shaped chain (001-013, 015, 015b, 019, 024, 026, 027, 029, 034-038, 040-045)');

  // ── the auth functions are byte-identical ──
  const after = await fingerprints(db);
  assert.deepEqual(after, before);
  assert.ok(after[SYNC_SIG].includes("if v_role = 'team' then") && after[SYNC_SIG].includes('ever_kept_team_token_at'));
  pass('hc_sync_notification_device (041 team branch), hc_register_live_activity_token and hc_unregister_device are byte-identical before and after 046, grants included');
  pass('the START and END scans have one call site each, the worker\'s five-minute cron (wrangler.toml), and no clock-in path runs them: the card lands on the next tick after clock-in, the documented latency; both 046 headers name the three approval items and the pause lever');
  // What 017 / 018 / 022 / 025 would have done is NOT done.
  for (const index of ['live_activity_tokens_p2s_uniq', 'live_activity_tokens_upd_uniq', 'live_activity_tokens_device_p2s_uidx', 'live_activity_tokens_device_update_uidx']) {
    assert.equal(await tableExists(db, index), true, index);
  }
  assert.equal(await tableExists(db, 'live_activity_tokens_legacy_p2s_uidx'), false, '017 legacy index absent');
  assert.equal(await fnExists(db, 'public.hc_management_can_access_shift_market(text,text,text)'), false, '025 helper absent');
  assert.equal(await fnExists(db, 'public.hc_enforce_notification_destination_authorization()'), false, '022 trigger function absent');
  assert.equal(await fnExists(db, 'public.hc_replace_legacy_live_activity_token()'), false);
  pass('the 010 and 015 token indexes and every function 017/018/022/025 would rewrite are untouched; none of their extra objects exist');

  // ── the 010 anonymous lane on the token table is closed; push_tokens is not ──
  const tokenPolicies = await asPostgres(db, () => rowsOn(db, "select policyname, roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'live_activity_tokens'"));
  assert.deepEqual(tokenPolicies, [], 'no policy at all on live_activity_tokens (010 had the two anon ones, 015 added none)');
  for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
    assert.equal(await hasTable(db, 'anon', 'live_activity_tokens', priv), false, `anon ${priv}`);
    assert.equal(await hasTable(db, 'public', 'live_activity_tokens', priv), false, `PUBLIC ${priv}`);
  }
  for (const priv of ['select', 'insert', 'update', 'references']) {
    assert.equal(await asPostgres(db, () => scalarOn(db, "select has_any_column_privilege('anon', 'public.live_activity_tokens', $1) as value", [priv])), false, `anon column ${priv}`);
  }
  for (const priv of ['insert', 'update', 'delete']) assert.equal(await hasTable(db, 'authenticated', 'live_activity_tokens', priv), false, `authenticated ${priv} (015 revoked it)`);
  assert.equal(await hasTable(db, 'authenticated', 'live_activity_tokens', 'select'), true, 'authenticated keeps 015\'s default select grant (no policy, so it reads nothing)');
  for (const priv of ['select', 'insert', 'update', 'delete']) assert.equal(await hasTable(db, 'service_role', 'live_activity_tokens', priv), true, `service_role ${priv}`);
  assert.ok((await asPostgres(db, () => rowsOn(db, "select policyname from pg_policies where schemaname = 'public' and tablename = 'push_tokens'"))).some(p => p.policyname === 'push_tokens_anon_insert'), 'the 008 push_tokens anon policy is still there (041\'s marker rule; 046 never touches it)');
  pass('046 closed the 010 anonymous lane: live_activity_tokens has no policy, anon and PUBLIC hold no table or column privilege, authenticated still cannot write (015), service_role keeps select/insert/update/delete, and the 008 push_tokens anon policy is untouched');

  // ── grants and row security ──
  assert.equal(await policyCount(db, 'live_activity_start_deliveries'), 0);
  assert.equal(await asPostgres(db, () => scalarOn(db, "select relrowsecurity as value from pg_class where oid = 'public.live_activity_start_deliveries'::regclass")), true);
  for (const role of ['anon', 'authenticated', 'public']) {
    for (const priv of ['select', 'insert', 'update', 'delete']) assert.equal(await hasTable(db, role, 'live_activity_start_deliveries', priv), false, `${role} ${priv}`);
    for (const signature of [...Object.values(SIGNATURES), ...TRIGGER_FUNCTIONS]) assert.equal(await hasExecute(db, role, signature), false, `${role} ${signature}`);
  }
  for (const priv of ['select', 'insert', 'update', 'delete']) assert.equal(await hasTable(db, 'service_role', 'live_activity_start_deliveries', priv), true, priv);
  for (const signature of Object.values(SIGNATURES)) assert.equal(await hasExecute(db, 'service_role', signature), true, signature);
  for (const signature of TRIGGER_FUNCTIONS) assert.equal(await hasExecute(db, 'service_role', signature), false, signature);
  pass('the ledger has RLS on, zero policies, service_role select/insert/update/delete and nothing for anon, authenticated or PUBLIC; the four RPCs are service_role only; the trigger functions are callable by nobody');
  const stamp1 = iso(Date.now());
  for (const [role, sub] of [['anon', null], ['authenticated', OWNER.authUserId]]) {
    await identityOn(db, { role, sub });
    await deniedOn(db, `${role} gets 42501 on the v2 START claim`, START_SQL, [stamp1, iso(Date.now() - 1800000), iso(Date.now() - 48 * 3600000), 50]);
    await deniedOn(db, `${role} gets 42501 on the plain START claim`, START_PLAIN_SQL, [stamp1, iso(Date.now() - 1800000), iso(Date.now() - 48 * 3600000), 50]);
    await deniedOn(db, `${role} gets 42501 on the END claim`, END_SQL, [stamp1, iso(Date.now() - 1800000), 50]);
    await deniedOn(db, `${role} gets 42501 on the validator`, VALIDATE_SQL, [DEVICE.owner, DEVICE.owner, DEVICE.owner, 1, TOKEN.ownerStart]);
    await deniedOn(db, `${role} cannot read the ledger`, 'select count(*) from public.live_activity_start_deliveries');
    await identityOn(db);
  }
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the service role is refused a stale stamp at or after the claim stamp (22023)', START_SQL, [stamp1, stamp1, iso(Date.now() - 48 * 3600000), 50], '22023');
  await deniedOn(db, 'the service role is refused a start window after the claim stamp (22023)', START_SQL, [stamp1, iso(Date.now() - 1800000), iso(Date.now() + 60000), 50], '22023');
  await deniedOn(db, 'the END claim is refused a stale stamp at or after the claim stamp (22023)', END_SQL, [stamp1, stamp1, 50], '22023');
  await identityOn(db);

  // ── nothing to claim yet: no shift, no phone ──
  assert.deepEqual(await claimStarts(db, iso(Date.now())), []);
  assert.deepEqual(await claimEnds(db, iso(Date.now())), []);
  pass('with no open shift and no phone the service claims answer an empty array (what the first live tick after 046 should log)');

  // ── phones register through the live 015 RPC, exactly as App.js does ──
  await register(db, OWNER, 'push_to_start', null, TOKEN.ownerStart, DEVICE.owner);
  await register(db, MANAGER, 'push_to_start', null, TOKEN.managerStart, DEVICE.manager);
  await register(db, VEGAS, 'push_to_start', null, TOKEN.vegasStart, DEVICE.vegas);
  await register(db, TEAM, 'push_to_start', null, TOKEN.teamStart, DEVICE.team);
  let p2s = await tokens(db, "token_type = 'push_to_start'");
  assert.deepEqual(p2s.map(t => t.email).sort(), [MANAGER.email, OWNER.email, VEGAS.email].sort(), 'a team phone never keeps a card token (015)');
  assert.ok(p2s.every(t => t.device_id && t.end_requested_at === null && t.end_queue_id === null));
  pass('owner, ny manager and vegas manager phones register push_to_start tokens with device ids; the team phone gets none; the new lease columns start null on insert');

  // ── the anonymous lane is closed: the public anon key cannot redirect a card ──
  // Before the close, an unfiltered anon PATCH rewrote the owner's
  // push_to_start token and an anon INSERT planted a push_to_start row for
  // the manager's email, and the next claim sent both cards to those tokens.
  const ATTACKER_TOKEN = 'ee'.repeat(32);
  const ATTACKER_DEVICE = '70000000-0000-4000-8000-0000000000ee';
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon (the public key in index.html) is refused an unfiltered UPDATE of live_activity_tokens (42501)', 'update public.live_activity_tokens set token = $1', [ATTACKER_TOKEN]);
  await deniedOn(db, 'anon is refused a filtered UPDATE of the owner\'s push_to_start row (42501)', "update public.live_activity_tokens set token = $1 where lower(email) = $2 and token_type = 'push_to_start' and shift_id is null", [ATTACKER_TOKEN, OWNER.email]);
  await deniedOn(db, 'anon is refused an INSERT of a push_to_start row for the manager\'s email with its own device id (42501)', "insert into public.live_activity_tokens (email, token_type, shift_id, token, device_id) values ($1, 'push_to_start', null, $2, $3::uuid)", [MANAGER.email, 'dd'.repeat(32), ATTACKER_DEVICE]);
  await deniedOn(db, 'anon is refused a SELECT of live_activity_tokens (42501)', 'select count(*) from public.live_activity_tokens');
  await deniedOn(db, 'anon is refused a DELETE of live_activity_tokens (42501)', 'delete from public.live_activity_tokens');
  await identityOn(db);
  // A signed-in crew phone (authenticated) cannot plant a row either: 015's
  // revoke, which the preflight now demands.
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  await deniedOn(db, 'a signed-in crew phone is refused a direct INSERT of a push_to_start row for the owner\'s email (42501, 015\'s revoke)', "insert into public.live_activity_tokens (email, token_type, shift_id, token, device_id) values ($1, 'push_to_start', null, $2, $3::uuid)", [OWNER.email, ATTACKER_TOKEN, ATTACKER_DEVICE]);
  await deniedOn(db, 'a signed-in crew phone is refused an UPDATE of live_activity_tokens (42501)', 'update public.live_activity_tokens set token = $1', [ATTACKER_TOKEN]);
  await identityOn(db);
  p2s = await tokens(db, "token_type = 'push_to_start'");
  assert.deepEqual(p2s.map(t => t.token).sort(), [TOKEN.managerStart, TOKEN.ownerStart, TOKEN.vegasStart].sort(), 'every registered token is exactly what the phones wrote');
  assert.ok(!p2s.some(t => t.token === ATTACKER_TOKEN || t.device_id === ATTACKER_DEVICE));
  pass('with the anonymous lane closed, neither the public anon key nor a signed-in crew phone can rewrite the owner\'s push_to_start token or plant one for a manager; the claim below sends the real tokens only');

  // ── a crew member clocks in: the START claim ──
  const shiftA = await openShift(db, TEAM, 'ny', 10);
  await locate(db, shiftA, GARAGE.lat + 0.01, GARAGE.lng, 8);
  await locate(db, shiftA, GARAGE.lat, GARAGE.lng, 2);
  const stampA = iso(Date.now());
  const claimA = await claimStarts(db, stampA);
  assert.equal(claimA.length, 2, 'owner phone + ny manager phone');
  for (const row of claimA) {
    assert.deepEqual(Object.keys(row), [...START_COLUMNS, 'market'], 'the v2 row carries exactly the 14 columns the worker reads');
    assert.equal(row.shift_id, shiftA);
    assert.equal(row.market, 'ny');
    assert.equal(row.worker_name, 'Sandbox 1');
    assert.equal(row.worker_email, TEAM.email);
    assert.equal(row.generation, 1);
    assert.match(row.token, /^[0-9a-f]{32,512}$/);
    assert.ok(seconds(row.clock_in_at, Date.now() - 10 * 60000) < 5);
    assert.ok(seconds(row.report_at, Date.now() - 2 * 60000) < 5, 'report_at is the latest GPS point');
    assert.equal(row.report_lat, GARAGE.lat);
    assert.equal(row.report_lng, GARAGE.lng);
    // Parity with the worker's UPDATE path: a START phone is always one the
    // UPDATE path would also address.
    const { owners, managers } = partitionRecipients(await roster(db), row.worker_email, row.market);
    assert.ok(owners.includes(row.email) || managers.includes(row.email), `${row.email} is an UPDATE recipient too`);
  }
  const ownerRow = claimA.find(r => r.email === OWNER.email);
  const managerRow = claimA.find(r => r.email === MANAGER.email);
  assert.ok(ownerRow && managerRow);
  assert.equal(ownerRow.device_id, DEVICE.owner);
  assert.equal(ownerRow.token, TOKEN.ownerStart);
  assert.equal(managerRow.device_id, DEVICE.manager);
  assert.ok(!claimA.some(r => r.email === VEGAS.email), 'the vegas manager is not sent a ny card');
  assert.ok(!claimA.some(r => r.email === TEAM.email));
  let rows = await ledger(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => seconds(r.claimed_at, stampA) === 0 && r.queued_at === null && r.delivered_at === null && r.terminal_at === null));
  pass('a ny clock-in seeds one receipt per eligible phone (owner + ny manager, never the vegas manager, never the crew phone) and the v2 claim returns the 14 worker columns with report_at/lat/lng from the latest GPS point, market ny and claimed_at = p_claimed_at unchanged');

  assert.deepEqual(await claimStarts(db, iso(Date.now() + 1000)), []);
  pass('a second claim inside the 30 minute lease returns nothing (claims are exclusive)');

  // ── the worker enqueues and completes; the drainer validates and delivers ──
  const badPayload = { ...startQueuePayload(ownerRow, stampA), live_activity_start_generation: 2 };
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'a push_queue la_start row whose identity does not match the leased receipt is refused (23514)', ENQUEUE_SQL, [ownerRow.queue_id, 'la_start', JSON.stringify(badPayload)], '23514', /ineligible or stale/);
  await deniedOn(db, 'a push_queue la_start row with two tokens is refused (23514)', ENQUEUE_SQL, [ownerRow.queue_id, 'la_start', JSON.stringify({ ...startQueuePayload(ownerRow, stampA), tokens: [ownerRow.token, managerRow.token] })], '23514', /malformed/);
  await deniedOn(db, 'a push_queue la_start row under a different id than its queue id is refused (23514)', ENQUEUE_SQL, [DEVICE.ownerRegenerated, 'la_start', JSON.stringify(startQueuePayload(ownerRow, stampA))], '23514', /ineligible or stale/);
  await deniedOn(db, 'a push_queue la_start row with an old claim stamp is refused (23514)', ENQUEUE_SQL, [ownerRow.queue_id, 'la_start', JSON.stringify(startQueuePayload(ownerRow, stamp0))], '23514', /ineligible or stale/);
  await identityOn(db);
  assert.equal(await queueRow(db, ownerRow.queue_id), undefined);
  assert.deepEqual(await enqueue(db, ownerRow.queue_id, 'la_start', startQueuePayload(ownerRow, stampA)), [{ id: ownerRow.queue_id }]);
  assert.deepEqual(await enqueue(db, ownerRow.queue_id, 'la_start', startQueuePayload(ownerRow, stampA)), [], 'a retry of the same queue id is a no-op (ignore-duplicates)');
  assert.equal((await queueRow(db, ownerRow.queue_id)).kind, 'la_start');
  assert.deepEqual(await completeStart(db, ownerRow, stampA), [{ id: ownerRow.delivery_id }]);
  assert.deepEqual(await completeStart(db, ownerRow, stampA), [], 'the completion PATCH matches once');
  rows = await ledger(db, 'id = $1', [ownerRow.delivery_id]);
  assert.equal(rows[0].claimed_at, null);
  assert.ok(rows[0].queued_at);
  pass('the worker\'s exact push_queue row (worker.js payload, id = queue id, collapse id) passes the insert guard, malformed or stale ones raise 23514, and the completion PATCH (filtered by id, shift, queue, generation, token, claimed_at=eq.<ms stamp>, queued_at is null) matches exactly once');

  assert.equal(await validate(db, ownerRow), true);
  assert.equal(await validate(db, { ...ownerRow, generation: 2 }), false);
  assert.equal(await validate(db, { ...ownerRow, token: TOKEN.ownerStart2 }), false);
  assert.equal(await asServiceRole(db, () => scalarOn(db, VALIDATE_SQL, [ownerRow.delivery_id, ownerRow.shift_id, ownerRow.queue_id, 0, ownerRow.token])), false);
  assert.equal(await asServiceRole(db, () => scalarOn(db, VALIDATE_SQL, [ownerRow.delivery_id, ownerRow.shift_id, ownerRow.queue_id, 1, '  '])), false);
  assert.equal(await asServiceRole(db, () => scalarOn(db, VALIDATE_SQL, [null, ownerRow.shift_id, ownerRow.queue_id, 1, ownerRow.token])), false);
  pass('the drainer\'s validator answers true for the queued receipt and false (never an error) for a wrong generation, token, null or short argument');

  const delivered = await recordDelivered(db, ownerRow);
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].delivered_at && delivered[0].terminal_at === null);
  assert.deepEqual(await recordDelivered(db, ownerRow), [], 'the delivered PATCH is a no-op the second time (delivered_at=is.null)');
  const present = await resultPresent(db, ownerRow);
  assert.equal(present.length, 1);
  assert.ok(present[0].delivered_at && present[0].terminal_at === null);
  assert.equal(await validate(db, ownerRow), false, 'delivered rows are never sent again');
  await finishQueue(db, ownerRow.queue_id);
  pass('the drainer\'s delivered PATCH (id, shift, queue, generation, token, delivered_at is null, terminal_at is null; device_id dropped) lands once, reads back through its confirmation GET, and the validator turns false');

  // ── the release PATCH, the stale re-claim with the same queue id ──
  assert.deepEqual(await releaseStart(db, managerRow, stampA), [{ id: managerRow.delivery_id }]);
  rows = await ledger(db, 'id = $1', [managerRow.delivery_id]);
  assert.equal(rows[0].claimed_at, null);
  const reclaimB = await claimStarts(db, iso(Date.now() + 2000));
  assert.equal(reclaimB.length, 1);
  assert.equal(reclaimB[0].delivery_id, managerRow.delivery_id);
  assert.equal(reclaimB[0].queue_id, managerRow.queue_id, 'the queue UUID is stable across a release');
  pass('the worker\'s release PATCH clears the lease and the next claim hands the same receipt back with the same queue UUID');
  // A claim that went stale (a lost enqueue response): 31 minutes later the
  // worker's p_stale_before passes the stored claimed_at.
  const stampStale = iso(Date.now() + 31 * 60000);
  const reclaimC = await claimStarts(db, stampStale, { staleBefore: iso(Date.now() + 60 * 1000 + 1000) });
  assert.equal(reclaimC.length, 1);
  assert.equal(reclaimC[0].delivery_id, managerRow.delivery_id);
  assert.equal(reclaimC[0].queue_id, managerRow.queue_id);
  assert.equal(reclaimC[0].generation, 1);
  rows = await ledger(db, 'id = $1', [managerRow.delivery_id]);
  assert.equal(seconds(rows[0].claimed_at, stampStale), 0);
  pass('a claim older than p_stale_before is re-claimable with the same queue UUID and generation (a lost enqueue response never makes a second logical START)');

  // ── a dead token: terminal once, no-op twice, then a new generation ──
  const managerRowNow = reclaimC[0];
  assert.deepEqual(await enqueue(db, managerRowNow.queue_id, 'la_start', startQueuePayload(managerRowNow, stampStale)), [{ id: managerRowNow.queue_id }]);
  assert.deepEqual(await completeStart(db, managerRowNow, stampStale), [{ id: managerRowNow.delivery_id }]);
  assert.equal(await validate(db, managerRowNow), true);
  const reason = ('410 BadDeviceToken ' + 'x'.repeat(300)).slice(0, 300);
  assert.equal(reason.length, 300);
  const terminal = await recordTerminal(db, managerRowNow, reason);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].terminal_reason, reason, 'the 300 character reason round-trips byte for byte');
  assert.deepEqual(await recordTerminal(db, managerRowNow, reason), []);
  assert.deepEqual(await recordDelivered(db, managerRowNow), [], 'a terminal row cannot become delivered');
  assert.equal((await resultPresent(db, managerRowNow))[0].terminal_reason, reason);
  assert.equal(await validate(db, managerRowNow), false);
  await finishQueue(db, managerRowNow.queue_id);
  const deadTokenId = (await tokens(db, 'token = $1', [managerRowNow.token]))[0].id;
  assert.deepEqual(await deleteStartToken(db, managerRowNow.token), [{ id: deadTokenId }], 'the drainer deletes the dead push_to_start token');
  assert.deepEqual(await claimStarts(db, iso(Date.now() + 3000)), [], 'a dead phone with no token is not re-armed');
  // The manager's phone comes back with a fresh token: a new generation.
  await register(db, MANAGER, 'push_to_start', null, TOKEN.managerStart2, DEVICE.manager);
  const stampD = iso(Date.now() + 4000);
  const claimD = await claimStarts(db, stampD);
  assert.equal(claimD.length, 1);
  assert.equal(claimD[0].delivery_id, managerRow.delivery_id, 'the same receipt row (one per shift and device)');
  assert.equal(claimD[0].generation, 2);
  assert.notEqual(claimD[0].queue_id, managerRow.queue_id, 'a new queue UUID for the new generation');
  assert.equal(claimD[0].token, TOKEN.managerStart2);
  rows = await ledger(db, 'id = $1', [managerRow.delivery_id]);
  assert.equal(rows[0].terminal_at, null);
  assert.equal(rows[0].terminal_reason, null);
  pass('Apple\'s dead-token answer latches terminal_at + terminal_reason exactly once (a second PATCH and a delivered PATCH are no-ops); only a fresh token after that earns generation 2 with a new queue UUID on the same receipt');
  assert.deepEqual(await enqueue(db, claimD[0].queue_id, 'la_start', startQueuePayload(claimD[0], stampD)), [{ id: claimD[0].queue_id }]);
  assert.deepEqual(await completeStart(db, claimD[0], stampD), [{ id: claimD[0].delivery_id }]);
  assert.equal((await recordDelivered(db, claimD[0])).length, 1);
  await finishQueue(db, claimD[0].queue_id);

  // ── the protect trigger: identity immutable, outcomes latched ──
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the ledger refuses a shift_id change (55000)', 'update public.live_activity_start_deliveries set shift_id = $2 where id = $1', [ownerRow.delivery_id, DEVICE.owner], '55000', /identity is immutable/);
  await deniedOn(db, 'the ledger refuses un-latching delivered_at (55000)', 'update public.live_activity_start_deliveries set delivered_at = null where id = $1', [ownerRow.delivery_id], '55000', /outcome is immutable/);
  await deniedOn(db, 'the ledger refuses a bare generation bump (55000)', 'update public.live_activity_start_deliveries set generation = generation + 1 where id = $1', [ownerRow.delivery_id], '55000', /transition is not allowed/);
  await deniedOn(db, 'the ledger refuses a terminal_at without a reason, or beside a delivered_at (23514)', 'update public.live_activity_start_deliveries set terminal_at = now() where id = $1', [ownerRow.delivery_id], '23514', /terminal_check|outcome_check/);
  await deniedOn(db, 'the ledger refuses an upper-case or short token (23514)', 'insert into public.live_activity_start_deliveries (shift_id, device_id, start_token) values ($1, $2, $3)', [shiftA, DEVICE.ownerRegenerated, 'ABCDEF'], '23514', /token_check/);
  await identityOn(db);
  pass('identity and outcome protection holds against the service key too');

  // ── a regenerated device UUID (reinstall) re-homes the receipt ──
  await register(db, OWNER, 'push_to_start', null, TOKEN.ownerStart, DEVICE.ownerRegenerated);
  rows = await ledger(db, 'id = $1', [ownerRow.delivery_id]);
  assert.equal(rows[0].device_id, DEVICE.ownerRegenerated);
  assert.ok(rows[0].delivered_at, 'the outcome survives the re-home');
  assert.deepEqual(await claimStarts(db, iso(Date.now() + 5000)), [], 'no second card for the same phone under a new UUID');
  pass('the same Apple token under a regenerated device UUID moves the receipt (delivered state kept) and never earns a second START');
  await closeShift(db, shiftA);

  // ── eligibility edge cases ──
  // The manager clocks in: the manager's own phone never gets their own card.
  const shiftB = await openShift(db, MANAGER, 'ny', 5);
  const claimE = await claimStarts(db, iso(Date.now() + 6000));
  assert.deepEqual(claimE.map(r => r.email), [OWNER.email]);
  assert.equal(claimE[0].shift_id, shiftB);
  assert.equal(claimE[0].device_id, DEVICE.ownerRegenerated);
  pass('a manager\'s own clock-in reaches the owner phone only, never the manager\'s own phone');
  // A vegas shift: the vegas manager and the owner, not the ny manager.
  const shiftV = await openShift(db, CREW_VEGAS, 'vegas', 4);
  const claimV = await claimStarts(db, iso(Date.now() + 7000));
  assert.deepEqual(claimV.map(r => r.email).sort(), [OWNER.email, VEGAS.email].sort());
  assert.ok(claimV.every(r => r.shift_id === shiftV && r.market === 'vegas'));
  pass('a vegas clock-in reaches the owner and the vegas manager, never the ny manager (market scoping matches partitionRecipients)');
  // A shift with a blank market: managers fail closed, the owner still gets it.
  const shiftBlank = await openShift(db, CREW2, null, 3);
  const claimBlank = await claimStarts(db, iso(Date.now() + 8000));
  assert.deepEqual(claimBlank.map(r => r.email), [OWNER.email]);
  assert.equal(claimBlank[0].market, null);
  pass('a shift with no market reaches the owner only (a manager never matches a blank market)');
  // An App Review shift is never seeded.
  await openShift(db, REVIEW, 'ny', 2);
  assert.deepEqual(await claimStarts(db, iso(Date.now() + 9000)), []);
  pass('an appreview@hamptonscoconuts.com shift never seeds a receipt');
  // A shift older than the 48 hour window is not seeded; an already seeded
  // receipt is still recovered regardless of age.
  const shiftOld = await openShift(db, TEAM, 'ny', 49 * 60);
  assert.deepEqual(await claimStarts(db, iso(Date.now() + 10000)), []);
  assert.equal((await ledger(db, 'shift_id = $1', [shiftOld])).length, 0);
  pass('a shift that clocked in more than 48 hours ago is not seeded');
  await closeShift(db, shiftOld);
  // Inactive or unlinked phones never receive.
  await register(db, STALE, 'push_to_start', null, 'ab'.repeat(32), '70000000-0000-4000-8000-000000000004');
  assert.equal((await tokens(db, 'email = $1', [STALE.email])).length, 0, '015 deletes an inactive manager\'s tokens');
  await asPostgres(db, () => q(db, "insert into public.live_activity_tokens (email, token_type, shift_id, token, device_id) values ($1, 'push_to_start', null, $2, $3)", [STALE.email, 'ab'.repeat(32), '70000000-0000-4000-8000-000000000004']));
  assert.deepEqual(await claimStarts(db, iso(Date.now() + 11000)), []);
  await asPostgres(db, () => q(db, 'delete from public.live_activity_tokens where email = $1', [STALE.email]));
  pass('a push_to_start row for an inactive manager (a leftover the RPC would never write) is never claimed');
  // A role downgrade after queueing: the validator turns false.
  const shiftC = await openShift(db, TEAM, 'ny', 1);
  const stampC = iso(Date.now() + 12000);
  const claimC = await claimStarts(db, stampC);
  const managerC = claimC.find(r => r.email === MANAGER.email);
  assert.ok(managerC && managerC.shift_id === shiftC);
  assert.deepEqual(await enqueue(db, managerC.queue_id, 'la_start', startQueuePayload(managerC, stampC)), [{ id: managerC.queue_id }]);
  assert.deepEqual(await completeStart(db, managerC, stampC), [{ id: managerC.delivery_id }]);
  assert.equal(await validate(db, managerC), true);
  await asPostgres(db, () => q(db, "update public.field_workers set market = 'miami' where id = $1", [ID.manager]));
  assert.equal(await validate(db, managerC), false, 'a manager moved to another market after enqueue is not sent');
  await asPostgres(db, () => q(db, "update public.field_workers set market = 'ny', role = 'team' where id = $1", [ID.manager]));
  assert.equal(await validate(db, managerC), false, 'a downgraded manager is not sent');
  await asPostgres(db, () => q(db, "update public.field_workers set role = 'manager' where id = $1", [ID.manager]));
  assert.equal(await validate(db, managerC), true);
  const ownerC = claimC.find(r => r.email === OWNER.email);
  assert.deepEqual(await enqueue(db, ownerC.queue_id, 'la_start', startQueuePayload(ownerC, stampC)), [{ id: ownerC.queue_id }]);
  assert.deepEqual(await completeStart(db, ownerC, stampC), [{ id: ownerC.delivery_id }]);
  await closeShift(db, shiftC);
  assert.equal(await validate(db, ownerC), false, 'a closed shift is not sent');
  assert.equal(await validate(db, managerC), false);
  // The drainer closes both queue rows as "no longer eligible" without a
  // ledger result; the receipts stay queued forever on a closed shift.
  await finishQueue(db, ownerC.queue_id);
  await finishQueue(db, managerC.queue_id);
  pass('the validator turns false after a market move, a role downgrade and a clock-out (the queue-time race the drainer checks for)');
  // The drainer's 7 day purge cannot delete an la_start row whose receipt
  // never recorded queued_at while the shift is open.
  const shiftD = await openShift(db, TEAM, 'ny', 1);
  const stampD2 = iso(Date.now() + 13000);
  const claimD2 = await claimStarts(db, stampD2);
  const ownerD = claimD2.find(r => r.email === OWNER.email);
  assert.ok(ownerD && ownerD.shift_id === shiftD);
  assert.deepEqual(await enqueue(db, ownerD.queue_id, 'la_start', startQueuePayload(ownerD, stampD2)), [{ id: ownerD.queue_id }]);
  await finishQueue(db, ownerD.queue_id);
  assert.deepEqual(await purgeQueue(db, ownerD.queue_id), [], 'the purge is silently refused while queued_at is unrecorded');
  assert.ok(await queueRow(db, ownerD.queue_id));
  assert.deepEqual(await completeStart(db, ownerD, stampD2), [{ id: ownerD.delivery_id }]);
  assert.deepEqual(await purgeQueue(db, ownerD.queue_id), [{ id: ownerD.queue_id }]);
  pass('the purge guard keeps an la_start queue row until its receipt records queued_at, then lets the 7 day purge through');
  await asPostgres(db, () => q(db, 'update public.live_activity_start_deliveries set delivered_at = now() where id = $1', [ownerD.delivery_id]));
  // Clean the remaining open-shift claims so the END path starts from a
  // quiet ledger: closing a shift clears a pre-close lease on the next claim.
  for (const id of [shiftB, shiftV, shiftBlank, shiftD]) await closeShift(db, id);
  await closeShift(db, (await asPostgres(db, () => scalarOn(db, 'select id as value from public.shifts where worker_email = $1', [REVIEW.email]))));
  await claimStarts(db, iso(Date.now() + 14000));
  assert.equal((await ledger(db, 'claimed_at is not null and queued_at is null')).length, 0, 'closed-shift leases are cleared by the claim');
  pass('closing a shift lets the next claim clear every abandoned pre-close lease');

  // ── the END path ──
  const shiftE = await openShift(db, TEAM, 'ny', 30);
  await register(db, OWNER, 'activity_update', shiftE, TOKEN.ownerUpdate, DEVICE.ownerRegenerated);
  await register(db, MANAGER, 'activity_update', shiftE, TOKEN.managerUpdate, DEVICE.manager);
  assert.deepEqual(await claimEnds(db, iso(Date.now())), [], 'an open shift is never ended');
  await closeShift(db, shiftE);
  const stampE = iso(Date.now());
  const endsE = await claimEnds(db, stampE);
  assert.equal(endsE.length, 2);
  for (const row of endsE) {
    assert.deepEqual(Object.keys(row), END_COLUMNS, 'the END row carries exactly the 7 columns the worker reads');
    assert.equal(row.shift_id, shiftE);
    assert.ok(row.clock_in_at && row.clock_out_at && new Date(row.clock_out_at) > new Date(row.clock_in_at));
    assert.match(row.queue_id, /^[0-9a-f-]{36}$/);
  }
  const ownerEnd = endsE.find(r => r.email === OWNER.email);
  const managerEnd = endsE.find(r => r.email === MANAGER.email);
  assert.equal(ownerEnd.token, TOKEN.ownerUpdate);
  let updRows = await tokens(db, "token_type = 'activity_update'");
  assert.ok(updRows.every(t => seconds(t.end_requested_at, stampE) === 0 && t.end_queue_id));
  assert.equal(updRows.find(t => t.email === OWNER.email).id, ownerEnd.token_id, 'token_id is live_activity_tokens.id');
  assert.deepEqual(await claimEnds(db, iso(Date.now() + 1000)), [], 'a second END claim inside the lease returns nothing');
  pass('after clock-out the END claim leases each update token once, returns token_id, queue_id, email, token, shift_id, clock_in_at, clock_out_at, stamps end_requested_at = p_claimed_at unchanged, and is exclusive');
  // The worker's release when the enqueue definitely failed.
  assert.deepEqual(await releaseEnd(db, managerEnd, stampE), [{ id: managerEnd.token_id }]);
  assert.deepEqual(await releaseEnd(db, managerEnd, stampE), []);
  updRows = await tokens(db, 'id = $1', [managerEnd.token_id]);
  assert.equal(updRows[0].end_requested_at, null);
  assert.equal(updRows[0].end_queue_id, null);
  const stampE2 = iso(Date.now() + 2000);
  const endsE2 = await claimEnds(db, stampE2);
  assert.deepEqual(endsE2.map(r => r.token_id), [managerEnd.token_id], 'the released phone is claimable again at once');
  pass('the worker\'s END release PATCH (id, token, activity_update, shift, end_queue_id, end_requested_at=eq.<stamp>) clears exactly that lease, once');
  // The enqueue, the pending-queue safety, and the drainer's delete.
  const managerEnd2 = endsE2[0];
  assert.deepEqual(await enqueue(db, ownerEnd.queue_id, 'la_end', endQueuePayload(ownerEnd, stampE)), [{ id: ownerEnd.queue_id }]);
  assert.deepEqual(await enqueue(db, managerEnd2.queue_id, 'la_end', endQueuePayload(managerEnd2, stampE2)), [{ id: managerEnd2.queue_id }]);
  const stampLate = iso(Date.now() + 31 * 60000);
  assert.deepEqual(await claimEnds(db, stampLate, { staleBefore: iso(Date.now() + 60000) }), [], 'a stale lease whose queue row is still pending is NOT re-claimed (a long drainer outage stays safe)');
  assert.deepEqual(await deleteEndToken(db, ownerEnd, stampE), [{ id: ownerEnd.token_id }]);
  assert.deepEqual(await deleteEndToken(db, ownerEnd, stampE), []);
  await finishQueue(db, ownerEnd.queue_id);
  pass('the drainer\'s END delete by full identity removes exactly the delivered phone\'s token, once');
  // The drainer exhausts the manager's END (release by full identity) after
  // its queue row closed: the next lease gets a fresh queue id because a
  // completed queue generation is never reopened.
  await finishQueue(db, managerEnd2.queue_id);
  assert.deepEqual(await releaseEnd(db, managerEnd2, stampE2), [{ id: managerEnd2.token_id }]);
  const endsE3 = await claimEnds(db, iso(Date.now() + 3000));
  assert.equal(endsE3.length, 1);
  assert.equal(endsE3[0].token_id, managerEnd2.token_id);
  assert.notEqual(endsE3[0].queue_id, managerEnd2.queue_id);
  pass('the drainer\'s END release by full identity clears the lease, and the next lease takes a fresh queue id (a completed queue generation is never reopened)');
  // The app's re-registration keeps the lease; a rotated token clears it.
  const leasedQueueId = endsE3[0].queue_id;
  await register(db, MANAGER, 'activity_update', shiftE, TOKEN.managerUpdate, DEVICE.manager);
  updRows = await tokens(db, 'id = $1', [managerEnd.token_id]);
  assert.equal(updRows[0].end_queue_id, leasedQueueId, 'the same token re-registered by the phone keeps the worker\'s lease');
  assert.ok(updRows[0].end_requested_at);
  await register(db, MANAGER, 'activity_update', shiftE, 'f1'.repeat(32), DEVICE.manager);
  updRows = await tokens(db, 'id = $1', [managerEnd.token_id]);
  assert.equal(updRows[0].token, 'f1'.repeat(32));
  assert.equal(updRows[0].end_requested_at, null);
  assert.equal(updRows[0].end_queue_id, null);
  pass('an app-style re-registration of the same token preserves the END lease (the phone cannot wipe it) while a rotated token clears it (a new destination needs its own END)');
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  await deniedOn(db, 'a phone cannot write the lease columns directly', 'update public.live_activity_tokens set end_requested_at = now() where id = $1', [managerEnd.token_id]);
  await identityOn(db);

  // ── rollback refuses while anything is in flight ──
  const shiftR = await openShift(db, TEAM, 'ny', 1);
  const stampR = iso(Date.now() + 20000);
  const claimR = await claimStarts(db, stampR);
  const ownerR = claimR.find(r => r.email === OWNER.email);
  const managerR = claimR.find(r => r.email === MANAGER.email);
  assert.ok(ownerR && managerR && ownerR.shift_id === shiftR);
  await refusesOn(db, 'rollback refuses while a START receipt is claimed, not queued and unanswered', rollback, '55000', /claimed, not queued and unanswered/);
  assert.equal(await tableExists(db, 'live_activity_start_deliveries'), true);
  assert.deepEqual(await enqueue(db, ownerR.queue_id, 'la_start', startQueuePayload(ownerR, stampR)), [{ id: ownerR.queue_id }]);
  assert.deepEqual(await completeStart(db, ownerR, stampR), [{ id: ownerR.delivery_id }]);
  assert.deepEqual(await releaseStart(db, managerR, stampR), [{ id: managerR.delivery_id }]);
  await refusesOn(db, 'rollback refuses while a START receipt on an open shift is queued but Apple has not answered', rollback, '55000', /queued but Apple has not answered/);
  assert.equal((await recordDelivered(db, ownerR)).length, 1);
  await refusesOn(db, 'rollback refuses while an open shift still has a START receipt (a re-apply would send a second card)', rollback, '55000', /open shift still has a START receipt/);
  await closeShift(db, shiftR);
  await refusesOn(db, 'rollback refuses while push_queue holds an unfinished la_start row', rollback, '55000', /unfinished la_start or la_end/);
  await finishQueue(db, ownerR.queue_id);
  const stampR2 = iso(Date.now() + 21000);
  const endsR = await claimEnds(db, stampR2);
  assert.equal(endsR.length, 1, 'the rotated manager token of the closed shift E');
  await refusesOn(db, 'rollback refuses while a token row carries an END lease, and its message names the one-transaction set_config recipe', rollback, '55000', /END lease.*set_config\('request\.jwt\.claim\.role', 'service_role', true\)/);
  // ── a hand release from the SQL editor: the editor is not service_role ──
  // auth.role() is null in a plain session (the Supabase SQL editor sends no
  // JWT), so 046's reset trigger silently keeps the lease a plain UPDATE
  // tries to clear, and the rollback keeps refusing. The header's recipe
  // (set_config inside one transaction) is what works.
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select auth.role() as value')), null, 'a plain session has no JWT role, like the SQL editor');
  const plainRelease = await asPostgres(db, () => q(db, 'update public.live_activity_tokens set end_requested_at = null, end_queue_id = null where id = $1', [endsR[0].token_id]));
  assert.equal(plainRelease.affectedRows, 1, 'the UPDATE reports one row');
  updRows = await tokens(db, 'id = $1', [endsR[0].token_id]);
  assert.ok(seconds(updRows[0].end_requested_at, stampR2) === 0 && updRows[0].end_queue_id === endsR[0].queue_id, 'and the lease is still there (silently kept)');
  await refusesOn(db, 'rollback still refuses after the silent hand UPDATE', rollback, '55000', /END lease/);
  await asPostgres(db, () => db.exec("begin; select set_config('request.jwt.claim.role', 'service_role', true); update public.live_activity_tokens set end_requested_at = null, end_queue_id = null where end_requested_at is not null or end_queue_id is not null; commit;"));
  updRows = await tokens(db, 'id = $1', [endsR[0].token_id]);
  assert.equal(updRows[0].end_requested_at, null);
  assert.equal(updRows[0].end_queue_id, null);
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select auth.role() as value')), null, 'the setting died with the transaction');
  pass('a plain UPDATE from the SQL editor cannot release an END lease (the reset trigger keeps it, one row "updated", nothing changed) while the header\'s one-transaction set_config recipe releases it and leaves no role behind');
  // The released phone is leased again by the next tick; carry on with it.
  const stampR3 = iso(Date.now() + 21500);
  const endsR3 = await claimEnds(db, stampR3);
  assert.equal(endsR3.length, 1);
  assert.equal(endsR3[0].token_id, endsR[0].token_id);
  await refusesOn(db, 'rollback refuses while a token row carries an END lease', rollback, '55000', /END lease/);
  assert.deepEqual(await enqueue(db, endsR3[0].queue_id, 'la_end', endQueuePayload(endsR3[0], stampR3)), [{ id: endsR3[0].queue_id }]);
  await refusesOn(db, 'rollback refuses while push_queue holds an unfinished la_end row', rollback, '55000', /unfinished la_start or la_end/);
  await finishQueue(db, endsR3[0].queue_id);
  assert.deepEqual(await deleteEndToken(db, endsR3[0], stampR3), [{ id: endsR3[0].token_id }]);
  assert.equal(await tableExists(db, 'live_activity_start_deliveries'), true);
  assert.equal(await columnType(db, 'live_activity_tokens', 'end_requested_at'), 'timestamp with time zone');
  for (const signature of Object.values(SIGNATURES)) assert.equal(await fnExists(db, signature), true);
  pass('every refused rollback leaves the ledger, the columns and the four functions in place');

  // ── a receipt Apple already answered keeps its lease stamp and never blocks the rollback ──
  // The worker's enqueue POST committed but its response was lost
  // (queued === null in runLiveActivityStartScan): the worker keeps the
  // claim by design. The drainer's validator answers true on a leased
  // receipt, the START goes out, delivered_at lands. claimed_at stays set
  // for good: the claim never revisits a delivered row and the pre-close
  // sweep only runs when the worker ticks after clock-out. The rollback's
  // first check must not read that as an enqueue in flight.
  // Two shifts at once, one claim, then no claim after clock-out (a claim
  // after clock-out is the worker tick that sweeps pre-close leases).
  const shiftU = await openShift(db, TEAM, 'ny', 1);
  const shiftU2 = await openShift(db, CREW2, 'ny', 1);
  const stampU = iso(Date.now() + 22000);
  const claimU = await claimStarts(db, stampU);
  assert.equal(claimU.length, 4, 'owner + ny manager for each of the two shifts');
  const ownerU = claimU.find(r => r.email === OWNER.email && r.shift_id === shiftU);
  const managerU = claimU.find(r => r.email === MANAGER.email && r.shift_id === shiftU);
  assert.ok(ownerU && managerU);
  assert.deepEqual(await enqueue(db, ownerU.queue_id, 'la_start', startQueuePayload(ownerU, stampU)), [{ id: ownerU.queue_id }]);
  // no completeStart: the response was lost, the lease stays
  assert.equal(await validate(db, ownerU), true, 'the drainer sends a leased, unqueued receipt');
  assert.equal((await recordDelivered(db, ownerU)).length, 1);
  await finishQueue(db, ownerU.queue_id);
  // The manager's receipt and shiftU2's two stay claimed and unqueued: the
  // worker died before their INSERTs.
  rows = await ledger(db, 'id = $1', [ownerU.delivery_id]);
  assert.ok(seconds(rows[0].claimed_at, stampU) === 0 && rows[0].queued_at === null && rows[0].delivered_at, 'claimed, never queued, delivered: the shape the worker leaves behind');
  assert.deepEqual(await claimStarts(db, iso(Date.now() + 22500)), [], 'the claim never revisits the delivered receipt (and the three fresh leases hold)');
  await closeShift(db, shiftU);
  await closeShift(db, shiftU2);
  pass('an enqueue whose response was lost leaves a delivered receipt with its lease stamp (claimed_at set, queued_at null, delivered_at set) that no claim revisits');
  // The unanswered pair on the closed shift still refuses, and the
  // message's hand remedy (the worker down) clears exactly that pair.
  await refusesOn(db, 'rollback refuses a claimed, unqueued, unanswered receipt on a closed shift (nothing distinguishes it from an enqueue in flight) and names the hand remedy', rollback, '55000', /claimed, not queued and unanswered.*null claimed_at by hand/);
  assert.equal((await asPostgres(db, () => q(db, 'update public.live_activity_start_deliveries as delivery set claimed_at = null from public.shifts as shift_row where shift_row.id = delivery.shift_id and shift_row.clock_out_at is not null and delivery.queued_at is null and delivery.claimed_at is not null and delivery.delivered_at is null and delivery.terminal_at is null'))).affectedRows, 3, 'the hand remedy from the message (the protect trigger allows a claimed_at change)');
  assert.equal((await ledger(db, 'claimed_at is not null and queued_at is null and delivered_at is null and terminal_at is null')).length, 0);
  assert.equal((await ledger(db, 'claimed_at is not null and queued_at is null and delivered_at is not null')).length, 1, 'the delivered receipt still carries its lease stamp, and only the rollback below proves it does not block');
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.shifts where clock_out_at is null')), 0, 'every sandbox shift is closed');

  // ── rollback, twice, then re-apply ──
  const beforeRollback = await fingerprints(db);
  for (const sql of [rollback, rollback]) await db.exec(sql);
  for (const signature of [...Object.values(SIGNATURES), ...TRIGGER_FUNCTIONS]) assert.equal(await fnExists(db, signature), false, signature);
  assert.equal(await tableExists(db, 'live_activity_start_deliveries'), false);
  assert.equal(await tableExists(db, 'live_activity_tokens_end_request_idx'), false);
  assert.equal(await columnType(db, 'live_activity_tokens', 'end_requested_at'), undefined);
  assert.equal(await columnType(db, 'live_activity_tokens', 'end_queue_id'), undefined);
  for (const index of ['live_activity_tokens_p2s_uniq', 'live_activity_tokens_upd_uniq', 'live_activity_tokens_device_p2s_uidx', 'live_activity_tokens_device_update_uidx']) {
    assert.equal(await tableExists(db, index), true, index);
  }
  assert.deepEqual(await fingerprints(db), beforeRollback);
  assert.deepEqual(await fingerprints(db), before);
  assert.ok((await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.live_activity_tokens'))) > 0, 'token rows survive');
  assert.ok((await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.push_queue'))) > 0, 'queue rows survive');
  assert.deepEqual(await asPostgres(db, () => rowsOn(db, "select policyname from pg_policies where schemaname = 'public' and tablename = 'live_activity_tokens'")), [], 'the rollback does not reopen the anonymous lane');
  assert.equal(await hasTable(db, 'anon', 'live_activity_tokens', 'insert'), false);
  pass('rollback runs twice once everything settled (a delivered receipt still carrying its lease stamp does not block it): functions, triggers, ledger, index and both columns gone; tokens, queue rows, the 010/015 indexes and the auth functions untouched; the anonymous lane stays closed');
  await db.exec(migration);
  for (const signature of Object.values(SIGNATURES)) assert.equal(await fnExists(db, signature), true);
  assert.equal((await ledger(db)).length, 0);
  const shiftZ = await openShift(db, TEAM, 'ny', 1);
  const stampZ = iso(Date.now() + 30000);
  const claimZ = await claimStarts(db, stampZ);
  assert.deepEqual(claimZ.map(r => r.email).sort(), [MANAGER.email, OWNER.email].sort());
  assert.ok(claimZ.every(r => r.shift_id === shiftZ));
  assert.deepEqual(await fingerprints(db), before);
  pass('re-apply after rollback starts with an empty ledger and claims again; the auth functions are still byte-identical');

  // ── the droplet probe's shape (partials-2026-09-14/verify046.py) is harmless ──
  // Dated 47 hours back with a 48 hour window: it never touches a live
  // worker lease, and any lease it takes is already stale for the worker.
  const probe = () => claimStarts(db, iso(Date.now() - 47 * 3600000), { staleBefore: iso(Date.now() - 48 * 3600000), startedAfter: iso(Date.now() - 48 * 3600000), limit: 1 });
  const probeEnds = () => claimEnds(db, iso(Date.now() - 47 * 3600000), { staleBefore: iso(Date.now() - 48 * 3600000), limit: 1 });
  assert.deepEqual(await probe(), [], 'the probe leaves the worker\'s fresh leases alone');
  assert.deepEqual(await probeEnds(), []);
  const ownerZ = claimZ.find(r => r.email === OWNER.email);
  assert.deepEqual(await releaseStart(db, ownerZ, stampZ), [{ id: ownerZ.delivery_id }]);
  const probed = await probe();
  assert.equal(probed.length, 1);
  assert.equal(probed[0].delivery_id, ownerZ.delivery_id);
  const reclaimZ = await claimStarts(db, iso(Date.now() + 31000));
  assert.deepEqual(reclaimZ.map(r => r.delivery_id), [ownerZ.delivery_id], 'the worker\'s next tick re-claims what the probe leased');
  assert.equal(reclaimZ[0].queue_id, ownerZ.queue_id);
  pass('the verify046.py probe shape (claim dated 47 h back, 48 h window, p_limit 1) never steals a live lease and anything it leases is re-claimed by the worker on its next tick');

  // ── PAUSE WITHOUT ROLLBACK: the emergency lever both headers name ──
  // shiftZ is open and holds two leased receipts, so the rollback refuses.
  // Revoking execute on the three claims from service_role stops the
  // worker's scans on their next tick (a non-404 error returns without
  // falling back), leaves the drainer's validator answering for rows
  // already leased or queued, touches no receipt, and the matching grant
  // or a 046 re-run (section H) resumes.
  const PAUSE_SQL = 'revoke execute on function public.hc_claim_live_activity_starts_v2(timestamptz, timestamptz, timestamptz, integer), public.hc_claim_live_activity_starts(timestamptz, timestamptz, timestamptz, integer), public.hc_claim_live_activity_ends(timestamptz, timestamptz, integer) from service_role;';
  const RESUME_SQL = PAUSE_SQL.replace('revoke execute', 'grant execute').replace('from service_role', 'to service_role');
  const CLAIM_SIGNATURES = [SIGNATURES.v2, SIGNATURES.plain, SIGNATURES.ends];
  await refusesOn(db, 'the rollback refuses while shiftZ is open with leased receipts, so mid-shift the lever is the only option', rollback, '55000', /046 rollback refuses/);
  const receiptsZ = await ledger(db, 'shift_id = $1', [shiftZ]);
  assert.equal(receiptsZ.length, 2);
  await db.exec(PAUSE_SQL);
  for (const signature of CLAIM_SIGNATURES) assert.equal(await hasExecute(db, 'service_role', signature), false, signature);
  assert.equal(await hasExecute(db, 'service_role', SIGNATURES.validate), true, 'the validator keeps its grant');
  const stampP = iso(Date.now() + 40000);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'paused: the worker\'s v2 START claim is 42501 (a non-404 the worker returns on without falling back)', START_SQL, [stampP, iso(Date.now() - 1800000), iso(Date.now() - 48 * 3600000), 50]);
  await deniedOn(db, 'paused: the plain START claim is 42501 too', START_PLAIN_SQL, [stampP, iso(Date.now() - 1800000), iso(Date.now() - 48 * 3600000), 50]);
  await deniedOn(db, 'paused: the END claim is 42501', END_SQL, [stampP, iso(Date.now() - 1800000), 50]);
  await identityOn(db);
  assert.equal(await validate(db, reclaimZ[0]), true, 'the drainer\'s validator still says yes for the leased receipt on the open shift');
  assert.deepEqual(await ledger(db, 'shift_id = $1', [shiftZ]), receiptsZ, 'no receipt changed while paused');
  await db.exec(RESUME_SQL);
  for (const signature of CLAIM_SIGNATURES) assert.equal(await hasExecute(db, 'service_role', signature), true, signature);
  assert.ok(Array.isArray(await claimStarts(db, iso(Date.now() + 41000))), 'the matching grant resumes the START claim');
  assert.ok(Array.isArray(await claimEnds(db, iso(Date.now() + 41000))), 'and the END claim');
  await db.exec(PAUSE_SQL);
  await identityOn(db, { role: 'service_role' });
  await assert.rejects(q(db, END_SQL, [stampP, iso(Date.now() - 1800000), 50]), error => error.code === '42501', 'paused again');
  await identityOn(db);
  await db.exec(migration);
  for (const signature of CLAIM_SIGNATURES) assert.equal(await hasExecute(db, 'service_role', signature), true, signature);
  assert.ok(Array.isArray(await claimStarts(db, iso(Date.now() + 42000))), 'a 046 re-run re-grants (section H) and resumes as well');
  assert.deepEqual(await ledger(db, 'shift_id = $1', [shiftZ]), receiptsZ, 'still no receipt changed');
  pass('PAUSE WITHOUT ROLLBACK: revoking execute on the three claims from service_role stops every claim within one tick, leaves the validator and every receipt alone, and the matching grant or a 046 re-run resumes; the rollback stays refused while the shift is open');

  // ── the 015c branch: the two 015c functions are untouched too ──
  const bridged = await productionShaped({ with015c: true });
  handles.push(bridged);
  const bridgedBefore = await fingerprints(bridged);
  assert.deepEqual(Object.keys(bridgedBefore).sort(), [...AUTH_SIGNATURES].sort(), 'all five auth functions present with 015c');
  await bridged.exec(migration);
  assert.deepEqual(await fingerprints(bridged), bridgedBefore);
  pass('on a branch with 015c (PostgreSQL 18 shim), 046 applies and hc_authorize_notification_device and hc_list_managed_open_shift_ids are byte-identical as well');
  // The trap the never-run note is about: after 046, 025 as written applies
  // with no error and replaces the claim with a copy bound to its own helper
  // (and rewrites the shift policies). Demonstrated on this branch only.
  await bridged.exec(migration025);
  assert.equal(await fnExists(bridged, 'public.hc_management_can_access_shift_market(text,text,text)'), true);
  pass('THE TRAP DEMONSTRATED: once 046 exists, 025\'s preflight passes and 025 installs its helper and policy rewrites with no error; 025 must never run (record it beside 016/017/022)');
  // 018 as written still refuses after 046: the anon policies it checked
  // first are gone now, so it trips on authenticated's default select grant
  // (015 left it; 016 would have revoked it).
  const guard018 = await productionShaped();
  handles.push(guard018);
  await guard018.exec(migration);
  await refusesOn(guard018, '018 as written still refuses after 046 (authenticated keeps 015\'s select grant on the token table), so it cannot silently replace the market-scoped claim today', migration018, '42501', /client role retains direct live_activity_tokens SELECT/);
  // Authenticated's remaining Supabase default grants on the token table
  // (select, truncate, references, trigger: 015:561 revoked only insert,
  // update and delete, and 018 names select first) are the ONLY barrier
  // left: 018's registration-RPC regex already matches 015's body, and
  // every object it creates is create-or-replace or if-not-exists. Take
  // them away with 016:563's own text (a 020-style cleanup) and 018 as
  // written installs over 046 with no error, replacing the market-scoped
  // claim and validator with its unscoped copies: a Vegas manager is then
  // seeded for a NY crew shift, a card the worker's partitionRecipients
  // would refuse to update. 018 must be retired as written before those
  // grants are ever touched.
  await register(guard018, OWNER, 'push_to_start', null, TOKEN.ownerStart, DEVICE.owner);
  await register(guard018, VEGAS, 'push_to_start', null, TOKEN.vegasStart, DEVICE.vegas);
  await openShift(guard018, TEAM, 'ny', 2);
  const claimB1 = await claimStarts(guard018, iso(Date.now()));
  assert.deepEqual(claimB1.map(r => r.email), [OWNER.email], '046: the Vegas manager is not seeded for a NY shift');
  await guard018.exec('revoke select on table public.live_activity_tokens from authenticated;');
  await refusesOn(guard018, 'with select alone revoked 018 still refuses, on the next default grant (truncate): the barrier is the whole default set, not select', migration018, '42501', /client role retains direct live_activity_tokens TRUNCATE/);
  await guard018.exec('revoke all on table public.live_activity_tokens from authenticated;');
  await guard018.exec(migration018);
  assert.equal(await fnExists(guard018, SIGNATURES.plain), true);
  assert.equal(await fnExists(guard018, SIGNATURES.v2), true, '046\'s wrapper survives and now calls 018\'s body');
  const shiftB2 = await openShift(guard018, CREW2, 'ny', 1);
  const claimB2 = await claimStarts(guard018, iso(Date.now() + 1000));
  assert.ok(claimB2.some(r => r.email === VEGAS.email && r.shift_id === shiftB2), '018 seeded the Vegas manager for the NY shift through the worker\'s v2 call');
  pass('THE SECOND TRAP DEMONSTRATED: revoke all on live_activity_tokens from authenticated (its remaining default grants are the only thing still stopping 018) and 018 as written installs over 046 with no error, replacing the market-scoped claim with its unscoped copy (a Vegas manager is seeded for a NY crew shift); retire 018 as written before those grants are touched');

  // ── preflight guards on an unexpected shape ──
  const guard = await productionShaped({ skip: ['041_team_alert_push_tokens'] });
  handles.push(guard);
  await refusesOn(guard, '046 refuses when 041 (notification_team_push_state + the team branch) is absent', migration, '55000', /requires migration 041/);
  assert.equal(await columnType(guard, 'live_activity_tokens', 'end_requested_at'), undefined, 'nothing was added');
  assert.equal(await tableExists(guard, 'live_activity_start_deliveries'), false);
  const guard1 = await productionShaped();
  handles.push(guard1);
  await guard1.exec(`create or replace function public.hc_sync_notification_device(p_device_id uuid, p_apns_token text, p_push_allowed boolean, p_live_supported boolean)
    returns void language plpgsql security definer set search_path = '' as $f$ begin return; end $f$;`);
  await refusesOn(guard1, '046 refuses when hc_sync_notification_device lacks the 041 team branch (a 016/017/022 rewrite happened)', migration, '55000', /does not carry the team branch/);
  const guard2 = await productionShaped();
  handles.push(guard2);
  await guard2.exec("create function public.hc_enforce_notification_destination_authorization() returns trigger language plpgsql as $f$ begin return new; end $f$;");
  await refusesOn(guard2, "046 refuses when 022's trigger function pre-exists", migration, '55000', /migration 022 is installed/);
  await guard2.exec('drop function public.hc_enforce_notification_destination_authorization();');
  await guard2.exec("create function public.hc_sync_notification_device_pre_mfa_028(uuid, text, boolean, boolean) returns void language sql as $f$ select null::void $f$;");
  await refusesOn(guard2, "046 refuses when 028's renamed function pre-exists", migration, '55000', /migration 028 is installed/);
  await guard2.exec('drop function public.hc_sync_notification_device_pre_mfa_028(uuid, text, boolean, boolean);');
  await guard2.exec('revoke execute on function public.hc_register_live_activity_token(text, uuid, text, uuid, boolean) from authenticated;');
  await refusesOn(guard2, '046 refuses when the 015 registration RPC is no longer hardened', migration, '55000', /hardened migration-015 RPC/);
  const guard3 = await productionShaped();
  handles.push(guard3);
  await guard3.exec('alter table public.live_activity_tokens add column end_requested_at text;');
  await refusesOn(guard3, '046 refuses a pre-existing end_requested_at that is not a timestamptz', migration, '55000', /end_requested_at of type text/);
  const guard4 = await productionShaped();
  handles.push(guard4);
  await guard4.exec('alter table public.live_activity_tokens add column end_queue_id text;');
  await refusesOn(guard4, '046 refuses a pre-existing end_queue_id that is not a uuid', migration, '55000', /end_queue_id of type text/);
  const guard5 = await productionShaped();
  handles.push(guard5);
  await guard5.exec('create table public.live_activity_start_deliveries (id int primary key);');
  await refusesOn(guard5, '046 refuses a foreign live_activity_start_deliveries with the wrong columns', migration, '55000', /refuses an existing public.live_activity_start_deliveries/);
  const guard6 = await productionShaped();
  handles.push(guard6);
  await guard6.exec(`insert into public.push_queue (id, kind, payload) values ('${DEVICE.owner}', 'la_start', '{"tokens": ["${TOKEN.ownerStart}"]}'::jsonb);`);
  await refusesOn(guard6, '046 refuses a first install while push_queue holds an unfinished la_start row', migration, '55000', /drain every unfinished la_start/);
  assert.equal(await tableExists(guard6, 'live_activity_start_deliveries'), false);
  await guard6.exec('update public.push_queue set done_at = now();');
  await guard6.exec(migration);
  pass('a finished la_start row does not block the install');
  const guard7 = await productionShaped();
  handles.push(guard7);
  await guard7.exec('drop index public.live_activity_tokens_device_p2s_uidx;');
  await refusesOn(guard7, '046 refuses when the 015 device push-to-start index is missing', migration, '55000', /live_activity_tokens_device_p2s_uidx/);
  const guard8 = await productionShaped();
  handles.push(guard8);
  await guard8.exec('alter table public.push_queue drop column outbox_type;');
  await refusesOn(guard8, '046 refuses when a column it reads is missing (push_queue.outbox_type from 027)', migration, '55000', /push_queue\.outbox_type/);
  // A phone older than the 2026-08-25 secure-auth build writes token rows
  // with the anon key and no device_id. One written within 7 days means
  // that phone is alive: 046 refuses and names the lane, rather than
  // cutting the phone off silently.
  const guard9 = await productionShaped();
  handles.push(guard9);
  const LEGACY_SQL = "insert into public.live_activity_tokens (email, token_type, shift_id, token, updated_at) values ($1, 'push_to_start', null, $2, now() - ($3::int * interval '1 day'))";
  await identityOn(guard9, { role: 'anon' });
  await guard9.query(LEGACY_SQL, [OWNER.email, 'ab'.repeat(32), 1]);
  await identityOn(guard9);
  const legacyRows = h => asPostgres(h, () => scalarOn(h, 'select count(*)::int as value from public.live_activity_tokens where device_id is null'));
  assert.equal(await legacyRows(guard9), 1, 'the 010 anon lane still takes a no-device row before 046');
  await refusesOn(guard9, '046 refuses while a no-device token row (a pre-2026-08-25 phone on the anonymous lane) was written within 7 days', migration, '55000', /anonymous lane this file closes/);
  assert.equal(await tableExists(guard9, 'live_activity_start_deliveries'), false, 'nothing was added');
  assert.equal(await hasTable(guard9, 'anon', 'live_activity_tokens', 'insert'), true, 'the lane is still open (the whole file rolled back)');
  await guard9.exec("update public.live_activity_tokens set updated_at = now() - interval '8 days' where device_id is null;");
  await guard9.exec(migration);
  assert.equal(await legacyRows(guard9), 1, 'an old legacy row is left alone (046 deletes no token row)');
  assert.equal(await hasTable(guard9, 'anon', 'live_activity_tokens', 'insert'), false, 'and the lane is closed');
  await identityOn(guard9, { role: 'anon' });
  await deniedOn(guard9, 'after the close that legacy phone\'s next write is refused (42501) instead of landing', LEGACY_SQL, [MANAGER.email, 'ac'.repeat(32), 0]);
  await identityOn(guard9);
  // A re-run never trips on a no-device row once the lane is closed: the
  // check only runs while the 010 policies still exist.
  await guard9.query(LEGACY_SQL, [MANAGER.email, 'ac'.repeat(32), 0]);
  await guard9.exec(migration);
  assert.deepEqual(await claimStarts(guard9, iso(Date.now())), [], 'no shift, nothing claimed; a no-device row is never a recipient anyway');
  pass('a legacy no-device row older than 7 days does not block 046, survives it, and once the lane is closed a re-run ignores even a fresh one');
  const guard10 = await productionShaped();
  handles.push(guard10);
  await guard10.exec('grant insert on table public.live_activity_tokens to authenticated;');
  await refusesOn(guard10, '046 refuses when authenticated got a direct token write back (015\'s revoke undone: a crew phone could plant a row for the owner\'s email)', migration, '55000', /authenticated must hold no direct insert, update or delete/);
  // A stray column-level grant to anon is cleared too (016:683-717's rule),
  // so the closed lane cannot leak through a column.
  const guard11 = await productionShaped();
  handles.push(guard11);
  await guard11.exec('grant select (email, token), update (token) on table public.live_activity_tokens to anon;');
  assert.equal(await asPostgres(guard11, () => scalarOn(guard11, "select has_any_column_privilege('anon', 'public.live_activity_tokens', 'update') as value")), true);
  await guard11.exec(migration);
  for (const priv of ['select', 'insert', 'update', 'references']) {
    assert.equal(await asPostgres(guard11, () => scalarOn(guard11, "select has_any_column_privilege('anon', 'public.live_activity_tokens', $1) as value", [priv])), false, `anon column ${priv}`);
  }
  await identityOn(guard11, { role: 'anon' });
  await deniedOn(guard11, 'after 046 the column-granted anon UPDATE of token is refused too (42501)', 'update public.live_activity_tokens set token = $1', ['ee'.repeat(32)]);
  await identityOn(guard11);
  pass('a stray column-level grant to anon on live_activity_tokens is cleared by 046 along with the table grants');

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the worker\'s fetch loop, the droplet drainer\'s APNs calls, the phone UI, or concurrent connections; 015c runs under the PostgreSQL 18 shim on its own branch only.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
