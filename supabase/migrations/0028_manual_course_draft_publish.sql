-- ============================================================================
-- Draft/publish states and duplicate-course detection for the manual course
-- library (0027). 0026 and 0027 are already applied to the linked hosted
-- project, so this is a new forward-only migration rather than an edit to
-- either -- it only adds a column, an index, changes some already-applied
-- function signatures via explicit drop-then-recreate (see the 0019
-- postmortem this codebase already documented: appending a parameter to an
-- already-applied function catalogs a second overload instead of replacing
-- it, and an existing single-arg call site would then become ambiguous),
-- and adds new functions.
--
-- Draft semantics: a course with published_at is null is readable only via
-- direct-by-id/created_by queries (same select policy every golf_courses
-- row already has -- unchanged, not tightened further) but is excluded
-- from search_courses(), so it never appears in general course search,
-- Start Personal Round, Create Tournament, etc. A draft may be saved with
-- zero tees, or tees with some holes still missing a par -- "still being
-- typed on a phone, tap Save Draft, finish it later" has to actually work,
-- not just "zero tees allowed". Publishing (at creation, or later via
-- publish_manual_course()) requires at least one *complete* current tee:
-- every one of its declared holes has a real par.
-- ============================================================================

alter table public.golf_courses add column published_at timestamptz;

-- Every row created before this migration was published immediately (the
-- only behavior that existed) -- backfill so nothing that used to be
-- searchable silently disappears.
update public.golf_courses set published_at = created_at where published_at is null and created_at is not null;

-- Mirrors golf_courses_active_idx's shape (0027): serves search_courses()'s
-- exact query (active + published), without scanning drafts/archived rows.
create index golf_courses_published_idx
  on public.golf_courses (source)
  where archived_at is null and published_at is not null;

-- ----------------------------------------------------------------------------
-- search_courses(): add the publish gate. Same signature, safe to replace
-- in place.
-- ----------------------------------------------------------------------------

create or replace function public.search_courses(p_query text, p_limit integer default 20)
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
    and gc.published_at is not null
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

-- ----------------------------------------------------------------------------
-- validate_manual_tee(): add p_require_complete. When false (draft), hole
-- numbering/count/sequencing is still always enforced (the client always
-- sends a full 1..N array driven by the hole-count selector -- there's
-- never a legitimate reason for that shape to be malformed, draft or not),
-- but a hole is allowed to have no par yet, and "every hole must include a
-- par" is skipped. A par that *is* present is always range-checked (3-6),
-- draft or not -- never store obvious garbage just because it's a draft.
-- Explicit drop first: the 1-arg version is called positionally elsewhere
-- in this file, which would become ambiguous against a same-named 2-arg
-- overload rather than resolving to it.
-- ----------------------------------------------------------------------------

drop function if exists public.validate_manual_tee(jsonb);

create function public.validate_manual_tee(p_tee jsonb, p_require_complete boolean default true)
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
    where (elem ->> 'hole_number') is null
  ) then
    raise exception 'every hole must include a hole number';
  end if;

  select count(distinct (elem ->> 'hole_number')::integer),
         min((elem ->> 'hole_number')::integer),
         max((elem ->> 'hole_number')::integer)
  into v_distinct_hole_numbers, v_min_hole, v_max_hole
  from jsonb_array_elements(v_holes) as elem;

  if v_distinct_hole_numbers <> v_hole_count or v_min_hole <> 1 or v_max_hole <> v_hole_count then
    raise exception 'hole numbers must be sequential from 1 to %, with no duplicates', v_hole_count;
  end if;

  if p_require_complete and exists (
    select 1 from jsonb_array_elements(v_holes) as elem where (elem ->> 'par') is null
  ) then
    raise exception 'every hole must include a par';
  end if;

  select count(*) into v_invalid_par_count
  from jsonb_array_elements(v_holes) as elem
  where (elem ->> 'par') is not null and (elem ->> 'par')::integer not between 3 and 6;

  if v_invalid_par_count > 0 then
    raise exception 'par must be between 3 and 6 for every hole';
  end if;
end;
$$;

revoke execute on function public.validate_manual_tee(jsonb, boolean) from public;

