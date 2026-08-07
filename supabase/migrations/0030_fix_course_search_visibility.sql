-- ============================================================================
-- Regression fix: previously-imported/cached GolfCourseAPI courses were
-- invisible to search_courses() and could be shadowed by an incomplete
-- duplicate from a fresh GolfCourseAPI search.
--
-- Root cause (production incident, Orchard View Golf Club):
--
-- 1. search_courses() (0027/0028) filters `gc.source in ('manual',
--    'imported')`. That was written to mean "GreenLink's own course
--    library", but it also silently excludes every course that was already
--    imported from GolfCourseAPI and cached in golf_courses with
--    source = 'golfcourseapi' -- including courses that have already been
--    played in real tournaments. Those rows were never part of "GreenLink's
--    own library" search, on purpose or not, and depend entirely on
--    GolfCourseAPI's live search returning the exact same result every time
--    to ever be found again.
--
-- 2. handleImport() (golf-course-lookup/index.ts) never stamped
--    published_at on a freshly-imported golfcourseapi row, so even after
--    fixing (1), every course imported since 0028 shipped (2026-07-26)
--    would still never satisfy search_courses()'s `published_at is not
--    null` gate. This is fixed in the Edge Function change accompanying
--    this migration; this migration only backfills existing rows.
--
-- 3. Because of (1) and (2), Orchard View Golf Club's complete, previously-
--    imported record (external_id 25562, 6 usable tees, played in 5 prior
--    tournaments) was never eligible to be surfaced by GreenLink's own
--    search or to shadow a duplicate. When GolfCourseAPI's live search
--    started returning a second, distinct listing for the same club --
--    "Orchard View Golf Club (Old)", external_id 'zcvtyq4k', zero tees --
--    nothing in GreenLink recognized that a complete record for the same
--    course already existed locally. The organizer's search only had the
--    broken listing to select, importing it created a second, empty
--    golf_courses row (id 35492ace-c0ae-4bcb-882f-eb46a615b7af), and the
--    tee picker correctly reported "No tee data available" for *that* row
--    -- while the original, complete, already-played course sat untouched
--    and unreachable from search.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Backfill published_at for every golfcourseapi-sourced row that predates
--    the Edge Function fix (this migration ships alongside the fix that
--    stamps published_at on every future import). Mirrors 0028's own
--    backfill for the same reason: nothing that was already importable
--    should silently become unsearchable, or stay unsearchable, because of
--    a column it was never taught to fill in.
-- ----------------------------------------------------------------------------

update public.golf_courses
set published_at = coalesce(published_at, imported_at, created_at, now())
where source = 'golfcourseapi'
  and published_at is null;

-- ----------------------------------------------------------------------------
-- 2) Archive the specific broken duplicate this incident produced. It has
--    zero tees, was never referenced by any tournament, and its
--    non-numeric external_id ('zcvtyq4k') is not a real, re-fetchable
--    GolfCourseAPI id -- keeping it live only gives search another empty
--    result to rank against the real course. archived_at (not a delete)
--    keeps it around for audit/history, exactly like every other archive
--    path in this schema.
-- ----------------------------------------------------------------------------

update public.golf_courses
set archived_at = now(), updated_at = now()
where id = '35492ace-c0ae-4bcb-882f-eb46a615b7af'
  and club_name = 'Orchard View Golf Club'
  and course_name = 'Orchard View Golf Club (Old)'
  and archived_at is null
  and not exists (select 1 from public.golf_course_tees where golf_course_id = golf_courses.id);

-- ----------------------------------------------------------------------------
-- 3) search_courses(): drop the source restriction (every published,
--    non-archived course in golf_courses is "GreenLink's own library" now
--    -- a golfcourseapi-sourced cache row is exactly as reusable as a
--    manual one), and replace has_usable_tee's "a tee row exists" check
--    with a real usability check mirroring the Edge Function's
--    isTeeUsable(): valid hole numbering (9 or 18) and every one of those
--    holes has a real, positive par. Also returns usable_tee_count so the
--    frontend can carry it as part of a search result's identity instead
--    of a single boolean, and can tell "one incomplete tee, one valid tee"
--    apart from "no usable tees at all" without a second round trip.
--    Column set changes, so drop-then-create (per the 0019 postmortem this
--    file already documents) rather than create-or-replace.
-- ----------------------------------------------------------------------------

drop function if exists public.search_courses(text, integer);

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
  has_usable_tee boolean,
  usable_tee_count integer
)
language sql
security definer
set search_path = public
stable
as $$
  select
    gc.id, gc.external_id, gc.club_name, gc.course_name, gc.city, gc.state, gc.country, gc.source,
    coalesce(ut.usable_tee_count, 0) > 0 as has_usable_tee,
    coalesce(ut.usable_tee_count, 0)::integer as usable_tee_count
  from public.golf_courses gc
  left join lateral (
    select count(*) as usable_tee_count
    from public.golf_course_tees t
    where t.golf_course_id = gc.id
      and t.archived_at is null
      and t.number_of_holes in (9, 18)
      and t.number_of_holes = (
        select count(*)
        from public.golf_course_tee_holes h
        where h.tee_id = t.id and h.par is not null and h.par > 0
      )
  ) ut on true
  where gc.archived_at is null
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
    coalesce(ut.usable_tee_count, 0) > 0 desc,
    gc.club_name
  limit greatest(coalesce(p_limit, 20), 0);
$$;

revoke execute on function public.search_courses(text, integer) from public;
grant execute on function public.search_courses(text, integer) to authenticated;
