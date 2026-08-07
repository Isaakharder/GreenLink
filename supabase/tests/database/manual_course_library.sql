-- ============================================================================
-- pgTAP suite for the manual course library (supabase/migrations/0027).
-- Covers: create_manual_course()/replace_manual_course_tees() happy paths
-- and rejections, ownership (creator/admin/outsider), search_courses()
-- inclusion/exclusion (archived, golfcourseapi-sourced), archive/restore,
-- and that a manual course's tee flows through the exact same
-- start_personal_round()/create_tournament_with_course() pipeline an
-- imported course already does -- including that editing a *used* tee
-- never changes a round that already imported it. Same fixture pattern as
-- personal_rounds.sql. Creates its own throwaway users/courses and rolls
-- back at the end.
--
-- Run with: supabase test db
-- ============================================================================

begin;

create extension if not exists pgtap;
create extension if not exists pgcrypto;

select plan(75);

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
-- Fixtures: an owner (creates courses), an outsider (unrelated user), and an
-- admin (is_admin = true, otherwise unrelated to the owner's courses).
-- ---------------------------------------------------------------------------

do $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000001',
     'authenticated', 'authenticated', 'course-owner@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ollie', 'last_name', 'Owner', 'username', 'course_owner_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000002',
     'authenticated', 'authenticated', 'course-outsider@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Otto', 'last_name', 'Outsider', 'username', 'course_outsider_test'),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000003',
     'authenticated', 'authenticated', 'course-admin@example.test',
     crypt('password123', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('first_name', 'Ada', 'last_name', 'Admin', 'username', 'course_admin_test'),
     now(), now(), '', '', '', '');

  update public.profiles set is_admin = true where id = '50000000-0000-0000-0000-000000000003';
end $$;

-- A golfcourseapi-sourced row, inserted the way the golf-course-lookup Edge
-- Function's service-role client would (no RLS insert policy exists for a
-- regular authenticated session -- by design, see 0020) -- done here, still
-- under the table owner, before any `set local role authenticated` below.
-- published_at is stamped explicitly (0030: handleImport() now does this on
-- every import -- omitting it here would just be testing a fixture that can
-- no longer occur in production).
do $$
declare
  v_api_course_id uuid;
  v_api_tee_id uuid;
begin
  insert into public.golf_courses (external_id, club_name, course_name, city, imported_by, raw_payload, published_at)
  values ('api-fixture-1', 'Api Sourced Club', 'Api Course', 'Fixtureville', '50000000-0000-0000-0000-000000000001', '{}'::jsonb, now())
  returning id into v_api_course_id;
  perform pg_temp.remember('api_course', v_api_course_id::text);

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total)
  values (v_api_course_id, 'Blue', 'male', 9, 36)
  returning id into v_api_tee_id;
  perform pg_temp.remember('api_tee', v_api_tee_id::text);

  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_api_tee_id, n, 4 from generate_series(1, 9) as n;
end $$;

-- ---------------------------------------------------------------------------
-- Regression fixtures for the Orchard View Golf Club production incident
-- (0030): a complete, already-imported golfcourseapi course must be
-- findable via search_courses() and correctly flagged usable, an
-- unpublished golfcourseapi row must stay invisible regardless of source,
-- a course with one archived and one active tee must count only the
-- active one, and a course with one broken tee alongside one valid tee
-- must not be flagged unusable overall.
-- ---------------------------------------------------------------------------

do $$
declare
  v_complete_id uuid;
  v_duplicate_id uuid;
  v_unpublished_id uuid;
  v_archived_pair_id uuid;
  v_mixed_id uuid;
  v_tee_id uuid;
