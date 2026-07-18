import { supabase } from './supabaseClient';
import type { GolfCourseTee } from '../types/database';

// Thin client for the golf-course-lookup Edge Function -- the only place
// the GolfCourseAPI key exists. The frontend never talks to GolfCourseAPI
// directly and never sees the key.

export interface CourseSearchResult {
  externalId: string;
  clubName: string;
  courseName: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

export type ImportedCourseTee = Pick<
  GolfCourseTee,
  'id' | 'tee_name' | 'gender' | 'number_of_holes' | 'par_total' | 'course_rating' | 'slope_rating'
>;

export interface ImportedCourse {
  id: string;
  club_name: string;
  course_name: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

// Kept in sync with the Edge Function's GolfCourseFailureKind
// (supabase/functions/golf-course-lookup/golfCourseApiClient.ts), plus two
// kinds that can only ever be known client-side:
//   - network_offline: the browser has no connection at all -- checked
//     before even attempting the call, so the user gets an instant, honest
//     answer instead of waiting on a request that was never going to work.
//   - function_unavailable: supabase.functions.invoke() didn't get a
//     parseable response from the Edge Function at all (wrong project,
//     function not deployed, a network failure reaching Supabase itself)
//     -- distinct from the function running and reporting its own failure.
export interface GolfCourseApiFailure {
  kind:
    | 'unauthorized'
    | 'not_configured'
    | 'rate_limited'
    | 'upstream_unavailable'
    | 'internal_error'
    | 'network_offline'
    | 'function_unavailable'
    | 'invalid_request'
    | 'unknown';
  message: string;
}

const FAILURE_MESSAGES: Record<GolfCourseApiFailure['kind'], string> = {
  unauthorized: 'Your session has expired. Sign in again to search for a course.',
  not_configured: "Course search isn't configured right now. You can still enter the course by hand.",
  rate_limited: 'Course search is temporarily busy. Try again in a moment, or enter the course by hand.',
  upstream_unavailable: 'GolfCourseAPI is unavailable right now. You can still enter the course by hand.',
  internal_error: 'Something went wrong on our end. You can still enter the course by hand.',
  network_offline: "You're offline. Course search needs a connection -- you can still enter the course by hand.",
  function_unavailable: 'Course search is temporarily unreachable. You can still enter the course by hand.',
  invalid_request: 'That request was not understood.',
  unknown: 'Course search is unavailable right now. You can still enter the course by hand.',
};

export class GolfCourseSearchError extends Error implements GolfCourseApiFailure {
  kind: GolfCourseApiFailure['kind'];
  constructor(kind: GolfCourseApiFailure['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new GolfCourseSearchError('network_offline', FAILURE_MESSAGES.network_offline);
  }

  const { data, error } = await supabase.functions.invoke('golf-course-lookup', { body });

  if (error) {
    // FunctionsHttpError carries the parsed JSON body on `context` in
    // supabase-js v2 when the function actually ran and returned a
    // response; if that's absent, or doesn't parse into our expected
    // shape, the function itself couldn't be reached (function_unavailable)
    // rather than having reported a specific failure.
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = (await context.clone().json()) as Partial<GolfCourseApiFailure>;
        if (body.kind && body.message) {
          throw new GolfCourseSearchError(body.kind, body.message);
        }
      } catch (parseErr) {
        if (parseErr instanceof GolfCourseSearchError) throw parseErr;
        // fall through: response wasn't the expected JSON shape
      }
    }
    throw new GolfCourseSearchError('function_unavailable', FAILURE_MESSAGES.function_unavailable);
  }

  return data as T;
}

export async function searchGolfCourses(query: string): Promise<CourseSearchResult[]> {
  const { results } = await invoke<{ results: CourseSearchResult[] }>({ action: 'search', query });
  return results;
}

export async function importGolfCourse(externalId: string): Promise<{ course: ImportedCourse; tees: ImportedCourseTee[] }> {
  return invoke({ action: 'import', externalId });
}

/** "Pinehurst, NC" -- enough to distinguish similarly-named courses without cluttering the list. */
export function formatCourseLocation(result: Pick<CourseSearchResult, 'city' | 'state' | 'country'>): string {
  const parts = [result.city, result.state || result.country].filter((part): part is string => !!part);
  return parts.join(', ');
}

export function formatTeeSummary(tee: ImportedCourseTee): string {
  const parts = [
    `${tee.tee_name} (${tee.gender})`,
    `${tee.number_of_holes} holes`,
    tee.par_total !== null ? `par ${tee.par_total}` : null,
    tee.course_rating !== null && tee.slope_rating !== null ? `${tee.course_rating}/${tee.slope_rating}` : null,
  ].filter((part): part is string => !!part);
  return parts.join(' · ');
}
