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

/** Canonical catalogs own all presentation copy; this union has no English fallback. */
export type OfflinePackMessageKey =
  | 'title'
  | 'description'
  | 'default_name'
  | 'name'
  | 'selection'
  | 'select_files'
  | 'free_space'
  | 'wifi_only'
  | 'expires'
  | 'never'
  | 'days'
  | 'expiry_note'
  | 'download'
  | 'creating'
  | 'selected_list'
  | 'progress'
  | 'remaining'
  | 'no_packs'
  | 'ready_note'
  | 'resume_note'
  | 'low_space'
  | 'protected_note'
  | 'start'
  | 'resume'
  | 'pause'
  | 'cancel'
  | 'retry'
  | 'remove'
  | 'remove_title'
  | 'remove_description'
  | 'remove_confirm'
  | 'back'
  | 'open'
  | 'file_retry'
  | 'file_cancel'
  | 'files'
  | 'load_more'
  | 'expires_at'
  | 'waiting_wifi'
  | 'waiting_network'
  | 'waiting_storage'
  | 'network_unknown'
  | 'error'
  | 'paused'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'ready'
  | 'cancelled'
  | 'expired'
  | 'pending'
  | 'downloading'
  | 'unsupported'
  | 'failed';
