import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { supabase } from '../lib/supabaseClient';
import { db, membershipCacheKey } from '../lib/db';
import { cacheMembership, cacheTournament } from '../lib/offlineCache';
import { useAuth } from '../auth/useAuth';
import type { Tournament, TournamentPlayer } from '../types/database';

export interface TournamentAccess {
  tournament: Tournament | null;
  membership: TournamentPlayer | null;
  isOrganizer: boolean;
  isAcceptedMember: boolean;
  canViewLiveScore: boolean;
  isLoading: boolean;
  isError: boolean;
  /** True when tournament/membership came from the offline cache rather than a live fetch. */
  fromCache: boolean;
  /** When fromCache is true, when that cached copy was last refreshed while online. */
  cachedAt: string | null;
  /** True only when nothing could be loaded either live or from cache (never opened this tournament on this device while online). */
  neverCachedOffline: boolean;
}

export function useTournamentAccess(tournamentId: string | undefined): TournamentAccess {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // So a status flip to `live` (or `completed`) shows up immediately for
  // every open tab/device without a manual refresh, since it can be
  // triggered by the organizer from a different session than the one
  // looking at this tournament right now.
  useEffect(() => {
    if (!tournamentId) return;

    const channel = supabase
      .channel(`tournament-${tournamentId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tournamentId}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tournamentId, queryClient]);

  const tournamentQuery = useQuery({
    queryKey: ['tournament', tournamentId],
    queryFn: async (): Promise<Tournament | null> => {
      const { data, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', tournamentId as string)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!tournamentId,
  });

  const membershipQuery = useQuery({
    queryKey: ['tournament-membership', tournamentId, user?.id],
    queryFn: async (): Promise<TournamentPlayer | null> => {
      const { data, error } = await supabase
        .from('tournament_players')
        .select('*')
        .eq('tournament_id', tournamentId as string)
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!tournamentId && !!user,
  });

  // Write-through: every successful live fetch refreshes the offline copy.
  useEffect(() => {
    if (tournamentQuery.data) void cacheTournament(tournamentQuery.data);
  }, [tournamentQuery.data]);

  useEffect(() => {
    if (tournamentId && user && membershipQuery.data) {
      void cacheMembership(tournamentId, user.id, membershipQuery.data);
    }
  }, [tournamentId, user, membershipQuery.data]);

  // TanStack Query's default networkMode pauses queries while offline
  // rather than erroring them, so a cold start offline (this hook's
  // queries never having run before, e.g. reopening the installed PWA with
  // no signal) would otherwise leave isError false forever and the
  // cache fallback below would never engage.
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  useEffect(() => {
    function handleOffline() {
      setIsOffline(true);
    }
    function handleOnline() {
      setIsOffline(false);
    }
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  const needsFallback = isOffline || tournamentQuery.isError || membershipQuery.isError;

  const cachedTournament = useLiveQuery(
    () => (needsFallback && tournamentId ? db.cachedTournaments.get(tournamentId) : undefined),
    [needsFallback, tournamentId],
  );
  const cachedMembership = useLiveQuery(
    () =>
      needsFallback && tournamentId && user
        ? db.cachedMemberships.get(membershipCacheKey(tournamentId, user.id))
        : undefined,
    [needsFallback, tournamentId, user],
  );

  const fromCache = needsFallback && !!cachedTournament;
  const tournament: Tournament | null = tournamentQuery.data
    ? tournamentQuery.data
    : fromCache && cachedTournament
      ? {
          id: cachedTournament.id,
          organizer_user_id: cachedTournament.organizerUserId,
          name: cachedTournament.name,
          course_name: cachedTournament.courseName,
          tournament_date: cachedTournament.tournamentDate,
          hole_count: cachedTournament.holeCount,
          scoring_format: cachedTournament.scoringFormat,
          team_size: cachedTournament.teamSize,
          description: null,
          status: cachedTournament.status,
          started_at: cachedTournament.startedAt,
          completed_at: cachedTournament.completedAt,
          created_at: cachedTournament.cachedAt,
          updated_at: cachedTournament.cachedAt,
          golf_course_id: cachedTournament.golfCourseId ?? null,
          golf_course_tee_id: cachedTournament.golfCourseTeeId ?? null,
          course_rating: cachedTournament.courseRating ?? null,
          slope_rating: cachedTournament.slopeRating ?? null,
          data_version: cachedTournament.dataVersion ?? 1,
        }
      : null;

  const membership: TournamentPlayer | null = membershipQuery.data
    ? membershipQuery.data
    : fromCache && cachedMembership
      ? {
          id: cachedMembership.id,
          tournament_id: cachedMembership.tournamentId,
          user_id: cachedMembership.userId,
          team_id: cachedMembership.teamId,
          membership_status: cachedMembership.membershipStatus,
          is_organizer: cachedMembership.isOrganizer,
          joined_at: cachedTournament?.cachedAt ?? new Date(0).toISOString(),
        }
      : null;

  const isAcceptedMember = membership?.membership_status === 'accepted';
  const isOrganizer = Boolean(membership?.is_organizer) || tournament?.organizer_user_id === user?.id;
  const canViewLiveScore =
    isAcceptedMember && !!tournament && (tournament.status === 'live' || tournament.status === 'completed');

  return {
    tournament,
    membership,
    isOrganizer,
    isAcceptedMember,
    canViewLiveScore,
    isLoading: (tournamentQuery.isLoading || membershipQuery.isLoading) && !fromCache,
    isError: needsFallback && !fromCache,
    fromCache,
    cachedAt: fromCache ? (cachedTournament?.cachedAt ?? null) : null,
    neverCachedOffline: needsFallback && !cachedTournament,
  };
}
