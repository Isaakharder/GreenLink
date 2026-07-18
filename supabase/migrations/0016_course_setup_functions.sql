-- ============================================================================
-- save_tournament_holes(): replaces the full hole set for a tournament in one
-- transactional call instead of N unrelated inserts. p_holes is a jsonb
-- array of objects: {hole_number, par, stroke_index?, distance?, distance_unit?}.
-- ============================================================================

create function public.save_tournament_holes(p_tournament_id uuid, p_holes jsonb)
returns setof public.tournament_holes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_hole_count integer;
  v_input_count integer;
  v_distinct_hole_numbers integer;
  v_min_hole integer;
  v_max_hole integer;
  v_stroke_index_count integer;
  v_distinct_stroke_indexes integer;
  v_invalid_par_count integer;
  v_invalid_distance_count integer;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can configure holes';
  end if;

  select status, hole_count into v_status, v_hole_count
  from public.tournaments
  where id = p_tournament_id;

  if v_status is null then
    raise exception 'tournament not found';
  end if;

  if v_status not in ('draft', 'upcoming') then
    raise exception 'course setup cannot be changed once the tournament has started';
  end if;

  if p_holes is null or jsonb_typeof(p_holes) <> 'array' then
    raise exception 'holes must be provided as an array.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_holes) as elem
    where (elem ->> 'hole_number') is null or (elem ->> 'par') is null
  ) then
    raise exception 'each hole must include a hole number and par.';
  end if;

  select count(*) into v_input_count from jsonb_array_elements(p_holes);
  if v_input_count <> v_hole_count then
    raise exception 'expected % holes, received %.', v_hole_count, v_input_count;
  end if;

  select count(distinct (elem ->> 'hole_number')::integer),
         min((elem ->> 'hole_number')::integer),
         max((elem ->> 'hole_number')::integer)
  into v_distinct_hole_numbers, v_min_hole, v_max_hole
  from jsonb_array_elements(p_holes) as elem;

  if v_distinct_hole_numbers <> v_hole_count or v_min_hole <> 1 or v_max_hole <> v_hole_count then
    raise exception 'hole numbers must be sequential from 1 to %, with no duplicates.', v_hole_count;
  end if;

  select count(*) into v_invalid_par_count
  from jsonb_array_elements(p_holes) as elem
  where (elem ->> 'par')::integer not between 3 and 6;

  if v_invalid_par_count > 0 then
    raise exception 'par must be between 3 and 6 for every hole.';
  end if;

  select count(*) into v_invalid_distance_count
  from jsonb_array_elements(p_holes) as elem
  where (elem ->> 'distance') is not null and (elem ->> 'distance')::integer < 0;

  if v_invalid_distance_count > 0 then
    raise exception 'distance cannot be negative.';
  end if;

  select count(*), count(distinct (elem ->> 'stroke_index')::integer)
  into v_stroke_index_count, v_distinct_stroke_indexes
  from jsonb_array_elements(p_holes) as elem
  where (elem ->> 'stroke_index') is not null;

  if v_stroke_index_count <> v_distinct_stroke_indexes then
    raise exception 'stroke index must be unique across holes when provided.';
  end if;

  delete from public.tournament_holes where tournament_id = p_tournament_id;

  insert into public.tournament_holes (tournament_id, hole_number, par, stroke_index, distance, distance_unit)
  select
    p_tournament_id,
    (elem ->> 'hole_number')::integer,
    (elem ->> 'par')::integer,
    (elem ->> 'stroke_index')::integer,
    (elem ->> 'distance')::integer,
    coalesce(elem ->> 'distance_unit', 'yards')
  from jsonb_array_elements(p_holes) as elem;

  return query
    select * from public.tournament_holes
    where tournament_id = p_tournament_id
    order by hole_number;
end;
$$;

revoke execute on function public.save_tournament_holes(uuid, jsonb) from public;
grant execute on function public.save_tournament_holes(uuid, jsonb) to authenticated;
