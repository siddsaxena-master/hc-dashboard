// Tests for POST /team/invite in worker.js: the owner adds a new hire from
// the HC Field Team screen (build 34). Everything runs against a fake
// network in the style of test-departure-scan.mjs. Nothing here can reach
// Supabase, Apple or a phone, and no real key or token is used.
//
// Run it with:  node worker/test-team-invite.mjs

import assert from 'node:assert/strict';
import worker, { validateTeamInvite, inviteToTestFlight, appStoreConnectJwt } from './worker.js';

let passed = 0;
const pass = (m) => { passed++; console.log('PASS: ' + m); };
const SB = 'https://example.invalid';
const WORKER_URL = 'https://worker.example.test';
const SERVICE_KEY = 'service-key-that-must-never-appear-in-a-reply';
const ASC_KEY_ID = 'ASCKEY1234';
const ASC_ISSUER_ID = '69a6de70-0000-47e3-e053-5b8c7c11a4d1';
const ASC_GROUP_DEFAULT = '4976ebfe-29f5-47b9-92e7-a314bbb271a1';
const T = (iso) => Date.parse(iso);

// A throwaway P-256 key so the App Store Connect token path signs for real.
async function fakeAppleKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return '-----BEGIN PRIVATE KEY-----\n' + b64 + '\n-----END PRIVATE KEY-----\n';
}
const ASC_PEM = await fakeAppleKeyPem();
const BASE_ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: SERVICE_KEY };
const ASC_ENV = { ...BASE_ENV, ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY: ASC_PEM };

// What the fake hc_claim_field_worker answers for each caller token. The
// live function (migration 015) returns { email, name, market, role } for
// the caller's ACTIVE roster row, or an empty list when there is none.
const TOKENS = {
  'owner-token': [{ email: 'sidd@example.invalid', name: 'Sidd', market: 'ny', role: 'owner' }],
  'manager-token': [{ email: 'jayden@example.invalid', name: 'Jayden Martin', market: 'ny', role: 'manager' }],
  'team-token': [{ email: 'crew@example.invalid', name: 'Hashim Nadir', market: 'ny', role: 'team' }],
  'nobody-token': [],
  // The roster stores roles in lowercase; a stray capital still counts as
  // the owner, the way migration 043 reads it (lower(btrim(role))).
  'shouting-token': [{ email: 'sidd@example.invalid', name: 'Sidd', market: 'ny', role: 'Owner' }],
};
// The roster as the service key reads it. Hashim left; his row is off.
const ROSTER = [
  { id: 'w-sidd', email: 'sidd@example.invalid', active: true },
  { id: 'w-hashim', email: 'Hashim.Nadir@example.invalid', active: false },
];
const NEW_HIRE = { email: 'New.Hire@Example.invalid', name: 'Ava  Chen', role: 'team', market: 'vegas', hourly_rate_cents: 1800 };

function reply(status, data = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { if (data === null) throw new Error('no body'); return data; },
    async text() { return data == null ? '' : JSON.stringify(data); },
  };
}

