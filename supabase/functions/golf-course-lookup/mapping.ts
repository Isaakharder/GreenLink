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
  // GolfCourseAPI's real /v1/search response includes each course's full
  // tee/hole data (see golfCourseApiClient.ts) -- typed optional here
  // defensively, so a result missing this field (an API change, or a
  // provider quirk) degrades to 'unknown' rather than a wrong guess.
  tees?: {
    male?: GolfCourseApiTee[] | null;
    female?: GolfCourseApiTee[] | null;
  } | null;
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
// Usable-tee determination -- shared by search-result marking and the
// import path's own tee filtering, so both agree on what "usable" means: a
// tee GreenLink's scoring engine can actually run a round on (9 or 18
// holes, every hole has a real par). Rating/slope/yardage/gender stay
// optional -- the scoring system doesn't need them.
// ---------------------------------------------------------------------------

export function isTeeUsable(tee: GolfCourseApiTee): boolean {
  if (tee.holes.length !== 9 && tee.holes.length !== 18) return false;
  return tee.holes.every((hole) => typeof hole.par === 'number' && Number.isFinite(hole.par) && hole.par > 0);
}

export function hasUsableTees(tees: GolfCourseApiCourseDetail['tees'] | undefined | null): boolean {
  return countUsableTees(tees) > 0;
}

/** How many of a course's tees (male + female) actually pass isTeeUsable() -- used both for the 'usable'/'unusable' label and as part of a search result's identity, so "one incomplete tee, one valid tee" is never collapsed into a flat unusable verdict. */
export function countUsableTees(tees: GolfCourseApiCourseDetail['tees'] | undefined | null): number {
  const male = tees?.male ?? [];
  const female = tees?.female ?? [];
  return [...male, ...female].filter(isTeeUsable).length;
}

export type ScorecardStatus = 'usable' | 'unusable' | 'unknown';

/**
 * Best-effort usability signal from a *search* result. GolfCourseAPI's real
 * /v1/search response includes each course's tee data (confirmed against
 * production), but this stays defensive: if `tees` is altogether absent
 * from a given result, that's 'unknown' -- never a false 'unusable' label
 * on a course GreenLink simply couldn't check yet.
 */
export function scorecardStatusFromSearchResult(course: GolfCourseApiSearchResult): ScorecardStatus {
  if (course.tees === undefined) return 'unknown';
  return hasUsableTees(course.tees) ? 'usable' : 'unusable';
}

// ---------------------------------------------------------------------------
// Search results -> frontend display summary. Enough to distinguish
// similarly-named courses (club name, course name, city/state/country) per
// requirement 3, without leaking the raw API payload to the client.
//
// courseId/externalProvider/usableTeeCount are a result's *identity* (see
// mergeCourseSearchResults() below): courseId is set only when this result
// is backed by a GreenLink golf_courses row (any source -- manual, bulk
// -imported, or a previously-cached GolfCourseAPI import), so the frontend
// always knows exactly which row it selected instead of re-deriving it from
// display text. externalProvider names the upstream API a result *also*
// exists in, independent of whether it's currently local.
// ---------------------------------------------------------------------------

export type CourseSearchSource = 'golfcourseapi' | 'manual' | 'imported';

export interface CourseSearchSummary {
  externalId: string;
  clubName: string;
  courseName: string;
  city: string | null;
  state: string | null;
  country: string | null;
  scorecardStatus: ScorecardStatus;
  source: CourseSearchSource;
  courseId: string | null;
  externalProvider: 'golfcourseapi' | null;
  usableTeeCount: number;
}

export function toSearchSummary(course: GolfCourseApiSearchResult): CourseSearchSummary {
  const usableTeeCount = course.tees === undefined ? 0 : countUsableTees(course.tees);
  return {
    externalId: String(course.id),
    clubName: course.club_name,
    courseName: course.course_name,
    city: course.location?.city ?? null,
    state: course.location?.state ?? null,
    country: course.location?.country ?? null,
    scorecardStatus: scorecardStatusFromSearchResult(course),
    source: 'golfcourseapi',
    courseId: null,
    externalProvider: 'golfcourseapi',
    usableTeeCount,
  };
}

// ---------------------------------------------------------------------------
// GreenLink's own course library (search_courses() RPC, supabase/migrations/
// 0027) -> the same CourseSearchSummary shape GolfCourseAPI results use, so
// the frontend renders both identically (plus a small source label) and
// merge/dedupe logic below can treat them uniformly.
// ---------------------------------------------------------------------------

