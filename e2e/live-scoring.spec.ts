import { expect, test, type Page } from '@playwright/test';
import { readSeed } from './seed';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

test('teammate sees a live leaderboard update, then an offline score syncs on reconnect', async ({ browser }) => {
  const seed = readSeed();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await signIn(pageA, seed.playerA.email, seed.playerA.password);
  await signIn(pageB, seed.playerB.email, seed.playerB.password);

  await pageA.goto(`/tournaments/${seed.tournamentId}/scorecard`);
  await pageB.goto(`/tournaments/${seed.tournamentId}/live`);

  // Step 1-2: Team A enters a score for hole 1 (par 4 -> Par -> 4 strokes).
  await pageA.getByRole('button', { name: 'Par', exact: true }).click();
  await expect(pageA.getByText('Score synchronized.')).toBeVisible({ timeout: 10_000 });

  // Step 3: Team B sees the leaderboard update via realtime, no manual refresh.
  const teamARow = pageB.getByRole('button').filter({ hasText: 'Team A' });
  await expect(teamARow).toBeVisible({ timeout: 10_000 });
  await expect(teamARow).toContainText('Through 1');

  // Step 4-5: Team A goes offline and enters another score (hole 2, par 3 -> Par -> 3 strokes).
  await contextA.setOffline(true);
  await pageA.getByRole('button', { name: 'Next Hole' }).click();
  await pageA.getByRole('button', { name: 'Par', exact: true }).click();
  await expect(pageA.getByText('Saved on this phone.')).toBeVisible();

  // Step 6-7: Team A reconnects; the queued operation syncs automatically
  // (no user action beyond restoring connectivity).
  await contextA.setOffline(false);
  await expect(pageA.getByText('Score synchronized.')).toBeVisible({ timeout: 15_000 });

  // Step 8: Team B sees the update reflecting both holes, still live.
  await expect(teamARow).toContainText('Through 2', { timeout: 15_000 });
  await expect(teamARow).toContainText('E'); // even par: hole 1 + hole 2 both scored at par

  await contextA.close();
  await contextB.close();
});
