import { useEffect, useState } from 'react';
import {
  formatCourseLocation,
  formatCourseSourceLabel,
  searchGolfCourses,
  GolfCourseSearchError,
  type CourseSearchResult,
} from '../lib/golfCourseApi';
import styles from './CourseSearchField.module.css';

interface CourseSearchFieldProps {
  label: string;
  onSelect: (result: CourseSearchResult) => void;
}

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 350;

/**
 * Search-as-you-type against GolfCourseAPI (via the golf-course-lookup Edge
 * Function). Purely a search+select widget -- selecting a result just calls
 * onSelect and resets; the caller decides what "selected" means (fill a
 * text field, offer a tee picker, etc). Typing without ever selecting a
 * result is always fine -- callers must keep their own manual-entry field
 * fully usable regardless of what happens here.
 */
export function CourseSearchField({ label, onSelect }: CourseSearchFieldProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CourseSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    let cancelled = false;

    const timer = window.setTimeout(() => {
      void searchGolfCourses(trimmed)
        .then((found) => {
          if (cancelled) return;
          setResults(found);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setResults([]);
          setError(err instanceof GolfCourseSearchError ? err.message : 'Course search is unavailable right now. You can still enter the course by hand.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  function handleSelect(result: CourseSearchResult) {
    onSelect(result);
    setQuery('');
    setResults([]);
  }

  return (
    <div className={styles.wrapper}>
      <div className="field">
        <label htmlFor="course-search">{label}</label>
        <input
          id="course-search"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by course or club name…"
          autoComplete="off"
        />
      </div>

      {loading && <p className={styles.status}>Searching…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {results.length > 0 && (
        <ul className={styles.results}>
          {results.map((result) => {
            const unusable = result.scorecardStatus === 'unusable';
            return (
              <li key={result.externalId}>
                <button
                  type="button"
                  className={`${styles.resultButton} ${unusable ? styles.resultUnusable : ''}`}
                  onClick={() => handleSelect(result)}
                >
                  <span className={styles.resultTitle}>{result.clubName}</span>
                  <span className={styles.resultMeta}>
                    {result.courseName}
                    {formatCourseLocation(result) && ` · ${formatCourseLocation(result)}`}
                    {' · '}
                    <span className={styles.sourceLabel}>{formatCourseSourceLabel(result.source)}</span>
                  </span>
                  {unusable && <span className={`badge badge-declined ${styles.resultBadge}`}>Scorecard data unavailable</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
