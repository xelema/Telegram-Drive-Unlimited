import { invoke } from '@tauri-apps/api/core';
import type { DetailedCacheInfo } from '../types';

export const TRANSCODE_CACHE_TIMEOUT_MS = 12_000;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function getDetailedTranscodeCache(refresh = false): Promise<DetailedCacheInfo> {
  // The native command returns its most recent inventory snapshot immediately.
  // Filesystem reconciliation is single-flight background work, so a frontend
  // deadline would only mislabel a healthy but large cache as failed.
  return invoke<DetailedCacheInfo>('cmd_get_detailed_transcode_cache', { refresh });
}

export function transcodeCacheErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
