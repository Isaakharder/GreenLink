import { useNavigate } from 'react-router-dom';
import { useToasts } from '../hooks/useToasts';
import { dismissToast } from '../lib/toast';
import styles from './ToastHost.module.css';

/** Global, non-blocking toast stack -- mounted once in AppShell. Tapping a chat toast's action navigates to that tournament; the player opens the chat button themselves from there (deliberately not an imperative "force the panel open" hook, to keep this store generic and not chat-specific). */
export function ToastHost() {
  const toasts = useToasts();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.tone]}`}>
          <div className={styles.content}>
            <p className={styles.title}>{toast.title}</p>
            {toast.body && <p className={styles.body}>{toast.body}</p>}
          </div>
          {toast.action && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                const tournamentId = toast.action?.context?.tournamentId;
                if (typeof tournamentId === 'string') navigate(`/tournaments/${tournamentId}/overview`);
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
