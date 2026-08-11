import { useCallback, useRef } from 'react';
import { showFileDialogFallback, pickWithFallback, sanitizeFilename } from '../utils';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFile } from '../types';

export function useFileOperations(
    activeFolderId: number | null,
    selectedIds: number[],
    setSelectedIds: (ids: number[]) => void,
    displayedFiles: TelegramFile[],
    queueBulkDownload?: (files: TelegramFile[], folderId: number | null) => void,
) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();

    // Callbacks read current selection data without being recreated for every click.
    const selectedIdsRef = useRef(selectedIds);
    selectedIdsRef.current = selectedIds;
    const displayedFilesRef = useRef(displayedFiles);
    displayedFilesRef.current = displayedFiles;

    const handleDelete = useCallback(async (target: TelegramFile | number) => {
        if (!await confirm({ title: "Delete File", message: "Are you sure you want to delete this file?", confirmText: "Delete", variant: 'danger' })) return;
        const file = typeof target === 'number'
            ? displayedFilesRef.current.find(candidate => candidate.id === target)
            : target;
        const id = typeof target === 'number' ? target : target.id;
        const sourceFolderId = file?.folder_id ?? activeFolderId;
        try {
            await invoke('cmd_delete_file', { messageId: id, folderId: sourceFolderId });
            await Promise.all([
                invoke('cmd_delete_image_thumbnail', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
                invoke('cmd_delete_preview_for_message', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
            ]);
            queryClient.invalidateQueries({ queryKey: ['files'] });
            toast.success("File deleted");
        } catch (e) {
            toast.error(`Delete failed: ${e}`);
        }
    }, [activeFolderId, confirm, queryClient]);

    const handleBulkDelete = useCallback(async () => {
        const ids = selectedIdsRef.current;
        if (ids.length === 0) return;
        if (!await confirm({ title: "Delete Files", message: `Are you sure you want to delete ${ids.length} files?`, confirmText: "Delete All", variant: 'danger' })) return;

        let success = 0;
        let fail = 0;
        for (const id of ids) {
            const sourceFolderId = displayedFilesRef.current.find(file => file.id === id)?.folder_id ?? activeFolderId;
            try {
                await invoke('cmd_delete_file', { messageId: id, folderId: sourceFolderId });
                await Promise.all([
                    invoke('cmd_delete_image_thumbnail', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
                    invoke('cmd_delete_preview_for_message', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
                ]);
                success++;
            } catch {
                fail++;
            }
        }
        setSelectedIds([]);
        queryClient.invalidateQueries({ queryKey: ['files'] });
        if (success > 0) toast.success(`Deleted ${success} files.`);
        if (fail > 0) toast.error(`Failed to delete ${fail} files.`);
    }, [activeFolderId, confirm, queryClient, setSelectedIds]);

    const handleBulkDownload = useCallback(async () => {
        const ids = selectedIdsRef.current;
        if (ids.length === 0) return;
        const currentFiles = displayedFilesRef.current;
        const targetFiles = currentFiles.filter((f) => ids.includes(f.id));
        if (targetFiles.length === 0) return;
        if (queueBulkDownload) {
            queueBulkDownload(targetFiles, activeFolderId);
            setSelectedIds([]);
            return;
        }
        const downloadToDir = async (dirPath: string) => {
            let successCount = 0;
            const sep = dirPath.includes('\\') ? '\\' : '/';
            for (const file of targetFiles) {
                const sanitizedName = sanitizeFilename(file.name);
                const filePath = dirPath.endsWith(sep) ? `${dirPath}${sanitizedName}` : `${dirPath}${sep}${sanitizedName}`;
                try {
                    await invoke('cmd_download_file', { req: { message_id: file.id, save_path: filePath, folder_id: activeFolderId } });
                    successCount++;
                } catch { }
            }
            toast.success(`Downloaded ${successCount} files.`);
            setSelectedIds([]);
        };
        try {
            const dirPath = await pickWithFallback(
                () => open({ directory: true, multiple: false, title: "Select Download Destination" }),
                () => handleBulkDownload(),
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
            await downloadToDir(dirPath);
        } catch (e) {
            toast.error(`Bulk download failed: ${e}`);
        }
    }, [activeFolderId, setSelectedIds, queueBulkDownload]);

    const handleBulkMove = useCallback(async (targetFolderId: number | null, onSuccess?: () => void) => {
        const ids = selectedIdsRef.current;
        if (ids.length === 0) return;
        const sourceFolders = new Set(displayedFilesRef.current.filter(file => ids.includes(file.id)).map(file => file.folder_id ?? activeFolderId));
        if (sourceFolders.size > 1) {
            toast.info('Move files from one source folder at a time.');
            return;
        }
        const sourceFolderId = sourceFolders.values().next().value ?? activeFolderId;
        try {
            await invoke('cmd_move_files', {
                messageIds: ids,
                sourceFolderId,
                targetFolderId: targetFolderId
            });
            // Clean up stale thumbnail and preview cache entries for the old message IDs.
            // After a move (forward+delete), the message gets a new ID in the
            // target folder, so old cached thumbnails are orphaned.
            await Promise.all(ids.flatMap(id => [
                invoke('cmd_delete_image_thumbnail', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
                invoke('cmd_delete_preview_for_message', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
            ]));
            toast.success(`Moved ${ids.length} files.`);
            queryClient.invalidateQueries({ queryKey: ['files'] });
            setSelectedIds([]);
            if (onSuccess) onSuccess();
        } catch {
            toast.error('Failed to move files');
        }
    }, [activeFolderId, queryClient, setSelectedIds]);

    const handleDownloadFolder = useCallback(async () => {
        const files = displayedFilesRef.current;
        if (files.length === 0) {
            toast.info("Folder is empty.");
            return;
        }
        if (queueBulkDownload) {
            queueBulkDownload(files, activeFolderId);
            return;
        }
        const downloadToDir = async (dirPath: string) => {
            let successCount = 0;
            toast.info(`Downloading folder contents (${files.length} files)...`);
            const sep = dirPath.includes('\\') ? '\\' : '/';
            for (const file of files) {
                const sanitizedName = sanitizeFilename(file.name);
                const filePath = dirPath.endsWith(sep) ? `${dirPath}${sanitizedName}` : `${dirPath}${sep}${sanitizedName}`;
                try {
                    await invoke('cmd_download_file', { req: { message_id: file.id, save_path: filePath, folder_id: activeFolderId } });
                    successCount++;
                } catch { }
            }
            toast.success(`Folder Download Complete: ${successCount} files.`);
        };
        try {
            const dirPath = await pickWithFallback(
                () => import('@tauri-apps/plugin-dialog').then(d => d.open({
                    directory: true, multiple: false, title: "Download Folder To..."
                })),
                () => handleDownloadFolder(),
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
            await downloadToDir(dirPath);
        } catch (e) {
            toast.error("Error: " + e);
        }
    }, [activeFolderId, queueBulkDownload]);

    const handleGlobalSearch = useCallback(async (query: string) => {
        try {
            return await invoke<TelegramFile[]>('cmd_search_global', { query });
        } catch {
            return [];
        }
    }, []);

    return {
        handleDelete,
        handleBulkDelete,
        handleBulkDownload,
        handleBulkMove,
        handleDownloadFolder,
        handleGlobalSearch,
    };
}
