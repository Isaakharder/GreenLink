import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { describeAuthError } from '../lib/authErrors';
import styles from './AuthForm.module.css';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (resetError) {
        setError(describeAuthError(resetError, 'forgot-password').message);
        return;
      }

      // Enumeration-safe: shown regardless of whether the email is
      // actually registered, so this page can't be used to test which
      // addresses have accounts.
      setSent(true);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className={`page ${styles.wrapper}`}>
      <h1>Forgot Password</h1>

      {sent ? (
        <p className={styles['info-text']}>
          If an account exists for that email, we&apos;ve sent a link to reset your password. Check your inbox and
          spam folder.
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
          <p>Enter your email and we&apos;ll send you a link to reset your password.</p>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send Reset Link'}
          </button>
        </form>
      )}

      <p className={styles.switch}>
        <Link to="/sign-in">Back to Sign In</Link>
      </p>
    </div>
  );
}
