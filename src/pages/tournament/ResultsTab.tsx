import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabaseClient';
import { formatRelativeTime } from '../../lib/relativeTime';
import { formatRelativeToPar } from '../../lib/leaderboard';
import { useLeaderboardData } from '../../hooks/useLeaderboardData';
import { OfflineDataSection } from '../../components/OfflineDataSection';
import { TeamScorecardModal } from './TeamScorecardModal';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import type { TournamentLifecycleEvent } from '../../types/database';
import styles from './ResultsTab.module.css';

interface CorrectionRow {
  id: string;
  hole_number: number;
  previous_strokes: number | null;
  new_strokes: number;
  change_reason: string | null;
  server_timestamp: string;
  changed_by_profile: { first_name: string; last_name: string } | null;
  team: { name: string | null; team_number: number | null } | null;
}

async function fetchLifecycleEvents(tournamentId: string): Promise<TournamentLifecycleEvent[]> {
  const { data, error } = await supabase
    .from('tournament_lifecycle_events')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function fetchCorrections(tournamentId: string): Promise<CorrectionRow[]> {
  const { data, error } = await supabase
    .from('score_operations')
    .select(
      'id, hole_number, previous_strokes, new_strokes, change_reason, server_timestamp, changed_by_profile:profiles!changed_by(first_name,last_name), team:tournament_teams!team_id(name,team_number)',
    )
    .eq('tournament_id', tournamentId)
    .not('change_reason', 'is', null)
    .order('server_timestamp', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as CorrectionRow[];
}

export function ResultsTab() {
  const { tournament, membership, isOrganizer } = useOutletContext<TournamentAccess>();
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);

  const leaderboard = useLeaderboardData(tournament?.id, !!tournament && tournament.status === 'completed');

  const lifecycleQuery = useQuery({
    queryKey: ['tournament-lifecycle', tournament?.id],
    queryFn: () => fetchLifecycleEvents(tournament!.id),
    enabled: !!tournament,
  });

  const correctionsQuery = useQuery({
    queryKey: ['tournament-corrections', tournament?.id],
    queryFn: () => fetchCorrections(tournament!.id),
    enabled: !!tournament,
  });

  if (!tournament) return null;

  const forceFinishEvent = lifecycleQuery.data?.find((e) => e.event_type === 'force_finished') ?? null;
  const winner = leaderboard.standings[0];
  const openTeam = leaderboard.teams.find((t) => t.id === openTeamId) ?? null;

  return (
    <div>
      <h1>{tournament.name}</h1>
      <p className={styles.meta}>
        {tournament.course_name} · {tournament.tournament_date}
        {tournament.started_at && <> · Started {formatRelativeTime(tournament.started_at)}</>}
        {tournament.completed_at && <> · Completed {formatRelativeTime(tournament.completed_at)}</>}
      </p>

      <OfflineDataSection tournamentId={tournament.id} />

      {forceFinishEvent && (
        <div className={styles.forceNote}>
          <strong>Forced completion.</strong> The organizer closed this tournament before every team finished
          scoring.
          {forceFinishEvent.reason && <> Reason: {forceFinishEvent.reason}</>}
        </div>
      )}

      {winner && (
        <div className={styles.winnerCard}>
          <p className={styles.winnerLabel}>{winner.isTied ? 'Tied for First' : 'Winner'}</p>
          <p className={styles.winnerName}>{winner.teamName}</p>
          <p>{formatRelativeToPar(winner.relativeToPar)}</p>
        </div>
      )}

      <h2 className="section-title">Final Rankings</h2>
      <ol className={styles.leaderboard}>
        {leaderboard.standings.map((team) => (
          <li key={team.teamId}>
            <button type="button" className={styles.row} onClick={() => setOpenTeamId(team.teamId)}>
              <span className={styles.rank}>{team.rankLabel}</span>
              <span className={styles.teamName}>{team.teamName}</span>
              <span className={styles.score}>{formatRelativeToPar(team.relativeToPar)}</span>
              <span className={styles.strokes}>{team.totalStrokes} strokes</span>
            </button>
          </li>
        ))}
      </ol>

      {openTeam && (
        <TeamScorecardModal
          team={openTeam}
          holes={leaderboard.holes}
          scores={leaderboard.scores.filter((s) => s.team_id === openTeam.id)}
          isOwnTeam={membership?.team_id === openTeam.id}
          isOrganizer={isOrganizer}
          isLive={false}
          tournamentId={tournament.id}
          onClose={() => setOpenTeamId(null)}
        />
      )}

      {correctionsQuery.data && correctionsQuery.data.length > 0 && (
        <>
          <h2 className="section-title">Organizer Corrections</h2>
          <ul className={styles.auditList}>
            {correctionsQuery.data.map((row) => (
              <li key={row.id} className={styles.auditRow}>
                <div>
                  {row.team?.name ?? `Team ${row.team?.team_number ?? ''}`} · Hole {row.hole_number}:{' '}
                  {row.previous_strokes ?? '—'} → {row.new_strokes}
                </div>
                <div className={styles.auditMeta}>
                  {row.change_reason} — {row.changed_by_profile?.first_name} {row.changed_by_profile?.last_name},{' '}
                  {formatRelativeTime(row.server_timestamp)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
