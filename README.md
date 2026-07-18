# GreenLink

Offline-first golf tournament scoring PWA. React + TypeScript + Vite
frontend, Supabase (Postgres + Auth + Realtime + Edge Functions) backend.

## Setup

```sh
npm install
cp .env.example .env   # fill in your Supabase project's URL + anon key
npm run dev
```

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `.env` (frontend) | Supabase project URL. Public. |
| `VITE_SUPABASE_ANON_KEY` | `.env` (frontend) | Supabase anon/public key. Public — never the service_role key. |
| `GOLFCOURSE_API_KEY` | Supabase Edge Function secret (server-side only) | GolfCourseAPI key, used exclusively by `supabase/functions/golf-course-lookup`. **Never** put this in `.env`/`VITE_*`, source code, or a commit — it must not reach the browser. |

### Configuring `GOLFCOURSE_API_KEY`

```sh
# Local development (supabase start)
supabase secrets set GOLFCOURSE_API_KEY=your-real-key-here

# Hosted project
supabase link --project-ref <your-project-ref>
supabase secrets set --project-ref <your-project-ref> GOLFCOURSE_API_KEY=your-real-key-here

# Confirm it's set (only a digest is shown, never the value)
supabase secrets list
```

If the secret isn't set, the Edge Function doesn't crash — search/import
requests return a `not_configured` response with a message the frontend
shows inline ("Course search isn't configured... enter the course by
hand"), and manual course/hole entry keeps working normally either way.

## Database

Migrations live in `supabase/migrations/`, applied in order. Local
development uses the Supabase CLI + Docker:

```sh
supabase start      # first time / after a stop
supabase db reset   # apply all migrations fresh
supabase test db    # run the pgTAP suite (supabase/tests/database/)
```

**Deploying to the hosted project requires its own push — deploying the
Edge Function does *not* deploy the database schema it depends on:**

```sh
supabase link --project-ref <your-project-ref>   # once
supabase db push --linked                        # applies any migrations the hosted DB is missing
supabase migration list --linked                  # sanity check: Local and Remote columns should match
```

This project shipped a real incident from skipping this step: the
`golf-course-lookup` function and its `GOLFCOURSE_API_KEY` secret were
deployed and working, but `supabase db push` had never been run, so
`golf_courses`/`golf_course_tees`/`golf_course_tee_holes` and
`apply_imported_course_to_tournament()` didn't exist on the hosted DB.
Search worked (it touches no table); import failed with a Postgres "relation
does not exist" error, which — before the error-classification fix below
— was reported to the user as a generic "search unavailable" message.
Always run `supabase migration list --linked` after deploying a function
that depends on new migrations, and check the *Remote* column.

## Edge Functions

```sh
supabase functions serve                              # serve locally against the local DB
supabase functions deploy golf-course-lookup           # deploy to the linked hosted project
```

Deploying does **not** deploy secrets — set `GOLFCOURSE_API_KEY` on the
target project separately (see above) before or after deploying; the
function reads it at request time via `Deno.env.get`, no redeploy needed
when it changes. See `supabase/functions/golf-course-lookup/README.md` for
the function's request shape, error classification, and testing notes.

## How course caching works

1. **Search** (`CreateTournament`/`SettingsTab` → `golf-course-lookup` Edge
   Function → GolfCourseAPI `/v1/search`) — read-only, returns club/course
   name + city/state/country for the organizer to tell similarly-named
   courses apart. Nothing is written to the database yet.
2. **Import** — the organizer picks a search result; the Edge Function
   checks `golf_courses.external_id` first. If that course was already
   imported (by anyone, for any tournament), the cached rows are reused and
   **GolfCourseAPI is not called again**. Otherwise it fetches
   `/v1/courses/{id}` and caches the course, its tees (`golf_course_tees`),
   and every tee's holes (`golf_course_tee_holes`, par/yardage/handicap) —
   shared, non-tournament-scoped reference data, readable by any
   authenticated user but writable only by the Edge Function (service-role
   key, bypassing RLS).
3. **Apply to a tournament** — the organizer picks a tee;
   `apply_imported_course_to_tournament()` **copies** that tee's holes into
   the tournament's own `tournament_holes` (via the same
   `save_tournament_holes()` used by manual entry) and records
   `course_rating`/`slope_rating`/provenance on the `tournaments` row
   itself. This is a one-time copy, not a live reference — editing or
   re-importing the shared cached course later **never** changes a
   tournament that already imported from it. The organizer can still
   hand-correct any imported hole in the same editable grid used for manual
   entry, any time before the tournament starts.

