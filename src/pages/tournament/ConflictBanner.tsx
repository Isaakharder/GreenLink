import { describeConflict, resolveConflict, type ConflictInfo } from '../../lib/conflict';
import styles from './ScorecardTab.module.css';

interface ConflictBannerProps {
  conflict: ConflictInfo;
  onKeepTheirs: (strokes: number, revision: number) => void;
  onKeepMine: (strokes: number, expectedRevision: number) => void;
  onReviewLater: () => void;
}

export function ConflictBanner({ conflict, onKeepTheirs, onKeepMine, onReviewLater }: ConflictBannerProps) {
  return (
    <div className={styles.conflictBanner} role="alert">
      <p className={styles.conflictText}>{describeConflict(conflict)}</p>
      <div className={styles.conflictActions}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            const resolution = resolveConflict(conflict, 'keep-theirs');
            if (resolution.action === 'keep-theirs') onKeepTheirs(resolution.strokes, resolution.revision);
          }}
        >
          Keep {conflict.updatedByName?.trim() || 'their'} score: {conflict.serverStrokes}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            const resolution = resolveConflict(conflict, 'keep-mine');
            if (resolution.action === 'keep-mine') onKeepMine(resolution.strokes, resolution.expectedRevision);
          }}
        >
          Replace with my score: {conflict.submittedStrokes}
        </button>
        <button type="button" className="btn btn-text btn-auto" onClick={onReviewLater}>
          Review later
        </button>
      </div>
    </div>
  );
}
