// Static safety checks for migration 030.
//
// Run with: node test-order-payment-integrity-migration.mjs
// No database or network connection is used.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('./migrations/030_order_payment_integrity.sql', import.meta.url),
  'utf8',
);
const rollback = await readFile(
  new URL('./migrations/030_order_payment_integrity_rollback.sql', import.meta.url),
  'utf8',
);

const checks = [];

function check(name, test) {
  test();
  checks.push(name);
}

function body(source, start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `missing ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `missing ${end}`);
  return source.slice(first, last);
}

function ordered(source, labels) {
  let previous = -1;
  for (const label of labels) {
    const next = source.indexOf(label, previous + 1);
    assert.notEqual(next, -1, `missing ordered fragment: ${label}`);
    assert.ok(next > previous, `out-of-order fragment: ${label}`);
    previous = next;
  }
}

function dollarTagsAreBalanced(source) {
  const tags = source.match(/\$[a-z_]*\$/gi) || [];
  const counts = new Map();
  for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  for (const [tag, count] of counts) {
    assert.equal(count % 2, 0, `${tag} must be balanced`);
  }
}

function sqlDelimitersAreBalanced(source) {
  const stack = [];
  const pairs = { ')': '(', ']': '[' };
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('--', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      assert.notEqual(close, -1, 'unterminated block comment');
      index = close + 2;
      continue;
    }
    if (source[index] === "'") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (source[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (source[index] === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (source[index] === '$') {
      const tag = source.slice(index).match(/^\$[a-z_]*\$/i)?.[0];
      if (tag) {
        const close = source.indexOf(tag, index + tag.length);
        assert.notEqual(close, -1, `unterminated ${tag}`);
        index = close + tag.length;
        continue;
      }
    }
    if (source[index] === '(' || source[index] === '[') stack.push(source[index]);
    if (source[index] === ')' || source[index] === ']') {
      assert.equal(stack.pop(), pairs[source[index]], `unbalanced ${source[index]}`);
    }
    index += 1;
  }

  assert.deepEqual(stack, [], 'unclosed SQL delimiter');
}

const paymentSignature =
  'public.hc_apply_verified_order_payment(uuid,text,bigint,bigint,text,bigint,bigint,bigint,text,text)';
const voidSignature =
  'public.hc_apply_verified_order_void(uuid,text,text,bigint,bigint,bigint,text,text)';
const paymentBody = body(
  migration,
  'create function public.hc_apply_verified_order_payment(',
  'revoke all on function public.hc_apply_verified_order_payment(',
);
const voidBody = body(
  migration,
  'create function public.hc_apply_verified_order_void(',
  'revoke all on function public.hc_apply_verified_order_void(',
);
const helperBody = body(
  migration,
  'create function public.hc_can_apply_direct_order_stage_transition(',
  'revoke all on function public.hc_can_apply_direct_order_stage_transition(',
);
const guardBody = body(
  migration,
  'create function public.hc_protect_order_payment_fields()',
  'revoke all on function public.hc_protect_order_payment_fields()',
);

check('forward transaction is explicit', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /commit;\s*$/);
});
check('rollback transaction is explicit', () => {
  assert.match(rollback, /^begin;/m);
  assert.match(rollback, /commit;\s*$/);
});
check('forward dollar tags are balanced', () => dollarTagsAreBalanced(migration));
check('rollback dollar tags are balanced', () => dollarTagsAreBalanced(rollback));
check('forward SQL delimiters are balanced', () => sqlDelimitersAreBalanced(migration));
check('rollback SQL delimiters are balanced', () => sqlDelimitersAreBalanced(rollback));
check('orders total is exact nullable bigint in forward preflight', () => {
  assert.match(
    migration,
    /attname = 'total_cents'[\s\S]{0,240}atttypid = 'pg_catalog\.int8'[\s\S]{0,240}attnotnull is false/,
  );
});
check('orders total is exact nullable bigint in rollback preflight', () => {
  assert.match(
    rollback,
    /attname = 'total_cents'[\s\S]{0,240}atttypid = 'pg_catalog\.int8'[\s\S]{0,240}attnotnull is false/,
  );
});
check('orders market text dependency is checked both ways', () => {
  for (const source of [migration, rollback]) {
    assert.match(
      source,
      /attname = 'market'[\s\S]{0,220}atttypid = 'pg_catalog\.text'/,
    );
  }
});
check('payment input order is exact', () => {
  assert.match(
    paymentBody,
    /p_order_id uuid,\s*p_external_invoice_id text,\s*p_qbo_total_cents bigint,\s*p_qbo_balance_cents bigint,\s*p_expected_stage text,\s*p_expected_total_cents bigint,\s*p_expected_deposit_cents bigint,\s*p_expected_balance_cents bigint,\s*p_idempotency_key text,\s*p_source text default 'quickbooks'/,
  );
});
check('void input order is exact', () => {
  assert.match(
    voidBody,
    /p_order_id uuid,\s*p_external_invoice_id text,\s*p_expected_stage text,\s*p_expected_total_cents bigint,\s*p_expected_deposit_cents bigint,\s*p_expected_balance_cents bigint,\s*p_idempotency_key text,\s*p_source text default 'quickbooks'/,
  );
});
check('old payment signature is absent', () => {
  assert.doesNotMatch(
    migration + rollback,
    /hc_apply_verified_order_payment\(uuid,text,bigint,bigint,text,text\)/,
  );
});
check('old void signature is absent', () => {
  assert.doesNotMatch(
    migration + rollback,
    /hc_apply_verified_order_void\(uuid,text,text,text\)/,
  );
});
check('payment exact signature is asserted throughout', () => {
  assert.ok(migration.split(paymentSignature).length - 1 >= 6);
  assert.ok(rollback.split(paymentSignature).length - 1 >= 5);
});
check('void exact signature is asserted throughout', () => {
  assert.ok(migration.split(voidSignature).length - 1 >= 6);
  assert.ok(rollback.split(voidSignature).length - 1 >= 5);
});
check('payment CAS occurs under lock and before provenance', () => {
  ordered(paymentBody, [
    'for update;',
    'QuickBooks invoice ID does not match the order',
    'v_order.stage is distinct from p_expected_stage',
    'verified payment order snapshot changed',
    'insert into public.verified_order_payment_events',
  ]);
});
check('payment CAS compares all four fields exactly', () => {
  for (const pair of [
    'v_order.stage is distinct from p_expected_stage',
    'v_order.total_cents is distinct from p_expected_total_cents',
    'v_order.deposit_cents is distinct from p_expected_deposit_cents',
    'v_order.balance_cents is distinct from p_expected_balance_cents',
  ]) assert.match(paymentBody, new RegExp(pair));
});
check('payment CAS mismatch is retryable', () => {
  assert.match(
    paymentBody,
    /errcode = '40001',\s*message = 'verified payment order snapshot changed'/,
  );
});
check('payment CAS does not coalesce expected nulls', () => {
  const cas = paymentBody.slice(
    paymentBody.indexOf('v_order.stage is distinct from p_expected_stage'),
    paymentBody.indexOf('insert into public.verified_order_payment_events'),
  );
  assert.doesNotMatch(cas, /coalesce\s*\(/i);
});
check('void CAS occurs under lock and before provenance', () => {
  ordered(voidBody, [
    'for update;',
    'QuickBooks invoice ID does not match the order',
    'v_order.stage is distinct from p_expected_stage',
    'verified void order snapshot changed',
    'insert into public.verified_order_void_events',
  ]);
});
check('void CAS compares all four fields exactly', () => {
  for (const pair of [
    'v_order.stage is distinct from p_expected_stage',
    'v_order.total_cents is distinct from p_expected_total_cents',
    'v_order.deposit_cents is distinct from p_expected_deposit_cents',
    'v_order.balance_cents is distinct from p_expected_balance_cents',
  ]) assert.match(voidBody, new RegExp(pair));
});
check('void CAS mismatch is retryable', () => {
  assert.match(
    voidBody,
    /errcode = '40001',\s*message = 'verified void order snapshot changed'/,
  );
});
check('void safe retry requires existing bound provenance', () => {
  ordered(voidBody, [
    'from public.verified_order_void_events as event_row',
    'v_event.order_id is not distinct from p_order_id',
    'v_event.external_invoice_id is not distinct from p_external_invoice_id',
  ]);
});
check('void safe retry requires unchanged cancelled row', () => {
  assert.match(voidBody, /v_order\.stage = 'cancelled'/);
  assert.match(voidBody, /p_expected_stage is not null/);
  assert.match(voidBody, /p_expected_stage <> 'cancelled'/);
  assert.match(
    voidBody,
    /v_order\.total_cents is not distinct from p_expected_total_cents/,
  );
  assert.match(
    voidBody,
    /v_order\.deposit_cents is not distinct from p_expected_deposit_cents/,
  );
  assert.match(
    voidBody,
    /v_order\.balance_cents is not distinct from p_expected_balance_cents/,
  );
});
check('void safe retry is a no-write false return', () => {
  ordered(voidBody, [
    'select v_order.id, v_order.stage, false;',
    'return;',
    'verified void order snapshot changed',
    'insert into public.verified_order_void_events',
  ]);
});
check('verified zero truth clears the split', () => {
  assert.match(
    paymentBody,
    /if v_received_cents = 0 then\s*v_final_deposit_cents := 0;\s*v_final_balance_cents := 0;/,
  );
});
check('verified zero truth maps non-operational stage to invoiced', () => {
  assert.match(
    paymentBody,
    /else\s*v_payment_stage := 'invoiced';\s*end if;/,
  );
});
check('ledger permanently retains the greatest verified receipt', () => {
  assert.match(
    migration,
    /max_qbo_received_cents = pg_catalog\.greatest\(\s*event_row\.max_qbo_received_cents,\s*p_qbo_total_cents - p_qbo_balance_cents\s*\)/,
  );
  assert.match(helperBody, /payment_event\.max_qbo_received_cents > 0/);
});
check('zero-only reconciliation records no positive evidence', () => {
  assert.match(
    paymentBody,
    /max_qbo_received_cents\s*\)[\s\S]{0,260}p_qbo_total_cents - p_qbo_balance_cents/,
  );
  assert.match(
    migration,
    /max_qbo_received_cents between 0 and 1000000000000/,
  );
});
check('payment sync preserves operational stages', () => {
  assert.match(
    paymentBody,
    /v_order\.stage in \('fulfilled', 'complete', 'cancelled'\)[\s\S]{0,100}v_final_stage := v_order\.stage/,
  );
});
check('direct amount changes are blocked', () => {
  assert.match(guardBody, /new\.deposit_cents is distinct from old\.deposit_cents/);
  assert.match(guardBody, /new\.balance_cents is distinct from old\.balance_cents/);
});
check('direct paid status entry is blocked', () => {
  assert.match(guardBody, /new\.stage in \('deposit_paid', 'paid_full'\)/);
});
check('ordinary cancelled insert is not classified as paid', () => {
  assert.match(
    guardBody,
    /new\.stage in \('deposit_paid', 'paid_full'\)/,
  );
  assert.doesNotMatch(
    guardBody,
    /new\.stage in \('deposit_paid', 'paid_full', 'cancelled'\)/,
  );
});
check('guard delegates stage evidence without reading private rows', () => {
  assert.match(
    guardBody,
    /coalesce\(\s*public\.hc_can_apply_direct_order_stage_transition\(\s*old\.id,\s*old\.stage,\s*new\.stage,\s*old\.deposit_cents,\s*old\.balance_cents\s*\),\s*false\s*\) is false/,
  );
  assert.doesNotMatch(guardBody, /verified_order_(?:payment|void)_events/);
});
check('helper binds calls to the exact visible order snapshot', () => {
  assert.match(
    helperBody,
    /order_row\.stage is not distinct from p_old_stage/,
  );
  assert.match(helperBody, /order_row\.deposit_cents is not distinct from p_deposit_cents/);
  assert.match(helperBody, /order_row\.balance_cents is not distinct from p_balance_cents/);
  assert.match(helperBody, /public\.hc_can_access_order_market\(order_row\.market\)/);
});
check('helper reads positive and void provenance privately', () => {
  assert.match(helperBody, /from public\.verified_order_payment_events/);
  assert.match(helperBody, /from public\.verified_order_void_events/);
  assert.match(helperBody, /coalesce\(p_deposit_cents, 0\) > 0/);
  assert.match(helperBody, /coalesce\(p_balance_cents, 0\) > 0/);
});
check('verified void makes cancelled durable', () => {
  assert.match(
    helperBody,
    /if v_has_verified_void then\s*return p_new_stage = 'cancelled';/,
  );
});
check('positive evidence permits only operational advances', () => {
  assert.match(
    helperBody,
    /p_old_stage in \('deposit_paid', 'paid_full'\)\s*then p_new_stage in \('fulfilled', 'complete'\)/,
  );
  assert.match(
    helperBody,
    /p_old_stage = 'fulfilled'\s*then p_new_stage = 'complete'/,
  );
  assert.match(helperBody, /else false\s*end;/);
});
check('no evidence preserves ordinary unpaid workflow', () => {
  assert.match(
    helperBody,
    /No positive payment evidence and no verified void[\s\S]{0,160}return true;/,
  );
});
check('guard bypass is bound to exact RPC owners', () => {
  assert.match(guardBody, new RegExp(paymentSignature.replace(/[()]/g, '\\$&')));
  assert.match(guardBody, new RegExp(voidSignature.replace(/[()]/g, '\\$&')));
  assert.match(guardBody, /v_payment_rpc_owner = v_void_rpc_owner/);
  assert.match(guardBody, /pg_get_userbyid\(v_payment_rpc_owner\) = current_user::text/);
});
check('guard remains invoker and non-callable', () => {
  assert.match(guardBody, /security invoker/);
  assert.match(
    migration,
    /revoke all on function public\.hc_protect_order_payment_fields\(\)\s*from public, anon, authenticated, service_role;/,
  );
});
check('helper takes a fresh snapshot as security definer', () => {
  assert.match(helperBody, /language plpgsql\s*volatile\s*security definer\s*set search_path = ''/);
});
check('helper denies anonymous direct calls', () => {
  assert.match(
    migration,
    /revoke all on function public\.hc_can_apply_direct_order_stage_transition\([\s\S]*?\) from public, anon, authenticated, service_role, supabase_admin;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.hc_can_apply_direct_order_stage_transition\([\s\S]*?\) to authenticated, service_role, supabase_admin;/,
  );
});
check('payment ledger remains private', () => {
  assert.match(
    migration,
    /alter table public\.verified_order_payment_events enable row level security;/,
  );
  assert.match(
    migration,
    /revoke all on table public\.verified_order_payment_events\s*from public, anon, authenticated, service_role, supabase_admin;/,
  );
});
check('void ledger remains private', () => {
  assert.match(
    migration,
    /alter table public\.verified_order_void_events enable row level security;/,
  );
  assert.match(
    migration,
    /revoke all on table public\.verified_order_void_events\s*from public, anon, authenticated, service_role, supabase_admin;/,
  );
});
check('only trusted backend roles execute payment RPC', () => {
  assert.match(
    migration,
    /grant execute on function public\.hc_apply_verified_order_payment\([\s\S]*?\) to service_role, supabase_admin;/,
  );
});
check('only trusted backend roles execute void RPC', () => {
  assert.match(
    migration,
    /grant execute on function public\.hc_apply_verified_order_void\([\s\S]*?\) to service_role, supabase_admin;/,
  );
});
check('payment catalog requires exact argument names and default', () => {
  assert.match(migration, /function_info\.pronargs = 10/);
  assert.match(migration, /function_info\.pronargdefaults = 1/);
  assert.match(migration, /'p_expected_total_cents'/);
  assert.match(migration, /pg_get_expr\(function_info\.proargdefaults, 0\)/);
});
check('void catalog requires exact argument names and default', () => {
  assert.match(migration, /function_info\.pronargs = 8/);
  assert.match(migration, /'p_expected_balance_cents'/);
});
check('rollback checks exact argument catalogs', () => {
  assert.match(rollback, /function_info\.pronargs = 10/);
  assert.match(rollback, /function_info\.pronargs = 8/);
  assert.match(rollback, /function_info\.pronargdefaults = 1/);
});
check('helper catalog and owner are exact in forward and rollback', () => {
  for (const source of [migration, rollback]) {
    assert.match(source, /function_info\.pronargs = 5/);
    assert.match(source, /function_info\.pronargdefaults = 0/);
    assert.match(source, /function_info\.provolatile = 'v'/);
    assert.match(source, /hc_can_apply_direct_order_stage_transition\(uuid,text,text,bigint,bigint\)/);
  }
});
check('rollback refuses payment provenance', () => {
  assert.match(
    rollback,
    /from public\.verified_order_payment_events[\s\S]{0,160}rollback blocked: preserve recorded payment audit events/,
  );
});
check('rollback refuses void provenance', () => {
  assert.match(
    rollback,
    /from public\.verified_order_void_events[\s\S]{0,160}rollback blocked: preserve recorded void audit events/,
  );
});
check('rollback drops exact payment contract', () => {
  assert.match(
    rollback,
    /drop function public\.hc_apply_verified_order_payment\(\s*uuid, text, bigint, bigint, text, bigint, bigint, bigint, text, text\s*\);/,
  );
});
check('rollback drops exact void contract', () => {
  assert.match(
    rollback,
    /drop function public\.hc_apply_verified_order_void\(\s*uuid, text, text, bigint, bigint, bigint, text, text\s*\);/,
  );
});
check('rollback drops exact provenance helper', () => {
  assert.match(
    rollback,
    /drop function public\.hc_can_apply_direct_order_stage_transition\(\s*uuid, text, text, bigint, bigint\s*\);/,
  );
});
check('payment ledger catalog requires all eight constraints', () => {
  for (const source of [migration, rollback]) {
    assert.match(
      source,
      /where constraint_info\.conrelid = v_events_oid\s*\) <> 8/,
    );
  }
});
check('ledger index ordering uses PostgreSQL 17 catalog properties', () => {
  for (const source of [migration, rollback]) {
    assert.equal(
      source.match(
        /pg_get_indexdef\(index_info\.indexrelid, 2, true\) = 'last_seen_at'/g,
      )?.length,
      2,
    );
    assert.equal(
      source.match(/pg_index_column_has_property\([\s\S]{0,120}'desc'[\s\S]{0,40}\) is true/g)?.length,
      2,
    );
    assert.equal(
      source.match(/pg_index_column_has_property\([\s\S]{0,120}'nulls_first'[\s\S]{0,40}\) is true/g)?.length,
      2,
    );
    assert.doesNotMatch(
      source,
      /pg_get_indexdef\(index_info\.indexrelid, 2, true\) = 'last_seen_at DESC'/,
    );
  }
});
check('business transition matrix matches required workflow', () => {
  function allowed({ oldStage, newStage, deposit = 0, balance = 0, positiveHistory = false, voidHistory = false }) {
    if (oldStage === newStage) return true;
    if (newStage === 'deposit_paid' || newStage === 'paid_full') return false;
    const paymentEvidence = deposit > 0 || balance > 0 || positiveHistory;
    if (voidHistory) return newStage === 'cancelled';
    if (!paymentEvidence) return true;
    if (oldStage === 'deposit_paid' || oldStage === 'paid_full') {
      return newStage === 'fulfilled' || newStage === 'complete';
    }
    if (oldStage === 'fulfilled') return newStage === 'complete';
    return false;
  }

  assert.equal(allowed({ oldStage: 'complete', newStage: 'invoiced' }), true);
  assert.equal(allowed({ oldStage: 'fulfilled', newStage: 'invoiced' }), true);
  assert.equal(allowed({ oldStage: 'invoiced', newStage: 'cancelled' }), true);
  assert.equal(allowed({ oldStage: 'cancelled', newStage: 'quoted' }), true);
  assert.equal(allowed({ oldStage: 'invoiced', newStage: 'quoted', positiveHistory: false }), true);
  assert.equal(allowed({ oldStage: 'complete', newStage: 'invoiced', positiveHistory: true }), false);
  assert.equal(allowed({ oldStage: 'paid_full', newStage: 'cancelled', positiveHistory: true }), false);
  assert.equal(allowed({ oldStage: 'cancelled', newStage: 'quoted', voidHistory: true }), false);
  assert.equal(allowed({ oldStage: 'deposit_paid', newStage: 'fulfilled', deposit: 100 }), true);
  assert.equal(allowed({ oldStage: 'fulfilled', newStage: 'complete', positiveHistory: true }), true);
});
check('forward migration never deletes existing order data', () => {
  assert.doesNotMatch(migration, /\b(?:delete\s+from|truncate\s+table|drop\s+table\s+public\.orders)\b/i);
});

for (const name of checks) console.log(`PASS  ${name}`);
console.log(`PASS  ${checks.length}/${checks.length} migration 030 static safety checks`);
