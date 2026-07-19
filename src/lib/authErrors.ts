import { isAuthApiError, isAuthRetryableFetchError, isAuthWeakPasswordError } from '@supabase/supabase-js';

/**
 * Categorizes a Supabase Auth failure so callers can decide on more than
 * just the message -- e.g. whether to offer a "resend confirmation email"
 * action. `rate_limited` and `email_send_failed` both mean the account may
 * already exist unconfirmed, so both should offer a resend path.
 */
export type AuthErrorKind =
  | 'rate_limited'
  | 'duplicate_email'
  | 'invalid_email'
  | 'weak_password'
  | 'invalid_credentials'
  | 'email_send_failed'
  | 'network'
  | 'unexpected';

export interface AuthErrorInfo {
  kind: AuthErrorKind;
  message: string;
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorKind, string> = {
  rate_limited: 'Too many confirmation emails have been requested. Please wait a few minutes and try again.',
  duplicate_email: 'An account with that email already exists. Try signing in instead.',
  invalid_email: 'Please enter a valid email address.',
  weak_password: 'That password is too weak. Use at least 6 characters.',
  invalid_credentials: 'Incorrect email or password.',
  email_send_failed: "We couldn't send the confirmation email right now. Please try again in a few minutes.",
  network: "We couldn't reach the server. Check your connection and try again.",
  unexpected: 'Something went wrong. Please try again.',
};

/**
 * Turns any error from a Supabase Auth call (signUp, signInWithPassword,
 * resend, ...) into a user-safe category + message, logging the real error
 * for debugging. Never surfaces raw Supabase/GoTrue text (e.g. "email rate
 * limit exceeded") to the UI.
 */
export function describeAuthError(error: unknown, context = 'auth'): AuthErrorInfo {
  console.error(`[${context}] Supabase auth error:`, error);

  if (isAuthRetryableFetchError(error)) {
    return { kind: 'network', message: AUTH_ERROR_MESSAGES.network };
  }

  if (isAuthWeakPasswordError(error)) {
    return { kind: 'weak_password', message: AUTH_ERROR_MESSAGES.weak_password };
  }

  if (isAuthApiError(error)) {
    switch (error.code) {
      case 'over_email_send_rate_limit':
      case 'over_request_rate_limit':
        return { kind: 'rate_limited', message: AUTH_ERROR_MESSAGES.rate_limited };
      case 'user_already_exists':
      case 'email_exists':
      case 'identity_already_exists':
        return { kind: 'duplicate_email', message: AUTH_ERROR_MESSAGES.duplicate_email };
      case 'weak_password':
        return { kind: 'weak_password', message: AUTH_ERROR_MESSAGES.weak_password };
      case 'email_address_invalid':
      case 'validation_failed':
        return { kind: 'invalid_email', message: AUTH_ERROR_MESSAGES.invalid_email };
      case 'invalid_credentials':
        return { kind: 'invalid_credentials', message: AUTH_ERROR_MESSAGES.invalid_credentials };
      case 'email_provider_disabled':
      case 'sms_send_failed':
        return { kind: 'email_send_failed', message: AUTH_ERROR_MESSAGES.email_send_failed };
      default:
        break;
    }

    // Older/self-hosted GoTrue instances may not set error.code -- fall
    // back to sniffing the (still never user-facing) message text.
    const message = error.message.toLowerCase();
    if (message.includes('rate limit')) {
      return { kind: 'rate_limited', message: AUTH_ERROR_MESSAGES.rate_limited };
    }
    if (message.includes('already registered') || message.includes('already exists')) {
      return { kind: 'duplicate_email', message: AUTH_ERROR_MESSAGES.duplicate_email };
    }
    if (message.includes('password')) {
      return { kind: 'weak_password', message: AUTH_ERROR_MESSAGES.weak_password };
    }
    if (message.includes('email') && (message.includes('invalid') || message.includes('valid'))) {
      return { kind: 'invalid_email', message: AUTH_ERROR_MESSAGES.invalid_email };
    }
    if (message.includes('sending') || message.includes('send email') || message.includes('mail')) {
      return { kind: 'email_send_failed', message: AUTH_ERROR_MESSAGES.email_send_failed };
    }
    if (error.status >= 500) {
      return { kind: 'unexpected', message: AUTH_ERROR_MESSAGES.unexpected };
    }
  }

  return { kind: 'unexpected', message: AUTH_ERROR_MESSAGES.unexpected };
}
