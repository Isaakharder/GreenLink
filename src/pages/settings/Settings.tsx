import { Link } from 'react-router-dom';

/** Profile → Settings hub. Only one section today (Courses); more settings can be added here later without another navigation layer. */
export function Settings() {
  return (
    <div>
      <h1>Settings</h1>
      <div className="card">
        <Link to="/settings/courses" className="btn btn-secondary">
          Courses
        </Link>
      </div>
    </div>
  );
}
