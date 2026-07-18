-- ============================================================================
-- create_tournament_with_course(): composes create_tournament() and
-- apply_imported_course_to_tournament() inside a single SECURITY DEFINER
-- function so course import at creation time is atomic. A single Postgres
-- function invocation is one transaction: if apply_imported_course_to_
-- tournament() raises (unknown tee, hole-count mismatch without a nine
-- choice, etc.), create_tournament()'s insert is rolled back too -- there
-- is no way for this function to leave behind a tournament with holes that
-- were supposed to be imported but weren't. p_tee_id defaults to null,
-- which skips the import step entirely and behaves identically to calling
-- create_tournament() directly (manual course entry, unaffected).
-- ============================================================================

create function public.create_tournament_with_course(
  p_name text,
  p_course_name text,
  p_tournament_date date,
  p_hole_count integer default 18,
  p_scoring_format text default null,
  p_team_size integer default null,
  p_description text default null,
  p_tee_id uuid default null,
  p_nine text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
begin
  v_tournament_id := public.create_tournament(
    p_name, p_course_name, p_tournament_date, p_hole_count, p_scoring_format, p_team_size, p_description
  );

  if p_tee_id is not null then
    perform public.apply_imported_course_to_tournament(v_tournament_id, p_tee_id, p_nine);
  end if;

  return v_tournament_id;
end;
$$;

revoke execute on function public.create_tournament_with_course(text, text, date, integer, text, integer, text, uuid, text) from public;
grant execute on function public.create_tournament_with_course(text, text, date, integer, text, integer, text, uuid, text) to authenticated;
