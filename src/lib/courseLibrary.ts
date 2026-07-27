import { supabase } from './supabaseClient';
import type { GolfCourseTeeGender } from '../types/database';

// Client for the manual course library RPCs (supabase/migrations/0027).
// Every write goes through a SECURITY DEFINER function that re-checks
// ownership/admin status server-side -- these wrappers exist only for a
// typed, ergonomic call shape, not for any permission logic of their own.

/**
 * Extracts a display message from a caught error, including a Supabase/
 * PostgREST RPC error (e.g. a `raise exception` from one of the functions
 * above) -- those come back as a plain `{ message, code, details, hint }`
 * object that `instanceof Error` does not reliably recognize in this
 * runtime, which would otherwise silently swallow the server's actual
 * validation message (e.g. "at least one tee is required to publish") in
 * favor of a generic fallback.
 */
export function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export interface ManualHoleInput {
  hole_number: number;
  /** null when a draft's hole hasn't had a par entered yet -- the server only requires every hole to have one when publishing. */
  par: number | null;
  yardage?: number | null;
}

export interface ManualTeeInput {
  /** Present when keeping/editing an existing tee; omitted for a brand new or copied tee. */
  tee_id?: string;
  tee_name: string;
  gender: GolfCourseTeeGender;
  course_rating?: number | null;
  slope_rating?: number | null;
  holes: ManualHoleInput[];
}

export interface ManualCourseInfoInput {
  clubName: string;
  courseName: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface ManualCourseListItem {
  id: string;
  club_name: string;
  course_name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  archived_at: string | null;
  published_at: string | null;
  created_at: string;
}

export async function createManualCourse(info: ManualCourseInfoInput, tees: ManualTeeInput[], publish = true): Promise<string> {
  const { data, error } = await supabase.rpc('create_manual_course', {
    p_club_name: info.clubName,
    p_course_name: info.courseName,
    p_address: info.address ?? null,
    p_city: info.city ?? null,
    p_state: info.state ?? null,
    p_country: info.country ?? null,
    p_latitude: info.latitude ?? null,
    p_longitude: info.longitude ?? null,
    p_tees: tees,
    p_publish: publish,
  });
  if (error) throw error;
  return data as string;
}

/** Turns a draft into a published (searchable) course. Requires at least one current tee server-side; a no-op if already published. */
export async function publishManualCourse(courseId: string): Promise<void> {
  const { error } = await supabase.rpc('publish_manual_course', { p_course_id: courseId });
  if (error) throw error;
}

export interface SimilarCourse {
  id: string;
  club_name: string;
  course_name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string;
}

export interface FindSimilarCoursesInput {
  clubName: string;
  courseName: string;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  excludeCourseId?: string | null;
}

/** "Before publishing, search for similar existing courses" -- a warning trigger only, never an automatic merge. */
export async function findSimilarCourses(input: FindSimilarCoursesInput): Promise<SimilarCourse[]> {
  const { data, error } = await supabase.rpc('find_similar_courses', {
    p_club_name: input.clubName,
    p_course_name: input.courseName,
    p_city: input.city ?? null,
    p_latitude: input.latitude ?? null,
    p_longitude: input.longitude ?? null,
    p_exclude_course_id: input.excludeCourseId ?? null,
  });
  if (error) throw error;
  return data ?? [];
}

export async function updateManualCourseInfo(courseId: string, info: ManualCourseInfoInput): Promise<void> {
  const { error } = await supabase.rpc('update_manual_course_info', {
    p_course_id: courseId,
    p_club_name: info.clubName,
    p_course_name: info.courseName,
    p_address: info.address ?? null,
    p_city: info.city ?? null,
    p_state: info.state ?? null,
    p_country: info.country ?? null,
    p_latitude: info.latitude ?? null,
    p_longitude: info.longitude ?? null,
  });
  if (error) throw error;
}

export async function replaceManualCourseTees(courseId: string, tees: ManualTeeInput[], publish = true): Promise<void> {
  const { error } = await supabase.rpc('replace_manual_course_tees', { p_course_id: courseId, p_tees: tees, p_publish: publish });
  if (error) throw error;
}

export async function archiveManualCourse(courseId: string): Promise<void> {
  const { error } = await supabase.rpc('archive_manual_course', { p_course_id: courseId });
  if (error) throw error;
}

export async function restoreManualCourse(courseId: string): Promise<void> {
  const { error } = await supabase.rpc('restore_manual_course', { p_course_id: courseId });
  if (error) throw error;
}

export async function canManageCourse(courseId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_manage_course', { p_course_id: courseId });
  if (error) throw error;
  return !!data;
}

/** "My Added Courses" -- includes archived ones (Settings shows and can restore them); search_courses() is what excludes archived rows from normal browsing. */
export async function fetchMyManualCourses(userId: string): Promise<ManualCourseListItem[]> {
  const { data, error } = await supabase
    .from('golf_courses')
    .select('id, club_name, course_name, city, state, country, archived_at, published_at, created_at')
    .eq('created_by', userId)
    .in('source', ['manual', 'imported'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export interface ManualCourseDetail {
  id: string;
  club_name: string;
  course_name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  raw_payload: { latitude?: number; longitude?: number } | null;
  published_at: string | null;
}

export async function fetchManualCourse(courseId: string): Promise<ManualCourseDetail> {
  const { data, error } = await supabase
    .from('golf_courses')
    .select('id, club_name, course_name, address, city, state, country, raw_payload, published_at')
    .eq('id', courseId)
    .single();
  if (error) throw error;
  return data as ManualCourseDetail;
}

export interface ManualCourseTeeWithHoles {
  id: string;
  tee_name: string;
  gender: GolfCourseTeeGender;
  /** The declared hole count (9 or 18) -- not necessarily equal to holes.length for a draft tee still missing some pars, which only stores the holes that have one. */
  number_of_holes: number;
  course_rating: number | null;
  slope_rating: number | null;
  holes: { hole_number: number; par: number; yardage: number | null }[];
}

export async function fetchManualCourseTees(courseId: string): Promise<ManualCourseTeeWithHoles[]> {
  const { data: tees, error } = await supabase
    .from('golf_course_tees')
    .select('id, tee_name, gender, number_of_holes, course_rating, slope_rating')
    .eq('golf_course_id', courseId)
    .is('archived_at', null)
    .order('tee_name', { ascending: true });
  if (error) throw error;
  if (!tees || tees.length === 0) return [];

  const { data: holes, error: holesError } = await supabase
    .from('golf_course_tee_holes')
    .select('tee_id, hole_number, par, yardage')
    .in(
      'tee_id',
      tees.map((tee) => tee.id),
    )
    .order('hole_number', { ascending: true });
  if (holesError) throw holesError;

  const holesByTeeId = new Map<string, { hole_number: number; par: number; yardage: number | null }[]>();
  for (const hole of holes ?? []) {
    const list = holesByTeeId.get(hole.tee_id) ?? [];
    list.push({ hole_number: hole.hole_number, par: hole.par, yardage: hole.yardage });
    holesByTeeId.set(hole.tee_id, list);
  }

  return tees.map((tee) => ({ ...tee, holes: holesByTeeId.get(tee.id) ?? [] }));
}
