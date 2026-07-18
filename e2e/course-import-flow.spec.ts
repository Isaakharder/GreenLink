import { expect, test, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedGolfCourseFixture, type SeededGolfCourse } from './seed';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

async function seedOrganizer() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now();
  const email = `e2e-course-import-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Ira', last_name: 'Importer', username: `e2e_import_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id };
}

/**
 * Intercepts calls to the golf-course-lookup Edge Function and answers them
 * with data referencing a real, pre-seeded golf_courses/golf_course_tees
 * fixture -- deterministic (no live GolfCourseAPI dependency, no quota
 * usage) while the *real* apply_imported_course_to_tournament RPC the
 * frontend calls afterward still operates on genuine rows. Also records
 * every request's Authorization header so the test can assert Create and
 * Settings send the same kind of token.
 */
function mockGolfCourseLookup(page: Page, fixture: SeededGolfCourse, capturedAuthHeaders: string[]) {
  return page.route('**/functions/v1/golf-course-lookup', async (route: Route) => {
    const request = route.request();
    capturedAuthHeaders.push(request.headers()['authorization'] ?? '');
    const body = JSON.parse(request.postData() ?? '{}');

    if (body.action === 'search') {
      await route.fulfill({
        json: {
          results: [
            {
              externalId: fixture.externalId,
              clubName: fixture.clubName,
              courseName: fixture.courseName,
              city: fixture.city,
              state: fixture.state,
              country: fixture.country,
            },
          ],
        },
      });
      return;
    }

    if (body.action === 'import') {
      await route.fulfill({
        json: {
          course: { id: 'mock-course-row', club_name: fixture.clubName, course_name: fixture.courseName, city: fixture.city, state: fixture.state, country: fixture.country },
          tees: [
            {
              id: fixture.teeId,
              tee_name: fixture.teeName,
              gender: 'male',
              number_of_holes: fixture.numberOfHoles,
              par_total: fixture.parTotal,
              course_rating: fixture.courseRating,
              slope_rating: fixture.slopeRating,
            },
          ],
        },
      });
      return;
    }

    await route.continue();
  });
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

test.describe('course import flow', () => {
  test('Create page: selecting a course requires a tee before continuing, and front-9 import populates holes 1-9 atomically', async ({ page }) => {
    const organizer = await seedOrganizer();
    const fixture = await seedGolfCourseFixture(organizer.userId);
    const capturedAuthHeaders: string[] = [];
    await mockGolfCourseLookup(page, fixture, capturedAuthHeaders);

    await signIn(page, organizer.email, organizer.password);
    await page.goto('/tournaments/new');

    await page.getByPlaceholder('Search by course or club name…').fill(fixture.clubName);
    await expect(page.getByText(fixture.clubName)).toBeVisible({ timeout: 10_000 });
    await page.getByText(fixture.clubName).first().click();

    // Selecting the search result stores the external id and imports it
    // (tee list appears) -- but nothing is "complete" without a tee yet.
    await expect(page.getByRole('button', { name: new RegExp(fixture.teeName) })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Create Tournament' })).toBeDisabled();

    // This is a 9-hole tournament; the fixture tee has 18 holes, so
    // choosing it must require an explicit front/back-9 choice.
    await page.selectOption('#holeCount', '9');
    await page.getByRole('button', { name: new RegExp(fixture.teeName) }).click();
    await expect(page.getByRole('button', { name: 'Use Front 9' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Tournament' })).toBeDisabled();

    await page.getByRole('button', { name: 'Use Front 9' }).click();
    await expect(page.getByRole('button', { name: 'Create Tournament' })).toBeEnabled();

    await page.fill('#name', `Front Nine Cup ${Date.now()}`);
    await page.fill('#tournamentDate', new Date().toISOString().slice(0, 10));
    await page.click('button[type=submit]');

    await page.waitForURL('**/overview');
    const tournamentId = page.url().match(/tournaments\/([0-9a-f-]+)\/overview/)?.[1];
    expect(tournamentId).toBeTruthy();

    // Verify the actual DB rows: front-9 slicing (hole numbers 1-9, par
    // from the fixture's original holes 1-9) and course provenance.
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: holes } = await db
      .from('tournament_holes')
      .select('hole_number, par')
      .eq('tournament_id', tournamentId)
      .order('hole_number');
    expect(holes?.map((h) => h.hole_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(holes?.[2].par).toBe(3); // fixture hole 3 is par 3

    const { data: tournamentRow } = await db.from('tournaments').select('golf_course_tee_id, course_rating, slope_rating').eq('id', tournamentId).single();
    expect(tournamentRow?.golf_course_tee_id).toBe(fixture.teeId);
    expect(tournamentRow?.course_rating).toBe(fixture.courseRating);
    expect(tournamentRow?.slope_rating).toBe(fixture.slopeRating);

    // Both the search and import calls carried a real bearer token.
    expect(capturedAuthHeaders.length).toBeGreaterThan(0);
    for (const header of capturedAuthHeaders) {
      expect(header).toMatch(/^Bearer .+/);
    }
  });

  test('Settings page: Import Course populates an existing tournament using the same auth path as Create', async ({ page }) => {
    const organizer = await seedOrganizer();
    const fixture = await seedGolfCourseFixture(organizer.userId);
    const capturedAuthHeaders: string[] = [];
    await mockGolfCourseLookup(page, fixture, capturedAuthHeaders);

    await signIn(page, organizer.email, organizer.password);

    // Create a plain manual (no course) 18-hole tournament first, matching
    // the fixture tee's hole count so this exercises the "direct apply"
    // path (no front/back-9 prompt).
    await page.goto('/tournaments/new');
    await page.fill('#name', `Settings Import Cup ${Date.now()}`);
    await page.fill('#courseName', 'Placeholder Course');
    await page.fill('#tournamentDate', new Date().toISOString().slice(0, 10));
    await page.selectOption('#holeCount', '18');
    await page.click('button[type=submit]');
    await page.waitForURL('**/overview');
    const tournamentId = page.url().match(/tournaments\/([0-9a-f-]+)\/overview/)?.[1];

    await page.goto(`/tournaments/${tournamentId}/settings`);
    await page.getByRole('button', { name: 'Import Course' }).click();
    await page.getByPlaceholder('Search by course or club name…').fill(fixture.clubName);
    await expect(page.getByText(fixture.clubName)).toBeVisible({ timeout: 10_000 });
    await page.getByText(fixture.clubName).first().click();

    await expect(page.getByText(new RegExp(fixture.teeName))).toBeVisible({ timeout: 10_000 });
    await page.getByText(new RegExp(fixture.teeName)).first().click();

    await expect(page.getByText(/Course setup populated — 18 holes imported/)).toBeVisible({ timeout: 10_000 });

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { count } = await db
      .from('tournament_holes')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);
    expect(count).toBe(18);

    expect(capturedAuthHeaders.length).toBeGreaterThan(0);
    for (const header of capturedAuthHeaders) {
      expect(header).toMatch(/^Bearer .+/);
    }
  });
});
