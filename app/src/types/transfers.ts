import type { UploadProtectionIntent } from './encryption';

export interface QueueItem {
  id: string;
  path: string;
  url?: string;
  folderId: number | null;
  status: 'pending' | 'paused' | 'downloading' | 'uploading' | 'success' | 'error' | 'cancelled' | 'waiting_for_unlock' | 'encrypting' | 'decrypting' | 'verifying';
  error?: string;
  progress?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  tempZipPath?: string;
  protection?: UploadProtectionIntent;
}

export type DroppedPathRejectionReason = 'directory' | 'missing' | 'unreadable' | 'unsupported';

export interface DroppedPathRejection {
  path: string;
  reason: DroppedPathRejectionReason;
}

export interface DroppedPathValidation {
  accepted: string[];
  rejected: DroppedPathRejection[];
}

export interface DropUploadResult {
  queued: number;
  rejected: DroppedPathRejection[];
  cancelled?: boolean;
}

export interface DownloadItem {
  id: string;
  messageId: number;
  filename: string;
  folderId: number | null;
  status: 'pending' | 'paused' | 'cooldown' | 'downloading' | 'success' | 'error' | 'cancelled' | 'waiting_for_unlock' | 'decrypting' | 'verifying';
  error?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  savePath?: string;
  protectionMode?: 'vault' | 'passphrase' | 'vault_and_passphrase';
  /** In-memory only. Never persist this single-use credential handle. */
  promptToken?: number;
}
