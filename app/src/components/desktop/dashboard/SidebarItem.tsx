import { createPortal } from 'react-dom';
import { MoreVertical, Globe, Pencil, Trash2, EyeOff, Eye, Link } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { FolderGroup } from '../../../types';
import { useSidebarFolderMenu } from './useSidebarFolderMenu';

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    active: boolean;
    onClick: () => void;
    onDelete?: () => void;
    folderId: number | null;
    isPublic?: boolean;
    onRename?: () => void;
    onToggleVisibility?: () => void;
    onExportInvite?: () => void;
    collapsed?: boolean;
    groups?: FolderGroup[];
    onAssignFolderToGroup?: (folderId: number, groupId: number | null) => void;
}

/**
 * Sortable sidebar folder and drop target for pointer/keyboard file moves.
 */
export function SidebarItem({
    icon: Icon, label, active = false, onClick, onDelete, folderId, isPublic, onRename, onToggleVisibility, onExportInvite, collapsed = false,
    groups = [], onAssignFolderToGroup
}: SidebarItemProps) {
    const { t } = useTranslation();

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
        isOver,
        active: dragActive,
    } = useSortable({
        id: folderId !== null ? `folder-${folderId}` : 'saved-messages',
        data: { kind: 'sidebar-folder', folderId },
        disabled: folderId === null ? { draggable: true, droppable: false } : false,
    });

    const style = folderId !== null ? {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
    } : undefined;

    const hasFolderActions = onDelete && folderId !== null;
    const {
        menuPosition,
        menuRef,
        triggerRef,
        openFromTrigger,
        openFromContextMenu,
        runAndClose,
    } = useSidebarFolderMenu(Boolean(hasFolderActions));
    const isFileDragOver = isOver && dragActive?.data.current?.kind === 'telegram-files';
    const dragCount = Array.isArray(dragActive?.data.current?.fileIds)
        ? dragActive.data.current.fileIds.length
        : 0;

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={onClick}
            title={collapsed ? label : undefined}
            onContextMenu={openFromContextMenu}
            className={`quiet-control group flex h-8 w-full cursor-pointer select-none items-center text-ui ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'} ${active
                ? 'bg-app-selected font-medium text-app-text'
                : isFileDragOver
                    ? 'bg-app-selected text-app-text ring-2 ring-app-accent'
                    : 'text-app-text-secondary hover:text-app-text'
                }`}
        >
            <Icon className={`h-4 w-4 flex-shrink-0 ${active || isFileDragOver ? 'text-app-accent' : ''}`} />
            {!collapsed && <span className="flex-1 truncate text-start">{label}</span>}
            {isFileDragOver && dragCount > 1 && (
                <span className="flex-shrink-0 px-1.5 py-0.5 bg-telegram-primary text-white text-[10px] font-bold rounded-full leading-none min-w-[18px] text-center">
                    {dragCount}
                </span>
            )}
            {isPublic && !collapsed && (
                <Globe className="w-3 h-3 text-emerald-400 flex-shrink-0" />
            )}
            {onDelete && !collapsed && (
                <button
                    type="button"
                    ref={triggerRef}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={openFromTrigger}
                    className="quiet-control flex h-7 w-7 items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-app-hover focus-visible:opacity-100"
                    title={t('files.folder_settings')}
                    aria-label={t('files.folder_settings')}
                >
                    <MoreVertical className="w-3.5 h-3.5 text-telegram-subtext hover:text-telegram-text" />
                </button>
            )}

            {/* Folder Context Menu */}
            {menuPosition && createPortal((
                <div
                    ref={menuRef}
                    className="quiet-menu fixed z-[300] flex min-w-[232px] flex-col gap-1 p-1.5 animate-in fade-in duration-100"
                    style={{ left: menuPosition.x, top: menuPosition.y }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div className="mb-1 max-w-[216px] truncate border-b border-app-border-subtle px-3 py-2.5 text-ui font-medium text-app-text-secondary">
                        {label}
                    </div>

                    {onRename && (
                        <button
                            onClick={() => runAndClose(onRename)}
                            className="quiet-menu-item min-h-10 gap-3 px-3 py-2"
                        >
                            <Pencil className="w-4 h-4 text-blue-400" />
                            {t('files.rename')}
                        </button>
                    )}

                    {onToggleVisibility && (
                        <button
                            onClick={() => runAndClose(onToggleVisibility)}
                            className="quiet-menu-item min-h-10 gap-3 px-3 py-2"
                        >
                            {isPublic ? (
                                <>
                                    <EyeOff className="w-4 h-4 text-amber-400" />
                                    {t('files.make_private')}
                                </>
                            ) : (
                                <>
                                    <Eye className="w-4 h-4 text-emerald-400" />
                                    {t('files.make_public')}
                                </>
                            )}
                        </button>
                    )}

                    {onExportInvite && (
                        <button
                            onClick={() => runAndClose(onExportInvite)}
                            className="quiet-menu-item min-h-10 gap-3 px-3 py-2"
                        >
                            <Link className="w-4 h-4 text-telegram-primary" />
                            {t('files.copy_link')}
                        </button>
                    )}

                    {onAssignFolderToGroup && folderId !== null && groups && groups.length > 0 && (
                        <>
                            <div className="my-1.5 h-px bg-telegram-border" />
                            <div className="px-3 py-1.5 text-badge font-medium text-app-text-tertiary">
                                {t('files.move_to_group') || "Move to Group"}
                            </div>
                            <button
                                onClick={() => runAndClose(() => onAssignFolderToGroup(folderId, null))}
                                className="quiet-menu-item min-h-10 gap-3 px-3 py-2 text-metadata"
                            >
                                <span className="w-1.5 h-1.5 rounded-full bg-telegram-subtext" />
                                {t('common.unassigned') || "None (Unassigned)"}
                            </button>
                            {groups.map(group => (
                                <button
                                    key={group.id}
                                    onClick={() => runAndClose(() => onAssignFolderToGroup(folderId, group.id))}
                                    className="quiet-menu-item min-h-10 gap-3 px-3 py-2 text-metadata"
                                >
                                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: group.color_hex }} />
                                    {group.name}
                                </button>
                            ))}
                        </>
                    )}

                    <div className="my-1.5 h-px bg-telegram-border" />

                    <button
                        onClick={() => runAndClose(onDelete)}
                        className="quiet-menu-item min-h-10 gap-3 px-3 py-2 text-app-danger hover:bg-app-danger/10"
                    >
                        <Trash2 className="w-4 h-4" />
                        {t('files.delete')}
                    </button>
                </div>
            ), document.body)}
        </div>
    )
}
