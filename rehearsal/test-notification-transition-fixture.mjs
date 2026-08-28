import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = await readFile(
  new URL('001a_notification_device_transition_fixture.sql', import.meta.url),
  'utf8',
);

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

check(
  /SANDBOX ONLY/.test(fixture) && /^begin;/m.test(fixture) && /^commit;/m.test(fixture),
  'fixture is sandbox-only and transactional',
);
check(
  /after rehearsal 001 and migration 021[\s\S]*before migration 022/.test(fixture),
  'fixture pins the exact transition window',
);
check(
  /migration 021 is not installed/.test(fixture) &&
    /run this before migration 022/.test(fixture),
  'fixture fails closed outside migrations 021 and 022',
);
check(
  /expected exactly one confirmed Sidd Auth user/.test(fixture) &&
    /email_confirmed_at is not null/.test(fixture),
  'fixture requires one confirmed sandbox Auth user',
);
check(
  /unrelated roster or order data exists/.test(fixture) &&
    /worker@sandbox\.invalid/.test(fixture),
  'fixture rejects unrelated business data',
);
check(
  /rehearsal 001 fixture is missing/.test(fixture) &&
    /00000000-0000-4000-8000-000000000601/.test(fixture) &&
    /00000000-0000-4000-8000-000000000602/.test(fixture),
  'fixture requires the fixed open-shift rows from rehearsal 001',
);
check(
  /00000000-0000-4000-8000-000000000401/.test(fixture) &&
    /00000000-0000-4000-8000-000000000402/.test(fixture),
  'fixture names both fixed notification devices',
);
check(
  /00000000-0000-4000-8000-000000000501/.test(fixture) &&
    /00000000-0000-4000-8000-000000000502/.test(fixture) &&
    /expected only the two fixed Push-to-Start rows/.test(fixture),
  'fixture requires only the two expected Push-to-Start rows',
);
check(
  /unrelated or mismatched device authorization exists/.test(fixture),
  'fixture rejects foreign or mismatched authorizations',
);
check(
  /request\.jwt\.claim\.sub/.test(fixture) &&
    /request\.jwt\.claim\.role/.test(fixture) &&
    /request\.jwt\.claims/.test(fixture),
  'fixture derives the RPC caller from the linked Auth identity',
);
check(
  /perform \*[\s\S]*from public\.hc_authorize_notification_device\(v_device_id\)/.test(fixture),
  'fixture discards each one-time authorization capability',
);
check(
  !/select\s+(?:device_auth\.)?revoke_secret\b/i.test(fixture) &&
    !/raise\s+notice/i.test(fixture),
  'fixture never selects or prints a raw capability',
);
check(
  /octet_length\(device_auth\.revoke_secret_hash\) = 32/.test(fixture) &&
    /both fixture devices were not authorized exactly/.test(fixture),
  'fixture verifies two hashed active authorization rows',
);
check(
  /migration 022 authorization gate is not zero/.test(fixture) &&
    /public\.push_tokens/.test(fixture) &&
    /token_type = 'push_to_start'/.test(fixture),
  'fixture repeats both migration 022 destination gates',
);
check(
  !/\b(?:delete|truncate|drop)\s+(?:table\s+)?(?:from\s+)?public\./i.test(fixture),
  'fixture never deletes or drops public data',
);

console.log(`${checks}/${checks} notification transition fixture checks passed`);
