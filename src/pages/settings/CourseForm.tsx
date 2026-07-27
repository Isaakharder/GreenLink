import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  createManualCourse,
  describeError,
  fetchManualCourse,
  fetchManualCourseTees,
  findSimilarCourses,
  publishManualCourse,
  replaceManualCourseTees,
  updateManualCourseInfo,
  type ManualTeeInput,
  type SimilarCourse,
} from '../../lib/courseLibrary';
import { useAuth } from '../../auth/useAuth';
import { DuplicateCourseModal } from '../../components/DuplicateCourseModal';
import type { GolfCourseTeeGender } from '../../types/database';
import styles from './CourseForm.module.css';

const PAR_OPTIONS = [3, 4, 5, 6] as const;

interface HoleFormRow {
  holeNumber: number;
  par: number | '';
  yardage: number | '';
}

interface TeeFormState {
  key: string;
  teeId?: string;
  teeName: string;
  gender: GolfCourseTeeGender;
  holeCount: 9 | 18;
  courseRating: string;
  slopeRating: string;
  holes: HoleFormRow[];
}

type Step = 'details' | 'tees' | 'review';

function buildHoleRows(holeCount: 9 | 18, source?: HoleFormRow[]): HoleFormRow[] {
  return Array.from({ length: holeCount }, (_, index) => {
    const holeNumber = index + 1;
    const existing = source?.find((row) => row.holeNumber === holeNumber);
    return existing ?? { holeNumber, par: '', yardage: '' };
  });
}

function newTee(): TeeFormState {
  return {
    key: crypto.randomUUID(),
    teeName: '',
    gender: 'unisex',
    holeCount: 18,
    courseRating: '',
    slopeRating: '',
    holes: buildHoleRows(18),
  };
}

function filledHoleCount(tee: TeeFormState): number {
  return tee.holes.filter((h) => h.par !== '').length;
}

function teeParTotal(tee: TeeFormState): number | null {
  if (filledHoleCount(tee) === 0) return null;
  return tee.holes.reduce((sum, h) => sum + (h.par === '' ? 0 : h.par), 0);
}

function teeYardageTotal(tee: TeeFormState): number | null {
  if (tee.holes.some((h) => h.yardage === '')) return null;
  return tee.holes.reduce((sum, h) => sum + (h.yardage === '' ? 0 : h.yardage), 0);
}

/**
 * Add/Edit Course -- a mobile-first step wizard: Course Details -> Tees
 * (collapsible list, each opening a one-hole-at-a-time editor) -> Review ->
 * Save. Publishing (create or edit) validates client-side the same way the
 * server does, so a rejection is never a surprise round trip; Save Draft
 * relaxes that -- an in-progress course with missing pars is a normal,
 * expected state, not an error.
 */
