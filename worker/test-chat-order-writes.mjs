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
import worker, { chatOrderWritesOn, CHAT_ORDER_WRITES_OFF_REPLY } from './worker.js';

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
];

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

// ── source pins: the gate sits in front of every chat write ─────────
await check('source: the three chat write calls exist once each, all after the off gate', async () => {
  const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const gate = source.indexOf('if (!chatWritesOn && CHAT_WRITE_ACTIONS.has(claudeResp.action))');
  assert.ok(gate > 0, 'gate present');
  for (const call of ['await updateEvent(', 'await insertEvent(', 'await deleteEvent(']) {
    const first = source.indexOf(call);
    assert.ok(first > gate, call + ' comes after the gate');
    assert.equal(source.indexOf(call, first + 1), -1, call + ' has one call site');
  }
  assert.match(source, /const CHAT_WRITE_ACTIONS = new Set\(\['create', 'update', 'delete'\]\);/);
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);
