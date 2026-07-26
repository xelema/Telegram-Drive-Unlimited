import { useState } from 'react';
import { HardDrive, Folder, Plus, RefreshCw, LogOut, ChevronLeft, ChevronRight, Settings2, Trash2, Check, X, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SidebarItem } from './SidebarItem';
import { BandwidthWidget } from './BandwidthWidget';
import { TelegramFolder, BandwidthStats, FolderGroup } from '../../../types';
import { useSettings } from '../../../context/SettingsContext';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    horizontalListSortingStrategy,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { quietMetrics } from '../../../design/contracts';

const PRESET_COLORS = [
    '#3B82F6', // Blue
    '#10B981', // Green
    '#8B5CF6', // Purple
    '#EC4899', // Pink
    '#F59E0B', // Orange
    '#14B8A6', // Teal
    '#06B6D4', // Cyan
    '#EF4444', // Red
];

interface GroupTabProps {
    id: string;
    groupId: number | null | 'all';
    label: string;
    colorHex?: string;
    active: boolean;
    onClick: () => void;
    onEdit?: () => void;
    isSortable?: boolean;
}

function GroupTab({ id, groupId, label, colorHex, active, onClick, onEdit, isSortable = true }: GroupTabProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id,
        disabled: !isSortable,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={onClick}
            className={`quiet-control flex h-7 flex-shrink-0 cursor-pointer select-none items-center gap-1.5 border px-2 text-badge font-medium ${
                active
                    ? 'border-app-accent/30 bg-app-selected text-app-accent'
                    : 'border-app-border bg-app-surface text-app-text-secondary hover:border-app-border-strong hover:text-app-text'
            }`}
        >
            {colorHex && (
                <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: colorHex }}
                />
            )}
            <span className="truncate max-w-[80px]">{label}</span>
            {onEdit && active && groupId !== 'all' && groupId !== null && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onEdit();
                    }}
                    className="rounded p-0.5 text-app-text-secondary hover:bg-app-hover hover:text-app-text"
                >
                    <Settings2 className="w-3 h-3" />
                </button>
            )}
        </div>
    );
}

interface SidebarProps {
    folders: TelegramFolder[];
    groups: FolderGroup[];
    activeFolderId: number | null;
    setActiveFolderId: (id: number | null) => void;
    onDrop: (e: React.DragEvent, folderId: number | null) => void;
    onDelete: (id: number, name: string) => void;
    onRename: (id: number, name: string) => void;
    onToggleVisibility: (id: number, name: string, isPublic: boolean) => void;
    onExportInvite: (id: number, name: string) => void;
    onCreate: (name: string) => Promise<void>;
    isSyncing: boolean;
    isConnected: boolean;
    onSync: () => void;
    onLogout: () => void;
    bandwidth: BandwidthStats | null;
    onAssignFolderToGroup: (folderId: number, groupId: number | null) => Promise<void>;
    onReorderFolders: (reordered: TelegramFolder[]) => Promise<void>;
    onUpdateGroupOrder: (reorderedGroups: FolderGroup[]) => Promise<void>;
    onCreateGroup: (name: string, colorHex: string) => Promise<void>;
    onUpdateGroup: (groupId: number, name: string, colorHex: string) => Promise<void>;
    onDeleteGroup: (groupId: number) => Promise<void>;
}

