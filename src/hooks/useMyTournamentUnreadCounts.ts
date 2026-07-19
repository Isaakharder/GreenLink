import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/useAuth';
import type { TournamentUnreadCount } from '../types/database';

/** Bulk unread chat counts across every live tournament the caller belongs to -- one query for the whole Tournaments list, no per-card realtime subscription. */
export function useMyTournamentUnreadCounts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-tournament-unread-counts', user?.id],
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase.rpc('get_my_tournament_unread_counts');
      if (error) throw error;
      return new Map((data as TournamentUnreadCount[]).map((row) => [row.tournament_id, row.unread_count]));
    },
    enabled: !!user,
  });
}
