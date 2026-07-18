import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabaseClient';
import { defaultParsForHoleCount, DISTANCE_UNITS } from '../../lib/constants';
import { CourseSearchField } from '../../components/CourseSearchField';
import { formatTeeSummary, GolfCourseSearchError, importGolfCourse, type CourseSearchResult, type ImportedCourseTee } from '../../lib/golfCourseApi';
import { classifyTeeCompatibility } from '../../lib/courseImport';
import { refreshIfDownloaded } from '../../lib/offlineDownload';
import { useAuth } from '../../auth/useAuth';
import type { TournamentAccess } from '../../hooks/useTournamentAccess';
import type { DistanceUnit, TournamentHole } from '../../types/database';
import styles from './SettingsTab.module.css';

interface HoleRow {
  holeNumber: number;
  par: number | '';
  strokeIndex: number | '';
  distance: number | '';
  distanceUnit: DistanceUnit;
}

interface OtherCourse {
  id: string;
  name: string;
  courseName: string;
  holeCount: number;
}

function buildEmptyRows(holeCount: number): HoleRow[] {
  return Array.from({ length: holeCount }, (_, index) => ({
    holeNumber: index + 1,
    par: '',
    strokeIndex: '',
    distance: '',
    distanceUnit: 'yards' as DistanceUnit,
  }));
}

/** Merges saved TournamentHole rows onto an empty grid -- shared by the initial seed-from-server effect and by "apply what was just imported". */
function mapHolesToRows(holeCount: number, holes: TournamentHole[]): HoleRow[] {
  const base = buildEmptyRows(holeCount);
  if (holes.length === 0) return base;

  const byHoleNumber = new Map(holes.map((hole) => [hole.hole_number, hole]));
  return base.map((row) => {
    const existing = byHoleNumber.get(row.holeNumber);
    if (!existing) return row;
    return {
      holeNumber: row.holeNumber,
      par: existing.par,
      strokeIndex: existing.stroke_index ?? '',
      distance: existing.distance ?? '',
      distanceUnit: existing.distance_unit,
    };
  });
}

async function fetchHoles(tournamentId: string): Promise<TournamentHole[]> {
  const { data, error } = await supabase
    .from('tournament_holes')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('hole_number', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchOtherCourses(tournamentId: string, organizerUserId: string): Promise<OtherCourse[]> {
  const { data: tournaments, error } = await supabase
    .from('tournaments')
    .select('id, name, course_name, hole_count')
    .eq('organizer_user_id', organizerUserId)
    .neq('id', tournamentId);
  if (error) throw error;
  if (!tournaments || tournaments.length === 0) return [];

  const { data: holes, error: holesError } = await supabase
    .from('tournament_holes')
    .select('tournament_id')
    .in(
      'tournament_id',
      tournaments.map((t) => t.id),
    );
  if (holesError) throw holesError;

  const configuredIds = new Set((holes ?? []).map((h) => h.tournament_id));

  return tournaments
    .filter((t) => configuredIds.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, courseName: t.course_name, holeCount: t.hole_count }));
}

