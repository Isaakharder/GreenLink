// Supabase Edge Function: the only place the GolfCourseAPI key is ever
// used. `verify_jwt` defaults to true for this function (see
// supabase/config.toml), so the platform rejects unauthenticated requests
// before this code runs at all -- protecting the external API's rate limit
// from anonymous abuse. Two actions, one function:
//   { "action": "search", "query": string }
//   { "action": "import", "externalId": string }
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  flattenTees,
  fromLocalCourseSearchRow,
  mergeCourseSearchResults,
  toGolfCourseRow,
  toGolfCourseTeeHoleRows,
  toGolfCourseTeeRow,
  toSearchSummary,
  type LocalCourseSearchRow,
} from './mapping.ts';
import { GolfCourseApiError, getCourseDetail, searchCourses } from './golfCourseApiClient.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function serviceRoleClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function requireUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    // Distinct from 'not_configured' (a server-side GOLFCOURSE_API_KEY
    // problem) -- this is the caller's own Supabase session being missing,
    // expired, or otherwise invalid. Conflating the two under one label was
    // part of what made a real bug here look like "search is flaky".
    throw new GolfCourseApiError('Your session has expired. Sign in again to search for a course.', 'unauthorized', 401);
  }
  return data.user.id;
}

// GreenLink's own course library (manual + future bulk-imported courses,
// supabase/migrations/0027) -- searched via search_courses() so it's
// matched the same way GolfCourseAPI results are (club/course name, city,
// state, country) and ranked ahead of them. Failure here degrades to
// GolfCourseAPI-only results rather than failing the whole search --
// GreenLink's own library being briefly unreachable shouldn't take down
// course search entirely.
async function searchLocalCourses(query: string) {
  try {
    const db = serviceRoleClient();
    const { data, error } = await db.rpc('search_courses', { p_query: query, p_limit: 20 });
    if (error) throw error;
    return ((data ?? []) as LocalCourseSearchRow[]).map(fromLocalCourseSearchRow);
  } catch (err) {
    console.error('golf-course-lookup: search_courses failed, continuing with GolfCourseAPI results only', err);
    return [];
  }
}

async function handleSearch(query: string): Promise<Response> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return json({ results: [] });
  }

  // Run both concurrently, but GolfCourseAPI being rate-limited, down, or
  // misconfigured must never hide the user's own GreenLink course library
  // -- that's local, always-reliable data. Only propagate the
  // GolfCourseApiError (the friendly, specific message the frontend
  // already renders) when the local library search *also* found nothing,
  // so a real API outage doesn't look like a silent empty search when
  // local results could have answered it on their own.
  const [localOutcome, apiOutcome] = await Promise.allSettled([searchLocalCourses(trimmed), searchCourses(trimmed)]);
  const localResults = localOutcome.status === 'fulfilled' ? localOutcome.value : [];

  if (apiOutcome.status === 'rejected') {
    if (localResults.length > 0) {
      console.error('golf-course-lookup: GolfCourseAPI search failed, continuing with GreenLink library results only', apiOutcome.reason);
      return json({ results: mergeCourseSearchResults(localResults, []) });
    }
    throw apiOutcome.reason;
  }

  const apiResults = apiOutcome.value.courses.map(toSearchSummary);
  return json({ results: mergeCourseSearchResults(localResults, apiResults) });
}

