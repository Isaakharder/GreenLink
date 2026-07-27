-- ============================================================================
-- Manual course library. Extends the existing golf_courses/golf_course_tees/
-- golf_course_tee_holes cache (0020) rather than introducing a parallel
-- scoring structure: a manually-created course is a golf_courses row with
-- source = 'manual' instead of 'golfcourseapi', and it flows through the
-- exact same apply_imported_course_to_tournament()/save_tournament_holes()
-- pipeline (0016, 0021) every imported course already uses. Nothing about
-- tournament creation, personal rounds, offline download, or scoring
-- changes: those all already operate on tournaments/tournament_holes, which
-- are copies taken at import time, never a live join back to these tables.
--
-- Investigation summary (see task): golf_courses.external_id is the
-- dedup/lookup key handleImport() already uses to short-circuit "already
-- cached, don't call GolfCourseAPI again". Manual courses get a synthetic
-- external_id ('manual-' || id) so that exact same short-circuit path
-- serves them too -- selecting a manual course from search calls the same
-- import action, unchanged, and gets its permanently-stored tees back.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Minimal admin concept. No admin-granting UI is built here (out of scope
-- per the brief: "do not build a complicated approval workflow now") --
-- this only gives RLS/RPC permission checks something to check against, so
-- an approval workflow can be layered on later without another schema change.
-- ----------------------------------------------------------------------------

alter table public.profiles add column is_admin boolean not null default false;

create function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- golf_courses: source + ownership + archive fields.
-- ----------------------------------------------------------------------------

alter table public.golf_courses
  alter column external_id drop not null,
  alter column raw_payload drop not null,
  add column source text not null default 'golfcourseapi' check (source in ('golfcourseapi', 'manual', 'imported')),
  add column created_by uuid references public.profiles (id),
  add column created_at timestamptz,
  add column updated_by uuid references public.profiles (id),
  add column updated_at timestamptz,
  add column archived_at timestamptz;

-- Every existing row came through the golfcourseapi import path -- backfill
-- created_by/created_at/updated_by/updated_at from the fields that already
-- recorded exactly that (imported_by/imported_at), so the new columns are a
-- strict superset of provenance info rather than a second, divergent record
-- of "who made this" for pre-existing rows.
update public.golf_courses
set created_by = imported_by, created_at = imported_at, updated_by = imported_by, updated_at = imported_at
where created_at is null;

alter table public.golf_courses
  alter column created_at set not null,
  alter column created_at set default now(),
  alter column updated_at set not null,
  alter column updated_at set default now();

create index golf_courses_created_by_idx on public.golf_courses (created_by);
-- Every search/browse query filters archived rows out; this index serves
-- exactly that query shape without scanning archived history each time.
create index golf_courses_active_idx on public.golf_courses (source) where archived_at is null;

