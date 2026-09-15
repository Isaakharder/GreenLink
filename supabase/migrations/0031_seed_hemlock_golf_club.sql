-- ============================================================================
-- Adds Hemlock Golf Club (Ludington, MI) as a manual course, via the same
-- create_manual_course() entry point Tilbury's seed (0029) used -- identical
-- validation, external_id generation, and par/yardage total computation as
-- any user-entered course, no separate insert path.
--
-- GreenLink's own complete record supplements an incomplete GolfCourseAPI
-- Hemlock listing (GolfCourseAPI finds the club but has no usable
-- scorecard/tee data for it). Deduplication against that incomplete listing
-- is handled by the existing exact-name-match rule in the Edge Function's
-- mergeCourseSearchResults() (supabase/functions/golf-course-lookup/
-- mapping.ts) -- no external_id link is needed or attempted here: a manual
-- course always gets its own synthetic external_id ('manual-' || id, same as
-- every other manual course), and no GolfCourseAPI Hemlock row has ever been
-- cached locally to link against anyway (verified via a read-only query
-- before writing this migration).
--
-- Six physical tees, seven golf_course_tees rows: White carries two rows
-- (gender 'male' and 'female') sharing identical yardages/pars/handicaps but
-- distinct course_rating/slope_rating, since the source scorecard prints
-- separate men's and women's ratings for that one physical tee -- the same
-- gender-per-row model GolfCourseAPI-imported courses already use. Black/
-- Green/Blue/Orange/Gold are 'unisex' (one rating each, no gender split on
-- the scorecard), matching Tilbury's convention.
--
-- Two distinct handicap/stroke-index sequences, one per hole per tee (see
-- golf_course_tee_holes.handicap, scoped by tee_id since 0020): Black/Green/
-- Blue/Orange share the "upper tees" row, White/Gold share the "forward
-- tees" row -- both stored independently, no schema change needed.
--
-- Green hole 4 is 322 yards, not 292 -- verified against the printed
-- front-nine total (3290), which only 322 makes the nine yardages sum to.
-- ============================================================================

do $$
declare
  v_owner_id uuid;
  v_course_id uuid;

  v_pars integer[] := array[4,4,4,4,3,5,4,4,4,4,5,5,3,4,3,4,4,4];
  v_hcp_upper integer[] := array[3,17,15,9,11,5,1,13,7,10,4,2,16,6,18,8,14,12];
  v_hcp_forward integer[] := array[7,17,3,15,9,1,11,13,5,10,4,8,14,2,18,16,12,6];

  v_black_yards integer[] := array[427,328,298,360,178,552,469,416,432,428,502,585,192,356,158,404,413,403];
  v_green_yards integer[] := array[409,313,283,322,165,539,450,400,409,418,464,565,167,340,148,385,391,394];
  v_blue_yards integer[] := array[382,299,263,298,158,526,409,371,386,395,447,506,156,324,138,365,369,370];
  v_orange_yards integer[] := array[357,283,244,246,138,481,339,342,313,372,429,491,130,297,112,346,330,356];
  v_white_yards integer[] := array[311,232,197,227,134,393,289,279,309,306,356,432,106,268,100,235,289,300];
  v_gold_yards integer[] := array[311,232,132,139,55,336,289,279,309,306,356,353,106,206,100,235,289,300];

  v_black_holes jsonb;
  v_green_holes jsonb;
  v_blue_holes jsonb;
  v_orange_holes jsonb;
  v_white_holes jsonb;
  v_gold_holes jsonb;

  v_black_tee_id uuid;
  v_green_tee_id uuid;
  v_blue_tee_id uuid;
  v_orange_tee_id uuid;
  v_white_male_tee_id uuid;
  v_white_female_tee_id uuid;
  v_gold_tee_id uuid;
  v_actual_holes jsonb;
