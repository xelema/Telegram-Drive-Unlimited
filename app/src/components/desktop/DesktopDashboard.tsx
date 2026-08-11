import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
    closestCenter,
    DndContext,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { TelegramFile, BandwidthStats, ShareInfo, type SmartView, type StorageInsightResult } from '../../types';
import { formatBytes, isMediaFile, isPdfFile, isArchiveFile, nativeShareOrCopy, copyToClipboard } from '../../utils';

// Components
import { Sidebar } from './dashboard/Sidebar';
import { TopBar } from './dashboard/TopBar';
import { FileExplorer, type SortDirection, type SortField } from './dashboard/FileExplorer';
import { TransferCenter } from './dashboard/TransferCenter';
import { MoveToFolderModal } from './dashboard/MoveToFolderModal';
import { PreviewModal } from './dashboard/PreviewModal';
import { MediaPlayer } from './dashboard/MediaPlayer';
import { ExternalDropBlocker } from './dashboard/ExternalDropBlocker';
import { PdfViewer } from './dashboard/PdfViewer';
import { ArchiveViewerModal } from './dashboard/ArchiveViewerModal';
import { SettingsModal, type SettingsTab } from './dashboard/SettingsModal';
import { ShareDialog } from './dashboard/ShareDialog';
import { RenameFolderModal } from './dashboard/RenameFolderModal';
import { RenameFileModal } from './dashboard/RenameFileModal';
import { DesktopAdBanner } from './dashboard/DesktopAdBanner';
import { RemoteUploadModal } from './dashboard/RemoteUploadModal';
import { KeyboardShortcutsDialog } from './dashboard/KeyboardShortcutsDialog';
import { DriveConceptTour } from './dashboard/DriveConceptTour';
import { HelpCenterDialog } from './dashboard/HelpCenterDialog';
import { Files, Link, Copy, Check, X, Loader2, Share2 } from 'lucide-react';

// Hooks
import { useTelegramConnection } from '../../hooks/useTelegramConnection';
import { useFileOperations } from '../../hooks/useFileOperations';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useFileDownload } from '../../hooks/useFileDownload';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useSettings } from '../../context/SettingsContext';
import { useConfirm } from '../../context/ConfirmContext';
import { DEFAULT_SEARCH_FILTERS, filterAndRankFiles, type FileSearchFilters } from '../../services/fileSearch';

const sameFile = (left: TelegramFile, right: TelegramFile) => (
    left.id === right.id && (left.folder_id ?? null) === (right.folder_id ?? null)
);