begin
  -- Complete, published, previously-imported course (stands in for the real
  -- Orchard View Golf Club row, external_id 25562).
  insert into public.golf_courses (external_id, club_name, course_name, city, imported_by, raw_payload, published_at)
  values ('regression-complete-1', 'Regression Orchard Golf Club', 'Regression Orchard Golf Club', 'Fixtureville',
    '50000000-0000-0000-0000-000000000001', '{}'::jsonb, now())
  returning id into v_complete_id;
  perform pg_temp.remember('regression_complete', v_complete_id::text);

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total)
  values (v_complete_id, 'White', 'male', 9, 36)
  returning id into v_tee_id;
  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_tee_id, n, 4 from generate_series(1, 9) as n;

  -- Incomplete duplicate (stands in for the broken "(Old)" listing, external_id
  -- 'zcvtyq4k') -- published (matching the real broken row found in
  -- production), zero tees.
  insert into public.golf_courses (external_id, club_name, course_name, city, imported_by, raw_payload, published_at)
  values ('regression-duplicate-1', 'Regression Orchard Golf Club', 'Regression Orchard Golf Club (Old)', 'Fixtureville',
    '50000000-0000-0000-0000-000000000001', '{}'::jsonb, now())
  returning id into v_duplicate_id;
  perform pg_temp.remember('regression_duplicate', v_duplicate_id::text);

  -- A golfcourseapi-sourced course that was imported but never published
  -- (published_at null) -- must stay invisible to search_courses() no
  -- matter how complete its tee data is; source alone is no longer the
  -- gate, published_at still is.
  insert into public.golf_courses (external_id, club_name, course_name, city, imported_by, raw_payload)
  values ('regression-unpublished-1', 'Regression Unpublished Club', 'Regression Unpublished Course', 'Fixtureville',
    '50000000-0000-0000-0000-000000000001', '{}'::jsonb)
  returning id into v_unpublished_id;
  perform pg_temp.remember('regression_unpublished', v_unpublished_id::text);

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total)
  values (v_unpublished_id, 'Blue', 'male', 9, 36)
  returning id into v_tee_id;
  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_tee_id, n, 4 from generate_series(1, 9) as n;

  -- A tee that was edited after being used (archived) plus its active
  -- replacement -- only the active one should count towards usability.
  insert into public.golf_courses (external_id, club_name, course_name, city, imported_by, raw_payload, published_at)
  values ('regression-archived-pair-1', 'Regression Archived Pair Club', 'Regression Archived Pair Club', 'Fixtureville',
    '50000000-0000-0000-0000-000000000001', '{}'::jsonb, now())
  returning id into v_archived_pair_id;
  perform pg_temp.remember('regression_archived_pair', v_archived_pair_id::text);

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total, archived_at)
  values (v_archived_pair_id, 'Blue', 'male', 9, 32, now())
  returning id into v_tee_id;
  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_tee_id, n, 3 from generate_series(1, 9) as n;

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total)
  values (v_archived_pair_id, 'Blue', 'male', 9, 36)
  returning id into v_tee_id;
  perform pg_temp.remember('regression_archived_pair_active_tee', v_tee_id::text);
  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_tee_id, n, 4 from generate_series(1, 9) as n;

  -- One usable 9-hole tee alongside one broken tee (missing a par on one
  -- hole) at the same course -- the course as a whole must still read as
  -- usable, and the broken tee must not be counted.
  insert into public.golf_courses (external_id, club_name, course_name, city, imported_by, raw_payload, published_at)
  values ('regression-mixed-1', 'Regression Mixed Tee Club', 'Regression Mixed Tee Club', 'Fixtureville',
    '50000000-0000-0000-0000-000000000001', '{}'::jsonb, now())
  returning id into v_mixed_id;
  perform pg_temp.remember('regression_mixed', v_mixed_id::text);

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total)
  values (v_mixed_id, 'Valid', 'male', 9, 36)
  returning id into v_tee_id;
  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_tee_id, n, 4 from generate_series(1, 9) as n;

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total)
  values (v_mixed_id, 'Broken', 'female', 9, null)
  returning id into v_tee_id;
  -- Only 8 of 9 holes get a par row -- an incomplete tee, still non-archived.
  insert into public.golf_course_tee_holes (tee_id, hole_number, par)
  select v_tee_id, n, 4 from generate_series(1, 8) as n;
end $$;

-- ---------------------------------------------------------------------------
-- 1) create_manual_course(): 9-hole and 18-hole happy paths.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Fixture Golf Club', 'Nine Layout', '1 Fixture Rd', 'Fixtureville', 'NC', 'USA', 35.1, -79.2,
    jsonb_build_array(jsonb_build_object(
      'tee_name', 'White', 'gender', 'unisex', 'course_rating', 34.5, 'slope_rating', 118,
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4, 'yardage', 350)) from generate_series(1, 9) as n)
    ))
  );
  perform pg_temp.remember('course_9', v_course_id::text);
end $$;

