import { expect, test, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

async function seedPlayer() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now();
  const email = `e2e-mygolf-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Gigi', last_name: `Golfer${stamp}`, username: `e2e_mygolf_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id, fullName: `Gigi Golfer${stamp}` };
}

interface SeededCourse {
  externalId: string;
  clubName: string;
  courseName: string;
  teeId: string;
  teeName: string;
  numberOfHoles: number;
  parTotal: number;
  courseRating: number;
  slopeRating: number;
}

/**
 * Same technique as course-import-flow.spec.ts's seedGolfCourseFixture --
 * seeds golf_courses/golf_course_tees/golf_course_tee_holes directly (the
 * data a real Edge Function import would have cached), stamped with a
 * unique club name per test run so this spec's Home feed assertions can't
 * collide with rounds left behind by earlier runs of this same spec.
 */
async function seedCourse(stamp: number, organizerUserId: string): Promise<SeededCourse> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const clubName = `E2E MyGolf Club ${stamp}`;
  const courseName = 'E2E MyGolf Course';

  const { data: course, error: courseError } = await admin
    .from('golf_courses')
    .insert({ external_id: `e2e-mygolf-course-${stamp}`, club_name: clubName, course_name: courseName, city: 'Testville', state: 'NC', country: 'USA', imported_by: organizerUserId, raw_payload: {} })
    .select('id')
    .single();
  if (courseError) throw courseError;

  const { data: tee, error: teeError } = await admin
    .from('golf_course_tees')
    .insert({ golf_course_id: course.id, tee_name: 'Blue', gender: 'male', number_of_holes: 18, par_total: 72, course_rating: 71.4, slope_rating: 128 })
    .select('id')
    .single();
  if (teeError) throw teeError;

  const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
  const holeRows = Array.from({ length: 18 }, (_, i) => ({ tee_id: tee.id, hole_number: i + 1, par: pars[i], yardage: 350 + i * 5, handicap: ((i * 7) % 18) + 1 }));
  const { error: holesError } = await admin.from('golf_course_tee_holes').insert(holeRows);
  if (holesError) throw holesError;

  return { externalId: `e2e-mygolf-course-${stamp}`, clubName, courseName, teeId: tee.id, teeName: 'Blue', numberOfHoles: 18, parTotal: 72, courseRating: 71.4, slopeRating: 128 };
}

