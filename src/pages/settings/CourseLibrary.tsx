import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import {
  archiveManualCourse,
  describeError,
  fetchMyManualCourses,
  findSimilarCourses,
  publishManualCourse,
  restoreManualCourse,
  type ManualCourseListItem,
  type SimilarCourse,
} from '../../lib/courseLibrary';
import { DuplicateCourseModal } from '../../components/DuplicateCourseModal';
import styles from './CourseLibrary.module.css';

export function CourseLibrary() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicateCheck, setDuplicateCheck] = useState<{ course: ManualCourseListItem; matches: SimilarCourse[] } | null>(null);

  const coursesQuery = useQuery({
    queryKey: ['my-manual-courses', user?.id],
    queryFn: () => fetchMyManualCourses(user!.id),
    enabled: !!user,
  });

  const myCourses = (coursesQuery.data ?? []).filter((course) => !course.archived_at);
  const archivedCourses = (coursesQuery.data ?? []).filter((course) => course.archived_at);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['my-manual-courses', user?.id] });
  }

  async function handleArchive(courseId: string) {
    setError(null);
    setActioningId(courseId);
    try {
      await archiveManualCourse(courseId);
      await refresh();
    } catch (err) {
      setError(describeError(err, 'Could not archive this course.'));
    } finally {
      setActioningId(null);
    }
  }

  async function handleRestore(courseId: string) {
    setError(null);
    setActioningId(courseId);
    try {
      await restoreManualCourse(courseId);
      await refresh();
    } catch (err) {
      setError(describeError(err, 'Could not restore this course.'));
    } finally {
      setActioningId(null);
    }
  }

  async function handlePublishClick(course: ManualCourseListItem) {
    setError(null);
    setActioningId(course.id);
    try {
      const matches = await findSimilarCourses({
        clubName: course.club_name,
        courseName: course.course_name,
        city: course.city,
        excludeCourseId: course.id,
      });
      if (matches.length > 0) {
        setDuplicateCheck({ course, matches });
        return;
      }
      await publishManualCourse(course.id);
      await refresh();
    } catch (err) {
      setError(describeError(err, 'Could not publish this course.'));
    } finally {
      setActioningId(null);
    }
  }

  async function handleContinuePublishing() {
    if (!duplicateCheck) return;
    const courseId = duplicateCheck.course.id;
    setActioningId(courseId);
    try {
      await publishManualCourse(courseId);
      await refresh();
      setDuplicateCheck(null);
    } catch (err) {
      setError(describeError(err, 'Could not publish this course.'));
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div>
      <h1>Courses</h1>
      <Link to="/settings/courses/new" className="btn btn-primary">
        Add Course
      </Link>

      <h2 className="section-title">My Courses</h2>
      {error && <p className="error-text">{error}</p>}
      {coursesQuery.isLoading && <p className="empty-state">Loading…</p>}
      {coursesQuery.data && myCourses.length === 0 && <p className="empty-state">You haven't added any courses yet.</p>}
      {myCourses.map((course) => {
        const isDraft = !course.published_at;
        return (
          <div key={course.id} className={`card ${styles.courseRow}`}>
            <div>
              <strong>{course.club_name}</strong>
              <p className={styles.meta}>{course.course_name}</p>
              {isDraft && <span className="badge badge-pending">Draft</span>}
            </div>
            <div className={styles.actions}>
              <Link to={`/settings/courses/${course.id}/edit`} className="btn btn-secondary btn-small btn-auto">
                Edit Course
              </Link>
              {isDraft && (
                <button
                  type="button"
                  className="btn btn-primary btn-small btn-auto"
                  disabled={actioningId === course.id}
                  onClick={() => void handlePublishClick(course)}
                >
                  Publish
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger btn-small btn-auto"
                disabled={actioningId === course.id}
                onClick={() => void handleArchive(course.id)}
              >
                Archive Course
              </button>
            </div>
          </div>
        );
      })}

      <h2 className="section-title">Archived Courses</h2>
      {coursesQuery.data && archivedCourses.length === 0 && <p className="empty-state">No archived courses.</p>}
      {archivedCourses.map((course) => (
        <div key={course.id} className={`card ${styles.courseRow}`}>
          <div>
            <strong>{course.club_name}</strong>
            <p className={styles.meta}>{course.course_name}</p>
            <span className="badge badge-declined">Archived</span>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn-secondary btn-small btn-auto"
              disabled={actioningId === course.id}
              onClick={() => void handleRestore(course.id)}
            >
              Restore
            </button>
          </div>
        </div>
      ))}

      {duplicateCheck && (
        <DuplicateCourseModal
          matches={duplicateCheck.matches}
          continuing={actioningId === duplicateCheck.course.id}
          onContinue={() => void handleContinuePublishing()}
          onDismiss={() => setDuplicateCheck(null)}
        />
      )}
    </div>
  );
}
