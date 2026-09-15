-- ============================================================================
-- Adds Tilbury Golf Club (Blue and Red tees, 18 holes each) as a manual
-- course, via the same create_manual_course() entry point the Add Course
-- UI already calls (impersonating an existing profile the same way the
-- pgTAP suite does -- see supabase/tests/database/manual_course_library.sql
-- -- so this gets identical validation, external_id generation, and
-- par/yardage total computation as any user-entered course; no separate
-- insert path).
--
-- golf_course_tee_holes has always had a `handicap` column (0020) that
-- GolfCourseAPI-imported tees already populate, but the manual-course
-- insert path (0027/0028) never wired it up -- the original manual-course-
-- creator spec only asked for hole number/par/yardage, so there was never
-- a caller that supplied one. This course's source scorecard includes a
-- stroke-index per hole per tee, and "insert it exactly the same way
-- GolfCourseAPI imported courses are stored" means that column should be
-- populated here too. Extending insert_manual_course_tee()/
-- replace_manual_course_tees() to accept an optional 'handicap' per hole
-- (both `create or replace`, same signatures, so every existing manual-
-- course call site that never supplies one is unaffected -- handicap stays
-- null exactly as before) is a symmetry fix to the existing infrastructure,
-- not a new schema or a special-cased path for this one course.
-- ============================================================================

