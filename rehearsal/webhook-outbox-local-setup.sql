-- ============================================================================
-- DISPOSABLE IN-MEMORY DATABASE ONLY. No real identities, orders, secrets or
-- credentials. Loaded by rehearsal/run-024-027-webhook-pglite.mjs.
--
-- Rebuilds the shape production is in TODAY (2026-09-10) for the parts that
-- migrations 024 and 027 touch:
--   * the three PostgREST roles and Supabase's bootstrap default privileges
--     (in Supabase every public table is GRANTed to anon/authenticated/
--     service_role and it is RLS, not GRANT, that protects it - so the
--     REVOKEs inside 024 and 027 only mean something when this is in place);
--   * auth.role() / auth.uid() / auth.users, copied by behaviour from
--     Supabase, because both migrations gate on auth.role();
--   * public.orders, shifts, shift_locations, field_workers, push_tokens and
--     push_queue, created by the repository's own migration files as written.
-- Migrations 020, 024, 026 and 027 are deliberately NOT applied here: that is
-- the live starting state this rehearsal has to begin from.
-- ============================================================================

do $guard$
begin
  -- A production database already has orders, and a hosted one has a network
  -- address. Either means this is not the throwaway in-memory rehearsal.
  if pg_catalog.inet_server_addr() is not null
     or pg_catalog.to_regclass('public.orders') is not null
     or pg_catalog.to_regclass('auth.users') is not null then
    raise exception using
      errcode = '55000',
      message = 'LOCAL REHEARSAL ONLY: this fixture refuses a networked or already-populated database';
  end if;
end
$guard$;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;

-- Supabase's bootstrap grants. Every table and function this role creates in
-- public is handed to the three API roles automatically.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- Supabase's helpers, copied by behaviour: both read the request settings
-- PostgREST fills in from the caller's JWT.
create function auth.role() returns text language sql stable as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$fn$;

create function auth.uid() returns uuid language sql stable as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$fn$;

create table auth.users (
  id uuid primary key,
  email text not null,
  email_confirmed_at timestamptz
);

-- The shipped runtime checks (rehearsal/006 and rehearsal/008) refuse to run
-- unless the database holds exactly this one confirmed rehearsal identity.
insert into auth.users (id, email, email_confirmed_at)
values (
  '00000000-0000-4000-8000-000000000001',
  'siddsaxena@gmail.com',
  '2026-01-01T00:00:00Z'
);
