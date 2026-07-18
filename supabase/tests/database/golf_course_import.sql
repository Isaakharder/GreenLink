-- ============================================================================
-- pgTAP suite for the GolfCourseAPI import layer: apply_imported_course_to_
-- tournament()'s authorization/validation/copy-semantics, and RLS on the
-- shared golf_courses cache tables. Executed for real via `supabase test db`.
--
-- The Edge Function itself (search/import against GolfCourseAPI, duplicate
-- detection via ON CONFLICT) is covered separately by Deno integration
-- tests against a mocked upstream -- this file only covers what's reachable
-- from Postgres: the cache tables' RLS, and the organizer-facing RPC that
-- copies a cached tee's holes into a tournament.
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(15);

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
-- Fixtures: an organizer with a 9-hole tournament and a 18-hole tournament,
-- an outsider (never a member of either), and one cached course with an
-- 18-hole tee -- imported "out of band" as if the Edge Function had already
-- cached it (this file never calls GolfCourseAPI).
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'course-organizer@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Cara', 'last_name', 'Organizer', 'username', 'course_organizer'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'course-outsider@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Owen', 'last_name', 'Outsider', 'username', 'course_outsider'),
     now(), now(), '', '', '', '');
end $$;

do $$
declare
  v_tournament_9 uuid;
  v_tournament_18 uuid;
  v_golf_course_id uuid;
  v_tee_id uuid;
  i integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_tournament_9 := public.create_tournament('Import Cup 9', 'Import Course', current_date, 9, 'Team Scramble', 2);
  v_tournament_18 := public.create_tournament('Import Cup 18', 'Import Course', current_date, 18, 'Team Scramble', 2);
  perform pg_temp.remember('tournament_9', v_tournament_9::text);
  perform pg_temp.remember('tournament_18', v_tournament_18::text);
end $$;

reset role;

-- Cache rows inserted directly (standing in for the Edge Function's
-- service-role write) -- the test connection's own role owns these tables
-- and bypasses RLS, same as how auth.users is seeded above.
do $$
declare
  v_golf_course_id uuid;
  v_tee_id uuid;
  i integer;
begin
  insert into public.golf_courses (external_id, club_name, course_name, city, state, country, imported_by, raw_payload)
  values ('gc-ext-1', 'Import Club', 'Import Course', 'Testville', 'NC', 'USA',
          '30000000-0000-0000-0000-000000000001', '{}'::jsonb)
  returning id into v_golf_course_id;

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total, course_rating, slope_rating)
  values (v_golf_course_id, 'Blue', 'male', 18, 72, 71.4, 128)
  returning id into v_tee_id;

  for i in 1..18 loop
    insert into public.golf_course_tee_holes (tee_id, hole_number, par, yardage, handicap)
    values (v_tee_id, i, case when i = 3 then 3 when i in (5, 12, 14) then 5 else 4 end, 350 + i, ((i * 7) % 18) + 1);
  end loop;

  perform pg_temp.remember('golf_course_id', v_golf_course_id::text);
  perform pg_temp.remember('tee_id', v_tee_id::text);
end $$;

-- ---------------------------------------------------------------------------
-- 1) A non-organizer cannot import a course into someone else's tournament.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.apply_imported_course_to_tournament(%L, %L, %L)',
      pg_temp.recall('tournament_18'), pg_temp.recall('tee_id'), 'front')
  ),
  'a non-organizer cannot import a course into a tournament'
);

reset role;

-- ---------------------------------------------------------------------------
-- 2) An 18-hole tee applied to an 18-hole tournament without p_nine.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.apply_imported_course_to_tournament(pg_temp.recall('tournament_18')::uuid, pg_temp.recall('tee_id')::uuid, null);
end $$;

select is(
  (select count(*)::int from public.tournament_holes where tournament_id = pg_temp.recall('tournament_18')::uuid),
  18,
  'an 18-hole tee imports all 18 holes into an 18-hole tournament'
);

select is(
  (select golf_course_tee_id from public.tournaments where id = pg_temp.recall('tournament_18')::uuid),
  pg_temp.recall('tee_id')::uuid,
  'the tournament records which tee it imported from'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) An 18-hole tee applied to a 9-hole tournament without p_nine is
--    rejected; front/back-9 slicing produces hole numbers 1-9 either way.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.apply_imported_course_to_tournament(%L, %L, null)',
      pg_temp.recall('tournament_9'), pg_temp.recall('tee_id'))
  ),
  'an 18-hole tee on a 9-hole tournament without p_nine is rejected'
);

do $$
begin
  perform public.apply_imported_course_to_tournament(
    pg_temp.recall('tournament_9')::uuid, pg_temp.recall('tee_id')::uuid, 'front'
  );
end $$;

select is(
  (select array_agg(hole_number order by hole_number) from public.tournament_holes where tournament_id = pg_temp.recall('tournament_9')::uuid),
  array[1,2,3,4,5,6,7,8,9],
  'front-9 slicing produces hole numbers 1 through 9'
);

select is(
  (select par from public.tournament_holes where tournament_id = pg_temp.recall('tournament_9')::uuid and hole_number = 3),
  3,
  'front-9 slicing carries over the correct par for hole 3'
);