select ok((select true from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'a manual 9-hole course was created');
select is((select source from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'manual', 'the new course is sourced as manual');
select is((select created_by from public.golf_courses where id = pg_temp.recall('course_9')::uuid), '50000000-0000-0000-0000-000000000001'::uuid, 'created_by records the creator');
select is((select external_id from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'manual-' || pg_temp.recall('course_9'), 'a synthetic external_id lets the existing import short-circuit serve this course too');
select is((select count(*)::int from public.golf_course_tees where golf_course_id = pg_temp.recall('course_9')::uuid), 1, 'one tee was saved');
select is((select number_of_holes from public.golf_course_tees where golf_course_id = pg_temp.recall('course_9')::uuid), 9, 'the tee has 9 holes');
select is(
  (select count(*)::int from public.golf_course_tee_holes h join public.golf_course_tees t on t.id = h.tee_id where t.golf_course_id = pg_temp.recall('course_9')::uuid),
  9, 'exactly 9 hole rows were written -- no fabricated holes'
);
select is((select yardage_total from public.golf_course_tees where golf_course_id = pg_temp.recall('course_9')::uuid), 3150, 'yardage_total is calculated when every hole has a yardage');

do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Fixture Golf Club', 'Eighteen Layout', null, 'Fixtureville', 'NC', 'USA', null, null,
    jsonb_build_array(jsonb_build_object(
      'tee_name', 'Blue', 'gender', 'male',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 18) as n)
    ))
  );
  perform pg_temp.remember('course_18', v_course_id::text);
end $$;

select is((select number_of_holes from public.golf_course_tees where golf_course_id = pg_temp.recall('course_18')::uuid), 18, 'a manual 18-hole course was created');
select is((select yardage_total from public.golf_course_tees where golf_course_id = pg_temp.recall('course_18')::uuid), null::integer, 'yardage_total stays null when yardage was never entered -- never invented');
select is((select course_rating from public.golf_course_tees where golf_course_id = pg_temp.recall('course_18')::uuid), null::numeric, 'course rating stays null when omitted');

-- ---------------------------------------------------------------------------
-- 2) Multiple tees, and a copied tee can be modified independently.
-- ---------------------------------------------------------------------------

