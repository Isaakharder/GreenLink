-- ============================================================================
-- pgTAP suite for My Golf personal rounds (supabase/migrations/0024).
-- Covers: start_personal_round()/finish_personal_round() happy paths and
-- rejections, is_public_personal_round() truth table, cross-user RLS
-- isolation (private rounds invisible to another user, public+completed
-- rounds visible), and get_public_round_feed()/get_my_golf_stats()
-- correctness. Same fixture/impersonation pattern as
-- tournament_setup_rules.sql / live_scoring_rules.sql. Creates its own
-- throwaway users/course/rounds and rolls back at the end.
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(33);

create temp table fixtures (key text primary key, value text);

create function pg_temp.remember(p_key text, p_value text) returns void
language sql security definer as $$
  insert into fixtures (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
$$;

create function pg_temp.recall(p_key text) returns text
language sql stable security definer as $$
  select value from fixtures where key = p_key;
$$;

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
-- Fixtures: two players (A starts personal rounds, B is an outsider who
-- never plays or is invited to anything -- personal rounds have no
-- invitations at all) and a shared imported course/tee/holes, inserted
-- directly the way the golf-course-lookup Edge Function would (this session
-- is the table owner here, before any `set local role authenticated`).
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'mygolf-player@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Pat', 'last_name', 'Player', 'username', 'mygolf_player_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'mygolf-outsider@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Oli', 'last_name', 'Outsider', 'username', 'mygolf_outsider_test'),
     now(), now(), '', '', '', '');

  insert into public.golf_courses (id, external_id, club_name, course_name, imported_by, raw_payload)
  values ('30000000-0000-0000-0000-000000000001', 'mygolf-test-course', 'Test Club', 'Test Course',
    '20000000-0000-0000-0000-000000000001', '{}'::jsonb);

  insert into public.golf_course_tees (id, golf_course_id, tee_name, gender, number_of_holes, par_total)
  values ('30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'White', 'male', 9, 36);

  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select '30000000-0000-0000-0000-000000000002', n, 4 from generate_series(1, 9) as n;
end $$;

-- ---------------------------------------------------------------------------
-- 1) start_personal_round requires a tee -- My Golf never offers manual
--    course entry.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.start_personal_round(%L, current_date, 9, null)', 'Test Course')
  ),
  'start_personal_round rejects a null tee id'
);

-- ---------------------------------------------------------------------------
-- 2) A hole-count/tee mismatch is rejected by the reused
--    apply_imported_course_to_tournament() validation, and rolls back the
--    whole round (no orphan tournament left behind).
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.expect_exception(
    format('select public.start_personal_round(%L, current_date, 18, %L)',
      'Test Course', '30000000-0000-0000-0000-000000000002')
  ),
  'start_personal_round rejects a tee/hole-count mismatch'
);

select is(
  (select count(*) from public.tournaments where organizer_user_id = '20000000-0000-0000-0000-000000000001'),
  0::bigint,
  'no orphan tournament left behind by either rejected start'
);

-- ---------------------------------------------------------------------------
-- 3) Happy path: start a 9-hole personal round.
-- ---------------------------------------------------------------------------

do $$
declare
  v_round_id uuid;
begin
  v_round_id := public.start_personal_round('Test Course', current_date, 9, '30000000-0000-0000-0000-000000000002');
  perform pg_temp.remember('round_1', v_round_id::text);
end $$;

select ok(
  (select is_personal from public.tournaments where id = pg_temp.recall('round_1')::uuid),
  'start_personal_round creates a tournament flagged is_personal'
);

select is(
  (select status from public.tournaments where id = pg_temp.recall('round_1')::uuid),
  'live',
  'start_personal_round leaves the round live and ready to score'
);

select is(
  (select team_size from public.tournaments where id = pg_temp.recall('round_1')::uuid),
  1,
  'a personal round is a team-size-1 tournament under the hood'
);

select is(
  (select visibility from public.personal_rounds where tournament_id = pg_temp.recall('round_1')::uuid),
  'private',
  'a round defaults to private until finished'
);

select is(
  (select walking_or_cart from public.personal_rounds where tournament_id = pg_temp.recall('round_1')::uuid),
  'walking',
  'walking_or_cart is recorded as chosen at start'
);

select is(
  (select count(*) from public.tournament_teams where tournament_id = pg_temp.recall('round_1')::uuid),
  1::bigint,
  'exactly one team is auto-created for a personal round'
);

select is(
  (select count(*) from public.tournament_players
    where tournament_id = pg_temp.recall('round_1')::uuid
      and user_id = '20000000-0000-0000-0000-000000000001'
      and is_organizer and membership_status = 'accepted' and team_id is not null),
  1::bigint,
  'the player is auto-enrolled as the accepted organizer, already assigned to the team'
);

select is(
  (select count(*) from public.tournament_holes where tournament_id = pg_temp.recall('round_1')::uuid),
  9::bigint,
  'all 9 holes were imported from the tee, reusing apply_imported_course_to_tournament()'
);

do $$
begin
  perform pg_temp.remember('team_1',
    (select id::text from public.tournament_teams where tournament_id = pg_temp.recall('round_1')::uuid));
end $$;

