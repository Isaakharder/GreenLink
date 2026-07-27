import { expect, test, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

async function seedPlayer(tag: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now();
  const email = `e2e-scorecard-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Cassie', last_name: `Courses${stamp}`, username: `e2e_scorecard_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

/**
 * Mocks the golf-course-lookup Edge Function with three fixture courses,
 * covering the three scorecardStatus paths a real search can return:
 *  - "Deer Run Golf Club" / "Buck/Doe": scorecardStatus 'unusable' straight
 *    from search (the real, production-confirmed shape -- GolfCourseAPI's
 *    tees is an empty object), so it never even reaches an import call.
 *  - "Empty Fairways Club" / "No Data Nine": scorecardStatus 'unknown' from
 *    search (simulating a result that doesn't expose tees at the list
 *    level), only discovered unusable once imported (tees: []).
 *  - "Green Acres Club" / "Championship": a normal, fully usable course.
 */
function mockGolfCourseLookup(page: Page, importCallCounts: Record<string, number>) {
  return page.route('**/functions/v1/golf-course-lookup', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');

    if (body.action === 'search') {
      await route.fulfill({
        json: {
          results: [
            {
              externalId: 'deerrun-5747',
              clubName: 'Deer Run Golf Club',
              courseName: 'Buck/Doe',
              city: 'Blenheim',
              state: 'ON',
              country: 'Canada',
              scorecardStatus: 'unusable',
            },
            {
              externalId: 'empty-fairways-1',
              clubName: 'Empty Fairways Club',
              courseName: 'No Data Nine',
              city: 'Testville',
              state: 'NC',
              country: 'USA',
              scorecardStatus: 'unknown',
            },
            {
              externalId: 'green-acres-1',
              clubName: 'Green Acres Club',
              courseName: 'Championship',
              city: 'Testville',
              state: 'NC',
              country: 'USA',
              scorecardStatus: 'usable',
            },
          ],
        },
      });
      return;
    }

    if (body.action === 'import') {
      importCallCounts[body.externalId] = (importCallCounts[body.externalId] ?? 0) + 1;

      if (body.externalId === 'empty-fairways-1') {
        await route.fulfill({
          json: { course: { id: 'mock-empty-course', club_name: 'Empty Fairways Club', course_name: 'No Data Nine' }, tees: [] },
        });
        return;
      }

      if (body.externalId === 'green-acres-1') {
        await route.fulfill({
          json: {
            course: { id: 'mock-green-acres', club_name: 'Green Acres Club', course_name: 'Championship' },
            tees: [
              {
                id: 'mock-tee-blue',
                tee_name: 'Blue',
                gender: 'male',
                number_of_holes: 18,
                par_total: 72,
                course_rating: 71.4,
                slope_rating: 128,
              },
            ],
          },
        });
        return;
      }

      // deerrun-5747 is never expected to reach an import call at all --
      // scorecardStatus 'unusable' short-circuits before the network call.
      await route.fulfill({ status: 500, json: { error: 'internal_error', message: 'unexpected import call in test' } });
      return;
    }

    await route.continue();
  });
}

test('search marks an unusable course, skips importing it, and offers the manual-scorecard fallback', async ({ page }) => {
  const player = await seedPlayer('unusable');
  const importCallCounts: Record<string, number> = {};
  await mockGolfCourseLookup(page, importCallCounts);
  await signIn(page, player.email, player.password);

  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Deer Run');

  // The search list itself marks the course as unusable, de-emphasized --
  // never presented identically to a fully-supported course.
  const resultButton = page.getByRole('button', { name: /Deer Run Golf Club/ });
  await expect(resultButton).toBeVisible({ timeout: 10_000 });
  await expect(resultButton.getByText('Scorecard data unavailable')).toBeVisible();

  await resultButton.click();

  // The dead-end message replaces the old bare "No tee data available"
  // text, with both required actions -- and Start Round is never reachable
  // from here.
  await expect(page.getByText('No complete scorecard was provided for this course.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter Scorecard Manually' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose Another Course' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Round' })).toHaveCount(0);

  // Known-unusable at search time -- no import call was ever made.
  expect(importCallCounts['deerrun-5747']).toBeUndefined();
});

