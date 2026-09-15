import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function seedUser() {
  const stamp = Date.now();
  const email = `e2e-members-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const lastName = `Memberson${stamp}`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Mia', last_name: lastName, username: `e2e_members_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id, fullName: `Mia ${lastName}` };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

test('Members card on Home navigates to the member directory, listing the signed-in user as an Active Member with no email exposed', async ({ page }) => {
  const { email, password, fullName } = await seedUser();

  await signIn(page, email, password);

  await page.getByRole('button', { name: 'Members' }).click();
  await page.waitForURL('**/members');
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();

  // Member rows are plain, non-interactive cards (no profile page to link to
  // yet) -- not buttons/links.
  const memberCard = page.locator('div[class*="card"]', { hasText: fullName });
  await expect(memberCard).toBeVisible();
  await expect(memberCard.getByRole('button')).toHaveCount(0);
  await expect(memberCard.getByText('Active Member')).toBeVisible();
  // A brand-new user has never played a round.
  await expect(memberCard.getByText('0', { exact: true })).toBeVisible();
  await expect(memberCard.getByText('rounds played')).toBeVisible();

  // The directory must never leak the account's email anywhere on the page.
  await expect(page.getByText(email)).toHaveCount(0);
});
