import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { CourseSearchField } from '../../components/CourseSearchField';
import {
  formatTeeSummary,
  GolfCourseSearchError,
  importGolfCourse,
  type CourseSearchResult,
  type ImportedCourseTee,
} from '../../lib/golfCourseApi';
import { WALKING_OR_CART_LABEL } from '../../lib/personalRounds';
import { useMyGolfRounds, type RecentCourse } from '../../hooks/useMyGolfRounds';
import type { WalkingOrCart } from '../../types/database';
import styles from './StartRound.module.css';

interface SelectedCourse {
  golfCourseId: string;
  courseName: string;
}

const WALKING_OR_CART_OPTIONS: WalkingOrCart[] = ['walking', 'cart'];

export function StartRound() {
  const navigate = useNavigate();
  const location = useLocation();
  const { recentCourses } = useMyGolfRounds();

  const [selectedCourse, setSelectedCourse] = useState<SelectedCourse | null>(null);
  const [availableTees, setAvailableTees] = useState<ImportedCourseTee[] | null>(null);
  const [loadingTees, setLoadingTees] = useState(false);
  const [courseError, setCourseError] = useState<string | null>(null);

  const [selectedTee, setSelectedTee] = useState<ImportedCourseTee | null>(null);
  const [holeCount, setHoleCount] = useState<number | null>(null);
  const [nine, setNine] = useState<'front' | 'back' | null>(null);
  const [walkingOrCart, setWalkingOrCart] = useState<WalkingOrCart>('walking');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Arriving from "Recent Courses" on the My Golf dashboard: skip straight
  // to the tee picker for that course instead of showing search again.
  useEffect(() => {
    const preselected = (location.state as { preselectCourse?: RecentCourse } | null)?.preselectCourse;
    if (preselected) void handleUseRecentCourse(preselected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetTeeChoice() {
    setSelectedTee(null);
    setHoleCount(null);
    setNine(null);
  }

  async function handleUseRecentCourse(course: RecentCourse) {
    setCourseError(null);
    setSelectedCourse({ golfCourseId: course.golfCourseId, courseName: course.courseName });
    setAvailableTees(null);
    resetTeeChoice();
    setLoadingTees(true);
    try {
      // Reuses the shared golf_course_tees cache directly -- no Edge
      // Function / GolfCourseAPI call needed for a course already played.
      const { data, error } = await supabase
        .from('golf_course_tees')
        .select('id, tee_name, gender, number_of_holes, par_total, course_rating, slope_rating')
        .eq('golf_course_id', course.golfCourseId);
      if (error) throw error;
      setAvailableTees((data ?? []) as ImportedCourseTee[]);
    } catch (err) {
      setCourseError(err instanceof Error ? err.message : "Couldn't load tees for this course.");
    } finally {
      setLoadingTees(false);
    }
  }

  async function handleSearchSelect(result: CourseSearchResult) {
    setCourseError(null);
    setAvailableTees(null);
    resetTeeChoice();
    setLoadingTees(true);
    try {
      const { course, tees } = await importGolfCourse(result.externalId);
      setSelectedCourse({
        golfCourseId: course.id,
        courseName: course.course_name === course.club_name ? course.club_name : `${course.club_name} — ${course.course_name}`,
      });
      setAvailableTees(tees);
    } catch (err) {
      setSelectedCourse(null);
      setCourseError(err instanceof GolfCourseSearchError ? err.message : "Something went wrong importing that course.");
    } finally {
      setLoadingTees(false);
    }
  }

  function handleChangeCourse() {
    setSelectedCourse(null);
    setAvailableTees(null);
    setCourseError(null);
    resetTeeChoice();
  }

  function handleSelectTee(tee: ImportedCourseTee) {
    setSelectedTee(tee);
    if (tee.number_of_holes === 9) {
      setHoleCount(9);
      setNine(null);
    } else {
      setHoleCount(null);
      setNine(null);
    }
  }

  function handleChooseHoles(count: 18 | 9, chosenNine: 'front' | 'back' | null) {
    setHoleCount(count);
    setNine(chosenNine);
  }

  const readyToStart = !!selectedCourse && !!selectedTee && holeCount !== null;

  async function handleStart() {
    if (!selectedCourse || !selectedTee || holeCount === null) return;
    setSubmitting(true);
    setSubmitError(null);

    const { data, error } = await supabase.rpc('start_personal_round', {
      p_course_name: selectedCourse.courseName,
      p_tournament_date: new Date().toISOString().slice(0, 10),
      p_hole_count: holeCount,
      p_tee_id: selectedTee.id,
      p_nine: nine,
      p_walking_or_cart: walkingOrCart,
    });

    setSubmitting(false);

    if (error) {
      setSubmitError(error.message);
      return;
    }

    navigate(`/my-golf/round/${data as string}`, { replace: true });
  }

  return (
    <div>
      <h1>Start Round</h1>

      {!selectedCourse && (
        <>
          {recentCourses.length > 0 && (
            <>
              <h2 className="section-title">Recent Courses</h2>
              <div className={styles.chipRow}>
                {recentCourses.map((course) => (
                  <button
                    key={course.golfCourseId}
                    type="button"
                    className={styles.chip}
                    onClick={() => void handleUseRecentCourse(course)}
                  >
                    {course.courseName}
                  </button>
                ))}
              </div>
            </>
          )}
          <h2 className="section-title">Search for a Course</h2>
          <CourseSearchField label="Course or club name" onSelect={(result) => void handleSearchSelect(result)} />
        </>
      )}

      {loadingTees && <p className="empty-state">Loading tees…</p>}
      {courseError && <p className="error-text">{courseError}</p>}

      {selectedCourse && availableTees && (
        <div className={`card ${styles.courseCard}`}>
          <div className={styles.courseHeader}>
            <strong>{selectedCourse.courseName}</strong>
            <button type="button" className="btn btn-text btn-auto" onClick={handleChangeCourse}>
              Change
            </button>
          </div>

          {availableTees.length === 0 && <p className="empty-state">No tee data available for this course.</p>}

          <h2 className="section-title">Choose a Tee</h2>
          {availableTees.map((tee) => (
            <button
              key={tee.id}
              type="button"
              className={`btn btn-secondary btn-small ${styles.teeButton}`}
              disabled={selectedTee?.id === tee.id}
              onClick={() => handleSelectTee(tee)}
            >
              {selectedTee?.id === tee.id ? '✓ ' : ''}
              {formatTeeSummary(tee)}
            </button>
          ))}

          {selectedTee && selectedTee.number_of_holes === 18 && (
            <>
              <h2 className="section-title">Holes</h2>
              <div className={styles.chipRow}>
                <button
                  type="button"
                  className={`btn btn-secondary btn-small ${holeCount === 18 ? styles.chosen : ''}`}
                  onClick={() => handleChooseHoles(18, null)}
                >
                  Play 18
                </button>
                <button
                  type="button"
                  className={`btn btn-secondary btn-small ${holeCount === 9 && nine === 'front' ? styles.chosen : ''}`}
                  onClick={() => handleChooseHoles(9, 'front')}
                >
                  Front 9
                </button>
                <button
                  type="button"
                  className={`btn btn-secondary btn-small ${holeCount === 9 && nine === 'back' ? styles.chosen : ''}`}
                  onClick={() => handleChooseHoles(9, 'back')}
                >
                  Back 9
                </button>
              </div>
            </>
          )}

          {selectedTee && (
            <>
              <h2 className="section-title">Walking or Cart</h2>
              <div className={styles.chipRow}>
                {WALKING_OR_CART_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`btn btn-secondary btn-small ${walkingOrCart === option ? styles.chosen : ''}`}
                    onClick={() => setWalkingOrCart(option)}
                  >
                    {WALKING_OR_CART_LABEL[option]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {submitError && <p className="error-text">{submitError}</p>}

      {selectedCourse && (
        <button type="button" className="btn btn-primary" disabled={!readyToStart || submitting} onClick={() => void handleStart()}>
          {submitting ? 'Starting…' : 'Start Round'}
        </button>
      )}
    </div>
  );
}
