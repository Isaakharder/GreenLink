import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PHOTO_A = path.join(REPO_ROOT, 'public/icons/icon-192.png');
const PHOTO_B = path.join(REPO_ROOT, 'public/icons/icon-512.png');

// Real, decodable PNG bytes for tests that seed an avatar directly via the
// admin Storage API and then check that a browser <img> actually renders it
// (as opposed to the security tests below, which only check API-level
// upload/replace/delete outcomes and never load the bytes in a browser --
// those keep using cheap placeholder Blobs). The bucket's allowed_mime_types
// includes image/png, so a real PNG works fine even though the object's
// deterministic path still ends in "avatar.webp" -- the browser decodes by
// actual bytes, not by filename extension.
const REAL_AVATAR_PNG_BYTES = fs.readFileSync(PHOTO_A);
function realAvatarBlob(): Blob {
  return new Blob([REAL_AVATAR_PNG_BYTES], { type: 'image/png' });
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

interface SeededUser {
  id: string;
  email: string;
  password: string;
  fullName: string;
}

async function seedUser(tag: string, firstName: string): Promise<SeededUser> {
  const stamp = Date.now() + Math.floor(Math.random() * 10000);
  const lastName = `Avatar${stamp}`;
  const email = `e2e-avatar-${tag}-${stamp}@example.test`;
  const password = 'e2e-password-123';
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName, username: `e2e_avatar_${tag}_${stamp}` },
  });
  if (error) throw error;
  return { id: data.user!.id, email, password, fullName: `${firstName} ${lastName}` };
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

