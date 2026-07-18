import { useConnectionState } from '../hooks/useConnectionState';
import { retrySyncNow } from '../lib/sync';
import styles from './ConnectionBadge.module.css';

const LABELS: Record<string, string> = {
  offline: 'Offline',
  online: 'Online',
  syncing: 'Syncing…',
  synced: 'All scores synced',
  'sync-failed': 'Could not sync. Tap to retry.',
};

export function ConnectionBadge() {
  const state = useConnectionState();

  if (state === 'sync-failed') {
    return (
      <button
        type="button"
        className={`${styles.badge} ${styles[state] ?? ''} ${styles.retryable}`}
        onClick={() => void retrySyncNow()}
      >
        <span className={styles.dot} aria-hidden="true" />
        {LABELS[state]}
      </button>
    );
  }

  return (
    <span className={`${styles.badge} ${styles[state] ?? ''}`}>
      <span className={styles.dot} aria-hidden="true" />
      {LABELS[state] ?? state}
    </span>
  );
}
