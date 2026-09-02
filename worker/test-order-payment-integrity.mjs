// Offline payment-integrity and persistence-confirmation tests.
// Every network request is intercepted in memory. Nothing reaches production.

import assert from 'node:assert/strict';
import worker, {
  canChangeStage,
  hasRecordedPayment,
  stageFromSupabase,
  stageToSupabase,
  validateMutationParams,
} from './worker.js';

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';
const WRONG_ID = '123e4567-e89b-42d3-a456-426614174999';
const CHAT_ID = '12345';
const SUCCESS_REPLY = '✅ Saved by Claudia';

const env = {
  TG_WEBHOOK_SECRET: 'offline-webhook-secret',
  ALLOWED_CHAT_IDS: CHAT_ID,
  TG_BOT_TOKEN: 'offline-bot-token',
  SUPABASE_URL: 'https://offline.supabase.test',
  SUPABASE_SERVICE_KEY: 'offline-service-key',
  ANTHROPIC_API_KEY: 'offline-ai-key',
};

const baseOrder = {
  id: ORDER_ID,
  stage: 'invoiced',
  client_name: 'Test Client',
  venue: 'Original Venue',
  total_cents: 10000,
  deposit_cents: 0,
  balance_cents: 0,
};

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS  ${message}`);
}

function failureOnly(messages, pattern) {
  return messages.length === 1 && pattern.test(messages[0]) && messages[0] !== SUCCESS_REPLY;
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch (e) {
    return true;
  }
}

async function runAction({
  action,
  params = null,
  eventId = action === 'create' ? null : ORDER_ID,
  rows = [baseOrder],
  writeResult = 'success',
}) {
  const telegramMessages = [];
  const writes = [];
  let claudeRequest = null;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const claudeResult = { action, eventId, params, reply: SUCCESS_REPLY };

  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const method = String(options.method || 'GET').toUpperCase();

    if (method === 'GET' && url.startsWith(env.SUPABASE_URL + '/rest/v1/orders?select=*')) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      claudeRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(claudeResult) }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith(env.SUPABASE_URL + '/rest/v1/orders')) {
      const body = options.body ? JSON.parse(options.body) : null;
      writes.push({ url, method, body, headers: options.headers || {} });
      if (writeResult === 'http-failure') {
        return new Response('offline write rejected', { status: 503 });
      }
      if (writeResult === 'zero') {
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (writeResult === 'empty-204') {
        return new Response(null, { status: 204 });
      }
      const returnedId = writeResult === 'wrong-id'
        ? WRONG_ID
        : (method === 'POST' ? body.id : ORDER_ID);
      return new Response(JSON.stringify([{ id: returnedId }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith('https://api.telegram.org/')) {
      telegramMessages.push(JSON.parse(options.body).text);
      return new Response('ok', { status: 200 });
    }
    throw new Error(`Unexpected offline request: ${method} ${url}`);
  };
  console.error = () => {};

  try {
    const response = await worker.fetch(new Request('https://worker.test/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': env.TG_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        message: { chat: { id: CHAT_ID }, text: 'offline test action' },
      }),
    }), env);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }

  return { telegramMessages, writes, claudeRequest };
}

const stagePairs = [
  ['inquiry', 'lead'],
  ['quoted', 'quoted'],
  ['invoiced', 'invoiced'],
  ['deposit_paid', 'deposit_paid'],
  ['paid_full', 'payment_full'],
  ['fulfilled', 'fulfilled'],
  ['complete', 'completed'],
  ['cancelled', 'passed'],
];
for (const [supabaseStage, dashboardStage] of stagePairs) {
  check(stageFromSupabase(supabaseStage) === dashboardStage, `${supabaseStage} maps exactly to ${dashboardStage}`);
  check(stageToSupabase(dashboardStage) === supabaseStage, `${dashboardStage} maps exactly to ${supabaseStage}`);
}
check(throws(() => stageFromSupabase('mystery')), 'unknown database stages are rejected');
check(throws(() => stageToSupabase('mystery')), 'unknown Telegram stages are rejected');

check(hasRecordedPayment({ deposit_amount: '$1,250.00' }), 'formatted positive deposit is durable payment evidence');
check(hasRecordedPayment({ balance_amount: '25' }), 'positive balance payment is durable payment evidence');
check(!hasRecordedPayment({ deposit_amount: '0', balance_amount: '' }), 'zero received amount is not payment evidence');
check(canChangeStage('deposit_paid', 'completed', true), 'paid order may advance to completed');
check(canChangeStage('payment_full', 'fulfilled', true), 'fully paid order may advance to fulfilled');
check(canChangeStage('invoiced', 'fulfilled', true), 'verified payment evidence may advance to fulfilled');
check(!canChangeStage('invoiced', 'passed', true), 'verified payment evidence cannot be cancelled by Telegram');
check(!canChangeStage('fulfilled', 'invoiced', true), 'fulfilled paid order cannot regress to invoiced');
check(!canChangeStage('completed', 'invoiced', true), 'completed paid order cannot regress to invoiced');
check(!canChangeStage('completed', 'passed', true), 'completed paid order cannot regress to passed');
check(canChangeStage('completed', 'invoiced', false), 'zero-payment completed order keeps normal stage behavior');
check(canChangeStage('completed', 'passed', false), 'zero-payment completed order may be cancelled normally');
check(throws(() => validateMutationParams({ stage: 'deposit_paid' })), 'Telegram cannot create a deposit-paid stage');
check(throws(() => validateMutationParams({ stage: 'payment_full' })), 'Telegram cannot create a fully-paid stage');
check(throws(() => validateMutationParams({ deposit_amount: '100' })), 'Telegram cannot write a deposit amount');
check(throws(() => validateMutationParams({ balance_cents: 10000 })), 'Telegram cannot write a database payment amount alias');

const updateFailure = await runAction({
  action: 'update',
  params: { venue: 'New Venue' },
  writeResult: 'http-failure',
});
check(updateFailure.writes.length === 1 && failureOnly(updateFailure.telegramMessages, /could not save that update/i), 'failed update sends only a retry message');

const updateZero = await runAction({
  action: 'update',
  params: { venue: 'New Venue' },
  writeResult: 'zero',
});
check(updateZero.writes.length === 1 && failureOnly(updateZero.telegramMessages, /could not save that update/i), '200 response with zero updated rows is not success');

const updateEmpty204 = await runAction({
  action: 'update',
  params: { venue: 'New Venue' },
  writeResult: 'empty-204',
});
check(updateEmpty204.writes.length === 1 && failureOnly(updateEmpty204.telegramMessages, /could not save that update/i), '204 response without a returned order is not success');

const updateWrongId = await runAction({
  action: 'update',
  params: { venue: 'New Venue' },
  writeResult: 'wrong-id',
});
check(updateWrongId.writes.length === 1 && failureOnly(updateWrongId.telegramMessages, /could not save that update/i), 'update returning a different order is not success');

const updateSuccess = await runAction({
  action: 'update',
  params: { venue: 'New Venue' },
});
check(updateSuccess.telegramMessages.length === 1 && updateSuccess.telegramMessages[0] === SUCCESS_REPLY, 'confirmed update sends the AI success reply');
check(JSON.stringify(updateSuccess.writes[0].body) === JSON.stringify({ venue: 'New Venue' }), 'ordinary update sends only the changed field');
check(updateSuccess.writes[0].headers.Prefer === 'return=representation', 'update asks Supabase to return the affected order');

const updateNoChange = await runAction({
  action: 'update',
  params: { venue: 'Original Venue' },
});
check(updateNoChange.writes.length === 0 && failureOnly(updateNoChange.telegramMessages, /nothing needed changing/i), 'no-op update makes no success claim without a database write');

const paidToCompleted = await runAction({
  action: 'update',
  params: { stage: 'completed' },
  rows: [{ ...baseOrder, stage: 'deposit_paid', deposit_cents: 2500 }],
});
check(paidToCompleted.telegramMessages[0] === SUCCESS_REPLY, 'paid order can be completed after a confirmed save');
check(JSON.stringify(paidToCompleted.writes[0].body) === JSON.stringify({ stage: 'complete' }), 'paid-to-completed update changes only the operational stage');
check(!('deposit_cents' in paidToCompleted.writes[0].body) && !('balance_cents' in paidToCompleted.writes[0].body), 'paid-order update omits payment columns');

for (const forbiddenStage of ['invoiced', 'passed']) {
  const denied = await runAction({
    action: 'update',
    params: { stage: forbiddenStage },
    rows: [{ ...baseOrder, stage: 'complete', deposit_cents: 2500 }],
  });
  check(denied.writes.length === 0 && failureOnly(denied.telegramMessages, /did not change that verified paid status/i), `completed paid order cannot change to ${forbiddenStage}`);
}

const zeroPaymentCompleted = await runAction({
  action: 'update',
  params: { stage: 'invoiced' },
  rows: [{ ...baseOrder, stage: 'complete', deposit_cents: 0, balance_cents: 0 }],
});
check(zeroPaymentCompleted.telegramMessages[0] === SUCCESS_REPLY && zeroPaymentCompleted.writes[0].body.stage === 'invoiced', 'zero-payment completed order follows normal confirmed update behavior');

const missingUpdateId = await runAction({
  action: 'update',
  eventId: null,
  params: { venue: 'New Venue' },
});
check(missingUpdateId.writes.length === 0 && failureOnly(missingUpdateId.telegramMessages, /valid order update/i), 'missing update ID fails accurately without writing');

const missingUpdateTarget = await runAction({
  action: 'update',
  params: { venue: 'New Venue' },
  rows: [],
});
check(missingUpdateTarget.writes.length === 0 && failureOnly(missingUpdateTarget.telegramMessages, /could not find that order/i), 'unknown update ID fails accurately without writing');

const createFailure = await runAction({
  action: 'create',
  params: { name: 'New Test Order', stage: 'lead' },
  rows: [],
  writeResult: 'http-failure',
});
check(createFailure.writes.length === 1 && failureOnly(createFailure.telegramMessages, /could not create that order/i), 'failed insert sends only a retry message');

const createZero = await runAction({
  action: 'create',
  params: { name: 'New Test Order', stage: 'lead' },
  rows: [],
  writeResult: 'zero',
});
check(createZero.writes.length === 1 && failureOnly(createZero.telegramMessages, /could not create that order/i), 'insert returning zero rows is not success');

const createSuccess = await runAction({
  action: 'create',
  params: { name: 'New Test Order', stage: 'lead' },
  rows: [],
});
check(createSuccess.telegramMessages[0] === SUCCESS_REPLY, 'confirmed insert sends the AI success reply');
check(!('deposit_cents' in createSuccess.writes[0].body) && !('balance_cents' in createSuccess.writes[0].body), 'new Telegram order omits payment columns');
check(createSuccess.writes[0].headers.Prefer === 'return=representation', 'insert asks Supabase to return the created order');

const createPaymentDenied = await runAction({
  action: 'create',
  params: { name: 'Unsafe Order', stage: 'deposit_paid', deposit_amount: '100' },
  rows: [],
});
check(createPaymentDenied.writes.length === 0 && failureOnly(createPaymentDenied.telegramMessages, /did not create that payment status/i), 'payment-bearing insert is denied before Supabase');

const deleteFailure = await runAction({ action: 'delete', writeResult: 'http-failure' });
check(deleteFailure.writes.length === 1 && failureOnly(deleteFailure.telegramMessages, /could not delete that order/i), 'failed delete sends only a retry message');

const deleteZero = await runAction({ action: 'delete', writeResult: 'zero' });
check(deleteZero.writes.length === 1 && failureOnly(deleteZero.telegramMessages, /could not delete that order/i), 'delete returning zero rows is not success');

const deleteEmpty204 = await runAction({ action: 'delete', writeResult: 'empty-204' });
check(deleteEmpty204.writes.length === 1 && failureOnly(deleteEmpty204.telegramMessages, /could not delete that order/i), '204 delete without a returned order is not success');

const deleteSuccess = await runAction({ action: 'delete' });
check(deleteSuccess.telegramMessages[0] === SUCCESS_REPLY, 'confirmed delete sends the AI success reply');
check(deleteSuccess.writes[0].headers.Prefer === 'return=representation', 'delete asks Supabase to return the removed order');

const missingDeleteId = await runAction({ action: 'delete', eventId: null });
check(missingDeleteId.writes.length === 0 && failureOnly(missingDeleteId.telegramMessages, /identify the order to delete/i), 'missing delete ID fails accurately without writing');

check(/Never infer, assert, or claim that a payment was received/.test(updateSuccess.claudeRequest.system), 'AI prompt forbids asserted payment evidence');
check(/verified QuickBooks sync handles payment automatically/.test(updateSuccess.claudeRequest.system), 'AI prompt directs payment requests to verified QuickBooks sync');

console.log(`\n${checks}/${checks} payment-integrity checks passed`);
