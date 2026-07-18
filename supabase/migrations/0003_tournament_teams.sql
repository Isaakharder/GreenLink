create table public.tournament_teams (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text,
  team_number integer,
  created_at timestamptz not null default now()
);

create index tournament_teams_tournament_idx on public.tournament_teams (tournament_id);

alter table public.tournament_teams enable row level security;

-- Policies added in 0009_functions_and_policies.sql.
