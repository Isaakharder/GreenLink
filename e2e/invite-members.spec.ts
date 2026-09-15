import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

interface SeededUser {
  id: string;
  email: string;
  password: string;
  fullName: string;
  username: string;
}

// last_name is stamped unique -- this shared local Postgres volume also
// carries fixture users seeded by other specs' global setup (e.g. an
// "Ollie Organizer" from seed.ts), and list_members() returns every profile
// in the database, so an unstamped name here could collide with one of
// those and make a name-based assertion match more rows than intended.
async function createConfirmedUser(tag: string, firstName: string, lastName: string): Promise<SeededUser> {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `e2e-invite-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const username = `e2e_invite_${tag}_${stamp}`;
  const stampedLastName = `${lastName}${stamp}`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: stampedLastName, username },
  });
  if (error) throw error;
  return { id: data.user!.id, email, password, fullName: `${firstName} ${stampedLastName}`, username };
}

async function signInClient(user: SeededUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  return client;
}

async function signIn(page: Page, user: SeededUser) {
  await page.goto('/sign-in');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

test('Teams tab Invite Members: discovers every member without username search, reuses the existing invite/accept/decline path, and never exposes email', async ({
  page,
}) => {
  const organizer = await createConfirmedUser('org', 'Ollie', 'Organizer');
  const eligible = await createConfirmedUser('eligible', 'Ellie', 'Eligible');
  const accepted = await createConfirmedUser('accepted', 'Ana', 'Accepted');
  const declined = await createConfirmedUser('declined', 'Dez', 'Declined');

  const organizerClient = await signInClient(organizer);

  const { data: tournamentId, error: createError } = await organizerClient.rpc('create_tournament', {
    p_name: `E2E Invite Members ${Date.now()}`,
    p_course_name: 'E2E Test Course',
    p_tournament_date: new Date().toISOString().slice(0, 10),
    p_hole_count: 9,
  });
  if (createError) throw createError;

  // accepted: invited, then accepts (the invitee-side flow, already covered
  // elsewhere -- driven via RPC here since it's not what this test proves).
  const { data: acceptedInvitationId, error: inviteAcceptedError } = await organizerClient.rpc('invite_player', {
    p_tournament_id: tournamentId,
    p_invited_user_id: accepted.id,
  });
  if (inviteAcceptedError) throw inviteAcceptedError;
  const acceptedClient = await signInClient(accepted);
  const { error: acceptError } = await acceptedClient.rpc('accept_invitation', { p_invitation_id: acceptedInvitationId });
  if (acceptError) throw acceptError;

  // declined: invited, then declines -- must become invitable again.
  const { data: declinedInvitationId, error: inviteDeclinedError } = await organizerClient.rpc('invite_player', {
    p_tournament_id: tournamentId,
    p_invited_user_id: declined.id,
  });
  if (inviteDeclinedError) throw inviteDeclinedError;
  const declinedClient = await signInClient(declined);
  const { error: declineError } = await declinedClient.rpc('decline_invitation', { p_invitation_id: declinedInvitationId });
  if (declineError) throw declineError;

  // eligible: never invited at all -- left alone so the test can invite them
  // through the real UI below.

  await signIn(page, organizer);
  await page.goto(`/tournaments/${tournamentId}/teams`);
  await expect(page.getByRole('heading', { name: 'Invite Members' })).toBeVisible();

  // The organizer is not shown as someone they can invite -- their name
  // appears exactly once on the page (the Organizer section below), not
  // also as a row in Invite Members.
  await expect(page.getByText(organizer.fullName, { exact: true })).toHaveCount(1);

  // Every row assertion below is scoped to the Invite Members list
  // specifically (not just "a div with this text anywhere on the page") --
  // the same person can legitimately appear again in Accepted Players /
  // Pending Invitations / Declined Invitations, and this list's status must
  // be checked independently of those.
  const inviteList = page.locator('div[class*="inviteList"]');
  const rowFor = (user: SeededUser) => inviteList.locator('div[class*="playerRow"]', { hasText: user.fullName });

  // eligible: discoverable and invitable with no username search, username shown.
  const eligibleRow = rowFor(eligible);
  await expect(eligibleRow.getByText(`@${eligible.username}`)).toBeVisible();
  const eligibleInviteButton = eligibleRow.getByRole('button', { name: 'Invite' });
  await expect(eligibleInviteButton).toBeVisible();

  // accepted: shows Accepted, no Invite button (duplicate invitations are
  // not possible through the UI -- there is nothing to click).
  const acceptedRow = rowFor(accepted);
  await expect(acceptedRow.getByText('Accepted ✓')).toBeVisible();
  await expect(acceptedRow.getByRole('button', { name: 'Invite' })).toHaveCount(0);

  // declined: back to invitable (invite_player revives it), not shown as "Declined" in this list.
  const declinedRow = rowFor(declined);
  await expect(declinedRow.getByRole('button', { name: 'Invite' })).toBeVisible();
  // exact: the last name itself contains "Declined" as a substring.
  await expect(declinedRow.getByText('Declined', { exact: true })).toHaveCount(0);

  // Inviting through the real UI uses the existing invite_player path: the
  // row updates to Pending via the existing query invalidation, no reload.
  await eligibleInviteButton.click();
  await expect(eligibleRow.getByText('Pending')).toBeVisible();
  await expect(eligibleRow.getByRole('button', { name: 'Invite' })).toHaveCount(0);

  // The existing lower sections are untouched and still show their own actions.
  await expect(page.getByRole('heading', { name: 'Organizer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted Players' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pending Invitations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Declined Invitations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-invite' })).toBeVisible();

  // Never expose email/auth information anywhere on this page.
  for (const user of [organizer, eligible, accepted, declined]) {
    await expect(page.getByText(user.email)).toHaveCount(0);
  }
});
