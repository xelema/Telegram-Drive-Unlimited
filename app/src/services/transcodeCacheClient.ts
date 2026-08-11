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

export function getDetailedTranscodeCache(): Promise<DetailedCacheInfo> {
  return withTimeout(
    invoke<DetailedCacheInfo>('cmd_get_detailed_transcode_cache'),
    TRANSCODE_CACHE_TIMEOUT_MS,
    'The transcode cache did not respond within 12 seconds.',
  );
}

export function transcodeCacheErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
