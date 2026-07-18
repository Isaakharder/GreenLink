-- ============================================================================
-- pgTAP suite for tournaments.data_version: the staleness counter the
-- frontend's offline-download feature compares against a cached copy's
-- version to know when to show "Update available". Verifies it bumps for
-- structural setup changes (holes/teams/players/tournament fields) and
-- deliberately does NOT bump for routine score submissions.
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(5);

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

-- ---------------------------------------------------------------------------
-- Fixtures: an organizer with a fresh 2-hole tournament and one player.
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'version-organizer@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Vera', 'last_name', 'Organizer', 'username', 'version_organizer'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'version-player@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Pat', 'last_name', 'Player', 'username', 'version_player'),
     now(), now(), '', '', '', '');
end $$;

do $$
declare
  v_tournament uuid;
  v_invitation uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_tournament := public.create_tournament('Version Cup', 'Version Course', current_date, 2, 'Team Scramble', 1);
  v_invitation := public.invite_player(v_tournament, '40000000-0000-0000-0000-000000000002');
  perform pg_temp.remember('tournament', v_tournament::text);
  perform pg_temp.remember('invitation', v_invitation::text);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('invitation')::uuid);
end $$;

reset role;

-- Note: data_version is already > 1 by this point -- create_tournament()
-- inserts the organizer's own tournament_players row, and accept_invitation()
-- inserts the invitee's, and both fire the tournament_players trigger.
-- That's correct/expected (roster changed), just not asserted here since
-- the exact starting value isn't the interesting property -- the deltas
-- below are.

-- ---------------------------------------------------------------------------
-- 1) Saving holes bumps data_version.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.save_tournament_holes(
    pg_temp.recall('tournament')::uuid,
    (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 2) as n)
  );
end $$;

select ok(
  (select data_version from public.tournaments where id = pg_temp.recall('tournament')::uuid) > 1,
  'saving holes bumps data_version'
);

-- ---------------------------------------------------------------------------
-- 2) Creating a team bumps data_version.
-- ---------------------------------------------------------------------------

do $$
declare
  v_before integer;
  v_team uuid;
begin
  select data_version into v_before from public.tournaments where id = pg_temp.recall('tournament')::uuid;
  v_team := (public.create_tournament_team(pg_temp.recall('tournament')::uuid, 'Team A')).id;
  perform pg_temp.remember('before_team', v_before::text);
  perform pg_temp.remember('team', v_team::text);
end $$;

select ok(
  (select data_version from public.tournaments where id = pg_temp.recall('tournament')::uuid) > pg_temp.recall('before_team')::integer,
  'creating a team bumps data_version'
);

-- ---------------------------------------------------------------------------
-- 3) Assigning a player to a team bumps data_version.
-- ---------------------------------------------------------------------------

do $$
declare
  v_before integer;
begin
  select data_version into v_before from public.tournaments where id = pg_temp.recall('tournament')::uuid;
  perform pg_temp.remember('before_assign', v_before::text);
  perform public.assign_tournament_player(
    (select id from public.tournament_players
       where tournament_id = pg_temp.recall('tournament')::uuid
         and user_id = '40000000-0000-0000-0000-000000000002'),
    pg_temp.recall('team')::uuid
  );
end $$;

select ok(
  (select data_version from public.tournaments where id = pg_temp.recall('tournament')::uuid) > pg_temp.recall('before_assign')::integer,
  'assigning a player to a team bumps data_version'
);

-- ---------------------------------------------------------------------------
-- 4) Starting the tournament bumps data_version.
-- ---------------------------------------------------------------------------

do $$
declare
  v_before integer;
  v_organizer_player_id uuid;
  v_organizer_team uuid;
begin
  -- team_size is 1 for this tournament, so the organizer needs their own
  -- second team, not to share "Team A" with the invited player.
  v_organizer_team := (public.create_tournament_team(pg_temp.recall('tournament')::uuid, 'Organizer Team')).id;
  select id into v_organizer_player_id from public.tournament_players
    where tournament_id = pg_temp.recall('tournament')::uuid
      and user_id = '40000000-0000-0000-0000-000000000001';
  perform public.assign_tournament_player(v_organizer_player_id, v_organizer_team);

  select data_version into v_before from public.tournaments where id = pg_temp.recall('tournament')::uuid;
  perform pg_temp.remember('before_start', v_before::text);
  perform public.start_tournament(pg_temp.recall('tournament')::uuid);
end $$;

select ok(
  (select data_version from public.tournaments where id = pg_temp.recall('tournament')::uuid) > pg_temp.recall('before_start')::integer,
  'starting the tournament bumps data_version'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5) Submitting a score does NOT bump data_version (live scoring is a
--    separate concern from structural setup staleness).
-- ---------------------------------------------------------------------------

do $$
declare
  v_before integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '40000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  select data_version into v_before from public.tournaments where id = pg_temp.recall('tournament')::uuid;
  perform pg_temp.remember('before_score', v_before::text);
  perform public.submit_team_score(
    gen_random_uuid(), pg_temp.recall('tournament')::uuid, pg_temp.recall('team')::uuid, 1, 4, 0
  );
end $$;

select is(
  (select data_version from public.tournaments where id = pg_temp.recall('tournament')::uuid),
  pg_temp.recall('before_score')::integer,
  'submitting a score does not bump data_version'
);

reset role;

select * from finish();
rollback;
