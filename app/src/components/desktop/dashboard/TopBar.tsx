import { HardDrive, LayoutGrid, Sun, Moon, Settings, Share2, X, Globe } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../../context/SettingsContext';
import { invoke } from '@tauri-apps/api/core';
import { useState, useEffect } from 'react';

interface TopBarProps {
    currentFolderName: string;
    selectedIds: number[];
    onShowMoveModal: () => void;
    onBulkDownload: () => void;
    onBulkDelete: () => void;
    onBulkShare: () => void;
    onDownloadFolder: () => void;
    onClearSelection: () => void;
    viewMode: 'grid' | 'list';
    setViewMode: (mode: 'grid' | 'list') => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    onSettingsClick: () => void;
    onRemoteUploadClick: () => void;
}

export function TopBar({
    currentFolderName, selectedIds, onShowMoveModal, onBulkDownload, onBulkDelete, onBulkShare,
    onDownloadFolder, onClearSelection, viewMode, setViewMode, searchTerm, onSearchChange, onSettingsClick,
    onRemoteUploadClick
}: TopBarProps) {
    const { theme, toggleTheme } = useTheme();
    const { t } = useTranslation();
    const { settings } = useSettings();
    const [proxyStatus, setProxyStatus] = useState<{ reachable: boolean; latency_ms: number } | null>(null);

    // Poll proxy status in the top bar
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

    return (
        <header className="h-14 border-b border-telegram-border flex items-center px-4 justify-between bg-telegram-surface/80 backdrop-blur-md sticky top-0 z-10" onClick={e => e.stopPropagation()}>
            <div className="flex-1 flex items-center justify-start gap-4">
                <div className="flex items-center text-sm breadcrumbs text-telegram-subtext select-none">
                    <span className="hover:text-telegram-text cursor-pointer transition-colors">{t('common.start')}</span>
                    <span className="mx-2">/</span>
                    <span className="text-telegram-text font-medium">{currentFolderName}</span>
                </div>
            </div>

            <div className="w-full max-w-md mx-4">
                <input
                    type="text"
                    placeholder={t('common.search_placeholder')}
                    className="w-full bg-telegram-hover border border-telegram-border rounded-lg px-3 py-1.5 text-sm text-telegram-text placeholder:text-telegram-subtext focus:outline-none focus:border-telegram-primary/50 transition-colors"
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                />
            </div>

            <div className="flex-1 flex items-center justify-end gap-2">
                {selectedIds.length > 0 && (
                    <div className="flex items-center gap-2 mr-4 animate-in fade-in slide-in-from-top-2">
                        <span className="text-xs text-telegram-subtext mr-2">{t('files.items_selected', { count: selectedIds.length })}</span>
                        <button onClick={onClearSelection} className="px-2 py-1.5 hover:bg-telegram-hover rounded-md text-xs text-telegram-subtext hover:text-telegram-text transition flex items-center gap-1" title={t('files.clear_selection')}><X className="w-3 h-3" /></button>
                        <button onClick={onShowMoveModal} className="px-3 py-1.5 bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary rounded-md text-xs transition font-medium">{t('files.move_to')}</button>
                        <button onClick={onBulkDownload} className="px-3 py-1.5 bg-telegram-hover hover:bg-telegram-border rounded-md text-xs text-telegram-text transition">{t('files.download_selected')}</button>
                        <button onClick={onBulkShare} className="px-3 py-1.5 bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary rounded-md text-xs transition font-medium flex items-center gap-1"><Share2 className="w-3 h-3" />{t('files.share')} ({selectedIds.length})</button>
                        <button onClick={onBulkDelete} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-md text-xs transition">{t('files.delete')}</button>
                    </div>
                )}

                {settings.proxyEnabled && settings.proxyLiveStateEnabled && (
                    <div 
                        className="flex items-center gap-1.5 mr-2 px-2.5 py-1 rounded bg-white/5 border border-telegram-border text-[11px] text-telegram-subtext font-mono transition-all group relative cursor-help"
                        title={!proxyStatus 
                            ? 'Proxy status: checking…' 
                            : proxyStatus.reachable 
                                ? `Proxy active: ${proxyStatus.latency_ms}ms latency` 
                                : 'Proxy status: unreachable'}
                    >
                        <div className={`w-2 h-2 rounded-full ${
                            !proxyStatus 
                                ? 'bg-amber-400 animate-pulse' 
                                : proxyStatus.reachable 
                                    ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' 
                                    : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                        }`} />
                        <span>
                            {!proxyStatus 
                                ? 'Checking…' 
                                : proxyStatus.reachable 
                                    ? `${proxyStatus.latency_ms}ms` 
                                    : 'Offline'}
                        </span>
                        <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                            {t('common.proxy')}: {!proxyStatus 
                                ? 'Checking…' 
                                : proxyStatus.reachable 
                                    ? `${proxyStatus.latency_ms}ms` 
                                    : 'Offline'}
                        </span>
                    </div>
                )}

                <button onClick={onDownloadFolder} className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition group relative" title={t('files.download_folder')}>
                    <HardDrive className="w-5 h-5" />
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {t('files.download_all')}
                    </span>
                </button>

                <button onClick={onRemoteUploadClick} className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition group relative" title={t('files.remote_upload')}>
                    <Globe className="w-5 h-5" />
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {t('files.remote_upload_url')}
                    </span>
                </button>

                <button
                    onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                    className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                    title={t('files.toggle_layout')}
                >
                    <LayoutGrid className="w-5 h-5" />
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {viewMode === 'grid' ? t('files.switch_list') : t('files.switch_grid')}
                    </span>
                </button>

                <div className="w-px h-6 bg-telegram-border mx-1"></div>

                <button
                    onClick={onSettingsClick}
                    className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                    title={t('common.settings')}
                >
                    <Settings className="w-5 h-5" />
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {t('common.settings')}
                    </span>
                </button>

                <button
                    onClick={toggleTheme}
                    className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                    title={theme === 'dark' ? t('common.switch_light') : t('common.switch_dark')}
                >
                    {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {theme === 'dark' ? t('common.light_mode') : t('common.dark_mode')}
                    </span>
                </button>
            </div>
        </header>
    )
}