// The fake world. Options flip one leg at a time so each failure is proved
// on its own: rosterDown, insertStatus, authExists, authStatus, authUsers,
// ascStatus, ascThrows.
function harness(opts = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (urlValue, options = {}) => {
    const url = String(urlValue);
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, headers, body });
    if (url === SB + '/rest/v1/rpc/hc_claim_field_worker') {
      const token = String(headers.Authorization || '').replace(/^Bearer /, '');
      if (!(token in TOKENS)) return reply(401, { message: 'JWT expired' });
      return reply(200, TOKENS[token]);
    }
    if (method === 'GET' && url.startsWith(SB + '/rest/v1/field_workers?')) {
      if (opts.rosterDown) return reply(500, { message: 'boom' });
      return reply(200, opts.roster || ROSTER);
    }
    if (method === 'POST' && url === SB + '/rest/v1/field_workers') {
      if (opts.insertStatus) {
        if (opts.insertStatus !== 409) return reply(opts.insertStatus, { message: 'boom' });
        // PostgREST's 409 body: the duplicate email (23505) or, if the login
        // vanished between create and insert, a foreign key (23503).
        return reply(409, opts.insertConflict === 'fkey'
          ? { code: '23503', message: 'insert or update on table "field_workers" violates foreign key constraint "field_workers_auth_user_id_fkey"' }
          : { code: '23505', message: 'duplicate key value violates unique constraint "field_workers_email_lower_uidx"' });
      }
      return reply(201, [{ id: 'w-new', created_at: '2026-09-14T00:00:00Z', ...body }]);
    }
    if (method === 'POST' && url === SB + '/auth/v1/admin/users') {
      if (opts.authExists) return reply(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      if (opts.authRefuses) return reply(422, { code: 422, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' });
      if (opts.authStatus) return reply(opts.authStatus, { msg: 'boom' });
      return reply(200, { id: 'auth-new', email: body.email, email_confirmed_at: '2026-09-14T00:00:00Z' });
    }
    if (method === 'PUT' && url.startsWith(SB + '/auth/v1/admin/users/')) {
      if (opts.confirmStatus) return reply(opts.confirmStatus, { msg: 'boom' });
      return reply(200, { id: url.split('/').pop(), email_confirmed_at: '2026-09-14T00:00:00Z' });
    }
    if (method === 'GET' && url === SB + '/auth/v1/admin/users?page=1&per_page=1000') {
      return reply(200, { users: opts.authUsers || [], aud: 'authenticated' });
    }
    if (method === 'POST' && url === 'https://api.appstoreconnect.apple.com/v1/betaTesters') {
      if (opts.ascThrows) {
        const failure = new Error(opts.ascThrows === 'abort' ? 'This operation was aborted' : 'socket hang up');
        if (opts.ascThrows === 'abort') failure.name = 'AbortError';
        throw failure;
      }
      const status = opts.ascStatus || 201;
      return reply(status, status === 201 ? { data: { type: 'betaTesters', id: 'tester-1' } } : { errors: [{ status: String(status) }] });
    }
    throw new Error('unexpected offline fetch: ' + method + ' ' + url);
  };
  return {
    calls,
    only: (pred) => calls.filter(pred),
    claim: () => calls.find((c) => c.url.endsWith('/rpc/hc_claim_field_worker')),
    rosterReads: () => calls.filter((c) => c.method === 'GET' && c.url.includes('/rest/v1/field_workers?')),
    authCreates: () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/auth/v1/admin/users')),
    authLists: () => calls.filter((c) => c.method === 'GET' && c.url.includes('/auth/v1/admin/users?')),
    confirms: () => calls.filter((c) => c.method === 'PUT' && c.url.includes('/auth/v1/admin/users/')),
    inserts: () => calls.filter((c) => c.method === 'POST' && c.url === SB + '/rest/v1/field_workers'),
    asc: () => calls.filter((c) => c.url.startsWith('https://api.appstoreconnect.apple.com/')),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

function post(token, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request(WORKER_URL + '/team/invite', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
async function invite(env, token, body, opts = {}) {
  const h = harness(opts);
  try {
    const resp = await worker.fetch(post(token, body), env);
    const text = await resp.text();
    return { status: resp.status, text, json: JSON.parse(text), headers: resp.headers, h };
  } finally { h.restore(); }
}
const decodeJwtPart = (p) => JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

// Every reply text is collected so the last check can prove no secret
// ever leaves the worker.
const replies = [];

// ── 1. No token, bad token: 401 before anything else is touched ─────
{
  const none = await invite(BASE_ENV, '', NEW_HIRE);
  assert.equal(none.status, 401);
  assert.deepEqual(none.json, { ok: false, error: 'Authentication required' });
  assert.equal(none.h.calls.length, 0, 'no token means no network call at all');
  replies.push(none.text);

  const expired = await invite(BASE_ENV, 'expired-token', NEW_HIRE);
  assert.equal(expired.status, 401);
  assert.deepEqual(expired.json, { ok: false, error: 'Authentication required' });
  assert.equal(expired.h.calls.length, 1);
  const claim = expired.h.claim();
  assert.equal(claim.method, 'POST');
  assert.equal(claim.headers.apikey, SERVICE_KEY);
  assert.equal(claim.headers.Authorization, 'Bearer expired-token');
  assert.deepEqual(claim.body, {});
  replies.push(expired.text);

  // An absurdly long Bearer is refused before any network call.
  const huge = await invite(BASE_ENV, 'a'.repeat(8193), NEW_HIRE);
  assert.equal(huge.status, 401);
  assert.equal(huge.h.calls.length, 0, 'an oversized token must not be forwarded');
  replies.push(huge.text);

  // A body declared over the 8 MB cap is refused after the claim, before
  // anything is buffered. (If Node's Request drops a hand-set Content-Length,
  // delete this one case; the worker path was probed by hand.)
  const h2 = harness();
  try {
    const big = await worker.fetch(post('owner-token', NEW_HIRE, { 'Content-Length': '9437184' }), BASE_ENV);
    assert.equal(big.status, 413);
    assert.equal(h2.calls.length, 1);
  } finally { h2.restore(); }

  // The POST-only gate: a GET never reaches the route.
  const h = harness();
  try {
    const get = await worker.fetch(new Request(WORKER_URL + '/team/invite', { method: 'GET', headers: { Authorization: 'Bearer owner-token' } }), BASE_ENV);
    assert.equal(get.status, 200);
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
  pass('401 without a token (zero network calls) and for a rejected token; the claim RPC is called with the service apikey, the caller\'s Bearer and an empty body');
}

// ── 2. A manager, a crew member, a login with no roster row: 403 ────
{
  for (const token of ['manager-token', 'team-token', 'nobody-token']) {
    const r = await invite(BASE_ENV, token, NEW_HIRE);
    assert.equal(r.status, 403, token);
    assert.deepEqual(r.json, { ok: false, error: 'Owner access required' });
    assert.equal(r.h.calls.length, 1, token + ' must stop at the claim');
    replies.push(r.text);
  }
  pass('403 for a manager, a crew member and an unknown login; nothing is read or written past the claim');
}

// ── 3. Bad fields: 400 in plain English, nothing written ────────────
{
  const cases = [
    [{ ...NEW_HIRE, email: 'not-an-email' }, 'a valid email address is required'],
    [{ ...NEW_HIRE, email: '' }, 'a valid email address is required'],
    [{ ...NEW_HIRE, email: 'a@b.c'.padEnd(260, 'x') + '@example.invalid' }, 'a valid email address is required'],
    [{ ...NEW_HIRE, email: 'a'.repeat(250) + '@x.co' }, 'a valid email address is required'],
    [{ ...NEW_HIRE, role: 'boss' }, 'role must be owner, manager or team'],
    [{ ...NEW_HIRE, role: undefined }, 'role must be owner, manager or team'],
    [{ ...NEW_HIRE, market: 'boston' }, 'market must be ny, vegas or miami'],
    [{ ...NEW_HIRE, hourly_rate_cents: 99999 }, 'hourly_rate_cents must be a whole number of cents between 0 and 25000'],
    [{ ...NEW_HIRE, hourly_rate_cents: 12.5 }, 'hourly_rate_cents must be a whole number of cents between 0 and 25000'],
    [{ ...NEW_HIRE, hourly_rate_cents: -1 }, 'hourly_rate_cents must be a whole number of cents between 0 and 25000'],
    [{ ...NEW_HIRE, hourly_rate_cents: 'eighteen' }, 'hourly_rate_cents must be a whole number of cents between 0 and 25000'],
    [{ ...NEW_HIRE, name: '' }, 'name must be 1 to 80 plain characters'],
    [{ ...NEW_HIRE, name: '   ' }, 'name must be 1 to 80 plain characters'],
    [{ ...NEW_HIRE, name: 'AvaChen' }, 'name must be 1 to 80 plain characters'],
    [{ ...NEW_HIRE, name: 'x'.repeat(81) }, 'name must be 1 to 80 plain characters'],
    [{ ...NEW_HIRE, name: 42 }, 'name must be 1 to 80 plain characters'],
  ];
  for (const [body, message] of cases) {
    const r = await invite(BASE_ENV, 'owner-token', body);
    assert.equal(r.status, 400, message);
    assert.deepEqual(r.json, { ok: false, error: message });
    assert.equal(r.h.calls.length, 1, 'a bad field must stop before the roster is read');
    replies.push(r.text);
  }
  const garbage = await invite(BASE_ENV, 'owner-token', 'not json');
  assert.equal(garbage.status, 400);
  assert.deepEqual(garbage.json, { ok: false, error: 'Invalid JSON body' });
  const list = await invite(BASE_ENV, 'owner-token', [NEW_HIRE]);
  assert.equal(list.status, 400);
  assert.deepEqual(list.json, { ok: false, error: 'Invalid JSON body' });
  // The pure validator normalizes what it accepts.
  assert.deepEqual(validateTeamInvite({ email: ' Ava.Chen@Example.INVALID ', name: '  Ava \t Chen ', role: ' Manager ', market: 'NY', hourly_rate_cents: '2000' }),
    { email: 'ava.chen@example.invalid', name: 'Ava Chen', role: 'manager', market: 'ny', hourly_rate_cents: 2000 });
  assert.deepEqual(validateTeamInvite({ email: 'a@b.co', name: 'A', role: 'team', market: 'miami' }).hourly_rate_cents, null);
  assert.deepEqual(validateTeamInvite({ email: 'a@b.co', name: 'A', role: 'team', market: 'miami', hourly_rate_cents: '' }).hourly_rate_cents, null);
  assert.deepEqual(validateTeamInvite({ email: 'a@b.co', name: 'A', role: 'team', market: 'miami', hourly_rate_cents: 0 }).hourly_rate_cents, 0);
  pass('400 for a bad email, role, market, rate or name, and for a non-object body; the validator lowercases email, role and market, collapses name whitespace and reads a digit string rate');
}

// ── 4. Duplicates: 409 from the roster read, and from the insert race ─
{
  const dup = await invite(BASE_ENV, 'owner-token', { ...NEW_HIRE, email: 'hashim.nadir@example.invalid' });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.json, { ok: false, error: 'already on the roster (switch them on from the Team screen)' });
  assert.equal(dup.h.rosterReads().length, 1);
  assert.equal(dup.h.rosterReads()[0].headers.apikey, SERVICE_KEY);
  assert.equal(dup.h.authCreates().length, 0, 'a duplicate must not create a login');
  assert.equal(dup.h.inserts().length, 0);
  replies.push(dup.text);

  const race = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { insertStatus: 409 });
  assert.equal(race.status, 409);
  assert.deepEqual(race.json, { ok: false, error: 'already on the roster (switch them on from the Team screen)' });
  assert.equal(race.h.asc().length, 0);
  replies.push(race.text);

  // A 409 that is not the unique email (a foreign key, if the login vanished
  // between create and insert) is a failed insert, never a duplicate.
  const fkey = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { insertStatus: 409, insertConflict: 'fkey' });
  assert.equal(fkey.status, 502);
  assert.deepEqual(fkey.json, { ok: false, error: 'the roster row could not be created' });
  replies.push(fkey.text);
  pass('409 for an email already on the roster (case-insensitive, inactive rows included) and for an insert that trips the unique email');
}

// ── 5. The happy path without App Store Connect secrets ─────────────
{
  const r = await invite(BASE_ENV, 'owner-token', NEW_HIRE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    ok: true,
    worker: { id: 'w-new', email: 'new.hire@example.invalid', name: 'Ava Chen', role: 'team', market: 'vegas', active: true, hourly_rate_cents: 1800 },
    testflight: 'skipped: no App Store Connect key on the worker',
  });
  assert.deepEqual(r.h.calls.map((c) => c.method + ' ' + c.url), [
    'POST ' + SB + '/rest/v1/rpc/hc_claim_field_worker',
    'GET ' + SB + '/rest/v1/field_workers?select=id,email,active',
    'POST ' + SB + '/auth/v1/admin/users',
    'POST ' + SB + '/rest/v1/field_workers',
  ]);
  const create = r.h.authCreates()[0];
  assert.equal(create.headers.apikey, SERVICE_KEY);
  assert.equal(create.headers.Authorization, 'Bearer ' + SERVICE_KEY);
  assert.deepEqual(create.body, { email: 'new.hire@example.invalid', email_confirm: true });
  const insert = r.h.inserts()[0];
  assert.equal(insert.headers.Prefer, 'return=representation');
  assert.equal(insert.headers.apikey, SERVICE_KEY);
  assert.deepEqual(insert.body, {
    email: 'new.hire@example.invalid', name: 'Ava Chen', role: 'team', market: 'vegas', active: true, hourly_rate_cents: 1800, auth_user_id: 'auth-new',
  });
  assert.equal(r.h.asc().length, 0, 'no ASC call without the secrets');
  assert.equal(r.headers.get('cache-control'), 'no-store', 'a reply with a person\'s details never sits in a cache');
  replies.push(r.text);

  const noRate = await invite(BASE_ENV, 'owner-token', { ...NEW_HIRE, hourly_rate_cents: null, role: 'Manager', market: 'MIAMI' });
  assert.equal(noRate.status, 200);
  assert.equal(noRate.h.inserts()[0].body.hourly_rate_cents, null);
  assert.equal(noRate.h.inserts()[0].body.role, 'manager');
  assert.equal(noRate.h.inserts()[0].body.market, 'miami');
  assert.equal(noRate.json.worker.hourly_rate_cents, null);
  const shout = await invite(BASE_ENV, 'shouting-token', NEW_HIRE);
  assert.equal(shout.status, 200, 'a role stored as "Owner" is still the owner, as 043 reads it');
  replies.push(shout.text);
  pass('happy path: claim, roster read, auth admin create { email, email_confirm: true }, roster insert with return=representation and the new auth id; the reply carries the row and a plain "skipped" TestFlight note; a role with a stray capital is still the owner');
}

// ── 6. The login already exists (a former hire, or a retry) ──────────
{
  const r = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { authExists: true, authUsers: [
    { id: 'auth-other', email: 'someone.else@example.invalid', email_confirmed_at: '2026-08-01T00:00:00Z' },
    { id: 'auth-old', email: 'New.Hire@example.invalid', email_confirmed_at: '2026-08-01T00:00:00Z' },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.h.authCreates().length, 1);
  assert.equal(r.h.authLists().length, 1);
  assert.equal(r.h.confirms().length, 0, 'a confirmed login is linked as it is');
  assert.equal(r.h.authLists()[0].headers.apikey, SERVICE_KEY);
  assert.equal(r.h.inserts()[0].body.auth_user_id, 'auth-old');
  assert.equal(r.json.ok, true);
  replies.push(r.text);

  const missing = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { authExists: true, authUsers: [] });
  assert.equal(missing.status, 502);
  assert.deepEqual(missing.json, { ok: false, error: 'the login exists but could not be found' });
  assert.equal(missing.h.inserts().length, 0);
  replies.push(missing.text);
  // A login that was started but never verified is confirmed first, so the
  // roster never links an unconfirmed user (migration 015's rule).
  const half = { id: 'auth-half', email: 'new.hire@example.invalid', email_confirmed_at: null };
  const healed = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { authExists: true, authUsers: [half] });
  assert.equal(healed.status, 200);
  assert.equal(healed.h.confirms().length, 1);
  assert.equal(healed.h.confirms()[0].url, SB + '/auth/v1/admin/users/auth-half');
  assert.deepEqual(healed.h.confirms()[0].body, { email_confirm: true });
  assert.equal(healed.h.confirms()[0].headers.apikey, SERVICE_KEY);
  assert.equal(healed.h.inserts()[0].body.auth_user_id, 'auth-half');
  replies.push(healed.text);

  const stuck = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { authExists: true, authUsers: [half], confirmStatus: 500 });
  assert.equal(stuck.status, 502);
  assert.deepEqual(stuck.json, { ok: false, error: 'the login exists but is unconfirmed' });
  assert.equal(stuck.h.inserts().length, 0);
  replies.push(stuck.text);

  // A 422 that is NOT "already registered" is a refused create, never a lookup.
  const refused = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { authRefuses: true });
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.json, { ok: false, error: 'the login could not be created' });
  assert.equal(refused.h.authLists().length, 0);
  assert.equal(refused.h.inserts().length, 0);
  replies.push(refused.text);
  pass('422 already registered: the existing login is found by email in the admin list (case-insensitive) and linked, an unconfirmed one is confirmed first; an unfindable login or any other 422 is a 502 with no roster row');
}

