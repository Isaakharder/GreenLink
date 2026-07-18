export interface ConflictInfo {
  holeNumber: number;
  updatedByName: string | null;
  serverStrokes: number;
  serverRevision: number;
  submittedStrokes: number;
}

/**
 * "John changed Hole 7 to 4 while you were offline. You entered 5." Falls
 * back to a generic name when the update didn't come from a named profile
 * (shouldn't normally happen, but the UI must never show "null changed...").
 */
export function describeConflict(conflict: ConflictInfo): string {
  const who = conflict.updatedByName?.trim() || 'A teammate';
  return `${who} changed Hole ${conflict.holeNumber} to ${conflict.serverStrokes} while you were offline. You entered ${conflict.submittedStrokes}.`;
}

export type ConflictResolution =
  | { action: 'keep-theirs'; strokes: number; revision: number }
  | { action: 'keep-mine'; strokes: number; expectedRevision: number };

/**
 * "Keep {name}'s score" accepts the server's current value as-is (no new
 * operation needed — it's already what the server has). "Replace with my
 * score" must be based on the *latest* known server revision, not whatever
 * revision the losing submission was built on, so the resubmission has a
 * real chance of applying instead of immediately conflicting again.
 */
export function resolveConflict(conflict: ConflictInfo, choice: 'keep-theirs' | 'keep-mine'): ConflictResolution {
  if (choice === 'keep-theirs') {
    return { action: 'keep-theirs', strokes: conflict.serverStrokes, revision: conflict.serverRevision };
  }
  return { action: 'keep-mine', strokes: conflict.submittedStrokes, expectedRevision: conflict.serverRevision };
}
