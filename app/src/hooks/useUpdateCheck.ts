import { useState, useEffect, useCallback } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
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

    const checkForUpdates = useCallback(async () => {
        setState(s => ({ ...s, checking: true, error: null }));
        try {
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
    }, []);

    const downloadAndInstall = useCallback(async () => {
        if (!update) return;

        setState(s => ({ ...s, downloading: true, progress: 0, phase: 'downloading', error: null }));
        try {
            await installVerifiedUpdate(
                update,
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
    }, [update]);

    const dismissUpdate = useCallback(() => {
        setState(s => ({ ...s, available: false, phase: null }));
        setUpdate(null);
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