// ── 7. TestFlight with the secrets: the exact ASC request ───────────
{
  const r = await invite(ASC_ENV, 'owner-token', NEW_HIRE);
  assert.equal(r.status, 200);
  assert.equal(r.json.testflight, 'invited');
  assert.equal(r.json.ok, true);
  const asc = r.h.asc();
  assert.equal(asc.length, 1);
  assert.equal(asc[0].method, 'POST');
  assert.equal(asc[0].url, 'https://api.appstoreconnect.apple.com/v1/betaTesters');
  assert.equal(asc[0].headers['Content-Type'], 'application/json');
  const jwt = String(asc[0].headers.Authorization).replace(/^Bearer /, '');
  const [head, claims] = jwt.split('.').slice(0, 2).map(decodeJwtPart);
  assert.deepEqual(head, { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' });
  assert.equal(claims.iss, ASC_ISSUER_ID);
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.equal(claims.exp - claims.iat, 19 * 60, 'a minute under Apple\'s 20-minute ceiling');
  assert.deepEqual(asc[0].body, {
    data: {
      type: 'betaTesters',
      attributes: { email: 'new.hire@example.invalid', firstName: 'Ava', lastName: 'Chen' },
      relationships: { betaGroups: { data: [{ type: 'betaGroups', id: ASC_GROUP_DEFAULT }] } },
    },
  });
  // The ASC call is the LAST thing, after the row exists.
  assert.equal(r.h.calls[r.h.calls.length - 1].url, 'https://api.appstoreconnect.apple.com/v1/betaTesters');
  replies.push(r.text);

  const group = await invite({ ...ASC_ENV, ASC_CREW_GROUP_ID: 'group-override' }, 'owner-token', { ...NEW_HIRE, name: 'Cher' });
  assert.equal(group.h.asc()[0].body.data.relationships.betaGroups.data[0].id, 'group-override');
  assert.deepEqual(group.h.asc()[0].body.data.attributes, { email: 'new.hire@example.invalid', firstName: 'Cher' });
  replies.push(group.text);

  const again = await invite(ASC_ENV, 'owner-token', NEW_HIRE, { ascStatus: 409 });
  assert.equal(again.status, 200); assert.equal(again.json.testflight, 'already a tester');
  const down = await invite(ASC_ENV, 'owner-token', NEW_HIRE, { ascStatus: 500 });
  assert.equal(down.status, 200); assert.equal(down.json.testflight, 'skipped: 500');
  const denied = await invite(ASC_ENV, 'owner-token', NEW_HIRE, { ascStatus: 401 });
  assert.equal(denied.status, 200); assert.equal(denied.json.testflight, 'skipped: 401');
  const thrown = await invite(ASC_ENV, 'owner-token', NEW_HIRE, { ascThrows: true });
  assert.equal(thrown.status, 200); assert.equal(thrown.json.testflight, 'skipped: network error');
  const slow = await invite(ASC_ENV, 'owner-token', NEW_HIRE, { ascThrows: 'abort' });
  assert.equal(slow.status, 200); assert.equal(slow.json.testflight, 'skipped: timeout');
  for (const x of [again, down, denied, thrown, slow]) { assert.equal(x.json.ok, true); assert.equal(x.json.worker.id, 'w-new'); replies.push(x.text); }

  // A partial secret set counts as no secret.
  assert.equal(await inviteToTestFlight({ ASC_KEY_ID, ASC_ISSUER_ID }, 'a@b.co', 'A'), 'skipped: no App Store Connect key on the worker');
  const token = await appStoreConnectJwt(ASC_ENV, T('2026-09-14T12:00:00Z'));
  const [, c2] = token.split('.').slice(0, 2).map(decodeJwtPart);
  // 2026-09-14T12:00:00Z is 1789387200 seconds since the epoch.
  assert.deepEqual(c2, { iss: ASC_ISSUER_ID, iat: 1789387200, exp: 1789388340, aud: 'appstoreconnect-v1' });
  pass('TestFlight: a 19-minute ES256 App Store Connect token (kid, iss, aud appstoreconnect-v1; a minute under Apple\'s 20-minute ceiling), the exact betaTesters body with the crew group (overridable), invited / already a tester / skipped: <status> / skipped: network error / skipped: timeout, never failing the request');
}

// ── 8. Supabase legs failing: honest statuses, nothing half-done ─────
{
  const rosterDown = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { rosterDown: true });
  assert.equal(rosterDown.status, 503);
  assert.deepEqual(rosterDown.json, { ok: false, error: 'the roster could not be read; try again' });
  assert.equal(rosterDown.h.authCreates().length, 0);
  replies.push(rosterDown.text);

  const authDown = await invite(BASE_ENV, 'owner-token', NEW_HIRE, { authStatus: 500 });
  assert.equal(authDown.status, 502);
  assert.deepEqual(authDown.json, { ok: false, error: 'the login could not be created' });
  assert.equal(authDown.h.inserts().length, 0);
  replies.push(authDown.text);

  const insertDown = await invite(ASC_ENV, 'owner-token', NEW_HIRE, { insertStatus: 500 });
  assert.equal(insertDown.status, 502);
  assert.deepEqual(insertDown.json, { ok: false, error: 'the roster row could not be created' });
  assert.equal(insertDown.h.asc().length, 0, 'no TestFlight invite without a roster row');
  replies.push(insertDown.text);

  const unconfigured = await invite({}, 'owner-token', NEW_HIRE);
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(unconfigured.json, { ok: false, error: 'Authentication service unavailable' });
  replies.push(unconfigured.text);
  pass('503 when the roster read or the worker config fails, 502 when Supabase refuses the login or the row; a failed leg never reaches the next one');
}

// ── 9. No secret, ever, in any reply ────────────────────────────────
{
  assert.ok(replies.length >= 30);
  const pemBody = ASC_PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  for (const text of replies) {
    assert.ok(!text.includes(SERVICE_KEY), 'service key leaked');
    assert.ok(!text.includes('owner-token'), 'caller token leaked');
    assert.ok(!text.includes(ASC_KEY_ID), 'ASC key id leaked');
    assert.ok(!text.includes(ASC_ISSUER_ID), 'ASC issuer leaked');
    assert.ok(!text.includes(pemBody.slice(0, 40)), 'ASC private key leaked');
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(text), 'a JWT leaked');
  }
  pass('no reply out of ' + replies.length + ' carries the service key, the caller token, the ASC key id, the issuer, the private key or any JWT');
}

console.log(`\nPASS: ${passed} team invite checks. No network, no database, no phone.`);
