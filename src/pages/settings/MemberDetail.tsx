import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAdminMembers, useSetMemberStatus, usePermanentlyDeleteMember } from '../../hooks/useAdminMembers';
import styles from './MemberDetail.module.css';

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// A rejected supabase-js RPC call resolves its error as a plain object
// matching the PostgrestError shape, not an actual PostgrestError/Error
// instance (verified against this project's installed supabase-js) --
// `instanceof Error` does not reliably narrow it, so check for a `message`
// property directly instead.
function getErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function MemberDetail() {
  const { memberId } = useParams<{ memberId: string }>();
  const navigate = useNavigate();
  const { data: members, isLoading } = useAdminMembers();
  const setStatus = useSetMemberStatus();
  const permanentlyDelete = usePermanentlyDeleteMember();

  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) {
    return <div className="page-status">Loading…</div>;
  }

  const member = members?.find((m) => m.id === memberId);

  if (!member) {
    return <p className="error-text">Member not found.</p>;
  }

  const isActive = member.membership_status === 'active';

  async function handleToggleStatus() {
    setActionError(null);
    const nextStatus = isActive ? 'inactive' : 'active';
    const verb = isActive ? 'Deactivate' : 'Activate';
    if (!window.confirm(`${verb} ${member!.first_name} ${member!.last_name} (@${member!.username})?`)) return;

    try {
      await setStatus.mutateAsync({ userId: member!.id, status: nextStatus });
    } catch (err) {
      setActionError(getErrorMessage(err, 'Something went wrong. Please try again.'));
    }
  }

  async function handlePermanentlyDelete() {
    setActionError(null);
    try {
      await permanentlyDelete.mutateAsync(member!.id);
      navigate('/settings/admin/members', { replace: true });
    } catch (err) {
      setActionError(getErrorMessage(err, 'Something went wrong. Please try again.'));
    }
  }

  const deleteConfirmed = deleteConfirmText.trim() === member.username;

  return (
    <div>
      <h1>Manage Member</h1>

      <div className={`card ${styles.summary}`}>
        <Avatar name={`${member.first_name} ${member.last_name}`} photoPath={member.photo_path} size="large" />
        <p className={styles.name}>
          {member.first_name} {member.last_name}
        </p>
        <p className={styles.username}>@{member.username}</p>
        {member.is_admin && <span className={styles.adminBadge}>Admin</span>}
      </div>

      <dl className={styles.detailList}>
        <div className={styles.row}>
          <dt>Member since</dt>
          <dd>{formatDate(member.member_since)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Status</dt>
          <dd>
            <span className={`${styles.statusBadge} ${isActive ? styles.active : styles.inactive}`}>
              {isActive ? 'Active' : 'Inactive'}
            </span>
          </dd>
        </div>
        <div className={styles.row}>
          <dt>Completed rounds</dt>
          <dd>{member.completed_rounds_count}</dd>
        </div>
      </dl>

      {actionError && <p className="error-text">{actionError}</p>}

      <button type="button" className="btn btn-secondary" disabled={setStatus.isPending} onClick={handleToggleStatus}>
        {setStatus.isPending ? 'Saving…' : isActive ? 'Deactivate Member' : 'Activate Member'}
      </button>

      <div className={styles.dangerZone}>
        <h2 className="section-title">Danger Zone</h2>
        <p className={styles.dangerExplainer}>
          Permanently deleting a member is intended for test or accidental accounts. A normal former member should be
          Deactivated instead -- that preserves their tournament history, while a permanent delete removes the account
          entirely and cannot be undone.
        </p>
        <label className={styles.confirmLabel} htmlFor="deleteConfirm">
          Type <strong>@{member.username}</strong> to enable permanent deletion
        </label>
        <input
          id="deleteConfirm"
          className="field"
          type="text"
          value={deleteConfirmText}
          onChange={(e) => setDeleteConfirmText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-danger"
          disabled={!deleteConfirmed || permanentlyDelete.isPending}
          onClick={handlePermanentlyDelete}
        >
          {permanentlyDelete.isPending ? 'Deleting…' : 'Permanently Delete Member'}
        </button>
      </div>
    </div>
  );
}
