-- ============================================================================
-- pgTAP suite for the tournament setup workflow's authorization rules.
--
-- IMPORTANT: this file was written without access to a running Postgres/
-- Supabase instance (no Docker/Supabase CLI in the environment that authored
-- it) and has NOT been executed. It follows documented Postgres/pgTAP/
-- PostgREST semantics as closely as possible, but treat a failure here as
-- "investigate" rather than "the app is definitely broken" until it's been
-- run once and adjusted for whatever it gets wrong. Run with:
--
--   supabase test db
--
-- It creates its own throwaway users/tournaments and rolls back at the end,
-- so it is safe to run against a local dev database.
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(11);

-- ---------------------------------------------------------------------------
-- Test helpers (session-temporary; gone when the transaction rolls back).
-- ---------------------------------------------------------------------------

create temp table fixtures (key text primary key, value text);

-- security definer: the test body runs under `set local role authenticated`
-- (to exercise RLS/auth.uid() for real), but this temp table is owned by
-- the session's original role, which `authenticated` has no grants on.
-- Definer rights let remember()/recall() work regardless of the caller's
-- current role, without handing that role any real privileges.
create function pg_temp.remember(p_key text, p_value text) returns void
language sql security definer as $$
  insert into fixtures (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
$$;

create function pg_temp.recall(p_key text) returns text
language sql stable security definer as $$
  select value from fixtures where key = p_key;
$$;

-- Executes p_sql and reports whether it raised. Used for every "this action
-- must be rejected" assertion below instead of guessing pgTAP's throws_ok()
-- overload/error-code matching, which this file's author could not verify
-- without a live database.
create function pg_temp.expect_exception(p_sql text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: an organizer, a player who will be an accepted member of
-- tournament A, and an "outsider" who is only ever a member of tournament B
-- -- used to exercise the cross-tournament assignment check.
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'organizer@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Olive', 'last_name', 'Organizer', 'username', 'organizer_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'member@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Mia', 'last_name', 'Member', 'username', 'member_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000003',
     'authenticated', 'authenticated', 'outsider@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Otto', 'last_name', 'Outsider', 'username', 'outsider_test'),
     now(), now(), '', '', '', '');
end $$;

-- Organizer creates two 9-hole, team-size-2 tournaments and invites one
-- player to each.
do $$
declare
  v_tournament_a uuid;
  v_tournament_b uuid;
  v_invitation_a uuid;
  v_invitation_b uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_tournament_a := public.create_tournament('Test Cup A', 'Course A', current_date, 9, 'Team Scramble', 2);
  v_tournament_b := public.create_tournament('Test Cup B', 'Course B', current_date, 9, 'Team Scramble', 2);
  v_invitation_a := public.invite_player(v_tournament_a, '10000000-0000-0000-0000-000000000002');
  v_invitation_b := public.invite_player(v_tournament_b, '10000000-0000-0000-0000-000000000003');

  perform pg_temp.remember('tournament_a', v_tournament_a::text);
  perform pg_temp.remember('tournament_b', v_tournament_b::text);
  perform pg_temp.remember('invitation_a', v_invitation_a::text);
  perform pg_temp.remember('invitation_b', v_invitation_b::text);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('invitation_a')::uuid);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('invitation_b')::uuid);
end $$;

reset role;

do $$
declare
  v_member_player_id uuid;
  v_outsider_player_id uuid;
begin
  select id into v_member_player_id from public.tournament_players
    where tournament_id = pg_temp.recall('tournament_a')::uuid
      and user_id = '10000000-0000-0000-0000-000000000002';
  select id into v_outsider_player_id from public.tournament_players
    where tournament_id = pg_temp.recall('tournament_b')::uuid
      and user_id = '10000000-0000-0000-0000-000000000003';
  perform pg_temp.remember('member_player_id', v_member_player_id::text);
  perform pg_temp.remember('outsider_player_id', v_outsider_player_id::text);
end $$;

-- ---------------------------------------------------------------------------
-- 1) Non-organizer cannot create a team.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.create_tournament_team(%L)', pg_temp.recall('tournament_a'))),
  'non-organizer cannot create a tournament team'
);

reset role;

-- Organizer creates a real team for the remaining steps.
do $$
declare
  v_team_a uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_team_a := (public.create_tournament_team(pg_temp.recall('tournament_a')::uuid, 'Team Blue')).id;
  perform pg_temp.remember('team_a', v_team_a::text);
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 2) A player cannot assign themselves to a team (they are not the
--    organizer, regardless of which team/player id they pass).
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.assign_tournament_player(%L, %L)',
      pg_temp.recall('member_player_id'), pg_temp.recall('team_a'))
  ),
  'a player cannot assign themselves to a team'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) A player from a different tournament cannot be assigned to this team,
