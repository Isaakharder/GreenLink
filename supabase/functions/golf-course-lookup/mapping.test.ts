import { describe, expect, it } from 'vitest';
import {
  flattenTees,
  toGolfCourseRow,
  toGolfCourseTeeHoleRows,
  toGolfCourseTeeRow,
  toSearchSummary,
  type GolfCourseApiCourseDetail,
  type GolfCourseApiTee,
} from './mapping';

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
    });
  });

  it('falls back to null location fields when missing, rather than throwing', () => {
    const summary = toSearchSummary({ id: 'abc', club_name: 'Some Club', course_name: 'Some Course' });
    expect(summary.city).toBeNull();
    expect(summary.state).toBeNull();
    expect(summary.country).toBeNull();
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

const eighteenHoleTee: GolfCourseApiTee = {
  tee_name: 'Blue',
  course_rating: 73.6,
  slope_rating: 138,
  par_total: 72,
  number_of_holes: 18,
  holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, yardage: 380 + i, handicap: i + 1 })),
};

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

  it('handles a course with no tees at all', () => {
    expect(flattenTees({ id: 1, club_name: 'Club', course_name: 'Course' })).toEqual([]);
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
