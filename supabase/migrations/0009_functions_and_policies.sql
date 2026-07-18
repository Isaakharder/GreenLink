-- ============================================================================
-- Membership helper functions
--
-- SECURITY DEFINER + owned by the migration role (table owner), so these
-- bypass RLS internally while still checking auth.uid() explicitly. This is
-- the standard way to avoid recursive-policy problems: policies below call
-- these functions instead of embedding cross-table subqueries directly.
-- ============================================================================

create function public.is_tournament_member(p_tournament_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.tournament_players
    where tournament_id = p_tournament_id
      and user_id = auth.uid()
      and membership_status = 'accepted'
  );
$$;

create function public.is_tournament_organizer(p_tournament_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.tournaments
    where id = p_tournament_id
      and organizer_user_id = auth.uid()
  );
$$;

create function public.is_team_member(p_tournament_id uuid, p_team_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.tournament_players
    where tournament_id = p_tournament_id
      and team_id = p_team_id
      and user_id = auth.uid()
      and membership_status = 'accepted'
  );
$$;

grant execute on function public.is_tournament_member(uuid) to authenticated;
grant execute on function public.is_tournament_organizer(uuid) to authenticated;
grant execute on function public.is_team_member(uuid, uuid) to authenticated;

-- ============================================================================
-- profiles: extend visibility to fellow accepted members of a shared
-- tournament (needed to show organizer/roster names on Overview & Teams).
-- Still no policy exposes email or lets anyone browse the whole table.
-- ============================================================================

create policy "profiles_select_tournament_co_members"
  on public.profiles for select
  to authenticated
  using (
    exists (
      select 1
      from public.tournament_players tp1
      join public.tournament_players tp2 on tp2.tournament_id = tp1.tournament_id
      where tp1.user_id = auth.uid()
        and tp1.membership_status = 'accepted'
        and tp2.user_id = profiles.id
        and tp2.membership_status = 'accepted'
    )
  );

create policy "profiles_select_invitation_parties"
  on public.profiles for select
  to authenticated
  using (
    exists (
      select 1 from public.tournament_invitations
      where status = 'pending'
        and (
          (invited_user_id = auth.uid() and invited_by_user_id = profiles.id)
          or (invited_by_user_id = auth.uid() and invited_user_id = profiles.id)
        )
    )
  );

-- ============================================================================
-- tournaments
-- ============================================================================

create policy "tournaments_select_members"
  on public.tournaments for select
  to authenticated
  using (
    public.is_tournament_member(id)
    or organizer_user_id = auth.uid()
    or exists (
      select 1 from public.tournament_invitations
      where tournament_id = tournaments.id
        and invited_user_id = auth.uid()
        and status = 'pending'
    )
  );

create policy "tournaments_update_organizer"
  on public.tournaments for update
  to authenticated
  using (organizer_user_id = auth.uid())
  with check (organizer_user_id = auth.uid());

-- No direct INSERT policy: tournaments are created via create_tournament()
-- below, which atomically also creates the organizer's membership row.

-- ============================================================================
-- tournament_teams
-- ============================================================================

create policy "tournament_teams_select_members"
  on public.tournament_teams for select
  to authenticated
  using (public.is_tournament_member(tournament_id) or public.is_tournament_organizer(tournament_id));

create policy "tournament_teams_insert_organizer"
  on public.tournament_teams for insert
  to authenticated
  with check (public.is_tournament_organizer(tournament_id));

create policy "tournament_teams_update_organizer"
  on public.tournament_teams for update
  to authenticated
  using (public.is_tournament_organizer(tournament_id))
  with check (public.is_tournament_organizer(tournament_id));

create policy "tournament_teams_delete_organizer"
  on public.tournament_teams for delete
  to authenticated
  using (public.is_tournament_organizer(tournament_id));

-- ============================================================================
-- tournament_players
-- ============================================================================

create policy "tournament_players_select"
  on public.tournament_players for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_tournament_member(tournament_id)
    or public.is_tournament_organizer(tournament_id)
  );

create policy "tournament_players_update_organizer"
  on public.tournament_players for update
  to authenticated
  using (public.is_tournament_organizer(tournament_id))
  with check (public.is_tournament_organizer(tournament_id));

create policy "tournament_players_delete_organizer"
  on public.tournament_players for delete
  to authenticated
  using (public.is_tournament_organizer(tournament_id));

-- No direct INSERT policy: rows are created by create_tournament() (organizer)
-- and accept_invitation() (invitee) below.

-- ============================================================================
-- tournament_invitations
-- ============================================================================