do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Multi Tee Club', 'Championship', null, null, null, null, null, null,
    jsonb_build_array(
      jsonb_build_object('tee_name', 'Blue', 'gender', 'male', 'par_total', null,
        'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4, 'yardage', 400)) from generate_series(1, 18) as n)),
      jsonb_build_object('tee_name', 'White', 'gender', 'male',
        'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4, 'yardage', 360)) from generate_series(1, 18) as n))
    )
  );
  perform pg_temp.remember('multi_tee_course', v_course_id::text);
end $$;

select is((select count(*)::int from public.golf_course_tees where golf_course_id = pg_temp.recall('multi_tee_course')::uuid), 2, 'both tees were saved from one create_manual_course() call');

do $$
declare
  v_course_id uuid;
  v_blue_id uuid;
  v_blue_holes jsonb;
  v_gold_holes jsonb;
begin
  v_course_id := pg_temp.recall('multi_tee_course')::uuid;
  select id into v_blue_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Blue';

  select jsonb_agg(jsonb_build_object('hole_number', h.hole_number, 'par', h.par, 'yardage', h.yardage))
  into v_blue_holes
  from public.golf_course_tee_holes h where h.tee_id = v_blue_id;

  -- "Copy Blue as a starting point for Gold": same pars, shorter yardage,
  -- submitted with no tee_id (a brand new tee) alongside the untouched
  -- Blue/White (both keeping their tee_id).
  select jsonb_agg(jsonb_build_object('hole_number', elem ->> 'hole_number', 'par', elem ->> 'par', 'yardage', (elem ->> 'yardage')::integer - 40))
  into v_gold_holes
  from jsonb_array_elements(v_blue_holes) as elem;

  perform public.replace_manual_course_tees(v_course_id, jsonb_build_array(
    jsonb_build_object('tee_id', v_blue_id, 'tee_name', 'Blue', 'gender', 'male', 'holes', v_blue_holes),
    jsonb_build_object('tee_id', (select id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'White'), 'tee_name', 'White', 'gender', 'male',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', h.hole_number, 'par', h.par, 'yardage', h.yardage)) from public.golf_course_tee_holes h join public.golf_course_tees t on t.id = h.tee_id where t.golf_course_id = v_course_id and t.tee_name = 'White')),
    jsonb_build_object('tee_name', 'Gold', 'gender', 'male', 'holes', v_gold_holes)
  ));
  perform pg_temp.remember('gold_tee_yardage', (select yardage_total::text from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Gold'));
  perform pg_temp.remember('blue_tee_yardage', (select yardage_total::text from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Blue'));
end $$;

select is((select count(*)::int from public.golf_course_tees where golf_course_id = pg_temp.recall('multi_tee_course')::uuid and archived_at is null), 3, 'the copied Gold tee was added alongside Blue and White, unarchived');
select isnt(pg_temp.recall('gold_tee_yardage'), pg_temp.recall('blue_tee_yardage'), 'editing the copied Gold tee (shorter yardage) never changed the original Blue tee it was copied from');
select is(pg_temp.recall('blue_tee_yardage'), (18 * 400)::text, 'Blue''s own yardage is untouched by the copy');

-- ---------------------------------------------------------------------------
-- 3) Validation rejections.
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb)',
    'Bad Club', 'Bad Course',
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'male',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 10) as n)))::text
  )),
  'a tee with 10 holes (neither 9 nor 18) is rejected'
);

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb)',
    'Bad Club', 'Bad Course',
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'male',
      'holes', jsonb_build_array(jsonb_build_object('hole_number', 1, 'par', 2))))::text
  )),
  'a hole with par 2 (outside 3-6) is rejected'
);

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb)',
    'Bad Club', 'Bad Course',
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'male',
      'holes', jsonb_build_array(
        jsonb_build_object('hole_number', 1, 'par', 4),
        jsonb_build_object('hole_number', 1, 'par', 4)
      )))::text
  )),
  'duplicate hole numbers are rejected'
);

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb)',
    'Bad Club', 'Bad Course', '[]'::text
  )),
  'a course with zero tees is rejected -- at least one valid tee is required to publish'
);

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb)',
    'Bad Club', 'Bad Course',
    jsonb_build_array(jsonb_build_object('tee_name', '', 'gender', 'male',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n)))::text
  )),
  'a blank tee name is rejected'
);

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb)',
    'Bad Club', 'Bad Course',
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'martian',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n)))::text
  )),
  'an invalid gender value is rejected'
);

-- ---------------------------------------------------------------------------
-- 4) search_courses(): matches club/course/city/state/country, excludes
--    archived and unpublished rows (0030: source is no longer a gate --
--    see the Orchard View regression fixtures/tests below).
-- ---------------------------------------------------------------------------

select ok(
  (select true from public.search_courses('Fixture Golf Club') where id = pg_temp.recall('course_9')::uuid),
  'search_courses matches by club name'
);
select ok(
  (select true from public.search_courses('Eighteen Layout') where id = pg_temp.recall('course_18')::uuid),
  'search_courses matches by course/layout name'
);
select ok(
  (select true from public.search_courses('Fixtureville') where id = pg_temp.recall('course_9')::uuid),
  'search_courses matches by city'
);

select is(
  (select count(*)::int from public.search_courses('Api Sourced Club')),
  1,
  'a published, usable golfcourseapi-sourced row IS returned by search_courses (0030 fix -- previously excluded by source alone, which is what let a complete, already-imported course go permanently unmatched)'
);
select ok(
  (select has_usable_tee from public.search_courses('Api Sourced Club') where id = pg_temp.recall('api_course')::uuid),
  'the previously-cached golfcourseapi course is flagged has_usable_tee'
);

-- --- Orchard View regression coverage (0030) -----------------------------

select is(
  (select count(*)::int from public.search_courses('Regression Orchard Golf Club')),
  2,
  'both the complete course and its incomplete duplicate are returned -- search_courses() does not dedupe by name, that is the Edge Function''s mergeCourseSearchResults() job'
);
select ok(
  (select has_usable_tee and usable_tee_count > 0 from public.search_courses('Regression Orchard Golf Club') where id = pg_temp.recall('regression_complete')::uuid),
  'the complete, previously-imported course is flagged usable with a positive tee count'
);
select ok(
  (select not has_usable_tee and usable_tee_count = 0 from public.search_courses('Regression Orchard Golf Club') where id = pg_temp.recall('regression_duplicate')::uuid),
  'the zero-tee duplicate is flagged unusable, never confused with the complete course it duplicates'
);

