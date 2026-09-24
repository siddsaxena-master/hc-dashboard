import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const sw=readFileSync(new URL('./sw.js',import.meta.url),'utf8');

let passed=0;
const tests=[];
function test(name,fn){tests.push({name,fn});}

function extractDeclaration(name){
  const match=html.match(new RegExp(`const ${name}=([^;]+);`));
  assert.ok(match,`missing declaration ${name}`);
  return `const ${name}=${match[1]};`;
}

function extractFunction(name){
  const starts=[`async function ${name}(`,`function ${name}(`];
  let start=-1;
  for(const marker of starts){
    start=html.indexOf(marker);
    if(start>=0)break;
  }
  assert.ok(start>=0,`missing function ${name}`);
  const brace=html.indexOf('{',start);
  let depth=0;
  let quote='';
  let escaped=false;
  let lineComment=false;
  let blockComment=false;
  for(let i=brace;i<html.length;i++){
    const ch=html[i];
    const next=html[i+1];
    if(lineComment){if(ch==='\n')lineComment=false;continue;}
    if(blockComment){if(ch==='*'&&next==='/'){blockComment=false;i++;}continue;}
    if(quote){
      if(escaped){escaped=false;continue;}
      if(ch==='\\'){escaped=true;continue;}
      if(ch===quote)quote='';
      continue;
    }
    if(ch==='/'&&next==='/'){lineComment=true;i++;continue;}
    if(ch==='/'&&next==='*'){blockComment=true;i++;continue;}
    if(ch==='\''||ch==='"'||ch==='`'){quote=ch;continue;}
    if(ch==='{')depth++;
    if(ch==='}'&&--depth===0)return html.slice(start,i+1);
  }
  throw new Error(`unterminated function ${name}`);
}

function buildContext(parts,names){
  const context=vm.createContext({crypto:webcrypto,Uint8Array,console});
  vm.runInContext(`${parts.join('\n')}\n${names.map(name=>`globalThis.${name}=${name};`).join('\n')}`,context);
  return context;
}

const stageContext=buildContext([
  extractDeclaration('SB_STAGE_TO_UI'),
  extractDeclaration('UI_STAGE_TO_SB'),
  extractFunction('stageFromSupabase'),
  extractFunction('stageToSupabase')
],['SB_STAGE_TO_UI','UI_STAGE_TO_SB','stageFromSupabase','stageToSupabase']);

const paymentContext=buildContext([
  extractFunction('isLeadStage'),
  extractFunction('isDoneStage'),
  extractFunction('hasRecordedPayment'),
  extractFunction('isStampAuthorized'),
  extractFunction('outstandingAmount'),
  extractFunction('paymentCardClass'),
  extractFunction('isOutstandingReceivable'),
  extractFunction('shouldCollectBalance')
],['isLeadStage','isDoneStage','hasRecordedPayment','isStampAuthorized','outstandingAmount','paymentCardClass','isOutstandingReceivable','shouldCollectBalance']);

const rowContext=buildContext([
  extractDeclaration('UI_STAGE_TO_SB'),
  extractDeclaration('UI_ETYPE_TO_SB'),
  extractDeclaration('UI_STAMP_TO_SB'),
  extractDeclaration('UI_FREQ_TO_SB'),
  extractDeclaration('UI_SOURCE_TO_SB'),
  extractDeclaration('UUID_RE'),
  extractFunction('stageToSupabase'),
  extractFunction('eventToSupabaseRow'),
  extractFunction('eventToSupabasePatch'),
  extractFunction('eventToSupabaseInsertRow'),
  extractFunction('newEventId')
],['UUID_RE','eventToSupabaseRow','eventToSupabasePatch','eventToSupabaseInsertRow','newEventId']);

const ackContext=buildContext([extractFunction('requireExactOrderWriteAck')],['requireExactOrderWriteAck']);

const RACE_ID='11111111-1111-4111-8111-111111111111';

