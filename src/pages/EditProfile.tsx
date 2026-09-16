import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/useAuth';
import { useProfile } from '../hooks/useProfile';
import { Avatar } from '../components/Avatar';
import { uploadAvatar, deleteAvatar } from '../lib/avatarUpload';
import { validateAvatarFile } from '../lib/avatarImage';
import styles from './EditProfile.module.css';

/**
 * First/last name and avatar only -- username and email are deliberately
 * not editable here (see the Profile page docs). Save sequencing is chosen
 * so a failure partway through never leaves profiles.photo_path pointing
 * at something that doesn't exist, and a Storage hiccup on removal never
 * leaves the profile itself in a bad state:
 *   - new photo: upload to Storage FIRST, only write photo_path after that
 *     succeeds -- a failed upload never touches the profile row at all.
 *   - remove photo: clear photo_path FIRST (the profile is correct the
 *     instant this succeeds, regardless of what happens next), then
 *     best-effort delete the now-unreferenced Storage object -- if that
 *     delete fails, the object is simply overwritten by this same user's
 *     next upload (fixed path), never surfaced as a user-facing error.
 */
export function EditProfile() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: profile, isLoading } = useProfile();

  const [hydrated, setHydrated] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (profile && !hydrated) {
      setFirstName(profile.first_name);
      setLastName(profile.last_name);
      setHydrated(true);
    }
  }, [profile, hydrated]);

  // Never leak the object URL, whether the user saves, cancels, or just
  // navigates away.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = ''; // lets the same file be re-picked later if removed and re-added
    if (!file) return;

    const validationError = validateAvatarFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setRemovePhoto(false);
    setPendingFile(file);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  function handleRemovePhoto() {
    setPendingFile(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRemovePhoto(true);
  }

  function handleCancel() {
    navigate('/profile');
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!user) return;

    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (!trimmedFirst || !trimmedLast) {
      setError('First and last name are required.');
      return;
    }

    setError(null);
    setSaving(true);

    try {
      const oldPhotoPath = profile?.photo_path ?? null;

      if (pendingFile) {
        const path = await uploadAvatar(user.id, pendingFile);
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ first_name: trimmedFirst, last_name: trimmedLast, photo_path: path })
          .eq('id', user.id);
        if (updateError) throw updateError;
      } else if (removePhoto && oldPhotoPath) {
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ first_name: trimmedFirst, last_name: trimmedLast, photo_path: null })
          .eq('id', user.id);
        if (updateError) throw updateError;

        try {
          await deleteAvatar(user.id);
        } catch (storageErr) {
          // Non-fatal: the profile already correctly reads as "no photo".
          // A stray object left behind here is self-healing -- it sits at
          // this same user's one fixed path and is simply overwritten the
          // next time they upload a new photo.
          console.error('avatar delete failed after clearing photo_path', storageErr);
        }
      } else {
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ first_name: trimmedFirst, last_name: trimmedLast })
          .eq('id', user.id);
        if (updateError) throw updateError;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profile', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['avatar-url', oldPhotoPath] }),
        queryClient.invalidateQueries({ queryKey: ['members'] }),
        queryClient.invalidateQueries({ queryKey: ['public-round-feed'] }),
        queryClient.invalidateQueries({ queryKey: ['tournament-roster-full'] }),
        queryClient.invalidateQueries({ queryKey: ['tournament-roster'] }),
        queryClient.invalidateQueries({ queryKey: ['tournament-teams'] }),
      ]);

      navigate('/profile', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !hydrated) {
    return <div className="page-status">Loading…</div>;
  }

  const hasPhotoShowing = !!previewUrl || (!!profile?.photo_path && !removePhoto);

  return (
    <div>
      <h1>Edit Profile</h1>

      <div className={styles.photoSection}>
        {previewUrl ? (
          <img src={previewUrl} alt="" className={styles.preview} />
        ) : (
          <Avatar name={`${firstName} ${lastName}`} photoPath={removePhoto ? null : (profile?.photo_path ?? null)} size="large" />
        )}
        <div className={styles.photoActions}>
          <button
            type="button"
            className="btn btn-secondary btn-small btn-auto"
            onClick={() => fileInputRef.current?.click()}
          >
            Change Photo
          </button>
          {hasPhotoShowing && (
            <button type="button" className="btn btn-text btn-auto" onClick={handleRemovePhoto}>
              Remove Photo
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className={styles.hiddenInput}
          onChange={handleFileChange}
          aria-label="Choose profile photo"
        />
      </div>

      <form onSubmit={(event) => void handleSave(event)}>
        <div className="field">
          <label htmlFor="editFirstName">First name</label>
          <input id="editFirstName" required value={firstName} onChange={(event) => setFirstName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="editLastName">Last name</label>
          <input id="editLastName" required value={lastName} onChange={(event) => setLastName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="editUsername">Username</label>
          <input id="editUsername" value={profile?.username ?? ''} disabled readOnly />
        </div>

        {error && <p className="error-text">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={handleCancel}>
          Cancel
        </button>
      </form>
    </div>
  );
}
