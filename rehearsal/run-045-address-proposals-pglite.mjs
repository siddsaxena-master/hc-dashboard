// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-045-address-proposals-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/045_order_address_proposals.sql (a drop off address
// read out of a customer email, the owner's Accept or Keep from the phone,
// the Jarvis apply state, and the two replay columns on intake_messages)
// and its rollback on the shape production is in on 2026-09-15: the 001-013
// base chain, 015, 015b, 019, 024, 026, 027, 029, 034-038 and 040-044 (015c
// and 030 are live too but refuse to apply on this sandbox, so they are not
// reproduced here). Real migration files are executed as written and never
// rewritten on disk. Every order, email, address and person here is fake.
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
  '044_order_reconfirmations',
];
const [supabaseBootstrap, ordersBaseline, migration, rollback] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/045_order_address_proposals.sql'),
  read('migrations/045_order_address_proposals_rollback.sql'),
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
  // The invoice has a one-line address; the email agrees but Accept should
  // rewrite it in full. delivery_at_utc set, so the day comes from it.
  sheeley: '30000000-0000-4000-8000-000000000001',
  // The invoice ship address differs from the email's.
  differs: '30000000-0000-4000-8000-000000000002',
  // The invoice was not read completely, so the on-file address is the
  // delivery notes (with venue behind it).
  notes: '30000000-0000-4000-8000-000000000003',
  // Nothing on file at all: no invoice address, no notes, no venue.
  blank: '30000000-0000-4000-8000-000000000004',
  // No delivery marker; the day comes from event_start_at.
  eventonly: '30000000-0000-4000-8000-000000000005',
  cancelled: '30000000-0000-4000-8000-000000000006',
  // Deleted at the end to prove the cascade.
  doomed: '30000000-0000-4000-8000-000000000007',
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
insert into public.orders (id, client_name, client_email, venue, delivery_notes, delivery_at_utc, event_start_at, stage, market, coconuts_qty, external_invoice_id, deposit_cents, balance_cents) values
  ('${ORDER.sheeley}', 'Fake Sheeley', 'fake.sheeley@example.invalid', null, null, '2026-09-18T00:00:00Z', '2026-09-18T22:00:00Z', 'paid_full', 'ny', 100, 'FAKE-2049', 0, 0),
  ('${ORDER.differs}', 'Fake Planner', 'fake.planner@example.invalid', 'Fake Beach Club', null, '2026-09-19T00:00:00Z', null, 'deposit_paid', 'ny', 100, 'FAKE-2101', 50000, 50000),
  ('${ORDER.notes}', 'Fake Notes', 'fake.notes@example.invalid', 'Fake Hall', '  1 Fake   Lane, Southampton ', '2026-09-20T00:00:00Z', null, 'deposit_paid', 'ny', 40, 'FAKE-2103', 20000, 20000),
  ('${ORDER.blank}', 'Fake Blank', 'fake.blank@example.invalid', null, null, '2026-09-21T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2104', 0, 30000),
  ('${ORDER.eventonly}', 'Fake Event', 'fake.event@example.invalid', 'Fake Pier', null, null, '2026-09-22T18:00:00Z', 'deposit_paid', 'ny', 30, 'FAKE-2105', 10000, 10000),
  ('${ORDER.cancelled}', 'Fake Cancelled', 'fake.cancelled@example.invalid', 'Fake Pier', null, '2026-09-23T00:00:00Z', null, 'cancelled', 'ny', 30, 'FAKE-2106', 0, 0),
  ('${ORDER.doomed}', 'Fake Cascade', 'fake.cascade@example.invalid', 'Fake Pier', null, '2026-09-24T00:00:00Z', null, 'deposit_paid', 'ny', 30, 'FAKE-2107', 10000, 10000);
