export const MAX_MESSAGE_LENGTH = 500;

export interface MessageValidation {
  valid: boolean;
  error: string | null;
  trimmed: string;
}

/**
 * Mirrors send_tournament_message()'s own trim/empty/length rules exactly
 * (supabase/migrations/0025) so the Send button can be disabled and a clear
 * error shown before ever round-tripping to the server -- the RPC is still
 * the actual enforcement point (never trust client-side-only validation),
 * this just keeps the UI honest about what it will accept.
 */
export function validateMessageText(text: string): MessageValidation {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Message cannot be empty.', trimmed };
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Message cannot be longer than ${MAX_MESSAGE_LENGTH} characters.`, trimmed };
  }
  return { valid: true, error: null, trimmed };
}

export interface UnreadSeparatorInput {
  id: string;
  created_at: string;
  sender_user_id: string;
}

/**
 * The id of the first message that should get an "New messages" divider
 * above it: the earliest message from someone else newer than the reader's
 * last-read snapshot. `messages` must be sorted ascending by created_at.
 * Returns null once there's nothing unread (including while lastReadAt is
 * null, i.e. the chat has never been opened -- everything is simply new,
 * not "separated").
 */
export function findUnreadSeparatorMessageId(
  messages: UnreadSeparatorInput[],
  lastReadAt: string | null,
  currentUserId: string | null,
): string | null {
  if (!lastReadAt) return null;
  const firstUnread = messages.find((m) => m.sender_user_id !== currentUserId && m.created_at > lastReadAt);
  return firstUnread?.id ?? null;
}

/** "10:42 AM" -- distinct from relativeTime.ts's "X minutes ago" phrasing, which doesn't fit a message transcript's clock-time convention. */
export function formatMessageClockTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
