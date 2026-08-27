import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.indexOf('</script>', scriptStart);

assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'dashboard inline script is present');
const script = html.slice(scriptStart + '<script>'.length, scriptEnd);
new Function(script);
new Function(serviceWorker);

let checks = 2;
function check(value, message) {
  assert.ok(value, message);
  checks += 1;
}

check(!/AUTH_USERS\s*=/.test(script), 'hardcoded browser whitelist is removed');
check(!/googleSignIn|localPreviewSignIn|local-preview-btn/.test(html), 'dashboard auth bypasses are removed');
check(!/localStorage\.(?:getItem|setItem)\('hc_(?:auth_email|role|market)'/.test(script), 'saved email, role, and market are never trusted');
check(/\/auth\/v1\/otp/.test(script) && /create_user:false/.test(script), 'OTP requests cannot create arbitrary Auth users');
check(/\/auth\/v1\/verify/.test(script) && /type:'email'/.test(script), 'email code verification is required');
check(/rpc\/hc_get_auth_bootstrap/.test(script), 'AAL1 receives only the minimal server-derived auth bootstrap');
check(/rpc\/hc_claim_field_worker_v2/.test(script), 'role, market, and Auth UUID come from the protected v2 roster claim');
check(/let currentUserId=null/.test(script) && /auth_user_id/.test(script), 'the immutable Auth UUID is kept in memory for account-scoped work');
check(/return\{access_token:data\.access_token,refresh_token:data\.refresh_token,expires_at:expiresAt\}/.test(script), 'persistent auth state contains tokens and expiry only');
check(/grant_type=refresh_token/.test(script), 'expired sessions refresh instead of silently signing out');
check(/const refreshToken=sbSession\?\.refresh_token\|\|null/.test(script) && /JSON\.stringify\(\{refresh_token:refreshToken\}\)/.test(script), 'refresh requests capture the exact starting refresh token');
check(/const refreshGeneration=dashboardSessionGeneration/.test(script) && /if\(!refreshIsCurrent\(\)\)throw staleSessionError\(\)/.test(script), 'refresh responses are bound to the starting session generation');
check(/sbRefreshContext\?\.generation===refreshGeneration&&sbRefreshContext\?\.refreshToken===refreshToken&&sbRefreshContext\?\.userId===refreshUserId/.test(script), 'only a refresh from the same Auth user and session can reuse an in-flight promise');
check(/identity\.userId===currentUserId/.test(script), 'authenticated responses are bound to the immutable Auth UUID');
check(/if\(sbRefreshPromise===trackedPromise\)\{sbRefreshPromise=null;sbRefreshContext=null;\}/.test(script), 'an old refresh cannot clear a newer refresh slot');
check(/requireCurrentSessionIdentity\(requestIdentity\)/.test(script), 'authenticated request responses reject stale refresh-token identity');
check(/if\(err\.authRejected\|\|!sbSession\)/.test(script) && /Could not verify your secure profile/.test(script), 'temporary profile-check failures keep the locked session available for retry');
check(/Authorization:'Bearer '\+accessToken/.test(script), 'authenticated Supabase and AI requests use the access token');

const assuranceStart = script.indexOf('function signedSessionClaims()');
const assuranceEnd = script.indexOf('function clearLegacyAuthState', assuranceStart);
const assuranceBlock = script.slice(assuranceStart, assuranceEnd);
check(/String\(signedSessionClaims\(\)\?\.aal\|\|''\)/.test(assuranceBlock), 'owner assurance reads the signed top-level JWT AAL');
check(!/user_metadata|app_metadata|localStorage/.test(assuranceBlock), 'client metadata and storage cannot satisfy owner assurance');
check(/authApiFetch\('factors',\{/.test(script) && /factor_type:'totp'/.test(script), 'owner TOTP enrollment uses the Supabase factor API');
check(/'\/challenge'/.test(script) && /challenge_id:challengeId,code/.test(script) && /'\/verify'/.test(script), 'owner TOTP uses Supabase challenge and verify APIs');
check(/friendly_name:'HC Owner Dashboard'/.test(script) && /issuer:'Hamptons Coconuts'/.test(script), 'the authenticator factor has a recognizable issuer and device name');
check(!/localStorage\.(?:setItem|getItem)\([^\n]*(?:mfa|factor|secret|otpauth)/i.test(script), 'MFA codes, factors, setup secrets, and URIs are never persisted');
check(!/console\.(?:log|info|debug)\([^\n]*(?:mfa|factor|secret|otpauth)/i.test(script), 'MFA material is never logged');
check(/secretEl\.textContent=enrollment\?String\(secret\|\|''\):''/.test(script), 'the selectable setup key is inserted as text only');
check(/safeMfaQrSource\(qrCode\)/.test(script) && /qr\.src=safeQr/.test(script), 'only a validated Supabase QR data image is rendered');
check(/add a second authenticator as a backup/i.test(html) && /Email alone cannot bypass this step/.test(html), 'the owner is prompted for a backup factor without an email bypass');
check(/let pendingMfaFactors=\[\]/.test(script) && /let pendingMfaUnverifiedFactorIds=\[\]/.test(script), 'verified and unfinished factor choices stay in memory only');
check(/factor\?\.friendly_name\|\|factor\?\.friendlyName/.test(script) && /slice\(0,60\)/.test(script), 'factor choices use bounded non-sensitive friendly names');
check(/if\(verified\.length>1\)[\s\S]{0,180}showDashboardMfaPanel\(\{selection:true\}\)/.test(script), 'all verified backup authenticators are offered for selection');
check(/button\.textContent=factor\.label/.test(script) && !/auth-mfa-factor[^\n]{0,200}innerHTML/.test(script), 'authenticator names are rendered as inert text, not HTML');
check(/dashboardUnverifiedTotpFactorIds\(user\)/.test(script) && /showDashboardMfaPanel\(\{restart:true\}\)/.test(script), 'an abandoned unverified factor pauses for an explicit restart');
check(/method:'DELETE'/.test(script) && /dashboardUnverifiedTotpFactorIds\(user\)\.includes\(factorId\)/.test(script), 'restart rechecks and removes only a still-unverified TOTP factor');
check(/dashboardTotpFactors\(latestUser\)\.some\(factor=>factor\.factorId===factorId\)\)continue/.test(script), 'a factor verified during restart is retained and selected safely');
const selectFactorStart = script.indexOf('function selectDashboardMfaFactor(factorId)');
const selectFactorEnd = script.indexOf('async function prepareDashboardMfa', selectFactorStart);
check(selectFactorStart >= 0 && !/pendingMfaAction\)return/.test(script.slice(selectFactorStart, selectFactorEnd)), 'restart may select a factor that became verified during the live recheck');
check(/pendingMfaFactors=\[\][\s\S]{0,100}pendingMfaUnverifiedFactorIds=\[\]/.test(script), 'MFA factor choices clear with the locked session');

const completeAuthStart = script.indexOf('async function completeDashboardAuthentication()');
const completeAuthEnd = script.indexOf('async function verifyDashboardMfa', completeAuthStart);
const completeAuthBlock = script.slice(completeAuthStart, completeAuthEnd);
const completeBootstrap = completeAuthBlock.indexOf('const bootstrap=await claimAuthBootstrap();');
const completeAal = completeAuthBlock.indexOf("signedSessionAal()!=='aal2'");
const completeLock = completeAuthBlock.indexOf('lockDashboardForMfa(bootstrap)');
const completeFullClaim = completeAuthBlock.indexOf('const profile=await claimDashboardProfile();');
check(completeBootstrap >= 0 && completeAal > completeBootstrap && completeLock > completeAal && completeFullClaim > completeLock, 'owner bootstrap and AAL2 gate run before the full profile claim');

const sensitiveStart = script.indexOf('function clearSensitiveDashboardState()');
const sensitiveEnd = script.indexOf('function lockDashboardForMfa', sensitiveStart);
const sensitiveBlock = script.slice(sensitiveStart, sensitiveEnd);
check(/currentRole=null/.test(sensitiveBlock) && /clearCachedOrders\(\)/.test(sensitiveBlock) && /events=\[\]/.test(sensitiveBlock), 'MFA lock clears rendered identity and operational rows immediately');
check(!/sbSession=null|localStorage\.removeItem\(SB_SESSION_KEY\)/.test(sensitiveBlock), 'MFA lock preserves the valid Supabase session for TOTP completion');
const clearSessionStart = script.indexOf('function clearDashboardSession()');
const clearSessionEnd = script.indexOf('function accessErrorIsDefinitive', clearSessionStart);
const clearSessionBlock = script.slice(clearSessionStart, clearSessionEnd);
check(/sbSession=null/.test(clearSessionBlock) && /localStorage\.removeItem\(SB_SESSION_KEY\)/.test(clearSessionBlock), 'definitive auth rejection clears the browser session');

const recheckStart = script.indexOf('async function revalidateDashboardAccess()');
const recheckEnd = script.indexOf('async function lockOwner', recheckStart);
const recheckBlock = script.slice(recheckStart, recheckEnd);
check(/const bootstrap=await claimAuthBootstrap\(\)/.test(recheckBlock) && /const profile=await claimDashboardProfile\(\)/.test(recheckBlock), 'periodic access checks repeat both bootstrap and full claim');
check(/signedSessionAal\(\)!=='aal2'/.test(recheckBlock) && /lockDashboardForMfa\(bootstrap\)/.test(recheckBlock), 'periodic checks lock an owner whose signed session drops below AAL2');
check(/accessErrorIsDefinitive\(err\)[\s\S]{0,100}clearDashboardSession\(\)/.test(recheckBlock), 'definitive 401, 403, or revoked access clears and locks immediately');
check(/existing session preserved/.test(recheckBlock) && /Your session is preserved/.test(recheckBlock), 'transient recheck failures preserve the current valid session');
check(/visibilitychange/.test(script) && /document\.visibilityState==='visible'/.test(script), 'returning the dashboard to the foreground rechecks access');
check(/setInterval\(revalidateDashboardAccess,ACCESS_RECHECK_MS\)/.test(script) && /ACCESS_RECHECK_MS=5\*60\*1000/.test(script), 'a five-minute access recheck timer is installed');

check(/rpc\/hc_list_orders_for_current_user/.test(script), 'orders use the role-shaped listing RPC');
for (const parameter of ['p_delivery_from', 'p_delivery_before', 'p_stages', 'p_offset', 'p_limit']) {
  check(script.includes(parameter), `order listing sends ${parameter}`);
}
check(!/orders\?select=\*/.test(script), 'anonymous full-order reads are removed');
check(/p_limit:500/.test(script) && /offset\+=batch\.length/.test(script), 'order listing paginates at the server limit');
check(/currentRole==='owner'&&sbSession\?\.access_token/.test(script), 'bulk order writes are owner and session gated');
check(/const sessionIsCurrent=\(\)=>sessionGeneration===dashboardSessionGeneration/.test(script), 'stale cloud responses cannot cross a logout or account change');

check(/function gmailConnect\(\)\{\s*if\(currentRole!==['"]owner['"]\)return;/.test(script), 'Gmail connection is enforced as owner-only');
check(/function confirmAllImports\(\)\{\s*if\(currentRole!==['"]owner['"]\)return;/.test(script), 'Gmail import mutation is enforced as owner-only');
check(/sessionGeneration===dashboardSessionGeneration&&gmailToken===sessionGmailToken/.test(script), 'stale Gmail results are discarded after session changes');

check(/rpc\/hc_confirm_order_delivery_v2/.test(script), 'delivery confirmation uses the replay-safe v2 RPC');
check(/p_delivery_request_id:item\.deliveryRequestId/.test(script), 'the stable delivery request UUID is sent on every retry');
check(/p_signed_via:'dashboard'/.test(script), 'delivery confirmation uses the fixed dashboard source label');
check(!/\/rest\/v1\/delivery_signatures/.test(script), 'browser no longer inserts signatures directly');
check(!/method:'PATCH'[\s\S]{0,180}orders\?id=eq\./.test(script), 'browser no longer patches delivered orders directly');
check(/const PENDING_KEY_PREFIX='hc_pending_deliveries_v3_'/.test(script) && /return prefix\+userId/.test(script), 'delivery queues are keyed by immutable Auth UUID');
check(/async function syncPendingDeliveries\(\)\{\s*if\(_delivSyncing\)return;\s*if\(!currentUserId\|\|!currentUserEmail\|\|!sbSession\?\.access_token\)return;/.test(script), 'delivery queue sync cannot start before an Auth UUID is established');
check(/UNVERIFIED_PENDING_KEY_PREFIX='hc_pending_deliveries_v2_'/.test(script) && /hasQuarantinedPendingQueue/.test(script) && !/migrateLegacyPendingQueue/.test(script), 'unverifiable legacy and email-keyed queues stay quarantined');
check(/REVIEW_KEY_PREFIX='hc_pending_deliveries_review_v1_'/.test(script) && /quarantineDeliveryItem/.test(script), 'permanent server rejections move to an Auth-ID-scoped review queue');
const lockOwnerStart = script.indexOf('async function lockOwner(');
const lockOwnerEnd = script.indexOf('// ── PROFIT CALC', lockOwnerStart);
const lockOwnerBlock = script.slice(lockOwnerStart, lockOwnerEnd);
check(/will retry when this account signs in again/.test(lockOwnerBlock) && !/syncPendingDeliveries\(\);\s*return/.test(lockOwnerBlock), 'pending signatures warn but do not block secure logout');
check(/function eventsCacheKey\(\)/.test(script) && script.includes('hc_events_owner') && script.includes('hc_events_field_'), 'cached orders are isolated by server-derived role and market');
check(/function clearCachedOrders\(\)/.test(script) && /key==='hc_events'/.test(script), 'sensitive legacy and role-scoped order caches can be cleared');

check(!html.includes('api.telegram.org/bot'), 'dashboard cannot send Telegram requests with browser credentials');
check(!html.includes('id="tg-bot-token"') && !html.includes('id="tg-chat-id"'), 'Telegram credential inputs are removed');
check(!/localStorage\.setItem\('hc_tg_(?:bot_token|chat_id)'/.test(script), 'Telegram credentials are never written to browser storage');
check((script.match(/clearLegacyTelegramCredentials\(\)/g)||[]).length >= 3, 'legacy Telegram credentials clear on startup and signout');

const authStart = script.indexOf('function authErrorMessage(');
const authEnd = script.indexOf('async function supabaseFetch', authStart);
assert.ok(authStart >= 0 && authEnd > authStart, 'refresh implementation is present');
const authStorage = new Map();
const refreshRequests = [];
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const authSandbox = {
  Date,
  JSON,
  Error,
  localStorage: {
    getItem(key) { return authStorage.has(key) ? authStorage.get(key) : null; },
    setItem(key, value) { authStorage.set(key, String(value)); },
    removeItem(key) { authStorage.delete(key); }
  },
  fetch(url, options) {
    const pending = deferred();
    refreshRequests.push({ url, options, ...pending });
    return pending.promise;
  }
};
vm.runInNewContext(`
  const SB_SESSION_KEY='hc_sb_session_v1';
  const SUPABASE_URL='https://example.supabase.co';
  const SUPABASE_ANON_KEY='anon';
  let sbSession=null;
  let sbRefreshPromise=null;
  let sbRefreshContext=null;
  let dashboardSessionGeneration=0;
  let currentUserId=null;
  function clearDashboardSession(){dashboardSessionGeneration+=1;currentUserId=null;sbSession=null;sbRefreshPromise=null;sbRefreshContext=null;localStorage.removeItem(SB_SESSION_KEY);}
  ${script.slice(authStart, authEnd)}
  globalThis.authTest={
    install(data,generation,userId){dashboardSessionGeneration=generation;currentUserId=userId;sbRefreshPromise=null;sbRefreshContext=null;saveSupabaseSession(data);},
    replace(data,userId){currentUserId=userId;saveSupabaseSession(data);},
    signOut(){clearDashboardSession();},
    refresh(){return refreshSupabaseSession();},
    state(){return{generation:dashboardSessionGeneration,userId:currentUserId,session:sbSession,refreshPending:!!sbRefreshPromise};}
  };
`, authSandbox);

const sessionA = { access_token: 'access-a', refresh_token: 'refresh-a', expires_at: 1 };
const sessionB = { access_token: 'access-b', refresh_token: 'refresh-b', expires_at: 1 };
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const okRefreshResponse = (session) => ({ ok: true, status: 200, json: async () => session });

authSandbox.authTest.install(sessionA, 10, userA);
const signedOutRefresh = authSandbox.authTest.refresh();
check(JSON.parse(refreshRequests[0].options.body).refresh_token === 'refresh-a', 'refresh HTTP body uses the captured token');
authSandbox.authTest.signOut();
refreshRequests[0].resolve(okRefreshResponse({ access_token: 'access-a2', refresh_token: 'refresh-a2', expires_at: 9999999999 }));
let signoutRaceRejected = false;
try { await signedOutRefresh; } catch (err) { signoutRaceRejected = err?.staleSession === true; }
check(signoutRaceRejected && authSandbox.authTest.state().session === null && !authStorage.has('hc_sb_session_v1'), 'a refresh finishing after signout cannot restore the old session');

authSandbox.authTest.install(sessionA, 20, userA);
const oldAccountRefresh = authSandbox.authTest.refresh();
authSandbox.authTest.replace(sessionB, userB);
const newAccountRefresh = authSandbox.authTest.refresh();
check(refreshRequests.length === 3 && JSON.parse(refreshRequests[2].options.body).refresh_token === 'refresh-b', 'a new account does not reuse the old account refresh promise');
refreshRequests[1].resolve(okRefreshResponse({ access_token: 'access-a2', refresh_token: 'refresh-a2', expires_at: 9999999999 }));
let replacementRaceRejected = false;
try { await oldAccountRefresh; } catch (err) { replacementRaceRejected = err?.staleSession === true; }
check(replacementRaceRejected && authSandbox.authTest.state().session?.access_token === 'access-b' && authSandbox.authTest.state().refreshPending, 'an old refresh rejects without clearing the new account refresh slot');
refreshRequests[2].resolve(okRefreshResponse({ access_token: 'access-b2', refresh_token: 'refresh-b2', expires_at: 9999999999 }));
check(await newAccountRefresh === 'access-b2', 'the replacement account can complete its own refresh');
const replacementState = authSandbox.authTest.state();
check(replacementState.userId === userB && replacementState.session?.access_token === 'access-b2' && replacementState.session?.refresh_token === 'refresh-b2', 'an old refresh cannot overwrite a newly verified Auth identity');

const helperStart = script.indexOf('function esc(');
const helperEnd = script.indexOf('function openNew', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'render safety helpers are present');
const sandbox = { URL };
vm.runInNewContext(script.slice(helperStart, helperEnd), sandbox);

assert.equal(sandbox.esc(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
checks += 1;
check(sandbox.safeEventId('ev_123_safe') === 'ev_123_safe', 'safe local event IDs are accepted');
check(sandbox.safeEventId(`ev_bad');alert(1)//`) === '', 'script-bearing event IDs are rejected');
check(sandbox.safeEventId('550e8400-e29b-41d4-a716-446655440000') !== '', 'order UUIDs are accepted');
check(sandbox.safeHttpUrl('https://example.com/invoice') === 'https://example.com/invoice', 'HTTPS invoice links are accepted');
check(sandbox.safeHttpUrl('javascript:alert(1)') === '', 'script URLs are rejected');
check(sandbox.safeHttpUrl('http://example.com') === '', 'unencrypted invoice links are rejected');
check(sandbox.safeImageDataUrl('data:image/png;base64,AA==') !== '', 'small PNG data is accepted');
check(sandbox.safeImageDataUrl('data:image/svg+xml;base64,AA==') === '', 'SVG logo data is rejected');
check(!html.includes('src="${e.logo_data_url}"'), 'raw logo data is never placed in an image attribute');
check(!html.includes('href="${esc(e.invoice_url)}"'), 'raw invoice links are never rendered');

const queueStart = script.indexOf("const LEGACY_PENDING_KEY='hc_pending_deliveries'");
const queueEnd = script.indexOf('function saveEventsLocalOnly', queueStart);
const uuidDefinition = script.match(/const UUID_RE=\/[^\n]+;/)?.[0];
assert.ok(queueStart >= 0 && queueEnd > queueStart && uuidDefinition, 'queue implementation is present');
const queueStorage = new Map();
const queueSandbox = {
  URL,
  Date,
  crypto: globalThis.crypto,
  localStorage: {
    get length() { return queueStorage.size; },
    key(index) { return [...queueStorage.keys()][index] ?? null; },
    getItem(key) { return queueStorage.has(key) ? queueStorage.get(key) : null; },
    setItem(key, value) { queueStorage.set(key, String(value)); },
    removeItem(key) { queueStorage.delete(key); }
  }
};
vm.runInNewContext(`${script.slice(helperStart, helperEnd)}\n${uuidDefinition}\nlet currentUserId=null;let currentUserEmail=null;let currentRole=null;\n${script.slice(queueStart, queueEnd)}\nglobalThis.queueTest={setIdentity(userId,email,role){currentUserId=userId;currentUserEmail=email;currentRole=role;},key:pendingQueueKey,reviewKey:reviewQueueKey,load:loadQueue,save:saveQueue,loadReview:loadReviewQueue,quarantine:quarantineDeliveryItem,hasQuarantined:hasQuarantinedPendingQueue,newRequestId:createDeliveryRequestId};`, queueSandbox);
const validQueueItem = {
  deliveryRequestId: '11111111-1111-4111-8111-111111111111',
  orderId: '550e8400-e29b-41d4-a716-446655440000',
  signedAt: '2026-08-27T12:00:00.000Z',
  signedBy: 'Test Customer',
  dataUrl: 'data:image/png;base64,AA=='
};
queueSandbox.queueTest.setIdentity(null, null, null);
check(queueSandbox.queueTest.load().length === 0 && queueSandbox.queueTest.save([validQueueItem]) === false && queueStorage.size === 0, 'pre-auth queue reads and writes fail closed');
queueSandbox.queueTest.setIdentity(userA, 'same-email@example.com', 'owner');
check(queueSandbox.queueTest.save([validQueueItem]) === true && queueSandbox.queueTest.load().length === 1, 'an authenticated user can persist a validated signature');
const ownerQueueKey = queueSandbox.queueTest.key();
queueSandbox.queueTest.setIdentity(userB, 'same-email@example.com', 'team');
check(queueSandbox.queueTest.key() !== ownerQueueKey && queueSandbox.queueTest.load().length === 0, 'a recreated same-email Auth user cannot read the first Auth user queue');
queueStorage.set(queueSandbox.queueTest.key(), '{"not":"an array"}');
check(queueSandbox.queueTest.load().length === 0, 'non-array queue JSON fails safely');
queueStorage.set(queueSandbox.queueTest.key(), 'malformed json');
check(queueSandbox.queueTest.load().length === 0, 'malformed queue JSON fails safely');
queueSandbox.queueTest.setIdentity(userA, 'same-email@example.com', 'owner');
check(queueSandbox.queueTest.load()[0]?.deliveryRequestId === validQueueItem.deliveryRequestId, 'a delivery request UUID is persisted unchanged for every retry');
const generatedRequestA = queueSandbox.queueTest.newRequestId();
const generatedRequestB = queueSandbox.queueTest.newRequestId();
check(uuidDefinition.includes('/i') && generatedRequestA !== generatedRequestB && /^[0-9a-f-]{36}$/.test(generatedRequestA), 'new delivery request IDs are cryptographically generated UUIDs');

queueStorage.set('hc_pending_deliveries', JSON.stringify([validQueueItem]));
const oldEmailKey = 'hc_pending_deliveries_v2_' + encodeURIComponent('same-email@example.com');
queueStorage.set(oldEmailKey, JSON.stringify([validQueueItem]));
check(queueSandbox.queueTest.hasQuarantined() === true && queueStorage.has('hc_pending_deliveries') && queueStorage.has(oldEmailKey), 'legacy and v2 email queues remain preserved but untrusted');
check(queueSandbox.queueTest.load().length === 1, 'quarantined email queues never merge into the Auth-ID queue');
check(queueSandbox.queueTest.quarantine(validQueueItem, 409) === true && queueSandbox.queueTest.loadReview()[0]?.deliveryRequestId === validQueueItem.deliveryRequestId, 'permanent rejection preserves the full signature under the same Auth UUID');
queueSandbox.queueTest.setIdentity(userB, 'same-email@example.com', 'team');
check(queueSandbox.queueTest.loadReview().length === 0, 'a recreated same-email user cannot read the prior Auth user review queue');

check(/hc-deliveries-v6/.test(serviceWorker), 'service worker cache is bumped past the insecure shell');
check(/req\.mode === 'navigate'[\s\S]+fetch\(req\)[\s\S]+catch\(async \(\) => \(await caches\.match\(req\)\) \|\| caches\.match\('\.\/index\.html'\)\)/.test(serviceWorker), 'navigation and index HTML use network-first with offline fallback');
check(/return cached \|\| fromNet/.test(serviceWorker), 'static shell assets retain cache-first background refresh');

console.log(`dashboard client security checks: ${checks}/${checks} passed`);
