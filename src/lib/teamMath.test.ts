import { describe, expect, it } from 'vitest';
import { computeAutoTeamCount, computeHoleStatus, computeQuickScoreStrokes, findFirstUnscoredHole } from './teamMath';

describe('computeAutoTeamCount', () => {
  it('creates enough teams to cover every accepted player (8 players, size 2 -> 4 teams)', () => {
    expect(computeAutoTeamCount(8, 2, 0)).toBe(4);
  });

  it('rounds up when players do not divide evenly', () => {
    expect(computeAutoTeamCount(7, 2, 0)).toBe(4);
  });

  it('only creates the shortfall when teams already exist', () => {
    expect(computeAutoTeamCount(8, 2, 3)).toBe(1);
  });

  it('returns 0 once enough teams already exist', () => {
    expect(computeAutoTeamCount(8, 2, 4)).toBe(0);
    expect(computeAutoTeamCount(8, 2, 6)).toBe(0);
  });

  it('returns 0 for a non-positive team size or player count', () => {
    expect(computeAutoTeamCount(8, 0, 0)).toBe(0);
    expect(computeAutoTeamCount(0, 2, 0)).toBe(0);
  });
});

describe('computeQuickScoreStrokes', () => {
  it('par 4 + Birdie (-1) = 3', () => {
    expect(computeQuickScoreStrokes(4, -1)).toBe(3);
  });

  it('par 5 + Eagle (-2) = 3', () => {
    expect(computeQuickScoreStrokes(5, -2)).toBe(3);
  });

  it('par 3 + Double Bogey (+2) = 5', () => {
    expect(computeQuickScoreStrokes(3, 2)).toBe(5);
  });

  it('never drops below 1 stroke, even for an aggressive eagle on a par 3', () => {
    expect(computeQuickScoreStrokes(3, -2)).toBe(1);
  });

  it('has no upper cap', () => {
    expect(computeQuickScoreStrokes(5, 20)).toBe(25);
  });
});

describe('findFirstUnscoredHole', () => {
  it('returns hole 1 when nothing has been scored', () => {
    expect(findFirstUnscoredHole([1, 2, 3, 4], [])).toBe(1);
  });

  it('returns the first unscored hole, not necessarily in sequential order', () => {
    expect(findFirstUnscoredHole([1, 2, 3, 4], [1, 2])).toBe(3);
  });

  it('supports shotgun starts: the "first" unscored hole can be any hole number', () => {
    // Round started on hole 10; holes 10-12 are scored, 1-9 and 13-18 are not.
    const holes = Array.from({ length: 18 }, (_, i) => i + 1);
    const scored = [10, 11, 12];
    expect(findFirstUnscoredHole(holes, scored)).toBe(1);
  });

  it('lands on the highest-numbered scored hole once every hole has a score', () => {
    expect(findFirstUnscoredHole([1, 2, 3], [1, 2, 3])).toBe(3);
  });

  it('returns 1 when there are no holes at all', () => {
    expect(findFirstUnscoredHole([], [])).toBe(1);
  });
});

describe('computeHoleStatus', () => {
  it('is not-scored when there is no cached score and no pending operation', () => {
    expect(
      computeHoleStatus({ hasCachedScore: false, pendingState: null, lastUpdatedByUserId: null, currentUserId: 'u1' }),
    ).toBe('not-scored');
  });

  it('is saved-locally for a queued-but-not-yet-sent operation', () => {
    expect(
      computeHoleStatus({ hasCachedScore: true, pendingState: 'pending', lastUpdatedByUserId: null, currentUserId: 'u1' }),
    ).toBe('saved-locally');
  });

  it('is pending while the operation is in flight', () => {
    expect(
      computeHoleStatus({ hasCachedScore: true, pendingState: 'syncing', lastUpdatedByUserId: null, currentUserId: 'u1' }),
    ).toBe('pending');
  });

  it('is sync-error for a failed or conflicted operation', () => {
    expect(
      computeHoleStatus({ hasCachedScore: true, pendingState: 'failed', lastUpdatedByUserId: null, currentUserId: 'u1' }),
    ).toBe('sync-error');
    expect(
      computeHoleStatus({ hasCachedScore: true, pendingState: 'conflict', lastUpdatedByUserId: null, currentUserId: 'u1' }),
    ).toBe('sync-error');
  });

  it('is synced when confirmed by the current user with no pending operation', () => {
    expect(
      computeHoleStatus({ hasCachedScore: true, pendingState: null, lastUpdatedByUserId: 'u1', currentUserId: 'u1' }),
    ).toBe('synced');
  });

  it('is teammate-changed when the last confirmed update came from someone else', () => {
    expect(
      computeHoleStatus({ hasCachedScore: true, pendingState: null, lastUpdatedByUserId: 'u2', currentUserId: 'u1' }),
    ).toBe('teammate-changed');
  });
});
