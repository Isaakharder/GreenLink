import { Link } from 'react-router-dom';
import { formatRelativeTime } from '../../lib/relativeTime';
import { formatRelativeToPar, formatTeamName } from '../../lib/leaderboard';
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
  /** Extra context line under the title (e.g. "Player · Tee played · Date") -- used by My Golf's read-only round views. Tournament call sites omit it. */
  subtitle?: string;
  /** My Golf only: this round is a personal round under the hood -- drives the title fallback ("My Round" instead of "Team 1") and routes "Go to Your Scorecard" to /my-golf instead of /tournaments. Tournament call sites omit it (default false). */
  isPersonal?: boolean;
  /** Overrides the title outright (e.g. the player's name on a public feed item). Takes priority over both the team name and the isPersonal fallback. */
  title?: string;
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
  subtitle,
  isPersonal = false,
  title,
}: TeamScorecardModalProps) {
  const sortedHoles = [...holes].sort((a, b) => a.hole_number - b.hole_number);
  const scoreByHole = new Map(scores.map((s) => [s.hole_number, s]));
  const displayTitle = title ?? (isPersonal ? 'My Round' : formatTeamName(team));

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
          <h2 className={styles.title}>{displayTitle}</h2>
          <button type="button" className={styles.closeButton} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {subtitle && <p className={styles.summary}>{subtitle}</p>}
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
          <Link
            to={isPersonal ? `/my-golf/round/${tournamentId}` : `/tournaments/${tournamentId}/scorecard`}
            className="btn btn-primary"
            onClick={onClose}
          >
            {isPersonal ? 'Continue Round' : 'Go to Your Scorecard'}
          </Link>
        )}
        {!isOwnTeam && isOrganizer && (
          <p className={styles.footerNote}>Use the correction form below to adjust this team's scores.</p>
        )}
      </div>
    </div>
  );
}
