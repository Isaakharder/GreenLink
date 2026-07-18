import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import styles from './AuthForm.module.css';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,20}$/;

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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);

    const trimmedUsername = username.trim();
    if (!USERNAME_PATTERN.test(trimmedUsername)) {
      setError('Username must be 3-20 characters: letters, numbers, "_" or "."');
      return;
    }

    setSubmitting(true);

    const { data: isAvailable, error: availabilityError } = await supabase.rpc('is_username_available', {
      p_username: trimmedUsername,
    });

    if (availabilityError) {
      setSubmitting(false);
      setError(availabilityError.message);
      return;
    }

    if (!isAvailable) {
      setSubmitting(false);
      setError('That username is already taken.');
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          username: trimmedUsername,
        },
      },
    });

    setSubmitting(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    if (data.session) {
      navigate('/home', { replace: true });
    } else {
      setInfo('Account created! Check your email to confirm your address, then sign in.');
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
      <p className={styles.switch}>
        Already have an account? <Link to="/sign-in">Sign In</Link>
      </p>
    </div>
  );
}
