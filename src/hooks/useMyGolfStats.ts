import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/useAuth';
import type { MyGolfStats } from '../types/database';

export function useMyGolfStats() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-golf-stats', user?.id],
    queryFn: async (): Promise<MyGolfStats> => {
      const { data, error } = await supabase.rpc('get_my_golf_stats');
      if (error) throw error;
      return data as MyGolfStats;
    },
    enabled: !!user,
  });
}
