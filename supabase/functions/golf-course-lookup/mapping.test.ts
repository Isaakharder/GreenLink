import { describe, expect, it } from 'vitest';
import {
  countUsableTees,
  flattenTees,
  fromLocalCourseSearchRow,
  hasUsableTees,
  isTeeUsable,
  mergeCourseSearchResults,
  scorecardStatusFromSearchResult,
  toGolfCourseRow,
  toGolfCourseTeeHoleRows,
  toGolfCourseTeeRow,
  toSearchSummary,
  type CourseSearchSummary,
  type GolfCourseApiCourseDetail,
  type GolfCourseApiSearchResult,
  type GolfCourseApiTee,
  type LocalCourseSearchRow,
} from './mapping';

const eighteenHoleTee: GolfCourseApiTee = {
  tee_name: 'Blue',
  course_rating: 73.6,
  slope_rating: 138,
  par_total: 72,
  number_of_holes: 18,
  holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, yardage: 380 + i, handicap: i + 1 })),
};

const nineHoleTee: GolfCourseApiTee = {
  tee_name: 'White',
  course_rating: 35.2,
  slope_rating: 120,
  par_total: 36,
  number_of_holes: 9,
  holes: Array.from({ length: 9 }, (_, i) => ({ par: 4, yardage: 350 + i, handicap: i + 1 })),
};

describe('toSearchSummary', () => {
  it('maps id/club_name/course_name/location into a display summary', () => {
    const summary = toSearchSummary({
      id: 42,
      club_name: 'Pinehurst Resort',
      course_name: 'Pinehurst No. 2',
      location: { city: 'Pinehurst', state: 'NC', country: 'USA' },
    });
    expect(summary).toEqual({
      externalId: '42',
      clubName: 'Pinehurst Resort',
      courseName: 'Pinehurst No. 2',
      city: 'Pinehurst',
      state: 'NC',
      country: 'USA',
      scorecardStatus: 'unknown',
      source: 'golfcourseapi',
      courseId: null,
      externalProvider: 'golfcourseapi',
      usableTeeCount: 0,
    });
  });

  it('falls back to null location fields when missing, rather than throwing', () => {
    const summary = toSearchSummary({ id: 'abc', club_name: 'Some Club', course_name: 'Some Course' });
    expect(summary.city).toBeNull();
    expect(summary.state).toBeNull();
    expect(summary.country).toBeNull();
  });

  it('never carries a courseId -- a fresh API result has no GreenLink row until imported', () => {
    expect(toSearchSummary({ id: 42, club_name: 'Club', course_name: 'Course' }).courseId).toBeNull();
  });

  it('counts only genuinely usable tees, not every tee present', () => {
    const summary = toSearchSummary({
      id: 1,
      club_name: 'Club',
      course_name: 'Course',
      tees: { male: [eighteenHoleTee, { ...eighteenHoleTee, holes: [] }], female: [eighteenHoleTee] },
    });
    expect(summary.usableTeeCount).toBe(2);
    expect(summary.scorecardStatus).toBe('usable');
  });
});

describe('countUsableTees', () => {
  it('is 0 when tees is entirely absent', () => {
    expect(countUsableTees(undefined)).toBe(0);
    expect(countUsableTees(null)).toBe(0);
  });

  it('counts usable male and female tees together', () => {
    expect(countUsableTees({ male: [eighteenHoleTee], female: [eighteenHoleTee, nineHoleTee] })).toBe(3);
  });

  it('excludes an unusable tee from the count without zeroing out the usable ones', () => {
    expect(countUsableTees({ male: [eighteenHoleTee, { ...eighteenHoleTee, holes: [] }] })).toBe(1);
  });
});

describe('toGolfCourseRow', () => {
  it('maps a course detail into the golf_courses row shape, keeping the raw payload', () => {
    const detail: GolfCourseApiCourseDetail = {
      id: 42,
      club_name: 'Pinehurst Resort',
      course_name: 'Pinehurst No. 2',
      location: { address: '1 Carolina Vista Dr', city: 'Pinehurst', state: 'NC', country: 'USA' },
    };
    const row = toGolfCourseRow(detail);
    expect(row.external_id).toBe('42');
    expect(row.address).toBe('1 Carolina Vista Dr');
    expect(row.raw_payload).toBe(detail);
  });
});

