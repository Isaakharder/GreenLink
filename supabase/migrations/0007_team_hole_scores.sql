create table public.team_hole_scores (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  team_id uuid not null references public.tournament_teams (id) on delete cascade,
  hole_number integer not null,
  strokes integer not null,
  revision integer not null default 1,
  last_updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tournament_id, team_id, hole_number)
);

create index team_hole_scores_tournament_idx on public.team_hole_scores (tournament_id);
create index team_hole_scores_team_idx on public.team_hole_scores (team_id);

alter table public.team_hole_scores enable row level security;

-- Writes only ever happen inside the submit_team_score() / correct_team_score()
-- SECURITY DEFINER functions (0010_score_functions.sql), which run as the table
-- owner and therefore bypass RLS while enforcing the real business rules
-- (own team + tournament must be live, or organizer + mandatory reason).
-- Regular authenticated users get a SELECT-only policy.
