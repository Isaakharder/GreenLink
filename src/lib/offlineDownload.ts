import { supabase } from './supabaseClient';
import { db } from './db';
import {
  cacheHoles,
  cacheMembership,
  cachePlayers,
  cacheScores,
  cacheTeams,
  cacheTournament,
  removeCachedTournamentData,
  type RosterEntryInput,
} from './offlineCache';
import type { CachedDownload } from './db';
import type { TeamHoleScore, Tournament, TournamentHole, TournamentPlayer, TournamentTeam } from '../types/database';

export type OfflineReadiness = 'not-downloaded' | 'downloading' | 'ready' | 'update-available' | 'failed';

/**
 * Pure: derives the 5-state offline readiness display from what's
 * persisted (`cached`) and the live tournament's data_version, when known
 * (offline, liveDataVersion is undefined -- there's nothing to compare
 * against, so a 'ready' download just stays 'ready'). 'downloading' is
 * intentionally not produced here -- it's transient UI state the caller
 * layers on top while a download is in flight, not something persisted.
 */
export function computeDownloadStatus(cached: CachedDownload | undefined, liveDataVersion: number | undefined): OfflineReadiness {
  if (!cached) return 'not-downloaded';
  if (cached.status === 'failed') return 'failed';
  if (liveDataVersion !== undefined && liveDataVersion !== cached.cacheVersion) return 'update-available';
  return 'ready';
}

async function fetchTournament(tournamentId: string): Promise<Tournament> {
  const { data, error } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();
  if (error) throw error;
  return data;
}

async function fetchMembership(tournamentId: string, userId: string): Promise<TournamentPlayer | null> {
  const { data, error } = await supabase
    .from('tournament_players')
    .select('*')
    .eq('tournament_id', tournamentId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchTeams(tournamentId: string): Promise<TournamentTeam[]> {
  const { data, error } = await supabase.from('tournament_teams').select('*').eq('tournament_id', tournamentId);
  if (error) throw error;
  return data ?? [];
}

async function fetchRosterWithProfiles(tournamentId: string): Promise<RosterEntryInput[]> {
  const { data: players, error } = await supabase
    .from('tournament_players')
    .select('*')
    .eq('tournament_id', tournamentId)
    .eq('membership_status', 'accepted');
  if (error) throw error;
  if (!players || players.length === 0) return [];

  const userIds = [...new Set(players.map((p) => p.user_id))];
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('id', userIds);
  if (profilesError) throw profilesError;

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  return players
    .filter((player) => profileById.has(player.user_id))
    .map((player) => ({ player, profile: profileById.get(player.user_id)! }));
}

async function fetchHoles(tournamentId: string): Promise<TournamentHole[]> {
  const { data, error } = await supabase
    .from('tournament_holes')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('hole_number', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchScores(tournamentId: string): Promise<TeamHoleScore[]> {
  const { data, error } = await supabase.from('team_hole_scores').select('*').eq('tournament_id', tournamentId);
  if (error) throw error;
  return data ?? [];
}

/**
 * Everything needed for a tournament to be usable offline (requirement:
 * tournament, teams, players, permissions, course/tee/rating/slope, every
 * hole, current scores), fetched and written through in one explicit
 * action. On failure: if there's no usable prior successful download, a
 * 'failed' cachedDownloads row is written so the UI shows "Download
 * failed" instead of silently doing nothing; if a prior 'ready' download
 * exists, it's left untouched (still fully usable offline) and the error
 * is only rethrown for the caller to show transiently -- a failed refresh
 * must never regress "ready" back to "not usable".
 */
export async function downloadTournamentForOffline(tournamentId: string, userId: string): Promise<void> {
  const existing = await db.cachedDownloads.get(tournamentId);

  try {
    const [tournament, membership, teams, roster, holes, scores] = await Promise.all([
      fetchTournament(tournamentId),
      fetchMembership(tournamentId, userId),
      fetchTeams(tournamentId),
      fetchRosterWithProfiles(tournamentId),
      fetchHoles(tournamentId),
      fetchScores(tournamentId),
    ]);

    await cacheTournament(tournament);
    if (membership) await cacheMembership(tournamentId, userId, membership);
    await cacheTeams(tournamentId, teams);
    await cachePlayers(tournamentId, roster);
    await cacheHoles(tournamentId, holes);
    await cacheScores(tournamentId, scores);

    await db.cachedDownloads.put({
      tournamentId,
      status: 'ready',
      downloadedAt: new Date().toISOString(),
      cacheVersion: tournament.data_version,
      holeCount: holes.length,
      lastError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Download failed';
    if (!existing || existing.status !== 'ready') {
      await db.cachedDownloads.put({
        tournamentId,
        status: 'failed',
        downloadedAt: existing?.downloadedAt ?? new Date().toISOString(),
        cacheVersion: existing?.cacheVersion ?? 0,
        holeCount: existing?.holeCount ?? 0,
        lastError: message,
      });
    }
    throw err;
  }
}

/**
 * Best-effort background refresh, called right after an organizer mutation
 * (holes saved, course/tee imported, teams changed, tournament started).
 * A no-op if this tournament was never explicitly downloaded on this
 * device; failures are swallowed since this isn't a user-initiated action
 * the user is waiting on -- the existing cache (or "update available" on
 * other devices) is the fallback either way.
 */
export async function refreshIfDownloaded(tournamentId: string, userId: string): Promise<void> {
  const existing = await db.cachedDownloads.get(tournamentId);
  if (!existing) return;
  try {
    await downloadTournamentForOffline(tournamentId, userId);
  } catch {
    // Swallowed by design -- see doc comment above.
  }
}

/** Removes one tournament's cached data. Never touches pendingScoreOperations -- see offlineCache.removeCachedTournamentData. */
export async function removeCachedTournament(tournamentId: string): Promise<void> {
  await removeCachedTournamentData(tournamentId);
}