export interface LocalCourseSearchRow {
  id: string;
  external_id: string;
  club_name: string;
  course_name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string;
  has_usable_tee: boolean;
  usable_tee_count: number;
}

export function fromLocalCourseSearchRow(row: LocalCourseSearchRow): CourseSearchSummary {
  // row.source is GreenLink's own source label straight from golf_courses'
  // check constraint ('golfcourseapi' | 'manual' | 'imported') -- passed
  // through as-is now that search_courses() (0030) returns previously
  // -cached GolfCourseAPI imports too. Collapsing everything that isn't
  // 'imported' into 'manual' (the old behavior) mislabeled those cached
  // rows and lost their external provider, which is exactly the identity
  // information requirement 3 is about.
  const source = (row.source === 'golfcourseapi' || row.source === 'imported' ? row.source : 'manual') as CourseSearchSource;
  return {
    externalId: row.external_id,
    clubName: row.club_name,
    courseName: row.course_name,
    city: row.city,
    state: row.state,
    country: row.country,
    scorecardStatus: row.usable_tee_count > 0 ? 'usable' : 'unusable',
    source,
    courseId: row.id,
    externalProvider: source === 'golfcourseapi' ? 'golfcourseapi' : null,
    usableTeeCount: row.usable_tee_count,
  };
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

function courseMatchKey(course: Pick<CourseSearchSummary, 'clubName' | 'courseName'>): string {
  return `${normalizeForMatch(course.clubName)}|${normalizeForMatch(course.courseName)}`;
}

/**
 * Merges GreenLink's own course library (manual courses, bulk-imported
 * courses, and previously-cached GolfCourseAPI imports -- search_courses()
 * as of 0030 returns all three, closing the gap that let a complete,
 * already-played course go permanently unmatched against a later duplicate
 * search result) ahead of a fresh GolfCourseAPI search.
 *
 * Two distinct dedup rules, both deliberately conservative:
 *
 * 1. Exact identity: an API result sharing a local result's exact
 *    external_id isn't "possibly the same course" -- it *is* the same
 *    golf_courses row, re-offered by a fresh live search. Always dropped in
 *    favor of the local copy (which carries courseId and, once imported,
 *    never needs another GolfCourseAPI round trip).
 *
 * 2. Exact name match, never a fuzzy guess: within results sharing the
 *    exact same (case/whitespace-insensitive) club name *and* course name,
 *    a result with zero usable tees is dropped when another result under
 *    that same exact name has at least one -- regardless of which side
 *    (local or API) is complete. This deliberately does NOT match on club
 *    name (or club+city) alone: two GolfCourseAPI search results can share
 *    a club name while being genuinely different, currently-playable
 *    layouts at a multi-course club (e.g. Deer Run Golf Club's "Buck/Doe"
 *    and "Doe/Fawn" -- confirmed distinct, both real, during this
 *    investigation) -- collapsing those would hide a real course exactly
 *    the way this bug hid Orchard View's real one. A result whose course
 *    name doesn't exactly match anything else is always kept, complete or
 *    not, and left distinguishable by source/courseId rather than merged.
 */
export function mergeCourseSearchResults(local: CourseSearchSummary[], api: CourseSearchSummary[]): CourseSearchSummary[] {
  const localExternalIds = new Set(local.map((course) => course.externalId));
  const apiWithoutExactDuplicates = api.filter((course) => !localExternalIds.has(course.externalId));

  const combined = [...local, ...apiWithoutExactDuplicates];
  const usableMatchKeys = new Set(combined.filter((course) => course.scorecardStatus === 'usable').map(courseMatchKey));
  return combined.filter((course) => course.scorecardStatus !== 'unusable' || !usableMatchKeys.has(courseMatchKey(course)));
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

/**
 * Flattens tees.male/tees.female into one list, tagging each with gender.
 * Tees that aren't usable (see isTeeUsable(): wrong hole count, or any hole
 * missing a real par) are dropped rather than failing the whole import --
 * this also protects the DB insert below, since golf_course_tee_holes.par
 * is NOT NULL and a raw API null would otherwise surface as an opaque
 * internal_error instead of "this tee has no usable data".
 */
export function flattenTees(detail: GolfCourseApiCourseDetail): TeeInput[] {
  const male = (detail.tees?.male ?? []).map((tee) => ({ gender: 'male' as const, tee }));
  const female = (detail.tees?.female ?? []).map((tee) => ({ gender: 'female' as const, tee }));
  return [...male, ...female].filter(({ tee }) => isTeeUsable(tee));
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
