import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = await Promise.all([
  '010_legacy_end_cutover_seed.sql',
  '010a_legacy_end_open_shift_guard_check.sql',
  '010b_legacy_end_rollback_check.sql',
  '011_legacy_end_failed_cutover_check.sql',
  '012_legacy_end_successful_cutover_check.sql',
  '013_legacy_end_claim_check.sql',
].map((name) => readFile(new URL(name, import.meta.url), 'utf8')).concat([
  readFile(new URL('../migrations/015a_closed_live_activity_end_preservation.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/015a_closed_live_activity_end_preservation_rollback.sql', import.meta.url), 'utf8'),
]));

const [seed, openShiftGuard, rollbackCheck, failedCutover, successfulCutover, endClaim, preservation, preservationRollback] = files;
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

check(/SANDBOX ONLY/.test(seed) && /^begin;/m.test(seed) && /^commit;/m.test(seed), 'seed is sandbox guarded and transactional');
check(/after 015 and before 015a, 016, or 017/.test(seed), 'seed pins the exact migration window');
check(/one confirmed linked owner is required/.test(seed) && /active roster links and a zero-open-shift baseline/.test(seed), 'seed requires a safe linked zero-shift baseline');
check((seed.match(/'activity_update'::text/g) || []).length === 4 && (seed.match(/'push_to_start'::text/g) || []).length === 1, 'seed covers four update cases and one future-start case');
check(seed.includes("'bad-token'"), 'seed includes the malformed closed negative case');
check(seed.includes("'00000000-0000-4000-8000-0000000015ff'::uuid"), 'seed includes an orphan shift case');

check(/every shift must be clocked out for the maintenance cutover/.test(preservation), '015a refuses a cutover while any shift is open');
check(/closed-shift END address would not survive migration 016/.test(preservation), '015a refuses an ineligible notification identity');
check(/unrecorded self-equal device identity already exists/.test(preservation), '015a distinguishes recovery IDs from pre-existing device identities');
check(/hc_migration_private\.live_activity_end_015a/.test(preservation), '015a records private per-row provenance');
check(/hc_migration_private\.live_activity_end_015a as marker/.test(preservationRollback), 'rollback changes only rows joined to provenance');
check(/changed row count did not match provenance/.test(preservationRollback), 'rollback requires an exact provenance row count');
check(/delete from hc_migration_private\.live_activity_end_015a/.test(preservationRollback) && /private provenance cleanup was incomplete/.test(preservationRollback), 'rollback clears only its private proof rows after exact restoration');

check(/EXPECTED-TO-FAIL attempt at migration 015a/.test(openShiftGuard), 'open-shift phase expects 015a to fail');
check(/failed 015a changed a recovery identity/.test(openShiftGuard), 'open-shift phase proves 015a rolled back token changes');
check(/failed 015a committed provenance/.test(openShiftGuard), 'open-shift phase proves 015a rolled back provenance');
check((openShiftGuard.match(/delete from public\./g) || []).length === 2 && openShiftGuard.includes('00000000-0000-4000-8000-000000001502'), 'open-shift cleanup deletes only the fixed token and shift');

check(/rollback left private provenance rows/.test(rollbackCheck), 'rollback phase requires empty private provenance');
check(/rollback did not restore four legacy-null rows/.test(rollbackCheck), 'rollback phase requires all four remaining legacy rows restored');
check(/pre-016 and pre-017 window/.test(rollbackCheck) && /^rollback;/m.test(rollbackCheck), 'rollback phase verifies the exact migration window without retaining changes');

check(/EXPECTED-TO-FAIL/.test(failedCutover) && /migration 016 did not roll back/.test(failedCutover), 'negative phase expects and verifies a rolled-back 016');
check(/failed 016 did not restore every fixture row/.test(failedCutover) && /\) <> 4 then/.test(failedCutover), 'negative phase verifies atomic rollback of all four remaining rows');
check((failedCutover.match(/delete from public\./g) || []).length === 2 && failedCutover.includes('00000000-0000-4000-8000-000000001505'), 'negative cleanup deletes only the fixed malformed token and its shift');

check(/valid closed END address did not survive 016/.test(successfulCutover), 'positive phase requires the closed END survivor');
check(/an unsafe truth-table token survived 016/.test(successfulCutover), 'positive phase rejects every unsafe survivor');
check(/^rollback;/m.test(successfulCutover), 'positive verification is read-only and rolls back');

check(/hc_claim_live_activity_ends/.test(endClaim), '017 phase calls the real durable END claim');
check(/queue_id is not null/.test(endClaim), '017 phase requires a durable queue identity');
check(!/select\s+(?:claimed\.)?token\b/i.test(endClaim), '017 phase never prints the raw Apple token');
check(/^rollback;/m.test(endClaim), '017 claim verification rolls back its lease');

console.log(`${checks}/${checks} legacy END preservation checks passed`);
