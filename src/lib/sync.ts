import { supabase } from './supabaseClient';
import { db, scoreCacheKey, type PendingOperationKind, type PendingScoreOperation } from './db';
import type { SubmitScoreResult, TeamHoleScore } from '../types/database';

export type ConnectionState = 'offline' | 'online' | 'syncing' | 'synced' | 'sync-failed';

type Listener = (state: ConnectionState) => void;

const listeners = new Set<Listener>();
let currentState: ConnectionState = typeof navigator !== 'undefined' && navigator.onLine ? 'online' : 'offline';
let flushing = false;
let monitorInitialized = false;

// Capped backoff for retryable failures: 2s, 5s, 15s, then hold at 30s.
// Small and bounded on purpose -- this is a golf course, not a data center;
// a runaway retry loop would just burn the player's battery and data plan.
const BACKOFF_SCHEDULE_MS = [2_000, 5_000, 15_000, 30_000];
const RETRY_POLL_INTERVAL_MS = 5_000;

function computeBackoffMs(retryCount: number): number {
  return BACKOFF_SCHEDULE_MS[Math.min(retryCount, BACKOFF_SCHEDULE_MS.length - 1)];
}

// Non-retryable: the operation was rejected for a reason that will still be
// true on the next attempt (business rule, permission, validation). Any
// message that doesn't match one of these is assumed transient/unknown and
// treated as retryable, so an unrecognized failure mode doesn't strand an
// operation forever without ever trying again.
const NON_RETRYABLE_PATTERNS = [
  'only a live tournament',
  'scores can only be submitted while the tournament is live',
  'you are not assigned to this team',
  'only the tournament organizer',
  'a reason is required',
  'strokes must be at least 1',
  'authentication required',
  'permission denied',
  'tournament not found',
];

export type FailureClass = 'retryable' | 'non-retryable';

export function classifyFailure(error: unknown): FailureClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (NON_RETRYABLE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return 'non-retryable';
  }
  return 'retryable';
}

function setState(next: ConnectionState): void {
  currentState = next;
  listeners.forEach((listener) => listener(currentState));
}

export function getConnectionState(): ConnectionState {
  return currentState;
}

export function subscribeConnectionState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Wires window online/offline listeners, a periodic backoff-retry poll, and does an initial queue flush. Safe to call more than once. */
export function initConnectionMonitor(): void {
  if (monitorInitialized || typeof window === 'undefined') return;
  monitorInitialized = true;

  window.addEventListener('online', () => {
    setState('online');
    void flushQueue();
  });
  window.addEventListener('offline', () => {
    setState('offline');
  });

  // Covers connectivity that's technically "online" per the browser but
  // flaky in practice (poor course reception) -- flushQueue is a cheap
  // no-op when there's nothing eligible to retry yet.
  window.setInterval(() => void flushQueue(), RETRY_POLL_INTERVAL_MS);

  void flushQueue();
}

export interface ApplyScoreChangeInput {
  tournamentId: string;
  teamId: string;
  holeNumber: number;
  newStrokes: number;
  kind: PendingOperationKind;
  changeReason?: string;
  /** Only for conflict resolution: force the expected revision instead of deriving it from local state. */
  expectedRevisionOverride?: number;
}

function freshOperation(input: ApplyScoreChangeInput, expectedRevision: number, now: string): PendingScoreOperation {
  return {
    operationUuid: crypto.randomUUID(),
    tournamentId: input.tournamentId,
    teamId: input.teamId,
    holeNumber: input.holeNumber,
    newStrokes: input.newStrokes,
    expectedRevision,
    kind: input.kind,
    changeReason: input.changeReason ?? null,
    deviceTimestamp: now,
    createdAt: now,
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
  };
}

