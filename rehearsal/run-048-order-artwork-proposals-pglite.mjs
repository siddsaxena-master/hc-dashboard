// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-048-order-artwork-proposals-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations/048_order_artwork_proposals.sql (a customer's artwork
// file found on an email, the owner's Use it, Not this one or Dismiss from
// the phone, the Approve artwork tap, the owner-only signing clause on the
// 035 logo-read helper, and the two new columns on intake_messages) and its
// rollback on the shape production is in on 2026-09-21: the 001-013 base
// chain, 015, 015b, 019, 024, 026, 027, 029, 034-038 and 040-047 (015c and
// 030 are live too but refuse to apply on this sandbox, so they are not
// reproduced here). Real migration files are executed as written and never
// rewritten on disk. Every order, email, file, hash and person here is fake.
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
  '047_passed_leads',
];
const [supabaseBootstrap, ordersBaseline, migration, rollback, migration035] = await Promise.all([
  read('rehearsal/webhook-outbox-local-setup.sql'),
  read('rehearsal/000_orders_baseline.sql'),
  read('migrations/048_order_artwork_proposals.sql'),
  read('migrations/048_order_artwork_proposals_rollback.sql'),
  read('migrations/035_order_logo_assets.sql'),
]);
const baseFiles = Object.fromEntries(await Promise.all(
  [...BASE_CHAIN, ...APPLIED_CHAIN].map(async name => [name, await read(`migrations/${name}.sql`)])));
