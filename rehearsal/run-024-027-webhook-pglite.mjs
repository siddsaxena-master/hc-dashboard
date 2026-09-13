// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-024-027-webhook-pglite.mjs <absolute @electric-sql/pglite package directory>
//
// Rehearses migrations 024 (webhook delivery receipts) and 027 (async intake +
// encrypted Telegram outbox) on the shape production is in TODAY (2026-09-10):
// migration 011's push_queue with its eight base columns and RLS on, no 020,
// no 024, no 026, no 027. Real migration files are executed AS WRITTEN and are
// never rewritten by this script. The shipped runtime checks
// rehearsal/006_* and rehearsal/008_* are executed as written too.
//
// The concrete production symptom this exists to settle: every push insert the
// deployed Cloudflare Worker makes has failed since 2026-09-06 with
//   42703 column push_queue.outbox_type does not exist
// because 027 is the migration that adds that column.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
// Supabase ships pgcrypto; migration 011 and the orders baseline both ask for
// it by name, so load the matching PGlite contrib bundle rather than editing a
// migration. gen_random_uuid() itself is core Postgres from 13 on.
const { pgcrypto } = await import(pathToFileURL(join(packageDir, 'dist/contrib/pgcrypto.js')).href);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root, file), 'utf8');
const [
  fixture, ordersBaseline, m002, m003, m008, m011,
  m024, m027, m029, rollback024, rollback027, checks006, checks008, workerSource,
] = await Promise.all([
  'rehearsal/webhook-outbox-local-setup.sql',
  'rehearsal/000_orders_baseline.sql',
  'migrations/002_shifts.sql',
  'migrations/003_field_workers.sql',
  'migrations/008_push_tokens.sql',
  'migrations/011_push_queue.sql',
  'migrations/024_webhook_delivery_receipts.sql',
  'migrations/027_webhook_async_intake_outbox.sql',
  'migrations/029_webhook_delivery_lease_renewal_fix.sql',
  'migrations/024_webhook_delivery_receipts_rollback.sql',
  'migrations/027_webhook_async_intake_outbox_rollback.sql',
  'rehearsal/006_webhook_delivery_receipt_runtime_checks.sql',
  'rehearsal/008_webhook_async_intake_runtime_checks.sql',
  'worker/worker.js',
].map(read));

let db;
let passed = 0;
const notes = [];
const pass = message => { passed++; console.log(`PASS: ${message}`); };
const note = message => { notes.push(message); console.log(`NOTE: ${message}`); };

async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0]?.value; }
async function rows(sql, params = []) { return (await db.query(sql, params)).rows; }

// PostgREST hands the request's role to Postgres two ways: it SETs the database
// role and it publishes the JWT role claim, which is what Supabase's auth.role()
// reads. Both must move together or the tests would prove the wrong thing.
async function identity(role = 'postgres', claim = null) {
  await db.exec('reset role;');
  await db.query("select set_config('request.jwt.claim.role', $1, false)",
    [claim ?? (role === 'postgres' ? '' : role)]);
  if (role !== 'postgres') await db.exec(`set role ${role};`);
}
async function denied(label, sql, params = [], code = '42501', message = null) {
  await assert.rejects(db.query(sql, params),
    error => error.code === code && (!message || message.test(error.message)), label);
  pass(label);
}
// A migration file that must refuse. Its own BEGIN leaves an aborted
// transaction behind, so close it before the next statement.
async function refuses(label, sql, code, message) {
  let seen = null;
  await assert.rejects(db.exec(sql),
    error => { seen = error; return error.code === code && message.test(error.message); }, label);
  try { await db.exec('rollback;'); } catch { /* nothing open */ }
  pass(`${label} (${seen.code}: ${seen.message})`);
}

const PUSH_QUEUE_BASE_COLUMNS = ['id', 'kind', 'payload', 'created_at', 'claimed_at', 'done_at', 'attempts', 'last_error'];
const PUSH_QUEUE_027_COLUMNS = ['outbox_type', 'next_attempt_at', 'dead_lettered_at', 'dead_letter_reason'];
const columnsOf = table => rows(
  `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table])
  .then(list => list.map(c => c.column_name));
const relationExists = name => scalar('select (pg_catalog.to_regclass($1) is not null) as value', [name]);
const routineExists = signature => scalar('select (pg_catalog.to_regprocedure($1) is not null) as value', [signature]);
const constraintNames = table => rows(
  `select conname from pg_catalog.pg_constraint where conrelid = $1::pg_catalog.regclass
     and convalidated order by conname`, [table]).then(list => list.map(r => r.conname));

// The full access surface of the public schema: who holds which table
// privilege, every row policy, and which tables enforce RLS at all.
async function accessCatalog() {
  const grants = await rows(
    `select table_name, grantee, privilege_type from information_schema.table_privileges
       where table_schema = 'public' order by table_name, grantee, privilege_type`);
  const policies = await rows(
    `select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
       from pg_catalog.pg_policies where schemaname = 'public'
       order by tablename, policyname`);
  const rls = await rows(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by c.relname`);
  return { grants, policies, rls };
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
const queueSnapshot = () => rows(
  `select id::text, kind, payload::text as payload, created_at, claimed_at, done_at, attempts, last_error
     from public.push_queue order by id`);

