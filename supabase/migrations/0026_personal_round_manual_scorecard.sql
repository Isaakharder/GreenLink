-- ============================================================================
-- start_personal_round(): manual-scorecard alternative to p_tee_id, for a
-- GolfCourseAPI search result found by the user but missing usable
-- tee/hole data (empty tees, tees with no par data, etc -- see the
-- golf-course-lookup Edge Function's mapping.ts for what "usable" means).
--
-- Reuses save_tournament_holes() (0016) for the write -- the exact same
-- function apply_imported_course_to_tournament() (0021) already calls for
-- the imported-course path -- so a manually-entered round gets identical
-- validation (sequential 1..hole_count numbering, no duplicate holes, a
-- valid par 3-6 for every hole, exact hole count match) and writes into the
-- same tournament_holes table. No second scoring format, no parallel
-- storage: a manual personal round is scored by the exact same
-- ScorecardTab/submit_team_score() path as an imported one.
--
-- Unlike some other signature changes in this codebase, this one cannot use
-- a plain `create or replace function` in place: per 0019's postmortem,
-- that only reuses the existing function when the argument type list
-- matches *exactly* -- appending three trailing parameters (even with
-- defaults) makes Postgres catalog a second, distinct overload instead,
-- and a 4-6 argument call then becomes ambiguous between the two. Drop the
-- old six-argument signature explicitly first.
-- ============================================================================

drop function if exists public.start_personal_round(text, date, integer, uuid, text, text);

create function public.start_personal_round(
  p_course_name text,
  p_tournament_date date,
  p_hole_count integer,
  p_tee_id uuid default null,
  p_nine text default null,
  p_walking_or_cart text default 'walking',
  p_manual_holes jsonb default null,
  p_course_rating numeric default null,
  p_slope_rating numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_tee_id is null and p_manual_holes is null then
    raise exception 'a course and tee, or a manual scorecard, is required to start a round';
  end if;

  if p_tee_id is not null and p_manual_holes is not null then
    raise exception 'provide either a tee or a manual scorecard, not both';
  end if;

  if p_walking_or_cart not in ('walking', 'cart') then
    raise exception 'walking_or_cart must be ''walking'' or ''cart''';
  end if;

  insert into public.tournaments (
    organizer_user_id, name, course_name, tournament_date,
    hole_count, scoring_format, team_size, status, is_personal
  )
  values (
    auth.uid(), p_course_name, p_course_name, p_tournament_date,
    coalesce(p_hole_count, 18), null, 1, 'upcoming', true
  )
  returning id into v_tournament_id;

  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values (v_tournament_id, auth.uid(), 'accepted', true);

  insert into public.tournament_teams (tournament_id, name, team_number)
  values (v_tournament_id, null, 1)
  returning id into v_team_id;

  update public.tournament_players
  set team_id = v_team_id
  where tournament_id = v_tournament_id and user_id = auth.uid();

  insert into public.personal_rounds (tournament_id, walking_or_cart, visibility)
  values (v_tournament_id, p_walking_or_cart, 'private');

  if p_tee_id is not null then
    -- Reuses the existing, unmodified import path (hole-count/nine
    -- compatibility rules, par/stroke-index/yardage copy) -- see
    -- 0021_apply_imported_course.sql. Raises (rolling back everything
    -- above) if the tee doesn't match p_hole_count/p_nine.
    perform public.apply_imported_course_to_tournament(v_tournament_id, p_tee_id, p_nine);
  else
    -- p_manual_holes: jsonb array of {hole_number, par, distance?}, one
    -- entry per hole -- the exact shape save_tournament_holes() already
    -- takes from SettingsTab.tsx's manual hole grid, validated and written
    -- unchanged here.
    perform public.save_tournament_holes(v_tournament_id, p_manual_holes);
    if p_course_rating is not null or p_slope_rating is not null then
      perform public.set_tournament_course_rating(v_tournament_id, p_course_rating, p_slope_rating);
    end if;
  end if;

  update public.tournaments
  set status = 'live', started_at = now()
  where id = v_tournament_id;

  return v_tournament_id;
end;
$$;

revoke execute on function public.start_personal_round(text, date, integer, uuid, text, text, jsonb, numeric, numeric) from public;
grant execute on function public.start_personal_round(text, date, integer, uuid, text, text, jsonb, numeric, numeric) to authenticated;
