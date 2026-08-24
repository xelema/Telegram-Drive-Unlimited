import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
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
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        const loadSettings = async () => {
            const loaded = await readPersistedSettings(DEFAULT_SETTINGS);
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
                }
            }
            setSettings(loaded);
            setIsLoaded(true);
        };
        void loadSettings();
    }, []);

    const persistSettings = useCallback((next: Settings) => writePersistedSettings(next), []);

    const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings(prev => {
            const next = { ...prev, [key]: value };
            persistSettings(next);
            return next;
        });
    }, [persistSettings]);

    const updateSettings = useCallback((updates: Partial<Settings>) => {
        setSettings(prev => {
            const next = { ...prev, ...updates };
            persistSettings(next);
            return next;
        });
    }, [persistSettings]);

    const resetSettings = useCallback(() => {
        setSettings(DEFAULT_SETTINGS);
        void persistSettings(DEFAULT_SETTINGS);
        void invoke('cmd_clear_proxy_secret').catch(() => {
            console.error('[Settings] Unable to remove the saved proxy credential.');
        });
    }, [persistSettings]);

    return (
        <SettingsContext.Provider value={{ settings, updateSetting, updateSettings, resetSettings, isLoaded }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) throw new Error('useSettings must be used within a SettingsProvider');
    return context;
};
