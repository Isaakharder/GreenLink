import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabaseClient';
import { formatRelativeTime } from '../../lib/relativeTime';
import { formatRelativeToPar } from '../../lib/leaderboard';
import { LIVE_SCORE_DISABLED_TEXT } from '../../lib/copy';
import { useLeaderboardData, type LiveStatus } from '../../hooks/useLeaderboardData';
import { TeamScorecardModal } from './TeamScorecardModal';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import type { TournamentTeam } from '../../types/database';
import styles from './LiveScoreTab.module.css';

const LIVE_STATUS_LABEL: Record<LiveStatus, string> = {
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

export function LiveScoreTab() {
  const { tournament, membership, canViewLiveScore, isOrganizer } = useOutletContext<TournamentAccess>();
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);

  const leaderboard = useLeaderboardData(tournament?.id, !!tournament && canViewLiveScore);

  if (!tournament) return null;

  if (!canViewLiveScore) {
    return <p className="empty-state">{LIVE_SCORE_DISABLED_TEXT}</p>;
  }

  const isCompleted = tournament.status === 'completed';
  const openTeam = leaderboard.teams.find((t) => t.id === openTeamId) ?? null;

  return (
    <div>
      <div className={styles.statusRow}>
        <span className={`${styles.liveDot} ${styles[leaderboard.liveStatus]}`} aria-hidden="true" />
        <span>{LIVE_STATUS_LABEL[leaderboard.liveStatus]}</span>
      </div>

      {leaderboard.standings.length === 0 ? (
        <p className="empty-state">No scores yet.</p>
      ) : (
        <ol className={styles.leaderboard}>
          {leaderboard.standings.map((team) => (
            <li key={team.teamId} className={styles.row}>
              <button type="button" className={styles.rowButton} onClick={() => setOpenTeamId(team.teamId)}>
                <span className={styles.rank}>{team.rankLabel}</span>
                <span className={styles.teamName}>{team.teamName}</span>
                <span className={styles.score}>{formatRelativeToPar(team.relativeToPar)}</span>
                <span className={styles.through}>
                  {isCompleted ? `${team.holesPlayed} holes` : `Through ${team.holesPlayed}`}
                </span>
                {team.lastUpdated && (
                  <span className={styles.updated}>Last synced {formatRelativeTime(team.lastUpdated)}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}

      {openTeam && (
        <TeamScorecardModal
          team={openTeam}
          holes={leaderboard.holes}
          scores={leaderboard.scores.filter((s) => s.team_id === openTeam.id)}
          isOwnTeam={membership?.team_id === openTeam.id}
          isOrganizer={isOrganizer}
          isLive={tournament.status === 'live'}
          tournamentId={tournament.id}
          onClose={() => setOpenTeamId(null)}
        />
      )}

      {isOrganizer && tournament.status === 'live' && (
        <ScoreCorrectionForm tournamentId={tournament.id} teams={leaderboard.teams} />
      )}
    </div>
  );
}

function ScoreCorrectionForm({ tournamentId, teams }: { tournamentId: string; teams: TournamentTeam[] }) {
  const queryClient = useQueryClient();
  const [teamId, setTeamId] = useState('');
  const [holeNumber, setHoleNumber] = useState('');
  const [strokes, setStrokes] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (!teamId || !holeNumber || !strokes || !reason.trim()) {
      setError('All fields, including a reason, are required.');
      return;
    }

    setSubmitting(true);

    const { error: rpcError } = await supabase.rpc('correct_team_score', {
      p_operation_uuid: crypto.randomUUID(),
      p_tournament_id: tournamentId,
      p_team_id: teamId,
      p_hole_number: Number(holeNumber),
      p_new_strokes: Number(strokes),
      p_change_reason: reason.trim(),
      p_device_timestamp: new Date().toISOString(),
    });

    setSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setSuccess(true);
    setHoleNumber('');
    setStrokes('');
    setReason('');
    void queryClient.invalidateQueries({ queryKey: ['leaderboard-scores', tournamentId] });
  }

  return (
    <div className={`card ${styles.correctionCard}`}>
      <h2 className="section-title">Correct a Score</h2>
      <p className={styles.correctionHint}>
        Organizer-only. Every correction is recorded with your reason in the audit history.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="correction-team">Team</label>
          <select id="correction-team" value={teamId} onChange={(event) => setTeamId(event.target.value)} required>
            <option value="">Select a team</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name ?? `Team ${team.team_number ?? ''}`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="correction-hole">Hole number</label>
          <input
            id="correction-hole"
            type="number"
            min={1}
            value={holeNumber}
            onChange={(event) => setHoleNumber(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="correction-strokes">Corrected strokes</label>
          <input
            id="correction-strokes"
            type="number"
            min={1}
            value={strokes}
            onChange={(event) => setStrokes(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="correction-reason">Reason</label>
          <input
            id="correction-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        {success && <p className={styles.successText}>Score corrected.</p>}
        <button type="submit" className="btn btn-secondary" disabled={submitting}>
          {submitting ? 'Correcting…' : 'Correct Score'}
        </button>
      </form>
    </div>
  );
}
