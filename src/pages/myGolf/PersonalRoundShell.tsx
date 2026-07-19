import { useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { useTournamentAccess } from '../../hooks/useTournamentAccess';
import { FinishRoundPanel } from './FinishRoundPanel';
import styles from './PersonalRoundShell.module.css';

/**
 * My Golf's analogue of TournamentDetail.tsx -- same useTournamentAccess
 * loading/offline/not-found handling, but a simple header instead of
 * TournamentTabBar (no teams/invitations/settings for a solo round). The
 * one child route renders the unmodified ScorecardTab directly via
 * <Outlet context={access} />, exactly as tournaments do.
 */
export function PersonalRoundShell() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const access = useTournamentAccess(tournamentId);
  const navigate = useNavigate();
  const [finishing, setFinishing] = useState(false);

  if (access.isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  if (access.neverCachedOffline) {
    return (
      <div className="page-status">
        <p>This round hasn't been opened on this device yet.</p>
        <p>Open it once while online before scoring offline.</p>
      </div>
    );
  }

  if (!access.tournament || !access.tournament.is_personal || !access.isOrganizer) {
    return (
      <div className="page-status">
        <p>Round not found.</p>
      </div>
    );
  }

  const { tournament } = access;

  return (
    <div>
      <div className={styles.header}>
        <p className={styles.courseName}>{tournament.course_name}</p>
        {tournament.status === 'live' && !finishing && (
          <button type="button" className="btn btn-primary btn-auto btn-small" onClick={() => setFinishing(true)}>
            Finish Round
          </button>
        )}
      </div>

      {access.fromCache && (
        <p className="empty-state" role="status">
          Offline — showing the last synced copy of this round.
        </p>
      )}

      <Outlet context={access} />

      {finishing && (
        <FinishRoundPanel
          access={access}
          onClose={() => setFinishing(false)}
          onFinished={() => navigate('/my-golf', { replace: true })}
        />
      )}
    </div>
  );
}
