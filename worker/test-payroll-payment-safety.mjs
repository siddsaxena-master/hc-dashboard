// Offline payroll payment safety checks. This reads local source files only.
// It does not connect to Supabase, start Expo, or make a network request.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const migration = await readFile(
  join(here, '..', 'migrations', '023_payroll_payment_safety.sql'),
  'utf8',
);
const app = await readFile(
  join(here, '..', '..', 'hc-field-app', 'App.js'),
  'utf8',
);

let failed = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (error) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + String(error.message || error));
  }
}

function includesAll(source, snippets) {
  for (const snippet of snippets) {
    assert.ok(source.includes(snippet), `missing: ${snippet}`);
  }
}

function sectionBetween(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0, `missing section start: ${start}`);
  assert.ok(endAt > startAt, `missing section end: ${end}`);
  return source.slice(startAt, endAt);
}

const executableMigration = migration.replace(/^\s*--.*$/gm, '');
const helperSource = sectionBetween(
  app,
  'const payMins =',
  '// A shift still open after this many hours',
);
const groupingSource = sectionBetween(
  app,
  'function buildPayGroups(',
  '// ── Day P&L:',
);
const helperContext = {};
vm.runInNewContext(
  `${helperSource}\n${groupingSource}\n` +
  'this.payrollApi = { payShiftTimeIssue, workerForShift, payrollFailureFor, buildPayGroups };',
  helperContext,
);
const {
  payShiftTimeIssue,
  workerForShift,
  payrollFailureFor,
  buildPayGroups,
} = helperContext.payrollApi;

check('migration is transactional and waits only briefly for production locks', () => {
  includesAll(migration, [
    'begin;',
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '60s';",
    'commit;',
  ]);
  assert.ok(migration.indexOf('begin;') < migration.indexOf('create table'));
  assert.ok(migration.lastIndexOf('commit;') > migration.indexOf('do $postflight$'));
});

check('migration refuses to create an incomplete audit before Auth cutover', () => {
  includesAll(migration, [
    "has_table_privilege('anon', 'public.shifts', 'UPDATE')",
    "'authenticated', 'public.shifts', 'UPDATE'",
    '023 requires the authenticated field cutover from migration 016',
  ]);
});

check('audit rows have identity, uniqueness, amount, duration, and note constraints', () => {
  includesAll(migration, [
    'create table if not exists public.shift_payment_records',
    'constraint shift_payment_records_shift_key unique (shift_id)',
    'constraint shift_payment_records_paid_minutes_check check',
    'paid_minutes between 1 and 1440',
    'constraint shift_payment_records_amount_check check',
    'paid_minutes::numeric * hourly_rate_cents::numeric / 60',
    'constraint shift_payment_records_worker_email_check check',
    'constraint shift_payment_records_payer_email_check check',
    'constraint shift_payment_records_note_length_check check',
    'payment_note = pg_catalog.btrim(payment_note)',
  ]);
});

check('payment history is owner-readable and immutable to every client role', () => {
  includesAll(migration, [
    'create policy shift_payment_records_owner_select',
    'using (public.hc_is_owner());',
    'grant select on table public.shift_payment_records to authenticated;',
    'grant select on table public.shift_payment_records to service_role;',
    'create trigger shift_payment_records_immutable',
    'before update or delete on public.shift_payment_records',
    "message = 'shift payment records are immutable'",
  ]);
  assert.doesNotMatch(
    executableMigration,
    /grant\s+all\s+on\s+table\s+public\.shift_payment_records/i,
  );
});

check('payment function is owner-only and captures the authenticated payer', () => {
  includesAll(migration, [
    'create or replace function public.hc_mark_shifts_paid(',
    'p_payment_note text default null',
    'security definer',
    "set search_path = ''",
    'if not public.hc_is_owner() then',
    'v_payer_auth_user_id := auth.uid();',
    'pg_catalog.btrim(public.hc_current_worker_email())',
    'pg_catalog.lower(pg_catalog.btrim(updated.roster_email))',
    "message = 'confirmed owner identity required'",
  ]);
});

