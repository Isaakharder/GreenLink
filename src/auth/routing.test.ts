import { describe, expect, it } from 'vitest';
import { resolveProtectedRouteOutcome, resolveRootRouteOutcome } from './routing';

describe('resolveRootRouteOutcome', () => {
  it('shows the loading state before the initial session check resolves', () => {
    expect(resolveRootRouteOutcome({ loading: true, hasSession: false, isPasswordRecovery: false })).toBe('loading');
    expect(resolveRootRouteOutcome({ loading: true, hasSession: true, isPasswordRecovery: true })).toBe('loading');
  });

  it('sends an unfinished password-recovery session to /reset-password, never /home', () => {
    expect(resolveRootRouteOutcome({ loading: false, hasSession: true, isPasswordRecovery: true })).toBe('recovery');
  });

  it('sends an ordinary signed-in session to /home', () => {
    expect(resolveRootRouteOutcome({ loading: false, hasSession: true, isPasswordRecovery: false })).toBe('home');
  });

  it('shows the logged-out landing page with no session', () => {
    expect(resolveRootRouteOutcome({ loading: false, hasSession: false, isPasswordRecovery: false })).toBe(
      'logged-out',
    );
  });
});

describe('resolveProtectedRouteOutcome', () => {
  it('shows the loading state before the initial session check resolves', () => {
    expect(resolveProtectedRouteOutcome({ loading: true, hasSession: false, isPasswordRecovery: false })).toBe(
      'loading',
    );
  });

  it('bounces an unfinished password-recovery session back to /reset-password instead of into the app', () => {
    expect(resolveProtectedRouteOutcome({ loading: false, hasSession: true, isPasswordRecovery: true })).toBe(
      'recovery',
    );
  });

  it('signs out a request with no session', () => {
    expect(resolveProtectedRouteOutcome({ loading: false, hasSession: false, isPasswordRecovery: false })).toBe(
      'signed-out',
    );
  });

  it('authorizes an ordinary signed-in session', () => {
    expect(resolveProtectedRouteOutcome({ loading: false, hasSession: true, isPasswordRecovery: false })).toBe(
      'authorized',
    );
  });
});
