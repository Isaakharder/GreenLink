import { supabase } from './supabaseClient';
import { processAvatarImage } from './avatarImage';

/** The one deterministic object every user's avatar ever lives at -- see 0035's migration comment for why this eliminates orphaned files by construction. */
export function avatarStoragePath(userId: string): string {
  return `${userId}/avatar.webp`;
}

/**
 * Processes and uploads a new avatar, replacing any existing one in place
 * (upsert to the same fixed path -- never a second object to clean up).
 * Does not touch profiles.photo_path; the caller updates that only after
 * this resolves, so a failed upload never leaves the profile pointing at
 * an image that was never actually written.
 */
export async function uploadAvatar(userId: string, file: File): Promise<string> {
  const blob = await processAvatarImage(file);
  const path = avatarStoragePath(userId);

  const { error } = await supabase.storage.from('avatars').upload(path, blob, {
    upsert: true,
    contentType: 'image/webp',
  });
  if (error) throw error;

  return path;
}

/** Best-effort: callers should treat this as non-fatal to whatever larger operation it's part of (see EditProfile's remove-photo sequencing). */
export async function deleteAvatar(userId: string): Promise<void> {
  const { error } = await supabase.storage.from('avatars').remove([avatarStoragePath(userId)]);
  if (error) throw error;
}
