// Disposable LOCAL Docker PostgreSQL only. No published ports or file mounts.
// Run: node rehearsal/run-calendar-logo-local.mjs postgres:17-alpine
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
if (!/^postgres:(?:\d+(?:\.\d+)*(?:-alpine)?|alpine)$/.test(image || '')) {
  throw new Error('Pass an explicitly selected official postgres image tag.');
}
const name = 'hc-calendar-logo-rehearsal-20260906';
const label = 'hc-calendar-logo-local-rehearsal';
const db = 'hc_calendar_logo_rehearsal';
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
function docker(args, input, timeout = 30000) {
  return execFileSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
}
function sql(text) {
  return docker(['exec', '-i', name, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], text);
}
let created = false;
try {
  const context = docker(['context', 'show']).trim();
  const endpoint = docker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  const localEndpoint = (value) => /^(?:npipe|unix):\/\//.test(value);
  if (!localEndpoint(endpoint) || (process.env.DOCKER_HOST && !localEndpoint(process.env.DOCKER_HOST))) {
    throw new Error('Refusing a remote Docker endpoint. This rehearsal is local only.');
  }
  console.log('Starting isolated local PostgreSQL with no ports, mounts, or external network.');
  docker(['run', '-d', '--name', name, '--label', `com.hamptonscoconuts.purpose=${label}`,
    '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${db}`, image]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', db], undefined, 5000); ready = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  if (!ready) throw new Error('Local PostgreSQL did not become ready.');
  sql(setup + '\n' + projection);
  console.log('Applying real 034 and 035, then rerunning both.');
  sql(migration034 + '\n' + migration035 + '\n' + migration034 + '\n' + migration035);
  console.log(sql(checks));
  console.log('Testing refusal to convert an existing public logo bucket.');
  sql("update storage.buckets set public=true where id='order-logos';");
  let refused = false;
  try { sql(migration035); }
  catch (error) {
    if (String(error.stderr || '').includes('035 refuses an existing public logo bucket')) refused = true;
    else throw error;
  }
  if (!refused) throw new Error('Existing public logo bucket was not refused.');
  sql("select public.rehearsal_assert((select public is true from storage.buckets where id='order-logos'), 'public bucket remained unchanged when migration refused it');");
  console.log('PASS: local SQL apply/rerun, real role permissions, safe projections, and public-bucket refusal.');
} finally {
  if (created) {
    const actualLabel = docker(['inspect', '--format', '{{ index .Config.Labels "com.hamptonscoconuts.purpose" }}', name]).trim();
    if (actualLabel !== label) throw new Error('Refusing cleanup: disposable container ownership label differs.');
    docker(['rm', '-f', name]);
    console.log('Removed only the labeled disposable test container and its temporary database.');
  }
}
