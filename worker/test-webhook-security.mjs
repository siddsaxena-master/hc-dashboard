import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { runWebhookIntakeScan } from './worker.js';

const WORKER_URL = 'https://worker.example.test';
const FORMSPREE_SECRET = 'formspree-test-signing-secret';
const QUO_KEY_BYTES = new TextEncoder().encode('quo-test-signing-key-32-bytes!!');
const QUO_SIGNING_KEY = bytesToBase64(QUO_KEY_BYTES);
const GRAPH_CLIENT_STATE = 'graph-test-client-state';
const OUTBOX_ID_KEY = bytesToBase64(new Uint8Array(32).fill(17));
const OUTBOX_ENCRYPTION_KEY = bytesToBase64(new Uint8Array(32).fill(34));
const OUTBOX_ENCRYPTION_KEY_ROTATED = bytesToBase64(
  new Uint8Array(32).fill(51),
);

const baseEnv = {
  FORMSPREE_WEBHOOK_SIGNING_SECRET: FORMSPREE_SECRET,
  QUO_WEBHOOK_SIGNING_KEY: QUO_SIGNING_KEY,
  MS_GRAPH_CLIENT_STATE: GRAPH_CLIENT_STATE,
  MS_GRAPH_ALLOWED_SUBSCRIPTION_IDS: 'subscription-one,subscription-two',
  MS_GRAPH_ALLOWED_TENANT_IDS: 'tenant-one,tenant-two',
  SUPABASE_URL: 'https://sandbox.supabase.test',
  SUPABASE_SERVICE_KEY: 'sandbox-service-key',
  ANTHROPIC_API_KEY: 'sandbox-anthropic-key',
  TG_BOT_TOKEN: 'sandbox-telegram-token',
  TG_WEBHOOK_SECRET: 'sandbox-telegram-webhook-secret',
  ALLOWED_CHAT_IDS: '',
  WEBHOOK_OUTBOX_ID_KEY: OUTBOX_ID_KEY,
  WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT:
    'test-current:' + OUTBOX_ENCRYPTION_KEY,
};

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

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptTestOutbox(row, encodedKey) {
  const outbox = row.payload.telegram_outbox;
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(encodedKey),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(outbox.nonce),
      additionalData: new TextEncoder().encode(
        'hc-telegram-outbox-v2\0' + outbox.key_version + '\0' + row.id,
      ),
    },
    key,
    base64ToBytes(outbox.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  ));
}

async function formspreeSignature(rawBody, timestamp, secret = FORMSPREE_SECRET) {
  const digest = await hmacSha256(
    new TextEncoder().encode(secret),
    timestamp + '.' + rawBody,
  );
  return 't=' + timestamp + ',v1=' + bytesToHex(digest);
}

async function quoSignature(body, timestamp, keyBytes = QUO_KEY_BYTES) {
  const digest = await hmacSha256(
    keyBytes,
    timestamp + '.' + JSON.stringify(body),
  );
  return 'hmac;1;' + timestamp + ';' + bytesToBase64(digest);
}

function request(path, rawBody, headers = {}, method = 'POST') {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (method !== 'GET') options.body = rawBody;
  return new Request(WORKER_URL + path, options);
}