check('invalid duration, already-paid, and stale-data failures are distinct', () => {
  includesAll(migration, [
    "message = 'shift duration must be between 1 minute and 24 hours'",
    "message = 'one or more shifts were already paid'",
    "message = 'one or more pay items changed or are invalid; no shifts were marked paid'",
    "errcode = '22023'",
    "errcode = '23505'",
    "errcode = '40001'",
  ]);
});

check('overlapping payment attempts lock rows and remain all-or-nothing', () => {
  includesAll(migration, [
    'order by item.shift_id',
    'for update;',
    'order by s.field_worker_id',
    'get diagnostics v_recorded_count = row_count;',
    'if v_recorded_count <> v_item_count then',
    "message = 'pay batch changed during update; no shifts were marked paid'",
  ]);
});

check('shift snapshots and audit rows are written in one database statement', () => {
  const updateAt = migration.indexOf('), updated as (');
  const auditAt = migration.indexOf('insert into public.shift_payment_records', updateAt);
  const countAt = migration.indexOf('get diagnostics v_recorded_count', auditAt);
  assert.ok(updateAt >= 0 && auditAt > updateAt && countAt > auditAt);
  includesAll(migration.slice(updateAt, countAt), [
    'set paid_at = v_paid_at',
    'paid_minutes = pg_catalog.floor(',
    'paid_cents = pg_catalog.round(',
    'v_payer_auth_user_id',
    'v_payer_email',
    'v_payment_note',
  ]);
});

check('postflight verifies constraints, policy, grants, trigger, and RPC shape', () => {
  includesAll(migration, [
    "'shift_payment_records_amount_check'",
    "trigger_info.tgname = 'shift_payment_records_immutable'",
    "policy_info.policyname = 'shift_payment_records_owner_select'",
    "'service_role', 'public.shift_payment_records', 'INSERT'",
    "function_info.proargnames = array['p_items', 'p_payment_note']",
    'function_info.pronargdefaults = 1',
    "setting.value ~ '^search_path=(|\"\")$'",
  ]);
});

check('app preserves individual pay and sends the explicit audit note', () => {
  includesAll(app, [
    'onPress={() => markPaid(g, [x])}',
    'Mark this shift paid',
    'p_payment_note: null,',
  ]);
});

check('app blocks unsafe durations but keeps those shifts visible for repair', () => {
  includesAll(app, [
    'const MIN_PAY_SHIFT_MS = 60 * 1000;',
    'const MAX_PAY_SHIFT_MS = 24 * 60 * 60 * 1000;',
    "return 'This shift is under one minute.';",
    "return 'This shift is over 24 hours.';",
    'g.closed.push(payRow);',
    'if (!timeIssue) g.payable.push(payRow);',
    'Fix times before paying</Text>',
    'onPress={() => openShiftEditor(x)}',
  ]);
});

check('duration helper enforces exact one-minute and 24-hour boundaries', () => {
  const at = '2026-08-27T12:00:00.000Z';
  const shift = (milliseconds) => ({
    clock_in_at: at,
    clock_out_at: new Date(Date.parse(at) + milliseconds).toISOString(),
  });
  assert.equal(payShiftTimeIssue(shift(0)), 'This shift is under one minute.');
  assert.equal(payShiftTimeIssue(shift(59999)), 'This shift is under one minute.');
  assert.equal(payShiftTimeIssue(shift(60000)), '');
  assert.equal(payShiftTimeIssue(shift(24 * 60 * 60 * 1000)), '');
  assert.equal(
    payShiftTimeIssue(shift(24 * 60 * 60 * 1000 + 1)),
    'This shift is over 24 hours.',
  );
});

check('app matches current workers by stable ID and legacy names only when unique', () => {
  includesAll(app, [
    'field_workers?select=id,email,name,hourly_rate_cents',
    "const workerId = String((sh && sh.field_worker_id) || '').toLowerCase();",
    'if (workerId) {',
    'if (emailMatches.length === 1) return emailMatches[0];',
    'return nameMatches.length === 1 ? nameMatches[0] : null;',
  ]);
});