function buildPullRaceContext(){
  let releaseFetch;
  let signalFetchStarted;
  let fetchCount=0;
  const fetchStarted=new Promise(resolve=>{signalFetchStarted=resolve;});
  const context=vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    localStorage:{setItem(){}},
    fetch:async()=>{
      fetchCount++;
      if(fetchCount===1){
        signalFetchStarted();
        await new Promise(resolve=>{releaseFetch=resolve;});
      }
      return{ok:true,status:200,json:async()=>[{id:RACE_ID,name:'cloud row'}]};
    }
  });
  vm.runInContext(`
    const SUPABASE_URL='https://example.invalid';
    const SB_HEADERS={};
    ${extractDeclaration('UUID_RE')}
    var events=[];
    let jbWriteQueue=Promise.resolve();
    let jbPullPromise=null;
    function setSyncStatus(){}
    function supabaseRowToEvent(row){return {...row};}
    function applyPendingToEvents(){}
    function render(){}
    ${extractFunction('queueJbWrite')}
    ${extractFunction('upsertLocalEventsById')}
    ${extractFunction('jbPull')}
    globalThis.jbPull=jbPull;
    globalThis.queueJbWrite=queueJbWrite;
    globalThis.upsertLocalEventsById=upsertLocalEventsById;
    globalThis.getEvents=()=>events;
    globalThis.applySavedState=()=>{events=[{id:'${RACE_ID}',name:'confirmed save'}];};
    globalThis.applyDeletedState=()=>{events=[];};
  `,context);
  return{context,fetchStarted,releaseFetch:()=>releaseFetch(),getFetchCount:()=>fetchCount};
}

const expectedStages=[
  ['inquiry','lead','Lead'],
  ['quoted','quoted','Quoted'],
  ['invoiced','invoiced','Invoiced'],
  ['deposit_paid','deposit_paid','Deposit Paid'],
  ['paid_full','payment_full','Fully Paid'],
  ['fulfilled','fulfilled','Fulfilled'],
  ['complete','completed','Completed'],
  ['cancelled','passed','Customer Passed']
];

test('stage selector has exactly eight correctly labelled stages',()=>{
  const block=html.match(/const STAGES=\[([\s\S]*?)\];/);
  assert.ok(block);
  const stages=vm.runInNewContext(`[${block[1]}]`);
  assert.deepEqual(Array.from(stages,s=>[s.id,s.label]),expectedStages.map(([,ui,label])=>[ui,label]));
});

test('all eight stages round trip exactly',()=>{
  for(const [db,ui] of expectedStages){
    assert.equal(stageContext.stageFromSupabase(db),ui);
    assert.equal(stageContext.stageToSupabase(ui),db);
  }
});

test('unknown stages fail closed',()=>{
  assert.throws(()=>stageContext.stageFromSupabase('mystery'),/Unsupported Supabase order stage/);
  assert.throws(()=>stageContext.stageToSupabase('stamp_ordered'),/Unsupported dashboard order stage/);
});

test('invoiced is not presented as deposit paid',()=>{
  assert.equal(stageContext.stageFromSupabase('invoiced'),'invoiced');
  assert.match(html,/invoiced:'🧾 Invoiced'/);
});

test('cancelled maps only to customer passed',()=>{
  assert.equal(stageContext.stageToSupabase('passed'),'cancelled');
  assert.doesNotMatch(extractDeclaration('UI_STAGE_TO_SB'),/passed:'complete'/);
});

test('payment card color depends on amounts, not stage',()=>{
  assert.equal(paymentContext.paymentCardClass({stage:'completed',total_amount:'100',deposit_amount:'',balance_amount:''}),'pay-none');
  assert.equal(paymentContext.paymentCardClass({stage:'lead',total_amount:'100',deposit_amount:'25',balance_amount:''}),'pay-deposit');
  assert.equal(paymentContext.paymentCardClass({stage:'invoiced',total_amount:'100',deposit_amount:'25',balance_amount:'75'}),'pay-full');
});

