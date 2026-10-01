import { sourceFolder } from '../services/fileIdentity';
import { useCallback, useRef } from 'react';
import { useActionScope } from './useActionScope';
import { showFileDialogFallback, pickWithFallback, sanitizeFilename } from '../utils';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFile } from '../types';
import { updateFileQueryData, invalidateOwnedFileQueries } from '../services/fileListRefresh';
import { userFacingError } from '../services/userFacingError';
import { useTranslation } from 'react-i18next';

export function useFileOperations(
    activeFolderId: number | null,
    selectedIds: number[],
    setSelectedIds: (ids: number[]) => void,
    displayedFiles: TelegramFile[],
    queueBulkDownload?: (files: TelegramFile[], folderId: number | null) => void,
    ownerId: string | null = null,
) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();
    const { t } = useTranslation();
    const capture = useActionScope(ownerId);

    // Callbacks read current selection data without being recreated for every click.
    const selectedIdsRef = useRef(selectedIds);
    selectedIdsRef.current = selectedIds;
    const displayedFilesRef = useRef(displayedFiles);
    displayedFilesRef.current = displayedFiles;

    const handleDelete = useCallback(async (target: TelegramFile | number) => {
        const isCurrent = capture();
        if (!ownerId || !isCurrent()) return;
        // Resolve the original target before confirmation. Reading current
        // lists afterwards can reinterpret the same message ID in another account.
        const file = typeof target === 'number'
            ? displayedFilesRef.current.find(candidate => candidate.id === target)
            : target;
        if (!file) { toast.error(t('common.operation_failed')); return; }
        const id = file.id;
        const sourceFolderId = sourceFolder(file, activeFolderId);
        if (!await confirm({ title: "Delete File", message: "Are you sure you want to delete this file?", confirmText: "Delete", variant: 'danger' }) || !isCurrent()) return;
        try {
            await invoke('cmd_delete_file', { messageId: id, folderId: sourceFolderId, ownerId });
            if (!isCurrent()) return;
            updateFileQueryData(queryClient, sourceFolderId, new Set([id]), () => null, ownerId);
            void invalidateOwnedFileQueries(queryClient, ownerId);
            toast.success("File deleted");
        } catch (error) {
            if (isCurrent()) toast.error(userFacingError(error, t));
        }
    }, [activeFolderId, capture, confirm, ownerId, queryClient, t]);

    const handleBulkDelete = useCallback(async () => {
        const isCurrent = capture();
        if (!ownerId || !isCurrent()) return;
        const ids = [...selectedIdsRef.current];
        if (ids.length === 0) return;
        const targets = ids.map(id => displayedFilesRef.current.find(file => file.id === id))
            .filter((file): file is TelegramFile => Boolean(file))
            .map(file => ({ id: file.id, folderId: sourceFolder(file, activeFolderId) }));
        if (targets.length !== ids.length) { toast.error(t('common.operation_failed')); return; }
        if (!await confirm({ title: "Delete Files", message: `Are you sure you want to delete ${ids.length} files?`, confirmText: "Delete All", variant: 'danger' }) || !isCurrent()) return;
        let success = 0;
        let fail = 0;
        const deletedByFolder = new Map<number | null, number[]>();
        for (const target of targets) {
            if (!isCurrent()) return;
            try {
                await invoke('cmd_delete_file', { messageId: target.id, folderId: target.folderId, ownerId });
                if (!isCurrent()) return;
                success++;
                deletedByFolder.set(target.folderId, [...(deletedByFolder.get(target.folderId) ?? []), target.id]);
            } catch {
                if (!isCurrent()) return;
                fail++;
            }
        }
        if (!isCurrent()) return;
        setSelectedIds([]);
        for (const [folderId, deletedIds] of deletedByFolder) {
            updateFileQueryData(queryClient, folderId, new Set(deletedIds), () => null, ownerId);
        }
        void invalidateOwnedFileQueries(queryClient, ownerId);
        if (success > 0) toast.success(`Deleted ${success} files.`);
        if (fail > 0) toast.error(`Failed to delete ${fail} files.`);
    }, [activeFolderId, capture, confirm, ownerId, queryClient, setSelectedIds, t]);

    const handleRenameFile = useCallback(async (file: TelegramFile, newName: string) => {
        const isCurrent = capture();
        if (!ownerId || !isCurrent()) return false;
        const id = file.id;
        const folderId = sourceFolder(file, activeFolderId);
        try {
            await invoke('cmd_rename_file', { ownerId, messageId: id, folderId, newName });
            if (!isCurrent()) return false;
            updateFileQueryData(queryClient, folderId, new Set([id]), item => ({ ...item, name: newName }), ownerId);
            void invalidateOwnedFileQueries(queryClient, ownerId);
            toast.success(`Renamed to "${newName}"`);
            return true;
        } catch (error) {
            if (isCurrent()) toast.error(userFacingError(error, t));
            return false;
        }
    }, [activeFolderId, capture, ownerId, queryClient, t]);

    const handleMoveFiles = useCallback(async (files: TelegramFile[], targetFolderId: number | null, onSuccess?: () => void, confirmLarge = false) => {
        const isCurrent = capture();
        if (!ownerId || !isCurrent() || !files.length) return false;
        const ids = [...new Set(files.map(file => file.id))];
        const sourceFolders = new Set(files.map(file => sourceFolder(file, activeFolderId)));
        if (sourceFolders.size !== 1) { toast.info('Move files from one source folder at a time.'); return false; }
        const sourceFolderId = sourceFolders.values().next().value!;
        if (sourceFolderId === targetFolderId) { toast.info('File is already in this folder'); return false; }
        if (confirmLarge && ids.length >= 10) {
            const accepted = await confirm({ title: 'Bulk Move Confirmation', message: `You are about to move ${ids.length} files. Are you sure?`, confirmText: `Move ${ids.length} Files`, variant: 'info' });
            if (!accepted || !isCurrent()) return false;
        }
        try {
            await invoke('cmd_move_files', { ownerId, messageIds: ids, sourceFolderId, targetFolderId });
            if (!isCurrent()) return false;
            updateFileQueryData(queryClient, sourceFolderId, new Set(ids), () => null, ownerId);
            void invalidateOwnedFileQueries(queryClient, ownerId);
            toast.success(`Moved ${ids.length} files.`);
            onSuccess?.();
            return true;
        } catch (error) {
            if (isCurrent()) toast.error(userFacingError(error, t));
            return false;
        }
    }, [activeFolderId, capture, confirm, ownerId, queryClient, t]);

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
                    await invoke('cmd_download_file', { req: { message_id: file.id, save_path: filePath, folder_id: sourceFolder(file, activeFolderId) } });
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
        const ids = [...selectedIdsRef.current];
        const files = displayedFilesRef.current.filter(file => ids.includes(file.id));
        if (files.length !== ids.length) return;
        await handleMoveFiles(files, targetFolderId, () => { setSelectedIds([]); onSuccess?.(); });
    }, [handleMoveFiles, setSelectedIds]);

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
                    await invoke('cmd_download_file', { req: { message_id: file.id, save_path: filePath, folder_id: sourceFolder(file, activeFolderId) } });
                    successCount++;
                } catch { }
            }
            toast.success(`Folder Download Complete: ${successCount} files.`);
        };
        try {
            const dirPath = await pickWithFallback(
                () => open({
                    directory: true, multiple: false, title: "Download Folder To..."
                }),
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
            toast.error(userFacingError(e, t));
        }
    }, [activeFolderId, queueBulkDownload]);

    const handleGlobalSearch = useCallback(async (query: string) => {
        const isCurrent = capture();
        if (!ownerId || !isCurrent()) return [];
        try {
            const files = await invoke<TelegramFile[]>('cmd_search_global', { query, ownerId });
            return isCurrent() ? files : [];
        } catch {
            return [];
        }
    }, [capture, ownerId]);

    return {
        handleDelete,
        handleBulkDelete,
        handleBulkDownload,
        handleBulkMove,
        handleMoveFiles,
        handleRenameFile,
        handleDownloadFolder,
        handleGlobalSearch,
    };
}