create policy "tournament_invitations_select"
  on public.tournament_invitations for select
  to authenticated
  using (invited_user_id = auth.uid() or public.is_tournament_organizer(tournament_id));

-- No direct INSERT/UPDATE policy: rows are created by invite_player() and
-- mutated by accept_invitation()/decline_invitation() below.

-- ============================================================================
-- tournament_holes
-- ============================================================================

create policy "tournament_holes_select_members"
  on public.tournament_holes for select
  to authenticated
  using (public.is_tournament_member(tournament_id) or public.is_tournament_organizer(tournament_id));

create policy "tournament_holes_insert_organizer"
  on public.tournament_holes for insert
  to authenticated
  with check (public.is_tournament_organizer(tournament_id));

create policy "tournament_holes_update_organizer"
  on public.tournament_holes for update
  to authenticated
  using (public.is_tournament_organizer(tournament_id))
  with check (public.is_tournament_organizer(tournament_id));

create policy "tournament_holes_delete_organizer"
  on public.tournament_holes for delete
  to authenticated
  using (public.is_tournament_organizer(tournament_id));

-- ============================================================================
-- create_tournament(): organizer creates a tournament and is atomically
-- enrolled as its accepted, organizer member.
-- ============================================================================

create function public.create_tournament(
  p_name text,
  p_course_name text,
  p_tournament_date date,
  p_hole_count integer default 18,
  p_scoring_format text default null,
  p_team_size integer default null
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
    hole_count, scoring_format, team_size, status
  )
  values (
    auth.uid(), p_name, p_course_name, p_tournament_date,
    coalesce(p_hole_count, 18), p_scoring_format, p_team_size, 'upcoming'
  )
  returning id into v_tournament_id;

  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values (v_tournament_id, auth.uid(), 'accepted', true);

  return v_tournament_id;
end;
$$;

grant execute on function public.create_tournament(text, text, date, integer, text, integer) to authenticated;

-- ============================================================================
-- invite_player(): organizer invites a profile (found via
-- search_profile_by_username) into their tournament.
-- ============================================================================

create function public.invite_player(p_tournament_id uuid, p_invited_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not public.is_tournament_organizer(p_tournament_id) then
    raise exception 'only the tournament organizer can invite players';
  end if;

  if exists (
    select 1 from public.tournament_players
    where tournament_id = p_tournament_id and user_id = p_invited_user_id
  ) then
    raise exception 'player is already a member of this tournament';
  end if;

  insert into public.tournament_invitations (tournament_id, invited_user_id, invited_by_user_id)
  values (p_tournament_id, p_invited_user_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
exception
  when unique_violation then
    raise exception 'player has already been invited to this tournament';
end;
$$;

grant execute on function public.invite_player(uuid, uuid) to authenticated;

-- ============================================================================
-- accept_invitation() / decline_invitation(): invitee responds; accepting
-- atomically creates the tournament_players membership row.
-- ============================================================================

create function public.accept_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_invited_user_id uuid;
  v_status text;
begin
  select tournament_id, invited_user_id, status
    into v_tournament_id, v_invited_user_id, v_status
  from public.tournament_invitations
  where id = p_invitation_id
  for update;

  if v_invited_user_id is null then
    raise exception 'invitation not found';
  end if;

  if v_invited_user_id <> auth.uid() then
    raise exception 'this invitation does not belong to the current user';
  end if;

  if v_status <> 'pending' then
    raise exception 'invitation has already been responded to';
  end if;

  update public.tournament_invitations
  set status = 'accepted', responded_at = now()
  where id = p_invitation_id;

  insert into public.tournament_players (tournament_id, user_id, membership_status, is_organizer)
  values (v_tournament_id, auth.uid(), 'accepted', false)
  on conflict (tournament_id, user_id) do nothing;
end;
$$;

grant execute on function public.accept_invitation(uuid) to authenticated;

create function public.decline_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invited_user_id uuid;
  v_status text;
begin
  select invited_user_id, status into v_invited_user_id, v_status
  from public.tournament_invitations
  where id = p_invitation_id
  for update;

  if v_invited_user_id is null then
    raise exception 'invitation not found';
  end if;

  if v_invited_user_id <> auth.uid() then
    raise exception 'this invitation does not belong to the current user';
  end if;

  if v_status <> 'pending' then
    raise exception 'invitation has already been responded to';
  end if;

  update public.tournament_invitations
  set status = 'declined', responded_at = now()
  where id = p_invitation_id;
end;
$$;

grant execute on function public.decline_invitation(uuid) to authenticated;
