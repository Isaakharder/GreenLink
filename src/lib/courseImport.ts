export type TeeCompatibility = 'direct' | 'needs-nine' | 'incompatible';

/**
 * Whether an imported tee's hole count can be applied to a tournament with
 * the given hole count, and how: an exact match applies directly, an
 * 18-hole tee on a 9-hole tournament needs the organizer to pick front/back
 * nine, and anything else (e.g. a 9-hole tee on an 18-hole tournament)
 * can't be reconciled at all. Mirrors the same rule enforced server-side in
 * apply_imported_course_to_tournament() (supabase/migrations/0021) --
 * shared by CreateTournament.tsx and SettingsTab.tsx so the two pages can
 * never drift on what counts as compatible.
 */
export function classifyTeeCompatibility(teeHoles: number, tournamentHoleCount: number): TeeCompatibility {
  if (teeHoles === tournamentHoleCount) return 'direct';
  if (teeHoles === 18 && tournamentHoleCount === 9) return 'needs-nine';
  return 'incompatible';
}