test('completed and fulfilled unpaid orders remain outstanding',()=>{
  for(const stage of ['fulfilled','completed']){
    const event={stage,total_amount:'500',deposit_amount:'100',balance_amount:'0'};
    assert.equal(paymentContext.isOutstandingReceivable(event),true);
    assert.equal(paymentContext.outstandingAmount(event),400);
    assert.equal(paymentContext.shouldCollectBalance(event,null),true);
  }
  assert.equal(paymentContext.isOutstandingReceivable({stage:'passed',total_amount:'500',deposit_amount:'0',balance_amount:'0'}),false);
});

test('stamp authorization requires a positive recorded payment',()=>{
  assert.equal(paymentContext.isStampAuthorized({deposit_amount:'',balance_amount:'0'}),false);
  assert.equal(paymentContext.isStampAuthorized({deposit_amount:'0.01',balance_amount:''}),true);
  assert.equal(paymentContext.isStampAuthorized({deposit_amount:'-10',balance_amount:'0'}),false);
});

test('all stamp action paths contain the positive-payment gate',()=>{
  assert.match(extractFunction('isStampUrgent'),/isStampAuthorized\(e\)/);
  assert.match(extractFunction('sendTelegramStampAlert'),/if\(!isStampAuthorized\(event\)\)return false/);
  assert.match(extractFunction('checkPendingStamps'),/if\(!isStampAuthorized\(e\)\)return false/);
  assert.match(extractFunction('renderTodos'),/stampAuthorized/);
});

test('invoice and Gmail prompts prohibit payment inference',()=>{
  assert.doesNotMatch(extractFunction('onInvoiceFile'),/deposit_amount[^:]/);
  assert.doesNotMatch(extractFunction('onInvoiceFile'),/balance_amount[^:]/);
  const promptStart=html.indexOf('const GMAIL_PARSE_PROMPT_SINGLE=');
  const promptEnd=html.indexOf('function renderImportPanel',promptStart);
  const prompts=html.slice(promptStart,promptEnd);
  assert.doesNotMatch(prompts,/"deposit_amount"|"balance_amount"/);
  assert.match(prompts,/Never infer money received/);
});

test('obsolete email payment inference functions are absent',()=>{
  for(const name of ['isQBPaymentEmail','extractPaymentInfo','matchEventForPayment','applyPaymentUpdate','QB_PAYMENT_SUBJECT']){
    assert.equal(html.includes(name),false,`${name} should be absent`);
  }
  assert.match(html,/if\(isQBNotificationEmail\(from\)\)/);
});

test('Gmail imports explicitly start unpaid',()=>{
  const source=extractFunction('confirmAllImports');
  assert.match(source,/deposit_amount:''/);
  assert.match(source,/balance_amount:''/);
  assert.doesNotMatch(source,/p\.deposit_amount|p\.balance_amount/);
});

test('stage and verified payment controls are display-only',()=>{
  const source=extractFunction('formBody');
  assert.match(source,/select id="f-stage" disabled/);
  assert.match(source,/id="f-deposit"[^>]* readonly/);
  assert.match(source,/id="f-balance"[^>]* readonly/);
  assert.match(source,/id="f-pay-notes"[^>]* readonly/);
  assert.match(source,/Stage is managed by QuickBooks and operations\. It is display-only here\./);
  assert.match(source,/Received payment amounts and payment status come from verified QuickBooks records\./);
  assert.match(source,/Legacy or manual payment notes are context only, not proof of payment\./);
});

