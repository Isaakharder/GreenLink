import { describe, expect, it } from 'vitest';
import { classifyTeeCompatibility } from './courseImport';

describe('classifyTeeCompatibility', () => {
  it('is direct when the tee and tournament hole counts match exactly (18/18)', () => {
    expect(classifyTeeCompatibility(18, 18)).toBe('direct');
  });

  it('is direct when the tee and tournament hole counts match exactly (9/9)', () => {
    expect(classifyTeeCompatibility(9, 9)).toBe('direct');
  });

  it('needs a front/back-nine choice for an 18-hole tee on a 9-hole tournament', () => {
    expect(classifyTeeCompatibility(18, 9)).toBe('needs-nine');
  });

  it('is incompatible for a 9-hole tee on an 18-hole tournament', () => {
    expect(classifyTeeCompatibility(9, 18)).toBe('incompatible');
  });

  it('is incompatible for any other mismatch', () => {
    expect(classifyTeeCompatibility(18, 27)).toBe('incompatible');
  });
});
