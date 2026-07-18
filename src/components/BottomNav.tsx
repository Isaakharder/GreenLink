import { NavLink } from 'react-router-dom';
import styles from './BottomNav.module.css';

const ITEMS = [
  { to: '/home', label: 'Home', icon: '⌂' },
  { to: '/tournaments', label: 'Tournaments', icon: '🏆' },
  { to: '/my-golf', label: 'My Golf', icon: '⛳' },
  { to: '/profile', label: 'Profile', icon: '👤' },
];

export function BottomNav() {
  return (
    <nav className={styles.nav} aria-label="Primary">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon} aria-hidden="true">
            {item.icon}
          </span>
          <span className={styles.label}>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
