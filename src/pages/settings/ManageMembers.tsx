import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAdminMembers } from '../../hooks/useAdminMembers';
import styles from './ManageMembers.module.css';

export function ManageMembers() {
  const { data: members, isLoading, isError } = useAdminMembers();

  if (isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  if (isError) {
    return <p className="error-text">Couldn't load members right now. Please try again later.</p>;
  }

  if (!members || members.length === 0) {
    return (
      <div>
        <h1>Manage Members</h1>
        <p className="empty-state">No members yet.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Manage Members</h1>
      <p className={styles.count}>
        {members.length} {members.length === 1 ? 'member' : 'members'}
      </p>
      <div className={styles.list}>
        {members.map((member) => (
          <Link key={member.id} to={`/settings/admin/members/${member.id}`} className={styles.card}>
            <Avatar name={`${member.first_name} ${member.last_name}`} photoPath={member.photo_path} size="medium" />
            <div className={styles.info}>
              <p className={styles.name}>
                {member.first_name} {member.last_name}
                {member.is_admin && <span className={styles.adminBadge}>Admin</span>}
              </p>
              <p className={styles.username}>@{member.username}</p>
            </div>
            <span className={`${styles.statusBadge} ${member.membership_status === 'active' ? styles.active : styles.inactive}`}>
              {member.membership_status === 'active' ? 'Active' : 'Inactive'}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
