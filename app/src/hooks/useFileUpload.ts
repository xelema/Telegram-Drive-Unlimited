import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DropUploadResult, DroppedPathValidation, QueueItem, UploadProtectionIntent } from '../types';
import { isAndroidPlatform, showFileDialogFallback, pickWithFallback } from '../utils';
import { useSettings } from '../context/SettingsContext';
import type { Store } from '@tauri-apps/plugin-store';
import { useTranslation } from 'react-i18next';

interface ProgressPayload {
    id: string;
    percent: number;
    uploaded_bytes: number;
    total_bytes: number;
    speed_bytes_per_sec: number;
}

interface RemoteProgressPayload {
    id: string;
    phase: 'downloading' | 'uploading';
    percent: number;
    speed: number;
    uploaded_bytes: number;
    total_bytes: number;
}

export function useFileUpload(activeFolderId: number | null, store: Store | null) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { settings } = useSettings();
    const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());
    const activeCountRef = useRef(0);

    // Listen for progress events from Rust
    useEffect(() => {
        let unlistenProgress: UnlistenFn | undefined;
        let unlistenRemote: UnlistenFn | undefined;

        listen<ProgressPayload>('upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id ? {
                    ...i,
                    progress: event.payload.percent,
                    uploadedBytes: event.payload.uploaded_bytes,
                    totalBytes: event.payload.total_bytes,
                    speedBytesPerSec: event.payload.speed_bytes_per_sec,
                } : i
            ));
        }).then(fn => { unlistenProgress = fn; });

        listen<RemoteProgressPayload>('remote-upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id ? {
                    ...i,
                    status: event.payload.phase,
                    progress: event.payload.percent,
                    speedBytesPerSec: event.payload.speed,
                    uploadedBytes: event.payload.uploaded_bytes,
                    totalBytes: event.payload.total_bytes,
                } : i
            ));
        }).then(fn => { unlistenRemote = fn; });

        return () => {
            unlistenProgress?.();
            unlistenRemote?.();
        };
    }, []);

    useEffect(() => {
        if (!store || initialized) return;
        store.get<QueueItem[]>('uploadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved
                    .filter(i => i.status === 'pending' || i.status === 'waiting_for_unlock')
                    .map(i => ({
                        ...i,
                        status: i.protection?.mode === 'passphrase' || i.protection?.mode === 'vault_and_passphrase'
                            ? 'waiting_for_unlock' as const
                            : i.status,
                        protection: i.protection ? { ...i.protection, promptToken: undefined } : undefined,
                    }));
                if (pending.length > 0) {
                    setUploadQueue(pending);
                    toast.info(`Restored ${pending.length} pending uploads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    useEffect(() => {
        if (!store || !initialized) return;
        const pending = uploadQueue
            .filter(i => i.status === 'pending' || i.status === 'waiting_for_unlock')
            .map(i => ({
                ...i,
                protection: i.protection ? { ...i.protection, promptToken: undefined } : undefined,
            }));
        store.set('uploadQueue', pending).then(() => store.save());
    }, [store, uploadQueue, initialized]);

    // Process up to maxConcurrentUploads in parallel
    useEffect(() => {
        const maxConcurrent = settings.maxConcurrentUploads || 1;
        const available = maxConcurrent - activeCountRef.current;
        if (available <= 0) return;
        const pendingItems = uploadQueue.filter(i => i.status === 'pending').slice(0, available);
        for (const item of pendingItems) {
            processItem(item);
        }
    }, [uploadQueue, settings.maxConcurrentUploads]);

    // Manage Android Foreground Service for persistent uploads
    useEffect(() => {
        if (!isAndroidPlatform) return;

        const hasActiveUploads = uploadQueue.some(i => i.status === 'uploading' || i.status === 'pending');
        if (hasActiveUploads) {
            invoke('cmd_start_foreground_service').catch(() => {});
        } else if (initialized) {
            invoke('cmd_stop_foreground_service').catch(() => {});
        }
    }, [uploadQueue, initialized]);

    /** Clean up temp zip file if the item was created from a folder */
    const cleanupTempZip = async (item: QueueItem) => {
        if (item.tempZipPath) {
            try {
                await invoke('cmd_delete_temp_zip', { path: item.tempZipPath });
            } catch {
                // Best-effort cleanup
            }
        }
    };

    const processItem = async (item: QueueItem) => {
        const protection: UploadProtectionIntent = item.protection ?? {
            mode: settings.encryptionDefaultMode,
            protectMetadata: settings.encryptionProtectMetadata,
        };
        if (
            (protection.mode === 'passphrase' || protection.mode === 'vault_and_passphrase')
            && !protection.promptToken
        ) {
            setUploadQueue(q => q.map(i => i.id === item.id ? {
                ...i,
                protection,
                status: 'waiting_for_unlock',
                error: 'File passphrase required',
            } : i));
            return;
        }
        activeCountRef.current++;
        const initialStatus = item.url ? 'downloading' : 'uploading';
        setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: initialStatus, progress: 0 } : i));
        try {
            if (item.url) {
                await invoke('cmd_upload_from_url', {
                    url: item.url,
                    folderId: item.folderId,
                    transferId: item.id,
                    protectionMode: protection.mode,
                    promptToken: protection.promptToken,
                    protectMetadata: protection.protectMetadata ?? settings.encryptionProtectMetadata,
                });
            } else {
                await invoke('cmd_upload_file', {
                    path: item.path,
                    folderId: item.folderId,
                    transferId: item.id,
                    protectionMode: protection.mode,
                    promptToken: protection.promptToken,
                    protectMetadata: protection.protectMetadata ?? settings.encryptionProtectMetadata,
                });
            }
            // Check if cancelled during upload
            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                queryClient.invalidateQueries({ queryKey: ['files', item.folderId] });
            }
            // Clean up temp zip on success
            await cleanupTempZip(item);
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                const errMsg = String(e);
                if (errMsg.includes('Transfer cancelled')) {
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
                } else if (errMsg.includes('VAULT_LOCKED') || errMsg.includes('KEY_REQUIRED')) {
                    setUploadQueue(q => q.map(i => i.id === item.id ? {
                        ...i,
                        status: 'waiting_for_unlock',
                        error: errMsg,
                        protection: i.protection ? { ...i.protection, promptToken: undefined } : protection,
                    } : i));
                    toast.warning(t('settings.encryption_mode_passphrase'));
                } else if (errMsg.includes('FILE_TOO_BIG') || errMsg.includes('too large') || errMsg.includes('2 GB')) {
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: errMsg } : i));
                    toast.error(`Upload failed: Telegram has a 2 GB file size limit. Try splitting large folders.`);
                } else {
                    const displayPath = item.url || item.path;
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: errMsg } : i));
                    toast.error(`Upload failed for ${displayPath.split('/').pop()}: ${e}`);
                }
            } else {
                cancelledRef.current.delete(item.id);
            }
            // Clean up temp zip even on failure
            await cleanupTempZip(item);
        } finally {
            activeCountRef.current--;
        }
    };

    const stageProtectionForFiles = async (
        count: number,
        requestedMode = settings.encryptionDefaultMode,
    ): Promise<UploadProtectionIntent[] | null> => {
        const mode = requestedMode;
        const base: UploadProtectionIntent = {
            mode,
            protectMetadata: settings.encryptionProtectMetadata,
        };
        if (mode !== 'passphrase' && mode !== 'vault_and_passphrase') {
            return Array.from({ length: count }, () => ({ ...base }));
        }

        const accepted = window.confirm(t('settings.encryption_disclaimer_body'));
        if (!accepted) return null;
        const passphrase = window.prompt(
            `${t('settings.encryption_mode_passphrase')}\n${t('settings.min_passphrase_length')}`,
        );
        if (!passphrase) return null;
        if (new TextEncoder().encode(passphrase).length < 8) {
            toast.error(t('settings.min_passphrase_length'));
            return null;
        }
        const confirmation = window.prompt(t('settings.confirm_passphrase'));
        if (confirmation !== passphrase) {
            toast.error(t('settings.passphrases_no_match'));
            return null;
        }
        try {
            const tokens = await Promise.all(
                Array.from({ length: count }, () => invoke<number>('cmd_stage_file_passphrase', { passphrase })),
            );
            return tokens.map(promptToken => ({ ...base, promptToken }));
        } catch (error) {
            toast.error(`Could not prepare encrypted upload: ${String(error)}`);
            return null;
        }
    };

    /** Queues a set of file paths with an explicit, non-secret protection intent. */
    const queueFiles = async (
        paths: string[],
        destinationFolderId: number | null = activeFolderId,
    ): Promise<number> => {
        if (!paths || paths.length === 0) return 0;
        const protection = await stageProtectionForFiles(paths.length);
        if (!protection) return 0;
        const newItems: QueueItem[] = paths.map((path: string, index) => ({
            id: Math.random().toString(36).substr(2, 9),
            path,
            folderId: destinationFolderId,
            status: 'pending' as const,
            protection: protection[index],
        }));
        setUploadQueue(prev => [...prev, ...newItems]);
        toast.info(t('notifications.uploads_queued', { count: paths.length }));
        return paths.length;
    };

    const handleManualUpload = async () => {
        const paths = await pickWithFallback(
            async () => {
                const selected = await open({ multiple: true, directory: false });
                if (!selected) return null;
                return Array.isArray(selected) ? selected : [selected];
            },
            () => handleManualUpload(),
            {
                errorTitle: 'File picker failed',
                onBrowserPicker: async () => {
                    const fallbackPaths = await showFileDialogFallback({ directory: false, multiple: true });
                    return fallbackPaths.length > 0 ? fallbackPaths : null;
                },
            },
        );
        if (paths && paths.length > 0) {
            await queueFiles(paths);
        }
    };

    /** Queue files dropped from the OS file manager (drag-and-drop upload) */
    const handleDropUpload = async (paths: string[]): Promise<DropUploadResult> => {
        if (!paths || paths.length === 0) return { queued: 0, rejected: [] };

        // Snapshot the destination before validation or an encryption prompt can yield.
        const destinationFolderId = activeFolderId;
        let validation: DroppedPathValidation;
        try {
            validation = await invoke<DroppedPathValidation>('cmd_validate_dropped_paths', { paths });
        } catch (error) {
            toast.error(t('settings.failed_prefix', { error: String(error) }));
            return { queued: 0, rejected: [] };
        }

        if (validation.rejected.length > 0) {
            toast.warning(t('notifications.drop_rejected', { count: validation.rejected.length }));
        }

        const queued = await queueFiles(validation.accepted, destinationFolderId);
        return {
            queued,
            rejected: validation.rejected,
            cancelled: validation.accepted.length > 0 && queued === 0,
        };
    };

    const handleFolderUpload = async () => {
        const folderPath = await pickWithFallback(
            async () => {
                const selected = await open({ multiple: false, directory: true, title: 'Select Folder to Upload' });
                if (!selected) return null;
                const fp = Array.isArray(selected) ? selected[0] : selected;
                return fp || null;
            },
            () => handleFolderUpload(),
            {
                errorTitle: 'Folder picker failed',
                onBrowserPicker: async () => {
                    const fallbackPaths = await showFileDialogFallback({ directory: true, multiple: true });
                    if (fallbackPaths.length > 0) {
                        // HTML folder picker returns individual file paths, not a folder path.
                        // We can't zip without a folder path, so files upload individually.
                        toast.info('Folder zipping unavailable with browser picker — uploading files individually.');
                        await queueFiles(fallbackPaths);
                    }
                    return null; // Already handled via queueFiles — signal that the main flow should stop
                },
            },
        );
        if (!folderPath) return;

        const folderName = folderPath.split('/').pop() || folderPath.split('\\').pop() || 'folder';

        if (settings.zipFolders) {
            toast.info(`Zipping "${folderName}"...`);
            try {
                const zipPath = await invoke<string>('cmd_zip_folder', { folderPath });
                const protection = await stageProtectionForFiles(1);
                if (!protection) {
                    await invoke('cmd_delete_temp_zip', { path: zipPath }).catch(() => {});
                    return;
                }
                const item: QueueItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    path: zipPath,
                    folderId: activeFolderId,
                    status: 'pending',
                    tempZipPath: zipPath,
                    protection: protection[0],
                };
                setUploadQueue(prev => [...prev, item]);
                toast.success(`Queued "${folderName}.zip" for upload`);
            } catch (e) {
                console.error('[Upload] Zip error:', e);
                toast.error(`Failed to zip folder: ${e}`);
            }
        } else {
            toast.info(`Folder upload without zipping is not supported. Enable "Zip folders before upload" in Settings.`);
        }
    };

    const cancelAll = () => {
        setUploadQueue(q => {
            const activeItems = q.filter(i => i.status === 'uploading' || i.status === 'downloading');
            for (const item of activeItems) {
                cancelledRef.current.add(item.id);
                invoke('cmd_cancel_transfer', { transferId: item.id }).catch(() => {});
            }
            return q
                .filter(i => i.status !== 'pending')
                .map(i => (i.status === 'uploading' || i.status === 'downloading') ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All uploads cancelled');
    };

    const cancelItem = (id: string) => {
        setUploadQueue(q => {
            const item = q.find(i => i.id === id);
            if (item?.status === 'uploading' || item?.status === 'downloading') {
                cancelledRef.current.add(id);
                invoke('cmd_cancel_transfer', { transferId: id }).catch(() => {});
                return q.map(i => i.id === id ? { ...i, status: 'cancelled' as const } : i);
            }
            // Remove pending items directly
            if (item?.status === 'pending') {
                return q.filter(i => i.id !== id);
            }
            return q;
        });
    };

    const retryItem = async (id: string) => {
        const item = uploadQueue.find(candidate => candidate.id === id);
        if (!item || !['error', 'cancelled', 'waiting_for_unlock'].includes(item.status)) return;
        let protection = item.protection;
        if (protection?.mode === 'passphrase' || protection?.mode === 'vault_and_passphrase') {
            const staged = await stageProtectionForFiles(1, protection.mode);
            if (!staged) return;
            protection = { ...staged[0], protectMetadata: protection.protectMetadata };
        }
        setUploadQueue(q => q.map(i =>
            i.id === id
                ? { ...i, protection, status: 'pending' as const, error: undefined, progress: undefined, uploadedBytes: undefined, totalBytes: undefined, speedBytesPerSec: undefined }
                : i
        ));
    };

    const handleUrlUpload = async (url: string, folderId: number | null) => {
        if (!url || !url.trim()) return;
        let filename: string;
        try {
            filename = new URL(url).pathname.split('/').pop() || 'remote_file';
        } catch {
            filename = url.split('/').pop() || 'remote_file';
        }
        const protection = await stageProtectionForFiles(1);
        if (!protection) return;
        const item: QueueItem = {
            id: Math.random().toString(36).substr(2, 9),
            path: filename,
            url: url.trim(),
            folderId: folderId,
            status: 'pending' as const,
            protection: protection[0],
        };
        setUploadQueue(prev => [...prev, item]);
        toast.info(`Queued remote upload from URL`);
    };

    return {
        uploadQueue,
        setUploadQueue,
        handleManualUpload,
        handleFolderUpload,
        handleDropUpload,
        handleUrlUpload,
        cancelAll,
        cancelItem,
        retryItem,
    };
}