describe('isTeeUsable', () => {
  it('accepts a fully-scored 18-hole tee', () => {
    expect(isTeeUsable(eighteenHoleTee)).toBe(true);
  });

  it('accepts a fully-scored 9-hole tee', () => {
    expect(isTeeUsable(nineHoleTee)).toBe(true);
  });

  it('accepts a tee with null rating/slope/par_total as long as every hole has a real par', () => {
    const tee: GolfCourseApiTee = { ...eighteenHoleTee, course_rating: null, slope_rating: null, par_total: null };
    expect(isTeeUsable(tee)).toBe(true);
  });

  it('rejects a tee with zero holes (e.g. GolfCourseAPI returned an empty holes array)', () => {
    expect(isTeeUsable({ ...eighteenHoleTee, holes: [] })).toBe(false);
  });

  it('rejects a tee whose hole count is neither 9 nor 18', () => {
    expect(isTeeUsable({ ...eighteenHoleTee, holes: eighteenHoleTee.holes.slice(0, 14) })).toBe(false);
  });

  it('rejects a tee where any hole is missing a real par', () => {
    const holesWithNullPar = eighteenHoleTee.holes.map((hole, i) =>
      i === 5 ? { ...hole, par: null as unknown as number } : hole,
    );
    expect(isTeeUsable({ ...eighteenHoleTee, holes: holesWithNullPar })).toBe(false);
  });

  it('rejects a tee where a hole has a zero or negative par', () => {
    const holesWithZeroPar = eighteenHoleTee.holes.map((hole, i) => (i === 0 ? { ...hole, par: 0 } : hole));
    expect(isTeeUsable({ ...eighteenHoleTee, holes: holesWithZeroPar })).toBe(false);
  });
});

describe('hasUsableTees', () => {
  it('is true when only male tees are usable (female-tee-less course)', () => {
    expect(hasUsableTees({ male: [eighteenHoleTee] })).toBe(true);
  });

  it('is true when only female tees are usable (male-tee-less course)', () => {
    expect(hasUsableTees({ female: [eighteenHoleTee] })).toBe(true);
  });

  it('is false for the Deer Run Golf Club "Buck/Doe" shape confirmed against production: tees is an empty object', () => {
    // Real cached raw_payload for external_id 5747 (verified live against
    // GolfCourseAPI during this investigation): `"tees": {}` -- no male key,
    // no female key at all.
    expect(hasUsableTees({})).toBe(false);
  });

  it('is false when tees is entirely absent', () => {
    expect(hasUsableTees(undefined)).toBe(false);
    expect(hasUsableTees(null)).toBe(false);
  });

  it('is false when every tee present has no usable holes', () => {
    expect(hasUsableTees({ male: [{ ...eighteenHoleTee, holes: [] }] })).toBe(false);
  });
});

describe('scorecardStatusFromSearchResult', () => {
  const base: GolfCourseApiSearchResult = { id: 1, club_name: 'Club', course_name: 'Course' };

  it('is "unknown" when the search result carries no tees field at all (defensive default)', () => {
    expect(scorecardStatusFromSearchResult(base)).toBe('unknown');
  });

  it('is "usable" when the search result includes at least one usable tee', () => {
    expect(scorecardStatusFromSearchResult({ ...base, tees: { male: [eighteenHoleTee] } })).toBe('usable');
  });

  it('is "unusable" when the search result explicitly has an empty tees object', () => {
    expect(scorecardStatusFromSearchResult({ ...base, tees: {} })).toBe('unusable');
  });
});