export function CourseForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { courseId } = useParams<{ courseId?: string }>();
  const isEditing = !!courseId;

  const [step, setStep] = useState<Step>('details');
  const [activeTeeKey, setActiveTeeKey] = useState<string | null>(null);
  const [currentHoleNumber, setCurrentHoleNumber] = useState(1);

  const [clubName, setClubName] = useState('');
  const [courseName, setCourseName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [stateField, setStateField] = useState('');
  const [country, setCountry] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [tees, setTees] = useState<TeeFormState[]>([newTee()]);
  const [wasPublished, setWasPublished] = useState(false);

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<SimilarCourse[] | null>(null);

  const [isDirty, setIsDirty] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchManualCourse(courseId), fetchManualCourseTees(courseId)])
      .then(([course, courseTees]) => {
        if (cancelled) return;
        setClubName(course.club_name);
        setCourseName(course.course_name);
        setAddress(course.address ?? '');
        setCity(course.city ?? '');
        setStateField(course.state ?? '');
        setCountry(course.country ?? '');
        setLatitude(course.raw_payload?.latitude != null ? String(course.raw_payload.latitude) : '');
        setLongitude(course.raw_payload?.longitude != null ? String(course.raw_payload.longitude) : '');
        setWasPublished(course.published_at != null);
        setTees(
          courseTees.length > 0
            ? courseTees.map((tee) => {
                const holeCount = (tee.number_of_holes === 9 ? 9 : 18) as 9 | 18;
                return {
                  key: tee.id,
                  teeId: tee.id,
                  teeName: tee.tee_name,
                  gender: tee.gender,
                  holeCount,
                  courseRating: tee.course_rating != null ? String(tee.course_rating) : '',
                  slopeRating: tee.slope_rating != null ? String(tee.slope_rating) : '',
                  holes: buildHoleRows(
                    holeCount,
                    tee.holes.map((h) => ({ holeNumber: h.hole_number, par: h.par, yardage: h.yardage ?? '' })),
                  ),
                };
              })
            : [newTee()],
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, 'Could not load this course.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  // Marks the form dirty on any change to tracked fields, once past the
  // initial load -- simpler and less error-prone than threading a
  // setIsDirty(true) call through every individual field setter.
  useEffect(() => {
    if (loading) return;
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    setIsDirty(true);
  }, [loading, clubName, courseName, address, city, stateField, country, latitude, longitude, tees]);

  useEffect(() => {
    function handler(event: BeforeUnloadEvent) {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  function confirmLeaveIfDirty(): boolean {
    return !isDirty || window.confirm('You have unsaved changes. Leave without saving?');
  }

  function handleCancel() {
    if (!confirmLeaveIfDirty()) return;
    navigate('/settings/courses');
  }

  function updateTee(key: string, patch: Partial<TeeFormState>) {
    setTees((prev) => prev.map((tee) => (tee.key === key ? { ...tee, ...patch } : tee)));
  }

  function updateHole(teeKey: string, holeNumber: number, patch: Partial<HoleFormRow>) {
    setTees((prev) =>
      prev.map((tee) =>
        tee.key === teeKey
          ? { ...tee, holes: tee.holes.map((hole) => (hole.holeNumber === holeNumber ? { ...hole, ...patch } : hole)) }
          : tee,
      ),
    );
  }

  function handleAddTee() {
    const tee = newTee();
    setTees((prev) => [...prev, tee]);
    setActiveTeeKey(tee.key);
    setCurrentHoleNumber(1);
  }

  function handleCopyTee(key: string) {
    const source = tees.find((tee) => tee.key === key);
    if (!source) return;
    setTees((prev) => [
      ...prev,
      { ...source, key: crypto.randomUUID(), teeId: undefined, teeName: `${source.teeName} Copy`, holes: source.holes.map((h) => ({ ...h })) },
    ]);
  }

  function handleRemoveTee(key: string) {
    setTees((prev) => prev.filter((tee) => tee.key !== key));
    if (activeTeeKey === key) setActiveTeeKey(null);
  }

  function handleHoleCountChange(key: string, holeCount: 9 | 18) {
    setTees((prev) =>
      prev.map((tee) => (tee.key === key ? { ...tee, holeCount, holes: buildHoleRows(holeCount, tee.holes) } : tee)),
    );
    setCurrentHoleNumber(1);
  }

  function buildTeeInputs(): ManualTeeInput[] {
    return tees.map((tee) => ({
      tee_id: tee.teeId,
      tee_name: tee.teeName.trim(),
      gender: tee.gender,
      course_rating: tee.courseRating.trim() === '' ? null : Number(tee.courseRating),
      slope_rating: tee.slopeRating.trim() === '' ? null : Number(tee.slopeRating),
      holes: tee.holes.map((hole) => ({
        hole_number: hole.holeNumber,
        par: hole.par === '' ? null : hole.par,
        yardage: hole.yardage === '' ? null : hole.yardage,
      })),
    }));
  }

  function validateDraft(): string | null {
    if (clubName.trim() === '') return 'Club name is required.';
    if (courseName.trim() === '') return 'Course/layout name is required.';
    for (const tee of tees) {
      if (tee.teeName.trim() === '') return 'Every tee needs a name, even in a draft.';
    }
    return null;
  }

  function validatePublish(): string | null {
    const draftError = validateDraft();
    if (draftError) return draftError;
    if (tees.length === 0) return 'At least one tee is required to publish.';
    for (const tee of tees) {
      if (tee.holes.some((hole) => hole.par === '')) return `Enter a par for every hole on ${tee.teeName || 'the tee'} before publishing.`;
    }
    return null;
  }

  async function handleSaveDraft() {
    setError(null);
    const validationError = validateDraft();
    if (validationError) {
      setError(validationError);
      return;
    }
    await persist(false);
  }

  async function handlePublish() {
    setError(null);
    const validationError = validatePublish();
    if (validationError) {
      setError(validationError);
      return;
    }

    setCheckingDuplicates(true);
    try {
      const matches = await findSimilarCourses({
        clubName: clubName.trim(),
        courseName: courseName.trim(),
        city: city.trim() || null,
        latitude: latitude.trim() === '' ? null : Number(latitude),
        longitude: longitude.trim() === '' ? null : Number(longitude),
        excludeCourseId: courseId ?? null,
      });
      if (matches.length > 0) {
        setDuplicateMatches(matches);
        return;
      }
    } catch (err) {
      // The duplicate check is a warning, not a gate -- it failing must
      // never block publishing a course the user is otherwise ready to save.
      console.error('find_similar_courses failed, continuing without the duplicate warning', err);
    } finally {
      setCheckingDuplicates(false);
    }

    await persist(true);
  }

  async function handleContinuePublishingAnyway() {
    setDuplicateMatches(null);
    await persist(true);
  }

  async function persist(publish: boolean) {
    setSaving(true);
    setError(null);
    try {
      const info = {
        clubName: clubName.trim(),
        courseName: courseName.trim(),
        address: address.trim() || null,
        city: city.trim() || null,
        state: stateField.trim() || null,
        country: country.trim() || null,
        latitude: latitude.trim() === '' ? null : Number(latitude),
        longitude: longitude.trim() === '' ? null : Number(longitude),
      };

      if (isEditing && courseId) {
        await updateManualCourseInfo(courseId, info);
        await replaceManualCourseTees(courseId, buildTeeInputs(), publish);
        if (publish) await publishManualCourse(courseId);
      } else {
        await createManualCourse(info, buildTeeInputs(), publish);
      }

      setIsDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['my-manual-courses', user?.id] });
      navigate('/settings/courses', { replace: true });
    } catch (err) {
      setError(describeError(err, 'Could not save this course. Please check your entries and try again.'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="empty-state">Loading…</p>;
  }

  const activeTee = tees.find((tee) => tee.key === activeTeeKey) ?? null;
  const showDraftAndPublish = !isEditing || !wasPublished;
  const busy = saving || checkingDuplicates;

  return (
    <div className={styles.wizard}>
      <h1>{isEditing ? 'Edit Course' : 'Add Course'}</h1>
      {isEditing && !wasPublished && <span className="badge badge-pending">Draft</span>}

      <ol className={styles.stepper} aria-label="Progress">
        {(['details', 'tees', 'review'] as Step[]).map((s, index) => (
          <li key={s} className={`${styles.stepDot} ${step === s ? styles.stepDotCurrent : ''}`}>
            {index + 1}. {s === 'details' ? 'Details' : s === 'tees' ? 'Tees' : 'Review'}
          </li>
        ))}
      </ol>

      {step === 'details' && (
        <div>
          <h2 className="section-title">Course Information</h2>
          <div className="field">
            <label htmlFor="clubName">Club name</label>
            <input id="clubName" required value={clubName} onChange={(event) => setClubName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="courseName">Course/layout name</label>
            <input id="courseName" required value={courseName} onChange={(event) => setCourseName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="address">Address</label>
            <input id="address" value={address} onChange={(event) => setAddress(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="city">City</label>
            <input id="city" value={city} onChange={(event) => setCity(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="state">Province/state</label>
            <input id="state" value={stateField} onChange={(event) => setStateField(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="country">Country</label>
            <input id="country" value={country} onChange={(event) => setCountry(event.target.value)} />
          </div>
          <div className={styles.latLngRow}>
            <div className="field">
              <label htmlFor="latitude">Latitude (optional)</label>
              <input id="latitude" type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="longitude">Longitude (optional)</label>
              <input id="longitude" type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
            </div>
          </div>

          <button type="button" className="btn btn-text btn-auto" onClick={handleCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={clubName.trim() === '' || courseName.trim() === ''}
            onClick={() => setStep('tees')}
          >
            Next: Tees
          </button>
        </div>
      )}

      {step === 'tees' && !activeTee && (
        <div>
          <h2 className="section-title">Tees</h2>
          {tees.map((tee) => {
            const filled = filledHoleCount(tee);
            const complete = filled === tee.holeCount;
            return (
              <div key={tee.key} className={`card ${styles.teeSummaryCard}`}>
                <div className={styles.teeSummaryHeader}>
                  <strong>{tee.teeName || 'Unnamed tee'}</strong>
                  {!complete && <span className="badge badge-pending">{filled} of {tee.holeCount} holes</span>}
                </div>
                <p className={styles.meta}>
                  {tee.gender} · {tee.holeCount} holes
                  {teeParTotal(tee) !== null && ` · Par ${teeParTotal(tee)}`}
                </p>
                <div className={styles.teeSummaryActions}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small btn-auto"
                    onClick={() => {
                      setActiveTeeKey(tee.key);
                      setCurrentHoleNumber(1);
                    }}
                  >
                    Edit Tee & Holes
                  </button>
                  <button type="button" className="btn btn-text btn-auto" onClick={() => handleCopyTee(tee.key)}>
                    Copy Tee
                  </button>
                  {tees.length > 1 && (
                    <button type="button" className="btn btn-text btn-auto" onClick={() => handleRemoveTee(tee.key)}>
                      Delete Tee
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <button type="button" className="btn btn-secondary" onClick={handleAddTee}>
            Add Tee
          </button>

          <div className={styles.stepNavRow}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('details')}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setStep('review')}>
              Next: Review
            </button>
          </div>
        </div>
      )}

      {step === 'tees' && activeTee && (
        <TeeEditor
          tee={activeTee}
          currentHoleNumber={currentHoleNumber}
          onCurrentHoleChange={setCurrentHoleNumber}
          onChange={(patch) => updateTee(activeTee.key, patch)}
          onHoleChange={(holeNumber, patch) => updateHole(activeTee.key, holeNumber, patch)}
          onHoleCountChange={(count) => handleHoleCountChange(activeTee.key, count)}
          onDone={() => setActiveTeeKey(null)}
        />
      )}

      {step === 'review' && (
        <div>
          <h2 className="section-title">Review</h2>
          <div className="card">
            <strong>{clubName}</strong>
            <p className={styles.meta}>{courseName}</p>
            <p className={styles.meta}>{[address, city, stateField, country].filter(Boolean).join(', ') || 'No address entered'}</p>
          </div>

          {tees.map((tee) => {
            const complete = filledHoleCount(tee) === tee.holeCount;
            return (
              <div key={tee.key} className="card">
                <div className={styles.teeSummaryHeader}>
                  <strong>{tee.teeName || 'Unnamed tee'}</strong>
                  <span className={`badge ${complete ? 'badge-accepted' : 'badge-pending'}`}>{complete ? 'Complete' : 'Incomplete'}</span>
                </div>
                <p className={styles.meta}>
                  {tee.gender} · {tee.holeCount} holes
                  {teeParTotal(tee) !== null && ` · Par ${teeParTotal(tee)}`}
                  {teeYardageTotal(tee) !== null && ` · ${teeYardageTotal(tee)} yds`}
                </p>
                {(tee.courseRating || tee.slopeRating) && (
                  <p className={styles.meta}>
                    {tee.courseRating && `Rating ${tee.courseRating}`}
                    {tee.courseRating && tee.slopeRating && ' · '}
                    {tee.slopeRating && `Slope ${tee.slopeRating}`}
                  </p>
                )}
              </div>
            );
          })}

          {error && <p className="error-text">{error}</p>}

          <div className={styles.stepNavRow}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('tees')}>
              Back
            </button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className={styles.saveBar}>
          {showDraftAndPublish ? (
            <>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void handleSaveDraft()}>
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handlePublish()}>
                {checkingDuplicates ? 'Checking…' : saving ? 'Publishing…' : 'Publish Course'}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handlePublish()}>
              {checkingDuplicates ? 'Checking…' : saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>
      )}

      {duplicateMatches && (
        <DuplicateCourseModal
          matches={duplicateMatches}
          continuing={saving}
          onContinue={() => void handleContinuePublishingAnyway()}
          onDismiss={() => setDuplicateMatches(null)}
        />
      )}
    </div>
  );
}

interface TeeEditorProps {
  tee: TeeFormState;
  currentHoleNumber: number;
  onCurrentHoleChange: (holeNumber: number) => void;
  onChange: (patch: Partial<TeeFormState>) => void;
  onHoleChange: (holeNumber: number, patch: Partial<HoleFormRow>) => void;
  onHoleCountChange: (count: 9 | 18) => void;
  onDone: () => void;
}

/** One tee's editor: tee-level fields, then a single current-hole card with Prev/Next Hole navigation and a tap-to-jump hole picker -- deliberately never an 18-row grid, so it stays usable on a phone. Mirrors the current-hole pattern already used for live scoring (ScorecardTab). */
function TeeEditor({ tee, currentHoleNumber, onCurrentHoleChange, onChange, onHoleChange, onHoleCountChange, onDone }: TeeEditorProps) {
  const currentHole = tee.holes.find((h) => h.holeNumber === currentHoleNumber) ?? tee.holes[0];
  const holeIndex = tee.holes.findIndex((h) => h.holeNumber === currentHole.holeNumber);

  return (
    <div>
      <div className={styles.teeEditorHeader}>
        <strong>{tee.teeName || 'New Tee'}</strong>
        <button type="button" className="btn btn-text btn-auto" onClick={onDone}>
          Done
        </button>
      </div>

      <div className="field">
        <label htmlFor={`tee-name-${tee.key}`}>Tee name</label>
        <input id={`tee-name-${tee.key}`} required value={tee.teeName} onChange={(event) => onChange({ teeName: event.target.value })} />
      </div>
      <div className={styles.teeFieldsRow}>
        <div className="field">
          <label htmlFor={`tee-gender-${tee.key}`}>Gender</label>
          <select
            id={`tee-gender-${tee.key}`}
            value={tee.gender}
            onChange={(event) => onChange({ gender: event.target.value as GolfCourseTeeGender })}
          >
            <option value="unisex">Unisex</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`tee-holes-${tee.key}`}>Holes</label>
          <select
            id={`tee-holes-${tee.key}`}
            value={tee.holeCount}
            onChange={(event) => onHoleCountChange(Number(event.target.value) as 9 | 18)}
          >
            <option value={9}>9</option>
            <option value={18}>18</option>
          </select>
        </div>
      </div>
      <div className={styles.teeFieldsRow}>
        <div className="field">
          <label htmlFor={`tee-rating-${tee.key}`}>Course rating (optional)</label>
          <input
            id={`tee-rating-${tee.key}`}
            type="number"
            step="0.1"
            value={tee.courseRating}
            onChange={(event) => onChange({ courseRating: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`tee-slope-${tee.key}`}>Slope rating (optional)</label>
          <input id={`tee-slope-${tee.key}`} type="number" value={tee.slopeRating} onChange={(event) => onChange({ slopeRating: event.target.value })} />
        </div>
      </div>

      <h2 className="section-title">Holes</h2>
      <div className={styles.holeCard}>
        <div className={styles.holeCardHeader}>
          <span className={styles.holeCardNumber}>Hole {currentHole.holeNumber}</span>
          <span className={styles.holeCardOf}>of {tee.holeCount}</span>
        </div>

        <p className={styles.parLabel}>Par</p>
        <div className={styles.parButtons} role="radiogroup" aria-label={`Par for hole ${currentHole.holeNumber}`}>
          {PAR_OPTIONS.map((par) => (
            <button
              key={par}
              type="button"
              role="radio"
              aria-checked={currentHole.par === par}
              className={`${styles.parButton} ${currentHole.par === par ? styles.parButtonSelected : ''}`}
              onClick={() => onHoleChange(currentHole.holeNumber, { par })}
            >
              {par}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor={`hole-yardage-${tee.key}-${currentHole.holeNumber}`}>Yardage (optional)</label>
          <input
            id={`hole-yardage-${tee.key}-${currentHole.holeNumber}`}
            type="number"
            min={0}
            value={currentHole.yardage}
            onChange={(event) =>
              onHoleChange(currentHole.holeNumber, { yardage: event.target.value === '' ? '' : Number(event.target.value) })
            }
          />
        </div>
      </div>

      <div className={styles.stepNavRow}>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={holeIndex <= 0}
          onClick={() => onCurrentHoleChange(tee.holes[holeIndex - 1].holeNumber)}
        >
          Previous Hole
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={holeIndex >= tee.holes.length - 1}
          onClick={() => onCurrentHoleChange(tee.holes[holeIndex + 1].holeNumber)}
        >
          Next Hole
        </button>
      </div>

      <ul className={styles.pickerList}>
        {tee.holes.map((hole) => (
          <li key={hole.holeNumber}>
            <button
              type="button"
              className={`${styles.pickerItem} ${hole.par !== '' ? styles.pickerItemFilled : ''} ${
                hole.holeNumber === currentHole.holeNumber ? styles.pickerItemCurrent : ''
              }`}
              onClick={() => onCurrentHoleChange(hole.holeNumber)}
            >
              {hole.holeNumber}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
