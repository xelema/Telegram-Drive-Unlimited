import { afterEach, describe, expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { getDetailedTranscodeCache, transcodeCacheErrorMessage, withTimeout } from '../../src/services/transcodeCacheClient';

afterEach(() => vi.useRealTimers());

describe('transcode cache client', () => {
  it('requests an immediate native snapshot and forwards explicit refresh intent', async () => {
    const snapshot = {
      entries: [], total_bytes: 0, max_bytes: 1,
      scan_in_progress: true, last_scanned_at: null, last_error: null,
    };
    invokeMock.mockResolvedValueOnce(snapshot);
    await expect(getDetailedTranscodeCache(true)).resolves.toBe(snapshot);
    expect(invokeMock).toHaveBeenCalledWith('cmd_get_detailed_transcode_cache', { refresh: true });
  });

  it('returns a cache response before the deadline', async () => {
    await expect(withTimeout(Promise.resolve({ total_bytes: 0 }), 100, 'timed out')).resolves.toEqual({ total_bytes: 0 });
  });

  it('rejects a cache request that never responds', async () => {
    vi.useFakeTimers();
    const request = withTimeout(new Promise<never>(() => {}), 100, 'cache timed out');
    const rejection = expect(request).rejects.toThrow('cache timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });

  it('normalizes native and JavaScript errors for display', () => {
    expect(transcodeCacheErrorMessage(new Error('locked'))).toBe('locked');
    expect(transcodeCacheErrorMessage('command unavailable')).toBe('command unavailable');
  });
});
