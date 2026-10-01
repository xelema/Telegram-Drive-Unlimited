import { invoke } from '@tauri-apps/api/core';
import type { DesktopTransferJob, TransferDirection, TransferKind, TransferStatus } from './desktopTransferEngine';

export type TransferErrorCategory = 'network' | 'rate_limit' | 'unlock' | 'source_missing' | 'storage' | 'integrity' | 'account' | 'interrupted' | 'persistence' | 'cancelled' | 'other';
export interface ActivityJob extends DesktopTransferJob {
  ownerId: string;
  errorCategory?: TransferErrorCategory | null;
  persistencePending?: boolean;
}
export interface LegacyTransfer {
  id: string;
  filename: string;
  direction: TransferDirection;
  kind: TransferKind;
  status: TransferStatus;
  createdAt: number;
  totalBytes: number;
  canAdopt: boolean;
}
export interface TransferActivitySnapshot {
  ownerId: string;
  jobs: ActivityJob[];
  legacy: LegacyTransfer[];
}

export const protectedActivityMetadata = (job: DesktopTransferJob): boolean =>
  Boolean(job.protectionMode && job.protectionMode !== 'standard')
  || Boolean(job.protectMetadata && job.protectionMode !== 'standard')
  || ['waiting_for_unlock', 'encrypting', 'decrypting'].includes(job.status);

export function projectActivityJob(job: ActivityJob): ActivityJob {
  return protectedActivityMetadata(job) ? {
    ...job, filename: '', path: undefined, url: undefined, savePath: undefined, tempZipPath: undefined,
    error: undefined, totalBytes: 0, transferredBytes: 0, speedBytesPerSec: 0,
  } : job;
}

export async function readTransferActivity(ownerId: string): Promise<TransferActivitySnapshot> {
  const snapshot = await invoke<TransferActivitySnapshot>('cmd_transfer_activity', { ownerId });
  if (snapshot.ownerId !== ownerId || snapshot.jobs.some(job => job.ownerId !== ownerId)) throw new Error('ACCOUNT_CHANGED');
  return { ...snapshot, jobs: snapshot.jobs.map(projectActivityJob) };
}
export const adoptLegacyTransfers = (ownerId: string, ids: string[], confirmedOwnership: boolean) => invoke<void>('cmd_transfer_adopt_legacy', { ownerId, ids, confirmedOwnership });
export const discardLegacyTransfers = (ownerId: string, ids: string[]) => invoke<void>('cmd_transfer_discard_legacy', { ownerId, ids });

const allowed = <T extends string>(value: T | null | undefined, values: readonly string[]): T | null => value && values.includes(value) ? value : null;

export function redactedTransferReport(jobs: readonly ActivityJob[], now = new Date()): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    transfers: jobs.slice(0, 500).map(job => ({
      direction: allowed(job.direction, ["upload", "download"]),
      kind: allowed(job.kind, ["local_upload", "url_upload", "download"]),
      status: allowed(job.status, ["pending", "paused", "waiting_for_network", "cooldown", "downloading", "uploading", "encrypting", "decrypting", "verifying", "waiting_for_unlock", "completed", "failed", "cancelled"]),
      errorCategory: allowed(job.errorCategory, ["network", "rate_limit", "unlock", "source_missing", "storage", "integrity", "account", "interrupted", "persistence", "cancelled", "other"]),
      progress: Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0,
      persistencePending: Boolean(job.persistencePending),
    })),
  }, null, 2);
}