-- ---------------------------------------------------------------------------
-- 4) Score three holes with the existing, unmodified submit_team_score() --
--    birdie, par, bogey, so get_my_golf_stats() below has known buckets.
-- ---------------------------------------------------------------------------

do $$
begin
  perform public.submit_team_score(gen_random_uuid(), pg_temp.recall('round_1')::uuid, pg_temp.recall('team_1')::uuid, 1, 3, 0, now());
  perform public.submit_team_score(gen_random_uuid(), pg_temp.recall('round_1')::uuid, pg_temp.recall('team_1')::uuid, 2, 4, 0, now());
  perform public.submit_team_score(gen_random_uuid(), pg_temp.recall('round_1')::uuid, pg_temp.recall('team_1')::uuid, 3, 5, 0, now());
end $$;

select is(
  (select count(*) from public.team_hole_scores where tournament_id = pg_temp.recall('round_1')::uuid),
  3::bigint,
  'the existing submit_team_score() RPC works unmodified for a personal round'
);

-- ---------------------------------------------------------------------------
-- 5) While live, the round is not publicly visible, even though it will
--    eventually be marked public -- only a finished round can be.
-- ---------------------------------------------------------------------------

select ok(
  not (select public.is_public_personal_round(pg_temp.recall('round_1')::uuid)),
  'a live round is never publicly visible, regardless of future visibility'
);

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.tournaments where id = pg_temp.recall('round_1')::uuid),
  0::bigint,
  'an outsider cannot see a live/private round at all'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6) Only the player can finish their round.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.finish_personal_round(%L, %L)', pg_temp.recall('round_1'), 'private')
  ),
  'a non-organizer cannot finish someone else''s round'
);

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select status from public.finish_personal_round(pg_temp.recall('round_1')::uuid, 'public')),
  'completed',
  'finish_personal_round marks the round completed even with holes 4-9 unscored'
);

select is(
  (select visibility from public.personal_rounds where tournament_id = pg_temp.recall('round_1')::uuid),
  'public',
  'finish_personal_round records the chosen visibility'
);

select ok(
  (select public.is_public_personal_round(pg_temp.recall('round_1')::uuid)),
  'a finished, public round is publicly visible'
);

select ok(
  pg_temp.expect_exception(format('select public.finish_personal_round(%L, %L)', pg_temp.recall('round_1'), 'private')),
  'a completed round cannot be finished again'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7) The outsider can now read everything needed for the read-only
--    scorecard: tournament, holes, scores, and the player's profile.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.tournaments where id = pg_temp.recall('round_1')::uuid),
  1::bigint,
  'an outsider can now see the finished, public round'
);

select is(
  (select count(*) from public.tournament_holes where tournament_id = pg_temp.recall('round_1')::uuid),
  9::bigint,
  'an outsider can read every hole of a public round'
);

select is(
  (select count(*) from public.team_hole_scores where tournament_id = pg_temp.recall('round_1')::uuid),
  3::bigint,
  'an outsider can read the scores of a public round'
);

select is(
  (select count(*) from public.profiles where id = '20000000-0000-0000-0000-000000000001'),
  1::bigint,
  'an outsider can read the player''s profile for a public round'
);

reset role;

-- ---------------------------------------------------------------------------
-- 8) get_public_round_feed() / get_my_golf_stats() correctness.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.get_public_round_feed(30)),
  1::bigint,
  'the public feed contains exactly the one finished public round so far'
);

select is(
  (select total_strokes from public.get_public_round_feed(30) where tournament_id = pg_temp.recall('round_1')::uuid),
  12::bigint,
  'the feed totals strokes correctly (3 + 4 + 5)'
);

select is(
  (select relative_to_par from public.get_public_round_feed(30) where tournament_id = pg_temp.recall('round_1')::uuid),
  0::bigint,
  'the feed computes relative-to-par correctly (-1 + 0 + 1)'
);

select is(((public.get_my_golf_stats() ->> 'birdies')::int), 1, 'stats: one birdie (3 on a par 4)');
select is(((public.get_my_golf_stats() ->> 'pars')::int), 1, 'stats: one par (4 on a par 4)');
select is(((public.get_my_golf_stats() ->> 'bogeys')::int), 1, 'stats: one bogey (5 on a par 4)');
select is(((public.get_my_golf_stats() ->> 'courses_played')::int), 1, 'stats: one distinct course played');

reset role;

-- ---------------------------------------------------------------------------
-- 9) A second round finished as private never appears publicly and is
--    excluded from the feed, but still counts toward the player's own
--    stats.
-- ---------------------------------------------------------------------------

do $$
declare
  v_round_id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_round_id := public.start_personal_round('Test Course', current_date, 9, '30000000-0000-0000-0000-000000000002');
  perform pg_temp.remember('round_2', v_round_id::text);
  perform public.finish_personal_round(v_round_id, 'private');
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.tournaments where id = pg_temp.recall('round_2')::uuid),
  0::bigint,
  'a finished-but-private round is never visible to an outsider'
);

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*) from public.get_public_round_feed(30)),
  1::bigint,
  'the private second round is excluded from the public feed'
);

select is(
  ((public.get_my_golf_stats() ->> 'rounds_played')::int),
  2,
  'both rounds still count toward the player''s own stats regardless of visibility'
);

reset role;

select * from finish();
rollback;
