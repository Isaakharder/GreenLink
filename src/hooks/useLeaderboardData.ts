import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { supabase } from '../lib/supabaseClient';
import { db } from '../lib/db';
import { cacheHoles, cacheScores, cacheTeams } from '../lib/offlineCache';
import { computeStandings, rankStandings, type RankedStanding } from '../lib/leaderboard';
import type { TeamHoleScore, TournamentHole, TournamentTeam } from '../types/database';

export type LiveStatus = 'live' | 'reconnecting' | 'offline';

async function fetchTeams(tournamentId: string): Promise<TournamentTeam[]> {
  const { data, error } = await supabase
    .from('tournament_teams')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('team_number', { ascending: true });
  if (error) throw error;
  return data ?? [];
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
 * Shared data + realtime source for both the Scorecard header ("2nd Place")
 * and the Live Score tab, so the fetch/cache/realtime-merge logic exists in
 * exactly one place. Realtime events are merged into the query cache in
 * place instead of triggering a full refetch, and a stale/out-of-order
 * event can never roll back a newer row (guarded by revision).
 */
export function useLeaderboardData(tournamentId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(
    typeof navigator !== 'undefined' && navigator.onLine ? 'reconnecting' : 'offline',
  );
  // Tracked separately from liveStatus (which also reflects the realtime
  // channel's own connectivity) because the cache-fallback decision below
  // needs a plain "is the browser offline right now" signal: TanStack
  // Query's default networkMode pauses queries while offline rather than
  // erroring them, so isError alone never becomes true offline and the
  // fallback would otherwise never engage.
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const teamsQuery = useQuery({
    queryKey: ['leaderboard-teams', tournamentId],
    queryFn: () => fetchTeams(tournamentId!),
    enabled: enabled && !!tournamentId,
  });
  const holesQuery = useQuery({
    queryKey: ['leaderboard-holes', tournamentId],
    queryFn: () => fetchHoles(tournamentId!),
    enabled: enabled && !!tournamentId,
  });
  const scoresQuery = useQuery({
    queryKey: ['leaderboard-scores', tournamentId],
    queryFn: () => fetchScores(tournamentId!),
    enabled: enabled && !!tournamentId,
  });

  useEffect(() => {
    if (tournamentId && teamsQuery.data) void cacheTeams(tournamentId, teamsQuery.data);
  }, [tournamentId, teamsQuery.data]);
  useEffect(() => {
    if (tournamentId && holesQuery.data) void cacheHoles(tournamentId, holesQuery.data);
  }, [tournamentId, holesQuery.data]);
  useEffect(() => {
    if (tournamentId && scoresQuery.data) void cacheScores(tournamentId, scoresQuery.data);
  }, [tournamentId, scoresQuery.data]);

  useEffect(() => {
    if (!enabled || !tournamentId) return;
    // Guard against React StrictMode's double-invoke creating two live
    // channels for the same tournament.
    if (channelRef.current) return;

    const channel = supabase
      .channel(`team-hole-scores-${tournamentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_hole_scores', filter: `tournament_id=eq.${tournamentId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as TeamHoleScore | undefined;
          if (!row) return;

          queryClient.setQueryData<TeamHoleScore[]>(['leaderboard-scores', tournamentId], (old) => {
            if (!old) return old;
            const index = old.findIndex((s) => s.team_id === row.team_id && s.hole_number === row.hole_number);
            if (index === -1) return [...old, row];
            // Never let a stale/out-of-order realtime event roll back a
            // newer optimistic-or-confirmed row already in the cache.
            if (old[index].revision > row.revision) return old;
            const next = [...old];
            next[index] = row;
            return next;
          });

          void cacheScores(tournamentId, [row]);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setLiveStatus('live');
        else if (status === 'TIMED_OUT') setLiveStatus('reconnecting');
        else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          setLiveStatus(typeof navigator !== 'undefined' && navigator.onLine ? 'reconnecting' : 'offline');
        }
      });

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [enabled, tournamentId, queryClient]);

  useEffect(() => {
    function handleOffline() {
      setLiveStatus('offline');
      setIsOffline(true);
    }
    function handleOnline() {
      setLiveStatus((prev) => (prev === 'offline' ? 'reconnecting' : prev));
      setIsOffline(false);
    }
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // Offline fallback: if the browser is offline, or the live queries
  // errored outright (e.g. denied/not-found rather than a network pause),
  // fall back to whatever was last cached.
  const usingCache = enabled && (isOffline || teamsQuery.isError || holesQuery.isError || scoresQuery.isError);

  const cachedTeams = useLiveQuery(
    () => (usingCache && tournamentId ? db.cachedTeams.where('tournamentId').equals(tournamentId).toArray() : []),
    [usingCache, tournamentId],
  );
  const cachedHoles = useLiveQuery(
    () => (usingCache && tournamentId ? db.cachedHoles.where('tournamentId').equals(tournamentId).sortBy('holeNumber') : []),
    [usingCache, tournamentId],
  );
  const cachedScoresRows = useLiveQuery(
    () => (usingCache && tournamentId ? db.cachedScores.where('tournamentId').equals(tournamentId).toArray() : []),
    [usingCache, tournamentId],
  );

  const teams: TournamentTeam[] = teamsQuery.data
    ?? (cachedTeams ?? []).map((t) => ({ id: t.id, tournament_id: t.tournamentId, name: t.name, team_number: t.teamNumber, created_at: '' }));
  const holes: TournamentHole[] = holesQuery.data
    ?? (cachedHoles ?? []).map((h) => ({ id: h.id, tournament_id: h.tournamentId, hole_number: h.holeNumber, par: h.par, stroke_index: h.strokeIndex, distance: h.distance, distance_unit: 'yards' as const }));
  const scores: TeamHoleScore[] = scoresQuery.data
    ?? (cachedScoresRows ?? []).map((s) => ({ id: s.id, tournament_id: s.tournamentId, team_id: s.teamId, hole_number: s.holeNumber, strokes: s.strokes, revision: s.revision, last_updated_by: s.lastUpdatedByUserId, updated_at: s.updatedAt, created_at: s.updatedAt }));

  const standings: RankedStanding[] = rankStandings(computeStandings(teams, holes, scores));

  return {
    teams,
    holes,
    scores,
    standings,
    liveStatus: usingCache ? 'offline' as const : liveStatus,
    isLoading: (teamsQuery.isLoading || holesQuery.isLoading || scoresQuery.isLoading) && !usingCache,
    usingCache,
  };
}