async function handleImport(externalId: string, importedBy: string): Promise<Response> {
  const db = serviceRoleClient();

  // Reuse: if this course was already imported by anyone, return the
  // cached tees without ever calling GolfCourseAPI again. archived_at is
  // null here on purpose (not just on the tees below): an archived
  // golf_courses row (e.g. a known-broken duplicate cleaned up in 0030) is
  // exactly the case where the cache must NOT be trusted -- GolfCourseAPI
  // may have since started returning real data for that same external_id,
  // and silently replaying old, empty cached tees for it would reproduce
  // the Orchard View incident every time someone selects that result.
  // Falling through to a fresh GolfCourseAPI fetch below and re-upserting
  // (which also clears archived_at) is what lets that external_id recover
  // once the upstream data does.
  const { data: existingCourse, error: existingError } = await db
    .from('golf_courses')
    .select('id, club_name, course_name, city, state, country')
    .eq('external_id', externalId)
    .is('archived_at', null)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existingCourse) {
    // archived_at is null: a tee superseded by an edit (see
    // replace_manual_course_tees(), 0027) must never be re-offered for a
    // new round -- its replacement, if any, is what should be selectable.
    const { data: tees, error: teesError } = await db
      .from('golf_course_tees')
      .select('id, tee_name, gender, number_of_holes, par_total, course_rating, slope_rating')
      .eq('golf_course_id', existingCourse.id)
      .is('archived_at', null);
    if (teesError) throw teesError;
    return json({ course: existingCourse, tees: tees ?? [] });
  }

  const detail = await getCourseDetail(externalId);
  const courseRow = toGolfCourseRow(detail);

  // published_at: a golfcourseapi import has no draft/publish workflow (that's
  // manual-course-only, see 0028) -- it's always immediately searchable, the
  // same as every row before 0028 was, backfilled the same way in 0030. Not
  // stamping this here was itself part of the Orchard View regression: it
  // meant search_courses() could never find a course imported after 0028
  // shipped, no matter how complete its data was.
  // archived_at: null -- clears it if this external_id was previously
  // archived (see the existingCourse lookup above). Refreshing raw_payload/
  // city/etc from a fresh fetch and un-archiving in the same upsert is what
  // lets a once-broken duplicate recover once GolfCourseAPI's own data for
  // it does, instead of staying permanently archived.
  const { data: insertedCourse, error: insertCourseError } = await db
    .from('golf_courses')
    .upsert(
      { ...courseRow, imported_by: importedBy, published_at: new Date().toISOString(), archived_at: null },
      { onConflict: 'external_id' },
    )
    .select('id, club_name, course_name, city, state, country')
    .single();
  if (insertCourseError) throw insertCourseError;

  const teeInputs = flattenTees(detail);
  const tees: { id: string; tee_name: string; gender: string; number_of_holes: number; par_total: number | null; course_rating: number | null; slope_rating: number | null }[] = [];

  for (const teeInput of teeInputs) {
    const teeRow = toGolfCourseTeeRow(teeInput);

    // Not a plain .upsert({ onConflict: 'golf_course_id,tee_name,gender' }):
    // 0027 replaced the unique constraint those three columns used to have
    // with a *partial* unique index (golf_course_tees_current_name_gender_idx,
    // `where archived_at is null`) so an archived predecessor never blocks
    // re-adding a tee with the same name. Postgres' ON CONFLICT can't target
    // a partial index by column list alone, so that upsert stopped matching
    // any real constraint the moment 0027 shipped -- it would throw on the
    // very first tee of any course whose golf_course_tees insert actually
    // ran (a brand-new import, or -- as found while fixing the Orchard View
    // incident -- a re-import of a previously-archived duplicate now that
    // GolfCourseAPI returns real tee data for it again). Select-then-insert-
    // or-update against the *current* tee explicitly instead.
    const { data: currentTee } = await db
      .from('golf_course_tees')
      .select('id')
      .eq('golf_course_id', insertedCourse.id)
      .eq('tee_name', teeRow.tee_name)
      .eq('gender', teeRow.gender)
      .is('archived_at', null)
      .maybeSingle();

    const teeQuery = currentTee
      ? db.from('golf_course_tees').update(teeRow).eq('id', currentTee.id)
      : db.from('golf_course_tees').insert({ ...teeRow, golf_course_id: insertedCourse.id });
    const { data: insertedTee, error: teeError } = await teeQuery
      .select('id, tee_name, gender, number_of_holes, par_total, course_rating, slope_rating')
      .single();
    if (teeError) throw teeError;

    const holeRows = toGolfCourseTeeHoleRows(teeInput.tee).map((row) => ({ ...row, tee_id: insertedTee.id }));
    const { error: holesError } = await db
      .from('golf_course_tee_holes')
      .upsert(holeRows, { onConflict: 'tee_id,hole_number' });
    if (holesError) throw holesError;

    tees.push(insertedTee);
  }

  return json({ course: insertedCourse, tees });
}

// Exported separately from the Deno.serve() call below so integration
// tests can invoke the handler directly (in-process, against a mock
// upstream) without needing a real listening server or a live GolfCourseAPI
// key.
export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const userId = await requireUserId(req);
    const body = await req.json();

    if (body.action === 'search' && typeof body.query === 'string') {
      return await handleSearch(body.query);
    }
    if (body.action === 'import' && typeof body.externalId === 'string') {
      return await handleImport(body.externalId, userId);
    }

    return json({ error: 'invalid_request', message: 'Unrecognized request.' }, 400);
  } catch (err) {
    if (err instanceof GolfCourseApiError) {
      return json({ error: err.kind, message: err.message }, err.status);
    }
    // Anything else is unexpected -- e.g. a database error (a missing
    // table/column from an undeployed migration, exactly like the bug this
    // classification was added for). Full detail goes to the server log
    // only; the client gets a generic-but-honestly-labeled message so it's
    // never confused with "GolfCourseAPI is down" or "search is flaky" --
    // internal_error means "something is broken on GreenLink's side",
    // which is the actionable signal an operator needs to see.
    console.error('golf-course-lookup: unexpected error', err);
    return json(
      { error: 'internal_error', message: 'Something went wrong on our end. You can still enter the course by hand.' },
      500,
    );
  }
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
