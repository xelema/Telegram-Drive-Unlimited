import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { X, Folder, File, Archive, Loader2, AlertTriangle, FileArchive, Download, ChevronDown, HardDrive, Zap, Square, CheckCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ArchiveEntry, TelegramFile, TelegramFolder } from '../../../types';
import { formatBytes } from '../../../utils';
import { toast } from 'sonner';

interface ArchiveViewerModalProps {
    file: TelegramFile;
    activeFolderId?: number | null;
    folders: TelegramFolder[];
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    nextFile?: TelegramFile | null;
    prevFile?: TelegramFile | null;
}

interface ExtractedFile {
    temp_path: string;
    filename: string;
    size: number;
}

export function ArchiveViewerModal({
    file,
    activeFolderId,
    folders,
    onClose,
    onNext,
    onPrev,
    currentIndex = 0,
    totalItems = 0,
    nextFile,
    prevFile,
}: ArchiveViewerModalProps) {
    const queryClient = useQueryClient();
    const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const { t } = useTranslation();

    // Debounce cache invalidations so rapid successive extracts don't
    // flood React Query with individual refetch requests.
    const invalidationPending = useRef<Set<number | null>>(new Set());
    const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const debouncedInvalidate = (folderId: number | null) => {
        invalidationPending.current.add(folderId);
        if (invalidationTimer.current) clearTimeout(invalidationTimer.current);
        invalidationTimer.current = setTimeout(() => {
            const ids = invalidationPending.current;
            invalidationPending.current = new Set();
            for (const id of ids) {
                queryClient.invalidateQueries({ queryKey: ['files', id] });
            }
        }, 300);
    };
    // Clean up on unmount — flush pending invalidations, cancel running extract-all
    useEffect(() => {
        return () => {
            if (invalidationTimer.current) clearTimeout(invalidationTimer.current);
            const ids = invalidationPending.current;
            if (ids.size > 0) {
                invalidationPending.current = new Set();
                for (const id of ids) {
                    queryClient.invalidateQueries({ queryKey: ['files', id] });
                }
            }
            // Cancel any running extract-all so orphaned uploads don't continue
            extractAllCancelledRef.current = true;
            extractAllProgressUnlisten.current?.();
            if (extractAllCurrentTransferRef.current) {
                invoke('cmd_cancel_transfer', { transferId: extractAllCurrentTransferRef.current }).catch(() => {});
            }
        };
    }, []);

    // Extract-all state
    const [extractAllBusy, setExtractAllBusy] = useState(false);
    const [extractAllDone, setExtractAllDone] = useState(0);
    const [extractAllCancelled, setExtractAllCancelled] = useState(false);
    const [extractAllTargetFolderId, setExtractAllTargetFolderId] = useState<number | null>(activeFolderId ?? null);
    const [extractAllFolderMenuOpen, setExtractAllFolderMenuOpen] = useState(false);
    const extractAllMenuRef = useRef<HTMLDivElement | null>(null);
    const extractAllCancelledRef = useRef(false);
    const extractAllCurrentTransferRef = useRef<string>('');
    const extractAllProgressUnlisten = useRef<UnlistenFn | null>(null);
    const extractAllEntryStatuses = useRef<Map<number, 'done' | 'failed'>>(new Map());

    // Per-file progress during extract-all
    const [extractAllProgress, setExtractAllProgress] = useState<UploadProgress | null>(null);
    const [extractAllCurrentEntryIndex, setExtractAllCurrentEntryIndex] = useState<number | null>(null);

    // Close extract-all folder menu on click outside
    useEffect(() => {
        if (!extractAllFolderMenuOpen) return;
        const fn = (e: MouseEvent) => {
            if (extractAllMenuRef.current && !extractAllMenuRef.current.contains(e.target as Node)) {
                setExtractAllFolderMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', fn);
        return () => document.removeEventListener('mousedown', fn);
    }, [extractAllFolderMenuOpen]);

    const extractAllTargetName = extractAllTargetFolderId === null
        ? t('common.saved_messages')
        : folders.find(f => f.id === extractAllTargetFolderId)?.name ?? 'Current Folder';

    const handleExtractAll = async () => {
        if (extractAllBusy || !entries) return;
        const fileEntries = entries.filter(e => !e.is_dir);
        if (fileEntries.length === 0) return;

        setExtractAllBusy(true);
        setExtractAllDone(0);
        setExtractAllCancelled(false);
        setExtractAllProgress(null);
        setExtractAllCurrentEntryIndex(null);
        setExtractAllFolderMenuOpen(false);
        extractAllCancelledRef.current = false;
        extractAllEntryStatuses.current = new Map();

        // Subscribe to upload-progress once for the entire batch
        const unlisten = await listen<UploadProgress>('upload-progress', (event) => {
            if (event.payload.id === extractAllCurrentTransferRef.current) {
                setExtractAllProgress({
                    id: event.payload.id,
                    percent: event.payload.percent,
                    uploaded_bytes: event.payload.uploaded_bytes,
                    total_bytes: event.payload.total_bytes,
                    speed_bytes_per_sec: event.payload.speed_bytes_per_sec,
                });
            }
        });
        extractAllProgressUnlisten.current = unlisten;

        let done = 0;
        let failed = 0;
        let wasCancelled = false;

        for (let i = 0; i < entries.length; i++) {
            if (extractAllCancelledRef.current) {
                wasCancelled = true;
                break;
            }

            const entry = entries[i];
            if (entry.is_dir) continue;

            const transferId = `arch-extract-all-${Date.now()}-${i}`;
            extractAllCurrentTransferRef.current = transferId;
            setExtractAllCurrentEntryIndex(i);
            setExtractAllProgress(null);
            let extracted: ExtractedFile | null = null;

            try {
                // Step 1: Extract
                extracted = await invoke<ExtractedFile>('cmd_extract_archive_entry', {
                    messageId: file.id,
                    folderId: activeFolderId ?? null,
                    entryIndex: i,
                });

                if (extractAllCancelledRef.current) { wasCancelled = true; break; }

                // Step 2: Upload
                await invoke('initiate_upload', {
                    path: extracted.temp_path,
                    folderId: extractAllTargetFolderId,
                    transferId,
                });

                done++;
                extractAllEntryStatuses.current.set(i, 'done');
            } catch (e) {
                const msg = String(e);
                if (msg.includes('cancelled') || msg.includes('canceled')) {
                    wasCancelled = true;
                    break;
                }
                failed++;
                extractAllEntryStatuses.current.set(i, 'failed');
                console.error(`Extract-all failed for "${entry.filename}":`, msg);
            } finally {
                // Clean up temp file
                if (extracted?.temp_path) {
                    try { await invoke('cmd_delete_temp_zip', { path: extracted.temp_path }); } catch {}
                }
            }

            setExtractAllDone(done);
        }

        setExtractAllBusy(false);
        extractAllCurrentTransferRef.current = '';
        setExtractAllProgress(null);
        setExtractAllCurrentEntryIndex(null);
        extractAllProgressUnlisten.current?.();
        extractAllProgressUnlisten.current = null;

        // Refresh the file list (debounced)
        debouncedInvalidate(extractAllTargetFolderId);

        // Summary toast
        const destName = extractAllTargetFolderId === null ? t('common.saved_messages') : extractAllTargetName;
        if (wasCancelled) {
            if (done > 0) {
                toast.info(`${done} extracted, cancelled — to ${destName}`);
            } else {
                toast.info('Extract All cancelled');
            }
        } else if (failed === 0) {
            toast.success(`${done} file${done !== 1 ? 's' : ''} extracted to ${destName}`);
        } else {
            toast.warning(`${done} extracted, ${failed} failed — to ${destName}`);
        }
    };

    const handleCancelExtractAll = () => {
        if (extractAllCancelledRef.current) return;
        extractAllCancelledRef.current = true;
        setExtractAllCancelled(true);
        // Cancel the currently in-flight transfer
        if (extractAllCurrentTransferRef.current) {
            invoke('cmd_cancel_transfer', { transferId: extractAllCurrentTransferRef.current }).catch(() => {});
        }
    };

    const lastFileId = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            setError(null);
            setEntries(null);

            try {
                const result = await invoke<ArchiveEntry[]>('cmd_list_archive_contents', {
                    messageId: file.id,
                    folderId: activeFolderId ?? null,
                });
                if (!cancelled) {
                    const archiveChanged = lastFileId.current !== file.id;
                    lastFileId.current = file.id;
                    setEntries(result);
                    if (archiveChanged) extractAllEntryStatuses.current = new Map();
                }
            } catch (e) {
                if (!cancelled) {
                    setError(String(e));
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        load();
        return () => { cancelled = true; };
    }, [file.id, activeFolderId]);

    // Keyboard: Escape to close, arrow keys to navigate
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            } else if (e.key === 'ArrowRight' && onNext) {
                onNext();
            } else if (e.key === 'ArrowLeft' && onPrev) {
                onPrev();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, onNext, onPrev]);

    const totalSize = entries?.reduce((sum, e) => sum + (e.is_dir ? 0 : e.size), 0) ?? 0;
    const fileCount = entries?.filter(e => !e.is_dir).length ?? 0;
    const dirCount = entries?.filter(e => e.is_dir).length ?? 0;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            {/* Arrow navigation buttons */}
            {prevFile && onPrev && (
                <button
                    onClick={(e) => { e.stopPropagation(); onPrev(); }}
                    className="absolute left-4 top-1/2 -translate-y-1/2 z-[210] p-2 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-all"
                    aria-label="Previous file"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                </button>
            )}
            {nextFile && onNext && (
                <button
                    onClick={(e) => { e.stopPropagation(); onNext(); }}
                    className="absolute right-4 top-1/2 -translate-y-1/2 z-[210] p-2 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white transition-all"
                    aria-label="Next file"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
            )}

            <div
                className="bg-telegram-surface border border-telegram-border rounded-xl w-[520px] max-h-[70vh] shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-4 border-b border-telegram-border flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <FileArchive className="w-6 h-6 text-telegram-primary shrink-0" />
                        <div className="min-w-0">
                            <h3 className="text-telegram-text font-medium truncate">{file.name}</h3>
                            <p className="text-xs text-telegram-subtext">{file.sizeStr}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {totalItems > 1 && (
                            <span className="text-xs text-telegram-subtext mr-2">
                                {currentIndex + 1} / {totalItems}
                            </span>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-lg hover:bg-telegram-hover text-telegram-subtext hover:text-telegram-text transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Stats bar */}
                {entries && !loading && !error && (
                    <div className="px-4 py-2 border-b border-telegram-border/50 bg-telegram-hover/20 shrink-0">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-4 text-xs text-telegram-subtext">
                                <span className="flex items-center gap-1">
                                    <File className="w-3 h-3" />
                                    {fileCount} file{fileCount !== 1 ? 's' : ''}
                                </span>
                                {dirCount > 0 && (
                                    <span className="flex items-center gap-1">
                                        <Folder className="w-3 h-3" />
                                        {dirCount} folder{dirCount !== 1 ? 's' : ''}
                                    </span>
                                )}
                                <span>{formatBytes(totalSize)} total</span>
                            </div>

                            {/* Extract All / Cancel button */}
                            {fileCount > 0 && (
                                <div className="flex items-center gap-0.5 relative" ref={extractAllMenuRef}>
                                    {extractAllBusy && !extractAllCancelled && (
                                        <span className="text-[10px] text-telegram-primary mr-1 tabular-nums">
                                            {extractAllDone}/{fileCount}
                                        </span>
                                    )}

                                    {extractAllBusy ? (
                                        /* Cancel button during operation */
                                        <button
                                            onClick={handleCancelExtractAll}
                                            disabled={extractAllCancelled}
                                            className="px-2 py-1 rounded-md text-[11px] font-medium transition-all bg-red-500/10 hover:bg-red-500/20 text-red-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                                            title="Cancel Extract All"
                                        >
                                            <Square className="w-3 h-3" />
                                            <span>{extractAllCancelled ? 'Stopping...' : `Cancel (${extractAllDone}/${fileCount})`}</span>
                                        </button>
                                    ) : (
                                        /* Extract All button + folder dropdown (idle) */
                                        <>
                                            <button
                                                onClick={handleExtractAll}
                                                className="px-2 py-1 rounded-l-md text-[11px] font-medium transition-all bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 flex items-center gap-1"
                                                title={`Extract all ${fileCount} files to ${extractAllTargetName}`}
                                            >
                                                <Zap className="w-3 h-3" />
                                                <span>{t('archive.extract_all')} ({fileCount})</span>
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setExtractAllFolderMenuOpen(o => !o); }}
                                                className="px-1 py-1 rounded-r-md text-[11px] transition-all bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 flex items-center border-l border-emerald-500/20"
                                                title={`Bulk target: ${extractAllTargetName}`}
                                            >
                                                <ChevronDown className={`w-2.5 h-2.5 transition-transform ${extractAllFolderMenuOpen ? 'rotate-180' : ''}`} />
                                            </button>
                                        </>
                                    )}

                                    {/* Bulk folder dropdown */}
                                    {extractAllFolderMenuOpen && (
                                        <div
                                            className="absolute right-0 top-full mt-1 z-[220] w-48 bg-telegram-surface border border-telegram-border rounded-lg shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
                                            onClick={e => e.stopPropagation()}
                                        >
                                            <div className="px-3 py-2 border-b border-telegram-border/50">
                                                <p className="text-[10px] uppercase tracking-wider text-telegram-subtext">{t('archive.extract_all_to')}</p>
                                            </div>
                                            <div className="max-h-48 overflow-y-auto py-1">
                                                <button
                                                    onClick={() => { setExtractAllTargetFolderId(null); setExtractAllFolderMenuOpen(false); }}
                                                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-telegram-hover transition-colors ${extractAllTargetFolderId === null ? 'bg-emerald-500/10 text-emerald-600' : 'text-telegram-text'}`}
                                                >
                                                    <HardDrive className="w-3.5 h-3.5 shrink-0" />
                                                    <span className="truncate">{t('common.saved_messages')}</span>
                                                    {extractAllTargetFolderId === null && (
                                                        <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                                    )}
                                                </button>
                                                {folders.map(f => (
                                                    <button
                                                        key={f.id}
                                                        onClick={() => { setExtractAllTargetFolderId(f.id); setExtractAllFolderMenuOpen(false); }}
                                                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-telegram-hover transition-colors ${extractAllTargetFolderId === f.id ? 'bg-emerald-500/10 text-emerald-600' : 'text-telegram-text'}`}
                                                    >
                                                        <Folder className="w-3.5 h-3.5 shrink-0" />
                                                        <span className="truncate">{f.name}</span>
                                                        {extractAllTargetFolderId === f.id && (
                                                            <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-y-auto min-h-0">
                    {/* Loading */}
                    {loading && (
                        <div className="flex flex-col items-center justify-center py-16 space-y-3">
                            <Loader2 className="w-8 h-8 text-telegram-primary animate-spin" />
                            <p className="text-sm text-telegram-subtext">{t('common.loading')}</p>
                        </div>
                    )}

                    {/* Error */}
                    {error && !loading && (
                        <div className="flex flex-col items-center justify-center py-16 space-y-3 px-6">
                            <AlertTriangle className="w-10 h-10 text-amber-500" />
                            <p className="text-sm text-center text-telegram-text font-medium">
                                {t('archive.failed_read')}
                            </p>
                            <p className="text-xs text-center text-telegram-subtext max-w-sm break-words">
                                {error}
                            </p>
                        </div>
                    )}

                    {/* Empty */}
                    {entries && entries.length === 0 && !loading && !error && (
                        <div className="flex flex-col items-center justify-center py-16 space-y-3">
                            <Archive className="w-10 h-10 text-telegram-subtext/50" />
                            <p className="text-sm text-telegram-subtext">{t('archive.empty_archive')}</p>
                        </div>
                    )}

                    {/* File list */}
                    {entries && entries.length > 0 && (
                        <div className="p-2">
                            {entries.map((entry, i) => (
                                <div
                                    key={`${entry.filename}-${i}`}
                                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-telegram-hover/50 transition-colors group"
                                >
                                    {/* Icon */}
                                    <div className="shrink-0">
                                        {entry.is_dir ? (
                                            <Folder className="w-5 h-5 text-telegram-primary" />
                                        ) : (
                                            <File className="w-5 h-5 text-telegram-subtext/60" />
                                        )}
                                    </div>

                                    {/* Name */}
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm text-telegram-text truncate">
                                            {entry.is_dir ? entry.filename.replace(/\/$/, '') : entry.filename}
                                        </p>
                                        {/* Per-file status during Extract All */}
                                        {extractAllBusy && extractAllCurrentEntryIndex === i ? (
                                            extractAllProgress ? (
                                                /* Upload progress bar */
                                                <div className="flex items-center gap-1.5 mt-1">
                                                    <div className="flex-1 h-1 bg-telegram-hover rounded-full overflow-hidden max-w-[160px]">
                                                        <div
                                                            className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
                                                            style={{ width: `${Math.min(extractAllProgress.percent, 99)}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-[10px] text-emerald-600 font-mono tabular-nums shrink-0">
                                                        {Math.min(extractAllProgress.percent, 99)}%
                                                    </span>
                                                </div>
                                            ) : (
                                                /* Extracting spinner */
                                                <div className="flex items-center gap-1.5 mt-1">
                                                    <Loader2 className="w-2.5 h-2.5 text-telegram-subtext animate-spin" />
                                                    <span className="text-[10px] text-telegram-subtext">{t('archive.extracting')}</span>
                                                </div>
                                            )
                                        ) : extractAllEntryStatuses.current.get(i) === 'done' ? (
                                            <div className="flex items-center gap-1 mt-1">
                                                <CheckCircle className="w-3 h-3 text-emerald-500" />
                                                <span className="text-[10px] text-emerald-600">Extracted</span>
                                            </div>
                                        ) : extractAllEntryStatuses.current.get(i) === 'failed' ? (
                                            <div className="flex items-center gap-1 mt-1">
                                                <XCircle className="w-3 h-3 text-red-500" />
                                                <span className="text-[10px] text-red-500">Failed</span>
                                            </div>
                                        ) : null}
                                    </div>

                                    {/* Extract button (files only) */}
                                    {!entry.is_dir && (
                                        <ExtractButton
                                            file={file}
                                            activeFolderId={activeFolderId}
                                            folders={folders}
                                            entryIndex={i}
                                            entryName={entry.filename}
                                            entrySize={entry.size}
                                            disabled={extractAllBusy}
                                            onCacheInvalidate={debouncedInvalidate}
                                        />
                                    )}

                                    {/* Sizes */}
                                    <div className="shrink-0 text-right flex flex-col items-end">
                                        {!entry.is_dir ? (
                                            <>
                                                <p className="text-xs text-telegram-text font-mono">
                                                    {formatBytes(entry.size)}
                                                </p>
                                                {entry.compressed_size !== entry.size && (
                                                    <p className="text-[10px] text-telegram-subtext/60 font-mono">
                                                        {formatBytes(entry.compressed_size)} compressed
                                                    </p>
                                                )}
                                            </>
                                        ) : (
                                            <p className="text-[10px] text-telegram-subtext/60">folder</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-3 border-t border-telegram-border bg-telegram-hover/10 shrink-0">
                    <button
                        onClick={onClose}
                        className="w-full px-4 py-2 rounded-lg bg-telegram-hover hover:bg-telegram-hover/70 text-telegram-text text-sm font-medium transition-colors"
                    >
                        {t('common.close')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Extract & Upload button per archive entry ────────────────────────────

interface ExtractButtonProps {
    file: TelegramFile;
    activeFolderId?: number | null;
    folders: TelegramFolder[];
    entryIndex: number;
    entryName: string;
    entrySize: number;
    disabled?: boolean;
    onCacheInvalidate: (folderId: number | null) => void;
}

interface UploadProgress {
    id: string;
    percent: number;
    uploaded_bytes: number;
    total_bytes: number;
    speed_bytes_per_sec: number;
}

function ExtractButton({ file, activeFolderId, folders, entryIndex, entryName, entrySize, disabled: parentDisabled, onCacheInvalidate }: ExtractButtonProps) {
    const [extracting, setExtracting] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<UploadProgress | null>(null);
    const [targetFolderId, setTargetFolderId] = useState<number | null>(activeFolderId ?? null);
    const [folderMenuOpen, setFolderMenuOpen] = useState(false);
    const unlistenRef = useRef<UnlistenFn | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const { t } = useTranslation();

    // Close folder menu on click outside
    useEffect(() => {
        if (!folderMenuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setFolderMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [folderMenuOpen]);

    // Clean up listener on unmount
    useEffect(() => {
        return () => {
            unlistenRef.current?.();
        };
    }, []);

    const targetFolderName = targetFolderId === null
        ? t('common.saved_messages')
        : folders.find(f => f.id === targetFolderId)?.name ?? 'Current Folder';

    const handleExtract = async () => {
        if (extracting || uploading || parentDisabled) return;
        setExtracting(true);
        setProgress(null);
        setFolderMenuOpen(false);

        const transferId = `arch-extract-${Date.now()}-${entryIndex}`;
        let extracted: ExtractedFile | null = null;

        // Subscribe to upload progress BEFORE starting the upload
        const unlisten = await listen<UploadProgress>('upload-progress', (event) => {
            if (event.payload.id === transferId) {
                setProgress({
                    id: event.payload.id,
                    percent: event.payload.percent,
                    uploaded_bytes: event.payload.uploaded_bytes,
                    total_bytes: event.payload.total_bytes,
                    speed_bytes_per_sec: event.payload.speed_bytes_per_sec,
                });
            }
        });
        unlistenRef.current = unlisten;

        try {
            // Step 1: Extract
            extracted = await invoke<ExtractedFile>('cmd_extract_archive_entry', {
                messageId: file.id,
                folderId: activeFolderId ?? null,
                entryIndex,
            });

            setExtracting(false);
            setUploading(true);

            // Step 2: Upload to the selected target folder
            await invoke('initiate_upload', {
                path: extracted.temp_path,
                folderId: targetFolderId,
                transferId,
            });

            const destName = targetFolderId === null ? t('common.saved_messages') : targetFolderName;
            toast.success(`"${entryName}" extracted to ${destName}`);

            // Refresh the file list for the target folder (debounced)
            onCacheInvalidate(targetFolderId);
        } catch (e) {
            const msg = String(e);
            if (msg.includes('cancelled') || msg.includes('canceled')) {
                toast.info('Extract cancelled');
            } else {
                toast.error(`Failed: ${msg}`);
            }
        } finally {
            unlistenRef.current?.();
            unlistenRef.current = null;
            setExtracting(false);
            setUploading(false);
            setProgress(null);
            // Always clean up the temp file
            if (extracted?.temp_path) {
                try {
                    await invoke('cmd_delete_temp_zip', { path: extracted.temp_path });
                } catch {
                    // best-effort cleanup; OS will reclaim temp eventually
                }
            }
        }
    };

    const isBusy = extracting || uploading;
    const label = extracting ? t('archive.extracting') : 'Uploading...';
    const progressPct = progress ? Math.min(progress.percent, 99) : 0;
    const showProgress = uploading && progress;

    return (
        <div className="shrink-0 mr-2 flex flex-col items-end gap-0.5" ref={menuRef}>
            <div className="flex items-center gap-0.5">
                <button
                    onClick={handleExtract}
                    disabled={isBusy}
                    className="px-2 py-1 rounded-l-md text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-all bg-telegram-primary/10 hover:bg-telegram-primary/20 text-telegram-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    title={`Extract "${entryName}" (${formatBytes(entrySize)}) to ${targetFolderName}`}
                >
                    {isBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                        <Download className="w-3 h-3" />
                    )}
                    <span>{isBusy ? label : t('archive.extract')}</span>
                </button>

                {/* Folder selector trigger */}
                <button
                    onClick={(e) => { e.stopPropagation(); setFolderMenuOpen(o => !o); }}
                    disabled={isBusy}
                    className="px-1 py-1 rounded-r-md text-[11px] opacity-0 group-hover:opacity-100 transition-all bg-telegram-primary/10 hover:bg-telegram-primary/20 text-telegram-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center border-l border-telegram-primary/20"
                    title={`Target: ${targetFolderName}`}
                >
                    <ChevronDown className={`w-2.5 h-2.5 transition-transform ${folderMenuOpen ? 'rotate-180' : ''}`} />
                </button>
            </div>

            {/* Folder dropdown */}
            {folderMenuOpen && (
                <div
                    className="absolute right-2 mt-8 z-[220] w-48 bg-telegram-surface border border-telegram-border rounded-lg shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="px-3 py-2 border-b border-telegram-border/50">
                        <p className="text-[10px] uppercase tracking-wider text-telegram-subtext">{t('archive.extract_to')}</p>
                    </div>
                    <div className="max-h-48 overflow-y-auto py-1">
                        {/* Saved Messages */}
                        <button
                            onClick={() => { setTargetFolderId(null); setFolderMenuOpen(false); }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-telegram-hover transition-colors ${targetFolderId === null ? 'bg-telegram-primary/10 text-telegram-primary' : 'text-telegram-text'}`}
                        >
                            <HardDrive className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{t('common.saved_messages')}</span>
                            {targetFolderId === null && (
                                <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-telegram-primary" />
                            )}
                        </button>
                        {/* Folders */}
                        {folders.map(f => (
                            <button
                                key={f.id}
                                onClick={() => { setTargetFolderId(f.id); setFolderMenuOpen(false); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-telegram-hover transition-colors ${targetFolderId === f.id ? 'bg-telegram-primary/10 text-telegram-primary' : 'text-telegram-text'}`}
                            >
                                <Folder className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">{f.name}</span>
                                {targetFolderId === f.id && (
                                    <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-telegram-primary" />
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Inline progress bar — always visible during active upload */}
            {showProgress && (
                <div className={`w-full flex items-center gap-1.5 transition-all ${uploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    <div className="flex-1 h-1 bg-telegram-hover rounded-full overflow-hidden">
                        <div
                            className="h-full bg-telegram-primary rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${progressPct}%` }}
                        />
                    </div>
                    <span className="text-[10px] text-telegram-subtext font-mono tabular-nums shrink-0">
                        {progressPct}%
                    </span>
                </div>
            )}
        </div>
    );
}
