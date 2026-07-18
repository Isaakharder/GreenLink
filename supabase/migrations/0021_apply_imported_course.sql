-- ============================================================================
-- Tournament-side provenance of an imported course. Nullable and never
-- required: a manually-entered tournament simply leaves these null forever.
-- ============================================================================

alter table public.tournaments
  add column golf_course_id uuid references public.golf_courses (id),
  add column golf_course_tee_id uuid references public.golf_course_tees (id),
  add column course_rating numeric,
  add column slope_rating numeric;

-- ============================================================================
-- apply_imported_course_to_tournament(): copies one tee's hole data from the
-- shared golf_course_tee_holes cache into this tournament's own
-- tournament_holes via save_tournament_holes() (0016) -- reusing it instead
-- of re-implementing hole validation guarantees the imported path can never
-- drift from the manual-entry path, and it means editing/deleting the
-- shared cached course later has zero effect on any tournament that already
-- imported from it (tournament_holes is a copy, not a live reference).
-- ============================================================================

create function public.apply_imported_course_to_tournament(
  p_tournament_id uuid,
  p_tee_id uuid,
  p_nine text default null
)
returns setof public.tournament_holes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_hole_count integer;
  v_golf_course_id uuid;
  v_tee_number_of_holes integer;
  v_tee_course_rating numeric;
  v_tee_slope_rating integer;
  v_holes jsonb;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can import a course';
  end if;

  select hole_count into v_tournament_hole_count
  from public.tournaments
  where id = p_tournament_id;

  if v_tournament_hole_count is null then
    raise exception 'tournament not found';
  end if;

  select golf_course_id, number_of_holes, course_rating, slope_rating
  into v_golf_course_id, v_tee_number_of_holes, v_tee_course_rating, v_tee_slope_rating
  from public.golf_course_tees
  where id = p_tee_id;

  if v_golf_course_id is null then
    raise exception 'tee not found';
  end if;

  if p_nine is not null and p_nine not in ('front', 'back') then
    raise exception 'p_nine must be ''front'' or ''back'' when provided';
  end if;

  if v_tee_number_of_holes = v_tournament_hole_count then
    select jsonb_agg(jsonb_build_object(
        'hole_number', hole_number,
        'par', par,
        'stroke_index', handicap,
        'distance', yardage,
        'distance_unit', 'yards'
      ))
    into v_holes
    from public.golf_course_tee_holes
    where tee_id = p_tee_id;
  elsif v_tee_number_of_holes = 18 and v_tournament_hole_count = 9 then
    if p_nine is null then
      raise exception 'this tee has 18 holes; specify p_nine as ''front'' or ''back'' for a 9-hole tournament';
    end if;

    select jsonb_agg(jsonb_build_object(
        'hole_number', case when p_nine = 'front' then hole_number else hole_number - 9 end,
        'par', par,
        'stroke_index', handicap,
        'distance', yardage,
        'distance_unit', 'yards'
      ))
    into v_holes
    from public.golf_course_tee_holes
    where tee_id = p_tee_id
      and hole_number between (case when p_nine = 'front' then 1 else 10 end)
                           and (case when p_nine = 'front' then 9 else 18 end);
  else
    raise exception 'this tee has % holes, which does not match the tournament''s % holes', v_tee_number_of_holes, v_tournament_hole_count;
  end if;

  if v_holes is null or jsonb_array_length(v_holes) = 0 then
    raise exception 'the selected tee has no hole data to import';
  end if;

  update public.tournaments
  set golf_course_id = v_golf_course_id,
      golf_course_tee_id = p_tee_id,
      course_rating = v_tee_course_rating,
      slope_rating = v_tee_slope_rating
  where id = p_tournament_id;

  return query select * from public.save_tournament_holes(p_tournament_id, v_holes);
end;
$$;

revoke execute on function public.apply_imported_course_to_tournament(uuid, uuid, text) from public;
grant execute on function public.apply_imported_course_to_tournament(uuid, uuid, text) to authenticated;

-- ============================================================================
-- set_tournament_course_rating(): lets the organizer correct rating/slope
-- by hand (e.g. a manually-entered course, or fixing an imported value)
-- without touching the hole grid. Same lock rule as course setup generally.
-- ============================================================================

create function public.set_tournament_course_rating(
  p_tournament_id uuid,
  p_course_rating numeric,
  p_slope_rating numeric
)
returns public.tournaments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_result public.tournaments;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can set course rating';
  end if;

  select status into v_status from public.tournaments where id = p_tournament_id;
  if v_status is null then
    raise exception 'tournament not found';
  end if;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'course rating cannot be changed once the tournament has started';
  end if;

  update public.tournaments
  set course_rating = p_course_rating,
      slope_rating = p_slope_rating
  where id = p_tournament_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.set_tournament_course_rating(uuid, numeric, numeric) from public;
grant execute on function public.set_tournament_course_rating(uuid, numeric, numeric) to authenticated;
