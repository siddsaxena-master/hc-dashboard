// Offline tests for the CLAUDIA_CHAT_ORDER_WRITES switch (M3, 2026-09-24).
// Claudia's Telegram chat can create, update and delete orders with the
// service key. With the switch unset or 'on' that must stay exactly as it
// was; with 'off' the chat still answers questions but writes NOTHING and
// points to HC App. Fake network: no request leaves this process, and no
// real key, chat, customer or order is used.
//
// Run: node worker/test-chat-order-writes.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { chatOrderWritesOn, CHAT_ORDER_WRITES_OFF_REPLY, answersOnlyEventContext } from './worker.js';

const WORKER_URL = 'https://worker.example.test';
const SB = 'https://sandbox.supabase.test';
const CHAT = '424242';
const HC_APP = 'https://app.hamptonscoconuts.com';
const baseEnv = {
  SUPABASE_URL: SB,
  SUPABASE_SERVICE_KEY: 'sandbox-service-key',
  ANTHROPIC_API_KEY: 'sandbox-anthropic-key',
  TG_BOT_TOKEN: 'sandbox-bot-token',
  TG_WEBHOOK_SECRET: 'sandbox-telegram-webhook-secret',
  ALLOWED_CHAT_IDS: CHAT,
};
const ORDER_A = '11111111-1111-4111-8111-111111111111';
const ORDER_B = '22222222-2222-4222-8222-222222222222';
const ROWS = [
  { id: ORDER_A, client_name: 'Test Client A', stage: 'quoted', market: 'ny',
    event_start_at: '2026-10-10T12:00:00Z', coconuts_qty: 100, total_cents: 150000,
    deposit_cents: 0, balance_cents: 0, stamp_status: 'not_ordered' },
  { id: ORDER_B, client_name: 'Test Client B', stage: 'invoiced', market: 'ny',
    event_start_at: '2026-10-12T12:00:00Z', coconuts_qty: 50, total_cents: 90000,
    deposit_cents: 0, balance_cents: 0, stamp_status: 'ordered' },
  // One row per other stored stage, for the answers-only context checks.
  { id: '33333333-3333-4333-8333-333333333333', client_name: 'Test Client D', stage: 'deposit_paid',
    market: 'ny', total_cents: 80000, deposit_cents: 0, balance_cents: null },
  { id: '44444444-4444-4444-8444-444444444444', client_name: 'Test Client E', stage: 'paid_full',
    market: 'ny', total_cents: 70000, deposit_cents: 35000, balance_cents: 35000 },
  { id: '55555555-5555-4555-8555-555555555555', client_name: 'Test Client F', stage: 'fulfilled',
    market: 'ny', total_cents: 60000, deposit_cents: 0, balance_cents: 0 },
  { id: '66666666-6666-4666-8666-666666666666', client_name: 'Test Client G', stage: 'cancelled',
    market: 'ny', total_cents: null, deposit_cents: 0, balance_cents: null },
  { id: '77777777-7777-4777-8777-777777777777', client_name: 'Test Client H', stage: 'complete',
    market: 'ny', total_cents: 50000, deposit_cents: 50000, balance_cents: 0 },
  { id: '88888888-8888-4888-8888-888888888888', client_name: 'Test Client I', stage: 'some_new_stage',
    market: 'ny', total_cents: 40000, deposit_cents: 0, balance_cents: 0 },
];
// What Claude is told for each row, by client name.
function sentContext(calls) {
  const content = calls.ai[0].messages[0].content;
  const start = content.indexOf('total):\n') + 'total):\n'.length;
  const end = content.indexOf('\n\nUser message:');
  const list = JSON.parse(content.slice(start, end));
  return Object.fromEntries(list.map(entry => [entry.name, entry]));
}

let failed = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log('PASS  ' + name);
  } catch (error) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + String(error.message || error));
  }
}