select is(
  (select count(*)::int from public.search_courses('Regression Unpublished')),
  0,
  'an unpublished golfcourseapi-sourced course stays invisible to search regardless of how complete its tee data is -- published_at is the gate, not source'
);

select is(
  (select usable_tee_count from public.search_courses('Regression Archived Pair Club') where id = pg_temp.recall('regression_archived_pair')::uuid),
  1,
  'an archived tee superseded by an edit is never counted, even though its replacement is -- only the active tee counts'
);

select ok(
  (select has_usable_tee and usable_tee_count = 1 from public.search_courses('Regression Mixed Tee Club') where id = pg_temp.recall('regression_mixed')::uuid),
  'one incomplete tee (missing a hole''s par) never makes the whole course unusable when another tee on it is complete -- and the incomplete tee itself is excluded from the count'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5) Ownership: creator can edit, an unrelated user cannot, an admin can.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  (select not pg_temp.expect_exception(format(
    'select public.update_manual_course_info(%L::uuid, %L, %L, null,null,null,null,null,null)',
    pg_temp.recall('course_9'), 'Fixture Golf Club (Updated)', 'Nine Layout'
  ))),
  'the creator can edit their own course'
);
select is((select club_name from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'Fixture Golf Club (Updated)', 'the edit was applied');

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format(
    'select public.update_manual_course_info(%L::uuid, %L, %L, null,null,null,null,null,null)',
    pg_temp.recall('course_9'), 'Hijacked', 'Hijacked'
  )),
  'an unrelated user cannot edit someone else''s course'
);
select ok(
  pg_temp.expect_exception(format('select public.archive_manual_course(%L::uuid)', pg_temp.recall('course_9'))),
  'an unrelated user cannot archive someone else''s course'
);
select is((select club_name from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'Fixture Golf Club (Updated)', 'the hijack attempt left the course unchanged');

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  (select not pg_temp.expect_exception(format(
    'select public.update_manual_course_info(%L::uuid, %L, %L, null,null,null,null,null,null)',
    pg_temp.recall('course_9'), 'Fixture Golf Club (Admin Edit)', 'Nine Layout'
  ))),
  'an administrator can edit a course they did not create'
);
select is((select club_name from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'Fixture Golf Club (Admin Edit)', 'the admin edit was applied');

select ok(
  (select not pg_temp.expect_exception(format('select public.archive_manual_course(%L::uuid)', pg_temp.recall('course_9')))),
  'an administrator can archive a course they did not create'
);
select ok((select archived_at is not null from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'the course is archived');
select is(
  (select count(*)::int from public.search_courses('Fixture Golf Club') where id = pg_temp.recall('course_9')::uuid),
  0,
  'an archived course disappears from search (its sibling course_18, same club name, still appears)'
);

select ok(
  (select not pg_temp.expect_exception(format('select public.restore_manual_course(%L::uuid)', pg_temp.recall('course_9')))),
  'an administrator can restore an archived course'
);
select ok((select archived_at is null from public.golf_courses where id = pg_temp.recall('course_9')::uuid), 'the course is no longer archived');
select ok(
  (select true from public.search_courses('Fixture Golf Club') where id = pg_temp.recall('course_9')::uuid),
  'a restored course reappears in search'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6) A manual course's tee works everywhere an imported tee already does:
--    starts a personal round (My Golf), and creates a tournament -- through
--    the exact same p_tee_id / apply_imported_course_to_tournament() path.
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_tee_id uuid;
  v_round_id uuid;
begin
  select id into v_tee_id from public.golf_course_tees where golf_course_id = pg_temp.recall('course_18')::uuid;
  perform pg_temp.remember('course_18_tee', v_tee_id::text);
  v_round_id := public.start_personal_round('Fixture Golf Club - Eighteen Layout', current_date, 18, v_tee_id, null, 'walking');
  perform pg_temp.remember('manual_personal_round', v_round_id::text);
end $$;

select is(
  (select count(*)::int from public.tournament_holes where tournament_id = pg_temp.recall('manual_personal_round')::uuid),
  18,
  'a manual course''s tee starts a personal round via the unchanged p_tee_id/apply_imported_course_to_tournament() path'
);
select ok(
  (select is_personal from public.tournaments where id = pg_temp.recall('manual_personal_round')::uuid),
  'the round is a personal round like any other'
);

do $$
declare
  v_tournament_id uuid;
begin
  v_tournament_id := public.create_tournament_with_course(
    'Fixture Cup', 'Fixture Golf Club - Eighteen Layout', current_date, 18, null, null, null,
    pg_temp.recall('course_18_tee')::uuid, null
  );
  perform pg_temp.remember('manual_tournament', v_tournament_id::text);
end $$;

select is(
  (select count(*)::int from public.tournament_holes where tournament_id = pg_temp.recall('manual_tournament')::uuid),
  18,
  'a manual course''s tee creates a tournament via the unchanged create_tournament_with_course() path'
);

-- ---------------------------------------------------------------------------
-- 7) Historical-data protection: editing a *used* tee forks instead of
--    mutating it -- the already-started round above keeps its original
--    pars, and a *new* round picks up the edited data.
-- ---------------------------------------------------------------------------

do $$
declare
  v_original_par integer;
  v_new_holes jsonb;
begin
  select par into v_original_par
  from public.tournament_holes
  where tournament_id = pg_temp.recall('manual_personal_round')::uuid and hole_number = 1;
  perform pg_temp.remember('original_hole1_par', v_original_par::text);

  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 5)) into v_new_holes from generate_series(1, 18) as n;

  perform public.replace_manual_course_tees(pg_temp.recall('course_18')::uuid, jsonb_build_array(
    jsonb_build_object('tee_id', pg_temp.recall('course_18_tee'), 'tee_name', 'Blue', 'gender', 'male', 'holes', v_new_holes)
  ));
