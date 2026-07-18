import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { Avatar } from '../../components/Avatar';
import { computeAutoTeamCount } from '../../lib/teamMath';
import type { RosterPlayer, RosterTeam } from '../../hooks/useTournamentRoster';
import styles from './TeamsPanel.module.css';

interface TeamsPanelProps {
  tournamentId: string;
  players: RosterPlayer[];
  teams: RosterTeam[];
  teamSize: number | null;
  isPreLive: boolean;
  onChange: () => void;
}

export function TeamsPanel({ tournamentId, players, teams, teamSize, isPreLive, onChange }: TeamsPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  const unassignedPlayers = players.filter((player) => !player.teamId);
  const previewAutoCount = teamSize ? computeAutoTeamCount(players.length, teamSize, teams.length) : 0;

  async function handleCreateTeam() {
    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('create_tournament_team', {
      p_tournament_id: tournamentId,
      p_name: null,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChange();
  }

  async function handleAutoCreate() {
    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('auto_create_tournament_teams', {
      p_tournament_id: tournamentId,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChange();
  }

  async function handleRename(teamId: string, draft: string) {
    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('rename_tournament_team', {
      p_team_id: teamId,
      p_name: draft,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setRenameDrafts((prev) => {
      const next = { ...prev };
      delete next[teamId];
      return next;
    });
    onChange();
  }

  async function handleDeleteTeam(teamId: string, label: string) {
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('delete_tournament_team', { p_team_id: teamId });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChange();
  }

  async function handleAssign(playerId: string, teamId: string) {
    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('assign_tournament_player', {
      p_player_id: playerId,
      p_team_id: teamId,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChange();
  }

  async function handleUnassign(playerId: string) {
    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('unassign_tournament_player', { p_player_id: playerId });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onChange();
  }

  return (
    <div>
      <h2 className="section-title">Teams</h2>

      {isPreLive && (
        <div className={styles.toolRow}>
          <button
            type="button"
            className="btn btn-secondary btn-small btn-auto"
            disabled={busy}
            onClick={() => void handleCreateTeam()}
          >
            Create Team
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small btn-auto"
            disabled={busy || !teamSize || previewAutoCount === 0}
            title={!teamSize ? 'Set a team size before auto-creating teams' : undefined}
            onClick={() => void handleAutoCreate()}
          >
            Auto-create Teams{teamSize && previewAutoCount > 0 ? ` (+${previewAutoCount})` : ''}
          </button>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {teams.length === 0 ? (
        <p className="empty-state">No teams have been created yet.</p>
      ) : (
        teams.map((team) => {
          const teamPlayers = players.filter((player) => player.teamId === team.id);
          const label = team.name ?? `Team ${team.teamNumber ?? ''}`;
          const draft = renameDrafts[team.id] ?? label;
          const sizeOk = teamSize ? teamPlayers.length === teamSize : true;

          return (
            <div key={team.id} className="card">
              {isPreLive ? (
                <div className={styles.renameRow}>
                  <input
                    className={styles.nameInput}
                    value={draft}
                    aria-label={`Rename ${label}`}
                    onChange={(event) =>
                      setRenameDrafts((prev) => ({ ...prev, [team.id]: event.target.value }))
                    }
                  />
                  {draft !== label && draft.trim().length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small btn-auto"
                      disabled={busy}
                      onClick={() => void handleRename(team.id, draft)}
                    >
                      Save
                    </button>
                  )}
                </div>
              ) : (
                <p className={styles.teamName}>{label}</p>
              )}

              <p className={sizeOk ? styles.countOk : styles.countBad}>
                {teamPlayers.length}
                {teamSize ? ` / ${teamSize}` : ''} players
              </p>

              {teamPlayers.length > 0 ? (
                <ul className={styles.memberList}>
                  {teamPlayers.map((player) => (
                    <li key={player.playerId} className={styles.memberRow}>
                      <Avatar name={player.name} size="small" />
                      <span className={styles.memberName}>{player.name}</span>
                      {isPreLive && (
                        <button
                          type="button"
                          className="btn-text"
                          disabled={busy}
                          onClick={() => void handleUnassign(player.playerId)}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>No players assigned yet.</p>
              )}

              {isPreLive && unassignedPlayers.length > 0 && (
                <div className="field">
                  <label htmlFor={`add-player-${team.id}`}>Add player</label>
                  <select
                    id={`add-player-${team.id}`}
                    value=""
                    disabled={busy}
                    onChange={(event) => {
                      if (event.target.value) void handleAssign(event.target.value, team.id);
                    }}
                  >
                    <option value="">Select a player…</option>
                    {unassignedPlayers.map((player) => (
                      <option key={player.playerId} value={player.playerId}>
                        {player.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isPreLive && (
                <button
                  type="button"
                  className="btn btn-danger btn-small btn-auto"
                  disabled={busy || teamPlayers.length > 0}
                  title={teamPlayers.length > 0 ? 'Remove all players from this team before deleting it' : undefined}
                  onClick={() => void handleDeleteTeam(team.id, label)}
                >
                  Remove Team
                </button>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
