import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedTournament } from './seed';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

// This spec needs the organizer's own credentials, which seedTournament()
// doesn't return (only the two players'). Re-derive them from the
// service-role client rather than plumbing a third credential through the
// shared seed shape for a single smoke test.
async function organizerCredentialsFor(tournamentId: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: tournament, error } = await admin
    .from('tournaments')
    .select('organizer_user_id')
    .eq('id', tournamentId)
    .single();
  if (error) throw error;
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(
    (tournament as { organizer_user_id: string }).organizer_user_id,
  );
  if (userError) throw userError;
  const email = userData.user.email!;
  // seed.ts sets the same password for every user it creates.
  return { email, password: 'e2e-password-123' };
}

test('organizer sees the incomplete-teams warning and force-finishes into a Results view', async ({ page }) => {
  // Seeds its own tournament (independent of the shared globalSetup one)
  // so this test's "nothing scored yet" assumption can never be broken by
  // another spec running earlier in the same suite.
  const seed = await seedTournament();
  const organizer = await organizerCredentialsFor(seed.tournamentId);

  await page.goto('/sign-in');
  await page.fill('#email', organizer.email);
  await page.fill('#password', organizer.password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');

  await page.goto(`/tournaments/${seed.tournamentId}/overview`);

  await expect(page.getByText('Team Progress')).toBeVisible();
  // Nothing has been scored yet in this freshly-seeded tournament.
  await expect(page.getByText('0/2 complete')).toHaveCount(3);

  await page.getByRole('button', { name: 'Finish Tournament' }).click();

  // Finishing normally is rejected client-side without ever calling
  // finish_tournament(force=false) -- the incomplete-teams warning appears
  // instead of a confirm dialog.
  await expect(page.getByText(/team\(s\) still have incomplete scorecards/)).toBeVisible();

  await page.fill('#force-finish-reason', 'e2e smoke test early close-out');
  await page.getByRole('button', { name: 'Force Complete Tournament' }).click();

  // The Overview route renders ResultsTab once status flips to completed.
  await expect(page.getByText('Forced completion.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('e2e smoke test early close-out')).toBeVisible();
  await expect(page.getByText('Final Rankings')).toBeVisible();
});