do $$
begin
  perform public.apply_imported_course_to_tournament(
    pg_temp.recall('tournament_9')::uuid, pg_temp.recall('tee_id')::uuid, 'back'
  );
end $$;

select is(
  (select par from public.tournament_holes where tournament_id = pg_temp.recall('tournament_9')::uuid and hole_number = 3),
  5,
  'back-9 slicing remaps original hole 12 (par 5) to hole number 3'
);

reset role;

-- ---------------------------------------------------------------------------
-- 4) tournament_holes is a copy: mutating the cached tee's hole data after
--    import does not change the tournament that already imported it.
-- ---------------------------------------------------------------------------

update public.golf_course_tee_holes
set par = 6
where tee_id = pg_temp.recall('tee_id')::uuid and hole_number = 3;

select isnt(
  (select par from public.tournament_holes where tournament_id = pg_temp.recall('tournament_18')::uuid and hole_number = 3),
  6,
  'editing the cached course after import does not change an already-imported tournament'
);

-- ---------------------------------------------------------------------------
-- 5) Cannot import once the tournament is live.
-- ---------------------------------------------------------------------------

do $$
declare
  v_invitation uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- start_tournament requires >= 2 accepted, all-assigned players -- invite
  -- the "outsider" here purely as a warm body to satisfy that readiness
  -- rule (this happens after test 1 already exercised them as a true
  -- non-member, so it doesn't weaken that assertion).
  v_invitation := public.invite_player(pg_temp.recall('tournament_18')::uuid, '30000000-0000-0000-0000-000000000002');
  perform pg_temp.remember('invitation_18', v_invitation::text);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.accept_invitation(pg_temp.recall('invitation_18')::uuid);
end $$;

reset role;

do $$
declare
  v_team_1 uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Tournament was created with team_size = 2, so both accepted players go
  -- on the one team (one team of 2, not two teams of 1).
  v_team_1 := (public.create_tournament_team(pg_temp.recall('tournament_18')::uuid, 'Shared Team')).id;

  perform public.assign_tournament_player(
    (select id from public.tournament_players
       where tournament_id = pg_temp.recall('tournament_18')::uuid
         and user_id = '30000000-0000-0000-0000-000000000001'),
    v_team_1
  );
  perform public.assign_tournament_player(
    (select id from public.tournament_players
       where tournament_id = pg_temp.recall('tournament_18')::uuid
         and user_id = '30000000-0000-0000-0000-000000000002'),
    v_team_1
  );

  perform public.start_tournament(pg_temp.recall('tournament_18')::uuid);
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.apply_imported_course_to_tournament(%L, %L, null)',
      pg_temp.recall('tournament_18'), pg_temp.recall('tee_id'))
  ),
  'a course cannot be imported once the tournament is live'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6) RLS: any authenticated user can read the shared course cache, but
--    cannot insert into it directly (writes are Edge-Function-only).
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(
    format('insert into public.golf_courses (external_id, club_name, course_name, imported_by, raw_payload) values (%L, %L, %L, %L, %L)',
      'gc-ext-2', 'Sneaky Club', 'Sneaky Course', '30000000-0000-0000-0000-000000000002', '{}')
  ),
  'a regular authenticated user cannot insert directly into golf_courses (RLS)'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7) create_tournament_with_course() is atomic: a successful call creates
--    both the tournament and its imported holes in one step, and a failed
--    import (e.g. an incompatible hole count) leaves no tournament behind
--    at all -- never a tournament with blank placeholder holes.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '30000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_new_tournament uuid;
begin
  v_new_tournament := public.create_tournament_with_course(
    'Atomic Cup', 'Atomic Course', current_date, 18, 'Team Scramble', 2, null,
    pg_temp.recall('tee_id')::uuid, null
  );
  perform pg_temp.remember('atomic_tournament', v_new_tournament::text);
end $$;

select is(
  (select count(*)::int from public.tournament_holes where tournament_id = pg_temp.recall('atomic_tournament')::uuid),
  18,
  'create_tournament_with_course creates the tournament and imports all 18 holes in one call'
);

select is(
  (select golf_course_tee_id from public.tournaments where id = pg_temp.recall('atomic_tournament')::uuid),
  pg_temp.recall('tee_id')::uuid,
  'create_tournament_with_course records which tee was imported'
);

do $$
declare
  v_before integer;
begin
  select count(*) into v_before from public.tournaments;
  perform pg_temp.remember('tournament_count_before_failed_atomic', v_before::text);
end $$;

select ok(
  pg_temp.expect_exception(
    format('select public.create_tournament_with_course(%L, %L, current_date, 9, %L, 2, null, %L, null)',
      'Should Not Exist Cup', 'Should Not Exist Course', 'Team Scramble', pg_temp.recall('tee_id'))
  ),
  'create_tournament_with_course rejects an 18-hole tee on a 9-hole tournament without a nine choice'
);

select is(
  (select count(*)::int from public.tournaments),
  pg_temp.recall('tournament_count_before_failed_atomic')::integer,
  'a failed import leaves no orphaned tournament behind -- the whole call rolled back'
);

select is(
  (select count(*)::int from public.tournaments where name = 'Should Not Exist Cup'),
  0,
  'specifically, the half-created tournament from the failed call does not exist'
);

reset role;

select * from finish();
rollback;