export function SettingsTab() {
  const { tournament, isOrganizer } = useOutletContext<TournamentAccess>();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [rows, setRows] = useState<HoleRow[]>([]);
  const seededRef = useRef(false);
  const [showCopyPicker, setShowCopyPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [showCourseImport, setShowCourseImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedCourseName, setImportedCourseName] = useState<string | null>(null);
  const [availableTees, setAvailableTees] = useState<ImportedCourseTee[] | null>(null);
  const [pendingNineTeeId, setPendingNineTeeId] = useState<string | null>(null);
  const [applyingTee, setApplyingTee] = useState(false);
  const [applySuccess, setApplySuccess] = useState<string | null>(null);

  const [editingRating, setEditingRating] = useState(false);
  const [ratingInput, setRatingInput] = useState('');
  const [slopeInput, setSlopeInput] = useState('');
  const [ratingSaving, setRatingSaving] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);

  const isLocked = !!tournament && tournament.status !== 'draft' && tournament.status !== 'upcoming';

  const holesQuery = useQuery({
    queryKey: ['tournament-holes-setup', tournament?.id],
    queryFn: () => fetchHoles(tournament!.id),
    enabled: !!tournament,
  });

  const otherCoursesQuery = useQuery({
    queryKey: ['organizer-other-courses', tournament?.id],
    queryFn: () => fetchOtherCourses(tournament!.id, tournament!.organizer_user_id),
    enabled: !!tournament && isOrganizer && showCopyPicker,
  });

  useEffect(() => {
    if (!tournament || seededRef.current || !holesQuery.data) return;
    seededRef.current = true;
    setRows(mapHolesToRows(tournament.hole_count, holesQuery.data));
  }, [tournament, holesQuery.data]);

  if (!isOrganizer) {
    return <p className="empty-state">You do not have permission to view this page.</p>;
  }

  if (!tournament) return null;

  function updateRow(holeNumber: number, patch: Partial<HoleRow>) {
    setRows((prev) => prev.map((row) => (row.holeNumber === holeNumber ? { ...row, ...patch } : row)));
    setSaveSuccess(false);
    setApplySuccess(null);
  }

  function handleFillDefaultPars() {
    const defaults = defaultParsForHoleCount(tournament!.hole_count);
    setRows((prev) => prev.map((row, index) => ({ ...row, par: defaults[index] ?? row.par })));
    setSaveSuccess(false);
  }

  async function handleCopyFrom(courseId: string) {
    const sourceHoles = await fetchHoles(courseId);
    const byHoleNumber = new Map(sourceHoles.map((hole) => [hole.hole_number, hole]));
    setRows((prev) =>
      prev.map((row) => {
        const source = byHoleNumber.get(row.holeNumber);
        if (!source) return row;
        return {
          holeNumber: row.holeNumber,
          par: source.par,
          strokeIndex: source.stroke_index ?? '',
          distance: source.distance ?? '',
          distanceUnit: source.distance_unit,
        };
      }),
    );
    setShowCopyPicker(false);
    setSaveSuccess(false);
  }

  async function handleCourseSelect(result: CourseSearchResult) {
    setImporting(true);
    setImportError(null);
    setApplySuccess(null);
    setAvailableTees(null);
    setPendingNineTeeId(null);

    try {
      const { tees } = await importGolfCourse(result.externalId);
      setImportedCourseName(`${result.clubName}${result.courseName !== result.clubName ? ` — ${result.courseName}` : ''}`);
      setAvailableTees(tees);
    } catch (err) {
      setImportError(
        err instanceof GolfCourseSearchError ? err.message : 'Course search is unavailable right now. You can still enter the course by hand.',
      );
    } finally {
      setImporting(false);
    }
  }

  async function applyTee(teeId: string, nine: 'front' | 'back' | null) {
    setApplyingTee(true);
    setImportError(null);
    setApplySuccess(null);

    const { data, error } = await supabase.rpc('apply_imported_course_to_tournament', {
      p_tournament_id: tournament!.id,
      p_tee_id: teeId,
      p_nine: nine,
    });

    setApplyingTee(false);

    if (error) {
      setImportError(error.message);
      return;
    }

    const importedHoles = (data as TournamentHole[]) ?? [];
    setRows(mapHolesToRows(tournament!.hole_count, importedHoles));
    setAvailableTees(null);
    setPendingNineTeeId(null);
    setShowCourseImport(false);
    setSaveSuccess(false);
    setApplySuccess(`Course setup populated — ${importedHoles.length} holes imported. Review below before saving.`);
    void queryClient.invalidateQueries({ queryKey: ['tournament', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-holes-setup', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-readiness', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-overview-stats', tournament!.id] });
    if (user) void refreshIfDownloaded(tournament!.id, user.id);
  }

  function handleSelectTee(tee: ImportedCourseTee) {
    setImportError(null);
    const compatibility = classifyTeeCompatibility(tee.number_of_holes, tournament!.hole_count);
    if (compatibility === 'direct') {
      void applyTee(tee.id, null);
      return;
    }
    if (compatibility === 'needs-nine') {
      setPendingNineTeeId(tee.id);
      return;
    }
    setImportError(`This tee has ${tee.number_of_holes} holes, which doesn't match this tournament's ${tournament!.hole_count} holes.`);
  }

  async function handleSaveRating() {
    setRatingError(null);
    const courseRating = ratingInput.trim() === '' ? null : Number(ratingInput);
    const slopeRating = slopeInput.trim() === '' ? null : Number(slopeInput);
    if ((ratingInput.trim() !== '' && Number.isNaN(courseRating)) || (slopeInput.trim() !== '' && Number.isNaN(slopeRating))) {
      setRatingError('Rating and slope must be numbers.');
      return;
    }

    setRatingSaving(true);
    const { error } = await supabase.rpc('set_tournament_course_rating', {
      p_tournament_id: tournament!.id,
      p_course_rating: courseRating,
      p_slope_rating: slopeRating,
    });
    setRatingSaving(false);

    if (error) {
      setRatingError(error.message);
      return;
    }

    setEditingRating(false);
    void queryClient.invalidateQueries({ queryKey: ['tournament', tournament!.id] });
    if (user) void refreshIfDownloaded(tournament!.id, user.id);
  }

  async function handleSaveHoles() {
    setSaveError(null);
    setSaveSuccess(false);

    if (rows.some((row) => row.par === '')) {
      setSaveError('Enter a par for every hole before saving.');
      return;
    }

    setSaving(true);

    const payload = rows.map((row) => ({
      hole_number: row.holeNumber,
      par: row.par,
      stroke_index: row.strokeIndex === '' ? null : row.strokeIndex,
      distance: row.distance === '' ? null : row.distance,
      distance_unit: row.distanceUnit,
    }));

    const { error } = await supabase.rpc('save_tournament_holes', {
      p_tournament_id: tournament!.id,
      p_holes: payload,
    });

    setSaving(false);

    if (error) {
      setSaveError(error.message);
      return;
    }

    setSaveSuccess(true);
    void queryClient.invalidateQueries({ queryKey: ['tournament-holes-setup', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-readiness', tournament!.id] });
    void queryClient.invalidateQueries({ queryKey: ['tournament-overview-stats', tournament!.id] });
    if (user) void refreshIfDownloaded(tournament!.id, user.id);
  }

  const totalPar = rows.reduce((sum, row) => sum + (row.par === '' ? 0 : row.par), 0);

  return (
    <div>
      <h2 className="section-title">Tournament Settings</h2>
      <dl className={styles.details}>
        <div className={styles.row}>
          <dt>Name</dt>
          <dd>{tournament.name}</dd>
        </div>
        <div className={styles.row}>
          <dt>Course</dt>
          <dd>{tournament.course_name}</dd>
        </div>
        <div className={styles.row}>
          <dt>Date</dt>
          <dd>{tournament.tournament_date}</dd>
        </div>
        <div className={styles.row}>
          <dt>Hole count</dt>
          <dd>{tournament.hole_count}</dd>
        </div>
        <div className={styles.row}>
          <dt>Scoring format</dt>
          <dd>{tournament.scoring_format ?? '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt>Team size</dt>
          <dd>{tournament.team_size ?? '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt>Course rating / slope</dt>
          <dd>
            {editingRating ? (
              <span className={styles.ratingEditRow}>
                <input
                  type="number"
                  step="0.1"
                  aria-label="Course rating"
                  value={ratingInput}
                  onChange={(event) => setRatingInput(event.target.value)}
                  disabled={isLocked}
                />
                <input
                  type="number"
                  aria-label="Slope rating"
                  value={slopeInput}
                  onChange={(event) => setSlopeInput(event.target.value)}
                  disabled={isLocked}
                />
                <button type="button" className="btn btn-secondary btn-small btn-auto" disabled={ratingSaving} onClick={() => void handleSaveRating()}>
                  {ratingSaving ? 'Saving…' : 'Save'}
                </button>
              </span>
            ) : (
              <>
                {tournament.course_rating ?? '—'} / {tournament.slope_rating ?? '—'}
                {!isLocked && (
                  <button
                    type="button"
                    className="btn btn-text btn-auto"
                    onClick={() => {
                      setRatingInput(tournament.course_rating?.toString() ?? '');
                      setSlopeInput(tournament.slope_rating?.toString() ?? '');
                      setRatingError(null);
                      setEditingRating(true);
                    }}
                  >
                    Edit
                  </button>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>
      {ratingError && <p className="error-text">{ratingError}</p>}

      <h2 className="section-title">Course Setup</h2>

      {isLocked ? (
        <p className={styles.lockedNotice}>Course setup is locked once the tournament has started.</p>
      ) : (
        <>
          <p className={styles.helperText}>Total par so far: {totalPar || '—'}</p>
          <div className={styles.toolRow}>
            <button type="button" className="btn btn-secondary btn-small btn-auto" onClick={handleFillDefaultPars}>
              Fill Default Pars
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small btn-auto"
              onClick={() => setShowCopyPicker((prev) => !prev)}
            >
              Copy Course Setup
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small btn-auto"
              onClick={() => setShowCourseImport((prev) => !prev)}
            >
              Import Course
            </button>
          </div>
          <p className={styles.helperNote}>Default pars are placeholders — review every hole before saving.</p>

          {showCourseImport && (
            <div className={`card ${styles.copyPicker}`}>
              <CourseSearchField label="Search GolfCourseAPI" onSelect={(result) => void handleCourseSelect(result)} />
              {importing && <p className={styles.helperText}>Importing course details…</p>}
              {applyingTee && <p className={styles.helperText}>Applying tee…</p>}
              {importError && <p className="error-text">{importError}</p>}

              {importedCourseName && availableTees && (
                <>
                  <p className={styles.helperText}>{importedCourseName} — choose a tee:</p>
                  {availableTees.length === 0 && <p className={styles.helperText}>No tee data available for this course.</p>}
                  {availableTees.map((tee) => (
                    <div key={tee.id}>
                      <button
                        type="button"
                        className={styles.copyOption}
                        disabled={applyingTee}
                        onClick={() => handleSelectTee(tee)}
                      >
                        <span className={styles.copyOptionName}>{formatTeeSummary(tee)}</span>
                      </button>
                      {pendingNineTeeId === tee.id && (
                        <div className={styles.toolRow}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small btn-auto"
                            disabled={applyingTee}
                            onClick={() => void applyTee(tee.id, 'front')}
                          >
                            Use Front 9
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small btn-auto"
                            disabled={applyingTee}
                            onClick={() => void applyTee(tee.id, 'back')}
                          >
                            Use Back 9
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {showCopyPicker && (
            <div className={`card ${styles.copyPicker}`}>
              {otherCoursesQuery.isLoading ? (
                <p className={styles.helperText}>Loading your other tournaments…</p>
              ) : otherCoursesQuery.data && otherCoursesQuery.data.length > 0 ? (
                otherCoursesQuery.data.map((course) => (
                  <button
                    key={course.id}
                    type="button"
                    className={styles.copyOption}
                    onClick={() => void handleCopyFrom(course.id)}
                  >
                    <span className={styles.copyOptionName}>{course.name}</span>
                    <span className={styles.copyOptionMeta}>
                      {course.courseName} · {course.holeCount} holes
                    </span>
                  </button>
                ))
              ) : (
                <p className={styles.helperText}>No previously configured courses to copy from yet.</p>
              )}
            </div>
          )}
        </>
      )}

      {applySuccess && <p className={styles.successText}>{applySuccess}</p>}

      {rows.map((row) => (
        <div key={row.holeNumber} className={styles.holeCard}>
          <p className={styles.holeCardTitle}>Hole {row.holeNumber}</p>
          <div className={styles.holeCardFields}>
            <div className="field">
              <label htmlFor={`par-${row.holeNumber}`}>Par</label>
              <input
                id={`par-${row.holeNumber}`}
                type="number"
                min={3}
                max={6}
                disabled={isLocked}
                value={row.par}
                onChange={(event) =>
                  updateRow(row.holeNumber, { par: event.target.value === '' ? '' : Number(event.target.value) })
                }
              />
            </div>
            <div className="field">
              <label htmlFor={`si-${row.holeNumber}`}>Stroke index</label>
              <input
                id={`si-${row.holeNumber}`}
                type="number"
                min={1}
                disabled={isLocked}
                value={row.strokeIndex}
                onChange={(event) =>
                  updateRow(row.holeNumber, {
                    strokeIndex: event.target.value === '' ? '' : Number(event.target.value),
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor={`dist-${row.holeNumber}`}>Distance</label>
              <input
                id={`dist-${row.holeNumber}`}
                type="number"
                min={0}
                disabled={isLocked}
                value={row.distance}
                onChange={(event) =>
                  updateRow(row.holeNumber, { distance: event.target.value === '' ? '' : Number(event.target.value) })
                }
              />
            </div>
            <div className="field">
              <label htmlFor={`unit-${row.holeNumber}`}>Unit</label>
              <select
                id={`unit-${row.holeNumber}`}
                disabled={isLocked}
                value={row.distanceUnit}
                onChange={(event) => updateRow(row.holeNumber, { distanceUnit: event.target.value as DistanceUnit })}
              >
                {DISTANCE_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ))}

      {!isLocked && (
        <>
          {saveError && <p className="error-text">{saveError}</p>}
          {saveSuccess && <p className={styles.successText}>Holes saved. Total par: {totalPar}.</p>}
          <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSaveHoles}>
            {saving ? 'Saving…' : 'Save All Holes'}
          </button>
        </>
      )}
    </div>
  );
}
