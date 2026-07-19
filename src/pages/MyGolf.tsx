import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BigButton } from '../components/BigButton';
import { TeamScorecardModal } from './tournament/TeamScorecardModal';
import { useMyGolfRounds, type RecentCourse } from '../hooks/useMyGolfRounds';
import { useMyGolfStats } from '../hooks/useMyGolfStats';
import { usePublicRoundDetail } from '../hooks/usePublicRoundDetail';
import { formatRelativeToPar } from '../lib/leaderboard';
import type { Tournament } from '../types/database';
import styles from './MyGolf.module.css';

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function RoundDetailModal({ tournamentId, onClose }: { tournamentId: string; onClose: () => void }) {
  const { data, isLoading, isError } = usePublicRoundDetail(tournamentId);

  if (isLoading) return <p className="empty-state">Loading scorecard…</p>;
  if (isError || !data) return null;

  return (
    <TeamScorecardModal
      team={data.team}
      holes={data.holes}
      scores={data.scores}
      isOwnTeam={false}
      isOrganizer={false}
      isLive={false}
      tournamentId={tournamentId}
      onClose={onClose}
      isPersonal
      title="My Round"
      subtitle={[data.teeName, formatDate(data.tournament.tournament_date)].filter(Boolean).join(' · ')}
    />
  );
}

export function MyGolf() {
  const navigate = useNavigate();
  const { isLoading, liveRound, recentRounds, recentCourses } = useMyGolfRounds();
  const statsQuery = useMyGolfStats();
  const [openRoundId, setOpenRoundId] = useState<string | null>(null);

  function handleSelectCourse(course: RecentCourse) {
    navigate('/my-golf/start', { state: { preselectCourse: course } });
  }

  function handleSelectRound(round: Tournament) {
    if (round.status === 'live') {
      navigate(`/my-golf/round/${round.id}`);
      return;
    }
    setOpenRoundId(round.id);
  }

  const stats = statsQuery.data;

  return (
    <div>
      <h1>My Golf</h1>

      {liveRound ? (
        <BigButton to={`/my-golf/round/${liveRound.id}`} label={`Resume Round — ${liveRound.course_name}`} icon="▶️" />
      ) : (
        <BigButton to="/my-golf/start" label="Start Round" icon="⛳" />
      )}

      {recentCourses.length > 0 && (
        <>
          <h2 className="section-title">Recent Courses</h2>
          <div className={styles.chipRow}>
            {recentCourses.map((course) => (
              <button key={course.golfCourseId} type="button" className={styles.chip} onClick={() => handleSelectCourse(course)}>
                {course.courseName}
              </button>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Recent Rounds</h2>
      {isLoading ? (
        <p className="empty-state">Loading…</p>
      ) : recentRounds.length === 0 ? (
        <p className="empty-state">No rounds yet — start one above.</p>
      ) : (
        <ul className={styles.roundList}>
          {recentRounds.map((round) => (
            <li key={round.id}>
              <button type="button" className={styles.roundRow} onClick={() => handleSelectRound(round)}>
                <span className={styles.roundCourse}>{round.course_name}</span>
                <span className={styles.roundDate}>{formatDate(round.tournament_date)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">Statistics</h2>
      {statsQuery.isLoading ? (
        <p className="empty-state">Loading…</p>
      ) : stats && stats.rounds_played > 0 ? (
        <div className={styles.statsGrid}>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.rounds_played}</span>
            <span className={styles.statLabel}>Rounds Played</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.average_score ?? '—'}</span>
            <span className={styles.statLabel}>Average Score</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.best_round ? formatRelativeToPar(stats.best_round.relative_to_par) : '—'}</span>
            <span className={styles.statLabel}>Best Round</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.birdies}</span>
            <span className={styles.statLabel}>Birdies</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.pars}</span>
            <span className={styles.statLabel}>Pars</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.bogeys}</span>
            <span className={styles.statLabel}>Bogeys</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.double_bogeys_plus}</span>
            <span className={styles.statLabel}>Double Bogeys+</span>
          </div>
          <div className={`card ${styles.statTile}`}>
            <span className={styles.statValue}>{stats.courses_played}</span>
            <span className={styles.statLabel}>Courses Played</span>
          </div>
        </div>
      ) : (
        <p className="empty-state">Finish a round to see your stats here.</p>
      )}

      {openRoundId && <RoundDetailModal tournamentId={openRoundId} onClose={() => setOpenRoundId(null)} />}
    </div>
  );
}