assert.ok(!/[\u2013\u2014]/.test(migration + rollback), 'no em or en dashes in the 048 files');
// The 035 helper body as the 035 file writes it, so the constants inside
// 048 and its rollback can be checked against the source of truth.
const body035 = (() => {
  const from = migration035.indexOf("as $function$\n  select auth.uid() is not null");
  const to = migration035.indexOf('$function$;', from);
  assert.ok(from > 0 && to > from, 'the 035 helper body was not found in the 035 file');
  return migration035.slice(from + 'as $function$'.length, to);
})();
assert.equal([...migration.matchAll(/\$body035\$/g)].length, 2, '048 carries the 035 body as one dollar-quoted constant');
assert.ok(migration.includes('$body035$' + body035 + '$body035$'), '048 preflight constant equals the 035 body byte for byte');
assert.ok(rollback.includes('$body035$' + body035 + '$body035$'), 'the rollback postflight constant equals the 035 body byte for byte');
assert.ok(rollback.includes('as $function$' + body035 + '$function$;'), 'the rollback restores the 035 body byte for byte');

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
  // The headline case: an empty card, one file in the email.
  empty: '30000000-0000-4000-8000-000000000001',
  // A hand-imported file already on the card (the Alison shape, free-text
  // usage), status received.
  hand: '30000000-0000-4000-8000-000000000002',
  // A record marked needs_review by hand.
  review: '30000000-0000-4000-8000-000000000003',
  // The card already holds the proposed bytes (as an original, and as a preview).
  dup: '30000000-0000-4000-8000-000000000004',
  // Twelve files on the card.
  full: '30000000-0000-4000-8000-000000000005',
  cancelled: '30000000-0000-4000-8000-000000000006',
  // Delivered last year.
  past: '30000000-0000-4000-8000-000000000007',
  // The invoice moves after the scan.
  invoice: '30000000-0000-4000-8000-000000000008',
  // The card changes after the scan.
  moved: '30000000-0000-4000-8000-000000000009',
  // An SVG: no preview, original only.
  svg: '30000000-0000-4000-8000-000000000010',
  // Nothing saved: too large and fetch failed.
  failed: '30000000-0000-4000-8000-000000000011',
  // A Vegas card with a file: the NY crew must not sign it.
  vegas: '30000000-0000-4000-8000-000000000012',
  // A card whose one file has no usage word.
  unlabelled: '30000000-0000-4000-8000-000000000013',
  // Two files in one email (a front and a back).
  two: '30000000-0000-4000-8000-000000000014',
  // No delivery marker; the day comes from event_start_at.
  eventonly: '30000000-0000-4000-8000-000000000015',
  // Deleted at the end to prove the cascade.
  doomed: '30000000-0000-4000-8000-000000000016',
  // Three files in one email, the worker has not read it yet: Use it,
  // then Use it again (the sibling re-snapshot), the dismissal window.
  three: '30000000-0000-4000-8000-000000000017',
};
const hex = n => n.toString(16).padStart(64, '0');
const SHA = { hand: hex(0x101), handPreview: hex(0x102), dup: hex(0x201), dupPreview: hex(0x202), vegas: hex(0x301), unlabelled: hex(0x401), review: hex(0x501) };

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
insert into public.orders (id, client_name, client_email, venue, delivery_at_utc, event_start_at, stage, market, coconuts_qty, external_invoice_id, deposit_cents, balance_cents) values
  ('${ORDER.empty}', 'Fake Sheeley', 'fake.sheeley@example.invalid', 'Fake Beach', '2027-03-05T00:00:00Z', '2027-03-05T22:00:00Z', 'paid_full', 'ny', 100, 'FAKE-3449', 0, 0),
  ('${ORDER.hand}', 'Fake Hand Import', 'fake.hand@example.invalid', 'Fake Beach', '2027-03-06T00:00:00Z', null, 'deposit_paid', 'ny', 100, 'FAKE-2049', 50000, 50000),
  ('${ORDER.review}', 'Fake Review', 'fake.review@example.invalid', 'Fake Hall', '2027-03-07T00:00:00Z', null, 'deposit_paid', 'ny', 40, 'FAKE-2103', 20000, 20000),
  ('${ORDER.dup}', 'Fake Duplicate', 'fake.dup@example.invalid', null, '2027-03-08T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2104', 0, 30000),
  ('${ORDER.full}', 'Fake Full', 'fake.full@example.invalid', 'Fake Pier', '2027-03-09T00:00:00Z', null, 'deposit_paid', 'ny', 30, 'FAKE-2105', 10000, 10000),
  ('${ORDER.cancelled}', 'Fake Cancelled', 'fake.cancelled@example.invalid', 'Fake Pier', '2027-03-10T00:00:00Z', null, 'cancelled', 'ny', 30, 'FAKE-2106', 0, 0),
  ('${ORDER.past}', 'Fake Past', 'fake.past@example.invalid', 'Fake Pier', '2025-06-01T00:00:00Z', null, 'complete', 'ny', 30, 'FAKE-2107', 0, 0),
  ('${ORDER.invoice}', 'Fake Invoice', 'fake.invoice@example.invalid', 'Fake Pier', '2027-03-11T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2108', 0, 30000),
  ('${ORDER.moved}', 'Fake Moved', 'fake.moved@example.invalid', 'Fake Pier', '2027-03-12T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2109', 0, 30000),
  ('${ORDER.svg}', 'Fake Vector', 'fake.svg@example.invalid', 'Fake Pier', '2027-03-13T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2110', 0, 30000),
  ('${ORDER.failed}', 'Fake Failed', 'fake.failed@example.invalid', 'Fake Pier', '2027-03-14T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2111', 0, 30000),
  ('${ORDER.vegas}', 'Fake Vegas', 'fake.vegas@example.invalid', 'Fake Strip', '2027-03-15T00:00:00Z', null, 'invoiced', 'vegas', 30, 'FAKE-2112', 0, 30000),
  ('${ORDER.unlabelled}', 'Fake Unlabelled', 'fake.unlabelled@example.invalid', 'Fake Pier', '2027-03-16T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2113', 0, 30000),
  ('${ORDER.two}', 'Fake Two Files', 'fake.two@example.invalid', 'Fake Pier', '2027-03-17T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2114', 0, 30000),
  ('${ORDER.eventonly}', 'Fake Event Only', 'fake.eventonly@example.invalid', 'Fake Pier', null, '2027-03-18T18:00:00Z', 'invoiced', 'ny', 30, 'FAKE-2115', 0, 30000),
  ('${ORDER.doomed}', 'Fake Cascade', 'fake.cascade@example.invalid', 'Fake Pier', '2027-03-19T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2116', 0, 30000),
  ('${ORDER.three}', 'Fake Three Files', 'fake.three@example.invalid', 'Fake Pier', '2027-03-20T00:00:00Z', null, 'invoiced', 'ny', 30, 'FAKE-2117', 0, 30000);`;

// A file entry the way the hand imports wrote it (import_alison_logo.py:86-94).
const handFile = (sha, previewSha, extra = {}) => ({
  usage: 'Coconut branding, Sienna Beach', sha256: sha, warnings: [],
  file_name: 'SIENNA BEACH V1 BLUE WITH PINK.ps', mime_type: 'application/postscript', size_bytes: 40000,
  source_ref: { kind: 'email', message_id: 'AAMk-fake-hand' },
  preview_path: '2049-sienna-beach-v1-blue-with-pink-' + sha.slice(0, 16) + '-preview.png',
  original_path: '2049-sienna-beach-v1-blue-with-pink-' + sha.slice(0, 16) + '.ps',
  preview_sha256: previewSha, preview_size_bytes: 9000,
  source_received_at: '2026-08-22T14:03:11Z', attachment_listed_size_bytes: 40000, ...extra,
});
const handRecord = (files, status = 'received', checkedAt = '2026-09-17T20:00:00.000Z') => ({
  files, status, checked_at: checkedAt,
  source_ref: { kind: 'email', message_ids: ['AAMk-fake-hand'] }, source_received_at: '2026-08-22T14:03:11Z',
});
const HAND_PATH = handFile(SHA.hand, SHA.handPreview).original_path;
const HAND_PREVIEW = handFile(SHA.hand, SHA.handPreview).preview_path;
const VEGAS_PATH = 'vegas-logo-' + SHA.vegas.slice(0, 16) + '.png';
// Applied AFTER the chain because 035 adds the column.
const LOGOS = `
update public.orders set logo_asset = '${JSON.stringify(handRecord([handFile(SHA.hand, SHA.handPreview)]))}'::jsonb, logo_received = true where id = '${ORDER.hand}';
update public.orders set logo_asset = '${JSON.stringify(handRecord([handFile(SHA.review, hex(0x502), { usage: 'Coconut' })], 'needs_review'))}'::jsonb where id = '${ORDER.review}';
update public.orders set logo_asset = '${JSON.stringify(handRecord([handFile(SHA.dup, SHA.dupPreview, { usage: 'Coconut' })]))}'::jsonb where id = '${ORDER.dup}';
update public.orders set logo_asset = '${JSON.stringify(handRecord(Array.from({ length: 12 }, (_, i) => handFile(hex(0x600 + i), hex(0x700 + i), { usage: 'Coconut', file_name: 'logo-' + i + '.png', mime_type: 'image/png', original_path: 'full-logo-' + i + '.png', preview_path: 'full-logo-' + i + '-preview.png' }))))}'::jsonb where id = '${ORDER.full}';
update public.orders set logo_asset = '${JSON.stringify(handRecord([handFile(SHA.vegas, hex(0x302), { usage: 'Coconut', file_name: 'vegas.png', mime_type: 'image/png', original_path: VEGAS_PATH, preview_path: 'vegas-logo-' + SHA.vegas.slice(0, 16) + '-preview.png' })]))}'::jsonb where id = '${ORDER.vegas}';
update public.orders set logo_asset = '${JSON.stringify(handRecord([handFile(SHA.unlabelled, hex(0x402), { usage: 'Usage needs confirmation' })]))}'::jsonb where id = '${ORDER.unlabelled}';
update public.orders set logo_asset = '${JSON.stringify(handRecord([handFile(hex(0x901), hex(0x902), { usage: 'Coconut' })]))}'::jsonb where id = '${ORDER.moved}';`;

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
  await assert.rejects(h.query(sql, params), error => (error.code === code && (!message || message.test(error.message))) || (console.error('unexpected: ' + error.code + ' ' + error.message), false), label);
  pass(label);
}
async function refusesOn(h, label, sql, code, message) {
  let seen = null;
  await assert.rejects(h.exec(sql), error => { seen = error; return error.code === code && message.test(error.message); }, label);
  try { await h.exec('rollback;'); } catch { /* nothing open */ }
  pass(`${label} (${seen.code}: ${seen.message})`);
}
// The phone's calls (POST rpc/hc_decide_proposed_artwork and
// rpc/hc_approve_order_artwork), as SQL with the parameter names PostgREST
// would match.
const DECIDE_SQL = 'select public.hc_decide_proposed_artwork(p_order_id => $1, p_proposal_id => $2, p_decision => $3) as value';
const APPROVE_SQL = 'select public.hc_approve_order_artwork(p_order_id => $1, p_checked_at => $2) as value';
const CAN_READ_SQL = 'select public.hc_can_read_order_logo($1) as value';
const decideAs = (h, who, orderId, proposalId, decision) => asUser(h, who, () => scalarOn(h, DECIDE_SQL, [orderId, proposalId, decision]));
const approveAs = (h, who, orderId, checkedAt) => asUser(h, who, () => scalarOn(h, APPROVE_SQL, [orderId, checkedAt]));
const canReadAs = (h, who, name) => asUser(h, who, () => scalarOn(h, CAN_READ_SQL, [name]));
// A linked, classified intake email the way Jarvis leaves it for the pass,
// and the way the worker leaves it once its 5-minute tick has read it
// (address_scanned_at stamped, 045). Pass { scanned: false } for an email
// the worker has NOT read yet (the pass runs about 3 minutes after the
// email; the worker ticks every 5).
let intakeSeq = 0;
async function newIntake(h, orderId, fields = {}) {
  const row = { from_addr: 'fake.customer@example.invalid', subject: 'Logo attached', raw_text: 'Logo attached, front and back.', status: 'pending_review', scanned: true, ...fields };
  intakeSeq++;
  return asServiceRole(h, () => scalarOn(h,
    `insert into public.intake_messages (channel, source_msg_id, from_addr, subject, raw_text, classification, status, order_id, classified_at, address_scanned_at)
     values ('email', $1, $2, $3, $4, 'maybe_order', $5, $6, now(), case when $7::boolean then now() else null end)
     returning id as value`,
    [`fake-048-${intakeSeq}`, row.from_addr, row.subject, row.raw_text, row.status, orderId, row.scanned]));
}
// The worker's stamp on an email it has now read (scanAddressForRow).
const workerReads = (h, intakeId) => asServiceRole(h, () => q(h, 'update public.intake_messages set address_scanned_at = now() where id = $1', [intakeId]));
// The droplet pass's insert, with the service key. The snapshots default to
// what the order carries right now; only the named fields vary.
let fileSeq = 0;
async function propose(h, intakeId, orderId, fields = {}) {
  fileSeq++;
  const o = await orderOf(h, orderId);
  const sha = fields.sha256 || hex(0x1000 + fileSeq);
  const mime = fields.mime_type || 'image/png';
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'application/pdf' ? 'pdf' : mime === 'image/svg+xml' ? 'svg' : mime === 'application/illustrator' ? 'ai' : 'ps';
  const base = (o.external_invoice_id || orderId.slice(0, 8)) + '-fake-logo-' + fileSeq + '-' + sha.slice(0, 16);
  const verdict = fields.verdict || 'ready';
  const row = {
    attachment_id: 'att-' + fileSeq, file_name: 'fake-logo-' + fileSeq + '.' + ext, mime_type: mime, sha256: sha, size_bytes: 12345,
    attachment_listed_size_bytes: 12345,
    original_path: verdict === 'ready' || verdict === 'no_preview' ? base + '.' + ext : null,
    preview_path: verdict === 'ready' ? base + '-preview.png' : null,
    preview_sha256: verdict === 'ready' ? hex(0x2000 + fileSeq) : null,
    preview_size_bytes: verdict === 'ready' ? 4567 : null,
    preview_width: verdict === 'ready' ? 1200 : null, preview_height: verdict === 'ready' ? 600 : null,
    verdict, verdict_note: null, page_count: null, sender_kind: 'customer', small_image: false, mismatch_note: null, warnings: [],
    card_files_at_scan: Array.isArray(o.logo_asset?.files) ? o.logo_asset.files.length : 0,
    card_checked_at_snapshot: o.logo_asset?.checked_at ?? null,
    invoice_id_snapshot: o.external_invoice_id,
    // The UTC calendar day of the delivery marker, else of the event start
    // (the worker's deliveryDaySnapshot).
    delivery_day_snapshot: await asPostgres(h, () => scalarOn(h, "select coalesce((delivery_at_utc at time zone 'UTC')::date, (event_start_at at time zone 'UTC')::date)::text as value from public.orders where id = $1", [orderId])),
    evidence_line: 'Logo attached, front and back.', source_received_at: '2026-08-22T14:03:11Z', found_at: null,
    ...fields,
  };
  return asServiceRole(h, () => scalarOn(h,
    `insert into public.order_artwork_proposals
       (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, attachment_listed_size_bytes, original_path, preview_path, preview_sha256, preview_size_bytes, preview_width, preview_height,
        verdict, verdict_note, page_count, sender_kind, small_image, mismatch_note, warnings, card_files_at_scan, card_checked_at_snapshot, invoice_id_snapshot, delivery_day_snapshot, evidence_line, source_received_at, found_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24, $25::date, $26, $27::timestamptz, coalesce($28::timestamptz, now()))
     returning id as value`,
    [intakeId, orderId, row.attachment_id, row.file_name, row.mime_type, row.sha256, row.size_bytes, row.attachment_listed_size_bytes, row.original_path, row.preview_path, row.preview_sha256, row.preview_size_bytes, row.preview_width, row.preview_height,
      row.verdict, row.verdict_note, row.page_count, row.sender_kind, row.small_image, row.mismatch_note, JSON.stringify(row.warnings), row.card_files_at_scan, row.card_checked_at_snapshot, row.invoice_id_snapshot, row.delivery_day_snapshot, row.evidence_line, row.source_received_at, row.found_at]));
}
const rowOf = (h, id) => asPostgres(h, async () => (await rowsOn(h,
  `select id, intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, preview_sha256, verdict, sender_kind, warnings,
          card_files_at_scan, card_checked_at_snapshot, invoice_id_snapshot, delivery_day_snapshot::text as delivery_day_snapshot, found_at, status, decided_at, decided_by, decided_via, usage_written, notified_at, error_detail, updated_at
     from public.order_artwork_proposals where id = $1`, [id]))[0]);
const intakeOf = (h, intakeId) => asPostgres(h, async () => (await rowsOn(h,
  'select id, status, reviewed_at, error_detail, email_meta, artwork_scanned_at from public.intake_messages where id = $1', [intakeId]))[0]);
async function orderOf(h, orderId) {
  const rows = await asPostgres(h, () => rowsOn(h, 'select to_jsonb(o) as value from public.orders as o where o.id = $1', [orderId]));
  return rows[0]?.value;
}
const setOrder = (h, orderId, sql, params = []) => asServiceRole(h, () => q(h, `update public.orders set ${sql} where id = $1`, [orderId, ...params]));
const fnCount = (h, name) => scalarOn(h, "select count(*)::int as value from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [name]);
const tableCount = h => scalarOn(h, "select count(*)::int as value from pg_class where relnamespace = 'public'::regnamespace and relname = 'order_artwork_proposals'");
const columnType = (h, column) => scalarOn(h,
  'select format_type(atttypid, atttypmod) as value from pg_attribute where attrelid = $1::regclass and attname = $2 and attnum > 0 and not attisdropped',
  ['public.intake_messages', column]);
const indexExists = (h, name) => scalarOn(h, 'select to_regclass($1) is not null as value', [`public.${name}`]);
const canExecute = (h, role, signature) => scalarOn(h, 'select has_function_privilege($1, $2, $3) as value', [role, signature, 'execute']);
const helperSrc = h => scalarOn(h, "select prosrc as value from pg_proc where oid = 'public.hc_can_read_order_logo(text)'::regprocedure");
const bucketCap = h => scalarOn(h, "select file_size_limit::text as value from storage.buckets where id = 'order-logos'");
const storagePolicies = h => rowsOn(h, "select policyname, permissive, roles::text as roles, cmd, qual from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname");
const seconds = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_S_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECIDE_SIG = 'public.hc_decide_proposed_artwork(uuid, bigint, text)';
const APPROVE_SIG = 'public.hc_approve_order_artwork(uuid, text)';
const IMPORT_KEYS = ['usage', 'sha256', 'warnings', 'file_name', 'mime_type', 'size_bytes', 'source_ref', 'preview_path', 'original_path', 'preview_sha256', 'preview_size_bytes', 'source_received_at', 'attachment_listed_size_bytes'];
const stillOf = (row, moving) => Object.fromEntries(Object.entries(row).filter(([key]) => !moving.includes(key)));

async function productionShaped(options = {}) {
  const { skip = [] } = options;
  const h = await PGlite.create({ extensions: { pgcrypto } });
  await h.exec(supabaseBootstrap);
  await h.exec(STORAGE_STUB);
  await h.exec(ordersBaseline);
  for (const name of BASE_CHAIN) await h.exec(baseFiles[name]);
  await h.exec(SEED);
  for (const name of APPLIED_CHAIN) if (!skip.includes(name)) await h.exec(baseFiles[name]);
  await h.exec(LOGOS);
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

  // ── before 048: the 035 helper is the 035 text, no table, no functions ──
  const src035 = await helperSrc(db);
  assert.equal(src035, body035, 'the installed 035 helper equals the 035 file body');
  const policiesBefore = await storagePolicies(db);
  for (const name of ['hc_order_logos_selected_read', 'hc_order_logos_authenticated_read_guard', 'hc_order_logos_anonymous_read_guard']) {
    assert.ok(policiesBefore.some(p => p.policyname === name), 'the 035 storage policy ' + name + ' is installed');
  }
  assert.equal(await tableCount(db), 0);
  assert.equal(await fnCount(db, 'hc_decide_proposed_artwork'), 0);
  assert.equal(await columnType(db, 'email_meta'), undefined);
  assert.equal(await bucketCap(db), null);
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'before 048 the phone\'s decide call fails with function does not exist (PostgREST 404 PGRST202)', DECIDE_SQL, [ORDER.empty, 1, 'use'], '42883');
  await identityOn(db);
  // The crew can sign a card file in their market (035): true before, and
  // still true after.
  assert.equal(await canReadAs(db, TEAM, HAND_PATH), true);
  assert.equal(await canReadAs(db, TEAM, VEGAS_PATH), false);
  const emptyBefore = await orderOf(db, ORDER.empty);
  assert.equal(emptyBefore.logo_asset, null);
  assert.equal(emptyBefore.logo_received, false);

  // ── apply twice ──
  for (const sql of [migration, migration]) await db.exec(sql);
  assert.equal(await tableCount(db), 1);
  assert.equal(await fnCount(db, 'hc_decide_proposed_artwork'), 1);
  assert.equal(await fnCount(db, 'hc_approve_order_artwork'), 1);
  assert.equal(await fnCount(db, 'hc_can_read_order_logo'), 1);
  assert.equal(await columnType(db, 'email_meta'), 'jsonb');
  assert.equal(await columnType(db, 'artwork_scanned_at'), 'timestamp with time zone');
  for (const name of ['order_artwork_proposals_order_status_idx', 'order_artwork_proposals_pending_notify_idx', 'order_artwork_proposals_intake_idx']) {
    assert.equal(await indexExists(db, name), true, name);
  }
  assert.equal(await bucketCap(db), '25000000');
  assert.deepEqual(await storagePolicies(db), policiesBefore, 'the three 035 storage policies are byte-identical');
  const src048 = await helperSrc(db);
  assert.ok(src048.startsWith(body035.slice(0, body035.length - ');\n'.length)), 'the 035 body is the first branch, verbatim');
  assert.ok(src048.includes("or (\n      auth.uid() is not null") && src048.includes('from public.order_artwork_proposals as proposal') && src048.endsWith('    );\n'));
  assert.equal(await scalarOn(db, "select count(*)::int as value from pg_policies where schemaname = 'public' and tablename = 'order_artwork_proposals'"), 1);
  assert.equal(await scalarOn(db, "select policyname as value from pg_policies where schemaname = 'public' and tablename = 'order_artwork_proposals'"), 'order_artwork_proposals_owner_select');
  assert.equal(await scalarOn(db, "select relrowsecurity as value from pg_class where oid = 'public.order_artwork_proposals'::regclass"), true);
  pass('048 applies twice on the production-shaped chain (001-013, 015, 015b, 019, 024, 026, 027, 029, 034-038, 040-047): two intake columns, the table, three indexes, one policy, RLS on, the helper re-created with the 035 text plus one clause, the bucket cap');

  // ── grants ──
  for (const signature of [DECIDE_SIG, APPROVE_SIG]) {
    assert.equal(await canExecute(db, 'authenticated', signature), true, signature + ' for authenticated');
    assert.equal(await canExecute(db, 'anon', signature), false, signature + ' not for anon');
    assert.equal(await canExecute(db, 'service_role', signature), false, signature + ' not for service_role');
    assert.equal(await canExecute(db, 'public', signature), false, signature + ' not for public');
  }
  assert.equal(await canExecute(db, 'anon', 'public.hc_can_read_order_logo(text)'), false);
  assert.equal(await canExecute(db, 'authenticated', 'public.hc_can_read_order_logo(text)'), true);
  assert.equal(await scalarOn(db, "select has_table_privilege('anon', 'public.order_artwork_proposals', 'select') as value"), false);
  assert.equal(await scalarOn(db, "select has_table_privilege('authenticated', 'public.order_artwork_proposals', 'select') as value"), true);
  assert.equal(await scalarOn(db, "select has_table_privilege('authenticated', 'public.order_artwork_proposals', 'insert') as value"), false);
  assert.equal(await scalarOn(db, "select has_table_privilege('authenticated', 'public.order_artwork_proposals', 'update') as value"), false);
  assert.equal(await scalarOn(db, "select has_table_privilege('service_role', 'public.order_artwork_proposals', 'insert') as value"), true);
  pass('execute on both functions: authenticated yes; anon, service_role and public no. Table: anon nothing, authenticated select only, service_role writes');

  // ── the crew still sign a card file in their market (035 behaviour kept) ──
  assert.equal(await canReadAs(db, TEAM, HAND_PATH), true);
  assert.equal(await canReadAs(db, TEAM, HAND_PREVIEW), true);
  assert.equal(await canReadAs(db, MANAGER, HAND_PATH), true);
  assert.equal(await canReadAs(db, TEAM, VEGAS_PATH), false, 'a Vegas card file is not for the NY crew');
  assert.equal(await canReadAs(db, OWNER, VEGAS_PATH), true, 'the owner signs any card file');
  assert.equal(await canReadAs(db, STALE, HAND_PATH), false, 'an inactive login signs nothing');
  assert.equal(await canReadAs(db, TEAM, 'nope'), false);
  assert.equal(await asPostgres(db, () => scalarOn(db, CAN_READ_SQL, ['nope'])), false, 'the migration role (no auth.uid) gets false');
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot call hc_can_read_order_logo at all', CAN_READ_SQL, [HAND_PATH], '42501', /permission denied for function/);
  await identityOn(db);
  pass('hc_can_read_order_logo keeps the 035 behaviour: crew and managers sign a card file in their market, never another market\'s, the owner signs any card file, an inactive login and anon get nothing');

  // ── the service key inserts rows; the phone cannot ──
  const intakeEmpty = await newIntake(db, ORDER.empty, { from_addr: 'fake.sheeley@example.invalid' });
  const propEmpty = await propose(db, intakeEmpty, ORDER.empty, { file_name: 'SIENNA BEACH V1 BLUE WITH PINK.ps', mime_type: 'application/postscript' });
  assert.ok(propEmpty > 0);
  let row = await rowOf(db, propEmpty);
  assert.equal(row.status, 'pending'); assert.equal(row.decided_at, null); assert.equal(row.notified_at, null);
  assert.equal(row.card_files_at_scan, 0); assert.equal(row.card_checked_at_snapshot, null);
  assert.equal(row.invoice_id_snapshot, 'FAKE-3449'); assert.equal(row.delivery_day_snapshot, '2027-03-05');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'the owner phone cannot insert a proposal (no insert grant)',
    "insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, verdict, sender_kind, source_received_at) values ($1, $2, 'x', 'x.png', 'image/png', $3, 10, 'too_large', 'customer', now())",
    [intakeEmpty, ORDER.empty, hex(0x9999)], '42501');
  await deniedOn(db, 'the owner phone cannot update a proposal', 'update public.order_artwork_proposals set status = $2 where id = $1', [propEmpty, 'declined'], '42501');
  await identityOn(db);
  // The owner reads it; a manager, the crew and anon read nothing.
  assert.equal(await asUser(db, OWNER, () => scalarOn(db, 'select count(*)::int as value from public.order_artwork_proposals')), 1);
  assert.equal(await asUser(db, MANAGER, () => scalarOn(db, 'select count(*)::int as value from public.order_artwork_proposals')), 0);
  assert.equal(await asUser(db, TEAM, () => scalarOn(db, 'select count(*)::int as value from public.order_artwork_proposals')), 0);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot read the table', 'select count(*) from public.order_artwork_proposals', [], '42501');
  await identityOn(db);
  pass('the service key inserts a pending row with the snapshots; the phone cannot insert or update; the owner reads it, a manager and the crew see nothing, anon is refused');

  // ── the owner signs a pending file's paths; nobody else does ──
  assert.equal(await canReadAs(db, OWNER, row.preview_path), true);
  assert.equal(await canReadAs(db, OWNER, row.original_path), true);
  assert.equal(await canReadAs(db, MANAGER, row.preview_path), false);
  assert.equal(await canReadAs(db, TEAM, row.preview_path), false);
  assert.equal(await canReadAs(db, STALE, row.preview_path), false);
  pass('hc_can_read_order_logo: the owner signs a pending proposal\'s preview and original; a manager, the crew and an inactive login do not');

  // ── the unique keys ──
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'unique (order_id, sha256) rejects the same bytes twice for one order (23505)',
    "insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, verdict, sender_kind, source_received_at) values ($1, $2, 'att-dup', 'again.png', 'image/png', $3, 10, 'again.png', 'again-preview.png', 'ready', 'customer', now())",
    [intakeEmpty, ORDER.empty, row.sha256], '23505', /order_artwork_proposals_order_sha256_key/);
  await deniedOn(db, 'unique (intake_id, attachment_id) rejects the same attachment twice (23505)',
    "insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, verdict, sender_kind, source_received_at) values ($1, $2, $3, 'again.png', 'image/png', $4, 10, 'again.png', 'again-preview.png', 'ready', 'customer', now())",
    [intakeEmpty, ORDER.empty, row.attachment_id, hex(0x9998)], '23505', /order_artwork_proposals_intake_attachment_key/);
  // The pass inserts with Prefer: resolution=ignore-duplicates: zero rows back.
  const ignored = await rowsOn(db,
    "insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, verdict, sender_kind, source_received_at) values ($1, $2, 'att-dup', 'again.png', 'image/png', $3, 10, 'again.png', 'again-preview.png', 'ready', 'customer', now()) on conflict do nothing returning id",
    [intakeEmpty, ORDER.empty, row.sha256]);
  assert.equal(ignored.length, 0);
  await identityOn(db);
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_artwork_proposals')), 1);
  // The same bytes on a DIFFERENT order are a fresh row (a repeat customer).
  const intakeRepeat = await newIntake(db, ORDER.doomed);
  const propRepeat = await propose(db, intakeRepeat, ORDER.doomed, { sha256: row.sha256 });
  assert.ok(propRepeat > propEmpty);
  pass('unique (order_id, sha256) and unique (intake_id, attachment_id) refuse duplicates; an ignore-duplicates insert answers zero rows; the same bytes on another order are a fresh row');

  // ── the check constraints hold whoever writes (the service key here) ──
  const bad = (fields) => {
    const base = { intake_id: intakeEmpty, order_id: ORDER.empty, attachment_id: 'att-bad', file_name: 'bad.png', mime_type: 'image/png', sha256: hex(0x8000), size_bytes: 10, original_path: 'bad.png', preview_path: 'bad-preview.png', verdict: 'ready', sender_kind: 'customer', status: 'pending', decided_at: null, decided_via: null, usage_written: null, warnings: '[]', page_count: null, ...fields };
    return ['insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, verdict, sender_kind, status, decided_at, decided_via, usage_written, warnings, page_count, source_received_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15, $16::jsonb, $17, now())',
      [base.intake_id, base.order_id, base.attachment_id, base.file_name, base.mime_type, base.sha256, base.size_bytes, base.original_path, base.preview_path, base.verdict, base.sender_kind, base.status, base.decided_at, base.decided_via, base.usage_written, base.warnings, base.page_count]];
  };
  await identityOn(db, { role: 'service_role' });
  for (const [label, fields, re] of [
    ['a ready row without a preview path', { preview_path: null }, /verdict_preview_check/],
    ['a no_preview row with a preview path', { verdict: 'no_preview' }, /verdict_preview_check/],
    ['a too_large row with an original path', { verdict: 'too_large', preview_path: null }, /verdict_original_check/],
    ['a fetch_failed row with a preview path', { verdict: 'fetch_failed', original_path: null }, /verdict_preview_check/],
    ['a used row with no decided_at', { status: 'used', decided_via: 'app' }, /decided_check/],
    ['a pending row with a decided_at', { decided_at: '2026-09-21T12:00:00Z' }, /decided_check/],
    ['an upper-case sha256', { sha256: hex(0xabcdef).toUpperCase() }, /sha256_check/],
    ['a 63 character sha256', { sha256: hex(0x8002).slice(1) }, /sha256_check/],
    ['a size over the 25 MB cap', { size_bytes: 25000001 }, /size_bytes_check/],
    ['a zero size', { size_bytes: 0 }, /size_bytes_check/],
    ['a traversal original path', { original_path: '../bad.png' }, /original_path_check/],
    ['a 501 character original path', { original_path: 'a'.repeat(497) + '.png' }, /original_path_check/],
    ['a double-slash original path', { original_path: 'a//bad.png' }, /original_path_check/],
    ['a leading-slash original path', { original_path: '/bad.png' }, /original_path_check/],
    ['a dot segment original path', { original_path: 'a/./bad.png' }, /original_path_check/],
    ['a preview path that is not a -preview.png', { preview_path: 'other.png' }, /preview_path_check/],
    ['a PDF whose preview path is its own original', { mime_type: 'application/pdf', original_path: 'bad.pdf', preview_path: 'bad.pdf' }, /preview_path_check/],
    // The pass never writes a raster original as its own preview (a raster
    // that could not be shrunk is no_preview with preview_path null; the
    // app draws the original by itself), so the check refuses it too.
    ['a PNG whose preview path is its own original', { original_path: 'self.png', preview_path: 'self.png' }, /preview_path_check/],
    ['a control character in the file name', { file_name: 'bad\tname.png' }, /file_name_check/],
    ['an empty file name', { file_name: '' }, /file_name_check/],
    ['a mime type outside the six', { mime_type: 'image/gif' }, /mime_type_check/],
    ['a verdict outside the four', { verdict: 'maybe' }, /verdict_check/],
    ['a sender kind outside the three', { sender_kind: 'vendor' }, /sender_kind_check/],
    ['a status outside the four', { status: 'kept' }, /status_check/],
    ['a decided_via outside the six', { status: 'declined', decided_at: '2026-09-21T12:00:00Z', decided_via: 'owner_edit' }, /decided_via_check/],
    ['a usage word outside the five', { usage_written: 'Logo' }, /usage_written_check/],
    ['warnings that are not an array', { warnings: '{}' }, /warnings_check/],
    ['a page count of 3', { page_count: 3 }, /page_count_check/],
  ]) {
    const [sql, params] = bad(fields);
    await deniedOn(db, 'the check refuses ' + label, sql, params, '23514', re);
  }
  // A raster the pass could not shrink: no_preview, original only, the
  // shape the pass writes (never preview_path = original_path).
  const [rasterSql, rasterParams] = bad({ attachment_id: 'att-raster', original_path: 'self.png', preview_path: null, verdict: 'no_preview', sha256: hex(0x8003) });
  const rasterNoPreview = await scalarOn(db, rasterSql + ' returning id as value', rasterParams);
  assert.ok(rasterNoPreview > 0);
  await q(db, 'delete from public.order_artwork_proposals where id = $1', [rasterNoPreview]);
  await deniedOn(db, 'the email_meta check refuses an array', "update public.intake_messages set email_meta = '[]'::jsonb where id = $1", [intakeEmpty], '23514', /email_meta_object/);
  await q(db, "update public.intake_messages set email_meta = $2::jsonb where id = $1", [intakeEmpty, JSON.stringify({ internet_message_id: '<fake@example.invalid>', sender_name: 'Fake Sheeley', to: ['sidd@example.invalid'], cc: [], attachments: [{ id: 'att-1', name: 'SIENNA BEACH V1 BLUE WITH PINK.ps', content_type: 'application/postscript', size: 12345, inline: false }] })]);
  await identityOn(db);
  assert.equal((await intakeOf(db, intakeEmpty)).email_meta.sender_name, 'Fake Sheeley');
  pass('every check constraint holds for the service key; a preview is always a ...-preview.png (a raster the pass could not shrink is no_preview with the original only); email_meta must be an object');

  // ── the headline case: Use it on an empty card ──
  const emptyIntakeBefore = await intakeOf(db, intakeEmpty);
  assert.equal(emptyIntakeBefore.status, 'pending_review');
  let out = await decideAs(db, OWNER, ORDER.empty, propEmpty, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 1 });
  let o = await orderOf(db, ORDER.empty);
  assert.equal(o.logo_received, true, 'the legacy flag is set (decision 4)');
  assert.equal(o.logo_url, null, 'logo_url is never touched');
  assert.equal(o.logo_asset.status, 'approved', 'a single new file on an empty card reads approved at once');
  assert.ok(ISO_MS_Z.test(o.logo_asset.checked_at), 'checked_at is printed as the imports print it: ' + o.logo_asset.checked_at);
  assert.ok(seconds(o.logo_asset.checked_at, Date.now()) < 60);
  assert.deepEqual(o.logo_asset.source_ref, { kind: 'email', message_ids: ['fake-048-1'] });
  assert.equal(o.logo_asset.source_received_at, '2026-08-22T14:03:11Z');
  assert.deepEqual(Object.keys(o.logo_asset).sort(), ['checked_at', 'files', 'source_ref', 'source_received_at', 'status'].sort());
  assert.equal(o.logo_asset.files.length, 1);
  const f = o.logo_asset.files[0];
  assert.deepEqual(Object.keys(f).sort(), [...IMPORT_KEYS, 'approved_at', 'approved_by'].sort(), 'exactly the import keys plus approved_at and approved_by');
  assert.equal(f.usage, 'Coconut'); assert.equal(f.sha256, row.sha256); assert.deepEqual(f.warnings, []);
  assert.equal(f.file_name, 'SIENNA BEACH V1 BLUE WITH PINK.ps'); assert.equal(f.mime_type, 'application/postscript'); assert.equal(f.size_bytes, 12345);
  assert.deepEqual(f.source_ref, { kind: 'email', message_id: 'fake-048-1' });
  assert.equal(f.preview_path, row.preview_path); assert.equal(f.original_path, row.original_path);
  assert.equal(f.preview_sha256, row.preview_sha256); assert.equal(f.preview_size_bytes, 4567);
  assert.equal(f.source_received_at, '2026-08-22T14:03:11Z'); assert.equal(f.attachment_listed_size_bytes, 12345);
  assert.equal(f.approved_at, o.logo_asset.checked_at); assert.equal(f.approved_by, OWNER.authUserId);
  assert.ok(new Date(o.updated_at).getTime() > new Date(emptyBefore.updated_at).getTime(), 'updated_at bumped');
  assert.deepEqual(stillOf(o, ['logo_asset', 'logo_received', 'updated_at']), stillOf(emptyBefore, ['logo_asset', 'logo_received', 'updated_at']), 'nothing else on the order moved');
  row = await rowOf(db, propEmpty);
  assert.equal(row.status, 'used'); assert.equal(row.decided_via, 'app'); assert.equal(row.usage_written, 'Coconut');
  assert.equal(row.decided_by, OWNER.authUserId); assert.ok(seconds(row.decided_at, Date.now()) < 60);
  const emptyIntakeAfter = await intakeOf(db, intakeEmpty);
  assert.equal(emptyIntakeAfter.status, 'dismissed');
  assert.equal(emptyIntakeAfter.error_detail, 'artwork proposal used by the owner in HC Field');
  assert.ok(seconds(emptyIntakeAfter.reviewed_at, Date.now()) < 60);
  // The 035 check still holds (the record is an object) and the 036
  // identity reads the five keys.
  assert.equal(await asPostgres(db, () => scalarOn(db, "select jsonb_typeof(logo_asset) as value from public.orders where id = $1", [ORDER.empty])), 'object');
  const identity = await asPostgres(db, () => scalarOn(db, 'select public.hc_order_prep_artwork_identity(logo_asset) as value from public.orders where id = $1', [ORDER.empty]));
  assert.deepEqual(identity.files[0], { file_name: f.file_name, mime_type: f.mime_type, original_path: f.original_path, preview_path: f.preview_path, usage: 'Coconut' });
  pass('Use it on an empty card: logo_asset in the 035 shape with exactly the import keys plus approved_at and approved_by, usage Coconut, status approved, checked_at now (ms, Z), logo_received true, logo_url untouched; the row is used/app with usage_written Coconut; the intake row is dismissed with the exact note');

  // ── the crew projection never carries the owner-only keys ──
  const crewRows = await asUser(db, TEAM, () => rowsOn(db, 'select public.hc_list_orders_for_current_user(null, null, null, 0, 500) as value'));
  const crewEmpty = crewRows.map(r => r.value).find(r => r.id === ORDER.empty);
  assert.ok(crewEmpty, 'the NY crew see the NY order');
  assert.deepEqual(Object.keys(crewEmpty.logo_asset).sort(), ['checked_at', 'files', 'source_received_at', 'status']);
  assert.deepEqual(Object.keys(crewEmpty.logo_asset.files[0]).sort(), ['file_name', 'mime_type', 'original_path', 'preview_path', 'usage']);
  assert.equal(crewEmpty.logo_received, true);
  assert.equal(JSON.stringify(crewEmpty).includes('approved_'), false);
  assert.equal(JSON.stringify(crewEmpty).includes('source_ref'), false);
  assert.equal(JSON.stringify(crewEmpty).includes(row.sha256), false);
  // And the crew can now sign the new card file (035 rule), the owner too.
  assert.equal(await canReadAs(db, TEAM, f.preview_path), true);
  assert.equal(await canReadAs(db, OWNER, f.original_path), true);
  pass('after Use it the crew projection (035) carries status, checked_at, source_received_at and the five file keys only: never approved_at, approved_by, source_ref or a hash; the crew sign the new card file');

  // ── a second decision on the same row ──
  const usedRow = await rowOf(db, propEmpty);
  const usedOrder = await orderOf(db, ORDER.empty);
  out = await decideAs(db, OWNER, ORDER.empty, propEmpty, 'use');
  assert.equal(out.applied, false); assert.equal(out.outcome, 'used'); assert.equal(out.message, 'Already decided.');
  out = await decideAs(db, OWNER, ORDER.empty, propEmpty, 'skip');
  assert.equal(out.applied, false); assert.equal(out.outcome, 'used'); assert.equal(out.message, 'Already decided.');
  assert.deepEqual(await rowOf(db, propEmpty), usedRow);
  assert.deepEqual(await orderOf(db, ORDER.empty), usedOrder, 'a second tap rewrites nothing');
  pass('a second decision on a decided row answers applied false, "Already decided.", and rewrites nothing');

  // ── Use it beside an unapproved older file keeps received ──
  const intakeHand = await newIntake(db, ORDER.hand);
  const propHand = await propose(db, intakeHand, ORDER.hand, { file_name: 'logo-v2.png' });
  const handBefore = await orderOf(db, ORDER.hand);
  assert.equal(handBefore.logo_asset.files.length, 1);
  out = await decideAs(db, OWNER, ORDER.hand, propHand, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 2 });
  o = await orderOf(db, ORDER.hand);
  assert.equal(o.logo_asset.status, 'received', 'the older hand import has no approved_at, so the record stays received');
  assert.equal(o.logo_asset.files.length, 2);
  assert.deepEqual(o.logo_asset.files[0], handBefore.logo_asset.files[0], 'the older file is kept byte for byte (no inherited approval)');
  assert.equal(o.logo_asset.files[1].usage, 'Coconut'); assert.ok(ISO_MS_Z.test(o.logo_asset.files[1].approved_at));
  assert.deepEqual(o.logo_asset.source_ref.message_ids, ['AAMk-fake-hand', 'fake-048-3'], 'the email id is appended distinct');
  assert.equal(o.logo_asset.source_received_at, '2026-08-22T14:03:11Z', 'the newer of the two received stamps (equal here)');
  assert.notEqual(o.logo_asset.checked_at, handBefore.logo_asset.checked_at, 'checked_at moved (the 036 fingerprint resets on purpose)');
  assert.equal(o.logo_received, true);
  pass('Use it beside an unapproved older file: the file is appended, the older entry is untouched, the record stays received, message_ids append distinct, checked_at moves');

  // ── Use it on a needs_review record keeps needs_review ──
  const intakeReview = await newIntake(db, ORDER.review);
  const propReview = await propose(db, intakeReview, ORDER.review);
  out = await decideAs(db, OWNER, ORDER.review, propReview, 'use');
  assert.equal(out.applied, true);
  o = await orderOf(db, ORDER.review);
  assert.equal(o.logo_asset.status, 'needs_review', 'needs_review is never lifted by a tap');
  assert.equal(o.logo_asset.files.length, 2);
  pass('Use it on a needs_review record appends the file and keeps needs_review');

  // ── Not this one writes nothing to orders ──
  const intakeSkip = await newIntake(db, ORDER.svg);
  const propSkip = await propose(db, intakeSkip, ORDER.svg, { file_name: 'display-logo.png' });
  const svgBefore = await orderOf(db, ORDER.svg);
  out = await decideAs(db, OWNER, ORDER.svg, propSkip, 'skip');
  assert.deepEqual(out, { applied: true, outcome: 'declined', files: 0 });
  assert.deepEqual(await orderOf(db, ORDER.svg), svgBefore, 'the order is byte-identical, updated_at included');
  row = await rowOf(db, propSkip);
  assert.equal(row.status, 'declined'); assert.equal(row.decided_via, 'app'); assert.equal(row.usage_written, null);
  const skipIntake = await intakeOf(db, intakeSkip);
  assert.equal(skipIntake.status, 'dismissed'); assert.equal(skipIntake.error_detail, 'artwork proposal declined by the owner in HC Field');
  // The owner can still re-look at a declined file (30-day window); nobody else.
  assert.equal(await canReadAs(db, OWNER, row.preview_path), true);
  assert.equal(await canReadAs(db, MANAGER, row.preview_path), false);
  // The unique key remembers the refusal for good on this order.
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the declined bytes cannot be proposed again for this order (23505)',
    "insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, verdict, sender_kind, source_received_at) values ($1, $2, 'att-again', 'again.png', 'image/png', $3, 10, 'again.png', 'again-preview.png', 'ready', 'customer', now())",
    [intakeSkip, ORDER.svg, row.sha256], '23505', /order_sha256_key/);
  await identityOn(db);
  pass('Not this one: the row is declined, the order is byte-identical, the intake row is dismissed once with the declined note, the owner can still sign the declined preview, the bytes can never be proposed again for that order');

  // ── the SVG: no preview, Use it still works ──
  const intakeSvg = await newIntake(db, ORDER.svg);
  const propSvg = await propose(db, intakeSvg, ORDER.svg, { file_name: 'logo.svg', mime_type: 'image/svg+xml', verdict: 'no_preview', verdict_note: 'No preview for .svg files' });
  row = await rowOf(db, propSvg);
  assert.equal(row.preview_path, null); assert.ok(row.original_path.endsWith('.svg'));
  assert.equal(await canReadAs(db, OWNER, row.original_path), true);
  out = await decideAs(db, OWNER, ORDER.svg, propSvg, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 1 });
  o = await orderOf(db, ORDER.svg);
  assert.equal(o.logo_asset.files[0].preview_path, null); assert.equal(o.logo_asset.files[0].preview_sha256, null);
  assert.equal(o.logo_asset.files[0].mime_type, 'image/svg+xml'); assert.equal(o.logo_asset.status, 'approved');
  // The intake row was already dismissed by the skip above on a different
  // intake; this one is its own row and is dismissed now.
  assert.equal((await intakeOf(db, intakeSvg)).status, 'dismissed');
  pass('a no_preview file (SVG) goes on the card with a null preview_path; the owner signed its original beforehand');

  // ── two files in one email, decided one by one ──
  const intakeTwo = await newIntake(db, ORDER.two);
  const propFront = await propose(db, intakeTwo, ORDER.two, { file_name: 'front.png' });
  const propBack = await propose(db, intakeTwo, ORDER.two, { file_name: 'back.png' });
  out = await decideAs(db, OWNER, ORDER.two, propBack, 'skip');
  assert.equal(out.applied, true); assert.equal(out.outcome, 'declined');
  assert.equal((await intakeOf(db, intakeTwo)).status, 'dismissed');
  assert.equal((await intakeOf(db, intakeTwo)).error_detail, 'artwork proposal declined by the owner in HC Field');
  assert.equal((await rowOf(db, propFront)).status, 'pending', 'the second file keeps its own row and its buttons');
  // The front is used AFTER the intake row was dismissed: the guarded
  // dismissal is a no-op, the note stays the first decision's.
  out = await decideAs(db, OWNER, ORDER.two, propFront, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 1 });
  assert.equal((await intakeOf(db, intakeTwo)).error_detail, 'artwork proposal declined by the owner in HC Field', 'the intake row is dismissed once; a later decision on the same email does not rewrite it');
  assert.equal((await orderOf(db, ORDER.two)).logo_asset.files[0].file_name, 'front.png');
  pass('two files in one email: Not this one on the back dismisses the email, the front keeps its own row, Use it on it then lands and the intake note is not rewritten');

  // ── three files in one email the worker has NOT read yet: Use it, then Use it ──
  // The pass makes the rows about 3 minutes after the email; the worker's
  // tick (reply scan, time and address scan) comes every 5. A tap in that
  // window must not hide the email from those scans, and the first Use it
  // must not make the second file unusable (plan 9: "the second row stands
  // with its own buttons").
  const intakeThree = await newIntake(db, ORDER.three, { scanned: false });
  const propFrontB = await propose(db, intakeThree, ORDER.three, { file_name: 'front.png' });
  const propBackB = await propose(db, intakeThree, ORDER.three, { file_name: 'back.png' });
  const propDisplay = await propose(db, intakeThree, ORDER.three, { file_name: 'display.png' });
  const otherPendingBefore = await rowOf(db, propRepeat);
  assert.equal(otherPendingBefore.status, 'pending', 'a pending row on another order stands beside this scenario');
  // Not this one on the display logo before the worker's tick.
  out = await decideAs(db, OWNER, ORDER.three, propDisplay, 'skip');
  assert.deepEqual(out, { applied: true, outcome: 'declined', files: 0 });
  assert.equal((await rowOf(db, propDisplay)).status, 'declined');
  let threeIntake = await intakeOf(db, intakeThree);
  assert.equal(threeIntake.status, 'pending_review', 'an email the worker has not read is never dismissed by an artwork decision');
  assert.equal(threeIntake.reviewed_at, null); assert.equal(threeIntake.error_detail, null);
  pass('dismissal window: Not this one on an email the worker has not read yet declines the row and leaves the intake row pending_review (the reply scan and the time and address scan still get to read it)');
  // Use it on the front, still before the worker's tick.
  const backBefore = await rowOf(db, propBackB);
  assert.equal(backBefore.card_checked_at_snapshot, null); assert.equal(backBefore.card_files_at_scan, 0);
  out = await decideAs(db, OWNER, ORDER.three, propFrontB, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 1 });
  o = await orderOf(db, ORDER.three);
  assert.equal(o.logo_asset.files.length, 1); assert.equal(o.logo_asset.status, 'approved');
  assert.equal((await intakeOf(db, intakeThree)).status, 'pending_review', 'Use it on an unread email: the file lands, the intake row still waits for the worker');
  const backAfter = await rowOf(db, propBackB);
  assert.equal(backAfter.status, 'pending', 'the sibling keeps its own row and its buttons');
  assert.equal(backAfter.card_checked_at_snapshot, o.logo_asset.checked_at, 'the sibling snapshot is re-taken to the checked_at the tap wrote (the worker retire step and the app compare exactly these two)');
  assert.equal(backAfter.card_files_at_scan, 1, 'the sibling now says the card has 1 file');
  assert.ok(new Date(backAfter.updated_at).getTime() > new Date(backBefore.updated_at).getTime());
  assert.deepEqual(stillOf(backAfter, ['card_checked_at_snapshot', 'card_files_at_scan', 'updated_at']), stillOf(backBefore, ['card_checked_at_snapshot', 'card_files_at_scan', 'updated_at']), 'nothing else on the sibling moved');
  assert.equal((await rowOf(db, propDisplay)).card_checked_at_snapshot, null, 'a decided sibling is not re-snapshotted');
  assert.deepEqual(await rowOf(db, propRepeat), otherPendingBefore, 'a pending row on another order is untouched');
  pass('Use it re-takes the card snapshot of every other PENDING row for the order in the same transaction: a front and a back in one email can both be used (plan 3D and 5b read literally would refuse the second as artwork_changed for good)');
  // The worker's tick reads the email; Use it on the back then lands and
  // dismisses the email with the used note.
  await workerReads(db, intakeThree);
  out = await decideAs(db, OWNER, ORDER.three, propBackB, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 2 });
  o = await orderOf(db, ORDER.three);
  assert.deepEqual(o.logo_asset.files.map((x) => x.file_name), ['front.png', 'back.png']);
  assert.equal(o.logo_asset.status, 'approved', 'both files carry approved_at');
  assert.ok(o.logo_asset.files.every((x) => ISO_MS_Z.test(x.approved_at)));
  threeIntake = await intakeOf(db, intakeThree);
  assert.equal(threeIntake.status, 'dismissed'); assert.equal(threeIntake.error_detail, 'artwork proposal used by the owner in HC Field');
  assert.ok(seconds(threeIntake.reviewed_at, Date.now()) < 60);
  pass('use then use: the second Use it lands (files 2, both approved); once the worker has read the email the decision dismisses the intake row with the used note');

  // ── who may call ──
  const intakeWho = await newIntake(db, ORDER.eventonly);
  const propWho = await propose(db, intakeWho, ORDER.eventonly);
  const whoRow = await rowOf(db, propWho);
  const whoOrder = await orderOf(db, ORDER.eventonly);
  for (const [label, who] of [['a manager', MANAGER], ['a team member', TEAM], ['an inactive login', STALE]]) {
    await identityOn(db, { role: 'authenticated', sub: who.authUserId });
    await deniedOn(db, `${label} cannot decide an artwork proposal`, DECIDE_SQL, [ORDER.eventonly, propWho, 'use'], '42501', /only the owner/);
    await deniedOn(db, `${label} cannot approve artwork`, APPROVE_SQL, [ORDER.hand, 'x'], '42501', /only the owner/);
  }
  await identityOn(db, { role: 'authenticated' });
  await deniedOn(db, 'a login with no auth uid cannot decide', DECIDE_SQL, [ORDER.eventonly, propWho, 'use'], '42501', /authenticated field worker required/);
  await deniedOn(db, 'a login with no auth uid cannot approve', APPROVE_SQL, [ORDER.hand, 'x'], '42501', /authenticated field worker required/);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'anon cannot even call the decide function', DECIDE_SQL, [ORDER.eventonly, propWho, 'use'], '42501', /permission denied for function/);
  await deniedOn(db, 'anon cannot even call the approve function', APPROVE_SQL, [ORDER.hand, 'x'], '42501', /permission denied for function/);
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'the service key cannot call the decide function (execute revoked)', DECIDE_SQL, [ORDER.eventonly, propWho, 'use'], '42501', /permission denied for function/);
  await deniedOn(db, 'the service key cannot call the approve function (execute revoked)', APPROVE_SQL, [ORDER.hand, 'x'], '42501', /permission denied for function/);
  await identityOn(db);
  assert.deepEqual(await rowOf(db, propWho), whoRow);
  assert.deepEqual(await orderOf(db, ORDER.eventonly), whoOrder);
  pass('refused callers never touch the row or the order');

  // ── malformed calls ──
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'an unknown decision is refused', DECIDE_SQL, [ORDER.eventonly, propWho, 'accept'], '22023', /decision must be use, skip or dismiss/);
  await deniedOn(db, 'a null decision is refused', DECIDE_SQL, [ORDER.eventonly, propWho, null], '22023', /decision must be use, skip or dismiss/);
  await deniedOn(db, 'a null order id is refused', DECIDE_SQL, [null, propWho, 'use'], '22023', /order id and a proposal id/);
  await deniedOn(db, 'a null proposal id is refused', DECIDE_SQL, [ORDER.eventonly, null, 'use'], '22023', /order id and a proposal id/);
  await deniedOn(db, 'a proposal id on the wrong order is a clear 22023', DECIDE_SQL, [ORDER.empty, propWho, 'use'], '22023', /No such artwork proposal/);
  await deniedOn(db, 'an unknown proposal id is a clear 22023', DECIDE_SQL, [ORDER.eventonly, 999999, 'use'], '22023', /No such artwork proposal/);
  await deniedOn(db, 'approve with a null order id is refused', APPROVE_SQL, [null, 'x'], '22023', /order id is required/);
  await deniedOn(db, 'approve on an unknown order is a clear 22023', APPROVE_SQL, ['30000000-0000-4000-8000-000000000099', 'x'], '22023', /No such order/);
  await deniedOn(db, 'approve on an order with no artwork is a clear 22023', APPROVE_SQL, [ORDER.eventonly, 'x'], '22023', /No artwork on this order/);
  await identityOn(db);
  assert.deepEqual(await rowOf(db, propWho), whoRow);
  pass('malformed calls raise 22023 and change nothing');
  // The event-only order (no delivery marker): the day comes from event_start_at, and Use it lands.
  out = await decideAs(db, OWNER, ORDER.eventonly, propWho, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 1 });
  pass('an order with no delivery marker takes its day from event_start_at and Use it lands');

  // ── cancelled, past day, invoice changed, card changed ──
  const intakeCancelled = await newIntake(db, ORDER.cancelled);
  const propCancelled = await propose(db, intakeCancelled, ORDER.cancelled);
  const cancelledBefore = await orderOf(db, ORDER.cancelled);
  out = await decideAs(db, OWNER, ORDER.cancelled, propCancelled, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'cancelled', message: 'This order is cancelled.' });
  row = await rowOf(db, propCancelled);
  assert.equal(row.status, 'superseded'); assert.equal(row.decided_via, 'cancelled'); assert.equal(row.decided_by, OWNER.authUserId);
  assert.deepEqual(await orderOf(db, ORDER.cancelled), cancelledBefore);
  assert.equal((await intakeOf(db, intakeCancelled)).status, 'pending_review', 'a retirement is not a decision: the intake row is left alone');
  pass('a cancelled order: superseded/cancelled, "This order is cancelled.", the order untouched');

  const intakePast = await newIntake(db, ORDER.past);
  const propPast = await propose(db, intakePast, ORDER.past);
  out = await decideAs(db, OWNER, ORDER.past, propPast, 'skip');
  assert.deepEqual(out, { applied: false, outcome: 'superseded', message: 'The delivery day has passed.' });
  row = await rowOf(db, propPast);
  assert.equal(row.status, 'superseded'); assert.equal(row.decided_via, 'date_passed');
  pass('a delivery day that has passed (even on a skip): superseded/date_passed, "The delivery day has passed."');

  const intakeInvoice = await newIntake(db, ORDER.invoice);
  const propInvoice = await propose(db, intakeInvoice, ORDER.invoice);
  await setOrder(db, ORDER.invoice, 'external_invoice_id = $2', ['FAKE-2108-B']);
  const invoiceBefore = await orderOf(db, ORDER.invoice);
  out = await decideAs(db, OWNER, ORDER.invoice, propInvoice, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'superseded', message: 'The invoice on this order changed after this email.' });
  row = await rowOf(db, propInvoice);
  assert.equal(row.status, 'superseded'); assert.equal(row.decided_via, 'invoice_changed');
  assert.deepEqual(await orderOf(db, ORDER.invoice), invoiceBefore);
  pass('an invoice that changed since the scan: superseded/invoice_changed, "The invoice on this order changed after this email."');

  const intakeMoved = await newIntake(db, ORDER.moved);
  const propMoved = await propose(db, intakeMoved, ORDER.moved);
  const propMovedSkip = await propose(db, intakeMoved, ORDER.moved, { attachment_id: 'att-moved-2' });
  // A hand edit moves checked_at after the scan.
  await asServiceRole(db, () => q(db, "update public.orders set logo_asset = logo_asset || jsonb_build_object('checked_at', '2026-09-21T15:00:00.000Z') where id = $1", [ORDER.moved]));
  const movedBefore = await orderOf(db, ORDER.moved);
  out = await decideAs(db, OWNER, ORDER.moved, propMoved, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'superseded', message: 'The artwork on the card changed since this email was read. Open the Calendar.' });
  row = await rowOf(db, propMoved);
  assert.equal(row.status, 'superseded'); assert.equal(row.decided_via, 'artwork_changed');
  assert.deepEqual(await orderOf(db, ORDER.moved), movedBefore);
  // A skip on the other file of the same email is a plain decline: the
  // card's state does not matter for Not this one.
  out = await decideAs(db, OWNER, ORDER.moved, propMovedSkip, 'skip');
  assert.deepEqual(out, { applied: true, outcome: 'declined', files: 1 });
  pass('a card whose artwork changed since the scan: Use it is superseded/artwork_changed with the Calendar sentence, the order untouched; Not this one still declines');

  // ── the same bytes already on the card ──
  const intakeDup = await newIntake(db, ORDER.dup);
  const propDupOriginal = await propose(db, intakeDup, ORDER.dup, { sha256: SHA.dup });
  const propDupPreview = await propose(db, intakeDup, ORDER.dup, { sha256: SHA.dupPreview, attachment_id: 'att-dup-preview' });
  const dupBefore = await orderOf(db, ORDER.dup);
  out = await decideAs(db, OWNER, ORDER.dup, propDupOriginal, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'used', message: 'Already on the card.' });
  row = await rowOf(db, propDupOriginal);
  assert.equal(row.status, 'used'); assert.equal(row.decided_via, 'already_on_card'); assert.equal(row.usage_written, null);
  assert.deepEqual(await orderOf(db, ORDER.dup), dupBefore, 'logo_asset byte-identical');
  assert.equal((await intakeOf(db, intakeDup)).status, 'dismissed');
  out = await decideAs(db, OWNER, ORDER.dup, propDupPreview, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'used', message: 'Already on the card.' });
  assert.equal((await rowOf(db, propDupPreview)).decided_via, 'already_on_card');
  assert.deepEqual(await orderOf(db, ORDER.dup), dupBefore, 'a match on preview_sha256 is a duplicate too');
  pass('bytes already on the card (as an original or as a preview): "Already on the card.", the row closes as used/already_on_card, logo_asset is byte-identical, the intake row is dismissed');

  // ── twelve files on the card ──
  const intakeFull = await newIntake(db, ORDER.full);
  const propFull = await propose(db, intakeFull, ORDER.full);
  const fullBefore = await orderOf(db, ORDER.full);
  assert.equal(fullBefore.logo_asset.files.length, 12);
  out = await decideAs(db, OWNER, ORDER.full, propFull, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'refused', message: 'This card already holds 12 files. Remove one by hand first.' });
  assert.equal((await rowOf(db, propFull)).status, 'pending', 'the row is left for the owner');
  assert.deepEqual(await orderOf(db, ORDER.full), fullBefore);
  assert.equal((await intakeOf(db, intakeFull)).status, 'pending_review');
  pass('twelve files on the card: refused with the exact sentence, the row stays pending, nothing written');

  // ── nothing was saved: Use it is refused, Dismiss declines ──
  const intakeFailed = await newIntake(db, ORDER.failed);
  const propTooLarge = await propose(db, intakeFailed, ORDER.failed, { verdict: 'too_large', verdict_note: 'file is 31 MB, cap 25 MB', size_bytes: 25000000 });
  const propFetchFailed = await propose(db, intakeFailed, ORDER.failed, { verdict: 'fetch_failed', verdict_note: 'Graph 404 after 24 h', attachment_id: 'att-gone' });
  const failedBefore = await orderOf(db, ORDER.failed);
  out = await decideAs(db, OWNER, ORDER.failed, propTooLarge, 'use');
  assert.deepEqual(out, { applied: false, outcome: 'refused', message: 'Nothing was saved from this email. Get the file another way, then Dismiss.' });
  assert.equal((await rowOf(db, propTooLarge)).status, 'pending');
  out = await decideAs(db, OWNER, ORDER.failed, propTooLarge, 'dismiss');
  assert.deepEqual(out, { applied: true, outcome: 'declined', files: 0 });
  assert.equal((await rowOf(db, propTooLarge)).status, 'declined');
  out = await decideAs(db, OWNER, ORDER.failed, propFetchFailed, 'use');
  assert.equal(out.applied, false); assert.equal(out.outcome, 'refused');
  out = await decideAs(db, OWNER, ORDER.failed, propFetchFailed, 'dismiss');
  assert.equal(out.outcome, 'declined');
  assert.deepEqual(await orderOf(db, ORDER.failed), failedBefore, 'nothing was written to the order');
  assert.equal((await intakeOf(db, intakeFailed)).status, 'dismissed');
  // A failed row has no paths, so nobody can sign anything for it.
  assert.equal((await rowOf(db, propTooLarge)).original_path, null);
  pass('too_large and fetch_failed rows: Use it is refused with the exact sentence, Dismiss declines them, the order is untouched');

  // ── Approve artwork ──
  const handNow = await orderOf(db, ORDER.hand);
  assert.equal(handNow.logo_asset.status, 'received');
  // The hand import's free-text usage blocks approval until it is PATCHed
  // to 'Coconut' (plan section 3 J, G0).
  out = await approveAs(db, OWNER, ORDER.hand, handNow.logo_asset.checked_at);
  assert.deepEqual(out, { applied: false, outcome: 'incomplete', message: 'Every file needs a usage word before approval.' });
  assert.deepEqual(await orderOf(db, ORDER.hand), handNow);
  // Compare-and-set: a stale checked_at is refused before anything else.
  out = await approveAs(db, OWNER, ORDER.hand, '2026-09-17T20:00:00.000Z');
  assert.deepEqual(out, { applied: false, outcome: 'changed', message: 'The artwork on the card changed since you looked. Open the Calendar.' });
  out = await approveAs(db, OWNER, ORDER.hand, null);
  assert.equal(out.outcome, 'changed');
  // 'Usage needs confirmation' is refused too.
  const unlabelledBefore = await orderOf(db, ORDER.unlabelled);
  out = await approveAs(db, OWNER, ORDER.unlabelled, unlabelledBefore.logo_asset.checked_at);
  assert.deepEqual(out, { applied: false, outcome: 'incomplete', message: 'Every file needs a usage word before approval.' });
  assert.deepEqual(await orderOf(db, ORDER.unlabelled), unlabelledBefore);
  // needs_review is refused.
  const reviewNow = await orderOf(db, ORDER.review);
  out = await approveAs(db, OWNER, ORDER.review, reviewNow.logo_asset.checked_at);
  assert.deepEqual(out, { applied: false, outcome: 'needs_review', message: 'This artwork is marked needs review; fix it by hand first.' });
  assert.deepEqual(await orderOf(db, ORDER.review), reviewNow);
  pass('Approve artwork refuses: a free-text usage and "Usage needs confirmation" (the exact incomplete sentence), a stale checked_at (the exact changed sentence), a needs_review record; nothing is written');
  // The G0 PATCH, then approval lands on every file.
  await asServiceRole(db, () => q(db, "update public.orders set logo_asset = jsonb_set(logo_asset, '{files,0,usage}', '\"Coconut\"') where id = $1", [ORDER.hand]));
  const handPatched = await orderOf(db, ORDER.hand);
  out = await approveAs(db, OWNER, ORDER.hand, handPatched.logo_asset.checked_at);
  assert.equal(out.applied, true); assert.equal(out.outcome, 'approved'); assert.ok(ISO_MS_Z.test(out.checked_at));
  o = await orderOf(db, ORDER.hand);
  assert.equal(o.logo_asset.status, 'approved');
  assert.equal(o.logo_asset.checked_at, out.checked_at, 'the returned checked_at is the new one');
  assert.notEqual(o.logo_asset.checked_at, handPatched.logo_asset.checked_at, 'checked_at moved (the 036 fingerprint resets on purpose)');
  assert.equal(o.logo_asset.files.length, 2);
  assert.equal(o.logo_asset.files[0].approved_at, out.checked_at, 'the hand import gained approved_at now');
  assert.equal(o.logo_asset.files[0].approved_by, OWNER.authUserId);
  assert.equal(o.logo_asset.files[0].usage, 'Coconut');
  assert.deepEqual(stillOf(o.logo_asset.files[0], ['approved_at', 'approved_by']), handPatched.logo_asset.files[0], 'every other key of the older file is kept');
  assert.equal(o.logo_asset.files[1].approved_at, handPatched.logo_asset.files[1].approved_at, 'the file approved by Use it keeps its own stamp');
  assert.deepEqual(stillOf(o.logo_asset, ['status', 'checked_at', 'files']), stillOf(handPatched.logo_asset, ['status', 'checked_at', 'files']));
  assert.equal(o.logo_received, true);
  // Re-run: already approved, nothing moves.
  out = await approveAs(db, OWNER, ORDER.hand, o.logo_asset.checked_at);
  assert.deepEqual(out, { applied: false, outcome: 'approved', message: 'Already approved.' });
  assert.deepEqual(await orderOf(db, ORDER.hand), o, 'a second Approve rewrites nothing');
  // Crew projection after the approve: still the five keys.
  const crewHand = (await asUser(db, TEAM, () => rowsOn(db, 'select public.hc_list_orders_for_current_user(null, null, null, 0, 500) as value'))).map(r => r.value).find(r => r.id === ORDER.hand);
  assert.equal(crewHand.logo_asset.status, 'approved');
  assert.ok(crewHand.logo_asset.files.every(x => Object.keys(x).sort().join() === 'file_name,mime_type,original_path,preview_path,usage'));
  pass('Approve artwork flips received to approved: every file lacking approved_at gets it, the Use it file keeps its stamp, checked_at moves and is returned, logo_received true; a second Approve answers "Already approved." and rewrites nothing; the crew projection stays five keys');

  // ── the 30-day window on the owner's signing clause ──
  const intakeOld = await newIntake(db, ORDER.doomed);
  const oldId = await asServiceRole(db, () => scalarOn(db,
    "insert into public.order_artwork_proposals (intake_id, order_id, attachment_id, file_name, mime_type, sha256, size_bytes, original_path, preview_path, verdict, sender_kind, source_received_at, status, decided_at, decided_via, found_at) values ($1, $2, 'att-old', 'old.png', 'image/png', $3, 10, 'old-logo.png', 'old-logo-preview.png', 'ready', 'customer', now() - interval '40 days', 'declined', now() - interval '31 days', 'app', now() - interval '40 days') returning id as value",
    [intakeOld, ORDER.doomed, hex(0x3001)]));
  assert.ok(oldId > 0);
  assert.equal(await canReadAs(db, OWNER, 'old-logo-preview.png'), false, 'declined 31 days ago: not even the owner');
  assert.equal(await canReadAs(db, OWNER, 'old-logo.png'), false);
  await asServiceRole(db, () => q(db, "update public.order_artwork_proposals set decided_at = now() - interval '29 days' where id = $1", [oldId]));
  assert.equal(await canReadAs(db, OWNER, 'old-logo-preview.png'), true, 'declined 29 days ago: the owner can re-look');
  assert.equal(await canReadAs(db, MANAGER, 'old-logo-preview.png'), false);
  pass('the owner\'s signing clause: a declined file is readable to the owner for 30 days and to nobody after, never to a manager');

  // ── re-run of the migration with rows present ──
  const pendingCountBefore = await asPostgres(db, () => scalarOn(db, "select count(*)::int as value from public.order_artwork_proposals where status = 'pending'"));
  assert.ok(pendingCountBefore >= 2);
  const rowsBefore = await asPostgres(db, () => rowsOn(db, 'select to_jsonb(p) as value from public.order_artwork_proposals as p order by id'));
  const handBeforeRerun = await orderOf(db, ORDER.hand);
  await db.exec(migration);
  assert.deepEqual(await asPostgres(db, () => rowsOn(db, 'select to_jsonb(p) as value from public.order_artwork_proposals as p order by id')), rowsBefore, 'every row survives the re-run');
  assert.deepEqual(await orderOf(db, ORDER.hand), handBeforeRerun);
  assert.equal(await helperSrc(db), src048);
  assert.equal(await canExecute(db, 'service_role', DECIDE_SIG), false);
  assert.equal(await canExecute(db, 'anon', APPROVE_SIG), false);
  assert.equal(await bucketCap(db), '25000000');
  assert.equal((await intakeOf(db, intakeEmpty)).email_meta.sender_name, 'Fake Sheeley', 'email_meta survives');
  pass('a re-run with rows present is harmless: rows, orders, the helper text, grants, the cap and email_meta unchanged');

  // ── the cascade ──
  await asPostgres(db, () => q(db, 'delete from public.orders where id = $1', [ORDER.doomed]));
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.order_artwork_proposals where order_id = $1', [ORDER.doomed])), 0);
  pass('deleting an order cascades its artwork rows away');

  // ── rollback refuses while a row is pending ──
  await refusesOn(db, 'rollback refuses while artwork proposals are pending', rollback, '55000', /artwork proposal\(s\) are pending/);
  assert.equal(await tableCount(db), 1); assert.equal(await fnCount(db, 'hc_decide_proposed_artwork'), 1);
  assert.equal(await columnType(db, 'email_meta'), 'jsonb');
  assert.equal(await helperSrc(db), src048);
  pass('a refused rollback leaves the table, the functions, the columns and the helper in place');
  // The owner decides the rest (the full card gets Not this one).
  for (const p of await asPostgres(db, () => rowsOn(db, "select id, order_id from public.order_artwork_proposals where status = 'pending'"))) {
    out = await decideAs(db, OWNER, p.order_id, p.id, 'skip');
    assert.equal(out.applied, true, 'pending row ' + p.id);
  }
  // ── rollback refuses while a used row's file is still on a card ──
  await refusesOn(db, 'rollback refuses while used rows still have their file on a card', rollback, '55000', /used artwork proposal\(s\) still have their file on a card/);
  assert.equal(await tableCount(db), 1);
  // The hand undo (decision 11): the owner takes the files off the cards,
  // here by clearing the records the taps built.
  const dismissedBefore = await asPostgres(db, () => scalarOn(db, "select count(*)::int as value from public.intake_messages where status = 'dismissed'"));
  const onCard = await asPostgres(db, () => rowsOn(db, "select distinct order_id from public.order_artwork_proposals where status = 'used'"));
  assert.ok(onCard.length >= 5);
  for (const p of onCard) await setOrder(db, p.order_id, 'logo_asset = null, logo_received = false');
  pass('rollback refuses while a Use it file is still on a card; taking the files off the cards by hand clears the refusal');

  // ── rollback, twice, then re-apply ──
  for (const sql of [rollback, rollback]) await db.exec(sql);
  assert.equal(await tableCount(db), 0);
  assert.equal(await fnCount(db, 'hc_decide_proposed_artwork'), 0);
  assert.equal(await fnCount(db, 'hc_approve_order_artwork'), 0);
  assert.equal(await fnCount(db, 'hc_can_read_order_logo'), 1);
  assert.equal(await helperSrc(db), body035, 'the restored helper text equals the 035 constant');
  assert.equal(await helperSrc(db), src035, 'and the text installed before 048');
  assert.equal(await columnType(db, 'email_meta'), undefined);
  assert.equal(await columnType(db, 'artwork_scanned_at'), undefined);
  assert.equal(await bucketCap(db), null);
  assert.deepEqual(await storagePolicies(db), policiesBefore, 'the three 035 storage policies are byte-identical after the rollback');
  assert.equal(await canExecute(db, 'anon', 'public.hc_can_read_order_logo(text)'), false);
  assert.equal(await canExecute(db, 'authenticated', 'public.hc_can_read_order_logo(text)'), true);
  assert.equal(await canReadAs(db, TEAM, VEGAS_PATH), false);
  assert.equal(await canReadAs(db, OWNER, VEGAS_PATH), true);
  assert.equal((await orderOf(db, ORDER.vegas)).logo_asset.files[0].original_path, VEGAS_PATH, 'a card file the rollback never touched is still there');
  // Every seeded order but the doomed one (deleted above to prove the cascade).
  assert.equal(await asPostgres(db, () => scalarOn(db, 'select count(*)::int as value from public.orders')), Object.keys(ORDER).length - 1, 'no order was deleted by the rollback');
  assert.equal(await asPostgres(db, () => scalarOn(db, "select count(*)::int as value from public.intake_messages where status = 'dismissed'")), dismissedBefore, 'dismissed intake rows stay dismissed');
  await identityOn(db, { role: 'authenticated', sub: OWNER.authUserId });
  await deniedOn(db, 'after the rollback the decide call fails with function does not exist', DECIDE_SQL, [ORDER.empty, 1, 'use'], '42883');
  await identityOn(db);
  pass('rollback runs twice once nothing is pending and no used file is on a card: table, both functions, both columns and the cap gone; the helper is the 035 text with the 035 grants; storage policies, card files, orders and intake rows untouched');
  await db.exec(migration);
  assert.equal(await tableCount(db), 1);
  assert.equal(await helperSrc(db), src048);
  assert.equal(await bucketCap(db), '25000000');
  const intakeAgain = await newIntake(db, ORDER.empty);
  const propAgain = await propose(db, intakeAgain, ORDER.empty);
  out = await decideAs(db, OWNER, ORDER.empty, propAgain, 'use');
  assert.deepEqual(out, { applied: true, outcome: 'used', files: 1 });
  assert.equal((await orderOf(db, ORDER.empty)).logo_asset.status, 'approved');
  await identityOn(db, { role: 'service_role' });
  await deniedOn(db, 'after the re-apply the service key still cannot call the decide function', DECIDE_SQL, [ORDER.empty, propAgain, 'use'], '42501', /permission denied for function/);
  await identityOn(db, { role: 'anon' });
  await deniedOn(db, 'after the re-apply anon still cannot call the approve function', APPROVE_SQL, [ORDER.empty, 'x'], '42501', /permission denied for function/);
  await identityOn(db);
  pass('re-apply after rollback: the table, the helper clause and the cap are back, Use it lands again, the grants are back to authenticated only');

  // ── preflight guards on an unexpected shape ──
  const guard1 = await productionShaped();
  handles.push(guard1);
  // Somebody changed the 035 helper's LOGIC (a manager could read every
  // card): 048 stops. Layout alone never stops it (next scenario).
  const helper035 = migration035.slice(migration035.indexOf('create or replace function public.hc_can_read_order_logo('), migration035.indexOf('$function$;', migration035.indexOf('create or replace function public.hc_can_read_order_logo(')) + '$function$;'.length);
  await guard1.exec(helper035.replace("lower(trim(worker.role)) = 'owner'", "lower(trim(worker.role)) in ('owner', 'manager')"));
  await refusesOn(guard1, '048 refuses an hc_can_read_order_logo whose logic is not the 035 logic', migration, '55000', /unrecognized public\.hc_can_read_order_logo/);
  assert.equal(await tableCount(guard1), 0, 'nothing was added');
  assert.equal(await columnType(guard1, 'email_meta'), undefined);
  // The live helper as production actually holds it (pasted 2026-09-06 from
  // a copy with different line breaks: "select 1 from public.orders" on one
  // line, fewer indents). Same words, other layout: 048 must apply.
  const guard1b = await productionShaped();
  handles.push(guard1b);
  await guard1b.exec(helper035.replace('select 1\n      from public.orders as order_row', 'select 1 from public.orders as order_row').replace(/\n {8,}/g, '\n  '));
  await guard1b.exec(migration);
  assert.equal(await columnType(guard1b, 'email_meta'), 'jsonb', '048 applied over the reformatted helper');
  const reread = await guard1b.query("select p.prosrc as s from pg_catalog.pg_proc p where p.oid = 'public.hc_can_read_order_logo(text)'::regprocedure");
  assert.ok(String(reread.rows[0].s).includes('order_artwork_proposals'), 'the helper now carries the 048 clause');
  pass('048 accepts the 035 helper laid out the way production holds it (words compared, not whitespace) and still refuses a logic change');
  const guard2 = await productionShaped();
  handles.push(guard2);
  await guard2.exec("update storage.buckets set public = true where id = 'order-logos';");
  await refusesOn(guard2, '048 refuses a public order-logos bucket', migration, '55000', /public order-logos bucket/);
  assert.equal(await tableCount(guard2), 0, 'nothing was added');
  assert.equal(await guard2.query("select public as value from storage.buckets where id = 'order-logos'").then(r => r.rows[0].value), true, 'the bucket was not changed');
  const guard3 = await productionShaped();
  handles.push(guard3);
  await guard3.exec('alter table public.intake_messages drop column address_scanned_at;');
  await refusesOn(guard3, '048 refuses when a 045 column is missing on intake_messages', migration, '55000', /intake_messages\.address_scanned_at/);
  assert.equal(await tableCount(guard3), 0);
  const guard4 = await productionShaped();
  handles.push(guard4);
  await guard4.exec('alter table public.intake_messages add column email_meta text;');
  await refusesOn(guard4, '048 refuses a pre-existing email_meta that is not jsonb', migration, '55000', /email_meta of type text/);
  assert.equal(await tableCount(guard4), 0);
  const guard5 = await productionShaped();
  handles.push(guard5);
  await guard5.exec('drop table public.order_address_proposals cascade;');
  await refusesOn(guard5, '048 refuses when public.order_address_proposals (045) is missing', migration, '55000', /order_address_proposals \(045\)/);
  assert.equal(await tableCount(guard5), 0);

  console.log(`\nPASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: in-memory SQL does not exercise PostgREST, Supabase Storage HTTP, the phone UI, the worker, the droplet pass, or concurrent connections.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const h of handles) await h.close();
}
