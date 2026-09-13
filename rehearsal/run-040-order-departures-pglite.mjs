// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-040-order-departures-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migration 040 (the departure plan table and the crew action
// function) on the same fake roster and orders the 036 and 038 rehearsals
// use, plus a fake shifts table and the roster columns 015 adds. Real
// migration files are executed as written; nothing here rewrites them.
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
const [fixture, original, migration, rollback] = await Promise.all([
  'rehearsal/calendar-logo-local-setup.sql',
  'migrations/019_dashboard_auth_transition.sql',
  'migrations/040_order_departures.sql',
  'migrations/040_order_departures_rollback.sql',
].map(file => readFile(join(root, file), 'utf8')));
const guard = "current_database() <> 'hc_calendar_logo_rehearsal'";
assert.equal(fixture.split(guard).length, 2);
const setup = fixture.replace(guard, "current_database() <> 'postgres'");
// 040's read policy calls the 019 market rule. Slice 019 from THAT function
// (the 038 rehearsal slices from the later order projection, which would
// leave the policy's function undefined here).
const from = original.indexOf('create or replace function public.hc_can_access_order_market(');
const to = original.indexOf('create or replace function public.hc_list_orders_for_current_user(', from);
assert.ok(from >= 0 && to > from, '019 must still define hc_can_access_order_market before the projection');
const accessSql = original.slice(from, to);

