import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { AUTH_ERROR_MESSAGES, describeAuthError, type AuthErrorKind } from '../lib/authErrors';
import styles from './AuthForm.module.css';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,20}$/;
const RESEND_COOLDOWN_MS = 30_000;

// Signup failures where the account may already exist unconfirmed (or the
// confirmation email just didn't arrive) -- offer a way to resend instead
// of leaving the user stuck.
const RESEND_ELIGIBLE_KINDS = new Set<AuthErrorKind>(['rate_limited', 'duplicate_email', 'email_send_failed']);

export function SignUp() {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const [showResend, setShowResend] = useState(false);
  const [resendEmail, setResendEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const resendingRef = useRef(false);

  function offerResend(forEmail: string) {
    setShowResend(true);
    setResendEmail(forEmail);
    setResendMessage(null);
    setResendError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    // Synchronous ref check (not just the `submitting` state) so a rapid
    // double-tap can't slip a second signUp() through before React commits
    // the first setSubmitting(true) render.
    if (submittingRef.current) return;

    setError(null);
    setInfo(null);

    const trimmedUsername = username.trim();
    if (!USERNAME_PATTERN.test(trimmedUsername)) {
      setError('Username must be 3-20 characters: letters, numbers, "_" or "."');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    try {
      const { data: isAvailable, error: availabilityError } = await supabase.rpc('is_username_available', {
        p_username: trimmedUsername,
      });

      if (availabilityError) {
        setError(describeAuthError(availabilityError, 'sign-up:username-check').message);
        return;
      }

      if (!isAvailable) {
        setError('That username is already taken.');
        return;
      }

      const trimmedEmail = email.trim();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            username: trimmedUsername,
          },
        },
      });

      if (signUpError) {
        const { kind, message } = describeAuthError(signUpError, 'sign-up');
        setError(message);
        if (RESEND_ELIGIBLE_KINDS.has(kind)) {
          offerResend(trimmedEmail);
        }
        return;
      }

      if (data.session) {
        navigate('/home', { replace: true });
        return;
      }

      // Supabase's enumeration-safe behavior: signing up again with an
      // email that's already registered "succeeds" (no session, no error)
      // but returns a user with an empty identities array instead of
      // actually creating a second account.
      const alreadyRegistered = data.user && (data.user.identities?.length ?? 0) === 0;
      if (alreadyRegistered) {
        setError(AUTH_ERROR_MESSAGES.duplicate_email);
        offerResend(trimmedEmail);
        return;
      }

      setInfo('Account created! Check your email to confirm your address, then sign in.');
      offerResend(trimmedEmail);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (resendingRef.current || resendCooldown) return;

    const targetEmail = resendEmail.trim();
    if (!targetEmail) {
      setResendError('Enter the email you signed up with.');
      return;
    }

    resendingRef.current = true;
    setResending(true);
    setResendCooldown(true);
    setResendMessage(null);
    setResendError(null);

    try {
      const { error: resendErr } = await supabase.auth.resend({ type: 'signup', email: targetEmail });

      if (resendErr) {
        setResendError(describeAuthError(resendErr, 'resend-confirmation').message);
        return;
      }

      setResendMessage('Confirmation email sent. Check your inbox and spam folder.');
    } finally {
      resendingRef.current = false;
      setResending(false);
      window.setTimeout(() => setResendCooldown(false), RESEND_COOLDOWN_MS);
    }
  }

  return (
    <div className={`page ${styles.wrapper}`}>
      <h1>Sign Up</h1>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="firstName">First name</label>
          <input
            id="firstName"
            autoComplete="given-name"
            required
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="lastName">Last name</label>
          <input
            id="lastName"
            autoComplete="family-name"
            required
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
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
        <div className="field">
          <label htmlFor="password">Password</label>
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
        {error && <p className="error-text">{error}</p>}
        {info && <p className={styles['info-text']}>{info}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Sign Up'}
        </button>
      </form>

      {showResend && (
        <div className={styles.resend}>
          <p>Already created your account? Resend confirmation email.</p>
          <div className="field">
            <label htmlFor="resendEmail">Email</label>
            <input
              id="resendEmail"
              type="email"
              autoComplete="email"
              value={resendEmail}
              onChange={(event) => setResendEmail(event.target.value)}
            />
          </div>
          {resendError && <p className="error-text">{resendError}</p>}
          {resendMessage && <p className={styles['info-text']}>{resendMessage}</p>}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={resending || resendCooldown}
            onClick={() => void handleResend()}
          >
            {resending ? 'Sending…' : 'Resend Confirmation Email'}
          </button>
        </div>
      )}

      <p className={styles.switch}>
        Already have an account? <Link to="/sign-in">Sign In</Link>
      </p>
    </div>
  );
}
