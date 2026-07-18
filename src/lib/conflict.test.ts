import { describe, expect, it } from 'vitest';
import { describeConflict, resolveConflict, type ConflictInfo } from './conflict';

const conflict: ConflictInfo = {
  holeNumber: 7,
  updatedByName: 'John',
  serverStrokes: 4,
  serverRevision: 3,
  submittedStrokes: 5,
};

describe('describeConflict', () => {
  it('matches the required copy', () => {
    expect(describeConflict(conflict)).toBe(
      'John changed Hole 7 to 4 while you were offline. You entered 5.',
    );
  });

  it('falls back to a generic name when none is known', () => {
    expect(describeConflict({ ...conflict, updatedByName: null })).toBe(
      'A teammate changed Hole 7 to 4 while you were offline. You entered 5.',
    );
  });

  it('falls back to a generic name for a blank/whitespace-only name', () => {
    expect(describeConflict({ ...conflict, updatedByName: '   ' })).toBe(
      'A teammate changed Hole 7 to 4 while you were offline. You entered 5.',
    );
  });
});

describe('resolveConflict', () => {
  it('keep-theirs accepts the server value as-is, no new operation', () => {
    const resolution = resolveConflict(conflict, 'keep-theirs');
    expect(resolution).toEqual({ action: 'keep-theirs', strokes: 4, revision: 3 });
  });

  it('keep-mine resubmits the losing value based on the latest known server revision', () => {
    const resolution = resolveConflict(conflict, 'keep-mine');
    expect(resolution).toEqual({ action: 'keep-mine', strokes: 5, expectedRevision: 3 });
  });
});
