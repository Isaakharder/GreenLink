/**
 * Pure route-outcome logic for RootRoute and ProtectedRoute, kept separate
 * from the components so the security-sensitive rule -- a password-recovery
 * session must never be routed like an ordinary login -- can be unit tested
 * without needing a live Supabase session.
 */

interface AuthRouteState {
  loading: boolean;
  hasSession: boolean;
  isPasswordRecovery: boolean;
}

export type RootRouteOutcome = 'loading' | 'recovery' | 'home' | 'logged-out';

export function resolveRootRouteOutcome({ loading, hasSession, isPasswordRecovery }: AuthRouteState): RootRouteOutcome {
  if (loading) return 'loading';
  // Checked before hasSession: a recovery session is still a session, but
  // must land on /reset-password, not /home.
  if (isPasswordRecovery) return 'recovery';
  if (hasSession) return 'home';
  return 'logged-out';
}

export type ProtectedRouteOutcome = 'loading' | 'recovery' | 'signed-out' | 'authorized';

export function resolveProtectedRouteOutcome({
  loading,
  hasSession,
  isPasswordRecovery,
}: AuthRouteState): ProtectedRouteOutcome {
  if (loading) return 'loading';
  if (isPasswordRecovery) return 'recovery';
  if (!hasSession) return 'signed-out';
  return 'authorized';
}
