import { invoke } from '@tauri-apps/api/core';
import type { ConflictResolution, SyncConflict, SyncLogEntry, SyncPair, SyncSettings, SyncStatus } from '../types/sync';

export const getSyncSettings = () => invoke<SyncSettings>('cmd_get_sync_settings');
export const toggleSync = (enabled: boolean) => invoke<SyncSettings>('cmd_toggle_sync', { enabled });
export const getSyncPairs = () => invoke<SyncPair[]>('cmd_get_sync_pairs');
export const addSyncPair = (localPath: string, channelId: number, label?: string) => invoke<SyncPair>('cmd_add_sync_pair', {
  localPath,
  channelId,
  label,
  syncDirection: 'bidirectional',
});
export const removeSyncPair = (pairId: number) => invoke<void>('cmd_remove_sync_pair', { pairId });
export const getSyncStatus = () => invoke<SyncStatus>('cmd_get_sync_status');
export const getSyncConflicts = () => invoke<SyncConflict[]>('cmd_get_sync_conflicts');
export const getSyncLog = (limit = 100) => invoke<SyncLogEntry[]>('cmd_get_sync_log', { limit });
export const resolveSyncConflict = (pairId: number, path: string, resolution: ConflictResolution) => invoke<void>('cmd_resolve_conflict', {
  pairId,
  path,
  resolution,
});
