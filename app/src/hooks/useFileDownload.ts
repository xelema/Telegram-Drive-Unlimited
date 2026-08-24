import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DownloadItem, FileEncryptionInfo, TelegramFile, VaultStatus } from '../types';
import { isAndroidPlatform, showFileDialogFallback, pickWithFallback, sanitizeFilename } from '../utils';
import { useSettings } from '../context/SettingsContext';
import type { Store } from '@tauri-apps/plugin-store';
import { useTranslation } from 'react-i18next';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useConfirm } from '../context/ConfirmContext';
import { formatBytes } from '../utils';
import { triggerHaptic } from '../services/feedback';
import { isTransientNetworkError, restoreDownloadQueue, serializeDownloadQueue } from '../services/transferQueuePolicy';
import { announceSupporterValueMoment } from '../services/supporterVisibility';
import { evaluateAndroidTransferPolicy, type AndroidTransferEnvironment } from '../services/androidTransferPolicy';
import {
    clearTerminalTransfers,
    downloadItemToTransferRequest,
    enqueueDesktopTransfers,
    listenToDesktopTransfers,
    listDesktopTransfers,
    supplyTransferPromptToken,
    transferBulkAction,
    transferItemAction,
    transferJobToDownloadItem,
} from '../services/desktopTransferEngine';

interface ProgressPayload {
    id: string;
    percent: number;
    uploaded_bytes: number;
    total_bytes: number;
    speed_bytes_per_sec: number;
}

