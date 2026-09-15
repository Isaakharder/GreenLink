-- ============================================================================
-- Member directory (first version): lists every GreenLink user as a member.
-- No new membership concept or table -- profiles already is "every GreenLink
-- user" (one row per auth.users row, created on sign-up, see 0001) and that's
-- exactly what "for now, every existing legitimate GreenLink user is an
-- Active Member" means. A real membership-status/dues/renewal system can add
-- its own columns/table later without this RPC's shape needing to change for
-- callers that only ever wanted "name + rounds played".
--
-- profiles' own RLS policy (0001) only lets a user select their own row, so a
-- directory listing everyone needs a SECURITY DEFINER function -- the same
-- pattern search_profile_by_username() (0001) and search_courses() (0027)
-- already use to expose a deliberately narrow, safe field list rather than
-- widening table-level RLS. Only id/first_name/last_name are selected here;
-- email lives in auth.users (never joined), and profiles' own username/
-- photo_path/is_admin/created_at/updated_at columns are simply not selected.
-- id is returned only as an internal row identifier (React key) -- the
-- frontend never renders it.
--
-- completed_rounds_count: a tournament_players row (accepted, not removed)
-- joined to a tournaments row with status = 'completed'. This already counts
-- both real multiplayer tournaments and personal rounds identically --
-- start_personal_round() (0024) inserts the starter into tournament_players
-- exactly like create_tournament()/accept_invitation() do for a real
-- tournament, and a personal round is simply a tournaments row with
-- is_personal = true. Reusing that existing join is the "reliably calculated
-- from existing data" source the brief asked for, rather than inventing a
-- new rounds-played counter.
-- ============================================================================

create function public.list_members()
returns table (
  id uuid,
  first_name text,
  last_name text,
  completed_rounds_count integer
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
    coalesce(rc.completed_rounds_count, 0)::integer as completed_rounds_count
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