// Fixture roster: 1 owner, 2 ny manager, 3 " TEAM " in " NY " (019 does not
// trim role, so that row reads nothing: a real 019 behaviour, asserted below),
// 4 inactive owner, 5 guest, 6 blank-market manager, 7 miami team.
// Added here: 8 clean ny team, 9 vegas team, 10 miami manager.
const users = Object.fromEntries(['owner', 'manager', 'spacedTeam', 'inactive', 'guest', 'blank', 'miamiTeam', 'team', 'vegasTeam', 'miamiManager']
  .map((name, index) => [name, `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const workerIds = Object.fromEntries(Object.keys(users)
  .map((name, index) => [name, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const orders = [1, 2, 3, 4, 5, 6, 7].map(id => `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`);
// Fixture rows: 1 NY, 2 miami, 3 no market, 4 undated quoted NY, 5 inquiry.
// Row 7 is added below as a Vegas job.
const [nyOrder, miamiOrder, unassignedOrder, noPlanOrder, , , vegasOrder] = orders;
const shiftIds = { team: '40000000-0000-4000-8000-000000000001', review: '40000000-0000-4000-8000-000000000002', wrongMarket: '40000000-0000-4000-8000-000000000003' };

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
// Reads one plan row as the database owner, then restores the caller.
async function planRow(id) {
  const caller = current;
  await identity(null, 'postgres');
  const result = (await db.query('select * from public.order_departures where order_id = $1', [id])).rows[0];
  await identity(caller.name, caller.role);
  return result;
}
const visible = async () =>
  (await db.query('select order_id, market from public.order_departures order by order_id')).rows.map(r => r.order_id);
const act = (order, action) =>
  scalar('select public.hc_departure_action($1, $2) as value', [order, action]);
const tableCount = () => scalar(
  "select count(*)::int as value from pg_class where relnamespace = 'public'::regnamespace and relname = 'order_departures'");
const functionCount = () => scalar(
  "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_departure_action'");

try {
  db = await PGlite.create();
  const ident = (await db.query('select current_database() as name, version() as version')).rows[0];
  assert.equal(ident.name, 'postgres');
  assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  await db.exec(setup + accessSql);

  // The read-only fixture predates the 015 roster columns and has no shifts
  // table; 040's preflight needs both. Emails and names are fake.
  await db.exec(`
    alter table public.field_workers add column email text, add column name text;
    update public.field_workers set email = 'w' || right(id::text, 2) || '@example.invalid', name = 'Worker ' || right(id::text, 2);
    insert into public.field_workers values
      ('${workerIds.team}', '${users.team}', 'team', 'ny', true, 'team08@example.invalid', 'Jay Fake'),
      ('${workerIds.vegasTeam}', '${users.vegasTeam}', 'team', 'vegas', true, 'vegas09@example.invalid', 'Li Fake'),
      ('${workerIds.miamiManager}', '${users.miamiManager}', 'manager', 'miami', true, 'miami10@example.invalid', 'Mia Fake');
    create table public.shifts (
      id uuid primary key default gen_random_uuid(),
      worker_name text not null,
      worker_email text,
      market text,
      clock_in_at timestamptz not null default now(),
      clock_in_lat double precision,
      clock_in_lng double precision,
      clock_out_at timestamptz
    );
    alter table public.shifts enable row level security;
    insert into public.orders(id, client_name, delivery_at_utc, stage, market, total_cents)
      values ('${vegasOrder}', 'Fake Vegas order', '2026-09-14T00:00:00Z', 'paid_full', 'vegas', 30000);`);

  // ── apply twice: idempotent ──
  await identity(null, 'postgres');
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await tableCount(), 1);
  assert.equal(await functionCount(), 1);
  pass('040 applies twice and leaves exactly one table and one function');

  // ── anon gets nothing, not even the function ──
  await identity(null, 'anon');
  await denied('anon cannot read order_departures', 'select * from public.order_departures');
  await denied('anon cannot call hc_departure_action', 'select public.hc_departure_action($1, $2)', [nyOrder, 'on_my_way']);

  // ── the worker (service key) writes plan rows ──
  await identity(null, 'service_role');
  await db.query(`insert into public.order_departures (order_id, plan_date, market, arrive_at, state, leave_by_at)
    values ($1, '2026-09-12', 'ny', '2026-09-12T19:30:00Z', 'planned', '2026-09-12T14:55:00Z'),
           ($2, '2026-09-12', 'miami', '2026-09-12T16:00:00Z', 'planned', '2026-09-12T13:00:00Z'),
           ($3, '2026-09-12', null, null, 'no_address', null),
           ($4, '2026-09-14', 'vegas', '2026-09-14T18:00:00Z', 'planned', '2026-09-14T16:30:00Z')`,
    [nyOrder, miamiOrder, unassignedOrder, vegasOrder]);
  assert.equal((await visible()).length, 4);
  pass('service_role inserts four plan rows (one with no market)');
  await denied('the alerts stamp must be a json object', 'update public.order_departures set alerts = $1::jsonb where order_id = $2', ['[]', nyOrder], '23514');
  await denied('an unknown state is refused', 'update public.order_departures set state = $1 where order_id = $2', ['teleported', nyOrder], '23514');
  await denied('an unknown route_source is refused', 'update public.order_departures set route_source = $1 where order_id = $2', ['waze', nyOrder], '23514');

  // ── who can read what ──
  await identity('owner');
  assert.deepEqual(await visible(), [nyOrder, miamiOrder, unassignedOrder, vegasOrder].sort());
  pass('owner reads every market, including the row with no market');
  await identity('manager');
  assert.deepEqual(await visible(), [nyOrder]);
  pass('ny manager reads only the ny row');
  await identity('miamiManager');
  assert.deepEqual(await visible(), [miamiOrder]);
  pass('miami manager reads only the miami row');
  await identity('team');
  assert.deepEqual(await visible(), [nyOrder]);
  pass('ny team reads only the ny row');
  await identity('vegasTeam');
  assert.deepEqual(await visible(), [vegasOrder]);
  pass('vegas team reads only the vegas row');
  for (const name of ['spacedTeam', 'inactive', 'guest', 'blank']) {
    await identity(name);
    assert.deepEqual(await visible(), []);
  }
  pass('untrimmed role, inactive, guest and blank-market roster rows read nothing (019 rule)');
  await identity('team');
  await denied('authenticated cannot insert a plan row', 'insert into public.order_departures (order_id, plan_date) values ($1, $2)', [noPlanOrder, '2026-09-12']);
  await denied('authenticated cannot update a plan row', 'update public.order_departures set state = $1 where order_id = $2', ['closed', nyOrder]);

  // ── on_my_way ──
  await identity('team');
  let result = await act(nyOrder, 'on_my_way');
  assert.equal(result.ack_by, users.team);
  assert.equal(result.ack_name, 'Jay Fake');
  assert.ok(result.ack_at);
  assert.equal(result.pickup_source, null);
  pass('ny team on_my_way stamps ack_at, ack_by and the roster display name');
  await denied('ny team cannot act on a vegas row', 'select public.hc_departure_action($1, $2)', [vegasOrder, 'on_my_way'], '42501', /not your market/);
  await denied('no plan row means a clear 22023', 'select public.hc_departure_action($1, $2)', [noPlanOrder, 'on_my_way'], '22023', /no departure plan/);
  await denied('an unknown action is refused', 'select public.hc_departure_action($1, $2)', [nyOrder, 'teleport'], '22023', /unknown departure action/);
  await denied('a null order is refused', 'select public.hc_departure_action($1, $2)', [null, 'on_my_way'], '22023');
  await identity('guest');
  await denied('a roster row with no useful role still cannot act outside its market', 'select public.hc_departure_action($1, $2)', [vegasOrder, 'on_my_way'], '42501');
  await identity('inactive');
  await denied('an inactive roster row cannot act', 'select public.hc_departure_action($1, $2)', [nyOrder, 'on_my_way'], '42501', /active field worker/);

  // ── left_garage needs an open, non-review shift in that market ──
  await identity('team');
  await denied('left_garage without an open shift', 'select public.hc_departure_action($1, $2)', [nyOrder, 'left_garage'], '22023', /Clock in first/);
  await identity(null, 'postgres');
  await db.query(`insert into public.shifts (id, worker_name, worker_email, market, clock_in_at, clock_out_at) values
    ($1, 'Jay Fake', 'TEAM08@example.invalid', 'NY', now() - interval '3 hours', now() - interval '1 hour'),
    ($2, 'Apple', 'appreview@hamptonscoconuts.com', 'ny', now() - interval '20 minutes', null),
    ($3, 'Jay Fake', 'team08@example.invalid', 'miami', now() - interval '10 minutes', null)`,
    [shiftIds.team, shiftIds.review, shiftIds.wrongMarket]);
  await identity('team');
  await denied('a closed shift, a review shift and a wrong-market shift do not count', 'select public.hc_departure_action($1, $2)', [nyOrder, 'left_garage'], '22023', /Clock in first/);
  await identity(null, 'postgres');
  await db.query('update public.shifts set clock_out_at = null where id = $1', [shiftIds.team]);
  await identity('team');
  result = await act(nyOrder, 'left_garage');
  assert.equal(result.pickup_source, 'claim');
  assert.equal(result.en_route_shift_id, shiftIds.team);
  assert.ok(result.pickup_seen_at);
  assert.equal(result.ack_name, 'Jay Fake');
  const firstPickup = result.pickup_seen_at;
  pass('left_garage with an open ny shift (email matched case-insensitively) records the claim');
  result = await act(nyOrder, 'left_garage');
  assert.equal(result.pickup_seen_at, firstPickup);
  pass('a second left_garage keeps the first departure time');
  await identity(null, 'postgres');
  await db.query('update public.order_departures set state = $1 where order_id = $2', ['closed', miamiOrder]);
  await identity('miamiManager');
  await denied('left_garage on a closed job', 'select public.hc_departure_action($1, $2)', [miamiOrder, 'left_garage'], '22023', /already over/);

  // ── silence, unsilence, reset ──
  await identity('team');
  await denied('team cannot silence', 'select public.hc_departure_action($1, $2)', [nyOrder, 'silence'], '42501', /owner or manager/);
  await denied('team cannot reset a departure', 'select public.hc_departure_action($1, $2)', [nyOrder, 'reset_departure'], '42501');
  await identity('miamiManager');
  result = await act(miamiOrder, 'silence');
  assert.equal(result.silenced_by, users.miamiManager);
  assert.ok(result.silenced_at);
  pass('miami manager silences a miami job');
  await denied('miami manager cannot silence an ny job', 'select public.hc_departure_action($1, $2)', [nyOrder, 'silence'], '42501', /not your market/);
  await identity('owner');
  result = await act(miamiOrder, 'unsilence');
  assert.equal(result.silenced_at, null);
  assert.equal(result.silenced_by, null);
  pass('owner unsilences any market');
  result = await act(nyOrder, 'reset_departure');
  for (const key of ['pickup_seen_at', 'pickup_source', 'en_route_shift_id', 'ack_at', 'ack_by', 'ack_name']) assert.equal(result[key], null, key);
  pass('owner reset_departure clears the claim and the acknowledgement');
  const stored = await planRow(nyOrder);
  assert.equal(stored.pickup_source, null);
  assert.equal(stored.state, 'planned');
  assert.equal(stored.leave_by_at.toISOString(), '2026-09-12T14:55:00.000Z');
  pass('the action function never touches the plan itself (state and leave-by unchanged)');
  await identity('manager');
  result = await act(nyOrder, '  SILENCE ');
  assert.ok(result.silenced_at);
  pass('actions are trimmed and case-insensitive');

  // ── cascade with the order ──
  await identity(null, 'postgres');
  await db.query('delete from public.orders where id = $1', [vegasOrder]);
  assert.equal(await planRow(vegasOrder), undefined);
  pass('deleting an order deletes its plan row');

  // ── rollback twice, then re-apply ──
  await identity(null, 'postgres');
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await tableCount(), 0);
  assert.equal(await functionCount(), 0);
  pass('rollback runs twice and removes the table and the function');
  await db.exec(migration);
  assert.equal(await tableCount(), 1);
  assert.equal(await functionCount(), 1);
  await identity('manager');
  assert.deepEqual(await visible(), []);
  pass('re-apply after rollback starts empty with the policy back in place');

  console.log(`PASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker scan, Apple Maps, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
