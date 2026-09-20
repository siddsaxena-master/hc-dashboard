// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-047-passed-leads-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/047_passed_leads.sql (the owner marks a lead passed
// from its Calendar card with a reason: orders.passed, hc_mark_order_passed,
// hc_reopen_passed_order) and its rollback on the shape production is in on
// 2026-09-19: the 001-013 base chain, 015, 015b, 019, 024, 026, 027, 029,
// 034-038 and 040-046 (015c and 030 are live too but refuse to apply on this
// sandbox, so they are not reproduced here). Real migration files are
// executed as written and never rewritten on disk. Every order, lead,
// competitor and person here is fake.
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
  '044_order_reconfirmations', '045_order_address_proposals', '046_live_activity_claims',
];
const [supabaseBootstrap, ordersBaseline, migration, rollback] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/047_passed_leads.sql'),
  read('migrations/047_passed_leads_rollback.sql'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));
assert.ok(!/[\u2013\u2014]/.test(migration + rollback), 'no em or en dashes in the 047 files');
// Sidd's word for a lead that went elsewhere is passed (2026-09-19). The
// files never use the word he rejected; the pattern spells it without
// writing it.
assert.ok(!/\bl[o]st\b/i.test(migration + rollback), 'the 047 files say passed, never the rejected word');

const OWNER = { authUserId: '00000000-0000-4000-8000-000000000001', email: 'siddsaxena@gmail.com' };
const MANAGER = { authUserId: '20000000-0000-4000-8000-000000000002', email: 'manager@example.invalid' };
const TEAM = { authUserId: '20000000-0000-4000-8000-000000000003', email: 'team@example.invalid' };
const STALE = { authUserId: '20000000-0000-4000-8000-000000000004', email: 'exmanager@example.invalid' };
const ID = {
  manager: '10000000-0000-4000-8000-000000000002',
  team: '10000000-0000-4000-8000-000000000003',
  stale: '10000000-0000-4000-8000-000000000004',
};
const ORDER = {
  // The headline case: a quoted lead that went with Cocolux on price.
  carvalho: '30000000-0000-4000-8000-000000000001',
  // An inquiry that went quiet.
  quiet: '30000000-0000-4000-8000-000000000002',
  // Not leads: refused whatever the reason.
  invoiced: '30000000-0000-4000-8000-000000000003',
  deposit: '30000000-0000-4000-8000-000000000004',
  complete: '30000000-0000-4000-8000-000000000005',
  // Cancelled by hand before 047 (never passed): a plain cancelled order.
  handCancelled: '30000000-0000-4000-8000-000000000006',
  // Spare leads for the length checks, the reopen paths and the rollback.
  lengths: '30000000-0000-4000-8000-000000000007',
  movedOn: '30000000-0000-4000-8000-000000000008',
  blocker: '30000000-0000-4000-8000-000000000009',
  lastMonth: '30000000-0000-4000-8000-000000000010',
};
const REASONS = ['price', 'competitor', 'timing', 'no_reply', 'event_cancelled', 'other'];

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
  ('${STALE.authUserId}', '${STALE.email}', '2026-01-04T00:00:00Z');
insert into public.field_workers (id, email, name, market, role, active, hourly_rate_cents) values
  ('${ID.manager}', '${MANAGER.email}', 'Sandbox Manager', 'ny', 'manager', true, 1900),
  ('${ID.team}', '${TEAM.email}', 'Sandbox Team', 'ny', 'team', true, 1800),
  ('${ID.stale}', '${STALE.email}', 'Sandbox Ex-manager', 'ny', 'manager', false, null);
