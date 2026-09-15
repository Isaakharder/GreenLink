import { useMembers } from '../hooks/useMembers';
import { formatMembershipDuration } from '../lib/memberDirectory';
import styles from './Members.module.css';

export function Members() {
  const { data: members, isLoading, isError } = useMembers();

  if (isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  if (isError) {
    return <p className="error-text">Couldn't load members right now. Please try again later.</p>;
  }

  if (!members || members.length === 0) {
    return (
      <div>
        <h1>Members</h1>
        <p className="empty-state">No members yet.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Members</h1>
      <p className={styles.count}>
        {members.length} {members.length === 1 ? 'member' : 'members'}
      </p>
      <div className={styles.list}>
        {members.map((member) => (
          // Non-interactive: there's no member profile page to link to yet.
          // Make this a <button>/<Link> once one exists.
          <div key={member.id} className={styles.card}>
            <div>
              <p className={styles.name}>
                {member.first_name} {member.last_name}
              </p>
              <div className={styles.meta}>
                <span className="badge badge-accepted">Active Member</span>
                <span>{formatMembershipDuration(member.member_since)}</span>
              </div>
            </div>
            <div className={styles.roundsCount}>
              <strong>{member.completed_rounds_count}</strong>
              {member.completed_rounds_count === 1 ? 'round played' : 'rounds played'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
