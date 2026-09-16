import { useEffect, useState } from 'react';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import styles from './Avatar.module.css';

interface AvatarProps {
  name: string;
  /** profiles.photo_path (or null/undefined) -- the caller never deals with signed URLs directly; resolving and caching that is this component's job via useAvatarUrl. */
  photoPath?: string | null;
  size?: 'small' | 'medium' | 'large';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * One member's avatar: their photo cropped to a circle when available,
 * initials otherwise -- and initials again, gracefully, whenever the photo
 * isn't available for any reason (no photo_path, the signed URL hasn't
 * resolved yet, resolving it failed, or the image itself failed to load).
 * Callers only ever provide name/photoPath; resolving and caching the
 * actual signed URL is handled internally via useAvatarUrl.
 */
export function Avatar({ name, photoPath, size = 'medium' }: AvatarProps) {
  const { data: url, isError } = useAvatarUrl(photoPath);
  const [imgFailed, setImgFailed] = useState(false);

  // A new/changed photo (or a freshly-resolved URL after a cache
  // invalidation) deserves a fresh attempt, not a stale failure carried
  // over from whatever was previously shown here.
  useEffect(() => {
    setImgFailed(false);
  }, [url]);

  const showPhoto = !!url && !isError && !imgFailed;
  const sizeClass = size === 'small' ? styles.small : size === 'large' ? styles.large : '';

  return (
    <span className={`${styles.avatar} ${sizeClass}`} aria-hidden="true">
      {showPhoto ? (
        <img src={url} alt="" className={styles.photo} onError={() => setImgFailed(true)} />
      ) : (
        getInitials(name)
      )}
    </span>
  );
}
