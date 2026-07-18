import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, scoreCacheKey } from '../../lib/db';
import { applyScoreChange, retrySyncNow } from '../../lib/sync';
import { useLeaderboardData } from '../../hooks/useLeaderboardData';
import { useAuth } from '../../auth/useAuth';
import { useConnectionState } from '../../hooks/useConnectionState';
import { formatRelativeToPar } from '../../lib/leaderboard';
import { computeHoleStatus, computeQuickScoreStrokes, findFirstUnscoredHole, type HoleStatus } from '../../lib/teamMath';
import { ConflictBanner } from './ConflictBanner';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import type { ConflictInfo } from '../../lib/conflict';
import styles from './ScorecardTab.module.css';

const QUICK_SCORES: { label: string; offset: number }[] = [
  { label: 'Eagle', offset: -2 },
  { label: 'Birdie', offset: -1 },
  { label: 'Par', offset: 0 },
  { label: 'Bogey', offset: 1 },
  { label: 'Double Bogey', offset: 2 },
];

const HOLE_STATUS_LABEL: Record<HoleStatus, string> = {
  'not-scored': 'Empty',
  'saved-locally': 'Saved',
  pending: 'Pending',
  synced: 'Synced',
  'teammate-changed': 'Teammate',
  'sync-error': 'Error',
};

const SYNC_STATUS_TEXT: Record<HoleStatus, string> = {
  'not-scored': '',
  'saved-locally': 'Saved on this phone.',
  pending: 'Waiting for connection.',
  synced: 'Score synchronized.',
  'teammate-changed': 'Score synchronized.',
  'sync-error': 'Could not sync. Tap to retry.',
};

