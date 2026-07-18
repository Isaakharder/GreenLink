-- ============================================================================
-- tournament_lifecycle_events: audit trail for finishing a tournament,
-- including forced completion with a mandatory reason. Rows are only ever
-- written from inside finish_tournament() (SECURITY DEFINER); members and
-- the organizer can read them (surfaced on the completed Results view).
-- ============================================================================

create table public.tournament_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  event_type text not null check (event_type in ('finished', 'force_finished')),
  performed_by uuid not null references public.profiles (id),
  reason text,
  created_at timestamptz not null default now()
);

create index tournament_lifecycle_events_tournament_idx on public.tournament_lifecycle_events (tournament_id);

alter table public.tournament_lifecycle_events enable row level security;

create policy "tournament_lifecycle_events_select_members"
  on public.tournament_lifecycle_events for select
  to authenticated
  using (public.is_tournament_member(tournament_id) or public.is_tournament_organizer(tournament_id));

-- Speeds up the per-hole aggregation in get_tournament_progress() and the
-- leaderboard queries in LiveScoreTab/ScorecardTab, which group by hole
-- within a tournament.
create index team_hole_scores_tournament_hole_idx on public.team_hole_scores (tournament_id, hole_number);

-- ============================================================================
-- get_tournament_progress(): single source of truth for "is every team done
-- scoring", used both to render the organizer's Overview progress list and
-- to decide whether to warn before finishing. finish_tournament() re-derives
-- the same completeness check itself rather than trusting this result,
-- exactly like get_tournament_readiness()/start_tournament() in 0015.
-- ============================================================================

create function public.get_tournament_progress(p_tournament_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_hole_count integer;
  v_teams jsonb;
  v_teams_finished integer;
  v_teams_playing integer;
  v_total_synced integer;
  v_team_count integer;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can view tournament progress';
  end if;

  select hole_count into v_hole_count
  from public.tournaments
  where id = p_tournament_id;

  if v_hole_count is null then
    raise exception 'tournament not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'team_id', t.id,
      'name', coalesce(t.name, 'Team ' || t.team_number),
      'holes_scored', coalesce(s.scored, 0),
      'holes_remaining', greatest(v_hole_count - coalesce(s.scored, 0), 0),
      'percent_complete', case when v_hole_count = 0 then 0
        else round(coalesce(s.scored, 0)::numeric / v_hole_count * 100)::integer end,
      'complete', coalesce(s.scored, 0) >= v_hole_count
    ) order by t.team_number nulls last, t.name),
    '[]'::jsonb)
  into v_teams
  from public.tournament_teams t
  left join (
    select team_id, count(distinct hole_number) as scored
    from public.team_hole_scores
    where tournament_id = p_tournament_id
    group by team_id
  ) s on s.team_id = t.id
  where t.tournament_id = p_tournament_id;

  select count(*) into v_team_count from public.tournament_teams where tournament_id = p_tournament_id;

  select count(*) into v_teams_finished
  from public.tournament_teams t
  left join (
    select team_id, count(distinct hole_number) as scored
    from public.team_hole_scores
    where tournament_id = p_tournament_id
    group by team_id
  ) s on s.team_id = t.id
  where t.tournament_id = p_tournament_id and coalesce(s.scored, 0) >= v_hole_count;

  v_teams_playing := v_team_count - v_teams_finished;

  select count(*) into v_total_synced
  from public.team_hole_scores
  where tournament_id = p_tournament_id;

  return jsonb_build_object(
    'hole_count', v_hole_count,
    'teams', v_teams,
    'teams_finished', v_teams_finished,
    'teams_playing', v_teams_playing,
    'total_synced_entries', v_total_synced,
    'all_complete', v_team_count > 0 and v_teams_finished = v_team_count
  );
end;
$$;

revoke execute on function public.get_tournament_progress(uuid) from public;
grant execute on function public.get_tournament_progress(uuid) to authenticated;

-- ============================================================================
-- finish_tournament(): replaces the 0015 version. A normal finish now
-- requires every team to have scored every hole; an organizer who needs to
-- close out early (weather, daylight, a team that quit) must pass
-- p_force := true with a non-empty p_reason, and that override is audited.
-- ============================================================================

drop function if exists public.finish_tournament(uuid);

create function public.finish_tournament(
  p_tournament_id uuid,
  p_force boolean default false,
  p_reason text default null
)
returns public.tournaments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_hole_count integer;
  v_incomplete_count integer;
  v_result public.tournaments;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can finish the tournament';
  end if;

  select status, hole_count into v_status, v_hole_count
  from public.tournaments
  where id = p_tournament_id;

  if v_status is null then
    raise exception 'tournament not found';
  end if;
  if v_status <> 'live' then
    raise exception 'only a live tournament can be finished';
  end if;

  if p_force then
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'a reason is required to force-complete the tournament';
    end if;
  else
    select count(*) into v_incomplete_count
    from public.tournament_teams t
    left join (
      select team_id, count(distinct hole_number) as scored
      from public.team_hole_scores
      where tournament_id = p_tournament_id
      group by team_id
    ) s on s.team_id = t.id
    where t.tournament_id = p_tournament_id and coalesce(s.scored, 0) < v_hole_count;

    if v_incomplete_count > 0 then
      raise exception '% team(s) still have incomplete scorecards. Use force-complete with a reason to finish anyway.', v_incomplete_count;
    end if;
  end if;

  update public.tournaments
  set status = 'completed', completed_at = now()
  where id = p_tournament_id
  returning * into v_result;

  insert into public.tournament_lifecycle_events (tournament_id, event_type, performed_by, reason)
  values (p_tournament_id, case when p_force then 'force_finished' else 'finished' end, auth.uid(), p_reason);

  return v_result;
end;
$$;

revoke execute on function public.finish_tournament(uuid, boolean, text) from public;
grant execute on function public.finish_tournament(uuid, boolean, text) to authenticated;
