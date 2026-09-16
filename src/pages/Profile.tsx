import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { supabase } from '../lib/supabaseClient';
import { db } from '../lib/db';
import { clearPrivateCache } from '../lib/offlineCache';
import { retrySyncNow } from '../lib/sync';
import { useProfile } from '../hooks/useProfile';
import { useAuth } from '../auth/useAuth';
import { Avatar } from '../components/Avatar';
import styles from './Profile.module.css';

export function Profile() {
  const { user } = useAuth();
  const { data: profile, isLoading } = useProfile();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const pendingCount = useLiveQuery(
    () => db.pendingScoreOperations.where('state').anyOf(['pending', 'syncing', 'failed']).count(),
    [],
  );

  async function performSignOut() {
    await supabase.auth.signOut();
    // Only the read cache (a copy of server state) is cleared -- unsynced
    // score operations must survive logout so they can still sync once
    // someone is back online and authenticated on this device.
    await clearPrivateCache();
  }

  async function handleSignOut() {
    if (pendingCount) {
      setConfirmingSignOut(true);
      return;
    }
    await performSignOut();
  }

  async function handleRetryThenCheck() {
    setRetrying(true);
    await retrySyncNow();
    setRetrying(false);
  }

  if (isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  return (
    <div>
      <h1>Profile</h1>
      <Link to="/profile/edit" className={`card ${styles.card}`}>
        <Avatar
          name={profile ? `${profile.first_name} ${profile.last_name}` : ''}
          photoPath={profile?.photo_path}
          size="large"
        />
        <div className={styles.info}>
          <p className={styles.name}>
            {profile?.first_name} {profile?.last_name}
          </p>
          <p className={styles.username}>@{profile?.username}</p>
          <p className={styles.email}>{user?.email}</p>
        </div>
        <span className={styles.editChevron}>Edit ›</span>
      </Link>

      <Link to="/settings" className="btn btn-secondary">
        Settings
      </Link>

      {confirmingSignOut ? (
        <div className="card">
          <p>
            You have {pendingCount} score{pendingCount === 1 ? '' : 's'} that {pendingCount === 1 ? 'has' : 'have'}{' '}
            not synchronized. Logging out may prevent {pendingCount === 1 ? 'it' : 'them'} from being submitted.
          </p>
          <button type="button" className="btn btn-primary" disabled={retrying} onClick={() => void handleRetryThenCheck()}>
            {retrying ? 'Retrying…' : 'Retry Sync'}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void performSignOut()}>
            Log Out Anyway
          </button>
          <button type="button" className="btn btn-text btn-auto" onClick={() => setConfirmingSignOut(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => void handleSignOut()}>
          Sign Out
        </button>
      )}
    </div>
  );
}
