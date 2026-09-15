import { db, scorecardPositionKey } from './db';

/** The hole the Scorecard tab last showed for this tournament+user, or null if never saved on this device. */
export async function getSavedHole(tournamentId: string, userId: string): Promise<number | null> {
  const row = await db.scorecardPositions.get(scorecardPositionKey(tournamentId, userId));
  return row?.holeNumber ?? null;
}

/** Writes immediately (no network round trip) so it survives a close/crash right after navigating holes. */
export async function saveCurrentHole(tournamentId: string, userId: string, holeNumber: number): Promise<void> {
  await db.scorecardPositions.put({
    id: scorecardPositionKey(tournamentId, userId),
    tournamentId,
    userId,
    holeNumber,
    updatedAt: new Date().toISOString(),
  });
}

/** Called when a tournament/round's downloaded data is explicitly removed -- see offlineCache.removeCachedTournamentData. */
export async function clearSavedHole(tournamentId: string, userId: string): Promise<void> {
  await db.scorecardPositions.delete(scorecardPositionKey(tournamentId, userId));
}
