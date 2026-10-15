import { BadRequestException } from '@nestjs/common';

/** Most photos a menu item can have in its gallery (the featured photo is separate). */
export const MAX_GALLERY_IMAGES = 8;
const MAX_URL_LENGTH = 500;
/** Files uploaded through POST /uploads that a browser can show inline (HEIC is accepted by the upload but is download-only, so it is no photo for a menu). */
const UPLOAD_IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

/**
 * One photo address of a menu item: our own upload ("/uploads/<name>.jpg", relative or with the public host) or an https / http picture address.
 * Never data:, javascript:, file: or an address with a login in it. Returns the cleaned address; throws a 400 (INVALID_IMAGE_URL) otherwise.
 */
export function cleanImageUrl(value: unknown, field = 'imageUrl'): string {
  const bad = (why: string) =>
    new BadRequestException({ message: `${field}: ${why}`, code: 'INVALID_IMAGE_URL', details: { field } });
  if (typeof value !== 'string') throw bad('must be a text address');
  const s = value.trim();
  if (!s) throw bad('is empty');
  if (s.length > MAX_URL_LENGTH) throw bad(`is longer than ${MAX_URL_LENGTH} characters`);
  if (/[\s<>"'`\\]/.test(s)) throw bad('contains characters that are not allowed in an address');
  let path: string;
  if (s.startsWith('/uploads/')) {
    path = s.split(/[?#]/)[0];
    if (path.includes('..') || path.includes('//')) throw bad('is not a valid upload address');
  } else {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw bad('must be a picture uploaded here or an https:// address');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('must be a picture uploaded here or an https:// address');
    if (u.username || u.password) throw bad('must not contain a login');
    path = u.pathname;
  }
  // our own uploads: only formats every browser shows
  if (path.includes('/uploads/') && !UPLOAD_IMAGE_EXT.test(path)) throw bad('must be a JPG, PNG, WebP or GIF picture');
  return s;
}

/**
 * The gallery of an item: cleaned, without duplicates and without the featured photo (it is shown first anyway), at most MAX_GALLERY_IMAGES.
 * `featured` is the item's imageUrl after this change.
 */
export function cleanGallery(value: unknown, featured?: string | null): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequestException({ message: 'galleryUrls must be a list of picture addresses', code: 'INVALID_IMAGE_URL', details: { field: 'galleryUrls' } });
  const out: string[] = [];
  value.forEach((v, i) => {
    const url = cleanImageUrl(v, `galleryUrls[${i}]`);
    if (url !== featured && !out.includes(url)) out.push(url);
  });
  if (out.length > MAX_GALLERY_IMAGES) {
    throw new BadRequestException({ message: `A gallery holds at most ${MAX_GALLERY_IMAGES} photos`, code: 'TOO_MANY_IMAGES', details: { max: MAX_GALLERY_IMAGES } });
  }
  return out;
}
