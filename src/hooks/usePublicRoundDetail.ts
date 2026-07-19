import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import type { TeamHoleScore, Tournament, TournamentHole, TournamentTeam } from '../types/database';

export interface RoundDetail {
  tournament: Tournament;
  team: TournamentTeam;
  holes: TournamentHole[];
  scores: TeamHoleScore[];
  playerName: string;
  teeName: string | null;
}

/**
 * Fetches everything the read-only scorecard modal needs for one round --
 * a player's own round (any visibility) or someone else's public,
 * completed round. Both cases are plain RLS-gated reads (same shape as the
 * fetchTeams/fetchHoles/fetchScores helpers in useLeaderboardData.ts /
 * offlineDownload.ts): RLS returning zero rows for a round this viewer
 * can't see surfaces here as a query error, not a special code path.
 */
async function fetchRoundDetail(tournamentId: string): Promise<RoundDetail> {
  const [tournamentRes, teamsRes, holesRes, scoresRes] = await Promise.all([
    supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
    supabase.from('tournament_teams').select('*').eq('tournament_id', tournamentId),
    supabase.from('tournament_holes').select('*').eq('tournament_id', tournamentId).order('hole_number', { ascending: true }),
    supabase.from('team_hole_scores').select('*').eq('tournament_id', tournamentId),
  ]);

  if (tournamentRes.error) throw tournamentRes.error;
  if (teamsRes.error) throw teamsRes.error;
  if (holesRes.error) throw holesRes.error;
  if (scoresRes.error) throw scoresRes.error;

  const tournament = tournamentRes.data;
  const team = (teamsRes.data ?? [])[0];
  if (!team) throw new Error('This round has no scorecard yet.');

  const [profileRes, teeRes] = await Promise.all([
    supabase.from('profiles').select('first_name, last_name').eq('id', tournament.organizer_user_id).maybeSingle(),
    tournament.golf_course_tee_id
      ? supabase.from('golf_course_tees').select('tee_name').eq('id', tournament.golf_course_tee_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (profileRes.error) throw profileRes.error;

  return {
    tournament,
    team,
    holes: holesRes.data ?? [],
    scores: scoresRes.data ?? [],
    playerName: profileRes.data ? `${profileRes.data.first_name} ${profileRes.data.last_name}` : 'Unknown player',
    teeName: teeRes.data?.tee_name ?? null,
  };
}

export function usePublicRoundDetail(tournamentId: string | null) {
  return useQuery({
    queryKey: ['round-detail', tournamentId],
    queryFn: () => fetchRoundDetail(tournamentId as string),
    enabled: !!tournamentId,
  });
}
