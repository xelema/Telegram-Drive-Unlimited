import i18n from '../../i18n';
import { useState } from 'react';
import { Shield, Lock, Key, Clock, Download, Upload, Eye, EyeOff, FileDown, FileUp, ChevronDown, AlertTriangle, RefreshCw, Copy, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../context/SettingsContext';
import { useEncryption } from '../../hooks/useEncryption';
import { EncryptionTransparencyDialog } from './EncryptionTransparencyDialog';
import { requireAndroidReauthentication } from '../../services/androidReauthentication';
import { useConfirm } from '../../context/ConfirmContext';

function RecoveryDrillPanel({ encryption, onComplete }: { encryption: ReturnType<typeof useEncryption>; onComplete: () => void }) {
    const { t } = useTranslation();
    const [stage, setStage] = useState<'export' | 'verify'>('export');
    const [recoveryPassphrase, setRecoveryPassphrase] = useState('');
    const [bundle, setBundle] = useState('');
    const [saved, setSaved] = useState(false);
    const [verifyBundle, setVerifyBundle] = useState('');
    const [verifyPassphrase, setVerifyPassphrase] = useState('');
    const [busy, setBusy] = useState(false);

    const createBundle = async () => {
        if (recoveryPassphrase.length < 8) return;
        setBusy(true);
        try {
            await requireAndroidReauthentication(t('protection_labels.auth_export'));
            setBundle(await encryption.exportRecovery(recoveryPassphrase));
        } catch (error) {
            toast.error(t('recovery_copy.export_failed', { error: String(error) }));
        } finally {
            setBusy(false);
        }
    };

    const verifyRecovery = async () => {
        if (!verifyBundle.trim() || !verifyPassphrase) return;
        setBusy(true);
        try {
            await requireAndroidReauthentication(t('protection_labels.auth_check'));
            // Verification only: the vault file, its passphrase and its keys
            // are left exactly as they are.
            const result = await encryption.verifyRecovery(verifyBundle.trim(), verifyPassphrase);
            if (!result.complete) {
                toast.error(t('recovery_copy.bundle_mismatch'));
                return;
            }
            onComplete();
            toast.success(t('recovery_copy.drill_passed'));
        } catch (error) {
            toast.error(t('recovery_copy.test_failed', { error: String(error) }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="rounded-lg border border-app-warning/25 bg-app-warning/5 p-4" aria-labelledby="recovery-drill-title">
            <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-app-warning" /><div><h4 id="recovery-drill-title" className="text-sm font-semibold text-app-text">{t('recovery_copy.drill_required')}</h4><p className="mt-1 text-xs leading-5 text-app-text-secondary">{t('recovery_copy.drill_description')}</p></div></div>
            {stage === 'export' ? (
                <div className="mt-4 space-y-3">
                    <input type="password" value={recoveryPassphrase} onChange={event => setRecoveryPassphrase(event.target.value)} placeholder={t('recovery_copy.new_passphrase')} aria-label={t('recovery_copy.passphrase_label')} className="quiet-control w-full border border-app-border bg-app-surface-sunken px-3 py-2 text-sm text-app-text" />
                    {!bundle ? (
                        <button type="button" onClick={createBundle} disabled={busy || recoveryPassphrase.length < 8} className="quiet-control w-full bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast disabled:opacity-50">{busy ? t('recovery_copy.creating') : t('recovery_copy.create_bundle')}</button>
                    ) : (
                        <>
                            <textarea readOnly value={bundle} rows={4} aria-label={t('recovery_copy.generated_bundle')} className="w-full resize-none rounded-lg border border-app-border bg-app-surface-sunken p-3 font-mono text-xs text-app-text" />
                            <button type="button" onClick={() => void navigator.clipboard.writeText(bundle)} className="quiet-control flex w-full items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-app-text"><Copy className="h-3.5 w-3.5" />{t('settings.copy_bundle')}</button>
                            <label className="flex items-start gap-2 text-xs leading-5 text-app-text-secondary"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} className="mt-1" />{t('recovery_copy.saved_label')}</label>
                            <button type="button" disabled={!saved} onClick={() => { setStage('verify'); setVerifyBundle(''); setVerifyPassphrase(''); }} className="quiet-control w-full bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast disabled:opacity-50">{t('recovery_copy.continue_restore')}</button>
                        </>
                    )}
                </div>
            ) : (
                <div className="mt-4 space-y-3">
                    <p className="text-xs leading-5 text-app-text-secondary">{t('recovery_copy.verify_description')}</p>
                    <textarea value={verifyBundle} onChange={event => setVerifyBundle(event.target.value)} rows={4} placeholder={t('recovery_copy.paste_bundle')} aria-label={t('recovery_copy.verify_bundle_label')} className="w-full resize-none rounded-lg border border-app-border bg-app-surface-sunken p-3 font-mono text-xs text-app-text" />
                    <input type="password" value={verifyPassphrase} onChange={event => setVerifyPassphrase(event.target.value)} placeholder={t('recovery_copy.passphrase_placeholder')} aria-label={t('recovery_copy.verification_passphrase')} className="quiet-control w-full border border-app-border bg-app-surface-sunken px-3 py-2 text-sm text-app-text" />
                    <button type="button" onClick={verifyRecovery} disabled={busy || !verifyBundle.trim() || !verifyPassphrase} className="quiet-control w-full bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast disabled:opacity-50">{busy ? t('recovery_copy.testing') : t('recovery_copy.verify_finish')}</button>
                </div>
            )}
        </section>
    );
}

function ExportRecoverySection({ encryption }: { encryption: ReturnType<typeof useEncryption> }) {
    const { t } = useTranslation();
    const [showExport, setShowExport] = useState(false);
    const [exportPassphrase, setExportPassphrase] = useState('');
    const [exportedBundle, setExportedBundle] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);

    const handleExport = async () => {
        if (!exportPassphrase) return;
        setExporting(true);
        try {
            await requireAndroidReauthentication(t('protection_labels.auth_export'));
            const bundle = await encryption.exportRecovery(exportPassphrase);
            setExportedBundle(bundle);
            toast.success(t('settings.export_success'));
        } catch (e) {
            toast.error(t('settings.export_failed', { error: String(e) }));
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="space-y-2">
            <button
                onClick={() => setShowExport(!showExport)}
                className="w-full py-2 rounded-lg text-sm font-medium bg-telegram-bg text-telegram-text hover:bg-telegram-hover/50 transition border border-telegram-border/30"
            >
                <FileUp className="w-4 h-4 inline mr-1.5" />
                {t('settings.export_recovery_bundle')}
            </button>
            {showExport && (
                <div className="p-3 bg-telegram-bg rounded-lg space-y-2 border border-telegram-border/30">
                    <p className="text-xs text-telegram-subtext">
                        {t('settings.export_recovery_desc')}
                    </p>
                    <input
                        type="password"
                        placeholder={t('settings.recovery_passphrase')}
                        value={exportPassphrase}
                        onChange={e => setExportPassphrase(e.target.value)}
                        className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition"
                    />
                    <button
                        onClick={handleExport}
                        disabled={exporting || !exportPassphrase}
                        className="w-full py-1.5 rounded-md text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50"
                    >
                        {exporting ? t('settings.exporting') : t('settings.export')}
                    </button>
                    {exportedBundle && (
                        <div className="p-3 bg-amber-500/5 border border-amber-500/10 rounded-lg space-y-2">
                            <p className="text-[10px] text-amber-400/80 uppercase tracking-wider font-semibold">
                                {t('settings.bundle_exported')}
                            </p>
                            <p className="text-[10px] text-red-400/70">
                                {t('settings.bundle_warning')}
                            </p>
                            <button
                                onClick={async () => {
                                    try {
                                        await navigator.clipboard.writeText(exportedBundle);
                                        toast.success(t('settings.bundle_copied'));
                                    } catch {
                                        toast.error(t('settings.copy_failed'));
                                    }
                                }}
                                className="w-full py-1.5 rounded-md text-xs font-medium bg-telegram-hover/50 text-telegram-text hover:bg-telegram-selected transition"
                            >
                                {t('settings.copy_bundle')}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function ImportRecoverySection({ encryption, vaultUnlocked }: { encryption: ReturnType<typeof useEncryption>; vaultUnlocked: boolean }) {
    const { t } = useTranslation();
    const { confirm } = useConfirm();
    const [showImport, setShowImport] = useState(false);
    const [importBundle, setImportBundle] = useState('');
    const [importPassphrase, setImportPassphrase] = useState('');
    const [vaultPassphrase, setVaultPassphrase] = useState('');
    const [confirmVaultPassphrase, setConfirmVaultPassphrase] = useState('');
    const [importing, setImporting] = useState(false);
    // An unlocked vault keeps its passphrase. Otherwise the restored vault
    // needs one chosen here; the bundle passphrase is never reused silently.
    const needsVaultPassphrase = !vaultUnlocked;

    const handleImport = async () => {
        if (!importBundle || !importPassphrase) return;
        if (needsVaultPassphrase) {
            if (new TextEncoder().encode(vaultPassphrase).length < 8) {
                toast.error(t('settings.min_passphrase_length'));
                return;
            }
            if (vaultPassphrase !== confirmVaultPassphrase) {
                toast.error(t('settings.passphrases_no_match'));
                return;
            }
        }
        const accepted = await confirm({
            title: t('settings.import_recovery_bundle'),
            message: t('settings.import_recovery_confirmation'),
            confirmText: t('settings.import'),
            variant: 'danger',
        });
        if (!accepted) return;
        setImporting(true);
        try {
            await requireAndroidReauthentication(t('protection_labels.auth_import'));
            const options = { vaultPassphrase: needsVaultPassphrase ? vaultPassphrase : undefined };
            try {
                await encryption.importRecovery(importBundle.trim(), importPassphrase, options);
            } catch (error) {
                const message = String(error);
                if (!message.includes('RECOVERY_BUNDLE_MISMATCH')) throw error;
                // The bundle lacks keys this vault uses. Replacing them is a
                // separate, explicit decision; the old vault file is archived.
                const replace = await confirm({
                    title: t('settings.import_recovery_bundle'),
                    message: message.replace(/^.*\[RECOVERY_BUNDLE_MISMATCH\]\s*/, ''),
                    confirmText: t('settings.import'),
                    variant: 'danger',
                });
                if (!replace) return;
                await encryption.importRecovery(importBundle.trim(), importPassphrase, { ...options, allowKeyReplacement: true });
            }
            toast.success(t('settings.import_success'));
            setShowImport(false);
            setImportBundle('');
            setImportPassphrase('');
            setVaultPassphrase('');
            setConfirmVaultPassphrase('');
        } catch (e) {
            toast.error(t('settings.import_failed', { error: String(e) }));
        } finally {
            setImporting(false);
        }
    };

    const field = "w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-xs text-telegram-text focus:outline-none";
    return (
        <div className="space-y-2">
            <button
                onClick={() => setShowImport(!showImport)}
                className="w-full py-2 rounded-lg text-sm font-medium bg-telegram-bg text-telegram-text hover:bg-telegram-hover/50 transition border border-telegram-border/30"
            >
                <FileDown className="w-4 h-4 inline mr-1.5" />
                {t('settings.import_recovery_bundle')}
            </button>
            {showImport && (
                <div className="p-3 bg-telegram-bg rounded-lg space-y-2 border border-telegram-border/30">
                    <p className="text-xs text-telegram-subtext">
                        {t('settings.import_recovery_desc')}
                    </p>
                    <textarea
                        placeholder={t('settings.paste_bundle')}
                        aria-label={t('settings.paste_bundle')}
                        value={importBundle}
                        onChange={e => setImportBundle(e.target.value)}
                        rows={3}
                        className={`${field} font-mono resize-none`}
                    />
                    <input
                        type="password"
                        placeholder={t('settings.recovery_passphrase')}
                        aria-label={t('settings.recovery_passphrase')}
                        value={importPassphrase}
                        onChange={e => setImportPassphrase(e.target.value)}
                        className={field}
                    />
                    {needsVaultPassphrase && (
                        <>
                            <input
                                type="password"
                                placeholder={t('settings.new_vault_passphrase')}
                                aria-label={t('settings.new_vault_passphrase')}
                                value={vaultPassphrase}
                                onChange={e => setVaultPassphrase(e.target.value)}
                                className={field}
                            />
                            <input
                                type="password"
                                placeholder={t('settings.confirm_passphrase')}
                                aria-label={t('settings.confirm_passphrase')}
                                value={confirmVaultPassphrase}
                                onChange={e => setConfirmVaultPassphrase(e.target.value)}
                                className={field}
                            />
                        </>
                    )}
                    <button
                        onClick={() => void handleImport()}
                        disabled={importing || !importBundle || !importPassphrase || (needsVaultPassphrase && !vaultPassphrase)}
                        className="w-full py-1.5 rounded-md text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50"
                    >
                        {importing ? t('settings.importing') : t('settings.import')}
                    </button>
                </div>
            )}
        </div>
    );
}

export function EncryptionSettingsSection() {
    const { t } = useTranslation();
    const { settings, updateSetting, updateSettings } = useSettings();
    const encryption = useEncryption();
    const [passphrase, setPassphrase] = useState('');
    const [confirmPassphrase, setConfirmPassphrase] = useState('');
    const [showPassphrase, setShowPassphrase] = useState(false);
    const [creatingVault, setCreatingVault] = useState(false);
    const [unlocking, setUnlocking] = useState(false);
    const [keyLossAcknowledged, setKeyLossAcknowledged] = useState(false);
    const [currentVaultPassphrase, setCurrentVaultPassphrase] = useState('');
    const [newVaultPassphrase, setNewVaultPassphrase] = useState('');
    const [confirmNewVaultPassphrase, setConfirmNewVaultPassphrase] = useState('');
    const [changingVaultPassphrase, setChangingVaultPassphrase] = useState(false);
    const [showTransparency, setShowTransparency] = useState(false);

    const vaultExists = encryption.vaultStatus?.exists ?? false;
    const vaultUnlocked = encryption.vaultStatus?.is_unlocked ?? false;
    const caps = encryption.capabilities;
    const cryptoReady = encryption.capabilityState === 'ready' && caps?.core_available === true;
    const recoveryAvailable = cryptoReady && caps?.features.recovery === true;
    // A drill counts only for the vault it was run against. Drills recorded
    // before the vault identity existed stay valid.
    const vaultId = encryption.vaultStatus?.vault_id ?? '';
    const drillCompleted = settings.vaultRecoveryDrillCompleted
        && (!settings.vaultRecoveryDrillVaultId || !vaultId || settings.vaultRecoveryDrillVaultId === vaultId);

    const handleCreateVault = async () => {
        if (passphrase.length < 8) {
            toast.error(t('settings.min_passphrase_length'));
            return;
        }
        if (passphrase !== confirmPassphrase) {
            toast.error(t('settings.passphrases_no_match'));
            return;
        }
        if (!keyLossAcknowledged) {
            toast.error(t('settings.encryption_ack_required'));
            return;
        }
        setCreatingVault(true);
        try {
            await encryption.createVault(passphrase);
            updateSettings({ vaultRecoveryDrillCompleted: false, vaultRecoveryDrillVaultId: '', encryptionDefaultMode: 'standard' });
            toast.success(t('recovery_copy.vault_created'));
            setPassphrase('');
            setConfirmPassphrase('');
            setKeyLossAcknowledged(false);
        } catch (e) {
            toast.error(t('settings.vault_create_failed', { error: String(e) }));
        } finally {
            setCreatingVault(false);
        }
    };

    const handleUnlock = async () => {
        if (!passphrase) return;
        setUnlocking(true);
        try {
            await encryption.unlockVault(passphrase);
            toast.success(t('settings.vault_unlocked_toast'));
            setPassphrase('');
        } catch {
            toast.error(t('settings.wrong_passphrase'));
        } finally {
            setUnlocking(false);
        }
    };

    const handleLock = async () => {
        await encryption.lockVault();
        toast.success(t('settings.vault_locked_toast'));
    };

    const handleChangeVaultPassphrase = async () => {
        if (newVaultPassphrase.length < 8) {
            toast.error(t('settings.min_passphrase_length'));
            return;
        }
        if (newVaultPassphrase !== confirmNewVaultPassphrase) {
            toast.error(t('settings.passphrases_no_match'));
            return;
        }
        setChangingVaultPassphrase(true);
        try {
            await requireAndroidReauthentication(t('protection_labels.auth_change'));
            await encryption.changeVaultPassphrase(currentVaultPassphrase, newVaultPassphrase);
            setCurrentVaultPassphrase('');
            setNewVaultPassphrase('');
            setConfirmNewVaultPassphrase('');
            toast.success(t('settings.vault_passphrase_changed'));
        } catch (error) {
            toast.error(t('settings.vault_passphrase_change_failed', { error: String(error) }));
        } finally {
            setChangingVaultPassphrase(false);
        }
    };

    return (
        <div className="space-y-4 w-full">
            <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                <Shield className="w-3.5 h-3.5" />
                {t('settings.encryption_privacy')}
                {vaultUnlocked && (
                    <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">
                        {t('settings.vault_unlocked')}
                    </span>
                )}
                {vaultExists && !vaultUnlocked && (
                    <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                        {t('settings.vault_locked')}
                    </span>
                )}
            </h3>

            <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 space-y-1.5" role="note">
                <p className="text-xs font-semibold text-amber-500 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    {t('settings.encryption_disclaimer_title')}
                </p>
                <p className="text-xs leading-relaxed text-telegram-subtext">
                    {t('settings.encryption_disclaimer_body')}
                </p>
            </div>

            <section className="grid gap-2 sm:grid-cols-3" aria-label={i18n.t('ui_copy.security_center')}>
                <div className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/25 p-3"><span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-tertiary">{i18n.t('ui_copy.vault')}</span><p className={`mt-1 text-xs font-medium ${vaultUnlocked ? 'text-app-success' : vaultExists ? 'text-app-warning' : 'text-app-text-secondary'}`}>{vaultUnlocked ? i18n.t('ui_copy.unlocked_session') : vaultExists ? i18n.t('settings.vault_locked') : i18n.t('ui_copy.not_configured')}</p></div>
                <div className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/25 p-3"><span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-tertiary">{i18n.t('ui_copy.recovery')}</span><p className={`mt-1 text-xs font-medium ${drillCompleted ? 'text-app-success' : 'text-app-warning'}`}>{drillCompleted ? i18n.t('ui_copy.recovery_verified') : i18n.t('ui_copy.action_required')}</p></div>
                <button type="button" onClick={() => setShowTransparency(true)} className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/25 p-3 text-start hover:border-app-accent/30"><span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-tertiary">{i18n.t("workspace.protection")}</span><p className="mt-1 flex items-center gap-1 text-xs font-medium text-app-accent">{i18n.t('ui_copy.how_it_works')} <HelpCircle className="h-3.5 w-3.5" /></p></button>
            </section>

            {encryption.capabilityState === 'loading' && (
                <div className="p-3 rounded-lg bg-telegram-hover/50" role="status">
                    <p className="text-xs text-telegram-subtext text-center">
                        {t('settings.encryption_checking')}
                    </p>
                </div>
            )}

            {encryption.capabilityState === 'error' && (
                <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5 space-y-2" role="alert">
                    <p className="text-xs font-medium text-red-400">
                        {t('settings.encryption_backend_error')}
                    </p>
                    <p className="text-xs leading-relaxed text-telegram-subtext">{t('recovery_copy.safety_disabled')}</p>
                    <button
                        type="button"
                        onClick={() => void encryption.refreshCapabilities()}
                        className="inline-flex items-center gap-1.5 rounded-md border border-telegram-border px-2.5 py-1.5 text-xs text-telegram-text hover:bg-telegram-hover/50 transition"
                    >
                        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('settings.retry_encryption_check')}
                    </button>
                </div>
            )}

            {encryption.capabilityState === 'blocked' && caps && (
                <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 space-y-2" role="status">
                    <p className="text-xs font-medium text-telegram-text">
                        {t('settings.encryption_safety_pause_title')}
                    </p>
                    <p className="text-xs leading-relaxed text-telegram-subtext">
                        {t('settings.encryption_safety_pause_body')}
                    </p>
                    {encryption.inventory && encryption.inventory.total_files > 0 && (
                        <p className="text-xs text-amber-500">
                            {t('settings.encryption_experimental_inventory', { count: encryption.inventory.total_files })}
                        </p>
                    )}
                    <p className="text-[10px] text-telegram-subtext">{t('recovery_copy.safety_paused')}</p>
                </div>
            )}

            {encryption.capabilityState === 'disabled' && (
                <div className="p-3 rounded-lg bg-telegram-hover/50">
                    <p className="text-xs text-telegram-subtext text-center">
                        {t('settings.encryption_disabled')}
                    </p>
                </div>
            )}

            {/* Default Upload Protection */}
            {cryptoReady && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                    <div className="flex items-center gap-2">
                        <Upload className="w-4 h-4 text-telegram-subtext" />
                        <div>
                            <p className="text-sm text-telegram-text font-medium">{t('settings.default_upload_protection')}</p>
                            <p className="text-xs text-telegram-subtext">{t('settings.default_upload_protection_desc')}</p>
                        </div>
                    </div>
                    <div className="relative">
                        <select
                            aria-label={t('settings.default_upload_protection')}
                            value={settings.encryptionDefaultMode}
                            onChange={e => updateSetting('encryptionDefaultMode', e.target.value as 'standard' | 'vault' | 'passphrase' | 'vault_and_passphrase')}
                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                        >
                            <option value="standard">{t('settings.encryption_mode_standard')}</option>
                            <option value="vault">{t('settings.encryption_mode_vault')}</option>
                            <option value="passphrase">{t('settings.encryption_mode_passphrase')}</option>
                            <option value="vault_and_passphrase">{t('settings.encryption_mode_vault_and_passphrase')}</option>
                        </select>
                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                </div>
            )}

            {/* Protect Metadata */}
            {cryptoReady && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                    <div className="flex items-center gap-2">
                        <EyeOff className="w-4 h-4 text-telegram-subtext" />
                        <div>
                            <p className="text-sm text-telegram-text font-medium">{t('settings.protect_metadata')}</p>
                            <p className="text-xs text-telegram-subtext">{t('settings.protect_metadata_desc')}</p>
                        </div>
                    </div>
                    <button
                        type="button" role="switch" aria-checked={settings.encryptionProtectMetadata} aria-label={t('settings.protect_metadata')}
                        onClick={() => updateSetting('encryptionProtectMetadata', !settings.encryptionProtectMetadata)}
                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                            settings.encryptionProtectMetadata ? 'bg-telegram-primary' : 'bg-telegram-border'
                        }`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            settings.encryptionProtectMetadata ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                    </button>
                </div>
            )}

            {/* Auto-lock */}
            {cryptoReady && vaultExists && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                    <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-telegram-subtext" />
                        <div>
                            <p className="text-sm text-telegram-text font-medium">{t('settings.auto_lock_vault')}</p>
                            <p className="text-xs text-telegram-subtext">{t('settings.auto_lock_vault_desc')}</p>
                        </div>
                    </div>
                    <div className="relative">
                        <select
                            aria-label={t('settings.auto_lock_vault')}
                            value={settings.encryptionAutoLockMinutes}
                            onChange={e => updateSetting('encryptionAutoLockMinutes', parseInt(e.target.value))}
                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                        >
                            <option value={0}>{t('settings.never')}</option>
                            {[1, 5, 15, 30, 60].map(minutes => <option key={minutes} value={minutes}>{new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(minutes)}</option>)}
                        </select>
                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                </div>
            )}

            {/* Lock on Sleep */}
            {cryptoReady && vaultExists && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                    <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-telegram-subtext" />
                        <div>
                            <p className="text-sm text-telegram-text font-medium">{t('settings.lock_on_sleep')}</p>
                            <p className="text-xs text-telegram-subtext">{t('settings.lock_on_sleep_desc')}</p>
                        </div>
                    </div>
                    <button
                        type="button" role="switch" aria-checked={settings.encryptionLockOnSleep} aria-label={t('settings.lock_on_sleep')}
                        onClick={() => updateSetting('encryptionLockOnSleep', !settings.encryptionLockOnSleep)}
                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                            settings.encryptionLockOnSleep ? 'bg-telegram-primary' : 'bg-telegram-border'
                        }`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            settings.encryptionLockOnSleep ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                    </button>
                </div>
            )}

            {/* Temp Policy */}
            {cryptoReady && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                    <div className="flex items-center gap-2">
                        <Download className="w-4 h-4 text-telegram-subtext" />
                        <div>
                            <p className="text-sm text-telegram-text font-medium">{t('settings.temp_plaintext_policy')}</p>
                            <p className="text-xs text-telegram-subtext">{t('settings.temp_plaintext_policy_desc')}</p>
                        </div>
                    </div>
                    <div className="relative">
                        <select
                            aria-label={t('settings.temp_plaintext_policy')}
                            value={settings.encryptionTempPolicy}
                            onChange={e => updateSetting('encryptionTempPolicy', e.target.value as 'balanced' | 'strict')}
                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                        >
                            <option value="balanced">{t('settings.policy_balanced')}</option>
                            <option value="strict">{t('settings.policy_strict')}</option>
                        </select>
                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                </div>
            )}

            {/* Vault Management */}
            {cryptoReady && (
                <div className="p-4 rounded-lg bg-telegram-hover/50 space-y-3 border border-telegram-border/30">
                    <h4 className="text-sm font-semibold text-telegram-text flex items-center gap-2">
                        <Key className="w-4 h-4 text-telegram-primary" />
                        {t('settings.vault_management')}
                    </h4>

                    {!vaultExists ? (
                        /* Create Vault */
                        <div className="space-y-3">
                            <p className="text-xs text-telegram-subtext">
                                {t('settings.vault_create_prompt')}
                            </p>
                            <div className="relative">
                                <input
                                    type={showPassphrase ? 'text' : 'password'}
                                    placeholder={t('settings.vault_passphrase_placeholder')}
                                    value={passphrase}
                                    onChange={e => setPassphrase(e.target.value)}
                                    className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-2 pr-9 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/50"
                                />
                                <button
                                    type="button" aria-label={t(showPassphrase ? 'settings.hide_passphrase' : 'settings.show_passphrase')} aria-pressed={showPassphrase}
                                    onClick={() => setShowPassphrase(!showPassphrase)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-telegram-subtext hover:text-telegram-text transition"
                                >
                                    {showPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <input
                                type={showPassphrase ? 'text' : 'password'}
                                placeholder={t('settings.confirm_passphrase')}
                                value={confirmPassphrase}
                                onChange={e => setConfirmPassphrase(e.target.value)}
                                className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-2 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/50"
                            />
                            <label className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={keyLossAcknowledged}
                                    onChange={event => setKeyLossAcknowledged(event.target.checked)}
                                    className="mt-0.5 h-3.5 w-3.5 accent-current"
                                />
                                <span className="text-[11px] leading-relaxed text-telegram-subtext">
                                    {t('settings.encryption_disclaimer_acknowledgement')}
                                </span>
                            </label>
                            <button
                                onClick={handleCreateVault}
                                disabled={creatingVault || passphrase.length < 8 || !keyLossAcknowledged}
                                className="w-full py-2 rounded-lg text-sm font-medium bg-telegram-primary text-app-accent-contrast hover:bg-telegram-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {creatingVault ? t('settings.creating_vault') : t('settings.create_vault')}
                            </button>

                        </div>
                    ) : vaultUnlocked ? (
                        /* Unlocked Vault */
                        <div className="space-y-3">
                            <p className="text-xs text-emerald-400">
                                {t('settings.vault_is_unlocked')}
                            </p>
                            <button
                                onClick={handleLock}
                                className="w-full py-2 rounded-lg text-sm font-medium bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition border border-amber-500/20"
                            >
                                <Lock className="w-4 h-4 inline mr-1.5" />
                                {t('settings.lock_vault_now')}
                            </button>
                            {recoveryAvailable && !drillCompleted && (
                                <RecoveryDrillPanel encryption={encryption} onComplete={() => updateSettings({ vaultRecoveryDrillCompleted: true, vaultRecoveryDrillVaultId: vaultId })} />
                            )}
                            <details className="rounded-lg border border-telegram-border/30 bg-telegram-bg p-3">
                                <summary className="cursor-pointer text-xs font-medium text-telegram-text">
                                    {t('settings.change_vault_passphrase')}
                                </summary>
                                <div className="mt-3 space-y-2">
                                    <input
                                        type="password"
                                        autoComplete="current-password"
                                        aria-label={t('settings.current_vault_passphrase')}
                                        value={currentVaultPassphrase}
                                        onChange={event => setCurrentVaultPassphrase(event.target.value)}
                                        placeholder={t('settings.current_vault_passphrase')}
                                        className="w-full rounded-md border border-telegram-border bg-telegram-bg px-3 py-2 text-xs text-telegram-text"
                                    />
                                    <input
                                        type="password"
                                        value={newVaultPassphrase}
                                        onChange={event => setNewVaultPassphrase(event.target.value)}
                                        placeholder={t('settings.new_vault_passphrase')}
                                        className="w-full rounded-md border border-telegram-border bg-telegram-bg px-3 py-2 text-xs text-telegram-text"
                                    />
                                    <input
                                        type="password"
                                        value={confirmNewVaultPassphrase}
                                        onChange={event => setConfirmNewVaultPassphrase(event.target.value)}
                                        placeholder={t('settings.confirm_passphrase')}
                                        className="w-full rounded-md border border-telegram-border bg-telegram-bg px-3 py-2 text-xs text-telegram-text"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleChangeVaultPassphrase}
                                        disabled={changingVaultPassphrase || !currentVaultPassphrase || newVaultPassphrase.length < 8}
                                        className="w-full rounded-md bg-telegram-primary/10 py-2 text-xs font-medium text-telegram-primary disabled:opacity-50"
                                    >
                                        {changingVaultPassphrase ? t('settings.saving') : t('settings.change_vault_passphrase')}
                                    </button>
                                </div>
                            </details>
                            {recoveryAvailable && (
                                <>
                                    <ExportRecoverySection encryption={encryption} />
                                    <ImportRecoverySection encryption={encryption} vaultUnlocked />
                                </>
                            )}
                        </div>
                    ) : (
                        /* Locked Vault */
                        <div className="space-y-3">
                            <p className="text-xs text-amber-400/70">
                                {t('settings.vault_is_locked')}
                            </p>
                            <div className="relative">
                                <input
                                    type={showPassphrase ? 'text' : 'password'}
                                    placeholder={t('settings.vault_passphrase_placeholder')}
                                    value={passphrase}
                                    onChange={e => setPassphrase(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleUnlock(); }}
                                    className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-2 pr-9 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/50"
                                />
                                <button
                                    type="button" aria-label={t(showPassphrase ? 'settings.hide_passphrase' : 'settings.show_passphrase')} aria-pressed={showPassphrase}
                                    onClick={() => setShowPassphrase(!showPassphrase)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-telegram-subtext hover:text-telegram-text transition"
                                >
                                    {showPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <button
                                onClick={handleUnlock}
                                disabled={unlocking || !passphrase}
                                className="w-full py-2 rounded-lg text-sm font-medium bg-telegram-primary text-app-accent-contrast hover:bg-telegram-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {unlocking ? t('settings.unlocking') : t('settings.unlock_vault')}
                            </button>
                        </div>
                    )}
                    {recoveryAvailable && (!vaultExists || !vaultUnlocked) && (
                        <div className="border-t border-telegram-border/30 pt-3">
                            <ImportRecoverySection encryption={encryption} vaultUnlocked={false} />
                        </div>
                    )}
                </div>
            )}
            {showTransparency && <EncryptionTransparencyDialog onClose={() => setShowTransparency(false)} />}
        </div>
    );
}