function jsonReply(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// One fake network per scenario. `claude` is what the fake model answers:
// an object (sent back as its JSON text) or { httpStatus } for an API error.
function installHarness(claude) {
  const calls = { reads: [], writes: [], ai: [], telegram: [], order: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = String(options.method || 'GET').toUpperCase();
    if (url.startsWith(SB + '/rest/v1/orders')) {
      if (method === 'GET') {
        calls.reads.push(url);
        calls.order.push('read');
        return jsonReply(200, url.includes('offset=0') ? ROWS : []);
      }
      calls.writes.push({ method, url, body: options.body ? JSON.parse(options.body) : null });
      calls.order.push('write:' + method);
      if (method === 'POST') return jsonReply(201, [JSON.parse(options.body)]);
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(options.body);
      calls.ai.push(body);
      calls.order.push('ai');
      if (claude && claude.httpStatus) return jsonReply(claude.httpStatus, { error: 'fake' });
      return jsonReply(200, { content: [{ type: 'text', text: JSON.stringify(claude) }] });
    }
    if (url.startsWith('https://api.telegram.org/bot')) {
      calls.telegram.push(JSON.parse(options.body));
      calls.order.push('telegram');
      return jsonReply(200, { ok: true, result: {} });
    }
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return { calls, restore() { globalThis.fetch = originalFetch; } };
}

function chatUpdate(text) {
  return new Request(WORKER_URL + '/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': baseEnv.TG_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 7, chat: { id: Number(CHAT) }, text },
    }),
  });
}

async function runChat(text, claude, envExtra = {}) {
  const harness = installHarness(claude);
  try {
    const response = await worker.fetch(chatUpdate(text), { ...baseEnv, ...envExtra });
    assert.equal(response.status, 200);
    return harness.calls;
  } finally {
    harness.restore();
  }
}

// Silence the worker's own console lines so the PASS/FAIL list stays readable,
// but keep them so a test can check what was logged.
const logged = [];
const originalLog = console.log;
const originalError = console.error;
function quietWorker(fn) {
  return async () => {
    console.log = (...args) => logged.push(args.join(' '));
    console.error = (...args) => logged.push(args.join(' '));
    try { await fn(); } finally { console.log = originalLog; console.error = originalError; }
  };
}

const UPDATE_A = {
  action: 'update', eventId: ORDER_A, params: { stamp_status: 'Received' },
  reply: 'Done! Marked the stamp received for *Test Client A*',
};
const CREATE_NEW = {
  action: 'create', eventId: null,
  params: { name: 'Test Client C', type: 'event', event_date: '2026-11-01', coconuts: '60' },
  reply: 'Added *Test Client C*',
};
const DELETE_B = {
  action: 'delete', eventId: ORDER_B, params: null,
  reply: 'Deleted *Test Client B*',
};
const QUESTION = {
  action: 'none', eventId: null, params: null,
  reply: 'You have 2 events coming up: *Test Client A* and *Test Client B*',
};
const LISTING = {
  action: 'list', eventId: null, params: null,
  reply: '1. *Test Client A*\n2. *Test Client B*',
};

// ── the switch value ────────────────────────────────────────────────
await check('switch: unset, blank and on (any case, spaces) allow writes', async () => {
  assert.equal(chatOrderWritesOn({}), true);
  assert.equal(chatOrderWritesOn(undefined), true);
  assert.equal(chatOrderWritesOn({ CLAUDIA_CHAT_ORDER_WRITES: '' }), true);
  assert.equal(chatOrderWritesOn({ CLAUDIA_CHAT_ORDER_WRITES: '   ' }), true);
  assert.equal(chatOrderWritesOn({ CLAUDIA_CHAT_ORDER_WRITES: 'on' }), true);
  assert.equal(chatOrderWritesOn({ CLAUDIA_CHAT_ORDER_WRITES: ' ON ' }), true);
});

await check('switch: off and every other value (a typo too) block writes', async () => {
  for (const value of ['off', 'OFF', ' off ', 'false', '0', 'no', 'of', 'onn']) {
    assert.equal(chatOrderWritesOn({ CLAUDIA_CHAT_ORDER_WRITES: value }), false, value);
  }
});

