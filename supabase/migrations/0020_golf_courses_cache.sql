-- ============================================================================
-- Shared, non-tournament-scoped cache of courses imported from the external
-- GolfCourseAPI service. Not written to directly by any client: rows are
-- only ever inserted by the `golf-course-lookup` Edge Function using the
-- service-role key (bypassing RLS), which also enforces the external
-- API key never reaches the browser. `external_id` is the deduplication
-- key -- re-importing the same GolfCourseAPI course reuses this row instead
-- of calling the external API again.
-- ============================================================================

create table public.golf_courses (
  id uuid primary key default gen_random_uuid(),
  external_id text unique not null,
  club_name text not null,
  course_name text not null,
  address text,
  city text,
  state text,
  country text,
  imported_by uuid not null references public.profiles (id),
  imported_at timestamptz not null default now(),
  -- Full external API payload for this course, kept in case a field we
  -- don't model explicitly below turns out to be needed later.
  raw_payload jsonb not null
);

create index golf_courses_club_course_name_idx on public.golf_courses (club_name, course_name);

create table public.golf_course_tees (
  id uuid primary key default gen_random_uuid(),
  golf_course_id uuid not null references public.golf_courses (id) on delete cascade,
  tee_name text not null,
  gender text not null check (gender in ('male', 'female')),
  number_of_holes integer not null check (number_of_holes in (9, 18)),
  par_total integer,
  course_rating numeric,
  slope_rating integer,
  unique (golf_course_id, tee_name, gender)
);

create index golf_course_tees_course_idx on public.golf_course_tees (golf_course_id);

create table public.golf_course_tee_holes (
  id uuid primary key default gen_random_uuid(),
  tee_id uuid not null references public.golf_course_tees (id) on delete cascade,
  hole_number integer not null,
  par integer not null,
  yardage integer,
  handicap integer,
  unique (tee_id, hole_number)
);

create index golf_course_tee_holes_tee_idx on public.golf_course_tee_holes (tee_id);

alter table public.golf_courses enable row level security;
alter table public.golf_course_tees enable row level security;
alter table public.golf_course_tee_holes enable row level security;

-- Shared reference data: any authenticated GreenLink user can read the
-- course cache (needed to search/browse before joining a tournament that
-- uses it), but nobody writes to it directly -- see the Edge Function.
create policy "golf_courses_select_authenticated"
  on public.golf_courses for select
  to authenticated
  using (true);

create policy "golf_course_tees_select_authenticated"
  on public.golf_course_tees for select
  to authenticated
  using (true);

create policy "golf_course_tee_holes_select_authenticated"
  on public.golf_course_tee_holes for select
  to authenticated
  using (true);
