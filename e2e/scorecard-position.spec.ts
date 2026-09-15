import { expect, test, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

// Regression coverage for the "scorecard resets to Hole 1" bug: closing the
// app, backgrounding it, refreshing, going offline, or navigating away from
// and back to the Scorecard tab must never lose the hole the user was
// actually viewing. See src/lib/scorecardPosition.ts and the restore effect
// in src/pages/tournament/ScorecardTab.tsx.

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

async function seedPlayer(tag: string) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now();
  const email = `e2e-holepos-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Peri', last_name: `Position${stamp}`, username: `e2e_holepos_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { email, password, userId: data.user!.id };
}

/**
 * Same "known-unusable course" trick as mygolf-manual-scorecard.spec.ts:
 * skips straight to the manual-scorecard form with no real import call, so
 * these tests can start an 18-hole personal round without depending on a
 * real course/tee fixture.
 */
function mockGolfCourseLookup(page: Page) {
  return page.route('**/functions/v1/golf-course-lookup', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.action === 'search') {
      await route.fulfill({
        json: {
          results: [
            {
              externalId: 'e2e-holepos-course',
              clubName: 'E2E Hole Position Club',
              courseName: 'No Data Nine',
              city: 'Testville',
              state: 'NC',
              country: 'USA',
              scorecardStatus: 'unusable',
            },
          ],
        },
      });
      return;
    }
    await route.continue();
  });
}

/** Starts an 18-hole personal round (par 4 throughout) via manual scorecard entry, landing on the Scorecard tab. */
async function startPersonalRound(page: Page) {
  await mockGolfCourseLookup(page);
  await page.goto('/my-golf/start');
  await page.getByPlaceholder('Search by course or club name…').fill('Hole Position');
  await page.getByRole('button', { name: /E2E Hole Position Club/ }).click();
  await page.getByRole('button', { name: 'Enter Scorecard Manually' }).click();

  for (let hole = 1; hole <= 18; hole++) {
    await page.fill(`#manual-par-${hole}`, '4');
  }
  await page.getByRole('button', { name: 'Use for This Round Only' }).click();
  await page.waitForURL('**/my-golf/round/**', { timeout: 10_000 });
  await expect(page.getByText('Hole 1', { exact: true })).toBeVisible({ timeout: 10_000 });
}

function holeHeading(page: Page, holeNumber: number) {
  return page.getByText(`Hole ${holeNumber}`, { exact: true });
}

function pickerHoleButton(page: Page, holeNumber: number) {
  // Each picker row is a button containing two spans ("Hole N" and a status
  // badge like "Empty"/"Saved") -- filtering by an exact-text descendant
  // avoids relying on how those two spans get concatenated into the
  // button's accessible name, and avoids "Hole 1" ever matching "Hole 10".
  return page.getByRole('button').filter({ has: page.getByText(`Hole ${holeNumber}`, { exact: true }) });
}

async function selectHoleFromPicker(page: Page, holeNumber: number) {
  await page.getByRole('button', { name: /Choose a Hole|Hide Hole Picker/ }).click();
  await pickerHoleButton(page, holeNumber).click();
}

test.describe('personal round scorecard position persistence', () => {
  test('navigate to a later hole, then remount (route change) restores it, not Hole 1', async ({ page }) => {
    const player = await seedPlayer('remount');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: 'Next Hole' }).click();
    }
    await expect(holeHeading(page, 7)).toBeVisible();

    // Navigate away (My Golf list) and back -- unmounts/remounts ScorecardTab
    // exactly like switching to a different tab and returning.
    await page.goto('/my-golf');
    await page.goBack();
    await expect(holeHeading(page, 7)).toBeVisible({ timeout: 10_000 });
  });

  test('navigate to Hole 13, then a full browser refresh restores Hole 13', async ({ page }) => {
    const player = await seedPlayer('refresh');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    await selectHoleFromPicker(page, 13);
    await expect(holeHeading(page, 13)).toBeVisible();

    await page.reload();
    await expect(holeHeading(page, 13)).toBeVisible({ timeout: 10_000 });
  });

  test('a saved position on Hole 13 wins over earlier unscored holes (shotgun / out-of-order play)', async ({ page }) => {
    const player = await seedPlayer('priority');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    // Holes 1-12 are left unscored; the user jumps straight to hole 13,
    // simulating a shotgun start or otherwise playing out of sequence.
    await selectHoleFromPicker(page, 13);
    await expect(holeHeading(page, 13)).toBeVisible();

    await page.reload();
    // Must NOT fall back to hole 1 (the first unscored hole) -- the saved
    // position takes priority.
    await expect(holeHeading(page, 13)).toBeVisible({ timeout: 10_000 });
  });

  test('with no saved position, a fresh round still defaults to Hole 1', async ({ page }) => {
    const player = await seedPlayer('default');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);
    await expect(holeHeading(page, 1)).toBeVisible();
  });

  test('a round beginning play on Hole 10 (shotgun start) persists Hole 10 across a reload', async ({ page }) => {
    const player = await seedPlayer('shotgun');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    // First action of the round is jumping to hole 10 -- nothing scored yet.
    await selectHoleFromPicker(page, 10);
    await expect(holeHeading(page, 10)).toBeVisible();

    await page.reload();
    await expect(holeHeading(page, 10)).toBeVisible({ timeout: 10_000 });
  });

  test('hole picker navigation persists across a reload', async ({ page }) => {
    const player = await seedPlayer('picker');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    await selectHoleFromPicker(page, 9);
    await expect(holeHeading(page, 9)).toBeVisible();

    await page.reload();
    await expect(holeHeading(page, 9)).toBeVisible({ timeout: 10_000 });
  });

  test('Previous/Next Hole navigation persists across a reload', async ({ page }) => {
    const player = await seedPlayer('prevnext');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    await page.getByRole('button', { name: 'Next Hole' }).click();
    await page.getByRole('button', { name: 'Next Hole' }).click();
    await page.getByRole('button', { name: 'Next Hole' }).click();
    await page.getByRole('button', { name: 'Previous Hole' }).click();
    await expect(holeHeading(page, 3)).toBeVisible();

    await page.reload();
    await expect(holeHeading(page, 3)).toBeVisible({ timeout: 10_000 });
  });

  test('"Save & Next" persists the newly selected next hole', async ({ page }) => {
    const player = await seedPlayer('savenext');
    await signIn(page, player.email, player.password);
    await startPersonalRound(page);

    await page.getByRole('button', { name: 'Par', exact: true }).click();
    await expect(page.getByText('Score synchronized.')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Save & Next' }).click();
    await expect(holeHeading(page, 2)).toBeVisible();

    await page.reload();
    await expect(holeHeading(page, 2)).toBeVisible({ timeout: 10_000 });
  });
});

