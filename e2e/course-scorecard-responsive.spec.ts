import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

// Common phone widths this suite must never overflow at, per the reported
// iPhone screenshot (Edit Course -> Tees -> Course rating/Slope rating).
const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function seedUser(tag: string) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `e2e-responsive-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Remi', last_name: `Responsive${stamp}`, username: `e2e_responsive_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id };
}

async function archiveCoursesCreatedBy(userId: string): Promise<void> {
  const { error } = await admin().from('golf_courses').update({ archived_at: new Date().toISOString() }).eq('created_by', userId).is('archived_at', null);
  if (error) throw error;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

/** No horizontal document overflow at the current viewport -- the literal bar the task set: scrollWidth <= clientWidth. */
async function assertNoHorizontalOverflow(page: Page, context: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${context}: document.documentElement.scrollWidth (${scrollWidth}) exceeds clientWidth (${clientWidth})`).toBeLessThanOrEqual(
    clientWidth,
  );
}

/** The full bounding box of every visible, enabled control matching locator must sit inside the viewport -- not just "no scrollbar", but "actually reachable/tappable". */
async function assertAllWithinViewport(page: Page, locator: Locator, context: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unavailable');
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const box = await locator.nth(i).boundingBox();
    if (!box) continue; // not visible/rendered -- nothing to assert
    expect(box.x, `${context} (#${i}): left edge (${box.x}) is off-screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${context} (#${i}): right edge (${box.x + box.width}) exceeds viewport width (${viewport.width})`).toBeLessThanOrEqual(
      viewport.width + 1, // sub-pixel rounding tolerance
    );
  }
}

