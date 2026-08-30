import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SETTINGS } from '../config/defaultSettings';
import {
    markProxySecretMigrated,
    readPersistedSettings,
    writePersistedSettings,
} from '../services/settingsPersistence';
import type { Settings } from '../types/settings';

export type { Settings } from '../types/settings';

interface SettingsContextType {
    settings: Settings;
    updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    updateSettings: (updates: Partial<Settings>) => void;
    resetSettings: () => void;
    isLoaded: boolean;
    persistenceStatus: 'loading' | 'saved' | 'saving' | 'error';
    retryPersistence: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [isLoaded, setIsLoaded] = useState(false);
    const [persistenceStatus, setPersistenceStatus] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
    const latestSettingsRef = useRef<Settings>(DEFAULT_SETTINGS);
    const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
    const persistenceRevisionRef = useRef(0);

    useEffect(() => {
        const loadSettings = async () => {
            let loadFailed = false;
            const loaded = await readPersistedSettings(DEFAULT_SETTINGS, undefined, () => {
                loadFailed = true;
            });
            if (loaded.proxyPassword) {
                try {
                    await invoke('cmd_migrate_proxy_secret', { password: loaded.proxyPassword });
                    markProxySecretMigrated();
                    loaded.proxyPassword = '';
                    await writePersistedSettings(loaded);
                } catch (error) {
                    // Keep the legacy value intact until secure storage becomes
                    // available. Never include the credential in diagnostic logs.
                    console.error('[Settings] Secure proxy credential migration is pending.');
                    loadFailed = true;
                }
            }
            setSettings(loaded);
            latestSettingsRef.current = loaded;
            setIsLoaded(true);
            setPersistenceStatus(loadFailed ? 'error' : 'saved');
        };
        void loadSettings();
    }, []);

    const persistSettings = useCallback((next: Settings): Promise<void> => {
        latestSettingsRef.current = next;
        const revision = ++persistenceRevisionRef.current;
        setPersistenceStatus('saving');
        const operation = persistenceQueueRef.current.then(() => writePersistedSettings(next));
        persistenceQueueRef.current = operation.catch(() => undefined);
        return operation.then(
            () => {
                if (revision === persistenceRevisionRef.current) setPersistenceStatus('saved');
            },
            () => {
                if (revision === persistenceRevisionRef.current) setPersistenceStatus('error');
                throw new Error('Settings persistence failed');
            },
        );
    }, []);

    const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings(prev => {
            const next = { ...prev, [key]: value };
            void persistSettings(next).catch(() => undefined);
            return next;
        });
    }, [persistSettings]);

    const updateSettings = useCallback((updates: Partial<Settings>) => {
        setSettings(prev => {
            const next = { ...prev, ...updates };
            void persistSettings(next).catch(() => undefined);
            return next;
        });
    }, [persistSettings]);

    const resetSettings = useCallback(() => {
        setSettings(DEFAULT_SETTINGS);
        latestSettingsRef.current = DEFAULT_SETTINGS;
        void persistSettings(DEFAULT_SETTINGS).catch(() => undefined);
        void invoke('cmd_clear_proxy_secret').catch(() => {
            console.error('[Settings] Unable to remove the saved proxy credential.');
        });
    }, [persistSettings]);

    const retryPersistence = useCallback(
        () => persistSettings(latestSettingsRef.current),
        [persistSettings],
    );

    return (
        <SettingsContext.Provider value={{ settings, updateSetting, updateSettings, resetSettings, isLoaded, persistenceStatus, retryPersistence }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) throw new Error('useSettings must be used within a SettingsProvider');
    return context;
};
