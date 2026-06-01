import { VideoTrackInfo } from '../types';

const DB_NAME = 'telegramic_moov_cache';
const DB_VERSION = 1;
const STORE_NAME = 'moov_metadata';
const MAX_ENTRIES = 50;

interface CacheEntry {
    tracks: VideoTrackInfo[];
    timestamp: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB not available'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });

    return dbPromise;
}

/**
 * Attempts to read cached moov metadata (track info) from IndexedDB.
 * Returns null if no cache entry exists or on any error.
 */
export async function getCachedMoov(key: string): Promise<VideoTrackInfo[] | null> {
    try {
        const db = await openDb();
        return new Promise<VideoTrackInfo[] | null>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => {
                const result = request.result;
                if (result && Array.isArray((result as CacheEntry).tracks)) {
                    resolve((result as CacheEntry).tracks);
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    } catch {
        return null;
    }
}

/**
 * Stores parsed moov metadata (track info) in IndexedDB.
 * Best-effort; failures are silently ignored.
 * Enforces a MAX_ENTRIES limit by evicting the oldest entry when full.
 */
export async function setCachedMoov(key: string, tracks: VideoTrackInfo[]): Promise<void> {
    try {
        const db = await openDb();
        return new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);

                const entry: CacheEntry = { tracks, timestamp: Date.now() };
                store.put(entry, key);

                // Evict oldest entries if over the limit
                const countReq = store.count();
                countReq.onsuccess = () => {
                    const count = countReq.result;
                    if (count > MAX_ENTRIES) {
                        evictOldest(store, count - MAX_ENTRIES);
                    }
                };

                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    } catch {
        // best-effort
    }
}

/**
 * Delete the oldest `count` entries from the store (LRU eviction).
 */
function evictOldest(store: IDBObjectStore, count: number): void {
    const entries: Array<{ key: IDBValidKey; timestamp: number }> = [];
    const cursorReq = store.openCursor();

    cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
            const entry = cursor.value as CacheEntry;
            entries.push({ key: cursor.key, timestamp: entry.timestamp ?? 0 });
            cursor.continue();
        } else {
            // Sort by timestamp ascending (oldest first)
            entries.sort((a, b) => a.timestamp - b.timestamp);
            // Delete the oldest `count` entries
            for (let i = 0; i < Math.min(count, entries.length); i++) {
                store.delete(entries[i].key);
            }
        }
    };
}

/**
 * Extracts a stable cache key from the stream URL.
 * Pattern: .../stream/{folderId}/{messageId}?token=...
 * Returns `{folderId}:{messageId}` or null if extraction fails.
 */
export function extractCacheKey(streamUrl: string): string | null {
    try {
        const url = new URL(streamUrl);
        const parts = url.pathname.split('/').filter(Boolean);
        const streamIdx = parts.indexOf('stream');
        if (streamIdx === -1 || streamIdx + 2 >= parts.length) return null;

        const folderId = parts[streamIdx + 1];
        const messageId = parts[streamIdx + 2];
        if (!folderId || !messageId) return null;

        return `${folderId}:${messageId}`;
    } catch {
        return null;
    }
}
