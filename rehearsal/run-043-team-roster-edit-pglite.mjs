// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-043-team-roster-edit-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/043_team_roster_edit.sql (the owner's roster edits from
// the phone) and its rollback on the shape production is in on 2026-09-14:
// the 001-013 base chain, 015, 015b, 019, 024, 027, 029, 034-038 and 041.
// Real migration files are executed as written and never rewritten on disk.
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
  '019_dashboard_auth_transition', '024_webhook_delivery_receipts',
  '027_webhook_async_intake_outbox', '029_webhook_delivery_lease_renewal_fix',
  '034_calendar_delivery_details', '035_order_logo_assets', '036_order_prep_workflow',
  '037_order_box_progress', '038_delivery_request_owner_edit', '041_team_alert_push_tokens',
];
const [supabaseBootstrap, ordersBaseline, migration, rollback] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/043_team_roster_edit.sql'),
  read('migrations/043_team_roster_edit_rollback.sql'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));

const OWNER = { authUserId: '00000000-0000-4000-8000-000000000001', email: 'siddsaxena@gmail.com' };
const MANAGER = { authUserId: '20000000-0000-4000-8000-000000000002', email: 'manager@example.invalid' };
const TEAM = { authUserId: '20000000-0000-4000-8000-000000000003', email: 'team@example.invalid' };
const STALE = { authUserId: '20000000-0000-4000-8000-000000000004', email: 'exmanager@example.invalid' };
const VEGAS = { authUserId: '20000000-0000-4000-8000-000000000005', email: 'vegas@example.invalid' };
const EXTEAM = { authUserId: '20000000-0000-4000-8000-000000000006', email: 'exteam@example.invalid' };
const REVIEW = { email: 'appreview@hamptonscoconuts.com' };
const ID = {
  owner: '10000000-0000-4000-8000-000000000001',
  manager: '10000000-0000-4000-8000-000000000002',
  team: '10000000-0000-4000-8000-000000000003',
  stale: '10000000-0000-4000-8000-000000000004',
  vegas: '10000000-0000-4000-8000-000000000005',
  exteam: '10000000-0000-4000-8000-000000000006',
  review: '10000000-0000-4000-8000-000000000007',
};

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
  ('${EXTEAM.authUserId}', '${EXTEAM.email}', '2026-01-06T00:00:00Z');
insert into public.field_workers (id, email, name, market, role, active, hourly_rate_cents) values
  ('${ID.manager}', '${MANAGER.email}', 'Sandbox Manager', 'ny', 'manager', true, 1900),
  ('${ID.team}', '${TEAM.email}', 'Sandbox Team', 'ny', 'team', true, 1800),
  ('${ID.stale}', '${STALE.email}', 'Sandbox Ex-manager', 'ny', 'manager', false, null),
  ('${ID.vegas}', '${VEGAS.email}', 'Sandbox Vegas', 'vegas', 'team', true, 2200),
  ('${ID.exteam}', '${EXTEAM.email}', 'Sandbox Ex-team', 'ny', 'team', false, 1800),
  ('${ID.review}', '${REVIEW.email}', 'App Review', 'ny', 'team', true, 0);
insert into public.shifts (id, worker_name, worker_email, market, clock_in_at, device) values
  ('50000000-0000-4000-8000-000000000001', 'Sandbox Team', '${TEAM.email}', 'ny', now() - interval '2 hours', 'sandbox-fixture');
insert into public.push_tokens (email, apns_token, platform, updated_at) values
  ('${MANAGER.email}', '${'b'.repeat(64)}', 'ios', '2026-08-14T10:00:00Z'),
  ('${VEGAS.email}', '${'c'.repeat(64)}', 'ios', '2026-09-01T10:00:00Z');
