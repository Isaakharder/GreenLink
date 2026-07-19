import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { findUnreadSeparatorMessageId, validateMessageText } from '../../lib/chat';
import { retryMessage } from '../../lib/chatSync';
import { MessageRow } from './MessageRow';
import type { useTournamentChat } from '../../hooks/useTournamentChat';
import styles from './ChatPanel.module.css';

interface ChatPanelProps {
  chat: ReturnType<typeof useTournamentChat>;
  /** lastReadAt as it was the moment the panel opened -- captured before markRead() advances it, so the unread divider has a stable place to sit for this viewing session. */
  openedWithLastReadAt: string | null;
  currentUserId: string | null;
  onClose: () => void;
}

const SCROLL_BOTTOM_THRESHOLD_PX = 48;

export function ChatPanel({ chat, openedWithLastReadAt, currentUserId, onClose }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const separatorMessageId = useMemo(
    () =>
      findUnreadSeparatorMessageId(
        chat.messages.map((m) => ({ id: m.id, created_at: m.createdAt, sender_user_id: m.senderUserId })),
        openedWithLastReadAt,
        currentUserId,
      ),
    [chat.messages, openedWithLastReadAt, currentUserId],
  );

  function scrollToBottom() {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    // Initial open: always land at the newest message.
    scrollToBottom();
  }, []);

  useEffect(() => {
    if (!userScrolledUp) scrollToBottom();
  }, [chat.messages.length, userScrolledUp]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserScrolledUp(distanceFromBottom > SCROLL_BOTTOM_THRESHOLD_PX);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validation = validateMessageText(draft);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    setError(null);
    setDraft('');
    setUserScrolledUp(false);
    await chat.sendMessage(validation.trimmed);
  }

  const showComposer = chat.canSend;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>{chat.tournamentName}</h2>
          <button type="button" className={styles.closeButton} aria-label="Close chat" onClick={onClose}>
            ×
          </button>
        </div>

        {chat.availability === 'not-started' && <p className={styles.statusBanner}>Chat opens when the tournament starts.</p>}
        {chat.availability === 'completed' && <p className={styles.statusBanner}>Tournament completed — chat is read-only.</p>}
        {chat.usingCache && <p className={styles.statusBanner}>Offline — showing the last synced messages.</p>}

        <ul className={styles.list} ref={listRef} onScroll={handleScroll}>
          {chat.isLoading && <li className={styles.empty}>Loading messages…</li>}
          {!chat.isLoading && chat.messages.length === 0 && <li className={styles.empty}>No messages yet — say hello!</li>}
          {chat.messages.map((message) => (
            <Fragment key={message.id}>
              {message.id === separatorMessageId && (
                <li className={styles.separator}>
                  <span>New messages</span>
                </li>
              )}
              <MessageRow
                message={message}
                onDelete={(id) => void chat.deleteMessage(id)}
                onRetry={(operationUuid) => void retryMessage(operationUuid)}
              />
            </Fragment>
          ))}
        </ul>

        {showComposer ? (
          <form className={styles.composer} onSubmit={(event) => void handleSubmit(event)}>
            <input
              type="text"
              className={styles.input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the tournament…"
              maxLength={600}
              aria-label="Message"
            />
            <button type="submit" className="btn btn-primary btn-auto" disabled={draft.trim().length === 0}>
              Send
            </button>
          </form>
        ) : null}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
