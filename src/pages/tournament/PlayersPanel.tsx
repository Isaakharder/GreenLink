import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { Avatar } from '../../components/Avatar';
import type { RosterInvitation, RosterPlayer, RosterTeam } from '../../hooks/useTournamentRoster';
import styles from './PlayersPanel.module.css';

interface FoundProfile {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
}

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
  const [username, setUsername] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FoundProfile | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);

  const organizer = players.find((p) => p.isOrganizer) ?? null;
  const acceptedPlayers = players.filter((p) => !p.isOrganizer);
  const pendingInvitations = invitations.filter((i) => i.status === 'pending');
  const closedInvitations = invitations.filter((i) => i.status === 'declined' || i.status === 'cancelled');

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    setSearchError(null);
    setFound(null);
    setInviteSuccess(false);

    const trimmed = username.trim();
    if (!trimmed) return;

    setSearching(true);
    const { data, error } = await supabase.rpc('search_profile_by_username', { p_username: trimmed });
    setSearching(false);

    if (error) {
      setSearchError(error.message);
      return;
    }

    const match = (Array.isArray(data) ? data[0] : data) as FoundProfile | undefined;
    if (!match) {
      setSearchError('No player found with that username.');
      return;
    }

    setFound(match);
  }

  async function handleInvite(userId: string) {
    setInviteSubmitting(true);
    setInviteError(null);

    const { error } = await supabase.rpc('invite_player', {
      p_tournament_id: tournamentId,
      p_invited_user_id: userId,
    });

    setInviteSubmitting(false);

    if (error) {
      setInviteError(error.message);
      return;
    }

    setInviteSuccess(true);
    setFound(null);
    setUsername('');
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
      <h2 className="section-title">Invite Player</h2>
      <form onSubmit={handleSearch}>
        <div className="field">
          <label htmlFor="invite-username">Username</label>
          <input
            id="invite-username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setFound(null);
              setInviteSuccess(false);
            }}
            autoCapitalize="none"
            disabled={!isPreLive}
          />
        </div>
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={searching || !username.trim() || !isPreLive}
        >
          {searching ? 'Searching…' : 'Find Player'}
        </button>
      </form>

      {!isPreLive && <p className={styles.muted}>Players can only be invited before the tournament starts.</p>}
      {searchError && <p className="error-text">{searchError}</p>}

      {found && (
        <div className={`card ${styles.foundCard}`}>
          <p className={styles.foundName}>
            {found.first_name} {found.last_name}
          </p>
          <p className={styles.foundUsername}>@{found.username}</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={inviteSubmitting}
            onClick={() => void handleInvite(found.id)}
          >
            {inviteSubmitting ? 'Inviting…' : 'Send Invitation'}
          </button>
          {inviteError && <p className="error-text">{inviteError}</p>}
        </div>
      )}

      {inviteSuccess && <p className={styles.successText}>Invitation sent.</p>}
      {rowError && <p className="error-text">{rowError}</p>}

      <h2 className="section-title">Organizer</h2>
      {organizer ? (
        <div className={styles.playerRow}>
          <Avatar name={organizer.name} />
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
            <Avatar name={player.name} />
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
            <Avatar name={invitation.name} />
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
            <Avatar name={invitation.name} />
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
                disabled={inviteSubmitting}
                onClick={() => void handleInvite(invitation.invitedUserId)}
              >
                Re-invite
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
