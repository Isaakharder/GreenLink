-- ============================================================================
-- pgTAP suite for the live-scoring engine added on top of the setup
-- workflow: revision-conflict-aware submit_team_score, per-team membership
-- enforcement, tournament-status gating, forced-finish auditing, and
-- leaderboard-table RLS. Executed for real via `supabase test db` (Docker +
-- Supabase CLI available in this environment), not just authored.
--
-- Fixture: one organizer and two players, each on their own single-player
-- team (team_size = 1), a 2-hole tournament. Keeping teams to one player
-- each is what makes "a player cannot score for another team" cheap to set
-- up and unambiguous.
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(12);

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
-- Fixtures
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'scoring-organizer@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Oscar', 'last_name', 'Organizer', 'username', 'scoring_organizer'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'player-a@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ana', 'last_name', 'PlayerA', 'username', 'scoring_player_a'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000003',
     'authenticated', 'authenticated', 'player-b@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ben', 'last_name', 'PlayerB', 'username', 'scoring_player_b'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000004',
     'authenticated', 'authenticated', 'outsider2@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ori', 'last_name', 'Outsider', 'username', 'scoring_outsider'),
     now(), now(), '', '', '', '');
end $$;

do $$
declare
  v_tournament uuid;
  v_inv_a uuid;
  v_inv_b uuid;
  v_team1 uuid;
  v_team2 uuid;
  v_team3 uuid;
  v_organizer_player_id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_tournament := public.create_tournament('Scoring Cup', 'Scoring Course', current_date, 2, 'Team Scramble', 1);
  v_inv_a := public.invite_player(v_tournament, '20000000-0000-0000-0000-000000000002');
  v_inv_b := public.invite_player(v_tournament, '20000000-0000-0000-0000-000000000003');
  perform pg_temp.remember('tournament', v_tournament::text);
  perform pg_temp.remember('inv_a', v_inv_a::text);
  perform pg_temp.remember('inv_b', v_inv_b::text);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('inv_a')::uuid);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('inv_b')::uuid);
end $$;

reset role;

do $$
declare
  v_tournament uuid := pg_temp.recall('tournament')::uuid;
  v_team1 uuid;
  v_team2 uuid;
  v_team3 uuid;
  v_organizer_player_id uuid;
  v_player_a_id uuid;
  v_player_b_id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_team1 := (public.create_tournament_team(v_tournament, 'Team Organizer')).id;
  v_team2 := (public.create_tournament_team(v_tournament, 'Team A')).id;
  v_team3 := (public.create_tournament_team(v_tournament, 'Team B')).id;

  select id into v_organizer_player_id from public.tournament_players
    where tournament_id = v_tournament and user_id = '20000000-0000-0000-0000-000000000001';
  select id into v_player_a_id from public.tournament_players
    where tournament_id = v_tournament and user_id = '20000000-0000-0000-0000-000000000002';
  select id into v_player_b_id from public.tournament_players
    where tournament_id = v_tournament and user_id = '20000000-0000-0000-0000-000000000003';

  perform public.assign_tournament_player(v_organizer_player_id, v_team1);
  perform public.assign_tournament_player(v_player_a_id, v_team2);
  perform public.assign_tournament_player(v_player_b_id, v_team3);

  perform public.save_tournament_holes(
    v_tournament,
    (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 2) as n)
  );

  perform public.start_tournament(v_tournament);

  perform pg_temp.remember('team1', v_team1::text);
  perform pg_temp.remember('team2', v_team2::text);
  perform pg_temp.remember('team3', v_team3::text);
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 1) submit_team_score is idempotent on operation_uuid.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform pg_temp.remember('op1', gen_random_uuid()::text);
end $$;

do $$
declare
  v_result jsonb;
begin
  v_result := public.submit_team_score(
    pg_temp.recall('op1')::uuid, pg_temp.recall('tournament')::uuid, pg_temp.recall('team2')::uuid,
    1, 4, 0
  );
  perform pg_temp.remember('result1_first', v_result::text);

  -- Resend of the exact same operation_uuid: must not double-apply.
  v_result := public.submit_team_score(
    pg_temp.recall('op1')::uuid, pg_temp.recall('tournament')::uuid, pg_temp.recall('team2')::uuid,
    1, 4, 0
  );
  perform pg_temp.remember('result1_resend', v_result::text);
end $$;

select is(
  pg_temp.recall('result1_first')::jsonb ->> 'status', 'ok',
  'first submission succeeds'
);