function jsonReply(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function nextTestUuid(state) {
  const suffix = String(state.nextUuid++).padStart(12, '0');
  return '10000000-0000-4000-8000-' + suffix;
}

function installFetchHarness(config = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const aiResponses = [...(config.aiResponses || [])];
  const state = {
    receipts: new Map(),
    orders: new Map(),
    orderAttempts: [],
    pushQueue: new Map(),
    pushAttempts: [],
    aiMessages: [],
    telegramAttempts: new Map(),
    telegramAccepted: new Map(),
    intake: new Map(),
    intakeClock: 0,
    nextUuid: 1,
    orderResponseLost: false,
    finishResponseLost: false,
    pushResponseLost: false,
    pushPostFailuresRemaining: Number(config.pushPostFailures || 0),
    telegramFailureUsed: false,
  };

  globalThis.fetch = async (urlValue, fetchOptions = {}) => {
    const url = String(urlValue);
    let parsedBody = null;
    try {
      parsedBody = fetchOptions.body ? JSON.parse(fetchOptions.body) : null;
    } catch {}
    calls.push({ url, options: fetchOptions, body: parsedBody });

    if (url.endsWith('/rest/v1/rpc/hc_claim_webhook_delivery')) {
      const key = parsedBody.p_provider + '|' + parsedBody.p_event_key;
      let receipt = state.receipts.get(key);
      if (!receipt) {
        receipt = {
          receiptId: nextTestUuid(state),
          claimToken: nextTestUuid(state),
          deliveryState: 'processing',
          leaseActive: true,
          attempts: 1,
        };
        state.receipts.set(key, receipt);
        return jsonReply(200, [{
          claim_state: 'claimed',
          receipt_id: receipt.receiptId,
          claim_token: receipt.claimToken,
          claim_expires_at: new Date(Date.now() + 300000).toISOString(),
        }]);
      }
      if (receipt.deliveryState === 'completed') {
        return jsonReply(200, [{
          claim_state: 'completed',
          receipt_id: receipt.receiptId,
          claim_token: null,
          claim_expires_at: null,
        }]);
      }
      if (receipt.leaseActive) {
        return jsonReply(200, [{
          claim_state: 'busy',
          receipt_id: receipt.receiptId,
          claim_token: null,
          claim_expires_at: new Date(Date.now() + 300000).toISOString(),
        }]);
      }
      receipt.claimToken = nextTestUuid(state);
      receipt.leaseActive = true;
      receipt.attempts++;
      return jsonReply(200, [{
        claim_state: 'claimed',
        receipt_id: receipt.receiptId,
        claim_token: receipt.claimToken,
        claim_expires_at: new Date(Date.now() + 300000).toISOString(),
      }]);
    }

    if (url.endsWith('/rest/v1/rpc/hc_finish_webhook_delivery')) {
      const key = parsedBody.p_provider + '|' + parsedBody.p_event_key;
      const receipt = state.receipts.get(key);
      const ownsLease = receipt &&
        receipt.deliveryState === 'processing' &&
        receipt.claimToken === parsedBody.p_claim_token;
      if (!ownsLease) return jsonReply(200, false);
      receipt.deliveryState = 'completed';
      receipt.leaseActive = false;
      receipt.claimToken = null;
      if (config.finishCommitThenLoseResponseOnce &&
          !state.finishResponseLost) {
        state.finishResponseLost = true;
        throw new Error('simulated lost receipt finish response after commit');
      }
      return jsonReply(200, true);
    }

    if (url.endsWith('/rest/v1/rpc/hc_renew_webhook_delivery')) {
      const key = parsedBody.p_provider + '|' + parsedBody.p_event_key;
      const receipt = state.receipts.get(key);
      const ownsLease = receipt &&
        receipt.deliveryState === 'processing' &&
        receipt.leaseActive &&
        receipt.claimToken === parsedBody.p_claim_token;
      return jsonReply(200, !!ownsLease);
    }

    if (url.endsWith('/rest/v1/rpc/hc_release_webhook_delivery')) {
      const key = parsedBody.p_provider + '|' + parsedBody.p_event_key;
      const receipt = state.receipts.get(key);
      const ownsLease = receipt &&
        receipt.deliveryState === 'processing' &&
        receipt.claimToken === parsedBody.p_claim_token;
      if (ownsLease) receipt.leaseActive = false;
      return jsonReply(200, !!ownsLease);
    }

    if (url.endsWith('/rest/v1/rpc/hc_enqueue_webhook_intake')) {
      const items = parsedBody?.p_items;
      if (!Array.isArray(items)) return jsonReply(400, { error: 'bad batch' });
      for (const item of items) {
        const key = item.provider + '|' + item.event_key;
        const existing = state.intake.get(key);
        if (existing) {
          assert.deepEqual(existing.payload, item.payload);
          continue;
        }
        state.intake.set(key, {
          intakeId: nextTestUuid(state),
          provider: item.provider,
          eventKey: item.event_key,
          payload: item.payload,
          deliveryState: 'pending',
          attemptCount: 0,
          nextAttempt: state.intakeClock,
          claimToken: null,
        });
      }
      return jsonReply(200, items.length);
    }

    if (url.endsWith('/rest/v1/rpc/hc_claim_webhook_intake')) {
      const available = [...state.intake.values()].find((item) =>
        item.deliveryState === 'pending' &&
        item.nextAttempt <= state.intakeClock,
      );
      if (!available) return jsonReply(200, []);
      available.deliveryState = 'processing';
      available.attemptCount++;
      available.claimToken = nextTestUuid(state);
      return jsonReply(200, [{
        intake_id: available.intakeId,
        provider: available.provider,
        event_key: available.eventKey,
        payload: available.payload,
        attempt_count: available.attemptCount,
        claim_token: available.claimToken,
        claim_expires_at: new Date(Date.now() + 900000).toISOString(),
      }]);
    }

    if (url.endsWith('/rest/v1/rpc/hc_finish_webhook_intake')) {
      const item = [...state.intake.values()].find((candidate) =>
        candidate.intakeId === parsedBody.p_intake_id,
      );
      const ownsLease = item && item.deliveryState === 'processing' &&
        item.claimToken === parsedBody.p_claim_token;
      if (ownsLease) {
        item.deliveryState = 'completed';
        item.claimToken = null;
      }
      return jsonReply(200, !!ownsLease);
    }

    if (url.endsWith('/rest/v1/rpc/hc_release_webhook_intake')) {
      const item = [...state.intake.values()].find((candidate) =>
        candidate.intakeId === parsedBody.p_intake_id,
      );
      const ownsLease = item && item.deliveryState === 'processing' &&
        item.claimToken === parsedBody.p_claim_token;
      if (ownsLease) {
        item.deliveryState = 'pending';
        item.claimToken = null;
        item.nextAttempt = state.intakeClock + 1;
      }
      return jsonReply(200, !!ownsLease);
    }

    if (url === 'https://api.anthropic.com/v1/messages') {
      const message = parsedBody?.messages?.[0]?.content || '';
      state.aiMessages.push(String(message));
      let configured = aiResponses.length ? aiResponses.shift() : undefined;
      if (configured === undefined && config.aiResponder) {
        configured = await config.aiResponder({
          requestBody: parsedBody,
          message: String(message),
          state,
        });
      }
      if (configured && typeof configured === 'object' &&
          Number.isInteger(configured.status)) {
        return jsonReply(configured.status, configured.body || { error: 'simulated' });
      }
      const text = typeof configured === 'string' ? configured : '{}';
      return jsonReply(200, { content: [{ type: 'text', text }] });
    }

    if (url.includes('/rest/v1/orders?on_conflict=id')) {
      const order = parsedBody;
      state.orderAttempts.push(order);
      if (!order || !order.id) return jsonReply(400, { error: 'missing id' });
      if (!state.orders.has(order.id)) state.orders.set(order.id, order);
      if (config.orderCommitThenLoseResponseOnce &&
          !state.orderResponseLost) {
        state.orderResponseLost = true;
        throw new Error('simulated lost order insert response after commit');
      }
      return new Response(null, { status: 201 });
    }

    if (url === 'https://sandbox.supabase.test/rest/v1/push_queue' &&
        String(fetchOptions.method || 'GET').toUpperCase() === 'POST') {
      const row = parsedBody;
      state.pushAttempts.push(row);
      if (!row || !row.id) return jsonReply(400, { error: 'missing id' });
      const failAfterStoredRows = Number(
        config.pushFailuresAfterStoredRows || 0,
      );
      if (state.pushPostFailuresRemaining > 0 &&
          state.pushQueue.size >= failAfterStoredRows) {
        state.pushPostFailuresRemaining--;
        return jsonReply(503, { error: 'simulated queue refusal' });
      }
      if (!state.pushQueue.has(row.id)) state.pushQueue.set(row.id, row);
      if (config.pushCommitThenLoseResponseOnce &&
          !state.pushResponseLost) {
        state.pushResponseLost = true;
        throw new Error('simulated lost push queue response after commit');
      }
      return new Response(null, { status: 201 });
    }

    if (url.startsWith(
      'https://sandbox.supabase.test/rest/v1/push_queue?',
    )) {
      const parsedUrl = new URL(url);
      const requested = String(parsedUrl.searchParams.get('id') || '')
        .replace(/^eq\./, '');
      const row = state.pushQueue.get(requested);
      return jsonReply(200, row ? [{ id: row.id, kind: row.kind }] : []);
    }

    if (url.startsWith('https://api.telegram.org/')) {
      const chatId = String(parsedBody?.chat_id || '');
      state.telegramAttempts.set(
        chatId,
        (state.telegramAttempts.get(chatId) || 0) + 1,
      );
      if (config.telegramFailChatOnce === chatId &&
          !state.telegramFailureUsed) {
        state.telegramFailureUsed = true;
        return jsonReply(503, { ok: false });
      }
      state.telegramAccepted.set(
        chatId,
        (state.telegramAccepted.get(chatId) || 0) + 1,
      );
      return jsonReply(200, { ok: true });
    }

    throw new Error('unexpected offline fetch: ' + url);
  };
  return {
    calls,
    state,
    restore() { globalThis.fetch = originalFetch; },
  };
}

function assertRejectedBeforeDownstream(response, harness, status = 401) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(harness.calls.length, 0);
}

