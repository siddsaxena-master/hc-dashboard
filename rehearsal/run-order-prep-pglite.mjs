// Synthetic, in-memory PostgreSQL only. Never accepts a connection URL.
// node rehearsal/run-order-prep-pglite.mjs <absolute @electric-sql/pglite package directory>
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
const files = await Promise.all([
  'rehearsal/calendar-logo-local-setup.sql',
  'migrations/019_dashboard_auth_transition.sql',
  'migrations/034_calendar_delivery_details.sql',
  'migrations/035_order_logo_assets.sql',
  'migrations/036_order_prep_workflow.sql',
].map(file => readFile(join(root, file), 'utf8')));
const [fixture, original, migration034, migration035, migration] = files;
const guard = "current_database() <> 'hc_calendar_logo_rehearsal'";
assert.equal(fixture.split(guard).length, 2);
const setup = fixture.replace(guard, "current_database() <> 'postgres'");
const from = original.indexOf('create or replace function public.hc_list_orders_for_current_user(');
const to = original.indexOf('-- Delivery confirmation is the one write allowed', from);
assert.ok(from >= 0 && to > from);
const users = Object.fromEntries(['owner','manager','team','inactive','guest','blank','miami']
  .map((name, index) => [name, `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const orders = [1,2,3,4].map(id => `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`);
const photoId = index => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
let db;
let passed = 0;
let displayedArtwork = null;
function artworkIdentity(asset) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' ? value : null;
  return {
    status:string(asset?.status), checked_at:string(asset?.checked_at),
    files:(Array.isArray(asset?.files) ? asset.files : []).filter(object).map(file =>
      Object.fromEntries(['file_name','mime_type','original_path','preview_path','usage'].map(key => [key,string(file[key])]))),
  };
}
const pass = message => { passed++; console.log(`PASS: ${message}`); };
async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0]?.value; }
async function identity(name = null, role = 'authenticated') {
  await db.exec('reset role;');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [name ? users[name] ?? name : '']);
  if (role !== 'postgres') await db.exec(`set role ${role};`);
}
async function denied(label, sql, params = [], code = '42501') {
  await assert.rejects(db.query(sql, params), error => error.code === code, label);
  pass(label);
}
const get = order => scalar('select public.hc_get_order_prep_state($1) as value', [order]);
const save = (order, version, patch, expected = displayedArtwork) => scalar('select public.hc_save_order_prep_state($1,$2,$3::jsonb,$4::jsonb) as value', [order, version, JSON.stringify(patch),JSON.stringify(expected)]);
const reserve = (order, id, captured, expected = displayedArtwork) => scalar('select public.hc_reserve_order_prep_photo($1,$2,$3,$4::jsonb) as value', [order,id,captured,JSON.stringify(expected)]);
const finish = (order, id) => scalar('select public.hc_finish_order_prep_photo($1,$2) as value', [order,id]);
const insertPhoto = (path, metadata = { size: 1200, mimetype: 'image/jpeg' }) => db.query(
  'insert into storage.objects(bucket_id,name,metadata) values ($1,$2,$3::jsonb)',
  ['order-prep-media',path,JSON.stringify(metadata)]);

try {
  db = await PGlite.create();
  const ident = (await db.query('select current_database() as name, version() as version')).rows[0];
  assert.equal(ident.name, 'postgres');
  assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  console.log('Running real SQL with synthetic rows only in in-memory PGlite 0.5.8.');
  await db.exec(setup + original.slice(from,to));
  // Add actual Storage metadata/configuration column names absent from the old
  // read-only fixture. The real migrations themselves are never rewritten.
  await db.exec(`alter table storage.buckets add column file_size_limit bigint, add column allowed_mime_types text[];
    alter table storage.objects add column metadata jsonb, add constraint object_path_unique unique(bucket_id,name);
    grant insert,update,delete on storage.objects to anon,authenticated;
    grant usage on sequence storage.objects_id_seq to anon,authenticated;
    create policy rehearsal_existing_broad_write on storage.objects for all to public using (true) with check (true);`);
  for (const sql of [migration034,migration035,migration,migration]) await db.exec(sql);
  pass('real migration applies and reruns without changing unrelated migrations');
  assert.deepEqual(await scalar("select jsonb_build_object('public',public,'size',file_size_limit,'mime',allowed_mime_types) as value from storage.buckets where id='order-prep-media'"),
    { public:false,size:8388608,mime:['image/jpeg'] });
  pass('private bucket has JPEG-only and 8 MiB configuration');
  const invoiceBefore = await db.query('select * from public.orders order by id');
  const capture = new Date().toISOString();
  const logo = { status:'received',checked_at:capture,source_ref:'secret-email-thread',files:[{preview_path:'selected/logo.png',usage:'Coconut'}] };
  displayedArtwork = artworkIdentity(logo);
  await db.query('update public.orders set logo_asset=$1::jsonb where id=$2', [JSON.stringify(logo),orders[0]]);
  assert.deepEqual(await scalar('select public.hc_order_prep_artwork_identity($1::jsonb) as value',[JSON.stringify(logo)]),displayedArtwork);
  assert.deepEqual(await scalar('select public.hc_order_prep_artwork_identity($1::jsonb) as value',[JSON.stringify({status:1,checked_at:true,files:[null,3,[],{file_name:9,usage:' Circle '}]})]),
    artworkIdentity({status:1,checked_at:true,files:[null,3,[],{file_name:9,usage:' Circle '}]}));
  pass('server identity matches staff-visible raw string projection and safely filters malformed file entries');
  assert.equal(await scalar("select count(*)::int as value from pg_proc where pronamespace='public'::regnamespace and proname='hc_save_order_prep_state'"),1);
  assert.equal(await scalar("select count(*)::int as value from pg_proc where pronamespace='public'::regnamespace and proname='hc_reserve_order_prep_photo'"),1);
  pass('save and reserve have only the new four-argument function signatures');
  await identity('team');
  let state = await get(orders[0]);
  assert.equal(state.version,0);
  assert.equal(state.cracking_method,null);
  assert.equal(state.staffing,null);
  assert.equal(state.onsite_cracking_method,null);
  assert.equal(state.latest_sample,null);
  assert.ok(Object.values(state.checks).every(value => value === false));
  pass('new order has unknown requirements and no invented completions');
  for (const [label,patch] of [
    ['team cannot rewrite cracking requirements',{cracking_method:'circle'}],
    ['team cannot rewrite staffing requirements',{staffing:true}],
    ['team cannot rewrite on-site cracking requirements',{onsite_cracking_method:'cocktail'}],
  ]) await denied(label,'select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],JSON.stringify(patch)]);
  await denied('unknown cracking cannot be marked checked','select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],'{"checks":{"cracking_checked":true}}'],'22023');
  await denied('unknown staffing cannot certify tools','select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],'{"checks":{"circle_tools_packed":true}}'],'22023');
  for (const patch of [{total_cents:0},{updated_by:users.owner},{checks:{invented:true}},{stamp_checked:'true'},{checks:null}]) {
    await denied('invalid or forged patch is rejected','select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],JSON.stringify(patch)],'22023');
  }
  await denied('stamp check cannot omit the artwork displayed on the phone',
    'select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],'{"stamp_checked":true}'],'40001');
  state = await save(orders[0],0,{stamp_checked:true,checks:{straws_packed:true}});
  assert.equal(state.version,1);
  assert.equal(state.stamp_checked,true);
  assert.equal(state.checks.straws_packed,true);
  pass('team can confirm physical stamp and straws');
  pass('private source references are not required in the crew artwork confirmation');
  await denied('stale device cannot overwrite checklist','select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],'{"stamp_checked":false}'],'40001');
  await identity('manager');
  state = await save(orders[0],1,{cracking_method:'circle',staffing:true,onsite_cracking_method:'circle'});
  assert.equal(state.cracking_method,'circle');
  pass('same-market manager can set distinct circle requirements');
  await identity('team');
  await denied('cocktail tools do not satisfy circle instructions','select public.hc_save_order_prep_state($1,2,$2::jsonb)',[orders[0],'{"checks":{"cocktail_tools_packed":true}}'],'22023');
  state = await save(orders[0],2,{checks:{cracking_checked:true,circle_tools_packed:true}});
  assert.equal(state.checks.cracking_checked,true);
  assert.equal(state.checks.circle_tools_packed,true);
  pass('team confirms known cracking and matching tools');
  await identity('manager');
  state = await save(orders[0],3,{cracking_method:'cocktail',onsite_cracking_method:'cocktail',checks:{cracking_checked:true,cocktail_tools_packed:true}});
  assert.equal(state.checks.cracking_checked,false);
  assert.equal(state.checks.circle_tools_packed,false);
  assert.equal(state.checks.cocktail_tools_packed,false);
  assert.equal(state.checks.straws_packed,true);
  pass('changed requirements invalidate old checks and require a fresh confirmation');
  await identity('team');
  const first = await reserve(orders[0],photoId(1),capture);
  assert.equal(first.path,`${orders[0]}/${users.team}/${photoId(1)}.jpg`);
  assert.deepEqual(await reserve(orders[0],photoId(1),capture),first);
  pass('photo reservation is server-named and retry-safe');
  await denied('missing upload cannot become a completed sample','select public.hc_finish_order_prep_photo($1,$2)',[orders[0],photoId(1)],'22023');
  await denied('unreserved file path cannot be uploaded','insert into storage.objects(bucket_id,name) values ($1,$2)',['order-prep-media','forged.jpg']);
  await insertPhoto(first.path);
  assert.equal(await scalar('select count(*)::int as value from storage.objects where name=$1',[first.path]),1);
  pass('uploader can read own pending upload');
  await identity('manager');
  assert.equal(await scalar('select count(*)::int as value from storage.objects where name=$1',[first.path]),0);
  pass('other workers cannot read unfinished private samples');
  await denied('manager cannot finalize another worker photo','select public.hc_finish_order_prep_photo($1,$2)',[orders[0],photoId(1)]);
  await denied('manager cannot claim another worker reserved identity','select public.hc_reserve_order_prep_photo($1,$2,$3,$4::jsonb)',[orders[0],photoId(1),capture,JSON.stringify(displayedArtwork)]);
  await denied('manager cannot upload into another worker reservation','insert into storage.objects(bucket_id,name) values ($1,$2)',['order-prep-media',first.path]);
  await identity('team');
  state = await finish(orders[0],photoId(1));
  assert.equal(state.latest_sample.id,photoId(1));
  assert.equal(state.confirmed_photo_id,photoId(1));
  assert.equal(state.confirmed_photo_path,first.path);
  assert.equal(state.latest_sample.artwork_current,true);
  const finishVersion = state.version;
  assert.equal((await finish(orders[0],photoId(1))).version,finishVersion);
  assert.ok(!JSON.stringify(state).includes('source_ref') && !JSON.stringify(state).includes('secret-email-thread')
    && !JSON.stringify(state).includes('client_email') && !JSON.stringify(state).includes('total_cents'));
  pass('finalization is retry-safe and returns only safe operational metadata');
  await identity(null,'postgres');
  await db.query("update public.orders set logo_asset=logo_asset || $1::jsonb where id=$2",[
    JSON.stringify({source_ref:'different-private-email-thread',source_received_at:capture}),orders[0]]);
  await identity('team');
  const privateOnlyChange = await get(orders[0]);
  assert.equal(privateOnlyChange.stamp_checked,true);
  assert.equal(privateOnlyChange.latest_sample.artwork_current,true);
  await reserve(orders[0],photoId(9),capture);
  pass('private source-reference changes preserve stamp/sample relevance and accept the unchanged crew identity');
  await denied('finished photo cannot be overwritten by upload','insert into storage.objects(bucket_id,name,metadata) values ($1,$2,$3::jsonb)',['order-prep-media',first.path,'{"size":10,"mimetype":"image/jpeg"}']);
  assert.equal((await db.query('update storage.objects set name=$1 where name=$2 returning id',['overwritten.jpg',first.path])).rows.length,0);
  assert.equal((await db.query('delete from storage.objects where name=$1 returning id',[first.path])).rows.length,0);
  pass('old broad policies cannot enable sample updates or deletes');
  await denied('cannot move an old-bucket object into prep bucket','update storage.objects set bucket_id=$1 where name=$2',['order-prep-media','unchanged.txt']);
  for (const table of ['order_prep_state','order_prep_photos','order_prep_audit']) {
    await denied(`client cannot directly read ${table}`,`select * from public.${table}`);
    await denied(`client cannot directly delete ${table}`,`delete from public.${table}`);
  }
  await identity('manager');
  assert.equal(await scalar('select count(*)::int as value from storage.objects where name=$1',[first.path]),1);
  pass('same-market manager reads completed sample');
  for (const who of ['inactive','guest','blank','miami',null,'20000000-0000-4000-8000-000000000099']) {
    await identity(who);
    await denied(`wrong or missing roster access denied (${who})`,'select public.hc_get_order_prep_state($1)',[orders[0]]);
    await denied(`wrong or missing roster write denied (${who})`,'select public.hc_save_order_prep_state($1,0,$2::jsonb)',[orders[0],'{"stamp_checked":true}']);
    await denied(`wrong or missing roster reservation denied (${who})`,'select public.hc_reserve_order_prep_photo($1,$2,$3)',[orders[0],photoId(99),capture]);
    assert.equal(await scalar('select count(*)::int as value from storage.objects where name=$1',[first.path]),0);
  }
  pass('cross-market, inactive, blank-market, unregistered and signed-out storage reads are denied');
  await identity('team');
  await denied('team cannot open unassigned-market order','select public.hc_get_order_prep_state($1)',[orders[2]]);
  await identity('owner');
  assert.equal((await get(orders[2])).version,0);
  await save(orders[1],0,{staffing:false,cracking_method:'straw_hole'});
  pass('owner has explicit global access including unassigned market');
  state = await save(orders[3],0,{staffing:true,cracking_method:'whole'});
  await denied('whole prep with unknown on-site method cannot certify tools',
    'select public.hc_save_order_prep_state($1,$2,$3::jsonb)',[orders[3],state.version,'{"checks":{"cocktail_tools_packed":true}}'],'22023');
  state = await save(orders[3],state.version,{onsite_cracking_method:'cocktail'});
  await identity('team');
  state = await save(orders[3],state.version,{checks:{cracking_checked:true,cocktail_tools_packed:true}});
  assert.equal(state.cracking_method,'whole');
  assert.equal(state.onsite_cracking_method,'cocktail');
  assert.equal(state.checks.cocktail_tools_packed,true);
  pass('whole prep and staffed cocktail opening remain independent requirements');
  await identity('owner');
  state = await save(orders[3],state.version,{cracking_method:'circle'});
  assert.equal(state.checks.cocktail_tools_packed,true);
  assert.equal(state.checks.cracking_checked,false);
  pass('changing prep method does not erase a valid independent on-site tool check');
  state = await save(orders[3],state.version,{staffing:false});
  assert.equal(state.checks.cocktail_tools_packed,false);
  pass('removing staffing resets event tool checks');
  await identity('owner','anon');
  await denied('anonymous RPC denied even with forged owner-like subject','select public.hc_get_order_prep_state($1)',[orders[0]]);
  await denied('anonymous helper denied','select public.hc_can_access_order_prep_photo($1,false)',[first.path]);
  await denied('anonymous file insert denied despite broad policy','insert into storage.objects(bucket_id,name) values ($1,$2)',['order-prep-media','anon.jpg']);
  assert.equal(await scalar("select count(*)::int as value from storage.objects where bucket_id='order-prep-media'"),0);
  assert.equal(await scalar("select count(*)::int as value from storage.objects where bucket_id='existing-private'"),1);
  pass('anonymous reads denied while unrelated bucket policy stays unchanged');
  await identity('team');
  await denied('photo reservation cannot omit the artwork displayed on the phone',
    'select public.hc_reserve_order_prep_photo($1,$2,$3)',[orders[0],photoId(90),capture],'40001');
  const stale = await reserve(orders[0],photoId(2),capture);
  await insertPhoto(stale.path);
  await identity(null,'postgres');
  await db.query("update public.orders set logo_asset=jsonb_set(logo_asset,'{files,0,preview_path}','\"replacement/logo.png\"'::jsonb) where id=$1",[orders[0]]);
  await identity('team');
  await denied('artwork changes with identical checked_at still reject stale sample finalization','select public.hc_finish_order_prep_photo($1,$2)',[orders[0],photoId(2)],'40001');
  assert.equal((await get(orders[0])).latest_sample.artwork_current,false);
  assert.equal((await get(orders[0])).stamp_checked,false);
  pass('previous finished sample visibly becomes stale after artwork changes');
  await denied('old displayed artwork cannot bind a stamp check to newer server artwork',
    'select public.hc_save_order_prep_state($1,$2,$3::jsonb,$4::jsonb)',
    [orders[0],(await get(orders[0])).version,'{"stamp_checked":true}',JSON.stringify(displayedArtwork)],'40001');
  await denied('old displayed artwork cannot bind a reserved photo to newer server artwork',
    'select public.hc_reserve_order_prep_photo($1,$2,$3,$4::jsonb)',
    [orders[0],photoId(90),capture,JSON.stringify(displayedArtwork)],'40001');
  displayedArtwork = artworkIdentity({...logo,files:[{preview_path:'replacement/logo.png',usage:'Coconut'}]});
  await denied('changed artwork requires a new physical stamp check before reserving photos',
    'select public.hc_reserve_order_prep_photo($1,$2,$3,$4::jsonb)',[orders[0],photoId(90),capture,JSON.stringify(displayedArtwork)],'22023');
  state = await get(orders[0]);
  state = await save(orders[0],state.version,{stamp_checked:true});
  assert.equal(state.stamp_checked,true);
  pass('new physical stamp check stores the current artwork on the server');
  for (const [id,metadata] of [[3,{size:8388609,mimetype:'image/jpeg'}],[4,{size:10,mimetype:'image/png'}],[5,{size:'garbage',mimetype:'image/jpeg'}],[6,{size:0,mimetype:'image/jpeg'}]]) {
    const reserved = await reserve(orders[0],photoId(id),capture);
    await insertPhoto(reserved.path,metadata);
    await denied('bad uploaded metadata cannot be finalized','select public.hc_finish_order_prep_photo($1,$2)',[orders[0],photoId(id)],'22023');
  }
  const retake = await reserve(orders[0],photoId(7),capture);
  await insertPhoto(retake.path);
  state = await finish(orders[0],photoId(7));
  assert.equal(state.latest_sample.id,photoId(7));
  assert.equal(state.latest_sample.artwork_current,true);
  pass('retake becomes latest sample without replacing the earlier file');
  const oldReceipt = await finish(orders[0],photoId(1));
  assert.equal(oldReceipt.confirmed_photo_id,photoId(1));
  assert.equal(oldReceipt.confirmed_photo_path,first.path);
  assert.equal(oldReceipt.latest_sample.id,photoId(7));
  pass('retry receipt identifies the exact old photo even when a newer sample exists');
  await denied('order without a checked stamp cannot reserve a sample',
    'select public.hc_reserve_order_prep_photo($1,$2,$3,$4::jsonb)',[orders[3],photoId(8),capture,JSON.stringify(artworkIdentity(null))],'22023');
  state = await get(orders[3]);
  await denied('missing artwork cannot become a checked stamp',
    'select public.hc_save_order_prep_state($1,$2,$3::jsonb,$4::jsonb)',[orders[3],state.version,'{"stamp_checked":true}',JSON.stringify(artworkIdentity(null))],'22023');
  await denied('client cannot forge the server stamp artwork snapshot',
    'select public.hc_save_order_prep_state($1,$2,$3::jsonb)',[orders[3],state.version,'{"stamp_artwork_snapshot":{}}'],'22023');
  await identity(null,'postgres');
  const retained = await scalar('select count(*)::int as value from public.order_prep_photos where order_id=$1 and finished_at is not null',[orders[0]]);
  assert.equal(retained,2);
  assert.equal(await scalar("select count(*)::int as value from public.order_prep_audit where action='sample_finished' and order_id=$1",[orders[0]]),2);
  assert.equal(await scalar("select count(*)::int as value from public.order_prep_audit where action='sample_reserved' and details->>'photo_id'=$1",[photoId(1)]),1);
  assert.equal(await scalar('select bool_and(actor_id is not null and recorded_at is not null) as value from public.order_prep_audit'),true);
  pass('audit records real authenticated actor and server time, retaining retakes without duplicate retries');
  const invoiceAfter = await db.query('select * from public.orders order by id');
  const withoutLogo = result => result.rows.map(({logo_asset,...row}) => row);
  assert.deepEqual(withoutLogo(invoiceAfter),withoutLogo(invoiceBefore));
  pass('no invoice, money, quantity, customer or calendar field was edited');
  await db.exec("update storage.buckets set public=true where id='order-prep-media';");
  await assert.rejects(db.exec(migration), /refuses an existing prep-media bucket/);
  await db.exec('rollback;');
  assert.equal(await scalar("select public as value from storage.buckets where id='order-prep-media'"),true);
  pass('migration refuses an incompatible existing bucket without silently changing it');
  console.log(`PASS: ${passed} local runtime scenarios. No live systems were contacted.`);
  console.log('Limits: bucket settings are checked, but in-memory SQL does not exercise Storage HTTP uploads, image-byte validation, phone camera permissions, or iPhone UI.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