// -- the deployed Worker's own row shape, mirrored exactly --------------------
// Read out of worker/worker.js so this cannot drift away from what is live.
const fnStart = workerSource.indexOf('export async function enqueuePush(');
assert.ok(fnStart > 0, 'worker.js must still export enqueuePush');
const rowStart = workerSource.indexOf('const row = {', fnStart);
const rowEnd = workerSource.indexOf('};', rowStart);
assert.ok(rowStart > fnStart && rowEnd > rowStart);
const rowLiteral = workerSource.slice(rowStart, rowEnd);
const workerRowKeys = [...rowLiteral.matchAll(/^ {4}([a-z_]+):/gm)].map(m => m[1]);
const enqueuePushRow = (kind, payload) => {
  const queueId = randomUUID();
  const queuePayload = {
    ...(payload || {}),
    headers: { ...((payload && payload.headers) || {}), collapse_id: queueId },
  };
  return {
    id: queueId,
    kind,
    payload: queuePayload,
    outbox_type: payload && payload.telegram_outbox ? 'webhook_telegram' : 'push',
  };
};
// PostgREST turns the Worker's POST body into exactly this INSERT. The Worker
// sends Prefer: resolution=ignore-duplicates, which is ON CONFLICT DO NOTHING.
const insertLikeWorker = row => db.query(
  `insert into public.push_queue (id, kind, payload, outbox_type)
     values ($1, $2, $3::jsonb, $4) on conflict (id) do nothing`,
  [row.id, row.kind, JSON.stringify(row.payload), row.outbox_type]);

// A well-formed v2 encrypted Telegram outbox payload, the only shape 027 lets
// into an outbox_type = 'webhook_telegram' row.
const telegramOutboxPayload = (extra = {}) => ({
  tokens: [],
  headers: {},
  aps: {},
  telegram_outbox: {
    version: 2,
    key_version: 'sandbox-current',
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'A'.repeat(64),
    ...extra,
  },
});

const LEGACY = {
  alert: '40000000-0000-4000-8000-000000000001',
  laStart: '40000000-0000-4000-8000-000000000002',
  laEnd: '40000000-0000-4000-8000-000000000003',
  laUpdate: '40000000-0000-4000-8000-000000000004',
  outbox: '40000000-0000-4000-8000-000000000005',
  oldWorker: '40000000-0000-4000-8000-000000000006',
};

