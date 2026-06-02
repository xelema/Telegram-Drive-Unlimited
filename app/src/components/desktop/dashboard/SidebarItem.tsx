import { useState, useEffect, useRef, useCallback } from 'react';
import { MoreVertical, Globe, Pencil, Trash2, EyeOff, Eye, Link } from 'lucide-react';

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    active: boolean;
    onClick: () => void;
    onDrop: (e: React.DragEvent) => void;
    onDelete?: () => void;
    folderId: number | null;
    isPublic?: boolean;
    onRename?: () => void;
    onToggleVisibility?: () => void;
    onExportInvite?: () => void;
}

/**
 * SidebarItem - Pure DOM event-based drop handling
 * 
 * With Tauri's dragDropEnabled: false, DOM events work reliably.
 * This component handles internal file moves via standard React drag events.
 * Right-click shows a context menu for folder management.
 */
export function SidebarItem({ icon: Icon, label, active = false, onClick, onDrop, onDelete, folderId, isPublic, onRename, onToggleVisibility, onExportInvite }: SidebarItemProps) {
    const [isOver, setIsOver] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const settingsBtnRef = useRef<HTMLDivElement>(null);

    const hasFolderActions = onDelete && folderId !== null;

    // Open the settings popover positioned relative to the ⋮ button
    const openSettingsPopover = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (!settingsBtnRef.current) return;
        const rect = settingsBtnRef.current.getBoundingClientRect();
        setContextMenu({ x: rect.left - 200, y: rect.bottom + 4 });
    }, []);

    // Open context menu at mouse position (right-click)
    const openContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (hasFolderActions) {
            setContextMenu({ x: e.clientX, y: e.clientY });
        }
    }, [hasFolderActions]);

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        const handler = () => setContextMenu(null);
        window.addEventListener('click', handler);
        window.addEventListener('contextmenu', handler);
        return () => {
            window.removeEventListener('click', handler);
            window.removeEventListener('contextmenu', handler);
        };
    }, [contextMenu]);

    // Adjust menu position to stay in viewport
    useEffect(() => {
        if (!contextMenu || !menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        let newX = contextMenu.x;
        let newY = contextMenu.y;
        if (newX + rect.width > window.innerWidth) newX = newX - rect.width;
        if (newY + rect.height > window.innerHeight) newY = newY - rect.height;
        if (newX !== contextMenu.x || newY !== contextMenu.y) {
            setContextMenu({ x: newX, y: newY });
        }
    }, [contextMenu]);

    return (
        <div
            onClick={onClick}
            onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsOver(true);
            }}
            onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
            }}
            onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX;
                const y = e.clientY;
                if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                    setIsOver(false);
                }
            }}
            onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsOver(false);
                if (onDrop) onDrop(e);
            }}
            onContextMenu={openContextMenu}
            className={`group w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer select-none ${active
                ? 'bg-telegram-primary/10 text-telegram-primary'
                : isOver
                    ? 'bg-telegram-primary/30 text-telegram-text ring-2 ring-telegram-primary scale-[1.02] shadow-lg'
                    : 'text-telegram-subtext hover:bg-telegram-hover hover:text-telegram-text'
                }`}
        >
            <Icon className={`w-4 h-4 ${isOver ? 'text-telegram-primary' : ''}`} />
            <span className="flex-1 text-left truncate">{label}</span>
            {isPublic && (
                <Globe className="w-3 h-3 text-emerald-400 flex-shrink-0" />
            )}
            {onDelete && (
                <div
                    ref={settingsBtnRef}
                    onClick={openSettingsPopover}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-telegram-hover transition-all"
                    title="Folder settings"
                >
                    <MoreVertical className="w-3.5 h-3.5 text-telegram-subtext hover:text-telegram-text" />
                </div>
            )}

            {/* Folder Context Menu */}
            {contextMenu && (
                <div
                    ref={menuRef}
                    className="fixed z-[300] min-w-[200px] bg-telegram-surface/95 backdrop-blur-xl border border-telegram-border rounded-lg shadow-2xl p-1.5 flex flex-col gap-0.5 animate-in fade-in zoom-in-95 duration-100"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div className="px-2 py-1.5 text-xs text-telegram-subtext font-medium truncate max-w-[180px] border-b border-telegram-border mb-1">
                        {label}
                    </div>

                    {onRename && (
                        <button
                            onClick={() => { setContextMenu(null); onRename(); }}
                            className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full"
                        >
                            <Pencil className="w-4 h-4 text-blue-400" />
                            Rename
                        </button>
                    )}

                    {onToggleVisibility && (
                        <button
                            onClick={() => { setContextMenu(null); onToggleVisibility(); }}
                            className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full"
                        >
                            {isPublic ? (
                                <>
                                    <EyeOff className="w-4 h-4 text-amber-400" />
                                    Make Private
                                </>
                            ) : (
                                <>
                                    <Eye className="w-4 h-4 text-emerald-400" />
                                    Make Public
                                </>
                            )}
                        </button>
                    )}

                    {onExportInvite && (
                        <button
                            onClick={() => { setContextMenu(null); onExportInvite(); }}
                            className="flex items-center gap-2 px-2 py-1.5 text-sm text-telegram-text hover:bg-telegram-hover rounded transition-colors text-left w-full"
                        >
                            <Link className="w-4 h-4 text-telegram-primary" />
                            Copy Invite Link
                        </button>
                    )}

                    <div className="h-px bg-telegram-border my-1" />

                    <button
                        onClick={() => { setContextMenu(null); onDelete?.(); }}
                        className="flex items-center gap-2 px-2 py-1.5 text-sm text-red-500 hover:bg-red-500/10 rounded transition-colors text-left w-full"
                    >
                        <Trash2 className="w-4 h-4" />
                        Delete
                    </button>
                </div>
            )}
        </div>
    )
}
