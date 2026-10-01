import type { DownloadItem, QueueItem } from '../types';

const ACTIVE_UPLOAD_STATUSES = new Set<QueueItem['status']>([
  'pending',
  'paused',
  'waiting_for_network',
  'uploading',
  'downloading',
  'encrypting',
  'verifying',
  'waiting_for_unlock',
  'error',
]);

const ACTIVE_DOWNLOAD_STATUSES = new Set<DownloadItem['status']>([
  'pending',
  'paused',
  'waiting_for_network',
  'cooldown',
  'downloading',
  'decrypting',
  'verifying',
  'waiting_for_unlock',
  'error',
]);

function withoutUploadPromptToken(item: QueueItem): QueueItem {
  return {
    ...item,
    protection: item.protection ? { ...item.protection, promptToken: undefined } : undefined,
  };
}

export function restoreUploadQueue(saved: QueueItem[], retainFailedItems = false): QueueItem[] {
  return saved
    .filter(item => ACTIVE_UPLOAD_STATUSES.has(item.status) && (retainFailedItems || item.status !== 'error'))
    .map(item => ({
      ...withoutUploadPromptToken(item),
      status: restoredUploadStatus(item),
    }));
}

function restoredUploadStatus(item: QueueItem): QueueItem['status'] {
  if (['paused', 'waiting_for_network', 'error'].includes(item.status)) return item.status;
  if (item.protection?.mode === 'passphrase' || item.protection?.mode === 'vault_and_passphrase') {
    return 'waiting_for_unlock';
  }
  return 'pending';
}

export function serializeUploadQueue(queue: QueueItem[], retainFailedItems = false): QueueItem[] {
  return queue
    .filter(item => ACTIVE_UPLOAD_STATUSES.has(item.status) && (retainFailedItems || item.status !== 'error'))
    .map(item => ({
      ...withoutUploadPromptToken(item),
      status: ['waiting_for_unlock', 'waiting_for_network', 'paused', 'error'].includes(item.status)
        ? item.status
        : 'pending',
    }));
}

function sanitizeDownloadItem(item: DownloadItem): DownloadItem {
  const preserveStatus = ['waiting_for_unlock', 'waiting_for_network', 'paused', 'error'].includes(item.status);
  return {
    ...item,
    status: preserveStatus ? item.status : 'pending',
    promptToken: undefined,
  };
}

export function isTransientNetworkError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return [
    'failed to fetch',
    'network',
    'connection',
    'timed out',
    'timeout',
    'temporarily unavailable',
    'socket',
    'broken pipe',
    'unreachable',
    'dns',
    'early eof',
    'transport error',
    'i/o error',
  ].some(fragment => message.includes(fragment));
}

export function restoreDownloadQueue(saved: DownloadItem[], retainFailedItems = false): DownloadItem[] {
  return saved
    .filter(item => ACTIVE_DOWNLOAD_STATUSES.has(item.status) && (retainFailedItems || item.status !== 'error'))
    .map(sanitizeDownloadItem);
}

export function serializeDownloadQueue(queue: DownloadItem[], retainFailedItems = false): DownloadItem[] {
  return queue
    .filter(item => ACTIVE_DOWNLOAD_STATUSES.has(item.status) && (retainFailedItems || item.status !== 'error'))
    .map(sanitizeDownloadItem);
}