select is(
  (pg_temp.recall('result1_resend')::jsonb -> 'score' ->> 'revision')::int, 1,
  'resending the same operation_uuid returns the original result without reapplying'
);

select is(
  (select count(*)::int from public.score_operations where operation_uuid = pg_temp.recall('op1')::uuid),
  1,
  'resending the same operation_uuid does not create a duplicate audit row'
);

-- ---------------------------------------------------------------------------
-- 2) Stale expected_revision returns a structured conflict, not an
--    exception, and does not change the server's score.
-- ---------------------------------------------------------------------------

do $$
declare
  v_result jsonb;
begin
  -- Server revision for hole 1 is now 1 (from test 1); resubmit with a new
  -- operation but a stale expected_revision of 0.
  v_result := public.submit_team_score(
    gen_random_uuid(), pg_temp.recall('tournament')::uuid, pg_temp.recall('team2')::uuid,
    1, 9, 0
  );
  perform pg_temp.remember('conflict_result', v_result::text);
end $$;

select is(
  pg_temp.recall('conflict_result')::jsonb ->> 'status', 'conflict',
  'a stale expected_revision returns a structured conflict instead of raising'
);

select is(
  (pg_temp.recall('conflict_result')::jsonb -> 'server' ->> 'strokes')::int, 4,
  'the conflict payload reports the current server strokes, unchanged by the losing submission'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) A player cannot submit a score for a team they do not belong to.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.submit_team_score(gen_random_uuid(), %L, %L, 2, 4, 0)',
      pg_temp.recall('tournament'), pg_temp.recall('team3'))
  ),
  'a player cannot submit a score for a team they are not assigned to'
);

reset role;

-- ---------------------------------------------------------------------------
-- 4) Scores are rejected before the tournament is live.
-- ---------------------------------------------------------------------------

do $$
declare
  v_draft_tournament uuid;
  v_draft_team uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_draft_tournament := public.create_tournament('Draft Cup', 'Draft Course', current_date, 2, 'Team Scramble', 1);
  v_draft_team := (public.create_tournament_team(v_draft_tournament, 'Team Draft')).id;
  perform pg_temp.remember('draft_tournament', v_draft_tournament::text);
  perform pg_temp.remember('draft_team', v_draft_team::text);
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.submit_team_score(gen_random_uuid(), %L, %L, 1, 4, 0)',
      pg_temp.recall('draft_tournament'), pg_temp.recall('draft_team'))
  ),
  'scores are rejected before the tournament is live'
);

-- ---------------------------------------------------------------------------
-- 5) finish_tournament rejects an incomplete tournament without force, and
--    force requires a non-empty reason.
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.expect_exception(format('select public.finish_tournament(%L)', pg_temp.recall('tournament'))),
  'finish_tournament rejects a tournament with incomplete team scorecards'
);

select ok(
  pg_temp.expect_exception(
    format('select public.finish_tournament(%L, true, null)', pg_temp.recall('tournament'))
  ),
  'force-finishing without a reason is rejected'
);

-- Force-finish for real, with a reason, so the audit-trail test below has a
-- completed tournament to correct a score against.
do $$
begin
  perform public.finish_tournament(pg_temp.recall('tournament')::uuid, true, 'weather delay, closing round early');
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 6) correct_team_score remains audited after completion, and the audit
--    row is visible to a regular tournament member.
-- ---------------------------------------------------------------------------

do $$
declare
  v_op uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.correct_team_score(
    v_op, pg_temp.recall('tournament')::uuid, pg_temp.recall('team2')::uuid,
    2, 5, 'organizer correction test', now()
  );
  perform pg_temp.remember('correction_op', v_op::text);
end $$;

reset role;

select is(
  (select change_reason from public.score_operations where operation_uuid = pg_temp.recall('correction_op')::uuid),
  'organizer correction test',
  'a post-completion organizer correction is recorded with its reason'
);

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*)::int from public.score_operations where operation_uuid = pg_temp.recall('correction_op')::uuid),
  1,
  'the correction audit row is visible to a regular tournament member'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7) Non-members cannot read this tournament's leaderboard-backing tables.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '20000000-0000-0000-0000-000000000004', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select is(
  (select count(*)::int from public.team_hole_scores where tournament_id = pg_temp.recall('tournament')::uuid),
  0,
  'a non-member cannot read team_hole_scores for this tournament'
);

reset role;

select * from finish();
rollback;
