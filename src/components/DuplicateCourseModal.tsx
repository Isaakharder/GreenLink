import { Link } from 'react-router-dom';
import type { SimilarCourse } from '../lib/courseLibrary';
import styles from './DuplicateCourseModal.module.css';

interface DuplicateCourseModalProps {
  matches: SimilarCourse[];
  onContinue: () => void;
  onDismiss: () => void;
  continuing?: boolean;
}

/**
 * "Before publishing, search for similar existing courses ... warn the
 * user." A warning only -- never blocks or merges. Reused by both
 * CourseForm (publishing from the creator) and CourseLibrary (publishing a
 * saved draft) so the two entry points can't drift on copy or behavior.
 */
export function DuplicateCourseModal({ matches, onContinue, onDismiss, continuing }: DuplicateCourseModalProps) {
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="duplicate-course-heading">
      <div className={styles.sheet}>
        <h2 id="duplicate-course-heading" className={styles.heading}>
          A similar course already exists
        </h2>
        <ul className={styles.matchList}>
          {matches.map((match) => (
            <li key={match.id} className={styles.matchRow}>
              <strong>{match.club_name}</strong>
              <span className={styles.matchMeta}>
                {match.course_name}
                {[match.city, match.state, match.country].filter(Boolean).length > 0 &&
                  ` · ${[match.city, match.state, match.country].filter(Boolean).join(', ')}`}
              </span>
              <Link to={`/settings/courses/${match.id}/edit`} className="btn btn-text btn-auto">
                View Existing Course
              </Link>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-primary" disabled={continuing} onClick={onContinue}>
          {continuing ? 'Publishing…' : 'Continue Creating'}
        </button>
        <button type="button" className="btn btn-text btn-auto" onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </div>
  );
}
