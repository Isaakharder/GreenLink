import styles from './Avatar.module.css';

interface AvatarProps {
  name: string;
  size?: 'small' | 'medium';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function Avatar({ name, size = 'medium' }: AvatarProps) {
  return (
    <span className={`${styles.avatar} ${size === 'small' ? styles.small : ''}`} aria-hidden="true">
      {getInitials(name)}
    </span>
  );
}