await check('Formspree fails closed when its signing secret is missing', async () => {
  const harness = installFetchHarness();
  try {
    const env = { ...baseEnv };
    delete env.FORMSPREE_WEBHOOK_SIGNING_SECRET;
    const response = await worker.fetch(
      request('/webhooks/formspree', '{}'),
      env,
    );
    assertRejectedBeforeDownstream(response, harness, 503);
  } finally { harness.restore(); }
});

await check('Formspree rejects a missing or malformed signature before downstream calls', async () => {
  const harness = installFetchHarness();
  try {
    const missing = await worker.fetch(
      request('/webhooks/formspree', '{}'),
      baseEnv,
    );
    assertRejectedBeforeDownstream(missing, harness);

    const malformed = await worker.fetch(
      request('/webhooks/formspree', '{}', {
        'Formspree-Signature': 't=not-a-time,v1=not-a-digest',
      }),
      baseEnv,
    );
    assertRejectedBeforeDownstream(malformed, harness);
  } finally { harness.restore(); }
});

await check('Formspree rejects an expired correctly signed request', async () => {
  const harness = installFetchHarness();
  try {
    const rawBody = '{"name":"Old lead"}';
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Formspree rejects a wrong signature before downstream calls', async () => {
  const harness = installFetchHarness();
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', '{"name":"Forged"}', {
        'Formspree-Signature': 't=' + timestamp + ',v1=' + '00'.repeat(32),
      }),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Formspree accepts a correct timestamped signature over exact raw JSON', async () => {
  const harness = installFetchHarness();
  try {
    const rawBody = '{\n  "name": "Real lead",\n  "email": "lead@example.com"\n}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      baseEnv,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(harness.calls[0].url.endsWith(
      '/rest/v1/rpc/hc_claim_webhook_delivery',
    ));
    assert.equal(harness.state.receipts.size, 1);
    assert.equal([...harness.state.receipts.values()][0].deliveryState, 'completed');
    assert.equal(harness.state.orders.size, 1);
    assert.ok(harness.calls.some((call) => call.url.includes('/rest/v1/orders')));
  } finally { harness.restore(); }
});

