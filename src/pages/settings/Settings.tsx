import { Link } from 'react-router-dom';
import { useProfile } from '../../hooks/useProfile';

/** Profile → Settings hub. Admin section is shown only when the signed-in user's own is_admin is true -- convenience only, never the security boundary: every admin_* RPC re-checks is_admin() server-side regardless of what this page renders. */
export function Settings() {
  const { data: profile } = useProfile();

  return (
    <div>
      <h1>Settings</h1>
      <div className="card">
        <Link to="/settings/courses" className="btn btn-secondary">
          Courses
        </Link>
      </div>

      {profile?.is_admin && (
        <>
          <h2 className="section-title">Admin</h2>
          <div className="card">
            <Link to="/settings/admin/members" className="btn btn-secondary">
              Manage Members ›
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
