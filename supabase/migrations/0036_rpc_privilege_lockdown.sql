-- ============================================================================
-- RPC privilege lockdown.
--
-- Investigation summary: every application-defined function in `public` was
-- found to carry an explicit EXECUTE grant to `anon` in production, even
-- functions whose own migration only ever wrote `grant execute ... to
-- authenticated` (or `revoke execute ... from public`, which does NOT touch
-- a role's own separately-recorded grant). The cause is a pre-existing
-- default ACL on this project, applied once, outside of any migration file:
--
--   alter default privileges for role postgres in schema public
--     grant execute on functions to anon, authenticated, service_role;
--
-- `postgres` is the role every migration creates functions as, so every
-- function ever created here picked up its own independent `anon` grant at
-- CREATE FUNCTION time -- a grant that a later `revoke ... from public`
-- cannot remove, because `public` (the pseudo-role meaning "everyone with no
-- other applicable grant") and `anon` (a real role with a direct grant) are
-- different ACL entries entirely.
--
-- IMPORTANT, empirically verified while building this migration: PostgreSQL
-- separately, unconditionally grants EXECUTE on every newly created function
-- to the PUBLIC pseudo-role -- a legacy behavior baked into CREATE FUNCTION
-- itself, NOT mediated through pg_default_acl at all. `alter default
-- privileges ... revoke execute on functions from public` does not change
-- this (tested directly: a function created immediately afterward still
-- came back with an explicit PUBLIC grant in its ACL). This is why almost
-- every function in this codebase's history already does
-- `revoke execute on function X from public;` right after `create function`
-- -- that per-function revoke is the ONLY mechanism that works, and it is
-- NOT optional. The six functions below that were still anon-reachable even
-- after revoking `anon` directly (bump_tournament_data_version,
-- get_public_round_feed, handle_new_user, has_public_personal_round,
-- is_public_personal_round, set_updated_at) are exactly the six whose
-- original migration skipped that per-function `revoke ... from public`
-- step.
--
-- GreenLink is a private, invite-only members club: an unauthenticated
-- caller should not be able to invoke member/tournament/account RPCs unless
-- there is a deliberate, product-level reason (there is exactly one:
-- `is_username_available`, needed before a session exists at all, during
-- sign-up). This migration:
--
--   1. Fixes the `postgres`-role default ACL going forward: new functions
--      created by `postgres` in `public` no longer automatically receive
--      the project's own bonus `anon`/`authenticated` grants (the ones
--      responsible for 45 of the 51 functions below already being
--      anon-reachable despite most of them properly revoking `public`).
--      This closes that specific extra exposure for every future function,
--      but -- per the note above -- does NOT excuse a future migration from
--      still explicitly revoking EXECUTE from `public` on any function that
--      shouldn't be world-callable. The allowlist pgTAP test added alongside
--      this migration is the actual backstop that catches a forgotten
--      revoke, on `public` or otherwise, before it reaches production.
--   2. Explicitly revokes `anon` (and, for the six affected above, `public`
--      directly) from every existing function that should only ever run as
--      an authenticated GreenLink member (classified B/C in the audit) or
--      as neither role at all (internal-only helpers, trigger functions).
--      `authenticated` access is left exactly as each function's own
--      migration already granted it -- this migration adds no new
--      capability to any authenticated member, and does not touch the
--      ownership/organizer/player authorization logic already inside each
--      function body.
--   3. Leaves `is_username_available(text)` untouched (still anon +
--      authenticated -- pre-login signup availability check).
--   4. Leaves the `supabase_admin`-owned default ACL and every non-public
--      schema (storage, auth, extensions) untouched -- out of scope and
--      Supabase-managed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Closes the project's own bonus default (anon/authenticated auto-grant)
--    for future functions, scoped to exactly the role migrations run as and
--    the schema application code lives in. service_role's default is
--    deliberately left alone (edge functions and admin tooling always need
--    to call any RPC). This does NOT close PostgreSQL's own separate
--    "PUBLIC gets EXECUTE on every new function" default -- see the note
--    above; every future function-creating migration must still explicitly
--    revoke from `public` per function.
-- ----------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1b) Six functions (bump_tournament_data_version, get_public_round_feed,
--     handle_new_user, has_public_personal_round, is_public_personal_round,
--     set_updated_at) never had an explicit `revoke execute ... from public`
--     in their own migration, unlike almost every other function in this
--     codebase. PUBLIC is a pseudo-role every real role (anon included)
--     implicitly inherits through, so revoking a role's own direct grant
--     does nothing while a PUBLIC grant remains: `anon` would still pass a
--     privilege check via PUBLIC alone. Revoked from PUBLIC specifically
--     here. They're also revoked from anon/authenticated directly alongside
--     it: depending on exactly when in this project's history the bonus
--     anon/authenticated default (see the note above) started applying,
--     these six may or may not additionally carry their own direct
--     anon/authenticated grant on top of the PUBLIC one (verified this
--     varies between this project's actual production history and a fresh
--     local database) -- revoking both is correct and safe either way, and
--     a revoke of a grant that was never present is a harmless no-op.
-- ----------------------------------------------------------------------------

