// Integration tests for the golf-course-lookup Edge Function handler.
//
// Auth and the database are the REAL local Supabase instance (`supabase
// start`) -- only GolfCourseAPI itself is mocked, via a local HTTP server
// and the GOLFCOURSE_API_BASE_URL override that golfCourseApiClient.ts
// reads. The mock's fixture shapes (search/course-detail) have been checked
// against the real production API with a real key (see mapping.ts's header
// comment and golfCourseApiClient.ts) -- this suite verifies GreenLink's
// own handler logic (auth, caching, duplicate detection, error mapping)
// against that verified shape, not the live upstream itself, which is
// unsuitable for a repeatable automated suite (real quota, real network).
//
// Requires: `supabase start` running, and TEST_SUPABASE_URL /
// TEST_SUPABASE_ANON_KEY / TEST_SUPABASE_SERVICE_ROLE_KEY env vars set to
// that local instance's values (printed by `supabase start`).
//
// Run with: deno test --allow-net --allow-env supabase/functions/golf-course-lookup/index.deno.test.ts

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('TEST_SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON_KEY = Deno.env.get('TEST_SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = Deno.env.get('TEST_SUPABASE_SERVICE_ROLE_KEY');

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error('TEST_SUPABASE_ANON_KEY / TEST_SUPABASE_SERVICE_ROLE_KEY must be set (values printed by `supabase start`).');
}

Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_ANON_KEY', ANON_KEY);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
Deno.env.set('GOLFCOURSE_API_KEY', 'test-key');

const { handleRequest } = await import('./index.ts');

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function getTestUserToken(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const email = `edge-fn-test-${Date.now()}@example.test`;
  const password = 'edge-fn-test-password';
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Edge', last_name: 'Tester', username: `edge_fn_${Date.now()}` },
  });
  if (createError) throw createError;

  const anon = createClient(SUPABASE_URL, ANON_KEY!);
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error('sign-in failed');
  return data.session.access_token;
}

// Mock GolfCourseAPI server -- request handler is swapped per-test via a
// mutable ref so each test controls its own responses/counters.
let mockHandler: (req: Request) => Response | Promise<Response> = () => new Response('not configured', { status: 500 });
const mockServer = Deno.serve({ port: 0 }, (req) => mockHandler(req));
const mockBaseUrl = `http://127.0.0.1:${mockServer.addr.port}`;
Deno.env.set('GOLFCOURSE_API_BASE_URL', mockBaseUrl);

function courseDetailFixture(id: string) {
  return {
    id,
    club_name: 'Pinehurst Resort',
    course_name: 'Pinehurst No. 2',
    location: { address: '1 Carolina Vista Dr', city: 'Pinehurst', state: 'NC', country: 'USA' },
    tees: {
      male: [
        {
          tee_name: 'Blue',
          course_rating: 73.6,
          slope_rating: 138,
          par_total: 72,
          holes: Array.from({ length: 18 }, (_, i) => ({
            par: [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4][i],
            yardage: 380 + i * 5,
            handicap: ((i * 7) % 18) + 1,
          })),
        },
      ],
    },
  };
}

function request(action: string, params: Record<string, unknown>, token: string | null): Request {
  return new Request('http://localhost/golf-course-lookup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, ...params }),
  });
}

const token = await getTestUserToken();

Deno.test('rejects a request with no Authorization header, classified as unauthorized (not not_configured)', async () => {
  const res = await handleRequest(request('search', { query: 'pinehurst' }, null));
  assert(res.status === 401, `expected 401, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'unauthorized', `expected unauthorized, got ${body.error}`);
  assert(body.message.toLowerCase().includes('session'), `expected a session-specific message, got: ${body.message}`);
});

Deno.test('rejects a request with a malformed/invalid token, also classified as unauthorized', async () => {
  const res = await handleRequest(request('search', { query: 'pinehurst' }, 'this-is-not-a-real-jwt'));
  assert(res.status === 401, `expected 401, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'unauthorized', `expected unauthorized, got ${body.error}`);
});

