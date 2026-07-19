import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/useAuth';
import type { Tournament } from '../types/database';

export interface RecentCourse {
  golfCourseId: string;
  golfCourseTeeId: string;
  courseName: string;
}

const MAX_RECENT_COURSES = 5;

async function fetchMyRounds(userId: string): Promise<Tournament[]> {
  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .eq('organizer_user_id', userId)
    .eq('is_personal', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Rounds the player has started, most recent first: the in-progress round to resume (if any), completed rounds for "Recent Rounds", and the courses/tees behind them for "Recent Courses" -- selecting one skips straight to the tee already played there. */
export function useMyGolfRounds() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['my-golf-rounds', user?.id],
    queryFn: () => fetchMyRounds(user!.id),
    enabled: !!user,
  });

  const rounds = query.data;
  const liveRound = rounds?.find((r) => r.status === 'live') ?? null;
  const recentRounds = rounds?.filter((r) => r.status === 'completed') ?? [];

  const recentCourses = useMemo<RecentCourse[]>(() => {
    const seen = new Set<string>();
    const courses: RecentCourse[] = [];
    for (const round of rounds ?? []) {
      if (!round.golf_course_id || !round.golf_course_tee_id) continue;
      if (seen.has(round.golf_course_id)) continue;
      seen.add(round.golf_course_id);
      courses.push({
        golfCourseId: round.golf_course_id,
        golfCourseTeeId: round.golf_course_tee_id,
        courseName: round.course_name,
      });
      if (courses.length >= MAX_RECENT_COURSES) break;
    }
    return courses;
  }, [rounds]);

  return {
    isLoading: query.isLoading,
    isError: query.isError,
    liveRound,
    recentRounds,
    recentCourses,
    refetch: () => void queryClient.invalidateQueries({ queryKey: ['my-golf-rounds', user?.id] }),
  };
}