insert into public.orders (id, client_name, client_email, venue, event_start_at, stage, market, coconuts_qty, external_invoice_id, deposit_cents, balance_cents, cancelled_at, cancelled_reason, notes) values
  ('${ORDER.carvalho}', 'Fake Carvalho', 'fake.carvalho@example.invalid', 'Fake Vineyard', '2026-10-03T20:00:00Z', 'quoted', 'ny', 120, null, 0, null, null, null, 'asked for 120 branded'),
  ('${ORDER.quiet}', 'Fake Quiet', 'fake.quiet@example.invalid', null, '2026-10-10T18:00:00Z', 'inquiry', 'ny', null, null, 0, null, null, null, null),
  ('${ORDER.invoiced}', 'Fake Invoiced', 'fake.invoiced@example.invalid', 'Fake Pier', '2026-10-04T18:00:00Z', 'invoiced', 'ny', 50, 'FAKE-2201', 0, 50000, null, null, null),
  ('${ORDER.deposit}', 'Fake Deposit', 'fake.deposit@example.invalid', 'Fake Pier', '2026-10-05T18:00:00Z', 'deposit_paid', 'ny', 50, 'FAKE-2202', 25000, 25000, null, null, null),
  ('${ORDER.complete}', 'Fake Complete', 'fake.complete@example.invalid', 'Fake Pier', '2026-08-05T18:00:00Z', 'complete', 'ny', 50, 'FAKE-2203', 0, 0, null, null, null),
  ('${ORDER.handCancelled}', 'Fake Hand Cancelled', 'fake.hand@example.invalid', 'Fake Pier', '2026-10-06T18:00:00Z', 'cancelled', 'ny', 50, 'FAKE-2204', 0, 0, '2026-09-01T12:00:00Z', 'client cancelled the event', null),
  ('${ORDER.lengths}', 'Fake Lengths', 'fake.lengths@example.invalid', null, '2026-10-11T18:00:00Z', 'quoted', 'ny', 80, null, 0, null, null, null, null),
  ('${ORDER.movedOn}', 'Fake Moved On', 'fake.moved@example.invalid', null, '2026-10-12T18:00:00Z', 'inquiry', 'ny', 30, null, 0, null, null, null, null),
  ('${ORDER.blocker}', 'Fake Blocker', 'fake.blocker@example.invalid', null, '2026-10-13T18:00:00Z', 'quoted', 'ny', 40, null, 0, null, null, null, null),
  ('${ORDER.lastMonth}', 'Fake Last Month', 'fake.lastmonth@example.invalid', null, '2026-10-14T18:00:00Z', 'quoted', 'vegas', 40, null, 0, null, null, null, null);`;

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
// The phone's two calls (POST rpc/hc_mark_order_passed and
// rpc/hc_reopen_passed_order through sb()), as SQL with the same parameter
// names PostgREST would match.
const MARK_SQL = 'select public.hc_mark_order_passed(p_order_id => $1, p_reason => $2, p_competitor => $3, p_note => $4) as value';
const REOPEN_SQL = 'select public.hc_reopen_passed_order(p_order_id => $1) as value';
async function markAs(h, who, orderId, reason, competitor = null, note = null) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  try { return await scalarOn(h, MARK_SQL, [orderId, reason, competitor, note]); } finally { await identityOn(h); }
}
async function reopenAs(h, who, orderId) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  try { return await scalarOn(h, REOPEN_SQL, [orderId]); } finally { await identityOn(h); }
}
const orderOf = (h, orderId) => asPostgres(h, async () => (await rowsOn(h,
  'select to_jsonb(o) as value from public.orders as o where o.id = $1', [orderId]))[0]?.value);
// The row with the columns the mark and the reopen are allowed to change
// taken out, so "nothing else moved" is one deepEqual.
const MOVING = ['stage', 'cancelled_at', 'cancelled_reason', 'passed', 'updated_at'];
const stillOf = row => Object.fromEntries(Object.entries(row).filter(([key]) => !MOVING.includes(key)));
const fnCount = (h, name) => scalarOn(h, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [name]);
const columnType = h => scalarOn(h,
  "select format_type(atttypid, atttypmod) as value from pg_attribute where attrelid = 'public.orders'::regclass and attname = 'passed' and attnum > 0 and not attisdropped");
const checkDef = h => scalarOn(h,
  "select pg_get_constraintdef(c.oid) as value from pg_constraint as c where c.conrelid = 'public.orders'::regclass and c.conname = 'orders_passed_check'");
const indexExists = h => scalarOn(h, "select to_regclass('public.orders_passed_at_idx') is not null as value");
const canExecute = (h, role, signature) => scalarOn(h, 'select has_function_privilege($1, $2, $3) as value', [role, signature, 'execute']);
const seconds = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MARK_SIG = 'public.hc_mark_order_passed(uuid, text, text, text)';
const REOPEN_SIG = 'public.hc_reopen_passed_order(uuid)';
// A passed record the way the function writes it, for the direct check
// constraint probes with the service key.
const record = (fields = {}) => JSON.stringify({
  reason: 'price', competitor: 'Cocolux', note: null, at: '2026-09-19T14:05:00.000Z',
  by: OWNER.authUserId, prior_stage: 'quoted', ...fields,
});

async function productionShaped(options = {}) {
  const { skip = [] } = options;
  const h = await PGlite.create({ extensions: { pgcrypto } });
  await h.exec(supabaseBootstrap);
  await h.exec(STORAGE_STUB);
  await h.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await h.exec(baseFiles[name]);
  await h.exec(SEED);
  for (const name of APPLIED_CHAIN) if (!skip.includes(name)) await h.exec(baseFiles[name]);
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
    'select id, email, name, role, active from public.field_workers where lower(email) = $1', [OWNER.email]))[0]);
  assert.ok(owner && owner.role === 'owner' && owner.active === true, 'the bootstrap must carry the owner row');
  ID.owner = owner.id;
  // The sandbox stage check has the in-list shape the preflight looks for.
  const stageDef = await scalarOn(db,
    "select pg_get_constraintdef(c.oid) as value from pg_constraint as c where c.conrelid = 'public.orders'::regclass and c.conname = 'orders_stage_check'");
  assert.ok(stageDef && /\(stage(::text)? = ANY/.test(stageDef) && stageDef.includes("'cancelled'"), stageDef);

  // ── before 047: no column, no functions ──
  assert.equal(await columnType(db), undefined);
  assert.equal(await fnCount(db, 'hc_mark_order_passed'), 0);
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'before 047 the phone\'s mark call fails with function does not exist (PostgREST 404 PGRST202)', MARK_SQL, [ORDER.carvalho, 'price', 'Cocolux', null], '42883');
  await identityOn(db);
  const carvalhoBefore = await orderOf(db, ORDER.carvalho);
  assert.equal(carvalhoBefore.stage, 'quoted');
  assert.equal(carvalhoBefore.cancelled_at, null);

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await columnType(db), 'jsonb');
  assert.equal(await fnCount(db, 'hc_mark_order_passed'), 1);
  assert.equal(await fnCount(db, 'hc_reopen_passed_order'), 1);
  assert.equal(await indexExists(db), true);
  const def047 = await checkDef(db);
  for (const word of [...REASONS, 'prior_stage', 'inquiry', 'quoted']) assert.ok(def047.includes(word), 'the check names ' + word);
  assert.equal((await orderOf(db, ORDER.carvalho)).passed, null, 'every existing row reads null');
  assert.deepEqual(stillOf(await orderOf(db, ORDER.carvalho)), stillOf(carvalhoBefore));
  pass('047 applies twice on the production-shaped chain (001-013, 015, 015b, 019, 024, 026, 027, 029, 034-038, 040-046): jsonb column, check, index, two functions');

  // ── grants: authenticated only ──
  for (const signature of [MARK_SIG, REOPEN_SIG]) {
    assert.equal(await canExecute(db, 'authenticated', signature), true, signature + ' for authenticated');
    assert.equal(await canExecute(db, 'anon', signature), false, signature + ' not for anon');
    assert.equal(await canExecute(db, 'service_role', signature), false, signature + ' not for service_role');
    assert.equal(await canExecute(db, 'public', signature), false, signature + ' not for public');
  }
  pass('execute on both functions: authenticated yes; anon, service_role and public no');

  // ── owner marks a quoted lead passed: price, Cocolux ──
  let out = await markAs(db, OWNER, ORDER.carvalho, 'price', 'Cocolux', 'cheaper price with Cocolux');
  assert.equal(out.applied, true);
  assert.equal(out.row.id, ORDER.carvalho);
  assert.equal(out.row.stage, 'cancelled');
  let row = await orderOf(db, ORDER.carvalho);
  assert.equal(row.stage, 'cancelled');
  assert.ok(seconds(row.cancelled_at, Date.now()) < 60, 'cancelled_at is now');
  assert.equal(row.cancelled_reason, 'passed: price, Cocolux');
  assert.equal(row.passed.reason, 'price');
  assert.equal(row.passed.competitor, 'Cocolux');
  assert.equal(row.passed.note, 'cheaper price with Cocolux');
  assert.equal(row.passed.prior_stage, 'quoted');
  assert.equal(row.passed.by, OWNER.authUserId);
  assert.ok(ISO_UTC.test(row.passed.at), 'at is ISO 8601 UTC text: ' + row.passed.at);
  assert.ok(seconds(row.passed.at, Date.now()) < 60, 'at is now');
  assert.ok(seconds(row.passed.at, row.cancelled_at) < 1, 'at and cancelled_at are the same instant (at is cut to milliseconds)');
  assert.deepEqual(Object.keys(row.passed).sort(), ['at', 'by', 'competitor', 'note', 'prior_stage', 'reason']);
  assert.deepEqual(stillOf(row), stillOf(carvalhoBefore), 'nothing else on the row moved');
  assert.ok(new Date(row.updated_at).getTime() > new Date(carvalhoBefore.updated_at).getTime(), 'updated_at bumped');
  pass('owner marks a quoted lead passed (price, Cocolux): stage cancelled, cancelled_at now, cancelled_reason "passed: price, Cocolux", passed {reason, competitor, note, at, by, prior_stage quoted}');

  // ── an inquiry too, with no competitor and no note ──
  const quietBefore = await orderOf(db, ORDER.quiet);
  out = await markAs(db, OWNER, ORDER.quiet, 'no_reply');
  assert.equal(out.applied, true);
  row = await orderOf(db, ORDER.quiet);
  assert.equal(row.stage, 'cancelled');
  assert.equal(row.cancelled_reason, 'passed: no_reply');
  assert.equal(row.passed.reason, 'no_reply');
  assert.equal(row.passed.competitor, null);
  assert.equal(row.passed.note, null);
  assert.equal(row.passed.prior_stage, 'inquiry');
  assert.deepEqual(stillOf(row), stillOf(quietBefore));
  pass('owner marks an inquiry passed (no reply): cancelled_reason "passed: no_reply", competitor and note null, prior_stage inquiry');

  // ── a second mark answers applied false and rewrites nothing ──
  const carvalhoPassed = await orderOf(db, ORDER.carvalho);
  out = await markAs(db, OWNER, ORDER.carvalho, 'competitor', 'Windansea', 'a different story');
  assert.equal(out.applied, false);
  assert.equal(out.message, 'Already marked passed.');
  assert.equal(out.row.passed.competitor, 'Cocolux');
  assert.deepEqual(await orderOf(db, ORDER.carvalho), carvalhoPassed, 'a second tap rewrites nothing, updated_at included');
  pass('a second mark on a passed lead answers applied false, "Already marked passed.", and rewrites nothing');

  // ── who may call ──
  const lengthsBefore = await orderOf(db, ORDER.lengths);
  for (const [label, who] of [['a manager', MANAGER], ['a team member', TEAM], ['an inactive login', STALE]]) {
    await identityOn(db, { role: 'authenticated', sub: who.authUserId });
    await deniedOn(db, `${label} cannot mark a lead passed`, MARK_SQL, [ORDER.lengths, 'price', null, null], '42501', /only the owner/);
    await deniedOn(db, `${label} cannot reopen a passed lead`, REOPEN_SQL, [ORDER.carvalho], '42501', /only the owner/);
  }
  await identityOn(db, { role: 'authenticated' });
  await deniedOn(db, 'a login with no auth uid cannot mark', MARK_SQL, [ORDER.lengths, 'price', null, null], '42501', /authenticated field worker required/);
  await deniedOn(db, 'a login with no auth uid cannot reopen', REOPEN_SQL, [ORDER.carvalho], '42501', /authenticated field worker required/);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot even call the mark function', MARK_SQL, [ORDER.lengths, 'price', null, null], '42501', /permission denied for function/);
  await deniedOn(db, 'anon cannot even call the reopen function', REOPEN_SQL, [ORDER.carvalho], '42501', /permission denied for function/);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the service key cannot call the mark function (execute revoked)', MARK_SQL, [ORDER.lengths, 'price', null, null], '42501', /permission denied for function/);
  await deniedOn(db, 'the service key cannot call the reopen function (execute revoked)', REOPEN_SQL, [ORDER.carvalho], '42501', /permission denied for function/);
  await identityOn(db);
  assert.deepEqual(await orderOf(db, ORDER.lengths), lengthsBefore);
  assert.deepEqual(await orderOf(db, ORDER.carvalho), carvalhoPassed);
  pass('refused callers never touch the order');

  // ── not a lead: refused 22023, the row untouched ──
  for (const [label, id] of [['an invoiced order', ORDER.invoiced], ['a deposit-paid order', ORDER.deposit], ['a complete order', ORDER.complete], ['an order cancelled by hand (never passed)', ORDER.handCancelled]]) {
    const before = await orderOf(db, id);
    await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
    await deniedOn(db, `${label} cannot be marked passed`, MARK_SQL, [id, 'price', 'Cocolux', null], '22023', /only a lead \(stage inquiry or quoted\)/);
    await identityOn(db);
    assert.deepEqual(await orderOf(db, id), before, label + ' is untouched');
  }
  row = await orderOf(db, ORDER.handCancelled);
  assert.equal(row.cancelled_reason, 'client cancelled the event');
  assert.equal(row.passed, null);
  pass('an invoiced, deposit-paid, complete or hand-cancelled order is refused (22023) and left exactly as it was');

  // ── malformed calls ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'an unknown reason is refused', MARK_SQL, [ORDER.lengths, 'maybe', null, null], '22023', /reason must be one of/);
  await deniedOn(db, 'an empty reason is refused', MARK_SQL, [ORDER.lengths, '', null, null], '22023', /reason must be one of/);
  await deniedOn(db, 'a null reason is refused', MARK_SQL, [ORDER.lengths, null, null, null], '22023', /reason must be one of/);
  await deniedOn(db, 'a null order id is refused', MARK_SQL, [null, 'price', null, null], '22023', /order id is required/);
  await deniedOn(db, 'an unknown order id is a clear 22023', MARK_SQL, ['30000000-0000-4000-8000-000000000099', 'price', null, null], '22023', /No such order/);
  await deniedOn(db, 'reopen with a null order id is refused', REOPEN_SQL, [null], '22023', /order id is required/);
  await deniedOn(db, 'reopen on an unknown order id is a clear 22023', REOPEN_SQL, ['30000000-0000-4000-8000-000000000099'], '22023', /No such order/);
  await identityOn(db);
  assert.deepEqual(await orderOf(db, ORDER.lengths), lengthsBefore);
  pass('malformed calls raise 22023 and change nothing');

  // ── competitor and note length checks through the function ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'a competitor name over 60 characters is refused', MARK_SQL, [ORDER.lengths, 'competitor', 'x'.repeat(61), null], '22023', /competitor name is too long/);
  await deniedOn(db, 'a note over 200 characters is refused', MARK_SQL, [ORDER.lengths, 'other', null, 'x'.repeat(201)], '22023', /note is too long/);
  await identityOn(db);
  assert.deepEqual(await orderOf(db, ORDER.lengths), lengthsBefore);
  out = await markAs(db, OWNER, ORDER.lengths, ' Competitor ', '  Coco\n  lux  ', ' ' + 'n'.repeat(200) + ' ');
  assert.equal(out.applied, true);
  row = await orderOf(db, ORDER.lengths);
  assert.equal(row.passed.reason, 'competitor', 'the reason is trimmed and lower-cased');
  assert.equal(row.passed.competitor, 'Coco lux', 'runs of whitespace in the competitor fold to one space');
  assert.equal(row.passed.note, 'n'.repeat(200), 'a 200 character note (trimmed) is accepted');
  assert.equal(row.cancelled_reason, 'passed: competitor, Coco lux');
  pass('a 61 character competitor or a 201 character note is refused (22023); 60 and 200 pass after trimming; whitespace folds');
  out = await reopenAs(db, OWNER, ORDER.lengths);
  assert.equal(out.applied, true);
  out = await markAs(db, OWNER, ORDER.lengths, 'competitor', 'x'.repeat(60), '   ');
  assert.equal(out.applied, true);
  row = await orderOf(db, ORDER.lengths);
  assert.equal(row.passed.competitor, 'x'.repeat(60));
  assert.equal(row.passed.note, null, 'a blank note is stored as null');
  out = await reopenAs(db, OWNER, ORDER.lengths);
  out = await markAs(db, OWNER, ORDER.lengths, 'price', '   ', null);
  row = await orderOf(db, ORDER.lengths);
  assert.equal(row.passed.competitor, null, 'a blank competitor is stored as null');
  assert.equal(row.cancelled_reason, 'passed: price', 'and adds nothing to cancelled_reason');
  pass('a 60 character competitor passes; a blank competitor or note is stored as null');

  // ── the check constraint holds whoever writes (the service key here) ──
  await identityOn(db, { role: 'service_role' });
  const setPassed = 'update public.orders set passed = $2::jsonb where id = $1';
  await deniedOn(db, 'the check refuses an unknown reason', setPassed, [ORDER.lengths, record({ reason: 'maybe' })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a missing reason', setPassed, [ORDER.lengths, record({ reason: undefined })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a competitor over 60 characters', setPassed, [ORDER.lengths, record({ competitor: 'x'.repeat(61) })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a competitor that is not a string', setPassed, [ORDER.lengths, record({ competitor: 7 })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a note over 200 characters', setPassed, [ORDER.lengths, record({ note: 'x'.repeat(201) })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a missing at', setPassed, [ORDER.lengths, record({ at: undefined })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a blank at', setPassed, [ORDER.lengths, record({ at: '  ' })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a prior_stage that is not a lead stage', setPassed, [ORDER.lengths, record({ prior_stage: 'invoiced' })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a missing prior_stage', setPassed, [ORDER.lengths, record({ prior_stage: undefined })], '23514', /orders_passed_check/);
  await deniedOn(db, 'the check refuses a record that is not an object', setPassed, [ORDER.lengths, JSON.stringify(['price'])], '23514', /orders_passed_check/);
  await q(db, setPassed, [ORDER.lengths, record({ competitor: undefined, note: undefined })]);
  await q(db, setPassed, [ORDER.lengths, record({ competitor: null, note: null, reason: 'event_cancelled', prior_stage: 'inquiry' })]);
  await q(db, setPassed, [ORDER.lengths, record({ competitor: 'x'.repeat(60), note: 'y'.repeat(200) })]);
  for (const reason of REASONS) await q(db, setPassed, [ORDER.lengths, record({ reason })]);
  await q(db, setPassed, [ORDER.lengths, record()]);
  await identityOn(db);
  pass('orders_passed_check: every one of the six reasons passes, absent or JSON-null competitor and note pass, the lengths and prior_stage hold, at must be present');

  // ── the digest's month read (the worker, with the service key) ──
  // passed->>at=gte.<month start> is a text compare on the ISO stamp, so a
  // mark from last month (stamped by hand here) drops out and this month's
  // stay in.
  out = await markAs(db, OWNER, ORDER.lastMonth, 'timing');
  assert.equal(out.applied, true);
  await asServiceRole(db, () => q(db,
    "update public.orders set passed = passed || jsonb_build_object('at', '2026-08-28T15:00:00.000Z') where id = $1", [ORDER.lastMonth]));
  const monthStart = new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z';
  const digestRows = await asServiceRole(db, () => rowsOn(db,
    "select passed from public.orders where passed is not null and passed ->> 'at' >= $1", [monthStart]));
  const digestIds = new Set((await asServiceRole(db, () => rowsOn(db,
    "select id from public.orders where passed is not null and passed ->> 'at' >= $1", [monthStart]))).map(r => r.id));
  assert.ok(digestIds.has(ORDER.carvalho) && digestIds.has(ORDER.quiet) && digestIds.has(ORDER.lengths));
  assert.ok(!digestIds.has(ORDER.lastMonth), 'last month\'s mark is out');
  assert.ok(!digestIds.has(ORDER.handCancelled), 'a hand-cancelled order is never a passed lead');
  const tally = {};
  for (const r of digestRows) tally[r.passed.reason] = (tally[r.passed.reason] || 0) + 1;
  assert.equal(tally.price, 2);
  assert.equal(tally.no_reply, 1);
  assert.equal(digestRows.length, 3);
  pass('the digest read (passed not null, at >= month start, service key) counts this month\'s marks by reason and leaves last month\'s and hand-cancelled orders out');

  // ── reopen restores the prior stage and clears everything ──
  out = await reopenAs(db, OWNER, ORDER.carvalho);
  assert.equal(out.applied, true);
  assert.equal(out.row.stage, 'quoted');
  row = await orderOf(db, ORDER.carvalho);
  assert.equal(row.stage, 'quoted');
  assert.equal(row.cancelled_at, null);
  assert.equal(row.cancelled_reason, null);
  assert.equal(row.passed, null);
  assert.deepEqual(stillOf(row), stillOf(carvalhoBefore));
  assert.ok(new Date(row.updated_at).getTime() > new Date(carvalhoPassed.updated_at).getTime());
  pass('reopen on the quoted lead: stage quoted again, cancelled_at, cancelled_reason and passed cleared, nothing else moved');
  out = await reopenAs(db, OWNER, ORDER.quiet);
  assert.equal((await orderOf(db, ORDER.quiet)).stage, 'inquiry');
  pass('reopen on the inquiry: stage inquiry again');
  // A reopened lead can be passed again, with a new reason.
  out = await markAs(db, OWNER, ORDER.carvalho, 'competitor', 'Windansea');
  assert.equal(out.applied, true);
  row = await orderOf(db, ORDER.carvalho);
  assert.equal(row.cancelled_reason, 'passed: competitor, Windansea');
  assert.equal(row.passed.prior_stage, 'quoted');
  pass('a reopened lead can be marked passed again with a new reason');

  // ── reopen on an order that was never passed ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'reopen on a quoted lead that was never passed is refused', REOPEN_SQL, [ORDER.quiet], '22023', /never marked passed/);
  await deniedOn(db, 'reopen on an order cancelled by hand (never passed) is refused', REOPEN_SQL, [ORDER.handCancelled], '22023', /never marked passed/);
  await deniedOn(db, 'reopen on an invoiced order is refused', REOPEN_SQL, [ORDER.invoiced], '22023', /never marked passed/);
  await identityOn(db);
  row = await orderOf(db, ORDER.handCancelled);
  assert.equal(row.stage, 'cancelled');
  assert.equal(row.cancelled_reason, 'client cancelled the event');
  pass('reopen on a never-passed order raises 22023 and changes nothing (a hand cancellation stays cancelled)');
  out = await reopenAs(db, OWNER, ORDER.quiet).catch(error => error.code);
  assert.equal(out, '22023');
  out = await reopenAs(db, OWNER, ORDER.carvalho);
  assert.equal(out.applied, true);
  out = await reopenAs(db, OWNER, ORDER.carvalho).catch(error => error.code);
  assert.equal(out, '22023', 'a second reopen is refused (nothing to reopen)');
  pass('a second reopen on the same lead is refused');

  // ── reopen on a passed order whose stage moved on since ──
  out = await markAs(db, OWNER, ORDER.movedOn, 'timing');
  assert.equal(out.applied, true);
  await asServiceRole(db, () => q(db, "update public.orders set stage = 'invoiced', external_invoice_id = 'FAKE-2205' where id = $1", [ORDER.movedOn]));
  out = await reopenAs(db, OWNER, ORDER.movedOn);
  assert.equal(out.applied, true);
  row = await orderOf(db, ORDER.movedOn);
  assert.equal(row.stage, 'invoiced', 'the stage is left where Jarvis put it');
  assert.equal(row.passed, null);
  assert.equal(row.cancelled_at, null);
  assert.equal(row.cancelled_reason, null);
  pass('reopen on a passed order that was invoiced since keeps the stage invoiced and clears only the passed record and the cancelled fields');

  // ── re-run of the migration with passed rows present ──
  out = await markAs(db, OWNER, ORDER.carvalho, 'price', 'Cocolux');
  assert.equal(out.applied, true);
  const beforeRerun = await orderOf(db, ORDER.carvalho);
  await db.exec(migration);
  assert.deepEqual(await orderOf(db, ORDER.carvalho), beforeRerun, 'the row survives the re-run untouched');
  assert.equal(await fnCount(db, 'hc_mark_order_passed'), 1);
  assert.equal(await fnCount(db, 'hc_reopen_passed_order'), 1);
  assert.equal(await checkDef(db), def047);
  assert.equal(await canExecute(db, 'service_role', MARK_SIG), false);
  assert.equal(await canExecute(db, 'anon', REOPEN_SIG), false);
  out = await markAs(db, OWNER, ORDER.carvalho, 'other');
  assert.equal(out.applied, false);
  pass('a re-run with passed rows present is harmless: rows, check, functions and grants unchanged');

  // ── the app's Passed chip and the follow-up to-do read ──
  // The chip tests o.passed != null; the follow-up to-do skips cancelled
  // orders, which a passed lead now is.
  const passedNow = await asPostgres(db, () => rowsOn(db, 'select id, stage from public.orders where passed is not null order by id'));
  assert.ok(passedNow.every(r => r.stage === 'cancelled'), 'every passed lead reads cancelled');
  assert.deepEqual(passedNow.map(r => r.id), [ORDER.carvalho, ORDER.lengths, ORDER.lastMonth]);
  const openLeads = await asPostgres(db, () => rowsOn(db, "select id from public.orders where stage in ('inquiry', 'quoted') and passed is not null"));
  assert.equal(openLeads.length, 0, 'no lead is both open and passed');
  pass('a passed lead is a cancelled order with a passed record: the Passed chip finds it, the lead follow-up (which skips cancelled) does not');

  // ── rollback refuses while a passed lead exists ──
  await refusesOn(db, 'rollback refuses while passed leads exist at stage cancelled', rollback, '55000', /3 order\(s\) still carry a passed record.*reopen those first/);
  assert.equal(await columnType(db), 'jsonb');
  assert.equal(await fnCount(db, 'hc_mark_order_passed'), 1);
  assert.equal(await fnCount(db, 'hc_reopen_passed_order'), 1);
  assert.deepEqual(await orderOf(db, ORDER.carvalho), beforeRerun);
  pass('a refused rollback leaves the column, the functions and the rows in place');
  // A passed record on an order that moved on (stage no longer cancelled)
  // does not block: the reason is no longer what keeps that order out.
  await asServiceRole(db, () => q(db, "update public.orders set stage = 'invoiced', external_invoice_id = 'FAKE-2206' where id = $1", [ORDER.lastMonth]));
  await refusesOn(db, 'rollback still refuses while two cancelled passed leads remain', rollback, '55000', /2 order\(s\) still carry/);
  // The owner reopens the rest.
  for (const id of [ORDER.carvalho, ORDER.lengths]) {
    out = await reopenAs(db, OWNER, id);
    assert.equal(out.applied, true);
  }
  assert.equal((await orderOf(db, ORDER.carvalho)).stage, 'quoted');
  assert.equal((await orderOf(db, ORDER.lengths)).stage, 'quoted');

  // ── rollback, twice, then re-apply ──
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await columnType(db), undefined);
  assert.equal(await fnCount(db, 'hc_mark_order_passed'), 0);
  assert.equal(await fnCount(db, 'hc_reopen_passed_order'), 0);
  assert.equal(await indexExists(db), false);
  assert.equal(await checkDef(db), undefined);
  row = await orderOf(db, ORDER.carvalho);
  assert.equal(row.stage, 'quoted');
  assert.equal(row.cancelled_at, null);
  assert.equal('passed' in row, false, 'the column is gone');
  row = await orderOf(db, ORDER.handCancelled);
  assert.equal(row.stage, 'cancelled');
  assert.equal(row.cancelled_reason, 'client cancelled the event');
  row = await orderOf(db, ORDER.lastMonth);
  assert.equal(row.stage, 'invoiced', 'the moved-on order keeps its stage; only its record is gone');
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.orders')), 10, 'no row was deleted');
  assert.equal(await asPostgres(db, () => scalarOn(db, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_is_owner'")), 1);
  pass('rollback runs twice once every passed lead is reopened: column, check, index and both functions gone; stages, hand cancellations and hc_is_owner untouched');
  await db.exec(migration);
  assert.equal(await columnType(db), 'jsonb');
  assert.equal((await orderOf(db, ORDER.carvalho)).passed, null);
  out = await markAs(db, OWNER, ORDER.carvalho, 'price', 'Cocolux', 'cheaper price with Cocolux');
  assert.equal(out.applied, true);
  assert.equal((await orderOf(db, ORDER.carvalho)).cancelled_reason, 'passed: price, Cocolux');
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'after the re-apply the service key still cannot call the mark function', MARK_SQL, [ORDER.blocker, 'price', null, null], '42501', /permission denied for function/);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'after the re-apply anon still cannot call the reopen function', REOPEN_SQL, [ORDER.carvalho], '42501', /permission denied for function/);
  await identityOn(db);
  pass('re-apply after rollback starts with every row null, marks again, and the grants are back to authenticated only');

  // ── preflight guards on an unexpected shape ──
  const guard1 = await productionShaped();
  handles.push(guard1);
  await guard1.exec('alter table public.orders drop column cancelled_reason;');
  await refusesOn(guard1, '047 refuses when orders.cancelled_reason is missing', migration, '55000', /orders\.cancelled_reason/);
  assert.equal(await columnType(guard1), undefined, 'nothing was added');
  assert.equal(await fnCount(guard1, 'hc_mark_order_passed'), 0);
  const guard2 = await productionShaped();
  handles.push(guard2);
  await guard2.exec('alter table public.orders add column passed text;');
  await refusesOn(guard2, '047 refuses a pre-existing passed column that is not jsonb', migration, '55000', /passed of type text/);
  assert.equal(await fnCount(guard2, 'hc_mark_order_passed'), 0);
  const guard3 = await productionShaped();
  handles.push(guard3);
  // A stage list without cancelled (added NOT VALID so the seed's cancelled
  // row does not stop the guard itself): every mark would fail 23514.
  await guard3.exec(`alter table public.orders drop constraint orders_stage_check;
    alter table public.orders add constraint orders_stage_check check (stage in ('inquiry', 'quoted', 'invoiced')) not valid;`);
  await refusesOn(guard3, '047 refuses a stage check that does not admit cancelled', migration, '55000', /stage check to admit inquiry, quoted and cancelled/);
  assert.equal(await columnType(guard3), undefined, 'nothing was added');
  const guard4 = await productionShaped();
  handles.push(guard4);
  await guard4.exec('drop function public.hc_is_owner() cascade;');
  await refusesOn(guard4, '047 refuses when public.hc_is_owner() (015) is missing', migration, '55000', /hc_is_owner/);
  assert.equal(await columnType(guard4), undefined, 'nothing was added');

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker digest, Jarvis, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