await check('Quo fails closed when its base64 signing key is missing', async () => {
  const harness = installFetchHarness();
  try {
    const env = { ...baseEnv };
    delete env.QUO_WEBHOOK_SIGNING_KEY;
    const response = await worker.fetch(request('/webhooks/quo', '{}'), env);
    assertRejectedBeforeDownstream(response, harness, 503);
  } finally { harness.restore(); }
});

await check('Quo rejects a missing or malformed signature before downstream calls', async () => {
  const harness = installFetchHarness();
  try {
    const missing = await worker.fetch(request('/webhooks/quo', '{}'), baseEnv);
    assertRejectedBeforeDownstream(missing, harness);

    const malformed = await worker.fetch(
      request('/webhooks/quo', '{}', {
        'openphone-signature': 'sha256;2;not-a-time;not-base64',
      }),
      baseEnv,
    );
    assertRejectedBeforeDownstream(malformed, harness);
  } finally { harness.restore(); }
});

await check('Quo rejects an expired correctly signed request', async () => {
  const harness = installFetchHarness();
  try {
    const body = { id: 'old-event', type: 'message.received' };
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const response = await worker.fetch(
      request('/webhooks/quo', JSON.stringify(body), {
        'openphone-signature': await quoSignature(body, timestamp),
      }),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Quo rejects a wrong signature before downstream calls', async () => {
  const harness = installFetchHarness();
  try {
    const timestamp = String(Date.now());
    const wrongDigest = bytesToBase64(new Uint8Array(32));
    const response = await worker.fetch(
      request('/webhooks/quo', '{"id":"forged"}', {
        'openphone-signature': 'hmac;1;' + timestamp + ';' + wrongDigest,
      }),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Quo accepts its correct canonical JSON signature', async () => {
  const harness = installFetchHarness();
  try {
    const body = { id: 'real-event', type: 'message.received', data: { body: 'Hello there' } };
    const rawBody = JSON.stringify(body, null, 2);
    const timestamp = String(Date.now());
    const response = await worker.fetch(
      request('/webhooks/quo', rawBody, {
        'openphone-signature': await quoSignature(body, timestamp),
      }),
      baseEnv,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(harness.state.receipts.size, 1);
    assert.equal(harness.state.aiMessages.length, 1);
    assert.equal([...harness.state.receipts.values()][0].deliveryState, 'completed');
  } finally { harness.restore(); }
});

await check('Microsoft Graph echoes validationToken for GET and POST with exact text', async () => {
  for (const method of ['GET', 'POST']) {
    const token = 'opaque token + slash/value';
    const path = '/webhooks/ms-graph?validationToken=' + encodeURIComponent(token);
    const response = await worker.fetch(request(path, '', {}, method), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/plain');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), token);
  }
});

await check('Microsoft Graph fails closed when clientState configuration is missing', async () => {
  const harness = installFetchHarness();
  try {
    const env = { ...baseEnv };
    delete env.MS_GRAPH_CLIENT_STATE;
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({ value: [] })),
      env,
    );
    assertRejectedBeforeDownstream(response, harness, 503);
  } finally { harness.restore(); }
});

await check('Microsoft Graph rejects missing clientState before downstream calls', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({
        value: [{ subscriptionId: 'subscription-one', tenantId: 'tenant-one' }],
      })),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Microsoft Graph rejects a batch if any clientState is wrong', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({
        value: [
          {
            clientState: GRAPH_CLIENT_STATE,
            subscriptionId: 'subscription-one',
            tenantId: 'tenant-one',
          },
          {
            clientState: 'wrong-client-state',
            subscriptionId: 'subscription-two',
            tenantId: 'tenant-two',
          },
        ],
      })),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Microsoft Graph enforces optional subscription and tenant allowlists', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({
        value: [{
          clientState: GRAPH_CLIENT_STATE,
          subscriptionId: 'unapproved-subscription',
          tenantId: 'tenant-one',
        }],
      })),
      baseEnv,
    );
    assertRejectedBeforeDownstream(response, harness);
  } finally { harness.restore(); }
});

await check('Microsoft Graph accepts every valid clientState and allowlisted identifier', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({
        value: [
          {
            clientState: GRAPH_CLIENT_STATE,
            subscriptionId: 'SUBSCRIPTION-ONE',
            tenantId: 'TENANT-ONE',
            resourceData: { id: 'message-one' },
          },
          {
            clientState: GRAPH_CLIENT_STATE,
            subscriptionId: 'subscription-two',
            tenantId: 'tenant-two',
            resourceData: { id: 'message-two' },
          },
        ],
      })),
      baseEnv,
    );
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(harness.state.intake.size, 2);
    assert.equal(harness.state.receipts.size, 0);
    assert.equal(harness.state.aiMessages.length, 0);
    for (const item of harness.state.intake.values()) {
      assert.equal(item.payload.clientState, undefined);
      assert.equal(item.payload.validationTokens, undefined);
    }

    const drained = await runWebhookIntakeScan(baseEnv);
    assert.deepEqual(drained, { claimed: 2, completed: 2, released: 0 });
    assert.equal(harness.state.receipts.size, 2);
    assert.equal(harness.state.aiMessages.length, 2);
    assert.ok([...harness.state.receipts.values()].every(
      (receipt) => receipt.deliveryState === 'completed',
    ));
  } finally { harness.restore(); }
});

