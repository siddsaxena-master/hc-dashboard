// Tests for the Google Voice guards in worker.js (CRM Step C, plan
// sections 1.4 and 5). Google Voice texts, voicemails and missed calls
// will arrive as intake rows with channel 'sms_forward'. Claudia must
// never card them, nag about them or count them as emails, and a Google
// Voice relay address must never become a client email (a reply to a
// txt.voice address would TEXT the customer).
//
// Run it with:  node worker/test-google-voice-guards.mjs
//
// No test framework and no network: the global fetch is a fake that
// records every URL and answers from canned rows. Fixtures use
// example.com and 555 numbers only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isVoiceRelayAddress, leadLookupEmail, leadLookupCandidates, reconfirmRecipientHolds,
  buildIntakeDigestLines, runIntakeNagScan, runIntakeCardScan,
} from './worker.js';

const TXT = '15555550100.15555550123.abcDEF12@txt.voice.google.com';
const NOREPLY = 'voice-noreply@google.com';

// ── fake network ───────────────────────────────────────────────────
let urls = [];
let answer = () => [];
globalThis.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  urls.push(u);
  const rows = answer(u);
  if (rows === null) return { ok: false, status: 500, text: async () => 'boom', json: async () => null };
  return { ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows };
};
const env = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'not-a-real-key',
  TG_BOT_TOKEN: 'not-a-real-token', ALLOWED_CHAT_IDS: '111' };
const intakeReads = () => urls.filter((u) => u.includes('/rest/v1/intake_messages?'));

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ── 1) which addresses are Google Voice relays ─────────────────────
test('txt.voice and voice-noreply addresses are relays, any case or form', () => {
  assert.equal(isVoiceRelayAddress(TXT), true);
  assert.equal(isVoiceRelayAddress(TXT.toUpperCase()), true);
  assert.equal(isVoiceRelayAddress(NOREPLY), true);
  assert.equal(isVoiceRelayAddress('Google Voice <' + NOREPLY + '>'), true);
  assert.equal(isVoiceRelayAddress('  "(555) 555-0123" <' + TXT + '>  '), true);
  assert.equal(isVoiceRelayAddress('jane@example.com, ' + TXT), true);
});

test('ordinary and lookalike addresses are not relays', () => {
  for (const a of ['jane@example.com', 'voice@google.com', 'noreply@google.com',
    'my-voice-noreply@google.com', 'voice-noreply@google.com.example.com',
    'x@txt.voice.google.com.example.com', 'x@voice.google.com', '', null, undefined, 'not an address']) {
    assert.equal(isVoiceRelayAddress(a), false, String(a));
  }
});

// ── 2) the two address guards the plan names ───────────────────────
test('leadLookupEmail returns null for both relays and keeps real senders', () => {
  assert.equal(leadLookupEmail(TXT), null);
  assert.equal(leadLookupEmail(NOREPLY), null);
  assert.equal(leadLookupEmail('Google Voice <' + NOREPLY + '>'), null);
  assert.equal(leadLookupEmail('Jane <Jane@Example.com>'), 'jane@example.com');
  assert.deepEqual(leadLookupCandidates(TXT, 'jane@example.com'), ['jane@example.com']);
  assert.deepEqual(leadLookupCandidates(NOREPLY, TXT), []);
});

test('reconfirmRecipientHolds holds any relay recipient as no_email', () => {
  assert.deepEqual(reconfirmRecipientHolds([TXT.toLowerCase()]), ['no_email']);
  assert.deepEqual(reconfirmRecipientHolds([NOREPLY]), ['no_email']);
  assert.deepEqual(reconfirmRecipientHolds(['jane@example.com', TXT.toLowerCase()]), ['no_email']);
  assert.deepEqual(reconfirmRecipientHolds(['jane@example.com']), []);
});

