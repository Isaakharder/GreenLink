-- ============================================================================
-- Membership lifecycle (Active / Inactive) and Admin -> Manage Members.
--
-- Adds profiles.membership_status so a former member can be hidden from the
-- directory and made ineligible for new invitations without touching a
-- single historical row -- every FK from tournaments/players/scores/chat/
-- courses back to profiles(id) is ON DELETE NO ACTION (see the investigation
-- ahead of this migration), so nothing here is required for history safety;
-- this column only changes what's *shown going forward*, never what's
-- stored. Also adds the admin RPC surface (list/detail, activate/
-- deactivate, permanent delete) and updates invite_player()/list_members()
-- to respect the new status.
--
-- Security convention (established in 0036): every new RPC below revokes
-- EXECUTE from PUBLIC and anon, grants only to authenticated, and -- because
-- an EXECUTE grant alone is not authorization -- every admin_* function
-- re-checks public.is_admin() as its very first statement and raises if the
-- caller isn't one. UI visibility of the Admin section is convenience only;
-- these checks are what actually enforce it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) profiles.membership_status. Existing rows default to 'active' via the
--    column default applied at add-time -- nobody's visibility changes.
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column membership_status text not null default 'active'
    check (membership_status in ('active', 'inactive'));

-- ----------------------------------------------------------------------------
-- 2) list_members(): the normal member directory now excludes inactive
--    members. Column set is unchanged from 0035 -- same drop+create pattern
--    this function has always used, kept for consistency even though the
--    shape didn't change this time.
-- ----------------------------------------------------------------------------

drop function if exists public.list_members();

create function public.list_members()
returns table (
  id uuid,
  first_name text,
  last_name text,
  username text,
  photo_path text,
  completed_rounds_count integer,
  member_since timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id,
    p.first_name,
    p.last_name,
    p.username,
    p.photo_path,
    coalesce(rc.completed_rounds_count, 0)::integer as completed_rounds_count,
    p.created_at as member_since
  from public.profiles p
  left join lateral (
    select count(distinct tp.tournament_id) as completed_rounds_count
    from public.tournament_players tp
    join public.tournaments t on t.id = tp.tournament_id
    where tp.user_id = p.id
      and tp.membership_status = 'accepted'
      and t.status = 'completed'
  ) rc on true
  where p.membership_status = 'active'
  order by p.first_name, p.last_name;
$$;

revoke execute on function public.list_members() from public;
grant execute on function public.list_members() to authenticated;

-- ----------------------------------------------------------------------------
-- 3) invite_player(): reject inviting an inactive/former member. Same
--    signature as 0014 -- create or replace, matching how this function has
--    always been revised in place.
-- ----------------------------------------------------------------------------

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
  v_invited_membership_status text;
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

  select membership_status into v_invited_membership_status
  from public.profiles
  where id = p_invited_user_id;

  if v_invited_membership_status is null then
    raise exception 'player not found';
  end if;
  if v_invited_membership_status <> 'active' then
    raise exception 'this member is no longer active and cannot be invited';
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

revoke execute on function public.invite_player(uuid, uuid) from public;
grant execute on function public.invite_player(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) admin_list_members(): every member (active + inactive), with the
--    membership/admin fields an administrator needs. Deliberately excludes
--    email -- the standing rule from the member-directory feature is that
--    email is account-only, and nothing about admin member management
--    requires changing that.
-- ----------------------------------------------------------------------------

create function public.admin_list_members()
returns table (
  id uuid,
  first_name text,
  last_name text,
  username text,
  photo_path text,
  membership_status text,
  is_admin boolean,
  completed_rounds_count integer,
  member_since timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin access required';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.username,
      p.photo_path,
      p.membership_status,
      p.is_admin,
      coalesce(rc.completed_rounds_count, 0)::integer as completed_rounds_count,
      p.created_at as member_since
    from public.profiles p
    left join lateral (
      select count(distinct tp.tournament_id) as completed_rounds_count
      from public.tournament_players tp
      join public.tournaments t on t.id = tp.tournament_id
      where tp.user_id = p.id
        and tp.membership_status = 'accepted'
        and t.status = 'completed'
    ) rc on true
    order by p.membership_status, p.first_name, p.last_name;
end;
$$;

revoke execute on function public.admin_list_members() from public, anon;
grant execute on function public.admin_list_members() to authenticated;

-- ----------------------------------------------------------------------------
-- 5) admin_set_member_status(): activate/deactivate. Guards: an admin can't
--    deactivate themselves, and deactivating the last remaining active
--    admin is refused regardless of who's doing it.
-- ----------------------------------------------------------------------------

