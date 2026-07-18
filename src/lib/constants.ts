export const SCORING_FORMATS = ['Team Scramble', 'Best Ball', 'Individual Stroke Play'] as const;
export type ScoringFormat = (typeof SCORING_FORMATS)[number];
export const DEFAULT_SCORING_FORMAT: ScoringFormat = 'Team Scramble';

export const TEAM_SIZE_OPTIONS = [2, 3, 4] as const;

export const DISTANCE_UNITS = ['yards', 'metres'] as const;

// Placeholder pars only — clearly flagged in the UI as needing review before
// a real course is configured. Front/back nine mirror each other, par 72
// overall for 18 holes.
const DEFAULT_PARS_9 = [4, 4, 3, 5, 4, 4, 3, 5, 4];
export const DEFAULT_PARS_18 = [...DEFAULT_PARS_9, ...DEFAULT_PARS_9];
export { DEFAULT_PARS_9 };

export function defaultParsForHoleCount(holeCount: number): number[] {
  return holeCount === 9 ? DEFAULT_PARS_9 : DEFAULT_PARS_18;
}
