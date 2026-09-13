// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-042-order-time-proposals-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migration 042 (proposed delivery times from coordinator emails,
// and the owner's Accept / Keep) on the fake roster and orders the 038
// rehearsal uses, with 004/005 (intake_messages), the 015 role functions,
// 034 and 038 applied first. Real migration files run as written.
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
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [fixture, m019, m015, m004, m005, m034, m038, migration, rollback] = await Promise.all([
  'rehearsal/calendar-logo-local-setup.sql',
  'migrations/019_dashboard_auth_transition.sql',
  'migrations/015_field_auth_transition.sql',
  'migrations/004_intake_messages.sql',
  'migrations/005_intake_approvals.sql',
  'migrations/034_calendar_delivery_details.sql',
  'migrations/038_delivery_request_owner_edit.sql',
  'migrations/042_order_time_proposals.sql',
  'migrations/042_order_time_proposals_rollback.sql',
].map(file => readFile(join(root, file), 'utf8').then(text => text.replace(/\r\n/g, '\n'))));
// (line endings normalised: some migration files are CRLF on this laptop;
// the database treats both as whitespace and the slices below match on LF)
const guard = "current_database() <> 'hc_calendar_logo_rehearsal'";
assert.equal(fixture.split(guard).length, 2);
const setup = fixture.replace(guard, "current_database() <> 'postgres'");
function slice(text, from, to, label) {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, label);
  return text.slice(a, b + to.length);
}
// The 019 order projection and its grants (038 patches it).
const projectionSql = slice(m019, 'create or replace function public.hc_list_orders_for_current_user(', '-- Delivery confirmation is the one write allowed', '019 projection').replace('-- Delivery confirmation is the one write allowed', '');
// The four 015 role helpers hc_is_owner() rests on, plus their grants.
const roleSql = slice(m015, 'create or replace function public.hc_current_worker_role()', 'coalesce(public.hc_current_worker_role() = \'owner\', false)\n$function$;', '015 role functions')
  + '\ngrant execute on function public.hc_current_worker_role() to authenticated, service_role;'
  + '\ngrant execute on function public.hc_is_active_worker() to authenticated, service_role;'
  + '\ngrant execute on function public.hc_can_manage_shifts() to authenticated, service_role;'
  + '\ngrant execute on function public.hc_is_owner() to authenticated, service_role;';
// 005's status list (adds 'approved') and classified_at.
const statusSql = slice(m005, 'alter table public.intake_messages\n  drop constraint if exists intake_messages_status_check;', 'add column if not exists classified_at timestamptz;', '005 status list');