begin
  -- ---------------------------------------------------------------------
  -- Pre-insert data integrity checks -- abort before writing anything if
  -- any source-scorecard transcription doesn't hold up.
  -- ---------------------------------------------------------------------

  if (select count(distinct x) from unnest(v_hcp_upper) as x) <> 18 or (select sum(x) from unnest(v_hcp_upper) as x) <> 171 then
    raise exception 'upper-tees handicap sequence is not a valid 1-18 permutation: %', v_hcp_upper;
  end if;
  if (select count(distinct x) from unnest(v_hcp_forward) as x) <> 18 or (select sum(x) from unnest(v_hcp_forward) as x) <> 171 then
    raise exception 'forward-tees handicap sequence is not a valid 1-18 permutation: %', v_hcp_forward;
  end if;

  if (select sum(x) from unnest(v_pars) as x) <> 72 then
    raise exception 'par sequence does not sum to the printed total of 72: %', (select sum(x) from unnest(v_pars) as x);
  end if;
  if (select sum(x) from unnest(v_black_yards) as x) <> 6901 then
    raise exception 'Black yardages do not sum to the printed total of 6901: %', (select sum(x) from unnest(v_black_yards) as x);
  end if;
  if (select sum(x) from unnest(v_green_yards) as x) <> 6562 then
    raise exception 'Green yardages do not sum to the printed total of 6562: %', (select sum(x) from unnest(v_green_yards) as x);
  end if;
  if (select sum(x) from unnest(v_blue_yards) as x) <> 6162 then
    raise exception 'Blue yardages do not sum to the printed total of 6162: %', (select sum(x) from unnest(v_blue_yards) as x);
  end if;
  if (select sum(x) from unnest(v_orange_yards) as x) <> 5606 then
    raise exception 'Orange yardages do not sum to the printed total of 5606: %', (select sum(x) from unnest(v_orange_yards) as x);
  end if;
  if (select sum(x) from unnest(v_white_yards) as x) <> 4763 then
    raise exception 'White yardages do not sum to the printed total of 4763: %', (select sum(x) from unnest(v_white_yards) as x);
  end if;
  if (select sum(x) from unnest(v_gold_yards) as x) <> 4333 then
    raise exception 'Gold yardages do not sum to the printed total of 4333: %', (select sum(x) from unnest(v_gold_yards) as x);
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', v_pars[n], 'yardage', v_black_yards[n], 'handicap', v_hcp_upper[n]) order by n)
  into v_black_holes from generate_series(1, 18) as n;
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', v_pars[n], 'yardage', v_green_yards[n], 'handicap', v_hcp_upper[n]) order by n)
  into v_green_holes from generate_series(1, 18) as n;
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', v_pars[n], 'yardage', v_blue_yards[n], 'handicap', v_hcp_upper[n]) order by n)
  into v_blue_holes from generate_series(1, 18) as n;
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', v_pars[n], 'yardage', v_orange_yards[n], 'handicap', v_hcp_upper[n]) order by n)
  into v_orange_holes from generate_series(1, 18) as n;
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', v_pars[n], 'yardage', v_white_yards[n], 'handicap', v_hcp_forward[n]) order by n)
  into v_white_holes from generate_series(1, 18) as n;
  select jsonb_agg(jsonb_build_object('hole_number', n, 'par', v_pars[n], 'yardage', v_gold_yards[n], 'handicap', v_hcp_forward[n]) order by n)
  into v_gold_holes from generate_series(1, 18) as n;

  -- ---------------------------------------------------------------------
  -- Owner resolution / idempotency -- same policy as Tilbury's seed (0029).
  -- ---------------------------------------------------------------------

  select p.id into v_owner_id
  from public.profiles p
  join auth.users u on u.id = p.id
  where u.email = 'isaakiya26@live.com';

  if v_owner_id is null then
    select id into v_owner_id from public.profiles where is_admin = true order by created_at asc limit 1;
  end if;

  if v_owner_id is null then
    select id into v_owner_id from public.profiles order by created_at asc limit 1;
  end if;

  if v_owner_id is null then
    raise notice 'Hemlock Golf Club seed skipped: no profiles exist yet in this database.';
    return;
  end if;

  if exists (select 1 from public.golf_courses where club_name = 'Hemlock Golf Club' and source = 'manual') then
    raise notice 'Hemlock Golf Club already exists as a manual course -- seed skipped.';
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id, 'role', 'authenticated')::text, true);

  v_course_id := public.create_manual_course(
    'Hemlock Golf Club',
    'Hemlock Golf Club',
    null,
    'Ludington',
    'MI',
    'USA',
    null,
    null,
    jsonb_build_array(
      jsonb_build_object('tee_name', 'Black', 'gender', 'unisex', 'course_rating', 73.5, 'slope_rating', 139, 'holes', v_black_holes),
      jsonb_build_object('tee_name', 'Green', 'gender', 'unisex', 'course_rating', 71.9, 'slope_rating', 135, 'holes', v_green_holes),
      jsonb_build_object('tee_name', 'Blue', 'gender', 'unisex', 'course_rating', 69.9, 'slope_rating', 130, 'holes', v_blue_holes),
      jsonb_build_object('tee_name', 'Orange', 'gender', 'unisex', 'course_rating', 67.1, 'slope_rating', 120, 'holes', v_orange_holes),
      jsonb_build_object('tee_name', 'White', 'gender', 'male', 'course_rating', 63.3, 'slope_rating', 111, 'holes', v_white_holes),
      jsonb_build_object('tee_name', 'White', 'gender', 'female', 'course_rating', 67.3, 'slope_rating', 117, 'holes', v_white_holes),
      jsonb_build_object('tee_name', 'Gold', 'gender', 'unisex', 'course_rating', 64.7, 'slope_rating', 110, 'holes', v_gold_holes)
    ),
    true
  );

  -- ---------------------------------------------------------------------
  -- Post-insert self-verification -- abort (rolling back the whole course)
  -- if anything actually stored doesn't match what was submitted above.
  -- ---------------------------------------------------------------------

  if (select count(*) from public.golf_course_tees where golf_course_id = v_course_id and archived_at is null) <> 7 then
    raise exception 'expected exactly 7 tee rows for Hemlock Golf Club, got %',
      (select count(*) from public.golf_course_tees where golf_course_id = v_course_id and archived_at is null);
  end if;

  select id into v_black_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Black' and gender = 'unisex' and archived_at is null;
  select id into v_green_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Green' and gender = 'unisex' and archived_at is null;
  select id into v_blue_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Blue' and gender = 'unisex' and archived_at is null;
  select id into v_orange_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Orange' and gender = 'unisex' and archived_at is null;
  select id into v_white_male_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'White' and gender = 'male' and archived_at is null;
  select id into v_white_female_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'White' and gender = 'female' and archived_at is null;
  select id into v_gold_tee_id from public.golf_course_tees where golf_course_id = v_course_id and tee_name = 'Gold' and gender = 'unisex' and archived_at is null;

  if v_black_tee_id is null or v_green_tee_id is null or v_blue_tee_id is null or v_orange_tee_id is null
    or v_white_male_tee_id is null or v_white_female_tee_id is null or v_gold_tee_id is null then
    raise exception 'one or more expected Hemlock tees were not found after creation';
  end if;

  -- Exact structural comparison (hole_number/par/yardage/handicap together)
  -- for every tee, not just aggregate totals -- catches a single wrong or
  -- transposed value that happened to leave the sum unchanged.
  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_black_tee_id;
  if v_actual_holes <> v_black_holes then
    raise exception 'Hemlock Black tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_black_holes;
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_green_tee_id;
  if v_actual_holes <> v_green_holes then
    raise exception 'Hemlock Green tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_green_holes;
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_blue_tee_id;
  if v_actual_holes <> v_blue_holes then
    raise exception 'Hemlock Blue tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_blue_holes;
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_orange_tee_id;
  if v_actual_holes <> v_orange_holes then
    raise exception 'Hemlock Orange tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_orange_holes;
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_white_male_tee_id;
  if v_actual_holes <> v_white_holes then
    raise exception 'Hemlock White (male) tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_white_holes;
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_white_female_tee_id;
  if v_actual_holes <> v_white_holes then
    raise exception 'Hemlock White (female) tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_white_holes;
  end if;

  select jsonb_agg(jsonb_build_object('hole_number', hole_number, 'par', par, 'yardage', yardage, 'handicap', handicap) order by hole_number) into v_actual_holes
  from public.golf_course_tee_holes where tee_id = v_gold_tee_id;
  if v_actual_holes <> v_gold_holes then
    raise exception 'Hemlock Gold tee holes do not match what was submitted: got %, expected %', v_actual_holes, v_gold_holes;
  end if;

  -- Rating/slope and computed totals, per tee.
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_black_tee_id and par_total = 72 and yardage_total = 6901 and course_rating = 73.5 and slope_rating = 139 and number_of_holes = 18
  ) then
    raise exception 'Hemlock Black tee totals/rating do not match expectations';
  end if;
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_green_tee_id and par_total = 72 and yardage_total = 6562 and course_rating = 71.9 and slope_rating = 135 and number_of_holes = 18
  ) then
    raise exception 'Hemlock Green tee totals/rating do not match expectations';
  end if;
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_blue_tee_id and par_total = 72 and yardage_total = 6162 and course_rating = 69.9 and slope_rating = 130 and number_of_holes = 18
  ) then
    raise exception 'Hemlock Blue tee totals/rating do not match expectations';
  end if;
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_orange_tee_id and par_total = 72 and yardage_total = 5606 and course_rating = 67.1 and slope_rating = 120 and number_of_holes = 18
  ) then
    raise exception 'Hemlock Orange tee totals/rating do not match expectations';
  end if;
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_white_male_tee_id and par_total = 72 and yardage_total = 4763 and course_rating = 63.3 and slope_rating = 111 and number_of_holes = 18
  ) then
    raise exception 'Hemlock White (male) tee totals/rating do not match expectations';
  end if;
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_white_female_tee_id and par_total = 72 and yardage_total = 4763 and course_rating = 67.3 and slope_rating = 117 and number_of_holes = 18
  ) then
    raise exception 'Hemlock White (female) tee totals/rating do not match expectations';
  end if;
  if not exists (
    select 1 from public.golf_course_tees
    where id = v_gold_tee_id and par_total = 72 and yardage_total = 4333 and course_rating = 64.7 and slope_rating = 110 and number_of_holes = 18
  ) then
    raise exception 'Hemlock Gold tee totals/rating do not match expectations';
  end if;

  raise notice 'Hemlock Golf Club seeded and self-verified: golf_courses.id = %', v_course_id;
end $$;
