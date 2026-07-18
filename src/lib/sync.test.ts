import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabaseClient', () => ({
  // Coalescing tests run with navigator.onLine forced false, so flushQueue
  // returns before ever reaching this; kept as a safety net so a bug in
  // that offline check can never make a unit test hit the real network.
  supabase: { rpc: vi.fn(() => Promise.reject(new Error('network should not be called in this test'))) },
}));

import { db } from './db';
import { applyScoreChange, classifyFailure } from './sync';

describe('classifyFailure', () => {
  it.each([
    ['scores can only be submitted while the tournament is live'],
    ['only a live tournament can be finished'],
    ['you are not assigned to this team'],
    ['only the tournament organizer can correct scores'],
    ['a reason is required to force-complete the tournament'],
    ['strokes must be at least 1'],
    ['authentication required'],
    ['permission denied for table team_hole_scores'],
    ['tournament not found'],
  ])('classifies "%s" as non-retryable', (message) => {
    expect(classifyFailure(new Error(message))).toBe('non-retryable');
  });

  it.each([
    ['Failed to fetch'],
    ['NetworkError when attempting to fetch resource'],
    ['The operation timed out'],
    ['Gateway Timeout (504)'],
    ['fetch failed'],
  ])('classifies "%s" as retryable', (message) => {
    expect(classifyFailure(new Error(message))).toBe('retryable');
  });

  it('treats an unrecognized error as retryable rather than stranding the operation', () => {
    expect(classifyFailure(new Error('something odd happened'))).toBe('retryable');
  });

  it('handles non-Error thrown values', () => {
    expect(classifyFailure('a plain string error')).toBe('retryable');
  });
});

describe('applyScoreChange coalescing (offline)', () => {
  beforeEach(async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await db.cachedScores.clear();
    await db.pendingScoreOperations.clear();
  });

  const input = { tournamentId: 't1', teamId: 'team1', holeNumber: 5, kind: 'submit' as const };

  it('queues a single operation for a fresh hole', async () => {
    await applyScoreChange({ ...input, newStrokes: 4 });
    const ops = await db.pendingScoreOperations.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].newStrokes).toBe(4);
    expect(ops[0].expectedRevision).toBe(0);
    expect(ops[0].state).toBe('pending');
  });

  it('coalesces rapid re-taps of the same hole into one operation carrying the final value', async () => {
    await applyScoreChange({ ...input, newStrokes: 4 });
    await applyScoreChange({ ...input, newStrokes: 5 });
    await applyScoreChange({ ...input, newStrokes: 6 });

    const ops = await db.pendingScoreOperations.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].newStrokes).toBe(6);
  });

  it('updates the optimistic cache to the latest value without bumping revision ahead of the server', async () => {
    await applyScoreChange({ ...input, newStrokes: 4 });
    await applyScoreChange({ ...input, newStrokes: 5 });

    const cached = await db.cachedScores.get('t1_team1_5');
    expect(cached?.strokes).toBe(5);
    expect(cached?.revision).toBe(0); // still unconfirmed by the server
  });

  it('does not coalesce into a stuck (failed) operation -- it queues a fresh one instead', async () => {
    await db.pendingScoreOperations.put({
      operationUuid: 'stuck-op',
      tournamentId: 't1',
      teamId: 'team1',
      holeNumber: 5,
      newStrokes: 9,
      expectedRevision: 0,
      kind: 'submit',
      changeReason: null,
      deviceTimestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      state: 'failed',
      lastError: 'tournament not found',
      retryCount: 1,
      nextRetryAt: null,
      conflictServerStrokes: null,
      conflictServerRevision: null,
      conflictUpdatedByUserId: null,
      conflictUpdatedByName: null,
      conflictUpdatedAt: null,
      conflictSubmittedStrokes: null,
    });

    await applyScoreChange({ ...input, newStrokes: 4 });

    const ops = await db.pendingScoreOperations.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].operationUuid).not.toBe('stuck-op');
    expect(ops[0].newStrokes).toBe(4);
    expect(ops[0].state).toBe('pending');
  });

  it('keeps operations for different holes independent', async () => {
    await applyScoreChange({ ...input, holeNumber: 1, newStrokes: 4 });
    await applyScoreChange({ ...input, holeNumber: 2, newStrokes: 5 });

    const ops = await db.pendingScoreOperations.toArray();
    expect(ops).toHaveLength(2);
  });
});
