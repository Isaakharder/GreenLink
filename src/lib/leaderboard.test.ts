import { describe, expect, it } from 'vitest';
import { computeStandings, formatRelativeToPar, rankStandings } from './leaderboard';
import type { TeamHoleScore, TournamentHole, TournamentTeam } from '../types/database';

function team(id: string, name: string): TournamentTeam {
  return { id, tournament_id: 't1', name, team_number: null, created_at: '' };
}

function hole(n: number, par: number): TournamentHole {
  return { id: `h${n}`, tournament_id: 't1', hole_number: n, par, stroke_index: null, distance: null, distance_unit: 'yards' };
}

function score(teamId: string, holeNumber: number, strokes: number, updatedAt = '2026-01-01T00:00:00Z'): TeamHoleScore {
  return {
    id: `${teamId}-${holeNumber}`,
    tournament_id: 't1',
    team_id: teamId,
    hole_number: holeNumber,
    strokes,
    revision: 1,
    last_updated_by: null,
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}

describe('computeStandings', () => {
  const holes = [hole(1, 4), hole(2, 5), hole(3, 3)];

  it('sums strokes and relative-to-par only across holes that have been scored', () => {
    const teams = [team('a', 'Team A')];
    const scores = [score('a', 1, 4), score('a', 2, 4)]; // birdie on the par-5, even on the par-4
    const [standing] = computeStandings(teams, holes, scores);
    expect(standing.totalStrokes).toBe(8);
    expect(standing.relativeToPar).toBe(-1);
    expect(standing.holesPlayed).toBe(2);
  });

  it('gives a team with no scores yet a relative-to-par of 0 and 0 holes played', () => {
    const [standing] = computeStandings([team('a', 'Team A')], holes, []);
    expect(standing.relativeToPar).toBe(0);
    expect(standing.holesPlayed).toBe(0);
  });
});

describe('rankStandings', () => {
  it('ranks strictly by relative-to-par, lowest first', () => {
    const standings = [
      { teamId: 'a', teamName: 'A', relativeToPar: 1, totalStrokes: 40, holesPlayed: 9, lastUpdated: null },
      { teamId: 'b', teamName: 'B', relativeToPar: -3, totalStrokes: 33, holesPlayed: 9, lastUpdated: null },
      { teamId: 'c', teamName: 'C', relativeToPar: -1, totalStrokes: 35, holesPlayed: 9, lastUpdated: null },
    ];
    const ranked = rankStandings(standings);
    expect(ranked.map((s) => s.teamId)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it('a team with fewer holes completed never ranks ahead merely for that reason', () => {
    const standings = [
      { teamId: 'behind', teamName: 'Behind', relativeToPar: -2, totalStrokes: 34, holesPlayed: 18, lastUpdated: null },
      { teamId: 'partial', teamName: 'Partial', relativeToPar: -1, totalStrokes: 8, holesPlayed: 9, lastUpdated: null },
    ];
    const ranked = rankStandings(standings);
    // "Behind" is actually better (lower relative-to-par) despite having
    // played more holes; "Partial" having fewer holes played must not put
    // it ahead on its own.
    expect(ranked[0].teamId).toBe('behind');
  });

  it('ties share the same rank and are labeled T-N', () => {
    const standings = [
      { teamId: 'a', teamName: 'A', relativeToPar: -2, totalStrokes: 34, holesPlayed: 12, lastUpdated: null },
      { teamId: 'b', teamName: 'B', relativeToPar: -2, totalStrokes: 34, holesPlayed: 11, lastUpdated: null },
      { teamId: 'c', teamName: 'C', relativeToPar: 1, totalStrokes: 37, holesPlayed: 12, lastUpdated: null },
    ];
    const ranked = rankStandings(standings);
    const [first, second, third] = ranked;
    expect(first.isTied).toBe(true);
    expect(second.isTied).toBe(true);
    expect(first.rankLabel).toBe('T-1');
    expect(second.rankLabel).toBe('T-1');
    expect(third.isTied).toBe(false);
    expect(third.rank).toBe(3);
    expect(third.rankLabel).toBe('3');
  });

  it('final-mode ranking (every team through all holes) is the same relative-to-par ordering', () => {
    const standings = [
      { teamId: 'a', teamName: 'A', relativeToPar: 3, totalStrokes: 75, holesPlayed: 18, lastUpdated: null },
      { teamId: 'b', teamName: 'B', relativeToPar: -4, totalStrokes: 68, holesPlayed: 18, lastUpdated: null },
    ];
    const ranked = rankStandings(standings);
    expect(ranked[0].teamId).toBe('b');
    expect(ranked[0].rankLabel).toBe('1');
  });
});

describe('formatRelativeToPar', () => {
  it('formats even par as E', () => {
    expect(formatRelativeToPar(0)).toBe('E');
  });

  it('formats over par with a leading +', () => {
    expect(formatRelativeToPar(3)).toBe('+3');
  });

  it('formats under par with a leading -', () => {
    expect(formatRelativeToPar(-2)).toBe('-2');
  });
});
