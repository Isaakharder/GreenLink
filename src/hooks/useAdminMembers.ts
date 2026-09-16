import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import type { AdminMember, ProfileMembershipStatus } from '../types/database';

async function fetchAdminMembers(): Promise<AdminMember[]> {
  const { data, error } = await supabase.rpc('admin_list_members');
  if (error) throw error;
  return data ?? [];
}

export function useAdminMembers() {
  return useQuery({
    queryKey: ['admin-members'],
    queryFn: fetchAdminMembers,
  });
}

function invalidateAfterMemberChange(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin-members'] }),
    queryClient.invalidateQueries({ queryKey: ['members'] }),
    queryClient.invalidateQueries({ queryKey: ['profile'] }),
  ]);
}

export function useSetMemberStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, status }: { userId: string; status: ProfileMembershipStatus }) => {
      const { error } = await supabase.rpc('admin_set_member_status', { p_user_id: userId, p_status: status });
      if (error) throw error;
    },
    onSuccess: () => invalidateAfterMemberChange(queryClient),
  });
}

export function usePermanentlyDeleteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc('admin_permanently_delete_member', { p_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAfterMemberChange(queryClient),
  });
}
