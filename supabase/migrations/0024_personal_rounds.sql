-- ============================================================================
-- My Golf (Phase 1): personal, un-invited rounds. Internally a personal
-- round is a one-player tournament -- one tournaments row (is_personal =
-- true), one auto-created tournament_teams row, one tournament_players row
-- (organizer = true, accepted), no invitations. This reuses the entire
-- existing scoring engine (team_hole_scores, submit_team_score(),
-- correct_team_score(), the offline sync queue, ScorecardTab) completely
-- unchanged -- the player never sees teams or invitations, a dedicated My
-- Golf shell hides that plumbing. personal_rounds is a thin 1:1 extension
-- table for the fields a tournament has no concept of (visibility,
-- walking/cart), keeping `tournaments` itself untouched in shape and
-- leaving room for future features (friends/likes/comments/badges) to hang
-- off personal_rounds.tournament_id without another tournaments migration.
-- ============================================================================

alter table public.tournaments
  add column is_personal boolean not null default false;

-- "my recent rounds" (organizer_user_id = me, is_personal) and the public
-- feed (is_personal, status = 'completed') are the two hot queries.
create index tournaments_organizer_personal_idx on public.tournaments (organizer_user_id, is_personal);
create index tournaments_public_feed_idx on public.tournaments (is_personal, status) where is_personal;

create table public.personal_rounds (
  tournament_id uuid primary key references public.tournaments (id) on delete cascade,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  walking_or_cart text not null default 'walking' check (walking_or_cart in ('walking', 'cart')),
  created_at timestamptz not null default now()
);

alter table public.personal_rounds enable row level security;

-- ============================================================================
-- is_public_personal_round(): single source of truth for "can anyone read
-- this round", reused by every policy below (same pattern as
-- is_tournament_member()/is_tournament_organizer() in 0009). A round is
-- only ever publicly visible once finished -- a round still in progress is
-- never exposed, regardless of the visibility the player will eventually
-- choose.
-- ============================================================================

create function public.is_public_personal_round(p_tournament_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.tournaments t
    join public.personal_rounds pr on pr.tournament_id = t.id
    where t.id = p_tournament_id
      and t.is_personal
      and t.status = 'completed'
      and pr.visibility = 'public'
  );
$$;

grant execute on function public.is_public_personal_round(uuid) to authenticated;

-- Same idea as is_public_personal_round(), keyed by organizer instead of by
-- tournament -- used only by the profiles policy below, where there's no
-- single tournament_id column to check against.
create function public.has_public_personal_round(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.tournaments t
    join public.personal_rounds pr on pr.tournament_id = t.id
    where t.organizer_user_id = p_user_id
      and t.is_personal
      and t.status = 'completed'
      and pr.visibility = 'public'
  );
$$;

grant execute on function public.has_public_personal_round(uuid) to authenticated;

create policy "personal_rounds_select_owner_or_public"
  on public.personal_rounds for select
  to authenticated
  using (
    public.is_tournament_organizer(tournament_id)
    or public.is_public_personal_round(tournament_id)
  );

-- No insert/update policy: written only by start_personal_round()/
-- finish_personal_round() below (SECURITY DEFINER, bypasses RLS).

-- ============================================================================
-- Sibling SELECT policies on the existing tournament tables so a finished,
-- public round's tournament/team/holes/scores are readable by any
-- authenticated user -- not just the player (mirrors *_select_members
-- everywhere it already exists).
-- ============================================================================

create policy "tournaments_select_public_rounds"
  on public.tournaments for select
  to authenticated
  using (public.is_public_personal_round(id));

create policy "tournament_teams_select_public_rounds"
  on public.tournament_teams for select
  to authenticated
  using (public.is_public_personal_round(tournament_id));

create policy "tournament_holes_select_public_rounds"
  on public.tournament_holes for select
  to authenticated
  using (public.is_public_personal_round(tournament_id));

create policy "team_hole_scores_select_public_rounds"
  on public.team_hole_scores for select
  to authenticated
  using (public.is_public_personal_round(tournament_id));