-- ----------------------------------------------------------------------------
-- insert_manual_course_tee(): only holes with a real (non-null) par are
-- ever written to golf_course_tee_holes -- that column is NOT NULL (0020),
-- and a draft's still-in-progress hole is represented by its *absence* as
-- a row, not a fabricated par. number_of_holes still records the declared
-- hole count (the jsonb array length, driven by the 9/18 selector), so a
-- reload of a partially-filled draft correctly re-renders the missing
-- holes as blank (CourseForm's buildHoleRows already fills any hole number
-- absent from the loaded set as blank -- unchanged, this just gives it
-- fewer rows to find for a draft). Same signature as 0027 -- safe to
-- replace in place.
-- ----------------------------------------------------------------------------

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

  insert into public.golf_course_tee_holes (tee_id, hole_number, par, yardage)
  select
    v_tee_id,
    (elem ->> 'hole_number')::integer,
    (elem ->> 'par')::integer,
    nullif(elem ->> 'yardage', '')::integer
  from jsonb_array_elements(p_tee -> 'holes') as elem
  where (elem ->> 'par') is not null;

  return v_tee_id;
end;
$$;

revoke execute on function public.insert_manual_course_tee(uuid, jsonb) from public;

-- ----------------------------------------------------------------------------
-- create_manual_course(): add p_publish. Explicit drop of the exact 0027
-- signature first -- see file header.
-- ----------------------------------------------------------------------------

drop function if exists public.create_manual_course(text, text, text, text, text, text, numeric, numeric, jsonb);

