import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { supabase } from '../lib/supabaseClient';
import { describeAuthError } from '../lib/authErrors';
import styles from './AuthForm.module.css';

export function ResetPassword() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (submittingRef.current) return;
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        setError(describeAuthError(updateError, 'reset-password').message);
        return;
      }

      navigate('/home', { replace: true });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="page-status">Loading…</div>;
  }

  // supabase-js establishes a short-lived "recovery" session from the token
  // in the reset-link URL as soon as the client initializes. No session at
  // this point means the link was already used, expired, or malformed.
  if (!session) {
    return (
      <div className={`page ${styles.wrapper}`}>
        <h1>Reset Password</h1>
        <p className="error-text">
          This password reset link is invalid or has expired. Request a new one below.
        </p>
        <p className={styles.switch}>
          <Link to="/forgot-password">Request New Link</Link>
        </p>
      </div>
    );
  }

  return (
    <div className={`page ${styles.wrapper}`}>
      <h1>Reset Password</h1>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="password">New password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={6}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="confirmPassword">Confirm new password</label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={6}
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save New Password'}
        </button>
      </form>
    </div>
  );
}