await check('completed provider receipts skip every downstream side effect on retry', async () => {
  const harness = installFetchHarness();
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-duplicate-event',
      name: 'Stable lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
    };
    const first = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      baseEnv,
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(harness.state.receipts.size, 1);
    assert.equal(harness.state.aiMessages.length, 1);
    assert.equal(harness.state.orderAttempts.length, 1);
    assert.equal(harness.state.orders.size, 1);
  } finally { harness.restore(); }
});

await check('retry after an order insert response is lost keeps one stable order', async () => {
  const harness = installFetchHarness({
    orderCommitThenLoseResponseOnce: true,
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-order-crash-event',
      name: 'Crash-safe lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
    };
    const first = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      baseEnv,
    );
    assert.equal(first.status, 503);
    assert.equal(second.status, 200);
    assert.equal(harness.state.orders.size, 1);
    assert.equal(harness.state.orderAttempts.length, 2);
    assert.equal(
      harness.state.orderAttempts[0].id,
      harness.state.orderAttempts[1].id,
    );
    assert.equal([...harness.state.receipts.values()][0].attempts, 2);
  } finally { harness.restore(); }
});

await check('retry after a lost receipt finish response skips completed work', async () => {
  const harness = installFetchHarness({
    finishCommitThenLoseResponseOnce: true,
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-finish-crash-event',
      name: 'Finish-safe lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
    };
    const first = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      baseEnv,
    );
    assert.equal(first.status, 503);
    assert.equal(second.status, 200);
    assert.equal(harness.state.aiMessages.length, 1);
    assert.equal(harness.state.orderAttempts.length, 1);
    assert.equal([...harness.state.receipts.values()][0].deliveryState, 'completed');
  } finally { harness.restore(); }
});

await check('transient AI failure is non-2xx and the released receipt retries', async () => {
  const harness = installFetchHarness({
    aiResponses: [
      { status: 503, body: { error: 'offline' } },
      '{}',
    ],
  });
  try {
    const body = { id: 'quo-transient-ai-event', type: 'message.received' };
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const headers = {
      'openphone-signature': await quoSignature(body, timestamp),
    };
    const first = await worker.fetch(
      request('/webhooks/quo', rawBody, headers),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/quo', rawBody, headers),
      baseEnv,
    );
    assert.equal(first.status, 503);
    assert.equal(second.status, 200);
    const receipt = [...harness.state.receipts.values()][0];
    assert.equal(receipt.attempts, 2);
    assert.equal(receipt.deliveryState, 'completed');
    assert.equal(harness.state.aiMessages.length, 2);
  } finally { harness.restore(); }
});

await check('Graph partial batch retry skips its completed first notification', async () => {
  const itemAttempts = new Map();
  const harness = installFetchHarness({
    aiResponder: ({ message }) => {
      const item = message.includes('graph-item-two') ? 'two' : 'one';
      const attempt = (itemAttempts.get(item) || 0) + 1;
      itemAttempts.set(item, attempt);
      if (item === 'two' && attempt === 1) {
        return { status: 503, body: { error: 'offline' } };
      }
      return '{}';
    },
  });
  try {
    const rawBody = JSON.stringify({ value: [
      {
        id: 'graph-item-one',
        clientState: GRAPH_CLIENT_STATE,
        subscriptionId: 'subscription-one',
        tenantId: 'tenant-one',
        resourceData: { id: 'message-one' },
      },
      {
        id: 'graph-item-two',
        clientState: GRAPH_CLIENT_STATE,
        subscriptionId: 'subscription-two',
        tenantId: 'tenant-two',
        resourceData: { id: 'message-two' },
      },
    ] });
    const first = await worker.fetch(
      request('/webhooks/ms-graph', rawBody),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/ms-graph', rawBody),
      baseEnv,
    );
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(harness.state.intake.size, 2);

    const firstDrain = await runWebhookIntakeScan(baseEnv);
    assert.deepEqual(firstDrain, { claimed: 2, completed: 1, released: 1 });
    assert.equal(itemAttempts.get('one'), 1);
    assert.equal(itemAttempts.get('two'), 1);

    harness.state.intakeClock++;
    const retryDrain = await runWebhookIntakeScan(baseEnv);
    assert.deepEqual(retryDrain, { claimed: 1, completed: 1, released: 0 });
    assert.equal(itemAttempts.get('one'), 1);
    assert.equal(itemAttempts.get('two'), 2);
    assert.equal(harness.state.receipts.size, 2);
    assert.ok([...harness.state.receipts.values()].every(
      (receipt) => receipt.deliveryState === 'completed',
    ));
  } finally { harness.restore(); }
});

