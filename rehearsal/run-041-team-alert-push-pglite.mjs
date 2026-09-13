// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-041-team-alert-push-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/041_team_alert_push_tokens.sql and its rollback on the
// shape production is in on 2026-09-13: 015, 015b, 015c, 019, 024, 027, 029,
// 034 through 038 applied; 016, 017, 018, 020, 021, 022, 025, 026, 028 not.
// Real migration files are executed as written and never rewritten on disk,
// with one exception copied from the 015c rehearsal: PGlite 0.5.8 is
// PostgreSQL 18, whose pg_constraint also lists NOT NULL rows, so four
// count(*) predicates inside 015c get a `contype <> 'n'` shim (a no-op on the
// PostgreSQL 17 Supabase runs). 041 itself runs byte for byte.
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
const read = file => readFile(join(root, file), 'utf8');
const appSource = await readFile(join(root, '..', 'hc-field-app', 'App.js'), 'utf8');

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
  '037_order_box_progress', '038_delivery_request_owner_edit',
];
const [supabaseBootstrap, ordersBaseline, migration015c, migration022, migration, rollback] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/015c_notification_device_api_compatibility.sql'),
  read('migrations/022_notification_device_authorization_cutover.sql'),
  read('migrations/041_team_alert_push_tokens.sql'),
  read('migrations/041_team_alert_push_tokens_rollback.sql'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));

// The 015c PostgreSQL 18 shim (see run-015c-notification-bridge-pglite.mjs).
const CONSTRAINT_COUNT = /(select count\(\*\)\n(\s*)from pg_catalog\.pg_constraint as constraint_info\n\s*where constraint_info\.conrelid =\n\s*'public\.notification_device_[a-z_]+'::pg_catalog\.regclass\n)(\s*\) <> [0-9]+)/g;
const SHIM_LINE = "and constraint_info.contype <> 'n'";
const migration015cPg18 = migration015c.replace(CONSTRAINT_COUNT,
  (whole, head, indent, tail) => `${head}${indent}  ${SHIM_LINE}\n${tail}`);
assert.equal(migration015cPg18.split(SHIM_LINE).length, 5, '015c shim must hit exactly four predicates');

// 022's rewrite of the sync function, as written, to demonstrate the trap.
const trapFrom = migration022.indexOf('create or replace function public.hc_sync_notification_device(');
const trapTo = migration022.indexOf('$function$;', trapFrom) + '$function$;'.length;
assert.ok(trapFrom > 0 && trapTo > trapFrom);
const migration022SyncOnly = migration022.slice(trapFrom, trapTo);

