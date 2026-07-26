import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from '../context/SettingsContext';
import type {
    EncryptionCapabilities,
    EncryptionCapabilityState,
    EncryptionSettings,
    VaultStatus,
    FileEncryptionInfo,
    EncryptionState,
    CryptoInventory,
} from '../types';

interface EncryptionContextType {
    capabilities: EncryptionCapabilities | null;
    settings: EncryptionSettings | null;
    vaultStatus: VaultStatus | null;
    inventory: CryptoInventory | null;
    capabilityState: EncryptionCapabilityState;
    capabilityError: string | null;
    isLoaded: boolean;
    refreshCapabilities: () => Promise<void>;
    refreshVaultStatus: () => Promise<void>;
    refreshInventory: () => Promise<void>;
    unlockVault: (passphrase: string) => Promise<number>;
    lockVault: () => Promise<void>;
    createVault: (passphrase: string) => Promise<void>;
    changeVaultPassphrase: (newPassphrase: string) => Promise<void>;
    getFileEncryptionInfo: (messageId: number, folderId: number | null) => Promise<FileEncryptionInfo>;
    generateRecoveryKey: () => Promise<string>;
    exportRecovery: (recoveryPassphrase: string) => Promise<string>;
    importRecovery: (bundle: string, recoveryPassphrase: string) => Promise<void>;
}

const EncryptionContext = createContext<EncryptionContextType | undefined>(undefined);

