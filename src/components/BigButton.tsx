import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './BigButton.module.css';

interface BigButtonProps {
  to: string;
  label: string;
  icon: ReactNode;
}

export function BigButton({ to, label, icon }: BigButtonProps) {
  const navigate = useNavigate();

  return (
    <button type="button" className={styles.button} onClick={() => navigate(to)}>
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
