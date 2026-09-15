-- ============================================================================
-- Adds username to list_members() (0032, 0033 -- already applied) so the
-- new Teams-tab "Invite Members" list can discover and invite any GreenLink
-- member without a username-search round trip first, while still displaying
-- the @username identity the invitation system's UI already shows elsewhere
-- (PlayersPanel's Accepted/Pending/Declined rows).
--
-- Not a new privacy exposure: username is already deliberately searchable by
-- any authenticated user via search_profile_by_username() (0001), and its
-- availability is even checkable anonymously via is_username_available()
-- (0001) -- unlike email/auth data, it was never meant to be private. Every
-- other field, the SECURITY DEFINER architecture, the fixed search_path, and
-- the authenticated-only grant are all unchanged from 0033.
--
-- Column set changes, so drop-then-create (per the 0019 postmortem this
-- codebase already documents) rather than create-or-replace.
-- ============================================================================

drop function if exists public.list_members();

create function public.list_members()
returns table (
  id uuid,
  first_name text,
  last_name text,
  username text,
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
  order by p.first_name, p.last_name;
$$;

revoke execute on function public.list_members() from public;
grant execute on function public.list_members() to authenticated;
