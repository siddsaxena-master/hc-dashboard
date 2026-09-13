// In-memory PostgreSQL rehearsal only. This runner has no connection URL option.
// Install @electric-sql/pglite@0.5.8 in a separate temporary directory, then run:
// node rehearsal/run-calendar-logo-pglite.mjs <absolute temporary package directory>
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = process.argv[2];
if (!packageDir || !isAbsolute(packageDir) || process.argv.length !== 3) {
  throw new Error('Pass only the absolute local directory for the temporary PGlite package.');
}
const packageInfo = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
if (packageInfo.name !== '@electric-sql/pglite' || packageInfo.version !== '0.5.8') {
  throw new Error('This rehearsal requires the reviewed temporary @electric-sql/pglite version 0.5.8.');
}
const { PGlite } = await import(pathToFileURL(join(packageDir, 'dist/index.js')).href);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const [setup, checks, original, migration034, migration035] = await Promise.all([
  readFile(join(here, 'calendar-logo-local-setup.sql'), 'utf8'),
  readFile(join(here, 'calendar-logo-local-checks.sql'), 'utf8'),
  readFile(join(root, 'migrations/019_dashboard_auth_transition.sql'), 'utf8'),
  readFile(join(root, 'migrations/034_calendar_delivery_details.sql'), 'utf8'),
  readFile(join(root, 'migrations/035_order_logo_assets.sql'), 'utf8'),
]);
const from = original.indexOf('create or replace function public.hc_list_orders_for_current_user(');
const to = original.indexOf('-- Delivery confirmation is the one write allowed', from);
if (from < 0 || to < 0) throw new Error('Cannot extract the real 019 order reader and grants.');
const projection = original.slice(from, to);
function inMemoryFixture(sql) {
  // PGlite initializes only its default database. Adapt only the fixture guard
  // in memory, never the checked-in SQL or the actual changes under test.
  const guard = "current_database() <> 'hc_calendar_logo_rehearsal'";
  if (sql.split(guard).length !== 2) throw new Error('Expected exactly one local fixture name guard.');
  return sql.replace(guard, "current_database() <> 'postgres'");
}
let db;
let passedAssertions = 0;
const queryOptions = { onNotice(notice) {
  if (notice.message.startsWith('PASS:')) {
    passedAssertions++;
    console.log(notice.message);
  }
} };

try {
  // No dataDir, filesystem, environment-derived settings, or live URL is used.
  db = await PGlite.create();
  const identity = await db.query('select current_database() as name, version() as version');
  if (identity.rows[0].name !== 'postgres' || !identity.rows[0].version.includes('(PGlite 0.5.8)')) {
    throw new Error('Refusing to run fixtures outside the verified in-memory PGlite database.');
  }
  console.log('Running only synthetic data in a verified in-memory PostgreSQL database.');
  console.log(identity.rows[0].version);
  await db.exec(inMemoryFixture(setup) + '\n' + projection, queryOptions);
  console.log('Applying real 034 and 035, then rerunning both.');
  for (const migration of [migration034, migration035, migration034, migration035]) {
    await db.exec(migration, queryOptions);
  }
  await db.exec(inMemoryFixture(checks), queryOptions);
  console.log('Checking refusal to alter an existing public logo bucket.');
  await db.exec("update storage.buckets set public=true where id='order-logos';");
  let refused = false;
  try { await db.exec(migration035); }
  catch (error) {
    if (String(error.message).includes('035 refuses an existing public logo bucket')) {
      refused = true;
      await db.exec('rollback;');
    } else throw error;
  }
  if (!refused) throw new Error('Existing public logo bucket was not refused.');
  await db.exec("select public.rehearsal_assert((select public is true from storage.buckets where id='order-logos'), 'public bucket remains unchanged after refused migration');", queryOptions);
  console.log(`PASS: ${passedAssertions} runtime assertions, apply/rerun and public-bucket refusal.`);
  console.log('Limit: this tests real SQL roles and rules, not the Supabase Storage HTTP API or an iPhone.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
  console.log('Closed the in-memory test database. No live data was used or changed.');
}
