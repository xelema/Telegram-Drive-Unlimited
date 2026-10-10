import { useState, useEffect, useCallback, useRef } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import type { UpdateInstallPhase } from '../services/updateReliability';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getInstallationInfo, RELEASES_URL } from '../services/installationInfo';
import { useSettings } from '../context/SettingsContext';
import { INITIAL_UPDATE_CHECK_DELAY_MS, UPDATE_RECHECK_INTERVAL_MS } from '../services/updatePolicy';

interface UpdateState {
    checking: boolean;
    available: boolean;
    downloading: boolean;
    progress: number;
    error: string | null;
    version: string | null;
    phase: UpdateInstallPhase | null;
    managedByPackageManager: boolean;
}

interface UpdateCheckResult {
    version: string | null;
    error: string | null;
}

interface UpdateInstallResult {
    error: string | null;
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
        managedByPackageManager: false,
    });
    const [update, setUpdate] = useState<Update | null>(null);
    const checkPromise = useRef<Promise<UpdateCheckResult> | null>(null);
    const installPromise = useRef<Promise<UpdateInstallResult> | null>(null);
    const currentVersion = useRef<string | null>(null);
    const checkGeneration = useRef(0);
    const lastCheckAt = useRef(0);
    const { settings, isLoaded } = useSettings();
    const automaticChecks = isLoaded && settings.autoUpdate !== false;

    const checkForUpdates = useCallback((): Promise<UpdateCheckResult> => {
        if (checkPromise.current) return checkPromise.current;
        if (installPromise.current) return Promise.resolve({ version: currentVersion.current, error: null });

        const generation = ++checkGeneration.current;
        lastCheckAt.current = Date.now();
        const superseded = () => generation !== checkGeneration.current;
        const operation = (async (): Promise<UpdateCheckResult> => {
            setState(s => ({ ...s, checking: true, error: null }));
            try {
                const installation = await getInstallationInfo();
                const { check } = await import('@tauri-apps/plugin-updater');
                if (superseded()) return { version: currentVersion.current, error: null };
                const updateInfo = await check();
                if (superseded()) return { version: currentVersion.current, error: null };
                setUpdate(updateInfo);
                currentVersion.current = updateInfo?.version ?? null;
                setState(s => ({
                    ...s,
                    checking: false,
                    available: updateInfo !== null,
                    version: updateInfo?.version ?? null,
                    managedByPackageManager: installation.managedByPackageManager,
                }));
                return { version: updateInfo?.version ?? null, error: null };
            } catch (err: unknown) {
                if (superseded()) return { version: currentVersion.current, error: null };
                const message = err instanceof Error ? err.message : String(err);
                setState(s => ({ ...s, checking: false, error: message }));
                return { version: null, error: message };
            }
        })();
        checkPromise.current = operation;
        void operation.then(() => {
            if (checkPromise.current === operation) checkPromise.current = null;
        });
        return operation;
    }, []);

    const downloadAndInstall = useCallback((): Promise<UpdateInstallResult> => {
        if (installPromise.current) return installPromise.current;
        if (!update) return Promise.resolve({ error: null });

        // An earlier check must not replace or hide the candidate being installed.
        ++checkGeneration.current;
        checkPromise.current = null;
        const operation = (async (): Promise<UpdateInstallResult> => {
            setState(s => ({ ...s, checking: false }));
            if (state.managedByPackageManager) {
                try {
                    await openUrl(RELEASES_URL);
                    return { error: null };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    setState(s => ({ ...s, error: message }));
                    return { error: message };
                }
            }

            setState(s => ({ ...s, downloading: true, progress: 0, phase: 'downloading', error: null }));
            try {
                const { installVerifiedUpdate } = await import('../services/updateInstall');
                await installVerifiedUpdate(
                    update!,
                    (nextProgress) => setState(s => ({ ...s, progress: nextProgress })),
                    (phase) => setState(s => ({ ...s, phase })),
                );
                return { error: null };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                setState(s => ({ ...s, downloading: false, phase: null, error: message }));
                return { error: message };
            }
        })();
        installPromise.current = operation;
        void operation.then(() => { installPromise.current = null; });
        return operation;
    }, [state.managedByPackageManager, update]);

    const dismissUpdate = useCallback(() => {
        if (installPromise.current) return;
        ++checkGeneration.current;
        checkPromise.current = null;
        currentVersion.current = null;
        setState(s => ({ ...s, checking: false, available: false, version: null, phase: null }));
        setUpdate(null);
    }, []);

    // Automatic checks: shortly after launch, then periodically and whenever a
    // long-hidden window is shown again. A manual check from Settings always
    // works, including when automatic checks are turned off.
    useEffect(() => {
        if (!automaticChecks) return;
        const check = () => { checkForUpdates().catch(console.error); };
        const checkWhenStale = () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - lastCheckAt.current >= UPDATE_RECHECK_INTERVAL_MS) check();
        };
        const initial = setTimeout(check, INITIAL_UPDATE_CHECK_DELAY_MS);
        const periodic = setInterval(check, UPDATE_RECHECK_INTERVAL_MS);
        document.addEventListener('visibilitychange', checkWhenStale);
        return () => {
            clearTimeout(initial);
            clearInterval(periodic);
            document.removeEventListener('visibilitychange', checkWhenStale);
        };
    }, [automaticChecks, checkForUpdates]);

    return {
        ...state,
        checkForUpdates,
        downloadAndInstall,
        dismissUpdate,
    };
}
