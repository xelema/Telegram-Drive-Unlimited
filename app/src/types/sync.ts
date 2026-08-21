export interface SyncSettings {
  enabled: boolean;
  debounceMs: number;
  encryption: 'inherit' | 'always_vault' | string;
}

export interface SyncPair {
  id: number;
  localPath: string;
  channelId: number;
  folderKey: string;
  label: string | null;
  syncDirection: 'bidirectional' | 'upload_only' | 'download_only';
  isActive: boolean;
  createdAt: number;
}

export interface SyncStatus {
  enabled: boolean;
  running: boolean;
  activePairs: number;
  pendingOps: number;
  conflicts: number;
  lastError: string | null;
}

export interface SyncLogEntry {
  id: number;
  pairId: number | null;
  action: string;
  relativePath: string | null;
  detail: string | null;
  createdAt: number;
}

export interface SyncConflict {
  pairId: number;
  relativePath: string;
  localPath: string;
  label: string | null;
}

export type ConflictResolution = 'keep_local' | 'keep_remote' | 'keep_both';