const users = Object.fromEntries(['owner', 'manager', 'team', 'inactive', 'guest', 'blank', 'miami']
  .map((name, index) => [name, `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const orders = [1, 2, 3, 4, 5, 6].map(id => `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`);
const [nyOrder, miamiOrder, , , , cancelledOrder] = orders;

let db;
let passed = 0;
let current = { name: null, role: 'postgres' };
const pass = message => { passed++; console.log(`PASS: ${message}`); };
async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0]?.value; }
async function identity(name = null, role = 'authenticated') {
  current = { name, role };
  await db.exec('reset role;');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [name ? users[name] ?? name : '']);
  if (role !== 'postgres') await db.exec(`set role ${role};`);
}
async function denied(label, sql, params = [], code = '42501', message = null) {
  await assert.rejects(db.query(sql, params),
    error => error.code === code && (!message || message.test(error.message)), label);
  pass(label);
}
async function asPostgres(work) {
  const caller = current;
  await identity(null, 'postgres');
  try { return await work(); } finally { await identity(caller.name, caller.role); }
}
const request = id => asPostgres(() => scalar('select delivery_request as value from public.orders where id = $1', [id]));
const intake = id => asPostgres(async () => (await db.query('select status, reviewed_at, error_detail from public.intake_messages where id = $1', [id])).rows[0]);
const proposal = id => asPostgres(async () => (await db.query('select * from public.order_time_proposals where intake_id = $1', [id])).rows[0]);
const decide = (order, intakeId, decision) => scalar('select public.hc_decide_proposed_time($1, $2, $3) as value', [order, intakeId, decision]);
const setRequest = (order, window, location = null, date = null, contactName = null, contactPhone = null) =>
  scalar('select public.hc_set_delivery_request($1, $2, $3, $4::date, $5, $6) as value', [order, window, location, date, contactName, contactPhone]);
async function newIntake(subject, orderId) {
  return asPostgres(() => scalar(
    "insert into public.intake_messages (channel, source_msg_id, from_addr, subject, raw_text, classification, status, order_id, classified_at) values ('email', $1, 'coordinator@example.invalid', $2, 'body', 'order', 'pending_review', $3, now()) returning id as value",
    [subject + '-' + Math.random().toString(36).slice(2), subject, orderId]));
}
async function newProposal(intakeId, orderId, arriveAt, label, foundAt) {
  const caller = current;
  await identity(null, 'service_role');
  await db.query(
    'insert into public.order_time_proposals (intake_id, order_id, proposed_arrive_at, proposed_label, evidence_line, evidence_where, on_file_window, found_at) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)',
    [intakeId, orderId, arriveAt, label, '2:00 PM Hamptons Coconuts arrival + setup', 'attachment:Timeline.pdf', 'As close to 3:30/4 PM as possible', foundAt]);
  await identity(caller.name, caller.role);
}
const tableCount = () => scalar("select count(*)::int as value from pg_class where relnamespace = 'public'::regnamespace and relname = 'order_time_proposals'");
const functionCount = () => scalar("select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_decide_proposed_time'");

try {
  db = await PGlite.create();
  const ident = (await db.query('select current_database() as name, version() as version')).rows[0];
  assert.equal(ident.name, 'postgres');
  assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  await db.exec(setup + projectionSql + roleSql);
  await db.exec(m004);
  await db.exec(statusSql);
  await db.exec(`alter table public.orders add column updated_at timestamptz not null default now();
    update public.orders set venue = 'Fake Beach Club', delivery_notes = '1 Fake Lane, Southampton' where id = '${nyOrder}';
    insert into public.orders(id, client_name, delivery_at_utc, stage, market, total_cents)
      values ('${cancelledOrder}', 'Fake cancelled order', '2026-09-13T12:00:00Z', 'cancelled', 'ny', 12000);`);
  await db.exec(m034);
  await db.exec(m038);

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await tableCount(), 1);
  assert.equal(await functionCount(), 1);
  pass('042 applies twice on top of 004/005/015/034/038');

  // ── the on-file time, set by the owner through the sheet ──
  await identity('owner');
  await setRequest(nyOrder, '3:30 PM', null, null, 'Tara', null);
  const onFile = await request(nyOrder);
  assert.equal(onFile.window, '3:30 PM');
  assert.equal(onFile.contact_name, 'Tara');

  // ── accept ──
  const i1 = await newIntake('Fwd: Abigail Canelle timeline 09/10/2026', nyOrder);
  await newProposal(i1, nyOrder, '2026-09-10T18:00:00Z', '2:00 PM', new Date(Date.now() + 60000).toISOString());
  await identity('owner');
  let result = await decide(nyOrder, i1, 'accept');
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'accepted');
  let dr = await request(nyOrder);
  assert.equal(dr.window, '2:00 PM');
  assert.equal(dr.source, 'owner');
  assert.equal(dr.status, 'confirmed');
  assert.equal(dr.date, '2026-09-10');
  assert.equal(dr.contact_name, 'Tara');
  assert.equal(dr.set_by, users.owner);
  let row = await intake(i1);
  assert.equal(row.status, 'dismissed');
  assert.ok(row.reviewed_at);
  assert.equal(row.error_detail, 'time proposal accepted by the owner in HC Field');
  let p = await proposal(i1);
  assert.equal(p.status, 'accepted'); assert.equal(p.decided_via, 'app'); assert.equal(p.decided_by, users.owner);
  pass('owner accepts: the window goes through 038 (source owner, contact kept), the intake row is dismissed, the proposal is stamped');
  result = await decide(nyOrder, i1, 'accept');
  assert.equal(result.applied, false); assert.equal(result.outcome, 'accepted');
  result = await decide(nyOrder, i1, 'keep');
  assert.equal(result.applied, false); assert.equal(result.outcome, 'accepted');
  assert.deepEqual(await request(nyOrder), dr);
  pass('a second accept, or a keep after an accept, reports already decided and rewrites nothing');

  // ── keep ──
  const i2 = await newIntake('Fwd: timeline v2 09/10/2026', nyOrder);
  await newProposal(i2, nyOrder, '2026-09-10T19:00:00Z', '3:00 PM', new Date(Date.now() + 60000).toISOString());
  await identity('owner');
  const before = await request(nyOrder);
  result = await decide(nyOrder, i2, 'keep');
  assert.equal(result.applied, true); assert.equal(result.outcome, 'kept');
  assert.deepEqual(await request(nyOrder), before);
  assert.equal((await intake(i2)).status, 'dismissed');
  assert.equal((await proposal(i2)).status, 'kept');
  pass('owner keeps: the order is byte for byte untouched, the intake row is dismissed');

  // ── who may decide, and malformed calls ──
  const i3 = await newIntake('Fwd: timeline v3 09/10/2026', nyOrder);
  await newProposal(i3, nyOrder, '2026-09-10T17:00:00Z', '1:00 PM', new Date(Date.now() + 60000).toISOString());
  await identity('manager');
  await denied('a manager cannot decide', 'select public.hc_decide_proposed_time($1, $2, $3)', [nyOrder, i3, 'accept'], '42501', /only the owner/);
  await identity('team');
  await denied('a team member cannot decide', 'select public.hc_decide_proposed_time($1, $2, $3)', [nyOrder, i3, 'accept'], '42501');
  await identity(null, 'anon');
  await denied('anon cannot even call the function', 'select public.hc_decide_proposed_time($1, $2, $3)', [nyOrder, i3, 'accept'], '42501', /permission denied for function/);
  await denied('anon cannot read proposals', 'select * from public.order_time_proposals');
  await identity('owner');
  await denied('a decision must be accept or keep', 'select public.hc_decide_proposed_time($1, $2, $3)', [nyOrder, i3, 'maybe'], '22023');
  await denied('an unknown proposal is a clear 22023', 'select public.hc_decide_proposed_time($1, $2, $3)', [miamiOrder, i3, 'accept'], '22023', /No such proposal/);
  assert.equal((await proposal(i3)).status, 'pending');
  pass('refusals never touch the proposal');

  // ── the owner typed a newer time by hand ──
  const i4 = await newIntake('Fwd: old timeline 09/10/2026', nyOrder);
  await newProposal(i4, nyOrder, '2026-09-10T16:00:00Z', '12:00 PM', new Date(Date.now() - 3600000).toISOString());
  await identity('owner');
  await setRequest(nyOrder, '4:00 PM');
  const typed = await request(nyOrder);
  result = await decide(nyOrder, i4, 'accept');
  assert.equal(result.applied, false); assert.equal(result.outcome, 'superseded');
  assert.match(result.message, /changed after this email arrived/);
  assert.deepEqual(await request(nyOrder), typed);
  p = await proposal(i4);
  assert.equal(p.status, 'superseded'); assert.equal(p.decided_via, 'owner_edit');
  assert.equal((await intake(i4)).status, 'pending_review');
  pass('a hand-typed time after the email wins: superseded, nothing rewritten, the intake row left for Sidd');

  // ── the proposal names a different day than the invoice ──
  const i5 = await newIntake('Fwd: moved timeline', nyOrder);
  await newProposal(i5, nyOrder, '2026-09-11T18:00:00Z', '2:00 PM', new Date(Date.now() + 60000).toISOString());
  await identity('owner');
  result = await decide(nyOrder, i5, 'accept');
  assert.equal(result.applied, false); assert.equal(result.outcome, 'refused');
  assert.match(result.message, /delivery dates change through the invoice/);
  assert.deepEqual(await request(nyOrder), typed);
  assert.equal((await proposal(i5)).decided_via, 'date_moved');
  pass('a proposal on another day is refused by 038 and reported, never applied');

  // ── a cancelled order ──
  const i6 = await newIntake('Fwd: cancelled job', cancelledOrder);
  await newProposal(i6, cancelledOrder, '2026-09-13T18:00:00Z', '2:00 PM', new Date(Date.now() + 60000).toISOString());
  await identity('owner');
  result = await decide(cancelledOrder, i6, 'accept');
  assert.equal(result.applied, false); assert.equal(result.outcome, 'cancelled');
  assert.equal((await proposal(i6)).decided_via, 'cancelled');
  pass('a cancelled order: reported as cancelled, nothing written to it');

  // ── the worker's insert never overwrites a decided row ──
  await identity(null, 'service_role');
  await db.query('insert into public.order_time_proposals (intake_id, order_id, proposed_arrive_at, proposed_label) values ($1, $2, $3, $4) on conflict (intake_id) do nothing', [i1, nyOrder, '2026-09-10T20:00:00Z', '4:00 PM']);
  await identity('owner');
  p = await proposal(i1);
  assert.equal(p.status, 'accepted'); assert.equal(p.proposed_label, '2:00 PM');
  pass('an ignore-duplicates insert leaves a decided proposal exactly as it was');

  // ── who can read ──
  await identity('owner');
  assert.equal(await scalar('select count(*)::int as value from public.order_time_proposals'), 6);
  await identity('manager');
  assert.equal(await scalar('select count(*)::int as value from public.order_time_proposals'), 0);
  await identity('team');
  assert.equal(await scalar('select count(*)::int as value from public.order_time_proposals'), 0);
  await identity('owner');
  await denied('the owner cannot write the table directly', 'update public.order_time_proposals set status = $1 where intake_id = $2', ['kept', i3]);
  pass('only the owner reads proposals; nobody but the service key writes the table directly');

  // ── constraints ──
  await identity(null, 'service_role');
  await denied('an unknown status is refused', 'update public.order_time_proposals set status = $1 where intake_id = $2', ['maybe', i3], '23514');
  await denied('an unknown decided_via is refused', 'update public.order_time_proposals set decided_via = $1 where intake_id = $2', ['telegram', i3], '23514');

  // ── rollback twice, re-apply ──
  await identity(null, 'postgres');
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await tableCount(), 0); assert.equal(await functionCount(), 0);
  assert.equal((await intake(i1)).status, 'dismissed');
  pass('rollback runs twice; decided intake rows stay dismissed');
  await db.exec(migration);
  assert.equal(await tableCount(), 1);
  await identity('owner');
  assert.equal(await scalar('select count(*)::int as value from public.order_time_proposals'), 0);
  pass('re-apply after rollback starts empty with the policy back');

  console.log(`PASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker scan, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
