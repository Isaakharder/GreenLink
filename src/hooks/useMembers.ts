import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import type { Member } from '../types/database';

/** Member directory (Home -> Members): every GreenLink user, via one RPC (list_members) rather than a direct profiles select -- profiles' RLS only allows selecting your own row. */
export function useMembers() {
  return useQuery({
    queryKey: ['members'],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await supabase.rpc('list_members');
      if (error) throw error;
      return data ?? [];
    },
  });
}
