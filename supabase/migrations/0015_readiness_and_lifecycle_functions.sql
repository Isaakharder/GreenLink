-- ============================================================================
-- get_tournament_readiness(): single source of truth for "is this tournament
-- safe to start", returned as one jsonb object. Used both to render the
-- Overview checklist and by start_tournament() below, so the UI and the
-- enforced rule can never drift apart. Organizer-only.
-- ============================================================================

create function public.get_tournament_readiness(p_tournament_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_tournament public.tournaments;
  v_holes_configured_count integer;
  v_accepted_count integer;
  v_unassigned_count integer;
  v_team_count integer;
  v_invalid_teams jsonb;
  v_details_complete boolean;
  v_holes_ok boolean;
  v_players_ok boolean;
  v_assignment_ok boolean;
  v_teams_ok boolean;
  v_team_sizes_ok boolean;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can view setup readiness';
  end if;

  select * into v_tournament from public.tournaments where id = p_tournament_id;
  if not found then
    raise exception 'tournament not found';
  end if;

  select count(*) into v_holes_configured_count
  from public.tournament_holes
  where tournament_id = p_tournament_id;

  select count(*) into v_accepted_count
  from public.tournament_players
  where tournament_id = p_tournament_id and membership_status = 'accepted';

  select count(*) into v_unassigned_count
  from public.tournament_players
  where tournament_id = p_tournament_id and membership_status = 'accepted' and team_id is null;

  select count(*) into v_team_count
  from public.tournament_teams
  where tournament_id = p_tournament_id;

  -- Teams whose accepted+assigned player count doesn't match the tournament's
  -- team size. Only evaluated when a team size has been set.
  select coalesce(jsonb_agg(jsonb_build_object(
      'team_id', t.id,
      'name', coalesce(t.name, 'Team ' || t.team_number),
      'required', v_tournament.team_size,
      'actual', coalesce(p.player_count, 0)
    )), '[]'::jsonb)
  into v_invalid_teams
  from public.tournament_teams t
  left join (
    select team_id, count(*) as player_count
    from public.tournament_players
    where tournament_id = p_tournament_id and membership_status = 'accepted' and team_id is not null
    group by team_id
  ) p on p.team_id = t.id
  where t.tournament_id = p_tournament_id
    and v_tournament.team_size is not null
    and coalesce(p.player_count, 0) <> v_tournament.team_size;

  v_details_complete :=
    v_tournament.name is not null and length(trim(v_tournament.name)) > 0
    and v_tournament.course_name is not null and length(trim(v_tournament.course_name)) > 0
    and v_tournament.tournament_date is not null
    and v_tournament.team_size is not null
    and v_tournament.scoring_format is not null;

  v_holes_ok := v_holes_configured_count = v_tournament.hole_count;
  v_players_ok := v_accepted_count >= 2;
  v_assignment_ok := v_unassigned_count = 0 and v_accepted_count > 0;
  v_teams_ok := v_team_count > 0;
  v_team_sizes_ok := jsonb_array_length(v_invalid_teams) = 0;

  return jsonb_build_object(
    'details_complete', v_details_complete,
    'holes_required', v_tournament.hole_count,
    'holes_configured_count', v_holes_configured_count,
    'holes_configured', v_holes_ok,
    'accepted_player_count', v_accepted_count,
    'min_players_met', v_players_ok,
    'unassigned_count', v_unassigned_count,
    'all_players_assigned', v_assignment_ok,
    'team_count', v_team_count,
    'teams_created', v_teams_ok,
    'invalid_teams', v_invalid_teams,
    'team_sizes_valid', v_team_sizes_ok,
    -- Structurally guaranteed by the unique(tournament_id, user_id) constraint
    -- and team_id being a single nullable column on tournament_players: a
    -- player can never occupy two rows/teams at once. Included so the
    -- checklist has one data source instead of hardcoding this in the UI.
    'no_duplicate_assignments', true,
    'ready', (
      v_details_complete and v_holes_ok and v_players_ok
      and v_assignment_ok and v_teams_ok and v_team_sizes_ok
    )
  );
end;
$$;

-- ============================================================================
-- start_tournament(): re-derives readiness and raises the specific reason
-- for the first failing check, so the organizer always gets an actionable
-- message rather than a generic rejection.
-- ============================================================================

create function public.start_tournament(p_tournament_id uuid)
returns public.tournaments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_readiness jsonb;
  v_invalid_team jsonb;
  v_result public.tournaments;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can start the tournament';
  end if;

  select status into v_status from public.tournaments where id = p_tournament_id;
  if v_status is null then
    raise exception 'tournament not found';
  end if;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'tournament has already been started';
  end if;

  v_readiness := public.get_tournament_readiness(p_tournament_id);

  if not (v_readiness ->> 'details_complete')::boolean then
    raise exception 'Complete the tournament name, course, date, scoring format and team size before starting.';
  end if;

  if not (v_readiness ->> 'holes_configured')::boolean then
    raise exception 'Configure all % holes before starting.', v_readiness ->> 'holes_required';
  end if;

  if not (v_readiness ->> 'min_players_met')::boolean then
    raise exception 'At least two accepted players are required to start.';
  end if;

  if not (v_readiness ->> 'all_players_assigned')::boolean then
    raise exception 'Assign all accepted players to a team before starting.';
  end if;

  if not (v_readiness ->> 'teams_created')::boolean then
    raise exception 'Create at least one team before starting.';
  end if;

  if not (v_readiness ->> 'team_sizes_valid')::boolean then
    v_invalid_team := v_readiness -> 'invalid_teams' -> 0;
    raise exception '% requires % players (has %).',
      v_invalid_team ->> 'name',
      v_invalid_team ->> 'required',
      v_invalid_team ->> 'actual';
  end if;

  update public.tournaments
  set status = 'live', started_at = now()
  where id = p_tournament_id
  returning * into v_result;

  return v_result;
end;
$$;

-- ============================================================================
-- finish_tournament(): organizer, live-only. Leaves scores untouched
-- (regular-player writes are already blocked by submit_team_score()
-- requiring status = 'live'; the completed leaderboard is simply whatever
-- team_hole_scores holds at this point).
-- ============================================================================

create function public.finish_tournament(p_tournament_id uuid)
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
    raise exception 'only the tournament organizer can finish the tournament';
  end if;

  select status into v_status from public.tournaments where id = p_tournament_id;
  if v_status is null then
    raise exception 'tournament not found';
  end if;
  if v_status <> 'live' then
    raise exception 'only a live tournament can be finished';
  end if;

  update public.tournaments
  set status = 'completed', completed_at = now()
  where id = p_tournament_id
  returning * into v_result;

  return v_result;
end;
$$;

-- No direct client update path remains for `tournaments`: status now only
-- ever changes via create_tournament()/start_tournament()/finish_tournament(),
-- all SECURITY DEFINER. Nothing in the app used this policy for anything
-- else (there is no "edit tournament details" UI), so nothing is lost.
drop policy "tournaments_update_organizer" on public.tournaments;

revoke execute on function public.get_tournament_readiness(uuid) from public;
grant execute on function public.get_tournament_readiness(uuid) to authenticated;

revoke execute on function public.start_tournament(uuid) from public;
grant execute on function public.start_tournament(uuid) to authenticated;

revoke execute on function public.finish_tournament(uuid) from public;
grant execute on function public.finish_tournament(uuid) to authenticated;
