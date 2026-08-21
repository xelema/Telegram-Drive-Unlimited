import { describe, expect, it } from 'vitest';
import {
  restoreDownloadQueue,
  restoreUploadQueue,
  isTransientNetworkError,
  serializeDownloadQueue,
  serializeUploadQueue,
} from '../../src/services/transferQueuePolicy';
import type { DownloadItem, QueueItem } from '../../src/types';

const upload = (status: QueueItem['status'], mode: 'standard' | 'passphrase' = 'standard'): QueueItem => ({
  id: status,
  path: `/tmp/${status}`,
  folderId: null,
  status,
  protection: { mode, promptToken: 42 },
});

const download = (status: DownloadItem['status']): DownloadItem => ({
  id: status,
  messageId: 1,
  filename: `${status}.bin`,
  folderId: null,
  status,
  promptToken: 42,
});

describe('upload queue persistence', () => {
  it('restores active items and requires passphrases again', () => {
    const restored = restoreUploadQueue([
      upload('uploading'),
      upload('paused'),
      upload('uploading', 'passphrase'),
      upload('success'),
    ]);
    expect(restored.map(item => item.status)).toEqual(['pending', 'paused', 'waiting_for_unlock']);
    expect(restored.every(item => item.protection?.promptToken === undefined)).toBe(true);
  });

  it('serializes only resumable work', () => {
    expect(serializeUploadQueue([upload('verifying'), upload('error')], true).map(item => item.status)).toEqual(['pending', 'error']);
  });

  it('keeps the existing desktop policy of dropping failed items', () => {
    expect(serializeUploadQueue([upload('error')])).toEqual([]);
  });

  it('keeps Android network waits recoverable across process recreation', () => {
    expect(restoreUploadQueue([upload('waiting_for_network')])[0].status).toBe('waiting_for_network');
  });
});

describe('download queue persistence', () => {
  it('normalizes in-flight work and removes prompt tokens', () => {
    const restored = restoreDownloadQueue([download('downloading'), download('paused'), download('waiting_for_unlock'), download('success')]);
    expect(restored.map(item => item.status)).toEqual(['pending', 'paused', 'waiting_for_unlock']);
    expect(restored.every(item => item.promptToken === undefined)).toBe(true);
  });

  it('keeps cooldown work resumable as pending', () => {
    expect(serializeDownloadQueue([download('cooldown')])[0].status).toBe('pending');
  });

  it('retains failed and network-waiting downloads for explicit or automatic retry', () => {
    expect(restoreDownloadQueue([download('error'), download('waiting_for_network')], true).map(item => item.status))
      .toEqual(['error', 'waiting_for_network']);
  });

  it('keeps the existing desktop policy of dropping failed downloads', () => {
    expect(restoreDownloadQueue([download('error')])).toEqual([]);
  });
});

describe('network failure classification', () => {
  it('recognizes transient transport failures without treating application errors as offline', () => {
    expect(isTransientNetworkError('TypeError: Failed to Fetch')).toBe(true);
    expect(isTransientNetworkError('connection reset by peer')).toBe(true);
    expect(isTransientNetworkError('DNS lookup failed: host unreachable')).toBe(true);
    expect(isTransientNetworkError('FILE_TOO_BIG')).toBe(false);
  });
});
