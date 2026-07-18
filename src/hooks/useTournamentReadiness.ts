import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export interface InvalidTeam {
  team_id: string;
  name: string;
  required: number;
  actual: number;
}

export interface TournamentReadiness {
  details_complete: boolean;
  holes_required: number;
  holes_configured_count: number;
  holes_configured: boolean;
  accepted_player_count: number;
  min_players_met: boolean;
  unassigned_count: number;
  all_players_assigned: boolean;
  team_count: number;
  teams_created: boolean;
  invalid_teams: InvalidTeam[];
  team_sizes_valid: boolean;
  no_duplicate_assignments: boolean;
  ready: boolean;
}

export function useTournamentReadiness(tournamentId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['tournament-readiness', tournamentId],
    queryFn: async (): Promise<TournamentReadiness> => {
      const { data, error } = await supabase.rpc('get_tournament_readiness', {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw error;
      return data as TournamentReadiness;
    },
    enabled: enabled && !!tournamentId,
  });
}
