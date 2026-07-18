import type { TeamHoleScore, TournamentHole, TournamentTeam } from '../types/database';

export interface TeamStanding {
  teamId: string;
  teamName: string;
  relativeToPar: number;
  totalStrokes: number;
  holesPlayed: number;
  lastUpdated: string | null;
}

export interface RankedStanding extends TeamStanding {
  rank: number;
  isTied: boolean;
  rankLabel: string; // "1", "T-2", ...
}

/**
 * Aggregates raw team/hole/score rows into one standing per team. Used both
 * for the live leaderboard (holesPlayed may be partial and differ team to
 * team) and, once every hole is scored, for final results — the same
 * relative-to-par math applies either way.
 */
export function computeStandings(
  teams: TournamentTeam[],
  holes: TournamentHole[],
  scores: TeamHoleScore[],
): TeamStanding[] {
  const parByHole = new Map(holes.map((h) => [h.hole_number, h.par]));

  return teams.map((team) => {
    const teamScores = scores.filter((s) => s.team_id === team.id);
    const totalStrokes = teamScores.reduce((sum, s) => sum + s.strokes, 0);
    const relativeToPar = teamScores.reduce((sum, s) => sum + (s.strokes - (parByHole.get(s.hole_number) ?? 0)), 0);
    const lastUpdated = teamScores.reduce<string | null>((latest, s) => {
      if (!latest) return s.updated_at;
      return s.updated_at > latest ? s.updated_at : latest;
    }, null);

    return {
      teamId: team.id,
      teamName: team.name ?? `Team ${team.team_number ?? ''}`,
      relativeToPar,
      totalStrokes,
      holesPlayed: teamScores.length,
      lastUpdated,
    };
  });
}

/**
 * Ranks standings by relative-to-par only, ascending (lowest first). Never
 * factors in holes played — a team that has played fewer holes never ranks
 * ahead merely for that reason, and two teams tied on relative-to-par tie
 * regardless of how many holes each has completed. Ties share a rank
 * ("T-2") the way golf leaderboards conventionally display them.
 */
export function rankStandings(standings: TeamStanding[]): RankedStanding[] {
  const sorted = [...standings].sort((a, b) => a.relativeToPar - b.relativeToPar);

  return sorted.map((standing) => {
    // Standard competition ("1224") ranking, the golf-leaderboard
    // convention: a team's rank is 1 + the number of teams strictly ahead
    // of it. Two teams tied for first both show rank 1; the next
    // distinct score jumps straight to 3, it is never compressed to 2.
    const rank = sorted.filter((s) => s.relativeToPar < standing.relativeToPar).length + 1;
    const isTied = sorted.filter((s) => s.relativeToPar === standing.relativeToPar).length > 1;
    const rankLabel = isTied ? `T-${rank}` : `${rank}`;

    return { ...standing, rank, isTied, rankLabel };
  });
}

export function formatRelativeToPar(value: number): string {
  if (value === 0) return 'E';
  return value > 0 ? `+${value}` : `${value}`;
}
