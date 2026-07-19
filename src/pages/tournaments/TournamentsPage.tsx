import { Link } from 'react-router-dom';
import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useTournamentLists, type PendingInvitation } from '../../hooks/useTournamentLists';
import { useMyTournamentUnreadCounts } from '../../hooks/useMyTournamentUnreadCounts';
import type { Tournament } from '../../types/database';
import styles from './TournamentsPage.module.css';

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function TournamentCard({ tournament, unreadCount = 0 }: { tournament: Tournament; unreadCount?: number }) {
  return (
    <Link to={`/tournaments/${tournament.id}/overview`} className={styles.card}>
      <div>
        <p className={styles.cardName}>
          {tournament.name}
          {unreadCount > 0 && (
            <span className={styles.unreadBadge} aria-label={`${unreadCount} unread chat message${unreadCount === 1 ? '' : 's'}`}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </p>
        <p className={styles.cardMeta}>
          {tournament.course_name} · {formatDate(tournament.tournament_date)}
        </p>
      </div>
      <span className={`${styles.statusBadge} ${styles[tournament.status] ?? ''}`}>{tournament.status}</span>
    </Link>
  );
}

function InvitationCard({
  invitation,
  onRespond,
}: {
  invitation: PendingInvitation;
  onRespond: () => void;
}) {
  const [submitting, setSubmitting] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(action: 'accept' | 'decline') {
    setSubmitting(action);
    setError(null);

    const { error: rpcError } = await supabase.rpc(
      action === 'accept' ? 'accept_invitation' : 'decline_invitation',
      { p_invitation_id: invitation.id },
    );

    setSubmitting(null);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    onRespond();
  }

  return (
    <div className={styles.invitationCard}>
      <div>
        <p className={styles.cardName}>{invitation.tournamentName}</p>
        <p className={styles.cardMeta}>
          {invitation.courseName} · {formatDate(invitation.tournamentDate)}
        </p>
        <p className={styles.cardMeta}>Invited by {invitation.invitedByName}</p>
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className={styles.invitationActions}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting !== null}
          onClick={() => respond('accept')}
        >
          {submitting === 'accept' ? 'Accepting…' : 'Accept'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={submitting !== null}
          onClick={() => respond('decline')}
        >
          {submitting === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>
    </div>
  );
}

export function TournamentsPage() {
  const { isLoading, invitations, active, upcoming, history, hasAnyRecords, refetch } = useTournamentLists();
  const unreadCounts = useMyTournamentUnreadCounts();

  if (isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  if (!hasAnyRecords) {
    return (
      <div>
        <h1>Tournaments</h1>
        <div className="empty-state">
          <p>No tournaments yet.</p>
        </div>
        <Link to="/tournaments/new" className="btn btn-primary">
          Create Tournament
        </Link>
        <p className={styles.waitNote}>Wait for an Invitation</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Tournaments</h1>

      <h2 className="section-title">Pending Invitations</h2>
      {invitations.length === 0 ? (
        <p className={styles.sectionEmpty}>No pending invitations.</p>
      ) : (
        invitations.map((invitation) => (
          <InvitationCard key={invitation.id} invitation={invitation} onRespond={refetch} />
        ))
      )}

      <h2 className="section-title">Active Tournaments</h2>
      {active.length === 0 ? (
        <p className={styles.sectionEmpty}>No active tournaments.</p>
      ) : (
        active.map((tournament) => (
          <TournamentCard key={tournament.id} tournament={tournament} unreadCount={unreadCounts.data?.get(tournament.id)} />
        ))
      )}

      <h2 className="section-title">Upcoming Tournaments</h2>
      {upcoming.length === 0 ? (
        <p className={styles.sectionEmpty}>No upcoming tournaments.</p>
      ) : (
        upcoming.map((tournament) => <TournamentCard key={tournament.id} tournament={tournament} />)
      )}

      <h2 className="section-title">Tournament History</h2>
      {history.length === 0 ? (
        <p className={styles.sectionEmpty}>No tournament history.</p>
      ) : (
        history.map((tournament) => <TournamentCard key={tournament.id} tournament={tournament} />)
      )}

      <Link to="/tournaments/new" className={`btn btn-primary ${styles.createButton}`}>
        Create Tournament
      </Link>
    </div>
  );
}
