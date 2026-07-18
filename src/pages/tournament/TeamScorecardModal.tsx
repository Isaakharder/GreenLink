import { Link } from 'react-router-dom';
import { formatRelativeTime } from '../../lib/relativeTime';
import { formatRelativeToPar } from '../../lib/leaderboard';
import type { TeamHoleScore, TournamentHole, TournamentTeam } from '../../types/database';
import styles from './TeamScorecardModal.module.css';

interface TeamScorecardModalProps {
  team: TournamentTeam;
  holes: TournamentHole[];
  scores: TeamHoleScore[];
  isOwnTeam: boolean;
  isOrganizer: boolean;
  isLive: boolean;
  tournamentId: string;
  onClose: () => void;
}

/**
 * Read-only, regardless of who's viewing -- editing always happens through
 * the Scorecard tab (own team, live) or the organizer correction form
 * already on the Live Score tab, never inline here.
 */
export function TeamScorecardModal({
  team,
  holes,
  scores,
  isOwnTeam,
  isOrganizer,
  isLive,
  tournamentId,
  onClose,
}: TeamScorecardModalProps) {
  const sortedHoles = [...holes].sort((a, b) => a.hole_number - b.hole_number);
  const scoreByHole = new Map(scores.map((s) => [s.hole_number, s]));

  let runningStrokes = 0;
  let runningPar = 0;
  const lastUpdated = scores.reduce<string | null>((latest, s) => {
    if (!latest) return s.updated_at;
    return s.updated_at > latest ? s.updated_at : latest;
  }, null);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>{team.name ?? `Team ${team.team_number ?? ''}`}</h2>
          <button type="button" className={styles.closeButton} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {lastUpdated && <p className={styles.summary}>Last updated {formatRelativeTime(lastUpdated)}</p>}

        <table className={styles.table}>
          <thead>
            <tr>
              <th>Hole</th>
              <th>Par</th>
              <th>Strokes</th>
              <th>To Par</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {sortedHoles.map((hole) => {
              const score = scoreByHole.get(hole.hole_number);
              if (score) {
                runningStrokes += score.strokes;
                runningPar += hole.par;
              }
              return (
                <tr key={hole.id}>
                  <td>{hole.hole_number}</td>
                  <td>{hole.par}</td>
                  <td>{score ? score.strokes : '—'}</td>
                  <td>{score ? formatRelativeToPar(score.strokes - hole.par) : '—'}</td>
                  <td>{score ? formatRelativeToPar(runningStrokes - runningPar) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {isOwnTeam && isLive && (
          <Link to={`/tournaments/${tournamentId}/scorecard`} className="btn btn-primary" onClick={onClose}>
            Go to Your Scorecard
          </Link>
        )}
        {!isOwnTeam && isOrganizer && (
          <p className={styles.footerNote}>Use the correction form below to adjust this team's scores.</p>
        )}
      </div>
    </div>
  );
}
