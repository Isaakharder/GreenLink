import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Covers Admin -> Manage Members (supabase/migrations/0037): admin-only
// visibility and RPC enforcement, deactivate/reactivate and its effect on
// the Members directory and Invite Members, historical-data preservation,
// self/last-admin protection, permanent-delete refusal for members with
// tournament history, the strong (type-the-username) delete confirmation
// UI, and mobile layout.

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function anon(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

interface SeededUser {
  id: string;
  email: string;
  password: string;
  fullName: string;
  username: string;
}

async function seedUser(tag: string, firstName: string, lastName: string): Promise<SeededUser> {
  const stamp = Date.now() + Math.floor(Math.random() * 10000);
  const email = `e2e-admin-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const username = `e2e_admin_${tag}_${stamp}`;
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

async function makeAdmin(userId: string): Promise<void> {
  const { error } = await admin().from('profiles').update({ is_admin: true }).eq('id', userId);
  if (error) throw error;
}

async function signInClient(user: SeededUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
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

test.describe('Admin visibility and RPC enforcement', () => {
  test('admin can see Manage Members; ordinary member cannot see the Admin UI', async ({ page }) => {
    const adminUser = await seedUser('viz-admin', 'Ada', 'Admin');
    await makeAdmin(adminUser.id);
    const ordinary = await seedUser('viz-ordinary', 'Ollie', 'Ordinary');

    await signIn(page, adminUser);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Manage Members/ })).toBeVisible();
    await page.getByRole('link', { name: /Manage Members/ }).click();
    await page.waitForURL('**/settings/admin/members');
    await expect(page.getByRole('heading', { name: 'Manage Members' })).toBeVisible();
    await expect(page.getByText(adminUser.fullName)).toBeVisible();

    await page.context().clearCookies();
    await signIn(page, ordinary);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Manage Members/ })).toHaveCount(0);
  });

  test('ordinary authenticated member cannot call admin RPCs directly', async () => {
    const ordinary = await seedUser('rpc-ordinary', 'Nora', 'NotAdmin');
    const client = await signInClient(ordinary);

    const listResult = await client.rpc('admin_list_members');
    expect(listResult.error).not.toBeNull();

    const statusResult = await client.rpc('admin_set_member_status', { p_user_id: ordinary.id, p_status: 'inactive' });
    expect(statusResult.error).not.toBeNull();

    const deleteResult = await client.rpc('admin_permanently_delete_member', { p_user_id: ordinary.id });
    expect(deleteResult.error).not.toBeNull();
  });

  test('anonymous caller cannot call admin RPCs', async () => {
    const listResult = await anon().rpc('admin_list_members');
    expect(listResult.error).not.toBeNull();

    const statusResult = await anon().rpc('admin_set_member_status', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
      p_status: 'inactive',
    });
    expect(statusResult.error).not.toBeNull();

    const deleteResult = await anon().rpc('admin_permanently_delete_member', { p_user_id: '00000000-0000-0000-0000-000000000000' });
    expect(deleteResult.error).not.toBeNull();
  });
});

test.describe('Deactivate / reactivate behavior', () => {
  test('admin can deactivate another member; they disappear from Members and Invite Members, and direct invitation is refused server-side; reactivation restores everything; historical data is untouched throughout', async ({
    page,
  }) => {
    const adminUser = await seedUser('deact-admin', 'Ada', 'Admin');
    await makeAdmin(adminUser.id);
    const target = await seedUser('deact-target', 'Terry', 'Target');

    // Give the target real tournament history before deactivating, so we
    // can prove it survives untouched.
    const organizerClient = await signInClient(adminUser);
    const { data: tournamentId, error: createError } = await organizerClient.rpc('create_tournament', {
      p_name: `E2E Admin History ${Date.now()}`,
      p_course_name: 'E2E Test Course',
      p_tournament_date: new Date().toISOString().slice(0, 10),
    });
    expect(createError).toBeNull();
    const { data: invitationId, error: inviteError } = await organizerClient.rpc('invite_player', {
      p_tournament_id: tournamentId,
      p_invited_user_id: target.id,
    });
    expect(inviteError).toBeNull();
    const targetClient = await signInClient(target);
    const { error: acceptError } = await targetClient.rpc('accept_invitation', { p_invitation_id: invitationId });
    expect(acceptError).toBeNull();

    // Admin deactivates the target via the UI.
    await signIn(page, adminUser);
    await page.goto('/settings/admin/members');
    await page.getByRole('link', { name: new RegExp(target.fullName) }).click();
    await page.waitForURL(/\/settings\/admin\/members\/.+/);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Deactivate Member' }).click();
    await expect(page.getByRole('button', { name: 'Activate Member' })).toBeVisible();
    await expect(page.locator('span', { hasText: 'Inactive' })).toBeVisible();

    // Disappears from the normal Members directory.
    await page.goto('/members');
    await expect(page.getByText(target.fullName)).toHaveCount(0);

    // Disappears from Invite Members on a fresh tournament.
    const { data: secondTournamentId } = await organizerClient.rpc('create_tournament', {
      p_name: `E2E Admin Invite ${Date.now()}`,
      p_course_name: 'E2E Test Course',
      p_tournament_date: new Date().toISOString().slice(0, 10),
    });
    await page.goto(`/tournaments/${secondTournamentId}/teams`);
    const inviteList = page.locator('div[class*="inviteList"]');
    await expect(inviteList.getByText(target.fullName)).toHaveCount(0);

    // Direct invitation is refused server-side even though the UI hides the option.
    const directInviteResult = await organizerClient.rpc('invite_player', {
      p_tournament_id: secondTournamentId as string,
      p_invited_user_id: target.id,
    });
    expect(directInviteResult.error).not.toBeNull();

    // Historical roster/tournament data is completely untouched.
    const { data: rosterRow, error: rosterError } = await admin()
      .from('tournament_players')
      .select('membership_status')
      .eq('tournament_id', tournamentId as string)
      .eq('user_id', target.id)
      .single();
    expect(rosterError).toBeNull();
    expect(rosterRow?.membership_status).toBe('accepted');

    const { data: profileRow } = await admin().from('profiles').select('first_name').eq('id', target.id).single();
    expect(profileRow?.first_name).toBe('Terry');

    // Reactivate: everything comes back.
    await page.goto(`/settings/admin/members/${target.id}`);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Activate Member' }).click();
    await expect(page.getByRole('button', { name: 'Deactivate Member' })).toBeVisible();

    await page.goto('/members');
    await expect(page.getByText(target.fullName)).toBeVisible();
  });
});

test.describe('Self-protection', () => {
  test('an admin cannot deactivate or permanently delete themselves', async ({ page }) => {
    const adminUser = await seedUser('self-admin', 'Sam', 'SelfAdmin');
    await makeAdmin(adminUser.id);

    await signIn(page, adminUser);
    await page.goto(`/settings/admin/members/${adminUser.id}`);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Deactivate Member' }).click();
    await expect(page.getByText(/cannot deactivate your own account/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deactivate Member' })).toBeVisible();

    await page.fill('#deleteConfirm', adminUser.username);
    await page.getByRole('button', { name: 'Permanently Delete Member' }).click();
    await expect(page.getByText(/cannot permanently delete your own account/i)).toBeVisible();

    const { data: stillExists } = await admin().from('profiles').select('id').eq('id', adminUser.id).maybeSingle();
    expect(stillExists).not.toBeNull();
  });
});

test.describe('Permanent delete', () => {
  test('refuses a member with tournament history, with a useful reason', async ({ page }) => {
    const adminUser = await seedUser('hist-admin', 'Hana', 'HistAdmin');
    await makeAdmin(adminUser.id);
    const withHistory = await seedUser('hist-target', 'Owen', 'Organizer');

    const organizerClient = await signInClient(withHistory);
    const { error: createError } = await organizerClient.rpc('create_tournament', {
      p_name: `E2E Cannot Delete ${Date.now()}`,
      p_course_name: 'E2E Test Course',
      p_tournament_date: new Date().toISOString().slice(0, 10),
    });
    expect(createError).toBeNull();

    await signIn(page, adminUser);
    await page.goto(`/settings/admin/members/${withHistory.id}`);
    await page.fill('#deleteConfirm', withHistory.username);
    await page.getByRole('button', { name: 'Permanently Delete Member' }).click();
    await expect(page.getByText(/organizes? \d+ tournament/i)).toBeVisible();

    const { data: stillExists } = await admin().from('profiles').select('id').eq('id', withHistory.id).maybeSingle();
    expect(stillExists).not.toBeNull();
  });

  test('the confirmation input gates the destructive button until the exact username is typed', async ({ page }) => {
    const adminUser = await seedUser('confirm-admin', 'Cora', 'ConfirmAdmin');
    await makeAdmin(adminUser.id);
    const deletable = await seedUser('confirm-target', 'Dana', 'Deletable');

    await signIn(page, adminUser);
    await page.goto(`/settings/admin/members/${deletable.id}`);

    const deleteButton = page.getByRole('button', { name: 'Permanently Delete Member' });
    await expect(deleteButton).toBeDisabled();

    await page.fill('#deleteConfirm', 'not-the-right-username');
    await expect(deleteButton).toBeDisabled();

    await page.fill('#deleteConfirm', deletable.username);
    await expect(deleteButton).toBeEnabled();

    await deleteButton.click();
    await page.waitForURL('**/settings/admin/members');

    const { data: stillExists } = await admin().from('profiles').select('id').eq('id', deletable.id).maybeSingle();
    expect(stillExists).toBeNull();
  });
});

test.describe('Avatar behavior in the admin UI', () => {
  test('Manage Members and member detail show the initials fallback when no photo exists', async ({ page }) => {
    const adminUser = await seedUser('avatar-admin', 'Avery', 'AvatarAdmin');
    await makeAdmin(adminUser.id);

    await signIn(page, adminUser);
    await page.goto('/settings/admin/members');
    const row = page.locator('a[href*="/settings/admin/members/"]', { hasText: adminUser.fullName });
    await expect(row).toBeVisible();
    await expect(row.locator('img')).toHaveCount(0);
    await expect(row.getByText('AA')).toBeVisible();

    await page.goto(`/settings/admin/members/${adminUser.id}`);
    await expect(page.locator('img')).toHaveCount(0);
    await expect(page.getByText('AA')).toBeVisible();
  });
});

test.describe('Mobile layout: Settings, Manage Members, member detail', () => {
  for (const width of [320, 375, 390, 430]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const adminUser = await seedUser(`mobile-${width}`, 'Mo', 'Mobile');
      await makeAdmin(adminUser.id);

      await signIn(page, adminUser);

      for (const path of ['/settings', '/settings/admin/members', `/settings/admin/members/${adminUser.id}`]) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth, `${path} overflowed at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth);
      }
    });
  }
});
