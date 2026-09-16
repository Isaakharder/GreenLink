import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_SOURCE_BYTES, validateAvatarFile } from './avatarImage';

function fakeFile(type: string, size: number): File {
  // A real Blob of this exact size, so `.size` reflects it accurately --
  // cheaper than actually allocating `size` bytes of content.
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], 'photo', { type });
}

describe('validateAvatarFile', () => {
  it('accepts a normal-sized JPEG', () => {
    expect(validateAvatarFile(fakeFile('image/jpeg', 2 * 1024 * 1024))).toBeNull();
  });

  it('accepts PNG and WebP too -- not limited to one subtype', () => {
    expect(validateAvatarFile(fakeFile('image/png', 1024))).toBeNull();
    expect(validateAvatarFile(fakeFile('image/webp', 1024))).toBeNull();
  });

  it('rejects a non-image file', () => {
    expect(validateAvatarFile(fakeFile('application/pdf', 1024))).toMatch(/image file/i);
  });

  it('rejects a file at or over the size cap', () => {
    expect(validateAvatarFile(fakeFile('image/jpeg', AVATAR_MAX_SOURCE_BYTES + 1))).toMatch(/too large/i);
  });

  it('accepts a file exactly at the size cap', () => {
    expect(validateAvatarFile(fakeFile('image/jpeg', AVATAR_MAX_SOURCE_BYTES))).toBeNull();
  });
});
