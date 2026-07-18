import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './useAuth';

export function ProtectedRoute() {
  const { session, loading } = useAuth();

  if (loading) {
    return <div className="page-status">Loading…</div>;
  }

  if (!session) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
