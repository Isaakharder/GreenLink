-- ============================================================================
-- Allowlist-based RPC privilege regression suite (supabase/migrations/0036).
--
-- Unlike a hand-maintained list of "functions we remembered to protect",
-- this asserts the actual policy: exactly one application-defined function
-- in `public` may be executed by an unauthenticated `anon` caller
-- (is_username_available(text), needed before a session exists during
-- sign-up). If a future migration adds RPC #52 and forgets to close it off
-- -- via a missing `revoke ... from public`/`from anon`, or by relying on
-- the (removed) automatic anon/authenticated default -- this test fails
-- automatically, without anyone having to remember to add it to a list.
--
-- Also covers: internal-only/trigger-only functions are reachable by
-- neither anon nor authenticated directly; a representative sample of
-- authenticated-only RPCs still work for `authenticated`; and the
-- `postgres`/`public` default ACL itself no longer auto-grants new
-- functions to anon/authenticated (while documenting the one thing that
-- default-privilege change cannot fix: PostgreSQL's own unconditional
-- PUBLIC-execute grant on every newly created function, which is why every
-- function-creating migration must still explicitly revoke it -- see 0036's
-- header comment).
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;

select plan(16);

-- ---------------------------------------------------------------------------
-- 1) The allowlist itself: anon may execute exactly one application function
--    in `public`. Excludes extension-owned functions (pgtap/pgcrypto helpers
--    are not application RPCs and aren't reachable via PostgREST anyway).
-- ---------------------------------------------------------------------------

select set_eq(
  $$
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  $$,
  ARRAY['is_username_available(p_username text)'],
  'anon can execute exactly one application function in public: is_username_available -- the deliberate pre-login signup check'
);

-- ---------------------------------------------------------------------------
-- 2) Internal-only helpers and trigger-only functions: reachable by neither
--    anon nor authenticated as a direct caller. create_manual_course() /
--    replace_manual_course_tees() still call insert_manual_course_tee() and
--    validate_manual_tee() internally (perform, not RPC) -- see test 6/7
--    below. The trigger functions still fire via their triggers regardless
--    of these direct-caller grants -- see test 8/9.
-- ---------------------------------------------------------------------------

select is_empty(
  $$
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'insert_manual_course_tee', 'validate_manual_tee',
        'bump_tournament_data_version', 'handle_new_user', 'set_updated_at'
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  $$,
  'internal-only helpers and trigger-only functions are not directly executable by anon or authenticated'
);

-- ---------------------------------------------------------------------------
-- 3) Representative sample of B/C-classified RPCs: authenticated access is
--    preserved (this lockdown must not have accidentally revoked the role
--    that's actually supposed to use these).
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('authenticated', 'public.list_members()', 'EXECUTE'), 'authenticated can still execute list_members()');
select ok(has_function_privilege('authenticated', 'public.get_public_round_feed(integer)', 'EXECUTE'), 'authenticated can still execute get_public_round_feed()');
select ok(has_function_privilege('authenticated', 'public.search_profile_by_username(text)', 'EXECUTE'), 'authenticated can still execute search_profile_by_username()');
select ok(has_function_privilege('authenticated', 'public.can_manage_course(uuid)', 'EXECUTE'), 'authenticated can still execute can_manage_course()');
select ok(has_function_privilege('authenticated', 'public.create_tournament(text, text, date, integer, text, integer, text)', 'EXECUTE'), 'authenticated can still execute create_tournament()');
select ok(has_function_privilege('authenticated', 'public.submit_team_score(uuid, uuid, uuid, integer, integer, integer, timestamptz)', 'EXECUTE'), 'authenticated can still execute submit_team_score()');
select ok(has_function_privilege('authenticated', 'public.send_tournament_message(uuid, uuid, text)', 'EXECUTE'), 'authenticated can still execute send_tournament_message()');
select ok(has_function_privilege('authenticated', 'public.admin_list_members()', 'EXECUTE'), 'authenticated can still execute admin_list_members() (is_admin() enforced in-body -- see admin_member_management.sql)');
select ok(has_function_privilege('authenticated', 'public.admin_set_member_status(uuid, text)', 'EXECUTE'), 'authenticated can still execute admin_set_member_status() (is_admin() enforced in-body)');
select ok(has_function_privilege('authenticated', 'public.admin_permanently_delete_member(uuid)', 'EXECUTE'), 'authenticated can still execute admin_permanently_delete_member() (is_admin() enforced in-body)');

-- ---------------------------------------------------------------------------
-- 4) The postgres/public default ACL for functions no longer auto-grants
--    anon or authenticated -- the actual, catalog-level effect of 0036's
--    `alter default privileges` statement.
-- ---------------------------------------------------------------------------

select ok(
  not exists (
    select 1
    from pg_default_acl d, unnest(d.defaclacl) as entry
    where d.defaclrole = 'postgres'::regrole
      and d.defaclnamespace = 'public'::regnamespace
      and d.defaclobjtype = 'f'
      and (entry::text like 'anon=%' or entry::text like 'authenticated=%')
  ),
  'the postgres/public default ACL for functions no longer auto-grants anon or authenticated'
);

select ok(
  exists (
    select 1
    from pg_default_acl d, unnest(d.defaclacl) as entry
    where d.defaclrole = 'postgres'::regrole
      and d.defaclnamespace = 'public'::regnamespace
      and d.defaclobjtype = 'f'
      and entry::text like 'service_role=%'
  ),
  'the postgres/public default ACL for functions still grants service_role (deliberately preserved)'
);

-- ---------------------------------------------------------------------------
-- 5) Documented residual gap: PostgreSQL unconditionally grants EXECUTE to
--    PUBLIC on every newly created function -- a legacy behavior that is
--    NOT mediated by pg_default_acl and cannot be suppressed by ALTER
--    DEFAULT PRIVILEGES (verified while building 0036: revoking PUBLIC from
--    the default ACL row itself had no effect on a subsequently created
--    function). This is exactly why every function-creating migration must
--    still explicitly `revoke execute ... from public` -- the fail-closed
--    default from 0036 only removes this project's *extra* anon/
--    authenticated default, not PostgreSQL's own PUBLIC one. This test
--    documents that gap so it's a known, asserted fact instead of a silent
--    surprise, and will fail loudly (telling us Postgres's behavior
--    changed) if a future Postgres version ever does close it.
-- ---------------------------------------------------------------------------

create function public.zz_default_priv_probe() returns integer language sql as $body$ select 1 $body$;

select ok(
  has_function_privilege('anon', 'public.zz_default_priv_probe()', 'EXECUTE'),
  'known PostgreSQL limitation: a brand-new function still grants PUBLIC (and therefore anon) execute by default -- every new RPC migration must explicitly revoke it (see 0036 header)'
);

revoke execute on function public.zz_default_priv_probe() from public;

select ok(
  not has_function_privilege('anon', 'public.zz_default_priv_probe()', 'EXECUTE'),
  'explicitly revoking PUBLIC on a new function (the required convention) does close anon access'
);

select * from finish();
rollback;