export function ScorecardTab() {
  const { tournament, membership } = useOutletContext<TournamentAccess>();
  const { user } = useAuth();
  const connectionState = useConnectionState();
  const teamId = membership?.team_id ?? null;
  const isLive = tournament?.status === 'live';

  const leaderboard = useLeaderboardData(
    tournament?.id,
    !!tournament && (tournament.status === 'live' || tournament.status === 'completed'),
  );

  const cachedOwnScores = useLiveQuery(
    () =>
      tournament && teamId
        ? db.cachedScores.where('tournamentId').equals(tournament.id).and((s) => s.teamId === teamId).toArray()
        : [],
    [tournament?.id, teamId],
  );

  const pendingOwnOps = useLiveQuery(
    () =>
      tournament && teamId
        ? db.pendingScoreOperations
            .where('tournamentId')
            .equals(tournament.id)
            .and((op) => op.teamId === teamId)
            .toArray()
        : [],
    [tournament?.id, teamId],
  );

  const cachedByHole = useMemo(() => new Map((cachedOwnScores ?? []).map((s) => [s.holeNumber, s])), [cachedOwnScores]);
  const pendingByHole = useMemo(() => new Map((pendingOwnOps ?? []).map((op) => [op.holeNumber, op])), [pendingOwnOps]);

  function effectiveStrokes(holeNumber: number): number | null {
    const op = pendingByHole.get(holeNumber);
    if (op) return op.newStrokes;
    return cachedByHole.get(holeNumber)?.strokes ?? null;
  }

  function holeStatus(holeNumber: number): HoleStatus {
    const op = pendingByHole.get(holeNumber);
    const cached = cachedByHole.get(holeNumber);
    return computeHoleStatus({
      hasCachedScore: !!cached,
      pendingState: op?.state ?? null,
      lastUpdatedByUserId: cached?.lastUpdatedByUserId ?? null,
      currentUserId: user?.id ?? null,
    });
  }

  const sortedHoles = useMemo(
    () => [...leaderboard.holes].sort((a, b) => a.hole_number - b.hole_number),
    [leaderboard.holes],
  );
  const holeNumbers = useMemo(() => sortedHoles.map((h) => h.hole_number), [sortedHoles]);
  const scoredHoleNumbers = useMemo(
    () => holeNumbers.filter((n) => effectiveStrokes(n) !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holeNumbers, cachedByHole, pendingByHole],
  );

  const [selectedHole, setSelectedHole] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dismissedConflictHole, setDismissedConflictHole] = useState<number | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current && holeNumbers.length > 0) {
      setSelectedHole(findFirstUnscoredHole(holeNumbers, scoredHoleNumbers));
      initializedRef.current = true;
    }
  }, [holeNumbers, scoredHoleNumbers]);

  if (!tournament) return null;

  if (tournament.status === 'draft' || tournament.status === 'upcoming') {
    return <p className="empty-state">Scoring opens once the tournament is live.</p>;
  }

  if (tournament.status === 'cancelled') {
    return <p className="empty-state">This tournament was cancelled.</p>;
  }

  if (!teamId) {
    return <p className="empty-state">You are not assigned to a team for this tournament.</p>;
  }

  if (sortedHoles.length === 0) {
    return <p className="empty-state">No holes have been set up for this tournament yet.</p>;
  }

  if (!isLive) {
    return (
      <div>
        <p className={styles.readOnlyNotice}>Tournament completed — scores are final.</p>
        <Link to={`/tournaments/${tournament.id}/overview`} className="btn btn-secondary btn-auto">
          View Results
        </Link>
      </div>
    );
  }

  const currentHole = selectedHole !== null ? sortedHoles.find((h) => h.hole_number === selectedHole) : undefined;
  const currentStrokes = selectedHole !== null ? effectiveStrokes(selectedHole) : null;
  const currentStatus = selectedHole !== null ? holeStatus(selectedHole) : 'not-scored';
  const currentPendingOp = selectedHole !== null ? pendingByHole.get(selectedHole) : undefined;

  const ownTeam = leaderboard.teams.find((t) => t.id === teamId);
  const ownStanding = leaderboard.standings.find((s) => s.teamId === teamId);
  const teamName = ownTeam?.name ?? `Team ${ownTeam?.team_number ?? ''}`;
  const holesCompleted = scoredHoleNumbers.length;

  async function commitScore(holeNumber: number, strokes: number) {
    if (!tournament || !teamId) return;
    await applyScoreChange({ tournamentId: tournament.id, teamId, holeNumber, newStrokes: strokes, kind: 'submit' });
  }

  function selectHole(n: number) {
    setSelectedHole(n);
    setPickerOpen(false);
    setDismissedConflictHole(null);
  }

  function goPrev() {
    if (selectedHole === null) return;
    const idx = holeNumbers.indexOf(selectedHole);
    if (idx > 0) selectHole(holeNumbers[idx - 1]);
  }

  function goNext() {
    if (selectedHole === null) return;
    const idx = holeNumbers.indexOf(selectedHole);
    if (idx < holeNumbers.length - 1) selectHole(holeNumbers[idx + 1]);
  }

  async function handleKeepTheirs(strokes: number, revision: number) {
    if (!currentPendingOp || !tournament || !teamId || selectedHole === null) return;
    await db.cachedScores.put({
      id: scoreCacheKey(tournament.id, teamId, selectedHole),
      tournamentId: tournament.id,
      teamId,
      holeNumber: selectedHole,
      strokes,
      revision,
      lastUpdatedByUserId: currentPendingOp.conflictUpdatedByUserId,
      updatedAt: currentPendingOp.conflictUpdatedAt ?? new Date().toISOString(),
    });
    await db.pendingScoreOperations.delete(currentPendingOp.operationUuid);
  }

  async function handleKeepMine(strokes: number, expectedRevision: number) {
    if (!tournament || !teamId || selectedHole === null || !currentPendingOp) return;
    await db.pendingScoreOperations.delete(currentPendingOp.operationUuid);
    await applyScoreChange({
      tournamentId: tournament.id,
      teamId,
      holeNumber: selectedHole,
      newStrokes: strokes,
      kind: 'submit',
      expectedRevisionOverride: expectedRevision,
    });
  }

  const conflictInfo: ConflictInfo | null =
    selectedHole !== null && currentPendingOp?.state === 'conflict' && currentPendingOp.conflictServerStrokes !== null
      ? {
          holeNumber: selectedHole,
          updatedByName: currentPendingOp.conflictUpdatedByName,
          serverStrokes: currentPendingOp.conflictServerStrokes,
          serverRevision: currentPendingOp.conflictServerRevision ?? 0,
          submittedStrokes: currentPendingOp.conflictSubmittedStrokes ?? 0,
        }
      : null;

  return (
    <div>
      <div className={styles.header}>
        <p className={styles.tournamentName}>{tournament.name}</p>
        <p className={styles.statusLine}>
          {teamName}
          {ownStanding && (
            <>
              {' · '}
              <strong>{ownStanding.isTied ? `Tied for ${ordinal(ownStanding.rank)} Place` : `${ordinal(ownStanding.rank)} Place`}</strong>
              {' · '}
              {formatRelativeToPar(ownStanding.relativeToPar)}
            </>
          )}
          {' · '}Through {holesCompleted}
        </p>
        {leaderboard.usingCache && <p className={styles.cacheNotice}>Showing last synced standings — reconnect to refresh.</p>}
      </div>

      {conflictInfo && dismissedConflictHole !== selectedHole && (
        <ConflictBanner
          conflict={conflictInfo}
          onKeepTheirs={(strokes, revision) => void handleKeepTheirs(strokes, revision)}
          onKeepMine={(strokes, expectedRevision) => void handleKeepMine(strokes, expectedRevision)}
          onReviewLater={() => setDismissedConflictHole(selectedHole)}
        />
      )}

      {currentHole && (
        <div className={styles.holeCard}>
          <div className={styles.holeHeader}>
            <span className={styles.holeNumber}>Hole {currentHole.hole_number}</span>
            <span className={styles.par}>Par {currentHole.par}</span>
          </div>
          <div className={styles.holeMeta}>
            {currentHole.distance !== null && (
              <span>
                {currentHole.distance} {currentHole.distance_unit}
              </span>
            )}
            <span>Stroke index {currentHole.stroke_index ?? '—'}</span>
          </div>

          <div className={styles.scoreDisplay}>
            <span className={styles.currentScore}>{currentStrokes ?? '—'}</span>
            {currentStrokes !== null && (
              <span className={styles.scoreToPar}>{formatRelativeToPar(currentStrokes - currentHole.par)}</span>
            )}
          </div>

          <div className={styles.quickButtons}>
            {QUICK_SCORES.map((quick) => (
              <button
                key={quick.label}
                type="button"
                className={styles.quickButton}
                onClick={() => void commitScore(currentHole.hole_number, computeQuickScoreStrokes(currentHole.par, quick.offset))}
              >
                {quick.label}
              </button>
            ))}
          </div>

          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.stepperButton}
              aria-label={`Decrease score for hole ${currentHole.hole_number}`}
              disabled={(currentStrokes ?? currentHole.par) <= 1}
              onClick={() => void commitScore(currentHole.hole_number, Math.max(1, (currentStrokes ?? currentHole.par) - 1))}
            >
              −
            </button>
            <span className={styles.stepperValue}>{currentStrokes ?? currentHole.par}</span>
            <button
              type="button"
              className={styles.stepperButton}
              aria-label={`Increase score for hole ${currentHole.hole_number}`}
              onClick={() => void commitScore(currentHole.hole_number, (currentStrokes ?? currentHole.par) + 1)}
            >
              +
            </button>
          </div>

          <p className={styles.syncStatusLine}>
            {currentStatus === 'sync-error' ? (
              <button type="button" className={styles.syncStatusError} onClick={() => void retrySyncNow()}>
                {SYNC_STATUS_TEXT[currentStatus]}
              </button>
            ) : (
              SYNC_STATUS_TEXT[currentStatus] || (connectionState === 'offline' ? 'Waiting for connection.' : '')
            )}
          </p>
        </div>
      )}

      <div className={styles.navRow}>
        <button type="button" className="btn btn-secondary" onClick={goPrev} disabled={holeNumbers.indexOf(selectedHole ?? -1) <= 0}>
          Previous Hole
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={goNext}
          disabled={selectedHole === null || holeNumbers.indexOf(selectedHole) >= holeNumbers.length - 1}
        >
          Next Hole
        </button>
      </div>
      <button
        type="button"
        className={`btn btn-primary ${styles.saveNextButton}`}
        onClick={goNext}
        disabled={selectedHole === null || holeNumbers.indexOf(selectedHole) >= holeNumbers.length - 1}
      >
        Save & Next
      </button>

      <button type="button" className={`btn btn-secondary ${styles.pickerToggle}`} onClick={() => setPickerOpen((v) => !v)}>
        {pickerOpen ? 'Hide Hole Picker' : 'Choose a Hole'}
      </button>

      {pickerOpen && (
        <ul className={styles.pickerList}>
          {sortedHoles.map((hole) => {
            const status = holeStatus(hole.hole_number);
            return (
              <li key={hole.id}>
                <button
                  type="button"
                  className={`${styles.pickerItem} ${styles[`status-${status}`]} ${hole.hole_number === selectedHole ? styles.pickerItemCurrent : ''}`}
                  onClick={() => selectHole(hole.hole_number)}
                >
                  <span>Hole {hole.hole_number}</span>
                  <span className={styles.pickerBadge}>{HOLE_STATUS_LABEL[status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const mod100 = n % 100;
  const suffix = suffixes[(mod100 - 20) % 10] ?? suffixes[mod100] ?? suffixes[0];
  return `${n}${suffix}`;
}
