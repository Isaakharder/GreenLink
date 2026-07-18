import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import type { TournamentProgress } from '../types/database';

export function useTournamentProgress(tournamentId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['tournament-progress', tournamentId],
    queryFn: async (): Promise<TournamentProgress> => {
      const { data, error } = await supabase.rpc('get_tournament_progress', {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw error;
      return data as TournamentProgress;
    },
    enabled: enabled && !!tournamentId,
  });
}