create or replace function public.insert_manual_course_tee(p_course_id uuid, p_tee jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tee_id uuid;
  v_par_total integer;
  v_yardage_total integer;
  v_course_rating numeric;
  v_slope_rating integer;
begin
  select sum((elem ->> 'par')::integer) into v_par_total
  from jsonb_array_elements(p_tee -> 'holes') as elem
  where (elem ->> 'par') is not null;

  select sum((elem ->> 'yardage')::integer) into v_yardage_total
  from jsonb_array_elements(p_tee -> 'holes') as elem
  where (elem ->> 'yardage') is not null;

  if (select count(*) from jsonb_array_elements(p_tee -> 'holes') as elem where (elem ->> 'yardage') is null) > 0 then
    v_yardage_total := null;
  end if;

  v_course_rating := nullif(p_tee ->> 'course_rating', '')::numeric;
  v_slope_rating := nullif(p_tee ->> 'slope_rating', '')::integer;

  insert into public.golf_course_tees (golf_course_id, tee_name, gender, number_of_holes, par_total, course_rating, slope_rating, yardage_total)
  values (
    p_course_id,
    trim(both from (p_tee ->> 'tee_name')),
    p_tee ->> 'gender',
    (select count(*) from jsonb_array_elements(p_tee -> 'holes')),
    v_par_total,
    v_course_rating,
    v_slope_rating,
    v_yardage_total
  )
  returning id into v_tee_id;

  insert into public.golf_course_tee_holes (tee_id, hole_number, par, yardage, handicap)
  select
    v_tee_id,
    (elem ->> 'hole_number')::integer,
    (elem ->> 'par')::integer,
    nullif(elem ->> 'yardage', '')::integer,
    nullif(elem ->> 'handicap', '')::integer
  from jsonb_array_elements(p_tee -> 'holes') as elem
  where (elem ->> 'par') is not null;

  return v_tee_id;
end;
$$;

revoke execute on function public.insert_manual_course_tee(uuid, jsonb) from public;

-- Same handicap wiring for the in-place edit branch of
-- replace_manual_course_tees() (the "not v_ever_used" path writes directly
-- to golf_course_tee_holes rather than going through
-- insert_manual_course_tee()) -- otherwise editing a tee that already has
-- handicap values (e.g. a future edit to this very course) would silently
-- drop them. Everything else in this function is unchanged from 0028.
create or replace function public.replace_manual_course_tees(p_course_id uuid, p_tees jsonb, p_publish boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tee jsonb;
  v_current_id uuid;
  v_ever_used boolean;
  v_mentioned_ids uuid[];
begin
  if not public.can_manage_course(p_course_id) then
    raise exception 'only the course creator or an administrator can edit this course';
  end if;

  if p_publish and (p_tees is null or jsonb_typeof(p_tees) <> 'array' or jsonb_array_length(p_tees) = 0) then
    raise exception 'at least one tee is required to publish a course';
  end if;

  if p_tees is null or jsonb_typeof(p_tees) <> 'array' then
    p_tees := '[]'::jsonb;
  end if;

  for v_tee in select * from jsonb_array_elements(p_tees)
  loop
    perform public.validate_manual_tee(v_tee, p_publish);
  end loop;

  select coalesce(array_agg(nullif(elem ->> 'tee_id', '')::uuid), '{}')
  into v_mentioned_ids
  from jsonb_array_elements(p_tees) as elem
  where nullif(elem ->> 'tee_id', '') is not null;

  for v_current_id in
    select id from public.golf_course_tees
    where golf_course_id = p_course_id and archived_at is null and not (id = any (v_mentioned_ids))
  loop
    select exists (select 1 from public.tournaments where golf_course_tee_id = v_current_id) into v_ever_used;
    if v_ever_used then
      update public.golf_course_tees set archived_at = now() where id = v_current_id;
    else
      delete from public.golf_course_tees where id = v_current_id;
    end if;
  end loop;

  for v_tee in select * from jsonb_array_elements(p_tees)
  loop
    v_current_id := nullif(v_tee ->> 'tee_id', '')::uuid;

    if v_current_id is null then
      perform public.insert_manual_course_tee(p_course_id, v_tee);
      continue;
    end if;

    if not exists (select 1 from public.golf_course_tees where id = v_current_id and golf_course_id = p_course_id and archived_at is null) then
      raise exception 'tee % is not a current tee on this course', v_current_id;
    end if;

    select exists (select 1 from public.tournaments where golf_course_tee_id = v_current_id) into v_ever_used;

    if not v_ever_used then
      update public.golf_course_tees
      set tee_name = trim(both from (v_tee ->> 'tee_name')),
          gender = v_tee ->> 'gender',
          number_of_holes = (select count(*) from jsonb_array_elements(v_tee -> 'holes')),
          par_total = (select sum((elem ->> 'par')::integer) from jsonb_array_elements(v_tee -> 'holes') as elem where (elem ->> 'par') is not null),
          course_rating = nullif(v_tee ->> 'course_rating', '')::numeric,
          slope_rating = nullif(v_tee ->> 'slope_rating', '')::integer,
          yardage_total = case
            when (select count(*) from jsonb_array_elements(v_tee -> 'holes') as elem where (elem ->> 'yardage') is null) > 0 then null
            else (select sum((elem ->> 'yardage')::integer) from jsonb_array_elements(v_tee -> 'holes') as elem)
          end
      where id = v_current_id;

      delete from public.golf_course_tee_holes where tee_id = v_current_id;
      insert into public.golf_course_tee_holes (tee_id, hole_number, par, yardage, handicap)
      select v_current_id, (elem ->> 'hole_number')::integer, (elem ->> 'par')::integer, nullif(elem ->> 'yardage', '')::integer, nullif(elem ->> 'handicap', '')::integer
      from jsonb_array_elements(v_tee -> 'holes') as elem
      where (elem ->> 'par') is not null;
    else
      update public.golf_course_tees set archived_at = now() where id = v_current_id;
      perform public.insert_manual_course_tee(p_course_id, v_tee);
    end if;
  end loop;

  update public.golf_courses set updated_by = auth.uid(), updated_at = now() where id = p_course_id;
end;
$$;

revoke execute on function public.replace_manual_course_tees(uuid, jsonb, boolean) from public;
grant execute on function public.replace_manual_course_tees(uuid, jsonb, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- The actual seed. Attributed to (in order of preference): the requesting
-- account (isaakiya26@live.com), else an existing administrator, else the
-- earliest-created profile -- create_manual_course() requires a real
-- auth.uid() (it's the same entry point a signed-in user's browser calls),
-- so some real profile has to be impersonated. Never hard-fails: on a
-- brand new database with zero profiles (a fresh CI/test reset), the seed
-- is skipped with a notice rather than breaking the migration for everyone
-- who runs `supabase db reset` from here on. Also skips (idempotently) if
-- a manual course with this name already exists, so re-running this
-- migration file by hand doesn't create a duplicate.
-- ----------------------------------------------------------------------------

-- Everything below runs as a single PL/pgSQL block so that the
-- set_config('request.jwt.claims', ..., true) call auth.uid() reads inside
-- create_manual_course() is guaranteed to still be in scope for that same
-- call: it's a transaction-local GUC (the `true` third argument), and
-- there is no guarantee a migration runner dispatches an entire file as
-- one implicit transaction across separate top-level statements the way
-- pgTAP's explicit `begin;...rollback;` wrapper does. One block sidesteps
-- that entirely. Note this never touches the actual database ROLE (unlike
-- the impersonation pattern in supabase/tests/database/*.sql) --
-- create_manual_course() is SECURITY DEFINER, so it already runs with the
-- defining role's privileges regardless of the caller's role; only the
-- auth.uid() GUC needs to be set.
do $$
declare
  v_owner_id uuid;
  v_course_id uuid;
  -- Blue: par 72 / 6126 yds (35 out + 37 back); hole 18 is par 5 on Blue --
  -- the source scorecard prints "4/5"/"36/37"/"71/72" at hole 18, splitting
  -- by tee (Blue 5/37/72, Red 4/36/71); Red's own table already sums to
  -- the stated 71 with hole 18 at par 4, unambiguously.
  v_blue_holes jsonb := jsonb_build_array(
    jsonb_build_object('hole_number', 1, 'par', 4, 'yardage', 405, 'handicap', 1),
    jsonb_build_object('hole_number', 2, 'par', 3, 'yardage', 121, 'handicap', 17),
    jsonb_build_object('hole_number', 3, 'par', 5, 'yardage', 480, 'handicap', 5),
    jsonb_build_object('hole_number', 4, 'par', 5, 'yardage', 557, 'handicap', 3),
    jsonb_build_object('hole_number', 5, 'par', 3, 'yardage', 134, 'handicap', 15),
    jsonb_build_object('hole_number', 6, 'par', 4, 'yardage', 365, 'handicap', 7),
    jsonb_build_object('hole_number', 7, 'par', 4, 'yardage', 285, 'handicap', 13),
    jsonb_build_object('hole_number', 8, 'par', 3, 'yardage', 173, 'handicap', 11),
    jsonb_build_object('hole_number', 9, 'par', 4, 'yardage', 363, 'handicap', 9),
    jsonb_build_object('hole_number', 10, 'par', 4, 'yardage', 374, 'handicap', 4),
    jsonb_build_object('hole_number', 11, 'par', 3, 'yardage', 175, 'handicap', 16),
    jsonb_build_object('hole_number', 12, 'par', 5, 'yardage', 550, 'handicap', 6),
    jsonb_build_object('hole_number', 13, 'par', 4, 'yardage', 352, 'handicap', 8),
    jsonb_build_object('hole_number', 14, 'par', 5, 'yardage', 490, 'handicap', 14),
    jsonb_build_object('hole_number', 15, 'par', 4, 'yardage', 346, 'handicap', 10),
    jsonb_build_object('hole_number', 16, 'par', 3, 'yardage', 173, 'handicap', 18),
    jsonb_build_object('hole_number', 17, 'par', 4, 'yardage', 376, 'handicap', 12),
    jsonb_build_object('hole_number', 18, 'par', 5, 'yardage', 407, 'handicap', 2)
  );
  -- Red: par 71 / 5530 yds (35 out + 36 back), as given.
  v_red_holes jsonb := jsonb_build_array(
    jsonb_build_object('hole_number', 1, 'par', 4, 'yardage', 390, 'handicap', 1),
    jsonb_build_object('hole_number', 2, 'par', 3, 'yardage', 112, 'handicap', 17),
    jsonb_build_object('hole_number', 3, 'par', 5, 'yardage', 410, 'handicap', 13),
    jsonb_build_object('hole_number', 4, 'par', 5, 'yardage', 452, 'handicap', 7),
    jsonb_build_object('hole_number', 5, 'par', 3, 'yardage', 118, 'handicap', 9),
    jsonb_build_object('hole_number', 6, 'par', 4, 'yardage', 345, 'handicap', 5),
    jsonb_build_object('hole_number', 7, 'par', 4, 'yardage', 265, 'handicap', 15),
    jsonb_build_object('hole_number', 8, 'par', 3, 'yardage', 161, 'handicap', 11),
    jsonb_build_object('hole_number', 9, 'par', 4, 'yardage', 355, 'handicap', 3),
    jsonb_build_object('hole_number', 10, 'par', 4, 'yardage', 285, 'handicap', 8),
    jsonb_build_object('hole_number', 11, 'par', 3, 'yardage', 156, 'handicap', 18),
    jsonb_build_object('hole_number', 12, 'par', 5, 'yardage', 414, 'handicap', 12),
    jsonb_build_object('hole_number', 13, 'par', 4, 'yardage', 341, 'handicap', 2),
    jsonb_build_object('hole_number', 14, 'par', 5, 'yardage', 470, 'handicap', 10),
    jsonb_build_object('hole_number', 15, 'par', 4, 'yardage', 335, 'handicap', 4),
    jsonb_build_object('hole_number', 16, 'par', 3, 'yardage', 167, 'handicap', 14),
    jsonb_build_object('hole_number', 17, 'par', 4, 'yardage', 354, 'handicap', 6),
    jsonb_build_object('hole_number', 18, 'par', 4, 'yardage', 400, 'handicap', 16)
  );
begin
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
    raise notice 'Tilbury Golf Club seed skipped: no profiles exist yet in this database.';
    return;
  end if;

  if exists (select 1 from public.golf_courses where club_name = 'Tilbury Golf Club' and source = 'manual') then
    raise notice 'Tilbury Golf Club already exists as a manual course -- seed skipped.';
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id, 'role', 'authenticated')::text, true);

  v_course_id := public.create_manual_course(
    'Tilbury Golf Club',
    'Tilbury Golf Club',
    '20425 Middleside Road',
    'Tilbury',
    'ON',
    'Canada',
    null,
    null,
    jsonb_build_array(
      jsonb_build_object('tee_name', 'Blue', 'gender', 'unisex', 'holes', v_blue_holes),
      jsonb_build_object('tee_name', 'Red', 'gender', 'unisex', 'holes', v_red_holes)
    ),
    true
  );

  raise notice 'Tilbury Golf Club seeded: golf_courses.id = %', v_course_id;
end $$;
