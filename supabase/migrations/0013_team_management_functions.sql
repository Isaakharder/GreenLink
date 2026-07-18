-- ============================================================================
-- Team management functions. Every one: organizer-only, rejects changes once
-- the tournament is no longer draft/upcoming, and validates that any team/
-- player id passed in actually belongs to the tournament being touched.
-- Team-size compliance itself is NOT enforced at assignment time (organizers
-- need room to shuffle players around while setting up); it's enforced as a
-- start-gate by get_tournament_readiness()/start_tournament() in
-- 0015_readiness_and_lifecycle_functions.sql.
-- ============================================================================

create function public.create_tournament_team(p_tournament_id uuid, p_name text default null)
returns public.tournament_teams
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_next_number integer;
  v_result public.tournament_teams;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can create teams';
  end if;

  select status into v_status from public.tournaments where id = p_tournament_id;
  if v_status is null then
    raise exception 'tournament not found';
  end if;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'teams cannot be changed once the tournament has started';
  end if;

  select coalesce(max(team_number), 0) + 1 into v_next_number
  from public.tournament_teams
  where tournament_id = p_tournament_id;

  insert into public.tournament_teams (tournament_id, name, team_number)
  values (p_tournament_id, coalesce(nullif(trim(p_name), ''), 'Team ' || v_next_number), v_next_number)
  returning * into v_result;

  return v_result;
end;
$$;

create function public.rename_tournament_team(p_team_id uuid, p_name text)
returns public.tournament_teams
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status text;
  v_result public.tournament_teams;
begin
  select tournament_id into v_tournament_id from public.tournament_teams where id = p_team_id;
  if v_tournament_id is null then
    raise exception 'team not found';
  end if;

  if not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the tournament organizer can rename teams';
  end if;

  select status into v_status from public.tournaments where id = v_tournament_id;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'teams cannot be changed once the tournament has started';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'team name cannot be empty';
  end if;

  update public.tournament_teams
  set name = trim(p_name)
  where id = p_team_id
  returning * into v_result;

  return v_result;
end;
$$;

create function public.delete_tournament_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status text;
  v_member_count integer;
begin
  select tournament_id into v_tournament_id from public.tournament_teams where id = p_team_id;
  if v_tournament_id is null then
    raise exception 'team not found';
  end if;

  if not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the tournament organizer can delete teams';
  end if;

  select status into v_status from public.tournaments where id = v_tournament_id;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'teams cannot be changed once the tournament has started';
  end if;

  select count(*) into v_member_count
  from public.tournament_players
  where team_id = p_team_id;

  if v_member_count > 0 then
    raise exception 'remove all players from this team before deleting it';
  end if;

  delete from public.tournament_teams where id = p_team_id;
end;
$$;

create function public.assign_tournament_player(p_player_id uuid, p_team_id uuid)
returns public.tournament_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_player_tournament_id uuid;
  v_team_tournament_id uuid;
  v_status text;
  v_result public.tournament_players;
begin
  select tournament_id into v_player_tournament_id
  from public.tournament_players
  where id = p_player_id;

  if v_player_tournament_id is null then
    raise exception 'player not found';
  end if;

  select tournament_id into v_team_tournament_id
  from public.tournament_teams
  where id = p_team_id;

  if v_team_tournament_id is null then
    raise exception 'team not found';
  end if;

  if v_player_tournament_id <> v_team_tournament_id then
    raise exception 'player and team must belong to the same tournament';
  end if;

  v_tournament_id := v_player_tournament_id;

  if not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the tournament organizer can assign players';
  end if;

  select status into v_status from public.tournaments where id = v_tournament_id;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'team assignments cannot be changed once the tournament has started';
  end if;

  update public.tournament_players
  set team_id = p_team_id
  where id = p_player_id
  returning * into v_result;

  return v_result;
end;
$$;

create function public.unassign_tournament_player(p_player_id uuid)
returns public.tournament_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status text;
  v_result public.tournament_players;
begin
  select tournament_id into v_tournament_id
  from public.tournament_players
  where id = p_player_id;

  if v_tournament_id is null then
    raise exception 'player not found';
  end if;

  if not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the tournament organizer can unassign players';
  end if;

  select status into v_status from public.tournaments where id = v_tournament_id;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'team assignments cannot be changed once the tournament has started';
  end if;

  update public.tournament_players
  set team_id = null
  where id = p_player_id
  returning * into v_result;

  return v_result;
end;
$$;

create function public.auto_create_tournament_teams(p_tournament_id uuid)
returns setof public.tournament_teams
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_team_size integer;
  v_accepted_count integer;
  v_existing_team_count integer;
  v_target_team_count integer;
  v_next_number integer;
  v_to_create integer;
  i integer;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can create teams';
  end if;

  select status, team_size into v_status, v_team_size
  from public.tournaments
  where id = p_tournament_id;

  if v_status is null then
    raise exception 'tournament not found';
  end if;

  if v_status not in ('draft', 'upcoming') then
    raise exception 'teams cannot be changed once the tournament has started';
  end if;

  if v_team_size is null or v_team_size < 1 then
    raise exception 'set a team size before auto-creating teams';
  end if;

  select count(*) into v_accepted_count
  from public.tournament_players
  where tournament_id = p_tournament_id and membership_status = 'accepted';

  select count(*) into v_existing_team_count
  from public.tournament_teams
  where tournament_id = p_tournament_id;

  v_target_team_count := ceil(v_accepted_count::numeric / v_team_size::numeric)::integer;
  v_to_create := greatest(v_target_team_count - v_existing_team_count, 0);

  if v_to_create = 0 then
    raise exception 'enough teams already exist for the current accepted players';
  end if;

  select coalesce(max(team_number), 0) into v_next_number
  from public.tournament_teams
  where tournament_id = p_tournament_id;

  for i in 1..v_to_create loop
    v_next_number := v_next_number + 1;
    insert into public.tournament_teams (tournament_id, name, team_number)
    values (p_tournament_id, 'Team ' || v_next_number, v_next_number);
  end loop;

  return query
    select * from public.tournament_teams
    where tournament_id = p_tournament_id
    order by team_number;
end;
$$;

revoke execute on function public.create_tournament_team(uuid, text) from public;
grant execute on function public.create_tournament_team(uuid, text) to authenticated;

revoke execute on function public.rename_tournament_team(uuid, text) from public;
grant execute on function public.rename_tournament_team(uuid, text) to authenticated;

revoke execute on function public.delete_tournament_team(uuid) from public;
grant execute on function public.delete_tournament_team(uuid) to authenticated;

revoke execute on function public.assign_tournament_player(uuid, uuid) from public;
grant execute on function public.assign_tournament_player(uuid, uuid) to authenticated;

revoke execute on function public.unassign_tournament_player(uuid) from public;
grant execute on function public.unassign_tournament_player(uuid) to authenticated;

revoke execute on function public.auto_create_tournament_teams(uuid) from public;
grant execute on function public.auto_create_tournament_teams(uuid) to authenticated;