interface TeamSeedResult {
  tournamentId: string;
  playerA: { email: string; password: string };
  playerB: { email: string; password: string };
}

/**
 * A live tournament with exactly one team holding BOTH players -- unlike
 * e2e/seed.ts's fixture (one player per team), this lets a test drive two
 * independent browser sessions that see the same team's shared scores, to
 * prove a teammate's realtime score change never moves the *other* player's
 * currently-viewed hole (current-hole position is personal UI state, not
 * shared team state).
 */
async function seedTeamTournament(holeCount: number): Promise<TeamSeedResult> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const stamp = Date.now();
  const organizer = { email: `e2e-holepos-team-org-${stamp}@example.test`, password: 'e2e-password-123' };
  const playerA = { email: `e2e-holepos-team-a-${stamp}@example.test`, password: 'e2e-password-123' };
  const playerB = { email: `e2e-holepos-team-b-${stamp}@example.test`, password: 'e2e-password-123' };

  async function createUser(email: string, password: string, tag: string) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: 'Terri', last_name: `Teammate${stamp}`, username: `e2e_holepos_${tag}_${stamp}` },
    });
    if (error) throw error;
    return data.user!.id;
  }

  await createUser(organizer.email, organizer.password, 'org');
  const playerAId = await createUser(playerA.email, playerA.password, 'a');
  const playerBId = await createUser(playerB.email, playerB.password, 'b');

  const organizerClient = createClient(SUPABASE_URL, process.env.E2E_SUPABASE_ANON_KEY!);
  const { error: signInError } = await organizerClient.auth.signInWithPassword(organizer);
  if (signInError) throw signInError;

  const { data: tournamentId, error: createError } = await organizerClient.rpc('create_tournament', {
    p_name: `E2E Hole Position Team ${stamp}`,
    p_course_name: 'E2E Test Course',
    p_tournament_date: new Date().toISOString().slice(0, 10),
    p_hole_count: holeCount,
    p_scoring_format: 'Team Scramble',
    // start_tournament() requires every team to have exactly team_size
    // players -- one shared team of 3 (organizer + both players) satisfies
    // that with a single team, rather than juggling two teams of mismatched
    // sizes just to give the auto-added organizer somewhere to go.
    p_team_size: 3,
  });
  if (createError) throw createError;

  const { data: invA, error: invAError } = await organizerClient.rpc('invite_player', { p_tournament_id: tournamentId, p_invited_user_id: playerAId });
  if (invAError) throw invAError;
  const { data: invB, error: invBError } = await organizerClient.rpc('invite_player', { p_tournament_id: tournamentId, p_invited_user_id: playerBId });
  if (invBError) throw invBError;

  const aClient = createClient(SUPABASE_URL, process.env.E2E_SUPABASE_ANON_KEY!);
  await aClient.auth.signInWithPassword(playerA);
  const { error: acceptAError } = await aClient.rpc('accept_invitation', { p_invitation_id: invA });
  if (acceptAError) throw acceptAError;

  const bClient = createClient(SUPABASE_URL, process.env.E2E_SUPABASE_ANON_KEY!);
  await bClient.auth.signInWithPassword(playerB);
  const { error: acceptBError } = await bClient.rpc('accept_invitation', { p_invitation_id: invB });
  if (acceptBError) throw acceptBError;

  // The organizer is auto-added as an accepted player on their own
  // tournament, so they need a team too -- put all three on the one shared
  // team rather than juggling a second, differently-sized team.
  const { data: team, error: teamError } = await organizerClient.rpc('create_tournament_team', { p_tournament_id: tournamentId, p_name: 'Team AB' });
  if (teamError) throw teamError;

  const { data: players, error: playersError } = await organizerClient
    .from('tournament_players')
    .select('id, user_id')
    .eq('tournament_id', tournamentId);
  if (playersError) throw playersError;

  const organizerPlayerId = players!.find((p) => p.user_id !== playerAId && p.user_id !== playerBId)!.id;
  const playerAPlayerId = players!.find((p) => p.user_id === playerAId)!.id;
  const playerBPlayerId = players!.find((p) => p.user_id === playerBId)!.id;

  for (const playerId of [organizerPlayerId, playerAPlayerId, playerBPlayerId]) {
    const { error } = await organizerClient.rpc('assign_tournament_player', { p_player_id: playerId, p_team_id: team.id });
    if (error) throw error;
  }

  const holes = Array.from({ length: holeCount }, (_, i) => ({ hole_number: i + 1, par: 4 }));
  const { error: holesError } = await organizerClient.rpc('save_tournament_holes', { p_tournament_id: tournamentId, p_holes: holes });
  if (holesError) throw holesError;

  const { error: startError } = await organizerClient.rpc('start_tournament', { p_tournament_id: tournamentId });
  if (startError) throw startError;

  return { tournamentId, playerA, playerB };
}

