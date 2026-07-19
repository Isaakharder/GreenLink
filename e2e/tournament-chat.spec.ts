import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedTournament } from './seed';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

// seedTournament() (e2e/seed.ts) doesn't return the organizer's own
// credentials (only the two players') -- same technique organizer-finish.spec.ts
// already uses to re-derive them from the service-role client.
async function organizerCredentialsFor(tournamentId: string) {
  const { data: tournament, error } = await admin().from('tournaments').select('organizer_user_id').eq('id', tournamentId).single();
  if (error) throw error;
  const { data: userData, error: userError } = await admin().auth.admin.getUserById(
    (tournament as { organizer_user_id: string }).organizer_user_id,
  );
  if (userError) throw userError;
  return { email: userData.user.email!, password: 'e2e-password-123' };
}

async function seedOutsider() {
  const stamp = Date.now();
  const email = `e2e-chat-outsider-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Ozzy', last_name: 'Outsider', username: `e2e_chat_outsider_${stamp}` },
  });
  if (error) throw error;
  return { email, password };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/home');
}

test('realtime delivery, unread badge, toast, read receipts, and offline retry between two members', async ({ browser }) => {
  const seed = await seedTournament();
  const organizer = await organizerCredentialsFor(seed.tournamentId);

  const contextOrganizer = await browser.newContext();
  const contextPlayer = await browser.newContext();
  const pageOrganizer = await contextOrganizer.newPage();
  const pagePlayer = await contextPlayer.newPage();

  await signIn(pageOrganizer, organizer.email, organizer.password);
  await signIn(pagePlayer, seed.playerA.email, seed.playerA.password);

  await pageOrganizer.goto(`/tournaments/${seed.tournamentId}/overview`);
  await pagePlayer.goto(`/tournaments/${seed.tournamentId}/overview`);

  // Both accepted members see the chat button; a non-member never would
  // (see the separate outsider test below).
  await expect(pageOrganizer.getByRole('button', { name: 'Open tournament chat' })).toBeVisible();
  await expect(pagePlayer.getByRole('button', { name: 'Open tournament chat' })).toBeVisible();

  // The player opens (and closes) the empty chat once first, establishing a
  // read marker -- the unread separator only means anything relative to a
  // *previous* read point (a first-ever open has nothing to separate from,
  // by design: everything would trivially be "new").
  await pagePlayer.getByRole('button', { name: 'Open tournament chat' }).click();
  await expect(pagePlayer.getByText('No messages yet — say hello!')).toBeVisible();
  await pagePlayer.getByRole('button', { name: 'Close chat' }).click();

  // --- Organizer sends while the player's chat is closed. ---
  await pageOrganizer.getByRole('button', { name: 'Open tournament chat' }).click();
  await pageOrganizer.getByPlaceholder('Message the tournament…').fill('Nice drive!');
  await pageOrganizer.getByRole('button', { name: 'Send' }).click();
  await expect(pageOrganizer.getByRole('main').getByText('Nice drive!')).toBeVisible();

  // The player, chat closed, gets an unread badge + toast (not an
  // interruption to anything -- no modal, no blocked score entry). The
  // toast's own copy of the message text is scoped out of every other
  // assertion below via getByRole('main') (ToastHost renders outside <main>).
  await expect(pagePlayer.getByText('New tournament message')).toBeVisible({ timeout: 10_000 });
  await expect(pagePlayer.getByRole('button', { name: 'Open tournament chat' })).toContainText('1');

  // Opening the chat shows the message, the sender's team, and clears unread.
  await pagePlayer.getByRole('button', { name: 'Open tournament chat' }).click();
  await expect(pagePlayer.getByRole('main').getByText('Nice drive!')).toBeVisible();
  await expect(pagePlayer.getByText('New messages')).toBeVisible(); // unread separator, since this arrived after last read
  await expect(pagePlayer.getByRole('button', { name: /Open tournament chat|View tournament chat/ })).not.toContainText('1');

  // --- Player replies; organizer (chat still open) sees it live, no toast needed. ---
  await pagePlayer.getByPlaceholder('Message the tournament…').fill('Thanks!');
  await pagePlayer.getByRole('button', { name: 'Send' }).click();
  await expect(pageOrganizer.getByRole('main').getByText('Thanks!')).toBeVisible({ timeout: 10_000 });

  // --- Offline retry: the player queues a message while offline. ---
  await contextPlayer.setOffline(true);
  await pagePlayer.getByPlaceholder('Message the tournament…').fill('can you hear me?');
  await pagePlayer.getByRole('button', { name: 'Send' }).click();
  await expect(pagePlayer.getByText('Sending…')).toBeVisible();

  await contextPlayer.setOffline(false);
  await expect(pagePlayer.getByText('Sending…')).toHaveCount(0, { timeout: 15_000 });
  await expect(pagePlayer.getByText('can you hear me?')).toBeVisible();

  // Reconnect delivered exactly one message -- never duplicated by the retry.
  await expect(pagePlayer.getByText('can you hear me?')).toHaveCount(1);
  const { count } = await admin()
    .from('tournament_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', seed.tournamentId)
    .eq('message_text', 'can you hear me?');
  expect(count).toBe(1);

  // --- Own-message delete. ---
  await pagePlayer.getByText('Thanks!').locator('..').getByRole('button', { name: 'Delete message' }).click();
  await expect(pagePlayer.getByText('Message removed')).toBeVisible();

  await contextOrganizer.close();
  await contextPlayer.close();
});

test('an outsider gets no chat access, and a completed tournament is read-only with history preserved', async ({ page, browser }) => {
  const seed = await seedTournament();
  const organizer = await organizerCredentialsFor(seed.tournamentId);
  const outsider = await seedOutsider();

  // Send one message as the organizer, then force-finish the tournament.
  const organizerContext = await browser.newContext();
  const organizerPage = await organizerContext.newPage();
  await signIn(organizerPage, organizer.email, organizer.password);
  await organizerPage.goto(`/tournaments/${seed.tournamentId}/overview`);
  await organizerPage.getByRole('button', { name: 'Open tournament chat' }).click();
  await organizerPage.getByPlaceholder('Message the tournament…').fill('gg everyone');
  await organizerPage.getByRole('button', { name: 'Send' }).click();
  await expect(organizerPage.getByRole('main').getByText('gg everyone')).toBeVisible();
  await organizerPage.getByRole('button', { name: 'Close chat' }).click();

  // Force-finish through the real UI (same flow as organizer-finish.spec.ts)
  // rather than an admin-client RPC call: finish_tournament() derives the
  // organizer from auth.uid(), which a service-role call has none of.
  await organizerPage.getByRole('button', { name: 'Finish Tournament' }).click();
  await expect(organizerPage.getByText(/team\(s\) still have incomplete scorecards/)).toBeVisible();
  await organizerPage.fill('#force-finish-reason', 'e2e chat read-only check');
  await organizerPage.getByRole('button', { name: 'Force Complete Tournament' }).click();
  await expect(organizerPage.getByText('Forced completion.')).toBeVisible({ timeout: 10_000 });
  await organizerContext.close();

  // The outsider was never invited to this tournament at all.
  await signIn(page, outsider.email, outsider.password);
  await page.goto(`/tournaments/${seed.tournamentId}/overview`);
  await expect(page.getByText('Tournament not found')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tournament chat' })).toHaveCount(0);

  // The organizer still sees the (now read-only) chat with history intact.
  const reopenContext = await browser.newContext();
  const reopenPage = await reopenContext.newPage();
  await signIn(reopenPage, organizer.email, organizer.password);
  await reopenPage.goto(`/tournaments/${seed.tournamentId}/overview`);
  await reopenPage.getByRole('button', { name: /View tournament chat|Open tournament chat/ }).click();
  await expect(reopenPage.getByText('Tournament completed — chat is read-only.')).toBeVisible();
  await expect(reopenPage.getByText('gg everyone')).toBeVisible();
  await expect(reopenPage.getByPlaceholder('Message the tournament…')).toHaveCount(0);
  await reopenContext.close();
});