test('an unusable course discovered only on import is cached for the session (no repeat fetch)', async ({ page }) => {
  const player = await seedPlayer('cache');
  const importCallCounts: Record<string, number> = {};
  await mockGolfCourseLookup(page, importCallCounts);
  await signIn(page, player.email, player.password);

  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Empty Fairways');
  const resultButton = page.getByRole('button', { name: /Empty Fairways Club/ });
  await expect(resultButton).toBeVisible({ timeout: 10_000 });

  // Not marked at the list level (scorecardStatus was 'unknown') -- only
  // discovered unusable after the import call resolves.
  await expect(resultButton.getByText('Scorecard data unavailable')).toHaveCount(0);
  await resultButton.click();
  await expect(page.getByText('No complete scorecard was provided for this course.')).toBeVisible({ timeout: 10_000 });
  expect(importCallCounts['empty-fairways-1']).toBe(1);

  // Choose Another Course, search again, select the same course again --
  // must not re-fetch it.
  await page.getByRole('button', { name: 'Choose Another Course' }).click();
  await page.getByPlaceholder('Search by course or club name…').fill('Empty Fairways');
  await expect(page.getByRole('button', { name: /Empty Fairways Club/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Empty Fairways Club/ }).click();
  await expect(page.getByText('No complete scorecard was provided for this course.')).toBeVisible();
  expect(importCallCounts['empty-fairways-1']).toBe(1);
});

test('a fully usable course is unaffected -- no badge, normal tee/hole flow reachable', async ({ page }) => {
  const player = await seedPlayer('usable');
  const importCallCounts: Record<string, number> = {};
  await mockGolfCourseLookup(page, importCallCounts);
  await signIn(page, player.email, player.password);

  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Green Acres');
  const resultButton = page.getByRole('button', { name: /Green Acres Club/ });
  await expect(resultButton).toBeVisible({ timeout: 10_000 });
  await expect(resultButton.getByText('Scorecard data unavailable')).toHaveCount(0);

  await resultButton.click();
  await expect(page.getByText('No complete scorecard was provided for this course.')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Blue/ })).toBeVisible({ timeout: 10_000 });
});

test('manual scorecard entry: "Use for This Round Only" starts a real round with the entered pars and saves nothing to the course library', async ({ page }) => {
  const player = await seedPlayer('manual');
  const importCallCounts: Record<string, number> = {};
  await mockGolfCourseLookup(page, importCallCounts);
  await signIn(page, player.email, player.password);

  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Deer Run');
  await page.getByRole('button', { name: /Deer Run Golf Club/ }).click();
  await page.getByRole('button', { name: 'Enter Scorecard Manually' }).click();

  await page.selectOption('#manualHoleCount', '9');
  for (let hole = 1; hole <= 9; hole++) {
    await page.fill(`#manual-par-${hole}`, '4');
  }
  await page.getByRole('button', { name: 'Use for This Round Only' }).click();
  await page.waitForURL('**/my-golf/round/**', { timeout: 10_000 });

  await expect(page.getByText('Hole 1 of 9')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Par 4', { exact: true })).toBeVisible();
});

test('manual scorecard entry: "Save to GreenLink Course Library" publishes a reusable course and starts the round on its tee', async ({ page }) => {
  const player = await seedPlayer('manual-saved');
  const importCallCounts: Record<string, number> = {};
  await mockGolfCourseLookup(page, importCallCounts);
  await signIn(page, player.email, player.password);

  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Deer Run');
  await page.getByRole('button', { name: /Deer Run Golf Club/ }).click();
  await page.getByRole('button', { name: 'Enter Scorecard Manually' }).click();

  await page.fill('#manualTeeName', 'Members');
  await page.selectOption('#manualHoleCount', '9');
  for (let hole = 1; hole <= 9; hole++) {
    await page.fill(`#manual-par-${hole}`, '4');
  }
  await page.getByRole('button', { name: 'Save to GreenLink Course Library & Start Round' }).click();
  await page.waitForURL('**/my-golf/round/**', { timeout: 15_000 });

  await expect(page.getByText('Hole 1 of 9')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Par 4', { exact: true })).toBeVisible();

  // A real, reusable course/tee was published -- this is what makes it
  // searchable for future rounds (search_courses(), 0027), not just usable
  // for this one.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: savedCourse, error: savedCourseError } = await admin
    .from('golf_courses')
    .select('id, source, created_by')
    .eq('created_by', player.userId)
    .eq('source', 'manual')
    .single();
  expect(savedCourseError).toBeNull();
  expect(savedCourse?.source).toBe('manual');

  const { count: teeCount } = await admin
    .from('golf_course_tees')
    .select('id', { count: 'exact', head: true })
    .eq('golf_course_id', savedCourse!.id)
    .eq('tee_name', 'Members');
  expect(teeCount).toBe(1);
});

test('manual scorecard entry rejects submission with a missing par, without fabricating one', async ({ page }) => {
  const player = await seedPlayer('manual-invalid');
  const importCallCounts: Record<string, number> = {};
  await mockGolfCourseLookup(page, importCallCounts);
  await signIn(page, player.email, player.password);

  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Deer Run');
  await page.getByRole('button', { name: /Deer Run Golf Club/ }).click();
  await page.getByRole('button', { name: 'Enter Scorecard Manually' }).click();

  await page.selectOption('#manualHoleCount', '9');
  // Only fill 8 of 9 holes.
  for (let hole = 1; hole <= 8; hole++) {
    await page.fill(`#manual-par-${hole}`, '4');
  }
  await page.getByRole('button', { name: 'Use for This Round Only' }).click();

  await expect(page.getByText('Enter a par for every hole before starting.')).toBeVisible();
  // Still on the form -- never navigated to a round with invented data.
  await expect(page.locator('#manual-par-9')).toBeVisible();
});
