import styles from './ChatFab.module.css';

interface ChatFabProps {
  unreadCount: number;
  readOnly: boolean;
  onClick: () => void;
}

/** Floating action button, bottom-right, positioned above BottomNav -- never over ScorecardTab's score-entry controls, which live in the normal scrolling content flow, not fixed to the viewport. */
export function ChatFab({ unreadCount, readOnly, onClick }: ChatFabProps) {
  return (
    <button type="button" className={styles.fab} onClick={onClick} aria-label={readOnly ? 'View tournament chat (read-only)' : 'Open tournament chat'}>
      <span aria-hidden="true">💬</span>
      {unreadCount > 0 && <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
    </button>
  );
}
