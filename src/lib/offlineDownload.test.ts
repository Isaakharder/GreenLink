import { describe, expect, it } from 'vitest';
import { computeDownloadStatus } from './offlineDownload';
import type { CachedDownload } from './db';

function download(overrides: Partial<CachedDownload> = {}): CachedDownload {
  return {
    tournamentId: 't1',
    status: 'ready',
    downloadedAt: '2026-01-01T00:00:00Z',
    cacheVersion: 3,
    holeCount: 18,
    lastError: null,
    ...overrides,
  };
}

describe('computeDownloadStatus', () => {
  it('is not-downloaded when nothing has been cached', () => {
    expect(computeDownloadStatus(undefined, 5)).toBe('not-downloaded');
  });

  it('is not-downloaded even if a live version is known but nothing was ever downloaded', () => {
    expect(computeDownloadStatus(undefined, undefined)).toBe('not-downloaded');
  });

  it('is failed when the last download attempt failed, regardless of version', () => {
    expect(computeDownloadStatus(download({ status: 'failed' }), 3)).toBe('failed');
  });

  it('is ready when the cached version matches the live version', () => {
    expect(computeDownloadStatus(download({ cacheVersion: 3 }), 3)).toBe('ready');
  });

  it('is update-available when the live version has moved on', () => {
    expect(computeDownloadStatus(download({ cacheVersion: 3 }), 5)).toBe('update-available');
  });

  it('stays ready when offline (live version unknown) instead of falsely claiming an update is available', () => {
    expect(computeDownloadStatus(download({ cacheVersion: 3 }), undefined)).toBe('ready');
  });
});
