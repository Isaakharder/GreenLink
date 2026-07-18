import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabaseClient';
import { useTournamentRoster } from '../../hooks/useTournamentRoster';
import { refreshIfDownloaded } from '../../lib/offlineDownload';
import { useAuth } from '../../auth/useAuth';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import { PlayersPanel } from './PlayersPanel';
import { TeamsPanel } from './TeamsPanel';
import styles from './TeamsTab.module.css';

interface TeamWithRoster {
  id: string;
  name: string | null;
  teamNumber: number | null;
  members: string[];
}

async function fetchTeams(tournamentId: string): Promise<TeamWithRoster[]> {
  const { data: teams, error } = await supabase
    .from('tournament_teams')
    .select('id, name, team_number')
    .eq('tournament_id', tournamentId)
    .order('team_number', { ascending: true });
  if (error) throw error;

  const { data: players, error: playersError } = await supabase
    .from('tournament_players')
    .select('team_id, user_id')
    .eq('tournament_id', tournamentId)
    .eq('membership_status', 'accepted')
    .not('team_id', 'is', null);
  if (playersError) throw playersError;

  const userIds = [...new Set((players ?? []).map((p) => p.user_id))];
  const { data: profiles, error: profilesError } =
    userIds.length > 0
      ? await supabase.from('profiles').select('id, first_name, last_name').in('id', userIds)
      : { data: [] as { id: string; first_name: string; last_name: string }[], error: null };
  if (profilesError) throw profilesError;

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  return (teams ?? []).map((team) => ({
    id: team.id,
    name: team.name,
    teamNumber: team.team_number,
    members: (players ?? [])
      .filter((player) => player.team_id === team.id)
      .map((player) => {
        const profile = profileById.get(player.user_id);
        return profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown player';
      }),
  }));
}

function ReadOnlyTeamsView({ tournamentId }: { tournamentId: string }) {
  const teamsQuery = useQuery({
    queryKey: ['tournament-teams', tournamentId],
    queryFn: () => fetchTeams(tournamentId),
    enabled: !!tournamentId,
  });

  if (teamsQuery.isLoading) {
    return <p className={styles.muted}>Loading teams…</p>;
  }

  if (!teamsQuery.data || teamsQuery.data.length === 0) {
    return <p className="empty-state">No teams have been created yet.</p>;
  }

  return (
    <div>
      {teamsQuery.data.map((team) => (
        <div key={team.id} className="card">
          <p className={styles.teamName}>{team.name ?? `Team ${team.teamNumber ?? ''}`}</p>
          {team.members.length > 0 ? (
            <ul className={styles.memberList}>
              {team.members.map((member) => (
                <li key={member}>{member}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>No players assigned yet.</p>
          )}
        </div>
      ))}
    </div>
  );
}

export function TeamsTab() {
  const { tournament, isOrganizer } = useOutletContext<TournamentAccess>();
  const { user } = useAuth();

  const isPreLive = tournament?.status === 'draft' || tournament?.status === 'upcoming';
  const roster = useTournamentRoster(tournament?.id, isOrganizer);

  if (!tournament) return null;

  if (!isOrganizer) {
    return <ReadOnlyTeamsView tournamentId={tournament.id} />;
  }

  if (roster.isLoading) {
    return <p className={styles.muted}>Loading roster…</p>;
  }

  if (roster.isError || !roster.data) {
    return <p className="error-text">Could not load the roster. Try again.</p>;
  }

  // Single choke point: every team/roster mutation in both panels calls
  // this same onChange prop, so wrapping it here is enough to keep an
  // already-downloaded offline copy fresh whenever the organizer changes
  // teams -- no per-mutation wiring needed inside the panels themselves.
  function handleRosterChange() {
    roster.refetch();
    if (user) void refreshIfDownloaded(tournament!.id, user.id);
  }

  return (
    <div>
      <PlayersPanel
        tournamentId={tournament.id}
        players={roster.data.players}
        invitations={roster.data.invitations}
        teams={roster.data.teams}
        isPreLive={isPreLive}
        onChange={handleRosterChange}
      />
      <TeamsPanel
        tournamentId={tournament.id}
        players={roster.data.players}
        teams={roster.data.teams}
        teamSize={tournament.team_size}
        isPreLive={isPreLive}
        onChange={handleRosterChange}
      />
    </div>
  );
}
