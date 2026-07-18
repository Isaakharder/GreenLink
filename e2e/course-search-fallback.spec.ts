import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

async function seedOrganizer() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now();
  const email = `e2e-course-search-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Cara', last_name: 'CourseTest', username: `e2e_course_${stamp}` },
  });
  if (error) throw error;
  return { email, password };
}

// This suite never depends on a real GolfCourseAPI key/response -- it only
// verifies that the new search UI degrades gracefully (a network/lookup
// failure shows a friendly message) and that manual course/hole entry,
// which must keep working regardless of the external service, still works
// end to end through the real UI (not just via RPC, as the other specs
// exercise it).
test('course search degrades gracefully and manual entry still creates a tournament and saves holes', async ({ page }) => {
  const organizer = await seedOrganizer();

  await page.goto('/sign-in');
  await page.fill('#email', organizer.email);
  await page.fill('#password', organizer.password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');

  await page.goto('/tournaments/new');

  // Typing into the search field without a working GolfCourseAPI must
  // surface a clear message, not a crash, and must never disable manual
  // entry.
  await page.getByPlaceholder('Search by course or club name…').fill('Pinehurst');
  await expect(page.locator('.error-text, [class*="error"]').first()).toBeVisible({ timeout: 10_000 });

  const courseInput = page.locator('#courseName');
  await expect(courseInput).toBeEnabled();

  await page.fill('#name', `Manual Entry Cup ${Date.now()}`);
  await courseInput.fill('Hand-Entered Course');
  await page.fill('#tournamentDate', new Date().toISOString().slice(0, 10));
  await page.selectOption('#holeCount', '9');
  await page.click('button[type=submit]');

  await page.waitForURL('**/overview');
  const tournamentUrl = page.url();
  const tournamentId = tournamentUrl.match(/tournaments\/([0-9a-f-]+)\/overview/)?.[1];
  expect(tournamentId).toBeTruthy();

  // Manual hole entry through Settings must still work end to end.
  await page.goto(`/tournaments/${tournamentId}/settings`);
  await page.getByRole('button', { name: 'Fill Default Pars' }).click();
  await page.getByRole('button', { name: 'Save All Holes' }).click();
  await expect(page.getByText(/Holes saved\. Total par: \d+\./)).toBeVisible({ timeout: 10_000 });
});
