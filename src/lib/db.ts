import Dexie, { type Table } from 'dexie';
import type { MembershipStatus, TournamentStatus } from '../types/database';

export interface CachedTournament {
  id: string;
  name: string;
  courseName: string;
  tournamentDate: string;
  status: TournamentStatus;
  holeCount: number;
  scoringFormat: string | null;
  teamSize: number | null;
  organizerUserId: string;
  startedAt: string | null;
  completedAt: string | null;
  cachedAt: string;
  dataVersion: number;
  golfCourseId: string | null;
  golfCourseTeeId: string | null;
  courseRating: number | null;
  slopeRating: number | null;
  isPersonal: boolean;
}

export interface CachedPlayer {
  id: string; // tournament_players.id
  tournamentId: string;
  userId: string;
  teamId: string | null;
  membershipStatus: MembershipStatus;
  isOrganizer: boolean;
  firstName: string;
  lastName: string;
}

export interface CachedDownload {
  tournamentId: string;
  status: 'ready' | 'failed';
  downloadedAt: string;
  cacheVersion: number;
  holeCount: number;
  lastError: string | null;
}

export interface CachedMembership {
  id: string; // `${tournamentId}_${userId}`
  tournamentId: string;
  userId: string;
  teamId: string | null;
  membershipStatus: MembershipStatus;
  isOrganizer: boolean;
}

export interface CachedTeam {
  id: string;
  tournamentId: string;
  name: string | null;
  teamNumber: number | null;
}

export interface CachedHole {
  id: string;
  tournamentId: string;
  holeNumber: number;
  par: number;
  strokeIndex: number | null;
  distance: number | null;
}

export interface CachedScore {
  id: string; // `${tournamentId}_${teamId}_${holeNumber}`
  tournamentId: string;
  teamId: string;
  holeNumber: number;
  strokes: number;
  revision: number;
  lastUpdatedByUserId: string | null;
  updatedAt: string;
}

export type PendingOperationKind = 'submit' | 'correct';
export type PendingOperationState = 'pending' | 'syncing' | 'failed' | 'conflict';

export interface PendingScoreOperation {
  operationUuid: string; // primary key — also the idempotency key sent to the server
  tournamentId: string;
  teamId: string;
  holeNumber: number;
  newStrokes: number;
  expectedRevision: number;
  kind: PendingOperationKind;
  changeReason: string | null;
  deviceTimestamp: string;
  createdAt: string;
  state: PendingOperationState;
  lastError: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  // Populated only when state === 'conflict'.
  conflictServerStrokes: number | null;
  conflictServerRevision: number | null;
  conflictUpdatedByUserId: string | null;
  conflictUpdatedByName: string | null;
  conflictUpdatedAt: string | null;
  conflictSubmittedStrokes: number | null;
}

// Server-confirmed chat messages, write-through cached (mirrors CachedScore's
// role) -- lets a member keep reading chat history while offline.
export interface CachedMessage {
  id: string; // tournament_messages.id
  tournamentId: string;
  senderUserId: string;
  senderTeamId: string | null;
  messageText: string;
  createdAt: string;
  deletedAt: string | null;
}

export type PendingMessageState = 'pending' | 'sending' | 'failed';

// Offline send queue for chat -- deliberately not shaped like
// PendingScoreOperation: a message is create-only (no revision, no
// coalescing target, nothing to correct), so there's no expectedRevision/
// conflict bookkeeping to carry.
export interface PendingMessage {
  operationUuid: string; // primary key — also the idempotency key sent to the server
  tournamentId: string;
  messageText: string;
  createdAt: string;
  state: PendingMessageState;
  lastError: string | null;
  retryCount: number;
  nextRetryAt: string | null;
}

export function scoreCacheKey(tournamentId: string, teamId: string, holeNumber: number): string {
  return `${tournamentId}_${teamId}_${holeNumber}`;
}

export function membershipCacheKey(tournamentId: string, userId: string): string {
  return `${tournamentId}_${userId}`;
}

