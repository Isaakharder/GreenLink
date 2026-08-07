import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { CourseSearchField } from '../../components/CourseSearchField';
import {
  formatTeeSummary,
  GolfCourseSearchError,
  hasUsableTee,
  importGolfCourse,
  isKnownUnusable,
  markCourseUnusable,
  type CourseSearchResult,
  type CourseSearchSource,
  type ImportedCourseTee,
} from '../../lib/golfCourseApi';
import { createManualCourse, fetchManualCourseTees, type ManualTeeInput } from '../../lib/courseLibrary';
import { WALKING_OR_CART_LABEL } from '../../lib/personalRounds';
import { useMyGolfRounds, type RecentCourse } from '../../hooks/useMyGolfRounds';
import type { GolfCourseTeeGender, WalkingOrCart } from '../../types/database';
import styles from './StartRound.module.css';

interface SelectedCourse {
  golfCourseId: string | null;
  courseName: string;
  /** Separate club/layout name as returned by search, only present when this
   * course came from a search result -- used to prefill the manual-entry
   * "save to library" path without trying to re-split the composed display
   * string above. Absent for Recent Courses (never routes through manual entry). */
  rawClubName?: string;
  rawLayoutName?: string;
  /** Preserved from the exact search result tapped, not re-derived from courseName -- absent for Recent Courses, which already identify a course by golfCourseId and have no ambiguity to preserve. */
  source?: CourseSearchSource;
}

interface ManualHoleRow {
  holeNumber: number;
  par: number | '';
  yardage: number | '';
}

const WALKING_OR_CART_OPTIONS: WalkingOrCart[] = ['walking', 'cart'];

