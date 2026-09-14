// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-044-order-reconfirmations-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/044_order_reconfirmations.sql (the reconfirmation
// email rows, the owner's decisions from the phone, and the conversation id
// on intake_messages) and its rollback on the shape production is in on
// 2026-09-14: the 001-013 base chain, 015, 015b, 019, 024, 026, 027, 029,
// 034-038 and 040-043 (015c and 030 are live too but refuse to apply on this
// sandbox, so they are not reproduced here). Real migration files are
// executed as written and never rewritten on disk. Every order, email and
// person here is fake.
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
];
const [supabaseBootstrap, ordersBaseline, migration, rollback] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/044_order_reconfirmations.sql'),
  read('migrations/044_order_reconfirmations_rollback.sql'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));

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
  ny: '30000000-0000-4000-8000-000000000001',
  vegas: '30000000-0000-4000-8000-000000000002',
  matrix: '30000000-0000-4000-8000-000000000003',
  doomed: '30000000-0000-4000-8000-000000000004',
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
  ('${STALE.authUserId}', '${STALE.email}', '2026-01-04T00:00:00Z');
insert into public.field_workers (id, email, name, market, role, active, hourly_rate_cents) values
  ('${ID.manager}', '${MANAGER.email}', 'Sandbox Manager', 'ny', 'manager', true, 1900),
  ('${ID.team}', '${TEAM.email}', 'Sandbox Team', 'ny', 'team', true, 1800),
  ('${ID.stale}', '${STALE.email}', 'Sandbox Ex-manager', 'ny', 'manager', false, null);
insert into public.orders (id, client_name, client_email, venue, delivery_at_utc, stage, market, coconuts_qty, external_invoice_id, deposit_cents, balance_cents) values
  ('${ORDER.ny}', 'Fake Planner', 'fake.planner@example.invalid', 'Fake Beach Club', '2026-09-19T00:00:00Z', 'deposit_paid', 'ny', 100, 'FAKE-2101', 50000, 50000),
  ('${ORDER.vegas}', 'Fake Casino', 'events@example.invalid, ar@example.invalid', 'Fake Casino Terrace', '2026-09-20T00:00:00Z', 'paid_full', 'vegas', 60, 'FAKE-2102', 0, 0),
  ('${ORDER.matrix}', 'Fake Matrix', 'matrix@example.invalid', 'Fake Hall', '2026-09-21T00:00:00Z', 'deposit_paid', 'ny', 40, 'FAKE-2103', 20000, 20000),
  ('${ORDER.doomed}', 'Fake Cascade', 'cascade@example.invalid', 'Fake Pier', '2026-09-22T00:00:00Z', 'deposit_paid', 'ny', 30, 'FAKE-2104', 10000, 10000);
