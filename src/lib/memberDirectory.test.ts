import { describe, expect, it } from 'vitest';
import { formatMembershipDuration, yearsAsMember } from './memberDirectory';

describe('yearsAsMember', () => {
  it('is 0 for someone who joined earlier this same year', () => {
    expect(yearsAsMember('2026-06-01T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe(0);
  });

  it('is 0 for someone who joined less than a year ago, even across a calendar-year boundary', () => {
    expect(yearsAsMember('2025-11-01T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe(0);
  });

  it('is 1 the day of the first anniversary, not before', () => {
    expect(yearsAsMember('2025-09-15T00:00:00Z', new Date('2026-09-14T00:00:00Z'))).toBe(0);
    expect(yearsAsMember('2025-09-15T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe(1);
  });

  it('counts full elapsed years, not a calendar-year subtraction', () => {
    // Joined Dec 2020, "now" is Jan 2026 -- 5 calendar-year labels apart, but
    // the 2026 anniversary (Dec 2026) hasn't happened yet.
    expect(yearsAsMember('2020-12-20T00:00:00Z', new Date('2026-01-05T00:00:00Z'))).toBe(5);
  });

  it('is never negative, even for a memberSince somehow in the future', () => {
    expect(yearsAsMember('2027-01-01T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe(0);
  });
});

describe('formatMembershipDuration', () => {
  it('labels a brand-new member distinctly from "0 years"', () => {
    expect(formatMembershipDuration('2026-06-01T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe('New member');
  });

  it('uses the singular for exactly 1 year', () => {
    expect(formatMembershipDuration('2025-09-15T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe('1 year');
  });

  it('uses the plural for more than 1 year', () => {
    expect(formatMembershipDuration('2020-01-01T00:00:00Z', new Date('2026-09-15T00:00:00Z'))).toBe('6 years');
  });
});
