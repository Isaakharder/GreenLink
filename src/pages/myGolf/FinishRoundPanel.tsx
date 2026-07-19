import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { computeStandings, formatRelativeToPar } from '../../lib/leaderboard';
import { formatRoundDuration, VISIBILITY_LABEL } from '../../lib/personalRounds';
import { supabase } from '../../lib/supabaseClient';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import type { PersonalRoundVisibility } from '../../types/database';
import styles from './FinishRoundPanel.module.css';

interface FinishRoundPanelProps {
  access: TournamentAccess;
  onClose: () => void;
  onFinished: () => void;
}

const VISIBILITY_OPTIONS: PersonalRoundVisibility[] = ['private', 'public'];

/**
 * "Finish Round": summary plus the Private/Public choice, defaulting to
 * Private. Uses a one-shot fetch + computeStandings() (the same pure
 * leaderboard math the scorecard uses) rather than useLeaderboardData --
 * that hook opens a realtime channel keyed by tournament id, and
 * ScorecardTab (still mounted underneath this panel) already holds that
 * exact channel open for this round; a second subscriber on the same
 * channel name throws.
 */
export function FinishRoundPanel({ access, onClose, onFinished }: FinishRoundPanelProps) {
  const { tournament, membership } = access;
  const teamId = membership?.team_id ?? null;

  const summaryQuery = useQuery({
    queryKey: ['personal-round-summary', tournament?.id, teamId],
    queryFn: async () => {
      const [{ data: holes, error: holesError }, { data: scores, error: scoresError }] = await Promise.all([
        supabase.from('tournament_holes').select('*').eq('tournament_id', tournament!.id),
        supabase.from('team_hole_scores').select('*').eq('tournament_id', tournament!.id).eq('team_id', teamId as string),
      ]);
      if (holesError) throw holesError;
      if (scoresError) throw scoresError;

      const [standing] = computeStandings(
        [{ id: teamId as string, tournament_id: tournament!.id, name: null, team_number: null, created_at: '' }],
        holes ?? [],
        scores ?? [],
      );
      return standing;
    },
    enabled: !!tournament && !!teamId,
  });

  const [visibility, setVisibility] = useState<PersonalRoundVisibility>('private');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!tournament) return null;

  const standing = summaryQuery.data;

  async function handleFinish() {
    setSubmitting(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('finish_personal_round', {
      p_tournament_id: tournament!.id,
      p_visibility: visibility,
    });

    setSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    onFinished();
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
        <h2 className={styles.title}>Finish Round</h2>

        <dl className={styles.summary}>
          <div>
            <dt>Course</dt>
            <dd>{tournament.course_name}</dd>
          </div>
          <div>
            <dt>Total Score</dt>
            <dd>{standing ? standing.totalStrokes : '—'}</dd>
          </div>
          <div>
            <dt>Relative to Par</dt>
            <dd>{standing ? formatRelativeToPar(standing.relativeToPar) : '—'}</dd>
          </div>
          <div>
            <dt>Round Duration</dt>
            <dd>{tournament.started_at ? formatRoundDuration(tournament.started_at, new Date().toISOString()) : '—'}</dd>
          </div>
        </dl>

        <h3 className="section-title">Who can see this round?</h3>
        <div className={styles.visibilityRow}>
          {VISIBILITY_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={`btn btn-secondary btn-small ${visibility === option ? styles.chosen : ''}`}
              onClick={() => setVisibility(option)}
            >
              {VISIBILITY_LABEL[option]}
            </button>
          ))}
        </div>
        <p className={styles.visibilityHint}>
          {visibility === 'public'
            ? 'This round will appear in the Home community feed once finished.'
            : 'Only you will be able to see this round.'}
        </p>

        {error && <p className="error-text">{error}</p>}

        <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void handleFinish()}>
          {submitting ? 'Finishing…' : 'Finish Round'}
        </button>
        <button type="button" className="btn btn-text btn-auto" onClick={onClose}>
          Keep Playing
        </button>
      </div>
    </div>
  );
}