insert into public.live_activity_tokens (email, token_type, shift_id, token, updated_at) values
  ('${MANAGER.email}', 'push_to_start', null, '${'d'.repeat(64)}', '2026-08-14T10:00:00Z');`;

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
const EDIT_SQL = 'select public.hc_update_field_worker($1, $2::jsonb) as value';
async function editAs(h, who, workerId, patch) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  try { return await scalarOn(h, EDIT_SQL, [workerId, JSON.stringify(patch)]); } finally { await identityOn(h); }
}
const rowOf = (h, id) => asPostgres(h, async () => (await rowsOn(h,
  'select id, email, name, role, market, active, hourly_rate_cents from public.field_workers where id = $1', [id]))[0]);
const auditCount = (h, id) => asPostgres(h, () => scalarOn(h, 'select count(*)::int as value from public.field_worker_edits where worker_id = $1', [id]));
const lastAudit = (h, id) => asPostgres(h, async () => (await rowsOn(h,
  'select changes, edited_by, edited_by_name from public.field_worker_edits where worker_id = $1 order by id desc limit 1', [id]))[0]);
const pushCount = (h, email) => asPostgres(h, () => scalarOn(h, 'select count(*)::int as value from public.push_tokens where lower(email) = $1', [email]));
const liveCount = (h, email) => asPostgres(h, () => scalarOn(h, 'select count(*)::int as value from public.live_activity_tokens where lower(email) = $1', [email]));
const fnCount = h => scalarOn(h, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_update_field_worker'");
const tableCount = h => scalarOn(h, "select count(*)::int as value from pg_class where relnamespace = 'public'::regnamespace and relname = 'field_worker_edits'");

async function productionShaped() {
  const h = await PGlite.create({ extensions: { pgcrypto } });
  await h.exec(supabaseBootstrap);
  await h.exec(STORAGE_STUB);
  await h.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await h.exec(baseFiles[name]);
  await h.exec(SEED);
  for (const name of APPLIED_CHAIN) await h.exec(baseFiles[name]);
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
  // The bootstrap seeds the owner's auth user and 003 seeds the roster row
  // with its own id, so look the row up by email rather than assuming an id.
  const owner = await asPostgres(db, async () => (await rowsOn(db,
    'select id, email, name, role, market, active, hourly_rate_cents from public.field_workers where lower(email) = $1', [OWNER.email]))[0]);
  assert.ok(owner && owner.role === 'owner' && owner.active === true, 'the bootstrap must carry the owner row');
  ID.owner = owner.id;

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await fnCount(db), 1);
  assert.equal(await tableCount(db), 1);
  pass('043 applies twice on the production-shaped chain (001-013, 015, 015b, 019, 024, 027, 029, 034-038, 041)');

  // ── a rename ──
  let out = await editAs(db, OWNER, ID.team, { name: '  Sandbox   Crew ' });
  assert.equal(out.applied, true);
  assert.deepEqual(out.changes.name, { before: 'Sandbox Team', after: 'Sandbox Crew' });
  assert.equal((await rowOf(db, ID.team)).name, 'Sandbox Crew');
  const audit = await lastAudit(db, ID.team);
  assert.equal(audit.edited_by, OWNER.authUserId);
  assert.deepEqual(audit.changes, { name: { before: 'Sandbox Team', after: 'Sandbox Crew' } });
  pass('the owner renames a team member (whitespace collapsed) and one audit row names who, what and the before/after');

  // ── the rate ──
  out = await editAs(db, OWNER, ID.team, { hourly_rate_cents: 2000 });
  assert.equal((await rowOf(db, ID.team)).hourly_rate_cents, 2000);
  out = await editAs(db, OWNER, ID.team, { hourly_rate_cents: null });
  assert.equal((await rowOf(db, ID.team)).hourly_rate_cents, null);
  assert.deepEqual(out.changes.hourly_rate_cents, { before: 2000, after: null });
  out = await editAs(db, OWNER, ID.team, { hourly_rate_cents: 1800 });
  pass('the rate can be set, cleared and set again, each change audited');
  for (const bad of [-1, 25001, 12.5, 'abc', true]) {
    await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
    await deniedOn(db, `rate ${JSON.stringify(bad)} is refused`, EDIT_SQL, [ID.team, JSON.stringify({ hourly_rate_cents: bad })], '22023');
    await identityOn(db);
  }

  // ── no-op ──
  out = await editAs(db, OWNER, ID.team, { name: 'Sandbox Crew', hourly_rate_cents: 1800 });
  assert.equal(out.applied, false);
  assert.deepEqual(out.changes, {});
  const auditsBefore = await auditCount(db, ID.team);
  out = await editAs(db, OWNER, ID.team, {});
  assert.equal(out.applied, false);
  assert.equal(await auditCount(db, ID.team), auditsBefore);
  pass('a patch that changes nothing reports applied false and writes no audit row');

  // ── role and market ──
  out = await editAs(db, OWNER, ID.team, { role: ' Manager ' });
  assert.equal((await rowOf(db, ID.team)).role, 'manager');
  pass('role is normalised (trimmed, lower case) before it is stored');
  assert.equal(await liveCount(db, MANAGER.email), 1);
  out = await editAs(db, OWNER, ID.manager, { role: 'team' });
  assert.equal((await rowOf(db, ID.manager)).role, 'team');
  assert.equal(await liveCount(db, MANAGER.email), 0, 'demotion to team deletes the lock-screen card tokens');
  assert.equal(await pushCount(db, MANAGER.email), 1, 'demotion to team keeps the alert token (041 rule)');
  pass('demoting a manager to team deletes their card tokens and keeps their alert token');
  await editAs(db, OWNER, ID.manager, { role: 'manager' });
  await editAs(db, OWNER, ID.team, { role: 'team' });
  out = await editAs(db, OWNER, ID.vegas, { market: 'NY' });
  assert.equal((await rowOf(db, ID.vegas)).market, 'ny');
  await editAs(db, OWNER, ID.vegas, { market: 'vegas' });
  pass('market changes are normalised and stored');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'an unknown role is refused', EDIT_SQL, [ID.team, JSON.stringify({ role: 'boss' })], '22023', /owner, manager or team/);
  await deniedOn(db, 'an unknown market is refused', EDIT_SQL, [ID.team, JSON.stringify({ market: 'paris' })], '22023', /ny, vegas or miami/);
  await deniedOn(db, 'an unknown field is refused', EDIT_SQL, [ID.team, JSON.stringify({ email: 'new@example.invalid' })], '22023', /unknown field/);
  await deniedOn(db, 'a non-object patch is refused', EDIT_SQL, [ID.team, JSON.stringify(['name'])], '22023', /must be an object/);
  await deniedOn(db, 'a missing worker is a clear 22023', EDIT_SQL, ['10000000-0000-4000-8000-0000000000ff', JSON.stringify({ name: 'x' })], '22023', /No such team member/);
  await deniedOn(db, 'a null worker id is refused', EDIT_SQL, [null, JSON.stringify({ name: 'x' })], '22023', /worker id is required/);
  await deniedOn(db, 'an empty name is refused', EDIT_SQL, [ID.team, JSON.stringify({ name: '   ' })], '22023', /1 to 80/);
  await deniedOn(db, 'a control character in a name is refused', EDIT_SQL, [ID.team, JSON.stringify({ name: 'BadName' })], '22023', /1 to 80/);
  await identityOn(db);

  // ── deactivation ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'a worker who is still clocked in cannot be switched off', EDIT_SQL, [ID.team, JSON.stringify({ active: false })], '22023', /still clocked in/);
  await identityOn(db);
  assert.equal((await rowOf(db, ID.team)).active, true);
  assert.equal(await pushCount(db, VEGAS.email), 1);
  out = await editAs(db, OWNER, ID.vegas, { active: false });
  assert.equal(out.applied, true);
  assert.deepEqual(out.changes.active, { before: true, after: false });
  assert.equal((await rowOf(db, ID.vegas)).active, false);
  assert.equal(await pushCount(db, VEGAS.email), 0, 'switching off deletes the alert token');
  pass('switching a worker off (no open shift) flips active, deletes their phone tokens and is audited');
  await asPostgres(db, () => q(db, "update public.shifts set clock_out_at = now() where worker_email = $1", [TEAM.email]));
  out = await editAs(db, OWNER, ID.team, { active: false });
  assert.equal((await rowOf(db, ID.team)).active, false);
  out = await editAs(db, OWNER, ID.team, { active: true });
  assert.equal((await rowOf(db, ID.team)).active, true);
  pass('once clocked out, the same worker can be switched off and back on');
  // A switched-off manager still exists for the Pay tab (nothing here deletes rows).
  assert.equal((await rowOf(db, ID.vegas)).email, VEGAS.email);
  pass('a switched-off worker keeps their roster row (pay history and unpaid shifts stay visible)');

  // ── the caller's own row ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'the owner cannot change their own role', EDIT_SQL, [ID.owner, JSON.stringify({ role: 'team' })], '42501', /your own role or access/);
  await deniedOn(db, 'the owner cannot switch themselves off', EDIT_SQL, [ID.owner, JSON.stringify({ active: false })], '42501', /your own role or access/);
  await identityOn(db);
  out = await editAs(db, OWNER, ID.owner, { name: 'Sidd Saxena' });
  assert.equal(out.applied, true);
  await editAs(db, OWNER, ID.owner, { name: owner.name });
  pass('the owner can still rename their own row');

  // ── a second owner ──
  out = await editAs(db, OWNER, ID.manager, { role: 'owner' });
  assert.equal((await rowOf(db, ID.manager)).role, 'owner');
  const MANAGER_AS_OWNER = MANAGER;
  out = await editAs(db, MANAGER_AS_OWNER, ID.owner, { role: 'manager' });
  assert.equal(out.applied, true, 'with two active owners, one may demote the other');
  out = await editAs(db, MANAGER_AS_OWNER, ID.owner, { role: 'owner' });
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  await deniedOn(db, 'the second owner cannot switch themselves off either', EDIT_SQL, [ID.manager, JSON.stringify({ active: false })], '42501', /your own role or access/);
  await identityOn(db);
  out = await editAs(db, OWNER, ID.manager, { role: 'manager' });
  assert.equal((await rowOf(db, ID.manager)).role, 'manager');
  pass('promoting to owner and back works; a second owner may demote the first while another owner remains');

  // ── the App Review login ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  for (const patch of [{ role: 'manager' }, { market: 'vegas' }, { active: false }]) {
    await deniedOn(db, `the App Review login keeps ${Object.keys(patch)[0]}`, EDIT_SQL, [ID.review, JSON.stringify(patch)], '42501', /App Review/);
  }
  await identityOn(db);
  out = await editAs(db, OWNER, ID.review, { hourly_rate_cents: 0, name: 'App Review' });
  assert.equal(out.applied, false);
  pass('the App Review row can only be renamed or re-rated, never re-roled, moved or switched off');

  // ── who may call ──
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  await deniedOn(db, 'a manager cannot edit the roster', EDIT_SQL, [ID.team, JSON.stringify({ name: 'x' })], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  await deniedOn(db, 'a team member cannot edit the roster', EDIT_SQL, [ID.team, JSON.stringify({ name: 'x' })], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated', sub: STALE.authUserId });
  await deniedOn(db, 'an inactive login cannot edit the roster', EDIT_SQL, [ID.team, JSON.stringify({ name: 'x' })], '42501');
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot even call the function', EDIT_SQL, [ID.team, JSON.stringify({ name: 'x' })], '42501');
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the service key cannot call the function (execute revoked)', EDIT_SQL, [ID.team, JSON.stringify({ name: 'x' })], '42501');
  await identityOn(db);

  // ── the audit table ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  assert.ok((await scalarOn(db, 'select count(*)::int as value from public.field_worker_edits')) > 5);
  await deniedOn(db, 'the owner cannot insert audit rows by hand', 'insert into public.field_worker_edits (worker_id, changes) values ($1, $2::jsonb)', [ID.team, '{}'], '42501');
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.field_worker_edits'), 0);
  await identityOn(db, { role: 'anon' });
  const anonRead = await q(db, 'select count(*)::int as value from public.field_worker_edits').then(r => r.rows[0].value, error => error.code);
  assert.ok(anonRead === 0 || anonRead === '42501');
  await identityOn(db);
  pass('only the owner reads the audit trail; nobody but the function writes it');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'phones still cannot update field_workers directly', 'update public.field_workers set name = $1 where id = $2', ['x', ID.team], '42501');
  await identityOn(db);

  // ── rollback, twice, then re-apply ──
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await fnCount(db), 0);
  assert.equal(await tableCount(db), 0);
  assert.equal((await rowOf(db, ID.vegas)).active, false, 'rollback never restores roster rows');
  pass('rollback runs twice and leaves the roster as edited');
  await db.exec(migration);
  assert.equal(await fnCount(db), 1);
  out = await editAs(db, OWNER, ID.vegas, { active: true });
  assert.equal(out.applied, true);
  pass('re-apply after rollback works and edits again');

  // ── preflight guards on an unexpected shape ──
  const guard = await productionShaped();
  handles.push(guard);
  await guard.exec("create table public.field_worker_edits (id int primary key);");
  await refusesOn(guard, '043 refuses a foreign field_worker_edits table with the wrong columns', migration, '55000', /refuses an existing public.field_worker_edits/);

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