insert into public.intake_messages (channel, source_msg_id, from_addr, subject, raw_text, classification, status, order_id, classified_at) values
  ('email', 'fake-pre-044-1', 'fake.planner@example.invalid', 'Re: Your coconuts for Saturday, September 19: quick reconfirm', 'confirmed', 'order', 'pending_review', '${ORDER.ny}', now());`;

// The subject and body the worker would write, filled with fake facts only.
const SUBJECT = 'Your coconuts for Saturday, September 19: quick reconfirm';
const BODY = [
  'Hi Fake,',
  '',
  'Your coconuts for Saturday, September 19 are locked in. One quick read through before we brand them.',
  '',
  'Delivery: Saturday, September 19. What exact time should our driver arrive? One line like \'please arrive at ...\' with the time is perfect.',
  'Drop off: Fake Beach Club, 1 Fake Lane, Southampton, NY 11968',
  'Count: 100 custom branded coconuts',
  'Cracking: straw hole pre-cracked, ready for straws',
  'On site contact: who should our driver call when we arrive? A name and cell is perfect.',
  'Your contact on our side: Sidd, sidd@hamptonscoconuts.com',
  '',
  'We brand and box everything on Friday, September 18, the day before. If anything above needs to change (count, time, address, or who meets us), reply by Wednesday, September 16 and I will update it.',
  '',
  'If it all looks right, just reply "confirmed" and we are set.',
  '',
  'Thanks so much,',
  'Sidd',
  'Hamptons Coconuts',
].join('\n');
const FACTS = {
  source: { stage: 'deposit_paid', coconuts_qty: 100, delivery_at_utc: '2026-09-19T00:00:00+00:00', venue: 'Fake Beach Club', client_email: 'fake.planner@example.invalid' },
  derived: { first_name: 'Fake', day_words: 'Saturday, September 19', count: 100, market: 'ny', zone: 'America/New_York' },
};

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
const DECIDE_SQL = 'select public.hc_decide_reconfirmation($1, $2) as value';
async function decideAs(h, who, id, decision) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  try { return await scalarOn(h, DECIDE_SQL, [id, decision]); } finally { await identityOn(h); }
}
// The worker's insert, with the service key. Only the named fields vary.
async function draft(h, fields = {}) {
  const row = {
    order_id: ORDER.ny, delivery_day: '2026-09-19', status: 'ready', hold_reasons: [],
    subject: SUBJECT, body: BODY, recipients: ['fake.planner@example.invalid'],
    facts: FACTS, picture: null, mode: 'preview', send_after: '2026-09-15T14:00:00Z',
    sent_at: null, change_note: null, ...fields,
  };
  return asServiceRole(h, () => scalarOn(h,
    `insert into public.order_reconfirmations
       (order_id, delivery_day, status, hold_reasons, subject, body, recipients, facts, picture, mode, send_after, sent_at, change_note)
     values ($1, $2::date, $3, $4::text[], $5, $6, $7::text[], $8::jsonb, $9::jsonb, $10, $11::timestamptz, $12::timestamptz, $13)
     returning id as value`,
    [row.order_id, row.delivery_day, row.status, row.hold_reasons, row.subject, row.body, row.recipients,
      JSON.stringify(row.facts), row.picture == null ? null : JSON.stringify(row.picture), row.mode, row.send_after, row.sent_at, row.change_note]));
}
const rowOf = (h, id) => asPostgres(h, async () => (await rowsOn(h,
  `select id, order_id, delivery_day::text as delivery_day, status, hold_reasons, subject, body, recipients, facts, picture, mode,
          send_after, decided_at, decided_by, decision, sent_at, change_note, created_at, updated_at
     from public.order_reconfirmations where id = $1`, [id]))[0]);
const setStatus = (h, id, status, holdReasons = []) => asServiceRole(h, () => q(h,
  'update public.order_reconfirmations set status = $2, hold_reasons = $3::text[] where id = $1', [id, status, holdReasons]));
const fnCount = h => scalarOn(h, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_decide_reconfirmation'");
const tableCount = h => scalarOn(h, "select count(*)::int as value from pg_class where relnamespace = 'public'::regnamespace and relname = 'order_reconfirmations'");
const columnType = h => scalarOn(h,
  "select format_type(atttypid, atttypmod) as value from pg_attribute where attrelid = 'public.intake_messages'::regclass and attname = 'conversation_id' and attnum > 0 and not attisdropped");
const indexExists = (h, name) => scalarOn(h, 'select to_regclass($1) is not null as value', [`public.${name}`]);
const seconds = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);

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
    'select id, email, name, role, active from public.field_workers where lower(email) = $1', [OWNER.email]))[0]);
  assert.ok(owner && owner.role === 'owner' && owner.active === true, 'the bootstrap must carry the owner row');
  ID.owner = owner.id;

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await fnCount(db), 1);
  assert.equal(await tableCount(db), 1);
  pass('044 applies twice on the production-shaped chain (001-013, 015, 015b, 019, 024, 026, 027, 029, 034-038, 040-043)');

  // ── the intake column ──
  assert.equal(await columnType(db), 'text');
  assert.equal(await indexExists(db, 'intake_messages_conversation_id_idx'), true);
  const preRow = await asPostgres(db, async () => (await rowsOn(db,
    "select id, conversation_id, status from public.intake_messages where source_msg_id = 'fake-pre-044-1'"))[0]);
  assert.equal(preRow.conversation_id, null);
  assert.equal(preRow.status, 'pending_review');
  const intakeId = await asServiceRole(db, () => scalarOn(db,
    `insert into public.intake_messages (channel, source_msg_id, from_addr, subject, raw_text, classification, status, order_id, classified_at, conversation_id)
     values ('email', 'fake-post-044-1', 'fake.planner@example.invalid', 'Re: ${SUBJECT}', 'confirmed', 'order', 'pending_review', $1, now(), $2)
     returning id as value`, [ORDER.ny, 'AAQkFakeConversation001']));
  assert.equal(await asServiceRole(db, () => scalarOn(db,
    'select conversation_id as value from public.intake_messages where id = $1', [intakeId])), 'AAQkFakeConversation001');
  assert.equal(await asServiceRole(db, () => scalarOn(db,
    'select id as value from public.intake_messages where conversation_id = $1', ['AAQkFakeConversation001'])), intakeId);
  pass('intake_messages.conversation_id is a nullable text column with an index; old rows read null, the poller writes it on insert');

  // ── the worker's draft ──
  const readyId = await draft(db);
  let row = await rowOf(db, readyId);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.hold_reasons, []);
  assert.equal(row.mode, 'preview');
  assert.equal(row.delivery_day, '2026-09-19');
  assert.equal(row.subject, SUBJECT);
  assert.equal(row.body, BODY);
  assert.deepEqual(row.recipients, ['fake.planner@example.invalid']);
  assert.deepEqual(row.facts, FACTS);
  assert.equal(row.picture, null);
  assert.equal(row.decision, null);
  const defaultsId = await asServiceRole(db, () => scalarOn(db,
    'insert into public.order_reconfirmations (order_id, delivery_day, subject, body) values ($1, $2::date, $3, $4) returning id as value',
    [ORDER.vegas, '2026-09-20', 'Your coconuts for Sunday, September 20: quick reconfirm', 'Hi Fake, one quick read through.']));
  row = await rowOf(db, defaultsId);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.hold_reasons, []);
  assert.deepEqual(row.facts, {});
  assert.deepEqual(row.recipients, []);
  assert.equal(row.mode, 'preview');
  assert.equal(row.send_after, null);
  pass('the service key inserts a draft; defaults are status ready, no hold reasons, empty facts, empty recipients, mode preview');

  // ── one live row per order per delivery day ──
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'a second live row for the same order and delivery day is refused (the unique index)',
    'insert into public.order_reconfirmations (order_id, delivery_day, subject, body) values ($1, $2::date, $3, $4)',
    [ORDER.ny, '2026-09-19', SUBJECT, BODY], '23505');
  await identityOn(db);
  const otherDayId = await draft(db, { delivery_day: '2026-09-26', send_after: null });
  assert.ok(otherDayId > readyId);
  pass('the same order on another delivery day gets its own row');

  // ── constraints the worker and droplet lean on ──
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'an unknown status is refused', 'update public.order_reconfirmations set status = $2 where id = $1', [readyId, 'maybe'], '23514');
  await deniedOn(db, 'an unknown hold reason is refused', 'update public.order_reconfirmations set hold_reasons = $2::text[] where id = $1', [readyId, ['logo_missing']], '23514');
  await deniedOn(db, 'a subject over 200 characters is refused', 'update public.order_reconfirmations set subject = $2 where id = $1', [readyId, 'x'.repeat(201)], '23514');
  await deniedOn(db, 'an empty body is refused', 'update public.order_reconfirmations set body = $2 where id = $1', [readyId, ''], '23514');
  await deniedOn(db, 'a body over 6000 characters is refused', 'update public.order_reconfirmations set body = $2 where id = $1', [readyId, 'x'.repeat(6001)], '23514');
  await deniedOn(db, 'an unknown mode is refused', 'update public.order_reconfirmations set mode = $2 where id = $1', [readyId, 'manual'], '23514');
  await deniedOn(db, 'an unknown decision is refused by the column check', 'update public.order_reconfirmations set decision = $2 where id = $1', [readyId, 'maybe'], '23514');
  await deniedOn(db, 'an unknown reply_kind is refused', 'update public.order_reconfirmations set reply_kind = $2 where id = $1', [readyId, 'question'], '23514');
  await deniedOn(db, 'a picture with an unknown source is refused', 'update public.order_reconfirmations set picture = $2::jsonb where id = $1', [readyId, JSON.stringify({ source: 'signed_url', url: 'https://example.invalid/x.png' })], '23514');
  await deniedOn(db, 'a picture that is not an object is refused', 'update public.order_reconfirmations set picture = $2::jsonb where id = $1', [readyId, JSON.stringify(['logo_asset'])], '23514');
  await deniedOn(db, 'facts that are not an object are refused', 'update public.order_reconfirmations set facts = $2::jsonb where id = $1', [readyId, JSON.stringify([1, 2])], '23514');
  await q(db, 'update public.order_reconfirmations set picture = $2::jsonb where id = $1',
    [readyId, JSON.stringify({ source: 'logo_asset', bucket: 'order-logos', path: 'fake/preview.png', content_type: 'image/png' })]);
  await q(db, 'update public.order_reconfirmations set picture = null where id = $1', [readyId]);
  await identityOn(db);
  pass('a well-formed picture (logo_asset with bucket, path, content_type) is accepted and can be cleared');

  // ── send_now: ready to released ──
  let out = await decideAs(db, OWNER, readyId, 'send_now');
  assert.equal(out.applied, true);
  assert.equal(out.status, 'released');
  assert.deepEqual(Object.keys(out.row).sort(), ['delivery_day', 'hold_reasons', 'id', 'order_id', 'send_after', 'status']);
  assert.equal(out.row.id, readyId);
  assert.equal(out.row.order_id, ORDER.ny);
  assert.equal(out.row.delivery_day, '2026-09-19');
  assert.equal(out.row.status, 'released');
  assert.deepEqual(out.row.hold_reasons, []);
  row = await rowOf(db, readyId);
  assert.equal(row.status, 'released');
  assert.ok(seconds(row.send_after, Date.now()) < 60, 'send_after moved to now');
  assert.equal(seconds(row.send_after, out.row.send_after), 0);
  assert.equal(row.decision, 'send_now');
  assert.equal(row.decided_by, OWNER.authUserId);
  assert.ok(seconds(row.decided_at, Date.now()) < 60);
  assert.ok(new Date(row.updated_at).getTime() >= new Date(row.created_at).getTime());
  pass('send_now: ready becomes released, send_after is now, decided_at, decided_by and decision are stamped, the return carries {applied, status, row}');

  // ── hold and release ──
  const holdId = await draft(db, { order_id: ORDER.vegas, delivery_day: '2026-09-27', send_after: '2026-09-23T17:00:00Z' });
  out = await decideAs(db, OWNER, holdId, 'hold');
  assert.equal(out.status, 'held');
  assert.deepEqual(out.row.hold_reasons, ['owner_hold']);
  row = await rowOf(db, holdId);
  assert.equal(row.status, 'held');
  assert.deepEqual(row.hold_reasons, ['owner_hold']);
  assert.equal(row.decision, 'hold');
  assert.equal(seconds(row.send_after, '2026-09-23T17:00:00Z'), 0, 'hold leaves send_after alone');
  pass('hold: ready becomes held with hold_reasons {owner_hold}');
  out = await decideAs(db, OWNER, holdId, 'release');
  assert.equal(out.status, 'ready');
  assert.deepEqual(out.row.hold_reasons, []);
  row = await rowOf(db, holdId);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.hold_reasons, []);
  assert.equal(row.decision, 'release');
  pass('release: an owner hold goes back to ready with the reasons cleared');

  // ── holds the owner cannot lift by hand ──
  const countHoldId = await draft(db, { order_id: ORDER.vegas, delivery_day: '2026-10-03', status: 'held', hold_reasons: ['count_missing'], send_after: null });
  const mixedHoldId = await draft(db, { order_id: ORDER.vegas, delivery_day: '2026-10-04', status: 'held', hold_reasons: ['owner_hold', 'address_missing'], send_after: null });
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'release on a count_missing hold is refused: fix the missing detail first', DECIDE_SQL, [countHoldId, 'release'], '22023', /fix the missing detail first/);
  await deniedOn(db, 'release on a mixed hold (owner_hold plus address_missing) is refused too', DECIDE_SQL, [mixedHoldId, 'release'], '22023', /fix the missing detail first/);
  await identityOn(db);
  row = await rowOf(db, countHoldId);
  assert.equal(row.status, 'held');
  assert.deepEqual(row.hold_reasons, ['count_missing']);
  assert.equal(row.decision, null);
  row = await rowOf(db, mixedHoldId);
  assert.deepEqual(row.hold_reasons, ['owner_hold', 'address_missing']);
  pass('a refused release leaves the held row byte for byte as it was');

  // ── skip from ready and from held ──
  out = await decideAs(db, OWNER, holdId, 'skip');
  assert.equal(out.status, 'skipped');
  assert.equal((await rowOf(db, holdId)).status, 'skipped');
  pass('skip: a ready row becomes skipped');
  out = await decideAs(db, OWNER, countHoldId, 'skip');
  assert.equal(out.status, 'skipped');
  row = await rowOf(db, countHoldId);
  assert.equal(row.status, 'skipped');
  assert.deepEqual(row.hold_reasons, ['count_missing'], 'skip keeps the reasons for the record');
  pass('skip: a held row becomes skipped (any hold reason)');

  // ── resend from sent, confirmed and changed; the slot frees up ──
  const sentId = await draft(db, { order_id: ORDER.matrix, delivery_day: '2026-09-21', status: 'sent', sent_at: '2026-09-17T14:00:00Z' });
  out = await decideAs(db, OWNER, sentId, 'resend');
  assert.equal(out.status, 'superseded');
  assert.equal((await rowOf(db, sentId)).status, 'superseded');
  const freshId = await draft(db, { order_id: ORDER.matrix, delivery_day: '2026-09-21', subject: 'Updated details for Monday, September 21' });
  assert.ok(freshId > sentId, 'a superseded row no longer blocks the unique index');
  pass('resend: a sent row becomes superseded and the worker can draft a fresh row for the same order and day');
  await setStatus(db, freshId, 'confirmed');
  out = await decideAs(db, OWNER, freshId, 'resend');
  assert.equal(out.status, 'superseded');
  pass('resend: a confirmed row becomes superseded');
  const changedId = await draft(db, { order_id: ORDER.matrix, delivery_day: '2026-09-21', status: 'changed', sent_at: '2026-09-17T15:00:00Z', change_note: 'count 40 to 60' });
  out = await decideAs(db, OWNER, changedId, 'resend');
  assert.equal(out.status, 'superseded');
  row = await rowOf(db, changedId);
  assert.equal(row.change_note, 'count 40 to 60', 'resend keeps the change note on the old row');
  pass('resend: a changed row becomes superseded, its change note kept');
  // After a bounce the customer never saw the email, so the owner fixes the
  // address on the invoice and Resend frees the slot; the worker then drafts
  // the FIRST-TIME subject again, not "Updated details".
  const bouncedId = await draft(db, { order_id: ORDER.matrix, delivery_day: '2026-09-28', status: 'bounced', sent_at: '2026-09-24T14:00:00Z' });
  await asServiceRole(db, () => q(db, "update public.order_reconfirmations set reply_kind = 'bounced', replied_at = now() where id = $1", [bouncedId]));
  out = await decideAs(db, OWNER, bouncedId, 'resend');
  assert.equal(out.status, 'superseded');
  row = await rowOf(db, bouncedId);
  assert.equal(row.status, 'superseded');
  assert.equal(row.decision, 'resend');
  const afterBounceId = await draft(db, { order_id: ORDER.matrix, delivery_day: '2026-09-28', subject: 'Your coconuts for Monday, September 28: quick reconfirm' });
  assert.ok(afterBounceId > bouncedId, 'a superseded bounce no longer blocks the unique index');
  assert.equal((await rowOf(db, afterBounceId)).status, 'ready');
  pass('resend: a bounced row becomes superseded and a fresh first-time draft for the same order and day is accepted');

  // ── done: changed back to sent ──
  const doneId = await draft(db, { order_id: ORDER.matrix, delivery_day: '2026-09-21', status: 'changed', sent_at: '2026-09-17T16:00:00Z', change_note: 'address 1 Fake Lane to 2 Fake Lane' });
  out = await decideAs(db, OWNER, doneId, 'done');
  assert.equal(out.status, 'sent');
  row = await rowOf(db, doneId);
  assert.equal(row.status, 'sent');
  assert.equal(row.change_note, 'address 1 Fake Lane to 2 Fake Lane');
  assert.equal(seconds(row.sent_at, '2026-09-17T16:00:00Z'), 0, 'done keeps the original sent_at');
  assert.equal(row.decision, 'done');
  pass('done: a changed row goes back to sent with change_note and sent_at kept');

  // ── every other (status, decision) pair is refused and changes nothing ──
  const ALLOWED = {
    send_now: ['ready'], hold: ['ready'], release: ['held'], skip: ['ready', 'held'],
    resend: ['sent', 'confirmed', 'changed', 'bounced'], done: ['changed'],
  };
  const STATUSES = ['held', 'ready', 'released', 'claimed', 'sent', 'confirmed', 'changed', 'bounced', 'skipped', 'expired', 'superseded'];
  const matrixId = await draft(db, { order_id: ORDER.doomed, delivery_day: '2026-09-22', send_after: null });
  let refused = 0;
  for (const status of STATUSES) {
    // A held row here carries a worker hold, so even 'release' must refuse.
    await setStatus(db, matrixId, status, status === 'held' ? ['count_missing'] : []);
    for (const decision of Object.keys(ALLOWED)) {
      if (ALLOWED[decision].includes(status) && !(decision === 'release' && status === 'held')) continue;
      await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
      await assert.rejects(q(db, DECIDE_SQL, [matrixId, decision]),
        error => error.code === '22023' && /needs a|fix the missing detail first/.test(error.message),
        `${decision} on ${status} must be refused with 22023`);
      await identityOn(db);
      const after = await rowOf(db, matrixId);
      assert.equal(after.status, status, `${decision} on ${status} must not move the row`);
      assert.equal(after.decision, null, `${decision} on ${status} must not stamp a decision`);
      refused++;
    }
  }
  // 66 pairs, minus the 9 allowed ones (release on held is still tried here
  // because the sandbox row carries a worker hold, which must refuse).
  assert.equal(refused, 11 * 6 - 9, 'every pair outside the six transitions was tried');
  pass(`${refused} disallowed (status, decision) pairs are refused with 22023 and a plain sentence; the row never moves`);

  // ── malformed calls ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'an unknown decision word is refused', DECIDE_SQL, [readyId, 'maybe'], '22023', /must be send_now, hold, release, skip, resend or done/);
  await deniedOn(db, 'an empty decision is refused', DECIDE_SQL, [readyId, ''], '22023', /must be send_now/);
  await deniedOn(db, 'a null id is refused', DECIDE_SQL, [null, 'send_now'], '22023', /reconfirmation id is required/);
  await deniedOn(db, 'an unknown id is a clear 22023', DECIDE_SQL, [987654321, 'send_now'], '22023', /No such reconfirmation/);
  await identityOn(db);
  const spacedId = await draft(db, { order_id: ORDER.doomed, delivery_day: '2026-10-10', send_after: null });
  out = await decideAs(db, OWNER, spacedId, '  Send_Now ');
  assert.equal(out.status, 'released');
  pass('the decision word is trimmed and lower-cased before it is checked');

  // ── who may call ──
  const callerId = await draft(db, { order_id: ORDER.doomed, delivery_day: '2026-10-11', send_after: null });
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  await deniedOn(db, 'a manager cannot decide a reconfirmation', DECIDE_SQL, [callerId, 'send_now'], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  await deniedOn(db, 'a team member cannot decide a reconfirmation', DECIDE_SQL, [callerId, 'send_now'], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated', sub: STALE.authUserId });
  await deniedOn(db, 'an inactive login cannot decide a reconfirmation', DECIDE_SQL, [callerId, 'send_now'], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated' });
  await deniedOn(db, 'a login with no auth uid is refused', DECIDE_SQL, [callerId, 'send_now'], '42501', /authenticated field worker required/);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot even call the function', DECIDE_SQL, [callerId, 'send_now'], '42501', /permission denied for function/);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the service key cannot call the function (execute revoked)', DECIDE_SQL, [callerId, 'send_now'], '42501', /permission denied for function/);
  await identityOn(db);
  assert.equal((await rowOf(db, callerId)).status, 'ready');
  pass('refused callers never touch the row');

  // ── who can read ──
  const total = await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'));
  assert.ok(total >= 10);
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'), total);
  const ownerSees = await rowsOn(db, 'select recipients, body from public.order_reconfirmations where id = $1', [readyId]);
  assert.deepEqual(ownerSees[0].recipients, ['fake.planner@example.invalid']);
  assert.equal(ownerSees[0].body, BODY);
  pass('the owner phone reads every row, recipients and body included');
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'), 0);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'), 0);
  await identityOn(db, { role: 'authenticated', sub: STALE.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'), 0);
  await identityOn(db, { role: 'authenticated' });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'), 0);
  pass('an authenticated non-owner (manager, team, inactive, no uid) reads nothing');
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon reads nothing from order_reconfirmations (no grant at all)', 'select count(*) from public.order_reconfirmations');
  await deniedOn(db, 'anon cannot insert into order_reconfirmations', 'insert into public.order_reconfirmations (order_id, delivery_day, subject, body) values ($1, $2::date, $3, $4)', [ORDER.ny, '2026-12-01', 'x', 'y']);
  const anonIntake = await q(db, 'select count(*)::int as value from public.intake_messages').then(r => r.rows[0].value, error => error.code);
  assert.ok(anonIntake === 0 || anonIntake === '42501');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  const ownerIntake = await q(db, 'select count(*)::int as value from public.intake_messages').then(r => r.rows[0].value, error => error.code);
  assert.ok(ownerIntake === 0 || ownerIntake === '42501');
  pass('intake_messages stays closed to anon and to phones: the new column opens nothing');

  // ── nobody but the service key writes the table, and even it cannot delete ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'the owner cannot update the table directly', 'update public.order_reconfirmations set status = $2 where id = $1', [callerId, 'released']);
  await deniedOn(db, 'the owner cannot insert directly', 'insert into public.order_reconfirmations (order_id, delivery_day, subject, body) values ($1, $2::date, $3, $4)', [ORDER.ny, '2026-12-02', 'x', 'y']);
  await deniedOn(db, 'the owner cannot delete directly', 'delete from public.order_reconfirmations where id = $1', [callerId]);
  await identityOn(db, { role: 'service_role' });
  await q(db, 'update public.order_reconfirmations set previewed_at = now(), reminded_at = now() where id = $1', [callerId]);
  await deniedOn(db, 'the service key cannot delete rows (delete is not granted)', 'delete from public.order_reconfirmations where id = $1', [callerId]);
  await identityOn(db);
  pass('the service key updates rows (the worker and droplet stamps) but nobody deletes by hand');

  // ── rows cascade away with their order ──
  const doomedBefore = await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations where order_id = $1', [ORDER.doomed]));
  assert.ok(doomedBefore >= 3);
  await asPostgres(db, () => q(db, 'delete from public.orders where id = $1', [ORDER.doomed]));
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations where order_id = $1', [ORDER.doomed])), 0);
  pass('deleting an order removes its reconfirmation rows (on delete cascade)');

  // ── rollback, twice, then re-apply ──
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await fnCount(db), 0);
  assert.equal(await tableCount(db), 0);
  assert.equal(await columnType(db), undefined);
  assert.equal(await indexExists(db, 'intake_messages_conversation_id_idx'), false);
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select status as value from public.intake_messages where id = $1', [intakeId])), 'pending_review');
  pass('rollback runs twice: function, policy, table and column gone; intake rows themselves untouched');
  await db.exec(migration);
  assert.equal(await fnCount(db), 1);
  assert.equal(await columnType(db), 'text');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations'), 0);
  await identityOn(db);
  const againId = await draft(db, { send_after: null });
  out = await decideAs(db, OWNER, againId, 'send_now');
  assert.equal(out.status, 'released');
  pass('re-apply after rollback starts empty, with the policy and the column back, and decides again');

  // ── preflight guards on an unexpected shape ──
  const guard = await productionShaped();
  handles.push(guard);
  await guard.exec('create table public.order_reconfirmations (id int primary key);');
  await refusesOn(guard, '044 refuses a foreign order_reconfirmations table with the wrong columns', migration, '55000', /refuses an existing public.order_reconfirmations/);
  const guard2 = await productionShaped();
  handles.push(guard2);
  await guard2.exec('alter table public.intake_messages add column conversation_id integer;');
  await refusesOn(guard2, '044 refuses a pre-existing conversation_id that is not text', migration, '55000', /conversation_id of type integer/);
  // A pre-existing table with every column the preflight asks for passes the
  // preflight, and "create ... if not exists" then skips the real index and
  // keeps any policy already there. The postflight must catch both shapes.
  const PRE_EXISTING_TABLE = `
    create table public.order_reconfirmations (
      id bigint generated always as identity primary key,
      order_id uuid not null references public.orders(id) on delete cascade,
      delivery_day date not null, status text not null default 'ready',
      hold_reasons text[] not null default '{}', facts jsonb not null default '{}',
      subject text not null, body text not null, recipients text[] not null default '{}',
      send_after timestamptz, decision text, reply_kind text);`;
  const guard3 = await productionShaped();
  handles.push(guard3);
  await guard3.exec(PRE_EXISTING_TABLE);
  await guard3.exec('create index order_reconfirmations_active_order_day_uidx on public.order_reconfirmations (order_id, delivery_day);');
  await refusesOn(guard3, '044 postflight refuses a plain index squatting on the unique index name (two live rows would be possible)', migration, '55000', /not a unique partial index/);
  const guard4 = await productionShaped();
  handles.push(guard4);
  await guard4.exec(PRE_EXISTING_TABLE);
  await guard4.exec(`
    create unique index order_reconfirmations_active_order_day_uidx
      on public.order_reconfirmations (order_id, delivery_day) where status <> 'superseded';
    alter table public.order_reconfirmations enable row level security;
    create policy order_reconfirmations_open_select on public.order_reconfirmations
      for select to authenticated using (true);`);
  await refusesOn(guard4, '044 postflight refuses a second select policy on the table (a manager phone would read every row)', migration, '55000', /exactly one policy/);

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker scan, the droplet sender, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