-- ----------------------------------------------------------------------------
-- golf_course_tees: allow 'unisex' (manual courses aren't always split by
-- gender the way GolfCourseAPI's records are), a total-yardage column
-- ("Total yardage, calculated where possible"), and per-tee archival for
-- edit-safety (below).
-- ----------------------------------------------------------------------------

alter table public.golf_course_tees drop constraint golf_course_tees_gender_check;
alter table public.golf_course_tees add constraint golf_course_tees_gender_check
  check (gender in ('male', 'female', 'unisex'));

alter table public.golf_course_tees add column yardage_total integer;
alter table public.golf_course_tees add column archived_at timestamptz;

-- A tee that has never been used by any round can be edited in place, but
-- one that has must not have its historical hole/par data mutated out from
-- under an already-played/scored round (tournament_holes is a copy taken at
-- import time -- see 0021 -- so editing here never touches it directly, but
-- an in-place edit would still corrupt what a *future* "view the course I
-- played" or re-import would show for that same tee id). Editing a
-- *used* tee therefore archives the old row and inserts its replacement as
-- a new row instead of mutating it -- a lightweight, per-tee version chain
-- using the same table rather than a separate revision structure.
--
-- The (golf_course_id, tee_name, gender) uniqueness only makes sense among
-- *current* tees -- an archived predecessor must not block re-adding a tee
-- with the same name.
alter table public.golf_course_tees drop constraint golf_course_tees_golf_course_id_tee_name_gender_key;
create unique index golf_course_tees_current_name_gender_idx
  on public.golf_course_tees (golf_course_id, tee_name, gender)
  where archived_at is null;

-- ----------------------------------------------------------------------------
-- validate_manual_tee(): shared validation for one tee's worth of manually-
-- entered data, used by both create_manual_course() and
-- replace_manual_course_tees() below so the two call sites can never
-- diverge on what "valid" means. Mirrors save_tournament_holes()'s rules
-- (0016) -- sequential 1..N numbering, no duplicates, par 3-6 -- since a
-- manually-entered course must be held to the exact same bar a manually-
-- entered tournament scorecard already is.
-- ----------------------------------------------------------------------------

create function public.validate_manual_tee(p_tee jsonb)
returns void
language plpgsql
as $$
declare
  v_tee_name text;
  v_gender text;
  v_holes jsonb;
  v_hole_count integer;
  v_distinct_hole_numbers integer;
  v_min_hole integer;
  v_max_hole integer;
  v_invalid_par_count integer;
begin
  v_tee_name := trim(both from (p_tee ->> 'tee_name'));
  if v_tee_name is null or v_tee_name = '' then
    raise exception 'every tee needs a name';
  end if;

  v_gender := p_tee ->> 'gender';
  if v_gender not in ('male', 'female', 'unisex') then
    raise exception 'tee gender must be ''male'', ''female'', or ''unisex''';
  end if;

  v_holes := p_tee -> 'holes';
  if v_holes is null or jsonb_typeof(v_holes) <> 'array' then
    raise exception 'each tee needs a holes array';
  end if;

  select count(*) into v_hole_count from jsonb_array_elements(v_holes);
  if v_hole_count not in (9, 18) then
    raise exception 'each tee must have exactly 9 or 18 holes';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_holes) as elem
    where (elem ->> 'hole_number') is null or (elem ->> 'par') is null
  ) then
    raise exception 'every hole must include a hole number and par';
  end if;

  select count(distinct (elem ->> 'hole_number')::integer),
         min((elem ->> 'hole_number')::integer),
         max((elem ->> 'hole_number')::integer)
  into v_distinct_hole_numbers, v_min_hole, v_max_hole
  from jsonb_array_elements(v_holes) as elem;

  if v_distinct_hole_numbers <> v_hole_count or v_min_hole <> 1 or v_max_hole <> v_hole_count then
    raise exception 'hole numbers must be sequential from 1 to %, with no duplicates', v_hole_count;
  end if;

  select count(*) into v_invalid_par_count
  from jsonb_array_elements(v_holes) as elem
  where (elem ->> 'par')::integer not between 3 and 6;

  if v_invalid_par_count > 0 then
    raise exception 'par must be between 3 and 6 for every hole';
  end if;
end;
$$;

-- Internal helper, not a public entry point: it trusts its caller already
-- verified ownership (create_manual_course()/replace_manual_course_tees()
-- both do). SECURITY DEFINER callers reach it regardless of this revoke --
-- Postgres checks EXECUTE privilege against the definer's role for calls
-- made from inside a SECURITY DEFINER function body, not the original
-- caller's -- but a client calling it directly via supabase.rpc() must not
-- be able to bypass the ownership check by skipping the wrapper.
revoke execute on function public.validate_manual_tee(jsonb) from public;

-- ----------------------------------------------------------------------------
-- insert_manual_course_tee(): inserts one already-validated tee + its holes
-- for a course, computing par_total/yardage_total the same way GolfCourseAPI
-- data already implies them (sum of holes; yardage_total only when every
-- hole has one -- never a fabricated partial total).
-- ----------------------------------------------------------------------------

create function public.insert_manual_course_tee(p_course_id uuid, p_tee jsonb)
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
  from jsonb_array_elements(p_tee -> 'holes') as elem;

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

  insert into public.golf_course_tee_holes (tee_id, hole_number, par, yardage)
  select
    v_tee_id,
    (elem ->> 'hole_number')::integer,
    (elem ->> 'par')::integer,
    nullif(elem ->> 'yardage', '')::integer
  from jsonb_array_elements(p_tee -> 'holes') as elem;

  return v_tee_id;
