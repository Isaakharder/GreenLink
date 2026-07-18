// Pure data mapping between the external GolfCourseAPI response shape and
// GreenLink's own cache-table row shapes. No Deno/network/Supabase APIs are
// used anywhere in this file on purpose: it's imported both by the Edge
// Function (Deno) and directly by Vitest (Node) so the exact same mapping
// logic is unit-tested without needing a Deno runtime or a live API call.
//
// NOTE: field names verified against the real production GolfCourseAPI
// (https://api.golfcourseapi.com -- /v1/search and /v1/courses/{id}) with a
// live key -- no changes were needed here; the one real discrepancy found
// was response *envelope* shape (/v1/courses/{id} wraps its result as
// { course: {...} }), which is handled in golfCourseApiClient.ts, not here.

export interface GolfCourseApiLocation {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface GolfCourseApiSearchResult {
  id: number | string;
  club_name: string;
  course_name: string;
  location?: GolfCourseApiLocation | null;
}

export interface GolfCourseApiSearchResponse {
  courses: GolfCourseApiSearchResult[];
}

export interface GolfCourseApiHole {
  par: number;
  yardage?: number | null;
  handicap?: number | null;
}

export interface GolfCourseApiTee {
  tee_name: string;
  course_rating?: number | null;
  slope_rating?: number | null;
  number_of_holes: number;
  par_total?: number | null;
  holes: GolfCourseApiHole[];
}

export interface GolfCourseApiCourseDetail {
  id: number | string;
  club_name: string;
  course_name: string;
  location?: GolfCourseApiLocation | null;
  tees?: {
    male?: GolfCourseApiTee[] | null;
    female?: GolfCourseApiTee[] | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Search results -> frontend display summary. Enough to distinguish
// similarly-named courses (club name, course name, city/state/country) per
// requirement 3, without leaking the raw API payload to the client.
// ---------------------------------------------------------------------------

export interface CourseSearchSummary {
  externalId: string;
  clubName: string;
  courseName: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

export function toSearchSummary(course: GolfCourseApiSearchResult): CourseSearchSummary {
  return {
    externalId: String(course.id),
    clubName: course.club_name,
    courseName: course.course_name,
    city: course.location?.city ?? null,
    state: course.location?.state ?? null,
    country: course.location?.country ?? null,
  };
}

// ---------------------------------------------------------------------------
// Course detail -> cache table rows.
// ---------------------------------------------------------------------------

export interface GolfCourseRow {
  external_id: string;
  club_name: string;
  course_name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  raw_payload: GolfCourseApiCourseDetail;
}

export function toGolfCourseRow(detail: GolfCourseApiCourseDetail): GolfCourseRow {
  return {
    external_id: String(detail.id),
    club_name: detail.club_name,
    course_name: detail.course_name,
    address: detail.location?.address ?? null,
    city: detail.location?.city ?? null,
    state: detail.location?.state ?? null,
    country: detail.location?.country ?? null,
    raw_payload: detail,
  };
}

export interface TeeInput {
  gender: 'male' | 'female';
  tee: GolfCourseApiTee;
}

/** Flattens tees.male/tees.female into one list, tagging each with gender. Tees with an unsupported hole count (not 9 or 18) are dropped rather than failing the whole import. */
export function flattenTees(detail: GolfCourseApiCourseDetail): TeeInput[] {
  const male = (detail.tees?.male ?? []).map((tee) => ({ gender: 'male' as const, tee }));
  const female = (detail.tees?.female ?? []).map((tee) => ({ gender: 'female' as const, tee }));
  return [...male, ...female].filter(({ tee }) => tee.holes.length === 9 || tee.holes.length === 18);
}

export interface GolfCourseTeeRow {
  tee_name: string;
  gender: 'male' | 'female';
  number_of_holes: number;
  par_total: number | null;
  course_rating: number | null;
  slope_rating: number | null;
}

export function toGolfCourseTeeRow({ gender, tee }: TeeInput): GolfCourseTeeRow {
  return {
    tee_name: tee.tee_name,
    gender,
    number_of_holes: tee.holes.length,
    par_total: tee.par_total ?? null,
    course_rating: tee.course_rating ?? null,
    slope_rating: tee.slope_rating ?? null,
  };
}

export interface GolfCourseTeeHoleRow {
  hole_number: number;
  par: number;
  yardage: number | null;
  handicap: number | null;
}

/** GolfCourseAPI's `holes` array is ordered 1..N with no explicit hole_number field, so position in the array is the hole number. */
export function toGolfCourseTeeHoleRows(tee: GolfCourseApiTee): GolfCourseTeeHoleRow[] {
  return tee.holes.map((hole, index) => ({
    hole_number: index + 1,
    par: hole.par,
    yardage: hole.yardage ?? null,
    handicap: hole.handicap ?? null,
  }));
}
