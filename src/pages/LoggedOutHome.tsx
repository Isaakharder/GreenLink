import { Link } from 'react-router-dom';
import styles from './LoggedOutHome.module.css';

export function LoggedOutHome() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden="true">
          ⛳
        </span>
        <h1>GreenLink</h1>
        <p>Golf tournament scoring</p>
      </div>
      <div className={styles.actions}>
        <Link to="/sign-up" className="btn btn-primary">
          Sign Up
        </Link>
        <Link to="/sign-in" className="btn btn-secondary">
          Sign In
        </Link>
      </div>
    </div>
  );
}