try {
  db = await PGlite.create({ extensions: { pgcrypto } });
  const ident = (await db.query('select current_database() as name, version() as version')).rows[0];
  assert.equal(ident.name, 'postgres');
  assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  console.log('No connection string, no Supabase, no droplet, no network.\n');

  // == 1. the starting state production is actually in ========================
  await db.exec(fixture);
  for (const sql of [ordersBaseline, m002, m003, m008, m011]) await db.exec(sql);
  // Synthetic rows only. The shipped runtime checks refuse to run unless every
  // orders row is a sandbox row, which is also a guard against real data.
  await db.exec(`
    insert into public.orders (id, client_name, client_email, stage, market, total_cents, delivery_at_utc)
      values ('30000000-0000-4000-8000-000000000001', 'Sandbox beach club', 'sandbox@example.invalid', 'paid_full', 'ny', 90000, '2026-09-11T12:00:00Z'),
             ('30000000-0000-4000-8000-000000000002', 'Sandbox miami order', null, 'invoiced', 'miami', 45000, '2026-09-12T12:00:00Z');
    insert into public.field_workers (email, name, market, role)
      values ('sandbox-team@example.invalid', 'Sandbox Team', 'ny', 'team')
      on conflict (email) do nothing;
    insert into public.shifts (id, worker_name, worker_email, market)
      values ('50000000-0000-4000-8000-000000000001', 'Sandbox Team', 'sandbox-team@example.invalid', 'ny');
    insert into public.shift_locations (shift_id, lat, lng)
      values ('50000000-0000-4000-8000-000000000001', 40.5, -74.3);
    insert into public.push_tokens (email, apns_token)
      values ('sandbox-team@example.invalid', 'deadbeef');`);
  await db.exec(`
    insert into public.push_queue (id, kind, payload, created_at, claimed_at, done_at, attempts, last_error) values
      ('${LEGACY.alert}', 'alert',
        '{"tokens":["aa11"],"headers":{"topic":"com.example.sandbox","push_type":"alert","priority":10},"aps":{"alert":{"title":"Sandbox clock-in"}},"telegram_text":"Sandbox fallback","fallback_chat_ids":["123456789"]}'::jsonb,
        '2026-09-01T10:00:00Z', null, null, 0, null),
      ('${LEGACY.laStart}', 'la_start',
        '{"tokens":["bb22"],"headers":{"push_type":"liveactivity"},"aps":{"event":"start"}}'::jsonb,
        '2026-09-02T10:00:00Z', '2026-09-02T10:00:05Z', null, 1, null),
      ('${LEGACY.laEnd}', 'la_end',
        '{"tokens":["cc33"],"headers":{"push_type":"liveactivity"},"aps":{"event":"end"}}'::jsonb,
        '2026-09-03T10:00:00Z', '2026-09-03T10:00:05Z', '2026-09-03T10:00:09Z', 2, 'apns 410 unregistered'),
      ('${LEGACY.laUpdate}', 'la_update', '{}'::jsonb,
        '2026-09-04T10:00:00Z', null, null, 0, null),
      ('${LEGACY.outbox}', 'alert',
        '${JSON.stringify(telegramOutboxPayload())}'::jsonb,
        '2026-09-05T10:00:00Z', null, null, 0, null);`);
  // One more row the way the OLD worker wrote them: no outbox_type column named
  // at all. This is what every pre-2026-09-06 production row looks like.
  await identity('service_role');
  await db.query(
    `insert into public.push_queue (id, kind, payload) values ($1, 'alert', $2::jsonb)`,
    [LEGACY.oldWorker, JSON.stringify({
      tokens: ['dd44'], headers: { collapse_id: LEGACY.oldWorker }, aps: {},
      telegram_text: 'legacy', fallback_chat_ids: ['1'],
    })]);
  await identity();

  assert.deepEqual(await columnsOf('push_queue'), PUSH_QUEUE_BASE_COLUMNS);
  assert.equal(await scalar("select relrowsecurity as value from pg_catalog.pg_class where oid = 'public.push_queue'::pg_catalog.regclass"), true);
  assert.equal(await scalar("select count(*)::int as value from pg_catalog.pg_policies where schemaname='public' and tablename='push_queue'"), 0);
  pass('starting state matches the probed production shape: push_queue has exactly the eight 011 columns, RLS on, zero policies');
  for (const missing of ['public.webhook_delivery_receipts', 'public.webhook_intake_queue']) {
    assert.equal(await relationExists(missing), false, `${missing} must be absent`);
  }
  for (const missing of [
    'public.hc_claim_webhook_delivery(text,text,integer)',
    'public.hc_enqueue_webhook_intake(jsonb)',
    'public.hc_renew_webhook_delivery(text,text,uuid,integer)']) {
    assert.equal(await routineExists(missing), false, `${missing} must be absent`);
  }
  pass('024 and 027 are genuinely unapplied here: no receipt ledger, no intake queue, none of their RPCs');
  const beforeCatalog = await accessCatalog();
  const beforeQueue = await queueSnapshot();
  const beforeOrders = await rows('select * from public.orders order by id');
  const beforeWorkers = await rows('select * from public.field_workers order by email');
  const beforeShifts = await rows('select * from public.shifts order by id');
  const beforeTokens = await rows('select * from public.push_tokens order by email');
  const rolesBefore = await rows('select rolname from pg_catalog.pg_roles order by rolname');
  assert.equal(beforeQueue.length, 6);
  assert.deepEqual(grantMap(beforeCatalog)['push_queue:anon'],
    ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']);
  pass('Supabase bootstrap grants are in place, so the 024 and 027 REVOKE statements are being tested against something real');

  // == 2. the live bug, before 027 ===========================================
  assert.deepEqual(workerRowKeys, ['id', 'kind', 'payload', 'outbox_type']);
  assert.ok(workerSource.slice(fnStart, rowStart).includes('collapse_id: queueId'));
  assert.ok(rowLiteral.includes('payload && payload.telegram_outbox'));
  pass('the deployed worker enqueuePush still posts exactly {id, kind, payload, outbox_type}, so this rehearsal is testing the live shape');
  await identity('service_role');
  const alertRow = enqueuePushRow('alert', {
    tokens: ['ee55'], aps: { alert: { title: 'Sandbox clock-in' } },
    telegram_text: 'x', fallback_chat_ids: ['1'],
  });
  const outboxRow = enqueuePushRow('alert', telegramOutboxPayload());
  assert.equal(alertRow.outbox_type, 'push');
  assert.equal(outboxRow.outbox_type, 'webhook_telegram');
  assert.equal(alertRow.payload.headers.collapse_id, alertRow.id);
  for (const [label, row] of [['push', alertRow], ['webhook_telegram', outboxRow]]) {
    await assert.rejects(insertLikeWorker(row),
      error => error.code === '42703' && /outbox_type/.test(error.message),
      `the ${label} insert must fail before 027`);
  }
  const preFailure = await insertLikeWorker(alertRow).catch(error => error);
  console.log(`      live error reproduced: ${preFailure.code} ${preFailure.message}`);
  assert.equal(preFailure.code, '42703');
  assert.match(preFailure.message, /column "outbox_type" of relation "push_queue" does not exist/);
  pass('THE LIVE BUG REPRODUCES: both worker inserts fail with 42703 column "outbox_type" of relation "push_queue" does not exist');
  assert.equal(await scalar('select count(*)::int as value from public.push_queue'), 6);
  pass('the failed worker inserts wrote nothing, which is why clock-in and delivery notifications have been silently dead');
  await identity();

  // == 3. 024 refuses a database without orders (its own preflight) ==========
  {
    const bare = await PGlite.create({ extensions: { pgcrypto } });
    try {
      await bare.exec(fixture);
      await assert.rejects(bare.exec(m024),
        error => error.code === '55000'
          && /024 requires Supabase Auth, pgcrypto UUIDs, and the orders table/.test(error.message),
        '024 must refuse a database with no orders table');
      pass('024 refuses a database missing public.orders, inside its own transaction, before creating anything');
    } finally { await bare.close(); }
  }

  // == 4. 027 refuses when 024 has not run ===================================
  await refuses('027 refuses to run before 024', m027, '55000',
    /027 requires migrations 011 and 024 plus Supabase Auth/);
  assert.deepEqual(await columnsOf('push_queue'), PUSH_QUEUE_BASE_COLUMNS);
  assert.equal(await relationExists('public.webhook_intake_queue'), false);
  assert.deepEqual(await queueSnapshot(), beforeQueue);
  pass('the refused 027 left push_queue byte for byte unchanged: no half-added column, no orphan table');

  // == 5. 024 applies, and applies twice =====================================
  for (const sql of [m024, m024]) await db.exec(sql);
  pass('024 applies cleanly on the production-shaped state and is idempotent (run twice, no error)');
  assert.equal(await relationExists('public.webhook_delivery_receipts'), true);
  assert.equal(await scalar("select relrowsecurity as value from pg_catalog.pg_class where oid = 'public.webhook_delivery_receipts'::pg_catalog.regclass"), true);
  assert.equal(await scalar("select count(*)::int as value from pg_catalog.pg_policies where schemaname='public' and tablename='webhook_delivery_receipts'"), 0);
  assert.equal(await scalar(`select count(*)::int as value from information_schema.table_privileges
      where table_schema='public' and table_name='webhook_delivery_receipts'
        and grantee in ('PUBLIC','anon','authenticated','service_role')`), 0);
  pass('the receipt ledger has RLS on, zero policies, and not one table grant to anon, authenticated, service_role or PUBLIC');
  for (const signature of [
    'public.hc_claim_webhook_delivery(text,text,integer)',
    'public.hc_finish_webhook_delivery(text,text,uuid)',
    'public.hc_release_webhook_delivery(text,text,uuid)']) {
    assert.equal(await routineExists(signature), true);
    assert.equal(await scalar('select has_function_privilege($1, $2, $3) as value', ['anon', signature, 'execute']), false);
    assert.equal(await scalar('select has_function_privilege($1, $2, $3) as value', ['authenticated', signature, 'execute']), false);
    assert.equal(await scalar('select has_function_privilege($1, $2, $3) as value', ['service_role', signature, 'execute']), true);
    assert.equal(await scalar('select prosecdef as value from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure($1)', [signature]), true);
  }
  pass('all three receipt RPCs exist, are SECURITY DEFINER, and only service_role may execute them');
  const eventKey = 'a'.repeat(64);
  await identity('anon');
  await denied('anon cannot execute the claim RPC at all',
    'select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['formspree', eventKey],
    '42501', /permission denied for function/);
  await identity('service_role', 'authenticated');
  await denied('a service_role connection carrying an authenticated JWT is refused inside the RPC',
    'select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['formspree', eventKey],
    '42501', /service role required/);
  await identity('service_role');
  const claim = (await rows('select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['formspree', eventKey]))[0];
  assert.equal(claim.claim_state, 'claimed');
  assert.ok(claim.claim_token);
  const second = (await rows('select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['formspree', eventKey]))[0];
  assert.equal(second.claim_state, 'busy');
  assert.equal(second.claim_token, null);
  assert.equal(await scalar('select public.hc_finish_webhook_delivery($1, $2, $3) as value',
    ['formspree', eventKey, claim.claim_token]), true);
  const third = (await rows('select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['formspree', eventKey]))[0];
  assert.equal(third.claim_state, 'completed');
  assert.equal(third.receipt_id, claim.receipt_id);
  pass('a real claim/busy/finish/duplicate cycle behaves: the same provider event is claimed once, reported busy, then completed');
  await denied('the RPC rejects a malformed event key',
    'select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['formspree', 'NOT-A-HASH'],
    '22023', /invalid webhook claim/);
  await denied('the RPC rejects an unknown provider',
    'select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['sendgrid', eventKey],
    '22023', /invalid webhook claim/);
  await identity();
  await db.exec('delete from public.webhook_delivery_receipts;');

  // == 6. the repository's own runtime checks for 024 ========================
  {
    const result = await db.exec(checks006);
    const final = result[result.length - 1].rows[0];
    assert.equal(final.webhook_delivery_receipt_runtime_rehearsal, 'passed');
    assert.equal(final.scenarios_checked, 8);
    assert.equal(await scalar('select count(*)::int as value from public.webhook_delivery_receipts'), 0);
    pass('rehearsal/006_webhook_delivery_receipt_runtime_checks.sql passes as written (8 scenarios) and rolls itself back');
  }

  // == 7. 027's other preflights ============================================
  await db.exec('alter table public.push_queue disable row level security;');
  await refuses('027 refuses when push_queue RLS is off', m027, '42501',
    /027 requires migration 011 push_queue RLS/);
  await db.exec('alter table public.push_queue enable row level security;');
  await db.exec('alter table public.push_queue rename column last_error to last_error_renamed;');
  await refuses('027 refuses when an 011 base column is missing', m027, '55000',
    /027 requires migration 011 push_queue column last_error/);
  await db.exec('alter table public.push_queue rename column last_error_renamed to last_error;');
  assert.deepEqual(await columnsOf('push_queue'), PUSH_QUEUE_BASE_COLUMNS);
  assert.deepEqual(await queueSnapshot(), beforeQueue);
  pass('both refused 027 attempts left the eight columns and all six rows exactly as they were');

  // == 8. a legacy row 027 would refuse to backfill ==========================
  const junkOutbox = '40000000-0000-4000-8000-000000000099';
  await db.query("insert into public.push_queue (id, kind, payload) values ($1, 'la_start', $2::jsonb)",
    [junkOutbox, JSON.stringify({ tokens: ['ff66'], telegram_outbox: { note: 'not the v2 encrypted shape' } })]);
  await refuses('027 aborts rather than half-migrate a push_queue row whose payload carries a telegram_outbox key that is not the v2 encrypted shape',
    m027, '23514', /push_queue_webhook_telegram_shape_check/);
  await db.query('delete from public.push_queue where id = $1', [junkOutbox]);
  assert.deepEqual(await columnsOf('push_queue'), PUSH_QUEUE_BASE_COLUMNS);
  assert.deepEqual(await queueSnapshot(), beforeQueue);
  note("PREFLIGHT FOR SIDD: before running 027, run `select count(*) from push_queue where payload ? 'telegram_outbox'`. Any row there that is not the v2 encrypted shape makes 027 abort. It rolls back cleanly and loses nothing, but the run stops.");

  // == 9. 027 applies, and applies twice =====================================
  for (const sql of [m027, m027]) await db.exec(sql);
  pass('027 applies cleanly once 024 is in place, and is idempotent (run twice, no error)');
  assert.deepEqual(await columnsOf('push_queue'), [...PUSH_QUEUE_BASE_COLUMNS, ...PUSH_QUEUE_027_COLUMNS]);
  const pushColumns = Object.fromEntries((await rows(
    `select column_name, is_nullable, column_default from information_schema.columns
       where table_schema='public' and table_name='push_queue'`)).map(c => [c.column_name, c]));
  assert.equal(pushColumns.outbox_type.is_nullable, 'NO');
  assert.equal(pushColumns.outbox_type.column_default, "'push'::text");
  assert.equal(pushColumns.next_attempt_at.is_nullable, 'NO');
  assert.equal(pushColumns.next_attempt_at.column_default, 'clock_timestamp()');
  assert.equal(pushColumns.dead_lettered_at.is_nullable, 'YES');
  assert.equal(pushColumns.dead_letter_reason.is_nullable, 'YES');
  pass("outbox_type is NOT NULL default 'push' and next_attempt_at is NOT NULL default clock_timestamp()");
  const queueConstraints = await constraintNames('public.push_queue');
  for (const name of ['push_queue_outbox_type_check', 'push_queue_webhook_telegram_shape_check', 'push_queue_dead_letter_shape_check']) {
    assert.ok(queueConstraints.includes(name), `${name} must exist and be validated`);
  }
  assert.equal(await scalar(`select count(*)::int as value from pg_catalog.pg_indexes
      where schemaname='public' and indexname='push_queue_webhook_outbox_pending_idx'`), 1);
  pass('all three new push_queue check constraints are present and validated, and the outbox drain index exists');

  // -- backfill correctness --
  const backfilled = Object.fromEntries((await rows(
    'select id::text, outbox_type, created_at, next_attempt_at from public.push_queue')).map(r => [r.id, r]));
  assert.equal(backfilled[LEGACY.outbox].outbox_type, 'webhook_telegram');
  for (const id of [LEGACY.alert, LEGACY.laStart, LEGACY.laEnd, LEGACY.laUpdate, LEGACY.oldWorker]) {
    assert.equal(backfilled[id].outbox_type, 'push', `${id} must backfill to push`);
  }
  pass('backfill is right: the one payload carrying telegram_outbox became webhook_telegram, and all five others (including the row with telegram_text and the empty payload) became push');
  for (const row of Object.values(backfilled)) {
    assert.equal(row.next_attempt_at.getTime(), row.created_at.getTime());
  }
  pass('every pre-existing row got next_attempt_at = its own created_at, so nothing jumps the drain queue');

  // -- point 6: the rows themselves survived --
  assert.deepEqual(await queueSnapshot(), beforeQueue);
  pass('all six pre-existing push_queue rows survived both migrations unchanged: ids, kinds, payload bytes, timestamps, attempts and last_error all identical');

  // == 10. THE FIX: the worker's own insert now works ========================
  await identity('service_role');
  for (const [label, row] of [['push', alertRow], ['webhook_telegram', outboxRow]]) {
    await insertLikeWorker(row);
    const stored = (await rows('select * from public.push_queue where id = $1', [row.id]))[0];
    assert.ok(stored, `${label} row must exist`);
    assert.equal(stored.outbox_type, row.outbox_type);
    assert.equal(stored.kind, row.kind);
    assert.deepEqual(stored.payload, row.payload);
    assert.equal(stored.payload.headers.collapse_id, row.id);
    assert.ok(stored.next_attempt_at instanceof Date);
    assert.equal(stored.done_at, null);
    assert.equal(stored.dead_lettered_at, null);
    pass(`THE BUG IS FIXED: the identical enqueuePush insert that failed with 42703 above now succeeds for outbox_type '${label}', with the collapse_id payload intact`);
  }
  await insertLikeWorker(alertRow);
  assert.equal(await scalar('select count(*)::int as value from public.push_queue where id = $1', [alertRow.id]), 1);
  pass('re-posting the same queue id is a no-op, so the worker retry (Prefer: resolution=ignore-duplicates) cannot double-send a notification');
  const defaulted = randomUUID();
  await db.query("insert into public.push_queue (id, kind, payload) values ($1, 'alert', '{}'::jsonb)", [defaulted]);
  assert.equal(await scalar('select outbox_type as value from public.push_queue where id = $1', [defaulted]), 'push');
  pass("an insert that never mentions outbox_type still works and defaults to 'push', so any older caller keeps working");
  await denied('an unknown outbox_type is refused',
    "insert into public.push_queue (kind, payload, outbox_type) values ('alert','{}'::jsonb,'telegram')",
    [], '23514', /push_queue_outbox_type_check/);
  await denied('a webhook_telegram row with a non-empty tokens array is refused',
    "insert into public.push_queue (kind, payload, outbox_type) values ('alert', $1::jsonb, 'webhook_telegram')",
    [JSON.stringify({ ...telegramOutboxPayload(), tokens: ['aa'] })], '23514', /push_queue_webhook_telegram_shape_check/);
  await denied('a webhook_telegram row carrying a plaintext chat_id is refused',
    "insert into public.push_queue (kind, payload, outbox_type) values ('alert', $1::jsonb, 'webhook_telegram')",
    [JSON.stringify(telegramOutboxPayload({ chat_id: '123456789' }))], '23514', /push_queue_webhook_telegram_shape_check/);
  await denied('a dead-lettered row that is not also finished is refused',
    `insert into public.push_queue (kind, payload, outbox_type, dead_lettered_at, dead_letter_reason)
       values ('alert', $1::jsonb, 'webhook_telegram', now(), 'gave up')`,
    [JSON.stringify(telegramOutboxPayload())], '23514', /push_queue_dead_letter_shape_check/);
  const deadLettered = randomUUID();
  await db.query(`insert into public.push_queue (id, kind, payload, outbox_type, done_at, dead_lettered_at, dead_letter_reason)
      values ($1, 'alert', $2::jsonb, 'webhook_telegram', now(), now(), 'telegram rejected the send five times')`,
    [deadLettered, JSON.stringify(telegramOutboxPayload())]);
  pass('a correctly finished dead-letter row is accepted, so a permanently undeliverable webhook alert can be parked instead of retried forever');

  // == 11. pushdrain keeps working under the narrowed grant ==================
  const pending = await rows('select id from public.push_queue where done_at is null order by created_at limit 5');
  assert.ok(pending.length > 0);
  await db.query('update public.push_queue set claimed_at = now(), attempts = attempts + 1 where id = $1', [pending[0].id]);
  await db.query('update public.push_queue set done_at = now(), last_error = null where id = $1', [pending[0].id]);
  await db.query('delete from public.push_queue where id = $1', [deadLettered]);
  pass('service_role can still SELECT, INSERT, UPDATE and DELETE push_queue after 027, so the Worker and the droplet pushdrain both keep working');
  await denied('service_role can no longer TRUNCATE push_queue', 'truncate table public.push_queue', [], '42501');
  await identity('anon');
  await denied('anon is now hard-denied on push_queue', 'select id from public.push_queue', [],
    '42501', /permission denied for table push_queue/);
  await identity('authenticated');
  await denied('authenticated is now hard-denied on push_queue', 'select id from public.push_queue', [],
    '42501', /permission denied for table push_queue/);
  await identity();
  pass('027 STRENGTHENS push_queue: before it, anon and authenticated held every table privilege and were stopped only by empty RLS; now they hold none');

  // == 12. the repository's own runtime checks for 027 =======================
  const queueCountBefore008 = await scalar('select count(*)::int as value from public.push_queue');
  let checks008Failure = null;
  try {
    await db.exec(checks008);
  } catch (error) { checks008Failure = error; }
  try { await db.exec('rollback;'); } catch { /* nothing open */ }
  assert.ok(checks008Failure, 'rehearsal/008 must not pass on 024 + 027 alone');
  assert.equal(checks008Failure.code, '42703');
  assert.match(checks008Failure.message, /column receipt\.claim_token does not exist/);
  console.log(`      027 defect surfaced by the shipped check: ${checks008Failure.code} ${checks008Failure.message}`);
  pass('DEFECT FOUND: rehearsal/008 cannot pass with only 024 + 027, because 027 ships a broken hc_renew_webhook_delivery');
  await identity('service_role');
  const renewKey = 'e'.repeat(64);
  const renewClaim = (await rows('select * from public.hc_claim_webhook_delivery($1, $2, 300)', ['ms_graph', renewKey]))[0];
  assert.equal(renewClaim.claim_state, 'claimed');
  await denied('027 hc_renew_webhook_delivery raises 42703 on every call',
    'select public.hc_renew_webhook_delivery($1, $2, $3, 300) as value', ['ms_graph', renewKey, renewClaim.claim_token],
    '42703', /column receipt\.claim_token does not exist/);
  assert.match(m027, /and receipt\.claim_token = p_claim_token/);
  // Back to the owner: information_schema hides columns from a role with no
  // privileges on the table, so asking as service_role would pass vacuously.
  // pg_attribute is the unfiltered catalog and cannot lie about this.
  await identity();
  const receiptColumns = (await rows(
    `select attname from pg_catalog.pg_attribute
       where attrelid = 'public.webhook_delivery_receipts'::pg_catalog.regclass
         and attnum > 0 and not attisdropped order by attnum`)).map(r => r.attname);
  assert.ok(receiptColumns.includes('lease_token'), 'the 024 ledger stores its claim in lease_token');
  assert.equal(receiptColumns.includes('claim_token'), false, 'the 024 ledger has no claim_token column');
  pass('the cause is exact: 027 line "receipt.claim_token = p_claim_token" names a column the 024 ledger does not have (it is lease_token)');
  note("DEFECT: migration 027's hc_renew_webhook_delivery is dead on arrival (42703 on every call). migrations/029_webhook_delivery_lease_renewal_fix.sql is the repository's own forward repair and it is NOT applied in production. Run 024, then 027, then 029.");
  await identity();
  await db.exec(m029);
  await identity('service_role');
  assert.equal(await scalar('select public.hc_renew_webhook_delivery($1, $2, $3, 300) as value',
    ['ms_graph', renewKey, renewClaim.claim_token]), true);
  assert.equal(await scalar('select public.hc_renew_webhook_delivery($1, $2, pg_catalog.gen_random_uuid(), 300) as value',
    ['ms_graph', renewKey]), false);
  await identity();
  await db.exec("update public.webhook_delivery_receipts set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second';");
  await identity('service_role');
  assert.equal(await scalar('select public.hc_renew_webhook_delivery($1, $2, $3, 300) as value',
    ['ms_graph', renewKey, renewClaim.claim_token]), false);
  pass('after 029 the renewal RPC works: the owning token renews, a foreign token does not, and an expired lease cannot be revived');
  await identity();
  await db.exec('delete from public.webhook_delivery_receipts;');
  {
    const result = await db.exec(checks008);
    const final = result[result.length - 1].rows[0];
    assert.equal(final.webhook_async_intake_runtime_rehearsal, 'passed');
    assert.equal(final.scenarios_checked, 13);
    pass('rehearsal/008_webhook_async_intake_runtime_checks.sql passes as written (13 scenarios) once 029 is applied on top of 024 + 027');
  }
  assert.equal(await scalar('select count(*)::int as value from public.webhook_intake_queue'), 0);
  assert.equal(await scalar('select count(*)::int as value from public.push_queue'), queueCountBefore008);
  pass('the 027 runtime check rolled itself back: no intake rows and no extra push_queue rows survived it');

  // == 13. rollbacks ========================================================
  const columnsBeforeRollback = await columnsOf('push_queue');
  const queueBeforeRollback = await queueSnapshot();
  await refuses('the 024 rollback file is deliberately blocked', rollback024, '55000', /024 automatic rollback blocked/);
  await refuses('the 027 rollback file is deliberately blocked', rollback027, '55000', /027 automatic rollback blocked/);
  assert.deepEqual(await columnsOf('push_queue'), columnsBeforeRollback);
  assert.deepEqual(await queueSnapshot(), queueBeforeRollback);
  assert.equal(await relationExists('public.webhook_delivery_receipts'), true);
  assert.equal(await relationExists('public.webhook_intake_queue'), true);
  for (const signature of [
    'public.hc_claim_webhook_delivery(text,text,integer)', 'public.hc_finish_webhook_delivery(text,text,uuid)',
    'public.hc_release_webhook_delivery(text,text,uuid)', 'public.hc_enqueue_webhook_intake(jsonb)',
    'public.hc_claim_webhook_intake(integer,integer)', 'public.hc_finish_webhook_intake(uuid,uuid)',
    'public.hc_release_webhook_intake(uuid,uuid,integer,text)', 'public.hc_renew_webhook_delivery(text,text,uuid,integer)']) {
    assert.equal(await routineExists(signature), true, `${signature} must survive the blocked rollbacks`);
  }
  pass('both rollback files refuse on purpose and leave a coherent state: every column, row, table and RPC is exactly where it was');
  note('NO AUTOMATED UNDO EXISTS. Both rollback files raise 55000 by design, so reversing 024 or 027 in production means a new reviewed forward migration coordinated with the Worker and pushdrain. Specifically unrecoverable by any rollback: dropping outbox_type throws away the push/webhook_telegram backfill, and dropping the receipt ledger lets already-processed provider webhooks be processed a second time (duplicate orders).');

  // == 14. access audit (nothing customer-facing was weakened) ===============
  const afterCatalog = await accessCatalog();
  const beforeGrants = grantMap(beforeCatalog);
  const afterGrants = grantMap(afterCatalog);
  for (const table of ['orders', 'field_workers', 'shifts', 'shift_locations', 'push_tokens']) {
    assert.deepEqual(forTable(afterCatalog, table), forTable(beforeCatalog, table),
      `${table} grants, policies and RLS must be untouched`);
  }
  pass('orders, field_workers, shifts, shift_locations and push_tokens have identical grants, row policies and RLS flags before 024 and after 027');
  assert.deepEqual(await rows('select * from public.orders order by id'), beforeOrders);
  assert.deepEqual(await rows('select * from public.field_workers order by email'), beforeWorkers);
  assert.deepEqual(await rows('select * from public.shifts order by id'), beforeShifts);
  assert.deepEqual(await rows('select * from public.push_tokens order by email'), beforeTokens);
  pass('not one row of orders, field_workers, shifts or push_tokens was written to or deleted by either migration');
  for (const table of ['field_workers', 'shifts', 'shift_locations', 'push_tokens']) {
    assert.equal(m024.includes(table), false, `024 must not mention ${table}`);
    assert.equal(m027.includes(table), false, `027 must not mention ${table}`);
  }
  assert.equal(m024.split('public.orders').length - 1, 1);
  assert.match(m024, /to_regclass\('public\.orders'\) is null/);
  assert.equal(m027.includes('public.orders'), false);
  pass('statically too: neither file contains any statement naming field_workers, shifts, shift_locations or push_tokens, and orders appears once in 024 as a read-only to_regclass existence test');
  assert.equal(afterGrants['push_queue:anon'], undefined);
  assert.equal(afterGrants['push_queue:authenticated'], undefined);
  assert.deepEqual(afterGrants['push_queue:service_role'], ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  for (const table of ['webhook_delivery_receipts', 'webhook_intake_queue']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(afterGrants[`${table}:${role}`], undefined, `${table} must grant ${role} nothing`);
    }
  }
  pass('the only access change anywhere is on push_queue and the two new private tables, and every change removes access rather than adding it');
  // The two new tables necessarily belong to the database owner that created
  // them, exactly like every other table here. What must never widen is what
  // the three PostgREST API roles and PUBLIC can reach.
  const API_ROLES = new Set(['anon', 'authenticated', 'service_role', 'PUBLIC']);
  const widened = Object.entries(afterGrants).filter(([key, privileges]) => {
    if (!API_ROLES.has(key.split(':')[1])) return false;
    const previous = beforeGrants[key] || [];
    return privileges.some(privilege => !previous.includes(privilege));
  }).map(([key]) => key);
  assert.deepEqual(widened.sort(), []);
  const ownerOnly = Object.keys(afterGrants).filter(key => !(key in beforeGrants));
  assert.deepEqual(ownerOnly.sort(), ['webhook_delivery_receipts:postgres', 'webhook_intake_queue:postgres']);
  pass('a full public-schema privilege diff finds ZERO grants widened for anon, authenticated, service_role or PUBLIC on any table; the only new grant rows anywhere belong to the database owner on the two new private tables');
  assert.deepEqual(await rows('select rolname from pg_catalog.pg_roles order by rolname'), rolesBefore);
  pass('neither migration created, dropped or renamed a database role');
  const newPolicies = afterCatalog.policies.filter(p =>
    !beforeCatalog.policies.some(q => q.tablename === p.tablename && q.policyname === p.policyname));
  assert.deepEqual(newPolicies, []);
  pass('024 and 027 create no row-level-security policy at all, so no new row is exposed to any client key');

  console.log('\n-- who can reach what after 024 + 027 --');
  for (const table of ['push_queue', 'webhook_delivery_receipts', 'webhook_intake_queue', 'orders', 'field_workers', 'shifts', 'shift_locations', 'push_tokens']) {
    const line = ['anon', 'authenticated', 'service_role'].map(role =>
      `${role}=${(afterGrants[`${table}:${role}`] || ['none']).join('/')}`).join('  ');
    const rls = afterCatalog.rls.find(r => r.relname === table);
    const policyCount = afterCatalog.policies.filter(p => p.tablename === table).length;
    console.log(`  ${table.padEnd(26)} rls=${rls ? rls.relrowsecurity : '?'} policies=${policyCount}  ${line}`);
  }

  console.log(`\nPASS: ${passed} local runtime assertions. No live systems were contacted.`);
  if (notes.length) {
    console.log('\n-- notes --');
    for (const message of notes) console.log(`  * ${message}`);
  }
  console.log('\nLimits: in-memory SQL does not exercise PostgREST itself, the Cloudflare Worker runtime, the droplet pushdrain,');
  console.log('Telegram or Apple delivery, concurrent connections, or production row volume. The starting fixture rebuilds the');
  console.log('parts of production that 024 and 027 touch; it is not a byte copy of every live policy on orders.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
