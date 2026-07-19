import { BigButton } from '../components/BigButton';
import { CommunityFeed } from '../components/CommunityFeed';
import { useProfile } from '../hooks/useProfile';
import styles from './Home.module.css';

export function Home() {
  const { data: profile } = useProfile();

  return (
    <div>
      <h1 className={styles.greeting}>{profile ? `Hi, ${profile.first_name}` : 'Welcome'}</h1>
      <div className={styles.grid}>
        <BigButton to="/tournaments" label="Tournament" icon="🏆" />
        <BigButton to="/my-golf" label="My Golf" icon="⛳" />
      </div>
      <CommunityFeed />
    </div>
  );
}
