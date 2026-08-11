import { describe, expect, it } from 'vitest';
import {
  restoreDownloadQueue,
  restoreUploadQueue,
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
    expect(serializeUploadQueue([upload('verifying'), upload('error')]).map(item => item.status)).toEqual(['pending']);
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
});
