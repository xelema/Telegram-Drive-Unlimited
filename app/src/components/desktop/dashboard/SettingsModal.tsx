import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, RotateCcw, Download, Upload, Trash2, HardDrive, Globe, Key, Copy, Check, RefreshCw, FolderArchive, Shield, Zap, Activity, Gauge, Wifi, ChevronDown, Link, Sparkles, Info, Clipboard, Monitor, Loader2, Languages, Play, Palette, Plus, Tag } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettings } from '../../../context/SettingsContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../../../i18n/languages';
import { ShareInfo, CacheEntry, DetailedCacheInfo } from '../../../types';
import { version as appVersion } from '../../../../package.json';
import { useTheme } from '../../../context/ThemeContext';
import { CustomTheme, ThemeColorPalette, generateThemeId } from '../../../theme/themeEngine';
import { getDefaultPalette } from '../../../theme/presets';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface ApiSettings {
    enabled: boolean;
    port: number;
    key_set: boolean;
    running: boolean;
}

type SettingsTab = 'general' | 'themes' | 'proxy' | 'vpn' | 'sharing' | 'about';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, updateSetting, resetSettings } = useSettings();
    const { confirm } = useConfirm();
    const { t } = useTranslation();
    const [clearing, setClearing] = useState(false);

    // Transcode cache state
    const [transcodeCache, setTranscodeCache] = useState<DetailedCacheInfo | null>(null);
    const [cacheLoading, setCacheLoading] = useState(false);
    const [clearingVariant, setClearingVariant] = useState<string | null>(null); // file_key:quality being cleared
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [vpnDetected, setVpnDetected] = useState<boolean | null>(null);
    const [proxyStatus, setProxyStatus] = useState<{ reachable: boolean; latency_ms: number } | null>(null);
    const [isTestingProxy, setIsTestingProxy] = useState(false);

    // Update check state
    const [updateChecking, setUpdateChecking] = useState(false);
    const [updateAvailable, setUpdateAvailable] = useState<Update | null>(null);
    const [updateVersion, setUpdateVersion] = useState<string | null>(null);
    const [updateDownloading, setUpdateDownloading] = useState(false);
    const [updateProgress, setUpdateProgress] = useState(0);

    // Reconnect state
    const [reconnecting, setReconnecting] = useState(false);

    // Diagnostics state
    const [diagLoading, setDiagLoading] = useState(false);

    const handleCheckForUpdates = useCallback(async () => {
        setUpdateChecking(true);
        try {
            const updateInfo = await check();
            if (updateInfo) {
                setUpdateAvailable(updateInfo);
                setUpdateVersion(updateInfo.version);
                toast.success(t('settings.update_available_toast', { version: updateInfo.version }));
            } else {
                setUpdateAvailable(null);
                setUpdateVersion(null);
                toast.success(t('settings.latest_version_toast'));
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('dev') || msg.includes('no current version')) {
                toast.info(t('settings.update_prod_only_toast'));
            } else {
                toast.error(t('settings.update_check_failed_toast', { error: msg }));
            }
        } finally {
            setUpdateChecking(false);
        }
    }, [t]);

    const handleInstallUpdate = useCallback(async () => {
        if (!updateAvailable) return;
        setUpdateDownloading(true);
        setUpdateProgress(0);
        let downloaded = 0;
        let contentLength = 0;
        try {
            await updateAvailable.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                    const data = event.data as { contentLength?: number };
                    contentLength = data.contentLength || 0;
                } else if (event.event === 'Progress') {
                    const data = event.data as { chunkLength?: number };
                    downloaded += data.chunkLength || 0;
                    if (contentLength > 0) {
                        setUpdateProgress(Math.min(Math.round((downloaded / contentLength) * 100), 100));
                    }
                }
            });
            await relaunch();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(t('settings.update_failed_toast', { error: msg }));
            setUpdateDownloading(false);
        }
    }, [updateAvailable, t]);

    // Sharing settings state
    const [shares, setShares] = useState<ShareInfo[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [globalDomain, setGlobalDomain] = useState('');

    const fetchShares = useCallback(async () => {
        setRefreshing(true);
        try {
            const list = await invoke<ShareInfo[]>('cmd_list_shares');
            setShares(list);
        } catch (e) {
            toast.error(t('settings.load_shares_failed', { error: e }));
        } finally {
            setRefreshing(false);
        }
    }, [t]);

    useEffect(() => {
        if (isOpen && activeTab === 'sharing') {
            fetchShares();
        }
    }, [isOpen, activeTab, fetchShares]);

    const handleRevokeShare = async (id: string) => {
        const ok = await confirm({
            title: t('settings.revoke_link_title'),
            message: t('settings.revoke_link_desc'),
            confirmText: t('settings.revoke'),
            variant: 'danger',
        });
        if (!ok) return;

        try {
            await invoke('cmd_revoke_share', { id });
            toast.success(t('settings.link_revoked'));
            fetchShares();
        } catch (e) {
            toast.error(t('settings.link_revoke_failed', { error: e }));
        }
    };

    const handleCopyShare = (id: string) => {
        const share = shares.find(s => s.id === id);
        if (!share) return;
        
        let link = `http://127.0.0.1:14201/d/${share.id}`;
        if (globalDomain.trim()) {
            link = `http://${globalDomain.trim()}/d/${share.id}`;
        }
        
        navigator.clipboard.writeText(link);
        setCopiedId(share.id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    // API settings state
    const [apiSettings, setApiSettings] = useState<ApiSettings>({ enabled: false, port: 8550, key_set: false, running: false });
    const [apiPort, setApiPort] = useState('8550');
    const [apiLoading, setApiLoading] = useState(false);
    const [generatedKey, setGeneratedKey] = useState<string | null>(null);
    const [keyCopied, setKeyCopied] = useState(false);

    const fetchApiSettings = useCallback(async () => {
        try {
            const result = await invoke<ApiSettings>('cmd_get_api_settings');
            setApiSettings(result);
            setApiPort(result.port.toString());
        } catch {
            // API settings not available
        }
    }, []);

    // Load API settings when modal opens
    useEffect(() => {
        if (isOpen) {
            fetchApiSettings();
            setGeneratedKey(null);
            setKeyCopied(false);
        }
    }, [isOpen, fetchApiSettings]);

    // Fetch transcode cache info
    const fetchTranscodeCache = useCallback(async () => {
        setCacheLoading(true);
        try {
            const info = await invoke<DetailedCacheInfo>('cmd_get_detailed_transcode_cache');
            setTranscodeCache(info);
        } catch {
            setTranscodeCache(null);
        } finally {
            setCacheLoading(false);
        }
    }, []);

    // Load transcode cache when on general tab
    useEffect(() => {
        if (isOpen && activeTab === 'general') {
            fetchTranscodeCache();
        }
    }, [isOpen, activeTab, fetchTranscodeCache]);

    // Poll API status while modal is open and API is enabled
    useEffect(() => {
        if (!isOpen || !apiSettings.enabled) return;
        const interval = setInterval(fetchApiSettings, 3000);
        return () => clearInterval(interval);
    }, [isOpen, apiSettings.enabled, fetchApiSettings]);

    // Sync proxy settings to backend whenever they change
    useEffect(() => {
        const applyProxy = async () => {
            try {
                await invoke('cmd_apply_proxy_settings', {
                    enabled: settings.proxyEnabled,
                    proxyType: settings.proxyType,
                    host: settings.proxyHost,
                    port: settings.proxyPort,
                    username: settings.proxyUsername,
                    password: settings.proxyPassword,
                });
            } catch {
                // best-effort sync
            }
        };
        applyProxy();
    }, [
        settings.proxyEnabled, settings.proxyType, settings.proxyHost,
        settings.proxyPort, settings.proxyUsername, settings.proxyPassword,
    ]);

    // Sync VPN optimizer settings to backend whenever they change
    useEffect(() => {
        const applyVpn = async () => {
            try {
                await invoke('cmd_apply_vpn_settings', {
                    enabled: settings.vpnMode,
                    timeoutMultiplier: settings.timeoutMultiplier,
                    retryAttempts: settings.retryAttempts,
                    retryBaseBackoffMs: Math.round(settings.retryBaseBackoffSec * 1000),
                    retryMaxBackoffMs: Math.round(settings.retryMaxBackoffSec * 1000),
                    adaptivePolling: settings.adaptivePolling,
                    pollingMinSec: settings.pollingMinSec,
                    pollingMaxSec: settings.pollingMaxSec,
                    preferredDc: settings.preferredDC,
                    dcFallbackAttempts: settings.dcFallbackAttempts,
                    floodWaitRespect: settings.floodWaitRespect,
                    peerCacheSize: settings.peerCacheSize,
                    bandwidthLimitUpKbs: settings.bandwidthLimitUpKBs,
                    bandwidthLimitDownKbs: settings.bandwidthLimitDownKBs,
                    chunkSizeKb: settings.chunkSizeKb,
                    keepAliveIntervalSec: settings.keepAliveIntervalSec,
                    autoDetectVpn: settings.autoDetectVpn,
                    archiveMaxBytes: settings.archiveMaxBytes * 1024 * 1024,
                });
            } catch {
                // best-effort sync
            }
        };
        applyVpn();
    }, [
        settings.vpnMode, settings.timeoutMultiplier, settings.retryAttempts,
        settings.retryBaseBackoffSec, settings.retryMaxBackoffSec, settings.adaptivePolling,
        settings.pollingMinSec, settings.pollingMaxSec, settings.preferredDC,
        settings.dcFallbackAttempts, settings.floodWaitRespect, settings.peerCacheSize,
        settings.bandwidthLimitUpKBs, settings.bandwidthLimitDownKBs, settings.chunkSizeKb,
        settings.keepAliveIntervalSec, settings.autoDetectVpn, settings.archiveMaxBytes,
    ]);

    // Poll latency when VPN tab is active
    useEffect(() => {
        if (!isOpen || activeTab !== 'vpn') return;
        const check = async () => {
            try {
                const ms = await invoke<number>('cmd_check_latency');
                setLatencyMs(ms);
            } catch { setLatencyMs(null); }
        };
        check();
        const interval = setInterval(check, 5000);
        return () => clearInterval(interval);
    }, [isOpen, activeTab]);

    // Poll proxy status when Proxy tab is active
    useEffect(() => {
        if (!isOpen || activeTab !== 'proxy') return;
        const checkProxy = async () => {
            if (!settings.proxyEnabled || !settings.proxyLiveStateEnabled) {
                setProxyStatus(null);
                return;
            }
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
    }, [isOpen, activeTab, settings.proxyEnabled, settings.proxyLiveStateEnabled]);

    // Detect VPN interfaces when VPN tab opens
    useEffect(() => {
        if (!isOpen || activeTab !== 'vpn') return;
        const detect = async () => {
            try {
                const found = await invoke<boolean>('cmd_detect_vpn');
                setVpnDetected(found);
            } catch { setVpnDetected(null); }
        };
        detect();
    }, [isOpen, activeTab]);

    const handleApiToggle = async () => {
        setApiLoading(true);
        try {
            const port = parseInt(apiPort, 10);
            if (isNaN(port) || port < 1024 || port > 65535) {
                toast.error(t('settings.port_range_error'));
                setApiLoading(false);
                return;
            }
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: !apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(result.enabled ? t('settings.api_server_started') : t('settings.api_server_stopped'));
        } catch (e) {
            toast.error(t('settings.api_update_failed', { error: e }));
        } finally {
            setApiLoading(false);
        }
    };

    const handlePortApply = async () => {
        const port = parseInt(apiPort, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
            toast.error(t('settings.port_range_error'));
            return;
        }
        if (port === apiSettings.port) return;
        setApiLoading(true);
        try {
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(t('settings.api_port_updated', { port }));
        } catch (e) {
            toast.error(t('settings.api_port_update_failed', { error: e }));
        } finally {
            setApiLoading(false);
        }
    };

    const handleGenerateKey = async () => {
        const ok = await confirm({
            title: t('settings.generate_api_key_title'),
            message: apiSettings.key_set
                ? t('settings.regenerate_api_key_desc')
                : t('settings.generate_api_key_desc'),
            confirmText: apiSettings.key_set ? t('settings.regenerate') : t('settings.generate'),
            variant: apiSettings.key_set ? 'danger' : 'info',
        });
        if (!ok) return;
        try {
            const key = await invoke<string>('cmd_regenerate_api_key');
            setGeneratedKey(key);
            setKeyCopied(false);
            setApiSettings(prev => ({ ...prev, key_set: true }));
            toast.success(t('settings.api_key_generated'));
        } catch (e) {
            toast.error(t('settings.api_key_generate_failed', { error: e }));
        }
    };

    const handleCopyKey = async () => {
        if (!generatedKey) return;
        try {
            await navigator.clipboard.writeText(generatedKey);
            setKeyCopied(true);
            setTimeout(() => setKeyCopied(false), 2000);
        } catch {
            toast.error(t('settings.copy_clipboard_failed'));
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        layout
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                        className="bg-telegram-surface border border-telegram-border rounded-xl w-[440px] shadow-2xl overflow-hidden flex flex-col"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="px-5 py-4 border-b border-telegram-border flex justify-between items-center">
                            <h2 className="text-telegram-text font-semibold text-base">{t('settings.title')}</h2>
                            <button
                                onClick={onClose}
                                className="p-1.5 hover:bg-telegram-hover rounded-lg text-telegram-subtext hover:text-telegram-text transition"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Tab Bar */}
                        <div className="px-5 pt-3 pb-0 flex gap-1 justify-start overflow-x-auto border-b border-telegram-border scrollbar-none">
                            {([['general', Globe], ['themes', Palette], ['proxy', Shield], ['vpn', Zap], ['sharing', Link], ['about', Info]] as const).map(([key, Icon]) => (
                                <button
                                    key={key}
                                    onClick={() => setActiveTab(key as SettingsTab)}
                                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors shrink-0 ${
                                        activeTab === key
                                            ? 'text-telegram-primary border-b-2 border-telegram-primary bg-telegram-primary/5'
                                            : 'text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover/50'
                                    }`}
                                >
                                    <Icon className="w-3.5 h-3.5" />
                                    {t(`settings.tab_${key}`)}
                                </button>
                            ))}
                        </div>

                        {/* Body */}
                        <motion.div layout className="px-5 py-4 max-h-[70vh] overflow-y-auto overflow-x-hidden relative">
                            <AnimatePresence mode="popLayout" initial={false}>

                                {activeTab === 'general' && (
                                    <motion.div
                                        key="general"
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 20 }}
                                        transition={{ type: 'spring', damping: 25, stiffness: 220, opacity: { duration: 0.15 } }}
                                        className="space-y-6 w-full"
                                    >

                            {/* Transfers Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Upload className="w-3.5 h-3.5" />
                                    {t('settings.transfers')}
                                </h3>

                                {/* Max Concurrent Uploads */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Upload className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.concurrent_uploads')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.max_uploads_desc')}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => updateSetting('maxConcurrentUploads', Math.max(1, settings.maxConcurrentUploads - 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            -
                                        </button>
                                        <span className="text-sm text-telegram-text font-medium w-5 text-center">
                                            {settings.maxConcurrentUploads}
                                        </span>
                                        <button
                                            onClick={() => updateSetting('maxConcurrentUploads', Math.min(10, settings.maxConcurrentUploads + 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>

                                {/* Max Concurrent Downloads */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Download className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.concurrent_downloads')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.max_downloads_desc')}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => updateSetting('maxConcurrentDownloads', Math.max(1, settings.maxConcurrentDownloads - 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            -
                                        </button>
                                        <span className="text-sm text-telegram-text font-medium w-5 text-center">
                                            {settings.maxConcurrentDownloads}
                                        </span>
                                        <button
                                            onClick={() => updateSetting('maxConcurrentDownloads', Math.min(10, settings.maxConcurrentDownloads + 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>

                                {/* Zip Folders */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <FolderArchive className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.zip_before_upload')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.zip_folders_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('zipFolders', !settings.zipFolders)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.zipFolders ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.zipFolders ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Hide Folder Groups */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Tag className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('common.hide_groups')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('common.hide_groups_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('hideGroups', !settings.hideGroups)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.hideGroups ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.hideGroups ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Performance Mode */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Zap className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.performance_mode')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.performance_mode_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('performanceMode', !settings.performanceMode)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.performanceMode ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.performanceMode ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Linux Rendering Fix */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Monitor className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.linux_rendering_fix')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.linux_rendering_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => {
                                            updateSetting('linuxRenderingFix', !settings.linuxRenderingFix);
                                            toast.info(t('settings.restart_app_toast'), { duration: 5000 });
                                        }}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.linuxRenderingFix ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.linuxRenderingFix ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                            </section>

                            {/* Language & Region Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Languages className="w-3.5 h-3.5" />
                                    {t('settings.language_region')}
                                </h3>

                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Globe className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.app_language')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.choose_language')}</p>
                                        </div>
                                    </div>
                                    <div className="relative">
                                        <select
                                            value={settings.language}
                                            onChange={e => updateSetting('language', e.target.value as any)}
                                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                        >
                                            {LANGUAGES.map(lang => (
                                                <option key={lang.code} value={lang.code}>
                                                    {lang.nativeLabel}
                                                </option>
                                            ))}
                                        </select>
                                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                </div>
                            </section>

                            {/* REST API Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Globe className="w-3.5 h-3.5" />
                                    {t('settings.rest_api')}
                                </h3>

                                {/* Enable Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${apiSettings.running ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-gray-500'}`} />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.enable_api_server')}</p>
                                            <p className="text-xs text-telegram-subtext">
                                                {apiSettings.running ? t('settings.api_running', { port: apiSettings.port }) : t('settings.api_stopped')}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={handleApiToggle}
                                        disabled={apiLoading}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${apiSettings.enabled ? 'bg-telegram-primary' : 'bg-telegram-border'} disabled:opacity-50`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${apiSettings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Port */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.port')}</p>
                                        <p className="text-xs text-telegram-subtext">1024 - 65535</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            min="1024"
                                            max="65535"
                                            value={apiPort}
                                            onChange={e => setApiPort(e.target.value)}
                                            onBlur={handlePortApply}
                                            onKeyDown={e => { if (e.key === 'Enter') handlePortApply(); }}
                                            className="w-20 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-center focus:outline-none focus:border-telegram-primary/50 transition"
                                        />
                                    </div>
                                </div>

                                {/* API Key */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2.5">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Key className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.api_key')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {apiSettings.key_set ? t('settings.api_key_configured') : t('settings.api_key_unset')}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleGenerateKey}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition"
                                        >
                                            <RefreshCw className="w-3 h-3" />
                                            {apiSettings.key_set ? t('settings.regenerate') : t('settings.generate')}
                                        </button>
                                    </div>

                                    {/* One-time key reveal */}
                                    {generatedKey && (
                                        <div className="mt-2 p-2.5 bg-telegram-bg rounded-lg border border-yellow-500/20">
                                            <p className="text-[10px] text-yellow-400/80 uppercase tracking-wider font-semibold mb-1.5">
                                                {t('settings.api_copy_alert')}
                                            </p>
                                            <div className="flex items-center gap-2">
                                                <code className="flex-1 text-xs text-telegram-text font-mono bg-telegram-hover rounded px-2 py-1.5 overflow-x-auto select-all">
                                                    {generatedKey}
                                                </code>
                                                <button
                                                    onClick={handleCopyKey}
                                                    className="p-1.5 rounded-md hover:bg-telegram-hover text-telegram-subtext hover:text-telegram-text transition flex-shrink-0"
                                                    title="Copy to clipboard"
                                                >
                                                    {keyCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </section>

                            {/* Storage Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <HardDrive className="w-3.5 h-3.5" />
                                    {t('settings.storage')}
                                </h3>

                                {/* Transcode Cache Size */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <HardDrive className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.transcode_cache_limit')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.transcode_cache_desc')}</p>
                                            </div>
                                        </div>
                                        <span className="text-sm text-telegram-primary font-mono font-medium">{settings.transcodeCacheMaxGb} GB</span>
                                    </div>
                                    <input type="range" min="1" max="50" step="1" value={settings.transcodeCacheMaxGb}
                                        onChange={e => {
                                            const gb = parseInt(e.target.value);
                                            updateSetting('transcodeCacheMaxGb', gb);
                                            invoke('cmd_set_transcode_cache_limit', { maxGb: gb }).catch(() => {});
                                        }}
                                        className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                </div>

                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Trash2 className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.clear_local_cache')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.clear_local_cache_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        disabled={clearing}
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: t('settings.clear_cache_title'),
                                                message: t('settings.clear_cache_desc'),
                                                confirmText: t('settings.clear'),
                                                variant: 'danger',
                                            });
                                            if (!ok) return;
                                            setClearing(true);
                                            try {
                                                await invoke('cmd_clean_cache');
                                                toast.success(t('settings.cache_cleared'));
                                            } catch {
                                                toast.error(t('settings.cache_clear_failed'));
                                            } finally {
                                                setClearing(false);
                                            }
                                        }}
                                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {clearing ? t('settings.clearing') : t('settings.clear')}
                                    </button>
                                </div>

                                {/* Transcode Cache */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <HardDrive className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.transcode_cache')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {transcodeCache
                                                        ? `${(transcodeCache.total_bytes / 1048576).toFixed(1)} MB / ${(transcodeCache.max_bytes / 1073741824).toFixed(1)} GB`
                                                        : t('common.loading')}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                onClick={fetchTranscodeCache}
                                                disabled={cacheLoading}
                                                className="p-1.5 rounded-md hover:bg-telegram-hover text-telegram-subtext hover:text-telegram-text transition"
                                                title={t('settings.refresh_links')}
                                            >
                                                <RefreshCw className={`w-3 h-3 ${cacheLoading ? 'animate-spin' : ''}`} />
                                            </button>
                                            <button
                                                disabled={!transcodeCache || transcodeCache.entries.length === 0}
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: t('settings.clear_transcode_title'),
                                                        message: t('settings.clear_transcode_message'),
                                                        confirmText: t('settings.clear_all'),
                                                        variant: 'danger',
                                                    });
                                                    if (!ok) return;
                                                    setClearingVariant('__all__');
                                                    try {
                                                        const msg = await invoke<string>('cmd_clear_transcode_cache', {});
                                                        toast.success(msg);
                                                        fetchTranscodeCache();
                                                    } catch (e) {
                                                        toast.error(t('settings.failed_prefix', { error: e }));
                                                    } finally {
                                                        setClearingVariant(null);
                                                    }
                                                }}
                                                className="px-2.5 py-1 rounded-md text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {clearingVariant === '__all__' ? t('settings.clearing') : t('settings.clear_all')}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Cache entries list */}
                                    {transcodeCache && transcodeCache.entries.length > 0 ? (
                                        <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1 custom-scrollbar">
                                            {/* Group HLS variants by file_key (exclude originals, which are cleared via per-file Clear or Clear All) */}
                                            {(() => {
                                                const grouped: Record<string, CacheEntry[]> = {};
                                                for (const e of transcodeCache.entries) {
                                                    // Skip original entries — they're cleared via per-file or Clear All only
                                                    if (e.quality === 'original') continue;
                                                    if (!grouped[e.file_key]) grouped[e.file_key] = [];
                                                    grouped[e.file_key].push(e);
                                                }
                                                return Object.entries(grouped).map(([fileKey, entries]) => (
                                                    <div key={fileKey} className="p-2 rounded bg-telegram-bg/50 border border-telegram-border/30">
                                                        <div className="flex items-center justify-between mb-1">
                                                            <span className="text-[10px] font-mono text-telegram-subtext truncate max-w-[180px]" title={fileKey}>
                                                                {fileKey}
                                                            </span>
                                                            <button
                                                                disabled={clearingVariant !== null}
                                                                onClick={async () => {
                                                                    setClearingVariant(fileKey);
                                                                    try {
                                                                        const msg = await invoke<string>('cmd_clear_transcode_cache', { fileKey });
                                                                        toast.success(msg);
                                                                        fetchTranscodeCache();
                                                                    } catch (e) {
                                                                        toast.error(t('settings.failed_prefix', { error: e }));
                                                                    } finally {
                                                                        setClearingVariant(null);
                                                                    }
                                                                }}
                                                                className="text-[9px] text-red-400/60 hover:text-red-400 transition px-1 py-0.5 rounded hover:bg-red-500/10 disabled:opacity-30"
                                                                title={t('settings.clear_variants_for', { key: fileKey })}
                                                            >
                                                                {clearingVariant === fileKey ? '...' : t('settings.clear')}
                                                            </button>
                                                        </div>
                                                        <div className="flex flex-wrap gap-1">
                                                            {entries.map(e => (
                                                                <button
                                                                    key={`${e.file_key}:${e.quality}`}
                                                                    disabled={clearingVariant !== null}
                                                                    onClick={async () => {
                                                                        const variantKey = `${e.file_key}:${e.quality}`;
                                                                        setClearingVariant(variantKey);
                                                                        try {
                                                                            const msg = await invoke<string>('cmd_clear_transcode_cache', { fileKey: e.file_key, quality: e.quality });
                                                                            toast.success(msg);
                                                                            fetchTranscodeCache();
                                                                        } catch (err) {
                                                                            toast.error(t('settings.failed_prefix', { error: err }));
                                                                        } finally {
                                                                            setClearingVariant(null);
                                                                        }
                                                                    }}
                                                                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                                                                        e.playlist_exists
                                                                            ? 'bg-emerald-500/10 text-emerald-400 hover:bg-red-500/10 hover:text-red-400 border border-emerald-500/20'
                                                                            : 'bg-amber-500/10 text-amber-400/60 border border-amber-500/20'
                                                                    } disabled:opacity-30`}
                                                                    title={`${e.quality} — ${(e.size_bytes / 1048576).toFixed(2)} MB${e.playlist_exists ? ' (ready)' : ' (partial)'}`}
                                                                >
                                     {e.quality === 'original' ? t('settings.original') : e.quality}
                                                                    <span className="text-[8px] opacity-60">{e.playlist_exists ? '✓' : '~'}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ));
                                            })()}
                                        </div>
                                    ) : transcodeCache && transcodeCache.entries.length === 0 ? (
                                        <p className="text-[11px] text-telegram-subtext/50 text-center py-2">{t('settings.no_transcoded_cached')}</p>
                                    ) : (
                                        <div className="flex items-center justify-center py-2">
                                            <RefreshCw className="w-3 h-3 text-telegram-subtext animate-spin" />
                                        </div>
                                    )}
                                </div>
                            </section>

                            {/* Updates Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Sparkles className="w-3.5 h-3.5" />
                                    {t('settings.updates')}
                                </h3>

                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Download className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.check_for_updates')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {updateVersion ? t('settings.update_available', { version: updateVersion }) : t('settings.check_updates_desc')}
                                                </p>
                                            </div>
                                        </div>
                                        {updateAvailable && !updateDownloading ? (
                                            <button
                                                onClick={handleInstallUpdate}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary text-white hover:bg-telegram-primary/90 transition"
                                            >
                                                <Download className="w-3 h-3" />
                                                {t('settings.update_restart')}
                                            </button>
                                        ) : updateDownloading ? (
                                            <div className="flex items-center gap-2">
                                                <RefreshCw className="w-3.5 h-3.5 text-telegram-primary animate-spin" />
                                                <span className="text-xs text-telegram-primary font-mono">{updateProgress}%</span>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={handleCheckForUpdates}
                                                disabled={updateChecking}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50"
                                            >
                                                <RefreshCw className={`w-3 h-3 ${updateChecking ? 'animate-spin' : ''}`} />
                                                {updateChecking ? t('settings.checking') : t('settings.check_now')}
                                            </button>
                                        )}
                                    </div>
                                    {updateDownloading && (
                                        <div className="w-full h-1.5 bg-telegram-border rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-telegram-primary rounded-full transition-all duration-300"
                                                style={{ width: `${updateProgress}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </section>

                                    </motion.div>
                                )}

                                {activeTab === 'proxy' && (
                                    <motion.section
                                        key="proxy"
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 20 }}
                                        transition={{ type: 'spring', damping: 25, stiffness: 220, opacity: { duration: 0.15 } }}
                                        className="space-y-3 w-full"
                                    >
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Shield className="w-3.5 h-3.5" />
                                    {t('settings.proxy_config')}
                                </h3>

                                {/* Enable Proxy */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2.5 h-2.5 rounded-full ${
                                            !settings.proxyEnabled || !settings.proxyLiveStateEnabled
                                                ? 'bg-gray-500' 
                                                : !proxyStatus 
                                                    ? 'bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.5)]' 
                                                    : proxyStatus.reachable 
                                                        ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' 
                                                        : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                                        }`} />
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm text-telegram-text font-medium">{t('common.enable_proxy')}</p>
                                                {settings.proxyEnabled && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-telegram-subtext font-mono">
                                                        {!settings.proxyLiveStateEnabled
                                                            ? t('settings.proxy_status_off') || 'Off'
                                                            : !proxyStatus 
                                                                ? t('settings.proxy_status_checking') || 'Checking…' 
                                                                : proxyStatus.reachable 
                                                                    ? `${t('settings.proxy_status_connected') || 'Connected'} (${proxyStatus.latency_ms}ms)` 
                                                                    : t('settings.proxy_status_unreachable') || 'Unreachable'}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-telegram-subtext">{t('settings.enable_proxy_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('proxyEnabled', !settings.proxyEnabled)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.proxyEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.proxyEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Live Connection Monitoring */}
                                {settings.proxyEnabled && (
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.live_state') || 'Live Connection Monitoring'}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.live_state_desc') || 'Periodically check connectivity and display latency'}</p>
                                        </div>
                                        <button
                                            onClick={() => updateSetting('proxyLiveStateEnabled', !settings.proxyLiveStateEnabled)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.proxyLiveStateEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.proxyLiveStateEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                )}

                                {/* Proxy Type */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.proxy_type')}</p>
                                        <p className="text-xs text-telegram-subtext">
                                            {settings.proxyType === 'socks5' 
                                                ? t('settings.socks5_desc') 
                                                : t('settings.http_bridge_desc') || 'HTTP/HTTPS proxy tunneling via local SOCKS5 bridge.'}
                                        </p>
                                    </div>
                                    <div className="relative">
                                        <select
                                            value={settings.proxyType}
                                            onChange={e => updateSetting('proxyType', e.target.value as 'socks5' | 'http' | 'https')}
                                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                        >
                                            <option value="socks5">SOCKS5</option>
                                            <option value="http">HTTP</option>
                                            <option value="https">HTTPS</option>
                                        </select>
                                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                </div>

                                {/* Host */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.host')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.host_desc')}</p>
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="e.g. 127.0.0.1"
                                        value={settings.proxyHost}
                                        onChange={e => updateSetting('proxyHost', e.target.value)}
                                        className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                    />
                                </div>

                                {/* Port */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.port')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.port_desc')}</p>
                                    </div>
                                    <input
                                        type="number"
                                        min="1"
                                        max="65535"
                                        value={settings.proxyPort}
                                        onChange={e => updateSetting('proxyPort', Math.max(1, Math.min(65535, parseInt(e.target.value) || 1080)))}
                                        className="w-20 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-center focus:outline-none focus:border-telegram-primary/50 transition"
                                    />
                                </div>

                                {/* SOCKS5/HTTP auth fields */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.username')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.optional')}</p>
                                    </div>
                                    <input
                                        type="text"
                                        placeholder={t('settings.optional')}
                                        value={settings.proxyUsername}
                                        onChange={e => updateSetting('proxyUsername', e.target.value)}
                                        className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                    />
                                </div>
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.password')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.optional')}</p>
                                    </div>
                                    <input
                                        type="password"
                                        placeholder={t('settings.optional')}
                                        value={settings.proxyPassword}
                                        onChange={e => updateSetting('proxyPassword', e.target.value)}
                                        className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                    />
                                </div>

                                {/* Info note */}
                                <div className="p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/10 space-y-3">
                                    <p className="text-[11px] text-yellow-400/70 leading-relaxed">
                                        {t('settings.proxy_reconnect_note')}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={async () => {
                                                setReconnecting(true);
                                                try {
                                                    const ok = await invoke<boolean>('cmd_reconnect_with_network_settings');
                                                    if (ok) {
                                                        toast.success(t('settings.reconnect_success_toast'));
                                                    } else {
                                                        toast.error(t('settings.reconnect_failed_toast'));
                                                    }
                                                } catch (e) {
                                                    toast.error(t('settings.reconnect_failed_err_toast', { error: e }));
                                                } finally {
                                                    setReconnecting(false);
                                                }
                                            }}
                                            disabled={reconnecting}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {reconnecting ? (
                                                <>
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                    {t('settings.reconnecting')}
                                                </>
                                            ) : (
                                                <>
                                                    <RefreshCw className="w-3 h-3" />
                                                    {t('settings.reconnect_now')}
                                                </>
                                            )}
                                        </button>
                                        <button
                                            onClick={async () => {
                                                setIsTestingProxy(true);
                                                try {
                                                    const success = await invoke<boolean>('cmd_test_proxy_traffic');
                                                    if (success) {
                                                        toast.success(t('settings.proxy_test_success') || 'Proxy connection working!');
                                                    } else {
                                                        toast.error(t('settings.proxy_test_failed') || 'Proxy traffic test failed.');
                                                    }
                                                } catch (e) {
                                                    toast.error(`Error testing proxy: ${e}`);
                                                } finally {
                                                    setIsTestingProxy(false);
                                                }
                                            }}
                                            disabled={isTestingProxy || reconnecting || !settings.proxyEnabled}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-telegram-text hover:bg-white/10 transition disabled:opacity-30 disabled:cursor-not-allowed"
                                        >
                                            {isTestingProxy ? (
                                                <>
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                    {t('settings.proxy_testing') || 'Testing…'}
                                                </>
                                            ) : (
                                                <>
                                                    <Play className="w-3.5 h-3.5" />
                                                    {t('settings.test_connection') || 'Test Connection'}
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </motion.section>
                        )}

                        {activeTab === 'vpn' && (
                                    <motion.section
                                        key="vpn"
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 20 }}
                                        transition={{ type: 'spring', damping: 25, stiffness: 220, opacity: { duration: 0.15 } }}
                                        className="space-y-3 w-full"
                                    >
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Zap className="w-3.5 h-3.5" />
                                    {t('settings.vpn_optimizer')}
                                    {latencyMs !== null && (
                                        <span className={`ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                                            latencyMs < 0 ? 'bg-red-500/10 text-red-400' :
                                            latencyMs < 100 ? 'bg-green-500/10 text-green-400' :
                                            latencyMs < 300 ? 'bg-yellow-500/10 text-yellow-400' :
                                            'bg-red-500/10 text-red-400'
                                        }`}>
                                            <Activity className="w-3 h-3 inline mr-0.5" />
                                            {latencyMs < 0 ? 'Offline' : `${latencyMs}ms`}
                                        </span>
                                    )}
                                </h3>

                                {/* Master Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${settings.vpnMode ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-gray-500'}`} />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.vpn_mode')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.vpn_mode_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('vpnMode', !settings.vpnMode)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.vpnMode ? 'bg-emerald-500' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.vpnMode ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {settings.vpnMode && (<>
                                    {/* Timeout Multiplier */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.timeout_multiplier')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.timeout_multiplier_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.timeoutMultiplier}×</span>
                                        </div>
                                        <input type="range" min="1" max="5" step="1" value={settings.timeoutMultiplier}
                                            onChange={e => updateSetting('timeoutMultiplier', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Retry Attempts */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.retry_attempts')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.retry_attempts_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.retryAttempts}</span>
                                        </div>
                                        <input type="range" min="0" max="5" step="1" value={settings.retryAttempts}
                                            onChange={e => updateSetting('retryAttempts', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Backoff Settings */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <p className="text-sm text-telegram-text font-medium">{t('settings.retry_backoff')}</p>
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.base_delay')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">{settings.retryBaseBackoffSec}s</span>
                                        </div>
                                        <input type="range" min="0.5" max="5" step="0.5" value={settings.retryBaseBackoffSec}
                                            onChange={e => updateSetting('retryBaseBackoffSec', parseFloat(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.max_delay')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">{settings.retryMaxBackoffSec}s</span>
                                        </div>
                                        <input type="range" min="8" max="60" step="2" value={settings.retryMaxBackoffSec}
                                            onChange={e => updateSetting('retryMaxBackoffSec', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Adaptive Polling */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.adaptive_polling')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.adaptive_polling_desc')}</p>
                                            </div>
                                            <button
                                                onClick={() => updateSetting('adaptivePolling', !settings.adaptivePolling)}
                                                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.adaptivePolling ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                            >
                                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.adaptivePolling ? 'translate-x-5' : 'translate-x-0'}`} />
                                            </button>
                                        </div>
                                        {settings.adaptivePolling && (<>
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs text-telegram-subtext">{t('settings.min_interval')}</p>
                                                <span className="text-xs text-telegram-primary font-mono">{settings.pollingMinSec}s</span>
                                            </div>
                                            <input type="range" min="10" max="30" step="5" value={settings.pollingMinSec}
                                                onChange={e => updateSetting('pollingMinSec', parseInt(e.target.value))}
                                                className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs text-telegram-subtext">{t('settings.max_interval')}</p>
                                                <span className="text-xs text-telegram-primary font-mono">{settings.pollingMaxSec}s</span>
                                            </div>
                                            <input type="range" min="45" max="120" step="15" value={settings.pollingMaxSec}
                                                onChange={e => updateSetting('pollingMaxSec', parseInt(e.target.value))}
                                                className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        </>)}
                                    </div>

                                    {/* Preferred DC */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.preferred_dc')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.preferred_dc_desc')}</p>
                                        </div>
                                        <div className="relative">
                                            <select
                                                value={settings.preferredDC}
                                                onChange={e => updateSetting('preferredDC', e.target.value as typeof settings.preferredDC)}
                                                className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                            >
                                                <option value="auto">{t('settings.auto')}</option>
                                                <option value="dc1">DC 1</option>
                                                <option value="dc2">DC 2</option>
                                                <option value="dc3">DC 3</option>
                                                <option value="dc4">DC 4</option>
                                                <option value="dc5">DC 5</option>
                                            </select>
                                            <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                        </div>
                                    </div>

                                    {/* DC Fallback Attempts */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.dc_fallback_attempts')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.dc_fallback_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.dcFallbackAttempts}</span>
                                        </div>
                                        <input type="range" min="1" max="4" step="1" value={settings.dcFallbackAttempts}
                                            onChange={e => updateSetting('dcFallbackAttempts', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Flood Wait */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.respect_flood')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.respect_flood_desc')}</p>
                                        </div>
                                        <button
                                            onClick={() => updateSetting('floodWaitRespect', !settings.floodWaitRespect)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.floodWaitRespect ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.floodWaitRespect ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>

                                    {/* Peer Cache Size */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.peer_cache_size')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.peer_cache_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.peerCacheSize}</span>
                                        </div>
                                        <input type="range" min="100" max="2000" step="100" value={settings.peerCacheSize}
                                            onChange={e => updateSetting('peerCacheSize', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Bandwidth Throttle */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <p className="text-sm text-telegram-text font-medium flex items-center gap-1.5">
                                            <Gauge className="w-3.5 h-3.5 text-telegram-subtext" />
                                            {t('settings.bandwidth_throttle')}
                                        </p>
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.upload_limit')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">
                                                {settings.bandwidthLimitUpKBs === 0 ? t('settings.unlimited') : `${settings.bandwidthLimitUpKBs} KB/s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="5120" step="128" value={settings.bandwidthLimitUpKBs}
                                            onChange={e => updateSetting('bandwidthLimitUpKBs', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.download_limit')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">
                                                {settings.bandwidthLimitDownKBs === 0 ? t('settings.unlimited') : `${settings.bandwidthLimitDownKBs} KB/s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="5120" step="128" value={settings.bandwidthLimitDownKBs}
                                            onChange={e => updateSetting('bandwidthLimitDownKBs', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Chunk Size */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.transfer_chunk_size')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.chunk_size_desc')}</p>
                                        </div>
                                        <div className="relative">
                                            <select
                                                value={settings.chunkSizeKb}
                                                onChange={e => updateSetting('chunkSizeKb', parseInt(e.target.value))}
                                                className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                            >
                                                <option value={128}>128 KB</option>
                                                <option value={256}>256 KB</option>
                                                <option value={512}>512 KB</option>
                                            </select>
                                            <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                        </div>
                                    </div>

                                    {/* Keep-Alive */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.keep_alive')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.keep_alive_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">
                                                {settings.keepAliveIntervalSec === 0 ? t('settings.off') : `${settings.keepAliveIntervalSec}s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="120" step="15" value={settings.keepAliveIntervalSec}
                                            onChange={e => updateSetting('keepAliveIntervalSec', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Archive Size Limit */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.bulk_archive_limit')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.bulk_archive_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">
                                                {settings.archiveMaxBytes === 0 ? t('settings.unlimited') : `${settings.archiveMaxBytes} MiB`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="2048" step="64" value={settings.archiveMaxBytes}
                                            onChange={e => updateSetting('archiveMaxBytes', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Auto-Detect VPN */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div className="flex items-center gap-2">
                                            <Wifi className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.auto_detect_vpn')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {vpnDetected === true ? t('settings.vpn_detected') : vpnDetected === false ? t('settings.no_vpn_detected') : t('settings.checking')}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => updateSetting('autoDetectVpn', !settings.autoDetectVpn)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autoDetectVpn ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.autoDetectVpn ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                </>)}
                                    </motion.section>
                                )}

                                {activeTab === 'sharing' && (
                                    <motion.section
                                        key="sharing"
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 20 }}
                                        transition={{ type: 'spring', damping: 25, stiffness: 220, opacity: { duration: 0.15 } }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                                <Link className="w-3.5 h-3.5 text-telegram-primary" />
                                                {t('settings.shared_links', { count: shares.length })}
                                            </h3>
                                            <button 
                                                onClick={fetchShares} 
                                                className="text-telegram-subtext hover:text-telegram-text p-1 rounded hover:bg-telegram-hover transition"
                                                title={t('settings.refresh_links')}
                                            >
                                                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                                            </button>
                                        </div>

                                        <div className="bg-telegram-hover/30 border border-telegram-border/50 rounded-lg p-3 space-y-2">
                                            <div className="text-[11px] font-semibold text-telegram-text flex items-center gap-1">🌐 {t('settings.ip_override')}</div>
                                            <input
                                                type="text"
                                                placeholder="e.g. 100.115.22.45 or my-pc:14201"
                                                value={globalDomain}
                                                onChange={(e) => setGlobalDomain(e.target.value)}
                                                className="w-full bg-telegram-surface border border-telegram-border rounded-md px-2.5 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary/50 placeholder:text-telegram-subtext/40"
                                            />
                                            <p className="text-[10px] text-telegram-subtext">
                                                {t('settings.ip_override_desc')}
                                            </p>
                                        </div>

                                        {shares.length === 0 ? (
                                            <div className="py-8 text-center space-y-2">
                                                <Link className="w-8 h-8 text-telegram-subtext/40 mx-auto" />
                                                <p className="text-sm font-medium text-telegram-text">{t('settings.no_active_links')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.no_active_links_desc')}</p>
                                            </div>
                                        ) : (
                                            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                                                {shares.map((share) => {
                                                    const isExpired = share.expires_at ? (share.expires_at < Math.floor(Date.now() / 1000)) : false;
                                                    return (
                                                        <div key={share.id} className="p-3 rounded-lg bg-telegram-hover/40 border border-telegram-border/50 flex flex-col gap-2 relative">
                                                              <div className="flex justify-between items-start gap-4">
                                                                <div className="min-w-0 flex-1">
                                                                    <div className="text-xs font-semibold text-telegram-text truncate" title={share.file_name}>
                                                                        {share.file_name}
                                                                    </div>
                                                                    <div className="flex gap-2 items-center mt-1 flex-wrap text-[10px]">
                                                                        <span className="text-telegram-subtext">
                                                                            {new Date(share.created_at * 1000).toLocaleDateString()}
                                                                        </span>
                                                                        <span className="w-1 h-1 rounded-full bg-telegram-border" />
                                                                        {share.has_password ? (
                                                                            <span className="text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5 font-medium">
                                                                                <Key className="w-2.5 h-2.5" /> {t('settings.protected')}
                                                                            </span>
                                                                        ) : (
                                                                            <span className="text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.public')}</span>
                                                                        )}
                                                                        <span className="w-1 h-1 rounded-full bg-telegram-border" />
                                                                        {share.expires_at ? (
                                                                            isExpired ? (
                                                                                <span className="text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.expired')}</span>
                                                                            ) : (
                                                                                <span className="text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded font-medium">
                                                                                    {t('settings.expires_at', { date: new Date(share.expires_at * 1000).toLocaleDateString() })}
                                                                                </span>
                                                                            )
                                                                        ) : (
                                                                            <span className="text-teal-400 bg-teal-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.never_expires')}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                
                                                                <div className="flex gap-1">
                                                                    <button
                                                                        onClick={() => handleCopyShare(share.id)}
                                                                        className={`p-1.5 rounded bg-telegram-surface border border-telegram-border text-telegram-text hover:bg-telegram-hover transition ${
                                                                            copiedId === share.id ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : ''
                                                                        }`}
                                                                        title={t('settings.copy_share_link')}
                                                                    >
                                                                        {copiedId === share.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleRevokeShare(share.id)}
                                                                        className="p-1.5 rounded bg-telegram-surface border border-telegram-border text-red-400 hover:bg-red-500/10 hover:border-red-500/30 transition"
                                                                        title={t('settings.revoke_link')}
                                                                    >
                                                                        <Trash2 className="w-3.5 h-3.5" />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </motion.section>
                                )}
                                {activeTab === 'themes' && (
                                    <ThemesTab />
                                )}
                                {activeTab === 'about' && (
                                    <motion.section
                                        key="about"
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 20 }}
                                        transition={{ type: 'spring', damping: 25, stiffness: 220, opacity: { duration: 0.15 } }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex flex-col items-center py-6 space-y-5">
                                            {/* Logo */}
                                            <img src="/logo.svg" className="w-16 h-16 drop-shadow-lg" alt="Telegram Drive Logo" />
                                            
                                            {/* App Name & Version */}
                                            <div className="text-center">
                                                <h3 className="text-base font-bold text-telegram-text">Telegram Drive</h3>
                                                <p className="text-xs text-telegram-subtext mt-0.5">v{appVersion}</p>
                                            </div>

                                            {/* Divider */}
                                            <div className="w-12 h-px bg-telegram-border" />

                                            {/* Diagnostics */}
                                            <button
                                                onClick={async () => {
                                                    setDiagLoading(true);
                                                    try {
                                                        const info = await invoke<string>('cmd_get_system_diagnostics');
                                                        await navigator.clipboard.writeText(info);
                                                        toast.success(t('settings.diagnostics_copied'));
                                                    } catch (e) {
                                                        toast.error(t('settings.diagnostics_copy_failed', { error: e }));
                                                    } finally {
                                                        setDiagLoading(false);
                                                    }
                                                }}
                                                disabled={diagLoading}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-hover border border-telegram-border text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border/30 transition disabled:opacity-50"
                                            >
                                                {diagLoading ? (
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                ) : (
                                                    <Clipboard className="w-3 h-3" />
                                                )}
                                                {t('settings.copy_diagnostics')}
                                            </button>

                                            {/* Creator Info */}
                                            <div className="text-center space-y-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-telegram-text">Cameron Amer</p>
                                                </div>

                                                {/* Website Link */}
                                                <button
                                                    onClick={(e) => { e.preventDefault(); open('https://www.cameronamer.com'); }}
                                                    className="flex items-center justify-center gap-1.5 text-xs text-telegram-primary hover:text-telegram-primary/80 transition-colors cursor-pointer"
                                                >
                                                    <Globe className="w-3.5 h-3.5" />
                                                    www.cameronamer.com
                                                </button>

                                                {/* GitHub Link */}
                                                <button
                                                    onClick={(e) => { e.preventDefault(); open('https://github.com/caamer20/telegram-drive'); }}
                                                    className="flex items-center justify-center gap-1.5 text-xs text-telegram-primary hover:text-telegram-primary/80 transition-colors cursor-pointer"
                                                >
                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                                                    </svg>
                                                    github.com/caamer20/telegram-drive
                                                </button>
                                            </div>

                                            {/* Tagline */}
                                            <p className="text-[11px] text-telegram-subtext/60 leading-relaxed max-w-[280px] text-center">
                                                {t('settings.tagline')}
                                            </p>
                                        </div>
                                    </motion.section>
                                )}
                            </AnimatePresence>
                        </motion.div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-telegram-border flex items-center justify-between">
                            <button
                                onClick={resetSettings}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-telegram-subtext hover:text-red-400 hover:bg-red-500/10 transition font-medium"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                {t('settings.reset_defaults')}
                            </button>
                            <button
                                onClick={onClose}
                                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary text-white hover:bg-telegram-primary/90 transition"
                            >
                                {t('settings.done')}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

// ── Themes Tab ──────────────────────────────────────────────────────
// Inline component (follows the pattern of the other tabs in this file).

const PALETTE_KEYS: { key: keyof ThemeColorPalette; labelKey: string }[] = [
    { key: 'bg', labelKey: 'settings.color_bg' },
    { key: 'surface', labelKey: 'settings.color_surface' },
    { key: 'primary', labelKey: 'settings.color_primary' },
    { key: 'secondary', labelKey: 'settings.color_secondary' },
    { key: 'text', labelKey: 'settings.color_text' },
    { key: 'subtext', labelKey: 'settings.color_subtext' },
];

function ThemesTab() {
    const { t } = useTranslation();
    const {
        customThemes,
        activeCustomThemeId,
        setActiveCustomTheme,
        addCustomTheme,
        deleteCustomTheme,
        updateCustomTheme,
    } = useTheme();
    const { confirm } = useConfirm();

    const [editingId, setEditingId] = useState<string | null>(null);

    const builtinThemes = customThemes.filter(t => t.isBuiltin);
    const userThemes = customThemes.filter(t => !t.isBuiltin);
    const editingTheme = editingId ? customThemes.find(t => t.id === editingId) : null;

    const handleCreateTheme = () => {
        const id = generateThemeId();
        const newTheme: CustomTheme = {
            id,
            name: 'My Theme',
            isDark: true,
            palette: getDefaultPalette(true),
        };
        addCustomTheme(newTheme);
        setEditingId(id);
        setActiveCustomTheme(id);
    };

    const handleSelectTheme = (theme: CustomTheme) => {
        if (activeCustomThemeId === theme.id) {
            // Deselect → reset to default
            setActiveCustomTheme(null);
            setEditingId(null);
        } else {
            setActiveCustomTheme(theme.id);
            if (!theme.isBuiltin) {
                setEditingId(theme.id);
            } else {
                setEditingId(null);
            }
        }
    };

    const handleDeleteTheme = async (id: string) => {
        const ok = await confirm({
            title: t('settings.delete_theme'),
            message: t('settings.delete_theme_confirm'),
            confirmText: t('common.delete'),
            variant: 'danger',
        });
        if (!ok) return;
        deleteCustomTheme(id);
        if (editingId === id) setEditingId(null);
    };

    const handlePaletteChange = (key: keyof ThemeColorPalette, value: string) => {
        if (!editingTheme || editingTheme.isBuiltin) return;
        const newPalette = { ...editingTheme.palette, [key]: value };
        updateCustomTheme(editingTheme.id, { palette: newPalette });
    };

    const handleBaseToggle = (isDark: boolean) => {
        if (!editingTheme || editingTheme.isBuiltin) return;
        updateCustomTheme(editingTheme.id, { isDark });
    };

    const handleNameChange = (name: string) => {
        if (!editingTheme || editingTheme.isBuiltin) return;
        updateCustomTheme(editingTheme.id, { name });
    };

    return (
        <motion.section
            key="themes"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 220, opacity: { duration: 0.15 } }}
            className="space-y-5 w-full"
        >
            {/* Presets */}
            <div className="space-y-2">
                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                    <Palette className="w-3.5 h-3.5" />
                    {t('settings.presets')}
                </h3>
                <div className="grid grid-cols-4 gap-2">
                    {builtinThemes.map(theme => (
                        <button
                            key={theme.id}
                            onClick={() => handleSelectTheme(theme)}
                            className={`relative rounded-lg p-0.5 transition-all duration-200 ${
                                activeCustomThemeId === theme.id
                                    ? 'ring-2 ring-telegram-primary ring-offset-1 ring-offset-telegram-surface'
                                    : 'hover:ring-1 hover:ring-telegram-subtext/30'
                            }`}
                            title={theme.name}
                        >
                            {/* Color preview swatch */}
                            <div className="rounded-md overflow-hidden h-10 flex">
                                <div className="flex-1" style={{ background: theme.palette.bg }} />
                                <div className="flex-1" style={{ background: theme.palette.surface }} />
                                <div className="flex-1" style={{ background: theme.palette.primary }} />
                            </div>
                            <p className="text-[10px] text-telegram-subtext mt-1 truncate text-center">
                                {theme.name}
                            </p>
                            {activeCustomThemeId === theme.id && (
                                <div className="absolute -top-1 -right-1 w-4 h-4 bg-telegram-primary rounded-full flex items-center justify-center">
                                    <Check className="w-2.5 h-2.5 text-white" />
                                </div>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Custom Themes */}
            <div className="space-y-2">
                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5" />
                    {t('settings.custom_themes')}
                </h3>

                {userThemes.length > 0 && (
                    <div className="grid grid-cols-4 gap-2">
                        {userThemes.map(theme => (
                            <button
                                key={theme.id}
                                onClick={() => handleSelectTheme(theme)}
                                className={`relative rounded-lg p-0.5 transition-all duration-200 ${
                                    activeCustomThemeId === theme.id
                                        ? 'ring-2 ring-telegram-primary ring-offset-1 ring-offset-telegram-surface'
                                        : 'hover:ring-1 hover:ring-telegram-subtext/30'
                                }`}
                                title={theme.name}
                            >
                                <div className="rounded-md overflow-hidden h-10 flex">
                                    <div className="flex-1" style={{ background: theme.palette.bg }} />
                                    <div className="flex-1" style={{ background: theme.palette.surface }} />
                                    <div className="flex-1" style={{ background: theme.palette.primary }} />
                                </div>
                                <p className="text-[10px] text-telegram-subtext mt-1 truncate text-center">
                                    {theme.name}
                                </p>
                                {activeCustomThemeId === theme.id && (
                                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-telegram-primary rounded-full flex items-center justify-center">
                                        <Check className="w-2.5 h-2.5 text-white" />
                                    </div>
                                )}
                            </button>
                        ))}
                    </div>
                )}

                <button
                    onClick={handleCreateTheme}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-telegram-border text-telegram-subtext hover:text-telegram-primary hover:border-telegram-primary/50 transition-colors text-xs"
                >
                    <Plus className="w-3.5 h-3.5" />
                    {t('settings.create_theme')}
                </button>
            </div>

            {/* Editor (shown when a custom theme is selected) */}
            {editingTheme && !editingTheme.isBuiltin && (
                <div className="space-y-3 p-3 rounded-lg bg-telegram-hover/30 border border-telegram-border/50">
                    <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider">
                        {t('settings.edit_theme')}
                    </h3>

                    {/* Theme Name */}
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-telegram-subtext w-16 shrink-0">{t('settings.theme_name')}</label>
                        <input
                            type="text"
                            value={editingTheme.name}
                            onChange={e => handleNameChange(e.target.value)}
                            className="flex-1 px-2 py-1.5 rounded-md text-xs bg-telegram-surface border border-telegram-border text-telegram-text focus:border-telegram-primary outline-none transition"
                            maxLength={32}
                        />
                    </div>

                    {/* Base Mode Toggle */}
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-telegram-subtext w-16 shrink-0">{t('settings.base_mode')}</label>
                        <div className="flex gap-1">
                            <button
                                onClick={() => handleBaseToggle(true)}
                                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                                    editingTheme.isDark
                                        ? 'bg-telegram-primary text-white'
                                        : 'bg-telegram-hover text-telegram-subtext hover:text-telegram-text'
                                }`}
                            >
                                Dark
                            </button>
                            <button
                                onClick={() => handleBaseToggle(false)}
                                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                                    !editingTheme.isDark
                                        ? 'bg-telegram-primary text-white'
                                        : 'bg-telegram-hover text-telegram-subtext hover:text-telegram-text'
                                }`}
                            >
                                Light
                            </button>
                        </div>
                    </div>

                    {/* Color Pickers */}
                    <div className="space-y-2">
                        {PALETTE_KEYS.map(({ key, labelKey }) => (
                            <div key={key} className="flex items-center gap-2">
                                <label className="text-xs text-telegram-subtext w-16 shrink-0">{t(labelKey)}</label>
                                <div className="flex items-center gap-1.5 flex-1">
                                    <input
                                        type="color"
                                        value={editingTheme.palette[key].startsWith('rgba') ? '#888888' : editingTheme.palette[key]}
                                        onChange={e => handlePaletteChange(key, e.target.value)}
                                        className="w-7 h-7 rounded-md border border-telegram-border cursor-pointer p-0.5 bg-transparent"
                                    />
                                    <input
                                        type="text"
                                        value={editingTheme.palette[key]}
                                        onChange={e => handlePaletteChange(key, e.target.value)}
                                        className="flex-1 px-2 py-1 rounded-md text-xs bg-telegram-surface border border-telegram-border text-telegram-text focus:border-telegram-primary outline-none transition font-mono"
                                        maxLength={30}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Delete Button */}
                    <button
                        onClick={() => handleDeleteTheme(editingTheme.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 transition"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('settings.delete_theme')}
                    </button>
                </div>
            )}

            {/* Reset to Default */}
            {activeCustomThemeId && (
                <button
                    onClick={() => {
                        setActiveCustomTheme(null);
                        setEditingId(null);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-telegram-subtext hover:text-telegram-text bg-telegram-hover/50 hover:bg-telegram-hover transition"
                >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {t('settings.reset_default')}
                </button>
            )}
        </motion.section>
    );
}
