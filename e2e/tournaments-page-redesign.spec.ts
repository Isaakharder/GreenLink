import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Covers the Tournaments page redesign: the intro/status block (heading +
// Pending Invitations / Active Tournaments / Upcoming Tournaments headings
// and their empty-state text) is centered, the DRAFT status badge is hidden
// from Upcoming Tournament cards while COMPLETED remains visible on
// Tournament History cards, and the page has no horizontal overflow at
// phone widths or desktop.

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

const PHONE_WIDTHS = [320, 375, 390, 430] as const;
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function seedUser(tag: string) {
  const stamp = Date.now() + Math.floor(Math.random() * 10000);
  const email = `e2e-tourpage-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Tori', last_name: `Page${stamp}`, username: `e2e_tourpage_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { id: data.user!.id, email, password };
}

async function signInClient(user: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  return client;
}

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

/** Seeds one draft (upcoming-bucket) tournament and one completed (history-bucket) tournament for the given user, so both list buckets render real cards. */
async function seedTournaments(user: { id: string; email: string; password: string }) {
  const client = await signInClient(user);

  const { data: draftId, error: draftError } = await client.rpc('create_tournament', {
    p_name: `E2E Draft ${Date.now()}`,
    p_course_name: 'E2E Test Course',
    p_tournament_date: new Date().toISOString().slice(0, 10),
  });
  if (draftError) throw draftError;

  const { data: completedId, error: completedError } = await client.rpc('create_tournament', {
    p_name: `E2E Completed ${Date.now()}`,
    p_course_name: 'E2E Test Course',
    p_tournament_date: new Date().toISOString().slice(0, 10),
  });
  if (completedError) throw completedError;

  // Flip straight to completed for test purposes -- the point here is
  // rendering a Tournament History card, not exercising the real lifecycle
  // (already covered by organizer-finish.spec.ts / tournament pgTAP suite).
  const { error: updateError } = await admin()
    .from('tournaments')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', completedId as string);
  if (updateError) throw updateError;

  return { draftId: draftId as string, completedId: completedId as string };
}

test.describe('Tournaments page redesign', () => {
  test('intro/status headings are centered; cards and Tournament History stay left-aligned', async ({ page }) => {
    const user = await seedUser('centering');
    await seedTournaments(user);
    await signIn(page, user);

    await page.goto('/tournaments');
    await expect(page.getByRole('heading', { name: 'Tournaments', level: 1 })).toBeVisible();

    const centeredSelectors = [
      page.getByRole('heading', { name: 'Tournaments', level: 1 }),
      page.getByRole('heading', { name: 'Pending Invitations' }),
      page.getByText('No pending invitations.'),
      page.getByRole('heading', { name: 'Active Tournaments' }),
      page.getByText('No active tournaments.'),
      page.getByRole('heading', { name: 'Upcoming Tournaments' }),
    ];
    for (const locator of centeredSelectors) {
      await expect(locator).toHaveCSS('text-align', 'center');
    }

    // Tournament History heading/cards are explicitly NOT part of the
    // centered intro block -- left as normal, unchanged.
    await expect(page.getByRole('heading', { name: 'Tournament History' })).toHaveCSS('text-align', 'start');
  });

  test('DRAFT badge is hidden on Upcoming Tournament cards; COMPLETED remains on Tournament History cards', async ({ page }) => {
    const user = await seedUser('badges');
    const { draftId, completedId } = await seedTournaments(user);
    await signIn(page, user);

    await page.goto('/tournaments');

    const draftCard = page.locator(`a[href="/tournaments/${draftId}/overview"]`);
    await expect(draftCard).toBeVisible();
    await expect(draftCard.getByText('draft', { exact: true })).toHaveCount(0);
    await expect(draftCard.getByText('DRAFT', { exact: true })).toHaveCount(0);

    const completedCard = page.locator(`a[href="/tournaments/${completedId}/overview"]`);
    await expect(completedCard).toBeVisible();
    await expect(completedCard.getByText('completed', { exact: true })).toBeVisible();
  });

  for (const width of PHONE_WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const user = await seedUser(`phone-${width}`);
      await seedTournaments(user);
      await signIn(page, user);

      await page.goto('/tournaments');
      await expect(page.getByRole('heading', { name: 'Tournaments', level: 1 })).toBeVisible();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }

  test('desktop: page renders with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    const user = await seedUser('desktop');
    await seedTournaments(user);
    await signIn(page, user);

    await page.goto('/tournaments');
    await expect(page.getByRole('heading', { name: 'Tournaments', level: 1 })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