await check('the off reply is plain, short, dash free and names HC App', async () => {
  assert.ok(CHAT_ORDER_WRITES_OFF_REPLY.includes(HC_APP));
  assert.ok(CHAT_ORDER_WRITES_OFF_REPLY.includes('nothing was changed'));
  assert.ok(CHAT_ORDER_WRITES_OFF_REPLY.length < 140);
  assert.doesNotMatch(CHAT_ORDER_WRITES_OFF_REPLY, /[–—*_`[]/);
});

// ── switch unset or on: today's behavior, writes happen ─────────────
for (const [label, envExtra] of [['unset', {}], ['on', { CLAUDIA_CHAT_ORDER_WRITES: 'on' }]]) {
  await check(`${label}: an update intent PATCHes that one order and sends Claude's reply`, quietWorker(async () => {
    const calls = await runChat('stamp received for test client a', UPDATE_A, envExtra);
    assert.deepEqual(calls.order, ['read', 'ai', 'write:PATCH', 'telegram']);
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.writes[0].url, SB + '/rest/v1/orders?id=eq.' + ORDER_A);
    assert.equal(calls.writes[0].body.stamp_status, 'received');
    assert.ok(!('sb_stage' in calls.writes[0].body), 'the read-only stored stage is never written');
    assert.equal(calls.telegram.length, 1);
    assert.equal(calls.telegram[0].text, UPDATE_A.reply);
    assert.equal(calls.telegram[0].parse_mode, 'Markdown');
  }));

  await check(`${label}: a create intent POSTs one new order`, quietWorker(async () => {
    const calls = await runChat('add Test Client C, Nov 1, 60 coconuts', CREATE_NEW, envExtra);
    assert.deepEqual(calls.order, ['read', 'ai', 'write:POST', 'telegram']);
    assert.equal(calls.writes[0].url, SB + '/rest/v1/orders');
    assert.equal(calls.writes[0].body.client_name, 'Test Client C');
    assert.equal(calls.writes[0].body.coconuts_qty, 60);
    assert.equal(calls.telegram[0].text, CREATE_NEW.reply);
  }));

  await check(`${label}: a delete intent DELETEs that one order`, quietWorker(async () => {
    const calls = await runChat('yes delete test client b', DELETE_B, envExtra);
    assert.deepEqual(calls.order, ['read', 'ai', 'write:DELETE', 'telegram']);
    assert.equal(calls.writes[0].url, SB + '/rest/v1/orders?id=eq.' + ORDER_B);
    assert.equal(calls.telegram[0].text, DELETE_B.reply);
  }));

  await check(`${label}: /start still shows the old help with the edit examples`, quietWorker(async () => {
    const calls = await runChat('/start', QUESTION, envExtra);
    assert.deepEqual(calls.order, ['telegram']);
    assert.ok(calls.telegram[0].text.includes('Add new event'));
    assert.ok(!calls.telegram[0].text.includes(HC_APP));
  }));
}

await check('unset and on send Claude the very same prompt, with no off block', quietWorker(async () => {
  const unset = await runChat('what is coming up?', QUESTION, {});
  const on = await runChat('what is coming up?', QUESTION, { CLAUDIA_CHAT_ORDER_WRITES: 'on' });
  assert.equal(unset.ai.length, 1);
  assert.equal(unset.ai[0].system, on.ai[0].system);
  assert.ok(unset.ai[0].system.startsWith('You are Claudia'));
  assert.ok(!unset.ai[0].system.includes('CHAT EDITS ARE OFF'));
}));

// ── switch off: answers only, no writes ─────────────────────────────
const OFF = { CLAUDIA_CHAT_ORDER_WRITES: 'off' };
for (const [label, claude] of [['update', UPDATE_A], ['create', CREATE_NEW], ['delete', DELETE_B]]) {
  await check(`off: a ${label} intent writes nothing and points to HC App`, quietWorker(async () => {
    const calls = await runChat('please ' + label + ' it', claude, OFF);
    assert.deepEqual(calls.order, ['read', 'ai', 'telegram']);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.telegram.length, 1);
    assert.equal(calls.telegram[0].text, CHAT_ORDER_WRITES_OFF_REPLY);
    assert.equal(calls.telegram[0].parse_mode, undefined); // plain text
    assert.ok(!calls.telegram.some(m => m.text === claude.reply)); // never "Done!"
  }));
}

await check('off: an incomplete write intent (no order id, no params) still gets the HC App reply', quietWorker(async () => {
  for (const claude of [
    { action: 'update', eventId: null, params: null, reply: 'Updated!' },
    { action: 'delete', eventId: null, params: null, reply: 'Deleted!' },
    { action: 'create', eventId: null, params: null, reply: 'Created!' },
  ]) {
    const calls = await runChat('change something', claude, OFF);
    assert.equal(calls.writes.length, 0);
    assert.deepEqual(calls.telegram.map(m => m.text), [CHAT_ORDER_WRITES_OFF_REPLY]);
  }
}));

await check('off: a typo value behaves like off (no write)', quietWorker(async () => {
  const calls = await runChat('stamp received', UPDATE_A, { CLAUDIA_CHAT_ORDER_WRITES: 'of' });
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.telegram[0].text, CHAT_ORDER_WRITES_OFF_REPLY);
}));

