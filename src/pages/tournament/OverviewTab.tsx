import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabaseClient';
import { useTournamentReadiness } from '../../hooks/useTournamentReadiness';
import { useTournamentProgress } from '../../hooks/useTournamentProgress';
import { refreshIfDownloaded } from '../../lib/offlineDownload';
import { useAuth } from '../../auth/useAuth';
import { OfflineDataSection } from '../../components/OfflineDataSection';
import { ResultsTab } from './ResultsTab';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import styles from './OverviewTab.module.css';

interface RosterEntry {
  userId: string;
  name: string;
  isOrganizer: boolean;
}

interface OverviewStats {
  teamCount: number;
  totalPar: number;
  holesConfiguredCount: number;
}

async function fetchRoster(tournamentId: string): Promise<RosterEntry[]> {
  const { data: players, error } = await supabase
    .from('tournament_players')
    .select('user_id, is_organizer')
    .eq('tournament_id', tournamentId)
    .eq('membership_status', 'accepted');
  if (error) throw error;
  if (!players || players.length === 0) return [];

  const userIds = [...new Set(players.map((p) => p.user_id))];
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .in('id', userIds);
  if (profilesError) throw profilesError;

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  return players.map((player) => {
    const profile = profileById.get(player.user_id);
    return {
      userId: player.user_id,
      name: profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown player',
      isOrganizer: player.is_organizer,
    };
  });
}

async function fetchOverviewStats(tournamentId: string): Promise<OverviewStats> {
  const [teamsResult, holesResult] = await Promise.all([
    supabase.from('tournament_teams').select('id', { count: 'exact', head: true }).eq('tournament_id', tournamentId),
    supabase.from('tournament_holes').select('par').eq('tournament_id', tournamentId),
  ]);
  if (teamsResult.error) throw teamsResult.error;
  if (holesResult.error) throw holesResult.error;

  const holes = holesResult.data ?? [];
  return {
    teamCount: teamsResult.count ?? 0,
    totalPar: holes.reduce((sum, hole) => sum + hole.par, 0),
    holesConfiguredCount: holes.length,
  };
}