end $$;

select ok(
  (select archived_at is not null from public.golf_course_tees where id = pg_temp.recall('course_18_tee')::uuid),
  'editing a tee that a round already used archives (forks) it instead of mutating it in place'
);
select is(
  (select par from public.golf_course_tee_holes where tee_id = pg_temp.recall('course_18_tee')::uuid and hole_number = 1),
  pg_temp.recall('original_hole1_par')::integer,
  'the archived tee''s own hole data is untouched -- still exactly what it was'
);
select is(
  (select par from public.tournament_holes where tournament_id = pg_temp.recall('manual_personal_round')::uuid and hole_number = 1),
  pg_temp.recall('original_hole1_par')::integer,
  'the already-started round''s tournament_holes are completely unaffected by the edit'
);

do $$
declare
  v_new_tee_id uuid;
  v_new_round_id uuid;
begin
  select id into v_new_tee_id
  from public.golf_course_tees
  where golf_course_id = pg_temp.recall('course_18')::uuid and archived_at is null;
  perform pg_temp.remember('course_18_tee_v2', v_new_tee_id::text);

  v_new_round_id := public.start_personal_round('Fixture Golf Club - Eighteen Layout (v2)', current_date, 18, v_new_tee_id, null, 'walking');
  perform pg_temp.remember('manual_personal_round_v2', v_new_round_id::text);
end $$;

select is(
  (select par from public.tournament_holes where tournament_id = pg_temp.recall('manual_personal_round_v2')::uuid and hole_number = 1),
  5,
  'a future round started with the current (forked) tee picks up the edited par'
);
select isnt(pg_temp.recall('course_18_tee_v2'), pg_temp.recall('course_18_tee'), 'the future round used a different, newer tee id than the historical round');

-- ---------------------------------------------------------------------------
-- 8) Regression: existing GolfCourseAPI-sourced tees are completely
--    unaffected -- flattenTees()/handleImport() territory is untouched by
--    this migration, but the shared golf_course_tees table/constraints now
--    also serve manual data, so this proves nothing here broke that path.
-- ---------------------------------------------------------------------------

do $$
declare
  v_round_id uuid;
begin
  v_round_id := public.start_personal_round('Api Sourced Club', current_date, 9, pg_temp.recall('api_tee')::uuid, null, 'cart');
  perform pg_temp.remember('api_round', v_round_id::text);
end $$;

select is(
  (select count(*)::int from public.tournament_holes where tournament_id = pg_temp.recall('api_round')::uuid),
  9,
  'an existing GolfCourseAPI-style tee (gender male, no yardage_total/archived_at set) still starts a round normally'
);

reset role;

