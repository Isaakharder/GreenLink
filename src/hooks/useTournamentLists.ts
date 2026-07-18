import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/useAuth';
import type { Tournament } from '../types/database';

export interface PendingInvitation {
  id: string;
  tournamentId: string;
  tournamentName: string;
  courseName: string;
  tournamentDate: string;
  invitedByName: string;
  createdAt: string;
}

async function fetchTournaments(): Promise<Tournament[]> {
  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .order('tournament_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchPendingInvitations(userId: string): Promise<PendingInvitation[]> {
  const { data: invitations, error } = await supabase
    .from('tournament_invitations')
    .select('id, tournament_id, invited_by_user_id, created_at')
    .eq('invited_user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!invitations || invitations.length === 0) return [];

  const tournamentIds = [...new Set(invitations.map((i) => i.tournament_id))];
  const inviterIds = [...new Set(invitations.map((i) => i.invited_by_user_id))];

  const [{ data: tournaments, error: tournamentsError }, { data: inviters, error: invitersError }] =
    await Promise.all([
      supabase.from('tournaments').select('id, name, course_name, tournament_date').in('id', tournamentIds),
      supabase.from('profiles').select('id, first_name, last_name').in('id', inviterIds),
    ]);
  if (tournamentsError) throw tournamentsError;
  if (invitersError) throw invitersError;

  const tournamentById = new Map((tournaments ?? []).map((t) => [t.id, t]));
  const inviterById = new Map((inviters ?? []).map((p) => [p.id, p]));

  return invitations.map((invitation) => {
    const tournament = tournamentById.get(invitation.tournament_id);
    const inviter = inviterById.get(invitation.invited_by_user_id);
    return {
      id: invitation.id,
      tournamentId: invitation.tournament_id,
      tournamentName: tournament?.name ?? 'Unknown tournament',
      courseName: tournament?.course_name ?? '',
      tournamentDate: tournament?.tournament_date ?? '',
      invitedByName: inviter ? `${inviter.first_name} ${inviter.last_name}` : 'Someone',
      createdAt: invitation.created_at,
    };
  });
}

export function useTournamentLists() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const tournamentsQuery = useQuery({
    queryKey: ['tournaments', user?.id],
    queryFn: fetchTournaments,
    enabled: !!user,
  });

  const invitationsQuery = useQuery({
    queryKey: ['pending-invitations', user?.id],
    queryFn: () => fetchPendingInvitations(user!.id),
    enabled: !!user,
  });

  const tournaments = tournamentsQuery.data ?? [];
  const invitations = invitationsQuery.data ?? [];

  const active = tournaments.filter((t) => t.status === 'live');
  const upcoming = tournaments.filter((t) => t.status === 'draft' || t.status === 'upcoming');
  const history = tournaments.filter((t) => t.status === 'completed' || t.status === 'cancelled');

  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: ['tournaments', user?.id] });
    void queryClient.invalidateQueries({ queryKey: ['pending-invitations', user?.id] });
  };

  return {
    isLoading: tournamentsQuery.isLoading || invitationsQuery.isLoading,
    isError: tournamentsQuery.isError || invitationsQuery.isError,
    invitations,
    active,
    upcoming,
    history,
    hasAnyRecords: tournaments.length > 0 || invitations.length > 0,
    refetch,
  };
}