export function useFileDownload(
    store: Store | null,
    androidNetworkAvailable = true,
    androidWaitingReason = 'Waiting for a network connection',
) {
    const { t } = useTranslation();
    const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());
    const pausedRef = useRef<Set<string>>(new Set());
    const networkPausedRef = useRef<Set<string>>(new Set());
    const activeCountRef = useRef(0);
    const persistenceChainRef = useRef<Promise<void>>(Promise.resolve());
    const persistenceHealthyRef = useRef(true);
    const startingItemsRef = useRef<Set<string>>(new Set());
    const downloadQueueRef = useRef(downloadQueue);
    const androidNetworkAvailableRef = useRef(androidNetworkAvailable);
    const desktopRevisionsRef = useRef<Map<string, number>>(new Map());
    const desktopStatusesRef = useRef<Map<string, string>>(new Map());
    downloadQueueRef.current = downloadQueue;
    androidNetworkAvailableRef.current = androidNetworkAvailable;
    const { settings, updateSetting } = useSettings();
    const { confirm } = useConfirm();
    const lastDownloadDirectoryRef = useRef<string | null>(null);
    const webDavTipShownRef = useRef(settings.downloadWebdavTipSeen);

    useEffect(() => {
        webDavTipShownRef.current = settings.downloadWebdavTipSeen;
    }, [settings.downloadWebdavTipSeen]);

    const directoryFromPath = (path: string) => {
        const separator = path.includes('\\') ? '\\' : '/';
        const index = path.lastIndexOf(separator);
        return index > 0 ? path.slice(0, index) : path;
    };

    const joinPath = (directory: string, filename: string) => {
        const separator = directory.includes('\\') ? '\\' : '/';
        return directory.endsWith(separator) ? `${directory}${filename}` : `${directory}${separator}${filename}`;
    };

    // Listen for progress events from Rust
    useEffect(() => {
        if (!isAndroidPlatform) return;
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>('download-progress', (event) => {
            setDownloadQueue(q => q.map(i =>
                i.id === event.payload.id ? {
                    ...i,
                    progress: event.payload.percent,
                    downloadedBytes: event.payload.uploaded_bytes,
                    totalBytes: event.payload.total_bytes,
                    speedBytesPerSec: event.payload.speed_bytes_per_sec,
                } : i
            ));
        }).then(fn => { unlisten = fn; });
        return () => { unlisten?.(); };
    }, []);

    // Desktop queue state is a revisioned projection of the durable Rust engine.
    useEffect(() => {
        if (isAndroidPlatform) return;
        let disposed = false;
        let unlisten: UnlistenFn | undefined;
        const accept = (
            job: Awaited<ReturnType<typeof listDesktopTransfers>>[number],
            notifyTransition = false,
        ) => {
            if (disposed || job.direction !== 'download') return;
            const knownRevision = desktopRevisionsRef.current.get(job.id) || 0;
            if (job.revision < knownRevision) return;
            const previousStatus = desktopStatusesRef.current.get(job.id);
            desktopRevisionsRef.current.set(job.id, job.revision);
            desktopStatusesRef.current.set(job.id, job.status);
            const item = transferJobToDownloadItem(job);
            setDownloadQueue(queue => queue.some(candidate => candidate.id === item.id)
                ? queue.map(candidate => candidate.id === item.id ? item : candidate)
                : [...queue, item]);
            if (notifyTransition && previousStatus !== job.status) {
                if (job.status === 'completed') {
                    triggerHaptic('success');
                    announceSupporterValueMoment('download_completed');
                    toast.success(`Downloaded: ${job.filename}`, job.savePath ? {
                        action: {
                            label: 'Show in folder',
                            onClick: () => { void revealItemInDir(job.savePath as string); },
                        },
                    } : undefined);
                    if (!webDavTipShownRef.current) {
                        webDavTipShownRef.current = true;
                        updateSetting('downloadWebdavTipSeen', true);
                        window.setTimeout(() => toast.info('Tip: browse the same files directly in Finder or File Explorer with WebDAV.', {
                            action: {
                                label: 'WebDAV settings',
                                onClick: () => window.dispatchEvent(new CustomEvent('telegram-drive-open-settings', { detail: { tab: 'webdav' } })),
                            },
                        }), 900);
                    }
                } else if (job.status === 'failed') {
                    toast.error(`Download failed: ${job.filename}`);
                } else if (job.status === 'waiting_for_unlock') {
                    toast.warning(t('settings.encryption_mode_passphrase'));
                }
            }
        };
        void listenToDesktopTransfers(job => accept(job, true), id => {
            desktopRevisionsRef.current.delete(id);
            desktopStatusesRef.current.delete(id);
            setDownloadQueue(queue => queue.filter(item => item.id !== id));
        }).then(async listener => {
            if (disposed) {
                listener();
                return;
            }
            unlisten = listener;
            const jobs = await listDesktopTransfers();
            jobs.forEach(job => accept(job));
        }).catch(error => {
            console.error('[Download] Could not attach to the desktop transfer engine:', error);
            toast.error('The desktop transfer queue could not be loaded.');
        });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [t, updateSetting]);

    // Load saved queue on mount
    useEffect(() => {
        if (!store || initialized) return;
        if (!isAndroidPlatform) {
            void store.get<DownloadItem[]>('downloadQueue').then(async saved => {
                const pending = saved ? restoreDownloadQueue(saved, false) : [];
                const prepared: DownloadItem[] = [];
                const unresolved: DownloadItem[] = [];
                for (const item of pending) {
                    if (item.savePath) {
                        prepared.push(item);
                        continue;
                    }
                    const selected = await save({
                        defaultPath: item.filename,
                        title: `Restore download: ${item.filename}`,
                    });
                    if (selected) prepared.push({ ...item, savePath: selected });
                    else unresolved.push(item);
                }
                if (prepared.length > 0) {
                    await enqueueDesktopTransfers(prepared.map(downloadItemToTransferRequest));
                }
                await store.set('downloadQueue', unresolved);
                await store.save();
                if (prepared.length > 0) {
                    toast.info(`Migrated ${prepared.length} downloads to the durable desktop queue`);
                }
                setInitialized(true);
            }).catch(error => {
                console.error('[Download] Could not migrate the desktop recovery queue:', error);
                toast.error('Could not migrate the saved download queue. It was left intact.');
                setInitialized(true);
            });
            return;
        }
        store.get<DownloadItem[]>('downloadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = restoreDownloadQueue(saved, isAndroidPlatform);
                if (pending.length > 0) {
                    setDownloadQueue(pending);
                    toast.info(`Restored ${pending.length} pending downloads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    // Save queue when it changes (only pending items)
    useEffect(() => {
        if (!isAndroidPlatform) return;
        if (!store || !initialized) return;
        const pending = serializeDownloadQueue(downloadQueue, isAndroidPlatform);
        persistenceChainRef.current = persistenceChainRef.current
            .catch(() => undefined)
            .then(async () => {
                await store.set('downloadQueue', pending);
                await store.save();
                persistenceHealthyRef.current = true;
            })
            .catch(error => {
                persistenceHealthyRef.current = false;
                console.error('[Download] Could not persist the recovery queue:', error);
            });
    }, [store, downloadQueue, initialized]);

    useEffect(() => {
        if (!isAndroidPlatform || !initialized) return;
        const activeStatuses: DownloadItem['status'][] = ['downloading', 'decrypting', 'verifying'];
        if (!androidNetworkAvailable) {
            setDownloadQueue(queue => {
                let changed = false;
                const next = queue.map(item => {
                    if (!['pending', 'cooldown'].includes(item.status) && !activeStatuses.includes(item.status)) return item;
                    changed = true;
                    if (activeStatuses.includes(item.status)) {
                        networkPausedRef.current.add(item.id);
                        void invoke('cmd_cancel_transfer', { transferId: item.id }).catch(() => undefined);
                    }
                    return { ...item, status: 'waiting_for_network' as const, error: androidWaitingReason };
                });
                return changed ? next : queue;
            });
            return;
        }
        setDownloadQueue(queue => queue.some(item => item.status === 'waiting_for_network')
            ? queue.map(item => item.status === 'waiting_for_network'
                ? { ...item, status: 'pending' as const, error: undefined }
                : item)
            : queue);
    }, [androidNetworkAvailable, androidWaitingReason, initialized]);

    // Process up to maxConcurrentDownloads in parallel
    useEffect(() => {
        if (!isAndroidPlatform) return;
        if (isAndroidPlatform && !androidNetworkAvailable) return;
        if (isAndroidPlatform && (!store || !initialized)) return;
        const maxConcurrent = settings.maxConcurrentDownloads || 1;
        const available = maxConcurrent - activeCountRef.current;
        if (available <= 0) return;
        const pendingItems = downloadQueue.filter(i => i.status === 'pending').slice(0, available);
        for (const item of pendingItems) {
            if (!isAndroidPlatform) {
                void processItem(item);
                continue;
            }
            if (startingItemsRef.current.has(item.id)) continue;
            startingItemsRef.current.add(item.id);
            void (async () => {
                await persistenceChainRef.current;
                const current = downloadQueueRef.current.find(candidate => candidate.id === item.id);
                if (!current || current.status !== 'pending' || !androidNetworkAvailableRef.current) return;
                if (!persistenceHealthyRef.current) {
                    setDownloadQueue(queue => queue.map(candidate => candidate.id === item.id ? {
                        ...candidate,
                        status: 'error',
                        error: 'Could not save this download for background recovery. Retry after reopening the app.',
                    } : candidate));
                    return;
                }
                await processItem(current);
            })().finally(() => startingItemsRef.current.delete(item.id));
        }
    }, [downloadQueue, settings.maxConcurrentDownloads, androidNetworkAvailable, initialized, store]);

    const enqueueDownloadItems = async (items: DownloadItem[]) => {
        if (items.length === 0) return;
        if (isAndroidPlatform) {
            setDownloadQueue(previous => [...previous, ...items]);
            return;
        }
        const jobs = await enqueueDesktopTransfers(items.map(downloadItemToTransferRequest));
        setDownloadQueue(previous => {
            const currentJobs = jobs.filter(job => {
                const knownRevision = desktopRevisionsRef.current.get(job.id) || 0;
                return job.revision >= knownRevision;
            });
            const incoming = new Map(currentJobs.map(job => [job.id, transferJobToDownloadItem(job)]));
            const next = previous.map(item => incoming.get(item.id) || item);
            const known = new Set(previous.map(item => item.id));
            for (const job of currentJobs) {
                desktopRevisionsRef.current.set(job.id, job.revision);
                if (!known.has(job.id)) next.push(transferJobToDownloadItem(job));
            }
            return next;
        });
    };

    const prepareDesktopCredential = async (messageId: number, folderId: number | null) => {
        const encryptionInfo = await invoke<FileEncryptionInfo>('cmd_get_file_encryption_info', {
            messageId,
            folderId,
        });
        const protectionMode = encryptionInfo.protection_mode;
        if (encryptionInfo.state === 'plain') {
            return { protectionMode, promptToken: undefined };
        }
        if (protectionMode === 'vault') {
            const vault = await invoke<VaultStatus>('cmd_get_vault_status').catch(() => null);
            if (!vault?.is_unlocked) {
                toast.warning(t('settings.vault_is_locked'));
                return null;
            }
            return { protectionMode, promptToken: undefined };
        }
        let needsPassphrase = protectionMode === 'passphrase';
        if (protectionMode === 'vault_and_passphrase') {
            const vault = await invoke<VaultStatus>('cmd_get_vault_status').catch(() => null);
            needsPassphrase = !vault?.is_unlocked;
        }
        if (!needsPassphrase) return { protectionMode, promptToken: undefined };
        const passphrase = window.prompt(
            protectionMode === 'vault_and_passphrase'
                ? `${t('settings.vault_is_locked')}\n${t('settings.encryption_mode_passphrase')}`
                : t('settings.encryption_mode_passphrase'),
        );
        if (!passphrase) return null;
        const promptToken = await invoke<number>('cmd_stage_file_passphrase', { passphrase });
        return { protectionMode, promptToken };
    };

    const processItem = async (item: DownloadItem) => {
        if (isAndroidPlatform) {
            const environment = await invoke<AndroidTransferEnvironment>('cmd_get_android_transfer_environment');
            const gate = evaluateAndroidTransferPolicy(environment, settings, item.totalBytes ?? 0);
            if (!gate.allowed) {
                setDownloadQueue(queue => queue.map(candidate => candidate.id === item.id ? {
                    ...candidate,
                    status: 'waiting_for_network',
                    error: gate.reason,
                } : candidate));
                return;
            }
        }
        activeCountRef.current++;
        setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'downloading', progress: 0 } : i));

        try {
            const encryptionInfo = await invoke<FileEncryptionInfo>('cmd_get_file_encryption_info', {
                messageId: item.messageId,
                folderId: item.folderId,
            });
            const protectionMode = encryptionInfo.protection_mode;
            let promptToken = item.promptToken;
            if (encryptionInfo.state !== 'plain') {
                setDownloadQueue(q => q.map(i => i.id === item.id ? {
                    ...i,
                    status: 'decrypting',
                    protectionMode,
                } : i));
            }
            let needsPassphrase = protectionMode === 'passphrase';
            if (protectionMode === 'vault_and_passphrase') {
                const vault = await invoke<VaultStatus>('cmd_get_vault_status').catch(() => null);
                needsPassphrase = !vault?.is_unlocked;
            }
            if (needsPassphrase && !promptToken) {
                const passphrase = window.prompt(
                    protectionMode === 'vault_and_passphrase'
                        ? `${t('settings.vault_is_locked')}\n${t('settings.encryption_mode_passphrase')}`
                        : t('settings.encryption_mode_passphrase'),
                );
                if (!passphrase) {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? {
                        ...i,
                        status: 'waiting_for_unlock',
                        protectionMode,
                        error: 'Encryption credentials required',
                    } : i));
                    return;
                }
                promptToken = await invoke<number>('cmd_stage_file_passphrase', { passphrase });
            }

            // On Android, skip the save dialog entirely — the Rust backend handles saving
            // to public Downloads via MediaStore. Passing the original filename ensures the
            // correct file extension is preserved instead of getting a numeric document ID.
            let savePath: string | null = item.savePath || null;
            let selectedSavePathNow = false;
            if (!savePath) {
                if (isAndroidPlatform) {
                    savePath = item.filename;
                } else {
                    savePath = await pickWithFallback(
                        () => save({ defaultPath: item.filename }),
                        () => {
                            setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'pending' as const, error: undefined } : i));
                        },
                        { errorTitle: 'Save dialog failed' },
                    );
                    if (!savePath) {
                        setDownloadQueue(q => q.filter(i => i.id !== item.id));
                        return;
                    }
                    selectedSavePathNow = true;
                    lastDownloadDirectoryRef.current = directoryFromPath(savePath);
                }
            }

            if (!isAndroidPlatform && selectedSavePathNow && savePath) {
                const accepted = await confirm({
                    title: 'Confirm download',
                    message: `1 file · ${formatBytes(item.totalBytes || 0)} → ${directoryFromPath(savePath)}`,
                    confirmText: 'Download',
                    variant: 'info',
                });
                if (!accepted) {
                    setDownloadQueue(q => q.filter(i => i.id !== item.id));
                    return;
                }
            }

            // Pause can be requested while metadata, credentials, or a save
            // destination are being resolved, before the backend transfer exists.
            if (pausedRef.current.has(item.id)) {
                pausedRef.current.delete(item.id);
                return;
            }

            await invoke('cmd_download_file', {
                req: {
                    message_id: item.messageId,
                    save_path: savePath,
                    folder_id: item.folderId,
                    transfer_id: item.id,
                    prompt_token: promptToken,
                }
            });

            // A successful backend return wins over a late pause request; the
            // destination already contains the complete file and must not be
            // downloaded again on resume.
            pausedRef.current.delete(item.id);
            networkPausedRef.current.delete(item.id);
            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                triggerHaptic('success');
                announceSupporterValueMoment('download_completed');
                toast.success(`Downloaded: ${item.filename}`, !isAndroidPlatform && savePath ? {
                    action: {
                        label: 'Show in folder',
                        onClick: () => { void revealItemInDir(savePath as string); },
                    },
                } : undefined);
                if (!isAndroidPlatform && !webDavTipShownRef.current) {
                    webDavTipShownRef.current = true;
                    updateSetting('downloadWebdavTipSeen', true);
                    window.setTimeout(() => toast.info('Tip: browse the same files directly in Finder or File Explorer with WebDAV.', {
                        action: {
                            label: 'WebDAV settings',
                            onClick: () => window.dispatchEvent(new CustomEvent('telegram-drive-open-settings', { detail: { tab: 'webdav' } })),
                        },
                    }), 900);
                }
            }
        } catch (e) {
            if (networkPausedRef.current.has(item.id)) {
                networkPausedRef.current.delete(item.id);
            } else if (pausedRef.current.has(item.id)) {
                pausedRef.current.delete(item.id);
            } else if (!cancelledRef.current.has(item.id)) {
                const errMsg = String(e);
                const floodWait = errMsg.match(/FLOOD_WAIT_(\d+)/i);
                if (floodWait) {
                    const seconds = Math.min(300, Math.max(1, Number(floodWait[1]) || 60));
                    const retryAt = Date.now() + seconds * 1000;
                    setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'cooldown', error: `Telegram cooling down (${seconds}s)` } : i));
                    void emit('telegram-cooldown', { operation: 'Download', retryAt, seconds, active: true });
                    window.setTimeout(() => {
                        void emit('telegram-cooldown', { operation: 'Download', retryAt, seconds: 0, active: false });
                        setDownloadQueue(q => q.map(i => i.id === item.id && i.status === 'cooldown' ? { ...i, status: 'pending', error: undefined } : i));
                    }, seconds * 1000);
                } else if (errMsg.includes('Transfer cancelled')) {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
                } else if (errMsg.includes('VAULT_LOCKED') || errMsg.includes('KEY_REQUIRED')) {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? {
                        ...i,
                        status: 'waiting_for_unlock',
                        promptToken: undefined,
                        error: errMsg,
                    } : i));
                    toast.warning(t('settings.encryption_mode_passphrase'));
                } else if (isAndroidPlatform && isTransientNetworkError(errMsg)) {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? {
                        ...i,
                        status: 'waiting_for_network',
                        error: 'Waiting for a stable network connection',
                    } : i));
                } else {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: errMsg } : i));
                    toast.error(`Download failed: ${item.filename}`);
                }
            } else if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            }
        } finally {
            activeCountRef.current--;
            // Ensure pending work is reconsidered after the active slot is freed,
            // including a transfer resumed while cancellation was unwinding.
            setDownloadQueue(q => [...q]);
        }
    };

    const queueDownload = async (messageId: number, filename: string, folderId: number | null, fileSize?: number) => {
        const cleanName = sanitizeFilename(filename);
        let savePath: string | undefined;
        if (!isAndroidPlatform && lastDownloadDirectoryRef.current) {
            const destination = lastDownloadDirectoryRef.current;
            const accepted = await confirm({
                title: 'Download file',
                message: `1 file · ${formatBytes(fileSize || 0)} → ${destination}`,
                confirmText: 'Download',
                cancelText: 'Choose another location',
                variant: 'info',
            });
            if (accepted) savePath = joinPath(destination, cleanName);
        }
        if (!isAndroidPlatform && !savePath) {
            const selected = await pickWithFallback(
                () => save({ defaultPath: cleanName }),
                () => queueDownload(messageId, filename, folderId, fileSize),
                { errorTitle: 'Save dialog failed' },
            );
            if (!selected) return;
            const accepted = await confirm({
                title: 'Confirm download',
                message: `1 file · ${formatBytes(fileSize || 0)} → ${directoryFromPath(selected)}`,
                confirmText: 'Download',
                variant: 'info',
            });
            if (!accepted) return;
            savePath = selected;
            lastDownloadDirectoryRef.current = directoryFromPath(selected);
        }
        const credential = !isAndroidPlatform
            ? await prepareDesktopCredential(messageId, folderId)
            : undefined;
        if (!isAndroidPlatform && !credential) return;
        const newItem: DownloadItem = {
            id: Math.random().toString(36).substr(2, 9),
            messageId,
            filename: cleanName,
            folderId,
            status: 'pending',
            totalBytes: fileSize,
            savePath,
            protectionMode: credential?.protectionMode,
            promptToken: credential?.promptToken,
        };
        await enqueueDownloadItems([newItem]);
    };

    const queueBulkDownload = async (files: TelegramFile[], folderId: number | null) => {
        // On Android, skip the directory picker — the Rust backend handles saving
        // to public Downloads via MediaStore. Don't set savePath so processItem
        // falls through to item.filename.
        if (isAndroidPlatform) {
            const newItems: DownloadItem[] = files.map(file => ({
                id: Math.random().toString(36).substr(2, 9),
                messageId: file.id,
                filename: sanitizeFilename(file.name),
                folderId: file.folder_id ?? folderId,
                status: 'pending' as const,
            }));
            setDownloadQueue(prev => [...prev, ...newItems]);
            toast.info(`Downloading ${files.length} file${files.length !== 1 ? 's' : ''} to Downloads`);
            return;
        }

        const enqueueFiles = async (dir: string) => {
            const separator = dir.includes('\\') ? '\\' : '/';
            const newItems: DownloadItem[] = files.map(file => {
                const sanitizedName = sanitizeFilename(file.name);
                return {
                    id: Math.random().toString(36).substr(2, 9),
                    messageId: file.id,
                    filename: sanitizedName,
                    folderId: file.folder_id ?? folderId,
                    status: 'pending' as const,
                    savePath: dir.endsWith(separator) ? `${dir}${sanitizedName}` : `${dir}${separator}${sanitizedName}`
                };
            });
            const prepared: DownloadItem[] = [];
            for (const item of newItems) {
                const credential = await prepareDesktopCredential(item.messageId, item.folderId);
                if (credential) prepared.push({
                    ...item,
                    protectionMode: credential.protectionMode,
                    promptToken: credential.promptToken,
                });
            }
            await enqueueDownloadItems(prepared);
            toast.info(`Queued ${prepared.length} file${prepared.length === 1 ? '' : 's'} for download`);
        };

        const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
        if (lastDownloadDirectoryRef.current) {
            const destination = lastDownloadDirectoryRef.current;
            const accepted = await confirm({
                title: 'Download files',
                message: `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(totalSize)} → ${destination}`,
                confirmText: 'Download',
                cancelText: 'Choose another location',
                variant: 'info',
            });
            if (accepted) {
                await enqueueFiles(destination);
                return;
            }
        }

        const dirPath = await pickWithFallback(
            () => open({ directory: true, multiple: false, title: "Select Download Destination" }),
            () => queueBulkDownload(files, folderId),
            {
                errorTitle: 'Folder picker failed',
                onBrowserPicker: async () => {
                    const paths = await showFileDialogFallback({ directory: true, multiple: false });
                    if (paths.length === 0) return null;
                    const sep = paths[0].includes('\\') ? '\\' : '/';
                    return paths[0].substring(0, paths[0].lastIndexOf(sep));
                },
            },
        );
        if (!dirPath) return;
        const accepted = await confirm({
            title: 'Confirm download',
            message: `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(totalSize)} → ${dirPath}`,
            confirmText: 'Download',
            variant: 'info',
        });
        if (!accepted) return;
        lastDownloadDirectoryRef.current = dirPath;
        await enqueueFiles(dirPath);
    };

    const clearFinished = () => {
        if (!isAndroidPlatform) {
            void clearTerminalTransfers('download', false).catch(error => toast.error(String(error)));
            return;
        }
        setDownloadQueue(q => q.filter(i => i.status !== 'success'));
    };

    const cancelAll = () => {
        if (!isAndroidPlatform) {
            void transferBulkAction('cancel', 'download').catch(error => toast.error(String(error)));
            toast.info('All downloads cancelled');
            return;
        }
        setDownloadQueue(q => {
            const active = q.filter(i => i.status === 'downloading' || i.status === 'decrypting' || i.status === 'verifying');
            const removable = q.filter(i => ['pending', 'paused', 'waiting_for_network', 'waiting_for_unlock', 'cooldown', 'error'].includes(i.status));
            for (const item of active) {
                cancelledRef.current.add(item.id);
                invoke('cmd_cancel_transfer', { transferId: item.id }).catch(() => {});
            }
            return q
                .filter(i => !removable.some(candidate => candidate.id === i.id))
                .map(i => active.some(activeItem => activeItem.id === i.id) ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All downloads cancelled');
    };

    const pauseAll = () => {
        if (!isAndroidPlatform) {
            void transferBulkAction('pause', 'download').catch(error => toast.error(String(error)));
            toast.info('Downloads paused. Active items will restart safely when resumed.');
            return;
        }
        setDownloadQueue(q => q.map(item => {
            if (item.status === 'downloading' || item.status === 'decrypting' || item.status === 'verifying') {
                pausedRef.current.add(item.id);
                invoke('cmd_cancel_transfer', { transferId: item.id }).catch(() => {});
                return { ...item, status: 'paused' as const, error: undefined };
            }
            return item.status === 'pending' || item.status === 'cooldown'
                ? { ...item, status: 'paused' as const, error: undefined }
                : item;
        }));
        toast.info('Downloads paused. Active items will restart safely when resumed.');
    };

    const resumeAll = () => {
        if (!isAndroidPlatform) {
            void transferBulkAction('resume', 'download').catch(error => toast.error(String(error)));
            toast.info('Downloads resumed');
            return;
        }
        setDownloadQueue(q => q.map(item => item.status === 'paused'
            ? { ...item, status: 'pending' as const, error: undefined }
            : item));
        toast.info('Downloads resumed');
    };

    const cancelItem = (id: string) => {
        if (!isAndroidPlatform) {
            void transferItemAction('cancel', id).catch(error => toast.error(String(error)));
            return;
        }
        setDownloadQueue(q => {
            const item = q.find(i => i.id === id);
            if (item && ['downloading', 'decrypting', 'verifying'].includes(item.status)) {
                cancelledRef.current.add(id);
                invoke('cmd_cancel_transfer', { transferId: id }).catch(() => {});
                return q.map(i => i.id === id ? { ...i, status: 'cancelled' as const } : i);
            }
            if (item && ['pending', 'paused', 'waiting_for_network', 'waiting_for_unlock', 'cooldown', 'error'].includes(item.status)) {
                return q.filter(i => i.id !== id);
            }
            return q;
        });
    };

    const retryItem = async (id: string) => {
        if (cancelledRef.current.has(id)) return;
        if (!isAndroidPlatform) {
            const item = downloadQueue.find(candidate => candidate.id === id);
            if (!item) return;
            if (item.status === 'waiting_for_unlock') {
                const credential = await prepareDesktopCredential(item.messageId, item.folderId);
                if (!credential) return;
                if (credential.promptToken) {
                    await supplyTransferPromptToken(id, credential.promptToken);
                }
            }
            await transferItemAction('retry', id);
            return;
        }
        setDownloadQueue(q => q.map(i =>
            i.id === id && (i.status === 'error' || i.status === 'cancelled' || i.status === 'waiting_for_unlock')
                ? { ...i, status: 'pending' as const, error: undefined, progress: undefined, downloadedBytes: undefined, totalBytes: undefined, speedBytesPerSec: undefined }
                : i
        ));
    };

    return {
        downloadQueue,
        queueDownload,
        queueBulkDownload,
        clearFinished,
        cancelAll,
        pauseAll,
        resumeAll,
        cancelItem,
        retryItem,
    };
}