Deno.test('search happy path returns mapped results without leaking the raw payload', async () => {
  mockHandler = (req) => {
    const url = new URL(req.url);
    assert(url.pathname === '/v1/search', `unexpected path ${url.pathname}`);
    return Response.json({
      courses: [
        { id: 999, club_name: 'Pinehurst Resort', course_name: 'Pinehurst No. 2', location: { city: 'Pinehurst', state: 'NC', country: 'USA' } },
      ],
    });
  };

  const res = await handleRequest(request('search', { query: 'pinehurst' }, token));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.results.length === 1, 'expected one search result');
  assert(body.results[0].externalId === '999', 'externalId mapped from numeric id');
  assert(body.results[0].city === 'Pinehurst', 'city carried through for disambiguation');
});

Deno.test('import happy path caches the course, tees, and holes', async () => {
  const externalId = `import-${Date.now()}`;
  let detailRequests = 0;
  mockHandler = (req) => {
    const url = new URL(req.url);
    if (url.pathname === `/v1/courses/${externalId}`) {
      detailRequests += 1;
      // Verified against the real API: /v1/courses/{id} wraps its result as
      // { course: {...} }, unlike /v1/search's bare { courses: [...] }.
      return Response.json({ course: courseDetailFixture(externalId) });
    }
    return new Response('not found', { status: 404 });
  };

  const res = await handleRequest(request('import', { externalId }, token));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.course.club_name === 'Pinehurst Resort', 'course row returned');
  assert(body.tees.length === 1, 'one tee returned');
  assert(body.tees[0].number_of_holes === 18, 'tee hole count mapped');
  assert(detailRequests === 1, 'called the mock upstream exactly once');

  // Verify actual DB rows, not just the response.
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: holes } = await db
    .from('golf_course_tee_holes')
    .select('*')
    .eq('tee_id', body.tees[0].id);
  assert(holes?.length === 18, `expected 18 hole rows, got ${holes?.length}`);

  // Duplicate detection: importing the same externalId again must not call
  // the mock upstream a second time.
  const res2 = await handleRequest(request('import', { externalId }, token));
  assert(res2.status === 200, `expected 200 on re-import, got ${res2.status}`);
  const body2 = await res2.json();
  assert(body2.course.id === body.course.id, 'reused the same cached course row');
  assert(detailRequests === 1, 'did not call GolfCourseAPI again for an already-cached course');
});

Deno.test('upstream 429 maps to a rate_limited message', async () => {
  mockHandler = () => new Response('rate limited', { status: 429 });
  const res = await handleRequest(request('search', { query: 'pinehurst' }, token));
  assert(res.status === 503, `expected 503, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'rate_limited', `expected rate_limited, got ${body.error}`);
  assert(typeof body.message === 'string' && body.message.length > 0, 'message present');
});

Deno.test('upstream 500 maps to an upstream_unavailable message', async () => {
  mockHandler = () => new Response('boom', { status: 500 });
  const res = await handleRequest(request('search', { query: 'pinehurst' }, token));
  assert(res.status === 503, `expected 503, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'upstream_unavailable', `expected upstream_unavailable, got ${body.error}`);
});

Deno.test('upstream network failure maps to an upstream_unavailable message', async () => {
  // Point at a port nothing is listening on.
  Deno.env.set('GOLFCOURSE_API_BASE_URL', 'http://127.0.0.1:1');
  const res = await handleRequest(request('search', { query: 'pinehurst' }, token));
  Deno.env.set('GOLFCOURSE_API_BASE_URL', mockBaseUrl);
  assert(res.status === 503, `expected 503, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'upstream_unavailable', `expected upstream_unavailable, got ${body.error}`);
});

Deno.test('an unexpected server-side error (e.g. a database problem) is classified as internal_error, not upstream_unavailable', async () => {
  // Simulate exactly the bug this classification was added for: the
  // service-role DB client fails for a reason that has nothing to do with
  // GolfCourseAPI. Swapping in a bad service-role key makes every query
  // inside handleImport() fail with a Postgres/PostgREST auth error --
  // an "unexpected" exception from this function's own point of view.
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'not-a-real-service-role-key');
  const externalId = `internal-error-${Date.now()}`;
  const res = await handleRequest(request('import', { externalId }, token));
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY!);

  assert(res.status === 500, `expected 500, got ${res.status}`);
  const body = await res.json();
  assert(body.error === 'internal_error', `expected internal_error, got ${body.error}`);
  assert(!body.message.toLowerCase().includes('jwt'), 'internal error details must not leak into the client message');
});

Deno.test({
  name: 'shut down mock server',
  fn: async () => {
    await mockServer.shutdown();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
