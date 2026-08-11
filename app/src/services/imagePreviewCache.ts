import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import {
    isImageCacheEntryExpired,
    PREVIEW_CACHE_MAX_ITEMS,
    THUMBNAIL_CACHE_MAX_ITEMS,
} from './imageCachePolicy';

type CacheEntry = {
    src: string;
    cachedAt: number;
};

const previewCache = new Map<string, CacheEntry>();
const thumbnailCache = new Map<string, CacheEntry>();
const pendingPreviews = new Map<string, Promise<string | null>>();
const pendingThumbnails = new Map<string, Promise<string | null>>();

export const getImageCacheKey = (fileId: number, folderId?: number | null): string =>
    `${folderId ?? 'home'}:${fileId}`;

const normalizeAssetSource = (value: string): string => {
    if (/^(?:data:|blob:|asset:|https?:)/i.test(value)) return value;
    return convertFileSrc(value);
};

const remember = (cache: Map<string, CacheEntry>, key: string, src: string, maxItems: number): void => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { src, cachedAt: Date.now() });
    while (cache.size > maxItems) {
        const oldestKey = cache.keys().next().value;
        if (!oldestKey) break;
        cache.delete(oldestKey);
    }
};

const read = (cache: Map<string, CacheEntry>, key: string, maxItems: number): string | null => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (isImageCacheEntryExpired(entry.cachedAt)) {
        cache.delete(key);
        return null;
    }
    remember(cache, key, entry.src, maxItems);
    return entry.src;
};

const load = (
    command: 'cmd_get_preview' | 'cmd_get_thumbnail',
    fileId: number,
    folderId: number | null | undefined,
    cache: Map<string, CacheEntry>,
    pending: Map<string, Promise<string | null>>,
    maxItems: number,
): Promise<string | null> => {
    const key = getImageCacheKey(fileId, folderId);
    const cached = read(cache, key, maxItems);
    if (cached) return Promise.resolve(cached);

    const existing = pending.get(key);
    if (existing) return existing;

    const request = invoke<string>(command, {
        messageId: fileId,
        folderId: folderId ?? null,
    }).then((path) => {
        if (!path) return null;
        const src = normalizeAssetSource(path);
        remember(cache, key, src, maxItems);
        return src;
    }).finally(() => {
        pending.delete(key);
    });
    pending.set(key, request);
    return request;
};

export const getCachedPreview = (fileId: number, folderId?: number | null): string | null =>
    read(previewCache, getImageCacheKey(fileId, folderId), PREVIEW_CACHE_MAX_ITEMS);

export const getCachedThumbnail = (fileId: number, folderId?: number | null): string | null =>
    read(thumbnailCache, getImageCacheKey(fileId, folderId), THUMBNAIL_CACHE_MAX_ITEMS);

export const loadPreview = (fileId: number, folderId?: number | null): Promise<string | null> =>
    load('cmd_get_preview', fileId, folderId, previewCache, pendingPreviews, PREVIEW_CACHE_MAX_ITEMS);

export const loadThumbnail = (fileId: number, folderId?: number | null): Promise<string | null> =>
    load('cmd_get_thumbnail', fileId, folderId, thumbnailCache, pendingThumbnails, THUMBNAIL_CACHE_MAX_ITEMS);

export const forgetPreview = (fileId: number, folderId?: number | null): void => {
    previewCache.delete(getImageCacheKey(fileId, folderId));
};

export const forgetThumbnail = (fileId: number, folderId?: number | null): void => {
    thumbnailCache.delete(getImageCacheKey(fileId, folderId));
};

export const clearImageMemoryCaches = (): void => {
    previewCache.clear();
    thumbnailCache.clear();
};