export function Sidebar({
    folders, groups = [], activeFolderId, setActiveFolderId, onDrop, onDelete, onRename, onToggleVisibility, onExportInvite, onCreate,
    isSyncing, isConnected, onSync, onLogout, bandwidth,
    onAssignFolderToGroup, onReorderFolders, onUpdateGroupOrder, onCreateGroup, onUpdateGroup, onDeleteGroup
}: SidebarProps) {
    const [showNewFolderInput, setShowNewFolderInput] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const { t } = useTranslation();
    const { settings, updateSetting } = useSettings();

    // Grouping States
    const [activeGroupId, setActiveGroupId] = useState<number | null | 'all'>('all');
    const [showGroupEditor, setShowGroupEditor] = useState(false);
    const [editingGroup, setEditingGroup] = useState<FolderGroup | null>(null); // null means creating
    const [groupName, setGroupName] = useState("");
    const [groupColor, setGroupColor] = useState("#3B82F6");

    // DND Kit Sensors
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over) return;

        const activeId = active.id.toString();
        const overId = over.id.toString();

        if (activeId.startsWith('folder-')) {
            const activeFolderId = parseInt(activeId.replace('folder-', ''), 10);

            if (overId.startsWith('group-tab-')) {
                const overGroupIdStr = overId.replace('group-tab-', '');
                const overGroupId = overGroupIdStr === 'all'
                    ? null
                    : overGroupIdStr === 'unassigned'
                        ? null
                        : parseInt(overGroupIdStr, 10);
                onAssignFolderToGroup(activeFolderId, overGroupId);
            } else if (overId.startsWith('folder-')) {
                const overFolderId = parseInt(overId.replace('folder-', ''), 10);
                if (activeFolderId !== overFolderId) {
                    const oldIndex = folders.findIndex(f => f.id === activeFolderId);
                    const newIndex = folders.findIndex(f => f.id === overFolderId);
                    if (oldIndex !== -1 && newIndex !== -1) {
                        const reordered = arrayMove(folders, oldIndex, newIndex);
                        onReorderFolders(reordered);
                    }
                }
            }
        } else if (activeId.startsWith('group-tab-')) {
            const activeGroupId = parseInt(activeId.replace('group-tab-', ''), 10);

            if (overId.startsWith('group-tab-')) {
                const overGroupIdStr = overId.replace('group-tab-', '');
                if (overGroupIdStr !== 'all' && overGroupIdStr !== 'unassigned') {
                    const overGroupId = parseInt(overGroupIdStr, 10);
                    if (activeGroupId !== overGroupId) {
                        const oldIndex = groups.findIndex(g => g.id === activeGroupId);
                        const newIndex = groups.findIndex(g => g.id === overGroupId);
                        if (oldIndex !== -1 && newIndex !== -1) {
                            const reordered = arrayMove(groups, oldIndex, newIndex);
                            onUpdateGroupOrder(reordered);
                        }
                    }
                }
            }
        }
    };

    const submitCreate = async () => {
        if (!newFolderName.trim()) return;
        try {
            await onCreate(newFolderName);
            setNewFolderName("");
            setShowNewFolderInput(false);
        } catch {
            // handled by parent
        }
    };

    const handleSaveGroup = async () => {
        if (!groupName.trim()) return;
        if (editingGroup) {
            await onUpdateGroup(editingGroup.id, groupName, groupColor);
        } else {
            await onCreateGroup(groupName, groupColor);
        }
        setShowGroupEditor(false);
        setEditingGroup(null);
        setGroupName("");
        setGroupColor("#3B82F6");
    };

    const handleDeleteGroupClick = async (groupId: number) => {
        await onDeleteGroup(groupId);
        if (activeGroupId === groupId) {
            setActiveGroupId('all');
        }
        setShowGroupEditor(false);
        setEditingGroup(null);
        setGroupName("");
        setGroupColor("#3B82F6");
    };

    const filteredFolders = folders.filter(folder => {
        if (settings.hideGroups || activeGroupId === 'all') return true;
        if (activeGroupId === null) return folder.group_id === null || folder.group_id === undefined;
        return folder.group_id === activeGroupId;
    });

    return (
        <aside 
            className="flex shrink-0 flex-col border-e border-app-border-subtle bg-app-sidebar transition-[width] duration-200"
            style={{ width: settings.sidebarCollapsed ? quietMetrics.sidebarWidth.collapsed : quietMetrics.sidebarWidth.expanded }}
            onClick={e => e.stopPropagation()}
        >
            <div className={`flex h-12 shrink-0 border-b border-app-border-subtle ${settings.sidebarCollapsed ? 'flex-col items-center justify-center gap-px px-1' : 'items-center justify-between px-3'}`}>
                <div className="flex items-center gap-2">
                    <img src="/logo.svg" className={settings.sidebarCollapsed ? 'h-[22px] w-[22px]' : 'h-6 w-6'} alt="Logo" />
                    {!settings.sidebarCollapsed && (
                        <span className="text-app-title font-semibold tracking-[-0.01em] text-app-text">{t('common.app_title')}</span>
                    )}
                </div>
                <button
                    onClick={() => updateSetting('sidebarCollapsed', !settings.sidebarCollapsed)}
                    className={`quiet-control flex items-center justify-center text-app-text-tertiary hover:text-app-text ${settings.sidebarCollapsed ? 'h-[15px] w-6' : 'h-7 w-7'}`}
                    title={settings.sidebarCollapsed ? t('common.expand_sidebar') || "Expand Sidebar" : t('common.collapse_sidebar') || "Collapse Sidebar"}
                >
                    {settings.sidebarCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
                </button>
            </div>

            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
            >
                {!settings.sidebarCollapsed && (
                    <div className="flex flex-col gap-2 border-b border-app-border-subtle px-3 py-2.5">
                        <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-badge font-medium text-app-text-tertiary">
                                {t('common.groups') || "Groups"}
                            </span>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => updateSetting('hideGroups', !settings.hideGroups)}
                                    className="quiet-control p-1 text-app-text-tertiary hover:text-app-text"
                                    title={settings.hideGroups ? t('common.show_groups') || "Show Groups" : t('common.hide_groups') || "Hide Groups"}
                                >
                                    {settings.hideGroups ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                                {!settings.hideGroups && (
                                    <button
                                        onClick={() => {
                                            setEditingGroup(null);
                                            setGroupName("");
                                            setGroupColor("#3B82F6");
                                            setShowGroupEditor(true);
                                        }}
                                        className="quiet-control p-1 text-app-text-tertiary hover:text-app-text"
                                        title={t('common.create_group') || "Create Group"}
                                    >
                                        <Plus className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {!settings.hideGroups && showGroupEditor && (
                            <div className="quiet-surface flex flex-col gap-2.5 p-2.5 animate-in fade-in duration-150">
                                <div>
                                    <label className="mb-1 block text-badge font-medium text-app-text-secondary">
                                        {editingGroup ? t('common.edit_group_name') : t('common.new_group_name')}
                                    </label>
                                    <input
                                        autoFocus
                                        type="text"
                                        className="quiet-control h-8 w-full border border-app-border bg-app-surface-sunken/50 px-2 text-ui text-app-text outline-none"
                                        placeholder={t('common.enter_group_name')}
                                        value={groupName}
                                        onChange={e => setGroupName(e.target.value)}
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-badge font-medium text-app-text-secondary">
                                        {t('common.theme_color')}
                                    </label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {PRESET_COLORS.map(color => (
                                            <button
                                                key={color}
                                                onClick={() => setGroupColor(color)}
                                                className={`w-5 h-5 rounded-full border transition-all ${
                                                    groupColor === color
                                                        ? 'border-white scale-110 shadow-md ring-1 ring-telegram-primary'
                                                        : 'border-transparent hover:scale-105'
                                                }`}
                                                style={{ backgroundColor: color }}
                                            />
                                        ))}
                                    </div>
                                </div>

                                <div className="flex gap-2 justify-end mt-1">
                                    {editingGroup && (
                                        <button
                                            onClick={() => handleDeleteGroupClick(editingGroup.id)}
                                            className="mr-auto p-1.5 text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                            title={t('common.delete_group')}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => {
                                            setShowGroupEditor(false);
                                            setEditingGroup(null);
                                        }}
                                        className="quiet-control flex h-7 items-center gap-1 px-2 text-badge font-medium text-app-text-secondary hover:text-app-text"
                                    >
                                        <X className="w-3 h-3" />
                                        {t('common.cancel') || "Cancel"}
                                    </button>
                                    <button
                                        onClick={handleSaveGroup}
                                        disabled={!groupName.trim()}
                                        className="quiet-control flex h-7 items-center gap-1 bg-app-accent px-2.5 text-badge font-medium text-app-accent-contrast hover:bg-app-accent-hover disabled:opacity-50"
                                    >
                                        <Check className="w-3 h-3" />
                                        {t('common.save') || "Save"}
                                    </button>
                                </div>
                            </div>
                        )}

                        {!settings.hideGroups && (
                            <div 
                                className="group-tabs-scroll flex items-center gap-2 overflow-x-auto py-1"
                                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                            >
                                <style>{`
                                    .group-tabs-scroll::-webkit-scrollbar {
                                        display: none;
                                    }
                                `}</style>
                                <GroupTab
                                    id="group-tab-all"
                                    groupId="all"
                                    label={t('common.all') || "All"}
                                    active={activeGroupId === 'all'}
                                    onClick={() => setActiveGroupId('all')}
                                    isSortable={false}
                                />
                                <GroupTab
                                    id="group-tab-unassigned"
                                    groupId={null}
                                    label={t('common.unassigned') || "Unassigned"}
                                    active={activeGroupId === null}
                                    onClick={() => setActiveGroupId(null)}
                                    isSortable={false}
                                />
                                <SortableContext
                                    items={groups.map(g => `group-tab-${g.id}`)}
                                    strategy={horizontalListSortingStrategy}
                                >
                                    {groups.map(group => (
                                        <GroupTab
                                            key={group.id}
                                            id={`group-tab-${group.id}`}
                                            groupId={group.id}
                                            label={group.name}
                                            colorHex={group.color_hex}
                                            active={activeGroupId === group.id}
                                            onClick={() => setActiveGroupId(group.id)}
                                            onEdit={() => {
                                                setEditingGroup(group);
                                                setGroupName(group.name);
                                                setGroupColor(group.color_hex || "#3B82F6");
                                                setShowGroupEditor(true);
                                            }}
                                        />
                                    ))}
                                </SortableContext>
                            </div>
                        )}
                    </div>
                )}

                {/* Scrollable folder list */}
                <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
                    <SidebarItem
                        icon={HardDrive}
                        label={t('common.saved_messages')}
                        active={activeFolderId === null}
                        onClick={() => setActiveFolderId(null)}
                        onDrop={(e: React.DragEvent) => onDrop(e, null)}
                        folderId={null}
                        collapsed={settings.sidebarCollapsed}
                    />
                    <SortableContext
                        items={filteredFolders.map(folder => `folder-${folder.id}`)}
                        strategy={verticalListSortingStrategy}
                    >
                        {filteredFolders.map(folder => (
                            <SidebarItem
                                key={folder.id}
                                icon={Folder}
                                label={folder.name}
                                active={activeFolderId === folder.id}
                                onClick={() => setActiveFolderId(folder.id)}
                                onDrop={(e: React.DragEvent) => onDrop(e, folder.id)}
                                onDelete={() => onDelete(folder.id, folder.name)}
                                onRename={() => onRename(folder.id, folder.name)}
                                onToggleVisibility={() => onToggleVisibility(folder.id, folder.name, !!(folder.is_public || folder.username))}
                                onExportInvite={() => onExportInvite(folder.id, folder.name)}
                                folderId={folder.id}
                                isPublic={!!(folder.is_public || folder.username)}
                                collapsed={settings.sidebarCollapsed}
                                groups={groups}
                                onAssignFolderToGroup={onAssignFolderToGroup}
                            />
                        ))}
                    </SortableContext>
                </nav>
            </DndContext>

            {/* Sticky Create Folder section — always visible above the footer */}
            {!settings.sidebarCollapsed && (
                <div className="border-t border-app-border-subtle px-2 py-2">
                    {showNewFolderInput ? (
                        <div className="px-1 py-1">
                            <input
                                autoFocus
                                type="text"
                                className="quiet-control h-8 w-full border border-app-border bg-app-surface-sunken/50 px-2 text-ui text-app-text outline-none"
                                placeholder={t('common.folder_name_placeholder')}
                                value={newFolderName}
                                onChange={e => setNewFolderName(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && submitCreate()}
                                onBlur={() => !newFolderName && setShowNewFolderInput(false)}
                            />
                        </div>
                    ) : (
                        <button
                            onClick={() => setShowNewFolderInput(true)}
                            className="quiet-control flex h-8 w-full items-center gap-2 border border-dashed border-app-border px-2.5 text-ui font-medium text-app-text-secondary hover:border-app-border-strong hover:text-app-text"
                        >
                            <Plus className="w-4 h-4" />
                            {t('common.create_folder')}
                        </button>
                    )}
                </div>
            )}

            <div className={`flex flex-col border-t border-app-border-subtle p-2 ${settings.sidebarCollapsed ? 'items-center gap-2' : 'gap-2'}`}>
                {settings.sidebarCollapsed ? (
                    <>
                        <div
                            className={`h-2 w-2 flex-shrink-0 rounded-full ${isConnected ? 'bg-app-success' : 'bg-app-danger'}`}
                            title={isConnected ? t('common.connected_telegram') : t('common.disconnected_telegram')}
                        />
                        <button
                            onClick={onSync}
                            disabled={isSyncing}
                            className={`quiet-control sidebar-sync-action p-2 text-app-accent ${isSyncing ? 'cursor-not-allowed opacity-50' : ''}`}
                            title={isSyncing ? t('common.syncing') : t('common.sync')}
                        >
                            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                            onClick={onLogout}
                            className="quiet-control sidebar-logout-action p-2 text-app-danger"
                            title={t('common.logout')}
                        >
                            <LogOut className="w-4 h-4" />
                        </button>
                    </>
                ) : (
                    <>
                        <div className="flex items-center gap-2 text-metadata text-app-text-secondary">
                            <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-app-success' : 'bg-app-danger'}`}></div>
                            <span>{isConnected ? t('common.connected_telegram') : t('common.disconnected_telegram')}</span>
                        </div>

                        <div className="flex gap-2">
                            <button
                                onClick={onSync}
                                disabled={isSyncing}
                                className={`quiet-control sidebar-sync-action flex h-[30px] flex-1 items-center justify-center gap-1.5 px-2.5 text-badge font-medium text-app-accent ${isSyncing ? 'cursor-not-allowed opacity-50' : ''}`}
                                title="Scan for existing folders"
                            >
                                <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                                {isSyncing ? t('common.syncing') : t('common.sync')}
                            </button>
                            <button
                                onClick={onLogout}
                                className="quiet-control sidebar-logout-action flex h-[30px] flex-1 items-center justify-center gap-1.5 px-2.5 text-badge font-medium text-app-danger"
                                title="Sign Out"
                            >
                                <LogOut className="w-3 h-3" />
                                {t('common.logout')}
                            </button>
                        </div>

                        {bandwidth && <BandwidthWidget bandwidth={bandwidth} />}
                    </>
                )}
            </div>
        </aside>
    );
}