create function public.admin_set_member_status(p_user_id uuid, p_status text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.profiles;
  v_target_is_admin boolean;
  v_other_active_admin_count integer;
begin
  if not public.is_admin() then
    raise exception 'admin access required';
  end if;

  if p_status not in ('active', 'inactive') then
    raise exception 'status must be ''active'' or ''inactive''';
  end if;

  if p_user_id = auth.uid() and p_status = 'inactive' then
    raise exception 'you cannot deactivate your own account';
  end if;

  select is_admin into v_target_is_admin from public.profiles where id = p_user_id;
  if v_target_is_admin is null then
    raise exception 'member not found';
  end if;

  if p_status = 'inactive' and v_target_is_admin then
    select count(*) into v_other_active_admin_count
    from public.profiles
    where is_admin and membership_status = 'active' and id <> p_user_id;

    if v_other_active_admin_count = 0 then
      raise exception 'cannot deactivate the last active administrator';
    end if;
  end if;

  update public.profiles
  set membership_status = p_status
  where id = p_user_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.admin_set_member_status(uuid, text) from public, anon;
grant execute on function public.admin_set_member_status(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6) admin_permanently_delete_member(): the destructive path, built
--    deliberately conservative -- see the investigation this migration
--    follows. Refuses outright (with a specific, useful reason) if the
--    target has ever organized or played in a tournament: that guarantees
--    every other NO ACTION-guarded reference (team_hole_scores.
--    last_updated_by, score_operations.changed_by, tournament_chat_reads.
--    user_id, tournament_messages.sender_user_id/deleted_by,
--    tournament_lifecycle_events.performed_by) is empty too, since every one
--    of those can only ever be written by someone who was already an
--    organizer or accepted tournament_players member when they wrote it.
--    What's left to clean up is genuinely low-stakes: pending/past
--    invitation rows (workflow state, not a result) and golf_courses
--    provenance columns (course *data* is never touched or removed, only
--    who's on record as having created/imported/last-updated it).
--
--    Verified locally before writing this: a SECURITY DEFINER function
--    owned by `postgres` (the role every migration and RPC in this project
--    is created as) can DELETE FROM auth.users directly when invoked by an
--    `authenticated` caller -- `postgres` holds DELETE on auth.users in this
--    project's role setup (authenticated/anon/service_role do not), and
--    SECURITY DEFINER makes the function run with the *owner's* privileges,
--    not the caller's. profiles.id already has `on delete cascade` from
--    auth.users (0001), so deleting the auth user is sufficient -- no
--    separate profiles delete, and no service-role credential anywhere
--    near the client. The avatars Storage object is removed the same way:
--    a direct DELETE against storage.objects (it's an ordinary Postgres
--    table under a `postgres`-accessible schema), not a Storage API call --
--    wrapped so a failure there never blocks the rest of the deletion.
-- ----------------------------------------------------------------------------

create function public.admin_permanently_delete_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_is_admin boolean;
  v_organized_count integer;
  v_played_count integer;
  v_other_active_admin_count integer;
begin
  if not public.is_admin() then
    raise exception 'admin access required';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'you cannot permanently delete your own account';
  end if;

  select is_admin into v_target_is_admin from public.profiles where id = p_user_id;
  if v_target_is_admin is null then
    raise exception 'member not found';
  end if;

  if v_target_is_admin then
    select count(*) into v_other_active_admin_count
    from public.profiles
    where is_admin and membership_status = 'active' and id <> p_user_id;

    if v_other_active_admin_count = 0 then
      raise exception 'cannot permanently delete the last active administrator';
    end if;
  end if;

  select count(*) into v_organized_count from public.tournaments where organizer_user_id = p_user_id;
  select count(*) into v_played_count from public.tournament_players where user_id = p_user_id;

  if v_organized_count > 0 or v_played_count > 0 then
    raise exception
      'cannot permanently delete this member: they organize % tournament(s) and have % tournament roster entr(y/ies). Remove or reassign those first, or use Deactivate instead to preserve history.',
      v_organized_count, v_played_count;
  end if;

  -- Low-stakes cleanup: workflow state, not results.
  delete from public.tournament_invitations
  where invited_user_id = p_user_id or invited_by_user_id = p_user_id;

  -- Course provenance: the course data itself is never touched, only who's
  -- on record for it. created_by/updated_by are nullable; imported_by is
  -- NOT NULL and must be reassigned rather than cleared -- attributed to
  -- the admin performing this deletion.
  update public.golf_courses set created_by = null where created_by = p_user_id;
  update public.golf_courses set updated_by = null where updated_by = p_user_id;
  update public.golf_courses set imported_by = auth.uid() where imported_by = p_user_id;

  -- Best-effort avatar cleanup -- never blocks account deletion.
  begin
    delete from storage.objects
    where bucket_id = 'avatars' and name = p_user_id::text || '/avatar.webp';
  exception when others then
    null;
  end;

  -- Cascades to public.profiles via profiles.id references auth.users(id)
  -- on delete cascade (0001).
  delete from auth.users where id = p_user_id;
end;
$$;

revoke execute on function public.admin_permanently_delete_member(uuid) from public, anon;
grant execute on function public.admin_permanently_delete_member(uuid) to authenticated;
