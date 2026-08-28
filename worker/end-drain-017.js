// Temporary migration-017 Live Activity END producer.
//
// This module is intentionally scheduled-only. It has no fetch handler and is
// deployed under its own non-public Worker configuration. It calls the
// service-role-only migration-017 claim function, then writes one stable queue
// row for each exact ActivityKit update token. Remove the scheduled deployment
// after the pre-021 drain gate reaches zero.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32,512}$/i;
const LIVE_ACTIVITY_TOPIC =
  'com.hamptonscoconuts.field.push-type.liveactivity';
// One row can consume five database requests in the worst definite-failure
// path: two inserts, two verification reads, and one exact lease release.
// Eight rows plus the claim request stays below a conservative 50-request tick.
const CLAIM_LIMIT = 8;
const DEFAULT_MAX_BATCHES = 1;
const MAX_BATCHES_CAP = 1;
const END_LEASE_MS = 30 * 60 * 1000;

function serviceHeaders(env, extras = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    ...extras,
  };
}

function baseUrl(env) {
  const url = String(env && env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env && env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }
  return url;
}

function boundedBatchCount(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_BATCHES;
  return Math.min(parsed, MAX_BATCHES_CAP);
}

function validDate(value) {
  return Number.isFinite(Date.parse(String(value || '')));
}

function exactClaimIdentity(row) {
  const tokenId = String(row && row.token_id || '');
  const queueId = String(row && row.queue_id || '');
  const shiftId = String(row && row.shift_id || '');
  const token = String(row && row.token || '').toLowerCase();
  if (!UUID_RE.test(tokenId) || !UUID_RE.test(queueId) ||
      !UUID_RE.test(shiftId) || !TOKEN_RE.test(token)) {
    return null;
  }
  return { tokenId, queueId, shiftId, token };
}

function shiftMinutes(row) {
  const clockIn = Date.parse(String(row.clock_in_at || ''));
  const clockOut = Date.parse(String(row.clock_out_at || ''));
  if (!Number.isFinite(clockIn) || !Number.isFinite(clockOut)) return null;
  return Math.max(0, Math.floor((clockOut - clockIn) / 60000));
}

export function buildEndQueueRow(tokenRow, claimStamp, nowMs = Date.now()) {
  const identity = exactClaimIdentity(tokenRow);
  const minutes = shiftMinutes(tokenRow || {});
  if (!identity || minutes === null || !validDate(claimStamp)) return null;

  const payload = {
    tokens: [identity.token],
    headers: {
      topic: LIVE_ACTIVITY_TOPIC,
      push_type: 'liveactivity',
      priority: 10,
      collapse_id: identity.queueId,
    },
    aps: {
      timestamp: Math.floor(nowMs / 1000),
      event: 'end',
      'content-state': {
        status: 'Clocked out',
        statusMinutes: minutes,
        boxesLine: 'Shift ended',
      },
      'dismissal-date': Math.floor(nowMs / 1000) - 1,
    },
    telegram_text: null,
    fallback_chat_ids: [],
    live_activity_token_id: identity.tokenId,
    live_activity_shift_id: identity.shiftId,
    live_activity_queue_id: identity.queueId,
    live_activity_end_requested_at: claimStamp,
  };

  return {
    id: identity.queueId,
    kind: 'la_end',
    payload,
  };
}

function sameQueueIdentity(found, wanted) {
  if (!found || found.id !== wanted.id || found.kind !== 'la_end') return false;
  const payload = found.payload;
  const wantedPayload = wanted.payload;
  return Boolean(payload && typeof payload === 'object' &&
    Array.isArray(payload.tokens) && payload.tokens.length === 1 &&
    payload.tokens[0] === wantedPayload.tokens[0] &&
    payload.live_activity_token_id === wantedPayload.live_activity_token_id &&
    payload.live_activity_shift_id === wantedPayload.live_activity_shift_id &&
    payload.live_activity_queue_id === wantedPayload.live_activity_queue_id &&
    payload.live_activity_end_requested_at ===
      wantedPayload.live_activity_end_requested_at);
}

async function verifyQueueRow(env, wanted) {
  try {
    const response = await fetch(
      baseUrl(env) + '/rest/v1/push_queue?id=eq.' +
        encodeURIComponent(wanted.id) + '&select=id,kind,payload&limit=1',
      { headers: serviceHeaders(env) },
    );
    if (!response.ok) return { known: false, present: false };
    const rows = await response.json();
    if (!Array.isArray(rows)) return { known: false, present: false };
    if (!rows.length) return { known: true, present: false };
    if (rows.some((row) => sameQueueIdentity(row, wanted))) {
      return { known: true, present: true };
    }
    throw new Error('queue UUID collision with a different END identity');
  } catch (error) {
    if (String(error && error.message || '').includes('UUID collision')) throw error;
    return { known: false, present: false };
  }
}

