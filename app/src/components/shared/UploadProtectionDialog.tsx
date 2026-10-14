import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, UploadCloud } from 'lucide-react';
import { useEncryption } from '../../hooks/useEncryption';
import { useSettings } from '../../context/SettingsContext';
import type { UploadChoice } from '../../context/UploadChoiceContext';
import { EncryptionSettingsSection } from './EncryptionSettingsSection';
import i18n from '../../i18n';

export default function UploadProtectionDialog({ count, onFinish }: { count: number; onFinish: (choice: UploadChoice | null) => void }) {
    const encryption = useEncryption();
    const { settings } = useSettings();
    const [vaultStep, setVaultStep] = useState(false);
    const activeRef = useRef(true);
    useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
    const uploadReady = encryption.capabilityState === 'ready' && encryption.capabilities?.upload_enabled === true;
    const requiresVault = settings.encryptionDefaultMode !== 'passphrase';
    const chooseProtect = async () => {
        if (!requiresVault) {
            if (uploadReady) onFinish('protect');
            return;
        }
        if (uploadReady && encryption.vaultStatus?.is_unlocked) {
            onFinish('protect');
            return;
        }
        await encryption.refreshVaultStatus();
        if (activeRef.current) setVaultStep(true);
    };
    return (
<>
                        {vaultStep ? <>
                            <h2 id="upload-choice-title" className="text-lg font-semibold text-app-text">{i18n.t(encryption.vaultStatus?.exists ? 'settings.unlock_vault' : 'settings.create_vault')}</h2>
                            <p className="mt-1 mb-5 text-sm text-app-text-secondary">{i18n.t("settings.vault_is_locked")} {i18n.t("settings.encryption_disclaimer_body")}</p>
                            <EncryptionSettingsSection vaultOnly />
                            <div className="sticky bottom-0 mt-5 flex flex-wrap justify-end gap-2 border-t border-app-border-subtle bg-app-surface pt-4">
                                <button disabled={!encryption.vaultStatus?.is_unlocked || encryption.capabilityState !== 'ready' || encryption.capabilities?.upload_enabled !== true} onClick={() => void chooseProtect()} className="min-h-11 rounded-lg bg-app-accent px-4 text-sm font-semibold text-app-accent-contrast disabled:opacity-40">{i18n.t("auth.continue")}</button>
                            </div>
                        </> : <>
                        <h2 id="upload-choice-title" className="text-lg font-semibold text-app-text">{i18n.t('upload_choice_copy.question', { count })}</h2>
                        <p className="mt-1 text-sm text-app-text-secondary">{i18n.t('upload_choice_copy.description')}</p>
                        {!requiresVault && !uploadReady && <div className="mt-4 rounded-lg border border-app-border-subtle bg-app-surface-sunken p-3 text-sm text-app-text-secondary" role={encryption.capabilityState === 'loading' ? 'status' : 'alert'}>
                            <p>{i18n.t(encryption.capabilityState === 'loading' ? 'settings.encryption_checking' : encryption.capabilityState === 'blocked' ? 'settings.encryption_safety_pause_title' : encryption.capabilityState === 'disabled' ? 'settings.encryption_disabled' : 'settings.encryption_backend_error')}</p>
                            {encryption.capabilityState !== 'loading' && <button type="button" onClick={() => void encryption.refreshCapabilities()} className="quiet-control mt-2 min-h-11 px-3 text-app-accent">{i18n.t('settings.retry_encryption_check')}</button>}
                        </div>}
                        <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <button onClick={() => onFinish('store')} className="quiet-surface p-4 text-start hover:border-app-accent/40 hover:bg-app-hover">
                                <UploadCloud className="mb-3 h-5 w-5 text-app-accent" />
                                <span className="block text-sm font-semibold text-app-text">{i18n.t('upload_choice_copy.store')}</span>
                                <span className="mt-1 block text-xs leading-5 text-app-text-secondary">{i18n.t('upload_choice_copy.plain_description')}</span>
                            </button>
                            <button onClick={() => void chooseProtect()} className="quiet-surface p-4 text-start hover:border-app-accent/40 hover:bg-app-hover">
                                <LockKeyhole className="mb-3 h-5 w-5 text-app-success" />
                                <span className="block text-sm font-semibold text-app-text">{i18n.t('upload_choice_copy.protect')}</span>
                                <span className="mt-1 block text-xs leading-5 text-app-text-secondary">{i18n.t('upload_choice_copy.protect_description')}</span>
                            </button>
                        </div>
                        </>}
</>
    );
}
