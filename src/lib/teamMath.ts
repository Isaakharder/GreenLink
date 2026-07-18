// Mirrors the team-count arithmetic in auto_create_tournament_teams()
// (supabase/migrations/0013_team_management_functions.sql) so the "Auto-
// create Teams" button can show an accurate preview before it's pressed.
// The database function is the actual source of truth/enforcement; this is
// display-only and never used to bypass it.
export function computeAutoTeamCount(
  acceptedPlayerCount: number,
  teamSize: number,
  existingTeamCount: number,
): number {
  if (teamSize <= 0 || acceptedPlayerCount <= 0) return 0;
  const targetTeamCount = Math.ceil(acceptedPlayerCount / teamSize);
  return Math.max(targetTeamCount - existingTeamCount, 0);
}

// Quick-score buttons (Eagle -2 ... Double Bogey +2) express strokes as an
// offset from par; this turns that offset into an actual stroke count,
// floored at 1 (a hole can never be scored below a single stroke) with no
// upper cap (there's no such thing as "too many strokes" on a real hole).
export function computeQuickScoreStrokes(par: number, offset: number): number {
  return Math.max(1, par + offset);
}

export type HoleStatus = 'not-scored' | 'saved-locally' | 'pending' | 'synced' | 'teammate-changed' | 'sync-error';

export interface HoleStatusInput {
  hasCachedScore: boolean;
  pendingState: 'pending' | 'syncing' | 'failed' | 'conflict' | null;
  lastUpdatedByUserId: string | null;
  currentUserId: string | null;
}

/** Drives the hole-picker badges: not scored / saved on this device / syncing / synced / changed by a teammate / sync error. */
export function computeHoleStatus(input: HoleStatusInput): HoleStatus {
  if (input.pendingState === 'pending') return 'saved-locally';
  if (input.pendingState === 'syncing') return 'pending';
  if (input.pendingState === 'failed' || input.pendingState === 'conflict') return 'sync-error';
  if (!input.hasCachedScore) return 'not-scored';
  if (input.lastUpdatedByUserId && input.currentUserId && input.lastUpdatedByUserId !== input.currentUserId) {
    return 'teammate-changed';
  }
  return 'synced';
}

/**
 * Picks which hole the Scorecard tab should open on: the first hole with no
 * score yet, hole 1 if nothing has been scored at all, or the
 * highest-numbered scored hole if every hole already has a score. Purely
 * hole-number based (not "next after the last one played sequentially") so
 * shotgun-start rounds that begin on an arbitrary hole behave correctly.
 */
export function findFirstUnscoredHole(holeNumbers: number[], scoredHoleNumbers: number[]): number {
  if (holeNumbers.length === 0) return 1;

  const scored = new Set(scoredHoleNumbers);
  const sortedHoles = [...holeNumbers].sort((a, b) => a - b);

  const firstUnscored = sortedHoles.find((n) => !scored.has(n));
  if (firstUnscored !== undefined) return firstUnscored;

  // Every hole has a score: land on the last one played (highest number),
  // not necessarily the last hole in the round.
  return Math.max(...sortedHoles);
}