Selecting a search result is never treated as a completed import by
itself — it stores the external course id and shows a tee list, but
nothing is imported into a tournament until a tee is chosen too (on
`CreateTournament`, the Create button stays disabled until then). On the
Create page, choosing a tee and submitting calls
`create_tournament_with_course()`, which wraps `create_tournament()` and
`apply_imported_course_to_tournament()` in one transaction — if the import
half fails (an incompatible hole count, a stale tee id), **the whole call
rolls back**, so a failed import never leaves behind a tournament with
blank placeholder holes. A tee with 18 holes applied to a 9-hole
tournament requires picking front or back nine explicitly (front = holes
1-9, back = holes 10-18 renumbered 1-9); any other mismatch is rejected.

Manual course/hole entry is always available as a fallback and is never
disabled by a GolfCourseAPI outage, rate limit, or missing key.

### Error messages

The Edge Function classifies every failure into one of several safe,
specific reasons instead of a single generic message — surfaced verbatim
by the frontend:

| Kind | Meaning | Shown as |
| --- | --- | --- |
| `unauthorized` | The caller's Supabase session is missing/invalid | "Your session has expired. Sign in again..." |
| `not_configured` | `GOLFCOURSE_API_KEY` missing or rejected by GolfCourseAPI | "Course search isn't configured..." |
| `rate_limited` | GolfCourseAPI returned 429 | "Course search is temporarily busy..." |
| `upstream_unavailable` | GolfCourseAPI network/5xx failure | "GolfCourseAPI is unavailable right now..." |
| `internal_error` | An unexpected server-side error (e.g. a schema mismatch) | "Something went wrong on our end..." (full detail logged server-side only, never sent to the client) |
| `network_offline` | The browser has no connection (checked client-side before even calling out) | "You're offline..." |
| `function_unavailable` | The Edge Function itself couldn't be reached (wrong project, not deployed, network failure) | "Course search is temporarily unreachable..." |

Every one of these keeps manual course/hole entry fully usable.

## How offline tournament downloads work

Tournament scoring never depends on GolfCourseAPI or a live connection.
Each tournament tracks a `data_version` counter (bumped by triggers
whenever holes, teams, roster, or course/tee/rating setup changes — **not**
by routine score submissions, which already sync continuously through
their own offline queue). The **Offline Data** section (Overview / Results
tab) drives an explicit download:

- **Download for Offline Play** fetches the tournament, teams, roster,
  every hole (par/stroke index/distance), course rating/slope, and current
  scores, and writes them into IndexedDB (Dexie) in one action, recording
  the `data_version` it downloaded at.
- Five states: **Not downloaded**, **Downloading**, **Ready for offline
  play**, **Update available** (the live `data_version` has moved past what
  was downloaded), **Download failed**.
- Auto-refresh: after the organizer saves holes, imports a course/tee,
  corrects the rating, changes teams, or starts the tournament, this
  device's own download silently re-syncs if one already exists — other
  devices see "Update available" next time they're online.
- **Pending score operations are never touched** by a download, a refresh,
  or removing a cached tournament — that queue is a separate, independent
  Dexie table and is only ever cleared once the server confirms it.
- Removing a cached tournament while scores are still unsynced requires
  explicit confirmation (a plain confirm when nothing is pending, a
  detailed warning when something is).

With no signal, an already-downloaded tournament fully supports: opening
the tournament, viewing every hole, viewing/entering scores (queued for
sync), and viewing the leaderboard — all from IndexedDB, zero network
requests.

## Tests

| Command | Covers |
| --- | --- |
| `npm run test` | Vitest — pure frontend logic (`src/lib/**/*.test.ts`) plus the Edge Function's pure mapping logic (`supabase/functions/**/*.test.ts`, excluding `*.deno.test.ts`) |
| `supabase test db` | pgTAP — RLS and SECURITY DEFINER function behavior |
| `deno test --allow-net --allow-env supabase/functions/golf-course-lookup/index.deno.test.ts` | Edge Function integration test (real local Supabase auth/DB, mocked GolfCourseAPI) |
| `deno check supabase/functions/golf-course-lookup/index.ts` | Type-checks the Deno-authored Edge Function code (outside `npm run typecheck`'s project graph on purpose — different global types) |
| `npm run e2e` | Playwright — browser-driven flows against a local Supabase instance (see `e2e/seed.ts`). `e2e/course-import-flow.spec.ts` mocks only the Edge Function's HTTP responses (`page.route`) against a real pre-seeded course fixture, so it exercises the real `apply_imported_course_to_tournament`/`create_tournament_with_course` RPCs and captures both Create's and Settings' outgoing requests to directly assert they use the same auth path. |

## Build

```sh
npm run typecheck
npm run lint
npm run build
```
