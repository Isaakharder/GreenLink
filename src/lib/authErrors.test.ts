import { describe, expect, it, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError, AuthWeakPasswordError } from '@supabase/supabase-js';
import { describeAuthError } from './authErrors';

describe('describeAuthError', () => {
  it('maps the email send rate limit to a friendly message, never the raw Supabase text', () => {
    const error = new AuthApiError('email rate limit exceeded', 429, 'over_email_send_rate_limit');
    const result = describeAuthError(error);

    expect(result.kind).toBe('rate_limited');
    expect(result.message).toBe(
      'Too many confirmation emails have been requested. Please wait a few minutes and try again.',
    );
    expect(result.message).not.toMatch(/email rate limit exceeded/i);
    expect(result.message.toLowerCase()).not.toContain('rate limit exceeded');
  });

  it('maps a general request rate limit the same way', () => {
    const error = new AuthApiError('rate limit exceeded', 429, 'over_request_rate_limit');
    expect(describeAuthError(error).kind).toBe('rate_limited');
  });

  it('falls back to sniffing the message when an older server omits error.code', () => {
    const error = new AuthApiError('Email rate limit exceeded', 429, undefined);
    const result = describeAuthError(error);
    expect(result.kind).toBe('rate_limited');
    expect(result.message).not.toMatch(/rate limit exceeded/i);
  });

  it('maps a duplicate email to a friendly, sign-in-pointing message', () => {
    const error = new AuthApiError('User already registered', 400, 'user_already_exists');
    const result = describeAuthError(error);
    expect(result.kind).toBe('duplicate_email');
    expect(result.message).toMatch(/already exists/i);
  });

  it('maps an invalid email', () => {
    const error = new AuthApiError('Unable to validate email address: invalid format', 400, 'email_address_invalid');
    const result = describeAuthError(error);
    expect(result.kind).toBe('invalid_email');
    expect(result.message).toMatch(/valid email/i);
  });

  it('maps a weak password error, including the dedicated AuthWeakPasswordError type', () => {
    const error = new AuthWeakPasswordError('Password should be at least 6 characters', 400, ['length']);
    const result = describeAuthError(error);
    expect(result.kind).toBe('weak_password');
    expect(result.message).toMatch(/too weak/i);
  });

  it('maps a network/fetch failure', () => {
    const error = new AuthRetryableFetchError('Failed to fetch', 0);
    const result = describeAuthError(error);
    expect(result.kind).toBe('network');
    expect(result.message).toMatch(/reach the server/i);
  });

  it('maps invalid credentials for sign-in', () => {
    const error = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials');
    const result = describeAuthError(error);
    expect(result.kind).toBe('invalid_credentials');
  });

  it('maps an email-sending failure distinctly from a generic server error', () => {
    const error = new AuthApiError('Error sending confirmation email', 500, undefined);
    const result = describeAuthError(error);
    expect(result.kind).toBe('email_send_failed');
  });

  it('falls back to a generic unexpected-error message for anything else', () => {
    const result = describeAuthError(new Error('boom'));
    expect(result.kind).toBe('unexpected');
    expect(result.message).toBe('Something went wrong. Please try again.');
  });

  it('logs the real error to the console for debugging without ever including it in the returned message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new AuthApiError('email rate limit exceeded', 429, 'over_email_send_rate_limit');

    const result = describeAuthError(error, 'sign-up');

    expect(consoleSpy).toHaveBeenCalledWith('[sign-up] Supabase auth error:', error);
    expect(result.message).not.toContain('email rate limit exceeded');
    consoleSpy.mockRestore();
  });
});
