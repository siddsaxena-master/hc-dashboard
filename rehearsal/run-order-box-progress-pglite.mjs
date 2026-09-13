// In-memory SQL with synthetic users/orders only. No live connection option.
// node rehearsal/run-order-box-progress-pglite.mjs <absolute @electric-sql/pglite 0.5.8 package directory>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname,isAbsolute,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const packageDir=process.argv[2];
assert.ok(packageDir&&isAbsolute(packageDir)&&process.argv.length===3,'Only a local PGlite package path is accepted');
const pkg=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));
assert.equal(pkg.name,'@electric-sql/pglite'); assert.equal(pkg.version,'0.5.8');
const {PGlite}=await import(pathToFileURL(join(packageDir,'dist/index.js')).href);
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const [fixture,original,...migrations]=await Promise.all([
  'rehearsal/calendar-logo-local-setup.sql','migrations/019_dashboard_auth_transition.sql',
  'migrations/034_calendar_delivery_details.sql','migrations/035_order_logo_assets.sql',
  'migrations/036_order_prep_workflow.sql','migrations/037_order_box_progress.sql'
].map(path=>readFile(join(root,path),'utf8')));
const guard="current_database() <> 'hc_calendar_logo_rehearsal'";
assert.equal(fixture.split(guard).length,2);
const from=original.indexOf('create or replace function public.hc_list_orders_for_current_user(');
const to=original.indexOf('-- Delivery confirmation is the one write allowed',from);
assert.ok(from>=0&&to>from);
const users=Object.fromEntries(['owner','manager','team','inactive','guest','blank','miami'].map((name,i)=>[name,`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const order=id=>`30000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const box=id=>`50000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const photo=id=>`60000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const capture=new Date().toISOString();
const artwork={status:'received',checked_at:capture,files:[{file_name:'logo.png',mime_type:'image/png',original_path:'selected/logo.png',preview_path:'selected/logo.png',usage:'Coconut'}]};
let displayed=structuredClone(artwork);
let db; let passes=0;
const pass=label=>{passes++;console.log(`PASS: ${label}`);};
async function scalar(sql,params=[]){return(await db.query(sql,params)).rows[0]?.value;}
async function identity(name=null,role='authenticated'){
  await db.exec('reset role;');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[name?users[name]??name:'']);
  if(role!=='postgres')await db.exec(`set role ${role};`);
}
async function rejects(label,sql,params=[],code='42501'){
  await assert.rejects(db.query(sql,params),err=>err.code===code,label);pass(label);
}
const get=(id=order(1))=>scalar('select public.hc_get_order_box_progress($1) as value',[id]);
const getPrep=(id=order(1))=>scalar('select public.hc_get_order_prep_state($1) as value',[id]);
const plan=(target,version,id=order(1))=>scalar('select public.hc_save_order_production_plan($1,$2,$3) as value',[id,version,target]);
async function prep(patch,id=order(1)){
  const current=await getPrep(id);
  return scalar('select public.hc_save_order_prep_state($1,$2,$3::jsonb,$4::jsonb) as value',[id,current.version,JSON.stringify(patch),JSON.stringify(displayed)]);
}
const reserve=(boxId,photoId,qty,version=1,id=order(1),expected=displayed)=>scalar('select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,$6,$7) as value',[id,boxId,photoId,capture,JSON.stringify(expected),qty,version]);
const finish=(boxId,photoId,id=order(1))=>scalar('select public.hc_finish_order_box_photo($1,$2,$3) as value',[id,boxId,photoId]);
const upload=(path,metadata={size:1000,mimetype:'image/jpeg'})=>db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)',['order-box-media',path,JSON.stringify(metadata)]);
const loaded=(boxId,photoId,value=true,id=order(1))=>scalar('select public.hc_set_order_box_loaded($1,$2,$3,$4) as value',[id,boxId,photoId,value]);
const loadAll=(version=1,id=order(1))=>scalar('select public.hc_mark_order_loaded($1,$2) as value',[id,version]);
const retire=(boxId,reason,id=order(1))=>scalar('select public.hc_void_order_production_box($1,$2,$3) as value',[id,boxId,reason]);
try{
  db=await PGlite.create();
  const ident=(await db.query('select current_database() as name,version() as version')).rows[0];
  assert.equal(ident.name,'postgres');assert.ok(ident.version.includes('(PGlite 0.5.8)'));
  await db.exec(fixture.replace(guard,"current_database() <> 'postgres'")+original.slice(from,to));
  await db.exec(`alter table storage.buckets add column file_size_limit bigint,add column allowed_mime_types text[];
    alter table storage.objects add column metadata jsonb,add constraint object_path_unique unique(bucket_id,name);
    grant insert,update,delete on storage.objects to anon,authenticated;
    grant usage on sequence storage.objects_id_seq to anon,authenticated;
    create policy existing_broad_write on storage.objects for all to public using(true) with check(true);`);
  for(const sql of [...migrations,migrations[2],migrations[3]])await db.exec(sql);
  pass('real 034 through 037 SQL applies, and 036/037 reruns remain compatible');
  assert.deepEqual(await scalar("select jsonb_build_object('public',public,'size',file_size_limit,'mime',allowed_mime_types) as value from storage.buckets where id='order-box-media'"),{public:false,size:8388608,mime:['image/jpeg']});
  pass('box bucket is separately private, JPEG-only, and limited to 8 MiB');
  await db.query('update public.orders set logo_asset=$1::jsonb,coconuts_qty=999 where id in($2,$3)',[JSON.stringify({...artwork,source_ref:'secret-customer-thread'}),order(1),order(2)]);
  const originalOrders=(await db.query('select * from public.orders order by id')).rows;
  await identity('manager');
  let state=await get();
  assert.equal(state.plan.target_coconuts,null);assert.equal(state.plan.version,0);assert.equal(state.totals.completed_coconuts,0);assert.equal(state.ready_to_load,false);assert.equal(state.fully_loaded,false);
  pass('unknown production target is not copied from unreliable raw invoice quantities');
  await prep({stamp_checked:true,cracking_method:'whole',staffing:true,onsite_cracking_method:'cocktail',checks:{straws_packed:true}});
  await identity('team');
  await rejects('team cannot set production quantity','select public.hc_save_order_production_plan($1,0,10)',[order(1)]);
  await rejects('no box can be reserved before target confirmation','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,4,0)',[order(1),box(1),photo(1),capture,JSON.stringify(displayed)],'22023');
  const sample=await scalar('select public.hc_reserve_order_prep_photo($1,$2,$3,$4::jsonb) as value',[order(1),photo(99),capture,JSON.stringify(displayed)]);
  await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)',['order-prep-media',sample.path,'{"size":10,"mimetype":"image/jpeg"}']);
  await scalar('select public.hc_finish_order_prep_photo($1,$2) as value',[order(1),photo(99)]);
  assert.equal((await get()).totals.completed_coconuts,0);assert.equal((await get()).boxes.length,0);
  pass('sample photo completion never creates a production box or quantity');
  await identity('manager');
  state=await plan(10,0);assert.equal(state.plan.source,'owner_confirmed');assert.equal(state.plan.target_coconuts,10);
  await rejects('stale target edit cannot overwrite current plan','select public.hc_save_order_production_plan($1,0,20)',[order(1)],'40001');
  await rejects('zero target is rejected','select public.hc_save_order_production_plan($1,1,0)',[order(1)],'22023');
  await identity('team');
  await rejects('zero actual box quantity is rejected','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,0,1)',[order(1),box(1),photo(1),capture,JSON.stringify(displayed)],'22023');
  const first=await reserve(box(1),photo(1),4);
  assert.equal(first.box_number,1);assert.equal(first.revision,1);assert.equal(first.coconuts_qty,4);assert.equal(first.path,`${order(1)}/${users.team}/${photo(1)}.jpg`);
  assert.deepEqual(await reserve(box(1),photo(1),4),first);
  state=await get();assert.equal(state.totals.reserved_coconuts,4);assert.equal(state.totals.completed_coconuts,0);assert.equal(state.totals.pending_boxes,1);assert.equal(state.totals.unreserved_coconuts,6);
  pass('stable box reservation is retry-safe and pending uploads do not count as completed production');
  await rejects('unfinished box cannot be marked loaded','select public.hc_set_order_box_loaded($1,$2,$3,true)',[order(1),box(1),photo(1)],'40001');
  await rejects('missing box file cannot be finalized','select public.hc_finish_order_box_photo($1,$2,$3)',[order(1),box(1),photo(1)],'22023');
  await rejects('forged unreserved upload is denied','insert into storage.objects(bucket_id,name) values($1,$2)',['order-box-media','forged.jpg']);
  await upload(first.path);
  await identity('manager');
  assert.equal(await scalar('select count(*)::int as value from storage.objects where name=$1',[first.path]),0);
  await rejects('another worker cannot finish reserved photo','select public.hc_finish_order_box_photo($1,$2,$3)',[order(1),box(1),photo(1)]);
  await rejects('another worker cannot upload reserved photo','insert into storage.objects(bucket_id,name) values($1,$2)',['order-box-media',first.path]);
  await rejects('another worker cannot claim reserved photo identity','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,4,1)',[order(1),box(1),photo(1),capture,JSON.stringify(displayed)]);
  await identity('team');
  state=await finish(box(1),photo(1));assert.equal(state.confirmed_box_id,box(1));assert.equal(state.confirmed_photo_id,photo(1));assert.equal(state.confirmed_photo_path,first.path);assert.equal(state.totals.completed_coconuts,4);assert.equal(state.totals.completed_boxes,1);
  assert.equal(state.boxes[0].latest_photo.photographer_id,users.team);assert.ok(state.boxes[0].latest_photo.finished_at);
  assert.equal((await finish(box(1),photo(1))).totals.completed_coconuts,4);
  pass('completed partial box records authenticated photographer and counts once even after retries');
  await rejects('existing physical box cannot change coconut quantity during retake','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,5,1)',[order(1),box(1),photo(2),capture,JSON.stringify(displayed)],'22023');
  state=await loaded(box(1),photo(1));assert.equal(state.totals.loaded_coconuts,4);assert.equal(state.fully_loaded,false);
  pass('individual photographed boxes can be loaded without falsely completing an unfinished order');
  const second=await reserve(box(2),photo(2),6);assert.equal(second.box_number,2);
  await rejects('pending reserved box quantity also prevents target overrun','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,1,1)',[order(1),box(3),photo(3),capture,JSON.stringify(displayed)],'22023');
  await upload(second.path);state=await finish(box(2),photo(2));
  assert.equal(state.totals.completed_coconuts,10);assert.equal(state.totals.completed_boxes,2);assert.equal(state.totals.remaining_coconuts,0);assert.equal(state.ready_to_load,false);
  pass('actual partial-box quantities sum exactly to the explicit target, not an assumed box size');
  await rejects('extra physical box cannot exceed target including reserved slots','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,1,1)',[order(1),box(3),photo(3),capture,JSON.stringify(displayed)],'22023');
  await rejects('whole-order load requires cracking and event tool checks','select public.hc_mark_order_loaded($1,1)',[order(1)],'22023');
  await prep({checks:{cracking_checked:true,cocktail_tools_packed:true}});
  state=await get();assert.equal(state.ready_to_load,true);assert.equal(state.fully_loaded,false);
  state=await loadAll();assert.equal(state.fully_loaded,true);assert.equal(state.totals.loaded_coconuts,10);
  assert.equal((await loadAll()).fully_loaded,true);
  pass('whole-order loading requires all evidence and required prep/straw/tool checks');
  await identity('manager');
  const retake=await reserve(box(1),photo(3),4);assert.equal(retake.revision,2);await upload(retake.path);state=await finish(box(1),photo(3));
  assert.equal(state.totals.completed_coconuts,10);assert.equal(state.totals.completed_boxes,2);assert.equal(state.boxes[0].latest_photo.id,photo(3));assert.equal(state.boxes[0].loaded,false);assert.equal(state.fully_loaded,false);
  pass('retake replaces displayed evidence, preserves quantity, and clears that box loading confirmation');
  await rejects('old photo cannot certify loading after retake','select public.hc_set_order_box_loaded($1,$2,$3,true)',[order(1),box(1),photo(1)],'40001');
  const queuedOlder=await reserve(box(1),photo(4),4);const queuedNewer=await reserve(box(1),photo(5),4);
  await upload(queuedOlder.path);await upload(queuedNewer.path);await finish(box(1),photo(5));await loaded(box(1),photo(5));
  state=await finish(box(1),photo(4));assert.equal(state.confirmed_photo_id,photo(4));assert.equal(state.boxes[0].latest_photo.id,photo(5));assert.equal(state.boxes[0].loaded,true);assert.equal(state.totals.completed_coconuts,10);
  pass('late queued older upload cannot replace newer proof, erase loading, or double-count production');
  for(const [id,metadata] of [[6,{size:8388609,mimetype:'image/jpeg'}],[7,{size:1,mimetype:'image/png'}],[8,{size:0,mimetype:'image/jpeg'}]]){
    const invalid=await reserve(box(1),photo(id),4);await upload(invalid.path,metadata);
    await rejects('invalid file metadata cannot complete a box photo','select public.hc_finish_order_box_photo($1,$2,$3)',[order(1),box(1),photo(id)],'22023');
  }
  await rejects('finished file cannot be overwritten','insert into storage.objects(bucket_id,name) values($1,$2)',['order-box-media',retake.path]);
  assert.equal((await db.query('update storage.objects set name=$1 where name=$2 returning id',['wrong.jpg',retake.path])).rows.length,0);
  assert.equal((await db.query('delete from storage.objects where name=$1 returning id',[retake.path])).rows.length,0);
  await rejects('cannot move unrelated file into box bucket','update storage.objects set bucket_id=$1 where name=$2',['order-box-media','unchanged.txt']);
  pass('legacy broad storage policies cannot permit replacement or deletion of box proof');
  for(const who of ['miami','inactive','guest','blank',null,'20000000-0000-4000-8000-000000000099']){
    await identity(who);
    await rejects(`unauthorized progress read (${who})`,'select public.hc_get_order_box_progress($1)',[order(1)]);
    await rejects(`unauthorized loading write (${who})`,'select public.hc_mark_order_loaded($1,1)',[order(1)]);
    await rejects(`unauthorized reservation (${who})`,'select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,4,1)',[order(1),box(1),photo(50),capture,JSON.stringify(displayed)]);
    assert.equal(await scalar("select count(*)::int as value from storage.objects where bucket_id='order-box-media'"),0);
  }
  pass('cross-market, invalid-roster and signed-out users cannot read private box images');
  await identity('owner','anon');
  await rejects('anonymous RPC denied even with owner-looking subject','select public.hc_get_order_box_progress($1)',[order(1)]);
  await rejects('anonymous storage helper denied','select public.hc_can_access_order_box_photo($1,false)',[first.path]);
  await rejects('anonymous box upload denied','insert into storage.objects(bucket_id,name) values($1,$2)',['order-box-media','anon.jpg']);
  assert.equal(await scalar("select count(*)::int as value from storage.objects where bucket_id='order-box-media'"),0);
  assert.equal(await scalar("select count(*)::int as value from storage.objects where bucket_id='existing-private'"),1);
  pass('anonymous box reads are denied without altering unrelated bucket access');
  await identity('owner');assert.equal((await get(order(3))).plan.target_coconuts,null);await plan(1,0,order(2));
  pass('owner can explicitly manage production across markets');
  await identity('team');
  for(const name of ['order_production_plans','order_production_boxes','order_box_photos','order_box_audit']){
    await rejects(`direct table read denied (${name})`,`select * from public.${name}`);
    await rejects(`direct table write denied (${name})`,`delete from public.${name}`);
  }
  await identity('manager');
  await rejects('target cannot drop below assigned physical quantities','select public.hc_save_order_production_plan($1,1,9)',[order(1)],'22023');
  state=await plan(12,1);assert.equal(state.plan.version,2);assert.equal(state.fully_loaded,false);assert.equal(state.totals.remaining_coconuts,2);
  await rejects('queued box cannot silently use stale target version','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,4,1)',[order(1),box(1),photo(70),capture,JSON.stringify(displayed)],'40001');
  state=await plan(10,2);assert.equal(state.plan.version,3);
  pass('explicit manager target changes are versioned and never rewrite box or invoice quantities');
  const stale=await reserve(box(1),photo(10),4,3);await upload(stale.path);
  await identity(null,'postgres');
  await db.query("update public.orders set logo_asset=logo_asset || '{\"source_ref\":\"new-private-ref\"}'::jsonb where id=$1",[order(1)]);
  await identity('manager');assert.equal((await get()).totals.completed_coconuts,10);
  pass('private source reference changes do not invalidate finished box proof');
  await identity(null,'postgres');
  await db.query("update public.orders set logo_asset=jsonb_set(logo_asset,'{files,0,preview_path}','\"replacement.png\"'::jsonb) where id=$1",[order(1)]);
  await identity('manager');
  state=await get();assert.equal(state.totals.completed_coconuts,0);assert.equal(state.totals.loaded_coconuts,0);assert.equal(state.totals.needs_review_boxes,2);assert.equal(state.fully_loaded,false);
  await rejects('stale displayed artwork cannot reserve new box proof','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,4,3)',[order(1),box(1),photo(11),capture,JSON.stringify(displayed)],'40001');
  await rejects('artwork changed during upload cannot become completed box proof','select public.hc_finish_order_box_photo($1,$2,$3)',[order(1),box(1),photo(10)],'40001');
  displayed={...artwork,files:[{...artwork.files[0],preview_path:'replacement.png'}]};
  await rejects('new artwork requires renewed physical stamp check','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,4,3)',[order(1),box(1),photo(11),capture,JSON.stringify(displayed)],'22023');
  await prep({stamp_checked:true});
  const corrected=await reserve(box(1),photo(11),4,3);await upload(corrected.path);state=await finish(box(1),photo(11));
  assert.equal(state.totals.completed_coconuts,4);assert.equal(state.totals.reserved_coconuts,10);assert.equal(state.totals.needs_review_boxes,1);
  pass('corrected branding retake restores only that physical box, not all order production');
  assert.ok(!JSON.stringify(state).includes('source_ref')&&!JSON.stringify(state).includes('client_email')&&!JSON.stringify(state).includes('total_cents'));
  pass('progress response exposes operational evidence only, not customer contact or financial fields');
  await rejects('loaded box must be explicitly unloaded before correction',
    'select public.hc_void_order_production_box($1,$2,$3)',[order(1),box(2),'Wrong recorded box'],'22023');
  await loaded(box(2),photo(2),false);
  await identity('team');
  await rejects('team cannot retire production boxes','select public.hc_void_order_production_box($1,$2,$3)',[order(1),box(2),'Wrong recorded box']);
  await identity('manager');
  await rejects('box correction requires a clear reason','select public.hc_void_order_production_box($1,$2,$3)',[order(1),box(2),''],'22023');
  state=await retire(box(2),'Wrong recorded box');
  assert.equal(state.totals.reserved_coconuts,4);assert.equal(state.totals.needs_review_boxes,0);
  assert.equal(state.boxes.find(row=>row.id===box(2)).voided,true);
  assert.equal((await retire(box(2),'Wrong recorded box')).totals.reserved_coconuts,4);
  pass('manager correction preserves history, frees quantity, and is retry-safe');
  await rejects('retired box cannot be reused for a retake','select public.hc_reserve_order_box_photo($1,$2,$3,$4,$5::jsonb,6,3)',[order(1),box(2),photo(12),capture,JSON.stringify(displayed)],'22023');
  await rejects('retired box cannot finalize an old photo','select public.hc_finish_order_box_photo($1,$2,$3)',[order(1),box(2),photo(2)],'22023');
  await rejects('retired box cannot be marked loaded','select public.hc_set_order_box_loaded($1,$2,$3,true)',[order(1),box(2),photo(2)],'22023');
  const abandoned=await reserve(box(3),photo(12),6,3);
  state=await retire(box(3),'Duplicate pending capture');
  assert.equal(state.totals.reserved_coconuts,4);assert.equal(state.totals.pending_boxes,0);
  await rejects('retired pending slot cannot accept a late upload','insert into storage.objects(bucket_id,name) values($1,$2)',['order-box-media',abandoned.path]);
  pass('failed or duplicate pending box can be corrected without trapping target quantity');
  const replacement=await reserve(box(4),photo(13),6,3);assert.equal(replacement.box_number,4);
  await upload(replacement.path);state=await finish(box(4),photo(13));
  state=await loadAll(3);assert.equal(state.fully_loaded,true);assert.equal(state.totals.completed_boxes,2);assert.equal(state.boxes.length,4);
  assert.equal(state.boxes.find(row=>row.id===box(2)).loaded,false);
  pass('replacement uses a new label, retired boxes remain history, and only active physical boxes load');
  await identity(null,'postgres');
  await db.query("update storage.objects set name=name||'.missing' where bucket_id='order-box-media' and name=$1",[corrected.path]);
  await identity('manager');state=await get();
  assert.equal(state.totals.completed_coconuts,6);assert.equal(state.totals.loaded_coconuts,6);assert.equal(state.fully_loaded,false);
  await rejects('unavailable stored photo cannot certify full-order loading','select public.hc_mark_order_loaded($1,3)',[order(1)],'22023');
  await identity(null,'postgres');
  await db.query("update storage.objects set name=$1 where bucket_id='order-box-media' and name=$2",[corrected.path,corrected.path+'.missing']);
  await identity('manager');
  const invoiceBase={source:'quickbooks',read_status:'complete',invoice_id:'fake-invoice-1',checked_at:capture,cracking:'whole'};
  for(const [label,patch] of [
    ['mixed invoice breakdown remains unresolved',{cracking:'review'}],
    ['unverified invoice snapshot blocks full readiness',{read_status:'unread'}],
    ['different invoice identity blocks full readiness',{invoice_id:'wrong-invoice'}],
    ['invalid invoice timestamp blocks full readiness',{checked_at:'not-a-time'}],
    ['verified invoice cracking conflict blocks full readiness',{cracking:'cocktail'}],
  ]){
    await identity(null,'postgres');
    await db.query('update public.orders set invoice_fulfillment=$1::jsonb where id=$2',[JSON.stringify({...invoiceBase,...patch}),order(1)]);
    await identity('manager');state=await get();assert.equal(state.ready_to_load,false);assert.equal(state.fully_loaded,false);assert.ok(state.readiness_reasons.some(reason=>reason.startsWith('Invoice')||reason.startsWith('Confirmed prep')));
    await rejects(label,'select public.hc_mark_order_loaded($1,3)',[order(1)],'22023');
  }
  await identity(null,'postgres');
  await db.query('update public.orders set invoice_fulfillment=$1::jsonb where id=$2',[JSON.stringify(invoiceBase),order(1)]);
  await identity('manager');assert.equal((await get()).fully_loaded,true);
  pass('a verified matching invoice preserves correct full readiness');
  await identity(null,'postgres');
  await db.query('update public.orders set invoice_fulfillment=null where id=$1',[order(1)]);
  await identity(null,'postgres');
  assert.equal(await scalar("select count(*)::int as value from public.order_production_boxes where order_id=$1",[order(1)]),4);
  assert.equal(await scalar("select count(*)::int as value from public.order_box_audit where action='box_photo_finished' and details->>'photo_id'=$1",[photo(1)]),1);
  assert.equal(await scalar("select count(*)::int as value from public.order_box_audit where action='order_loaded'"),2);
  assert.equal(await scalar("select count(*)::int as value from public.order_box_audit where action='box_voided' and details->>'box_id'=$1",[box(2)]),1);
  assert.equal(await scalar('select bool_and(actor_id is not null and recorded_at is not null) as value from public.order_box_audit'),true);
  pass('audit preserves server actor/time and retry-safe physical-box history');
  const afterOrders=(await db.query('select * from public.orders order by id')).rows;
  const withoutLogo=rows=>rows.map(({logo_asset,...row})=>row);
  assert.deepEqual(withoutLogo(afterOrders),withoutLogo(originalOrders));
  pass('invoice quantities, money, stage, calendar dates and customer fields remain unchanged');
  await db.exec("update storage.buckets set public=true where id='order-box-media';");
  await assert.rejects(db.exec(migrations[3]),/refuses an existing box-media bucket/);await db.exec('rollback;');
  assert.equal(await scalar("select public as value from storage.buckets where id='order-box-media'"),true);
  pass('incompatible existing box bucket is refused without silently reconfiguring it');
  console.log(`PASS: ${passes} local box-progress runtime scenarios. No live systems used.`);
  console.log('Limits: does not test Storage HTTP, image bytes, phone UI, or real multi-connection races. SQL serializes per-order writes using a plan-row lock.');
}catch(error){console.error(error);process.exitCode=1;}finally{if(db)await db.close();}
