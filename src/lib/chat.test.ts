import { describe, expect, it } from 'vitest';
import { findUnreadSeparatorMessageId, formatMessageClockTime, validateMessageText } from './chat';

describe('validateMessageText', () => {
  it('rejects an empty string', () => {
    expect(validateMessageText('').valid).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    const result = validateMessageText('   \n\t  ');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it('trims before validating and returns the trimmed text', () => {
    const result = validateMessageText('  hello  ');
    expect(result.valid).toBe(true);
    expect(result.trimmed).toBe('hello');
  });

  it('accepts exactly 500 characters', () => {
    expect(validateMessageText('a'.repeat(500)).valid).toBe(true);
  });

  it('rejects 501 characters', () => {
    const result = validateMessageText('a'.repeat(501));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/500/);
  });
});

describe('findUnreadSeparatorMessageId', () => {
  const currentUserId = 'me';

  it('returns null when the chat has never been read (nothing to separate yet)', () => {
    const messages = [{ id: 'm1', created_at: '2026-07-19T10:00:00Z', sender_user_id: 'other' }];
    expect(findUnreadSeparatorMessageId(messages, null, currentUserId)).toBeNull();
  });

  it('finds the first message from someone else after the read marker', () => {
    const messages = [
      { id: 'm1', created_at: '2026-07-19T09:00:00Z', sender_user_id: 'other' }, // already read
      { id: 'm2', created_at: '2026-07-19T10:00:00Z', sender_user_id: 'other' }, // unread
      { id: 'm3', created_at: '2026-07-19T10:01:00Z', sender_user_id: 'other' },
    ];
    expect(findUnreadSeparatorMessageId(messages, '2026-07-19T09:30:00Z', currentUserId)).toBe('m2');
  });

  it('skips the reader\'s own messages when deciding where the separator goes', () => {
    const messages = [
      { id: 'm1', created_at: '2026-07-19T10:00:00Z', sender_user_id: 'me' }, // own message, never "unread"
      { id: 'm2', created_at: '2026-07-19T10:01:00Z', sender_user_id: 'other' },
    ];
    expect(findUnreadSeparatorMessageId(messages, '2026-07-19T09:30:00Z', currentUserId)).toBe('m2');
  });

  it('returns null when everything is already read', () => {
    const messages = [{ id: 'm1', created_at: '2026-07-19T09:00:00Z', sender_user_id: 'other' }];
    expect(findUnreadSeparatorMessageId(messages, '2026-07-19T10:00:00Z', currentUserId)).toBeNull();
  });
});

describe('formatMessageClockTime', () => {
  it('formats a timestamp as a clock time', () => {
    // Just assert it produces a plausible non-empty clock string -- exact
    // formatting is locale-dependent (Intl), not something to hardcode.
    expect(formatMessageClockTime('2026-07-19T10:42:00Z')).toMatch(/\d{1,2}:\d{2}/);
  });
});