end;
$$;

-- Internal helper, same reasoning as validate_manual_tee() above -- it
-- writes to golf_course_tees/golf_course_tee_holes with no ownership check
-- of its own, so it must never be reachable except from another
-- SECURITY DEFINER function that already checked can_manage_course().
revoke execute on function public.insert_manual_course_tee(uuid, jsonb) from public;

-- ----------------------------------------------------------------------------
-- create_manual_course(): the "Add Course" / "Save to GreenLink Course
-- Library" entry point. p_tees is a jsonb array of
-- {tee_name, gender, holes: [{hole_number, par, yardage?}], course_rating?, slope_rating?}.
-- At least one valid tee is required -- "publishing" a course with none
-- makes no sense (nothing would ever be selectable for a round).
-- ----------------------------------------------------------------------------

create function public.create_manual_course(
  p_club_name text,
  p_course_name text,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_tees jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_course_id uuid;
  v_tee jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if trim(both from coalesce(p_club_name, '')) = '' then
    raise exception 'club name is required';
  end if;

  if trim(both from coalesce(p_course_name, '')) = '' then
    raise exception 'course name is required';
  end if;

  if p_tees is null or jsonb_typeof(p_tees) <> 'array' or jsonb_array_length(p_tees) = 0 then
    raise exception 'at least one tee is required to publish a course';
  end if;

  -- Validate every tee before writing anything -- a partially-published
  -- course (some tees saved, one silently dropped for being invalid) would
  -- be worse than rejecting the whole submission.
  for v_tee in select * from jsonb_array_elements(p_tees)
  loop
    perform public.validate_manual_tee(v_tee);
  end loop;

  v_course_id := gen_random_uuid();

  insert into public.golf_courses (
    id, external_id, club_name, course_name, address, city, state, country,
    source, imported_by, created_by, updated_by
  )
  values (
    v_course_id, 'manual-' || v_course_id::text, trim(both from p_club_name), trim(both from p_course_name),
    nullif(trim(both from coalesce(p_address, '')), ''),
    nullif(trim(both from coalesce(p_city, '')), ''),
    nullif(trim(both from coalesce(p_state, '')), ''),
    nullif(trim(both from coalesce(p_country, '')), ''),
    'manual', auth.uid(), auth.uid(), auth.uid()
  );

  -- latitude/longitude aren't modeled as their own columns (golf_courses
  -- only ever needed address/city/state/country until now) -- kept in
  -- raw_payload, the same "anything not modeled explicitly" column
  -- GolfCourseAPI imports already use, rather than adding two columns only
  -- manual courses populate.
  if p_latitude is not null or p_longitude is not null then
    update public.golf_courses
    set raw_payload = jsonb_build_object('latitude', p_latitude, 'longitude', p_longitude)
    where id = v_course_id;
  end if;

  for v_tee in select * from jsonb_array_elements(p_tees)
  loop
    perform public.insert_manual_course_tee(v_course_id, v_tee);
  end loop;

  return v_course_id;
end;
$$;

