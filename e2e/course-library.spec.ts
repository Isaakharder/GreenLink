import { expect, test, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function seedUser(tag: string) {
  const stamp = Date.now();
  const email = `e2e-courselib-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Cory', last_name: `Courses${stamp}`, username: `e2e_courselib_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id };
}

/**
 * Archives every manual course this test's seeded user created (safe
 * regardless of whether a course was ever referenced by a tournament --
 * unlike deleting, archiving never touches golf_course_id/golf_course_tee_id
 * foreign keys). Run at the end of every test that publishes a real course
 * through the UI, so this suite's own published courses -- and their
 * city/club-name fields -- can never accumulate in the local Postgres
 * volume and leak into a *later* run's find_similar_courses()/
 * search_courses() results (both filter archived_at is null). Each test
 * seeds a brand-new, uniquely-stamped user via seedUser(), so scoping by
 * created_by is exact -- never touches another test's data.
 */
async function archiveCoursesCreatedBy(userId: string): Promise<void> {
  const { error } = await admin()
    .from('golf_courses')
    .update({ archived_at: new Date().toISOString() })
    .eq('created_by', userId)
    .is('archived_at', null);
  if (error) throw error;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

/** Fills the current hole's par (radio buttons 3/4/5/6 -- only one hole's set is ever rendered at a time). */
async function setCurrentHolePar(page: Page, par: number) {
  await page.getByRole('radio', { name: String(par), exact: true }).click();
}

/**
 * Drives the Tees step's single-tee editor: opens "Edit Tee & Holes" on the
 * (only) tee card, names it, sets hole count, fills `parsToFill` holes
 * (starting from hole 1) with the given par, then returns to the tee list
 * ("Done"). Leaves any holes beyond parsToFill untouched -- the caller
 * decides whether that's a deliberate draft or a bug.
 */
async function fillFirstTee(page: Page, opts: { teeName: string; holeCount: 9 | 18; parsToFill: number; par?: number }) {
  await page.getByRole('button', { name: 'Edit Tee & Holes' }).first().click();
  await page.fill('[id^="tee-name-"]', opts.teeName);
  await page.selectOption('[id^="tee-holes-"]', String(opts.holeCount));

  for (let hole = 1; hole <= opts.parsToFill; hole++) {
    await setCurrentHolePar(page, opts.par ?? 4);
    if (hole < opts.holeCount) {
      await page.getByRole('button', { name: 'Next Hole' }).click();
    }
  }
  await page.getByRole('button', { name: 'Done' }).click();
}

test.describe('manual course library', () => {
  test('a user can add, edit, and archive/restore a manual course from Settings', async ({ page }) => {
    const owner = await seedUser('crud');
    await signIn(page, owner.email, owner.password);

    await page.goto('/profile');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('**/settings');
    await page.getByRole('link', { name: 'Courses' }).click();
    await page.waitForURL('**/settings/courses');

    await page.getByRole('link', { name: 'Add Course' }).click();
    await page.waitForURL('**/settings/courses/new');

    const stamp = Date.now();
    const clubName = `E2E Library Club ${stamp}`;
    await page.fill('#clubName', clubName);
    await page.fill('#courseName', `Main Layout ${stamp}`);
    // Stamped like clubName/courseName -- a bare "Testville" would exactly
    // match (find_similar_courses matches city case-insensitively) every
    // other published course this suite has ever left behind with that same
    // literal city, unexpectedly popping the duplicate-warning modal instead
    // of publishing straight through.
    await page.fill('#city', `Testville ${stamp}`);
    await page.fill('#state', 'NC');
    await page.fill('#country', 'USA');
    await page.getByRole('button', { name: 'Next: Tees' }).click();

    await fillFirstTee(page, { teeName: 'White', holeCount: 9, parsToFill: 9 });

    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Publish Course' }).click();
    await page.waitForURL('**/settings/courses');

    await expect(page.getByText(clubName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Draft', { exact: true })).toHaveCount(0);

    // Edit: change the club name.
    await page.getByRole('link', { name: 'Edit Course' }).click();
    await page.waitForURL('**/settings/courses/*/edit');
    await expect(page.locator('#clubName')).toHaveValue(clubName);
    const updatedName = `${clubName} (Updated)`;
    await page.fill('#clubName', updatedName);
    await page.getByRole('button', { name: 'Next: Tees' }).click();
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.waitForURL('**/settings/courses');
    await expect(page.getByText(updatedName)).toBeVisible({ timeout: 10_000 });

    // Archive, then restore.
    await page.getByRole('button', { name: 'Archive Course' }).click();
    await expect(page.getByText('Archived', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Archived', { exact: true })).toHaveCount(0, { timeout: 10_000 });

    // Leaves the course archived so it never lingers as a real, findable
    // published course for a later run's find_similar_courses()/
    // search_courses() to match against (see archiveCoursesCreatedBy).
    await archiveCoursesCreatedBy(owner.userId);
  });

  test('Save Draft keeps a course out of search until Publish is used', async ({ page }) => {
    const owner = await seedUser('draft');
    await signIn(page, owner.email, owner.password);

    const stamp = Date.now();
    const clubName = `E2E Draft Club ${stamp}`;

    await page.goto('/settings/courses/new');
    await page.fill('#clubName', clubName);
    await page.fill('#courseName', `Draft Layout ${stamp}`);
    await page.getByRole('button', { name: 'Next: Tees' }).click();

    // Only fill 5 of 9 holes -- a realistic "still typing this on my phone" draft.
    await fillFirstTee(page, { teeName: 'White', holeCount: 9, parsToFill: 5 });

    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Save Draft' }).click();
    await page.waitForURL('**/settings/courses');

    await expect(page.getByText(clubName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();

    // Not searchable yet.
    await page.goto('/my-golf/start');
    await page.getByPlaceholder('Search by course or club name…').fill(clubName);
    await expect(page.getByText(clubName)).toHaveCount(0, { timeout: 5_000 });

    // Publishing is blocked until every hole has a par.
    await page.goto('/settings/courses');
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('every tee must have a par for all of its holes')).toBeVisible({ timeout: 10_000 });

    // Finish the draft, then Publish succeeds and it becomes searchable.
    await page.getByRole('link', { name: 'Edit Course' }).click();
    await page.waitForURL('**/settings/courses/*/edit');
    await page.getByRole('button', { name: 'Next: Tees' }).click();
    await page.getByRole('button', { name: 'Edit Tee & Holes' }).click();
    // Jump to hole 6 via the picker (holes 1-5 already have a par from the draft save).
    await page.getByRole('button', { name: '6', exact: true }).click();
    for (let hole = 6; hole <= 9; hole++) {
      await setCurrentHolePar(page, 4);
      if (hole < 9) await page.getByRole('button', { name: 'Next Hole' }).click();
    }
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Publish Course' }).click();
    await page.waitForURL('**/settings/courses');
    await expect(page.getByText('Draft', { exact: true })).toHaveCount(0, { timeout: 10_000 });

    await page.goto('/my-golf/start');
    await page.getByPlaceholder('Search by course or club name…').fill(clubName);
    await expect(page.getByRole('button', { name: new RegExp(clubName) })).toBeVisible({ timeout: 10_000 });

    await archiveCoursesCreatedBy(owner.userId);
  });

  test('publishing near a similarly-named existing course shows a duplicate warning', async ({ page }) => {
    const owner = await seedUser('dupe');
    await signIn(page, owner.email, owner.password);

    const stamp = Date.now();
    const clubName = `E2E Duplicate Club ${stamp}`;

    // First course: published normally.
    await page.goto('/settings/courses/new');
    await page.fill('#clubName', clubName);
    await page.fill('#courseName', `Original Layout ${stamp}`);
    // Stamped for the same reason as the CRUD test's city above -- a bare
    // "Duplicateville" would exactly match a course this same spec left
    // behind on a previous run, popping the duplicate-warning modal on
    // *this* publish (which the test doesn't expect yet) instead of on the
    // second course's, which is the one actually under test.
    await page.fill('#city', `Duplicateville ${stamp}`);
    await page.getByRole('button', { name: 'Next: Tees' }).click();
    await fillFirstTee(page, { teeName: 'White', holeCount: 9, parsToFill: 9 });
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Publish Course' }).click();
    await page.waitForURL('**/settings/courses');

    // Second course: same club name -- publishing should warn before saving.
    await page.getByRole('link', { name: 'Add Course' }).click();
    await page.fill('#clubName', clubName);
    await page.fill('#courseName', `Second Layout ${stamp}`);
    await page.getByRole('button', { name: 'Next: Tees' }).click();
    await fillFirstTee(page, { teeName: 'Blue', holeCount: 9, parsToFill: 9 });
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Publish Course' }).click();

    await expect(page.getByText('A similar course already exists')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'View Existing Course' })).toBeVisible();

    await page.getByRole('button', { name: 'Continue Creating' }).click();
    await page.waitForURL('**/settings/courses');
    await expect(page.getByText(`Second Layout ${stamp}`)).toBeVisible({ timeout: 10_000 });

    await archiveCoursesCreatedBy(owner.userId);
  });

  test("an unrelated user cannot edit or archive someone else's course, but an administrator can", async () => {
    const owner = await seedUser('owner2');
    const outsider = await seedUser('outsider2');
    const adminUser = await seedUser('admin2');
    await admin().from('profiles').update({ is_admin: true }).eq('id', adminUser.userId);

    const stamp = Date.now();
    // Seeded directly (service-role, bypassing RLS) rather than via
    // create_manual_course() -- that RPC reads auth.uid(), which is null
    // under the service-role key with no user JWT. Same technique
    // e2e/seed.ts's seedGolfCourseFixture already uses for golfcourseapi
    // fixtures.
    const { data: seededCourse, error: seedError } = await admin()
      .from('golf_courses')
      .insert({
        external_id: `manual-e2e-${stamp}`,
        club_name: `E2E Ownership Club ${stamp}`,
        course_name: 'Layout',
        source: 'manual',
        created_by: owner.userId,
        imported_by: owner.userId,
        published_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (seedError) throw seedError;

    // These RPCs are exactly what the Edit/Archive UI buttons call --
    // exercised directly here (rather than through the page) since the
    // interesting behavior is the server-side permission check, not any
    // client rendering.
    const outsiderClient = createClient(SUPABASE_URL, process.env.E2E_SUPABASE_ANON_KEY ?? '');
    await outsiderClient.auth.signInWithPassword({ email: outsider.email, password: outsider.password });
    const { error: outsiderEditError } = await outsiderClient.rpc('update_manual_course_info', {
      p_course_id: seededCourse.id,
      p_club_name: 'Hijacked',
      p_course_name: 'Hijacked',
      p_address: null,
      p_city: null,
      p_state: null,
      p_country: null,
      p_latitude: null,
      p_longitude: null,
    });
    expect(outsiderEditError).not.toBeNull();
    const { error: outsiderArchiveError } = await outsiderClient.rpc('archive_manual_course', { p_course_id: seededCourse.id });
    expect(outsiderArchiveError).not.toBeNull();

    const adminClient = createClient(SUPABASE_URL, process.env.E2E_SUPABASE_ANON_KEY ?? '');
    await adminClient.auth.signInWithPassword({ email: adminUser.email, password: adminUser.password });
    const { error: adminEditError } = await adminClient.rpc('update_manual_course_info', {
      p_course_id: seededCourse.id,
      p_club_name: `E2E Ownership Club ${stamp} (Admin Edit)`,
      p_course_name: 'Layout',
      p_address: null,
      p_city: null,
      p_state: null,
      p_country: null,
      p_latitude: null,
      p_longitude: null,
    });
    expect(adminEditError).toBeNull();
    const { error: adminArchiveError } = await adminClient.rpc('archive_manual_course', { p_course_id: seededCourse.id });
    expect(adminArchiveError).toBeNull();

    const { data: finalCourse } = await admin().from('golf_courses').select('club_name, archived_at').eq('id', seededCourse.id).single();
    expect(finalCourse?.club_name).toBe(`E2E Ownership Club ${stamp} (Admin Edit)`);
    expect(finalCourse?.archived_at).not.toBeNull();
  });

  test('a manual course starts a personal round and creates a tournament through the normal search/import flow', async ({ page }) => {
    const owner = await seedUser('use');
    const stamp = Date.now();
    const clubName = `E2E Usable Club ${stamp}`;

    const { data: course, error: courseError } = await admin()
      .from('golf_courses')
      .insert({
        external_id: `manual-e2e-use-${stamp}`,
        club_name: clubName,
        course_name: 'Main Layout',
        city: `Testville ${stamp}`,
        state: 'NC',
        country: 'USA',
        source: 'manual',
        created_by: owner.userId,
        imported_by: owner.userId,
        published_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (courseError) throw courseError;

    const { data: tee, error: teeError } = await admin()
      .from('golf_course_tees')
      .insert({ golf_course_id: course.id, tee_name: 'Blue', gender: 'unisex', number_of_holes: 18, par_total: 72 })
      .select('id')
      .single();
    if (teeError) throw teeError;

    const holeRows = Array.from({ length: 18 }, (_, i) => ({ tee_id: tee.id, hole_number: i + 1, par: 4 }));
    const { error: holesError } = await admin().from('golf_course_tee_holes').insert(holeRows);
    if (holesError) throw holesError;

    const courseId: string = course.id;
    const teeId: string = tee.id;

    function mockGolfCourseLookup(p: Page) {
      return p.route('**/functions/v1/golf-course-lookup', async (route: Route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        if (body.action === 'search') {
          await route.fulfill({
            json: {
              results: [
                {
                  externalId: `manual-e2e-use-${stamp}`,
                  clubName,
                  courseName: 'Main Layout',
                  city: `Testville ${stamp}`,
                  state: 'NC',
                  country: 'USA',
                  scorecardStatus: 'usable',
                  source: 'manual',
                },
              ],
            },
          });
          return;
        }
        if (body.action === 'import') {
          await route.fulfill({
            json: {
              course: { id: courseId, club_name: clubName, course_name: 'Main Layout', city: `Testville ${stamp}`, state: 'NC', country: 'USA' },
              tees: [{ id: teeId, tee_name: 'Blue', gender: 'unisex', number_of_holes: 18, par_total: 72, course_rating: null, slope_rating: null }],
            },
          });
          return;
        }
        await route.continue();
      });
    }

    await mockGolfCourseLookup(page);
    await signIn(page, owner.email, owner.password);

    await page.goto('/my-golf/start');
    await page.getByPlaceholder('Search by course or club name…').fill(clubName);
    const resultButton = page.getByRole('button', { name: new RegExp(clubName) });
    await expect(resultButton).toBeVisible({ timeout: 10_000 });
    await expect(resultButton.getByText('GreenLink Course')).toBeVisible();
    await resultButton.click();

    await expect(page.getByRole('radio', { name: /Blue/ })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('radio', { name: /Blue/ }).click();
    await page.getByRole('radio', { name: 'Play 18' }).click();
    await page.getByRole('button', { name: 'Start Round' }).click();
    await page.waitForURL('**/my-golf/round/**', { timeout: 10_000 });
    await expect(page.getByText('Hole 1 of 18')).toBeVisible({ timeout: 10_000 });

    // Create Tournament: the same course/tee, through the same search+import path.
    await page.goto('/tournaments/new');
    await page.fill('#name', `E2E Tournament ${stamp}`);
    await page.getByPlaceholder('Search by course or club name…').fill(clubName);
    await expect(page.getByText(clubName).first()).toBeVisible({ timeout: 10_000 });
    await page.getByText(clubName).first().click();
    await expect(page.getByRole('button', { name: /Blue/ })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Blue/ }).click();
    await page.fill('#tournamentDate', new Date().toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Create Tournament' }).click();
    await page.waitForURL('**/tournaments/**/overview', { timeout: 10_000 });

    // Archiving (not deleting) is required here regardless -- the
    // personal round and tournament created above hold non-cascading
    // foreign keys to this course/tee.
    await archiveCoursesCreatedBy(owner.userId);
  });

  test('the course creator can build and publish an 18-hole course on a phone-sized viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const owner = await seedUser('mobile');
    await signIn(page, owner.email, owner.password);

    const stamp = Date.now();
    const clubName = `E2E Mobile Club ${stamp}`;

    await page.goto('/settings/courses/new');
    await page.fill('#clubName', clubName);
    await page.fill('#courseName', `Mobile Layout ${stamp}`);
    await page.getByRole('button', { name: 'Next: Tees' }).click();

    await page.getByRole('button', { name: 'Edit Tee & Holes' }).click();
    await page.fill('[id^="tee-name-"]', 'Blue');
    // Default hole count is 18 -- never render all 18 at once; only the
    // current hole's fields are ever visible.
    await expect(page.locator('[id^="hole-par-"]')).toHaveCount(0);
    await expect(page.getByText('Hole 1')).toBeVisible();

    for (let hole = 1; hole <= 18; hole++) {
      await setCurrentHolePar(page, 4);
      if (hole < 18) await page.getByRole('button', { name: 'Next Hole' }).click();
    }
    await expect(page.getByRole('button', { name: 'Next Hole' })).toBeDisabled();
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Next: Review' }).click();
    await expect(page.getByText('Par 72')).toBeVisible();

    // Sticky save bar is present with both actions.
    await expect(page.getByRole('button', { name: 'Save Draft' })).toBeVisible();
    const publishButton = page.getByRole('button', { name: 'Publish Course' });
    await expect(publishButton).toBeVisible();
    await publishButton.click();
    await page.waitForURL('**/settings/courses');
    await expect(page.getByText(clubName)).toBeVisible({ timeout: 10_000 });

    await archiveCoursesCreatedBy(owner.userId);
  });

  test('warns before leaving the form with unsaved changes', async ({ page }) => {
    const owner = await seedUser('unsaved');
    await signIn(page, owner.email, owner.password);

    await page.goto('/settings/courses/new');
    await page.fill('#clubName', 'Unsaved Changes Club');

    let dialogMessage = '';
    page.once('dialog', (dialog) => {
      dialogMessage = dialog.message();
      void dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(dialogMessage.length).toBeGreaterThan(0);

    // Dismissing the confirm means we stayed on the form -- the field is untouched.
    await expect(page.locator('#clubName')).toHaveValue('Unsaved Changes Club');
  });
});
