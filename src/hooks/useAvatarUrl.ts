import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

// avatars is a private bucket -- there is no plain/public URL, only
// short-lived signed ones (see 0035's migration comment for why the read
// policy is scoped the way it is). 1 hour is generous enough that a normal
// session rarely needs a second fetch, short enough that a leaked/cached
// URL doesn't stay valid indefinitely.
const SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;
// Deliberately shorter than the URL's own expiry: the query is refetched
// (on remount, refocus, or the interval below) well before the signed URL
// it already handed out would actually stop working, so a long-lived open
// tab never has an avatar suddenly break mid-session.
const SIGNED_URL_STALE_TIME_MS = 45 * 60 * 1000;

/**
 * Resolves one member's avatar storage path to a viewable (signed) URL,
 * cached by React Query. The cache key is the path itself, so every
 * <Avatar> showing the same member's photo -- Members list, Teams roster,
 * Community Feed, wherever -- shares one cached result and one in-flight
 * request instead of each issuing its own createSignedUrl call, and again
 * automatically once the path is already cached from a previous view.
 */
export function useAvatarUrl(photoPath: string | null | undefined) {
  return useQuery({
    queryKey: ['avatar-url', photoPath],
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase.storage
        .from('avatars')
        .createSignedUrl(photoPath as string, SIGNED_URL_EXPIRES_IN_SECONDS);
      if (error) throw error;
      return data.signedUrl;
    },
    enabled: !!photoPath,
    staleTime: SIGNED_URL_STALE_TIME_MS,
    gcTime: SIGNED_URL_STALE_TIME_MS + 15 * 60 * 1000,
    refetchInterval: SIGNED_URL_STALE_TIME_MS,
    retry: 1,
  });
}
