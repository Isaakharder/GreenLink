import { formatMessageClockTime } from '../../lib/chat';
import type { ChatMessageDisplay } from '../../hooks/useTournamentChat';
import styles from './ChatPanel.module.css';

interface MessageRowProps {
  message: ChatMessageDisplay;
  onDelete: (messageId: string) => void;
  onRetry: (operationUuid: string) => void;
}

export function MessageRow({ message, onDelete, onRetry }: MessageRowProps) {
  return (
    <li className={`${styles.row} ${message.isOwn ? styles.own : ''}`}>
      <div className={styles.bubble}>
        <p className={styles.meta}>
          {message.senderName}
          {message.senderTeamName && <span className={styles.metaTeam}> · {message.senderTeamName}</span>}
          <span className={styles.metaTime}> · {formatMessageClockTime(message.createdAt)}</span>
        </p>
        {message.deletedAt ? (
          <p className={styles.removed}>Message removed</p>
        ) : (
          <p className={styles.text}>{message.messageText}</p>
        )}

        {message.failed && message.operationUuid && (
          <button type="button" className={styles.retry} onClick={() => onRetry(message.operationUuid!)}>
            Not sent — retry
          </button>
        )}
        {message.pending && !message.failed && <p className={styles.sending}>Sending…</p>}

        {message.canDelete && (
          <button type="button" className={styles.deleteButton} aria-label="Delete message" onClick={() => onDelete(message.id)}>
            ×
          </button>
        )}
      </div>
    </li>
  );
}