revoke execute on function public.bump_tournament_data_version() from public, anon, authenticated;
revoke execute on function public.get_public_round_feed(integer) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.has_public_personal_round(uuid) from public, anon;
revoke execute on function public.is_public_personal_round(uuid) from public, anon;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) Internal-only helpers: never meant to be reachable by a direct caller
--    at all (see their own migration comments in 0027/0028). Revoked from
--    both roles -- create_manual_course()/replace_manual_course_tees() call
--    them internally via `perform`, which does not require the calling
--    session to hold its own EXECUTE grant on the callee.
-- ----------------------------------------------------------------------------

revoke execute on function public.insert_manual_course_tee(uuid, jsonb) from anon, authenticated;
revoke execute on function public.validate_manual_tee(jsonb, boolean) from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) Trigger-only functions: fired by the table trigger machinery, which
--    does not re-check the invoking session's EXECUTE privilege on the
--    trigger function -- only CREATE TRIGGER itself required it, once, from
--    whoever defined the trigger. Direct anon/authenticated EXECUTE grants
--    on these serve no purpose (Postgres already refuses to run a
--    trigger-returning function outside trigger context) and are removed as
--    part of this cleanup.
-- ----------------------------------------------------------------------------

-- (All three already fully covered by their PUBLIC revoke in step 1b above
-- -- none of them ever had a separate anon/authenticated grant beyond that.)

-- ----------------------------------------------------------------------------
-- 4) Every remaining application RPC: authenticated-GreenLink-members-only.
--    `authenticated` is left untouched (already granted by each function's
--    own migration); only the incidental `anon` grant is removed.
-- ----------------------------------------------------------------------------

-- Member directory / profile lookup (0001, 0032-0035) -- names, usernames,
-- membership dates, round counts, avatar paths: exactly the private-member
-- data this whole lockdown is about.
revoke execute on function public.search_profile_by_username(text) from anon;
revoke execute on function public.list_members() from anon;

-- Community Feed (0024) -- "public" has only ever meant "visible to signed-in
-- GreenLink members", matching every sibling RLS policy this RPC's query
-- depends on (tournaments_select_public_rounds, team_hole_scores_select_
-- public_rounds, tournament_holes_select_public_rounds, tournament_teams_
-- select_public_rounds, profiles_select_public_round_organizer -- all
-- `to authenticated` in 0024), never internet-public. (Already covered by
-- its PUBLIC revoke in step 1b above; anon has no other path to it.)

-- Membership/ownership boolean helpers (0009, 0024, 0027) -- not a data leak
-- on their own (null-safe against an anonymous caller, boolean-only return),
-- but no legitimate reason for a signed-out caller to invoke them directly.
-- (is_public_personal_round/has_public_personal_round already covered by
-- their PUBLIC revoke in step 1b above.)
revoke execute on function public.is_tournament_member(uuid) from anon;
revoke execute on function public.is_tournament_organizer(uuid) from anon;
revoke execute on function public.is_team_member(uuid, uuid) from anon;
revoke execute on function public.is_admin() from anon;
revoke execute on function public.can_manage_course(uuid) from anon;