function buildManualRows(holeCount: 9 | 18): ManualHoleRow[] {
  return Array.from({ length: holeCount }, (_, index) => ({ holeNumber: index + 1, par: '', yardage: '' }));
}

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

  const [manualEntry, setManualEntry] = useState(false);
  const [manualTeeName, setManualTeeName] = useState('');
  const [manualGender, setManualGender] = useState<GolfCourseTeeGender>('unisex');
  const [manualHoleCount, setManualHoleCount] = useState<9 | 18>(18);
  const [manualRows, setManualRows] = useState<ManualHoleRow[]>([]);
  const [manualRating, setManualRating] = useState('');
  const [manualSlope, setManualSlope] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

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
    setManualEntry(false);
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
      // archived_at is null: a tee superseded by an edit since this course
      // was last played must not be re-offered -- only its current
      // replacement (if any) should be selectable.
      const { data, error } = await supabase
        .from('golf_course_tees')
        .select('id, tee_name, gender, number_of_holes, par_total, course_rating, slope_rating')
        .eq('golf_course_id', course.golfCourseId)
        .is('archived_at', null);
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

    const composedName =
      result.courseName === result.clubName ? result.clubName : `${result.clubName} — ${result.courseName}`;

    // A course already confirmed unusable this session (or already flagged
    // unusable by the search result itself) doesn't need another network
    // round trip -- go straight to the no-scorecard screen.
    if (result.scorecardStatus === 'unusable' || isKnownUnusable(result.externalId)) {
      setSelectedCourse({ golfCourseId: result.courseId, courseName: composedName, rawClubName: result.clubName, rawLayoutName: result.courseName, source: result.source });
      setAvailableTees([]);
      return;
    }

    setLoadingTees(true);
    try {
      const { course, tees } = await importGolfCourse(result.externalId);
      setSelectedCourse({ golfCourseId: course.id, courseName: composedName, rawClubName: result.clubName, rawLayoutName: result.courseName, source: result.source });
      setAvailableTees(tees);
      if (!hasUsableTee(tees)) markCourseUnusable(result.externalId);
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
    if (selectedTee?.id === tee.id) return;
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

  function handleEnterManualEntry() {
    setManualEntry(true);
    setManualTeeName('');
    setManualGender('unisex');
    setManualHoleCount(18);
    setManualRows(buildManualRows(18));
    setManualRating('');
    setManualSlope('');
    setManualError(null);
    setSubmitError(null);
  }

  function handleManualHoleCountChange(count: 9 | 18) {
    setManualHoleCount(count);
    setManualRows(buildManualRows(count));
  }

  function updateManualRow(holeNumber: number, patch: Partial<ManualHoleRow>) {
    setManualRows((prev) => prev.map((row) => (row.holeNumber === holeNumber ? { ...row, ...patch } : row)));
  }

  const scorecardUnusable = !manualEntry && availableTees !== null && availableTees.length === 0;
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
      console.error('start_personal_round failed', error);
      setSubmitError("We couldn't start your round. Please try again.");
      return;
    }

    navigate(`/my-golf/round/${data as string}`, { replace: true });
  }

  function validateManualEntry(): string | null {
    if (manualRows.some((row) => row.par === '')) return 'Enter a par for every hole before starting.';
    return null;
  }

  /** "Use for This Round Only": the round-only fallback -- unchanged from before the course library existed. Nothing is saved for future rounds. */
  async function handleStartManualRoundOnly() {
    if (!selectedCourse) return;
    const validationError = validateManualEntry();
    if (validationError) {
      setManualError(validationError);
      return;
    }
    setManualError(null);
    setSubmitting(true);
    setSubmitError(null);

    const manualHoles = manualRows.map((row) => ({
      hole_number: row.holeNumber,
      par: row.par,
      distance: row.yardage === '' ? null : row.yardage,
    }));
    const trimmedTeeName = manualTeeName.trim();
    const courseName = trimmedTeeName ? `${selectedCourse.courseName} (${trimmedTeeName})` : selectedCourse.courseName;
    const courseRating = manualRating.trim() === '' ? null : Number(manualRating);
    const slopeRating = manualSlope.trim() === '' ? null : Number(manualSlope);

    const { data, error } = await supabase.rpc('start_personal_round', {
      p_course_name: courseName,
      p_tournament_date: new Date().toISOString().slice(0, 10),
      p_hole_count: manualHoleCount,
      p_walking_or_cart: walkingOrCart,
      p_manual_holes: manualHoles,
      p_course_rating: courseRating,
      p_slope_rating: slopeRating,
    });

    setSubmitting(false);

    if (error) {
      console.error('start_personal_round (manual) failed', error);
      setSubmitError("We couldn't start your round. Please try again.");
      return;
    }

    navigate(`/my-golf/round/${data as string}`, { replace: true });
  }

  /**
   * "Save to GreenLink Course Library": publishes the entered scorecard as a
   * real, reusable manual course (create_manual_course()), then starts the
   * round through the exact same p_tee_id path an imported course already
   * uses -- never p_manual_holes for this branch, so the round and the
   * library record are backed by the identical golf_course_tees row.
   */
  async function handleStartManualSaved() {
    if (!selectedCourse) return;
    const validationError = validateManualEntry();
    if (validationError) {
      setManualError(validationError);
      return;
    }
    if (manualTeeName.trim() === '') {
      setManualError('Enter a tee name before saving to the course library.');
      return;
    }
    setManualError(null);
    setSubmitting(true);
    setSubmitError(null);

    try {
      const teeInput: ManualTeeInput = {
        tee_name: manualTeeName.trim(),
        gender: manualGender,
        course_rating: manualRating.trim() === '' ? null : Number(manualRating),
        slope_rating: manualSlope.trim() === '' ? null : Number(manualSlope),
        holes: manualRows.map((row) => ({
          hole_number: row.holeNumber,
          par: row.par === '' ? 0 : row.par,
          yardage: row.yardage === '' ? null : row.yardage,
        })),
      };

      const courseId = await createManualCourse(
        {
          clubName: selectedCourse.rawClubName ?? selectedCourse.courseName,
          courseName: selectedCourse.rawLayoutName ?? manualTeeName.trim(),
        },
        [teeInput],
      );
      const savedTees = await fetchManualCourseTees(courseId);
      const savedTee = savedTees[0];
      if (!savedTee) throw new Error('The course was saved but its tee could not be found.');

      const { data, error } = await supabase.rpc('start_personal_round', {
        p_course_name: selectedCourse.courseName,
        p_tournament_date: new Date().toISOString().slice(0, 10),
        p_hole_count: manualHoleCount,
        p_tee_id: savedTee.id,
        p_nine: null,
        p_walking_or_cart: walkingOrCart,
      });

      if (error) throw error;

      navigate(`/my-golf/round/${data as string}`, { replace: true });
    } catch (err) {
      console.error('save-to-library manual round failed', err);
      setSubmitError("We couldn't start your round. Please try again.");
    } finally {
      setSubmitting(false);
    }
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

      {selectedCourse && availableTees && scorecardUnusable && (
        <div className={`card ${styles.courseCard}`}>
          <div className={styles.courseHeader}>
            <strong>{selectedCourse.courseName}</strong>
          </div>
          <p className="empty-state">No complete scorecard was provided for this course.</p>
          <button type="button" className="btn btn-secondary" onClick={handleEnterManualEntry}>
            Enter Scorecard Manually
          </button>
          <button type="button" className="btn btn-text btn-auto" onClick={handleChangeCourse}>
            Choose Another Course
          </button>
        </div>
      )}

      {selectedCourse && manualEntry && (
        <div className={`card ${styles.courseCard}`}>
          <div className={styles.courseHeader}>
            <strong>{selectedCourse.courseName}</strong>
            <button type="button" className="btn btn-text btn-auto" onClick={handleChangeCourse}>
              Change
            </button>
          </div>

          <h2 className="section-title">Enter Scorecard Manually</h2>
          <div className="field">
            <label htmlFor="manualTeeName">Tee name</label>
            <input id="manualTeeName" value={manualTeeName} onChange={(event) => setManualTeeName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="manualGender">Tee gender</label>
            <select id="manualGender" value={manualGender} onChange={(event) => setManualGender(event.target.value as GolfCourseTeeGender)}>
              <option value="unisex">Unisex</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="manualHoleCount">Holes</label>
            <select
              id="manualHoleCount"
              value={manualHoleCount}
              onChange={(event) => handleManualHoleCountChange(Number(event.target.value) as 9 | 18)}
            >
              <option value={9}>9</option>
              <option value={18}>18</option>
            </select>
          </div>

          {manualRows.map((row) => (
            <div key={row.holeNumber} className={styles.manualHoleRow}>
              <span className={styles.manualHoleNumber}>Hole {row.holeNumber}</span>
              <div className="field">
                <label htmlFor={`manual-par-${row.holeNumber}`}>Par</label>
                <input
                  id={`manual-par-${row.holeNumber}`}
                  type="number"
                  min={3}
                  max={6}
                  value={row.par}
                  onChange={(event) =>
                    updateManualRow(row.holeNumber, { par: event.target.value === '' ? '' : Number(event.target.value) })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor={`manual-yardage-${row.holeNumber}`}>Yardage (optional)</label>
                <input
                  id={`manual-yardage-${row.holeNumber}`}
                  type="number"
                  min={0}
                  value={row.yardage}
                  onChange={(event) =>
                    updateManualRow(row.holeNumber, { yardage: event.target.value === '' ? '' : Number(event.target.value) })
                  }
                />
              </div>
            </div>
          ))}

          <div className="field">
            <label htmlFor="manualRating">Course rating (optional)</label>
            <input id="manualRating" type="number" step="0.1" value={manualRating} onChange={(event) => setManualRating(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="manualSlope">Slope rating (optional)</label>
            <input id="manualSlope" type="number" value={manualSlope} onChange={(event) => setManualSlope(event.target.value)} />
          </div>

          {manualError && <p className="error-text">{manualError}</p>}
        </div>
      )}

      {selectedCourse && availableTees && !scorecardUnusable && !manualEntry && (
        <div className={`card ${styles.courseCard}`}>
          <div className={styles.courseHeader}>
            <strong>{selectedCourse.courseName}</strong>
            <button type="button" className="btn btn-text btn-auto" onClick={handleChangeCourse}>
              Change
            </button>
          </div>

          <h2 className="section-title">Choose a Tee</h2>
          <div role="radiogroup" aria-label="Choose a tee">
            {availableTees.map((tee) => {
              const isSelected = selectedTee?.id === tee.id;
              return (
                <button
                  key={tee.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`btn btn-secondary btn-small ${styles.teeButton} ${isSelected ? styles.chosen : ''}`}
                  onClick={() => handleSelectTee(tee)}
                >
                  {isSelected ? '✓ ' : ''}
                  {formatTeeSummary(tee)}
                </button>
              );
            })}
          </div>

          {selectedTee && selectedTee.number_of_holes === 18 && (
            <>
              <h2 className="section-title">Holes</h2>
              <div className={styles.chipRow} role="radiogroup" aria-label="Holes">
                <button
                  type="button"
                  role="radio"
                  aria-checked={holeCount === 18}
                  className={`btn btn-secondary btn-small ${holeCount === 18 ? styles.chosen : ''}`}
                  onClick={() => handleChooseHoles(18, null)}
                >
                  {holeCount === 18 ? '✓ ' : ''}
                  Play 18
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={holeCount === 9 && nine === 'front'}
                  className={`btn btn-secondary btn-small ${holeCount === 9 && nine === 'front' ? styles.chosen : ''}`}
                  onClick={() => handleChooseHoles(9, 'front')}
                >
                  {holeCount === 9 && nine === 'front' ? '✓ ' : ''}
                  Front 9
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={holeCount === 9 && nine === 'back'}
                  className={`btn btn-secondary btn-small ${holeCount === 9 && nine === 'back' ? styles.chosen : ''}`}
                  onClick={() => handleChooseHoles(9, 'back')}
                >
                  {holeCount === 9 && nine === 'back' ? '✓ ' : ''}
                  Back 9
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {selectedCourse && (selectedTee || manualEntry) && (
        <div className={`card ${styles.courseCard}`}>
          <h2 className="section-title">Walking or Cart</h2>
          <div className={styles.chipRow} role="radiogroup" aria-label="Walking or cart">
            {WALKING_OR_CART_OPTIONS.map((option) => {
              const isSelected = walkingOrCart === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`btn btn-secondary btn-small ${isSelected ? styles.chosen : ''}`}
                  onClick={() => setWalkingOrCart(option)}
                >
                  {isSelected ? '✓ ' : ''}
                  {WALKING_OR_CART_LABEL[option]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {submitError && <p className="error-text">{submitError}</p>}

      {selectedCourse && manualEntry && (
        <>
          {/* Saving is the default, emphasized action -- this scorecard is
              worth reusing for next time unless the user says otherwise. */}
          <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void handleStartManualSaved()}>
            {submitting ? 'Starting…' : 'Save to GreenLink Course Library & Start Round'}
          </button>
          <button type="button" className="btn btn-secondary" disabled={submitting} onClick={() => void handleStartManualRoundOnly()}>
            Use for This Round Only
          </button>
        </>
      )}

      {selectedCourse && !manualEntry && !scorecardUnusable && (
        <button type="button" className="btn btn-primary" disabled={!readyToStart || submitting} onClick={() => void handleStart()}>
          {submitting ? 'Starting…' : 'Start Round'}
        </button>
      )}
    </div>
  );
}
