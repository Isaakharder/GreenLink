import { NavLink } from 'react-router-dom';
import { LIVE_SCORE_DISABLED_TEXT } from '../lib/copy';
import styles from './TournamentTabBar.module.css';

interface TournamentTabBarProps {
  basePath: string;
  canViewLiveScore: boolean;
  showSettings: boolean;
}

const tabClass = ({ isActive }: { isActive: boolean }) => `${styles.tab} ${isActive ? styles.active : ''}`;

export function TournamentTabBar({ basePath, canViewLiveScore, showSettings }: TournamentTabBarProps) {
  return (
    <div className={styles.bar} role="tablist" aria-label="Tournament sections">
      <NavLink to={`${basePath}/overview`} className={tabClass}>
        Overview
      </NavLink>
      <NavLink to={`${basePath}/teams`} className={tabClass}>
        Teams
      </NavLink>
      <NavLink to={`${basePath}/scorecard`} className={tabClass}>
        Scorecard
      </NavLink>

      {canViewLiveScore ? (
        <NavLink to={`${basePath}/live`} className={tabClass}>
          Live Score
        </NavLink>
      ) : (
        <span
          className={`${styles.tab} ${styles.disabled}`}
          aria-disabled="true"
          title={LIVE_SCORE_DISABLED_TEXT}
        >
          Live Score
        </span>
      )}

      {showSettings && (
        <NavLink to={`${basePath}/settings`} className={tabClass}>
          Settings
        </NavLink>
      )}
    </div>
  );
}