test('saveEvent restores protected values and forces new drafts unpaid',()=>{
  const source=extractFunction('saveEvent');
  for(const assignment of [
    'd.stage=oldEvent.stage',
    'd.deposit_amount=oldEvent.deposit_amount',
    'd.balance_amount=oldEvent.balance_amount',
    'd.pay_notes=oldEvent.pay_notes'
  ])assert.ok(source.includes(assignment),`missing ${assignment}`);
  assert.match(source,/else\{\s*d\.stage='lead';\s*d\.deposit_amount='';\s*d\.balance_amount='';\s*d\.pay_notes='';/);
});

test('new order IDs are stable UUIDs generated before insert',()=>{
  const first=rowContext.newEventId();
  const second=rowContext.newEventId();
  assert.match(first,rowContext.UUID_RE);
  assert.match(second,rowContext.UUID_RE);
  assert.notEqual(first,second);
  assert.match(extractFunction('saveEvent'),/id:editingId\|\|\(newEventDraftId\|\|\(newEventDraftId=newEventId\(\)\)\)/);
  assert.match(extractFunction('saveEvent'),/if\(eventSaveInFlight\)return/);
  assert.match(extractFunction('confirmAllImports'),/_eventId=newEventId\(\)/);
});

function baseEvent(){
  return {
    id:'11111111-1111-4111-8111-111111111111',type:'event',name:'Crystal',email:'',phone:'',venue:'',venue_type:'',event_type:'',event_date:'2026-09-06',event_end_date:'',coconuts:'50',crack_whole:'',crack_circle:'',crack_straw:'50',stamp_design:'',stamp_status:'Not ordered',logo_received:'',pre_tax_amount:'500',tax_amount:'0',total_amount:'500',deposit_amount:'100',balance_amount:'0',pay_notes:'verified',invoice_url:'',stage:'invoiced',market:'ny',source:'',delivery_date:'2026-09-06',delivery_notes:'',coi_requested:false,frequency:'',next_order_date:'',notes:''
  };
}

test('narrow patch preserves unchanged payment fields',()=>{
  const before=baseEvent();
  const after={...before,venue:'New venue'};
  const patch=rowContext.eventToSupabasePatch(before,after);
  assert.deepEqual(Object.keys(patch),['venue']);
  assert.equal(Object.hasOwn(patch,'deposit_cents'),false);
  assert.equal(Object.hasOwn(patch,'balance_cents'),false);
  assert.equal(Object.hasOwn(patch,'pay_notes'),false);
});

test('narrow patch never emits protected stage or payment fields',()=>{
  const before=baseEvent();
  const after={...before,venue:'Safe venue edit',stage:'tampered-stage',deposit_amount:'150',balance_amount:'350',pay_notes:'tampered'};
  const patch=rowContext.eventToSupabasePatch(before,after);
  assert.deepEqual(Object.keys(patch),['venue']);
  assert.equal(patch.venue,'Safe venue edit');
  for(const field of ['stage','deposit_cents','balance_cents','pay_notes'])assert.equal(Object.hasOwn(patch,field),false);
});

test('new inserts are forced unpaid at inquiry despite tampered input',()=>{
  const tampered={...baseEvent(),stage:'payment_full',deposit_amount:'500',balance_amount:'250',pay_notes:'fake payment'};
  const row=rowContext.eventToSupabaseInsertRow(tampered);
  assert.equal(row.stage,'inquiry');
  assert.equal(row.deposit_cents,0);
  assert.equal(row.balance_cents,null);
  assert.equal(row.pay_notes,null);
  assert.match(extractFunction('jbUpsert'),/changedEvents\.map\(eventToSupabaseInsertRow\)/);
});

function response(payload,{ok=true,status=200,invalid=false}={}){
  return {
    ok,status,
    async json(){if(invalid)throw new Error('invalid json');return payload;},
    async text(){return JSON.stringify(payload);}
  };
}

test('exact acknowledgment accepts one expected UUID',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  assert.equal(await ackContext.requireExactOrderWriteAck(response([{id}]),id,'Save'),true);
});

for(const [name,payload,options] of [
  ['empty array',[],{}],
  ['wrong UUID',[{id:'22222222-2222-4222-8222-222222222222'}],{}],
  ['multiple rows',[{id:'11111111-1111-4111-8111-111111111111'},{id:'11111111-1111-4111-8111-111111111111'}],{}],
  ['invalid JSON',null,{invalid:true}],
  ['HTTP error',{message:'rejected'},{ok:false,status:409}]
]){
  test(`exact acknowledgment rejects ${name}`,async()=>{
    const id='11111111-1111-4111-8111-111111111111';
    await assert.rejects(()=>ackContext.requireExactOrderWriteAck(response(payload,options),id,'Save'));
  });
}

