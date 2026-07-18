create table public.tournament_players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  team_id uuid references public.tournament_teams (id) on delete set null,
  membership_status text not null default 'accepted'
    check (membership_status in ('accepted', 'removed')),
  is_organizer boolean not null default false,
  joined_at timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create index tournament_players_tournament_idx on public.tournament_players (tournament_id);
create index tournament_players_user_idx on public.tournament_players (user_id);
create index tournament_players_team_idx on public.tournament_players (team_id);

alter table public.tournament_players enable row level security;

-- Policies added in 0009_functions_and_policies.sql. All rows in this table
-- are created by SECURITY DEFINER functions (create_tournament, accept_invitation)
-- rather than direct client INSERTs, so no INSERT policy is granted to
-- authenticated users.
