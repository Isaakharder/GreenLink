-- ============================================================================
-- tournaments.data_version: a monotonically increasing counter bumped
-- whenever *structural* tournament setup data changes (course/tee/holes/
-- teams/roster/lifecycle) -- used by the frontend's offline download
-- feature to detect "the cached copy on this device is stale" without
-- comparing individual tables. Deliberately NOT bumped by team_hole_scores
-- changes: live scoring already syncs continuously through the existing
-- offline queue, and bumping this on every single score would make
-- "update available" fire constantly during play, which isn't the point --
-- this tracks setup data, not live play state.
-- ============================================================================

alter table public.tournaments
  add column data_version integer not null default 1;

create function public.bump_tournament_data_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
begin
  -- Direct updates to the tournaments row itself (course/tee/rating,
  -- status transitions via start_tournament/finish_tournament, etc.):
  -- bump inline as part of the same row update, no recursion risk since
  -- this is BEFORE UPDATE and only mutates NEW.
  if TG_TABLE_NAME = 'tournaments' then
    NEW.data_version := OLD.data_version + 1;
    return NEW;
  end if;

  v_tournament_id := coalesce(NEW.tournament_id, OLD.tournament_id);
  update public.tournaments set data_version = data_version + 1 where id = v_tournament_id;
  return coalesce(NEW, OLD);
end;
$$;

create trigger tournaments_bump_data_version
  before update on public.tournaments
  for each row
  execute function public.bump_tournament_data_version();

create trigger tournament_holes_bump_data_version
  after insert or update or delete on public.tournament_holes
  for each row
  execute function public.bump_tournament_data_version();

create trigger tournament_teams_bump_data_version
  after insert or update or delete on public.tournament_teams
  for each row
  execute function public.bump_tournament_data_version();

create trigger tournament_players_bump_data_version
  after insert or update or delete on public.tournament_players
  for each row
  execute function public.bump_tournament_data_version();
