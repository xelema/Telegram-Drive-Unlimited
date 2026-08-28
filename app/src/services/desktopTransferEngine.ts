import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DownloadItem, QueueItem } from '../types';
import type { VideoUploadMode } from '../types/settings';

export type TransferDirection = 'upload' | 'download';
export type TransferKind = 'local_upload' | 'url_upload' | 'download';
export type TransferStatus =
    | 'pending'
    | 'paused'
    | 'waiting_for_network'
    | 'cooldown'
    | 'downloading'
    | 'uploading'
    | 'encrypting'
    | 'decrypting'
    | 'verifying'
    | 'waiting_for_unlock'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface DesktopTransferJob {
    id: string;
    direction: TransferDirection;
    kind: TransferKind;
    status: TransferStatus;
    path?: string;
    url?: string;
    folderId: number | null;
    messageId?: number;
    filename: string;
    savePath?: string;
    protectionMode?: string;
    protectMetadata?: boolean;
    videoUploadMode?: VideoUploadMode;
    tempZipPath?: string;
    progress: number;
    transferredBytes: number;
    totalBytes: number;
    speedBytesPerSec: number;
    error?: string;
    retryAt?: number;
    queuePosition: number;
    revision: number;
    createdAt: number;
    updatedAt: number;
}

export interface DesktopTransferRequest {
    id: string;
    direction: TransferDirection;
    kind: TransferKind;
    path?: string;
    url?: string;
    folderId: number | null;
    messageId?: number;
    filename: string;
    savePath?: string;
    protectionMode?: string;
    promptToken?: number;
    protectMetadata?: boolean;
    videoUploadMode?: VideoUploadMode;
    tempZipPath?: string;
    totalBytes?: number;
    initialStatus?: TransferStatus;
}

const uploadStatus = (status: TransferStatus): QueueItem['status'] => {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'error';
    if (status === 'cooldown') return 'waiting_for_network';
    return status;
};

const downloadStatus = (status: TransferStatus): DownloadItem['status'] => {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'error';
    if (status === 'uploading' || status === 'encrypting') return 'downloading';
    return status;
};

export const transferJobToUploadItem = (job: DesktopTransferJob): QueueItem => ({
    id: job.id,
    path: job.path || job.filename,
    url: job.url,
    folderId: job.folderId,
    status: uploadStatus(job.status),
    error: job.error,
    progress: job.progress,
    uploadedBytes: job.transferredBytes,
    totalBytes: job.totalBytes,
    speedBytesPerSec: job.speedBytesPerSec,
    tempZipPath: job.tempZipPath,
    protection: job.protectionMode ? {
        mode: job.protectionMode as NonNullable<QueueItem['protection']>['mode'],
        protectMetadata: job.protectMetadata,
    } : undefined,
    videoUploadMode: job.videoUploadMode,
});

export const transferJobToDownloadItem = (job: DesktopTransferJob): DownloadItem => ({
    id: job.id,
    messageId: job.messageId || 0,
    filename: job.filename,
    folderId: job.folderId,
    status: downloadStatus(job.status),
    error: job.error,
    progress: job.progress,
    downloadedBytes: job.transferredBytes,
    totalBytes: job.totalBytes,
    speedBytesPerSec: job.speedBytesPerSec,
    savePath: job.savePath,
    protectionMode: job.protectionMode as DownloadItem['protectionMode'],
});

export const uploadItemToTransferRequest = (item: QueueItem): DesktopTransferRequest => ({
    id: item.id,
    direction: 'upload',
    kind: item.url ? 'url_upload' : 'local_upload',
    path: item.url ? undefined : item.path,
    url: item.url,
    folderId: item.folderId,
    filename: item.path.split(/[\\/]/).pop() || item.path,
    protectionMode: item.protection?.mode,
    promptToken: item.protection?.promptToken,
    protectMetadata: item.protection?.protectMetadata,
    videoUploadMode: item.videoUploadMode,
    tempZipPath: item.tempZipPath,
    totalBytes: item.totalBytes,
    initialStatus: normalizeInitialStatus(item.status),
});

export const downloadItemToTransferRequest = (item: DownloadItem): DesktopTransferRequest => ({
    id: item.id,
    direction: 'download',
    kind: 'download',
    folderId: item.folderId,
    messageId: item.messageId,
    filename: item.filename,
    savePath: item.savePath,
    protectionMode: item.protectionMode,
    promptToken: item.promptToken,
    totalBytes: item.totalBytes,
    initialStatus: normalizeInitialStatus(item.status),
});

const normalizeInitialStatus = (status: QueueItem['status'] | DownloadItem['status']): TransferStatus => {
    if (status === 'success') return 'completed';
    if (status === 'error') return 'failed';
    if (status === 'uploading' || status === 'downloading' || status === 'encrypting'
        || status === 'decrypting' || status === 'verifying') return 'pending';
    return status;
};

export async function listDesktopTransfers(): Promise<DesktopTransferJob[]> {
    return invoke<DesktopTransferJob[]>('cmd_transfer_list');
}

export async function enqueueDesktopTransfers(
    requests: DesktopTransferRequest[],
): Promise<DesktopTransferJob[]> {
    if (requests.length === 0) return [];
    return invoke<DesktopTransferJob[]>('cmd_transfer_enqueue_many', { requests });
}

export async function configureDesktopTransferLimits(maxUploads: number, maxDownloads: number) {
    await invoke('cmd_transfer_set_limits', {
        maxUploads: Math.max(1, maxUploads),
        maxDownloads: Math.max(1, maxDownloads),
    });
}

export async function transferItemAction(
    action: 'pause' | 'resume' | 'cancel' | 'retry',
    id: string,
): Promise<DesktopTransferJob> {
    return invoke<DesktopTransferJob>(`cmd_transfer_${action}`, { id });
}

export async function transferBulkAction(
    action: 'pause' | 'resume' | 'cancel',
    direction: TransferDirection,
): Promise<DesktopTransferJob[]> {
    return invoke<DesktopTransferJob[]>(`cmd_transfer_${action}_all`, { direction });
}

export async function clearTerminalTransfers(
    direction: TransferDirection,
    includeFailedAndCancelled: boolean,
): Promise<string[]> {
    return invoke<string[]>('cmd_transfer_clear_terminal', { direction, includeFailedAndCancelled });
}

export async function supplyTransferPromptToken(id: string, promptToken: number): Promise<void> {
    await invoke('cmd_transfer_supply_prompt_token', { id, promptToken });
}

export async function listenToDesktopTransfers(
    onUpsert: (job: DesktopTransferJob) => void,
    onRemove: (id: string) => void,
): Promise<UnlistenFn> {
    const unlistenUpsert = await listen<DesktopTransferJob>('transfer-upserted', event => {
        onUpsert(event.payload);
    });
    const unlistenRemove = await listen<string>('transfer-removed', event => {
        onRemove(event.payload);
    });
    return () => {
        unlistenUpsert();
        unlistenRemove();
    };
}

export function mergeTransferJob(
    jobs: DesktopTransferJob[],
    incoming: DesktopTransferJob,
): DesktopTransferJob[] {
    const existing = jobs.find(job => job.id === incoming.id);
    if (existing && existing.revision >= incoming.revision) return jobs;
    const next = existing
        ? jobs.map(job => job.id === incoming.id ? incoming : job)
        : [...jobs, incoming];
    return next.sort((left, right) => left.queuePosition - right.queuePosition);
}
