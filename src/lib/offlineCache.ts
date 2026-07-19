import { db, membershipCacheKey, scoreCacheKey } from './db';
import type { Profile, TeamHoleScore, Tournament, TournamentHole, TournamentPlayer, TournamentTeam } from '../types/database';

// Centralizes write-through caching from Supabase responses into Dexie, so
// every tab that fetches tournament data also makes it available offline
// instead of each tab reinventing its own seeding effect.

export async function cacheTournament(tournament: Tournament): Promise<void> {
  await db.cachedTournaments.put({
    id: tournament.id,
    name: tournament.name,
    courseName: tournament.course_name,
    tournamentDate: tournament.tournament_date,
    status: tournament.status,
    holeCount: tournament.hole_count,
    scoringFormat: tournament.scoring_format,
    teamSize: tournament.team_size,
    organizerUserId: tournament.organizer_user_id,
    startedAt: tournament.started_at,
    completedAt: tournament.completed_at,
    cachedAt: new Date().toISOString(),
    dataVersion: tournament.data_version,
    golfCourseId: tournament.golf_course_id,
    golfCourseTeeId: tournament.golf_course_tee_id,
    courseRating: tournament.course_rating,
    slopeRating: tournament.slope_rating,
    isPersonal: tournament.is_personal,
  });
}

export async function cacheMembership(tournamentId: string, userId: string, player: TournamentPlayer): Promise<void> {
  await db.cachedMemberships.put({
    id: membershipCacheKey(tournamentId, userId),
    tournamentId,
    userId,
    teamId: player.team_id,
    membershipStatus: player.membership_status,
    isOrganizer: player.is_organizer,
  });
}

export async function cacheTeams(tournamentId: string, teams: TournamentTeam[]): Promise<void> {
  await db.cachedTeams.bulkPut(
    teams.map((team) => ({
      id: team.id,
      tournamentId,
      name: team.name,
      teamNumber: team.team_number,
    })),
  );
}

export interface RosterEntryInput {
  player: TournamentPlayer;
  profile: Pick<Profile, 'first_name' | 'last_name'>;
}

export async function cachePlayers(tournamentId: string, roster: RosterEntryInput[]): Promise<void> {
  await db.cachedPlayers.bulkPut(
    roster.map(({ player, profile }) => ({
      id: player.id,
      tournamentId,
      userId: player.user_id,
      teamId: player.team_id,
      membershipStatus: player.membership_status,
      isOrganizer: player.is_organizer,
      firstName: profile.first_name,
      lastName: profile.last_name,
    })),
  );
}

export async function cacheHoles(tournamentId: string, holes: TournamentHole[]): Promise<void> {
  await db.cachedHoles.bulkPut(
    holes.map((hole) => ({
      id: `${tournamentId}_${hole.hole_number}`,
      tournamentId,
      holeNumber: hole.hole_number,
      par: hole.par,
      strokeIndex: hole.stroke_index,
      distance: hole.distance,
    })),
  );
}

/**
 * Writes server-confirmed scores into the cache, skipping any hole that has
 * an unsynced local operation (pending/syncing/failed/conflict) so a
 * background refetch never clobbers an optimistic edit still in flight.
 */
export async function cacheScores(tournamentId: string, scores: TeamHoleScore[]): Promise<void> {
  if (scores.length === 0) return;

  const pendingOps = await db.pendingScoreOperations.where('tournamentId').equals(tournamentId).toArray();
  const pendingKeys = new Set(
    pendingOps.map((op) => scoreCacheKey(op.tournamentId, op.teamId, op.holeNumber)),
  );

  const toWrite = scores.filter((score) => !pendingKeys.has(scoreCacheKey(tournamentId, score.team_id, score.hole_number)));

  await db.cachedScores.bulkPut(
    toWrite.map((score) => ({
      id: scoreCacheKey(tournamentId, score.team_id, score.hole_number),
      tournamentId,
      teamId: score.team_id,
      holeNumber: score.hole_number,
      strokes: score.strokes,
      revision: score.revision,
      lastUpdatedByUserId: score.last_updated_by,
      updatedAt: score.updated_at,
    })),
  );
}

/**
 * Clears cached *read* data (safe to lose — it's just a copy of server
 * state and gets re-seeded on next successful fetch). Never touches
 * pendingScoreOperations: unsynced scores must survive logout so they can
 * still sync once the user (or another user on this device) is back online
 * and authenticated.
 */
export async function clearPrivateCache(): Promise<void> {
  await db.transaction(
    'rw',
    [db.cachedTournaments, db.cachedMemberships, db.cachedTeams, db.cachedHoles, db.cachedScores, db.cachedPlayers, db.cachedDownloads, db.cachedMessages],
    async () => {
      await Promise.all([
        db.cachedTournaments.clear(),
        db.cachedMemberships.clear(),
        db.cachedTeams.clear(),
        db.cachedHoles.clear(),
        db.cachedScores.clear(),
        db.cachedPlayers.clear(),
        db.cachedDownloads.clear(),
        db.cachedMessages.clear(),
      ]);
    },
  );
}

/**
 * Removes one tournament's cached data (the "Remove cached tournament"
 * action in the Offline Data section) -- unlike clearPrivateCache(), this
 * is scoped to a single tournament rather than wiping every cached
 * tournament on the device. Same invariant: pendingScoreOperations is never
 * touched, regardless of which tournament's scores they belong to.
 */
export async function removeCachedTournamentData(tournamentId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.cachedTournaments, db.cachedMemberships, db.cachedTeams, db.cachedHoles, db.cachedScores, db.cachedPlayers, db.cachedDownloads, db.cachedMessages],
    async () => {
      await Promise.all([
        db.cachedTournaments.delete(tournamentId),
        db.cachedMemberships.where('tournamentId').equals(tournamentId).delete(),
        db.cachedTeams.where('tournamentId').equals(tournamentId).delete(),
        db.cachedHoles.where('tournamentId').equals(tournamentId).delete(),
        db.cachedScores.where('tournamentId').equals(tournamentId).delete(),
        db.cachedPlayers.where('tournamentId').equals(tournamentId).delete(),
        db.cachedDownloads.delete(tournamentId),
        db.cachedMessages.where('tournamentId').equals(tournamentId).delete(),
      ]);
    },
  );
}