/**
 * Step 1-3 of the offline scoring flow: update the local cache immediately,
 * create/coalesce a queued operation, then opportunistically flush.
 *
 * Coalescing: if this hole already has an operation that hasn't been sent
 * yet ('pending'), its strokes/timestamp are updated in place instead of
 * queuing a second operation -- rapid re-taps of the same hole collapse to
 * one network call carrying the final value. An operation already in
 * flight ('syncing') or stuck ('failed'/'conflict') is left alone and a new
 * operation is queued behind it instead, based on the best currently-known
 * revision.
 */
export async function applyScoreChange(input: ApplyScoreChangeInput): Promise<void> {
  const now = new Date().toISOString();
  const cacheId = scoreCacheKey(input.tournamentId, input.teamId, input.holeNumber);

  const existingCached = await db.cachedScores.get(cacheId);
  const existingOp = await db.pendingScoreOperations
    .where('[tournamentId+teamId+holeNumber]')
    .equals([input.tournamentId, input.teamId, input.holeNumber])
    .and((op) => op.kind === input.kind)
    .first();

  // Optimistic display cache: strokes reflect the latest local edit, but
  // revision is only ever set from confirmed server responses (see
  // flushQueue) -- it is never bumped here, so it stays a true "expected
  // revision" baseline rather than a guess.
  await db.cachedScores.put({
    id: cacheId,
    tournamentId: input.tournamentId,
    teamId: input.teamId,
    holeNumber: input.holeNumber,
    strokes: input.newStrokes,
    revision: existingCached?.revision ?? 0,
    lastUpdatedByUserId: existingCached?.lastUpdatedByUserId ?? null,
    updatedAt: now,
  });

  if (input.expectedRevisionOverride === undefined && existingOp && existingOp.state === 'pending') {
    await db.pendingScoreOperations.update(existingOp.operationUuid, {
      newStrokes: input.newStrokes,
      changeReason: input.changeReason ?? existingOp.changeReason,
      deviceTimestamp: now,
    });
    void flushQueue();
    return;
  }

  let expectedRevision: number;
  if (input.expectedRevisionOverride !== undefined) {
    expectedRevision = input.expectedRevisionOverride;
  } else if (existingOp?.state === 'syncing') {
    expectedRevision = existingOp.expectedRevision + 1;
  } else if (existingOp?.state === 'conflict' && existingOp.conflictServerRevision !== null) {
    expectedRevision = existingOp.conflictServerRevision;
  } else {
    expectedRevision = existingCached?.revision ?? 0;
  }

  // Superseding a stuck (syncing/failed/conflict) operation for this hole:
  // remove it so only the fresh one remains queued.
  if (existingOp && existingOp.state !== 'pending') {
    await db.pendingScoreOperations.delete(existingOp.operationUuid);
  }

  const operation = freshOperation(input, expectedRevision, now);
  await db.pendingScoreOperations.put(operation);

  void flushQueue();
}

function isRunnable(op: PendingScoreOperation, nowMs: number): boolean {
  if (op.state === 'conflict') return false;
  if (op.state === 'pending' || op.state === 'syncing') return true;
  // 'failed': only runnable once its backoff window has elapsed.
  return !op.nextRetryAt || new Date(op.nextRetryAt).getTime() <= nowMs;
}