-- Tournament lifecycle / setup (0009, 0013, 0014, 0015, 0016, 0018, 0021, 0023)
revoke execute on function public.create_tournament(text, text, date, integer, text, integer, text) from anon;
revoke execute on function public.create_tournament_with_course(text, text, date, integer, text, integer, text, uuid, text) from anon;
revoke execute on function public.invite_player(uuid, uuid) from anon;
revoke execute on function public.cancel_tournament_invitation(uuid) from anon;
revoke execute on function public.remove_tournament_player(uuid) from anon;
revoke execute on function public.accept_invitation(uuid) from anon;
revoke execute on function public.decline_invitation(uuid) from anon;
revoke execute on function public.create_tournament_team(uuid, text) from anon;
revoke execute on function public.rename_tournament_team(uuid, text) from anon;
revoke execute on function public.delete_tournament_team(uuid) from anon;
revoke execute on function public.assign_tournament_player(uuid, uuid) from anon;
revoke execute on function public.unassign_tournament_player(uuid) from anon;
revoke execute on function public.auto_create_tournament_teams(uuid) from anon;
revoke execute on function public.get_tournament_readiness(uuid) from anon;
revoke execute on function public.start_tournament(uuid) from anon;
revoke execute on function public.finish_tournament(uuid, boolean, text) from anon;
revoke execute on function public.get_tournament_progress(uuid) from anon;
revoke execute on function public.save_tournament_holes(uuid, jsonb) from anon;
revoke execute on function public.apply_imported_course_to_tournament(uuid, uuid, text) from anon;
revoke execute on function public.set_tournament_course_rating(uuid, numeric, numeric) from anon;

-- Scoring (0010, 0017)
revoke execute on function public.submit_team_score(uuid, uuid, uuid, integer, integer, integer, timestamptz) from anon;
revoke execute on function public.correct_team_score(uuid, uuid, uuid, integer, integer, text, timestamptz) from anon;

-- Tournament chat (0025)
revoke execute on function public.send_tournament_message(uuid, uuid, text) from anon;
revoke execute on function public.delete_tournament_message(uuid) from anon;
revoke execute on function public.mark_tournament_chat_read(uuid) from anon;
revoke execute on function public.get_tournament_chat_summary(uuid) from anon;
revoke execute on function public.get_my_tournament_unread_counts() from anon;

-- Personal rounds / My Golf (0024, 0026)
revoke execute on function public.start_personal_round(text, date, integer, uuid, text, text, jsonb, numeric, numeric) from anon;
revoke execute on function public.finish_personal_round(uuid, text) from anon;
revoke execute on function public.get_my_golf_stats() from anon;

-- Course library / search (0027, 0028, 0030) -- create_manual_course,
-- update_manual_course_info, replace_manual_course_tees, archive/restore/
-- publish_manual_course, find_similar_courses, search_courses. None of
-- these have a legitimate pre-login caller: manual course entry only ever
-- happens inside the signed-in app, and golf-course-lookup's own call to
-- search_courses() uses a service_role client (unaffected by this revoke).
revoke execute on function public.create_manual_course(text, text, text, text, text, text, numeric, numeric, jsonb, boolean) from anon;
revoke execute on function public.update_manual_course_info(uuid, text, text, text, text, text, text, numeric, numeric) from anon;
revoke execute on function public.replace_manual_course_tees(uuid, jsonb, boolean) from anon;
revoke execute on function public.archive_manual_course(uuid) from anon;
revoke execute on function public.restore_manual_course(uuid) from anon;
revoke execute on function public.publish_manual_course(uuid) from anon;
revoke execute on function public.find_similar_courses(text, text, text, numeric, numeric, uuid) from anon;
revoke execute on function public.search_courses(text, integer) from anon;

-- `is_username_available(text)` is deliberately left untouched below this
-- line: it remains grant(ed) to anon, authenticated exactly as 0001 left it.
