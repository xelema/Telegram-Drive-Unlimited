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
import { restoreDownloadQueue, serializeDownloadQueue } from '../services/transferQueuePolicy';
import { announceSupporterValueMoment } from '../services/supporterVisibility';

interface ProgressPayload {
    id: string;
    percent: number;
    uploaded_bytes: number;
    total_bytes: number;
    speed_bytes_per_sec: number;
}

export function useFileDownload(store: Store | null) {
    const { t } = useTranslation();
    const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());
    const pausedRef = useRef<Set<string>>(new Set());
    const activeCountRef = useRef(0);
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

    // Load saved queue on mount
    useEffect(() => {
        if (!store || initialized) return;
        store.get<DownloadItem[]>('downloadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = restoreDownloadQueue(saved);
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
        if (!store || !initialized) return;
        const pending = serializeDownloadQueue(downloadQueue);
        store.set('downloadQueue', pending).then(() => store.save());
    }, [store, downloadQueue, initialized]);

    // Process up to maxConcurrentDownloads in parallel
    useEffect(() => {
        const maxConcurrent = settings.maxConcurrentDownloads || 1;
        const available = maxConcurrent - activeCountRef.current;
        if (available <= 0) return;
        const pendingItems = downloadQueue.filter(i => i.status === 'pending').slice(0, available);
        for (const item of pendingItems) {
            processItem(item);
        }
    }, [downloadQueue, settings.maxConcurrentDownloads]);

    const processItem = async (item: DownloadItem) => {
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
            if (pausedRef.current.has(item.id)) {
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
        const newItem: DownloadItem = {
            id: Math.random().toString(36).substr(2, 9),
            messageId,
            filename: cleanName,
            folderId,
            status: 'pending',
            totalBytes: fileSize,
            savePath,
        };
        setDownloadQueue(prev => [...prev, newItem]);
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

        const enqueueFiles = (dir: string) => {
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
            setDownloadQueue(prev => [...prev, ...newItems]);
            toast.info(`Queued ${files.length} files for download`);
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
                enqueueFiles(destination);
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
        enqueueFiles(dirPath);
    };

    const clearFinished = () => {
        setDownloadQueue(q => q.filter(i => i.status !== 'success'));
    };

    const cancelAll = () => {
        setDownloadQueue(q => {
            const active = q.filter(i => i.status === 'downloading' || i.status === 'decrypting' || i.status === 'verifying');
            for (const item of active) {
                cancelledRef.current.add(item.id);
                invoke('cmd_cancel_transfer', { transferId: item.id }).catch(() => {});
            }
            return q
                .filter(i => i.status !== 'pending' && i.status !== 'paused' && i.status !== 'cooldown')
                .map(i => active.some(activeItem => activeItem.id === i.id) ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All downloads cancelled');
    };

    const pauseAll = () => {
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
        setDownloadQueue(q => q.map(item => item.status === 'paused'
            ? { ...item, status: 'pending' as const, error: undefined }
            : item));
        toast.info('Downloads resumed');
    };

    const cancelItem = (id: string) => {
        setDownloadQueue(q => {
            const item = q.find(i => i.id === id);
            if (item && ['downloading', 'decrypting', 'verifying'].includes(item.status)) {
                cancelledRef.current.add(id);
                invoke('cmd_cancel_transfer', { transferId: id }).catch(() => {});
                return q.map(i => i.id === id ? { ...i, status: 'cancelled' as const } : i);
            }
            if (item?.status === 'pending' || item?.status === 'paused' || item?.status === 'cooldown') {
                return q.filter(i => i.id !== id);
            }
            return q;
        });
    };

    const retryItem = (id: string) => {
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
