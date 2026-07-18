import { Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { ConnectionBadge } from './ConnectionBadge';
import { OfflineBanner } from './OfflineBanner';
import styles from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.logo}>GreenLink</span>
        <ConnectionBadge />
      </header>
      <OfflineBanner />
      <main className={styles.main}>
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