/** Every element matching locator must be the same width and the same height as the first one -- proves a true equal-size grid rather than content-sized buttons (e.g. "1" narrower than "18"). 1px tolerance for grid-track remainder rounding. */
async function assertEqualDimensions(page: Page, locator: Locator, context: string) {
  const count = await locator.count();
  expect(count, `${context}: expected at least 2 elements to compare`).toBeGreaterThan(1);
  let refWidth: number | null = null;
  let refHeight: number | null = null;
  for (let i = 0; i < count; i++) {
    const box = await locator.nth(i).boundingBox();
    if (!box) continue;
    if (refWidth === null || refHeight === null) {
      refWidth = box.width;
      refHeight = box.height;
      continue;
    }
    expect(Math.abs(box.width - refWidth), `${context} (#${i}): width ${box.width} differs from #0's width ${refWidth}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - refHeight), `${context} (#${i}): height ${box.height} differs from #0's height ${refHeight}`).toBeLessThanOrEqual(1);
  }
}

/** Groups locator's matched elements by vertical position (row) and asserts every row has exactly expectedColumns items -- a true N-column grid wrap, not a flex row that happens to look right for one hole count. */
async function assertGridColumnCount(page: Page, locator: Locator, expectedColumns: number, context: string) {
  const count = await locator.count();
  const rowsByY = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const box = await locator.nth(i).boundingBox();
    if (!box) continue;
    const rowKey = Math.round(box.y);
    rowsByY.set(rowKey, (rowsByY.get(rowKey) ?? 0) + 1);
  }
  const expectedRows = Math.ceil(count / expectedColumns);
  expect(rowsByY.size, `${context}: expected ${expectedRows} rows of ${expectedColumns}, found rows: ${[...rowsByY.values()]}`).toBe(expectedRows);
  for (const [y, itemsInRow] of rowsByY) {
    // The last row may be a partial row (fewer items); every other row must
    // have exactly expectedColumns.
    expect(itemsInRow, `${context}: row at y=${y} has ${itemsInRow} items`).toBeLessThanOrEqual(expectedColumns);
  }
  const fullRows = [...rowsByY.values()].filter((n) => n === expectedColumns).length;
  expect(fullRows, `${context}: expected at least one full row of ${expectedColumns}`).toBeGreaterThan(0);
}

function mockUnusableGolfCourseLookup(page: Page) {
  return page.route('**/functions/v1/golf-course-lookup', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.action === 'search') {
      await route.fulfill({
        json: {
          results: [
            {
              externalId: 'responsive-unusable-1',
              clubName: 'Responsive Test Golf Club',
              courseName: 'No Data Nine',
              city: 'Testville',
              state: 'ON',
              country: 'Canada',
              scorecardStatus: 'unusable',
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({ status: 400, json: { error: 'invalid_request', message: 'unexpected action in test mock' } });
  });
}

for (const width of PHONE_WIDTHS) {
  test(`Add Course (Details -> Tees -> Review) has no horizontal overflow at ${width}px, including the Course rating/Slope rating row`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const owner = await seedUser(`course-${width}`);
    await signIn(page, owner.email, owner.password);

    await page.goto('/settings/courses/new');
    await assertNoHorizontalOverflow(page, `${width}px: Details step`);

    await page.fill('#clubName', `Responsive Club ${width}`);
    await page.fill('#courseName', `Responsive Layout ${width}`);
    await assertNoHorizontalOverflow(page, `${width}px: Details step, filled`);
    await page.getByRole('button', { name: 'Next: Tees' }).click();

    await assertNoHorizontalOverflow(page, `${width}px: Tees step (tee list)`);
    await page.getByRole('button', { name: 'Edit Tee & Holes' }).click();

    await page.fill('[id^="tee-name-"]', 'Blue');
    await assertNoHorizontalOverflow(page, `${width}px: Tee editor, Gender/Holes row`);

    // The exact row from the reported screenshot.
    await page.fill('[id^="tee-rating-"]', '72.5');
    await page.fill('[id^="tee-slope-"]', '135');
    await assertNoHorizontalOverflow(page, `${width}px: Tee editor, Course rating/Slope rating row`);
    await assertAllWithinViewport(page, page.locator('[id^="tee-rating-"], [id^="tee-slope-"]'), `${width}px: rating/slope inputs`);
    // Both fields (and their labels) must actually be visible, not clipped.
    await expect(page.getByLabel('Course rating (optional)')).toBeVisible();
    await expect(page.getByLabel('Slope rating (optional)')).toBeVisible();

    // Hole editor: par buttons must all be visible, within the viewport, and
    // identically sized (four equal-width/height controls, not content-sized).
    const parButtons = page.getByRole('radio', { name: /^[3-6]$/ });
    await assertAllWithinViewport(page, parButtons, `${width}px: par buttons`);
    await assertEqualDimensions(page, parButtons, `${width}px: par buttons`);
    await page.getByRole('radio', { name: '4', exact: true }).click();
    await page.fill('[id^="hole-yardage-"]', '350');
    await assertNoHorizontalOverflow(page, `${width}px: Tee editor, hole card filled`);

    // Hole navigation: true 6-column grid -- all 18 buttons the same size
    // (not "1" narrower than "10"/"18"), laid out 6 per row, fully on-screen.
    const holePickerButtons = page.locator('button[class*="pickerItem"]');
    await expect(holePickerButtons).toHaveCount(18);
    await assertAllWithinViewport(page, holePickerButtons, `${width}px: hole picker buttons`);
    await assertEqualDimensions(page, holePickerButtons, `${width}px: hole picker buttons`);
    await assertGridColumnCount(page, holePickerButtons, 6, `${width}px: hole picker grid`);

    for (let hole = 2; hole <= 18; hole++) {
      await page.getByRole('button', { name: 'Next Hole' }).click();
      await page.getByRole('radio', { name: '4', exact: true }).click();
    }
    await assertNoHorizontalOverflow(page, `${width}px: Tee editor, last hole`);
    await page.getByRole('button', { name: 'Done' }).click();

    await assertNoHorizontalOverflow(page, `${width}px: Tees step (tee summary)`);
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await assertNoHorizontalOverflow(page, `${width}px: Review step`);
    await expect(page.getByText('Par 72')).toBeVisible();
    await expect(page.getByText('Rating 72.5')).toBeVisible();
    await expect(page.getByText('Slope 135')).toBeVisible();

    await page.getByRole('button', { name: 'Publish Course' }).click();
    await page.waitForURL('**/settings/courses');
    await assertNoHorizontalOverflow(page, `${width}px: Course Library after publish`);

    await archiveCoursesCreatedBy(owner.userId);
  });

  test(`My Golf manual scorecard entry has no horizontal overflow at ${width}px across all 18 holes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const player = await seedUser(`manual-${width}`);
    await mockUnusableGolfCourseLookup(page);
    await signIn(page, player.email, player.password);

    await page.goto('/my-golf/start');
    await page.getByPlaceholder('Search by course or club name…').fill('Responsive Test');
    await page.getByRole('button', { name: /Responsive Test Golf Club/ }).click();
    await page.getByRole('button', { name: 'Enter Scorecard Manually' }).click();

    await assertNoHorizontalOverflow(page, `${width}px: manual entry, 18-hole grid rendered at once`);
    await assertAllWithinViewport(page, page.locator('[id^="manual-par-"]'), `${width}px: manual par inputs`);
    await assertAllWithinViewport(page, page.locator('[id^="manual-yardage-"]'), `${width}px: manual yardage inputs`);

    await page.fill('#manualRating', '71.2');
    await page.fill('#manualSlope', '128');
    await assertNoHorizontalOverflow(page, `${width}px: manual entry, course rating/slope filled`);

    for (let hole = 1; hole <= 18; hole++) {
      await page.fill(`#manual-par-${hole}`, '4');
    }
    await assertNoHorizontalOverflow(page, `${width}px: manual entry, all holes filled`);
  });
}

test('desktop: Course rating and Slope rating render side by side, not stacked (no regression)', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const owner = await seedUser('desktop');
  await signIn(page, owner.email, owner.password);

  await page.goto('/settings/courses/new');
  await page.fill('#clubName', 'Desktop Regression Club');
  await page.fill('#courseName', 'Desktop Regression Layout');
  await page.getByRole('button', { name: 'Next: Tees' }).click();
  await page.getByRole('button', { name: 'Edit Tee & Holes' }).click();
  await page.fill('[id^="tee-name-"]', 'Blue');

  await assertNoHorizontalOverflow(page, 'desktop: Tee editor');

  const ratingBox = await page.locator('[id^="tee-rating-"]').boundingBox();
  const slopeBox = await page.locator('[id^="tee-slope-"]').boundingBox();
  if (!ratingBox || !slopeBox) throw new Error('rating/slope inputs not visible on desktop');
  // Side by side means roughly the same vertical position, slope strictly
  // to the right of rating -- if this ever regresses to always-stacked,
  // slope's y would jump well below rating's instead.
  expect(Math.abs(ratingBox.y - slopeBox.y)).toBeLessThan(5);
  expect(slopeBox.x).toBeGreaterThan(ratingBox.x + ratingBox.width);

  // The hole picker and par selector stay sensible on desktop too -- this
  // app's interior pages are capped to a single ~480px content column
  // (AppShell's .main) regardless of viewport, so the same equal-size,
  // 6-column behavior verified on phones must still hold here.
  const parButtons = page.getByRole('radio', { name: /^[3-6]$/ });
  await assertEqualDimensions(page, parButtons, 'desktop: par buttons');
  const holePickerButtons = page.locator('button[class*="pickerItem"]');
  await expect(holePickerButtons).toHaveCount(18);
  await assertEqualDimensions(page, holePickerButtons, 'desktop: hole picker buttons');
  await assertGridColumnCount(page, holePickerButtons, 6, 'desktop: hole picker grid');

  await archiveCoursesCreatedBy(owner.userId);
});
