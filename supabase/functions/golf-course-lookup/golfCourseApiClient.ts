import type { GolfCourseApiCourseDetail, GolfCourseApiSearchResponse } from './mapping.ts';

// Base URL is env-overridable specifically so integration tests can point
// this at a local mock server instead of the real GolfCourseAPI. The
// endpoints/response shapes here have been verified against the real
// production API with a real key: /v1/search returns { courses: [...] }
// (each course already including full tee/hole data), /v1/courses/{id}
// returns { course: {...} } (note the wrapper -- easy to miss).
const DEFAULT_BASE_URL = 'https://api.golfcourseapi.com';

// Every safe, distinct failure reason this function can report -- kept in
// sync with src/lib/golfCourseApi.ts's GolfCourseApiFailure['kind'] on the
// frontend. Deliberately specific rather than collapsing everything into
// one generic "unavailable": a schema/DB error (internal_error) and a
// missing session (unauthorized, thrown from index.ts, not here) must never
// be reported the same way as "GolfCourseAPI itself is down"
// (upstream_unavailable) -- that conflation is what made this bug look like
// a flaky search instead of a missing migration.
export type GolfCourseFailureKind =
  | 'unauthorized'
  | 'not_configured'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'internal_error';

export class GolfCourseApiError extends Error {
  constructor(
    message: string,
    public readonly kind: GolfCourseFailureKind,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GolfCourseApiError';
  }
}

function getBaseUrl(): string {
  return Deno.env.get('GOLFCOURSE_API_BASE_URL') || DEFAULT_BASE_URL;
}

function getApiKey(): string {
  const key = Deno.env.get('GOLFCOURSE_API_KEY');
  if (!key) {
    throw new GolfCourseApiError(
      'GOLFCOURSE_API_KEY is not configured on the server.',
      'not_configured',
      503,
    );
  }
  return key;
}

async function request<T>(path: string): Promise<T> {
  const apiKey = getApiKey();
  let response: Response;

  try {
    response = await fetch(`${getBaseUrl()}${path}`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
  } catch {
    throw new GolfCourseApiError(
      'GolfCourseAPI is unavailable right now. You can still enter the course by hand.',
      'upstream_unavailable',
      503,
    );
  }

  if (response.status === 429) {
    throw new GolfCourseApiError(
      'Course search is temporarily busy. Try again in a moment, or enter the course by hand.',
      'rate_limited',
      503,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new GolfCourseApiError(
      'The configured GOLFCOURSE_API_KEY was rejected by GolfCourseAPI. Check the secret and try again.',
      'not_configured',
      503,
    );
  }

  if (!response.ok) {
    throw new GolfCourseApiError(
      'GolfCourseAPI is unavailable right now. You can still enter the course by hand.',
      'upstream_unavailable',
      503,
    );
  }

  return (await response.json()) as T;
}

export function searchCourses(query: string): Promise<GolfCourseApiSearchResponse> {
  return request<GolfCourseApiSearchResponse>(`/v1/search?search_query=${encodeURIComponent(query)}`);
}

// Verified against the real API: unlike /v1/search (which returns
// { courses: [...] }), /v1/courses/{id} wraps its single result as
// { course: {...} } rather than returning the course object bare.
export async function getCourseDetail(externalId: string): Promise<GolfCourseApiCourseDetail> {
  const { course } = await request<{ course: GolfCourseApiCourseDetail }>(
    `/v1/courses/${encodeURIComponent(externalId)}`,
  );
  return course;
}
