import { expect, test } from '@playwright/test';
import { readSeed } from './seed';

// Note: this exercises the SPA's own offline behavior (Dexie cache + the
// offline-fallback hooks), not service-worker app-shell precaching -- the
// dev server (which this suite runs against, see playwright.config.ts) does
// not register a service worker, so a hard page *reload* while offline
// would just hit the browser's own offline error page. Client-side
// navigation within the already-loaded SPA is the correct thing to test
// here; live-scoring.spec.ts uses the same pattern for its offline step.
test('downloads a tournament for offline play, then stays usable with no network', async ({ browser }) => {
  const seed = readSeed();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/sign-in');
  await page.fill('#email', seed.playerA.email);
  await page.fill('#password', seed.playerA.password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');

  await page.goto(`/tournaments/${seed.tournamentId}/overview`);

  await expect(page.getByText('Not downloaded')).toBeVisible();
  await page.getByRole('button', { name: 'Download for Offline Play' }).click();
  await expect(page.getByText('Ready for offline play')).toBeVisible({ timeout: 15_000 });

  // Cached holes should reflect the seeded 2-hole tournament (see e2e/seed.ts).
  const cachedHolesRow = page.locator('dl').filter({ hasText: 'Cached holes' });
  await expect(cachedHolesRow).toContainText('2');

  // Go offline -- the already-loaded SPA must keep working via its Dexie
  // cache, with zero further network requests, for the rest of this test.
  await context.setOffline(true);

  await expect(page.getByText('Offline — scores will upload automatically when your connection returns.')).toBeVisible({
    timeout: 10_000,
  });

  // Client-side navigation (no page reload) to the Scorecard tab -- holes
  // must render from the offline download, not a live fetch.
  await page.getByRole('link', { name: 'Scorecard' }).click();
  await expect(page.getByText(/Par \d/).first()).toBeVisible({ timeout: 10_000 });

  // Live Score tab must also work offline, reading the cached leaderboard.
  await page.getByRole('link', { name: 'Live Score' }).click();
  await expect(page.getByText('Team A')).toBeVisible({ timeout: 10_000 });

  // Offline Data section still reports "ready" (not falsely "update
  // available" just because we can't reach the server to compare versions).
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByText('Ready for offline play')).toBeVisible();

  await context.setOffline(false);
  await context.close();
});