export function Dashboard({ onLogout }: { onLogout: () => void }) {
    const queryClient = useQueryClient();
    const { t } = useTranslation();


    const {
        store, folders, groups, activeFolderId, setActiveFolderId, isSyncing, isConnected,
        handleLogout, handleSyncFolders, handleCreateFolder, handleFolderDelete,
        handleFolderRename, handleFolderToggleVisibility, handleExportFolderInvite,
        handleCreateGroup, handleDeleteGroup, handleUpdateGroup, handleAssignFolderToGroup,
        handleReorderFolders, handleUpdateGroupOrder
    } = useTelegramConnection(onLogout);


    const { settings, updateSetting, isLoaded: settingsLoaded } = useSettings();
    const { confirm } = useConfirm();

    useEffect(() => {
        if (sessionStorage.getItem('telegram-drive-recovered-session') !== 'true') return;
        sessionStorage.removeItem('telegram-drive-recovered-session');
        const timer = window.setTimeout(() => {
            toast.success('We recovered your session — transfers are still queued.');
        }, 500);
        return () => window.clearTimeout(timer);
    }, []);
    const viewMode = settings.viewMode;
    const setViewMode = (mode: 'grid' | 'list') => updateSetting('viewMode', mode);

    const [previewFile, setPreviewFile] = useState<TelegramFile | null>(null);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [showMoveModal, setShowMoveModal] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [createFolderRequest, setCreateFolderRequest] = useState(0);
    const [activeSmartView, setActiveSmartView] = useState<SmartView | null>('recents');
    const [searchTerm, setSearchTerm] = useState("");
    const [searchResults, setSearchResults] = useState<TelegramFile[]>([]);
    const [searchFilters, setSearchFilters] = useState<FileSearchFilters>(DEFAULT_SEARCH_FILTERS);
    const [isSearching, setIsSearching] = useState(false);
    const [folderSyncProgress, setFolderSyncProgress] = useState({ active: false, count: 0 });
    const [cardScale, setCardScale] = useState(1.0);
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
    const [internalDrag, setInternalDrag] = useState<{ fileIds: number[]; label: string } | null>(null);
    const dragSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const handleSortChange = (field: SortField) => {
        if (field === sortField) {
            setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
            return;
        }
        setSortField(field);
        setSortDirection('asc');
    };
    const [showRemoteUpload, setShowRemoteUpload] = useState(false);
    const [playingFile, setPlayingFile] = useState<TelegramFile | null>(null);
    const [pdfFile, setPdfFile] = useState<TelegramFile | null>(null);
    const [archiveViewFile, setArchiveViewFile] = useState<TelegramFile | null>(null);
    const [shareFile, setShareFile] = useState<TelegramFile | null>(null);
    const [bulkShareLinks, setBulkShareLinks] = useState<Array<{ file: TelegramFile; link: string }> | null>(null);
    const [bulkShareLoading, setBulkShareLoading] = useState(false);
    const [bulkShareCopied, setBulkShareCopied] = useState<Set<string>>(new Set());
    const [previewContextFiles, setPreviewContextFiles] = useState<TelegramFile[]>([]);
    const [previewContextIndex, setPreviewContextIndex] = useState(-1);
    const [renameFolder, setRenameFolder] = useState<{ id: number; name: string } | null>(null);
    const [moveFileTarget, setMoveFileTarget] = useState<TelegramFile | null>(null);
    const [renameFileTarget, setRenameFileTarget] = useState<TelegramFile | null>(null);

    useEffect(() => {
        const openSettings = (event: Event) => {
            const tab = (event as CustomEvent<{ tab?: SettingsTab }>).detail?.tab ?? 'general';
            setSettingsInitialTab(tab);
            setShowSettings(true);
        };
        window.addEventListener('telegram-drive-open-settings', openSettings);
        return () => window.removeEventListener('telegram-drive-open-settings', openSettings);
    }, []);

    const { data: allFiles = [], isLoading, error } = useQuery({
        queryKey: ['files', activeSmartView ?? 'folder', activeFolderId],
        queryFn: async () => {
            if (activeSmartView) {
                if (activeSmartView === 'offline') {
                    const localFiles = await invoke<TelegramFile[]>('cmd_get_offline_files', { limit: 250 });
                    return localFiles.map((file) => ({ ...file, sizeStr: formatBytes(file.size), type: 'file' as const }));
                }
                if (activeSmartView === 'large' || activeSmartView === 'old' || activeSmartView === 'duplicates') {
                    const insight = await invoke<StorageInsightResult>('cmd_get_storage_insight', {
                        view: activeSmartView,
                        largeThresholdBytes: 100 * 1024 * 1024,
                        oldFileDays: 365,
                    });
                    return insight.files.map((file) => ({ ...file, sizeStr: formatBytes(file.size), type: 'file' as const }));
                }
                const localFiles = await invoke<TelegramFile[]>('cmd_get_file_activity', { view: activeSmartView, limit: 250 });
                return localFiles.map((file) => ({ ...file, sizeStr: formatBytes(file.size), type: 'file' as const }));
            }
            setFolderSyncProgress({ active: true, count: 0 });
            const accumulatedFiles = new Map<number, TelegramFile>();
            queryClient.setQueryData(['files', 'folder', activeFolderId], []);

            const unlisten = await listen<any>('folder-load-chunk', (event) => {
                const payload = event.payload;
                if (payload.folderId === activeFolderId) {
                    const newChunk: TelegramFile[] = payload.files.map((f: any) => ({
                        ...f,
                        sizeStr: formatBytes(f.size),
                        type: (f.icon_type as TelegramFile['type']) || 'file'
                    }));
                    newChunk.forEach((file) => accumulatedFiles.set(file.id, file));
                    setFolderSyncProgress({ active: true, count: accumulatedFiles.size });
                    queryClient.setQueryData(['files', 'folder', activeFolderId], Array.from(accumulatedFiles.values()));
                }
            });

            try {
                await invoke('cmd_get_files', { folderId: activeFolderId });
                return Array.from(accumulatedFiles.values());
            } finally {
                unlisten();
                setFolderSyncProgress((progress) => ({ ...progress, active: false }));
            }
        },
        enabled: !!store,
    });

    const displayedFiles = useMemo(() => {
        const source = searchTerm.trim().length >= 2 && searchFilters.scope === 'all'
            ? [...allFiles, ...searchResults].filter((file, index, values) => values.findIndex((candidate) => candidate.id === file.id && candidate.folder_id === file.folder_id) === index)
            : allFiles;
        return filterAndRankFiles(source, searchTerm, searchFilters);
    }, [allFiles, searchResults, searchTerm, searchFilters]);
    const isCrossFolderView = activeSmartView !== null
        || (searchFilters.scope === 'all' && searchTerm.trim().length >= 2);

    const { data: bandwidth } = useQuery({
        queryKey: ['bandwidth'],
        queryFn: () => invoke<BandwidthStats>('cmd_get_bandwidth'),
        refetchInterval: 5000,
        enabled: !!store
    });


    const { uploadQueue, setUploadQueue, handleManualUpload, handleFolderUpload, handleDropUpload, handleUrlUpload, cancelAll: cancelUploads, pauseAll: pauseUploads, resumeAll: resumeUploads, cancelItem: cancelUploadItem, retryItem: retryUploadItem } = useFileUpload(activeFolderId, store);
    const { downloadQueue, queueDownload, queueBulkDownload, clearFinished: clearDownloads, cancelAll: cancelDownloads, pauseAll: pauseDownloads, resumeAll: resumeDownloads, cancelItem: cancelDownloadItem, retryItem: retryDownloadItem } = useFileDownload(store);

    const {
        handleDelete, handleBulkDelete, handleBulkDownload,
        handleBulkMove, handleDownloadFolder, handleGlobalSearch

    } = useFileOperations(activeFolderId, selectedIds, setSelectedIds, displayedFiles, queueBulkDownload);

    // Bulk share: generate links for all selected non-folder files
    const handleBulkShare = useCallback(async () => {
        const shareFiles = displayedFiles.filter(f => selectedIds.includes(f.id) && f.type !== 'folder');
        if (shareFiles.length === 0) {
            toast.info('No shareable files selected (folders cannot be shared)');
            return;
        }
        setBulkShareLinks([]);
        setBulkShareLoading(true);
        setBulkShareCopied(new Set());
        try {
            const results = await Promise.all(
                shareFiles.map(async (file) => {
                    try {
                        const info = await invoke<ShareInfo>('cmd_create_share', {
                            folderId: file.folder_id ?? activeFolderId,
                            messageId: file.id,
                            fileName: file.name,
                            fileSize: file.size,
                            password: null,
                            expiryHours: 24,
                        });
                        return { file, link: info.link };
                    } catch (e) {
                        toast.error(`Failed to share ${file.name}: ${e}`);
                        return null;
                    }
                })
            );
            const valid = results.filter((r): r is { file: TelegramFile; link: string } => r !== null);
            if (valid.length > 0) {
                setBulkShareLinks(valid);
                setSelectedIds([]);
            } else {
                setBulkShareLinks(null);
                toast.error('Failed to generate any share links');
            }
        } finally {
            setBulkShareLoading(false);
        }
    }, [displayedFiles, selectedIds, activeFolderId]);

    const handleCopyBulkLink = useCallback((link: string) => {
        navigator.clipboard.writeText(link);
        setBulkShareCopied(prev => new Set(prev).add(link));
        setTimeout(() => setBulkShareCopied(prev => {
            const next = new Set(prev);
            next.delete(link);
            return next;
        }), 2000);
    }, []);


    const handleSelectAll = useCallback(() => {
        if (isCrossFolderView) {
            toast.info('Open a folder to select multiple files safely.');
            return;
        }
        setSelectedIds(displayedFiles.map(f => f.id));
    }, [displayedFiles, isCrossFolderView]);

    const handleKeyboardDelete = useCallback(() => {
        if (selectedIds.length > 0) {
            handleBulkDelete();
        }
    }, [selectedIds, handleBulkDelete]);

    const handleEscape = useCallback(() => {
        lastClickedIndexRef.current = -1;
        setSelectedIds([]);
        setSearchTerm("");
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
        setArchiveViewFile(null);
    }, []);

    const handleFocusSearch = useCallback(() => {
        const searchInput = document.querySelector('input[data-file-search]') as HTMLInputElement;
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
    }, []);

    const handleEnter = useCallback(() => {
        if (selectedIds.length === 1) {
            const selected = displayedFiles.find(f => f.id === selectedIds[0]);
            if (selected) {
                if (selected.type === 'folder') {
                    setActiveFolderId(selected.id);
                } else {
                    handlePreview(selected, displayedFiles);
                }
            }
        }
    }, [selectedIds, displayedFiles, setActiveFolderId]);


    useEffect(() => {
        lastClickedIndexRef.current = -1;
        setSelectedIds([]);
        setShowMoveModal(false);
        setSearchTerm("");
        setSearchResults([]);
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
        setPreviewContextFiles([]);
        setPreviewContextIndex(-1);
        setArchiveViewFile(null);
    }, [activeFolderId, activeSmartView]);


    useEffect(() => {
        if (searchTerm.trim().length < 2 || searchFilters.scope === 'folder') {
            setSearchResults([]);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            const results = await handleGlobalSearch(searchTerm.trim());
            setSearchResults(results.map((file) => ({ ...file, sizeStr: formatBytes(file.size), type: 'file' })));
            setIsSearching(false);
        }, 500);

        return () => clearTimeout(timer);
    }, [searchTerm, searchFilters.scope, handleGlobalSearch]);




    const lastClickedIndexRef = useRef<number>(-1);

    const clearSelection = useCallback(() => {
        lastClickedIndexRef.current = -1;
        setSelectedIds([]);
    }, []);

    const handleFileClick = (e: React.MouseEvent, file: TelegramFile, orderedFiles: TelegramFile[] = []) => {
        e.stopPropagation();
        const filesSource = orderedFiles.length > 0 ? orderedFiles : displayedFiles;
        if (isCrossFolderView) {
            clearSelection();
            if (file.type === 'folder') {
                setActiveSmartView(null);
                setActiveFolderId(file.id);
            } else {
                handlePreview(file, filesSource);
            }
            return;
        }

        const id = file.id;
        const currentIndex = filesSource.findIndex(candidate => sameFile(candidate, file));

        if (e.shiftKey && lastClickedIndexRef.current >= 0) {
            // Shift+Click: range select from last clicked to current
            const start = Math.min(lastClickedIndexRef.current, currentIndex);
            const end = Math.max(lastClickedIndexRef.current, currentIndex);
            const rangeIds = filesSource.slice(start, end + 1).map(f => f.id);
            setSelectedIds(rangeIds);
        } else if (e.metaKey || e.ctrlKey) {
            // Ctrl/Cmd+Click: toggle individual file
            lastClickedIndexRef.current = currentIndex;
            setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
        } else {
            // Plain click: select single file
            lastClickedIndexRef.current = currentIndex;
            setSelectedIds([id]);
        }
    }

    const handleToggleSelection = useCallback((id: number) => {
        setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
    }, []);

    const handleFileMove = useCallback((file: TelegramFile) => {
        setMoveFileTarget(file);
        setShowMoveModal(true);
    }, []);

    const handleRename = useCallback((file: TelegramFile) => {
        setRenameFileTarget(file);
    }, []);

    const handleRenameSubmit = useCallback(async (newName: string) => {
        if (!renameFileTarget) return;
        try {
            await invoke('cmd_rename_file', {
                messageId: renameFileTarget.id,
                folderId: renameFileTarget.folder_id ?? activeFolderId,
                newName,
            });
            queryClient.invalidateQueries({ queryKey: ['files'] });
            toast.success(`Renamed to "${newName}"`);
        } catch (e) {
            toast.error(`Failed to rename: ${e}`);
            throw e;
        }
    }, [renameFileTarget, activeFolderId, queryClient]);

    const handleKeyboardDownload = useCallback(() => {
        if (selectedIds.length > 0) {
            handleBulkDownload();
        }
    }, [selectedIds, handleBulkDownload]);

    const handleKeyboardShare = useCallback(() => {
        if (selectedIds.length > 0) {
            handleBulkShare();
        }
    }, [selectedIds, handleBulkShare]);

    const handleKeyboardRename = useCallback(() => {
        if (selectedIds.length === 1) {
            const selected = displayedFiles.find(f => f.id === selectedIds[0]);
            if (selected && selected.type !== 'folder') {
                handleRename(selected);
            }
        }
    }, [selectedIds, displayedFiles, handleRename]);

    useKeyboardShortcuts({
        onSelectAll: handleSelectAll,
        onDelete: handleKeyboardDelete,
        onEscape: handleEscape,
        onSearch: handleFocusSearch,
        onEnter: handleEnter,
        onDownload: handleKeyboardDownload,
        onShare: handleKeyboardShare,
        onRename: handleKeyboardRename,
        onShowShortcuts: () => setShowShortcuts(true),
        enabled: !previewFile && !playingFile && !pdfFile && !archiveViewFile
            && !showMoveModal && !showSettings && !showShortcuts && !showHelp
            && !showRemoteUpload && !shareFile && !bulkShareLinks
            && settings.driveTourSeen
    });

    const handlePreview = (file: TelegramFile, orderedFiles?: TelegramFile[]) => {
        const sourceFolderId = file.folder_id ?? activeFolderId;
        void invoke('cmd_record_file_opened', {
            folderId: sourceFolderId,
            messageId: file.id,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.mime_type ?? null,
            fileExt: file.file_ext ?? null,
            createdAt: file.created_at ?? null,
            encryptionState: file.encryption_state ?? 'plain',
        }).then(() => queryClient.invalidateQueries({ queryKey: ['files', 'recents'] })).catch(() => {});
        const contextFiles = (orderedFiles || displayedFiles).filter((f) => f.type !== 'folder');
        const contextIndex = contextFiles.findIndex((candidate) => sameFile(candidate, file));

        setPreviewContextFiles(contextFiles);
        setPreviewContextIndex(contextIndex);

        const isMedia = isMediaFile(file.name);
        const isPdf = isPdfFile(file.name);
        const isArchive = isArchiveFile(file.name);

        if (isArchive) {
            setArchiveViewFile(file);
            setPreviewFile(null);
            setPlayingFile(null);
            setPdfFile(null);
        } else if (isMedia) {
            setPlayingFile(file);
            setPreviewFile(null);
            setPdfFile(null);
            setArchiveViewFile(null);
        } else if (isPdf) {
            setPdfFile(file);
            setPreviewFile(null);
            setPlayingFile(null);
            setArchiveViewFile(null);
        } else {
            setPreviewFile(file);
            setPlayingFile(null);
            setPdfFile(null);
            setArchiveViewFile(null);
        }
    };

    const navigatePreview = useCallback((step: 1 | -1) => {
        if (previewContextFiles.length === 0) return;

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id ?? archiveViewFile?.id;
        if (!currentFileId) return;

        const currentIndex = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + step + previewContextFiles.length) % previewContextFiles.length;
        const nextFile = previewContextFiles[nextIndex];
        if (!nextFile) return;

        setPreviewContextIndex(nextIndex);

        const isMedia = isMediaFile(nextFile.name);
        const isPdf = isPdfFile(nextFile.name);
        const isArchive = isArchiveFile(nextFile.name);

        if (isArchive) {
            setArchiveViewFile(nextFile);
            setPreviewFile(null);
            setPlayingFile(null);
            setPdfFile(null);
        } else if (isMedia) {
            setPlayingFile(nextFile);
            setPreviewFile(null);
            setPdfFile(null);
            setArchiveViewFile(null);
        } else if (isPdf) {
            setPdfFile(nextFile);
            setPreviewFile(null);
            setPlayingFile(null);
            setArchiveViewFile(null);
        } else {
            setPreviewFile(nextFile);
            setPlayingFile(null);
            setPdfFile(null);
            setArchiveViewFile(null);
        }
    }, [previewContextFiles, previewFile, playingFile, pdfFile, archiveViewFile]);

    const handleNextPreview = useCallback(() => {
        navigatePreview(1);
    }, [navigatePreview]);

    const handlePrevPreview = useCallback(() => {
        navigatePreview(-1);
    }, [navigatePreview]);

    const previewNeighborFiles = useCallback(() => {
        if (previewContextFiles.length === 0) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentFile = previewFile ?? playingFile ?? pdfFile ?? archiveViewFile;
        if (!currentFile) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentIdx = previewContextFiles.findIndex((file) => sameFile(file, currentFile));
        if (currentIdx === -1) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const nextIdx = (currentIdx + 1) % previewContextFiles.length;
        const prevIdx = (currentIdx - 1 + previewContextFiles.length) % previewContextFiles.length;

        return {
            nextFile: previewContextFiles[nextIdx] || null,
            prevFile: previewContextFiles[prevIdx] || null,
        };
    }, [previewContextFiles, previewFile, playingFile, pdfFile, archiveViewFile]);

    const handleMoveFilesToFolder = async (idsToMove: number[], targetFolderId: number | null) => {
        if (idsToMove.length === 0) return;
        const sourceFolders = new Set(displayedFiles.filter(file => idsToMove.includes(file.id)).map(file => file.folder_id ?? activeFolderId));
        if (sourceFolders.size > 1) {
            toast.info('Move files from one source folder at a time.');
            return;
        }
        const sourceFolderId = sourceFolders.values().next().value ?? activeFolderId;
        if (sourceFolderId === targetFolderId) {
            toast.info('File is already in this folder');
            return;
        }

        if (idsToMove.length >= 10) {
            const confirmed = await confirm({
                title: 'Bulk Move Confirmation',
                message: `You are about to move ${idsToMove.length} files. Are you sure?`,
                confirmText: `Move ${idsToMove.length} Files`,
                variant: 'info',
            });
            if (!confirmed) return;
        }

        try {
            await invoke('cmd_move_files', {
                messageIds: idsToMove,
                sourceFolderId,
                targetFolderId: targetFolderId
            });
            // Clean up stale thumbnail and preview cache entries for the old message IDs
            await Promise.all(idsToMove.flatMap(id => [
                invoke('cmd_delete_image_thumbnail', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
                invoke('cmd_delete_preview_for_message', { messageId: id, folderId: sourceFolderId }).catch(() => {}),
            ]));

            queryClient.invalidateQueries({ queryKey: ['files'] });
            setSelectedIds([]);
            toast.success(`Moved ${idsToMove.length} file(s).`);
        } catch {
            toast.error(`Failed to move file(s).`);
        }
    };

    const handleInternalDragStart = (event: DragStartEvent) => {
        if (event.active.data.current?.kind !== 'telegram-files') return;
        const fileIds = event.active.data.current.fileIds;
        if (!Array.isArray(fileIds) || fileIds.length === 0) return;
        setInternalDrag({
            fileIds: fileIds.filter((id): id is number => typeof id === 'number'),
            label: String(event.active.data.current.label || ''),
        });
    };

    const handleInternalDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setInternalDrag(null);
        if (!over) return;

        const activeKind = active.data.current?.kind;
        const overKind = over.data.current?.kind;

        if (activeKind === 'telegram-files') {
            const fileIds = active.data.current?.fileIds;
            const targetFolderId = over.data.current?.folderId;
            const isFolderTarget = overKind === 'sidebar-folder' || overKind === 'content-folder';
            if (isFolderTarget && Array.isArray(fileIds) && (targetFolderId === null || typeof targetFolderId === 'number')) {
                await handleMoveFilesToFolder(
                    fileIds.filter((id): id is number => typeof id === 'number'),
                    targetFolderId,
                );
            }
            return;
        }

        if (activeKind === 'sidebar-folder') {
            const draggedFolderId = active.data.current?.folderId;
            if (typeof draggedFolderId !== 'number') return;

            if (overKind === 'sidebar-group') {
                const groupId = over.data.current?.groupId;
                await handleAssignFolderToGroup(draggedFolderId, typeof groupId === 'number' ? groupId : null);
                return;
            }

            if (overKind === 'sidebar-folder') {
                const overFolderId = over.data.current?.folderId;
                if (typeof overFolderId !== 'number' || draggedFolderId === overFolderId) return;
                const oldIndex = folders.findIndex(folder => folder.id === draggedFolderId);
                const newIndex = folders.findIndex(folder => folder.id === overFolderId);
                if (oldIndex !== -1 && newIndex !== -1) {
                    await handleReorderFolders(arrayMove(folders, oldIndex, newIndex));
                }
            }
            return;
        }

        if (activeKind === 'sidebar-group' && overKind === 'sidebar-group') {
            const draggedGroupId = active.data.current?.groupId;
            const overGroupId = over.data.current?.groupId;
            if (typeof draggedGroupId !== 'number' || typeof overGroupId !== 'number' || draggedGroupId === overGroupId) return;
            const oldIndex = groups.findIndex(group => group.id === draggedGroupId);
            const newIndex = groups.findIndex(group => group.id === overGroupId);
            if (oldIndex !== -1 && newIndex !== -1) {
                await handleUpdateGroupOrder(arrayMove(groups, oldIndex, newIndex));
            }
        }
    };

    const currentFolderName = activeFolderId === null
        ? t('common.saved_messages')
        : folders.find(f => f.id === activeFolderId)?.name || t('common.folders');
    const currentViewName = activeSmartView
        ? ({
            recents: t('common.recents'),
            favorites: t('common.favorites'),
            pinned: t('common.pinned'),
            offline: t('common.offline_files'),
            large: t('common.large_files'),
            old: t('common.old_files'),
            duplicates: t('common.duplicates'),
        } as const)[activeSmartView]
        : currentFolderName;

    const updateActivityFlag = useCallback(async (file: TelegramFile, flag: 'favorite' | 'pinned') => {
        const nextValue = flag === 'favorite' ? !file.is_favorite : !file.is_pinned;
        await invoke('cmd_set_file_activity_flag', {
            folderId: file.folder_id ?? activeFolderId,
            messageId: file.id,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.mime_type ?? null,
            fileExt: file.file_ext ?? null,
            createdAt: file.created_at ?? null,
            encryptionState: file.encryption_state ?? 'plain',
            flag,
            value: nextValue,
        });
        await queryClient.invalidateQueries({ queryKey: ['files'] });
        toast.success(flag === 'favorite'
            ? (nextValue ? 'Added to Favorites' : 'Removed from Favorites')
            : (nextValue ? 'Pinned' : 'Unpinned'));
    }, [activeFolderId, queryClient]);


    const previewNeighbors = previewNeighborFiles();

    return (
        <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragStart={handleInternalDragStart}
            onDragCancel={() => setInternalDrag(null)}
            onDragEnd={handleInternalDragEnd}
        >
            <div className="desktop-shell relative flex h-screen w-full overflow-hidden bg-app-canvas">

            <ExternalDropBlocker
                currentFolderName={currentViewName}
                enabled={isConnected}
                onFilesDropped={handleDropUpload}
                onUploadClick={handleManualUpload}
            />

            <AnimatePresence>
                {showMoveModal && (
                    <MoveToFolderModal
                        folders={folders}
                        fileName={moveFileTarget?.name}
                        onClose={() => { setShowMoveModal(false); setMoveFileTarget(null); }}
                        onSelect={async (targetFolderId: number | null) => {
                            if (moveFileTarget) {
                                try {
                                    await invoke('cmd_move_files', {
                                        messageIds: [moveFileTarget.id],
                                        sourceFolderId: moveFileTarget.folder_id ?? activeFolderId,
                                        targetFolderId,
                                    });
                                    // Clean up stale thumbnail and preview cache for the old message ID
                                    await Promise.all([
                                        invoke('cmd_delete_image_thumbnail', { messageId: moveFileTarget.id, folderId: moveFileTarget.folder_id ?? activeFolderId }).catch(() => {}),
                                        invoke('cmd_delete_preview_for_message', { messageId: moveFileTarget.id, folderId: moveFileTarget.folder_id ?? activeFolderId }).catch(() => {}),
                                    ]);
                                    queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
                                    toast.success(`Moved "${moveFileTarget.name}"`);
                                    setMoveFileTarget(null);
                                    setShowMoveModal(false);
                                } catch {
                                    toast.error('Failed to move file');
                                }
                            } else {
                                handleBulkMove(targetFolderId, () => setShowMoveModal(false));
                            }
                        }}
                        activeFolderId={moveFileTarget?.folder_id ?? activeFolderId}
                        key="move-modal"
                    />
                )}
                {playingFile && (
                    <MediaPlayer
                        file={playingFile}
                        onClose={() => setPlayingFile(null)}
                        onNext={handleNextPreview}
                        onPrev={handlePrevPreview}
                        currentIndex={previewContextIndex}
                        totalItems={previewContextFiles.length}
                        activeFolderId={playingFile.folder_id ?? activeFolderId}
                        key={playingFile.id}
                    />
                )}
                {pdfFile && (
                    <PdfViewer
                        file={pdfFile}
                        onClose={() => setPdfFile(null)}
                        onNext={handleNextPreview}
                        onPrev={handlePrevPreview}
                        currentIndex={previewContextIndex}
                        totalItems={previewContextFiles.length}
                        activeFolderId={pdfFile.folder_id ?? activeFolderId}
                        key="pdf-viewer"
                    />
                )}
                {showRemoteUpload && (
                    <RemoteUploadModal
                        isOpen={showRemoteUpload}
                        onClose={() => setShowRemoteUpload(false)}
                        folders={folders}
                        onUpload={handleUrlUpload}
                        key="remote-upload-modal"
                    />
                )}
            </AnimatePresence>

            <Sidebar
                folders={folders}
                groups={groups}
                activeFolderId={activeFolderId}
                setActiveFolderId={setActiveFolderId}
                onDelete={handleFolderDelete}
                onRename={(id, name) => setRenameFolder({ id, name })}
                onToggleVisibility={async (id, _name, isPublic) => {
                    try {
                        await handleFolderToggleVisibility(id, !isPublic);
                        queryClient.invalidateQueries({ queryKey: ['folders'] });
                    } catch { /* toast handled in hook */ }
                }}
                onExportInvite={async (id, _name) => {
                    try {
                        const info = await handleExportFolderInvite(id);
                        try {
                            await copyToClipboard(info.link);
                            toast.success(`Invite link copied: ${info.link}`);
                        } catch (e) {
                            toast.error(`Failed to copy to clipboard: ${e}`);
                        }
                    } catch { /* backend error already toasted in hook */ }
                }}
                onCreate={handleCreateFolder}
                isSyncing={isSyncing}
                isConnected={isConnected}
                onSync={handleSyncFolders}
                onLogout={handleLogout}
                bandwidth={bandwidth || null}
                onAssignFolderToGroup={handleAssignFolderToGroup}
                onCreateGroup={handleCreateGroup}
                onUpdateGroup={handleUpdateGroup}
                onDeleteGroup={handleDeleteGroup}
                createFolderRequest={createFolderRequest}
                activeSmartView={activeSmartView}
                onSmartViewChange={setActiveSmartView}
            />

            <main className="flex min-w-0 flex-1 flex-col">
                <TopBar
                    currentFolderName={currentViewName}
                    selectedIds={selectedIds}
                    onShowMoveModal={() => setShowMoveModal(true)}
                    onBulkDownload={handleBulkDownload}
                    onBulkDelete={handleBulkDelete}
                    onBulkShare={handleBulkShare}
                    onDownloadFolder={handleDownloadFolder}
                    onClearSelection={clearSelection}
                    onUploadClick={handleManualUpload}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    cardScale={cardScale}
                    onCardScaleChange={setCardScale}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSortChange={handleSortChange}
                    searchTerm={searchTerm}
                    onSearchChange={setSearchTerm}
                    searchFilters={searchFilters}
                    onSearchFiltersChange={setSearchFilters}
                    onSettingsClick={() => setShowSettings(true)}
                    onRemoteUploadClick={() => setShowRemoteUpload(true)}
                    onNewFolderClick={() => setCreateFolderRequest((value) => value + 1)}
                    onShowShortcuts={() => setShowShortcuts(true)}
                    onShowHelp={() => setShowHelp(true)}
                />
                {(searchTerm.trim().length > 0 || searchFilters.type !== 'all' || searchFilters.size !== 'any' || searchFilters.date !== 'any') && (
                    <div className="px-5 pb-0 pt-3">
                        <h2 className="text-ui font-medium text-app-text-secondary">
                            {displayedFiles.length.toLocaleString()} result{displayedFiles.length === 1 ? '' : 's'}{searchTerm.trim() ? <> for <span className="text-app-accent">"{searchTerm}"</span></> : null}
                        </h2>
                    </div>
                )}
                <FileExplorer
                    folders={folders}
                    files={displayedFiles}
                    loading={(isLoading && allFiles.length === 0) || isSearching}
                    error={error}
                    viewMode={viewMode}
                    selectedIds={selectedIds}
                    activeFolderId={activeFolderId}
                    onFileClick={handleFileClick}
                    onDelete={handleDelete}
                    onDownload={(file) => queueDownload(file.id, file.name, file.folder_id ?? activeFolderId, file.size)}
                    onPreview={handlePreview}
                    onManualUpload={handleManualUpload}
                    onFolderUpload={handleFolderUpload}
                    showFolderUpload={settings.zipFolders}
                    onToggleSelection={handleToggleSelection}
                    onShare={setShareFile}
                    onRename={handleRename}
                    onFileMove={handleFileMove}
                    cardScale={cardScale}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSortChange={handleSortChange}
                    onToggleFavorite={(file) => void updateActivityFlag(file, 'favorite')}
                    onTogglePinned={(file) => void updateActivityFlag(file, 'pinned')}
                    syncProgress={folderSyncProgress}
                    selectionDisabled={isCrossFolderView}
                />
            </main>

            {previewFile && (
                <PreviewModal
                    file={previewFile}
                    activeFolderId={previewFile.folder_id ?? activeFolderId}
                    onClose={() => setPreviewFile(null)}
                    onNext={handleNextPreview}
                    onPrev={handlePrevPreview}
                    currentIndex={previewContextIndex}
                    totalItems={previewContextFiles.length}
                    nextFile={previewNeighbors.nextFile}
                    prevFile={previewNeighbors.prevFile}
                />
            )}

            {archiveViewFile && (
                <ArchiveViewerModal
                    file={archiveViewFile}
                    activeFolderId={archiveViewFile.folder_id ?? activeFolderId}
                    folders={folders}
                    onClose={() => setArchiveViewFile(null)}
                    onNext={handleNextPreview}
                    onPrev={handlePrevPreview}
                    currentIndex={previewContextIndex}
                    totalItems={previewContextFiles.length}
                    nextFile={previewNeighbors.nextFile}
                    prevFile={previewNeighbors.prevFile}
                />
            )}


            <TransferCenter
                uploads={uploadQueue}
                downloads={downloadQueue}
                onClearUploads={() => setUploadQueue(q => q.filter(i => i.status !== 'success' && i.status !== 'error' && i.status !== 'cancelled'))}
                onCancelUploads={cancelUploads}
                onPauseUploads={pauseUploads}
                onResumeUploads={resumeUploads}
                onCancelUpload={cancelUploadItem}
                onRetryUpload={retryUploadItem}
                onClearDownloads={clearDownloads}
                onCancelDownloads={cancelDownloads}
                onPauseDownloads={pauseDownloads}
                onResumeDownloads={resumeDownloads}
                onCancelDownload={cancelDownloadItem}
                onRetryDownload={retryDownloadItem}
            />

            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                initialTab={settingsInitialTab}
            />

            {showShortcuts && <KeyboardShortcutsDialog onClose={() => setShowShortcuts(false)} />}

            {settingsLoaded && !settings.driveTourSeen && (
                <DriveConceptTour
                    onFinish={() => updateSetting('driveTourSeen', true)}
                    onOpenHelp={() => { updateSetting('driveTourSeen', true); setShowHelp(true); }}
                    onOpenSupporter={() => { updateSetting('driveTourSeen', true); setSettingsInitialTab('privacy'); setShowSettings(true); }}
                />
            )}

            {showHelp && <HelpCenterDialog onClose={() => setShowHelp(false)} />}

            <DesktopAdBanner
                suppressed={
                    uploadQueue.some(item => ['pending', 'uploading', 'downloading', 'encrypting', 'verifying'].includes(item.status))
                    || downloadQueue.some(item => ['pending', 'cooldown', 'downloading', 'decrypting', 'verifying'].includes(item.status))
                    || Boolean(previewFile || playingFile || pdfFile || archiveViewFile || showSettings || showMoveModal || shareFile || showRemoteUpload || showHelp || !settings.driveTourSeen)
                }
                onSupport={() => { setSettingsInitialTab('privacy'); setShowSettings(true); }}
            />

            {shareFile && (
                <ShareDialog
                    file={shareFile}
                    onClose={() => setShareFile(null)}
                    folders={folders}
                    activeFolderId={activeFolderId}
                    onOpenSettings={() => { setShareFile(null); setSettingsInitialTab('webdav'); setShowSettings(true); }}
                />
            )}

            {renameFolder && (
                <RenameFolderModal
                    folderId={renameFolder.id}
                    currentName={renameFolder.name}
                    onRename={handleFolderRename}
                    onClose={() => setRenameFolder(null)}
                />
            )}

            {renameFileTarget && (
                <RenameFileModal
                    fileName={renameFileTarget.name}
                    onRename={handleRenameSubmit}
                    onClose={() => setRenameFileTarget(null)}
                />
            )}

            {/* Bulk Share Results Modal */}
            {bulkShareLinks && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onClick={() => setBulkShareLinks(null)}
                >
                    <div
                        className="bg-telegram-surface border border-telegram-border rounded-xl w-[500px] max-h-[70vh] shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="p-4 border-b border-telegram-border flex items-center justify-between">
                            <h3 className="text-telegram-text font-medium flex items-center gap-2">
                                <Link className="w-5 h-5 text-telegram-primary" />
                                {bulkShareLinks.length} Share Link{bulkShareLinks.length !== 1 ? 's' : ''}
                            </h3>
                            <button onClick={() => setBulkShareLinks(null)} className="text-telegram-subtext hover:text-telegram-text">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {bulkShareLoading ? (
                            <div className="flex flex-col items-center justify-center py-16 space-y-3">
                                <Loader2 className="w-8 h-8 text-telegram-primary animate-spin" />
                                <p className="text-sm text-telegram-subtext">Generating share links...</p>
                            </div>
                        ) : (
                            <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
                                {bulkShareLinks.map(({ file, link }) => {
                                    const isCopied = bulkShareCopied.has(link);
                                    return (
                                        <div
                                            key={file.id}
                                            className="p-3 rounded-lg bg-telegram-hover/30 border border-telegram-border/30 space-y-2"
                                        >
                                            <p className="text-xs font-semibold text-telegram-text truncate">{file.name}</p>
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    readOnly
                                                    value={link}
                                                    className="flex-1 bg-telegram-bg border border-telegram-border rounded-lg px-2.5 py-1.5 text-xs text-telegram-text focus:outline-none select-all truncate"
                                                />
                                                <button
                                                    onClick={() => handleCopyBulkLink(link)}
                                                    className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-center transition-all flex-shrink-0 ${
                                                        isCopied
                                                            ? 'bg-emerald-500 border-emerald-500 text-white'
                                                            : 'bg-telegram-hover border-telegram-border text-telegram-text hover:bg-white/10'
                                                    }`}
                                                >
                                                    {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                </button>
                                                {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                                                    <button
                                                        onClick={() => nativeShareOrCopy(file.name, file.sizeStr, link, () => handleCopyBulkLink(link))}
                                                        className="px-2.5 py-1.5 rounded-lg bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary border border-telegram-primary/30 transition-all flex items-center justify-center flex-shrink-0"
                                                    >
                                                        <Share2 className="w-3.5 h-3.5" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        <button
                            onClick={() => setBulkShareLinks(null)}
                            className="w-full px-4 py-2.5 border-t border-telegram-border bg-telegram-hover/20 hover:bg-telegram-hover/40 text-telegram-text text-sm font-medium transition-colors"
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}
                <DragOverlay dropAnimation={null}>
                    {internalDrag && (
                        <div className="flex max-w-xs items-center gap-2 rounded-lg border border-app-accent/40 bg-app-surface px-3 py-2 text-sm font-medium text-app-text shadow-2xl">
                            <Files className="h-4 w-4 shrink-0 text-app-accent" />
                            <span className="truncate">{internalDrag.label}</span>
                            {internalDrag.fileIds.length > 1 && (
                                <span className="rounded-full bg-app-accent px-1.5 py-0.5 text-[10px] font-bold text-app-accent-contrast">
                                    {internalDrag.fileIds.length}
                                </span>
                            )}
                        </div>
                    )}
                </DragOverlay>
            </div>
        </DndContext>
    );
}
