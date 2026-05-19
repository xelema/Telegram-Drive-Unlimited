import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, RotateCcw, Download, Upload, Trash2, HardDrive, Globe, Key, Copy, Check, RefreshCw, FolderArchive, Shield, Zap, Activity, Gauge, Wifi, ChevronDown } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useSettings } from '../../context/SettingsContext';
import { useConfirm } from '../../context/ConfirmContext';

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

type SettingsTab = 'general' | 'proxy' | 'vpn';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, updateSetting, resetSettings } = useSettings();
    const { confirm } = useConfirm();
    const [clearing, setClearing] = useState(false);
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [vpnDetected, setVpnDetected] = useState<boolean | null>(null);

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
                    secret: settings.proxySecret,
                });
            } catch {
                // best-effort sync
            }
        };
        applyProxy();
    }, [
        settings.proxyEnabled, settings.proxyType, settings.proxyHost,
        settings.proxyPort, settings.proxyUsername, settings.proxyPassword,
        settings.proxySecret,
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
        settings.keepAliveIntervalSec, settings.autoDetectVpn,
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
                toast.error('Port must be between 1024 and 65535');
                setApiLoading(false);
                return;
            }
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: !apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(result.enabled ? 'API server started' : 'API server stopped');
        } catch (e) {
            toast.error(`Failed to update API: ${e}`);
        } finally {
            setApiLoading(false);
        }
    };

    const handlePortApply = async () => {
        const port = parseInt(apiPort, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
            toast.error('Port must be between 1024 and 65535');
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
            toast.success(`API port updated to ${port}`);
        } catch (e) {
            toast.error(`Failed to update port: ${e}`);
        } finally {
            setApiLoading(false);
        }
    };

    const handleGenerateKey = async () => {
        const ok = await confirm({
            title: 'Generate API Key',
            message: apiSettings.key_set
                ? 'This will revoke your current API key and generate a new one. Any existing integrations will stop working.'
                : 'Generate a new API key for authenticating REST API requests.',
            confirmText: apiSettings.key_set ? 'Regenerate' : 'Generate',
            variant: apiSettings.key_set ? 'danger' : 'info',
        });
        if (!ok) return;
        try {
            const key = await invoke<string>('cmd_regenerate_api_key');
            setGeneratedKey(key);
            setKeyCopied(false);
            setApiSettings(prev => ({ ...prev, key_set: true }));
            toast.success('API key generated');
        } catch (e) {
            toast.error(`Failed to generate key: ${e}`);
        }
    };

    const handleCopyKey = async () => {
        if (!generatedKey) return;
        try {
            await navigator.clipboard.writeText(generatedKey);
            setKeyCopied(true);
            setTimeout(() => setKeyCopied(false), 2000);
        } catch {
            toast.error('Failed to copy to clipboard');
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
                            <h2 className="text-telegram-text font-semibold text-base">Settings</h2>
                            <button
                                onClick={onClose}
                                className="p-1.5 hover:bg-telegram-hover rounded-lg text-telegram-subtext hover:text-telegram-text transition"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Tab Bar */}
                        <div className="px-5 pt-3 pb-0 flex gap-1 border-b border-telegram-border">
                            {([['general', 'General', Globe], ['proxy', 'Proxy', Shield], ['vpn', 'VPN', Zap]] as const).map(([key, label, Icon]) => (
                                <button
                                    key={key}
                                    onClick={() => setActiveTab(key as SettingsTab)}
                                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
                                        activeTab === key
                                            ? 'text-telegram-primary border-b-2 border-telegram-primary bg-telegram-primary/5'
                                            : 'text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover/50'
                                    }`}
                                >
                                    <Icon className="w-3.5 h-3.5" />
                                    {label}
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
                                    Transfers
                                </h3>

                                {/* Max Concurrent Uploads */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Upload className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">Concurrent Uploads</p>
                                            <p className="text-xs text-telegram-subtext">Max parallel uploads</p>
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
                                            <p className="text-sm text-telegram-text font-medium">Concurrent Downloads</p>
                                            <p className="text-xs text-telegram-subtext">Max parallel downloads</p>
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
                                            <p className="text-sm text-telegram-text font-medium">Zip Folders Before Upload</p>
                                            <p className="text-xs text-telegram-subtext">Compress folders into .zip before uploading</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('zipFolders', !settings.zipFolders)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.zipFolders ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.zipFolders ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                            </section>

                            {/* REST API Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Globe className="w-3.5 h-3.5" />
                                    REST API
                                </h3>

                                {/* Enable Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${apiSettings.running ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-gray-500'}`} />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">Enable API Server</p>
                                            <p className="text-xs text-telegram-subtext">
                                                {apiSettings.running ? `Running on port ${apiSettings.port}` : 'Localhost only (127.0.0.1)'}
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
                                        <p className="text-sm text-telegram-text font-medium">Port</p>
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
                                                <p className="text-sm text-telegram-text font-medium">API Key</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {apiSettings.key_set ? 'Key configured' : 'No key set'}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleGenerateKey}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition"
                                        >
                                            <RefreshCw className="w-3 h-3" />
                                            {apiSettings.key_set ? 'Regenerate' : 'Generate'}
                                        </button>
                                    </div>

                                    {/* One-time key reveal */}
                                    {generatedKey && (
                                        <div className="mt-2 p-2.5 bg-telegram-bg rounded-lg border border-yellow-500/20">
                                            <p className="text-[10px] text-yellow-400/80 uppercase tracking-wider font-semibold mb-1.5">
                                                Copy now — this key will not be shown again
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
                                    Storage
                                </h3>

                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Trash2 className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">Clear Local Cache</p>
                                            <p className="text-xs text-telegram-subtext">Remove cached previews and temp files</p>
                                        </div>
                                    </div>
                                    <button
                                        disabled={clearing}
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: 'Clear Cache',
                                                message: 'This will remove all cached previews and temporary files. Your uploaded files on Telegram are not affected.',
                                                confirmText: 'Clear',
                                                variant: 'danger',
                                            });
                                            if (!ok) return;
                                            setClearing(true);
                                            try {
                                                await invoke('cmd_clean_cache');
                                                toast.success('Cache cleared successfully');
                                            } catch {
                                                toast.error('Failed to clear cache');
                                            } finally {
                                                setClearing(false);
                                            }
                                        }}
                                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {clearing ? 'Clearing...' : 'Clear'}
                                    </button>
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
                                    Proxy Configuration
                                </h3>

                                {/* Enable Proxy */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${settings.proxyEnabled ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-gray-500'}`} />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">Enable Proxy</p>
                                            <p className="text-xs text-telegram-subtext">Route traffic through a proxy server</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('proxyEnabled', !settings.proxyEnabled)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.proxyEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.proxyEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Proxy Type */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">Proxy Type</p>
                                        <p className="text-xs text-telegram-subtext">SOCKS5 or MTProto proxy</p>
                                    </div>
                                    <div className="relative">
                                        <select
                                            value={settings.proxyType}
                                            onChange={e => updateSetting('proxyType', e.target.value as 'socks5' | 'mtproto')}
                                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                        >
                                            <option value="socks5">SOCKS5</option>
                                            <option value="mtproto">MTProto</option>
                                        </select>
                                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                </div>

                                {/* Host */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">Host</p>
                                        <p className="text-xs text-telegram-subtext">Proxy server address</p>
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
                                        <p className="text-sm text-telegram-text font-medium">Port</p>
                                        <p className="text-xs text-telegram-subtext">1–65535</p>
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

                                {/* SOCKS5 auth fields */}
                                {settings.proxyType === 'socks5' && (
                                    <>
                                        <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">Username</p>
                                                <p className="text-xs text-telegram-subtext">Optional</p>
                                            </div>
                                            <input
                                                type="text"
                                                placeholder="Optional"
                                                value={settings.proxyUsername}
                                                onChange={e => updateSetting('proxyUsername', e.target.value)}
                                                className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                            />
                                        </div>
                                        <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">Password</p>
                                                <p className="text-xs text-telegram-subtext">Optional</p>
                                            </div>
                                            <input
                                                type="password"
                                                placeholder="Optional"
                                                value={settings.proxyPassword}
                                                onChange={e => updateSetting('proxyPassword', e.target.value)}
                                                className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                            />
                                        </div>
                                    </>
                                )}

                                {/* MTProto secret */}
                                {settings.proxyType === 'mtproto' && (
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">Secret</p>
                                            <p className="text-xs text-telegram-subtext">MTProto proxy secret key</p>
                                        </div>
                                        <input
                                            type="password"
                                            placeholder="Required"
                                            value={settings.proxySecret}
                                            onChange={e => updateSetting('proxySecret', e.target.value)}
                                            className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                        />
                                    </div>
                                )}

                                {/* Info note */}
                                <div className="p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/10">
                                    <p className="text-[11px] text-yellow-400/70 leading-relaxed">
                                        ⚠️ Proxy changes require reconnecting. The app will attempt to reconnect automatically when you toggle the proxy.
                                    </p>
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
                                    VPN Optimizer
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
                                            <p className="text-sm text-telegram-text font-medium">VPN Mode</p>
                                            <p className="text-xs text-telegram-subtext">Optimize for high-latency / VPN connections</p>
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
                                                <p className="text-sm text-telegram-text font-medium">Timeout Multiplier</p>
                                                <p className="text-xs text-telegram-subtext">Increase connection timeouts</p>
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
                                                <p className="text-sm text-telegram-text font-medium">Retry Attempts</p>
                                                <p className="text-xs text-telegram-subtext">Retries on failed API calls</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.retryAttempts}</span>
                                        </div>
                                        <input type="range" min="0" max="5" step="1" value={settings.retryAttempts}
                                            onChange={e => updateSetting('retryAttempts', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Backoff Settings */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <p className="text-sm text-telegram-text font-medium">Retry Backoff</p>
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">Base delay</p>
                                            <span className="text-xs text-telegram-primary font-mono">{settings.retryBaseBackoffSec}s</span>
                                        </div>
                                        <input type="range" min="0.5" max="5" step="0.5" value={settings.retryBaseBackoffSec}
                                            onChange={e => updateSetting('retryBaseBackoffSec', parseFloat(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">Max delay</p>
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
                                                <p className="text-sm text-telegram-text font-medium">Adaptive Polling</p>
                                                <p className="text-xs text-telegram-subtext">Auto-adjust update check interval</p>
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
                                                <p className="text-xs text-telegram-subtext">Min interval</p>
                                                <span className="text-xs text-telegram-primary font-mono">{settings.pollingMinSec}s</span>
                                            </div>
                                            <input type="range" min="10" max="30" step="5" value={settings.pollingMinSec}
                                                onChange={e => updateSetting('pollingMinSec', parseInt(e.target.value))}
                                                className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs text-telegram-subtext">Max interval</p>
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
                                            <p className="text-sm text-telegram-text font-medium">Preferred Data Centre</p>
                                            <p className="text-xs text-telegram-subtext">Start connections from this DC</p>
                                        </div>
                                        <div className="relative">
                                            <select
                                                value={settings.preferredDC}
                                                onChange={e => updateSetting('preferredDC', e.target.value as typeof settings.preferredDC)}
                                                className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                            >
                                                <option value="auto">Auto</option>
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
                                                <p className="text-sm text-telegram-text font-medium">DC Fallback Attempts</p>
                                                <p className="text-xs text-telegram-subtext">DCs to try on connection failure</p>
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
                                            <p className="text-sm text-telegram-text font-medium">Respect Flood Wait</p>
                                            <p className="text-xs text-telegram-subtext">Auto-sleep on FLOOD_WAIT errors</p>
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
                                                <p className="text-sm text-telegram-text font-medium">Peer Cache Size</p>
                                                <p className="text-xs text-telegram-subtext">Cached peer resolutions</p>
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
                                            Bandwidth Throttle
                                        </p>
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">Upload limit</p>
                                            <span className="text-xs text-telegram-primary font-mono">
                                                {settings.bandwidthLimitUpKBs === 0 ? 'Unlimited' : `${settings.bandwidthLimitUpKBs} KB/s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="5120" step="128" value={settings.bandwidthLimitUpKBs}
                                            onChange={e => updateSetting('bandwidthLimitUpKBs', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">Download limit</p>
                                            <span className="text-xs text-telegram-primary font-mono">
                                                {settings.bandwidthLimitDownKBs === 0 ? 'Unlimited' : `${settings.bandwidthLimitDownKBs} KB/s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="5120" step="128" value={settings.bandwidthLimitDownKBs}
                                            onChange={e => updateSetting('bandwidthLimitDownKBs', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Chunk Size */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">Transfer Chunk Size</p>
                                            <p className="text-xs text-telegram-subtext">Smaller = better for unstable connections</p>
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
                                                <p className="text-sm text-telegram-text font-medium">Keep-Alive Ping</p>
                                                <p className="text-xs text-telegram-subtext">Prevent VPN idle disconnects</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">
                                                {settings.keepAliveIntervalSec === 0 ? 'Off' : `${settings.keepAliveIntervalSec}s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="120" step="15" value={settings.keepAliveIntervalSec}
                                            onChange={e => updateSetting('keepAliveIntervalSec', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Auto-Detect VPN */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div className="flex items-center gap-2">
                                            <Wifi className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">Auto-Detect VPN</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {vpnDetected === true ? 'VPN interface detected' : vpnDetected === false ? 'No VPN detected' : 'Checking...'}
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
                            </AnimatePresence>
                        </motion.div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-telegram-border flex items-center justify-between">
                            <button
                                onClick={resetSettings}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-telegram-subtext hover:text-red-400 hover:bg-red-500/10 transition font-medium"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                Reset to Defaults
                            </button>
                            <button
                                onClick={onClose}
                                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary text-white hover:bg-telegram-primary/90 transition"
                            >
                                Done
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
