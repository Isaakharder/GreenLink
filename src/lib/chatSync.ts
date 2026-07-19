import { supabase } from './supabaseClient';
import { db, type PendingMessage } from './db';

// Purpose-built, much smaller than sync.ts's score queue: a chat message is
// create-only (no revision, no "expected prior value", nothing it could
// ever conflict with or need to coalesce into) -- send_tournament_message()
// is idempotent on operation_uuid, so the only job here is "keep retrying
// until it lands, exactly once." Connectivity itself is still read via
// `navigator.onLine` directly (same as sync.ts) rather than importing
// sync.ts's ConnectionBadge-facing state machine, which is intentionally
// score-sync-specific (its states like 'sync-failed' describe score sync).

const BACKOFF_SCHEDULE_MS = [2_000, 5_000, 15_000, 30_000];
const RETRY_POLL_INTERVAL_MS = 5_000;

function computeBackoffMs(retryCount: number): number {
  return BACKOFF_SCHEDULE_MS[Math.min(retryCount, BACKOFF_SCHEDULE_MS.length - 1)];
}

// Non-retryable: send_tournament_message() rejected the message for a
// reason that will still be true on the next attempt. Anything else is
// assumed transient and retried, same policy as sync.ts's classifyFailure.
const NON_RETRYABLE_PATTERNS = [
  'message cannot be empty',
  'message cannot be longer than',
  'only accepted tournament members',
  'messages can only be sent while the tournament is live',
  'authentication required',
  'permission denied',
  'tournament not found',
];

export type ChatFailureClass = 'retryable' | 'non-retryable';

export function classifyChatFailure(error: unknown): ChatFailureClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (NON_RETRYABLE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return 'non-retryable';
  }
  return 'retryable';
}

let flushPromise: Promise<void> | null = null;
let monitorInitialized = false;

/** Queues a message for send and opportunistically flushes. Returns the operation_uuid the caller can use to track/retry/cancel it. */
export async function queueMessage(tournamentId: string, messageText: string): Promise<string> {
  const operationUuid = crypto.randomUUID();
  await db.pendingMessages.put({
    operationUuid,
    tournamentId,
    messageText,
    createdAt: new Date().toISOString(),
    state: 'pending',
    lastError: null,
    retryCount: 0,
    nextRetryAt: null,
  });

  void flushMessageQueue();
  return operationUuid;
}

function isRunnable(op: PendingMessage, nowMs: number): boolean {
  if (op.state === 'pending' || op.state === 'sending') return true;
  // 'failed': only auto-retried once a backoff window has actually elapsed.
  // A non-retryable failure deliberately leaves nextRetryAt null (see
  // sendOne) to mean "terminal until the user explicitly retries" -- unlike
  // a retryable failure's populated nextRetryAt, a null one must NOT be
  // treated as "always due," or a permanently-rejected message would spin
  // the flush loop forever retrying the exact same rejection.
  if (op.state === 'failed') return op.nextRetryAt !== null && new Date(op.nextRetryAt).getTime() <= nowMs;
  return false;
}

async function sendOne(op: PendingMessage): Promise<void> {
  await db.pendingMessages.update(op.operationUuid, { state: 'sending' });

  try {
    const { error } = await supabase.rpc('send_tournament_message', {
      p_tournament_id: op.tournamentId,
      p_operation_uuid: op.operationUuid,
      p_message_text: op.messageText,
    });
    if (error) throw error;

    // The confirmed row arrives via the realtime channel (or the next
    // fetch) into cachedMessages -- this queue's only job was getting it
    // to the server safely, so the pending record is simply removed.
    await db.pendingMessages.delete(op.operationUuid);
  } catch (err) {
    const failureClass = classifyChatFailure(err);
    const retryCount = op.retryCount + 1;
    await db.pendingMessages.update(op.operationUuid, {
      state: 'failed',
      lastError: err instanceof Error ? err.message : 'Send failed',
      retryCount,
      nextRetryAt: failureClass === 'retryable' ? new Date(Date.now() + computeBackoffMs(retryCount)).toISOString() : null,
    });
  }
}

async function runFlush(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  for (;;) {
    const ops = await db.pendingMessages.orderBy('createdAt').toArray();
    const runnable = ops.filter((op) => isRunnable(op, Date.now()));
    if (runnable.length === 0) break;

    for (const op of runnable) {
      await sendOne(op);
    }
  }
}

/**
 * Drains pendingMessages (across every tournament, same "one global queue"
 * shape as sync.ts's flushQueue) in createdAt order. No coalescing: unlike
 * a score, a second message never supersedes a first one queued for the
 * same tournament, so every pending row is sent independently.
 *
 * Single-flight: a call made while a flush is already running awaits that
 * same in-flight run rather than silently no-op'ing, so "queue a message,
 * then await flushMessageQueue()" reliably means "the queue is drained (or
 * blocked on backoff) by the time this resolves" for every caller.
 */
export function flushMessageQueue(): Promise<void> {
  if (!flushPromise) {
    flushPromise = runFlush().finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

/** Manual "Not sent — retry": clears the backoff timer on a stuck message and flushes immediately. */
export async function retryMessage(operationUuid: string): Promise<void> {
  const op = await db.pendingMessages.get(operationUuid);
  if (!op) return;
  await db.pendingMessages.update(operationUuid, { nextRetryAt: null, state: 'pending' });
  void flushMessageQueue();
}

/** Wires the online listener + periodic backoff-retry poll for the chat queue. Safe to call more than once. */
export function initChatSyncMonitor(): void {
  if (monitorInitialized || typeof window === 'undefined') return;
  monitorInitialized = true;

  window.addEventListener('online', () => void flushMessageQueue());
  window.setInterval(() => void flushMessageQueue(), RETRY_POLL_INTERVAL_MS);

  void flushMessageQueue();
}
