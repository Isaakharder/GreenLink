import { Outlet, useParams } from 'react-router-dom';
import { useTournamentAccess } from '../../hooks/useTournamentAccess';
import { TournamentTabBar } from '../../components/TournamentTabBar';
import { TournamentChat } from '../../components/chat/TournamentChat';

export function TournamentDetail() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const access = useTournamentAccess(tournamentId);

  if (access.isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  if (access.neverCachedOffline) {
    return (
      <div className="page-status">
        <p>This tournament hasn't been opened on this device yet.</p>
        <p>Open it once while online before scoring offline.</p>
      </div>
    );
  }

  // RLS returns zero rows for a tournament the user cannot access, so a
  // guessed/unknown UUID lands here rather than leaking any tournament data.
  if (!access.tournament || !(access.isAcceptedMember || access.isOrganizer)) {
    return (
      <div className="page-status">
        <p>Tournament not found.</p>
        <p>You may not have access to this tournament, or the link is incorrect.</p>
      </div>
    );
  }

  return (
    <div>
      {access.fromCache && (
        <p className="empty-state" role="status">
          Offline — showing the last synced copy of this tournament.
        </p>
      )}
      <TournamentTabBar
        basePath={`/tournaments/${tournamentId}`}
        canViewLiveScore={access.canViewLiveScore}
        showSettings={access.isOrganizer}
      />
      <Outlet context={access} />
      <TournamentChat access={access} />
    </div>
  );
}
