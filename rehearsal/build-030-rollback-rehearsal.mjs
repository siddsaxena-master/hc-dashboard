import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const forwardPath = join(repoRoot, 'migrations', '030_order_payment_integrity.sql');
const rollbackPath = join(repoRoot, 'migrations', '030_order_payment_integrity_rollback.sql');
const outputPath = join(here, '030_order_payment_integrity_rollback_rehearsal.sql');

const expectedHashes = {
  forward: '451bf850d2ed5a0321e6ea9acec4b7c064e358f62fab8f6d263d0a496cf4c27a',
  rollback: '30f18c59b1f5ef661077a594f8eb828b531eb9d344286018fed750101e7031d2',
};

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stripOuterTransaction(source, label) {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const beginLines = lines
    .map((line, index) => ({ line: line.trim().toLowerCase(), index }))
    .filter(({ line }) => line === 'begin;');
  const commitLines = lines
    .map((line, index) => ({ line: line.trim().toLowerCase(), index }))
    .filter(({ line }) => line === 'commit;');

  if (beginLines.length !== 1 || commitLines.length !== 1) {
    throw new Error(`${label} must contain exactly one standalone BEGIN and COMMIT`);
  }
  if (beginLines[0].index >= commitLines[0].index) {
    throw new Error(`${label} has an invalid transaction boundary order`);
  }

  return lines
    .filter((_, index) => index !== beginLines[0].index && index !== commitLines[0].index)
    .join('\n')
    .trim();
}

function countStandalone(sql, statement) {
  return sql
    .split('\n')
    .filter((line) => line.trim().toLowerCase() === statement.toLowerCase())
    .length;
}

const [forwardSource, rollbackSource] = await Promise.all([
  readFile(forwardPath, 'utf8'),
  readFile(rollbackPath, 'utf8'),
]);

const actualHashes = {
  forward: sha256(forwardSource),
  rollback: sha256(rollbackSource),
};

if (actualHashes.forward !== expectedHashes.forward) {
  throw new Error(`Forward migration hash changed: ${actualHashes.forward}`);
}
if (actualHashes.rollback !== expectedHashes.rollback) {
  throw new Error(`Rollback migration hash changed: ${actualHashes.rollback}`);
}

const forwardBody = stripOuterTransaction(forwardSource, 'Forward migration');
const rollbackBody = stripOuterTransaction(rollbackSource, 'Rollback migration');

const rehearsalSql = [
  '-- GENERATED FILE. DO NOT EDIT BY HAND.',
  '-- Installs migration 030 and its rollback inside one outer transaction.',
  '-- The final ROLLBACK guarantees that this rehearsal leaves no live objects.',
  '',
  'begin;',
  "set local idle_in_transaction_session_timeout = '30s';",
  '',
  '-- Exact reviewed forward migration body.',
  forwardBody,
  '',
  '-- Simulate the forward COMMIT dropping its temporary validation tables.',
  'drop table pg_temp.hc_030_expected_payment_checks;',
  'drop table pg_temp.hc_030_expected_void_checks;',
  '',
  '-- Exact reviewed rollback migration body.',
  rollbackBody,
  '',
  '-- This is intentionally the only terminal transaction statement.',
  'rollback;',
  '',
].join('\n');

const checks = {
  begin: countStandalone(rehearsalSql, 'begin;'),
  commit: countStandalone(rehearsalSql, 'commit;'),
  rollback: countStandalone(rehearsalSql, 'rollback;'),
  tempDrops: (rehearsalSql.match(/drop table pg_temp\.hc_030_expected_(?:payment|void)_checks;/gi) || []).length,
};

if (checks.begin !== 1 || checks.commit !== 0 || checks.rollback !== 1 || checks.tempDrops !== 2) {
  throw new Error(`Unsafe rehearsal shape: ${JSON.stringify(checks)}`);
}

await writeFile(outputPath, rehearsalSql, 'utf8');

console.log(JSON.stringify({
  outputPath,
  sourceHashes: actualHashes,
  rehearsalHash: sha256(rehearsalSql),
  checks,
}, null, 2));
