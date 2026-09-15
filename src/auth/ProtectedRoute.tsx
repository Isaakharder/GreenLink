import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './useAuth';
import { resolveProtectedRouteOutcome } from './routing';

export function ProtectedRoute() {
  const { session, loading, isPasswordRecovery } = useAuth();
  const outcome = resolveProtectedRouteOutcome({ loading, hasSession: !!session, isPasswordRecovery });

  switch (outcome) {
    case 'loading':
      return <div className="page-status">Loading…</div>;
    // An unfinished password recovery isn't a real login -- send it back to
    // finish resetting the password instead of into the app.
    case 'recovery':
      return <Navigate to="/reset-password" replace />;
    case 'signed-out':
      return <Navigate to="/" replace />;
    case 'authorized':
      return <Outlet />;
  }
}
