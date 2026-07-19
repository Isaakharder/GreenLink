import { describe, expect, it } from 'vitest';
import { classifyScoreBucket, formatRoundDuration } from './personalRounds';

describe('classifyScoreBucket', () => {
  it('folds eagle-or-better into birdie', () => {
    expect(classifyScoreBucket(2, 4)).toBe('birdie'); // eagle
    expect(classifyScoreBucket(3, 4)).toBe('birdie'); // birdie
  });

  it('is par when strokes equal par', () => {
    expect(classifyScoreBucket(4, 4)).toBe('par');
  });

  it('is bogey for one over par', () => {
    expect(classifyScoreBucket(5, 4)).toBe('bogey');
  });

  it('is double-bogey-plus for two or more over par', () => {
    expect(classifyScoreBucket(6, 4)).toBe('double-bogey-plus');
    expect(classifyScoreBucket(9, 4)).toBe('double-bogey-plus');
  });
});

describe('formatRoundDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatRoundDuration('2026-07-19T08:00:00.000Z', '2026-07-19T09:42:00.000Z')).toBe('1h 42m');
  });

  it('omits hours under an hour', () => {
    expect(formatRoundDuration('2026-07-19T08:00:00.000Z', '2026-07-19T08:35:00.000Z')).toBe('35m');
  });

  it('returns <1m for a round finished within the same minute', () => {
    expect(formatRoundDuration('2026-07-19T08:00:00.000Z', '2026-07-19T08:00:30.000Z')).toBe('<1m');
  });

  it('never goes negative for out-of-order timestamps', () => {
    expect(formatRoundDuration('2026-07-19T08:00:00.000Z', '2026-07-19T07:00:00.000Z')).toBe('<1m');
  });
});
