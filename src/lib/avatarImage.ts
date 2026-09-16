// Dependency-free browser avatar pipeline: validate -> orientation-aware
// decode -> center crop to square -> resize -> WebP compression. Runs
// entirely client-side so we never store/transmit a full-resolution phone
// photo; the server-side bucket limits (0035) are a second, independent
// layer of enforcement, not a substitute for this.

export const AVATAR_SIZE = 512;
// A generous cap on the *source* file before we even attempt to decode it
// -- large enough to never bother a normal phone photo, small enough to
// fail fast on something absurd rather than hang the browser decoding it.
export const AVATAR_MAX_SOURCE_BYTES = 15 * 1024 * 1024;
export const AVATAR_OUTPUT_QUALITY = 0.85;
export const AVATAR_OUTPUT_TYPE = 'image/webp';

/**
 * Fast, pure checks on the raw file -- no decode attempt. Deliberately
 * permissive on the exact image subtype (checks the general "image/*"
 * shape rather than hand-maintaining a format whitelist): the browser's
 * own decode capability in processAvatarImage() is the real source of
 * truth for "can we actually use this file", since supported formats
 * differ across browsers (e.g. HEIC) in ways not worth duplicating here.
 */
export function validateAvatarFile(file: File): string | null {
  if (!file.type.startsWith('image/')) {
    return 'Please choose an image file.';
  }
  if (file.size > AVATAR_MAX_SOURCE_BYTES) {
    return 'That image is too large. Please choose a photo under 15 MB.';
  }
  return null;
}

/**
 * Decodes, orientation-corrects, center-crops to square, resizes to
 * AVATAR_SIZE, and re-encodes as WebP. Throws a user-safe Error message on
 * any failure (unreadable/unsupported file, canvas unsupported, encode
 * failure) -- callers show it directly rather than a raw browser error.
 */
export async function processAvatarImage(file: File): Promise<Blob> {
  const validationError = validateAvatarFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  let bitmap: ImageBitmap;
  try {
    // imageOrientation: 'from-image' is what actually applies the file's
    // EXIF orientation during decode -- without it, a photo taken in
    // portrait on an iPhone can decode sideways since the pixel data
    // itself is often stored landscape with an orientation tag.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("Couldn't read that image. Please try a different photo.");
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas is not supported in this browser.');
    }
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, AVATAR_OUTPUT_TYPE, AVATAR_OUTPUT_QUALITY));
    if (!blob) {
      throw new Error("Couldn't process that image. Please try a different photo.");
    }
    return blob;
  } finally {
    bitmap.close();
  }
}