function mockGolfCourseLookup(page: Page, fixture: SeededCourse) {
  return page.route('**/functions/v1/golf-course-lookup', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');

    if (body.action === 'search') {
      await route.fulfill({ json: { results: [{ externalId: fixture.externalId, clubName: fixture.clubName, courseName: fixture.courseName, city: 'Testville', state: 'NC', country: 'USA' }] } });
      return;
    }

    if (body.action === 'import') {
      await route.fulfill({
        json: {
          course: { id: 'mock-course-row', club_name: fixture.clubName, course_name: fixture.courseName, city: 'Testville', state: 'NC', country: 'USA' },
          tees: [{ id: fixture.teeId, tee_name: fixture.teeName, gender: 'male', number_of_holes: fixture.numberOfHoles, par_total: fixture.parTotal, course_rating: fixture.courseRating, slope_rating: fixture.slopeRating }],
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

test('start a personal round, score it, finish it public, and see it on the Home feed -- a second private round stays hidden', async ({ page }) => {
  const stamp = Date.now();
  const player = await seedPlayer();
  const fixture = await seedCourse(stamp, player.userId);
  await mockGolfCourseLookup(page, fixture);

  // A stamped club name makes every feed/round-list assertion below
  // collision-proof against rounds left behind by earlier runs of this spec.
  const feedItem = page.getByRole('button', { name: new RegExp(fixture.clubName) });

  await signIn(page, player.email, player.password);

  // --- Round 1: search for the course, play 18, score hole 1, finish public. ---
  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill(fixture.clubName);
  await expect(page.getByText(fixture.clubName)).toBeVisible({ timeout: 10_000 });
  await page.getByText(fixture.clubName).first().click();

  await expect(page.getByRole('radio', { name: new RegExp(fixture.teeName) })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('radio', { name: new RegExp(fixture.teeName) }).click();

  // Selecting a tee must be visibly obvious, not just a checkmark buried in
  // the label -- a solid brand-green background + white text, not merely a
  // border-color tweak (regression test for the cascade-order bug where the
  // scoped .chosen rule silently lost to the global .btn-secondary rule).
  const selectedTeeButton = page.getByRole('radio', { name: new RegExp(fixture.teeName) });
  await expect(selectedTeeButton).toHaveAttribute('aria-checked', 'true');
  await expect(selectedTeeButton).toHaveCSS('background-color', 'rgb(27, 94, 60)');
  await expect(selectedTeeButton).toHaveCSS('color', 'rgb(255, 255, 255)');

  // 18-hole tee: the Play 18 / Front 9 / Back 9 choice appears.
  const play18Button = page.getByRole('radio', { name: 'Play 18' });
  const front9Button = page.getByRole('radio', { name: 'Front 9' });
  await expect(play18Button).toBeVisible();
  await play18Button.click();

  await expect(play18Button).toHaveAttribute('aria-checked', 'true');
  await expect(play18Button).toHaveCSS('background-color', 'rgb(27, 94, 60)');
  await expect(play18Button).toHaveCSS('color', 'rgb(255, 255, 255)');
  // The unselected sibling in the same group must stay unhighlighted (white
  // background, not the selected green) -- confirms the state is scoped per
  // button, not applied to the whole group.
  await expect(front9Button).toHaveAttribute('aria-checked', 'false');
  await expect(front9Button).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  await page.getByRole('button', { name: 'Start Round' }).click();
  await page.waitForURL('**/my-golf/round/**');

  // The scorecard header adapts for a personal round: the player's name and
  // hole progress instead of "Team 1" -- never the tournament team label.
  await expect(page.getByText(player.fullName)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Hole 1 of 18')).toBeVisible();
  await expect(page.getByText('Team 1')).toHaveCount(0);
  await expect(page.getByText(/^Team\s/)).toHaveCount(0);

  // Reuses the exact same ScorecardTab UI as tournaments (the hole card itself is unchanged).
  await expect(page.getByText('Par 4', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Par', exact: true }).click();
  await expect(page.getByText('Score synchronized.')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Finish Round' }).click();
  await expect(page.getByText('Who can see this round?')).toBeVisible();
  await page.getByRole('button', { name: 'Public' }).click();
  await page.getByRole('button', { name: 'Finish Round', exact: true }).click();
  await page.waitForURL('**/my-golf');

  // --- The finished public round appears on the Home community feed. ---
  await page.goto('/home');
  await expect(feedItem).toBeVisible({ timeout: 10_000 });
  await expect(feedItem).toContainText(player.fullName);

  await feedItem.click();
  await expect(page.getByRole('columnheader', { name: 'Strokes' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(fixture.numberOfHoles + 1); // header row + one per hole
  await page.getByRole('button', { name: 'Close' }).click();

  // --- Round 2, started from "Recent Courses" (no search this time), finished private. ---
  // Scoped to the chip (not the Recent Rounds row, which shows the same course text).
  await page.goto('/my-golf');
  await page.locator('button[class*="chip"]', { hasText: fixture.clubName }).click();
  await page.waitForURL('**/my-golf/start');

  await expect(page.getByRole('radio', { name: new RegExp(fixture.teeName) })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('radio', { name: new RegExp(fixture.teeName) }).click();
  await page.getByRole('radio', { name: 'Play 18' }).click();
  await page.getByRole('button', { name: 'Start Round' }).click();
  await page.waitForURL('**/my-golf/round/**');

  await page.getByRole('button', { name: 'Finish Round' }).click();
  await expect(page.getByText('Who can see this round?')).toBeVisible();
  // Private is the default -- finish without touching the visibility choice.
  await page.getByRole('button', { name: 'Finish Round', exact: true }).click();
  await page.waitForURL('**/my-golf');

  // The private round never appears on the Home feed -- still exactly the one public item for this course.
  await page.goto('/home');
  await expect(feedItem).toHaveCount(1);

  // My Golf's own Recent Rounds history shows both rounds, regardless of visibility.
  await page.goto('/my-golf');
  await expect(page.getByText('Rounds Played')).toBeVisible();
  await expect(page.locator('li', { hasText: fixture.clubName })).toHaveCount(2);
});
