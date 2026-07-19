import { expect, test, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

interface Signup {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
}

function freshSignup(tag: string): Signup {
  const stamp = Date.now();
  // Username must fit USERNAME_PATTERN in SignUp.tsx: 3-20 chars, so the
  // base36 timestamp keeps this well under the limit (unlike a raw ms epoch).
  const shortStamp = stamp.toString(36);
  return {
    firstName: 'Sammy',
    lastName: 'Signup',
    username: `e2e_${tag.slice(0, 6)}_${shortStamp}`,
    email: `e2e-signup-${tag}-${stamp}@example.test`,
    password: 'correct-horse-battery',
  };
}

async function fillSignupForm(page: Page, signup: Signup) {
  await page.goto('/sign-up');
  await page.fill('#firstName', signup.firstName);
  await page.fill('#lastName', signup.lastName);
  await page.fill('#username', signup.username);
  await page.fill('#email', signup.email);
  await page.fill('#password', signup.password);
}

/** Fulfils POST .../auth/v1/signup with a GoTrue-shaped error body, exactly as supabase-js parses it (see auth-js fetch.js: error_code / code, msg). */
function mockSignUpError(page: Page, status: number, errorCode: string, msg: string) {
  return page.route('**/auth/v1/signup', async (route: Route) => {
    await route.fulfill({ status, json: { code: status, error_code: errorCode, msg } });
  });
}

function mockResendError(page: Page, status: number, errorCode: string, msg: string) {
  return page.route('**/auth/v1/resend', async (route: Route) => {
    await route.fulfill({ status, json: { code: status, error_code: errorCode, msg } });
  });
}

/**
 * Local Supabase auto-confirms email on signup (no confirmation step),
 * unlike production where "Confirm email" is on. Mocking the no-session
 * response lets these tests deterministically reach the awaiting-
 * confirmation / resend screen regardless of local dev config.
 */
function mockSignUpNoSession(page: Page) {
  return page.route('**/auth/v1/signup', async (route: Route) => {
    await route.fulfill({ json: { user: { id: 'mock-user', identities: [{ id: 'x' }] }, session: null } });
  });
}

const signUpButton = (page: Page) => page.getByRole('button', { name: /Sign Up|Creating account/ });

test.describe('sign-up error handling', () => {
  test('normal signup succeeds, shows the awaiting-confirmation message, and offers resend', async ({ page }) => {
    const signup = freshSignup('happy');
    await mockSignUpNoSession(page);
    await fillSignupForm(page, signup);
    await signUpButton(page).click();

    await expect(page.getByText('Account created!')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Already created your account? Resend confirmation email.')).toBeVisible();
    // The resend email field is pre-filled with what was just entered, not blank.
    await expect(page.locator('#resendEmail')).toHaveValue(signup.email);
  });

  test('normal signup against the real backend creates the account and signs the user in', async ({ page }) => {
    const signup = freshSignup('real');
    await fillSignupForm(page, signup);
    await signUpButton(page).click();
    await page.waitForURL('**/home', { timeout: 10_000 });
  });

  test('double-tapping Sign Up sends exactly one request and disables the button while pending', async ({ page }) => {
    const signup = freshSignup('doubletap');
    let signupRequests = 0;

    await page.route('**/auth/v1/signup', async (route: Route) => {
      signupRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ json: { user: { id: 'mock-user', identities: [{ id: 'x' }] }, session: null } });
    });

    await fillSignupForm(page, signup);

    const button = signUpButton(page);
    // Dispatch two native clicks synchronously in the same task, so both
    // fire before React can re-render the button as disabled -- Playwright's
    // own .click() retries for "enabled" and would let a second click through
    // *after* the button re-enables post-response, which isn't a real double-tap.
    await button.evaluate((el) => {
      (el as { click: () => void }).click();
      (el as { click: () => void }).click();
    });

    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Creating account…');

    await expect(page.getByText('Account created!')).toBeVisible({ timeout: 10_000 });
    expect(signupRequests).toBe(1);
  });

  test('re-enables the Sign Up button after a failed request so the user can retry', async ({ page }) => {
    const signup = freshSignup('retry');
    await mockSignUpError(page, 429, 'over_email_send_rate_limit', 'email rate limit exceeded');
    await fillSignupForm(page, signup);

    const button = signUpButton(page);
    await button.click();

    await expect(page.getByText(/Too many confirmation emails/)).toBeVisible({ timeout: 10_000 });
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Sign Up');
  });

  test('email rate-limit error shows the friendly message, never the raw Supabase text, and offers resend', async ({ page }) => {
    const signup = freshSignup('ratelimit');
    await mockSignUpError(page, 429, 'over_email_send_rate_limit', 'email rate limit exceeded');
    await fillSignupForm(page, signup);
    await signUpButton(page).click();

    await expect(
      page.getByText('Too many confirmation emails have been requested. Please wait a few minutes and try again.'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(/email rate limit exceeded/i);

    // Form values survive the failure -- nothing was cleared.
    await expect(page.locator('#firstName')).toHaveValue(signup.firstName);
    await expect(page.locator('#lastName')).toHaveValue(signup.lastName);
    await expect(page.locator('#username')).toHaveValue(signup.username);
    await expect(page.locator('#email')).toHaveValue(signup.email);

    await expect(page.getByText('Already created your account? Resend confirmation email.')).toBeVisible();
  });

  test('duplicate email (already-registered soft response) shows a friendly message and offers resend', async ({ page }) => {
    const signup = freshSignup('dupemail');
    // Supabase's enumeration-safe response for signing up an already-registered
    // email: 200 OK, no session, identities: [].
    await page.route('**/auth/v1/signup', async (route: Route) => {
      await route.fulfill({ json: { user: { id: 'mock-existing-user', email: signup.email, identities: [] }, session: null } });
    });
    await fillSignupForm(page, signup);
    await signUpButton(page).click();

    await expect(page.getByText('An account with that email already exists. Try signing in instead.')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Already created your account? Resend confirmation email.')).toBeVisible();
  });

  test('duplicate username is rejected before any signup request is made', async ({ page }) => {
    // Genuine signup against the real local backend -- the username must
    // actually land in `profiles` for is_username_available() to see it as
    // taken. Local auto-confirms, so this redirects straight to /home.
    const first = freshSignup('dupuser');
    await fillSignupForm(page, first);
    await signUpButton(page).click();
    await page.waitForURL('**/home', { timeout: 10_000 });

    // Second signup: same username, different email/person.
    const second = { ...freshSignup('dupuser2'), username: first.username };
    let signupRequests = 0;
    await page.route('**/auth/v1/signup', async (route: Route) => {
      signupRequests += 1;
      await route.continue();
    });

    await fillSignupForm(page, second);
    await signUpButton(page).click();

    await expect(page.getByText('That username is already taken.')).toBeVisible({ timeout: 10_000 });
    expect(signupRequests).toBe(0);
  });

  test('an invalid email from the server is translated to a friendly message', async ({ page }) => {
    const signup = freshSignup('bademail');
    await mockSignUpError(page, 400, 'email_address_invalid', 'Unable to validate email address: invalid format');
    await fillSignupForm(page, signup);
    await signUpButton(page).click();

    await expect(page.getByText('Please enter a valid email address.')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(/unable to validate email address/i);
  });

  test('a weak password from the server is translated to a friendly message', async ({ page }) => {
    const signup = freshSignup('weakpw');
    await mockSignUpError(page, 422, 'weak_password', 'Password should be at least 6 characters');
    await fillSignupForm(page, signup);
    await signUpButton(page).click();

    await expect(page.getByText('That password is too weak. Use at least 6 characters.')).toBeVisible({ timeout: 10_000 });
  });

  test('a network failure during signup shows a friendly message and preserves the form', async ({ page }) => {
    const signup = freshSignup('network');
    await page.route('**/auth/v1/signup', (route: Route) => route.abort('failed'));
    await fillSignupForm(page, signup);
    await signUpButton(page).click();

    await expect(page.getByText("We couldn't reach the server. Check your connection and try again.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('#email')).toHaveValue(signup.email);
    await expect(signUpButton(page)).toBeEnabled();
  });

  test('resend confirmation: success message, cooldown, and rate-limit handling', async ({ page }) => {
    const signup = freshSignup('resend');
    await mockSignUpNoSession(page);
    await fillSignupForm(page, signup);
    await signUpButton(page).click();
    await expect(page.getByText('Account created!')).toBeVisible({ timeout: 10_000 });

    const resendButton = page.getByRole('button', { name: /Resend Confirmation Email|Sending…/ });

    await resendButton.click();
    await expect(page.getByText('Confirmation email sent. Check your inbox and spam folder.')).toBeVisible({
      timeout: 10_000,
    });

    // Cooldown: immediately re-clicking must not fire a second request.
    let resendRequests = 0;
    await page.route('**/auth/v1/resend', async (route: Route) => {
      resendRequests += 1;
      await route.continue();
    });
    await expect(resendButton).toBeDisabled();
    expect(resendRequests).toBe(0);
  });

  test('resend confirmation shows the same friendly waiting message on a rate-limit response', async ({ page }) => {
    const signup = freshSignup('resendrate');
    await mockSignUpNoSession(page);
    await fillSignupForm(page, signup);
    await signUpButton(page).click();
    await expect(page.getByText('Account created!')).toBeVisible({ timeout: 10_000 });

    await mockResendError(page, 429, 'over_email_send_rate_limit', 'email rate limit exceeded');
    await page.getByRole('button', { name: 'Resend Confirmation Email' }).click();

    await expect(
      page.getByText('Too many confirmation emails have been requested. Please wait a few minutes and try again.'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(/email rate limit exceeded/i);
  });

  test('existing sign-in flow is unchanged', async ({ page }) => {
    const stamp = Date.now();
    const email = `e2e-signin-smoke-${stamp}@example.test`;
    const password = 'e2e-password-123';
    const { error } = await admin().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: 'Sig', last_name: `Nin${stamp}`, username: `e2e_signin_${stamp}` },
    });
    if (error) throw error;

    await page.goto('/sign-in');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('button[type=submit]');
    await page.waitForURL('**/home');
  });
});