test.describe('Edit Profile: upload, replace, remove -- propagates without a reload', () => {
  test('full lifecycle', async ({ page }) => {
    const user = await seedUser('lifecycle', 'Isaak');

    await signIn(page, user);

    // The Profile card is tappable and opens Edit Profile.
    await page.goto('/profile');
    await expect(page.getByText(user.fullName)).toBeVisible();
    await page.getByRole('link', { name: new RegExp(user.fullName) }).click();
    await page.waitForURL('**/profile/edit');

    // Upload: preview appears before saving, initials fallback is gone.
    await page.locator('input[type="file"]').setInputFiles(PHOTO_A);
    await expect(page.locator('img')).toBeVisible();

    const newFirstName = 'Updated';
    await page.fill('#editFirstName', newFirstName);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL('**/profile');

    // Profile now shows the new name and a real photo (an <img>, not initials text).
    await expect(page.getByText(`${newFirstName} ${user.fullName.split(' ')[1]}`)).toBeVisible();
    await expect(page.locator('img')).toBeVisible({ timeout: 10_000 });

    // Propagates to Members with no reload (same SPA session, no page.reload()).
    await page.goto('/members');
    const memberCard = page.locator('div[class*="card"]', { hasText: `${newFirstName} ${user.fullName.split(' ')[1]}` });
    await expect(memberCard).toBeVisible();
    await expect(memberCard.locator('img')).toBeVisible({ timeout: 10_000 });

    // Replace with a different photo.
    await page.goto('/profile/edit');
    await page.locator('input[type="file"]').setInputFiles(PHOTO_B);
    await expect(page.locator('img')).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL('**/profile');
    await expect(page.locator('img')).toBeVisible({ timeout: 10_000 });

    // Remove entirely -- back to initials, everywhere, still no reload.
    await page.goto('/profile/edit');
    await expect(page.getByRole('button', { name: 'Remove Photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Photo' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL('**/profile');
    await expect(page.locator('img')).toHaveCount(0);

    await page.goto('/members');
    const memberCardAfterRemove = page.locator('div[class*="card"]', { hasText: `${newFirstName} ${user.fullName.split(' ')[1]}` });
    await expect(memberCardAfterRemove).toBeVisible();
    await expect(memberCardAfterRemove.locator('img')).toHaveCount(0);
  });

  test('a brand-new member with no photo shows initials, never a broken image, on Members', async ({ page }) => {
    const user = await seedUser('initials', 'Nora');
    await signIn(page, user);

    await page.goto('/members');
    const memberCard = page.locator('div[class*="card"]', { hasText: user.fullName });
    await expect(memberCard).toBeVisible();
    await expect(memberCard.locator('img')).toHaveCount(0);
    // The initials themselves (first letter of first + last name).
    const initials = `${user.fullName[0]}${user.fullName.split(' ')[1][0]}`;
    await expect(memberCard.getByText(initials)).toBeVisible();
  });
});

test.describe('Avatar storage security', () => {
  test('a user can upload, replace, and delete their own avatar via the real Storage API', async () => {
    const user = await seedUser('own-storage', 'Owen');
    const client = await signInClient(user);
    const ownPath = `${user.id}/avatar.webp`;

    const uploadResult = await client.storage.from('avatars').upload(ownPath, new Blob(['fake-webp-bytes'], { type: 'image/webp' }), {
      contentType: 'image/webp',
      upsert: true,
    });
    expect(uploadResult.error).toBeNull();

    // Replace (upsert over the same fixed path).
    const replaceResult = await client.storage.from('avatars').upload(ownPath, new Blob(['different-fake-bytes'], { type: 'image/webp' }), {
      contentType: 'image/webp',
      upsert: true,
    });
    expect(replaceResult.error).toBeNull();

    const removeResult = await client.storage.from('avatars').remove([ownPath]);
    expect(removeResult.error).toBeNull();
  });

  test('a user cannot upload, replace, or delete another user\'s avatar', async () => {
    const userA = await seedUser('attacker', 'Attacker');
    const userB = await seedUser('victim', 'Victim');
    const clientA = await signInClient(userA);
    const victimPath = `${userB.id}/avatar.webp`;

    // Seed victim's own avatar via the admin client (bypasses RLS -- this
    // is test setup, not the thing under test) so there's a real object for
    // the attacker to try to overwrite/delete.
    const seedResult = await admin().storage.from('avatars').upload(victimPath, new Blob(['victim-bytes'], { type: 'image/webp' }), {
      contentType: 'image/webp',
      upsert: true,
    });
    expect(seedResult.error).toBeNull();

    const uploadAttempt = await clientA.storage.from('avatars').upload(victimPath, new Blob(['attacker-bytes'], { type: 'image/webp' }), {
      contentType: 'image/webp',
      upsert: false,
    });
    expect(uploadAttempt.error).not.toBeNull();

    const updateAttempt = await clientA.storage.from('avatars').update(victimPath, new Blob(['attacker-bytes-2'], { type: 'image/webp' }), {
      contentType: 'image/webp',
    });
    expect(updateAttempt.error).not.toBeNull();

    const removeAttempt = await clientA.storage.from('avatars').remove([victimPath]);
    // Supabase Storage's remove() reports success with an empty result list
    // (rather than a top-level error) when RLS silently excludes every
    // targeted path -- either way, nothing was actually deleted, checked
    // next.
    expect((removeAttempt.data ?? []).length).toBe(0);

    // Prove the object is genuinely untouched (upload/update denials aren't
    // just cosmetic errors that quietly succeeded anyway).
    const stillThereForAdmin = await admin().storage.from('avatars').download(victimPath);
    expect(stillThereForAdmin.error).toBeNull();
  });

  test('any authenticated member can view another member\'s avatar; anonymous access is denied', async () => {
    const userA = await seedUser('viewer', 'Viewer');
    const userB = await seedUser('viewed', 'Viewed');
    const bPath = `${userB.id}/avatar.webp`;

    const seedResult = await admin().storage.from('avatars').upload(bPath, new Blob(['viewed-bytes'], { type: 'image/webp' }), {
      contentType: 'image/webp',
      upsert: true,
    });
    expect(seedResult.error).toBeNull();

    const clientA = await signInClient(userA);
    const signedUrlResult = await clientA.storage.from('avatars').createSignedUrl(bPath, 60);
    expect(signedUrlResult.error).toBeNull();
    expect(signedUrlResult.data?.signedUrl).toBeTruthy();

    // Anonymous (no session at all) must be refused a signed URL for the
    // same object.
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const anonSignedUrlResult = await anonClient.storage.from('avatars').createSignedUrl(bPath, 60);
    expect(anonSignedUrlResult.error).not.toBeNull();

    // Anonymous listing of the bucket is refused too.
    const anonListResult = await anonClient.storage.from('avatars').list(userB.id);
    expect((anonListResult.data ?? []).length).toBe(0);
  });
});

test.describe('Avatar appears wherever GreenLink already shows members', () => {
  test('an uploaded photo renders in the Teams tab Invite Members list', async ({ page }) => {
    const organizer = await seedUser('org', 'Ollie');
    const member = await seedUser('teammember', 'Tia');

    // Seed the member's avatar directly (upload UI already covered above).
    // Real, decodable image bytes -- this test checks that a browser <img>
    // actually renders, not just that the upload API call succeeds.
    await admin().storage.from('avatars').upload(`${member.id}/avatar.webp`, realAvatarBlob(), {
      contentType: 'image/png',
      upsert: true,
    });
    const { error: profileError } = await admin()
      .from('profiles')
      .update({ photo_path: `${member.id}/avatar.webp` })
      .eq('id', member.id);
    expect(profileError).toBeNull();

    const organizerClient = await signInClient(organizer);
    const { data: tournamentId, error: createError } = await organizerClient.rpc('create_tournament', {
      p_name: `E2E Avatar Teams ${Date.now()}`,
      p_course_name: 'E2E Test Course',
      p_tournament_date: new Date().toISOString().slice(0, 10),
      p_hole_count: 9,
    });
    expect(createError).toBeNull();

    await signIn(page, organizer);
    await page.goto(`/tournaments/${tournamentId}/teams`);

    const inviteList = page.locator('div[class*="inviteList"]');
    const memberRow = inviteList.locator('div[class*="playerRow"]', { hasText: member.fullName });
    await expect(memberRow.locator('img')).toBeVisible({ timeout: 10_000 });
  });

  test('an uploaded photo renders in the Community Feed', async ({ page }) => {
    const player = await seedUser('feed', 'Feely');
    const avatarPath = `${player.id}/avatar.webp`;

    // Real, decodable image bytes -- this test checks that a browser <img>
    // actually renders in the feed, not just that the upload API succeeds.
    const { error: uploadError } = await admin()
      .storage.from('avatars')
      .upload(avatarPath, realAvatarBlob(), { contentType: 'image/png', upsert: true });
    expect(uploadError).toBeNull();
    const { error: profileError } = await admin().from('profiles').update({ photo_path: avatarPath }).eq('id', player.id);
    expect(profileError).toBeNull();

    // A completed, public personal round -- seeded directly (the round-
    // creation/scoring/finish flow itself is covered by
    // personal-round-flow.spec.ts; this test is only about the feed
    // rendering the avatar for an already-existing round).
    const { data: tournament, error: tournamentError } = await admin()
      .from('tournaments')
      .insert({
        organizer_user_id: player.id,
        name: 'E2E Avatar Feed Round',
        course_name: 'E2E Test Course',
        tournament_date: new Date().toISOString().slice(0, 10),
        status: 'completed',
        is_personal: true,
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    expect(tournamentError).toBeNull();

    const { error: playerError } = await admin()
      .from('tournament_players')
      .insert({ tournament_id: tournament!.id, user_id: player.id, membership_status: 'accepted', is_organizer: true });
    expect(playerError).toBeNull();
    const { error: personalRoundError } = await admin()
      .from('personal_rounds')
      .insert({ tournament_id: tournament!.id, visibility: 'public', walking_or_cart: 'walking' });
    expect(personalRoundError).toBeNull();

    await signIn(page, player);
    await page.goto('/home');

    const feedItem = page.locator('li', { hasText: player.fullName });
    await expect(feedItem.locator('img')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Mobile layout: Profile and Edit Profile', () => {
  for (const width of [320, 375, 390, 430]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const user = await seedUser(`mobile-${width}`, 'Mo');
      await signIn(page, user);

      await page.goto('/profile');
      const profileOverflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(profileOverflow.scrollWidth).toBeLessThanOrEqual(profileOverflow.clientWidth);

      await page.goto('/profile/edit');
      const editOverflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(editOverflow.scrollWidth).toBeLessThanOrEqual(editOverflow.clientWidth);

      await expect(page.getByRole('button', { name: 'Change Photo' })).toBeVisible();
      await expect(page.getByLabel('First name')).toBeVisible();
      await expect(page.getByLabel('Last name')).toBeVisible();
    });
  }
});
