-- Enable Realtime change notifications for live score updates. Row visibility
-- for these events is still governed by the SELECT policies above, so
-- non-members do not receive updates for tournaments they cannot read.
alter publication supabase_realtime add table public.team_hole_scores;
alter publication supabase_realtime add table public.tournaments;
