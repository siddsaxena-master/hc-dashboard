// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-015c-notification-bridge-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/015c_notification_device_api_compatibility.sql and its
// rollback on the shape production is in TODAY (2026-09-10): 015, 015b, 019,
// 024, 027, 029, 034 through 038 applied; 014, 015c, 016, 017, 018, 020, 021,
// 022, 023, 025, 026 and 028 not applied. Real migration files are executed as
// written and are never rewritten on disk.
//
// The production symptom this exists to settle: HC Field build 30 calls
//   POST rpc/hc_authorize_notification_device  {"p_device_id": ...}
// and throws 'notification device authorization failed' when it is not ok
// (App.js:580), so it never reaches the POST that actually saves the APNs
// token, rpc/hc_sync_notification_device. Probed live today, the first RPC is
// 404 PGRST202 (absent) and the second is 403 42501 (present). The owner's
// push_tokens row has been frozen at 2026-08-13 through five app builds.
//
// ONE DELIBERATE DEVIATION, and it is reported as a defect rather than hidden:
// PGlite 0.5.8 is PostgreSQL 18, and PostgreSQL 18 records NOT NULL constraints
// in pg_catalog.pg_constraint (contype 'n'). Four bare `count(*) from
// pg_constraint` predicates inside 015c therefore see 14 and 4 where the file
// expects 6 and 2. Section 3 runs the file BYTE FOR BYTE first and captures
// that failure. Every later section runs the same text through pg18Compatible(),
// which appends `and constraint_info.contype <> 'n'` to exactly those four
// predicates and nothing else - a no-op on the PostgreSQL 15/17 that Supabase
// runs, and the exact repair this rehearsal recommends. The patch is proved
// reversible before it is used.
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
// Supabase ships pgcrypto; 015c's capability secret is gen_random_bytes(32) and
// digest(bytea,'sha256'), so load the matching PGlite contrib bundle rather
// than editing a migration.
const { pgcrypto } = await import(pathToFileURL(join(packageDir, 'dist/contrib/pgcrypto.js')).href);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8');
const appRoot = join(root, '..', 'hc-field-app');

const BASE_CHAIN = [
  '001_delivery_signatures', '002_shifts', '003_field_workers', '004_intake_messages',
  '005_intake_approvals', '006_payroll_and_shift_summaries', '007_clockin_alerts',
  '008_push_tokens', '009_app_config', '010_live_activity_tokens', '011_push_queue',
  '012_edit_trail_paid_snapshot', '013_invoice_pdf_url',
];
// Everything production has actually applied on top of the base chain, in order.
// 014 is skipped on purpose (it must never run). 030 has no file in this repo,
// which is called out in the closing limits.
const APPLIED_CHAIN = [
  '015_field_auth_transition', '015b_payroll_payment_rpc_compatibility',
  '019_dashboard_auth_transition', '024_webhook_delivery_receipts',
  '027_webhook_async_intake_outbox', '029_webhook_delivery_lease_renewal_fix',
  '034_calendar_delivery_details', '035_order_logo_assets', '036_order_prep_workflow',
  '037_order_box_progress', '038_delivery_request_owner_edit',
];
const LATER_CHAIN = [
  '016_field_auth_cutover', '017_live_activity_end_delivery', '018_live_activity_start_dedup',
];

const [
  supabaseBootstrap, ordersBaseline, migration015c, rollback015c, migration021,
  fixture001, fixture001a, checks002, appSource,
] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/015c_notification_device_api_compatibility.sql'),
  read('migrations/015c_notification_device_api_compatibility_rollback.sql'),
  read('migrations/021_notification_device_authorization_transition.sql'),
  read('rehearsal/001_post_cutover_fixture.sql'),
  read('rehearsal/001a_notification_device_transition_fixture.sql'),
  read('rehearsal/002_notification_device_authorization_checks.sql'),
  readFile(join(appRoot, 'App.js'), 'utf8'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN, ...LATER_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));

// -- the PostgreSQL 18 compatibility patch, and its proof ---------------------
const CONSTRAINT_COUNT = /(select count\(\*\)\n(\s*)from pg_catalog\.pg_constraint as constraint_info\n\s*where constraint_info\.conrelid =\n\s*'public\.notification_device_[a-z_]+'::pg_catalog\.regclass\n)(\s*\) <> [0-9]+)/g;
const SHIM_LINE = "and constraint_info.contype <> 'n'";
function pg18Compatible(sql) {
  let hits = 0;
  const patched = sql.replace(CONSTRAINT_COUNT,
    (whole, head, indent, tail) => { hits++; return `${head}${indent}  ${SHIM_LINE}\n${tail}`; });
  const reversed = patched.split('\n').filter(line => line.trim() !== SHIM_LINE).join('\n');
  return { patched, hits, reversed };
}

let db;
let passed = 0;
const notes = [];
const defects = [];
const pass = message => { passed++; console.log(`PASS: ${message}`); };
const note = message => { notes.push(message); console.log(`NOTE: ${message}`); };
const defect = message => { defects.push(message); console.log(`DEFECT: ${message}`); };

const q = (handle, sql, params = []) => handle.query(sql, params);
async function scalarOn(handle, sql, params = []) { return (await q(handle, sql, params)).rows[0]?.value; }
async function rowsOn(handle, sql, params = []) { return (await q(handle, sql, params)).rows; }
const scalar = (sql, params = []) => scalarOn(db, sql, params);
const rows = (sql, params = []) => rowsOn(db, sql, params);

// PostgREST hands the request's role to Postgres two ways: it SETs the database
// role and it publishes the JWT claims, which is what Supabase's auth.role() and
// auth.uid() read. Both must move together or these tests prove the wrong thing.
const currentIdentity = new Map();
async function identityOn(handle, options = {}) {
  const { role = 'postgres', sub = null, claimRole = null } = options;
  currentIdentity.set(handle, options);
  await handle.exec('reset role;');
  const jwtRole = claimRole ?? (role === 'postgres' ? '' : role);
  await q(handle, "select set_config('request.jwt.claim.role', $1, false)", [jwtRole]);
  await q(handle, "select set_config('request.jwt.claim.sub', $1, false)", [sub ?? '']);
  await q(handle, "select set_config('request.jwt.claims', $1, false)",
    [sub || jwtRole ? JSON.stringify({ sub: sub || null, role: jwtRole || null }) : '']);
  if (role !== 'postgres') await handle.exec(`set role ${role};`);
}
const identity = options => identityOn(db, options);
async function denied(label, sql, params = [], code = '42501', message = null) {
  await assert.rejects(db.query(sql, params),
    error => error.code === code && (!message || message.test(error.message)), label);
  pass(label);
}
// A migration file that must refuse. Its own BEGIN leaves an aborted
// transaction behind, so close it before the next statement.
async function refusesOn(handle, label, sql, code, message) {
  let seen = null;
  await assert.rejects(handle.exec(sql),
    error => { seen = error; return error.code === code && message.test(error.message); }, label);
  try { await handle.exec('rollback;'); } catch { /* nothing open */ }
  pass(`${label} (${seen.code}: ${seen.message})`);
  return seen;
}
const refuses = (label, sql, code, message) => refusesOn(db, label, sql, code, message);

const relationExistsOn = (handle, name) =>
  scalarOn(handle, 'select (pg_catalog.to_regclass($1) is not null) as value', [name]);
const routineExistsOn = (handle, signature) =>
  scalarOn(handle, 'select (pg_catalog.to_regprocedure($1) is not null) as value', [signature]);
const relationExists = name => relationExistsOn(db, name);
const routineExists = signature => routineExistsOn(db, signature);
const functionDefOn = (handle, signature) =>
  scalarOn(handle, 'select pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($1)) as value', [signature]);
const functionDef = signature => functionDefOn(db, signature);

// Every function in schema public, by exact signature, with its full body.
const functionCatalogOn = handle => rowsOn(handle,
  `select p.oid::pg_catalog.regprocedure::text as signature,
          pg_catalog.pg_get_functiondef(p.oid) as definition
     from pg_catalog.pg_proc as p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.prokind = 'f'
     order by 1`);
