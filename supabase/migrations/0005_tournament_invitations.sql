create table public.tournament_invitations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  invited_user_id uuid not null references public.profiles (id),
  invited_by_user_id uuid not null references public.profiles (id),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tournament_id, invited_user_id)
);

create index tournament_invitations_invited_user_idx on public.tournament_invitations (invited_user_id);
create index tournament_invitations_tournament_idx on public.tournament_invitations (tournament_id);

alter table public.tournament_invitations enable row level security;

-- Policies added in 0009_functions_and_policies.sql. Rows are created via the
-- invite_player() function and mutated via accept_invitation()/decline_invitation(),
-- all SECURITY DEFINER, so no direct INSERT/UPDATE policy is granted.
