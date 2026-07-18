import { useConnectionState } from '../hooks/useConnectionState';
import styles from './OfflineBanner.module.css';

export function OfflineBanner() {
  const state = useConnectionState();

  if (state !== 'offline') return null;

  return (
    <p className={styles.banner} role="status">
      Offline — scores will upload automatically when your connection returns.
    </p>
  );
}