test('all order mutations request representations and validate the UUID',()=>{
  for(const name of ['jbPatch','jbUpsert','jbDelete']){
    const source=extractFunction(name);
    assert.match(source,/return=representation/);
    assert.match(source,/requireExactOrderWriteAck/);
  }
  assert.match(extractFunction('jbPatch'),/orders\?id=eq\.'\+encodeURIComponent\(id\)/);
  assert.match(extractFunction('jbDelete'),/orders\?id=eq\.'\+encodeURIComponent\(id\)/);
  assert.match(extractFunction('jbUpsert'),/for\(const row of rows\)/);
  assert.match(extractFunction('syncPendingDeliveries'),/requireExactOrderWriteAck\(r2,item\.orderId/);
});

test('delayed pulls cannot overwrite a queued save or delete',async()=>{
  for(const mutation of ['save','delete']){
    const race=buildPullRaceContext();
    const pullPromise=race.context.jbPull();
    await race.fetchStarted;
    let mutationFinished=false;
    const mutationPromise=race.context.queueJbWrite(async()=>{
      if(mutation==='save')race.context.applySavedState();
      else race.context.applyDeletedState();
      mutationFinished=true;
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(mutationFinished,false,`${mutation} must wait for the active pull`);
    race.releaseFetch();
    await Promise.all([pullPromise,mutationPromise]);
    const finalEvents=Array.from(race.context.getEvents(),event=>({...event}));
    if(mutation==='save')assert.deepEqual(finalEvents,[{id:RACE_ID,name:'confirmed save'}]);
    else assert.deepEqual(finalEvents,[]);
  }
  assert.match(extractFunction('jbPull'),/^function jbPull\(\)\{\s*if\(jbPullPromise\)return jbPullPromise;/);
});

test('new-order local commit dedupes a row loaded by a queued pull',async()=>{
  const race=buildPullRaceContext();
  let releaseWrite;
  const writeGate=new Promise(resolve=>{releaseWrite=resolve;});
  const writePromise=race.context.queueJbWrite(async()=>{await writeGate;return true;});
  const pullPromise=race.context.jbPull();
  const localEvent={id:RACE_ID,name:'local confirmed order'};
  const callerCommit=(async()=>{
    assert.equal(await writePromise,true);
    await pullPromise;
    race.context.upsertLocalEventsById([localEvent]);
  })();
  releaseWrite();
  await race.fetchStarted;
  race.releaseFetch();
  await Promise.all([pullPromise,callerCommit]);
  const finalEvents=Array.from(race.context.getEvents(),event=>({...event}));
  assert.deepEqual(finalEvents,[localEvent]);
  assert.equal(new Set(finalEvents.map(event=>event.id)).size,1);
  assert.match(extractFunction('saveEvent'),/\}else upsertLocalEventsById\(\[ev\]\);/);
  assert.match(extractFunction('confirmAllImports'),/upsertLocalEventsById\(imported\);/);
});

test('duplicate startup pulls share one fetch and one queue slot',async()=>{
  const race=buildPullRaceContext();
  const first=race.context.jbPull();
  const duplicate=race.context.jbPull();
  assert.equal(duplicate,first);
  let followingWriteRan=false;
  const followingWrite=race.context.queueJbWrite(async()=>{followingWriteRan=true;});
  await race.fetchStarted;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(race.getFetchCount(),1);
  assert.equal(followingWriteRan,false);
  race.releaseFetch();
  await Promise.all([first,duplicate,followingWrite]);
  assert.equal(race.getFetchCount(),1);
  assert.equal(followingWriteRan,true);
  const laterPull=race.context.jbPull();
  assert.notEqual(laterPull,first);
  await laterPull;
  assert.equal(race.getFetchCount(),2);
});

test('service worker cache is bumped exactly to v5',()=>{
  assert.match(sw,/const CACHE = 'hc-deliveries-v5'/);
  assert.doesNotMatch(sw,/hc-deliveries-v4/);
});

for(const {name,fn} of tests){
  try{
    await fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  }catch(error){
    console.error(`not ok ${passed+1} - ${name}`);
    throw error;
  }
}

console.log(`\n${passed} payment integrity tests passed`);
