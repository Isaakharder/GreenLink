import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('./supabaseClient', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { db } from './db';
import { classifyChatFailure, flushMessageQueue, queueMessage, retryMessage } from './chatSync';

describe('classifyChatFailure', () => {
  it.each([
    ['message cannot be empty'],
    ['message cannot be longer than 500 characters'],
    ['only accepted tournament members can send messages'],
    ['messages can only be sent while the tournament is live'],
    ['authentication required'],
    ['tournament not found'],
  ])('classifies "%s" as non-retryable', (message) => {
    expect(classifyChatFailure(new Error(message))).toBe('non-retryable');
  });

  it.each([['Failed to fetch'], ['NetworkError when attempting to fetch resource'], ['fetch failed']])(
    'classifies "%s" as retryable',
    (message) => {
      expect(classifyChatFailure(new Error(message))).toBe('retryable');
    },
  );

  it('treats an unrecognized error as retryable rather than stranding the message', () => {
    expect(classifyChatFailure(new Error('something odd happened'))).toBe('retryable');
  });
});

describe('queueMessage / flushMessageQueue', () => {
  beforeEach(async () => {
    vi.stubGlobal('navigator', { onLine: true });
    rpcMock.mockReset();
    await db.pendingMessages.clear();
  });

  it('queues a message and removes it once the send succeeds', async () => {
    rpcMock.mockResolvedValue({ data: { id: 'm1' }, error: null });

    const operationUuid = await queueMessage('t1', 'gg');
    await flushMessageQueue();

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('send_tournament_message', {
      p_tournament_id: 't1',
      p_operation_uuid: operationUuid,
      p_message_text: 'gg',
    });

    const pending = await db.pendingMessages.toArray();
    expect(pending).toHaveLength(0);
  });

  it('never sends the message twice on a resend -- the same operation_uuid is reused', async () => {
    let calls = 0;
    rpcMock.mockImplementation(() => {
      calls += 1;
      // First attempt fails (transient); the retry must reuse the same
      // operation_uuid, not mint a new one.
      if (calls === 1) return Promise.resolve({ data: null, error: new Error('Failed to fetch') });
      return Promise.resolve({ data: { id: 'm1' }, error: null });
    });

    const operationUuid = await queueMessage('t1', 'nice putt');
    await flushMessageQueue(); // first attempt: fails, scheduled for retry

    const afterFirstAttempt = await db.pendingMessages.get(operationUuid);
    expect(afterFirstAttempt?.state).toBe('failed');

    // A manual retry (as if the user tapped "Not sent — retry").
    await retryMessage(operationUuid);
    await flushMessageQueue();

    expect(calls).toBe(2);
    expect(rpcMock.mock.calls[0][1].p_operation_uuid).toBe(operationUuid);
    expect(rpcMock.mock.calls[1][1].p_operation_uuid).toBe(operationUuid);

    const pending = await db.pendingMessages.toArray();
    expect(pending).toHaveLength(0);
  });

  it('does not retry a non-retryable failure and leaves it without a scheduled retry', async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error('message cannot be empty') });

    const operationUuid = await queueMessage('t1', '   ');
    await flushMessageQueue();

    const op = await db.pendingMessages.get(operationUuid);
    expect(op?.state).toBe('failed');
    expect(op?.nextRetryAt).toBeNull();
  });

  it('sends independent messages for the same tournament as separate operations', async () => {
    rpcMock.mockResolvedValue({ data: { id: 'm1' }, error: null });

    await queueMessage('t1', 'first');
    await queueMessage('t1', 'second');
    await flushMessageQueue();

    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    rpcMock.mockResolvedValue({ data: { id: 'm1' }, error: null });

    await queueMessage('t1', 'hello?');
    await flushMessageQueue();

    expect(rpcMock).not.toHaveBeenCalled();
    const pending = await db.pendingMessages.toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0].state).toBe('pending');
  });
});
