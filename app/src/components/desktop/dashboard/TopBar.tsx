import { useEffect, useRef, useState } from 'react';
import {
    ArrowDown,
    ArrowUp,
    Download,
    FolderInput,
    Globe,
    HardDrive,
    LayoutGrid,
    List,
    Moon,
    MoreHorizontal,
    Settings,
    Share2,
    SlidersHorizontal,
    Sun,
    Trash2,
    UploadCloud,
    X,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../context/ThemeContext';
import { useSettings } from '../../../context/SettingsContext';
import { Button, IconButton, MenuItem, MenuPanel, SearchField } from '../../ui';
import type { SortDirection, SortField } from './FileExplorer';

interface TopBarProps {
    currentFolderName: string;
    selectedIds: number[];
    onShowMoveModal: () => void;
    onBulkDownload: () => void;
    onBulkDelete: () => void;
    onBulkShare: () => void;
    onDownloadFolder: () => void;
    onClearSelection: () => void;
    onUploadClick: () => void;
    viewMode: 'grid' | 'list';
    setViewMode: (mode: 'grid' | 'list') => void;
    cardScale: number;
    onCardScaleChange: (scale: number) => void;
    sortField: SortField;
    sortDirection: SortDirection;
    onSortChange: (field: SortField) => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    onSettingsClick: () => void;
    onRemoteUploadClick: () => void;
}

export function TopBar({
    currentFolderName,
    selectedIds,
    onShowMoveModal,
    onBulkDownload,
    onBulkDelete,
    onBulkShare,
    onDownloadFolder,
    onClearSelection,
    onUploadClick,
    viewMode,
    setViewMode,
    cardScale,
    onCardScaleChange,
    sortField,
    sortDirection,
    onSortChange,
    searchTerm,
    onSearchChange,
    onSettingsClick,
    onRemoteUploadClick,
}: TopBarProps) {
    const { theme, toggleTheme } = useTheme();
    const { t } = useTranslation();
    const { settings } = useSettings();
    const [proxyStatus, setProxyStatus] = useState<{ reachable: boolean; latency_ms: number } | null>(null);
    const [showMore, setShowMore] = useState(false);
    const [showViewOptions, setShowViewOptions] = useState(false);
    const moreRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<HTMLDivElement>(null);
    const hasSelection = selectedIds.length > 0;

    useEffect(() => {
        if (!settings.proxyEnabled || !settings.proxyLiveStateEnabled) {
            setProxyStatus(null);
            return;
        }
        const checkProxy = async () => {
            try {
                const status = await invoke<{ reachable: boolean; latency_ms: number }>('cmd_get_proxy_status');
                setProxyStatus(status);
            } catch {
                setProxyStatus({ reachable: false, latency_ms: -1 });
            }
        };
        checkProxy();
        const interval = setInterval(checkProxy, 5000);
        return () => clearInterval(interval);
    }, [settings.proxyEnabled, settings.proxyLiveStateEnabled]);

    useEffect(() => {
        if (!showMore && !showViewOptions) return;
        const close = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!moreRef.current?.contains(target)) setShowMore(false);
            if (!viewRef.current?.contains(target)) setShowViewOptions(false);
        };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [showMore, showViewOptions]);

    const runMoreAction = (action: () => void) => {
        setShowMore(false);
        action();
    };

    return (
        <header
            className="quiet-toolbar sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2.5 border-b border-app-border-subtle px-3"
            onClick={(event) => event.stopPropagation()}
        >
            {hasSelection ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <IconButton label={t('files.clear_selection')} onClick={onClearSelection}>
                        <X className="h-4 w-4" />
                    </IconButton>
                    <span className="me-1 min-w-0 truncate text-ui font-medium text-app-text">
                        {t('files.items_selected', { count: selectedIds.length })}
                    </span>
                    <Button size="sm" onClick={onShowMoveModal} leadingIcon={<FolderInput className="h-3.5 w-3.5" />}>
                        {t('files.move_to')}
                    </Button>
                    <Button size="sm" onClick={onBulkDownload} leadingIcon={<Download className="h-3.5 w-3.5" />}>
                        {t('files.download')}
                    </Button>
                    <Button size="sm" onClick={onBulkShare} leadingIcon={<Share2 className="h-3.5 w-3.5" />}>
                        {t('files.share')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={onBulkDelete} leadingIcon={<Trash2 className="h-3.5 w-3.5" />}>
                        {t('files.delete')}
                    </Button>
                </div>
            ) : (
                <>
                    <div className="min-w-[8rem] flex-1">
                        <h1 className="truncate text-app-title font-semibold tracking-[-0.01em] text-app-text" title={currentFolderName}>
                            {currentFolderName}
                        </h1>
                    </div>

                    <SearchField
                        containerClassName="w-full max-w-[24rem]"
                        placeholder={t('common.search_placeholder')}
                        value={searchTerm}
                        onChange={(event) => onSearchChange(event.target.value)}
                    />

                    <div className="flex flex-1 items-center justify-end gap-1.5">
                        {settings.proxyEnabled && settings.proxyLiveStateEnabled && (
                            <div
                                className="quiet-control flex h-7 items-center gap-1.5 px-2 text-badge text-app-text-secondary"
                                title={!proxyStatus
                                    ? 'Proxy status: checking…'
                                    : proxyStatus.reachable
                                        ? `Proxy active: ${proxyStatus.latency_ms}ms latency`
                                        : 'Proxy status: unreachable'}
                            >
                                <span className={`h-1.5 w-1.5 rounded-full ${
                                    !proxyStatus ? 'bg-app-warning animate-pulse' : proxyStatus.reachable ? 'bg-app-success' : 'bg-app-danger'
                                }`} />
                                <span className="font-mono">
                                    {!proxyStatus ? '…' : proxyStatus.reachable ? `${proxyStatus.latency_ms}ms` : 'Offline'}
                                </span>
                            </div>
                        )}

                        <Button
                            variant="primary"
                            onClick={onUploadClick}
                            leadingIcon={<UploadCloud className="h-3.5 w-3.5" />}
                            className="toolbar-upload-action"
                        >
                            {t('common.upload')}
                        </Button>

                        <div className="relative" ref={viewRef}>
                            <IconButton
                                label={t('files.toggle_layout')}
                                onClick={() => {
                                    setShowViewOptions((value) => !value);
                                    setShowMore(false);
                                }}
                                aria-expanded={showViewOptions}
                                className={showViewOptions ? 'bg-app-selected text-app-accent' : ''}
                            >
                                <SlidersHorizontal className="h-3.5 w-3.5" />
                            </IconButton>
                            {showViewOptions && (
                                <MenuPanel className="absolute end-0 top-9 z-50 w-64">
                                    <div className="px-2 pb-1 pt-1 text-badge font-medium text-app-text-tertiary">
                                        {t('files.toggle_layout')}
                                    </div>
                                    <div className="grid grid-cols-2 gap-1">
                                        <button
                                            type="button"
                                            onClick={() => setViewMode('grid')}
                                            className={`quiet-control flex h-8 items-center justify-center gap-2 px-2 text-ui font-medium ${viewMode === 'grid' ? 'bg-app-selected text-app-accent' : 'text-app-text-secondary hover:text-app-text'}`}
                                        >
                                            <LayoutGrid className="h-3.5 w-3.5" />
                                            {t('files.switch_grid')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setViewMode('list')}
                                            className={`quiet-control flex h-8 items-center justify-center gap-2 px-2 text-ui font-medium ${viewMode === 'list' ? 'bg-app-selected text-app-accent' : 'text-app-text-secondary hover:text-app-text'}`}
                                        >
                                            <List className="h-3.5 w-3.5" />
                                            {t('files.switch_list')}
                                        </button>
                                    </div>

                                    <div className="my-1 h-px bg-app-border-subtle" />
                                    <div className="grid grid-cols-3 gap-1" role="group" aria-label="Sort files">
                                        {(['name', 'size', 'date'] as const).map((field) => (
                                            <button
                                                key={field}
                                                type="button"
                                                onClick={() => onSortChange(field)}
                                                className={`quiet-control flex h-8 min-w-0 items-center justify-center gap-1 px-1.5 text-metadata font-medium ${sortField === field ? 'bg-app-selected text-app-accent' : 'text-app-text-secondary hover:text-app-text'}`}
                                            >
                                                <span className="truncate">{t(`common.${field}`)}</span>
                                                {sortField === field && (sortDirection === 'asc'
                                                    ? <ArrowUp className="h-3 w-3 shrink-0" />
                                                    : <ArrowDown className="h-3 w-3 shrink-0" />)}
                                            </button>
                                        ))}
                                    </div>

                                    {viewMode === 'grid' && (
                                        <>
                                            <div className="my-1 h-px bg-app-border-subtle" />
                                            <div className="flex h-8 items-center gap-1 px-1">
                                                <IconButton
                                                    size="xs"
                                                    label="Smaller thumbnails"
                                                    onClick={() => onCardScaleChange(Math.max(0.5, cardScale - 0.25))}
                                                    disabled={cardScale <= 0.5}
                                                >
                                                    <ZoomOut className="h-3.5 w-3.5" />
                                                </IconButton>
                                                <input
                                                    type="range"
                                                    min="0.5"
                                                    max="2"
                                                    step="0.25"
                                                    value={cardScale}
                                                    onChange={(event) => onCardScaleChange(parseFloat(event.target.value))}
                                                    className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-app-border [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-app-accent"
                                                    aria-label="Thumbnail size"
                                                />
                                                <IconButton
                                                    size="xs"
                                                    label="Larger thumbnails"
                                                    onClick={() => onCardScaleChange(Math.min(2, cardScale + 0.25))}
                                                    disabled={cardScale >= 2}
                                                >
                                                    <ZoomIn className="h-3.5 w-3.5" />
                                                </IconButton>
                                                <span className="w-9 text-end text-badge tabular-nums text-app-text-tertiary">{Math.round(cardScale * 100)}%</span>
                                            </div>
                                        </>
                                    )}
                                </MenuPanel>
                            )}
                        </div>

                        <div className="relative" ref={moreRef}>
                            <IconButton label={t('common.preferences')} onClick={() => {
                                setShowMore((value) => !value);
                                setShowViewOptions(false);
                            }} aria-expanded={showMore}>
                                <MoreHorizontal className="h-3.5 w-3.5" />
                            </IconButton>
                            {showMore && (
                                <MenuPanel className="absolute end-0 top-9 z-50 w-56">
                                    <MenuItem onClick={() => runMoreAction(onDownloadFolder)}>
                                        <HardDrive className="h-3.5 w-3.5 text-app-text-secondary" />
                                        {t('files.download_folder')}
                                    </MenuItem>
                                    <MenuItem onClick={() => runMoreAction(onRemoteUploadClick)}>
                                        <Globe className="h-3.5 w-3.5 text-app-text-secondary" />
                                        {t('files.remote_upload')}
                                    </MenuItem>
                                    <MenuItem onClick={() => runMoreAction(toggleTheme)}>
                                        {theme === 'dark' ? <Sun className="h-3.5 w-3.5 text-app-text-secondary" /> : <Moon className="h-3.5 w-3.5 text-app-text-secondary" />}
                                        {theme === 'dark' ? t('common.light_mode') : t('common.dark_mode')}
                                    </MenuItem>
                                    <div className="my-1 h-px bg-app-border-subtle" />
                                    <MenuItem onClick={() => runMoreAction(onSettingsClick)}>
                                        <Settings className="h-3.5 w-3.5 text-app-text-secondary" />
                                        {t('common.preferences')}
                                    </MenuItem>
                                </MenuPanel>
                            )}
                        </div>
                    </div>
                </>
            )}
        </header>
    );
}