export function OverviewTab() {
  const { tournament, isOrganizer } = useOutletContext<TournamentAccess>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);

  const rosterQuery = useQuery({
    queryKey: ['tournament-roster', tournament?.id],
    queryFn: () => fetchRoster(tournament!.id),
    enabled: !!tournament,
  });

  const statsQuery = useQuery({
    queryKey: ['tournament-overview-stats', tournament?.id],
    queryFn: () => fetchOverviewStats(tournament!.id),
    enabled: !!tournament,
  });

  const isPreLive = tournament?.status === 'draft' || tournament?.status === 'upcoming';
  const readinessQuery = useTournamentReadiness(tournament?.id, isOrganizer && isPreLive);
  const progressQuery = useTournamentProgress(tournament?.id, isOrganizer && tournament?.status === 'live');

  const [showForceFinish, setShowForceFinish] = useState(false);
  const [forceReason, setForceReason] = useState('');

  if (!tournament) return null;

  if (tournament.status === 'completed') {
    return <ResultsTab />;
  }

  const organizerName = rosterQuery.data?.find((player) => player.isOrganizer)?.name ?? '—';
  const readiness = readinessQuery.data;
  const progress = progressQuery.data;

  function refreshAfterLifecycleChange() {
    void queryClient.invalidateQueries({ queryKey: ['tournament', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-readiness', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-progress', tournament!.id] });
  }

  async function handleStart() {
    setActionSubmitting(true);
    setActionError(null);
    const { error } = await supabase.rpc('start_tournament', { p_tournament_id: tournament!.id });
    setActionSubmitting(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    refreshAfterLifecycleChange();
    if (user) void refreshIfDownloaded(tournament!.id, user.id);
  }

  async function handleFinish() {
    // Re-fetch progress right before deciding, so a stale/cached read never
    // lets the organizer skip the incomplete-teams warning.
    const { data: freshProgress, error: progressError } = await supabase.rpc('get_tournament_progress', {
      p_tournament_id: tournament!.id,
    });
    if (progressError) {
      setActionError(progressError.message);
      return;
    }
    if (!freshProgress.all_complete) {
      setShowForceFinish(true);
      return;
    }

    if (!window.confirm('Finish this tournament? Regular players will no longer be able to change scores.')) {
      return;
    }
    setActionSubmitting(true);
    setActionError(null);
    const { error } = await supabase.rpc('finish_tournament', {
      p_tournament_id: tournament!.id,
      p_force: false,
      p_reason: null,
    });
    setActionSubmitting(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    refreshAfterLifecycleChange();
  }

  async function handleForceFinish() {
    if (!forceReason.trim()) {
      setActionError('A reason is required to force-complete the tournament.');
      return;
    }
    setActionSubmitting(true);
    setActionError(null);
    const { error } = await supabase.rpc('finish_tournament', {
      p_tournament_id: tournament!.id,
      p_force: true,
      p_reason: forceReason.trim(),
    });
    setActionSubmitting(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    setShowForceFinish(false);
    setForceReason('');
    refreshAfterLifecycleChange();
  }

  let statusBannerText = 'Setup incomplete';
  let statusBannerTone = styles.bannerIncomplete;
  if (tournament.status === 'live') {
    statusBannerText = 'Tournament live';
    statusBannerTone = styles.bannerLive;
  } else if (tournament.status === 'cancelled') {
    statusBannerText = 'Tournament cancelled';
    statusBannerTone = styles.bannerIncomplete;
  } else if (readiness?.ready) {
    statusBannerText = 'Ready to start';
    statusBannerTone = styles.bannerReady;
  }

  const checklistItems = readiness
    ? [
        { label: 'Tournament details completed', complete: readiness.details_complete },
        {
          label: `Course holes configured (${readiness.holes_configured_count}/${readiness.holes_required})`,
          complete: readiness.holes_configured,
        },
        {
          label: `At least two accepted players (${readiness.accepted_player_count})`,
          complete: readiness.min_players_met,
        },
        {
          label:
            readiness.unassigned_count > 0
              ? `Every accepted player assigned to a team (${readiness.unassigned_count} unassigned)`
              : 'Every accepted player assigned to a team',
          complete: readiness.all_players_assigned,
        },
        { label: `Teams created (${readiness.team_count})`, complete: readiness.teams_created },
        { label: 'Each team satisfies the selected team-size rules', complete: readiness.team_sizes_valid },
        { label: 'No player assigned to multiple teams', complete: readiness.no_duplicate_assignments },
      ]
    : [];

  return (
    <div>
      <h1>{tournament.name}</h1>

      <div className={`${styles.banner} ${statusBannerTone}`}>{statusBannerText}</div>

      <OfflineDataSection tournamentId={tournament.id} />

      <dl className={styles.details}>
        <div className={styles.row}>
          <dt>Course</dt>
          <dd>{tournament.course_name}</dd>
        </div>
        <div className={styles.row}>
          <dt>Date</dt>
          <dd>{tournament.tournament_date}</dd>
        </div>
        <div className={styles.row}>
          <dt>Status</dt>
          <dd className={styles.statusValue}>{tournament.status}</dd>
        </div>
        <div className={styles.row}>
          <dt>Organizer</dt>
          <dd>{organizerName}</dd>
        </div>
        <div className={styles.row}>
          <dt>Scoring format</dt>
          <dd>{tournament.scoring_format ?? '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt>Number of holes</dt>
          <dd>{tournament.hole_count}</dd>
        </div>
        <div className={styles.row}>
          <dt>Team size</dt>
          <dd>{tournament.team_size ?? '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt>Accepted players</dt>
          <dd>{rosterQuery.data?.length ?? 0}</dd>
        </div>
        <div className={styles.row}>
          <dt>Teams</dt>
          <dd>{statsQuery.data?.teamCount ?? 0}</dd>
        </div>
        <div className={styles.row}>
          <dt>Total course par</dt>
          <dd>{statsQuery.data && statsQuery.data.holesConfiguredCount > 0 ? statsQuery.data.totalPar : '—'}</dd>
        </div>
        {tournament.description && (
          <div className={styles.row}>
            <dt>Notes</dt>
            <dd>{tournament.description}</dd>
          </div>
        )}
      </dl>

      <h2 className="section-title">Accepted Players</h2>
      {rosterQuery.isLoading ? (
        <p className={styles.muted}>Loading players…</p>
      ) : rosterQuery.data && rosterQuery.data.length > 0 ? (
        <ul className={styles.roster}>
          {rosterQuery.data.map((player) => (
            <li key={player.userId}>
              {player.name} {player.isOrganizer && <span className={styles.organizerTag}>Organizer</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No accepted players yet.</p>
      )}

      {isOrganizer && isPreLive && (
        <>
          <h2 className="section-title">Setup Checklist</h2>
          {readinessQuery.isLoading ? (
            <p className={styles.muted}>Checking setup…</p>
          ) : (
            <ul className={styles.checklist}>
              {checklistItems.map((item) => (
                <li key={item.label} className={item.complete ? styles.checklistDone : styles.checklistPending}>
                  <span aria-hidden="true">{item.complete ? '✓' : '○'}</span> {item.label}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {isOrganizer && isPreLive && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={actionSubmitting || !readiness?.ready}
          onClick={handleStart}
        >
          {actionSubmitting ? 'Starting…' : 'Start Tournament'}
        </button>
      )}

      {isOrganizer && tournament.status === 'live' && (
        <>
          <h2 className="section-title">Team Progress</h2>
          {progressQuery.isLoading ? (
            <p className={styles.muted}>Checking progress…</p>
          ) : (
            <ul className={styles.checklist}>
              {progress?.teams.map((team) => (
                <li key={team.team_id} className={team.complete ? styles.checklistDone : styles.checklistPending}>
                  <span aria-hidden="true">{team.complete ? '✓' : '○'}</span> {team.name}:{' '}
                  {team.holes_scored}/{progress.hole_count} complete
                </li>
              ))}
            </ul>
          )}

          <div className={styles.liveActions}>
            <Link to={`/tournaments/${tournament.id}/scorecard`} className="btn btn-primary">
              Continue Scoring
            </Link>
            <Link to={`/tournaments/${tournament.id}/live`} className="btn btn-secondary">
              Live Score
            </Link>
            <button type="button" className="btn btn-danger" disabled={actionSubmitting} onClick={handleFinish}>
              {actionSubmitting ? 'Finishing…' : 'Finish Tournament'}
            </button>
          </div>

          {showForceFinish && (
            <div className={`card ${styles.forceFinishCard}`}>
              <p>
                <strong>
                  {progress?.teams.filter((t) => !t.complete).length ?? 0} team(s) still have incomplete
                  scorecards:
                </strong>
              </p>
              <ul className={styles.checklist}>
                {progress?.teams
                  .filter((t) => !t.complete)
                  .map((t) => (
                    <li key={t.team_id} className={styles.checklistPending}>
                      {t.name}: {t.holes_scored}/{progress.hole_count}
                    </li>
                  ))}
              </ul>
              <div className="field">
                <label htmlFor="force-finish-reason">Reason for finishing early (required)</label>
                <input
                  id="force-finish-reason"
                  value={forceReason}
                  onChange={(event) => setForceReason(event.target.value)}
                  placeholder="e.g. weather delay, daylight ran out"
                />
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={actionSubmitting}
                onClick={handleForceFinish}
              >
                {actionSubmitting ? 'Finishing…' : 'Force Complete Tournament'}
              </button>
              <button
                type="button"
                className="btn btn-text btn-auto"
                onClick={() => {
                  setShowForceFinish(false);
                  setForceReason('');
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </>
      )}

      {actionError && <p className="error-text">{actionError}</p>}
    </div>
  );
}
