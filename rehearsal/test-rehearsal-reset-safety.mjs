import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const reset = await readFile(
  new URL('./000_reset_rehearsal.sql', import.meta.url),
  'utf8',
);

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

check(
  /SANDBOX ONLY/.test(reset) && /gfbtxfwavninuapjzksk/.test(reset),
  'reset names the one disposable Supabase target',
);
check(
  !/omdcfphbwuwsrffdszlg/.test(reset),
  'reset never names the production project',
);
check(
  /^begin;/m.test(reset) && /^commit;/m.test(reset),
  'all reset DDL is transactional',
);
check(
  /lock_timeout = '5s'/.test(reset) && /statement_timeout = '5min'/.test(reset),
  'reset has bounded lock and execution time',
);
check(
  /count\(\*\) from auth\.users\) <> 1/.test(reset)
    && /lower\(auth_user\.email\) = 'siddsaxena@gmail\.com'/.test(reset)
    && /email_confirmed_at is not null/.test(reset),
  'guard requires exactly one confirmed rehearsal Auth user',
);
check(
  /to_regclass\('public\.orders'\) is null/.test(reset)
    && /to_regclass\('public\.field_workers'\) is null/.test(reset)
    && /to_regclass\('public\.shifts'\) is null/.test(reset)
    && /to_regclass\('public\.live_activity_tokens'\) is null/.test(reset),
  'first reset fails if the expected prior rehearsal tables are absent',
);
check(
  /unrelated field_workers rows exist/.test(reset)
    && /'worker@sandbox\.invalid'/.test(reset)
    && /00000000-0000-4000-8000-000000000103/.test(reset),
  'roster guard permits only the known owner and fixed sandbox worker',
);
check(
  /unrelated orders rows exist/.test(reset)
    && /client_name not like 'Sandbox %'/.test(reset)
    && /00000000-0000-4000-8000-00000000\[0-9a-f\]\{4\}/.test(reset),
  'order guard permits only fixed synthetic rehearsal rows',
);
check(
  /hc_reset_public_schema_before/.test(reset)
    && /namespace\.nspowner/.test(reset)
    && /namespace\.nspacl/.test(reset),
  'reset snapshots public schema ownership and ACL',
);
check(
  /hc_reset_public_defaults_before/.test(reset)
    && /pg_catalog\.pg_default_acl/.test(reset)
    && /except all/.test(reset),
  'reset snapshots and compares public default privileges in both directions',
);
check(
  !/drop\s+schema\s+(?:if\s+exists\s+)?public/i.test(reset),
  'reset never drops or recreates the public schema',
);
check(
  !/drop\s+owned/i.test(reset),
  'reset never uses broad role-owned deletion',
);
check(
  /namespace\.nspname = 'public'/.test(reset)
    && /'drop %s if exists %I\.%I cascade'/.test(reset),
  'dynamic relation drops are schema-qualified to public',
);
check(
  /dependency\.refclassid =\s*\n?\s*'pg_catalog\.pg_extension'::pg_catalog\.regclass/.test(reset)
    && /dependency\.deptype = 'e'/.test(reset),
  'extension-owned relations, routines, and types are excluded',
);
check(
  /hc_reset_public_extensions_before/.test(reset)
    && /an extension-owned public object changed/.test(reset),
  'final assertions prove extension-owned public objects survived',
);
check(
  /drop schema if exists hc_migration_private cascade;/.test(reset),
  'reset removes only the migration-private schema outside public',
);
check(
  !/(?:delete|truncate|update|insert\s+into)\s+(?:table\s+)?auth\.users/i.test(reset),
  'reset never writes to the Auth users table',
);
check(
  /join pg_temp\.hc_reset_auth_user_before/.test(reset)
    && /the confirmed rehearsal Auth user changed/.test(reset),
  'final assertions prove the same Auth user survived',
);
check(
  /public schema ownership or ACL changed/.test(reset)
    && /public default privileges changed/.test(reset),
  'final assertions prove public access state survived',
);
check(
  /non-extension public objects remain/.test(reset)
    && /hc_migration_private still exists/.test(reset),
  'final assertions require a clean rehearsal result',
);
check(
  /'passed'::text as rehearsal_reset/.test(reset)
    && /1::integer as preserved_auth_users/.test(reset),
  'success output is small and does not expose an Auth identifier',
);

console.log(`${checks}/${checks} rehearsal reset safety checks passed`);