// Returns inserted, verified, unknown, or failed. Unknown deliberately retains
// the token lease because the INSERT may have committed before its response was
// lost. Migration 017 will not create an overlapping queue row while that exact
// pending UUID exists.
export async function enqueueEndQueue(env, row) {
  let finalVerification = { known: false, present: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(baseUrl(env) + '/rest/v1/push_queue', {
        method: 'POST',
        headers: serviceHeaders(env, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=minimal',
        }),
        body: JSON.stringify(row),
      });
      if (response.ok) return 'inserted';
      console.error('end-drain-017 queue insert failed:', response.status);
    } catch (error) {
      console.error('end-drain-017 queue insert response unavailable');
    }

    finalVerification = await verifyQueueRow(env, row);
    if (finalVerification.present) return 'verified';
  }
  return finalVerification.known ? 'failed' : 'unknown';
}

export async function releaseEndClaim(env, tokenRow, claimStamp) {
  const identity = exactClaimIdentity(tokenRow);
  if (!identity || !validDate(claimStamp)) return false;
  try {
    const response = await fetch(
      baseUrl(env) + '/rest/v1/live_activity_tokens' +
        '?id=eq.' + encodeURIComponent(identity.tokenId) +
        '&token=eq.' + encodeURIComponent(identity.token) +
        '&token_type=eq.activity_update' +
        '&shift_id=eq.' + encodeURIComponent(identity.shiftId) +
        '&end_queue_id=eq.' + encodeURIComponent(identity.queueId) +
        '&end_requested_at=eq.' + encodeURIComponent(claimStamp),
      {
        method: 'PATCH',
        headers: serviceHeaders(env, {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify({
          end_requested_at: null,
          end_queue_id: null,
        }),
      },
    );
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length === 1;
  } catch (error) {
    console.error('end-drain-017 exact lease release failed');
    return false;
  }
}

export async function claimEndBatch(env, claimStamp, staleStamp) {
  const response = await fetch(
    baseUrl(env) + '/rest/v1/rpc/hc_claim_live_activity_ends',
    {
      method: 'POST',
      headers: serviceHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        p_claimed_at: claimStamp,
        p_stale_before: staleStamp,
        p_limit: CLAIM_LIMIT,
      }),
    },
  );
  if (!response.ok) {
    throw new Error('migration-017 END claim failed with status ' + response.status);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('END claim returned a non-array');
  return rows;
}

export async function runEndDrain017(env, options = {}) {
  baseUrl(env);
  const maxBatches = boundedBatchCount(
    options.maxBatches || env.END_DRAIN_MAX_BATCHES,
  );
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const stats = {
    batches: 0,
    claimed: 0,
    queued: 0,
    retainedUnknown: 0,
    released: 0,
    malformed: 0,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const batchNow = now();
    const claimStamp = new Date(batchNow).toISOString();
    const staleStamp = new Date(batchNow - END_LEASE_MS).toISOString();
    const claimedRows = await claimEndBatch(env, claimStamp, staleStamp);
    stats.batches++;
    stats.claimed += claimedRows.length;

    for (const tokenRow of claimedRows) {
      const queueRow = buildEndQueueRow(tokenRow, claimStamp, batchNow);
      if (!queueRow) {
        stats.malformed++;
        if (await releaseEndClaim(env, tokenRow, claimStamp)) stats.released++;
        continue;
      }

      try {
        const result = await enqueueEndQueue(env, queueRow);
        if (result === 'inserted' || result === 'verified') {
          stats.queued++;
        } else if (result === 'unknown') {
          stats.retainedUnknown++;
        } else if (await releaseEndClaim(env, tokenRow, claimStamp)) {
          stats.released++;
        }
      } catch (error) {
        // A UUID collision or other uncertain ownership state must retain the
        // lease for operator inspection. Releasing it could overlap a send.
        stats.retainedUnknown++;
        console.error('end-drain-017 retained an uncertain exact lease');
      }
    }

    if (claimedRows.length < CLAIM_LIMIT) break;
  }
  console.log('end-drain-017 tick:', JSON.stringify(stats));
  return stats;
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(runEndDrain017(env));
  },
};