test('the lead row fallback and the Formspree row never store a relay', () => {
  const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const scrub = src.slice(src.indexOf('function _scrubOperatorEmail('), src.indexOf('function _scrubOperatorEmail(') + 600);
  assert.match(scrub, /if \(isVoiceRelayAddress\(lower\)\) return null;/);
  assert.match(src, /\[extracted\.client_email, submission\.email\]\s*\.find\(\(a\) => a && !isVoiceRelayAddress\(a\)\) \|\| null/);
});

// ── 3) the reads never pick up Google Voice rows ───────────────────
test('the 5-minute card scan reads email rows only (channel=neq.sms_forward)', async () => {
  urls = [];
  answer = () => [];
  await runIntakeCardScan(env);
  const cardRead = intakeReads().filter((u) => u.includes('telegram_message_id=is.null') && u.includes('classified_at=not.is.null'));
  assert.equal(cardRead.length, 1);
  assert.ok(cardRead[0].includes('&channel=neq.sms_forward'));
  assert.ok(cardRead[0].includes('&replayed_at=is.null'));
});

test('the hourly 4h and 24h nag reads skip Google Voice rows', async () => {
  urls = [];
  answer = () => [];
  await runIntakeNagScan(env);
  const nagReads = intakeReads().filter((u) => u.includes('status=in.(pending_review,approved)'));
  assert.equal(nagReads.length, 2);
  for (const u of nagReads) assert.ok(u.includes('&channel=neq.sms_forward'), u);
});

// Canned digest answers: `waiting` for the awaiting-review read, `texts`
// for the Google Voice count read, nothing for every other read.
function digestAnswer(waiting, texts) {
  return (u) => {
    if (u.includes('channel=eq.sms_forward')) return texts;
    if (u.includes('status=in.(pending_review,approved)')) return waiting;
    return [];
  };
}
const pendingEmail = (id) => ({ id, status: 'pending_review', created_at: new Date(Date.now() - 3 * 3600000).toISOString(), reviewed_at: null });
const threeTexts = [{ id: 7 }, { id: 8 }, { id: 9 }];

test('8am digest: awaiting review counts email rows only, texts get their own line', async () => {
  urls = [];
  answer = digestAnswer([pendingEmail(41), pendingEmail(42)], threeTexts);
  const lines = await buildIntakeDigestLines(env);
  const waitingRead = intakeReads().find((u) => u.includes('status=in.(pending_review,approved)'));
  assert.ok(waitingRead.includes('&channel=eq.email'), waitingRead);
  const textsRead = intakeReads().find((u) => u.includes('channel=eq.sms_forward'));
  assert.ok(textsRead.includes('status=eq.pending_review'));
  assert.ok(textsRead.includes('&replayed_at=is.null'));
  assert.ok(textsRead.startsWith('https://example.invalid/rest/v1/intake_messages?select=id&'));
  assert.ok(lines.some((l) => l.startsWith('Intake: 2 awaiting review')));
  assert.ok(lines.includes('3 texts or voicemails in HC App New to sort'));
});

test('8am digest: no texts line when there are none or the read fails', async () => {
  for (const texts of [[], null]) {
    urls = [];
    answer = digestAnswer([pendingEmail(41)], texts);
    const lines = await buildIntakeDigestLines(env);
    assert.ok(!lines.some((l) => l.includes('texts or voicemails')), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.startsWith('Intake: 1 awaiting review')));
  }
});

test('8am digest: a capped read says 1000 or more, never a false exact count', async () => {
  urls = [];
  answer = digestAnswer([], Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })));
  const lines = await buildIntakeDigestLines(env);
  assert.ok(lines.includes('1000 or more texts or voicemails in HC App New to sort'));
});

// ── runner ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const c of cases) {
  try { await c.fn(); passed++; console.log('ok    ' + c.name); }
  catch (e) { failed++; console.log('FAIL  ' + c.name + '\n      ' + ((e && e.message) || e)); }
}
console.log(passed + ' passed, ' + failed + ' failed, ' + cases.length + ' total');
if (failed) process.exit(1);