revoke execute on function public.create_manual_course(text, text, text, text, text, text, numeric, numeric, jsonb) from public;
grant execute on function public.create_manual_course(text, text, text, text, text, text, numeric, numeric, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- Ownership check shared by every mutating course-library RPC below.
-- ----------------------------------------------------------------------------

create function public.can_manage_course(p_course_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.golf_courses
    where id = p_course_id and (created_by = auth.uid() or public.is_admin())
  );
$$;

-- Not revoked from public: harmless to expose (a boolean about whether the
-- *caller* may manage a given course, nothing about anyone else), and the
-- frontend can use it to decide whether to show Edit/Archive controls at
-- all rather than showing them and failing on submit.
revoke execute on function public.can_manage_course(uuid) from public;
grant execute on function public.can_manage_course(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- update_manual_course_info(): course-level descriptive fields only (name/
-- address/location). These are never referenced live by an in-progress or
-- historical round -- tournaments.course_name is copied at creation time
-- (see start_personal_round()/create_tournament_with_course()) -- so
-- editing them in place is always safe and immediately visible in future
-- searches, with zero effect on anything already played.
-- ----------------------------------------------------------------------------

create function public.update_manual_course_info(
  p_course_id uuid,
  p_club_name text,
  p_course_name text,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_latitude numeric default null,
  p_longitude numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_course(p_course_id) then
    raise exception 'only the course creator or an administrator can edit this course';
  end if;

  if trim(both from coalesce(p_club_name, '')) = '' then
    raise exception 'club name is required';
  end if;
  if trim(both from coalesce(p_course_name, '')) = '' then
    raise exception 'course name is required';
  end if;

  update public.golf_courses
  set club_name = trim(both from p_club_name),
      course_name = trim(both from p_course_name),
      address = nullif(trim(both from coalesce(p_address, '')), ''),
      city = nullif(trim(both from coalesce(p_city, '')), ''),
      state = nullif(trim(both from coalesce(p_state, '')), ''),
      country = nullif(trim(both from coalesce(p_country, '')), ''),
      raw_payload = case
        when p_latitude is not null or p_longitude is not null
          then jsonb_build_object('latitude', p_latitude, 'longitude', p_longitude)
        else raw_payload
      end,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_course_id;
end;
$$;

revoke execute on function public.update_manual_course_info(uuid, text, text, text, text, text, text, numeric, numeric) from public;
grant execute on function public.update_manual_course_info(uuid, text, text, text, text, text, text, numeric, numeric) to authenticated;

-- ----------------------------------------------------------------------------
-- replace_manual_course_tees(): the single call behind "Add another tee",
-- "Copy an existing tee", "Edit individual holes", and "Remove an unused
-- tee" in the tee editor -- one full desired-state submission, diffed
-- against what's currently there, the same "replace the whole set in one
-- call" shape save_tournament_holes() already uses. p_tees elements may
-- carry an existing "tee_id" (editing/keeping a current tee) or omit it (a
-- brand new tee, including a copied one -- a copy starts with no id of its
-- own). Any current tee not mentioned in p_tees is being removed.
--
-- Version safety: a tee that has never been used by any round is mutated
-- in place (cheap, no history to protect). A tee that HAS been used is
-- archived instead of deleted/mutated -- its historical hole data stays
-- exactly as it was for whatever round already reads it via
-- tournaments.golf_course_tee_id -- and, if the incoming submission still
-- wants a tee by that name, a new current row is inserted as its
-- replacement.
-- ----------------------------------------------------------------------------

create function public.replace_manual_course_tees(p_course_id uuid, p_tees jsonb)
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

  if p_tees is null or jsonb_typeof(p_tees) <> 'array' or jsonb_array_length(p_tees) = 0 then
    raise exception 'at least one tee is required';
  end if;

  for v_tee in select * from jsonb_array_elements(p_tees)
  loop
    perform public.validate_manual_tee(v_tee);
  end loop;

  select coalesce(array_agg(nullif(elem ->> 'tee_id', '')::uuid), '{}')
  into v_mentioned_ids
  from jsonb_array_elements(p_tees) as elem
  where nullif(elem ->> 'tee_id', '') is not null;

  -- Phase 1 (removals first): frees up any (tee_name, gender) slot a
  -- removed/renamed tee held, before phase 2 inserts anything -- otherwise
  -- "remove Blue, add a new tee also named Blue" would collide with the
  -- still-current old row under golf_course_tees_current_name_gender_idx.
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

  -- Phase 2: add new tees (including copies, which never carry a tee_id)
  -- and edit/fork existing ones.
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
          par_total = (select sum((elem ->> 'par')::integer) from jsonb_array_elements(v_tee -> 'holes') as elem),
          course_rating = nullif(v_tee ->> 'course_rating', '')::numeric,
          slope_rating = nullif(v_tee ->> 'slope_rating', '')::integer,
          yardage_total = case
            when (select count(*) from jsonb_array_elements(v_tee -> 'holes') as elem where (elem ->> 'yardage') is null) > 0 then null
            else (select sum((elem ->> 'yardage')::integer) from jsonb_array_elements(v_tee -> 'holes') as elem)
          end
      where id = v_current_id;

      delete from public.golf_course_tee_holes where tee_id = v_current_id;
      insert into public.golf_course_tee_holes (tee_id, hole_number, par, yardage)
      select v_current_id, (elem ->> 'hole_number')::integer, (elem ->> 'par')::integer, nullif(elem ->> 'yardage', '')::integer
      from jsonb_array_elements(v_tee -> 'holes') as elem;
    else
      -- This tee has scored history -- fork instead of mutating it.
      update public.golf_course_tees set archived_at = now() where id = v_current_id;
      perform public.insert_manual_course_tee(p_course_id, v_tee);
    end if;
  end loop;

  update public.golf_courses set updated_by = auth.uid(), updated_at = now() where id = p_course_id;
end;
$$;

revoke execute on function public.replace_manual_course_tees(uuid, jsonb) from public;
grant execute on function public.replace_manual_course_tees(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- archive_manual_course() / restore_manual_course(): soft delete. Archived
-- courses are excluded from search_courses() below and can't be the target
-- of a new import (handleImport() only ever looks a course up by
-- external_id when a search already surfaced it), but the row itself, and
-- every tee/hole under it, is untouched -- any tournament that already
-- references golf_course_id/golf_course_tee_id keeps reading it exactly as
-- before (the existing "using (true)" SELECT policy on these tables was
-- never conditioned on archived_at).
-- ----------------------------------------------------------------------------

create function public.archive_manual_course(p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_course(p_course_id) then
    raise exception 'only the course creator or an administrator can archive this course';
  end if;

  update public.golf_courses
  set archived_at = now(), updated_by = auth.uid(), updated_at = now()
  where id = p_course_id;
end;
$$;

create function public.restore_manual_course(p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_course(p_course_id) then
    raise exception 'only the course creator or an administrator can restore this course';
  end if;

  update public.golf_courses
  set archived_at = null, updated_by = auth.uid(), updated_at = now()
  where id = p_course_id;
end;
$$;

revoke execute on function public.archive_manual_course(uuid) from public;
grant execute on function public.archive_manual_course(uuid) to authenticated;
revoke execute on function public.restore_manual_course(uuid) from public;
grant execute on function public.restore_manual_course(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- search_courses(): GreenLink's own course library (manual + future
-- bulk-imported courses), matched against club name/course name/city/
-- state/country -- the same fields golf-course-lookup's GolfCourseAPI
-- search already lets a user match on. Used by the Edge Function to merge
-- local results ahead of GolfCourseAPI's (see golf-course-lookup/index.ts)
-- so "GreenLink Course" results rank first. has_usable_tee lets the caller
-- apply the same "usable" bar as GolfCourseAPI results (isTeeUsable() in
-- mapping.ts) without a second round trip.
-- ----------------------------------------------------------------------------

create function public.search_courses(p_query text, p_limit integer default 20)
returns table (
  id uuid,
  external_id text,
  club_name text,
  course_name text,
  city text,
  state text,
  country text,
  source text,
  has_usable_tee boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    gc.id, gc.external_id, gc.club_name, gc.course_name, gc.city, gc.state, gc.country, gc.source,
    exists (select 1 from public.golf_course_tees t where t.golf_course_id = gc.id and t.archived_at is null) as has_usable_tee
  from public.golf_courses gc
  where gc.source in ('manual', 'imported')
    and gc.archived_at is null
    and gc.club_name is not null
    and (
      gc.club_name ilike '%' || p_query || '%'
      or gc.course_name ilike '%' || p_query || '%'
      or gc.city ilike '%' || p_query || '%'
      or gc.state ilike '%' || p_query || '%'
      or gc.country ilike '%' || p_query || '%'
    )
  order by
    (gc.club_name ilike p_query || '%' or gc.course_name ilike p_query || '%') desc,
    gc.club_name
  limit greatest(coalesce(p_limit, 20), 0);
$$;

revoke execute on function public.search_courses(text, integer) from public;
grant execute on function public.search_courses(text, integer) to authenticated;