// The full access surface: table privileges, row policies, RLS flags, and the
// EXECUTE grants on every public function (including PUBLIC).
async function accessCatalogOn(handle) {
  const grants = await rowsOn(handle,
    `select table_name, grantee, privilege_type from information_schema.table_privileges
       where table_schema = 'public' order by table_name, grantee, privilege_type`);
  const policies = await rowsOn(handle,
    `select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
       from pg_catalog.pg_policies where schemaname = 'public' order by tablename, policyname`);
  const rls = await rowsOn(handle,
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by c.relname`);
  const routines = await rowsOn(handle,
    `select p.oid::pg_catalog.regprocedure::text as signature,
            case when a.grantee = 0 then 'PUBLIC'
                 else pg_catalog.pg_get_userbyid(a.grantee) end as grantee,
            a.privilege_type
       from pg_catalog.pg_proc as p,
            pg_catalog.aclexplode(
              coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as a
       where p.pronamespace = 'public'::pg_catalog.regnamespace
         and a.privilege_type = 'EXECUTE'
       order by 1, 2`);
  return { grants, policies, rls, routines };
}
const forTable = (catalog, table) => ({
  grants: catalog.grants.filter(g => g.table_name === table),
  policies: catalog.policies.filter(p => p.tablename === table),
  rls: catalog.rls.filter(r => r.relname === table),
});
const grantMap = catalog => {
  const map = {};
  for (const g of catalog.grants) (map[`${g.table_name}:${g.grantee}`] ??= []).push(g.privilege_type);
  for (const key of Object.keys(map)) map[key].sort();
  return map;
};
const routineGrantSet = catalog =>
  new Set(catalog.routines.map(r => `${r.signature}:${r.grantee}`));

// -- what HC Field build 30 actually posts, read out of App.js ----------------
// Parsed from the shipped source so this rehearsal cannot drift from the app.
function rpcBodyKeys(name) {
  const start = appSource.indexOf(`sb('rpc/${name}'`);
  assert.ok(start > 0, `App.js must still call rpc/${name}`);
  const bodyStart = appSource.indexOf('JSON.stringify({', start);
  const bodyEnd = appSource.indexOf('})', bodyStart);
  assert.ok(bodyStart > start && bodyEnd > bodyStart);
  const literal = appSource.slice(bodyStart, bodyEnd);
  assert.equal(literal.includes('}'), false, 'the posted body must be a flat object literal');
  return [...literal.matchAll(/[{,\n]\s*(p_[a-z_]+)\s*:/g)].map(m => m[1]);
}
const AUTHORIZE_KEYS = rpcBodyKeys('hc_authorize_notification_device');
const SYNC_KEYS = rpcBodyKeys('hc_sync_notification_device');
const secretPattern = appSource.match(/const NOTIFICATION_REVOKE_SECRET_RE = \/(.+?)\/([a-z]*);/);
assert.ok(secretPattern, 'App.js must still define NOTIFICATION_REVOKE_SECRET_RE');
const NOTIFICATION_REVOKE_SECRET_RE = new RegExp(secretPattern[1], secretPattern[2]);
const UUID_RE = new RegExp(appSource.match(/const UUID_RE = \/(.+?)\/([a-z]*);/)[1],
  appSource.match(/const UUID_RE = \/(.+?)\/([a-z]*);/)[2]);
const AUTH_FAILURE_MESSAGE = 'notification device authorization failed';
assert.ok(appSource.includes(`throw new Error('${AUTH_FAILURE_MESSAGE}')`),
  'App.js must still throw that exact message when authorization is not ok');

// PostgREST turns a POST body into a NAMED-argument call. Calling by name is
// what makes a parameter-name mismatch fail here the way it fails in production.
const namedCall = (fn, keys) =>
  `${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
const AUTHORIZE_SQL = `select * from public.${namedCall('hc_authorize_notification_device', AUTHORIZE_KEYS)}`;
const SYNC_SQL = `select public.${namedCall('hc_sync_notification_device', SYNC_KEYS)} as value`;

// syncNotificationDevice() from App.js:666-712, reduced to its database calls
// and to the one control-flow rule that matters: authorize FIRST, and throw
// before sync if it is not ok.
async function appRegistrationFlow({ deviceId, apnsToken, pushAllowed = true, liveSupported = true, canManage = true }) {
  if (canManage) {
    let result;
    try {
      result = await db.query(AUTHORIZE_SQL, [deviceId]);
    } catch {
      throw new Error(AUTH_FAILURE_MESSAGE);
    }
    const row = result.rows.length === 1 ? result.rows[0] : null;
    const secret = String(row?.revoke_secret ?? '').trim();
    if (!row || String(row.device_id ?? '').toLowerCase() !== deviceId
        || !NOTIFICATION_REVOKE_SECRET_RE.test(secret)) {
      throw new Error(AUTH_FAILURE_MESSAGE);
    }
    var storedSecret = secret.toLowerCase();
  }
  const response = await db.query(SYNC_SQL, [deviceId, apnsToken, pushAllowed, liveSupported])
    .catch(error => { throw new Error(`notification device reconciliation failed: ${error.message}`); });
  return { storedSecret: storedSecret ?? null, response };
}

// -- synthetic identities ----------------------------------------------------
const OWNER = { authUserId: '00000000-0000-4000-8000-000000000001', email: 'siddsaxena@gmail.com' };
const MANAGER = { authUserId: '20000000-0000-4000-8000-000000000002', email: 'manager@example.invalid' };
const TEAM = { authUserId: '20000000-0000-4000-8000-000000000003', email: 'team@example.invalid' };
const STALE = { authUserId: '20000000-0000-4000-8000-000000000004', email: 'exmanager@example.invalid' };
const OWNER_DEVICE = '70000000-0000-4000-8000-000000000001';
const MANAGER_DEVICE = '70000000-0000-4000-8000-000000000002';
const TEAM_DEVICE = '70000000-0000-4000-8000-000000000003';
const OWNER_APNS = 'd1'.repeat(32);
const MANAGER_APNS = 'b'.repeat(64);
const LEGACY_OWNER_APNS = 'a'.repeat(64);
for (const id of [OWNER_DEVICE, MANAGER_DEVICE, TEAM_DEVICE]) {
  assert.ok(UUID_RE.test(id), 'fixture device ids must satisfy the app own UUID_RE');
}

// A Supabase Storage stub. Migrations 035, 036 and 037 refuse without it, and
// production has it. Nothing 015c touches lives here.
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

// The roster, tokens and rows the notification path reads. Loaded BEFORE 015 so
// migration 015 links each roster row to its Auth identity exactly as it did in
// production. The owner push row is deliberately the frozen legacy shape: no
// device_id, updated_at 2026-08-13, which is what Sidd's row looks like today.
const SEED = `
insert into auth.users (id, email, email_confirmed_at) values
  ('${MANAGER.authUserId}', '${MANAGER.email}', '2026-01-02T00:00:00Z'),
  ('${TEAM.authUserId}', '${TEAM.email}', '2026-01-03T00:00:00Z'),
  ('${STALE.authUserId}', '${STALE.email}', '2026-01-04T00:00:00Z');
insert into public.field_workers (id, email, name, market, role, active) values
  ('10000000-0000-4000-8000-000000000002', '${MANAGER.email}', 'Sandbox Manager', 'ny', 'manager', true),
  ('10000000-0000-4000-8000-000000000003', '${TEAM.email}', 'Sandbox Team', 'ny', 'team', true),
  ('10000000-0000-4000-8000-000000000004', '${STALE.email}', 'Sandbox Ex-manager', 'ny', 'manager', false);
insert into public.orders (id, client_name, client_email, stage, market, total_cents, delivery_at_utc) values
  ('30000000-0000-4000-8000-000000000001', 'Sandbox beach club', 'sandbox@example.invalid', 'paid_full', 'ny', 90000, '2026-09-11T12:00:00Z'),
  ('30000000-0000-4000-8000-000000000002', 'Sandbox miami order', null, 'invoiced', 'miami', 45000, '2026-09-12T12:00:00Z');
insert into public.shifts (id, worker_name, worker_email, market, clock_in_at, device) values
  ('50000000-0000-4000-8000-000000000001', 'Sandbox Team', '${TEAM.email}', 'ny', now() - interval '2 hours', 'sandbox-fixture'),
  ('50000000-0000-4000-8000-000000000002', 'App Review', 'appreview@hamptonscoconuts.com', 'ny', now() - interval '1 hour', 'sandbox-fixture'),
  ('50000000-0000-4000-8000-000000000003', 'Sandbox Manager', '${MANAGER.email}', 'ny', now() - interval '5 hours', 'sandbox-fixture');
update public.shifts set clock_out_at = now() - interval '4 hours'
  where id = '50000000-0000-4000-8000-000000000003';
insert into public.shift_locations (shift_id, lat, lng)
  values ('50000000-0000-4000-8000-000000000001', 40.5, -74.3);
insert into public.push_tokens (email, apns_token, platform, updated_at) values
  ('${OWNER.email}', '${LEGACY_OWNER_APNS}', 'ios', '2026-08-13T10:00:00Z'),
  ('${MANAGER.email}', '${MANAGER_APNS}', 'ios', '2026-08-14T10:00:00Z');
insert into public.live_activity_tokens (id, email, token_type, shift_id, token, updated_at) values
  ('60000000-0000-4000-8000-000000000001', '${OWNER.email}', 'push_to_start', null, '${'c'.repeat(64)}', '2026-08-13T10:00:00Z');`;

async function productionShaped({ withStorage = true } = {}) {
  const handle = await PGlite.create({ extensions: { pgcrypto } });
  await handle.exec(supabaseBootstrap);
  if (withStorage) await handle.exec(STORAGE_STUB);
  await handle.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await handle.exec(baseFiles[name]);
  await handle.exec(SEED);
  for (const name of APPLIED_CHAIN) {
    if (!withStorage && ['035_order_logo_assets', '036_order_prep_workflow', '037_order_box_progress'].includes(name)) continue;
    await handle.exec(baseFiles[name]);
  }
  await identityOn(handle);
  return handle;
}

// Token tables carry RLS. Read them as the database owner, then put the caller
// identity back, so a snapshot can never come back empty because of the caller.
async function asOwner(handle, work) {
  const saved = currentIdentity.get(handle) ?? {};
  await identityOn(handle);
  try { return await work(); } finally { await identityOn(handle, saved); }
}
const tokenRows = handle => asOwner(handle, () => rowsOn(handle,
  'select email, apns_token, platform, updated_at, device_id from public.push_tokens order by email'));
const liveRows = handle => asOwner(handle, () => rowsOn(handle,
  'select id::text, email, token_type, shift_id::text, token, updated_at, device_id from public.live_activity_tokens order by id'));

const MIGRATION_015_RPCS = [
  'public.hc_sync_notification_device(uuid,text,boolean,boolean)',
  'public.hc_register_live_activity_token(text,uuid,text,uuid,boolean)',
  'public.hc_unregister_device(uuid)',
  'public.hc_can_manage_shifts()',
  'public.hc_start_shift(double precision,double precision,text)',
  'public.hc_clock_out_my_shift(uuid,timestamp with time zone,double precision,double precision)',
];

const branches = [];
try {
  db = await productionShaped();
  branches.push(db);
  const ident = (await db.query('select current_database() as name, version() as version')).rows[0];
  assert.equal(ident.name, 'postgres');
  assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  console.log('No connection string, no Supabase, no droplet, no network.\n');

  // == 1. this rehearsal is testing the shape the shipped app really posts ====
  assert.deepEqual(AUTHORIZE_KEYS, ['p_device_id']);
  assert.deepEqual(SYNC_KEYS, ['p_device_id', 'p_apns_token', 'p_push_allowed', 'p_live_supported']);
  assert.equal(NOTIFICATION_REVOKE_SECRET_RE.source, '^[0-9a-f]{64}$');
  assert.equal(NOTIFICATION_REVOKE_SECRET_RE.flags, 'i');
  pass(`App.js posts exactly ${JSON.stringify(AUTHORIZE_KEYS)} to rpc/hc_authorize_notification_device and exactly ${JSON.stringify(SYNC_KEYS)} to rpc/hc_sync_notification_device, so this rehearsal calls both by those parameter names`);
  console.log(`      authorize call: ${AUTHORIZE_SQL}`);
  console.log(`      sync call:      ${SYNC_SQL}`);
  console.log(`      secret gate:    NOTIFICATION_REVOKE_SECRET_RE = ${NOTIFICATION_REVOKE_SECRET_RE}\n`);

  // == 2. the starting state, and the live bug reproduced =====================
  for (const table of ['orders', 'field_workers', 'shifts', 'shift_locations',
    'push_tokens', 'live_activity_tokens', 'push_queue', 'intake_messages',
    'delivery_signatures', 'webhook_delivery_receipts', 'webhook_intake_queue']) {
    assert.equal(await relationExists(`public.${table}`), true, `${table} must exist`);
  }
  for (const signature of MIGRATION_015_RPCS) {
    assert.equal(await routineExists(signature), true, `${signature} must exist before 015c`);
  }
  assert.equal(await routineExists('public.hc_authorize_notification_device(uuid)'), false);
  assert.equal(await routineExists('public.hc_revoke_notification_device(uuid,text)'), false);
  assert.equal(await relationExists('public.notification_device_authorizations'), false);
  assert.equal(await relationExists('public.notification_device_security_state'), false);
  pass('starting state matches the live probe exactly: hc_sync_notification_device(uuid,text,boolean,boolean) is PRESENT and hc_authorize_notification_device(p_device_id) is ABSENT');
  for (const absent of ['public.hc_claim_live_activity_ends(timestamp with time zone,timestamp with time zone,integer)',
    'public.hc_validate_live_activity_start_delivery(uuid,uuid,uuid,integer,text)',
    'public.hc_enforce_notification_destination_authorization()',
    'public.hc_management_can_access_shift_market(text,text,text)']) {
    assert.equal(await routineExists(absent), false, `${absent} must be absent`);
  }
  pass('016, 017, 018, 022 and 025 are genuinely unapplied here, which is the state 015c is written for');

  const beforeCatalog = await accessCatalogOn(db);
  const beforeFunctions = await functionCatalogOn(db);
  const beforeTokens = await tokenRows(db);
  const beforeLive = await liveRows(db);
  const beforeOrders = await rows('select * from public.orders order by id');
  const beforeWorkers = await rows('select * from public.field_workers order by email');
  const beforeShifts = await rows('select * from public.shifts order by id');
  const rolesBefore = await rows('select rolname from pg_catalog.pg_roles order by rolname');
  const ownerTokenBefore = beforeTokens.find(t => t.email === OWNER.email);
  assert.equal(ownerTokenBefore.device_id, null);
  assert.equal(ownerTokenBefore.updated_at.toISOString(), '2026-08-13T10:00:00.000Z');
  pass("the owner's push_tokens row starts frozen the way production's does: updated_at 2026-08-13 and no device_id");

  await identity({ role: 'authenticated', sub: OWNER.authUserId });
  const preAuthorize = await db.query(AUTHORIZE_SQL, [OWNER_DEVICE]).catch(error => error);
  assert.equal(preAuthorize.code, '42883');
  console.log(`      live error reproduced: ${preAuthorize.code} ${preAuthorize.message}`);
  pass('THE LIVE BUG REPRODUCES: the exact authorize call the app makes fails with 42883 undefined_function, which is what PostgREST answers as 404 PGRST202');
  await assert.rejects(appRegistrationFlow({ deviceId: OWNER_DEVICE, apnsToken: OWNER_APNS }),
    error => error.message === AUTH_FAILURE_MESSAGE,
    'the app flow must throw before it reaches the token save');
  pass(`the modelled App.js flow throws '${AUTH_FAILURE_MESSAGE}' (App.js:580) before it ever reaches rpc/hc_sync_notification_device`);
  assert.deepEqual(await tokenRows(db), beforeTokens);
  pass('and because it threw first, nothing was written: push_tokens is byte for byte what it was, which is why the owner row is still dated 2026-08-13 after five builds');
  // The second RPC is present and would work. That is the live 403 vs 404 split.
  const syncOnlyProbe = await db.query(SYNC_SQL, [OWNER_DEVICE, OWNER_APNS, true, true]).catch(error => error);
  assert.ok(!(syncOnlyProbe instanceof Error), 'hc_sync_notification_device already works on its own');
  pass('proof the fault is registration and not delivery: hc_sync_notification_device by itself already succeeds today, it is only unreachable because authorize throws first');
  await identity();
  await db.exec(`update public.push_tokens set apns_token = '${LEGACY_OWNER_APNS}', updated_at = '2026-08-13T10:00:00Z', device_id = null where email = '${OWNER.email}';`);
  assert.deepEqual(await tokenRows(db), beforeTokens);

  // == 3. 015c executed BYTE FOR BYTE ========================================
  const byteForByte = await PGlite.create({ extensions: { pgcrypto } });
  branches.push(byteForByte);
  {
    const source = await productionShaped();
    branches.push(source);
    const failure = await refusesOn(source, '015c as written aborts on PostgreSQL 18', migration015c,
      '55000', /015c assertion failed: capability tables contain unexpected schema/);
    assert.equal(await relationExistsOn(source, 'public.notification_device_authorizations'), false);
    assert.equal(await routineExistsOn(source, 'public.hc_authorize_notification_device(uuid)'), false);
    assert.deepEqual(await tokenRows(source), beforeTokens);
    pass('that abort rolled the whole transaction back: no capability table, no authorize RPC, no token row touched');
    defect(`015c refuses to install on PostgreSQL 18. Four bare "count(*) from pg_catalog.pg_constraint" predicates expect 6 and 2; PostgreSQL 18 records NOT NULL constraints in pg_constraint (contype 'n'), so they see 14 and 4. Error: ${failure.code} ${failure.message}`);
    note('On PostgreSQL 17 and older, where NOT NULL constraints are NOT catalogued in pg_constraint, those counts are 6 and 2 and the assertion passes unchanged. That is proved from the live catalog a few lines below. So this is a portability defect, not a today-blocker on a Supabase project still on 15 or 17. The fix is one predicate: add `and constraint_info.contype <> \'n\'` to each of the four counts (migration lines 710-720 and 1902-1913). It is a no-op on 15 and 17 and correct on 18. CHECK BEFORE RUNNING: `select version()` in the Supabase SQL editor. If it says PostgreSQL 18, 015c will abort and change nothing, and the four predicates must be fixed first.');
  }
  const { patched: migration015cPg18, hits, reversed } = pg18Compatible(migration015c);
  assert.equal(hits, 4, 'the compatibility patch must touch exactly the four bare constraint counts');
  assert.equal(reversed, migration015c, 'stripping the added lines must reproduce the migration byte for byte');
  assert.equal(migration015cPg18.split(SHIM_LINE).length - 1, 4);
  pass('the PostgreSQL 18 compatibility patch is provably minimal: it adds exactly 4 identical lines and removing those 4 lines reproduces the migration file byte for byte');
  await byteForByte.close();

  // == 4. POINT 1: applies cleanly, and is idempotent ========================
  for (const attempt of [1, 2]) {
    await db.exec(migration015cPg18);
    pass(`015c applies cleanly on the production-shaped starting state (run ${attempt} of 2)`);
  }
  pass('015c is IDEMPOTENT: the second run passes its own re-run preflight, which re-checks every installed index, key and check expression');
  for (const relation of ['public.notification_device_authorizations', 'public.notification_device_security_state']) {
    assert.equal(await relationExists(relation), true);
  }
  for (const signature of ['public.hc_authorize_notification_device(uuid)',
    'public.hc_revoke_notification_device(uuid,text)', 'public.hc_list_managed_open_shift_ids()',
    'public.hc_notification_random_secret()', 'public.hc_notification_secret_hash(text)',
    'public.hc_purge_revoked_notification_device()', 'public.hc_revoke_ineligible_worker_devices()']) {
    assert.equal(await routineExists(signature), true, `${signature} must exist after 015c`);
  }
  assert.equal(await scalar('select count(*)::int as value from public.notification_device_authorizations'), 0);
  assert.equal(await scalar('select count(*)::int as value from public.notification_device_security_state'), 1);
  assert.equal(await scalar('select ever_issued_at as value from public.notification_device_security_state'), null);
  pass('after 015c both capability tables exist, all seven capability functions exist, no device is authorized yet and ever_issued_at is still null');
  // Show, from the live catalog, that the patched predicate is the ONLY thing
  // the version difference changes: excluding PostgreSQL 18's NOT NULL rows,
  // the two tables carry exactly the 6 and 2 constraints the file expects.
  for (const [table, expected] of [['notification_device_authorizations', 6], ['notification_device_security_state', 2]]) {
    assert.equal(await scalar(
      `select count(*)::int as value from pg_catalog.pg_constraint
         where conrelid = $1::pg_catalog.regclass and contype <> 'n'`, [`public.${table}`]), expected);
    assert.ok(await scalar(
      `select count(*)::int as value from pg_catalog.pg_constraint
         where conrelid = $1::pg_catalog.regclass and contype = 'n'`, [`public.${table}`]) > 0);
  }
  pass("confirmed from the catalog: ignoring PostgreSQL 18's NOT NULL constraint rows, the two capability tables carry exactly the 6 and 2 constraints 015c asserts, so on any PostgreSQL 17 or older the unpatched file passes that check unchanged");

  const afterInstallTokens = await tokenRows(db);
  const afterInstallLive = await liveRows(db);
  const afterInstallFunctions = await functionCatalogOn(db);
  // Negative control: the byte-for-byte token comparison used below has to be
  // able to fail, or POINT 4 would pass on an empty promise. Prove it fails on
  // a one-character change, on a throwaway copy, then discard that copy.
  {
    const control = await productionShaped();
    branches.push(control);
    await control.exec(migration015cPg18);
    await control.exec(`update public.push_tokens set apns_token = 'ff' || substring(apns_token from 3) where email = '${OWNER.email}';`);
    const mutated = await tokenRows(control);
    assert.throws(() => assert.deepEqual(mutated, beforeTokens),
      'the token snapshot comparison must detect a two-character change');
    pass('negative control: the push_tokens byte-for-byte comparison detects a two-character change, so POINT 4 passing means something');
    await control.close();
    branches.splice(branches.indexOf(control), 1);
  }

  // == 5. POINT 4: nothing migration 015 owns moved ==========================
  assert.deepEqual(afterInstallTokens, beforeTokens);
  assert.deepEqual(afterInstallLive, beforeLive);
  pass('POINT 4: every existing push_tokens and live_activity_tokens row survived 015c byte for byte (email, apns_token, platform, updated_at, device_id and token all identical)');
  const beforeByName = Object.fromEntries(beforeFunctions.map(f => [f.signature, f.definition]));
  const afterByName = Object.fromEntries(afterInstallFunctions.map(f => [f.signature, f.definition]));
  const changed = Object.keys(beforeByName).filter(sig => beforeByName[sig] !== afterByName[sig]);
  const removed = Object.keys(beforeByName).filter(sig => !(sig in afterByName));
  const added = Object.keys(afterByName).filter(sig => !(sig in beforeByName)).sort();
  assert.deepEqual(changed, []);
  assert.deepEqual(removed, []);
  pass(`POINT 4: not one pre-existing public function changed signature or body across 015c (${beforeFunctions.length} functions compared by pg_get_functiondef, 0 changed, 0 dropped)`);
  console.log(`      functions added by 015c: ${added.join(', ')}`);
  assert.deepEqual(added, [
    'hc_authorize_notification_device(uuid)',
    'hc_list_managed_open_shift_ids()',
    'hc_notification_random_secret()',
    'hc_notification_secret_hash(text)',
    'hc_purge_revoked_notification_device()',
    'hc_revoke_ineligible_worker_devices()',
    'hc_revoke_notification_device(uuid,text)',
  ]);
  pass('015c adds exactly seven functions and replaces none');

  // == 6. POINT 2: the authorize RPC the app calls now succeeds ==============
  await identity({ role: 'authenticated', sub: OWNER.authUserId });
  const authorized = (await rows(AUTHORIZE_SQL, [OWNER_DEVICE]))[0];
  assert.ok(authorized, 'the authorize RPC must return exactly one row');
  assert.equal(String(authorized.device_id).toLowerCase(), OWNER_DEVICE);
  pass('POINT 2: hc_authorize_notification_device called with EXACTLY { p_device_id } as an authenticated owner SUCCEEDS and echoes the device_id the app sent');
  assert.equal(typeof authorized.revoke_secret, 'string');
  assert.equal(NOTIFICATION_REVOKE_SECRET_RE.test(authorized.revoke_secret), true);
  assert.equal(authorized.revoke_secret.length, 64);
  assert.equal(authorized.secret_version, 1);
  pass(`POINT 2: the returned revoke_secret satisfies the app's own NOTIFICATION_REVOKE_SECRET_RE ${NOTIFICATION_REVOKE_SECRET_RE} (64 lowercase hex characters), so App.js:579 accepts it instead of throwing`);
  // The assertion above must be able to fail. Prove the same test rejects a
  // secret that does not satisfy the regex.
  assert.equal(NOTIFICATION_REVOKE_SECRET_RE.test(`${authorized.revoke_secret}z`), false);
  assert.equal(NOTIFICATION_REVOKE_SECRET_RE.test(authorized.revoke_secret.slice(0, 63)), false);
  pass('that regex check is a real gate, not a rubber stamp: a 65-character or 63-character value fails it');
  // Named-argument binding is the whole point: PostgREST calls by parameter
  // NAME, so a name mismatch is what produced the live 404. Prove the call
  // really binds by name and not by position.
  await denied('calling the same function with a wrong parameter name fails, which proves these calls bind by NAME the way PostgREST does',
    'select * from public.hc_authorize_notification_device(p_deviceid => $1)', [OWNER_DEVICE], '42883', /does not exist/);
  const secondAuthorize = (await rows(AUTHORIZE_SQL, [OWNER_DEVICE]))[0];
  assert.notEqual(secondAuthorize.revoke_secret, authorized.revoke_secret);
  assert.equal(secondAuthorize.secret_version, 2);
  assert.equal(NOTIFICATION_REVOKE_SECRET_RE.test(secondAuthorize.revoke_secret), true);
  pass('re-authorizing the same phone rotates the secret and bumps secret_version 1 -> 2, so a reinstall cannot be revoked with the old capability');
  assert.equal(await scalarOn(db, 'select public.hc_revoke_notification_device($1, $2) as value', [OWNER_DEVICE, authorized.revoke_secret]), false);
  pass('the rotated-out secret can no longer revoke the device');
  await identity();
  assert.notEqual(await scalar('select ever_issued_at as value from public.notification_device_security_state'), null);
  pass('the first successful authorization set the permanent ever_issued_at marker, which is what makes the rollback refuse afterwards');

  // == 7. POINT 3: the token save the app could never reach ==================
  await identity({ role: 'authenticated', sub: OWNER.authUserId });
  const flow = await appRegistrationFlow({ deviceId: OWNER_DEVICE, apnsToken: OWNER_APNS });
  assert.ok(NOTIFICATION_REVOKE_SECRET_RE.test(flow.storedSecret));
  await identity();
  const ownerTokenAfter = (await tokenRows(db)).find(t => t.email === OWNER.email);
  assert.equal(ownerTokenAfter.apns_token, OWNER_APNS);
  assert.equal(ownerTokenAfter.device_id, OWNER_DEVICE);
  assert.ok(ownerTokenAfter.updated_at.getTime() > ownerTokenBefore.updated_at.getTime());
  pass(`POINT 3: the whole App.js flow now runs end to end. hc_sync_notification_device with EXACTLY ${JSON.stringify(SYNC_KEYS)} wrote the token row: apns_token is the new device token, device_id is bound, and updated_at moved off 2026-08-13`);
  note('BEFORE 015c that same modelled flow threw at the authorize step and left push_tokens untouched (section 2). AFTER 015c it completes and rewrites the row. That is the proven fix, not an assumption.');
  // A second phone for a second manager, to prove this is not owner-only.
  await identity({ role: 'authenticated', sub: MANAGER.authUserId });
  const managerFlow = await appRegistrationFlow({ deviceId: MANAGER_DEVICE, apnsToken: 'e7'.repeat(32) });
  assert.ok(NOTIFICATION_REVOKE_SECRET_RE.test(managerFlow.storedSecret));
  await identity();
  const managerToken = (await tokenRows(db)).find(t => t.email === MANAGER.email);
  assert.equal(managerToken.device_id, MANAGER_DEVICE);
  assert.equal(managerToken.apns_token, 'e7'.repeat(32));
  pass('an active manager on a second phone completes the same flow and gets their own device-bound token row');
  assert.equal(await scalar('select count(*)::int as value from public.notification_device_authorizations where revoked_at is null'), 2);
  // The re-run that actually matters: 015c applied again once real phones are
  // authorized. It must not rotate anyone's secret or drop anyone's token.
  await identity();
  const authRowsBeforeRerun = await rows(
    `select device_id::text, auth_user_id::text, field_worker_id::text,
            pg_catalog.encode(revoke_secret_hash, 'hex') as hash, secret_version,
            authorized_at, revoked_at, updated_at
       from public.notification_device_authorizations order by device_id`);
  const tokensBeforeRerun = await tokenRows(db);
  const issuedBeforeRerun = await scalar('select ever_issued_at as value from public.notification_device_security_state');
  await db.exec(migration015cPg18);
  assert.deepEqual(await rows(
    `select device_id::text, auth_user_id::text, field_worker_id::text,
            pg_catalog.encode(revoke_secret_hash, 'hex') as hash, secret_version,
            authorized_at, revoked_at, updated_at
       from public.notification_device_authorizations order by device_id`), authRowsBeforeRerun);
  assert.deepEqual(await tokenRows(db), tokensBeforeRerun);
  assert.deepEqual(await scalar('select ever_issued_at as value from public.notification_device_security_state'), issuedBeforeRerun);
  pass('POINT 1, the re-run that matters: applying 015c a third time WITH two phones already authorized changed nothing. Same secret hashes, same secret_version, same authorized_at, same tokens, same ever_issued_at. Re-running it does not sign anybody out');

  // == 8. POINT 5: who is refused ============================================
  await identity({ role: 'anon' });
  await denied('POINT 5: anon cannot execute hc_authorize_notification_device at all',
    AUTHORIZE_SQL, [OWNER_DEVICE], '42501', /permission denied for function/);
  await denied('POINT 5: anon cannot execute hc_sync_notification_device at all',
    SYNC_SQL, [OWNER_DEVICE, OWNER_APNS, true, true], '42501', /permission denied for function/);
  await identity({ role: 'authenticated' });
  await denied('POINT 5: an authenticated connection with no JWT subject is refused inside the authorize RPC',
    AUTHORIZE_SQL, [OWNER_DEVICE], '42501', /authenticated Supabase user required/);
  await denied('POINT 5: an authenticated connection with no JWT subject is refused inside the sync RPC',
    SYNC_SQL, [OWNER_DEVICE, OWNER_APNS, true, true], '42501', /authenticated Supabase user required/);
  await identity({ role: 'authenticated', sub: '20000000-0000-4000-8000-0000000000ff' });
  await denied('POINT 5: a signed-in Supabase user who is on no roster row is refused by authorize',
    AUTHORIZE_SQL, [OWNER_DEVICE], '42501', /active owner or manager required/);
  await denied('POINT 5: a signed-in Supabase user who is on no roster row is refused by sync too',
    SYNC_SQL, [OWNER_DEVICE, OWNER_APNS, true, true], '42501', /linked field worker identity required/);
  // A team-role worker: state plainly what the migration intends.
  await identity({ role: 'authenticated', sub: TEAM.authUserId });
  await denied('POINT 5: an ACTIVE team-role worker is refused by hc_authorize_notification_device',
    AUTHORIZE_SQL, [TEAM_DEVICE], '42501', /active owner or manager required/);
  await db.query(SYNC_SQL, [TEAM_DEVICE, 'f3'.repeat(32), true, true]);
  await identity();
  assert.equal(await scalar('select count(*)::int as value from public.push_tokens where lower(email) = $1', [TEAM.email]), 0);
  pass("POINT 5 stated plainly: a team-role worker gets NO device authorization (42501 'active owner or manager required') and migration 015's sync RPC then deletes every push destination for that account. Team members are not push recipients by design, in 015 and in 015c alike. App.js:673 never even calls authorize for them, because canManageRole(w) is false, so 015c changes nothing for a team worker");
  note('CONSEQUENCE FOR TODAY: the two employees clocked in right now are only push RECIPIENTS if their field_workers.role is owner or manager. If they are team, no migration in this series will ever give them a lock-screen banner. The person 015c unblocks is Sidd, the owner whose phone could not register.');
  // Service role is not granted either RPC by 015c.
  await identity({ role: 'service_role' });
  await denied('service_role cannot execute hc_authorize_notification_device either',
    AUTHORIZE_SQL, [OWNER_DEVICE], '42501', /permission denied for function/);
  await identity();

  // -- the one function 015c deliberately opens to anon --
  assert.equal(await scalar('select has_function_privilege($1,$2,$3) as value',
    ['anon', 'public.hc_revoke_notification_device(uuid,text)', 'execute']), true);
  await identity({ role: 'anon' });
  assert.equal(await scalar('select public.hc_revoke_notification_device($1,$2) as value',
    [OWNER_DEVICE, 'f'.repeat(64)]), false);
  assert.equal(await scalar('select public.hc_revoke_notification_device($1,$2) as value',
    [OWNER_DEVICE, 'not-a-hex-secret']), false);
  await identity();
  assert.equal(await scalar('select count(*)::int as value from public.push_tokens where lower(email) = $1', [OWNER.email]), 1);
  pass('015c deliberately grants hc_revoke_notification_device to anon (it must work after the Auth session is gone). A wrong or malformed secret returns false and changes nothing: the owner token row is still there');
  await identity({ role: 'anon' });
  assert.equal(await scalar('select public.hc_revoke_notification_device($1,$2) as value',
    [MANAGER_DEVICE, managerFlow.storedSecret]), true);
  assert.equal(await scalar('select public.hc_revoke_notification_device($1,$2) as value',
    [MANAGER_DEVICE, managerFlow.storedSecret]), true);
  await identity();
  assert.equal(await scalar('select count(*)::int as value from public.push_tokens where lower(email) = $1', [MANAGER.email]), 0);
  assert.equal(await scalar("select revoked_reason as value from public.notification_device_authorizations where device_id = $1", [MANAGER_DEVICE]), 'device capability revoked');
  pass('with the CORRECT 64-hex secret the anon revoke works and is idempotent, and it deletes only that phone push destination');
  note("SECURITY NOTE, stated rather than glossed: 015c widens the anon RPC surface by exactly one function, hc_revoke_notification_device(uuid,text). It is a bearer capability by design, it only ever DELETES that one phone's destinations, and it needs the exact 32-byte secret, but it is a new anon-reachable, state-changing function and should be read as such.");
  // Put the manager phone back so the later diffs are on a live pair.
  await identity({ role: 'authenticated', sub: MANAGER.authUserId });
  await appRegistrationFlow({ deviceId: MANAGER_DEVICE, apnsToken: MANAGER_APNS });
  await identity();

  // -- the inactive manager, and the two triggers 015c installs --
  await identity({ role: 'authenticated', sub: STALE.authUserId });
  await denied('POINT 5: a DEACTIVATED manager is refused by hc_authorize_notification_device',
    AUTHORIZE_SQL, [TEAM_DEVICE], '42501', /active owner or manager required/);
  await identity();
  {
    const roster = await productionShaped();
    branches.push(roster);
    await roster.exec(migration015cPg18);
    for (const [who, device, token] of [[OWNER, OWNER_DEVICE, OWNER_APNS], [MANAGER, MANAGER_DEVICE, MANAGER_APNS]]) {
      await identityOn(roster, { role: 'authenticated', sub: who.authUserId });
      await roster.query(AUTHORIZE_SQL, [device]);
      await roster.query(SYNC_SQL, [device, token, true, true]);
    }
    await identityOn(roster);
    assert.equal(await scalarOn(roster, 'select count(*)::int as value from public.notification_device_authorizations where revoked_at is null'), 2);
    // Deactivation.
    await roster.exec(`update public.field_workers set active = false where lower(email) = '${MANAGER.email}';`);
    const revoked = (await rowsOn(roster,
      'select revoked_at, revoked_reason from public.notification_device_authorizations where device_id = $1', [MANAGER_DEVICE]))[0];
    assert.ok(revoked.revoked_at, 'deactivating the roster row must revoke the device');
    assert.equal(await scalarOn(roster, 'select count(*)::int as value from public.push_tokens where lower(email) = $1', [MANAGER.email]), 0);
    assert.equal(await scalarOn(roster,
      'select (revoked_at is null) as value from public.notification_device_authorizations where device_id = $1', [OWNER_DEVICE]), true);
    assert.equal(await scalarOn(roster, 'select count(*)::int as value from public.push_tokens where lower(email) = $1', [OWNER.email]), 1);
    pass(`both triggers 015c installs really fire: deactivating a manager on field_workers revoked THAT device ('${revoked.revoked_reason}') and deleted THAT phone's push_tokens row, while the owner's device and token were left alone`);
    // Role downgrade.
    await roster.exec(`update public.field_workers set role = 'team' where lower(email) = '${OWNER.email}';`);
    assert.equal(await scalarOn(roster,
      'select (revoked_at is not null) as value from public.notification_device_authorizations where device_id = $1', [OWNER_DEVICE]), true);
    assert.equal(await scalarOn(roster, 'select count(*)::int as value from public.push_tokens where lower(email) = $1', [OWNER.email]), 0);
    pass('a role downgrade from owner to team revokes the same way, so a demoted account stops receiving push without anyone touching the phone');
    // An unlinked roster row cannot authorize, whatever its role says.
    await roster.exec(`update public.field_workers set role = 'manager', active = true, auth_user_id = null where lower(email) = '${TEAM.email}';`);
    await identityOn(roster, { role: 'authenticated', sub: TEAM.authUserId });
    await assert.rejects(roster.query(AUTHORIZE_SQL, [TEAM_DEVICE]),
      error => error.code === '42501' && /active owner or manager required/.test(error.message));
    await identityOn(roster);
    pass('a roster row that is an ACTIVE MANAGER but has no auth_user_id still cannot authorize a device: 015c matches on the Auth link, not on the email');
    note("PREFLIGHT FOR SIDD, one query: `select email, role, active, auth_user_id from field_workers where auth_user_id is null`. Any owner or manager listed there will still get 'active owner or manager required' after 015c, because the RPC matches on the Supabase Auth link. Signing in on the phone is what sets it (hc_claim_field_worker); 015 set it for anyone already signed in when it ran.");
  }

  // -- a phone changing hands --
  assert.equal(await scalar('select count(*)::int as value from public.push_tokens where lower(email) = $1', [MANAGER.email]), 1);
  await identity({ role: 'authenticated', sub: OWNER.authUserId });
  const handover = (await rows(AUTHORIZE_SQL, [MANAGER_DEVICE]))[0];
  assert.ok(NOTIFICATION_REVOKE_SECRET_RE.test(handover.revoke_secret));
  await identity();
  assert.equal(await scalar('select count(*)::int as value from public.push_tokens where lower(email) = $1', [MANAGER.email]), 0);
  assert.equal(await scalar('select auth_user_id::text as value from public.notification_device_authorizations where device_id = $1', [MANAGER_DEVICE]), OWNER.authUserId);
  pass("a phone changing hands is handled: when a different signed-in owner authorizes a device that another account held, that device's old push destination is deleted in the same transaction, so the previous person's notifications cannot land on it");

  // -- the third function 015c installs, exercised --
  await identity({ role: 'authenticated', sub: OWNER.authUserId });
  const openShifts = (await rows('select shift_id::text as shift_id from public.hc_list_managed_open_shift_ids()')).map(r => r.shift_id);
  assert.deepEqual(openShifts, ['50000000-0000-4000-8000-000000000001']);
  await identity({ role: 'authenticated', sub: TEAM.authUserId });
  await denied('a team worker cannot call hc_list_managed_open_shift_ids',
    'select * from public.hc_list_managed_open_shift_ids()', [], '42501', /owner or manager required/);
  await identity({ role: 'anon' });
  await denied('anon cannot call hc_list_managed_open_shift_ids',
    'select * from public.hc_list_managed_open_shift_ids()', [], '42501', /permission denied for function/);
  await identity();
  pass('hc_list_managed_open_shift_ids works for the owner and returns only the real open shift: the synthetic App Review shift is excluded, and team and anon are refused');

  // == 9. POINT 6: THE TRAP ==================================================
  const authorizeDefBefore21 = await functionDef('public.hc_authorize_notification_device(uuid)');
  assert.match(authorizeDefBefore21, /for update of fw/);
  assert.match(authorizeDefBefore21, /ever_issued_at/);
  pass("015c's authorize function carries both of the protections its header names: the `for update of fw` roster lock and the ever_issued_at permanent-issue marker");
  const trapRefusal = await refuses('POINT 6: running migration 021 immediately after 015c is refused',
    migration021, '55000', /021 requires migrations 015 through 018/);
  assert.equal(await functionDef('public.hc_authorize_notification_device(uuid)'), authorizeDefBefore21);
  assert.equal(await scalar('select count(*)::int as value from public.notification_device_authorizations'), 2);
  pass('the refused 021 changed nothing: the corrected authorize function and both live authorizations are exactly as they were');
  note(`WHY 021 refuses today: its own preflight demands 017 and 018 (${trapRefusal.message}), and 015c's preflight refuses to install if 017 or 018 are present. The two are mutually exclusive ONLY while 016, 017 and 018 stay unapplied. 015c itself installs no marker, no version row, no guard function and no comment in the database that would stop 021.`);
  {
    // The trap, executed. 015c, then the documented rollout order 016, 017, 018,
    // then 021, exactly as a future session following the numbered files would.
    const trap = await productionShaped();
    branches.push(trap);
    await trap.exec(migration015cPg18);
    await identityOn(trap, { role: 'authenticated', sub: OWNER.authUserId });
    const trapSecret = (await rowsOn(trap, AUTHORIZE_SQL, [OWNER_DEVICE]))[0].revoke_secret;
    assert.ok(NOTIFICATION_REVOKE_SECRET_RE.test(trapSecret));
    await identityOn(trap);
    const beforeTrap = await functionDefOn(trap, 'public.hc_authorize_notification_device(uuid)');
    // 016 refuses while any open shift has no active authenticated worker, and
    //018 refuses while ANY shift is open at all ("clock out every open shift
    // before START dedup cutover"). Both are their own documented preconditions,
    // so satisfy them here and let the trap be tested on its merits.
    await trap.exec('update public.shifts set clock_out_at = now() where clock_out_at is null;');
    for (const name of LATER_CHAIN) await trap.exec(baseFiles[name]);
    pass('on a branch database, migrations 016, 017 and 018 all apply cleanly ON TOP of 015c: the documented rollout order is not blocked');
    await trap.exec(migration021);
    const afterTrap = await functionDefOn(trap, 'public.hc_authorize_notification_device(uuid)');
    assert.notEqual(afterTrap, beforeTrap);
    assert.match(beforeTrap, /for update of fw/);
    assert.equal(/for update of fw/.test(afterTrap), false);
    assert.match(beforeTrap, /ever_issued_at/);
    assert.equal(/ever_issued_at/.test(afterTrap), false);
    assert.equal(await scalarOn(trap, "select count(*)::int as value from information_schema.columns where table_schema='public' and table_name='notification_device_security_state' and column_name='ever_issued_at'"), 1);
    defect('POINT 6 ANSWER, and it is a NO: 015c does NOT block migration 021. Run 016, 017 and 018 (all three apply cleanly after 015c) and 021 then applies without any complaint and CREATE OR REPLACEs hc_authorize_notification_device with the version that has neither the `for update of fw` roster lock nor the ever_issued_at marker write. The only thing standing between Sidd and that silent downgrade today is that 016, 017 and 018 have not been run.');
    note('The ever_issued_at COLUMN survives 021 (021 uses create table if not exists), so the rollback file keeps refusing. What is lost is the code that WRITES it: after 021 a fresh install would set no marker at all, and the roster row is no longer locked while the device is authorized.');
    note('CONCRETE GUARD TO ADD BEFORE SHIPPING 015c: give 015c a marker 021 would trip over, or amend 021 to refuse when notification_device_security_state.ever_issued_at exists. A header comment is not a guard. This is the same shape as the 027-after-029 trap hit earlier today.');
  }

  // == 10. POINT 8: the full access audit ===================================
  const afterCatalog = await accessCatalogOn(db);
  const beforeGrants = grantMap(beforeCatalog);
  const afterGrants = grantMap(afterCatalog);
  for (const table of ['orders', 'field_workers', 'shifts', 'shift_locations', 'push_tokens', 'live_activity_tokens', 'push_queue']) {
    assert.deepEqual(forTable(afterCatalog, table), forTable(beforeCatalog, table),
      `${table} grants, policies and RLS must be untouched by 015c`);
  }
  pass('POINT 8: orders, field_workers, shifts, shift_locations, push_tokens, live_activity_tokens and push_queue have IDENTICAL table grants, row policies and RLS flags before and after 015c');
  const API_ROLES = new Set(['anon', 'authenticated', 'service_role', 'PUBLIC']);
  // Only tables that already existed can be "widened". The two brand-new
  // private capability tables are enumerated on their own line below.
  const preExistingTables = new Set(beforeCatalog.grants.map(g => g.table_name));
  const widened = Object.entries(afterGrants).filter(([key, privileges]) => {
    const [table, grantee] = key.split(':');
    if (!API_ROLES.has(grantee) || !preExistingTables.has(table)) return false;
    return privileges.some(privilege => !(beforeGrants[key] || []).includes(privilege));
  }).map(([key]) => key).sort();
  assert.deepEqual(widened, []);
  const newGrantKeys = Object.keys(afterGrants).filter(key => !(key in beforeGrants)).sort();
  assert.deepEqual(newGrantKeys, [
    'notification_device_authorizations:postgres',
    'notification_device_authorizations:service_role',
    'notification_device_security_state:postgres',
    'notification_device_security_state:service_role',
  ]);
  pass('POINT 8: a full public-schema privilege diff finds ZERO table privileges widened for anon, authenticated, service_role or PUBLIC. The only new table grants anywhere are on the two brand-new private capability tables, to the database owner and service_role');
  const newPolicies = afterCatalog.policies.filter(p =>
    !beforeCatalog.policies.some(b => b.tablename === p.tablename && b.policyname === p.policyname));
  assert.deepEqual(newPolicies, []);
  pass('POINT 8: 015c creates no row-level-security policy at all, on any table, so it exposes no new row to any client key');
  for (const table of ['notification_device_authorizations', 'notification_device_security_state']) {
    assert.equal(await scalar(
      'select relrowsecurity as value from pg_catalog.pg_class where oid = $1::pg_catalog.regclass', [`public.${table}`]), true);
    for (const role of ['anon', 'authenticated', 'PUBLIC']) {
      assert.equal(afterGrants[`${table}:${role}`], undefined, `${table} must grant ${role} nothing`);
    }
  }
  pass('POINT 8: both capability tables have RLS on, zero policies, and not one privilege for anon, authenticated or PUBLIC. The revoke-secret hashes are unreachable through the public anon key');
  assert.deepEqual(await rows('select rolname from pg_catalog.pg_roles order by rolname'), rolesBefore);
  pass('POINT 8: 015c created, dropped or renamed no database role');
  const beforeRoutineGrants = routineGrantSet(beforeCatalog);
  const newRoutineGrants = [...routineGrantSet(afterCatalog)].filter(key => !beforeRoutineGrants.has(key)).sort();
  console.log('\n-- every EXECUTE grant 015c adds --');
  for (const key of newRoutineGrants) console.log(`  ${key.replace(':', '   -> ')}`);
  const clientRoutineGrants = newRoutineGrants.filter(key => {
    const grantee = key.slice(key.lastIndexOf(':') + 1);
    return grantee === 'anon' || grantee === 'authenticated' || grantee === 'PUBLIC';
  }).sort();
  assert.deepEqual(clientRoutineGrants, [
    'hc_authorize_notification_device(uuid):authenticated',
    'hc_list_managed_open_shift_ids():authenticated',
    'hc_revoke_notification_device(uuid,text):anon',
    'hc_revoke_notification_device(uuid,text):authenticated',
  ]);
  pass('POINT 8: exactly four new client-reachable EXECUTE grants, and no other function anywhere changed who may run it. anon gains exactly one function, the bearer revoke');
  for (const signature of ['public.hc_notification_random_secret()', 'public.hc_notification_secret_hash(text)',
    'public.hc_purge_revoked_notification_device()', 'public.hc_revoke_ineligible_worker_devices()']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await scalar('select has_function_privilege($1,$2,$3) as value', [role, signature, 'execute']), false,
        `${role} must not be able to execute ${signature}`);
    }
  }
  pass('POINT 8: the secret generator, the secret hasher and both trigger functions are executable by nobody but the database owner');
  for (const signature of ['public.hc_authorize_notification_device(uuid)',
    'public.hc_revoke_notification_device(uuid,text)', 'public.hc_list_managed_open_shift_ids()']) {
    assert.equal(await scalar('select prosecdef as value from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure($1)', [signature]), true);
    assert.equal(await scalar(
      `select exists (select 1 from pg_catalog.unnest(proconfig) as s(v) where s.v like 'search_path=%') as value
         from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure($1)`, [signature]), true);
  }
  pass('POINT 8: all three client-callable new functions are SECURITY DEFINER with a pinned search_path');
  // Static enumeration: every GRANT and REVOKE statement in the file, so the
  // runtime diff above can be checked against the source that produced it.
  const accessStatements = [...migration015c.matchAll(/^(grant|revoke)[\s\S]*?;/gm)]
    .map(m => m[0].split('\n').map(line => line.trim()).join(' ').replace(/\s+/g, ' '));
  console.log('\n-- every GRANT and REVOKE statement in 015c, in file order --');
  for (const statement of accessStatements) console.log(`  ${statement}`);
  assert.equal(accessStatements.length, 14);
  assert.equal(accessStatements.filter(s => s.startsWith('revoke')).length, 9);
  assert.equal(accessStatements.filter(s => s.startsWith('grant')).length, 5);
  assert.equal(accessStatements.filter(s => /\b(orders|shifts|shift_locations|push_tokens|live_activity_tokens|field_workers|push_queue)\b/.test(s)).length, 0);
  assert.equal(migration015c.includes('create policy'), false);
  assert.equal(migration015c.includes('drop policy'), false);
  assert.equal(/alter table (?!public\.notification_device_)/.test(migration015c), false);
  pass('POINT 8 enumerated from the source too: 015c contains exactly 14 access statements (9 REVOKE, 5 GRANT), not one of which names orders, shifts, shift_locations, push_tokens, live_activity_tokens, field_workers or push_queue; it contains no CREATE POLICY, no DROP POLICY, and no ALTER TABLE on any table but its own two');

  // == 11. the shipped rehearsal SQL files ==================================
  {
    const guardFailure = await refuses('rehearsal/001a as written refuses on this production-shaped database',
      fixture001a, '55000', /SANDBOX GUARD/);
    note(`rehearsal/001a_notification_device_transition_fixture.sql RAN and REFUSED here, correctly: ${guardFailure.message}. Its guards are written for the disposable hc-field-rehearsal project after migrations 001 and 021, not for a production-shaped database.`);
    let checksFailure = null;
    try { await db.exec(checks002); } catch (error) { checksFailure = error; }
    try { await db.exec('rollback;'); } catch { /* nothing open */ }
    assert.ok(checksFailure, 'rehearsal/002 must not pass here');
    pass(`rehearsal/002_notification_device_authorization_checks.sql RAN and FAILED here as expected (${checksFailure.code}: ${checksFailure.message})`);
    note('rehearsal/002 CANNOT pass on 015 + 015c and this is not a 015c defect: 002 calls hc_claim_live_activity_starts_v2 and hc_validate_live_activity_start_delivery, which migration 018 creates, and it expects hc_unregister_device to leave revoked_reason = \'authenticated sign-out\', which migration 022 introduces. 015c installs neither 018 nor 022 by design.');
  }
  // 001a on a database shaped the way 001a itself demands.
  {
    const sandbox = await productionShaped();
    branches.push(sandbox);
    await sandbox.exec(migration015cPg18);
    // 001's own guards demand exactly one confirmed Auth user and a roster of
    // only Sidd plus worker@sandbox.invalid, so strip this database back to
    // that BEFORE running it. Then it fails for the one reason that matters.
    await sandbox.exec(`
      delete from public.push_tokens;
      delete from public.live_activity_tokens;
      delete from public.orders;
      delete from public.shift_locations;
      delete from public.shifts;
      delete from public.field_workers where lower(email) <> 'siddsaxena@gmail.com';
      delete from auth.users where lower(email) <> 'siddsaxena@gmail.com';
      insert into public.orders (id, client_name, stage, market, total_cents)
        values ('30000000-0000-4000-8000-0000000000a1', 'Sandbox beach club', 'paid_full', 'ny', 90000);`);
    const fixtureFailure = await refusesOn(sandbox, 'rehearsal/001_post_cutover_fixture.sql as written cannot run on 015 + 015c',
      fixture001, '23503', /shift worker email is not on the active field roster/);
    note(`rehearsal/001_post_cutover_fixture.sql CANNOT run offline against a 015 + 015c database: ${fixtureFailure.message}. Its two open shifts belong to a DEACTIVATED worker and to the App Review account, and migration 015's shifts_assign_field_worker trigger refuses both on INSERT. Its live_activity_tokens insert would then fail again on end_requested_at, a column migration 017 adds. 001 says on its own first line that it is for a database with 015 through 018 applied, so this is expected, not a 015c defect.`);
    // Seed what 001 would have created, with that one 015 INSERT trigger off
    // for the seed only, and then find the hard blocker.
    await sandbox.exec(`
      insert into public.field_workers (id, email, name, market, role, active)
        values ('00000000-0000-4000-8000-000000000103', 'worker@sandbox.invalid', 'Sandbox Worker', 'ny', 'team', false);
      alter table public.shifts disable trigger shifts_assign_field_worker;
      insert into public.shifts (id, worker_name, worker_email, market, clock_in_at, device) values
        ('00000000-0000-4000-8000-000000000601', 'Sandbox Worker', 'worker@sandbox.invalid', 'ny', now() - interval '30 minutes', 'sandbox-fixture'),
        ('00000000-0000-4000-8000-000000000602', 'App Review', 'appreview@hamptonscoconuts.com', 'ny', now() - interval '20 minutes', 'sandbox-fixture');
      alter table public.shifts enable trigger shifts_assign_field_worker;
      insert into public.live_activity_tokens (id, email, token_type, shift_id, token, device_id, updated_at)
        values ('00000000-0000-4000-8000-000000000501', 'siddsaxena@gmail.com', 'push_to_start', null, ${"repeat('a', 64)"}, '00000000-0000-4000-8000-000000000401', now());`);
    const twoPhoneFailure = await sandbox.query(
      `insert into public.live_activity_tokens (id, email, token_type, shift_id, token, device_id, updated_at)
         values ('00000000-0000-4000-8000-000000000502', 'siddsaxena@gmail.com', 'push_to_start', null, repeat('b', 64), '00000000-0000-4000-8000-000000000402', now())`)
      .catch(error => error);
    assert.equal(twoPhoneFailure.code, '23505');
    assert.match(twoPhoneFailure.message, /live_activity_tokens_p2s_uniq/);
    pass(`the two-phone state 001a requires is UNREACHABLE on 015 + 015c: ${twoPhoneFailure.code} ${twoPhoneFailure.message}`);
    note("WHY rehearsal/001a cannot validate this bridge: it needs TWO push_to_start rows on the same owner email (devices ...401 and ...402), and migration 015 deliberately retains migration 010's live_activity_tokens_p2s_uniq index, which allows exactly one push_to_start row per EMAIL. Migration 017 is what drops that index, and 015c refuses to coexist with 017. So 001a's fixture state cannot exist in any database 015c is allowed to install into. Reported honestly rather than forced.");
    const gateStart = fixture001a.lastIndexOf('if exists (', fixture001a.indexOf('from public.push_tokens as token_row'));
    const gateEnd = fixture001a.indexOf('end if;',
      fixture001a.indexOf('SANDBOX ASSERTION: migration 022 authorization gate is not zero')) + 'end if;'.length;
    assert.ok(gateStart > 0 && gateEnd > gateStart);
    const gateBlock = `do $gate$\nbegin\n${fixture001a.slice(gateStart, gateEnd)}\nend\n$gate$;`;
    let gateFailure = null;
    try { await db.exec(gateBlock); } catch (error) { gateFailure = error; }
    try { await db.exec('rollback;'); } catch { /* nothing open */ }
    if (gateFailure) {
      pass(`001a's own closing assertion, lifted verbatim and run against the main post-015c database, FAILS: ${gateFailure.code} ${gateFailure.message}`);
      note('That failure is about the FUTURE migration 022, not about 015c. The legacy Live Activity push_to_start row that predates device IDs (device_id null) can never match an authorization row, so a later 022 cutover would strand it. PREFLIGHT FOR SIDD: before 022 is ever run, every push_tokens and live_activity_tokens row must belong to an authorized device. After 015c, opening the app on each owner or manager phone is what creates those authorizations; any row left with a null device_id has to be deleted or re-registered first.');
    } else {
      pass("001a's own closing assertion, lifted verbatim and run against the main post-015c database, PASSES: every notification destination belongs to an authorized, active owner or manager device");
    }
    await identityOn(sandbox);
  }

  // == 12. POINT 7: the rollback ============================================
  {
    const clean = await productionShaped();
    branches.push(clean);
    await clean.exec(migration015cPg18);
    const cleanTokens = await tokenRows(clean);
    const cleanLive = await liveRows(clean);
    const cleanFunctions = await functionCatalogOn(clean);
    const cleanAccess = await accessCatalogOn(clean);
    await clean.exec(rollback015c);
    pass('POINT 7: the 015c rollback RUNS and completes on a bridge that has never issued a capability');
    for (const relation of ['public.notification_device_authorizations', 'public.notification_device_security_state']) {
      assert.equal(await relationExistsOn(clean, relation), false, `${relation} must be gone`);
    }
    for (const signature of ['public.hc_authorize_notification_device(uuid)',
      'public.hc_revoke_notification_device(uuid,text)', 'public.hc_notification_random_secret()',
      'public.hc_notification_secret_hash(text)', 'public.hc_purge_revoked_notification_device()',
      'public.hc_revoke_ineligible_worker_devices()']) {
      assert.equal(await routineExistsOn(clean, signature), false, `${signature} must be gone`);
    }
    assert.equal(await routineExistsOn(clean, 'public.hc_list_managed_open_shift_ids()'), true);
    assert.equal(await scalarOn(clean, "select count(*)::int as value from pg_catalog.pg_extension where extname = 'pgcrypto'"), 1);
    assert.deepEqual(await tokenRows(clean), cleanTokens);
    assert.deepEqual(await liveRows(clean), cleanLive);
    pass('POINT 7: the rollback leaves a coherent state: both capability tables and six of the seven functions dropped, every push and Live Activity token row untouched, pgcrypto retained');
    const afterRollbackFunctions = await functionCatalogOn(clean);
    const stillPresent = Object.fromEntries(afterRollbackFunctions.map(f => [f.signature, f.definition]));
    const cleanByName = Object.fromEntries(cleanFunctions.map(f => [f.signature, f.definition]));
    const survivorsChanged = Object.keys(stillPresent).filter(sig => cleanByName[sig] !== stillPresent[sig]);
    assert.deepEqual(survivorsChanged, []);
    assert.deepEqual(Object.keys(stillPresent).sort().filter(s => !s.startsWith('hc_list_managed_open_shift_ids')),
      Object.keys(cleanByName).sort().filter(s => !s.startsWith('hc_authorize_notification_device')
        && !s.startsWith('hc_revoke_notification_device') && !s.startsWith('hc_notification_')
        && !s.startsWith('hc_purge_revoked_notification_device') && !s.startsWith('hc_revoke_ineligible_worker_devices')
        && !s.startsWith('hc_list_managed_open_shift_ids')));
    pass('POINT 7: no surviving function had its body changed by the rollback');
    const rolledBackAccess = await accessCatalogOn(clean);
    for (const table of ['orders', 'field_workers', 'shifts', 'push_tokens', 'live_activity_tokens']) {
      assert.deepEqual(forTable(rolledBackAccess, table), forTable(cleanAccess, table));
    }
    pass('POINT 7: the rollback widened nothing either: orders, field_workers, shifts, push_tokens and live_activity_tokens keep identical grants, policies and RLS');
    note('WHAT THE ROLLBACK CANNOT RESTORE: it deliberately leaves hc_list_managed_open_shift_ids() installed and granted to authenticated and service_role, and it leaves the pgcrypto extension. It does not restore the pre-015c state exactly, and it says so in its own header.');
  }
  // The one-way door: on the main database a capability HAS been issued.
  const tokensBeforeRefusedRollback = await tokenRows(db);
  const rollbackRefusal = await refuses('POINT 7: the rollback REFUSES once any phone has ever been authorized',
    rollback015c, '55000', /015c rollback blocked: a phone capability was previously issued/);
  assert.equal(await relationExists('public.notification_device_authorizations'), true);
  assert.equal(await routineExists('public.hc_authorize_notification_device(uuid)'), true);
  assert.equal(await scalar('select count(*)::int as value from public.notification_device_authorizations'), 2);
  assert.deepEqual(await tokenRows(db), tokensBeforeRefusedRollback);
  pass('the refused rollback left everything in place: both capability tables, all seven functions, both device authorizations and every token row');
  note(`ONE-WAY DOOR, and it closes the moment Sidd opens the app: ${rollbackRefusal.message}. The permanent ever_issued_at marker is set by the FIRST successful authorize call. After that the only way back is a new forward migration. Plan on 015c being irreversible in practice within minutes of running it.`);

  // == 13. the closing picture ==============================================
  assert.deepEqual(await rows('select * from public.orders order by id'), beforeOrders);
  assert.deepEqual(await rows('select * from public.field_workers order by email'), beforeWorkers);
  assert.deepEqual(await rows('select * from public.shifts order by id'), beforeShifts);
  pass('not one row of orders, field_workers or shifts was written or deleted anywhere in this rehearsal');
  for (const table of ['orders', 'shift_locations', 'push_queue', 'intake_messages', 'delivery_signatures']) {
    assert.equal(migration015c.includes(`public.${table}`), false, `015c must not name ${table}`);
  }
  assert.equal(migration015c.split('public.orders').length - 1, 0);
  pass('statically too: 015c contains no statement naming orders, shift_locations, push_queue, intake_messages or delivery_signatures');
  console.log(`      015c names field_workers ${migration015c.split('public.field_workers').length - 1} times, shifts ${migration015c.split('public.shifts').length - 1} times, push_tokens ${migration015c.split('public.push_tokens').length - 1} times, live_activity_tokens ${migration015c.split('public.live_activity_tokens').length - 1} times (locks, reads, and the revoked-device destination purge)`);

  console.log('\n-- who can reach what after 015c --');
  const finalAccess = await accessCatalogOn(db);
  const finalGrants = grantMap(finalAccess);
  for (const table of ['notification_device_authorizations', 'notification_device_security_state',
    'push_tokens', 'live_activity_tokens', 'orders', 'field_workers', 'shifts', 'shift_locations', 'push_queue']) {
    const line = ['anon', 'authenticated', 'service_role'].map(role =>
      `${role}=${(finalGrants[`${table}:${role}`] || ['none']).join('/')}`).join('  ');
    const rls = finalAccess.rls.find(r => r.relname === table);
    const policyCount = finalAccess.policies.filter(p => p.tablename === table).length;
    console.log(`  ${table.padEnd(38)} rls=${rls ? rls.relrowsecurity : '?'} policies=${policyCount}  ${line}`);
  }
  console.log('\n-- the seven functions 015c adds, and who may EXECUTE them --');
  for (const signature of ['public.hc_authorize_notification_device(uuid)',
    'public.hc_revoke_notification_device(uuid,text)', 'public.hc_list_managed_open_shift_ids()',
    'public.hc_notification_random_secret()', 'public.hc_notification_secret_hash(text)',
    'public.hc_purge_revoked_notification_device()', 'public.hc_revoke_ineligible_worker_devices()']) {
    const holders = [];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (await scalar('select has_function_privilege($1,$2,$3) as value', [role, signature, 'execute'])) holders.push(role);
    }
    console.log(`  ${signature.replace('public.', '').padEnd(46)} ${holders.length ? holders.join(', ') : 'owner only'}`);
  }

  console.log(`\nPASS: ${passed} local runtime assertions. No live systems were contacted.`);
  if (defects.length) {
    console.log('\n-- DEFECTS FOUND IN 015c --');
    for (const message of defects) console.log(`  * ${message}`);
  }
  if (notes.length) {
    console.log('\n-- notes --');
    for (const message of notes) console.log(`  * ${message}`);
  }
  console.log('\nLimits, stated rather than buried:');
  console.log('  * Migration 030 is applied in production but has no file in this repository, so it is not modelled here.');
  console.log('  * PGlite is PostgreSQL 18; the Supabase project may be on an older major version. Section 3 is the byte-for-byte');
  console.log('    run and it FAILED on 18. Every later section used the four-line compatibility patch that section 3 proves is');
  console.log('    minimal and reversible, so the behaviour below is proved for text identical to the file except those 4 lines.');
  console.log('  * storage.buckets and storage.objects are a local stub so that 035, 036 and 037 install. 015c touches neither.');
  console.log('  * In-memory SQL does not exercise PostgREST itself, iOS SecureStore, APNs delivery, the Cloudflare worker,');
  console.log('    concurrent connections, lock_timeout behaviour under real contention, or production row volume.');
  console.log('  * This proves REGISTRATION. It does not prove a banner appears on the lock screen: that still needs the app run.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const handle of branches) { try { await handle.close(); } catch { /* already closed */ } }
}
