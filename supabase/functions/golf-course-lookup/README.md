# golf-course-lookup

Supabase Edge Function. The only place the GolfCourseAPI key is used —
it never reaches the browser or any `VITE_` environment variable.

## Actions

POST body, one of:

```json
{ "action": "search", "query": "pinehurst" }
{ "action": "import", "externalId": "18135" }
```

`search` calls GolfCourseAPI's search endpoint and returns a trimmed
summary per course (club name, course name, city/state/country) — enough
to tell similarly-named courses apart, without exposing the raw API
payload. `import` fetches full course/tee/hole detail and caches it into
`golf_courses` / `golf_course_tees` / `golf_course_tee_holes` (service-role
write, bypassing RLS — regular users can only `select` those tables). If
the course's `external_id` is already cached, GolfCourseAPI is **not**
called again; the existing rows are reused.

`verify_jwt = true` (set in `supabase/config.toml`) — only authenticated
GreenLink users can trigger a call, so the external API's rate limit isn't
exposed to anonymous traffic. A missing/expired/invalid session is
classified as `unauthorized` (`requireUserId()` in `index.ts`) — kept
distinct from `not_configured` (the *server's* `GOLFCOURSE_API_KEY` being
the problem), since conflating "your session expired" with "the admin
misconfigured the server" produces useless error messages.

## Error classification

Every failure returns `{ "error": "<kind>", "message": "<safe, specific text>" }`
with an appropriate HTTP status — never a single generic "unavailable" for
every possible cause:

| Kind | Status | Cause |
| --- | --- | --- |
| `unauthorized` | 401 | Caller's Supabase session missing/invalid |
| `not_configured` | 503 | `GOLFCOURSE_API_KEY` unset, or rejected by GolfCourseAPI (401/403 upstream) |
| `rate_limited` | 503 | GolfCourseAPI returned 429 |
| `upstream_unavailable` | 503 | GolfCourseAPI network failure or 5xx |
| `internal_error` | 500 | Any other unexpected exception (e.g. a missing table/column from an undeployed migration) — full detail goes to `console.error` only, the client response is deliberately generic so internals never leak, but the *kind* still tells you it's GreenLink's own bug, not GolfCourseAPI's availability |
| `invalid_request` | 400 | Malformed request body |

This distinction matters in practice, not just in theory: the production
incident this function was hardened for was exactly an `internal_error`
(missing hosted-DB migrations) being reported as a generic search-unavailable
message, which made it look like a flaky external API instead of a
deployment gap. See the root README's "Deploying" section.

## Required secret

| Name | Purpose |
| --- | --- |
| `GOLFCOURSE_API_KEY` | Sent as `Authorization: Key <value>` to GolfCourseAPI. Required — the function returns a `not_configured` error if unset. |

Set it with the Supabase CLI:

```sh
# Local development (supabase start)
supabase secrets set --env-file supabase/functions/.env.local GOLFCOURSE_API_KEY=your-key-here
# or directly:
supabase secrets set GOLFCOURSE_API_KEY=your-key-here

# Hosted project
supabase secrets set --project-ref <your-project-ref> GOLFCOURSE_API_KEY=your-key-here
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically
by the Supabase platform to every Edge Function — nothing to configure.

## Optional: `GOLFCOURSE_API_BASE_URL`

Overrides the upstream base URL (default `https://api.golfcourseapi.com`).
Only meant for pointing the function at a local mock during testing — see
`index.deno.test.ts`.

## Schema (verified against production)

Confirmed against the real GolfCourseAPI with a live key:

- `GET /v1/search?search_query=X` → `{ "courses": [{ id, club_name,
  course_name, location: { address, city, state, country, latitude,
  longitude }, tees: { male?, female? } }] }`. Search results already
  include each course's full tee/hole data.
- `GET /v1/courses/{id}` → **`{ "course": { ...same shape as above... } }`**
  — note the `course` wrapper; easy to miss, and the one real discrepancy
  found during verification (fixed in `golfCourseApiClient.ts`'s
  `getCourseDetail()`, which unwraps it — `mapping.ts` itself needed no
  changes, its field names were already correct).
- Each tee: `tee_name`, `course_rating` (numeric), `slope_rating`
  (integer), `par_total`, `number_of_holes` (9 or 18 — `holes.length`
  always matches), `holes: [{ par, yardage, handicap }]` ordered 1..N
  (hole number is array position, not an explicit field).
- Invalid/missing key → `401` `{ "error": "API Key is missing or invalid" }`
  (mapped to a `not_configured` response here). Unknown course id → `404`
  with a **plain-text**, non-JSON body (handled safely — the client never
  calls `.json()` on a non-ok response).

## Testing

- `mapping.ts` is plain TypeScript (no Deno APIs) and is unit-tested via
  Vitest too: `supabase/functions/golf-course-lookup/mapping.test.ts`
  (picked up by the root `npm run test`).
- `index.deno.test.ts` is a Deno integration test exercising the real
  handler against the real local Supabase auth/DB and a **mocked**
  GolfCourseAPI (a local HTTP server, wired in via `GOLFCOURSE_API_BASE_URL`).
  Never run against the real GolfCourseAPI service. Run with:

  ```sh
  supabase start   # local Postgres/Auth/Realtime/Functions
  TEST_SUPABASE_URL=http://127.0.0.1:54321 \
  TEST_SUPABASE_ANON_KEY=<publishable key from `supabase start`> \
  TEST_SUPABASE_SERVICE_ROLE_KEY=<secret key from `supabase start`> \
  deno test --allow-net --allow-env supabase/functions/golf-course-lookup/index.deno.test.ts
  ```

  Includes coverage for every error kind above, including a real
  `internal_error` case (a bad service-role key makes every DB call in
  `handleImport()` fail, the same failure mode as the production incident).

- `e2e/course-import-flow.spec.ts` (root `npm run e2e`) intercepts this
  function's HTTP calls via Playwright's `page.route()` — deterministic, no
  GolfCourseAPI dependency — while letting the real `apply_imported_course_
  to_tournament`/`create_tournament_with_course` RPCs run against a
  pre-seeded fixture, and asserts both `CreateTournament` and `SettingsTab`
  send the same `Authorization: Bearer` shape to this function.

- Type-check the Deno-authored files (not covered by `npm run typecheck`,
  which only checks `src/`/`e2e/`/`vite.config.ts` — Deno's global types
  don't belong in that project graph):

  ```sh
  deno check supabase/functions/golf-course-lookup/index.ts
  ```
