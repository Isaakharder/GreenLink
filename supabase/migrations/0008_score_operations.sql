-- Audit history and idempotency record for offline score synchronization.
-- Each row is one attempted change; operation_uuid lets the offline queue
-- resend an operation safely without creating a duplicate effect.
create table public.score_operations (
  id uuid primary key default gen_random_uuid(),
  operation_uuid uuid unique not null,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  team_id uuid not null references public.tournament_teams (id) on delete cascade,
  hole_number integer not null,
  previous_strokes integer,
  new_strokes integer not null,
  revision integer not null,
  changed_by uuid not null references public.profiles (id),
  device_timestamp timestamptz,
  server_timestamp timestamptz not null default now(),
  change_reason text
);

create index score_operations_tournament_idx on public.score_operations (tournament_id);
create index score_operations_team_hole_idx on public.score_operations (tournament_id, team_id, hole_number);

alter table public.score_operations enable row level security;

-- Rows are only ever inserted from inside submit_team_score()/correct_team_score()
-- (SECURITY DEFINER, bypasses RLS). Regular authenticated users get SELECT only.
