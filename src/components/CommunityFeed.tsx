import { useState } from 'react';
import { usePublicRoundFeed } from '../hooks/usePublicRoundFeed';
import { usePublicRoundDetail } from '../hooks/usePublicRoundDetail';
import { formatRelativeTime } from '../lib/relativeTime';
import { formatRelativeToPar } from '../lib/leaderboard';
import { TeamScorecardModal } from '../pages/tournament/TeamScorecardModal';
import type { PublicRoundFeedItem } from '../types/database';
import styles from './CommunityFeed.module.css';

function FeedItem({ item, onSelect }: { item: PublicRoundFeedItem; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className={styles.item} onClick={onSelect}>
        <div className={styles.itemHeader}>
          <span className={styles.playerName}>
            {item.player_first_name} {item.player_last_name}
          </span>
          <span className={styles.time}>{formatRelativeTime(item.completed_at)}</span>
        </div>
        <div className={styles.itemScore}>
          <span className={styles.score}>{item.total_strokes}</span>
          <span className={styles.relative}>{formatRelativeToPar(item.relative_to_par)}</span>
        </div>
        <p className={styles.course}>
          {item.course_name}
          {item.tee_name && ` · ${item.tee_name}`}
        </p>
      </button>
    </li>
  );
}

function FeedDetailModal({ tournamentId, onClose }: { tournamentId: string; onClose: () => void }) {
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
      title={data.playerName}
      subtitle={data.teeName ?? undefined}
    />
  );
}

/** Home page section: every public, completed personal round, newest first. Selecting one reuses TeamScorecardModal (same read-only scorecard the app already uses for tournaments) instead of a bespoke detail view. */
export function CommunityFeed() {
  const { data, isLoading } = usePublicRoundFeed();
  const [openRoundId, setOpenRoundId] = useState<string | null>(null);

  return (
    <div>
      <h2 className="section-title">Community Feed</h2>
      {isLoading ? (
        <p className="empty-state">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="empty-state">No public rounds yet.</p>
      ) : (
        <ul className={styles.list}>
          {data.map((item) => (
            <FeedItem key={item.tournament_id} item={item} onSelect={() => setOpenRoundId(item.tournament_id)} />
          ))}
        </ul>
      )}

      {openRoundId && <FeedDetailModal tournamentId={openRoundId} onClose={() => setOpenRoundId(null)} />}
    </div>
  );
}
