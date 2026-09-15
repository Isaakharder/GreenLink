-- ============================================================================
-- Adds member_since to list_members() (0032, already applied) so the
-- directory can show how long someone has been a GreenLink member --
-- profiles.created_at (stamped once, at sign-up, never updated) is exactly
-- that date; no new column needed. Column set changes, so drop-then-create
-- (per the 0019 postmortem this codebase already documents) rather than
-- create-or-replace.
-- ============================================================================

drop function if exists public.list_members();

create function public.list_members()
returns table (
  id uuid,
  first_name text,
  last_name text,
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