await check('off: a question is still answered from the order list, as before', quietWorker(async () => {
  const calls = await runChat('what is coming up?', QUESTION, OFF);
  assert.deepEqual(calls.order, ['read', 'ai', 'telegram']);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.telegram[0].text, QUESTION.reply);
  assert.equal(calls.telegram[0].parse_mode, 'Markdown');
  const sent = calls.ai[0].messages[0].content;
  assert.ok(sent.includes('Test Client A') && sent.includes('Test Client B'));
}));

await check('off: a list request is still answered, as before', quietWorker(async () => {
  const calls = await runChat('list my events', LISTING, OFF);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.telegram[0].text, LISTING.reply);
}));

await check('off: Claude is told edits are off (on prompt plus one block, nothing removed)', quietWorker(async () => {
  const on = await runChat('what is coming up?', QUESTION, {});
  const off = await runChat('what is coming up?', QUESTION, OFF);
  assert.ok(off.ai[0].system.startsWith(on.ai[0].system));
  const extra = off.ai[0].system.slice(on.ai[0].system.length);
  assert.ok(extra.includes('CHAT EDITS ARE OFF'));
  assert.ok(extra.includes('no confirmation question'));
  assert.equal(off.ai[0].model, on.ai[0].model);
}));

await check('off: /start offers questions only and names HC App, no order read, no AI call', quietWorker(async () => {
  const calls = await runChat('/start', QUESTION, OFF);
  assert.deepEqual(calls.order, ['telegram']);
  assert.ok(calls.telegram[0].text.includes(HC_APP));
  assert.ok(!calls.telegram[0].text.includes('Add new event'));
  assert.ok(!calls.telegram[0].text.includes('fully paid'));
}));

await check('off: an AI error is reported exactly as before and writes nothing', quietWorker(async () => {
  const calls = await runChat('stamp received', { httpStatus: 500 }, OFF);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.telegram.length, 1);
  assert.ok(calls.telegram[0].text.startsWith('❌ AI error: HTTP 500'));
}));

await check('off: the refusal log names the action only (no order id, no customer)', quietWorker(async () => {
  logged.length = 0;
  await runChat('stamp received', UPDATE_A, OFF);
  const line = logged.find(l => l.includes('chat order write refused'));
  assert.ok(line, 'refusal was logged');
  assert.ok(line.includes('(action update)'));
  assert.ok(!line.includes(ORDER_A) && !line.includes('Test Client'));
}));

await check('a chat from a chat id that is not allowed is still refused before any read', quietWorker(async () => {
  const calls = await runChat('what is coming up?', QUESTION, { ...OFF, ALLOWED_CHAT_IDS: '999' });
  assert.deepEqual(calls.order, ['telegram']);
  assert.ok(calls.telegram[0].text.includes('Access denied'));
}));

// ── answers only: no payment facts from the dashboard (review F1) ───
await check('on: Claude still gets today\'s context (lossy stage names, received amounts)', quietWorker(async () => {
  const ctx = sentContext(await runChat('what is coming up?', QUESTION, {}));
  assert.equal(ctx['Test Client A'].stage, 'lead');          // quoted
  assert.equal(ctx['Test Client B'].stage, 'deposit_paid');  // invoiced
  assert.equal(ctx['Test Client E'].stage, 'payment_full');
  assert.equal(ctx['Test Client F'].stage, 'completed');     // fulfilled
  assert.equal(ctx['Test Client I'].stage, 'lead');          // unknown word
  assert.equal(ctx['Test Client B'].deposit_amount, '0');
  assert.equal(ctx['Test Client E'].balance_amount, '350');
  assert.ok(!('sb_stage' in ctx['Test Client A']));
}));

await check('off: Claude gets truthful stage words and no payment stage', quietWorker(async () => {
  const ctx = sentContext(await runChat('who still owes a deposit?', QUESTION, OFF));
  assert.equal(ctx['Test Client A'].stage, 'quoted');
  assert.equal(ctx['Test Client B'].stage, 'invoiced');
  assert.equal(ctx['Test Client D'].stage, 'invoiced');      // deposit_paid
  assert.equal(ctx['Test Client E'].stage, 'invoiced');      // paid_full
  assert.equal(ctx['Test Client F'].stage, 'fulfilled');
  assert.equal(ctx['Test Client G'].stage, 'passed');        // cancelled
  assert.equal(ctx['Test Client H'].stage, 'completed');     // complete
  assert.equal(ctx['Test Client I'].stage, 'some_new_stage');// passed through, no throw
  for (const entry of Object.values(ctx)) {
    assert.ok(!['deposit_paid', 'payment_full', 'paid_full'].includes(entry.stage), entry.name);
    assert.ok(!('deposit_amount' in entry) && !('balance_amount' in entry), entry.name);
    assert.ok(!('sb_stage' in entry), entry.name);
  }
  assert.equal(ctx['Test Client E'].total_amount, '700');    // the invoice total stays
  assert.equal(ctx['Test Client A'].name, 'Test Client A');
}));