describe('flattenTees', () => {
  it('tags male and female tees with their gender and combines them into one list', () => {
    const detail: GolfCourseApiCourseDetail = {
      id: 1,
      club_name: 'Club',
      course_name: 'Course',
      tees: {
        male: [eighteenHoleTee],
        female: [{ ...eighteenHoleTee, tee_name: 'Red' }],
      },
    };
    const flattened = flattenTees(detail);
    expect(flattened).toHaveLength(2);
    expect(flattened[0]).toEqual({ gender: 'male', tee: eighteenHoleTee });
    expect(flattened[1].gender).toBe('female');
  });

  it('keeps a male-only course usable', () => {
    const detail: GolfCourseApiCourseDetail = { id: 1, club_name: 'Club', course_name: 'Course', tees: { male: [eighteenHoleTee] } };
    expect(flattenTees(detail)).toHaveLength(1);
  });

  it('keeps a female-only course usable', () => {
    const detail: GolfCourseApiCourseDetail = { id: 1, club_name: 'Club', course_name: 'Course', tees: { female: [eighteenHoleTee] } };
    const flattened = flattenTees(detail);
    expect(flattened).toHaveLength(1);
    expect(flattened[0].gender).toBe('female');
  });

  it('keeps a tee with null rating/slope as long as its holes have real pars -- optional fields are never a reason to drop real data', () => {
    const tee: GolfCourseApiTee = { ...eighteenHoleTee, course_rating: null, slope_rating: null, par_total: null };
    const detail: GolfCourseApiCourseDetail = { id: 1, club_name: 'Club', course_name: 'Course', tees: { male: [tee] } };
    expect(flattenTees(detail)).toHaveLength(1);
  });

  it('drops tees whose hole count is neither 9 nor 18 instead of failing the whole import', () => {
    const malformedTee: GolfCourseApiTee = { ...eighteenHoleTee, holes: eighteenHoleTee.holes.slice(0, 14) };
    const detail: GolfCourseApiCourseDetail = {
      id: 1,
      club_name: 'Club',
      course_name: 'Course',
      tees: { male: [eighteenHoleTee, malformedTee] },
    };
    expect(flattenTees(detail)).toHaveLength(1);
  });

  it('drops a tee that has tee metadata but a zero-length holes array (tees present, no holes)', () => {
    const detail: GolfCourseApiCourseDetail = {
      id: 1,
      club_name: 'Club',
      course_name: 'Course',
      tees: { male: [{ ...eighteenHoleTee, holes: [] }] },
    };
    expect(flattenTees(detail)).toEqual([]);
  });

  it('handles a course with no tees at all', () => {
    expect(flattenTees({ id: 1, club_name: 'Club', course_name: 'Course' })).toEqual([]);
  });

  it('handles the real Deer Run Golf Club "Buck/Doe" shape: tees present as an empty object, not null/undefined', () => {
    const detail: GolfCourseApiCourseDetail = {
      id: 5747,
      club_name: 'Deer Run Golf Club',
      course_name: 'Buck/Doe',
      location: { city: 'Blenheim', state: 'ON', country: 'Canada' },
      tees: {},
    };
    expect(flattenTees(detail)).toEqual([]);
  });

  it('never invents a tee or hole that was not present in the input', () => {
    const detail: GolfCourseApiCourseDetail = { id: 1, club_name: 'Club', course_name: 'Course', tees: { male: [eighteenHoleTee] } };
    const flattened = flattenTees(detail);
    expect(flattened).toHaveLength(1);
    expect(flattened[0].tee.holes).toHaveLength(18);
    expect(flattened[0].tee.holes).toEqual(eighteenHoleTee.holes);
  });
});

describe('toGolfCourseTeeRow', () => {
  it('derives number_of_holes from the holes array length', () => {
    const row = toGolfCourseTeeRow({ gender: 'male', tee: eighteenHoleTee });
    expect(row).toEqual({
      tee_name: 'Blue',
      gender: 'male',
      number_of_holes: 18,
      par_total: 72,
      course_rating: 73.6,
      slope_rating: 138,
    });
  });
});

describe('toGolfCourseTeeHoleRows', () => {
  it('numbers holes 1..N by array position', () => {
    const rows = toGolfCourseTeeHoleRows(eighteenHoleTee);
    expect(rows).toHaveLength(18);
    expect(rows[0]).toEqual({ hole_number: 1, par: 4, yardage: 380, handicap: 1 });
    expect(rows[17]).toEqual({ hole_number: 18, par: 4, yardage: 397, handicap: 18 });
  });
});