await check('webhook alerts enqueue one encrypted stable row per chat without inline Telegram', async () => {
  const harness = installFetchHarness({
    aiResponses: [JSON.stringify({
      client_name: 'Private Lead Name',
      client_email: 'private-lead@example.com',
      summary: 'Private alert summary',
    })],
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-encrypted-outbox-event',
      name: 'Private Lead Name',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      {
        ...baseEnv,
        ALLOWED_CHAT_IDS: 'private-chat-a,private-chat-b,private-chat-a',
      },
    );
    assert.equal(response.status, 200);
    assert.equal(harness.state.pushQueue.size, 2);
    assert.equal(harness.state.telegramAttempts.size, 0);
    for (const [queueId, row] of harness.state.pushQueue) {
      assert.match(queueId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(row.payload.tokens, []);
      assert.equal(row.outbox_type, 'webhook_telegram');
      assert.equal(row.payload.telegram_text, undefined);
      assert.equal(row.payload.fallback_chat_ids, undefined);
      assert.equal(row.payload.telegram_outbox.version, 2);
      assert.equal(row.payload.telegram_outbox.key_version, 'test-current');
      const stored = JSON.stringify(row);
      assert.ok(!stored.includes('private-chat-a'));
      assert.ok(!stored.includes('private-chat-b'));
      assert.ok(!stored.includes('Private Lead Name'));
      assert.ok(!stored.includes('private-lead@example.com'));
      assert.ok(!stored.includes('Private alert summary'));
    }
  } finally { harness.restore(); }
});

await check('partial multi-chat enqueue retries with stable IDs before provider acknowledgment', async () => {
  const harness = installFetchHarness({
    pushPostFailures: 2,
    pushFailuresAfterStoredRows: 1,
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-partial-outbox-event',
      name: 'Queue retry lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
    };
    const env = {
      ...baseEnv,
      ALLOWED_CHAT_IDS: 'partial-chat-a,partial-chat-b',
    };
    const first = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      env,
    );
    assert.equal(first.status, 503);
    assert.equal(harness.state.pushQueue.size, 1);
    const firstQueueId = [...harness.state.pushQueue.keys()][0];

    const second = await worker.fetch(
      request('/webhooks/formspree', rawBody, headers),
      {
        ...env,
        WEBHOOK_OUTBOX_ENCRYPTION_KEY_CURRENT:
          'test-rotated:' + OUTBOX_ENCRYPTION_KEY_ROTATED,
      },
    );
    assert.equal(second.status, 200);
    assert.equal(harness.state.pushQueue.size, 2);
    assert.ok(harness.state.pushQueue.has(firstQueueId));
    assert.equal(harness.state.orders.size, 1);
    assert.equal(harness.state.telegramAttempts.size, 0);
    assert.equal([...harness.state.receipts.values()][0].attempts, 2);
    assert.deepEqual(
      new Set([...harness.state.pushQueue.values()].map(
        (row) => row.payload.telegram_outbox.key_version,
      )),
      new Set(['test-current', 'test-rotated']),
    );
  } finally { harness.restore(); }
});

await check('lost outbox insert response is verified durably before provider 200', async () => {
  const harness = installFetchHarness({
    pushCommitThenLoseResponseOnce: true,
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-lost-outbox-response',
      name: 'Lookup-safe lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      { ...baseEnv, ALLOWED_CHAT_IDS: 'lookup-safe-chat' },
    );
    assert.equal(response.status, 200);
    assert.equal(harness.state.pushQueue.size, 1);
    assert.equal(harness.state.pushAttempts.length, 1);
    assert.ok(harness.calls.some((call) =>
      call.url.includes('/rest/v1/push_queue?id=eq.'),
    ));
  } finally { harness.restore(); }
});

await check('Telegram root webhook fails closed before parsing and setup rejects URL secrets', async () => {
  const harness = installFetchHarness();
  try {
    const missingEnv = { ...baseEnv };
    delete missingEnv.TG_WEBHOOK_SECRET;
    const missing = await worker.fetch(
      request('/', '{not valid json'),
      missingEnv,
    );
    assert.equal(missing.status, 503);
    assert.equal(missing.headers.get('Cache-Control'), 'no-store');

    const wrong = await worker.fetch(
      request('/', '{not valid json', {
        'X-Telegram-Bot-Api-Secret-Token': 'wrong',
      }),
      baseEnv,
    );
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('Cache-Control'), 'no-store');

    const querySecret = await worker.fetch(
      request(
        '/setup-telegram-webhook?secret=' +
          encodeURIComponent(baseEnv.TG_WEBHOOK_SECRET),
        '{}',
      ),
      baseEnv,
    );
    assert.equal(querySecret.status, 401);
    assert.equal(harness.calls.length, 0);
    const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /OPTIONAL webhook hardening/i);
    assert.doesNotMatch(source, /\?secret=<TG_WEBHOOK_SECRET>/i);
    assert.match(source, /authorization is accepted only in X-Setup-Secret/i);
  } finally { harness.restore(); }
});

await check('canonical nested Formspree retries survive whitespace and key reordering', async () => {
  const harness = installFetchHarness();
  try {
    const firstBody = JSON.stringify({
      form: 'contact-form-id',
      keys: ['name', 'email', 'message'],
      submission: {
        _date: '2026-08-27T12:00:00Z',
        name: 'Nested Lead',
        email: 'nested@example.com',
        message: 'Need 100 coconuts',
      },
    });
    const secondBody = `{
      "submission": {
        "message": "Need 100 coconuts",
        "email": "nested@example.com",
        "name": "Nested Lead",
        "_date": "2026-08-27T12:00:00Z"
      },
      "keys": ["message", "email", "name"],
      "form": "contact-form-id"
    }`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const first = await worker.fetch(
      request('/webhooks/formspree', firstBody, {
        'Formspree-Signature': await formspreeSignature(firstBody, timestamp),
      }),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/formspree', secondBody, {
        'Formspree-Signature': await formspreeSignature(secondBody, timestamp),
      }),
      baseEnv,
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(harness.state.receipts.size, 1);
    assert.equal(harness.state.aiMessages.length, 1);
    assert.equal(harness.state.orders.size, 1);
    assert.equal([...harness.state.orders.values()][0].client_name, 'Nested Lead');
  } finally { harness.restore(); }
});