test.describe('tournament scorecard position persistence', () => {
  test('a teammate scoring a different hole in realtime does not move my current hole', async ({ browser }) => {
    const seed = await seedTeamTournament(5);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await signIn(pageA, seed.playerA.email, seed.playerA.password);
    await signIn(pageB, seed.playerB.email, seed.playerB.password);

    await pageA.goto(`/tournaments/${seed.tournamentId}/scorecard`);
    await pageB.goto(`/tournaments/${seed.tournamentId}/scorecard`);

    // Player A navigates to hole 4 and stays there.
    await selectHoleFromPicker(pageA, 4);
    await expect(holeHeading(pageA, 4)).toBeVisible();

    // Player B (teammate, shares the same team's scores) is on hole 2 and
    // scores it -- this is a realtime score change for the team A is on.
    await selectHoleFromPicker(pageB, 2);
    await pageB.getByRole('button', { name: 'Par', exact: true }).click();
    await expect(pageB.getByText('Score synchronized.')).toBeVisible({ timeout: 10_000 });

    // Player A's own cached-scores view updates (their "Through N" count
    // moves), but their currently-viewed hole must not move off hole 4.
    await expect(pageA.getByText('Through 1')).toBeVisible({ timeout: 10_000 });
    await expect(holeHeading(pageA, 4)).toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});

test('navigating to Live Score and back does not reset the current hole', async ({ page }) => {
  const seed = await seedTeamTournament(5);
  await signIn(page, seed.playerA.email, seed.playerA.password);
  await page.goto(`/tournaments/${seed.tournamentId}/scorecard`);

  await selectHoleFromPicker(page, 3);
  await expect(holeHeading(page, 3)).toBeVisible();

  await page.getByRole('link', { name: 'Live Score' }).click();
  await page.waitForURL(`**/tournaments/${seed.tournamentId}/live`);
  await page.getByRole('link', { name: 'Scorecard' }).click();
  await page.waitForURL(`**/tournaments/${seed.tournamentId}/scorecard`);

  await expect(holeHeading(page, 3)).toBeVisible({ timeout: 10_000 });
});

test('navigate to a later hole, go offline, remount: position and a pending offline score both survive', async ({ page, context }) => {
  const seed = await seedTeamTournament(18);
  await signIn(page, seed.playerA.email, seed.playerA.password);
  await page.goto(`/tournaments/${seed.tournamentId}/scorecard`);

  await selectHoleFromPicker(page, 13);
  await expect(holeHeading(page, 13)).toBeVisible();
  // Visiting the tab online write-through caches holes/scores/membership
  // into Dexie (see useLeaderboardData.ts and useTournamentAccess.ts) --
  // no explicit "Download for Offline Play" step is needed for this.

  await context.setOffline(true);

  // The dev server this suite runs against registers no service worker, so
  // a hard page reload while offline just hits the browser's own offline
  // error page (see offline-download.spec.ts). Remounting via in-app
  // client-side tab navigation (no document reload) is the realistic
  // equivalent, and matches this suite's established offline-testing
  // pattern.
  await page.getByRole('link', { name: 'Live Score' }).click();
  await page.getByRole('link', { name: 'Scorecard' }).click();
  await expect(holeHeading(page, 13)).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Par', exact: true }).click();
  await expect(page.getByText('Saved on this phone.')).toBeVisible();

  // Remount again while still offline -- both the position and the pending
  // score must survive a second close/reopen with no connection.
  await page.getByRole('link', { name: 'Live Score' }).click();
  await page.getByRole('link', { name: 'Scorecard' }).click();
  await expect(holeHeading(page, 13)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Saved on this phone.')).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText('Score synchronized.')).toBeVisible({ timeout: 15_000 });
});