check('worker matching prefers ID and refuses ambiguous legacy names', () => {
  const workers = [
    { id: 'worker-a', email: 'a@example.com', name: 'Alex', hourly_rate_cents: 2400 },
    { id: 'worker-b', email: 'b@example.com', name: 'Alex', hourly_rate_cents: 3000 },
  ];
  assert.equal(workerForShift(workers, {
    field_worker_id: 'worker-a',
    worker_email: 'b@example.com',
    worker_name: 'Alex',
  }).id, 'worker-a');
  assert.equal(workerForShift(workers, {
    worker_email: 'b@example.com',
    worker_name: 'Alex',
  }).id, 'worker-b');
  assert.equal(workerForShift(workers, { worker_name: 'Alex' }), null);
});

check('app labels incomplete totals and reports exact exception counts', () => {
  includesAll(app, [
    "knownOnly: unpricedCount > 0 || timeReviewCount > 0",
    "pay.knownOnly ? 'Known total' : 'Total owed'",
    'pay.unpricedCount} closed {pay.unpricedCount === 1',
    'pay.timeReviewCount} {pay.timeReviewCount === 1',
  ]);
});

check('pay groups keep invalid rows visible and total only known payable work', () => {
  const workers = [
    { id: 'worker-a', email: 'a@example.com', name: 'Alex', hourly_rate_cents: 2400 },
  ];
  const shifts = [
    {
      id: 'valid', field_worker_id: 'worker-a', worker_name: 'Alex',
      worker_email: 'a@example.com', clock_in_at: '2026-08-27T12:00:00.000Z',
      clock_out_at: '2026-08-27T14:00:00.000Z',
    },
    {
      id: 'placeholder', field_worker_id: 'worker-a', worker_name: 'Alex',
      worker_email: 'a@example.com', clock_in_at: '2026-08-27T15:00:00.000Z',
      clock_out_at: '2026-08-27T15:00:00.000Z',
    },
    {
      id: 'unpriced', field_worker_id: 'missing-worker', worker_name: 'Casey',
      worker_email: 'casey@example.com', clock_in_at: '2026-08-27T16:00:00.000Z',
      clock_out_at: '2026-08-27T17:00:00.000Z',
    },
  ];
  const pay = buildPayGroups(shifts, workers);
  const alex = pay.list.find((group) => group.key === 'worker:worker-a');
  assert.equal(alex.closed.length, 2);
  assert.equal(alex.payable.length, 1);
  assert.equal(alex.closed.find((row) => row.id === 'placeholder').cents, null);
  assert.equal(pay.grand, 4800);
  assert.equal(pay.unpricedCount, 1);
  assert.equal(pay.timeReviewCount, 1);
  assert.equal(pay.knownOnly, true);
});

check('app uses New York confirmation times and classifies server failures', () => {
  includesAll(app, [
    'timeZone: BUSINESS_TIME_ZONE, hour:',
    'Times use New York time.',
    "title: 'Owner access needed'",
    "title: 'Fix times before paying'",
    "title: 'Payroll changed'",
    "title: 'Payment not recorded'",
  ]);
});

check('payment error helper maps access, duration, stale data, and unknown failures', () => {
  assert.equal(payrollFailureFor({ status: 401 }, {}).title, 'Owner access needed');
  assert.equal(payrollFailureFor({ status: 400 }, {
    code: '22023', message: 'shift duration must be between 1 minute and 24 hours',
  }).title, 'Fix times before paying');
  assert.equal(payrollFailureFor({ status: 409 }, {
    code: '23505', message: 'one or more shifts were already paid',
  }).title, 'Payroll changed');
  assert.equal(payrollFailureFor({ status: 500 }, null).title, 'Payment not recorded');
});

console.log(`\n${total - failed}/${total} payroll payment safety checks passed`);
if (failed) process.exit(1);
