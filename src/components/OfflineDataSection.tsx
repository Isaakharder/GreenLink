import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { computeDownloadStatus, downloadTournamentForOffline, removeCachedTournament, type OfflineReadiness } from '../lib/offlineDownload';
import { formatRelativeTime } from '../lib/relativeTime';
import { useAuth } from '../auth/useAuth';
import type { TournamentAccess } from '../hooks/useTournamentAccess';
import styles from './OfflineDataSection.module.css';

interface OfflineDataSectionProps {
  tournamentId: string;
}

const STATUS_LABEL: Record<OfflineReadiness, string> = {
  'not-downloaded': 'Not downloaded',
  downloading: 'Downloading…',
  ready: 'Ready for offline play',
  'update-available': 'Update available',
  failed: 'Download failed',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function OfflineDataSection({ tournamentId }: OfflineDataSectionProps) {
  const { user } = useAuth();
  const { tournament, fromCache } = useOutletContext<TournamentAccess>();
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState<string | null>(null);

  const cachedDownload = useLiveQuery(() => db.cachedDownloads.get(tournamentId), [tournamentId]);
  const pendingCount = useLiveQuery(
    () => db.pendingScoreOperations.where('tournamentId').equals(tournamentId).count(),
    [tournamentId],
  );
  const lastScoreSync = useLiveQuery(async () => {
    const scores = await db.cachedScores.where('tournamentId').equals(tournamentId).toArray();
    return scores.reduce<string | null>((latest, s) => (!latest || s.updatedAt > latest ? s.updatedAt : latest), null);
  }, [tournamentId]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    void navigator.storage.estimate().then((estimate) => {
      if (estimate.usage === undefined) return;
      const quotaText = estimate.quota ? ` of ~${formatBytes(estimate.quota)} available` : '';
      setStorageEstimate(`${formatBytes(estimate.usage)} used${quotaText}`);
    });
  }, []);

  // The live tournament's data_version is only a meaningful comparison
  // point when we actually reached the server this session -- when the
  // tournament itself came from the offline cache, there's nothing
  // fresher to compare a cached download against.
  const liveDataVersion = fromCache ? undefined : tournament?.data_version;
  const status: OfflineReadiness = downloading ? 'downloading' : computeDownloadStatus(cachedDownload, liveDataVersion);

  async function handleDownload() {
    if (!user) return;
    setDownloading(true);
    setActionError(null);
    try {
      await downloadTournamentForOffline(tournamentId, user.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Download failed. You can try again.');
    } finally {
      setDownloading(false);
    }
  }

  function handleRemoveClick() {
    if ((pendingCount ?? 0) > 0) {
      setConfirmingRemove(true);
      return;
    }
    if (window.confirm('Remove the offline copy of this tournament from this device?')) {
      void removeCachedTournament(tournamentId);
    }
  }

  async function handleConfirmRemove() {
    await removeCachedTournament(tournamentId);
    setConfirmingRemove(false);
  }

  return (
    <div className={`card ${styles.section}`}>
      <div className={styles.header}>
        <h2 className={styles.title}>Offline Data</h2>
        <span className={`${styles.statusBadge} ${styles[`status-${status}`] ?? ''}`}>{STATUS_LABEL[status]}</span>
      </div>

      {cachedDownload && (
        <dl className={styles.meta}>
          <div>
            <dt>Last downloaded</dt>
            <dd>{formatRelativeTime(cachedDownload.downloadedAt)}</dd>
          </div>
          <div>
            <dt>Cached holes</dt>
            <dd>{cachedDownload.holeCount}</dd>
          </div>
          <div>
            <dt>Cache version</dt>
            <dd>v{cachedDownload.cacheVersion}</dd>
          </div>
          {lastScoreSync && (
            <div>
              <dt>Last sync</dt>
              <dd>{formatRelativeTime(lastScoreSync)}</dd>
            </div>
          )}
        </dl>
      )}

      <dl className={styles.meta}>
        <div>
          <dt>Pending sync</dt>
          <dd>{pendingCount ?? 0}</dd>
        </div>
        {storageEstimate && (
          <div>
            <dt>Storage</dt>
            <dd>{storageEstimate}</dd>
          </div>
        )}
      </dl>

      {status === 'failed' && cachedDownload?.lastError && <p className="error-text">{cachedDownload.lastError}</p>}
      {actionError && <p className="error-text">{actionError}</p>}

      <div className={styles.actions}>
        {(status === 'not-downloaded' || status === 'failed') && (
          <button type="button" className="btn btn-primary" disabled={downloading || !user} onClick={() => void handleDownload()}>
            {downloading ? 'Downloading…' : status === 'failed' ? 'Retry Download' : 'Download for Offline Play'}
          </button>
        )}
        {status === 'update-available' && (
          <button type="button" className="btn btn-primary" disabled={downloading} onClick={() => void handleDownload()}>
            {downloading ? 'Updating…' : 'Update Now'}
          </button>
        )}
        {status === 'ready' && (
          <button type="button" className="btn btn-secondary btn-auto" disabled={downloading} onClick={() => void handleDownload()}>
            {downloading ? 'Updating…' : 'Refresh'}
          </button>
        )}
        {cachedDownload && (
          <button type="button" className="btn btn-text btn-auto" onClick={handleRemoveClick}>
            Remove Cached Tournament
          </button>
        )}
      </div>

      {confirmingRemove && (
        <div className={styles.confirmPanel}>
          <p>
            You have {pendingCount} score{pendingCount === 1 ? '' : 's'} that {pendingCount === 1 ? 'has' : 'have'} not
            synced yet. Removing cached data won&apos;t delete {pendingCount === 1 ? 'it' : 'them'}, but you
            won&apos;t be able to view this tournament offline until you re-download.
          </p>
          <button type="button" className="btn btn-danger" onClick={() => void handleConfirmRemove()}>
            Remove Anyway
          </button>
          <button type="button" className="btn btn-text btn-auto" onClick={() => setConfirmingRemove(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
