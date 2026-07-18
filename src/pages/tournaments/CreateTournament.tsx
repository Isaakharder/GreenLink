import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { DEFAULT_SCORING_FORMAT, SCORING_FORMATS, TEAM_SIZE_OPTIONS } from '../../lib/constants';
import { CourseSearchField } from '../../components/CourseSearchField';
import { classifyTeeCompatibility } from '../../lib/courseImport';
import {
  formatTeeSummary,
  GolfCourseSearchError,
  importGolfCourse,
  type CourseSearchResult,
  type ImportedCourseTee,
} from '../../lib/golfCourseApi';
import styles from './CreateTournament.module.css';

interface SelectedCourse {
  externalId: string;
  clubName: string;
  courseName: string;
}

export function CreateTournament() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [courseName, setCourseName] = useState('');
  const [tournamentDate, setTournamentDate] = useState('');
  const [holeCount, setHoleCount] = useState(18);
  const [scoringFormat, setScoringFormat] = useState<string>(DEFAULT_SCORING_FORMAT);
  const [teamSize, setTeamSize] = useState<number>(TEAM_SIZE_OPTIONS[0]);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Selecting a search result stores the external course id and imports it
  // (caches golf_courses/golf_course_tees/golf_course_tee_holes) so a tee
  // list can be shown -- selecting a name alone is never treated as a
  // completed import. Only choosing a tee (selectedTeeId) completes it.
  const [selectedCourse, setSelectedCourse] = useState<SelectedCourse | null>(null);
  const [availableTees, setAvailableTees] = useState<ImportedCourseTee[] | null>(null);
  const [importingCourse, setImportingCourse] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedTeeId, setSelectedTeeId] = useState<string | null>(null);
  const [selectedNine, setSelectedNine] = useState<'front' | 'back' | null>(null);
  const [pendingNineTeeId, setPendingNineTeeId] = useState<string | null>(null);

  // Changing the hole count can invalidate a tee choice made under a
  // different count (e.g. picked "front 9" of an 18-hole tee, then switched
  // to 18 holes) -- clear it and make the organizer re-confirm rather than
  // silently submitting a stale/mismatched choice.
  useEffect(() => {
    setSelectedTeeId(null);
    setSelectedNine(null);
    setPendingNineTeeId(null);
  }, [holeCount]);

  async function handleCourseSelect(result: CourseSearchResult) {
    setImportError(null);
    setImportingCourse(true);
    setAvailableTees(null);
    setSelectedTeeId(null);
    setSelectedNine(null);
    setPendingNineTeeId(null);

    try {
      const { course, tees } = await importGolfCourse(result.externalId);
      setSelectedCourse({ externalId: result.externalId, clubName: course.club_name, courseName: course.course_name });
      setAvailableTees(tees);
      setCourseName(course.course_name === course.club_name ? course.club_name : `${course.club_name} — ${course.course_name}`);
    } catch (err) {
      setSelectedCourse(null);
      setImportError(err instanceof GolfCourseSearchError ? err.message : 'Something went wrong importing that course. You can still enter it by hand.');
    } finally {
      setImportingCourse(false);
    }
  }

  function handleSelectTee(tee: ImportedCourseTee) {
    setImportError(null);
    const compatibility = classifyTeeCompatibility(tee.number_of_holes, holeCount);
    if (compatibility === 'direct') {
      setSelectedTeeId(tee.id);
      setSelectedNine(null);
      setPendingNineTeeId(null);
      return;
    }
    if (compatibility === 'needs-nine') {
      setPendingNineTeeId(tee.id);
      return;
    }
    setImportError(`This tee has ${tee.number_of_holes} holes, which doesn't match this tournament's ${holeCount} holes.`);
  }

  function handleChooseNine(teeId: string, nine: 'front' | 'back') {
    setSelectedTeeId(teeId);
    setSelectedNine(nine);
    setPendingNineTeeId(null);
  }

  function handleUseManualEntry() {
    setSelectedCourse(null);
    setAvailableTees(null);
    setSelectedTeeId(null);
    setSelectedNine(null);
    setPendingNineTeeId(null);
    setImportError(null);
  }

  const awaitingTeeChoice = selectedCourse !== null && selectedTeeId === null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    // create_tournament_with_course() is atomic: if a course/tee was
    // chosen but importing it fails (e.g. a stale tee id), nothing is
    // created at all -- the organizer stays on this form with the exact
    // error, never a tournament with blank placeholder holes.
    const { data, error: rpcError } = await supabase.rpc('create_tournament_with_course', {
      p_name: name.trim(),
      p_course_name: courseName.trim(),
      p_tournament_date: tournamentDate,
      p_hole_count: holeCount,
      p_scoring_format: scoringFormat,
      p_team_size: teamSize,
      p_description: description.trim() || null,
      p_tee_id: selectedTeeId,
      p_nine: selectedNine,
    });

    setSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    navigate(`/tournaments/${data as string}/overview`, { replace: true });
  }

  return (
    <div>
      <h1>Create Tournament</h1>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="name">Tournament name</label>
          <input id="name" required value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <CourseSearchField label="Find a course (optional)" onSelect={(result) => void handleCourseSelect(result)} />

        {importingCourse && <p className="empty-state">Importing course details…</p>}
        {importError && <p className="error-text">{importError}</p>}

        {selectedCourse && availableTees && (
          <div className={`card ${styles.teeCard}`}>
            <p>
              <strong>{selectedCourse.clubName}</strong> — choose a tee to import its holes, par, stroke index,
              distances, rating, and slope:
            </p>
            {availableTees.length === 0 && <p className="empty-state">No tee data available for this course.</p>}
            {availableTees.map((tee) => (
              <div key={tee.id} className={styles.teeRow}>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={selectedTeeId === tee.id}
                  onClick={() => handleSelectTee(tee)}
                >
                  {selectedTeeId === tee.id ? '✓ ' : ''}
                  {formatTeeSummary(tee)}
                </button>
                {pendingNineTeeId === tee.id && (
                  <div className={styles.nineButtons}>
                    <button type="button" className="btn btn-secondary btn-small btn-auto" onClick={() => handleChooseNine(tee.id, 'front')}>
                      Use Front 9
                    </button>
                    <button type="button" className="btn btn-secondary btn-small btn-auto" onClick={() => handleChooseNine(tee.id, 'back')}>
                      Use Back 9
                    </button>
                  </div>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-text btn-auto" onClick={handleUseManualEntry}>
              Set up holes manually instead
            </button>
          </div>
        )}

        <div className="field">
          <label htmlFor="courseName">Course</label>
          <input
            id="courseName"
            required
            value={courseName}
            onChange={(event) => setCourseName(event.target.value)}
            placeholder="Or type the course name directly"
          />
        </div>
        <div className="field">
          <label htmlFor="tournamentDate">Date</label>
          <input
            id="tournamentDate"
            type="date"
            required
            value={tournamentDate}
            onChange={(event) => setTournamentDate(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="holeCount">Number of holes</label>
          <select id="holeCount" value={holeCount} onChange={(event) => setHoleCount(Number(event.target.value))}>
            <option value={9}>9</option>
            <option value={18}>18</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="scoringFormat">Scoring format</label>
          <select
            id="scoringFormat"
            value={scoringFormat}
            onChange={(event) => setScoringFormat(event.target.value)}
          >
            {SCORING_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="teamSize">Team size</label>
          <select id="teamSize" value={teamSize} onChange={(event) => setTeamSize(Number(event.target.value))}>
            {TEAM_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} players
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="description">Description or notes (optional)</label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        {awaitingTeeChoice && (
          <p className="error-text">Choose a tee above, or "Set up holes manually instead", before creating the tournament.</p>
        )}
        <button type="submit" className="btn btn-primary" disabled={submitting || importingCourse || awaitingTeeChoice}>
          {submitting ? 'Creating…' : 'Create Tournament'}
        </button>
      </form>
    </div>
  );
}
