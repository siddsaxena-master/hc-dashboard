// Offline SQL-contract checks and authorization fixtures. No database, network,
// secrets, logos, or customer email. A PostgreSQL rehearsal is still required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [sql, originalSql, deliverySql] = await Promise.all([
  readFile(join(root, 'migrations/035_order_logo_assets.sql'), 'utf8'),
  readFile(join(root, 'migrations/019_dashboard_auth_transition.sql'), 'utf8'),
  readFile(join(root, 'migrations/034_calendar_delivery_details.sql'), 'utf8'),
]);
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
function between(text, first, last) {
  const start = text.indexOf(first);
  assert.ok(start >= 0, `missing ${first}`);
  const end = text.indexOf(last, start + first.length);
  assert.ok(end >= 0, `missing ${last}`);
  return text.slice(start + first.length, end);
}
const anchor = between(sql, '$anchor$', '$anchor$');
const addition = between(sql, '$addition$', '$addition$');
const deliveryAnchor = between(deliverySql, '$anchor$', '$anchor$');
const deliveryAddition = between(deliverySql, '$addition$', '$addition$');
const helper = between(sql,
  'create or replace function public.hc_can_read_order_logo(p_name text)',
  'revoke all on function public.hc_can_read_order_logo(text)');

check('metadata stays nullable and nothing backfills orders or uploads assets', () => {
  assert.match(sql, /add column if not exists logo_asset jsonb;/);
  assert.match(sql, /logo_asset is null or pg_catalog\.jsonb_typeof\(logo_asset\) = 'object'/);
  assert.doesNotMatch(sql, /\b(?:update|insert\s+into|delete\s+from)\s+public\.orders/i);
  assert.doesNotMatch(sql, /\b(?:insert\s+into|update|delete\s+from)\s+storage\.objects/i);
});
check('bucket is private and an existing public bucket aborts', () => {
  assert.match(sql, /where id = 'order-logos' and public is distinct from false/);
  assert.match(sql, /values \('order-logos', 'order-logos', false\)\s+on conflict \(id\) do nothing/);
  assert.match(sql, /v_public is distinct from false/);
  assert.match(sql, /where bucket\.id = 'order-logos'\s+for update/);
  assert.doesNotMatch(sql, /\bupdate\s+storage\.buckets/i);
  assert.match(sql, /'storage\.objects'::regclass and relrowsecurity is true/);
});
check('logo reader is a read-only locked-down function with current roster checks', () => {
  assert.match(helper, /language sql\s+stable\s+security definer\s+set search_path = ''/);
  for (const guard of [
    'select auth.uid() is not null', 'worker.auth_user_id = auth.uid()',
    'worker.active is true', "lower(trim(worker.role)) = 'owner'",
    "lower(trim(worker.role)) in ('manager', 'team')",
    "nullif(lower(trim(worker.market)), '') is not null",
    "nullif(lower(trim(order_row.market)), '') is not null",
    'lower(trim(order_row.market)) = lower(trim(worker.market))',
  ]) assert.ok(helper.includes(guard), `missing guard: ${guard}`);
  assert.doesNotMatch(helper, /\b(?:insert|update|delete)\b|storage\.objects/i);
  assert.match(sql, /revoke all on function public\.hc_can_read_order_logo\(text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.hc_can_read_order_logo\(text\) to authenticated;/);
});
check('only selected string paths can authorize a logo read', () => {
  assert.match(helper, /jsonb_array_elements\(\s+case when pg_catalog\.jsonb_typeof\(order_row\.logo_asset -> 'files'\) = 'array'\s+then order_row\.logo_asset -> 'files' else '\[\]'::jsonb end/);
  for (const key of ['original_path', 'preview_path']) {
    assert.ok(helper.includes(`pg_catalog.jsonb_typeof(logo_file.value -> '${key}') = 'string'`));
    assert.ok(helper.includes(`logo_file.value ->> '${key}' = p_name`));
  }
  assert.doesNotMatch(helper, /\blike\b|starts_with|source_ref|invoice_pdf_url/i);
});
check('read policies resist broader existing policies and do not grant writes', () => {
  assert.match(sql, /as permissive for select to authenticated\s+using \(bucket_id = 'order-logos' and public\.hc_can_read_order_logo\(name\)\)/);
  assert.match(sql, /as restrictive for select to authenticated\s+using \(case when bucket_id = 'order-logos'\s+then public\.hc_can_read_order_logo\(name\) else true end\)/);
  assert.match(sql, /as restrictive for select to anon\s+using \(bucket_id <> 'order-logos'\)/);
  assert.doesNotMatch(sql, /\bfor\s+(?:all|insert|update|delete)\s+to\b/i);
  assert.equal([...sql.matchAll(/create policy /g)].length, 3);
});
check('projection whitelists logo fields without email references or invoice links', () => {
  const fields = [...addition.matchAll(/'([a-z_]+)', o\.logo_asset -> '([a-z_]+)'/g)];
  assert.deepEqual(fields.map((match) => match[1]), [
    'status', 'checked_at', 'source_received_at',
  ]);
  assert.ok(fields.every((match) => match[1] === match[2]));
  const fileFields = [...addition.matchAll(/'([a-z_]+)', logo_file\.value -> '([a-z_]+)'/g)];
  assert.deepEqual(fileFields.map((match) => match[1]), [
    'file_name', 'mime_type', 'original_path', 'preview_path', 'usage',
  ]);
  assert.ok(fileFields.every((match) => match[1] === match[2]));
  assert.match(addition, /jsonb_typeof\(o\.logo_asset -> 'files'\) = 'array'/);
  assert.match(addition, /order by logo_file\.position/);
  assert.match(addition, /with ordinality as logo_file\(value, position\)/);
  assert.doesNotMatch(addition, /source_ref|invoice_pdf_url|external_invoice_url|email|else o\.logo_asset/);
});
check('034 and 035 preserve all original order access code and commute', () => {
  const original = between(originalSql,
    'create or replace function public.hc_list_orders_for_current_user(',
    'revoke all on function public.hc_list_orders_for_current_user(');
  assert.equal(original.split(anchor).length - 1, 1);
  const addLogo = (text) => text.replace(anchor, anchor + addition);
  const addDelivery = (text) => text.replace(deliveryAnchor, deliveryAnchor + deliveryAddition);
  const patched = addLogo(addDelivery(original));
  assert.equal(patched, addDelivery(addLogo(original)));
  assert.equal(patched.replace(anchor + addition, anchor)
    .replace(deliveryAnchor + deliveryAddition, deliveryAnchor), original);
  for (const property of ['proacl', 'proowner', 'prosecdef', 'proconfig']) {
    assert.ok(sql.includes(`${property} is distinct from`));
  }
  assert.match(sql, /v_target <> v_public and pg_catalog\.pg_get_functiondef\(v_public\) <> v_public_before/);
  assert.match(sql, /pg_catalog\.strpos\(v_before, v_anchor \|\| v_addition\) > 0/);
});

// Mirror the reviewed predicate to exercise authorization cases. This is not
// a substitute for executing the actual SQL with authenticated fixture roles.
const normalized = (value) => String(value ?? '').trim().toLowerCase();
function canRead(userId, name, orders, workers) {
  return !!userId && typeof name === 'string' && name.length > 0 && orders.some((order) =>
    workers.some((worker) => worker.auth_user_id === userId && worker.active === true && (
      normalized(worker.role) === 'owner' || (
        ['manager', 'team'].includes(normalized(worker.role)) && normalized(worker.market) &&
        normalized(order.market) && normalized(order.market) === normalized(worker.market)
      )
    )) && (Array.isArray(order.logo_asset?.files) ? order.logo_asset.files : []).some((file) =>
      file && typeof file === 'object' && ['original_path', 'preview_path'].some((key) =>
        typeof file[key] === 'string' && file[key] === name)));
}
check('fixtures cover owner, exact market, private paths, missing roles, and revocation', () => {
  const orders = [
    { market: ' NY ', logo_asset: { files: [
      { original_path: 'a/logo.ai', preview_path: 'a/preview.png', usage: 'Coconut front' },
      { original_path: 'a/back.svg', preview_path: 'a/back-preview.png', usage: 'Coconut back' },
    ] } },
    { market: 'miami', logo_asset: { files: [{ original_path: 'b/logo.pdf' }] } },
    { market: null, logo_asset: { files: [{ original_path: 'c/logo.png' }] } },
    { market: 'ny', logo_asset: { files: [{ original_path: { path: 'malformed' } }] } },
    { market: 'ny', logo_asset: { files: { original_path: 'malformed-array' } } },
  ];
  const workers = [
    { auth_user_id: 'owner', active: true, role: 'owner', market: null },
    { auth_user_id: 'manager', active: true, role: 'manager', market: 'ny' },
    { auth_user_id: 'team', active: true, role: ' TEAM ', market: ' NY ' },
    { auth_user_id: 'inactive', active: false, role: 'owner' },
    { auth_user_id: 'blank', active: true, role: 'manager', market: ' ' },
    { auth_user_id: 'other', active: true, role: 'guest', market: 'ny' },
  ];
  const read = (user, name) => canRead(user, name, orders, workers);
  assert.equal(read('owner', 'b/logo.pdf'), true);
  assert.equal(read('owner', 'c/logo.png'), true);
  for (const user of ['manager', 'team']) {
    assert.equal(read(user, 'a/logo.ai'), true);
    assert.equal(read(user, 'a/preview.png'), true);
    assert.equal(read(user, 'a/back.svg'), true);
    assert.equal(read(user, 'a/back-preview.png'), true);
    assert.equal(read(user, 'b/logo.pdf'), false);
    assert.equal(read(user, 'c/logo.png'), false);
  }
  for (const user of [null, '', 'unknown', 'inactive', 'blank', 'other']) {
    assert.equal(read(user, 'a/logo.ai'), false);
  }
  assert.equal(read('owner', ''), false);
  assert.equal(read('owner', 'a/other.png'), false);
  assert.equal(read('owner', 'a/logo.ai/extra'), false);
  assert.equal(read('owner', 'malformed'), false);
  assert.equal(read('owner', 'malformed-array'), false);
  orders[0].logo_asset.files[0].original_path = 'a/replacement.ai';
  assert.equal(read('manager', 'a/logo.ai'), false);
  assert.equal(read('manager', 'a/replacement.ai'), true);
  workers.find((worker) => worker.auth_user_id === 'manager').market = 'miami';
  assert.equal(read('manager', 'a/replacement.ai'), false);
});

console.log(`${checks} logo storage checks passed. PostgreSQL and Storage runtime rehearsal remain required.`);
