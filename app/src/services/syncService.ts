import { invoke } from '@tauri-apps/api/core';
import type { ConflictResolution, SyncConflict, SyncLogEntry, SyncPair, SyncPairSaveOptions, SyncPreview, SyncPreviewRequest, SyncSettings, SyncStatus } from '../types/sync';

export const getSyncSettings = (ownerId: string) => invoke<SyncSettings>('cmd_get_sync_settings', { ownerId });
export const toggleSync = (enabled: boolean, ownerId: string) => invoke<SyncSettings>('cmd_toggle_sync', { enabled, ownerId });
export const getSyncPairs = (ownerId: string) => invoke<SyncPair[]>('cmd_get_sync_pairs', { ownerId });
export const addSyncPair = (localPath: string, channelId: number, label: string | undefined, options: SyncPairSaveOptions, ownerId: string) => invoke<SyncPair>('cmd_add_sync_pair', {
  localPath,
  channelId,
  label,
  ...options,
  ownerId,
});
export const previewSyncPair = (request: SyncPreviewRequest, ownerId: string) => invoke<SyncPreview>('cmd_preview_sync_pair', { request, ownerId });
export const updateSyncPair = (request: SyncPreviewRequest, previewToken: string, isActive: boolean, ownerId: string) => invoke<SyncPair>('cmd_update_sync_pair', { request, previewToken, isActive, ownerId });
export const setSyncPairActive = (pairId: number, isActive: boolean, ownerId: string) => invoke<void>('cmd_set_sync_pair_active', { pairId, isActive, ownerId });
export const removeSyncPair = (pairId: number, ownerId: string) => invoke<void>('cmd_remove_sync_pair', { pairId, ownerId });
export const getSyncStatus = (ownerId: string) => invoke<SyncStatus>('cmd_get_sync_status', { ownerId });
export const getSyncConflicts = (ownerId: string) => invoke<SyncConflict[]>('cmd_get_sync_conflicts', { ownerId });
export const getSyncLog = (ownerId: string, limit = 100) => invoke<SyncLogEntry[]>('cmd_get_sync_log', { limit, ownerId });
export const resolveSyncConflict = (pairId: number, path: string, resolution: ConflictResolution, ownerId: string) => invoke<void>('cmd_resolve_conflict', {
  pairId,
  path,
  resolution,
  ownerId,
});
