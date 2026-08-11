import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcodeCacheErrorMessage, withTimeout } from '../../src/services/transcodeCacheClient';

afterEach(() => vi.useRealTimers());

describe('transcode cache client', () => {
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
