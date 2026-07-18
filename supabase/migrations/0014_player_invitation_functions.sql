-- ============================================================================
-- cancel_tournament_invitation(): organizer cancels a pending invitation.
-- ============================================================================

create function public.cancel_tournament_invitation(p_invitation_id uuid)
returns public.tournament_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status text;
  v_result public.tournament_invitations;
begin
  select tournament_id, status into v_tournament_id, v_status
  from public.tournament_invitations
  where id = p_invitation_id
  for update;

  if v_tournament_id is null then
    raise exception 'invitation not found';
  end if;

  if not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the tournament organizer can cancel invitations';
  end if;

  if v_status <> 'pending' then
    raise exception 'only pending invitations can be cancelled';
  end if;

  update public.tournament_invitations
  set status = 'cancelled', responded_at = now()
  where id = p_invitation_id
  returning * into v_result;

  return v_result;
end;
$$;

-- ============================================================================
-- remove_tournament_player(): organizer removes an accepted player before
-- the tournament starts. The organizer's own membership row can't be removed
-- this way, and nothing here works once the tournament is live/completed/
-- cancelled — a "remove a live player" workflow would need its own audited
-- correction function, which is explicitly out of scope for this phase.
-- ============================================================================

create function public.remove_tournament_player(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_is_organizer boolean;
  v_status text;
begin
  select tournament_id, is_organizer into v_tournament_id, v_is_organizer
  from public.tournament_players
  where id = p_player_id;

  if v_tournament_id is null then
    raise exception 'player not found';
  end if;

  if not public.is_tournament_organizer(v_tournament_id) then
    raise exception 'only the tournament organizer can remove players';
  end if;

  if v_is_organizer then
    raise exception 'the organizer cannot be removed from their own tournament';
  end if;

  select status into v_status from public.tournaments where id = v_tournament_id;
  if v_status not in ('draft', 'upcoming') then
    raise exception 'players cannot be removed once the tournament has started';
  end if;

  delete from public.tournament_players where id = p_player_id;
end;
$$;

-- ============================================================================
-- invite_player(): replaces the 0009 version. Now revives a cancelled or
-- declined invitation in place (re-send) instead of failing on the unique
-- constraint, and is restricted to draft/upcoming tournaments (inviting
-- players to a tournament already underway isn't part of this setup flow).
-- ============================================================================

create or replace function public.invite_player(p_tournament_id uuid, p_invited_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
  v_status text;
  v_tournament_status text;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can invite players';
  end if;

  select status into v_tournament_status from public.tournaments where id = p_tournament_id;
  if v_tournament_status is null then
    raise exception 'tournament not found';
  end if;
  if v_tournament_status not in ('draft', 'upcoming') then
    raise exception 'players cannot be invited once the tournament has started';
  end if;

  if exists (
    select 1 from public.tournament_players
    where tournament_id = p_tournament_id and user_id = p_invited_user_id
  ) then
    raise exception 'player is already a member of this tournament';
  end if;

  select id, status into v_invitation_id, v_status
  from public.tournament_invitations
  where tournament_id = p_tournament_id and invited_user_id = p_invited_user_id
  for update;

  if v_invitation_id is not null then
    if v_status = 'pending' then
      raise exception 'player has already been invited to this tournament';
    end if;

    update public.tournament_invitations
    set status = 'pending',
        invited_by_user_id = auth.uid(),
        responded_at = null,
        created_at = now()
    where id = v_invitation_id;

    return v_invitation_id;
  end if;

  insert into public.tournament_invitations (tournament_id, invited_user_id, invited_by_user_id)
  values (p_tournament_id, p_invited_user_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;

-- ============================================================================
-- create_tournament(): replaces the 0009 version. Adds an optional
-- description and starts tournaments in `draft` (was `upcoming`) per this
-- phase's spec — `start_tournament()` in 0015 accepts either.
-- ============================================================================

create or replace function public.create_tournament(
  p_name text,
  p_course_name text,
  p_tournament_date date,
  p_hole_count integer default 18,
  p_scoring_format text default null,
  p_team_size integer default null,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.tournaments (
    organizer_user_id, name, course_name, tournament_date,
    hole_count, scoring_format, team_size, status, description
  )
  values (
    auth.uid(), p_name, p_course_name, p_tournament_date,
    coalesce(p_hole_count, 18), p_scoring_format, p_team_size, 'draft', p_description
  )
  returning id into v_tournament_id;

  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values (v_tournament_id, auth.uid(), 'accepted', true);

  return v_tournament_id;
end;
$$;

revoke execute on function public.cancel_tournament_invitation(uuid) from public;
grant execute on function public.cancel_tournament_invitation(uuid) to authenticated;

revoke execute on function public.remove_tournament_player(uuid) from public;
grant execute on function public.remove_tournament_player(uuid) to authenticated;

revoke execute on function public.invite_player(uuid, uuid) from public;
grant execute on function public.invite_player(uuid, uuid) to authenticated;

revoke execute on function public.create_tournament(text, text, date, integer, text, integer, text) from public;
grant execute on function public.create_tournament(text, text, date, integer, text, integer, text) to authenticated;