const localRow: LocalCourseSearchRow = {
  id: 'course-1',
  external_id: 'manual-course-1',
  club_name: 'Deer Run Golf Club',
  course_name: 'Buck/Doe',
  city: 'Blenheim',
  state: 'ON',
  country: 'Canada',
  source: 'manual',
  has_usable_tee: true,
  usable_tee_count: 2,
};

describe('fromLocalCourseSearchRow', () => {
  it('maps a search_courses() row into the shared CourseSearchSummary shape', () => {
    expect(fromLocalCourseSearchRow(localRow)).toEqual({
      externalId: 'manual-course-1',
      clubName: 'Deer Run Golf Club',
      courseName: 'Buck/Doe',
      city: 'Blenheim',
      state: 'ON',
      country: 'Canada',
      scorecardStatus: 'usable',
      source: 'manual',
      courseId: 'course-1',
      externalProvider: null,
      usableTeeCount: 2,
    });
  });

  it('maps usable_tee_count = 0 to scorecardStatus unusable, independent of has_usable_tee', () => {
    expect(fromLocalCourseSearchRow({ ...localRow, has_usable_tee: false, usable_tee_count: 0 }).scorecardStatus).toBe('unusable');
  });

  it('maps source "imported" through unchanged', () => {
    expect(fromLocalCourseSearchRow({ ...localRow, source: 'imported' }).source).toBe('imported');
  });

  it('maps source "golfcourseapi" through unchanged (a previously-cached GolfCourseAPI import), unlike the old behavior that collapsed it into "manual"', () => {
    const cached = fromLocalCourseSearchRow({ ...localRow, source: 'golfcourseapi', external_id: '25562' });
    expect(cached.source).toBe('golfcourseapi');
    expect(cached.externalProvider).toBe('golfcourseapi');
    expect(cached.courseId).toBe('course-1');
  });

  it('gives a manual/imported row no external provider', () => {
    expect(fromLocalCourseSearchRow(localRow).externalProvider).toBeNull();
  });
});

