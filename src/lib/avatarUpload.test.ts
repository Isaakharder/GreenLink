import { describe, expect, it } from 'vitest';
import { avatarStoragePath } from './avatarUpload';

describe('avatarStoragePath', () => {
  it('is the one deterministic path a given user\'s avatar always lives at', () => {
    expect(avatarStoragePath('11111111-1111-1111-1111-111111111111')).toBe('11111111-1111-1111-1111-111111111111/avatar.webp');
  });

  it('is stable across repeated calls for the same user -- replace/remove rely on this never drifting', () => {
    const userId = '22222222-2222-2222-2222-222222222222';
    expect(avatarStoragePath(userId)).toBe(avatarStoragePath(userId));
  });

  it('differs between users', () => {
    expect(avatarStoragePath('user-a')).not.toBe(avatarStoragePath('user-b'));
  });
});