create function public.create_manual_course(
  p_club_name text,
  p_course_name text,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_tees jsonb default '[]'::jsonb,
  p_publish boolean default true
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

  -- A draft may be saved with zero tees -- the "at least one valid tee"
  -- bar only applies when actually publishing. Any tee that *is*
  -- submitted, draft or not, still has to be structurally well-formed
  -- (see validate_manual_tee's p_require_complete for what's relaxed).
  if p_publish and (p_tees is null or jsonb_typeof(p_tees) <> 'array' or jsonb_array_length(p_tees) = 0) then
    raise exception 'at least one tee is required to publish a course';
  end if;

  if p_tees is not null and jsonb_typeof(p_tees) = 'array' then
    for v_tee in select * from jsonb_array_elements(p_tees)
    loop
      perform public.validate_manual_tee(v_tee, p_publish);
    end loop;
  end if;

  v_course_id := gen_random_uuid();

  insert into public.golf_courses (
    id, external_id, club_name, course_name, address, city, state, country,
    source, imported_by, created_by, updated_by, published_at
  )
  values (
    v_course_id, 'manual-' || v_course_id::text, trim(both from p_club_name), trim(both from p_course_name),
    nullif(trim(both from coalesce(p_address, '')), ''),
    nullif(trim(both from coalesce(p_city, '')), ''),
    nullif(trim(both from coalesce(p_state, '')), ''),
    nullif(trim(both from coalesce(p_country, '')), ''),
    'manual', auth.uid(), auth.uid(), auth.uid(),
    case when p_publish then now() else null end
  );

  if p_latitude is not null or p_longitude is not null then
    update public.golf_courses
    set raw_payload = jsonb_build_object('latitude', p_latitude, 'longitude', p_longitude)
    where id = v_course_id;
  end if;

  if p_tees is not null and jsonb_typeof(p_tees) = 'array' then
    for v_tee in select * from jsonb_array_elements(p_tees)
    loop
      perform public.insert_manual_course_tee(v_course_id, v_tee);
    end loop;
  end if;

  return v_course_id;
end;
$$;

revoke execute on function public.create_manual_course(text, text, text, text, text, text, numeric, numeric, jsonb, boolean) from public;
grant execute on function public.create_manual_course(text, text, text, text, text, text, numeric, numeric, jsonb, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- replace_manual_course_tees(): add p_publish, same "require complete /
-- require at least one" relaxation as create_manual_course, so editing a
-- draft (Save Draft again, still incomplete) works the same way creating
-- one does. Explicit drop of the 0027 2-arg signature first.
-- ----------------------------------------------------------------------------

drop function if exists public.replace_manual_course_tees(uuid, jsonb);

create function public.replace_manual_course_tees(p_course_id uuid, p_tees jsonb, p_publish boolean default true)
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
          par_total = (select sum((elem ->> 'par')::integer) from jsonb_array_elements(v_tee -> 'holes') as elem where (elem ->> 'par') is not null),
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
      from jsonb_array_elements(v_tee -> 'holes') as elem
      where (elem ->> 'par') is not null;
    else
      -- This tee has scored history -- fork instead of mutating it.
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
-- publish_manual_course(): turns a draft (or a no-op on an already-
-- published course) into published. Requires at least one current tee, and
-- every current tee must be *complete* -- every one of its declared holes
-- has a stored par row, not just "a tee row exists". Complete is required
-- of *every* current tee, not merely one of them: once published, every
-- current tee becomes selectable in Start Round / Create Tournament
-- (StartRound.tsx and SettingsTab.tsx read golf_course_tees directly, with
-- no completeness check of their own), and an incomplete tee reaching that
-- picker would import a truncated scorecard through
-- apply_imported_course_to_tournament() (0021) -- fewer tournament_holes
-- rows than the tee's own hole_count, which the scoring UI doesn't expect.
-- Leaving an incomplete tee behind therefore blocks publish entirely
-- (finish it or delete it first) rather than silently excluding it.
-- ----------------------------------------------------------------------------

create function public.publish_manual_course(p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_course(p_course_id) then
    raise exception 'only the course creator or an administrator can publish this course';
  end if;

  if not exists (
    select 1 from public.golf_course_tees where golf_course_id = p_course_id and archived_at is null
  ) then
    raise exception 'at least one tee is required to publish a course';
  end if;

  if exists (
    select 1
    from public.golf_course_tees t
    where t.golf_course_id = p_course_id
      and t.archived_at is null
      and t.number_of_holes <> (select count(*) from public.golf_course_tee_holes h where h.tee_id = t.id)
  ) then
    raise exception 'every tee must have a par for all of its holes before publishing';
  end if;

  update public.golf_courses
  set published_at = coalesce(published_at, now()), updated_by = auth.uid(), updated_at = now()
  where id = p_course_id;
end;
$$;

revoke execute on function public.publish_manual_course(uuid) from public;
grant execute on function public.publish_manual_course(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- find_similar_courses(): a duplicate-warning trigger for "before
-- publishing, search for similar existing courses" -- never an automatic
-- merge. Only ever surfaces PUBLISHED, non-archived manual/imported courses
-- -- another user's still-private draft must never leak through this
-- check. Matching is intentionally loose (it's a warning, not a gate):
-- normalized club/course name containment, city match, or close
-- coordinates (~0.02 degrees, roughly 2km, when both sides have them).
-- ----------------------------------------------------------------------------

create function public.find_similar_courses(
  p_club_name text,
  p_course_name text,
  p_city text default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_exclude_course_id uuid default null
)
returns table (
  id uuid,
  club_name text,
  course_name text,
  city text,
  state text,
  country text,
  source text
)
language sql
security definer
set search_path = public
stable
as $$
  select gc.id, gc.club_name, gc.course_name, gc.city, gc.state, gc.country, gc.source
  from public.golf_courses gc
  where gc.source in ('manual', 'imported')
    and gc.archived_at is null
    and gc.published_at is not null
    and (p_exclude_course_id is null or gc.id <> p_exclude_course_id)
    and (
      gc.club_name ilike '%' || trim(both from coalesce(p_club_name, '')) || '%'
      or gc.course_name ilike '%' || trim(both from coalesce(p_course_name, '')) || '%'
      or (p_city is not null and gc.city is not null and gc.city ilike trim(both from p_city))
      or (
        p_latitude is not null and p_longitude is not null
        and (gc.raw_payload ->> 'latitude') is not null and (gc.raw_payload ->> 'longitude') is not null
        and abs((gc.raw_payload ->> 'latitude')::numeric - p_latitude) < 0.02
        and abs((gc.raw_payload ->> 'longitude')::numeric - p_longitude) < 0.02
      )
    )
  order by gc.club_name
  limit 5;
$$;

revoke execute on function public.find_similar_courses(text, text, text, numeric, numeric, uuid) from public;
grant execute on function public.find_similar_courses(text, text, text, numeric, numeric, uuid) to authenticated;
