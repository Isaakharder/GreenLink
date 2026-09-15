/**
 * Full elapsed years since memberSince (anniversary-aware, not a calendar-year
 * subtraction) -- someone who joined 11 months ago is 0 years in, not 1.
 * Never negative even if memberSince is somehow in the future (clock skew,
 * bad data) -- 0 in that case rather than a nonsensical negative count.
 */
export function yearsAsMember(memberSince: string, now: Date = new Date()): number {
  const joined = new Date(memberSince);
  let years = now.getFullYear() - joined.getFullYear();

  const hadAnniversaryThisYear =
    now.getMonth() > joined.getMonth() || (now.getMonth() === joined.getMonth() && now.getDate() >= joined.getDate());
  if (!hadAnniversaryThisYear) years -= 1;

  return Math.max(years, 0);
}

/** "New member" / "1 year" / "N years" -- the label a member card actually renders. */
export function formatMembershipDuration(memberSince: string, now: Date = new Date()): string {
  const years = yearsAsMember(memberSince, now);
  if (years === 0) return 'New member';
  return years === 1 ? '1 year' : `${years} years`;
}
