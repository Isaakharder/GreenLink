create table public.tournament_holes (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  hole_number integer not null,
  par integer not null,
  stroke_index integer,
  distance integer,
  unique (tournament_id, hole_number)
);

create index tournament_holes_tournament_idx on public.tournament_holes (tournament_id);

alter table public.tournament_holes enable row level security;

-- Policies added in 0009_functions_and_policies.sql.
