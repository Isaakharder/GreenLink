import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { Avatar } from '../../components/Avatar';
import { useAuth } from '../../auth/useAuth';
import { useMembers } from '../../hooks/useMembers';
import { invitableMembers, resolveInviteStatus } from '../../lib/inviteMembers';
import type { RosterInvitation, RosterPlayer, RosterTeam } from '../../hooks/useTournamentRoster';
import styles from './PlayersPanel.module.css';

interface PlayersPanelProps {
  tournamentId: string;
  players: RosterPlayer[];
  invitations: RosterInvitation[];
  teams: RosterTeam[];
  isPreLive: boolean;
  onChange: () => void;
}

function teamLabel(teamId: string | null, teams: RosterTeam[]): string {
  if (!teamId) return 'Unassigned';
  const team = teams.find((t) => t.id === teamId);
  if (!team) return 'Unassigned';
  return team.name ?? `Team ${team.teamNumber ?? ''}`;
}

export function PlayersPanel({ tournamentId, players, invitations, teams, isPreLive, onChange }: PlayersPanelProps) {
  const { user } = useAuth();
  const { data: members } = useMembers();
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);

  const organizer = players.find((p) => p.isOrganizer) ?? null;
  const acceptedPlayers = players.filter((p) => !p.isOrganizer);
  const pendingInvitations = invitations.filter((i) => i.status === 'pending');
  const closedInvitations = invitations.filter((i) => i.status === 'declined' || i.status === 'cancelled');

  const invitable = invitableMembers(members ?? [], user?.id);

  async function handleInvite(userId: string) {
    setBusyMemberId(userId);
    setInviteError(null);

    const { error } = await supabase.rpc('invite_player', {
      p_tournament_id: tournamentId,
      p_invited_user_id: userId,
    });

    setBusyMemberId(null);

    if (error) {
      setInviteError(error.message);
      return;
    }

    onChange();
  }

  async function handleCancelInvitation(invitationId: string) {
    setRowError(null);
    setBusyRowId(invitationId);
    const { error } = await supabase.rpc('cancel_tournament_invitation', { p_invitation_id: invitationId });
    setBusyRowId(null);
    if (error) {
      setRowError(error.message);
      return;
    }
    onChange();
  }

  async function handleRemovePlayer(playerId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this tournament?`)) return;
    setRowError(null);
    setBusyRowId(playerId);
    const { error } = await supabase.rpc('remove_tournament_player', { p_player_id: playerId });
    setBusyRowId(null);
    if (error) {
      setRowError(error.message);
      return;
    }
    onChange();
  }

  return (
    <div>
      <h2 className="section-title">Invite Members</h2>
      {!isPreLive && <p className={styles.muted}>Players can only be invited before the tournament starts.</p>}
      {inviteError && <p className="error-text">{inviteError}</p>}

      {invitable.length === 0 ? (
        <p className={styles.muted}>No other GreenLink members yet.</p>
      ) : (
        // A dedicated wrapper (not just reusing .playerRow at the top level)
        // so e2e tests can scope to this section specifically -- a member
        // can legitimately appear again below (Accepted Players, Pending
        // Invitations, Declined Invitations), and "Invite Members" is the
        // only section where their *tournament* status has to be
        // unambiguous from the others.
        <div className={styles.inviteList}>
          {invitable.map((member) => {
            const status = resolveInviteStatus(member.id, players, invitations);
            return (
              <div key={member.id} className={styles.playerRow}>
                <Avatar name={`${member.first_name} ${member.last_name}`} photoPath={member.photo_path} />
                <div className={styles.playerInfo}>
                  <p className={styles.playerName}>
                    {member.first_name} {member.last_name}
                  </p>
                  <p className={styles.playerMeta}>@{member.username}</p>
                </div>
                {status === 'accepted' && <span className="badge badge-accepted">Accepted ✓</span>}
                {status === 'pending' && <span className="badge badge-pending">Pending</span>}
                {status === 'invite' && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small btn-auto"
                    disabled={!isPreLive || busyMemberId === member.id}
                    onClick={() => void handleInvite(member.id)}
                  >
                    {busyMemberId === member.id ? 'Inviting…' : 'Invite'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {rowError && <p className="error-text">{rowError}</p>}

      <h2 className="section-title">Organizer</h2>
      {organizer ? (
        <div className={styles.playerRow}>
          <Avatar name={organizer.name} photoPath={organizer.photoPath} />
          <div className={styles.playerInfo}>
            <p className={styles.playerName}>{organizer.name}</p>
            <p className={styles.playerMeta}>@{organizer.username}</p>
          </div>
          <span className="badge badge-accepted">Organizer</span>
        </div>
      ) : (
        <p className={styles.muted}>—</p>
      )}

      <h2 className="section-title">Accepted Players</h2>
      {acceptedPlayers.length === 0 ? (
        <p className={styles.muted}>No accepted players yet.</p>
      ) : (
        acceptedPlayers.map((player) => (
          <div key={player.playerId} className={styles.playerRow}>
            <Avatar name={player.name} photoPath={player.photoPath} />
            <div className={styles.playerInfo}>
              <p className={styles.playerName}>{player.name}</p>
              <p className={styles.playerMeta}>
                @{player.username} · {teamLabel(player.teamId, teams)}
              </p>
            </div>
            <span className="badge badge-accepted">Accepted</span>
            {isPreLive && (
              <button
                type="button"
                className="btn btn-danger btn-small btn-auto"
                disabled={busyRowId === player.playerId}
                onClick={() => void handleRemovePlayer(player.playerId, player.name)}
              >
                Remove
              </button>
            )}
          </div>
        ))
      )}

      <h2 className="section-title">Pending Invitations</h2>
      {pendingInvitations.length === 0 ? (
        <p className={styles.muted}>No pending invitations.</p>
      ) : (
        pendingInvitations.map((invitation) => (
          <div key={invitation.id} className={styles.playerRow}>
            <Avatar name={invitation.name} photoPath={invitation.photoPath} />
            <div className={styles.playerInfo}>
              <p className={styles.playerName}>{invitation.name}</p>
              <p className={styles.playerMeta}>@{invitation.username}</p>
            </div>
            <span className="badge badge-pending">Pending</span>
            {isPreLive && (
              <button
                type="button"
                className="btn btn-secondary btn-small btn-auto"
                disabled={busyRowId === invitation.id}
                onClick={() => void handleCancelInvitation(invitation.id)}
              >
                Cancel
              </button>
            )}
          </div>
        ))
      )}

      <h2 className="section-title">Declined Invitations</h2>
      {closedInvitations.length === 0 ? (
        <p className={styles.muted}>No declined or cancelled invitations.</p>
      ) : (
        closedInvitations.map((invitation) => (
          <div key={invitation.id} className={styles.playerRow}>
            <Avatar name={invitation.name} photoPath={invitation.photoPath} />
            <div className={styles.playerInfo}>
              <p className={styles.playerName}>{invitation.name}</p>
              <p className={styles.playerMeta}>@{invitation.username}</p>
            </div>
            <span className={`badge badge-${invitation.status}`}>
              {invitation.status === 'declined' ? 'Declined' : 'Cancelled'}
            </span>
            {isPreLive && (
              <button
                type="button"
                className="btn btn-secondary btn-small btn-auto"
                disabled={busyMemberId === invitation.invitedUserId}
                onClick={() => void handleInvite(invitation.invitedUserId)}
              >
                {busyMemberId === invitation.invitedUserId ? 'Inviting…' : 'Re-invite'}
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
