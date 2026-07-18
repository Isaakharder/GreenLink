create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  organizer_user_id uuid not null references public.profiles (id),
  name text not null,
  course_name text not null,
  tournament_date date not null,
  hole_count integer not null default 18,
  scoring_format text,
  team_size integer,
  status text not null default 'draft'
    check (status in ('draft', 'upcoming', 'live', 'completed', 'cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tournaments_organizer_idx on public.tournaments (organizer_user_id);
create index tournaments_status_idx on public.tournaments (status);

alter table public.tournaments enable row level security;

create trigger tournaments_set_updated_at
  before update on public.tournaments
  for each row
  execute function public.set_updated_at();

-- RLS policies for this table are created in 0009_functions_and_policies.sql,
-- once the membership helper functions and tournament_players table exist.
-- Until then RLS is enabled with zero policies, so the table is inaccessible
-- to anon/authenticated roles (service_role and table owner are unaffected).