async function submitOne(op: PendingScoreOperation): Promise<void> {
  await db.pendingScoreOperations.update(op.operationUuid, { state: 'syncing' });

  try {
    if (op.kind === 'correct') {
      const { data, error } = await supabase.rpc('correct_team_score', {
        p_operation_uuid: op.operationUuid,
        p_tournament_id: op.tournamentId,
        p_team_id: op.teamId,
        p_hole_number: op.holeNumber,
        p_new_strokes: op.newStrokes,
        p_change_reason: op.changeReason,
        p_device_timestamp: op.deviceTimestamp,
      });
      if (error) throw error;

      const row = data as TeamHoleScore | null;
      if (row) await writeConfirmedScore(row);
      await db.pendingScoreOperations.delete(op.operationUuid);
      return;
    }

    const { data, error } = await supabase.rpc('submit_team_score', {
      p_operation_uuid: op.operationUuid,
      p_tournament_id: op.tournamentId,
      p_team_id: op.teamId,
      p_hole_number: op.holeNumber,
      p_new_strokes: op.newStrokes,
      p_expected_revision: op.expectedRevision,
      p_device_timestamp: op.deviceTimestamp,
    });
    if (error) throw error;

    const result = data as SubmitScoreResult;
    if (result.status === 'ok') {
      await writeConfirmedScore(result.score);
      await db.pendingScoreOperations.delete(op.operationUuid);
    } else {
      await db.pendingScoreOperations.update(op.operationUuid, {
        state: 'conflict',
        lastError: null,
        nextRetryAt: null,
        conflictServerStrokes: result.server.strokes,
        conflictServerRevision: result.server.revision,
        conflictUpdatedByUserId: result.server.updated_by_user_id,
        conflictUpdatedByName: result.server.updated_by_name,
        conflictUpdatedAt: result.server.updated_at,
        conflictSubmittedStrokes: result.submitted.strokes,
      });
    }
  } catch (err) {
    const failureClass = classifyFailure(err);
    const retryCount = op.retryCount + 1;
    await db.pendingScoreOperations.update(op.operationUuid, {
      state: 'failed',
      lastError: err instanceof Error ? err.message : 'Sync failed',
      retryCount,
      nextRetryAt: failureClass === 'retryable' ? new Date(Date.now() + computeBackoffMs(retryCount)).toISOString() : null,
    });
  }
}

async function writeConfirmedScore(row: TeamHoleScore): Promise<void> {
  await db.cachedScores.put({
    id: scoreCacheKey(row.tournament_id, row.team_id, row.hole_number),
    tournamentId: row.tournament_id,
    teamId: row.team_id,
    holeNumber: row.hole_number,
    strokes: row.strokes,
    revision: row.revision,
    lastUpdatedByUserId: row.last_updated_by,
    updatedAt: row.updated_at,
  });
}

/**
 * Drains pendingScoreOperations in createdAt order over the submit/correct
 * RPCs. Each RPC call is idempotent on operation_uuid, so a resend after a
 * partial failure (e.g. the request succeeded server-side but the response
 * was lost) never double-applies a change. Unlike a naive queue, one
 * operation failing doesn't block the rest -- each hole is independent
 * server-side, so a stuck hole 7 shouldn't stop hole 8 from syncing.
 */
export async function flushQueue(): Promise<void> {
  if (flushing) return;

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    setState('offline');
    return;
  }

  flushing = true;
  setState('syncing');

  try {
    // Loop so operations coalesced/queued *during* this flush (e.g. the
    // user keeps tapping while a request for another hole is in flight)
    // get picked up before we give up the flushing lock, instead of
    // waiting for the next external trigger.
    for (;;) {
      const ops = await db.pendingScoreOperations.orderBy('createdAt').toArray();
      const runnable = ops.filter((op) => isRunnable(op, Date.now()));
      if (runnable.length === 0) break;

      for (const op of runnable) {
        await submitOne(op);
      }
    }
  } finally {
    flushing = false;
  }

  const remaining = await db.pendingScoreOperations.toArray();
  if (remaining.length === 0) {
    setState(typeof navigator !== 'undefined' && navigator.onLine ? 'synced' : 'offline');
  } else if (remaining.some((op) => op.state === 'conflict' || op.state === 'failed')) {
    setState('sync-failed');
  } else {
    setState('syncing');
  }
}

/** Manual "Retry Sync": clears backoff timers on failed operations and flushes immediately. Conflicts are left untouched -- those need a user decision, not a retry. */
export async function retrySyncNow(): Promise<void> {
  const failed = await db.pendingScoreOperations.where('state').equals('failed').toArray();
  await Promise.all(
    failed.map((op) => db.pendingScoreOperations.update(op.operationUuid, { nextRetryAt: null })),
  );
  await flushQueue();
}