// What HC Field posts, read out of App.js so the call shape cannot drift.
function rpcBodyKeys(name) {
  const start = appSource.indexOf(`sb('rpc/${name}'`);
  assert.ok(start > 0, `App.js must still call rpc/${name}`);
  const bodyStart = appSource.indexOf('JSON.stringify({', start);
  const bodyEnd = appSource.indexOf('})', bodyStart);
  const literal = appSource.slice(bodyStart, bodyEnd);
  return [...literal.matchAll(/[{,\n]\s*(p_[a-z_]+)\s*:/g)].map(m => m[1]);
}
const SYNC_KEYS = rpcBodyKeys('hc_sync_notification_device');
const AUTHORIZE_KEYS = rpcBodyKeys('hc_authorize_notification_device');
assert.deepEqual(SYNC_KEYS, ['p_device_id', 'p_apns_token', 'p_push_allowed', 'p_live_supported']);
assert.deepEqual(AUTHORIZE_KEYS, ['p_device_id']);
const SYNC_SQL = `select public.hc_sync_notification_device(${SYNC_KEYS.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as value`;
const AUTHORIZE_SQL = `select * from public.hc_authorize_notification_device(${AUTHORIZE_KEYS.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
const SYNC_SIG = 'public.hc_sync_notification_device(uuid,text,boolean,boolean)';

const OWNER = { authUserId: '00000000-0000-4000-8000-000000000001', email: 'siddsaxena@gmail.com' };
const MANAGER = { authUserId: '20000000-0000-4000-8000-000000000002', email: 'manager@example.invalid' };
const TEAM = { authUserId: '20000000-0000-4000-8000-000000000003', email: 'team@example.invalid' };
const STALE = { authUserId: '20000000-0000-4000-8000-000000000004', email: 'exmanager@example.invalid' };
const VEGAS = { authUserId: '20000000-0000-4000-8000-000000000005', email: 'vegas@example.invalid' };
const EXTEAM = { authUserId: '20000000-0000-4000-8000-000000000006', email: 'exteam@example.invalid' };
const OWNER_DEVICE = '70000000-0000-4000-8000-000000000001';
const MANAGER_DEVICE = '70000000-0000-4000-8000-000000000002';
const TEAM_DEVICE = '70000000-0000-4000-8000-000000000003';
const TEAM_DEVICE_2 = '70000000-0000-4000-8000-000000000004';
const OWNER_APNS = 'd1'.repeat(32);
const MANAGER_APNS = 'b'.repeat(64);
const LEGACY_OWNER_APNS = 'a'.repeat(64);
const TEAM_APNS = 'e2'.repeat(32);
const TEAM_APNS_2 = 'e3'.repeat(32);
const LEGACY_TEAM_APNS = 'e4'.repeat(32);

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

// Loaded BEFORE 015 so 015 links each roster row to its Auth identity as it
// did in production. The team push row is the build-24 legacy shape (no
// device id), which is what a crew phone that once tapped Allow holds today.
const SEED = `
insert into auth.users (id, email, email_confirmed_at) values
  ('${MANAGER.authUserId}', '${MANAGER.email}', '2026-01-02T00:00:00Z'),
  ('${TEAM.authUserId}', '${TEAM.email}', '2026-01-03T00:00:00Z'),
  ('${STALE.authUserId}', '${STALE.email}', '2026-01-04T00:00:00Z'),
  ('${VEGAS.authUserId}', '${VEGAS.email}', '2026-01-05T00:00:00Z'),
  ('${EXTEAM.authUserId}', '${EXTEAM.email}', '2026-01-06T00:00:00Z');
insert into public.field_workers (id, email, name, market, role, active) values
  ('10000000-0000-4000-8000-000000000002', '${MANAGER.email}', 'Sandbox Manager', 'ny', 'manager', true),
  ('10000000-0000-4000-8000-000000000003', '${TEAM.email}', 'Sandbox Team', 'ny', 'team', true),
  ('10000000-0000-4000-8000-000000000004', '${STALE.email}', 'Sandbox Ex-manager', 'ny', 'manager', false),
  ('10000000-0000-4000-8000-000000000005', '${VEGAS.email}', 'Sandbox Vegas', 'vegas', 'team', true),
  ('10000000-0000-4000-8000-000000000006', '${EXTEAM.email}', 'Sandbox Ex-team', 'ny', 'team', false),
  ('10000000-0000-4000-8000-000000000007', 'appreview@hamptonscoconuts.com', 'App Review', 'ny', 'team', true);
insert into public.shifts (id, worker_name, worker_email, market, clock_in_at, device) values
  ('50000000-0000-4000-8000-000000000001', 'Sandbox Team', '${TEAM.email}', 'ny', now() - interval '2 hours', 'sandbox-fixture'),
  ('50000000-0000-4000-8000-000000000002', 'App Review', 'appreview@hamptonscoconuts.com', 'ny', now() - interval '1 hour', 'sandbox-fixture');
insert into public.push_tokens (email, apns_token, platform, updated_at) values
  ('${OWNER.email}', '${LEGACY_OWNER_APNS}', 'ios', '2026-08-13T10:00:00Z'),
  ('${MANAGER.email}', '${MANAGER_APNS}', 'ios', '2026-08-14T10:00:00Z'),
  ('${TEAM.email}', '${LEGACY_TEAM_APNS}', 'ios', '2026-08-05T10:00:00Z');`;

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
async function asOwner(h, work) {
  const saved = ident.get(h) ?? {};
  await identityOn(h);
  try { return await work(); } finally { await identityOn(h, saved); }
}
const tokenRows = h => asOwner(h, () => rowsOn(h,
  'select email, apns_token, platform, device_id from public.push_tokens order by email'));
const liveCount = (h, email) => asOwner(h, () => scalarOn(h,
  'select count(*)::int as value from public.live_activity_tokens where lower(email) = $1', [email]));
const tokenFor = async (h, email) => (await tokenRows(h)).find(t => t.email === email) ?? null;
const marker = h => asOwner(h, () => scalarOn(h,
  'select ever_kept_team_token_at as value from public.notification_team_push_state where singleton is true'));
const functionDef = h => scalarOn(h, 'select pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($1)) as value', [SYNC_SIG]);
async function refusesOn(h, label, sql, code, message) {
  let seen = null;
  await assert.rejects(h.exec(sql), error => { seen = error; return error.code === code && message.test(error.message); }, label);
  try { await h.exec('rollback;'); } catch { /* nothing open */ }
  pass(`${label} (${seen.code}: ${seen.message})`);
}
async function deniedOn(h, label, sql, params = [], code = '42501', message = null) {
  await assert.rejects(h.query(sql, params), error => error.code === code && (!message || message.test(error.message)), label);
  pass(label);
}
async function sync(h, who, device, token, allowed = true, live = true) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  await q(h, SYNC_SQL, [device, token, allowed, live]);
  await identityOn(h);
}
// The build-30+ owner/manager flow: authorize (015c) first, then sync.
async function manageFlow(h, who, device, token) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  const secret = String((await q(h, AUTHORIZE_SQL, [device])).rows[0].revoke_secret).toLowerCase();
  await q(h, SYNC_SQL, [device, token, true, true]);
  await identityOn(h);
  return secret;
}
async function productionShaped({ with015c = false } = {}) {
  const h = await PGlite.create({ extensions: { pgcrypto } });
  await h.exec(supabaseBootstrap);
  await h.exec(STORAGE_STUB);
  await h.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await h.exec(baseFiles[name]);
  await h.exec(SEED);
  for (const name of APPLIED_CHAIN) await h.exec(baseFiles[name]);
  if (with015c) await h.exec(migration015cPg18);
  await identityOn(h);
  return h;
}
// The worker's recipient rule, in SQL, so the JS query can be checked against
// it later: owners always, same-market managers, clocked-in team in the
// market, every active team phone in the market when nobody is clocked in.
// App Review and inactive rows never count.
const recipientsFor = (h, market) => asOwner(h, () => rowsOn(h, `
  with roster as (
    select lower(fw.email) as email, fw.role, lower(coalesce(fw.market, '')) as market
    from public.field_workers as fw
    where fw.active is true and lower(fw.email) <> 'appreview@hamptonscoconuts.com'),
  clocked as (
    select distinct lower(s.worker_email) as email from public.shifts as s
    where s.clock_out_at is null and lower(coalesce(s.market, '')) = $1
      and lower(s.worker_email) <> 'appreview@hamptonscoconuts.com')
  select r.email, r.role
  from public.push_tokens as pt
  join roster as r on r.email = lower(pt.email)
  where r.role = 'owner'
     or (r.role = 'manager' and r.market = $1)
     or (r.role = 'team' and r.market = $1
         and (r.email in (select email from clocked) or not exists (select 1 from clocked)))
  order by r.email`, [market]).then(rows => rows.map(r => `${r.role}:${r.email}`)));

const handles = [];
try {
  // ── A. the live shape today: 015c applied, then 041 ──
  const db = await productionShaped({ with015c: true });
  handles.push(db);
  const version = await scalarOn(db, 'select version() as value');
  assert.ok(version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8. No network.\n');
  const def015 = await functionDef(db);
  assert.equal(def015.includes("if v_role = 'team' then"), false);
  const before = await tokenRows(db);
  assert.equal(before.find(t => t.email === TEAM.email).device_id, null);
  pass('starting state: 015 + 015c live, the team phone holds a build-24 legacy row with no device id');

  // The bug 041 fixes, reproduced: 015 deletes the team row on its next sync.
  await sync(db, TEAM, TEAM_DEVICE, TEAM_APNS);
  assert.equal(await tokenFor(db, TEAM.email), null);
  pass('THE BUG REPRODUCES: under 015 a team phone that syncs loses its push row (this is why Lian has no token)');
  await asOwner(db, () => q(db, "insert into public.push_tokens (email, apns_token, platform, updated_at) values ($1, $2, 'ios', '2026-08-05T10:00:00Z')", [TEAM.email, LEGACY_TEAM_APNS]));

  for (const sql of [migration, migration]) await db.exec(sql);
  const def041 = await functionDef(db);
  assert.ok(def041.includes("if v_role = 'team' then") && def041.includes('ever_kept_team_token_at'));
  assert.equal(await marker(db), null);
  pass('041 applies twice; the function carries the team branch; the marker starts null');

  await sync(db, TEAM, TEAM_DEVICE, TEAM_APNS);
  let team = await tokenFor(db, TEAM.email);
  assert.deepEqual(team, { email: TEAM.email, apns_token: TEAM_APNS, platform: 'ios', device_id: TEAM_DEVICE });
  assert.equal((await tokenRows(db)).filter(t => t.email === TEAM.email).length, 1);
  assert.equal(await liveCount(db, TEAM.email), 0);
  assert.ok(await marker(db));
  pass('a team sync keeps exactly ONE push row (device id set, legacy row upgraded in place), zero card tokens, and stamps the marker');

  await sync(db, TEAM, TEAM_DEVICE_2, TEAM_APNS_2);
  team = await tokenFor(db, TEAM.email);
  assert.equal(team.apns_token, TEAM_APNS_2);
  assert.equal(team.device_id, TEAM_DEVICE_2);
  assert.equal((await tokenRows(db)).filter(t => t.email === TEAM.email).length, 1);
  pass('a new phone replaces the row, never a second row (one phone per worker)');

  await sync(db, TEAM, TEAM_DEVICE_2, null);
  assert.equal((await tokenFor(db, TEAM.email)).apns_token, TEAM_APNS_2);
  pass('permission granted but no Apple token yet changes nothing');

  await asOwner(db, () => q(db, "insert into public.live_activity_tokens (email, token_type, shift_id, token, updated_at) values ($1, 'push_to_start', null, $2, now())", [TEAM.email, 'c'.repeat(64)]));
  await sync(db, TEAM, TEAM_DEVICE_2, TEAM_APNS_2, true, true);
  assert.equal(await liveCount(db, TEAM.email), 0);
  pass('a card token that somehow reached a team email is deleted on the next sync');

  await sync(db, TEAM, TEAM_DEVICE_2, TEAM_APNS_2, false, true);
  assert.equal(await tokenFor(db, TEAM.email), null);
  pass('turning notifications off deletes that phone row');

  await sync(db, TEAM, TEAM_DEVICE_2, TEAM_APNS_2);
  await asOwner(db, () => q(db, 'update public.field_workers set active = false where email = $1', [TEAM.email]));
  await sync(db, TEAM, TEAM_DEVICE_2, TEAM_APNS_2);
  assert.equal(await tokenFor(db, TEAM.email), null);
  await asOwner(db, () => q(db, 'update public.field_workers set active = true where email = $1', [TEAM.email]));
  pass('an inactive team identity loses every destination, as 015 did for everyone else');

  await sync(db, EXTEAM, TEAM_DEVICE_2, TEAM_APNS_2);
  assert.equal(await tokenFor(db, EXTEAM.email), null);
  pass('an inactive ex-team identity gets nothing');

  // Reclaim rules from 015 still hold across roles.
  await sync(db, TEAM, TEAM_DEVICE, TEAM_APNS);
  await sync(db, VEGAS, TEAM_DEVICE, 'f5'.repeat(32));
  assert.equal(await tokenFor(db, TEAM.email), null);
  assert.equal((await tokenFor(db, VEGAS.email)).device_id, TEAM_DEVICE);
  pass('a shared phone: the newest login reclaims the device and the previous worker row goes (015 reclaim rule)');
  await sync(db, TEAM, TEAM_DEVICE_2, 'f5'.repeat(32));
  assert.equal(await tokenFor(db, VEGAS.email), null);
  pass('and the exact-token reclaim rule holds too');

  // Owner and manager: unchanged. The 015c authorize gate still refuses team.
  const managerSecret = await manageFlow(db, MANAGER, MANAGER_DEVICE, MANAGER_APNS);
  assert.equal((await tokenFor(db, MANAGER.email)).device_id, MANAGER_DEVICE);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  await deniedOn(db, 'the 015c authorize gate still refuses a team phone (the app never calls it for team)', AUTHORIZE_SQL, [TEAM_DEVICE], '42501', /active owner or manager required/);
  await identityOn(db);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot execute the function', SYNC_SQL, [TEAM_DEVICE, TEAM_APNS, true, true], '42501', /permission denied for function/);
  // 008 left anon a table grant (the D-L known risk); row security hides
  // every row from it. Either a refusal or zero rows is the safe outcome.
  const anonRead = await q(db, 'select count(*)::int as value from public.push_tokens').then(r => r.rows[0].value, error => error.code);
  assert.ok(anonRead === 0 || anonRead === '42501', `anon must see nothing, saw ${anonRead}`);
  pass(`anon reads nothing from push_tokens (${anonRead === 0 ? 'zero rows through row security' : 'refused'})`);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.push_tokens'), 0);
  pass('an authenticated phone reads no push_tokens rows (RLS, no select policy)');
  await identityOn(db);

  // The shared-phone rule through 015c: revoking the manager's authorization
  // for a device purges push rows for that device, whoever holds them now.
  await sync(db, TEAM, MANAGER_DEVICE, TEAM_APNS);
  assert.equal(await tokenFor(db, MANAGER.email), null);
  assert.equal((await tokenFor(db, TEAM.email)).device_id, MANAGER_DEVICE);
  await identityOn(db, { role: 'anon' });
  assert.equal(await scalarOn(db, 'select public.hc_revoke_notification_device($1, $2) as value', [MANAGER_DEVICE, managerSecret]), true);
  await identityOn(db);
  assert.equal(await tokenFor(db, TEAM.email), null);
  pass('015c device revocation still purges the phone, even when a team login now holds it (the intended shared-phone rule)');

  // The recipient rule the worker will use.
  await sync(db, TEAM, TEAM_DEVICE, TEAM_APNS);
  await manageFlow(db, MANAGER, MANAGER_DEVICE, MANAGER_APNS);
  await sync(db, VEGAS, TEAM_DEVICE_2, 'f6'.repeat(32));
  await manageFlow(db, OWNER, OWNER_DEVICE, OWNER_APNS);
  assert.deepEqual(await recipientsFor(db, 'ny'), [`manager:${MANAGER.email}`, `owner:${OWNER.email}`, `team:${TEAM.email}`]);
  pass('recipients, ny, team clocked in: owner + ny manager + the clocked-in team phone (App Review excluded)');
  assert.deepEqual(await recipientsFor(db, 'vegas'), [`owner:${OWNER.email}`, `team:${VEGAS.email}`]);
  pass('recipients, vegas, nobody clocked in: owner + every active vegas team phone');
  await asOwner(db, () => q(db, "update public.shifts set clock_out_at = now() where worker_email = $1", [TEAM.email]));
  assert.deepEqual(await recipientsFor(db, 'ny'), [`manager:${MANAGER.email}`, `owner:${OWNER.email}`, `team:${TEAM.email}`]);
  pass('recipients, ny, nobody clocked in: owner + manager + every active ny team phone');

  // Rollback refuses once a crew token was kept.
  await refusesOn(db, 'rollback refuses after a crew phone was issued a token', rollback, '55000', /repair forward/);
  assert.ok((await functionDef(db)).includes("if v_role = 'team' then"));
  pass('and leaves the 041 function in place');

  // 028's rename-and-wrap shape on top of 041 keeps working, and 041 then refuses a re-run.
  await db.exec(`alter function public.hc_sync_notification_device(uuid, text, boolean, boolean) rename to hc_sync_notification_device_pre_mfa_028;
    create or replace function public.hc_sync_notification_device(p_device_id uuid, p_apns_token text, p_push_allowed boolean, p_live_supported boolean)
    returns void language plpgsql security definer set search_path = '' as $wrap$
    begin perform public.hc_sync_notification_device_pre_mfa_028(p_device_id, p_apns_token, p_push_allowed, p_live_supported); end $wrap$;
    revoke all on function public.hc_sync_notification_device(uuid, text, boolean, boolean) from public, anon, authenticated;
    grant execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean) to authenticated, service_role;`);
  await sync(db, TEAM, TEAM_DEVICE, TEAM_APNS_2);
  assert.equal((await tokenFor(db, TEAM.email)).apns_token, TEAM_APNS_2);
  pass('the 028 rename-and-wrap shape applied AFTER 041 still keeps a team token');
  await refusesOn(db, '041 refuses to re-run once 028 has renamed the function', migration, '55000', /migration 028 is installed/);
  await refusesOn(db, 'the rollback refuses too', rollback, '55000', /migration 028/);

  // ── B. 041 BEFORE 015c, then 015c on top ──
  const early = await productionShaped();
  handles.push(early);
  await early.exec(migration);
  await early.exec(migration015cPg18);
  await sync(early, TEAM, TEAM_DEVICE, TEAM_APNS);
  assert.equal((await tokenFor(early, TEAM.email)).device_id, TEAM_DEVICE);
  assert.ok((await functionDef(early)).includes("if v_role = 'team' then"));
  pass('041 before 015c: 015c applies on top (it never redefines this function) and the team branch survives');

  // ── C. rollback before any crew token: restores 015 byte for byte ──
  const fresh = await productionShaped({ with015c: true });
  handles.push(fresh);
  const freshDef015 = await functionDef(fresh);
  await fresh.exec(migration);
  await asOwner(fresh, () => q(fresh, "insert into public.push_tokens (email, apns_token, platform, device_id) values ($1, $2, 'ios', $3) on conflict (email) do update set device_id = excluded.device_id", [TEAM.email, TEAM_APNS, TEAM_DEVICE]));
  for (const sql of [rollback, rollback]) await fresh.exec(sql);
  assert.equal(await functionDef(fresh), freshDef015);
  assert.equal(await tokenFor(fresh, TEAM.email), null);
  assert.equal(await scalarOn(fresh, "select (pg_catalog.to_regclass('public.notification_team_push_state') is null) as value"), true);
  pass('rollback (twice) before any crew token: the 015 function text is restored exactly, team rows removed, marker table gone');
  await fresh.exec(migration);
  assert.equal(await marker(fresh), null);
  pass('re-apply after rollback works');

  // ── D. the trap 016/017/022 would spring, shown on a branch ──
  const trap = await productionShaped({ with015c: true });
  handles.push(trap);
  await trap.exec(migration);
  await trap.exec(migration022SyncOnly);
  assert.equal((await functionDef(trap)).includes("if v_role = 'team' then"), false);
  pass("THE TRAP DEMONSTRATED: 022's create-or-replace text applied after 041 silently removes the team branch with no error");

  // ── E. the preflight refusals ──
  const guard = await productionShaped({ with015c: true });
  handles.push(guard);
  await guard.exec("create function public.hc_enforce_notification_destination_authorization() returns trigger language plpgsql as $f$ begin return new; end $f$;");
  await refusesOn(guard, "041 refuses when 022's trigger function pre-exists", migration, '55000', /migration 022 is installed/);
  await guard.exec('drop function public.hc_enforce_notification_destination_authorization();');
  await guard.exec("create function public.hc_sync_notification_device_pre_mfa_028(uuid, text, boolean, boolean) returns void language sql as $f$ select null::void $f$;");
  await refusesOn(guard, "041 refuses when 028's renamed function pre-exists", migration, '55000', /migration 028 is installed/);
  await guard.exec('drop function public.hc_sync_notification_device_pre_mfa_028(uuid, text, boolean, boolean);');
  await guard.exec('drop policy push_tokens_anon_insert on public.push_tokens;');
  await refusesOn(guard, '041 refuses when the 008 policy is gone with no marker (016 cutover shape)', migration, '55000', /migration-016 cutover/);
  await guard.exec(`create table public.notification_team_push_state (singleton boolean primary key default true, installed_at timestamptz not null default now(), ever_kept_team_token_at timestamptz, anon_push_policies_dropped_at timestamptz default now(), constraint notification_team_push_state_singleton_check check (singleton is true));
    insert into public.notification_team_push_state (singleton) values (true);`);
  await guard.exec(migration);
  assert.ok((await functionDef(guard)).includes("if v_role = 'team' then"));
  pass('with the policy deliberately dropped AND the marker stamped, 041 applies (the D-L escape hatch)');
  await guard.exec('revoke execute on function public.hc_sync_notification_device(uuid, text, boolean, boolean) from service_role;');
  await refusesOn(guard, '041 refuses when the 015 function is no longer hardened', migration, '55000', /not hardened/);

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker, Apple, or concurrent connections; 028 was modelled by its rename-and-wrap shape, not executed.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