describe('mergeCourseSearchResults', () => {
  const local: CourseSearchSummary = {
    externalId: 'manual-1',
    clubName: 'Deer Run Golf Club',
    courseName: 'Buck/Doe',
    city: 'Blenheim',
    state: 'ON',
    country: 'Canada',
    scorecardStatus: 'usable',
    source: 'manual',
    courseId: 'course-1',
    externalProvider: null,
    usableTeeCount: 2,
  };

  it('ranks local GreenLink results ahead of GolfCourseAPI results', () => {
    const api: CourseSearchSummary = { ...local, externalId: 'api-1', source: 'golfcourseapi', courseId: null, externalProvider: 'golfcourseapi', clubName: 'Some Other Club' };
    const merged = mergeCourseSearchResults([local], [api]);
    expect(merged[0]).toBe(local);
    expect(merged[1]).toBe(api);
  });

  it('drops an API duplicate when it has no usable tees and a local record already covers the same course (prefer the complete GreenLink record)', () => {
    const incompleteApiDuplicate: CourseSearchSummary = {
      ...local,
      externalId: 'api-1',
      source: 'golfcourseapi',
      courseId: null,
      externalProvider: 'golfcourseapi',
      scorecardStatus: 'unusable',
      usableTeeCount: 0,
    };
    const merged = mergeCourseSearchResults([local], [incompleteApiDuplicate]);
    expect(merged).toEqual([local]);
  });

  it('keeps both when the API duplicate is also usable -- never silently merges, just lets the source label distinguish them', () => {
    const usableApiDuplicate: CourseSearchSummary = { ...local, externalId: 'api-1', source: 'golfcourseapi', courseId: null, externalProvider: 'golfcourseapi' };
    const merged = mergeCourseSearchResults([local], [usableApiDuplicate]);
    expect(merged).toHaveLength(2);
    expect(merged.map((c) => c.source)).toEqual(['manual', 'golfcourseapi']);
  });

  it('matches duplicates case-insensitively and ignoring surrounding whitespace, but only on an exact club+course name pair', () => {
    const sameCourseDifferentCase: CourseSearchSummary = {
      ...local,
      externalId: 'api-1',
      source: 'golfcourseapi',
      courseId: null,
      externalProvider: 'golfcourseapi',
      scorecardStatus: 'unusable',
      usableTeeCount: 0,
      clubName: '  deer run golf club  ',
      courseName: 'BUCK/DOE',
    };
    expect(mergeCourseSearchResults([local], [sameCourseDifferentCase])).toEqual([local]);
  });

  it('never merges a merely-similar course name -- an unreliable match keeps both results', () => {
    const similarButDifferentCourse: CourseSearchSummary = {
      ...local,
      externalId: 'api-1',
      source: 'golfcourseapi',
      courseId: null,
      externalProvider: 'golfcourseapi',
      scorecardStatus: 'unusable',
      usableTeeCount: 0,
      courseName: 'Doe/Fawn', // a real, distinct sibling layout at the same club (see investigation)
    };
    const merged = mergeCourseSearchResults([local], [similarButDifferentCourse]);
    expect(merged).toHaveLength(2);
  });

  it('keeps every API result when there is no local course at all', () => {
    const api: CourseSearchSummary = { ...local, externalId: 'api-1', source: 'golfcourseapi', courseId: null, externalProvider: 'golfcourseapi', scorecardStatus: 'unusable', usableTeeCount: 0, clubName: 'Unrelated Club' };
    expect(mergeCourseSearchResults([], [api])).toEqual([api]);
  });

  // --- Regression coverage for the Orchard View Golf Club production incident ---

  const orchardViewComplete: CourseSearchSummary = {
    externalId: '25562',
    clubName: 'Orchard View Golf Club',
    courseName: 'Orchard View Golf Club',
    city: null,
    state: null,
    country: null,
    scorecardStatus: 'usable',
    source: 'golfcourseapi',
    courseId: 'orchard-view-course-id',
    externalProvider: 'golfcourseapi',
    usableTeeCount: 6,
  };

  it('never drops a complete, already-cached GolfCourseAPI course (has courseId) -- the exact incident this merge logic exists to prevent', () => {
    const brokenDuplicateListing: CourseSearchSummary = {
      externalId: 'zcvtyq4k',
      clubName: 'Orchard View Golf Club',
      courseName: 'Orchard View Golf Club (Old)',
      city: null,
      state: null,
      country: null,
      scorecardStatus: 'unusable',
      source: 'golfcourseapi',
      courseId: null,
      externalProvider: 'golfcourseapi',
      usableTeeCount: 0,
    };
    const merged = mergeCourseSearchResults([orchardViewComplete], [brokenDuplicateListing]);
    // Different course_name ("Orchard View Golf Club (Old)" vs "Orchard View
    // Golf Club") means this is NOT an exact-name duplicate -- both are
    // shown, but the complete, already-known course is first and carries
    // its identity (courseId) so selecting it never needs GolfCourseAPI.
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(orchardViewComplete);
    expect(merged[0].courseId).not.toBeNull();
    expect(merged[0].usableTeeCount).toBeGreaterThan(0);
  });

  it('drops an API result that is an exact identity duplicate (same external_id) of a local result, regardless of usability', () => {
    const sameRowRefetched: CourseSearchSummary = {
      ...orchardViewComplete,
      courseId: null,
      scorecardStatus: 'unusable',
      usableTeeCount: 0,
    };
    const merged = mergeCourseSearchResults([orchardViewComplete], [sameRowRefetched]);
    expect(merged).toEqual([orchardViewComplete]);
  });

  it('would still (correctly) merge away an exact-name incomplete duplicate of the complete Orchard View record', () => {
    const exactNameIncompleteDuplicate: CourseSearchSummary = {
      ...orchardViewComplete,
      externalId: 'some-other-id',
      courseId: null,
      scorecardStatus: 'unusable',
      usableTeeCount: 0,
    };
    const merged = mergeCourseSearchResults([orchardViewComplete], [exactNameIncompleteDuplicate]);
    expect(merged).toEqual([orchardViewComplete]);
  });
});