class GreenLinkDB extends Dexie {
  cachedTournaments!: Table<CachedTournament, string>;
  cachedMemberships!: Table<CachedMembership, string>;
  cachedTeams!: Table<CachedTeam, string>;
  cachedHoles!: Table<CachedHole, string>;
  cachedScores!: Table<CachedScore, string>;
  cachedPlayers!: Table<CachedPlayer, string>;
  cachedDownloads!: Table<CachedDownload, string>;
  pendingScoreOperations!: Table<PendingScoreOperation, string>;
  cachedMessages!: Table<CachedMessage, string>;
  pendingMessages!: Table<PendingMessage, string>;

  constructor() {
    super('greenlink');

    // v1: original shape. Kept verbatim (not edited in place) so existing
    // installs upgrade through it rather than losing whatever's already in
    // pendingScoreOperations — Dexie preserves table contents across a
    // version bump as long as the table name survives, which it does here.
    this.version(1).stores({
      cachedTournaments: 'id, status',
      cachedTeams: 'id, tournamentId',
      cachedHoles: 'id, tournamentId, [tournamentId+holeNumber]',
      cachedScores: 'id, tournamentId, teamId, [tournamentId+teamId+holeNumber]',
      pendingScoreOperations: 'operationUuid, tournamentId, state, createdAt',
    });

    // v2: adds cachedMemberships (for offline tournament access) and a
    // compound index on pendingScoreOperations for per-hole coalescing.
    // New non-indexed fields on existing tables (expectedRevision, retry
    // bookkeeping, conflict fields, lastUpdatedByUserId) need no explicit
    // migration — Dexie/IndexedDB records are schemaless beyond the
    // declared indexes, so old rows simply read back with those fields
    // undefined until next written.
    this.version(2).stores({
      cachedTournaments: 'id, status',
      cachedMemberships: 'id, tournamentId',
      cachedTeams: 'id, tournamentId',
      cachedHoles: 'id, tournamentId, [tournamentId+holeNumber]',
      cachedScores: 'id, tournamentId, teamId, [tournamentId+teamId+holeNumber]',
      pendingScoreOperations:
        'operationUuid, tournamentId, state, createdAt, [tournamentId+teamId+holeNumber]',
    });

    // v3: adds cachedPlayers (roster, for offline team/leaderboard display)
    // and cachedDownloads (one row per tournament, tracking the explicit
    // "Download for Offline Play" action's status/version/timestamp,
    // separate from the incidental per-tab caching the other tables have
    // always done). New fields on cachedTournaments (dataVersion, course/
    // tee provenance) are non-indexed, so existing rows just read back with
    // them undefined until next written -- no migration needed for those.
    this.version(3).stores({
      cachedTournaments: 'id, status',
      cachedMemberships: 'id, tournamentId',
      cachedTeams: 'id, tournamentId',
      cachedHoles: 'id, tournamentId, [tournamentId+holeNumber]',
      cachedScores: 'id, tournamentId, teamId, [tournamentId+teamId+holeNumber]',
      cachedPlayers: 'id, tournamentId',
      cachedDownloads: 'tournamentId',
      pendingScoreOperations:
        'operationUuid, tournamentId, state, createdAt, [tournamentId+teamId+holeNumber]',
    });

    // v4: adds cachedMessages (tournament chat read cache) and
    // pendingMessages (chat's own small offline send queue -- separate from
    // pendingScoreOperations since a message has none of the revision/
    // conflict/coalescing semantics a score correction has).
    this.version(4).stores({
      cachedTournaments: 'id, status',
      cachedMemberships: 'id, tournamentId',
      cachedTeams: 'id, tournamentId',
      cachedHoles: 'id, tournamentId, [tournamentId+holeNumber]',
      cachedScores: 'id, tournamentId, teamId, [tournamentId+teamId+holeNumber]',
      cachedPlayers: 'id, tournamentId',
      cachedDownloads: 'tournamentId',
      pendingScoreOperations:
        'operationUuid, tournamentId, state, createdAt, [tournamentId+teamId+holeNumber]',
      cachedMessages: 'id, tournamentId, [tournamentId+createdAt]',
      pendingMessages: 'operationUuid, tournamentId, state, createdAt',
    });
  }
}

export const db = new GreenLinkDB();
