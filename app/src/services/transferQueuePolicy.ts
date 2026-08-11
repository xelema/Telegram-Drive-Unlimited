import type { DownloadItem, QueueItem } from '../types';

const ACTIVE_UPLOAD_STATUSES = new Set<QueueItem['status']>([
  'pending',
  'paused',
  'uploading',
  'downloading',
  'encrypting',
  'verifying',
  'waiting_for_unlock',
]);

const ACTIVE_DOWNLOAD_STATUSES = new Set<DownloadItem['status']>([
  'pending',
  'paused',
  'cooldown',
  'downloading',
  'decrypting',
  'verifying',
  'waiting_for_unlock',
]);

function withoutUploadPromptToken(item: QueueItem): QueueItem {
  return {
    ...item,
    protection: item.protection ? { ...item.protection, promptToken: undefined } : undefined,
  };
}

export function restoreUploadQueue(saved: QueueItem[]): QueueItem[] {
  return saved
    .filter(item => ACTIVE_UPLOAD_STATUSES.has(item.status))
    .map(item => ({
      ...withoutUploadPromptToken(item),
      status: item.status === 'paused'
        ? 'paused'
        : item.protection?.mode === 'passphrase' || item.protection?.mode === 'vault_and_passphrase'
          ? 'waiting_for_unlock'
          : 'pending',
    }));
}

export function serializeUploadQueue(queue: QueueItem[]): QueueItem[] {
  return queue
    .filter(item => ACTIVE_UPLOAD_STATUSES.has(item.status))
    .map(item => ({
      ...withoutUploadPromptToken(item),
      status: item.status === 'waiting_for_unlock' || item.status === 'paused' ? item.status : 'pending',
    }));
}

function sanitizeDownloadItem(item: DownloadItem): DownloadItem {
  const preserveStatus = item.status === 'waiting_for_unlock' || item.status === 'paused';
  return {
    ...item,
    status: preserveStatus ? item.status : 'pending',
    promptToken: undefined,
  };
}

export function restoreDownloadQueue(saved: DownloadItem[]): DownloadItem[] {
  return saved
    .filter(item => ACTIVE_DOWNLOAD_STATUSES.has(item.status))
    .map(sanitizeDownloadItem);
}

export function serializeDownloadQueue(queue: DownloadItem[]): DownloadItem[] {
  return queue
    .filter(item => ACTIVE_DOWNLOAD_STATUSES.has(item.status))
    .map(sanitizeDownloadItem);
}
