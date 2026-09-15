import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { removeCachedTournamentData } from './offlineCache';
import { clearSavedHole, getSavedHole, saveCurrentHole } from './scorecardPosition';

describe('scorecardPosition', () => {
  beforeEach(async () => {
    await db.scorecardPositions.clear();
  });

  it('returns null when nothing has been saved for this tournament+user', async () => {
    expect(await getSavedHole('t1', 'u1')).toBeNull();
  });

  it('round-trips a saved hole', async () => {
    await saveCurrentHole('t1', 'u1', 13);
    expect(await getSavedHole('t1', 'u1')).toBe(13);
  });

  it('overwrites the previous position for the same tournament+user', async () => {
    await saveCurrentHole('t1', 'u1', 7);
    await saveCurrentHole('t1', 'u1', 8);
    expect(await getSavedHole('t1', 'u1')).toBe(8);
  });

  it('scopes position by tournament -- one tournament never leaks into another for the same user', async () => {
    await saveCurrentHole('tournament-a', 'u1', 13);
    await saveCurrentHole('tournament-b', 'u1', 5);
    expect(await getSavedHole('tournament-a', 'u1')).toBe(13);
    expect(await getSavedHole('tournament-b', 'u1')).toBe(5);
  });

  it('scopes position by user -- one account never leaks into another on the same device', async () => {
    await saveCurrentHole('t1', 'user-a', 13);
    await saveCurrentHole('t1', 'user-b', 2);
    expect(await getSavedHole('t1', 'user-a')).toBe(13);
    expect(await getSavedHole('t1', 'user-b')).toBe(2);
  });

  it('clears the saved position for one tournament+user without affecting others', async () => {
    await saveCurrentHole('t1', 'u1', 13);
    await saveCurrentHole('t2', 'u1', 4);
    await clearSavedHole('t1', 'u1');
    expect(await getSavedHole('t1', 'u1')).toBeNull();
    expect(await getSavedHole('t2', 'u1')).toBe(4);
  });

  it('is removed when its tournament\'s downloaded data is explicitly removed, without touching pending offline scores or other tournaments', async () => {
    await saveCurrentHole('t1', 'u1', 13);
    await saveCurrentHole('t2', 'u1', 6);
    await db.pendingScoreOperations.put({
      operationUuid: 'op-1',
      tournamentId: 't1',
      teamId: 'team1',
      holeNumber: 13,
      newStrokes: 4,
      expectedRevision: 0,
      kind: 'submit',
      changeReason: null,
      deviceTimestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      state: 'pending',
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
      conflictServerStrokes: null,
      conflictServerRevision: null,
      conflictUpdatedByUserId: null,
      conflictUpdatedByName: null,
      conflictUpdatedAt: null,
      conflictSubmittedStrokes: null,
    });

    await removeCachedTournamentData('t1');

    expect(await getSavedHole('t1', 'u1')).toBeNull();
    expect(await getSavedHole('t2', 'u1')).toBe(6);
    const ops = await db.pendingScoreOperations.where('tournamentId').equals('t1').toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].newStrokes).toBe(4);
  });
});