-- profiles: a public round's player name needs to be visible to any viewer,
-- not just fellow tournament members (mirrors profiles_select_tournament_
-- co_members / profiles_select_invitation_parties in 0009).
create policy "profiles_select_public_round_organizer"
  on public.profiles for select
  to authenticated
  using (public.has_public_personal_round(profiles.id));

-- ============================================================================
-- start_personal_round(): the My Golf equivalent of create_tournament_with_
-- course(), but always requires a course/tee (My Golf never offers manual
-- course entry -- only a previously played course or a GolfCourseAPI
-- search result) and skips straight to 'live' -- there is no invitation/
-- team-assignment setup phase for a solo round, so get_tournament_
-- readiness()/start_tournament() (which require >= 2 accepted players) do
-- not apply and are not called. The tournament row is created as
-- 'upcoming' first purely so apply_imported_course_to_tournament() (via
-- save_tournament_holes(), which only allows hole changes in draft/
-- upcoming) can run unmodified, then flipped to 'live' in the same
-- transaction.
-- ============================================================================

create function public.start_personal_round(
  p_course_name text,
  p_tournament_date date,
  p_hole_count integer,
  p_tee_id uuid,
  p_nine text default null,
  p_walking_or_cart text default 'walking'
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

  if p_tee_id is null then
    raise exception 'a course and tee are required to start a round';
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

  -- Reuses the existing, unmodified import path (hole-count/nine
  -- compatibility rules, par/stroke-index/yardage copy) -- see
  -- 0021_apply_imported_course.sql. Raises (rolling back everything above)
  -- if the tee doesn't match p_hole_count/p_nine.
  perform public.apply_imported_course_to_tournament(v_tournament_id, p_tee_id, p_nine);

  update public.tournaments
  set status = 'live', started_at = now()
  where id = v_tournament_id;

  return v_tournament_id;
end;
$$;

revoke execute on function public.start_personal_round(text, date, integer, uuid, text, text) from public;
grant execute on function public.start_personal_round(text, date, integer, uuid, text, text) to authenticated;

-- ============================================================================
-- finish_personal_round(): unlike finish_tournament(), does not require
-- every hole to be scored -- a solo round can be picked up early (weather,
-- time, a front-nine-only day) with whatever was scored standing as final.
-- ============================================================================

create function public.finish_personal_round(
  p_tournament_id uuid,
  p_visibility text default 'private'
)
returns public.tournaments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_is_personal boolean;
  v_result public.tournaments;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the player can finish this round';
  end if;

  if p_visibility not in ('private', 'public') then
    raise exception 'visibility must be ''private'' or ''public''';
  end if;

  select status, is_personal into v_status, v_is_personal
  from public.tournaments
  where id = p_tournament_id;

  if v_status is null then
    raise exception 'round not found';
  end if;
  if not v_is_personal then
    raise exception 'not a personal round';
  end if;
  if v_status <> 'live' then
    raise exception 'only a round in progress can be finished';
  end if;

  update public.tournaments
  set status = 'completed', completed_at = now()
  where id = p_tournament_id
  returning * into v_result;

  update public.personal_rounds
  set visibility = p_visibility
  where tournament_id = p_tournament_id;

  return v_result;
end;
$$;

revoke execute on function public.finish_personal_round(uuid, text) from public;
grant execute on function public.finish_personal_round(uuid, text) to authenticated;

-- ============================================================================
-- get_public_round_feed(): one aggregating query for the Home page
-- Community Feed instead of N+1 client fetches (same "one RPC does the
-- aggregation" convention as get_tournament_progress()). Newest-finished
-- first.
-- ============================================================================

create function public.get_public_round_feed(p_limit integer default 30)
returns table (
  tournament_id uuid,
  player_first_name text,
  player_last_name text,
  course_name text,
  tee_name text,
  tournament_date date,
  completed_at timestamptz,
  hole_count integer,
  total_strokes bigint,
  relative_to_par bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id as tournament_id,
    p.first_name as player_first_name,
    p.last_name as player_last_name,
    t.course_name,
    gct.tee_name,
    t.tournament_date,
    t.completed_at,
    t.hole_count,
    coalesce(sum(s.strokes), 0) as total_strokes,
    coalesce(sum(s.strokes - h.par), 0) as relative_to_par
  from public.tournaments t
  join public.personal_rounds pr on pr.tournament_id = t.id
  join public.profiles p on p.id = t.organizer_user_id
  left join public.golf_course_tees gct on gct.id = t.golf_course_tee_id
  left join public.team_hole_scores s on s.tournament_id = t.id
  left join public.tournament_holes h on h.tournament_id = t.id and h.hole_number = s.hole_number
  where t.is_personal and t.status = 'completed' and pr.visibility = 'public'
  group by t.id, p.first_name, p.last_name, t.course_name, gct.tee_name, t.tournament_date, t.completed_at, t.hole_count
  order by t.completed_at desc
  limit greatest(coalesce(p_limit, 30), 0);
$$;

grant execute on function public.get_public_round_feed(integer) to authenticated;

-- ============================================================================
-- get_my_golf_stats(): aggregates the caller's own completed personal
-- rounds. Computed entirely on read from team_hole_scores/tournament_holes
-- -- nothing pre-aggregated/stored. Score buckets are keyed off
-- strokes - par: eagle-or-better folds into "birdies" since the brief lists
-- exactly birdies/pars/bogeys/double-bogeys+ and no separate eagle bucket.
-- ============================================================================

create function public.get_my_golf_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_rounds_played integer;
  v_average_score numeric;
  v_courses_played integer;
  v_birdies integer;
  v_pars integer;
  v_bogeys integer;
  v_double_bogeys_plus integer;
  v_best_round jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select count(*) into v_rounds_played
  from public.tournaments t
  where t.organizer_user_id = auth.uid() and t.is_personal and t.status = 'completed';

  select round(avg(totals.total_strokes), 1) into v_average_score
  from (
    select t.id, sum(s.strokes) as total_strokes
    from public.tournaments t
    join public.team_hole_scores s on s.tournament_id = t.id
    where t.organizer_user_id = auth.uid() and t.is_personal and t.status = 'completed'
    group by t.id
  ) totals;

  select count(distinct t.golf_course_id) into v_courses_played
  from public.tournaments t
  where t.organizer_user_id = auth.uid() and t.is_personal and t.status = 'completed'
    and t.golf_course_id is not null;

  select
    count(*) filter (where s.strokes - h.par <= -1),
    count(*) filter (where s.strokes - h.par = 0),
    count(*) filter (where s.strokes - h.par = 1),
    count(*) filter (where s.strokes - h.par >= 2)
  into v_birdies, v_pars, v_bogeys, v_double_bogeys_plus
  from public.tournaments t
  join public.team_hole_scores s on s.tournament_id = t.id
  join public.tournament_holes h on h.tournament_id = t.id and h.hole_number = s.hole_number
  where t.organizer_user_id = auth.uid() and t.is_personal and t.status = 'completed';

  select jsonb_build_object(
      'tournament_id', best.id,
      'course_name', best.course_name,
      'tournament_date', best.tournament_date,
      'relative_to_par', best.relative_to_par
    )
  into v_best_round
  from (
    select t.id, t.course_name, t.tournament_date, sum(s.strokes - h.par) as relative_to_par
    from public.tournaments t
    join public.team_hole_scores s on s.tournament_id = t.id
    join public.tournament_holes h on h.tournament_id = t.id and h.hole_number = s.hole_number
    where t.organizer_user_id = auth.uid() and t.is_personal and t.status = 'completed'
    group by t.id, t.course_name, t.tournament_date
    order by relative_to_par asc
    limit 1
  ) best;

  return jsonb_build_object(
    'rounds_played', v_rounds_played,
    'average_score', v_average_score,
    'best_round', v_best_round,
    'birdies', coalesce(v_birdies, 0),
    'pars', coalesce(v_pars, 0),
    'bogeys', coalesce(v_bogeys, 0),
    'double_bogeys_plus', coalesce(v_double_bogeys_plus, 0),
    'courses_played', coalesce(v_courses_played, 0)
  );
end;
$$;

revoke execute on function public.get_my_golf_stats() from public;
grant execute on function public.get_my_golf_stats() to authenticated;