-- ---------------------------------------------------------------------------
-- 9) Draft/publish lifecycle (0028): a draft may be saved with zero tees or
--    an incomplete tee (some holes still missing a par); publishing
--    requires every current tee to be fully complete, and only published
--    courses are ever returned by search_courses()/find_similar_courses().
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

-- 9a) A draft with zero tees.
do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Draft Only Club', 'Unnamed Layout', null, 'Fixtureville', null, null, null, null, '[]'::jsonb, false
  );
  perform pg_temp.remember('draft_no_tees', v_course_id::text);
end $$;

select ok((select true from public.golf_courses where id = pg_temp.recall('draft_no_tees')::uuid), 'a draft can be created with zero tees');
select is((select published_at from public.golf_courses where id = pg_temp.recall('draft_no_tees')::uuid), null::timestamptz, 'a draft has no published_at');
select is((select count(*)::int from public.search_courses('Draft Only Club')), 0, 'a draft with zero tees never appears in search_courses');

select ok(
  pg_temp.expect_exception(format('select public.publish_manual_course(%L::uuid)', pg_temp.recall('draft_no_tees'))),
  'publishing a draft with zero tees is rejected'
);

-- 9b) A draft with one incomplete tee (6 of 9 holes have a par).
do $$
declare
  v_course_id uuid;
  v_holes jsonb;
begin
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', case when n <= 6 then 4 else null end))
  into v_holes from generate_series(1, 9) as n;

  v_course_id := public.create_manual_course(
    'Draft Incomplete Club', 'Partial Layout', null, 'Fixtureville', null, null, null, null,
    jsonb_build_array(jsonb_build_object('tee_name', 'White', 'gender', 'unisex', 'holes', v_holes)),
    false
  );
  perform pg_temp.remember('draft_incomplete', v_course_id::text);
  perform pg_temp.remember('draft_incomplete_tee', (select id::text from public.golf_course_tees where golf_course_id = v_course_id));
end $$;

select is(
  (select number_of_holes from public.golf_course_tees where id = pg_temp.recall('draft_incomplete_tee')::uuid),
  9, 'an incomplete draft tee still records the full declared hole count'
);
select is(
  (select count(*)::int from public.golf_course_tee_holes where tee_id = pg_temp.recall('draft_incomplete_tee')::uuid),
  6, 'only the holes that actually have a par were written -- the other 3 are represented by absence, not a fabricated par'
);

select ok(
  pg_temp.expect_exception(format('select public.publish_manual_course(%L::uuid)', pg_temp.recall('draft_incomplete'))),
  'publishing a course with an incomplete tee is rejected'
);

select ok(
  pg_temp.expect_exception(format(
    'select public.create_manual_course(%L, %L, null,null,null,null,null,null, %L::jsonb, true)',
    'Bad Publish', 'Bad Publish',
    jsonb_build_array(jsonb_build_object('tee_name', 'White', 'gender', 'unisex',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', case when n = 1 then null else 4 end)) from generate_series(1, 9) as n)))::text
  )),
  'publishing (create_manual_course p_publish=true) with a hole missing a par is rejected, same as before this migration'
);

-- Complete the tee via replace_manual_course_tees, still as a draft (p_publish=false) --
-- published_at must stay null even though the tee itself is now complete.
do $$
declare
  v_full_holes jsonb;
begin
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) into v_full_holes from generate_series(1, 9) as n;
  perform public.replace_manual_course_tees(
    pg_temp.recall('draft_incomplete')::uuid,
    jsonb_build_array(jsonb_build_object('tee_id', pg_temp.recall('draft_incomplete_tee'), 'tee_name', 'White', 'gender', 'unisex', 'holes', v_full_holes)),
    false
  );
end $$;

select is(
  (select published_at from public.golf_courses where id = pg_temp.recall('draft_incomplete')::uuid),
  null::timestamptz,
  'completing a tee via replace_manual_course_tees(p_publish=false) does not publish the course'
);
select is(
  (select count(*)::int from public.golf_course_tee_holes where tee_id = pg_temp.recall('draft_incomplete_tee')::uuid),
  9, 'the tee is now complete after the draft-mode edit'
);

select ok(
  (select not pg_temp.expect_exception(format('select public.publish_manual_course(%L::uuid)', pg_temp.recall('draft_incomplete')))),
  'publish_manual_course succeeds once every current tee is complete'
);
select ok(
  (select published_at is not null from public.golf_courses where id = pg_temp.recall('draft_incomplete')::uuid),
  'published_at is set after publishing'
);
select ok(
  (select true from public.search_courses('Draft Incomplete Club') where id = pg_temp.recall('draft_incomplete')::uuid),
  'the course appears in search_courses immediately after publishing'
);

reset role;

-- 9c) Ownership on publish_manual_course(): outsider cannot, admin can.
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Draft Ownership Club', 'Layout', null, null, null, null, null, null,
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'unisex',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n))),
    false
  );
  perform pg_temp.remember('draft_ownership', v_course_id::text);
