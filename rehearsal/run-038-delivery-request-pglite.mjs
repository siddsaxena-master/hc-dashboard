// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-038-delivery-request-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migration 038 (owner-confirmed delivery time and location) on the
// same fake roster and orders the 036 rehearsal uses. Real migration files are
// executed as written; nothing here rewrites them.
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
const [fixture, original, migration034, migration035, migration, rollback] = await Promise.all([
  'rehearsal/calendar-logo-local-setup.sql',
  'migrations/019_dashboard_auth_transition.sql',
  'migrations/034_calendar_delivery_details.sql',
  'migrations/035_order_logo_assets.sql',
  'migrations/038_delivery_request_owner_edit.sql',
  'migrations/038_delivery_request_owner_edit_rollback.sql',
].map(file => readFile(join(root, file), 'utf8')));
const guard = "current_database() <> 'hc_calendar_logo_rehearsal'";
assert.equal(fixture.split(guard).length, 2);
const setup = fixture.replace(guard, "current_database() <> 'postgres'");
// The 019 order projection plus its grants, exactly as the older rehearsals load it.
const from = original.indexOf('create or replace function public.hc_list_orders_for_current_user(');
const to = original.indexOf('-- Delivery confirmation is the one write allowed', from);
assert.ok(from >= 0 && to > from);
const projectionSql = original.slice(from, to);
const users = Object.fromEntries(['owner','manager','team','inactive','guest','blank','miami']
  .map((name, index) => [name, `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const orders = [1,2,3,4,5,6].map(id => `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`);
// Fixture rows: 1 NY (2026-09-10), 2 miami (2026-09-11), 3 no market (2026-09-12),
// 4 undated quoted NY, 5 undated inquiry NY. Row 6 is added below as cancelled.
const [nyOrder, miamiOrder, unassignedOrder, eventOnlyOrder, undatedOrder, cancelledOrder] = orders;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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
// Reads a whole order row as the database owner, then restores the caller.
async function row(id) {
  const caller = current;
  await identity(null, 'postgres');
  const result = (await db.query('select * from public.orders where id = $1', [id])).rows[0];
  await identity(caller.name, caller.role);
  return result;
}
async function allRows() {
  const caller = current;
  await identity(null, 'postgres');
  const result = (await db.query('select * from public.orders order by id')).rows;
  await identity(caller.name, caller.role);
  return result;
}
const setRequest = (order, window, location = null, date = null, contactName = null, contactPhone = null) =>
  scalar('select public.hc_set_delivery_request($1, $2, $3, $4::date, $5, $6) as value', [order, window, location, date, contactName, contactPhone]);
const projection = async () =>
  (await db.query('select value from public.hc_list_orders_for_current_user() as t(value)')).rows.map(r => r.value);
const projectionHasLocation = () => scalar(
  `select count(*)::int as value from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('hc_list_orders_for_current_user','hc_list_orders_for_current_user_pre_mfa_028')
     and pg_get_functiondef(p.oid) like '%''location'', o.delivery_request -> ''location''%'`);
const functionCount = () => scalar(
  "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_set_delivery_request'");
// Everything except the three columns 038 is allowed to change.
const untouched = ({ delivery_request, venue, updated_at, ...rest }) => rest;

try {
  db = await PGlite.create();
  const ident = (await db.query('select current_database() as name, version() as version')).rows[0];
  assert.equal(ident.name, 'postgres');
  assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  await db.exec(setup + projectionSql);
  // The read-only fixture predates these production columns and rows. The
  // real orders table has updated_at (026 stamps it); 038 requires it.
  await db.exec(`alter table public.orders add column updated_at timestamptz not null default now();
    update public.orders set venue = 'Fake Beach Club', delivery_notes = '1 Fake Lane, Southampton' where id = '${nyOrder}';
    update public.orders set event_start_at = '2026-09-15T22:30:00-04:00' where id = '${eventOnlyOrder}';
    insert into public.orders(id, client_name, delivery_at_utc, stage, market, total_cents)
      values ('${cancelledOrder}', 'Fake cancelled order', '2026-09-13T12:00:00Z', 'cancelled', 'ny', 12000);`);
  await db.exec(migration034);
  const projectionAfter034 = await scalar(
    "select pg_get_functiondef('public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'::regprocedure) as value");
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await functionCount(), 1);
  assert.equal(await projectionHasLocation(), 1);
  const projectionAfter038 = await scalar(
    "select pg_get_functiondef('public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'::regprocedure) as value");
  assert.equal(projectionAfter038.split("'location', o.delivery_request -> 'location'").length, 2);
  // Rebuild the exact block 038 inserts, from its own key names, so this
  // assertion cannot drift from the migration.
  const addition = ['location', 'contact_name', 'contact_phone']
    .map(key => "," + String.fromCharCode(10) + "          '" + key + "', o.delivery_request -> '" + key + "'")
    .join('');
  // Compare with line endings normalised: the base projection text carries
  // CRLF from its own source file while this migration inserts LF, and the
  // database treats both as ordinary whitespace.
  const flat = text => text.split(String.fromCharCode(13)).join('');
  assert.equal(flat(projectionAfter038).replace(flat(addition), ''), flat(projectionAfter034));
  pass('real migration applies, reruns without duplicating the projection key, and changes nothing else in the projection');
  assert.equal(await scalar("select has_function_privilege('anon', 'public.hc_set_delivery_request(uuid,text,text,date,text,text)', 'execute') as value"), false);
  assert.equal(await scalar("select has_function_privilege('authenticated', 'public.hc_set_delivery_request(uuid,text,text,date,text,text)', 'execute') as value"), true);
  assert.equal(await scalar("select has_function_privilege('service_role', 'public.hc_set_delivery_request(uuid,text,text,date,text,text)', 'execute') as value"), false);
  pass('only authenticated sessions may call the function; anon and service_role are not granted');
  const before = await allRows();

  // ── owner sets a window only ──────────────────────────────────────────
  await identity('owner');
  let request = await setRequest(nyOrder, '  2:00   PM ');
  assert.deepEqual(Object.keys(request).sort(), ['checked_at', 'date', 'set_by', 'source', 'status', 'window']);
  assert.equal(request.date, '2026-09-10');
  assert.equal(request.window, '2:00 PM');
  assert.equal(request.status, 'confirmed');
  assert.equal(request.source, 'owner');
  assert.equal(request.set_by, users.owner);
  assert.match(request.checked_at, ISO_MS);
  assert.ok(Number.isFinite(Date.parse(request.checked_at)));
  let stored = await row(nyOrder);
  assert.deepEqual(stored.delivery_request, request);
  assert.equal(stored.venue, 'Fake Beach Club');
  assert.equal(stored.delivery_notes, '1 Fake Lane, Southampton');
  assert.ok(stored.updated_at > before[0].updated_at);
  pass('owner sets window only: contract keys, trimmed window, row date, ISO UTC checked_at, venue untouched');

  // ── second identical call changes nothing ─────────────────────────────
  const snapshot = await row(nyOrder);
  assert.deepEqual(await setRequest(nyOrder, '2:00 PM'), request);
  assert.deepEqual(await setRequest(nyOrder, ' 2:00  PM', '', '2026-09-10'), request);
  assert.deepEqual(await row(nyOrder), snapshot);
  pass('a second identical call (also with the explicit row date) returns the same request and leaves the row byte for byte');

  // ── owner sets window + location ──────────────────────────────────────
  request = await setRequest(nyOrder, '2:00 PM', ' service entrance on Main St, gate code 1234 ');
  assert.equal(request.location, 'service entrance on Main St, gate code 1234');
  assert.equal(request.venue_before, 'Fake Beach Club');
  assert.equal(request.window, '2:00 PM');
  stored = await row(nyOrder);
  assert.equal(stored.venue, 'service entrance on Main St, gate code 1234');
  assert.equal(stored.delivery_notes, '1 Fake Lane, Southampton');
  assert.deepEqual(untouched(stored), untouched(before[0]));
  pass('owner sets window + location: venue mirrors the location, venue_before keeps the original, delivery_notes untouched');
  const withLocation = await row(nyOrder);
  assert.deepEqual(await setRequest(nyOrder, '2:00 PM', 'service entrance on Main St, gate code 1234'), request);
  assert.deepEqual(await row(nyOrder), withLocation);
  pass('a second identical window + location call changes nothing');

  // ── location edits keep the first venue_before ────────────────────────
  request = await setRequest(nyOrder, '2:00 PM', 'side gate');
  assert.equal(request.location, 'side gate');
  assert.equal(request.venue_before, 'Fake Beach Club');
  assert.equal((await row(nyOrder)).venue, 'side gate');
  pass('changing the location re-mirrors venue and keeps the original venue_before');

  // ── location removed, window kept ─────────────────────────────────────
  request = await setRequest(nyOrder, '2:00 PM');
  assert.equal(request.location, undefined);
  assert.equal(request.venue_before, undefined);
  assert.equal((await row(nyOrder)).venue, 'Fake Beach Club');
  pass('removing the location while keeping the window restores venue and drops venue_before');

  // ---- site contact: the person the driver calls from the door ----
  request = await setRequest(nyOrder, '3:00 PM', 'loading dock', null,
    '  Maria   (venue coordinator) ', ' +1 631 555 0134 x2 ');
  assert.equal(request.contact_name, 'Maria (venue coordinator)');
  assert.equal(request.contact_phone, '+1 631 555 0134 x2');
  assert.equal(request.location, 'loading dock');
  pass('owner sets a site contact: name and phone are trimmed and stored beside the window');
  const withContact = await setRequest(nyOrder, '3:00 PM', 'loading dock', null,
    'Maria (venue coordinator)', '+1 631 555 0134 x2');
  assert.deepEqual(withContact, request);
  pass('an identical call including the contact still writes nothing');
  request = await setRequest(nyOrder, '3:00 PM', 'loading dock');
  assert.equal(request.contact_name, undefined);
  assert.equal(request.contact_phone, undefined);
  pass('dropping the contact removes both keys and keeps the window and location');
  await denied('a contact without a window is refused',
    'select public.hc_set_delivery_request($1, null, null, null, $2, $3)',
    [nyOrder, 'Maria', '631 555 0134'], '22023', /delivery window is required/);
  await denied('an over-long contact name is refused',
    'select public.hc_set_delivery_request($1, $2, null, null, $3, null)',
    [nyOrder, '3:00 PM', 'x'.repeat(81)], '22023', /contact name must be 80/);
  await denied('an over-long contact phone is refused',
    'select public.hc_set_delivery_request($1, $2, null, null, null, $3)',
    [nyOrder, '3:00 PM', '5'.repeat(41)], '22023', /contact phone must be 40/);
  await denied('a control character in the contact is refused',
    'select public.hc_set_delivery_request($1, $2, null, null, $3, null)',
    [nyOrder, '3:00 PM', 'Maria' + String.fromCharCode(7)], '22023', /plain text/);
  request = await setRequest(nyOrder, '3:00 PM', null, null, 'x'.repeat(80), '5'.repeat(40));
  assert.equal(request.contact_name.length, 80);
  assert.equal(request.contact_phone.length, 40);
  pass('a contact exactly at both limits is accepted');
  assert.equal(await setRequest(nyOrder, null), null);
  assert.equal((await row(nyOrder)).delivery_request, null);
  pass('clearing the request removes the contact with it');
  // Hand the next scenario the state it expects: a window-only request,
  // no location, so its repeat call is a true replay.
  await setRequest(nyOrder, '2:00 PM');

  // ── worker stamp survives a replay and is cleared by a real edit ──────
  await identity(null, 'postgres');
  await db.query("update public.orders set delivery_request = delivery_request || '{\"notified_at\":\"2026-09-07T15:00:00.000Z\"}'::jsonb where id = $1", [nyOrder]);
  await identity('owner');
  const notified = await row(nyOrder);
  assert.equal((await setRequest(nyOrder, '2:00 PM')).notified_at, '2026-09-07T15:00:00.000Z');
  assert.deepEqual(await row(nyOrder), notified);
  pass('worker notified_at survives an identical owner call (no second push)');
  request = await setRequest(nyOrder, '3:00 PM');
  assert.equal(request.notified_at, undefined);
  assert.equal(request.window, '3:00 PM');
  assert.ok(Date.parse(request.checked_at) >= Date.parse(notified.delivery_request.checked_at));
  pass('a real edit drops notified_at and carries a fresh checked_at so the worker announces it again');

  // ── clear restores venue ──────────────────────────────────────────────
  await setRequest(nyOrder, '3:00 PM', 'loading dock');
  assert.equal((await row(nyOrder)).venue, 'loading dock');
  assert.equal(await setRequest(nyOrder, null, null), null);
  stored = await row(nyOrder);
  assert.equal(stored.delivery_request, null);
  assert.equal(stored.venue, 'Fake Beach Club');
  assert.deepEqual(untouched(stored), untouched(before[0]));
  const cleared = await row(nyOrder);
  assert.equal(await setRequest(nyOrder, '   ', ''), null);
  assert.deepEqual(await row(nyOrder), cleared);
  pass('clear restores venue, empties delivery_request, and a repeated clear changes nothing');

  // ── a venue someone else changed is not overwritten by a clear ───────
  await setRequest(nyOrder, '3:00 PM', 'loading dock');
  await identity(null, 'postgres');
  await db.query('update public.orders set venue = $1 where id = $2', ['Renamed by the dashboard', nyOrder]);
  await identity('owner');
  assert.equal(await setRequest(nyOrder, null), null);
  assert.equal((await row(nyOrder)).venue, 'Renamed by the dashboard');
  pass('clear leaves a venue that was changed by someone else after the mirror');
  await identity(null, 'postgres');
  await db.query('update public.orders set venue = $1 where id = $2', ['Fake Beach Club', nyOrder]);
  await identity('owner');

  // ── re-confirming identical details repairs a clobbered mirror ────────
  // The web dashboard also writes venue, and venue is the only place the
  // shipped crew app shows the location, so re-tapping Confirm has to be the
  // repair. The request itself must not change, or the crew is re-notified.
  const mirrored = await setRequest(nyOrder, '3:00 PM', 'loading dock');
  assert.equal((await row(nyOrder)).venue, 'loading dock');
  await identity(null, 'postgres');
  await db.query('update public.orders set venue = $1 where id = $2', ['Clobbered by the dashboard', nyOrder]);
  await identity('owner');
  const repaired = await setRequest(nyOrder, '3:00 PM', 'loading dock');
  assert.equal((await row(nyOrder)).venue, 'loading dock');
  assert.deepEqual(repaired, mirrored);
  assert.equal(repaired.checked_at, mirrored.checked_at);
  pass('re-confirming the same details puts a clobbered venue mirror back without touching the request');

  // ── a venue corrected after the mirror survives a later clear ─────────
  // venue_before must follow the newest legitimate venue, not the first one,
  // or a clear resurrects a stale name over a QuickBooks correction.
  await identity(null, 'postgres');
  await db.query('update public.orders set venue = $1 where id = $2',
    ['Fake Beach Club PAVILION B', nyOrder]);
  await identity('owner');
  const recaptured = await setRequest(nyOrder, '4:00 PM', 'loading dock');
  assert.equal(recaptured.venue_before, 'Fake Beach Club PAVILION B');
  assert.equal(await setRequest(nyOrder, null), null);
  assert.equal((await row(nyOrder)).venue, 'Fake Beach Club PAVILION B');
  pass('a venue corrected after the mirror was set is what a later clear restores');
  await identity(null, 'postgres');
  await db.query('update public.orders set venue = $1 where id = $2', ['Fake Beach Club', nyOrder]);
  await identity('owner');

  // ── a null venue is restored as null ──────────────────────────────────
  request = await setRequest(unassignedOrder, '10am - 12pm', 'back porch');
  assert.equal(request.date, '2026-09-12');
  assert.ok('venue_before' in request);
  assert.equal(request.venue_before, null);
  assert.equal((await row(unassignedOrder)).venue, 'back porch');
  assert.equal(await setRequest(unassignedOrder, null), null);
  assert.equal((await row(unassignedOrder)).venue, null);
  pass('owner reaches an order with no market; a null original venue comes back as null after clearing');

  // ── manager in market OK, out of market refused ───────────────────────
  await identity('manager');
  request = await setRequest(nyOrder, '9 AM', 'kitchen door');
  assert.equal(request.set_by, users.manager);
  assert.equal(request.location, 'kitchen door');
  assert.equal((await row(nyOrder)).venue, 'kitchen door');
  pass('same-market manager confirms window and location');
  await denied('manager out of market is refused', 'select public.hc_set_delivery_request($1, $2)', [miamiOrder, '9 AM']);
  await denied('manager cannot reach an order with no market', 'select public.hc_set_delivery_request($1, $2)', [unassignedOrder, '9 AM']);
  await denied('manager gets access denied, not not-found, for an unknown order',
    'select public.hc_set_delivery_request($1, $2)', ['30000000-0000-4000-8000-000000000099', '9 AM']);
  assert.equal((await row(miamiOrder)).delivery_request, null);
  pass('refused calls write nothing');

  // ── team, other roles, signed-out, anon refused ──────────────────────
  for (const who of ['team', 'miami', 'guest', 'inactive', 'blank', null, '20000000-0000-4000-8000-000000000099']) {
    await identity(who);
    await denied(`refused for ${who ?? 'signed-out session'}`, 'select public.hc_set_delivery_request($1, $2)', [nyOrder, '9 AM']);
  }
  await identity('blank');
  await denied('blank-market manager cannot reach an order with no market either',
    'select public.hc_set_delivery_request($1, $2)', [unassignedOrder, '9 AM']);
  await identity('owner', 'anon');
  await denied('anonymous role is refused even with an owner-like subject', 'select public.hc_set_delivery_request($1, $2)', [nyOrder, '9 AM']);
  assert.equal((await row(nyOrder)).delivery_request.window, '9 AM');
  pass('team, guest, inactive, blank-market, cross-market, unregistered, signed-out and anonymous callers change nothing');

  // ── validation ────────────────────────────────────────────────────────
  await identity('owner');
  await denied('window too long is refused', 'select public.hc_set_delivery_request($1, $2)', [nyOrder, 'x'.repeat(81)], '22023', /80 characters/);
  await denied('location too long is refused', 'select public.hc_set_delivery_request($1, $2, $3)', [nyOrder, '9 AM', 'y'.repeat(201)], '22023', /200 characters/);
  await denied('location without a window is refused', 'select public.hc_set_delivery_request($1, $2, $3)', [nyOrder, '  ', 'side gate'], '22023', /window is required/);
  // '' is the bell control character; the function must refuse it.
  await denied('control characters are refused', 'select public.hc_set_delivery_request($1, $2)', [nyOrder, '9 AM'], '22023', /plain text/);
  await denied('a null order id is refused', 'select public.hc_set_delivery_request(null, $1)', ['9 AM'], '22023');
  await denied('owner gets not-found for an unknown order', 'select public.hc_set_delivery_request($1, $2)', ['30000000-0000-4000-8000-000000000099', '9 AM'], '22023', /not found/);
  request = await setRequest(nyOrder, 'a'.repeat(80), 'b'.repeat(200));
  assert.equal(request.window.length, 80);
  assert.equal(request.location.length, 200);
  request = await setRequest(nyOrder, 'line one\n\tline two', 'gate\r\ncode 1234');
  assert.equal(request.window, 'line one line two');
  assert.equal(request.location, 'gate code 1234');
  pass('boundary lengths are accepted and inner line breaks collapse to single spaces');

  // ── dates ─────────────────────────────────────────────────────────────
  await denied('wrong date is refused with the invoice message', 'select public.hc_set_delivery_request($1, $2, null, $3::date)',
    [nyOrder, '9 AM', '2026-09-11'], '22023', /dates change through the invoice.*2026-09-10/);
  await denied('wrong date is refused even on a clear', 'select public.hc_set_delivery_request($1, null, null, $2::date)',
    [nyOrder, '2026-09-11'], '22023', /dates change through the invoice/);
  assert.equal((await setRequest(nyOrder, '9 AM', null, '2026-09-10')).date, '2026-09-10');
  pass('the explicit row date is accepted');
  await denied('an undated order cannot take a window', 'select public.hc_set_delivery_request($1, $2)', [undatedOrder, '9 AM'], '22023', /no delivery date yet/);
  await denied('an undated order refuses any explicit date', 'select public.hc_set_delivery_request($1, $2, null, $3::date)',
    [undatedOrder, '9 AM', '2026-09-20'], '22023', /no date yet/);
  assert.equal(await setRequest(undatedOrder, null), null);
  pass('an undated order can still be cleared');
  await db.exec("set timezone to 'America/New_York';");
  request = await setRequest(eventOnlyOrder, '8 AM');
  assert.equal(request.date, '2026-09-16');
  await denied('event-only order refuses the local-time date', 'select public.hc_set_delivery_request($1, $2, null, $3::date)',
    [eventOnlyOrder, '8 AM', '2026-09-15'], '22023', /2026-09-16/);
  await db.exec('reset timezone;');
  assert.equal((await setRequest(eventOnlyOrder, '8 AM', null, '2026-09-16')).date, '2026-09-16');
  pass('with no delivery marker the event start decides, as the UTC date the app buckets by, whatever the session timezone');
  await denied('a cancelled order is refused', 'select public.hc_set_delivery_request($1, $2)', [cancelledOrder, '9 AM'], '22023', /cancelled/);

  // ── another source is replaced, private keys dropped ─────────────────
  await identity(null, 'postgres');
  await db.query('update public.orders set delivery_request = $1::jsonb where id = $2', [JSON.stringify({
    date: '2026-09-11', window: '9 AM', status: 'requested', source: 'email',
    checked_at: '2026-09-01T10:00:00.000Z', source_ref: 'private-thread-reference',
  }), miamiOrder]);
  await identity('owner');
  request = await setRequest(miamiOrder, '9 AM');
  assert.equal(request.status, 'confirmed');
  assert.equal(request.source, 'owner');
  assert.equal(request.source_ref, undefined);
  assert.notEqual(request.checked_at, '2026-09-01T10:00:00.000Z');
  pass('an emailed request with the same window becomes an owner confirmation without its private reference');

  // ── projection ────────────────────────────────────────────────────────
  await identity('owner');
  await setRequest(nyOrder, '9 AM', 'kitchen door');
  await identity(null, 'postgres');
  await db.query("update public.orders set delivery_request = delivery_request || '{\"notified_at\":\"2026-09-07T15:00:00.000Z\"}'::jsonb where id = $1", [nyOrder]);
  await identity('manager');
  let rows = await projection();
  let seen = rows.find(r => r.id === nyOrder);
  assert.ok(seen);
  assert.deepEqual(Object.keys(seen.delivery_request).sort(), ['checked_at', 'contact_name', 'contact_phone', 'date', 'location', 'source', 'status', 'window']);
  assert.equal(seen.delivery_request.location, 'kitchen door');
  assert.equal(seen.venue, 'kitchen door');
  assert.equal(seen.client_email, undefined);
  assert.equal(seen.total_cents, undefined);
  assert.ok(rows.every(r => r.id !== miamiOrder));
  pass('projection for a manager exposes location (and the mirrored venue) but never set_by, venue_before, notified_at or private fields');
  await identity('team');
  seen = (await projection()).find(r => r.id === nyOrder);
  assert.equal(seen.delivery_request.location, 'kitchen door');
  assert.equal(seen.delivery_request.venue_before, undefined);
  pass('team phones get the same eight delivery_request keys');
  await identity('owner');
  seen = (await projection()).find(r => r.id === nyOrder);
  assert.equal(seen.delivery_request.venue_before, 'Fake Beach Club');
  assert.equal(seen.delivery_request.set_by, users.owner);
  assert.equal(seen.delivery_request.notified_at, '2026-09-07T15:00:00.000Z');
  pass('owner projection still returns the whole row');

  // ── nothing outside delivery_request, venue, updated_at changed ───────
  const after = await allRows();
  assert.deepEqual(after.map(untouched), before.map(untouched));
  assert.equal(after.find(r => r.id === miamiOrder).venue, before.find(r => r.id === miamiOrder).venue);
  pass('no date marker, address, market, stage, quantity, customer or money field was edited on any order');

  // ── rollback and re-apply ─────────────────────────────────────────────
  await identity(null, 'postgres');
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await functionCount(), 0);
  assert.equal(await projectionHasLocation(), 0);
  assert.equal(await scalar(
    "select pg_get_functiondef('public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'::regprocedure) as value"),
    projectionAfter034);
  assert.match(await scalar("select col_description('public.orders'::regclass, (select attnum from pg_attribute where attrelid = 'public.orders'::regclass and attname = 'delivery_request')) as value"),
    /^Optional human-verified request: \{date:"YYYY-MM-DD"\|null,window,status:"requested"\|"confirmed"\|"conflict",source:"email"\|"owner",checked_at,source_ref\?\}\./);
  assert.equal((await row(nyOrder)).delivery_request.location, 'kitchen door');
  pass('rollback removes the function, restores the exact 034 projection and comment, reruns safely, and leaves row data alone');
  await identity('manager');
  seen = (await projection()).find(r => r.id === nyOrder);
  assert.equal(seen.delivery_request.location, undefined);
  await denied('rolled-back function cannot be called', 'select public.hc_set_delivery_request($1, $2)', [nyOrder, '9 AM'], '42883');
  pass('after rollback non-owners no longer see location');
  await identity(null, 'postgres');
  await db.exec(migration);
  assert.equal(await functionCount(), 1);
  assert.equal(await projectionHasLocation(), 1);
  await identity('manager');
  assert.equal((await projection()).find(r => r.id === nyOrder).delivery_request.location, 'kitchen door');
  assert.equal((await setRequest(nyOrder, '9 AM', 'kitchen door')).location, 'kitchen door');
  pass('re-applying 038 after the rollback restores the function and the projection key');

  // ── refusals of the wrong starting state ──────────────────────────────
  await identity(null, 'postgres');
  await db.exec('alter table public.orders drop constraint orders_delivery_request_object;');
  await assert.rejects(db.exec(migration), /038 requires the 034 constraint/);
  await db.exec('rollback;');
  await db.exec("alter table public.orders add constraint orders_delivery_request_object check (delivery_request is null or jsonb_typeof(delivery_request) = 'object');");
  pass('migration refuses a database missing the 034 shape constraint');
  await db.exec(projectionSql);
  await assert.rejects(db.exec(migration), /038 requires the 034 delivery projection/);
  await db.exec('rollback;');
  await db.exec(migration034);
  await db.exec(migration);
  assert.equal(await projectionHasLocation(), 1);
  pass('migration refuses a projection without the 034 delivery block, then applies once 034 is back');

  // -- the privacy gate, narrowed 2026-09-09: the LOCATION waits, the TIME does not --
  // Gate codes and service-entrance notes must not land in a table the public
  // dashboard key can read, and migration 020 removes that access. The delivery
  // WINDOW is not in that class: names, street addresses, phones and delivery
  // dates on this table are already exposed, so a time of day adds nothing, and
  // withholding it would cost the owner the field feature entirely.
  await identity(null, 'postgres');
  await db.exec('grant select on table public.orders to anon;');
  await identity('owner');
  const publicWindow = await setRequest(nyOrder, '4:30 PM');
  assert.equal(publicWindow.window, '4:30 PM');
  assert.equal(publicWindow.location, undefined);
  pass('the delivery time still saves while the orders table is publicly readable');
  await denied('the on-site location is refused while anon can read orders',
    'select public.hc_set_delivery_request($1, $2, $3)',
    [nyOrder, '4:30 PM', 'gate code 4412'], '42501', /cannot be saved until public read access/);
  assert.equal((await row(nyOrder)).delivery_request.location, undefined);
  assert.equal((await row(nyOrder)).venue, 'Fake Beach Club');
  pass('a refused location writes nothing at all, and never touches the venue');
  await identity(null, 'postgres');
  await db.exec('revoke select on table public.orders from anon;');
  await identity('owner');
  const privateLocation = await setRequest(nyOrder, '4:30 PM', 'gate code 4412');
  assert.equal(privateLocation.location, 'gate code 4412');
  pass('the same location saves once public read access is removed');
  // Hand the next scenario the state it expects: the manager's window and
  // on-site location, exactly as it stood before this gate block ran.
  await setRequest(nyOrder, '9 AM', 'kitchen door');

  // ── 035 and 038 patch different projection lines, so either can go live first ──
  // 035 (customer logos) is still local preparation while 038 may ship before it.
  await identity(null, 'postgres');
  await db.exec(migration035);                                   // 035 lands after 038
  for (const sql of [rollback, migration, migration]) await db.exec(sql); // 038 lands after 035, then reruns
  const stacked = await scalar(
    "select pg_get_functiondef('public.hc_list_orders_for_current_user(timestamptz,timestamptz,text[],integer,integer)'::regprocedure) as value");
  assert.equal(stacked.split("'logo_asset', case").length, 2);
  assert.equal(stacked.split("'location', o.delivery_request -> 'location'").length, 2);
  await identity('manager');
  seen = (await projection()).find(r => r.id === nyOrder);
  assert.equal(seen.delivery_request.location, 'kitchen door');
  assert.equal(seen.logo_asset, null);
  pass('035 and 038 apply in either order; the projection carries both logo_asset and location exactly once');

  console.log(`PASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker push, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