insert into public.intake_messages (channel, source_msg_id, from_addr, subject, raw_text, classification, status, order_id, classified_at) values
  ('email', 'fake-pre-045-1', 'fake.sheeley@example.invalid', 'Logo file', 'Please deliver to 491 S Dean Street, Englewood, NJ 07631', 'maybe_order', 'pending_review', '${ORDER.sheeley}', now());`;

// The invoice ship addresses as Jarvis's sync stores them (034's
// invoice_fulfillment). Applied AFTER the chain because 034 adds the column.
const FULFILLMENT = `
update public.orders set invoice_fulfillment = '{"read_status": "complete", "address": "491 S Dean Street, Englewood, NJ 07631", "address_structured": false, "source_updated_at": "2026-09-15T22:31:00Z"}'::jsonb where id = '${ORDER.sheeley}';
update public.orders set invoice_fulfillment = '{"read_status": "complete", "address": "45 Main St, Southampton, NY 11968", "address_structured": true, "source_updated_at": "2026-09-01T12:00:00Z"}'::jsonb where id = '${ORDER.differs}';
update public.orders set invoice_fulfillment = '{"read_status": "partial", "address": "unread"}'::jsonb where id = '${ORDER.notes}';
update public.orders set invoice_fulfillment = '{"read_status": "complete", "address": "1 Fake Lane, Southampton, NY 11968"}'::jsonb where id = '${ORDER.eventonly}';
update public.orders set invoice_fulfillment = '{"read_status": "complete", "address": "2 Fake Lane, Southampton, NY 11968"}'::jsonb where id = '${ORDER.cancelled}';
update public.orders set invoice_fulfillment = '{"read_status": "complete", "address": "3 Fake Lane, Southampton, NY 11968"}'::jsonb where id = '${ORDER.doomed}';`;

const ENGLEWOOD = { line1: '491 S Dean Street', city: 'Englewood', state: 'NJ', postal_code: '07631' };
const ENGLEWOOD_TEXT = '491 S Dean Street, Englewood, NJ 07631';
const BRIDGE = { line1: '12 Ocean Rd', city: 'Bridgehampton', state: 'NY', postal_code: '11932' };
const BRIDGE_TEXT = '12 Ocean Rd, Bridgehampton, NY 11932';
const NO_ZIP = { line1: '7 Further Ln', city: 'Amagansett', state: 'NY' };
const NO_ZIP_TEXT = '7 Further Ln, Amagansett, NY';

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
const DECIDE_SQL = 'select public.hc_decide_proposed_address($1, $2, $3) as value';
async function decideAs(h, who, orderId, intakeId, decision) {
  await identityOn(h, { role: 'authenticated', sub: who.authUserId });
  try { return await scalarOn(h, DECIDE_SQL, [orderId, intakeId, decision]); } finally { await identityOn(h); }
}
// A linked, classified intake email the way Jarvis leaves it for the scan.
let intakeSeq = 0;
async function newIntake(h, orderId, fields = {}) {
  const row = {
    from_addr: 'fake.customer@example.invalid', subject: 'Re: coconuts', raw_text: 'Please deliver to ' + ENGLEWOOD_TEXT,
    status: 'pending_review', conversation_id: null, replayed_at: null, ...fields,
  };
  intakeSeq++;
  return asServiceRole(h, () => scalarOn(h,
    `insert into public.intake_messages (channel, source_msg_id, from_addr, subject, raw_text, classification, status, order_id, classified_at, conversation_id, replayed_at)
     values ('email', $1, $2, $3, $4, 'maybe_order', $5, $6, now(), $7, $8::timestamptz)
     returning id as value`,
    [`fake-045-${intakeSeq}`, row.from_addr, row.subject, row.raw_text, row.status, orderId, row.conversation_id, row.replayed_at]));
}
// The worker's insert, with the service key. Only the named fields vary.
// The snapshot columns default to what the seed orders carry.
const SNAPSHOT = {
  [ORDER.sheeley]: { on_file_address: ENGLEWOOD_TEXT, on_file_source: 'invoice', on_file_structured: false, invoice_id_snapshot: 'FAKE-2049', delivery_day_snapshot: '2026-09-18' },
  [ORDER.differs]: { on_file_address: '45 Main St, Southampton, NY 11968', on_file_source: 'invoice', on_file_structured: true, invoice_id_snapshot: 'FAKE-2101', delivery_day_snapshot: '2026-09-19' },
  [ORDER.notes]: { on_file_address: '1 Fake Lane, Southampton', on_file_source: 'delivery_notes', on_file_structured: null, invoice_id_snapshot: 'FAKE-2103', delivery_day_snapshot: '2026-09-20' },
  [ORDER.blank]: { on_file_address: null, on_file_source: null, on_file_structured: null, invoice_id_snapshot: 'FAKE-2104', delivery_day_snapshot: '2026-09-21' },
  [ORDER.eventonly]: { on_file_address: '1 Fake Lane, Southampton, NY 11968', on_file_source: 'invoice', on_file_structured: null, invoice_id_snapshot: 'FAKE-2105', delivery_day_snapshot: '2026-09-22' },
  [ORDER.cancelled]: { on_file_address: '2 Fake Lane, Southampton, NY 11968', on_file_source: 'invoice', on_file_structured: null, invoice_id_snapshot: 'FAKE-2106', delivery_day_snapshot: '2026-09-23' },
  [ORDER.doomed]: { on_file_address: '3 Fake Lane, Southampton, NY 11968', on_file_source: 'invoice', on_file_structured: null, invoice_id_snapshot: 'FAKE-2107', delivery_day_snapshot: '2026-09-24' },
};
async function propose(h, intakeId, orderId, fields = {}) {
  const row = {
    proposed_address: ENGLEWOOD, proposed_text: ENGLEWOOD_TEXT,
    evidence_line: 'Please deliver to 491 S Dean Street, Englewood, NJ 07631', evidence_where: 'body',
    on_file_newer: false, found_at: null, ...SNAPSHOT[orderId], ...fields,
  };
  await asServiceRole(h, () => q(h,
    `insert into public.order_address_proposals
       (intake_id, order_id, proposed_address, proposed_text, evidence_line, evidence_where, on_file_address, on_file_source, on_file_structured, on_file_newer, invoice_id_snapshot, delivery_day_snapshot, found_at)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, coalesce($13::timestamptz, now()))`,
    [intakeId, orderId, JSON.stringify(row.proposed_address), row.proposed_text, row.evidence_line, row.evidence_where,
      row.on_file_address, row.on_file_source, row.on_file_structured, row.on_file_newer, row.invoice_id_snapshot, row.delivery_day_snapshot, row.found_at]));
  return intakeId;
}
// A pending row proposed and accepted by the owner in one go.
async function accepted(h, orderId, intakeFields = {}) {
  const id = await propose(h, await newIntake(h, orderId, intakeFields), orderId);
  const out = await decideAs(h, OWNER, orderId, id, 'accept');
  assert.equal(out.applied, true, 'the setup accept must apply');
  return id;
}
// The reconfirmation scan's insert (044) of a held draft, with the service
// key: the hold reason list is what 045 widens.
let heldSeq = 0;
async function heldReconfirmation(h, orderId, reasons) {
  heldSeq++;
  // One live row per order and day (044's unique index), so each held row
  // takes its own day, far from the seed orders' real days.
  const day = '2027-01-' + String(heldSeq).padStart(2, '0');
  return asServiceRole(h, () => scalarOn(h,
    `insert into public.order_reconfirmations (order_id, delivery_day, status, hold_reasons, subject, body)
     values ($1, $2::date, 'held', $3::text[], 'Your coconuts: quick reconfirm', 'Hi, one quick read through.')
     returning id as value`,
    [orderId, day, reasons]));
}
const holdCheckDef = h => scalarOn(h,
  "select pg_get_constraintdef(c.oid) as value from pg_constraint as c where c.conrelid = 'public.order_reconfirmations'::regclass and c.conname = 'order_reconfirmations_hold_reasons_check'");
const rowOf = (h, intakeId) => asPostgres(h, async () => (await rowsOn(h,
  `select intake_id, order_id, proposed_address, proposed_text, evidence_line, evidence_where, on_file_address, on_file_source, on_file_structured, on_file_newer,
          invoice_id_snapshot, delivery_day_snapshot::text as delivery_day_snapshot, found_at, status, decided_at, decided_by, decided_via,
          apply_status, apply_after, apply_claimed_at, apply_attempts, applied_at, apply_note, invoice_doc_number, total_moved, tax_zero, error_detail, notified_at, updated_at
     from public.order_address_proposals where intake_id = $1`, [intakeId]))[0]);
const intakeOf = (h, intakeId) => asPostgres(h, async () => (await rowsOn(h,
  'select id, status, reviewed_at, error_detail, replayed_at, address_scanned_at from public.intake_messages where id = $1', [intakeId]))[0]);
const orderOf = (h, orderId) => asPostgres(h, async () => (await rowsOn(h,
  'select to_jsonb(o) as value from public.orders as o where o.id = $1', [orderId]))[0].value);
const setApply = (h, intakeId, applyStatus, extra = {}) => asServiceRole(h, () => q(h,
  `update public.order_address_proposals
      set apply_status = $2, error_detail = coalesce($3, error_detail), applied_at = coalesce($4::timestamptz, applied_at), apply_claimed_at = coalesce($5::timestamptz, apply_claimed_at)
    where intake_id = $1`,
  [intakeId, applyStatus, extra.error_detail ?? null, extra.applied_at ?? null, extra.apply_claimed_at ?? null]));
const setOrder = (h, orderId, sql, params = []) => asPostgres(h, () => q(h, `update public.orders set ${sql} where id = $1`, [orderId, ...params]));
const fnCount = h => scalarOn(h, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_decide_proposed_address'");
const tableCount = h => scalarOn(h, "select count(*)::int as value from pg_class where relnamespace = 'public'::regnamespace and relname = 'order_address_proposals'");
const columnType = (h, column) => scalarOn(h,
  'select format_type(atttypid, atttypmod) as value from pg_attribute where attrelid = $1::regclass and attname = $2 and attnum > 0 and not attisdropped',
  ['public.intake_messages', column]);
const indexExists = (h, name) => scalarOn(h, 'select to_regclass($1) is not null as value', [`public.${name}`]);
const seconds = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);

async function productionShaped(options = {}) {
  const { skip = [] } = options;
  const h = await PGlite.create({ extensions: { pgcrypto } });
  await h.exec(supabaseBootstrap);
  await h.exec(STORAGE_STUB);
  await h.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await h.exec(baseFiles[name]);
  await h.exec(SEED);
  for (const name of APPLIED_CHAIN) if (!skip.includes(name)) await h.exec(baseFiles[name]);
  await h.exec(FULFILLMENT);
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
  const timeRowsBefore = await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_time_proposals'));

  // ── before 045: 044's hold_reasons check refuses the new reason ──
  // The worker's reconfirmation scan writes hold_reasons on every insert
  // and rewrite. With 044's list alone, a draft held on a waiting Address?
  // row would fail the check and the hold would never land.
  const def044 = await holdCheckDef(db);
  assert.ok(def044 && def044.includes('pending_time_proposal') && !def044.includes('pending_address_proposal'), def044);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'before 045, a draft held with pending_address_proposal is refused by 044\'s check (23514)',
    "insert into public.order_reconfirmations (order_id, delivery_day, status, hold_reasons, subject, body) values ($1, '2027-06-01'::date, 'held', $2::text[], 'x', 'y')",
    [ORDER.sheeley, ['pending_address_proposal']], '23514', /hold_reasons_check/);
  await identityOn(db);
  const held044Id = await heldReconfirmation(db, ORDER.sheeley, ['count_missing', 'pending_time_proposal']);
  assert.ok(held044Id > 0);

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await fnCount(db), 1);
  assert.equal(await tableCount(db), 1);
  assert.equal(await indexExists(db, 'order_address_proposals_order_status_idx'), true);
  assert.equal(await indexExists(db, 'order_address_proposals_apply_idx'), true);
  pass('045 applies twice on the production-shaped chain (001-013, 015, 015b, 019, 024, 026, 027, 029, 034-038, 040-044)');

  // ── the widened hold_reasons check ──
  const def045 = await holdCheckDef(db);
  assert.ok(def045.includes('pending_address_proposal') && def045.includes('pending_time_proposal'), def045);
  for (const word of ['count_missing', 'address_missing', 'cracking_unknown', 'pending_time_proposal', 'no_email', 'billing_email_only', 'too_many_emails', 'date_unverified', 'owner_hold']) {
    assert.ok(def045.includes("'" + word + "'"), '044 word kept: ' + word);
  }
  const heldAddrId = await heldReconfirmation(db, ORDER.sheeley, ['pending_address_proposal']);
  const heldBothId = await heldReconfirmation(db, ORDER.differs, ['count_missing', 'pending_time_proposal', 'pending_address_proposal']);
  assert.ok(heldAddrId > 0 && heldBothId > heldAddrId);
  assert.deepEqual(await asPostgres(db, () => scalarOn(db, 'select hold_reasons as value from public.order_reconfirmations where id = $1', [heldBothId])),
    ['count_missing', 'pending_time_proposal', 'pending_address_proposal']);
  // The worker's rewrite of an existing row (the PATCH on status in ready,held).
  await asServiceRole(db, () => q(db, "update public.order_reconfirmations set hold_reasons = $2::text[] where id = $1 and status in ('ready', 'held')", [held044Id, ['pending_address_proposal']]));
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'after 045, an unknown hold reason is still refused', 'update public.order_reconfirmations set hold_reasons = $2::text[] where id = $1', [held044Id, ['logo_missing']], '23514', /hold_reasons_check/);
  await identityOn(db);
  pass('045 widens 044\'s hold_reasons check by exactly one word: a draft held with pending_address_proposal inserts and rewrites, every 044 reason still passes, an unknown reason still fails');

  // ── the two intake columns ──
  assert.equal(await columnType(db, 'replayed_at'), 'timestamp with time zone');
  assert.equal(await columnType(db, 'address_scanned_at'), 'timestamp with time zone');
  const preRow = await asPostgres(db, async () => (await rowsOn(db,
    "select id, replayed_at, address_scanned_at, status from public.intake_messages where source_msg_id = 'fake-pre-045-1'"))[0]);
  assert.equal(preRow.replayed_at, null);
  assert.equal(preRow.address_scanned_at, null);
  assert.equal(preRow.status, 'pending_review');
  const replayedId = await newIntake(db, ORDER.sheeley, { replayed_at: '2026-09-16T13:00:00Z' });
  let intakeRow = await intakeOf(db, replayedId);
  assert.equal(seconds(intakeRow.replayed_at, '2026-09-16T13:00:00Z'), 0);
  assert.equal(intakeRow.address_scanned_at, null);
  await asServiceRole(db, () => q(db, 'update public.intake_messages set address_scanned_at = now() where id = $1', [replayedId]));
  intakeRow = await intakeOf(db, replayedId);
  assert.ok(seconds(intakeRow.address_scanned_at, Date.now()) < 60);
  assert.equal(await asServiceRole(db, () => scalarOn(db,
    'select count(*)::int as value from public.intake_messages where replayed_at is null')), 1 + 0, 'the pre-045 row is the only live row so far');
  assert.equal(await asServiceRole(db, () => scalarOn(db,
    'select count(*)::int as value from public.intake_messages where replayed_at is not null')), 1);
  pass('intake_messages.replayed_at and address_scanned_at are nullable timestamptz columns; old rows read null, the replay and the worker stamp them, and replayed_at=is.null tells live rows apart');

  // ── the worker's insert and its defaults ──
  const pendingId = await propose(db, await newIntake(db, ORDER.sheeley), ORDER.sheeley);
  let row = await rowOf(db, pendingId);
  assert.equal(row.status, 'pending');
  assert.equal(row.apply_status, null);
  assert.equal(row.apply_attempts, 0);
  assert.equal(row.on_file_newer, false);
  assert.equal(row.total_moved, false);
  assert.equal(row.tax_zero, false);
  assert.equal(row.decided_via, null);
  assert.equal(row.notified_at, null);
  assert.deepEqual(row.proposed_address, ENGLEWOOD);
  assert.equal(row.proposed_text, ENGLEWOOD_TEXT);
  assert.equal(row.on_file_source, 'invoice');
  assert.equal(row.on_file_structured, false);
  assert.equal(row.invoice_id_snapshot, 'FAKE-2049');
  assert.equal(row.delivery_day_snapshot, '2026-09-18');
  assert.ok(seconds(row.found_at, Date.now()) < 60);
  pass('the service key inserts a proposal; defaults are status pending, no apply state, 0 attempts, flags false');

  // ── column checks the worker and Jarvis lean on ──
  await identityOn(db, { role: 'service_role' });
  const setAddr = 'update public.order_address_proposals set proposed_address = $2::jsonb where intake_id = $1';
  await deniedOn(db, 'an address that is not an object is refused', setAddr, [pendingId, JSON.stringify([ENGLEWOOD_TEXT])], '23514');
  await deniedOn(db, 'an address with a blank line1 is refused', setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, line1: '  ' })], '23514');
  await deniedOn(db, 'an address with no city is refused', setAddr, [pendingId, JSON.stringify({ line1: '491 S Dean Street', state: 'NJ', postal_code: '07631' })], '23514');
  await deniedOn(db, 'a lower-case or full-name state is refused', setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, state: 'nj' })], '23514');
  await deniedOn(db, 'a ZIP that is not five digits is refused', setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, postal_code: '0763' })], '23514');
  await deniedOn(db, 'a ZIP+4 is refused (the worker stores the five digits)', setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, postal_code: '07631-1234' })], '23514');
  await q(db, setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, postal_code: null })]);
  await q(db, setAddr, [pendingId, JSON.stringify(NO_ZIP)]);
  await q(db, setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, line2: 'Apt 2' })]);
  // The two worker-only hints (the state assumed from a town name and
  // geocode-confirmed) pass the check; the phone prints them, Jarvis ignores them.
  await q(db, setAddr, [pendingId, JSON.stringify({ ...ENGLEWOOD, state_inferred: true, state_from: 'Englewood' })]);
  await q(db, setAddr, [pendingId, JSON.stringify(ENGLEWOOD)]);
  pass('a missing ZIP (absent or JSON null) and an optional line2 are accepted');
  const setText = 'update public.order_address_proposals set proposed_text = $2 where intake_id = $1';
  await deniedOn(db, 'an empty proposed_text is refused', setText, [pendingId, ''], '23514');
  await deniedOn(db, 'a proposed_text over 200 characters is refused', setText, [pendingId, 'x'.repeat(201)], '23514');
  await deniedOn(db, 'a proposed_text with a control character is refused', setText, [pendingId, 'line one\nline two'], '23514');
  await deniedOn(db, 'an unknown status is refused', 'update public.order_address_proposals set status = $2 where intake_id = $1', [pendingId, 'maybe'], '23514');
  await deniedOn(db, 'an unknown decided_via is refused', 'update public.order_address_proposals set decided_via = $2 where intake_id = $1', [pendingId, 'telegram'], '23514');
  await deniedOn(db, 'an unknown on_file_source is refused', 'update public.order_address_proposals set on_file_source = $2 where intake_id = $1', [pendingId, 'email'], '23514');
  await deniedOn(db, 'an evidence_line over 200 characters is refused', 'update public.order_address_proposals set evidence_line = $2 where intake_id = $1', [pendingId, 'x'.repeat(201)], '23514');
  await deniedOn(db, 'an on_file_address over 400 characters is refused', 'update public.order_address_proposals set on_file_address = $2 where intake_id = $1', [pendingId, 'x'.repeat(401)], '23514');
  await deniedOn(db, 'an apply_note over 300 characters is refused', 'update public.order_address_proposals set apply_note = $2 where intake_id = $1', [pendingId, 'x'.repeat(301)], '23514');
  await deniedOn(db, 'an invoice_doc_number over 40 characters is refused', 'update public.order_address_proposals set invoice_doc_number = $2 where intake_id = $1', [pendingId, 'x'.repeat(41)], '23514');
  await deniedOn(db, 'an error_detail over 300 characters is refused', 'update public.order_address_proposals set error_detail = $2 where intake_id = $1', [pendingId, 'x'.repeat(301)], '23514');

  // ── the accepted/apply_status check constraint ──
  const setState = 'update public.order_address_proposals set status = $2, apply_status = $3 where intake_id = $1';
  await deniedOn(db, 'a pending row cannot carry an apply_status', setState, [pendingId, 'pending', 'queued'], '23514', /accepted_apply_check/);
  await deniedOn(db, 'an accepted row must carry an apply_status', setState, [pendingId, 'accepted', null], '23514', /accepted_apply_check/);
  await deniedOn(db, 'an unknown apply_status is refused', setState, [pendingId, 'accepted', 'done'], '23514');
  await q(db, setState, [pendingId, 'accepted', 'queued']);
  await deniedOn(db, 'a kept row cannot keep its apply_status (Dismiss must null it)', setState, [pendingId, 'kept', 'failed'], '23514', /accepted_apply_check/);
  await deniedOn(db, 'a superseded row cannot keep its apply_status (every retirement must null it)', 'update public.order_address_proposals set status = $2 where intake_id = $1', [pendingId, 'superseded'], '23514', /accepted_apply_check/);
  await q(db, setState, [pendingId, 'superseded', null]);
  await q(db, setState, [pendingId, 'pending', null]);
  await identityOn(db);
  pass('the check constraint holds: status accepted if and only if apply_status is set; a retirement that nulls apply_status passes');

  // ── owner accepts: queued for Jarvis, nothing else written anywhere ──
  const orderBefore = await orderOf(db, ORDER.sheeley);
  let out = await decideAs(db, OWNER, ORDER.sheeley, pendingId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  assert.equal(out.row.intake_id, pendingId);
  assert.equal(out.row.status, 'accepted');
  assert.equal(out.row.apply_status, 'queued');
  row = await rowOf(db, pendingId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.apply_status, 'queued');
  assert.ok(seconds(row.apply_after, Date.now()) < 60, 'apply_after is now');
  assert.equal(row.apply_attempts, 0);
  assert.equal(row.apply_claimed_at, null);
  assert.equal(row.applied_at, null);
  assert.equal(row.decided_via, 'app');
  assert.equal(row.decided_by, OWNER.authUserId);
  assert.ok(seconds(row.decided_at, Date.now()) < 60);
  assert.ok(new Date(row.updated_at).getTime() >= new Date(row.found_at).getTime());
  intakeRow = await intakeOf(db, pendingId);
  assert.equal(intakeRow.status, 'dismissed');
  assert.ok(intakeRow.reviewed_at);
  assert.equal(intakeRow.error_detail, 'address proposal accepted by the owner in HC Field');
  assert.deepEqual(await orderOf(db, ORDER.sheeley), orderBefore, 'the order row is byte for byte untouched');
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_time_proposals')), timeRowsBefore);
  pass('owner accepts: status accepted, apply_status queued, apply_after now, decided_via app; the intake row is dismissed; orders and order_time_proposals untouched');

  // A row carrying the worker-only hints accepts the same way.
  const inferredId = await propose(db, await newIntake(db, ORDER.sheeley), ORDER.sheeley, { proposed_address: { ...ENGLEWOOD, state_inferred: true, state_from: 'Englewood' } });
  out = await decideAs(db, OWNER, ORDER.sheeley, inferredId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  row = await rowOf(db, inferredId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.apply_status, 'queued');
  assert.deepEqual(row.proposed_address, { ...ENGLEWOOD, state_inferred: true, state_from: 'Englewood' });
  pass('a proposal whose state was assumed from a town (state_inferred, state_from) accepts as accepted/queued with the hints kept');
  row = await rowOf(db, pendingId);

  // ── double tap ──
  out = await decideAs(db, OWNER, ORDER.sheeley, pendingId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'accepted');
  assert.equal(out.message, 'Already decided.');
  assert.ok(out.decided_at);
  out = await decideAs(db, OWNER, ORDER.sheeley, pendingId, 'keep');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'accepted');
  assert.equal(out.message, 'Already decided.');
  assert.deepEqual(await rowOf(db, pendingId), row, 'a second tap rewrites nothing');
  pass('a second accept, or a keep after an accept, answers Already decided and rewrites nothing');

  // ── Jarvis at work: applying and applied rows are also already decided ──
  await setApply(db, pendingId, 'applying', { apply_claimed_at: new Date().toISOString() });
  out = await decideAs(db, OWNER, ORDER.sheeley, pendingId, 'keep');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'accepted');
  assert.equal(out.message, 'Already decided.');
  await setApply(db, pendingId, 'applied', { applied_at: new Date().toISOString() });
  await asServiceRole(db, () => q(db,
    "update public.order_address_proposals set apply_note = $2, invoice_doc_number = $3, total_moved = true, tax_zero = false, notified_at = now() where intake_id = $1",
    [pendingId, 'Invoice #2049: tax 92.19 to 68.75, total 1342.19 to 1318.75', '2049']));
  out = await decideAs(db, OWNER, ORDER.sheeley, pendingId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'accepted');
  row = await rowOf(db, pendingId);
  assert.equal(row.apply_status, 'applied');
  assert.equal(row.invoice_doc_number, '2049');
  assert.equal(row.total_moved, true);
  pass('a row Jarvis is applying or has applied stays accepted; a tap answers Already decided and the apply stamps survive');

  // ── owner keeps ──
  const keptId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  const differsBefore = await orderOf(db, ORDER.differs);
  out = await decideAs(db, OWNER, ORDER.differs, keptId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  row = await rowOf(db, keptId);
  assert.equal(row.status, 'kept');
  assert.equal(row.apply_status, null);
  assert.equal(row.apply_after, null);
  assert.equal(row.decided_via, 'app');
  assert.equal(row.decided_by, OWNER.authUserId);
  intakeRow = await intakeOf(db, keptId);
  assert.equal(intakeRow.status, 'dismissed');
  assert.equal(intakeRow.error_detail, 'address proposal kept by the owner in HC Field');
  assert.deepEqual(await orderOf(db, ORDER.differs), differsBefore);
  pass('owner keeps: status kept, no apply state, the intake row is dismissed, the order byte for byte untouched');
  out = await decideAs(db, OWNER, ORDER.differs, keptId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'kept');
  assert.equal(out.message, 'Already decided.');
  pass('accept after a keep answers Already decided');

  // ── who may call ──
  const callerId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  await deniedOn(db, 'a manager cannot decide a proposed address', DECIDE_SQL, [ORDER.differs, callerId, 'accept'], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  await deniedOn(db, 'a team member cannot decide a proposed address', DECIDE_SQL, [ORDER.differs, callerId, 'accept'], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated', sub: STALE.authUserId });
  await deniedOn(db, 'an inactive login cannot decide a proposed address', DECIDE_SQL, [ORDER.differs, callerId, 'accept'], '42501', /only the owner/);
  await identityOn(db, { role: 'authenticated' });
  await deniedOn(db, 'a login with no auth uid is refused', DECIDE_SQL, [ORDER.differs, callerId, 'accept'], '42501', /authenticated field worker required/);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot even call the function', DECIDE_SQL, [ORDER.differs, callerId, 'accept'], '42501', /permission denied for function/);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the service key cannot call the function (execute revoked)', DECIDE_SQL, [ORDER.differs, callerId, 'accept'], '42501', /permission denied for function/);
  await identityOn(db);
  row = await rowOf(db, callerId);
  assert.equal(row.status, 'pending');
  assert.equal((await intakeOf(db, callerId)).status, 'pending_review');
  pass('refused callers never touch the proposal or the intake row');

  // ── malformed calls ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'a decision must be accept or keep', DECIDE_SQL, [ORDER.differs, callerId, 'maybe'], '22023', /must be accept or keep/);
  await deniedOn(db, 'an empty decision is refused', DECIDE_SQL, [ORDER.differs, callerId, ''], '22023', /must be accept or keep/);
  await deniedOn(db, 'a null order id is refused', DECIDE_SQL, [null, callerId, 'accept'], '22023', /order id and an intake id/);
  await deniedOn(db, 'a null intake id is refused', DECIDE_SQL, [ORDER.differs, null, 'accept'], '22023', /order id and an intake id/);
  await deniedOn(db, 'a proposal on another order is a clear 22023', DECIDE_SQL, [ORDER.sheeley, callerId, 'accept'], '22023', /No such proposal/);
  await deniedOn(db, 'an unknown intake id is a clear 22023', DECIDE_SQL, [ORDER.differs, 987654321, 'accept'], '22023', /No such proposal/);
  await identityOn(db);
  assert.equal((await rowOf(db, callerId)).status, 'pending');
  out = await decideAs(db, OWNER, ORDER.differs, callerId, '  Keep ');
  assert.equal(out.outcome, 'kept');
  pass('malformed calls raise 22023 and change nothing; the decision word is trimmed and lower-cased');

  // ── accept with no ZIP is refused, the row untouched ──
  const noZipId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: NO_ZIP, proposed_text: NO_ZIP_TEXT });
  const noZipBefore = await rowOf(db, noZipId);
  out = await decideAs(db, OWNER, ORDER.differs, noZipId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'refused');
  assert.equal(out.message, 'No ZIP on this address. Put it on the invoice in the Jarvis chat, then Dismiss.');
  assert.deepEqual(await rowOf(db, noZipId), noZipBefore, 'the row is untouched');
  assert.equal((await intakeOf(db, noZipId)).status, 'pending_review');
  pass('accept on a row with no ZIP: applied false, outcome refused, the row and the intake left exactly as they were');
  out = await decideAs(db, OWNER, ORDER.differs, noZipId, 'accept');
  assert.equal(out.outcome, 'refused');
  out = await decideAs(db, OWNER, ORDER.differs, noZipId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  assert.equal((await intakeOf(db, noZipId)).status, 'dismissed');
  pass('a refused accept can be retried and Dismiss (keep) still works on the same row');

  // ── the invoice on the order changed ──
  const invoiceId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.differs, 'external_invoice_id = $2', ['FAKE-2101-REISSUED']);
  out = await decideAs(db, OWNER, ORDER.differs, invoiceId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'superseded');
  assert.equal(out.message, 'The invoice on this order changed after this email. Set the address through Jarvis.');
  row = await rowOf(db, invoiceId);
  assert.equal(row.status, 'superseded');
  assert.equal(row.decided_via, 'invoice_changed');
  assert.equal(row.apply_status, null);
  assert.equal(row.decided_by, OWNER.authUserId);
  assert.equal((await intakeOf(db, invoiceId)).status, 'pending_review', 'the intake row is left for Sidd');
  pass('the invoice changed after the email: superseded / invoice_changed, nothing queued, the intake row left for Sidd');
  const invoiceKeepId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  out = await decideAs(db, OWNER, ORDER.differs, invoiceKeepId, 'keep');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, invoiceKeepId)).decided_via, 'invoice_changed');
  pass('keep on such a row is superseded the same way (the checks run before the decision)');
  const invoiceNullId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT, invoice_id_snapshot: null });
  out = await decideAs(db, OWNER, ORDER.differs, invoiceNullId, 'accept');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, invoiceNullId)).decided_via, 'invoice_changed');
  pass('a null invoice snapshot against an invoiced order counts as changed (is distinct from)');
  await setOrder(db, ORDER.differs, 'external_invoice_id = $2', ['FAKE-2101']);

  // ── the delivery date moved ──
  const dateId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.differs, 'delivery_at_utc = $2::timestamptz', ['2026-09-26T00:00:00Z']);
  out = await decideAs(db, OWNER, ORDER.differs, dateId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'superseded');
  assert.equal(out.message, 'The delivery date moved after this email arrived. Set the address through Jarvis.');
  row = await rowOf(db, dateId);
  assert.equal(row.status, 'superseded');
  assert.equal(row.decided_via, 'date_moved');
  assert.equal((await intakeOf(db, dateId)).status, 'pending_review');
  pass('the delivery date moved after the email: superseded / date_moved, the intake row left for Sidd');
  await setOrder(db, ORDER.differs, 'delivery_at_utc = $2::timestamptz', ['2026-09-19T00:00:00Z']);
  const dayNullId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT, delivery_day_snapshot: null });
  out = await decideAs(db, OWNER, ORDER.differs, dayNullId, 'accept');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, dayNullId)).decided_via, 'date_moved');
  pass('a null day snapshot against a dated order counts as moved');
  // The day is read the way 038 reads it: the UTC date of the delivery
  // marker, else of the event start. A late-evening UTC event start still
  // lands on its UTC calendar day whatever the session timezone.
  const eventId = await propose(db, await newIntake(db, ORDER.eventonly), ORDER.eventonly);
  out = await decideAs(db, OWNER, ORDER.eventonly, eventId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  pass('an order with no delivery marker takes its day from event_start_at (UTC calendar date) and accepts');
  const eventMovedId = await propose(db, await newIntake(db, ORDER.eventonly), ORDER.eventonly, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.eventonly, 'event_start_at = $2::timestamptz', ['2026-09-23T02:00:00Z']);
  out = await decideAs(db, OWNER, ORDER.eventonly, eventMovedId, 'accept');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, eventMovedId)).decided_via, 'date_moved');
  pass('an event start that crosses into the next UTC day counts as moved');

  // ── the on-file address moved (owner_edit) ──
  const movedId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.differs, "invoice_fulfillment = invoice_fulfillment || '{\"address\": \"46 Main St, Southampton, NY 11968\"}'::jsonb");
  out = await decideAs(db, OWNER, ORDER.differs, movedId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'superseded');
  assert.equal(out.message, 'The invoice address changed after this email arrived. Open the Calendar.');
  row = await rowOf(db, movedId);
  assert.equal(row.status, 'superseded');
  assert.equal(row.decided_via, 'owner_edit');
  assert.equal(row.apply_status, null);
  assert.equal((await intakeOf(db, movedId)).status, 'pending_review');
  pass('the invoice ship address moved after the email: superseded / owner_edit, the intake row left for Sidd');
  // Whitespace and case never count as a move (collapseSpaces + lower).
  const spacedId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.differs, "invoice_fulfillment = invoice_fulfillment || '{\"address\": \"  45  main St,\\n Southampton,   NY 11968 \"}'::jsonb");
  out = await decideAs(db, OWNER, ORDER.differs, spacedId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  pass('runs of whitespace, newlines and letter case on the invoice address are not a move');
  // A snapshot the worker stored with a stray space still matches after
  // both sides collapse.
  const snapSpacedId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT, on_file_address: '45 Main  St, Southampton, NY 11968 ' });
  out = await decideAs(db, OWNER, ORDER.differs, snapSpacedId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  pass('the stored snapshot is collapsed the same way before the compare');
  // A no-break space (U+00A0, pasted from an HTML email into QuickBooks) or
  // a narrow no-break space (U+202F) on the invoice address: the worker's
  // collapseSpaces folds them (JavaScript's \s), so the snapshot was
  // stored with plain spaces; the function folds them the same way, or
  // every tap would answer 'The invoice address changed'.
  const nbspId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.differs, "invoice_fulfillment = invoice_fulfillment || jsonb_build_object('address', $2::text)", ['45 Main\u00a0St, Southampton,\u202fNY 11968']);
  out = await decideAs(db, OWNER, ORDER.differs, nbspId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  pass('a no-break space on the invoice address is not a move (Unicode spaces fold to plain spaces on both sides)');
  // And the other way round: a snapshot the worker could only have stored
  // with plain spaces against the same invoice text is not a move either.
  const nbspSnapId = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT, on_file_address: '45 Main St, Southampton, NY 11968' });
  out = await decideAs(db, OWNER, ORDER.differs, nbspSnapId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  pass('the same no-break-space invoice text against a plain-space snapshot keeps');
  await setOrder(db, ORDER.differs, "invoice_fulfillment = invoice_fulfillment || '{\"address\": \"45 Main St, Southampton, NY 11968\"}'::jsonb");
  // The precedence: an invoice not read completely is skipped, the delivery
  // notes count, the venue only when the notes are blank.
  const notesId = await propose(db, await newIntake(db, ORDER.notes), ORDER.notes);
  await setOrder(db, ORDER.notes, 'venue = $2', ['Fake Other Hall']);
  await setOrder(db, ORDER.notes, "invoice_fulfillment = invoice_fulfillment || '{\"address\": \"9 Unread St, Nowhere, NY 00000\"}'::jsonb");
  out = await decideAs(db, OWNER, ORDER.notes, notesId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  pass('with the invoice not read completely, the delivery notes are the address on file: a changed venue or unread invoice text is not a move');
  const notesMovedId = await propose(db, await newIntake(db, ORDER.notes), ORDER.notes, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.notes, 'delivery_notes = $2', ['2 Fake Lane, Southampton']);
  out = await decideAs(db, OWNER, ORDER.notes, notesMovedId, 'accept');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, notesMovedId)).decided_via, 'owner_edit');
  pass('changed delivery notes are a move when they are the address on file');
  await setOrder(db, ORDER.notes, 'delivery_notes = $2', ['1 Fake Lane, Southampton']);
  const notesFlipId = await propose(db, await newIntake(db, ORDER.notes), ORDER.notes, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.notes, "invoice_fulfillment = '{\"read_status\": \"complete\", \"address\": \"1 Fake Lane, Southampton, NY 11968\"}'::jsonb");
  out = await decideAs(db, OWNER, ORDER.notes, notesFlipId, 'accept');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, notesFlipId)).decided_via, 'owner_edit');
  pass('an invoice read completely after the scan takes precedence over the notes, so that is a move too');
  await setOrder(db, ORDER.notes, "invoice_fulfillment = '{\"read_status\": \"partial\", \"address\": \"unread\"}'::jsonb");
  // Blank on file: a blank or whitespace-only invoice address is skipped the
  // way collapseSpaces skips it, so nothing on file matches a null snapshot.
  const blankId = await propose(db, await newIntake(db, ORDER.blank), ORDER.blank);
  await setOrder(db, ORDER.blank, "invoice_fulfillment = '{\"read_status\": \"complete\", \"address\": \"   \"}'::jsonb, delivery_notes = $2, venue = $3", ['  ', '']);
  out = await decideAs(db, OWNER, ORDER.blank, blankId, 'accept');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'accepted');
  pass('nothing on file (null, blank or whitespace-only everywhere) matches a null snapshot and accepts');
  const blankMovedId = await propose(db, await newIntake(db, ORDER.blank), ORDER.blank, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  await setOrder(db, ORDER.blank, 'venue = $2', ['Fake Pier, Sag Harbor, NY']);
  out = await decideAs(db, OWNER, ORDER.blank, blankMovedId, 'accept');
  assert.equal(out.outcome, 'superseded');
  assert.equal((await rowOf(db, blankMovedId)).decided_via, 'owner_edit');
  pass('an address that appeared on file after a blank scan (even only a venue) is a move');
  await setOrder(db, ORDER.blank, 'venue = null, delivery_notes = null, invoice_fulfillment = null');

  // ── the order of the checks: cancelled first ──
  const cancelledId = await propose(db, await newIntake(db, ORDER.cancelled), ORDER.cancelled);
  await setOrder(db, ORDER.cancelled, 'external_invoice_id = $2', ['FAKE-2106-REISSUED']);
  out = await decideAs(db, OWNER, ORDER.cancelled, cancelledId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'cancelled');
  assert.equal(out.message, 'This order is cancelled.');
  row = await rowOf(db, cancelledId);
  assert.equal(row.status, 'superseded');
  assert.equal(row.decided_via, 'cancelled');
  assert.equal(row.apply_status, null);
  assert.equal((await intakeOf(db, cancelledId)).status, 'pending_review');
  pass('a cancelled order: reported as cancelled (before any other check), superseded / cancelled, nothing queued');

  // ── a failed apply: Accept is reported, Keep is the Dismiss button ──
  const failedId = await accepted(db, ORDER.differs);
  await setApply(db, failedId, 'failed', { error_detail: 'QuickBooks said: Stale Object Error, the invoice was edited elsewhere' });
  row = await rowOf(db, failedId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.apply_status, 'failed');
  out = await decideAs(db, OWNER, ORDER.differs, failedId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.message, 'QuickBooks refused this one. Put the address on the invoice in the Jarvis chat.');
  assert.deepEqual(await rowOf(db, failedId), row, 'accept on a failed row rewrites nothing');
  pass('accept on a failed row: applied false, outcome failed, the row untouched');
  out = await decideAs(db, OWNER, ORDER.differs, failedId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  row = await rowOf(db, failedId);
  assert.equal(row.status, 'kept');
  assert.equal(row.apply_status, null);
  assert.equal(row.decided_via, 'app');
  assert.equal(row.decided_by, OWNER.authUserId);
  assert.ok(seconds(row.decided_at, Date.now()) < 60);
  assert.equal(row.error_detail, 'QuickBooks said: Stale Object Error, the invoice was edited elsewhere', 'error_detail keeps the reason');
  assert.equal((await intakeOf(db, failedId)).status, 'dismissed');
  assert.equal((await intakeOf(db, failedId)).error_detail, 'address proposal accepted by the owner in HC Field', 'the intake row was already dismissed by the accept; the guarded update is a no-op');
  pass('Dismiss (keep) on a failed row: status kept, apply_status nulled, error_detail kept, the intake dismissal a guarded no-op');
  out = await decideAs(db, OWNER, ORDER.differs, failedId, 'keep');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'kept');
  assert.equal(out.message, 'Already decided.');
  pass('a second Dismiss answers Already decided');
  // A failed row on an order that has since changed still dismisses: the
  // failed branch runs before the order checks, so Sidd is never stuck.
  const failedMovedId = await accepted(db, ORDER.differs);
  await setApply(db, failedMovedId, 'failed', { error_detail: 'QuickBooks said: missing ZIP' });
  await setOrder(db, ORDER.differs, 'external_invoice_id = $2', ['FAKE-2101-AGAIN']);
  out = await decideAs(db, OWNER, ORDER.differs, failedMovedId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  assert.equal((await rowOf(db, failedMovedId)).apply_status, null);
  await setOrder(db, ORDER.differs, 'external_invoice_id = $2', ['FAKE-2101']);
  pass('Dismiss on a failed row works even after the invoice changed (the failed branch runs first)');

  // ── the worker's insert never overwrites a decided row ──
  await asServiceRole(db, () => q(db,
    `insert into public.order_address_proposals (intake_id, order_id, proposed_address, proposed_text, invoice_id_snapshot, delivery_day_snapshot)
     values ($1, $2, $3::jsonb, $4, 'FAKE-2049', '2026-09-18'::date) on conflict (intake_id) do nothing`,
    [pendingId, ORDER.sheeley, JSON.stringify(BRIDGE), BRIDGE_TEXT]));
  row = await rowOf(db, pendingId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.proposed_text, ENGLEWOOD_TEXT);
  pass('an ignore-duplicates insert leaves a decided proposal exactly as it was');

  // ── the worker retires pending rows (newer email, owner edit, cancelled) ──
  // The scan's PATCH order_address_proposals?order_id=eq.<id>&status=eq.pending
  // to superseded / newer_email, run before it inserts the newer email's row.
  const olderId = await propose(db, await newIntake(db, ORDER.sheeley), ORDER.sheeley, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
  const newerId = await newIntake(db, ORDER.sheeley);
  const retired = await asServiceRole(db, () => scalarOn(db,
    `with done as (
       update public.order_address_proposals
          set status = 'superseded', decided_via = 'newer_email', decided_at = now(), updated_at = now()
        where order_id = $1 and status = 'pending' returning 1)
     select count(*)::int as value from done`, [ORDER.sheeley]));
  assert.equal(retired, 1, 'only the older pending row was standing');
  await propose(db, newerId, ORDER.sheeley);
  row = await rowOf(db, olderId);
  assert.equal(row.status, 'superseded');
  assert.equal(row.decided_via, 'newer_email');
  assert.equal(row.decided_by, null);
  assert.equal(row.apply_status, null);
  out = await decideAs(db, OWNER, ORDER.sheeley, olderId, 'accept');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'superseded');
  assert.equal(out.message, 'Already decided.');
  assert.equal((await rowOf(db, newerId)).status, 'pending');
  assert.equal((await intakeOf(db, olderId)).status, 'pending_review', 'a retirement never touches the intake row');
  pass('the worker retires an older pending row as superseded / newer_email with the service key; a tap on it answers Already decided; the newer row stands');
  // The follow-up loop retires a pending row whose order was cancelled or
  // whose on-file address moved, with the other two words.
  for (const via of ['owner_edit', 'cancelled']) {
    const id = await propose(db, await newIntake(db, ORDER.differs), ORDER.differs, { proposed_address: BRIDGE, proposed_text: BRIDGE_TEXT });
    await asServiceRole(db, () => q(db,
      "update public.order_address_proposals set status = 'superseded', decided_via = $2, decided_at = now(), updated_at = now() where intake_id = $1 and status = 'pending'", [id, via]));
    row = await rowOf(db, id);
    assert.equal(row.status, 'superseded');
    assert.equal(row.decided_via, via);
  }
  pass('every decided_via the worker writes (newer_email, owner_edit, cancelled) is admitted on a retirement');

  // ── the Jarvis apply lifecycle in SQL: queue read, guarded claim, stamps ──
  const laterId = await accepted(db, ORDER.blank);
  // A row backed off after an HTTP error (apply_after = now + 15 minutes).
  await asServiceRole(db, () => q(db,
    "update public.order_address_proposals set apply_after = now() + interval '15 minutes' where intake_id = $1", [laterId]));
  const firstId = await accepted(db, ORDER.blank);
  // The droplet's read: accepted, queued, due, oldest decision first, one row.
  // Scoped to this scenario's two rows: earlier scenarios left other accepted
  // rows queued on purpose (the rollback refusal below needs them).
  const QUEUE_SQL = `select intake_id as value from public.order_address_proposals
     where status = 'accepted' and apply_status = 'queued' and apply_after <= now()
       and intake_id in ($1, $2)
     order by decided_at asc limit 1`;
  assert.equal(await asServiceRole(db, () => scalarOn(db, QUEUE_SQL, [laterId, firstId])), firstId, 'a row backed off 15 minutes is not due yet');
  // The claim, guarded on queued and accepted: a second process finds nothing.
  const CLAIM_SQL = `with claimed as (
       update public.order_address_proposals
          set apply_status = 'applying', apply_claimed_at = now(), apply_attempts = apply_attempts + 1, updated_at = now()
        where intake_id = $1 and apply_status = 'queued' and status = 'accepted' returning 1)
     select count(*)::int as value from claimed`;
  assert.equal(await asServiceRole(db, () => scalarOn(db, CLAIM_SQL, [firstId])), 1);
  assert.equal(await asServiceRole(db, () => scalarOn(db, CLAIM_SQL, [firstId])), 0, 'a second claim finds nothing');
  row = await rowOf(db, firstId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.apply_status, 'applying');
  assert.equal(row.apply_attempts, 1);
  assert.ok(seconds(row.apply_claimed_at, Date.now()) < 60);
  assert.equal(await asServiceRole(db, () => scalarOn(db, QUEUE_SQL, [laterId, firstId])), undefined, 'a claimed row leaves the queue');
  // QuickBooks written, dashboard re-sync pending: applied_at while applying.
  await asServiceRole(db, () => q(db,
    "update public.order_address_proposals set applied_at = now(), updated_at = now() where intake_id = $1 and apply_status = 'applying'", [firstId]));
  row = await rowOf(db, firstId);
  assert.equal(row.apply_status, 'applying');
  assert.ok(row.applied_at, 'applied_at set while still applying means sync pending');
  // The finishing stamp, guarded on applying, with the banner columns.
  const finished = await asServiceRole(db, () => scalarOn(db,
    `with done as (
       update public.order_address_proposals
          set apply_status = 'applied', apply_note = $2, invoice_doc_number = $3, total_moved = false, tax_zero = true, updated_at = now()
        where intake_id = $1 and apply_status = 'applying' returning 1)
     select count(*)::int as value from done`,
    [firstId, 'Invoice #2104: tax 0.00 to 0.00, total 300.00 to 300.00', '2104']));
  assert.equal(finished, 1);
  row = await rowOf(db, firstId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.apply_status, 'applied');
  assert.equal(row.invoice_doc_number, '2104');
  assert.equal(row.total_moved, false);
  assert.equal(row.tax_zero, true);
  assert.equal(row.notified_at, null, 'the worker has not pushed yet');
  // The worker's follow-up read for the applied or failed push.
  const toNotify = await asServiceRole(db, () => rowsOn(db,
    "select intake_id from public.order_address_proposals where status = 'accepted' and apply_status in ('applied', 'failed') and notified_at is null"));
  assert.ok(toNotify.some(r => r.intake_id === firstId), 'the applied row is due a push');
  assert.ok(!toNotify.some(r => r.intake_id === laterId), 'a queued row is not pushed');
  out = await decideAs(db, OWNER, ORDER.blank, firstId, 'keep');
  assert.equal(out.applied, false);
  assert.equal(out.outcome, 'accepted');
  assert.equal(out.message, 'Already decided.');
  pass('the Jarvis lifecycle in SQL: the queue read skips a backed-off row, the guarded claim wins once, applied_at while applying means sync pending, the guarded finishing stamp lands, the follow-up read finds it, and a tap still answers Already decided');

  // ── one email, two tables: a time row and an address row side by side ──
  const bothId = await propose(db, await newIntake(db, ORDER.sheeley), ORDER.sheeley);
  await asServiceRole(db, () => q(db,
    'insert into public.order_time_proposals (intake_id, order_id, proposed_arrive_at, proposed_label) values ($1, $2, $3, $4)',
    [bothId, ORDER.sheeley, '2026-09-18T22:00:00Z', '6:00 PM']));
  out = await decideAs(db, OWNER, ORDER.sheeley, bothId, 'accept');
  assert.equal(out.outcome, 'accepted');
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select status as value from public.order_time_proposals where intake_id = $1', [bothId])), 'pending');
  intakeRow = await intakeOf(db, bothId);
  assert.equal(intakeRow.status, 'dismissed');
  assert.equal(intakeRow.error_detail, 'address proposal accepted by the owner in HC Field');
  pass('deciding the address row leaves the same email\'s time row (042) pending');
  const bothKeepId = await propose(db, await newIntake(db, ORDER.sheeley), ORDER.sheeley);
  await asServiceRole(db, () => q(db,
    'insert into public.order_time_proposals (intake_id, order_id, proposed_arrive_at, proposed_label) values ($1, $2, $3, $4)',
    [bothKeepId, ORDER.sheeley, '2026-09-18T22:00:00Z', '6:00 PM']));
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  out = await scalarOn(db, 'select public.hc_decide_proposed_time($1, $2, $3) as value', [ORDER.sheeley, bothKeepId, 'keep']);
  await identityOn(db);
  assert.equal(out.outcome, 'kept');
  assert.equal((await rowOf(db, bothKeepId)).status, 'pending');
  intakeRow = await intakeOf(db, bothKeepId);
  assert.equal(intakeRow.status, 'dismissed');
  assert.equal(intakeRow.error_detail, 'time proposal kept by the owner in HC Field');
  out = await decideAs(db, OWNER, ORDER.sheeley, bothKeepId, 'keep');
  assert.equal(out.applied, true);
  assert.equal(out.outcome, 'kept');
  assert.equal((await intakeOf(db, bothKeepId)).error_detail, 'time proposal kept by the owner in HC Field', 'the second dismissal is a guarded no-op');
  pass('the time decision leaves the address row pending; whichever decides first dismisses the email and the second dismissal is a no-op');

  // ── a replayed row: the decision dismisses it like any other ──
  const replayedProposalId = await propose(db, await newIntake(db, ORDER.sheeley, { replayed_at: '2026-09-16T13:00:00Z' }), ORDER.sheeley, { found_at: '2026-09-16T13:05:00Z' });
  out = await decideAs(db, OWNER, ORDER.sheeley, replayedProposalId, 'keep');
  assert.equal(out.outcome, 'kept');
  intakeRow = await intakeOf(db, replayedProposalId);
  assert.equal(intakeRow.status, 'dismissed');
  assert.equal(seconds(intakeRow.replayed_at, '2026-09-16T13:00:00Z'), 0, 'the replay stamp survives the decision');
  pass('a proposal from a replayed email decides like any other and keeps its replayed_at stamp');

  // ── who can read ──
  const total = await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'));
  assert.ok(total >= 20);
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'), total);
  const ownerSees = await rowsOn(db, 'select proposed_address, proposed_text, evidence_line, apply_note from public.order_address_proposals where intake_id = $1', [pendingId]);
  assert.deepEqual(ownerSees[0].proposed_address, ENGLEWOOD);
  assert.equal(ownerSees[0].apply_note, 'Invoice #2049: tax 92.19 to 68.75, total 1342.19 to 1318.75');
  pass('the owner phone reads every row, address and apply note included');
  await identityOn(db, { role: 'authenticated', sub: MANAGER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'), 0);
  await identityOn(db, { role: 'authenticated', sub: TEAM.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'), 0);
  await identityOn(db, { role: 'authenticated', sub: STALE.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'), 0);
  await identityOn(db, { role: 'authenticated' });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'), 0);
  pass('an authenticated non-owner (manager, team, inactive, no uid) reads nothing');
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon reads nothing from order_address_proposals (no grant at all)', 'select count(*) from public.order_address_proposals');
  await deniedOn(db, 'anon cannot insert into order_address_proposals',
    'insert into public.order_address_proposals (intake_id, order_id, proposed_address, proposed_text) values ($1, $2, $3::jsonb, $4)', [pendingId, ORDER.sheeley, JSON.stringify(ENGLEWOOD), ENGLEWOOD_TEXT]);
  const anonIntake = await q(db, 'select count(*)::int as value from public.intake_messages').then(r => r.rows[0].value, error => error.code);
  assert.ok(anonIntake === 0 || anonIntake === '42501');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  const ownerIntake = await q(db, 'select count(*)::int as value from public.intake_messages').then(r => r.rows[0].value, error => error.code);
  assert.ok(ownerIntake === 0 || ownerIntake === '42501');
  pass('intake_messages stays closed to anon and to phones: the two new columns open nothing');

  // ── nobody but the service key writes the table ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'the owner cannot update the table directly', 'update public.order_address_proposals set status = $2 where intake_id = $1', [callerId, 'kept']);
  await deniedOn(db, 'the owner cannot insert directly',
    'insert into public.order_address_proposals (intake_id, order_id, proposed_address, proposed_text) values ($1, $2, $3::jsonb, $4)', [pendingId, ORDER.sheeley, JSON.stringify(ENGLEWOOD), ENGLEWOOD_TEXT]);
  await deniedOn(db, 'the owner cannot delete directly', 'delete from public.order_address_proposals where intake_id = $1', [callerId]);
  await identityOn(db, { role: 'service_role' });
  await q(db, 'update public.order_address_proposals set notified_at = now() where intake_id = $1', [pendingId]);
  await identityOn(db);
  pass('the service key updates rows (the worker and Jarvis stamps); phones never write the table directly');

  // ── rows cascade away with their order and with their email ──
  const doomedId = await propose(db, await newIntake(db, ORDER.doomed), ORDER.doomed);
  await asPostgres(db, () => q(db, 'delete from public.orders where id = $1', [ORDER.doomed]));
  assert.equal(await rowOf(db, doomedId), undefined);
  pass('deleting an order removes its address proposals (on delete cascade)');
  const doomedIntakeId = await propose(db, await newIntake(db, ORDER.blank), ORDER.blank);
  await asPostgres(db, () => q(db, 'delete from public.intake_messages where id = $1', [doomedIntakeId]));
  assert.equal(await rowOf(db, doomedIntakeId), undefined);
  pass('deleting an intake email removes its address proposal (on delete cascade)');

  // ── rollback refuses while a QuickBooks write may be in flight ──
  const queuedId = await accepted(db, ORDER.blank);
  await refusesOn(db, 'rollback refuses while an accepted row is queued', rollback, '55000', /queued or applying/);
  assert.equal(await tableCount(db), 1);
  assert.equal(await fnCount(db), 1);
  await setApply(db, queuedId, 'applying', { apply_claimed_at: new Date().toISOString() });
  await refusesOn(db, 'rollback refuses while an accepted row is applying', rollback, '55000', /queued or applying/);
  assert.equal(await columnType(db, 'replayed_at'), 'timestamp with time zone');
  pass('a refused rollback leaves the table, the function and the columns in place');
  // Jarvis finishes: every queued or applying row (this one and the ones the
  // scenarios above accepted) ends applied. Failed and applied rows never
  // block the rollback.
  const settled = await asServiceRole(db, () => scalarOn(db,
    `with done as (
       update public.order_address_proposals set apply_status = 'applied', applied_at = now()
        where status = 'accepted' and apply_status in ('queued', 'applying') returning 1)
     select count(*)::int as value from done`));
  assert.ok(settled >= 2, 'more than one accepted row was waiting');
  await asServiceRole(db, () => q(db,
    "update public.order_address_proposals set apply_status = 'failed', error_detail = 'QuickBooks said: Stale Object Error' where intake_id = $1", [eventId]));

  // ── rollback refuses while a draft still holds with the 045 reason ──
  await refusesOn(db, 'rollback refuses while an order_reconfirmations row holds with pending_address_proposal', rollback, '55000', /pending_address_proposal/);
  assert.equal(await tableCount(db), 1);
  assert.ok((await holdCheckDef(db)).includes('pending_address_proposal'), 'the widened check is still in place');
  // The worker (or a hand edit) clears the reason: the rows stay, the word goes.
  await asServiceRole(db, () => q(db, "update public.order_reconfirmations set hold_reasons = array_remove(hold_reasons, 'pending_address_proposal') where 'pending_address_proposal' = any(hold_reasons)"));
  assert.deepEqual(await asPostgres(db, () => scalarOn(db, 'select hold_reasons as value from public.order_reconfirmations where id = $1', [heldBothId])), ['count_missing', 'pending_time_proposal']);
  pass('a refused rollback leaves the widened check in place; clearing the reason from every held row unblocks it');

  // ── rollback, twice, then re-apply ──
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await fnCount(db), 0);
  assert.equal(await tableCount(db), 0);
  assert.equal(await columnType(db, 'replayed_at'), undefined);
  assert.equal(await columnType(db, 'address_scanned_at'), undefined);
  const defBack = await holdCheckDef(db);
  assert.ok(defBack.includes('pending_time_proposal') && !defBack.includes('pending_address_proposal'), defBack);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'after the rollback, 044\'s check refuses pending_address_proposal again',
    'update public.order_reconfirmations set hold_reasons = $2::text[] where id = $1', [heldAddrId, ['pending_address_proposal']], '23514', /hold_reasons_check/);
  await identityOn(db);
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_reconfirmations where id in ($1, $2, $3)', [held044Id, heldAddrId, heldBothId])), 3, 'the reconfirmation rows themselves survive');
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select status as value from public.intake_messages where id = $1', [pendingId])), 'dismissed');
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select status as value from public.order_time_proposals where intake_id = $1', [bothId])), 'pending');
  assert.equal(await asPostgres(db, () => scalarOn(db, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hc_decide_proposed_time'")), 1);
  pass('rollback runs twice once applied and failed rows are all that is left: function, policy, table and both columns gone; intake rows, 042\'s table and function untouched');
  await db.exec(migration);
  assert.equal(await fnCount(db), 1);
  assert.equal(await columnType(db, 'replayed_at'), 'timestamp with time zone');
  assert.equal(await columnType(db, 'address_scanned_at'), 'timestamp with time zone');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  assert.equal(await scalarOn(db, 'select count(*)::int as value from public.order_address_proposals'), 0);
  await identityOn(db);
  const againId = await propose(db, await newIntake(db, ORDER.sheeley), ORDER.sheeley);
  out = await decideAs(db, OWNER, ORDER.sheeley, againId, 'accept');
  assert.equal(out.outcome, 'accepted');
  assert.equal(out.row.apply_status, 'queued');
  assert.ok((await holdCheckDef(db)).includes('pending_address_proposal'), 'the hold reason is admitted again');
  await asServiceRole(db, () => q(db, 'update public.order_reconfirmations set hold_reasons = $2::text[] where id = $1', [heldAddrId, ['pending_address_proposal']]));
  pass('re-apply after rollback starts empty, with the policy, the columns and the widened hold_reasons check back, and decides again');

  // ── preflight guards on an unexpected shape ──
  const guard = await productionShaped({ skip: ['042_order_time_proposals'] });
  handles.push(guard);
  await refusesOn(guard, '045 refuses when 042 (order_time_proposals) is absent', migration, '55000', /order_time_proposals \(042\)/);
  assert.equal(await columnType(guard, 'replayed_at'), undefined, 'nothing was added');
  // 044 added intake_messages.conversation_id; the reply scan matches on it.
  const guard1 = await productionShaped({ skip: ['044_order_reconfirmations'] });
  handles.push(guard1);
  await refusesOn(guard1, '045 refuses when 044 (intake_messages.conversation_id) is absent', migration, '55000', /intake_messages\.conversation_id/);
  assert.equal(await columnType(guard1, 'replayed_at'), undefined, 'nothing was added');
  // 044's hold_reasons check must be there under its own name and shape;
  // a dropped or foreign constraint is never rewritten.
  const guard1b = await productionShaped();
  handles.push(guard1b);
  await guard1b.exec('alter table public.order_reconfirmations drop constraint order_reconfirmations_hold_reasons_check;');
  await refusesOn(guard1b, '045 refuses when 044\'s hold_reasons check is missing from order_reconfirmations', migration, '55000', /hold_reasons check/);
  assert.equal(await columnType(guard1b, 'replayed_at'), undefined, 'nothing was added');
  const guard1c = await productionShaped();
  handles.push(guard1c);
  await guard1c.exec(`alter table public.order_reconfirmations drop constraint order_reconfirmations_hold_reasons_check;
    alter table public.order_reconfirmations add constraint order_reconfirmations_hold_reasons_check check (hold_reasons <@ array['owner_hold']::text[]);`);
  await refusesOn(guard1c, '045 refuses a hold_reasons check that is not 044\'s (no pending_time_proposal)', migration, '55000', /hold_reasons check/);
  assert.equal(await columnType(guard1c, 'replayed_at'), undefined, 'nothing was added');
  const guard2 = await productionShaped();
  handles.push(guard2);
  await guard2.exec('create table public.order_address_proposals (id int primary key);');
  await refusesOn(guard2, '045 refuses a foreign order_address_proposals table with the wrong columns', migration, '55000', /refuses an existing public.order_address_proposals/);
  const guard2b = await productionShaped();
  handles.push(guard2b);
  await guard2b.exec(`
    create table public.order_address_proposals (
      intake_id bigint primary key, order_id uuid not null, proposed_address jsonb not null, proposed_text text not null,
      status text not null default 'pending', apply_status text, invoice_id_snapshot text, delivery_day_snapshot date,
      found_at timestamptz not null default now());`);
  await refusesOn(guard2b, '045 refuses a foreign table that lacks apply_after (the queue index needs it)', migration, '55000', /with no apply_after column/);
  const guard3 = await productionShaped();
  handles.push(guard3);
  await guard3.exec('alter table public.intake_messages add column replayed_at integer;');
  await refusesOn(guard3, '045 refuses a pre-existing replayed_at that is not a timestamptz', migration, '55000', /replayed_at of type integer/);
  const guard4 = await productionShaped();
  handles.push(guard4);
  await guard4.exec('alter table public.intake_messages add column address_scanned_at text;');
  await refusesOn(guard4, '045 refuses a pre-existing address_scanned_at that is not a timestamptz', migration, '55000', /address_scanned_at of type text/);
  // A pre-existing table with every column the preflight asks for passes the
  // preflight, and "create ... if not exists" then skips the real check
  // constraint and keeps any policy already there. The postflight must
  // catch both shapes.
  const PRE_EXISTING_TABLE = `
    create table public.order_address_proposals (
      intake_id bigint primary key references public.intake_messages(id) on delete cascade,
      order_id uuid not null references public.orders(id) on delete cascade,
      proposed_address jsonb not null, proposed_text text not null,
      status text not null default 'pending', apply_status text, apply_after timestamptz,
      invoice_id_snapshot text, delivery_day_snapshot date,
      found_at timestamptz not null default now());`;
  const guard5 = await productionShaped();
  handles.push(guard5);
  await guard5.exec(PRE_EXISTING_TABLE);
  await refusesOn(guard5, '045 postflight refuses a pre-existing table without the accepted/apply_status check constraint', migration, '55000', /check constraint is missing/);
  const guard6 = await productionShaped();
  handles.push(guard6);
  await guard6.exec(PRE_EXISTING_TABLE + `
    alter table public.order_address_proposals add constraint order_address_proposals_accepted_apply_check
      check ((status = 'accepted') = (apply_status is not null));
    alter table public.order_address_proposals enable row level security;
    create policy order_address_proposals_open_select on public.order_address_proposals
      for select to authenticated using (true);`);
  await refusesOn(guard6, '045 postflight refuses a second select policy on the table (a manager phone would read every row)', migration, '55000', /exactly one policy/);

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, the phone UI, the worker scan, the Jarvis apply step, QuickBooks, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