--    even by this tournament's own organizer.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.assign_tournament_player(%L, %L)',
      pg_temp.recall('outsider_player_id'), pg_temp.recall('team_a'))
  ),
  'a player from a different tournament cannot be assigned to this team'
);

-- Legitimately assign the member to team A (organizer context still active).
select public.assign_tournament_player(
  (select pg_temp.recall('member_player_id'))::uuid,
  (select pg_temp.recall('team_a'))::uuid
);

reset role;

-- ---------------------------------------------------------------------------
-- 4) start_tournament rejects a tournament with no holes configured.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.start_tournament(%L)', pg_temp.recall('tournament_a'))),
  'cannot start a tournament with no holes configured'
);

-- Configure all 9 holes so later steps can proceed.
select public.save_tournament_holes(
  (select pg_temp.recall('tournament_a'))::uuid,
  (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n)
);

reset role;

-- ---------------------------------------------------------------------------
-- 5) start_tournament rejects an unassigned accepted player. The organizer's
--    own membership row is itself an accepted player and is not yet
--    assigned to a team, so this must still fail.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.start_tournament(%L)', pg_temp.recall('tournament_a'))),
  'cannot start a tournament with an unassigned accepted player'
);

do $$
declare
  v_organizer_player_id uuid;
begin
  select id into v_organizer_player_id from public.tournament_players
    where tournament_id = pg_temp.recall('tournament_a')::uuid
      and user_id = '10000000-0000-0000-0000-000000000001';
  perform public.assign_tournament_player(v_organizer_player_id, pg_temp.recall('team_a')::uuid);
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 6) start_tournament rejects an invalid team size. Team A now correctly
--    has 2/2 players; add a second, empty team so team_sizes_valid fails.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.create_tournament_team(pg_temp.recall('tournament_a')::uuid, 'Team Empty');
end $$;

select ok(
  pg_temp.expect_exception(format('select public.start_tournament(%L)', pg_temp.recall('tournament_a'))),
  'cannot start a tournament with a team that does not satisfy the team size'
);

do $$
declare
  v_empty_team_id uuid;
begin
  select id into v_empty_team_id from public.tournament_teams
    where tournament_id = pg_temp.recall('tournament_a')::uuid and name = 'Team Empty';
  perform public.delete_tournament_team(v_empty_team_id);
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 7) start_tournament succeeds once everything above is fixed.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select status from public.start_tournament(pg_temp.recall('tournament_a')::uuid)),
  'live',
  'start_tournament succeeds and sets status to live once setup is valid'
);

reset role;

-- ---------------------------------------------------------------------------
-- 8) Team changes are rejected once the tournament is live.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.create_tournament_team(%L)', pg_temp.recall('tournament_a'))),
  'team changes are rejected once the tournament is live'
);

-- ---------------------------------------------------------------------------
-- 9) Course changes are rejected once the tournament is live.
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.expect_exception(
    format(
      'select public.save_tournament_holes(%L, %L::jsonb)',
      pg_temp.recall('tournament_a'),
      (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n)::text
    )
  ),
  'course changes are rejected once the tournament is live'
);

reset role;

-- ---------------------------------------------------------------------------
-- 10) A non-member cannot read this tournament's data. The "outsider" is a
--     real authenticated user, just not a member of tournament A.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*)::int from public.tournaments where id = pg_temp.recall('tournament_a')::uuid),
  0,
  'a non-member cannot read this tournament row'
);

reset role;

-- ---------------------------------------------------------------------------
-- 11) A regular member cannot submit scores once the tournament is
--     completed (existing rule from 0010, re-verified against the new
--     lifecycle functions).
-- ---------------------------------------------------------------------------

-- No holes were scored in this fixture, so a normal finish would (correctly,
-- per 0018) reject on incomplete scorecards; force-finish to reach the
-- "completed" state this section actually needs to test.
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.finish_tournament(pg_temp.recall('tournament_a')::uuid, true, 'test fixture close-out');
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '10000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.submit_team_score(gen_random_uuid(), %L, %L, 1, 4, 0)',
      pg_temp.recall('tournament_a'), pg_temp.recall('team_a'))
  ),
  'a regular member cannot submit scores once the tournament is completed'
);

reset role;

select * from finish();
rollback;
