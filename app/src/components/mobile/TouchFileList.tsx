import { useRef, useState, useCallback } from 'react';
import { DownloadCloud, Trash2, Pencil, CheckSquare, X, Check, FolderInput, MoreVertical, Eye, Link, Copy } from 'lucide-react';
import { FileTypeIcon } from '../shared/FileTypeIcon';
import { ActionPopover, ActionItem } from './ActionPopover';
import { TelegramFile, TelegramFolder } from '../../types';

interface TouchFileListProps {
  files: TelegramFile[];
  isLoading: boolean;
  onDownload: (file: TelegramFile) => void;
  onDelete: (file: TelegramFile) => void;
  onPreview: (file: TelegramFile) => void;
  onRename: (file: TelegramFile) => void;
  selectedIds: number[];
  onToggleSelection: (id: number) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkDelete: () => void;
  onBulkDownload: () => void;
  onBulkMove: (targetFolderId: number | null) => void;
  onBulkShare?: () => void;
  onShare?: (file: TelegramFile) => void;
  onCopyTelegramLink?: (file: TelegramFile) => void;
  folders: TelegramFolder[];
  activeFolderId: number | null;
}

export function TouchFileList({ files, isLoading, onDownload, onDelete, onPreview, onRename, selectedIds, onToggleSelection, onSelectAll, onClearSelection, onBulkDelete, onBulkDownload, onBulkMove, onBulkShare, onShare, onCopyTelegramLink, folders, activeFolderId }: TouchFileListProps) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [actionMenuFile, setActionMenuFile] = useState<TelegramFile | null>(null);
  const isSelectionActive = selectionMode || selectedIds.length > 0;

  // Long-press detection refs
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFiredRef = useRef(false);
  const LONG_PRESS_DURATION = 500;

  // Long-press handlers — defined BEFORE any early returns to satisfy Rules of Hooks.
  // On Android, long-press opens the action popover (file options menu).
  const handlePointerDown = useCallback((e: React.PointerEvent, file: TelegramFile) => {
    if (isSelectionActive) return;
    longPressFiredRef.current = false;
    longPressPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      // Haptic feedback — short vibration pulse (Web Vibration API, supported in Android WebView)
      navigator.vibrate?.(15);
      setActionMenuFile(file);
    }, LONG_PRESS_DURATION);
  }, [isSelectionActive]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!longPressPosRef.current || !longPressTimerRef.current) return;
    const dx = Math.abs(e.clientX - longPressPosRef.current.x);
    const dy = Math.abs(e.clientY - longPressPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressPosRef.current = null;
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPosRef.current = null;
  }, []);

  // Build action items for a file's popover menu
  const buildFileActions = useCallback((file: TelegramFile): ActionItem[] => {
    const actions: ActionItem[] = [
      {
        label: 'Preview',
        icon: <Eye className="w-4 h-4" />,
        onClick: () => onPreview(file),
      },
      {
        label: 'Download',
        icon: <DownloadCloud className="w-4 h-4" />,
        onClick: () => onDownload(file),
      },
      {
        label: 'Rename',
        icon: <Pencil className="w-4 h-4" />,
        onClick: () => onRename(file),
      },
    ];
    if (file.type !== 'folder' && onShare) {
      actions.push({
        label: 'Share Link',
        icon: <Link className="w-4 h-4" />,
        onClick: () => onShare(file),
      });
    }
    // Telegram native t.me link (only for files in public channels with a username)
    if (file.type !== 'folder' && onCopyTelegramLink) {
      const folder = folders.find(f => f.id === file.folder_id) || folders.find(f => f.id === activeFolderId);
      const username = folder?.username || (folder as any)?.chat?.username || (folder as any)?.channel?.username;
      if (username) {
        actions.push({
          label: 'Copy Telegram Link',
          icon: <Copy className="w-4 h-4" />,
          onClick: () => onCopyTelegramLink(file),
        });
      }
    }
    actions.push({
      label: 'Delete',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => onDelete(file),
      destructive: true,
    });
    return actions;
  }, [onPreview, onDownload, onRename, onDelete, onShare, onCopyTelegramLink, folders, activeFolderId]);

  return (
    <>
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center">
          <div className="animate-spin rounded-full h-7 w-7 border-t-2 border-b-2 border-telegram-primary"></div>
          <p className="text-xs text-telegram-subtext font-semibold">Retrieving your files...</p>
        </div>
      )}

      {!isLoading && files.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center px-4">
          <div className="p-4 rounded-2xl bg-telegram-hover/10 text-telegram-subtext border border-telegram-border/10">
            📁
          </div>
          <h4 className="text-sm font-bold text-telegram-text">This folder is empty</h4>
          <p className="text-xs text-telegram-subtext max-w-xs leading-relaxed">
            Upload files or synchronise folders to begin managing content.
          </p>
        </div>
      )}

      {!isLoading && files.length > 0 && (
        <>
          {/* Selection mode toggle & batch action bar */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => {
                if (isSelectionActive) {
                  onClearSelection();
                }
                setSelectionMode(!selectionMode);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 active:scale-95 ${
                isSelectionActive
                  ? 'bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30'
                  : 'bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30'
              }`}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {isSelectionActive ? `${selectedIds.length} selected` : 'Select'}
            </button>
            {isSelectionActive && (
              <>
                <button
                  onClick={onSelectAll}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[10px] font-semibold bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30 active:scale-95 transition-all duration-200"
                >
                  <Check className="w-3 h-3" />
                  All
                </button>
                <button
                  onClick={onClearSelection}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[10px] font-semibold bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30 active:scale-95 transition-all duration-200"
                >
                  <X className="w-3 h-3" />
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Batch action bar - visible when items are selected */}
          {isSelectionActive && selectedIds.length > 0 && (
            <div className="sticky top-0 z-10 flex items-center justify-center gap-3 p-3 mb-3 rounded-2xl bg-telegram-primary/10 border border-telegram-primary/20 backdrop-blur-md animate-in slide-in-from-top-2">
              <button
                onClick={onBulkDownload}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30 active:scale-95 transition-all duration-200"
              >
                <DownloadCloud className="w-3.5 h-3.5" />
                Download ({selectedIds.length})
              </button>
              <button
                onClick={() => setShowMovePicker(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 active:scale-95 transition-all duration-200"
              >
                <FolderInput className="w-3.5 h-3.5" />
                Move ({selectedIds.length})
              </button>
              {onBulkShare && (
                <button
                  onClick={onBulkShare}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-teal-500/20 text-teal-400 border border-teal-500/30 active:scale-95 transition-all duration-200"
                >
                  <Link className="w-3.5 h-3.5" />
                  Share ({selectedIds.length})
                </button>
              )}
              <button
                onClick={onBulkDelete}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30 active:scale-95 transition-all duration-200"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete ({selectedIds.length})
              </button>
            </div>
          )}

          {/* Move-to-folder picker modal */}
          {showMovePicker && (
            <div
              className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm"
              onClick={() => setShowMovePicker(false)}
            >
              <div
                className="bg-[#1c1c1c] border border-white/10 rounded-2xl p-5 w-[300px] max-h-[60vh] flex flex-col shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-white">Move {selectedIds.length} file{selectedIds.length !== 1 ? 's' : ''} to...</h3>
                  <button
                    onClick={() => setShowMovePicker(false)}
                    className="p-1.5 rounded-lg hover:bg-white/10 text-telegram-subtext"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                  {/* Saved Messages */}
                  <button
                    onClick={() => { onBulkMove(null); setShowMovePicker(false); }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                      activeFolderId === null
                        ? 'bg-telegram-primary/10 text-telegram-primary'
                        : 'text-telegram-subtext hover:bg-white/5'
                    }`}
                  >
                    📁 Saved Messages
                  </button>
                  {folders
                    .filter(f => f.id !== activeFolderId)
                    .map(folder => (
                      <button
                        key={folder.id}
                        onClick={() => { onBulkMove(folder.id); setShowMovePicker(false); }}
                        className="w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold text-telegram-subtext hover:bg-white/5 transition-all duration-200"
                      >
                        📁 {folder.name}
                      </button>
                    ))}
                  {folders.filter(f => f.id !== activeFolderId).length === 0 && (
                    <p className="text-xs text-telegram-subtext/60 text-center py-4">No other folders available</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* File list — no more swipeable list, just tap-friendly rows with ⋮ menu */}
          <div className="space-y-2.5 pb-20">
            {files.map((file) => {
              const isSelected = selectedIds.includes(file.id);

              return (
                <div
                  key={file.id}
                  onPointerDown={(e) => handlePointerDown(e, file)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onClick={() => {
                    // If long-press just fired, skip the click — the ActionPopover is already open
                    if (longPressFiredRef.current) {
                      longPressFiredRef.current = false;
                      return;
                    }
                    if (isSelectionActive) {
                      onToggleSelection(file.id);
                    } else {
                      onPreview(file);
                    }
                  }}
                  className={`flex items-center justify-between p-3.5 rounded-2xl bg-telegram-hover/15 border transition-all duration-200 cursor-pointer active:bg-telegram-hover/35 ${
                    isSelected ? 'border-telegram-primary/50 bg-telegram-primary/10' : 'border-telegram-border/20'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    {/* Selection checkbox in selection mode */}
                    {isSelectionActive && (
                      <div className={`flex-shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all duration-200 ${
                        isSelected
                          ? 'bg-telegram-primary border-telegram-primary text-black'
                          : 'border-telegram-border/50 bg-transparent'
                      }`}>
                        {isSelected && <Check className="w-3.5 h-3.5" />}
                      </div>
                    )}
                    <div className="flex-shrink-0">
                      <FileTypeIcon filename={file.name} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-telegram-text truncate max-w-[150px] leading-snug">{file.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-telegram-subtext/80 font-medium font-mono">{file.sizeStr}</span>
                        <span className="w-1 h-1 bg-telegram-border rounded-full" />
                        <span className="text-[10px] text-telegram-subtext/80 font-medium">{file.created_at || 'Sync'}</span>
                      </div>
                    </div>
                  </div>

                  {/* ⋮ menu button — replaces swipe gesture */}
                  {!isSelectionActive && (
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActionMenuFile(file);
                      }}
                      className="flex-shrink-0 p-2 rounded-xl hover:bg-telegram-hover/40 active:bg-telegram-hover/60 text-telegram-subtext/60 hover:text-telegram-subtext transition-all duration-200"
                      aria-label="File actions"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Action popover for file operations */}
      {actionMenuFile && (
        <ActionPopover
          title={actionMenuFile.name}
          actions={buildFileActions(actionMenuFile)}
          onClose={() => setActionMenuFile(null)}
        />
      )}
    </>
  );
}
