import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceFile } from './workspace';
import { normalizeListedFile } from './fileListRefresh';

export type OfflineItemStatus = 'pending' | 'downloading' | 'ready' | 'error' | 'unsupported' | 'cancelled' | 'expired';
export type OfflinePackStatus = 'paused' | 'queued' | 'running' | 'waiting' | 'ready' | 'error' | 'cancelled' | 'expired';
export interface OfflinePackItem { file: WorkspaceFile; status: OfflineItemStatus; downloadedBytes: number; error: string | null }
export interface OfflinePack {
  id: string; ownerId: string; name: string; wifiOnly: boolean; expiresAt: number | null;
  createdAt: number; updatedAt: number; status: OfflinePackStatus; waitingReason: string | null;
  autoResume: boolean; activeRun: string | null; files: OfflinePackItem[];
}
export interface OfflinePackSnapshot {
  ownerId: string; packs: OfflinePack[]; freeBytes: number; reserveBytes: number;
  network: { known: boolean; connected: boolean; wifi: boolean };
}
export type OfflinePackAction = 'start' | 'pause' | 'cancel' | 'retry' | 'remove' | 'retry_file' | 'cancel_file';

function normalize(pack: OfflinePack, ownerId: string): OfflinePack {
  if (pack.ownerId !== ownerId) throw new Error('ACCOUNT_CHANGED');
  return { ...pack, files: pack.files.map(item => ({ ...item, file: { ...item.file, ...normalizeListedFile(item.file) } })) };
}
export async function readOfflinePacks(ownerId: string): Promise<OfflinePackSnapshot> {
  const result = await invoke<OfflinePackSnapshot>('cmd_offline_packs_list', { ownerId });
  if (result.ownerId !== ownerId) throw new Error('ACCOUNT_CHANGED');
  return { ...result, packs: result.packs.map(pack => normalize(pack, ownerId)) };
}
export async function createOfflinePack(ownerId: string, name: string, files: WorkspaceFile[], wifiOnly: boolean, expiresAt: number | null): Promise<OfflinePack> {
  return normalize(await invoke<OfflinePack>('cmd_offline_pack_create', { ownerId, name, fileKeys: [...new Set(files.map(file => file.key))], wifiOnly, expiresAt }), ownerId);
}
export async function actOnOfflinePack(ownerId: string, packId: string, action: OfflinePackAction, fileKey?: string): Promise<OfflinePack | null> {
  const result = await invoke<OfflinePack | null>('cmd_offline_pack_action', { ownerId, packId, action, fileKey: fileKey ?? null });
  return result ? normalize(result, ownerId) : null;
}
export function offlinePackPath(ownerId: string, packId: string, fileKey: string): Promise<string> {
  return invoke('cmd_offline_pack_path', { ownerId, packId, fileKey });
}
export function offlinePackTotals(pack: OfflinePack): { totalBytes: number; downloadedBytes: number; readyFiles: number; totalFiles: number; requiredBytes: number } {
  return pack.files.reduce((total, item) => ({
    totalBytes: total.totalBytes + item.file.size,
    downloadedBytes: total.downloadedBytes + (item.status === 'ready' ? item.file.size : Math.min(item.file.size, Math.max(0, item.downloadedBytes))),
    readyFiles: total.readyFiles + Number(item.status === 'ready'),
    totalFiles: total.totalFiles + 1,
    requiredBytes: total.requiredBytes + (['ready', 'unsupported', 'expired'].includes(item.status) ? 0 : item.file.size),
  }), { totalBytes: 0, downloadedBytes: 0, readyFiles: 0, totalFiles: 0, requiredBytes: 0 });
}

/** English defaults are merged into the locale catalog by the workspace UI. */
export const offlinePackMessages = {
  title: 'Offline trip packs', description: 'Keep a complete selection on this device before you travel.',
  default_name: 'My trip', name: 'Pack name', selection: '{{count}} selected files · {{size}} required',
  select_files: 'Select files or a whole collection in your library to create a pack.',
  free_space: '{{size}} free · {{reserve}} reserved for the device', wifi_only: 'Download on Wi-Fi only',
  expires: 'Remove this device copy after', never: 'Keep until I remove it', days: '{{count}} days',
  expiry_note: 'Expired packs are removed while the app is running or the next time you open it.',
  download: 'Create and download pack', creating: 'Creating pack…', selected_list: 'Review selected files',
  progress: '{{ready}} of {{count}} files ready · {{size}} saved', remaining: '{{size}} still needed',
  no_packs: 'No trip packs yet.', ready_note: 'Ready files open from this device without contacting Telegram.',
  resume_note: 'Completed files survive restarting the app. Interrupted files retry from the beginning.',
  low_space: 'There is not enough free space for this selection. You can create the pack now and free space before downloading.',
  protected_note: 'Protected files remain visible as unavailable; export them from your unlocked vault before travelling.',
  start: 'Download', resume: 'Resume', pause: 'Pause', cancel: 'Cancel downloads', retry: 'Retry unfinished files',
  remove: 'Remove device pack', remove_title: 'Remove this device pack?', remove_description: 'This removes the pack’s downloaded copies. Telegram originals and other packs stay available.',
  remove_confirm: 'Remove pack', back: 'Keep pack', open: 'Open offline', file_retry: 'Retry file', file_cancel: 'Cancel file',
  files: 'Show files', load_more: 'Show more files', expires_at: 'Expires {{date}}',
  waiting_wifi: 'Waiting for Wi-Fi', waiting_network: 'Waiting for a network connection', waiting_storage: 'Waiting for more free device storage',
  network_unknown: 'The active network could not be verified. Check your connection and retry.',
  error: 'The pack could not be updated. Retry after checking the account, connection and device storage.',
  paused: 'Paused', queued: 'Queued', running: 'Downloading', waiting: 'Waiting', ready: 'Ready offline',
  cancelled: 'Downloads cancelled', expired: 'Expired', pending: 'Pending', downloading: 'Downloading', unsupported: 'Protected file unavailable',
  failed: 'Needs attention',
} as const;
