import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import type { InvitationStatus } from '../types/database';

export interface RosterPlayer {
  playerId: string;
  userId: string;
  name: string;
  username: string;
  teamId: string | null;
  isOrganizer: boolean;
  joinedAt: string;
}

export interface RosterInvitation {
  id: string;
  invitedUserId: string;
  name: string;
  username: string;
  status: InvitationStatus;
  createdAt: string;
  respondedAt: string | null;
}

export interface RosterTeam {
  id: string;
  name: string | null;
  teamNumber: number | null;
}

export interface TournamentRoster {
  players: RosterPlayer[];
  invitations: RosterInvitation[];
  teams: RosterTeam[];
}

async function fetchRoster(tournamentId: string): Promise<TournamentRoster> {
  const [playersResult, invitationsResult, teamsResult] = await Promise.all([
    supabase
      .from('tournament_players')
      .select('id, user_id, team_id, is_organizer, joined_at')
      .eq('tournament_id', tournamentId),
    supabase
      .from('tournament_invitations')
      .select('id, invited_user_id, status, created_at, responded_at')
      .eq('tournament_id', tournamentId),
    supabase
      .from('tournament_teams')
      .select('id, name, team_number')
      .eq('tournament_id', tournamentId)
      .order('team_number', { ascending: true }),
  ]);

  if (playersResult.error) throw playersResult.error;
  if (invitationsResult.error) throw invitationsResult.error;
  if (teamsResult.error) throw teamsResult.error;

  const players = playersResult.data ?? [];
  const invitations = invitationsResult.data ?? [];
  const teams = teamsResult.data ?? [];

  const userIds = [...new Set([...players.map((p) => p.user_id), ...invitations.map((i) => i.invited_user_id)])];

  const { data: profiles, error: profilesError } =
    userIds.length > 0
      ? await supabase.from('profiles').select('id, first_name, last_name, username').in('id', userIds)
      : { data: [] as { id: string; first_name: string; last_name: string; username: string }[], error: null };
  if (profilesError) throw profilesError;

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  return {
    players: players.map((player) => {
      const profile = profileById.get(player.user_id);
      return {
        playerId: player.id,
        userId: player.user_id,
        name: profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown player',
        username: profile?.username ?? '',
        teamId: player.team_id,
        isOrganizer: player.is_organizer,
        joinedAt: player.joined_at,
      };
    }),
    invitations: invitations.map((invitation) => {
      const profile = profileById.get(invitation.invited_user_id);
      return {
        id: invitation.id,
        invitedUserId: invitation.invited_user_id,
        name: profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown player',
        username: profile?.username ?? '',
        status: invitation.status as InvitationStatus,
        createdAt: invitation.created_at,
        respondedAt: invitation.responded_at,
      };
    }),
    teams: teams.map((team) => ({ id: team.id, name: team.name, teamNumber: team.team_number })),
  };
}

export function useTournamentRoster(tournamentId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['tournament-roster-full', tournamentId],
    queryFn: () => fetchRoster(tournamentId as string),
    enabled: enabled && !!tournamentId,
  });

  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: ['tournament-roster-full', tournamentId] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-readiness', tournamentId] });
  };

  return { ...query, refetch };
}
