import { useState, useEffect, useCallback } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type as osType } from '@tauri-apps/plugin-os';
import { installVerifiedUpdate, type UpdateInstallPhase } from '../services/updateReliability';

interface UpdateState {
    checking: boolean;
    available: boolean;
    downloading: boolean;
    progress: number;
    error: string | null;
    version: string | null;
    phase: UpdateInstallPhase | null;
}

interface AndroidUpdateManifest {
    version: string;
    versionCode: number;
}

interface AndroidUpdateProgress {
    downloadedBytes: number;
    totalBytes?: number;
    percent?: number;
}

interface AndroidInstallResult {
    installerLaunched: boolean;
    unknownSourcesSettingsOpened: boolean;
}

export function useUpdateCheck() {
    const [state, setState] = useState<UpdateState>({
        checking: false,
        available: false,
        downloading: false,
        progress: 0,
        error: null,
        version: null,
        phase: null,
    });
    const [update, setUpdate] = useState<Update | null>(null);
    const [androidUpdate, setAndroidUpdate] = useState<AndroidUpdateManifest | null>(null);
    const isAndroid = (() => {
        try { return osType() === 'android'; } catch { return false; }
    })();

    const checkForUpdates = useCallback(async () => {
        setState(s => ({ ...s, checking: true, error: null }));
        try {
            if (isAndroid) {
                const updateInfo = await invoke<AndroidUpdateManifest | null>('cmd_check_android_update');
                setAndroidUpdate(updateInfo);
                setState(s => ({
                    ...s,
                    checking: false,
                    available: updateInfo !== null,
                    version: updateInfo?.version ?? null,
                }));
                return;
            }
            const updateInfo = await check();
            if (updateInfo) {
                setUpdate(updateInfo);
                setState(s => ({
                    ...s,
                    checking: false,
                    available: true,
                    version: updateInfo.version,
                }));
            } else {
                setState(s => ({ ...s, checking: false, available: false }));
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to check for updates';
            setState(s => ({
                ...s,
                checking: false,
                error: message,
            }));
        }
    }, [isAndroid]);

    const downloadAndInstall = useCallback(async () => {
        if (!update && !androidUpdate) return;

        setState(s => ({ ...s, downloading: true, progress: 0, phase: 'downloading', error: null }));
        try {
            if (isAndroid) {
                const unlisten = await listen<AndroidUpdateProgress>('android-update-progress', (event) => {
                    const progress = event.payload.percent;
                    if (progress !== undefined) {
                        setState(s => ({
                            ...s,
                            progress,
                            phase: progress >= 100 ? 'installing' : 'downloading',
                        }));
                    }
                });
                try {
                    const result = await invoke<AndroidInstallResult>('cmd_download_and_install_android_update');
                    if (result.unknownSourcesSettingsOpened) {
                        setState(s => ({
                            ...s,
                            downloading: false,
                            phase: null,
                            error: 'Allow Telegram Drive to install updates, then choose Update Now again.',
                        }));
                    }
                } finally {
                    unlisten();
                }
                return;
            }
            await installVerifiedUpdate(
                update!,
                (nextProgress) => setState(s => ({ ...s, progress: nextProgress })),
                (phase) => setState(s => ({ ...s, phase })),
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to install update';
            setState(s => ({
                ...s,
                downloading: false,
                phase: null,
                error: message,
            }));
        }
    }, [androidUpdate, isAndroid, update]);

    const dismissUpdate = useCallback(() => {
        setState(s => ({ ...s, available: false, phase: null }));
        setUpdate(null);
        setAndroidUpdate(null);
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            checkForUpdates().catch(console.error);
        }, 5000);
        return () => clearTimeout(timer);
    }, [checkForUpdates]);

    return {
        ...state,
        checkForUpdates,
        downloadAndInstall,
        dismissUpdate,
    };
}
