import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import type { PublicRoundFeedItem } from '../types/database';

const FEED_LIMIT = 30;

/** Home page Community Feed: every public, completed personal round, newest-finished first. Backed by one aggregating RPC (get_public_round_feed) rather than N+1 client fetches. */
export function usePublicRoundFeed() {
  return useQuery({
    queryKey: ['public-round-feed'],
    queryFn: async (): Promise<PublicRoundFeedItem[]> => {
      const { data, error } = await supabase.rpc('get_public_round_feed', { p_limit: FEED_LIMIT });
      if (error) throw error;
      return data ?? [];
    },
  });
}