await check('Graph returns 202 after durable enqueue without waiting for slow AI', async () => {
  let aiCalled = false;
  const harness = installFetchHarness({
    aiResponder: async () => {
      aiCalled = true;
      await new Promise(() => {});
    },
  });
  try {
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({ value: [{
        clientState: GRAPH_CLIENT_STATE,
        subscriptionId: 'subscription-one',
        tenantId: 'tenant-one',
        resourceData: { id: 'slow-message' },
      }] })),
      baseEnv,
    );
    assert.equal(response.status, 202);
    assert.equal(harness.state.intake.size, 1);
    assert.equal(aiCalled, false);
    assert.equal(harness.state.aiMessages.length, 0);
    assert.ok(harness.calls.every((call) =>
      call.url !== 'https://api.anthropic.com/v1/messages',
    ));
  } finally { harness.restore(); }
});

await check('Graph reordered and rebatched retries keep one intake item per notification', async () => {
  const harness = installFetchHarness();
  try {
    const itemA = {
      clientState: GRAPH_CLIENT_STATE,
      subscriptionId: 'subscription-one',
      tenantId: 'tenant-one',
      changeType: 'created',
      resourceData: { id: 'stable-resource-a' },
    };
    const itemB = {
      clientState: GRAPH_CLIENT_STATE,
      subscriptionId: 'subscription-two',
      tenantId: 'tenant-two',
      changeType: 'updated',
      resourceData: { id: 'stable-resource-b' },
    };
    const first = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({ value: [itemA, itemB] })),
      baseEnv,
    );
    const second = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({ value: [itemB, itemA] }, null, 2)),
      baseEnv,
    );
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(harness.state.intake.size, 2);
  } finally { harness.restore(); }
});

await check('Graph namespaces reused resource IDs across distinct notifications', async () => {
  const harness = installFetchHarness();
  try {
    const shared = {
      clientState: GRAPH_CLIENT_STATE,
      tenantId: 'tenant-one',
      resourceData: { id: 'shared-resource-id' },
    };
    const notifications = [
      {
        ...shared,
        subscriptionId: 'subscription-one',
        changeType: 'created',
        resource: 'users/mailbox-a/messages/shared-resource-id',
      },
      {
        ...shared,
        subscriptionId: 'subscription-two',
        changeType: 'created',
        resource: 'users/mailbox-a/messages/shared-resource-id',
      },
      {
        ...shared,
        subscriptionId: 'subscription-one',
        changeType: 'updated',
        resource: 'users/mailbox-a/messages/shared-resource-id',
      },
      {
        ...shared,
        subscriptionId: 'subscription-one',
        changeType: 'created',
        resource: 'users/mailbox-b/messages/shared-resource-id',
      },
    ];
    const response = await worker.fetch(
      request('/webhooks/ms-graph', JSON.stringify({ value: notifications })),
      baseEnv,
    );
    assert.equal(response.status, 202);
    assert.equal(harness.state.intake.size, notifications.length);
  } finally { harness.restore(); }
});

await check('provider Telegram alert is bounded plain text with literal Markdown characters', async () => {
  const literalMarkdown = '*_[link](https://example.test) `code` # heading ';
  const harness = installFetchHarness({
    aiResponses: [JSON.stringify({
      client_name: 'Plain Text Lead',
      summary: literalMarkdown + 'x'.repeat(5000),
    })],
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-plain-text-cap',
      name: 'Plain Text Lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      { ...baseEnv, ALLOWED_CHAT_IDS: 'plain-text-chat' },
    );
    assert.equal(response.status, 200);
    const row = [...harness.state.pushQueue.values()][0];
    const decoded = await decryptTestOutbox(row, OUTBOX_ENCRYPTION_KEY);
    assert.deepEqual(Object.keys(decoded).sort(), ['chat_id', 'text']);
    assert.equal(decoded.chat_id, 'plain-text-chat');
    assert.ok(decoded.text.includes(literalMarkdown));
    assert.equal([...decoded.text].length, 4096);
  } finally { harness.restore(); }
});

await check('4096 multi-byte characters fit the encrypted outbox contract', async () => {
  const harness = installFetchHarness({
    aiResponses: [JSON.stringify({
      client_name: 'Unicode Lead',
      summary: '😀'.repeat(5000),
    })],
  });
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-unicode-text-cap',
      name: 'Unicode Lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      { ...baseEnv, ALLOWED_CHAT_IDS: 'unicode-chat' },
    );
    assert.equal(response.status, 200);
    const row = [...harness.state.pushQueue.values()][0];
    const decoded = await decryptTestOutbox(row, OUTBOX_ENCRYPTION_KEY);
    const ciphertext = row.payload.telegram_outbox.ciphertext;
    assert.equal([...decoded.text].length, 4096);
    assert.ok(ciphertext.length > 8192);
    assert.ok(ciphertext.length <= 32768);
  } finally { harness.restore(); }
});