export function EncryptionProvider({ children }: { children: ReactNode }) {
    const { settings: appSettings, isLoaded: appSettingsLoaded } = useSettings();
    const [capabilities, setCapabilities] = useState<EncryptionCapabilities | null>(null);
    const [settings, setSettings] = useState<EncryptionSettings | null>(null);
    const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
    const [inventory, setInventory] = useState<CryptoInventory | null>(null);
    const [capabilityState, setCapabilityState] = useState<EncryptionCapabilityState>('loading');
    const [capabilityError, setCapabilityError] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    const refreshCapabilities = useCallback(async () => {
        setCapabilityState('loading');
        setCapabilityError(null);
        try {
            const caps = await invoke<EncryptionCapabilities>('cmd_get_encryption_capabilities');
            if (caps.contract_version !== 2) {
                throw new Error(`Unsupported encryption command contract ${String(caps.contract_version)}`);
            }
            setCapabilities(caps);
            setCapabilityState(
                caps.availability === 'ready'
                    ? 'ready'
                    : caps.availability === 'blocked'
                      ? 'blocked'
                      : caps.availability === 'disabled'
                        ? 'disabled'
                        : 'blocked',
            );
        } catch (error) {
            setCapabilities(null);
            setCapabilityError(String(error));
            setCapabilityState('error');
        }
    }, []);

    const refreshVaultStatus = useCallback(async () => {
        try {
            const status = await invoke<VaultStatus>('cmd_get_vault_status');
            setVaultStatus(status);
        } catch {
            setVaultStatus(null);
        }
    }, []);

    const refreshInventory = useCallback(async () => {
        try {
            setInventory(await invoke<CryptoInventory>('cmd_get_crypto_inventory'));
        } catch {
            setInventory(null);
        }
    }, []);

    useEffect(() => {
        const load = async () => {
            await Promise.all([
                refreshCapabilities(),
                refreshVaultStatus(),
                refreshInventory(),
                invoke<EncryptionSettings>('cmd_get_encryption_settings').then(setSettings).catch(() => {}),
            ]);
            setIsLoaded(true);
        };
        load();
    }, [refreshCapabilities, refreshInventory, refreshVaultStatus]);

    useEffect(() => {
        if (!appSettingsLoaded) return;
        const effectiveSettings: EncryptionSettings = {
            default_mode: appSettings.encryptionDefaultMode,
            protect_metadata: appSettings.encryptionProtectMetadata,
            auto_lock_minutes: appSettings.encryptionAutoLockMinutes,
            lock_on_sleep: appSettings.encryptionLockOnSleep,
            temp_policy: appSettings.encryptionTempPolicy,
            remember_device: false,
        };
        invoke<EncryptionSettings>('cmd_update_encryption_settings', { settings: effectiveSettings })
            .then(setSettings)
            .catch(error => {
                setCapabilityError(previous => previous ?? `Encryption settings were rejected: ${String(error)}`);
            });
    }, [
        appSettings.encryptionAutoLockMinutes,
        appSettings.encryptionDefaultMode,
        appSettings.encryptionLockOnSleep,
        appSettings.encryptionProtectMetadata,
        appSettings.encryptionTempPolicy,
        appSettingsLoaded,
    ]);

    useEffect(() => {
        if (!appSettingsLoaded || !appSettings.encryptionLockOnSleep) return;
        const handleVisibility = () => {
            if (document.visibilityState === 'hidden') {
                void invoke('cmd_lock_vault').catch(() => {});
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    }, [appSettings.encryptionLockOnSleep, appSettingsLoaded]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        listen('vault-locked', () => {
            if (!cancelled) void refreshVaultStatus();
        }).then(dispose => {
            if (cancelled) dispose();
            else unlisten = dispose;
        }).catch(() => {
            // Capability diagnostics surface backend mismatches elsewhere.
        });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [refreshVaultStatus]);

    const unlockVault = useCallback(async (passphrase: string): Promise<number> => {
        const sessionId = await invoke<number>('cmd_unlock_vault', { passphrase });
        await refreshVaultStatus();
        return sessionId;
    }, [refreshVaultStatus]);

    const lockVault = useCallback(async () => {
        await invoke('cmd_lock_vault');
        await refreshVaultStatus();
    }, [refreshVaultStatus]);

    const createVault = useCallback(async (passphrase: string) => {
        await invoke('cmd_create_vault', { passphrase });
        await refreshVaultStatus();
    }, [refreshVaultStatus]);

    const changeVaultPassphrase = useCallback(async (newPassphrase: string) => {
        await invoke('cmd_change_vault_passphrase', { newPassphrase });
        await refreshVaultStatus();
    }, [refreshVaultStatus]);

    const getFileEncryptionInfo = useCallback(async (
        messageId: number,
        folderId: number | null,
    ): Promise<FileEncryptionInfo> => {
        return await invoke<FileEncryptionInfo>('cmd_get_file_encryption_info', {
            messageId,
            folderId,
        });
    }, []);

    const generateRecoveryKey = useCallback(async (): Promise<string> => {
        return await invoke<string>('cmd_generate_recovery_key');
    }, []);

    const exportRecovery = useCallback(async (recoveryPassphrase: string): Promise<string> => {
        return await invoke<string>('cmd_export_vault_recovery', {
            recoveryPassphrase,
        });
    }, []);

    const importRecovery = useCallback(async (
        bundle: string,
        recoveryPassphrase: string,
    ): Promise<void> => {
        await invoke('cmd_import_vault_recovery', {
            bundleBase64: bundle,
            recoveryPassphrase,
            replaceExisting: true,
        });
        await refreshVaultStatus();
    }, [refreshVaultStatus]);

    const contextValue: EncryptionContextType = {
        capabilities,
        settings,
        vaultStatus,
        inventory,
        capabilityState,
        capabilityError,
        isLoaded,
        refreshCapabilities,
        refreshVaultStatus,
        refreshInventory,
        unlockVault,
        lockVault,
        createVault,
        changeVaultPassphrase,
        getFileEncryptionInfo,
        generateRecoveryKey,
        exportRecovery,
        importRecovery,
    };

    return (
        <EncryptionContext.Provider value={contextValue}>
            {children}
        </EncryptionContext.Provider>
    );
}

export function useEncryption() {
    const ctx = useContext(EncryptionContext);
    if (!ctx) {
        throw new Error('useEncryption must be used within an EncryptionProvider');
    }
    return ctx;
}

export function resolveEncryptionState(
    info: FileEncryptionInfo | undefined,
    vaultUnlocked: boolean,
): EncryptionState {
    if (!info || info.state === 'plain') return 'plain';
    if (info.state === 'encrypted_verifying') return 'encrypted_verifying';
    if (info.state === 'encrypted_corrupt') return 'encrypted_corrupt';
    if (info.state === 'encrypted_unsupported_version') return 'encrypted_unsupported_version';
    if (info.state === 'encrypted_key_missing') return 'encrypted_key_missing';

    if (vaultUnlocked) return 'encrypted_unlocked';
    return 'encrypted_locked';
}
