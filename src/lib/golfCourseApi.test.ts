import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('./supabaseClient', () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invokeMock(...args) } },
}));

import { formatCourseLocation, formatTeeSummary, searchGolfCourses, GolfCourseSearchError, type CourseSearchResult, type ImportedCourseTee } from './golfCourseApi';

describe('formatCourseLocation', () => {
  it('joins city and state for the common case', () => {
    const result: Pick<CourseSearchResult, 'city' | 'state' | 'country'> = { city: 'Pinehurst', state: 'NC', country: 'USA' };
    expect(formatCourseLocation(result)).toBe('Pinehurst, NC');
  });

  it('falls back to country when state is missing', () => {
    expect(formatCourseLocation({ city: 'St Andrews', state: null, country: 'Scotland' })).toBe('St Andrews, Scotland');
  });

  it('handles a course with no location data at all', () => {
    expect(formatCourseLocation({ city: null, state: null, country: null })).toBe('');
  });

  it('handles state-only (no city)', () => {
    expect(formatCourseLocation({ city: null, state: 'NC', country: 'USA' })).toBe('NC');
  });
});

describe('formatTeeSummary', () => {
  const tee: ImportedCourseTee = {
    id: 't1',
    tee_name: 'Blue',
    gender: 'male',
    number_of_holes: 18,
    par_total: 72,
    course_rating: 73.6,
    slope_rating: 138,
  };

  it('includes tee name, gender, hole count, par, and rating/slope', () => {
    expect(formatTeeSummary(tee)).toBe('Blue (male) · 18 holes · par 72 · 73.6/138');
  });

  it('omits missing rating/slope/par rather than showing them as null', () => {
    expect(formatTeeSummary({ ...tee, par_total: null, course_rating: null, slope_rating: null })).toBe(
      'Blue (male) · 18 holes',
    );
  });
});

describe('searchGolfCourses error classification', () => {
  const originalOnLine = navigator.onLine;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true });
  });

  it('short-circuits to network_offline without calling the Edge Function at all when the browser is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

    await expect(searchGolfCourses('pinehurst')).rejects.toMatchObject({ kind: 'network_offline' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('surfaces the Edge Function\'s own reported kind/message verbatim (e.g. unauthorized)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const context = {
      clone: () => ({
        json: async () => ({ kind: 'unauthorized', message: 'Your session has expired. Sign in again to search for a course.' }),
      }),
    };
    invokeMock.mockResolvedValue({ data: null, error: { message: 'edge function error', context } });

    await expect(searchGolfCourses('pinehurst')).rejects.toMatchObject({
      kind: 'unauthorized',
      message: 'Your session has expired. Sign in again to search for a course.',
    });
  });

  it('classifies as function_unavailable when no parseable response came back at all', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    invokeMock.mockResolvedValue({ data: null, error: { message: 'network error', context: undefined } });

    await expect(searchGolfCourses('pinehurst')).rejects.toMatchObject({ kind: 'function_unavailable' });
  });

  it('returns real results on success', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    invokeMock.mockResolvedValue({ data: { results: [{ externalId: '1', clubName: 'Club', courseName: 'Course', city: null, state: null, country: null }] }, error: null });

    const results = await searchGolfCourses('pinehurst');
    expect(results).toHaveLength(1);
    expect(results[0].externalId).toBe('1');
  });
});

describe('GolfCourseSearchError', () => {
  it('carries its kind separately from the Error message', () => {
    const err = new GolfCourseSearchError('rate_limited', 'busy');
    expect(err.kind).toBe('rate_limited');
    expect(err.message).toBe('busy');
    expect(err).toBeInstanceOf(Error);
  });
});
