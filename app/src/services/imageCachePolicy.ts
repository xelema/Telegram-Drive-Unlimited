export const IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
export const PREVIEW_CACHE_MAX_ITEMS = 16;
export const THUMBNAIL_CACHE_MAX_ITEMS = 256;

export function isImageCacheEntryExpired(cachedAt: number, now = Date.now()): boolean {
  return now - cachedAt > IMAGE_CACHE_TTL_MS;
}