await check('off: Claude is told payments come from QuickBooks through Jarvis', quietWorker(async () => {
  const off = await runChat('who paid?', QUESTION, OFF);
  const on = await runChat('who paid?', QUESTION, {});
  const extra = off.ai[0].system.slice(on.ai[0].system.length);
  assert.ok(extra.includes('Never say who has paid'));
  assert.ok(extra.includes('QuickBooks') && extra.includes('Jarvis'));
  assert.ok(extra.includes('"invoiced" means an invoice exists'));
  assert.doesNotMatch(extra, /[–—]/);
}));

await check('answersOnlyEventContext: odd stored words never throw or leak a prototype', async () => {
  const base = { id: 'x', name: 'n', stage: 'lead', deposit_amount: '5', balance_amount: '6', total_amount: '9' };
  assert.equal(answersOnlyEventContext(base, 'constructor').stage, 'constructor');
  assert.equal(answersOnlyEventContext(base, '__proto__').stage, '__proto__');
  assert.equal(answersOnlyEventContext(base, '').stage, 'lead');
  assert.equal(answersOnlyEventContext(base, null).stage, 'lead');
  assert.equal(answersOnlyEventContext(base, undefined).stage, 'lead');
  const out = answersOnlyEventContext(base, 'paid_full');
  assert.deepEqual(out, { id: 'x', name: 'n', stage: 'invoiced', total_amount: '9' });
  assert.equal(base.deposit_amount, '5', 'the input entry is not changed');
});

// ── answers only: odd actions never carry the model's reply (review F3) ──
const ODD_ACTIONS = [
  { action: 'Update', eventId: ORDER_A, params: { stage: 'payment_full' }, reply: 'Done! Marked paid' },
  { action: 'mark', eventId: ORDER_A, params: null, reply: 'Done! Marked paid' },
  { eventId: ORDER_A, params: null, reply: 'Done! Marked paid' },                 // no action
  { action: ['update'], eventId: ORDER_A, params: null, reply: 'Done! Marked paid' },
  { action: 'update Test Client A', eventId: null, params: null, reply: 'Done! Marked paid' },
];
await check('off: an odd or missing action gets the off reply, writes nothing, logs only "other"', quietWorker(async () => {
  for (const claude of ODD_ACTIONS) {
    logged.length = 0;
    const calls = await runChat('mark test client a paid', claude, OFF);
    assert.equal(calls.writes.length, 0, JSON.stringify(claude.action));
    assert.deepEqual(calls.telegram.map(m => m.text), [CHAT_ORDER_WRITES_OFF_REPLY], JSON.stringify(claude.action));
    const line = logged.find(l => l.includes('chat order write refused'));
    assert.ok(line && line.includes('(action other)'), JSON.stringify(claude.action));
    assert.ok(!line.includes('Test Client'));
  }
}));

await check('on: an odd action behaves exactly as before (no write, the model reply is sent)', quietWorker(async () => {
  for (const claude of ODD_ACTIONS) {
    const calls = await runChat('mark test client a paid', claude, {});
    assert.equal(calls.writes.length, 0, JSON.stringify(claude.action));
    assert.deepEqual(calls.telegram.map(m => m.text), ['Done! Marked paid']);
  }
}));

// ── source pins: the gate sits in front of every chat write ─────────
await check('source: the three chat write calls exist once each, all after the off gate', async () => {
  const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const gate = source.indexOf('if (!chatWritesOn && !CHAT_ANSWER_ACTIONS.has(claudeResp.action))');
  assert.ok(gate > 0, 'gate present');
  for (const call of ['await updateEvent(', 'await insertEvent(', 'await deleteEvent(']) {
    const first = source.indexOf(call);
    assert.ok(first > gate, call + ' comes after the gate');
    assert.equal(source.indexOf(call, first + 1), -1, call + ' has one call site');
  }
  assert.match(source, /const CHAT_WRITE_ACTIONS = new Set\(\['create', 'update', 'delete'\]\);/);
  assert.match(source, /const CHAT_ANSWER_ACTIONS = new Set\(\['none', 'list'\]\);/);
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);