await check('overlong Telegram destinations fail before encrypted enqueue', async () => {
  const harness = installFetchHarness();
  try {
    const rawBody = JSON.stringify({
      id: 'formspree-overlong-chat-id',
      name: 'Destination Guard Lead',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      { ...baseEnv, ALLOWED_CHAT_IDS: 'x'.repeat(129) },
    );
    assert.equal(response.status, 503);
    assert.equal(harness.state.pushQueue.size, 0);
  } finally { harness.restore(); }
});

await check('webhook timeouts and exact lease renewal precede durable side effects', async () => {
  const harness = installFetchHarness();
  try {
    const rawBody = JSON.stringify({ id: 'lease-order-event', name: 'Lease Lead' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await worker.fetch(
      request('/webhooks/formspree', rawBody, {
        'Formspree-Signature': await formspreeSignature(rawBody, timestamp),
      }),
      baseEnv,
    );
    assert.equal(response.status, 200);
    const renewIndex = harness.calls.findIndex((call) =>
      call.url.endsWith('/rest/v1/rpc/hc_renew_webhook_delivery'),
    );
    const orderIndex = harness.calls.findIndex((call) =>
      call.url.includes('/rest/v1/orders?on_conflict=id'),
    );
    assert.ok(renewIndex >= 0 && renewIndex < orderIndex);
    const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /webhookFetch\(CLAUDE_API,[\s\S]*?60000\)/);
  } finally { harness.restore(); }
});

await check('migration 027 is private, bounded, service-only, and reversible only by coordination', async () => {
  const migration = readFileSync(
    new URL('../migrations/027_webhook_async_intake_outbox.sql', import.meta.url),
    'utf8',
  );
  const rollback = readFileSync(
    new URL('../migrations/027_webhook_async_intake_outbox_rollback.sql', import.meta.url),
    'utf8',
  );
  const rehearsal = readFileSync(
    new URL('../rehearsal/008_webhook_async_intake_runtime_checks.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /requires migrations 011 and 024/i);
  assert.match(migration, /safe rollout order:[\s\S]*024 and 027[\s\S]*pushdrain[\s\S]*Worker/i);
  assert.match(migration, /create table if not exists public\.webhook_intake_queue/i);
  assert.match(migration, /alter table public\.webhook_intake_queue enable row level security/i);
  assert.match(migration, /revoke all on table public\.webhook_intake_queue[\s\S]*service_role/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.push_queue to service_role/i);
  assert.match(migration, /hc_enqueue_webhook_intake/);
  assert.match(migration, /hc_claim_webhook_intake/);
  assert.match(migration, /hc_finish_webhook_intake/);
  assert.match(migration, /hc_release_webhook_intake/);
  assert.match(migration, /hc_renew_webhook_delivery/);
  assert.match(migration, /262144/);
  assert.match(migration, /65536/);
  assert.match(migration, /v_item_count > 100/);
  assert.match(migration, /next_attempt_at/);
  assert.match(migration, /dead_lettered_at/);
  assert.match(migration, /between 24 and 32768/);
  assert.match(migration, /not \(payload \? 'clientState'\)/);
  assert.doesNotMatch(migration, /pg_catalog\.coalesce/i);
  assert.match(rollback, /raise exception/i);
  assert.match(rollback, /coordinated/i);
  assert.match(rehearsal, /^begin;/im);
  assert.match(rehearsal, /^rollback;/im);
  assert.match(rehearsal, /authenticated caller reached service-only/i);
  assert.match(rehearsal, /lease/i);
  assert.match(rehearsal, /repeat\('A', 21912\)/);
  assert.match(rehearsal, /repeat\('A', 32769\)/);
});

await check('receipt migration is private, service-only, and stores no webhook payload', async () => {
  const migration = readFileSync(
    new URL('../migrations/024_webhook_delivery_receipts.sql', import.meta.url),
    'utf8',
  );
  const tableDefinition = migration.match(
    /create table if not exists public\.webhook_delivery_receipts \(([\s\S]*?)\n\);/i,
  )?.[1] || '';
  assert.match(migration, /alter table public\.webhook_delivery_receipts enable row level security/i);
  assert.match(migration, /revoke all on table public\.webhook_delivery_receipts[\s\S]*service_role/i);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(migration, /auth\.role\(\)[\s\S]*service_role/i);
  assert.doesNotMatch(
    tableDefinition,
    /raw|body|payload|secret|provider_event_id/i,
  );
});

await check('all provider webhook bodies are capped before parsing or downstream calls', async () => {
  const oversized = JSON.stringify({ value: 'x'.repeat(256 * 1024) });
  for (const path of [
    '/webhooks/formspree',
    '/webhooks/quo',
    '/webhooks/ms-graph',
  ]) {
    const harness = installFetchHarness();
    try {
      const response = await worker.fetch(request(path, oversized), baseEnv);
      assertRejectedBeforeDownstream(response, harness, 413);
    } finally { harness.restore(); }
  }
});

await check('stale GPS alerts describe report freshness without claiming movement', async () => {
  const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(source, /GPS has not reported for/);
  assert.match(source, /GPS stale ['"]? \+ mins/);
  assert.match(source, /No fresh GPS report while en route/);
  assert.doesNotMatch(source, /has not moved for/);
  assert.doesNotMatch(source, /Not moving while enroute/);
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);