end $$;

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  pg_temp.expect_exception(format('select public.publish_manual_course(%L::uuid)', pg_temp.recall('draft_ownership'))),
  'an unrelated user cannot publish someone else''s draft'
);

reset role;

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  (select not pg_temp.expect_exception(format('select public.publish_manual_course(%L::uuid)', pg_temp.recall('draft_ownership')))),
  'an administrator can publish a draft they did not create'
);
select ok(
  (select published_at is not null from public.golf_courses where id = pg_temp.recall('draft_ownership')::uuid),
  'the admin-published draft is now published'
);

reset role;

-- ---------------------------------------------------------------------------
-- 10) find_similar_courses() (0028): a duplicate-warning trigger, never an
--     automatic merge -- matches by name/city/coordinates among published
--     courses only, excludes archived rows, drafts, and the record being
--     excluded (p_exclude_course_id).
-- ---------------------------------------------------------------------------

do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '50000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

select ok(
  (select true from public.find_similar_courses('Fixture Golf Club', 'Nine Layout') where id = pg_temp.recall('course_9')::uuid),
  'find_similar_courses matches by club name'
);
-- course_18 (unlike course_9) was never renamed/re-cityed by the section 5
-- ownership-edit tests, so its city is still exactly what create_manual_course
-- set at fixture setup -- a stable target for a city-only match (deliberately
-- unrelated club/course name terms, so only the city condition can match).
select ok(
  (select true from public.find_similar_courses('Some Unrelated Name', 'Some Other Name', 'Fixtureville') where id = pg_temp.recall('course_18')::uuid),
  'find_similar_courses matches by city even when the names differ'
);

-- Dedicated, uniquely-named fixtures for the exclusion assertions below --
-- reusing course_9/course_18 (siblings under the same club, by design, for
-- the multi-course-per-club tests earlier) would make "excludes X" checks
-- ambiguous against their shared club name.
do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Archived Similar Club', 'Old Layout', null, 'Fixtureville', null, null, null, null,
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'unisex',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n))),
    true
  );
  perform pg_temp.remember('archived_similar', v_course_id::text);
  perform public.archive_manual_course(v_course_id);
end $$;

select is(
  (select count(*)::int from public.find_similar_courses('Archived Similar Club', 'Old Layout')),
  0,
  'find_similar_courses excludes archived rows'
);

do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Truly Private Draft Club', 'Hidden From Everyone Layout', null, null, null, null, null, null,
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'unisex',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n))),
    false
  );
  perform pg_temp.remember('private_draft', v_course_id::text);
end $$;

select is(
  (select count(*)::int from public.find_similar_courses('Truly Private Draft Club', 'Hidden From Everyone Layout')),
  0,
  'find_similar_courses never surfaces another user''s still-unpublished draft'
);

do $$
declare
  v_course_id uuid;
begin
  v_course_id := public.create_manual_course(
    'Self Exclude Test Club', 'Only Layout Ever Named This', null, null, null, null, null, null,
    jsonb_build_array(jsonb_build_object('tee_name', 'Blue', 'gender', 'unisex',
      'holes', (select jsonb_agg(jsonb_build_object('hole_number', n, 'par', 4)) from generate_series(1, 9) as n))),
    true
  );
  perform pg_temp.remember('self_exclude', v_course_id::text);
end $$;

select is(
  (select count(*)::int from public.find_similar_courses('Self Exclude Test Club', 'Only Layout Ever Named This', null, null, null, pg_temp.recall('self_exclude')::uuid)),
  0,
  'p_exclude_course_id lets a course exclude itself from its own duplicate check'
);

reset role;

select * from finish();
rollback;
