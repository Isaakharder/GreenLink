import type { PersonalRoundVisibility, WalkingOrCart } from '../types/database';

export type ScoreBucket = 'birdie' | 'par' | 'bogey' | 'double-bogey-plus';

// Mirrors the bucketing in get_my_golf_stats() (supabase/migrations/0024) --
// eagle-or-better folds into 'birdie' since the brief lists exactly these
// four categories with no separate eagle bucket.
export function classifyScoreBucket(strokes: number, par: number): ScoreBucket {
  const diff = strokes - par;
  if (diff <= -1) return 'birdie';
  if (diff === 0) return 'par';
  if (diff === 1) return 'bogey';
  return 'double-bogey-plus';
}

/** "1h 42m" between a round's started_at and completed_at. Falls back to minutes-only under an hour, and to "<1m" for a round finished within the same minute. */
export function formatRoundDuration(startedAt: string, completedAt: string): string {
  const diffMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  const totalMinutes = Math.floor(diffMs / 60_000);

  if (totalMinutes < 1) return '<1m';

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export const VISIBILITY_LABEL: Record<PersonalRoundVisibility, string> = {
  private: 'Private',
  public: 'Public',
};

export const WALKING_OR_CART_LABEL: Record<WalkingOrCart, string> = {
  walking: 'Walking',
  cart: 'Cart',
};
