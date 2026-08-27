// Offline security tests for the dashboard's paid AI proxy routes.
// No request leaves this process and no real key or account is used.

import assert from 'node:assert/strict';
import worker, { resetDashboardAiRateLimitsForTests } from './worker.js';

const DASHBOARD_ORIGIN = 'https://siddsaxena-master.github.io';
const WORKER_URL = 'https://worker.example.test';
const env = {
  SUPABASE_URL: 'https://sandbox.supabase.test',
  SUPABASE_SERVICE_KEY: 'sandbox-service-key',
  ANTHROPIC_API_KEY: 'sandbox-anthropic-key',
};

let failed = 0;
let total = 0;

async function check(name, fn) {
  total++;
  resetDashboardAiRateLimitsForTests();
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

function installFetchHarness() {
  const calls = { auth: [], ai: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    if (url.endsWith('/rest/v1/rpc/hc_claim_field_worker')) {
      calls.auth.push({ url, options });
      const token = String(options.headers.Authorization || '').replace(/^Bearer /, '');
      if (token === 'expired-token') return jsonReply(401, { message: 'expired' });
      if (token === 'team-token') {
        return jsonReply(200, [{ email: 'team@example.com', role: 'team' }]);
      }
      const ownerEmail = token === 'rate-token'
        ? 'rate-owner@example.com'
        : token.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '@example.com';
      return jsonReply(200, [{ email: ownerEmail, role: 'owner' }]);
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      calls.ai.push({ url, options, body: JSON.parse(options.body) });
      return jsonReply(200, { content: [{ type: 'text', text: 'safe result' }] });
    }
    throw new Error('unexpected offline fetch: ' + url);
  };
  return {
    calls,
    restore() { globalThis.fetch = originalFetch; },
  };
}

function post(path, token, body, headers = {}) {
  return new Request(WORKER_URL + path, {
    method: 'POST',
    headers: {
      'Origin': DASHBOARD_ORIGIN,
      'Authorization': token ? 'Bearer ' + token : '',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBatch = {
  systemPrompt: 'Return plain text.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  maxTokens: 9000,
};

await check('preflight permits only the exact dashboard origin and auth header', async () => {
  const response = await worker.fetch(new Request(WORKER_URL + '/parse-batch', {
    method: 'OPTIONS',
    headers: {
      'Origin': DASHBOARD_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), DASHBOARD_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
});

await check('wrong-origin preflight and non-POST calls are rejected', async () => {
  const preflight = await worker.fetch(new Request(WORKER_URL + '/parse-file', {
    method: 'OPTIONS',
    headers: { 'Origin': 'https://evil.example' },
  }), env);
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);

  const getResponse = await worker.fetch(new Request(WORKER_URL + '/parse-file', {
    method: 'GET',
    headers: { 'Origin': DASHBOARD_ORIGIN },
  }), env);
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get('Allow'), 'POST, OPTIONS');
});

await check('wrong origin is blocked before authentication or AI', async () => {
  const harness = installFetchHarness();
  try {
    const request = post('/parse-batch', 'owner-token', validBatch);
    request.headers.set('Origin', 'https://evil.example');
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(harness.calls.auth.length, 0);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('missing bearer token is blocked before Supabase and AI', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(post('/parse-batch', '', validBatch), env);
    assert.equal(response.status, 401);
    assert.equal(harness.calls.auth.length, 0);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('expired session is blocked and never reaches AI', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(post('/parse-batch', 'expired-token', validBatch), env);
    assert.equal(response.status, 401);
    assert.equal(harness.calls.auth.length, 1);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('non-owner session is blocked and never reaches AI', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(post('/parse-batch', 'team-token', validBatch), env);
    assert.equal(response.status, 403);
    assert.equal(harness.calls.auth.length, 1);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('confirmed owner reaches AI with a 1600-token cap and safe CORS', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(post('/parse-batch', 'owner-token', validBatch), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), DASHBOARD_ORIGIN);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(await response.json(), { text: 'safe result' });
    assert.equal(harness.calls.auth.length, 1);
    assert.equal(harness.calls.auth[0].options.headers.apikey, env.SUPABASE_SERVICE_KEY);
    assert.equal(harness.calls.auth[0].options.headers.Authorization, 'Bearer owner-token');
    assert.equal(harness.calls.ai.length, 1);
    assert.equal(harness.calls.ai[0].body.max_tokens, 1600);
  } finally { harness.restore(); }
});

await check('oversized declared body is rejected before AI', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(post('/parse-batch', 'large-owner', validBatch, {
      'Content-Length': String(8 * 1024 * 1024 + 1),
    }), env);
    assert.equal(response.status, 413);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('prompt and message limits reject oversized batch input', async () => {
  const harness = installFetchHarness();
  try {
    const promptResponse = await worker.fetch(post('/parse-batch', 'prompt-owner', {
      systemPrompt: 'x'.repeat(20001),
      messages: validBatch.messages,
    }), env);
    assert.equal(promptResponse.status, 400);

    const tooManyMessages = Array.from({ length: 21 }, () => ({
      role: 'user', content: 'hello',
    }));
    const messageResponse = await worker.fetch(post('/parse-batch', 'message-owner', {
      systemPrompt: 'valid',
      messages: tooManyMessages,
    }), env);
    assert.equal(messageResponse.status, 400);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('file route accepts safe PDF blocks and strips extra fields', async () => {
  const harness = installFetchHarness();
  try {
    const response = await worker.fetch(post('/parse-file', 'file-owner', {
      systemPrompt: 'Read this invoice.',
      maxTokens: 500,
      contentBlocks: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'QUJDRA==',
            unexpected: 'remove me',
          },
          unexpected: 'remove me too',
        },
        { type: 'text', text: 'Extract fields.' },
      ],
    }), env);
    assert.equal(response.status, 200);
    assert.equal(harness.calls.ai.length, 1);
    assert.deepEqual(harness.calls.ai[0].body.messages[0].content, [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'QUJDRA==' },
      },
      { type: 'text', text: 'Extract fields.' },
    ]);
  } finally { harness.restore(); }
});

await check('file route rejects too many or unsupported content blocks', async () => {
  const harness = installFetchHarness();
  try {
    const countResponse = await worker.fetch(post('/parse-file', 'block-owner', {
      systemPrompt: '',
      contentBlocks: Array.from({ length: 13 }, () => ({ type: 'text', text: 'x' })),
    }), env);
    assert.equal(countResponse.status, 400);

    const mediaResponse = await worker.fetch(post('/parse-file', 'media-owner', {
      systemPrompt: '',
      contentBlocks: [{
        type: 'document',
        source: { type: 'base64', media_type: 'text/html', data: 'QUJDRA==' },
      }],
    }), env);
    assert.equal(mediaResponse.status, 400);
    assert.equal(harness.calls.ai.length, 0);
  } finally { harness.restore(); }
});

await check('per-owner rate limit stops the twenty-first AI request', async () => {
  const harness = installFetchHarness();
  try {
    for (let i = 0; i < 20; i++) {
      const allowed = await worker.fetch(post('/parse-batch', 'rate-token', validBatch), env);
      assert.equal(allowed.status, 200);
    }
    const blocked = await worker.fetch(post('/parse-batch', 'rate-token', validBatch), env);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('Retry-After')) >= 1);
    assert.equal(harness.calls.auth.length, 21);
    assert.equal(harness.calls.ai.length, 20);
  } finally { harness.restore(); }
});

console.log('');
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);
