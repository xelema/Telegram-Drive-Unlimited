import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Bug, CheckCircle2, Cloud, CreditCard, Database, Globe, HardDrive, Heart, KeyRound, Megaphone, Shield, Zap, Clipboard, Loader2, RefreshCw, Upload, Download } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';
import type { TFunction } from 'i18next';
import { EncryptionSettingsSection } from '../../../shared/EncryptionSettingsSection';
import { ThemesTab } from '../ThemesTab';
import { useSupporter } from '../../../../context/SupporterContext';
import { useConfirm } from '../../../../context/ConfirmContext';
import type { Settings } from '../../../../types/settings';
import {
  downloadSettingsSync,
  getSettingsSyncStatus,
  uploadSettingsSync,
  type SettingsSyncStatus,
} from '../../../../services/settingsSync';
import { shouldOfferNewSupporterPurchase } from '../../../../services/supporterVisibility';
import i18n from '../../../../i18n';

const tabMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.12, ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number] },
};

interface SettingsTabFrameProps {
  children: ReactNode;
}

export function GeneralSettingsTab({ children }: SettingsTabFrameProps) {
  return <motion.div key="general" {...tabMotion} className="w-full space-y-6">{children}</motion.div>;
}

export function ProxySettingsTab({ children }: SettingsTabFrameProps) {
  return <motion.section key="proxy" {...tabMotion} className="w-full space-y-3">{children}</motion.section>;
}

export function VpnSettingsTab({ children }: SettingsTabFrameProps) {
  return <motion.section key="vpn" {...tabMotion} className="w-full space-y-3">{children}</motion.section>;
}

export function WebDavSettingsTab({ children }: SettingsTabFrameProps) {
  return <motion.section key="webdav" {...tabMotion} className="w-full space-y-4">{children}</motion.section>;
}

export function SharingSettingsTab({ children }: SettingsTabFrameProps) {
  return <motion.section key="sharing" {...tabMotion} className="w-full space-y-4">{children}</motion.section>;
}

interface PrivacySettingsTabProps {
  crashReportingEnabled: boolean;
  onCrashReportingChange: () => void;
  settings: Settings;
  onSettingsChange: (updates: Partial<Settings>) => void;
  onSettingsSyncEnabledChange: (enabled: boolean) => void;
}

function SettingsSyncSection({
  settings,
  onSettingsChange,
  onEnabledChange,
}: {
  settings: Settings;
  onSettingsChange: (updates: Partial<Settings>) => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { confirm } = useConfirm();
  const [passphrase, setPassphrase] = useState('');
  const [status, setStatus] = useState<SettingsSyncStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'status' | 'upload' | 'download' | null>(null);

  const refreshStatus = async () => {
    setBusyAction('status');
    setStatusError(null);
    try {
      setStatus(await getSettingsSyncStatus());
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    if (settings.telegramSettingsSyncEnabled) void refreshStatus();
  }, [settings.telegramSettingsSyncEnabled]);

  const upload = async () => {
    if (status?.available && !status.current_device) {
      const approved = await confirm({
        title: 'Replace the settings backup?',
        message: 'The latest encrypted backup came from another device. Uploading will replace it with this device’s current safe preferences.',
        confirmText: 'Replace backup',
      });
      if (!approved) return;
    }
    setBusyAction('upload');
    setStatusError(null);
    try {
      setStatus(await uploadSettingsSync(settings, passphrase));
      toast.success('Encrypted settings uploaded to Telegram Saved Messages.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusError(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  };

  const download = async () => {
    const approved = await confirm({
      title: 'Apply settings from Telegram?',
      message: 'Synced display, transfer, network-tuning, and encryption preferences will replace their local values. Credentials and activation data are not changed.',
      confirmText: 'Apply settings',
    });
    if (!approved) return;
    setBusyAction('download');
    setStatusError(null);
    try {
      const restored = await downloadSettingsSync(passphrase);
      onSettingsChange(restored.settings);
      setStatus({
        available: true,
        updated_at: restored.updated_at,
        device_id: restored.device_id,
        current_device: status?.device_id === restored.device_id ? status.current_device : false,
      });
      toast.success('Encrypted settings downloaded and applied.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusError(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  };

  const passphraseIsValid = passphrase.trim().length >= 12;
  const isBusy = busyAction !== null;

  return (
    <section className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/20 p-4" aria-labelledby="settings-sync-title">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden="true" />
          <div>
            <h3 id="settings-sync-title" className="text-sm font-semibold text-app-text">Encrypted settings sync</h3>
            <p className="mt-1 text-xs leading-5 text-app-text-secondary">Manually move safe app preferences between devices through your own Telegram Saved Messages. Telegram Drive operates no sync server.</p>
          </div>
        </div>
        <button type="button" role="switch" aria-checked={settings.telegramSettingsSyncEnabled} aria-label="Enable encrypted settings sync" onClick={() => { setStatusError(null); setPassphrase(''); onEnabledChange(!settings.telegramSettingsSyncEnabled); }} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings.telegramSettingsSyncEnabled ? 'bg-app-accent' : 'bg-app-border'}`}><span className={`absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.telegramSettingsSyncEnabled ? 'translate-x-5 rtl:-translate-x-5' : ''}`} /></button>
      </div>

      {settings.telegramSettingsSyncEnabled && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-app-warning/25 bg-app-warning/5 p-3 text-xs leading-5 text-app-text-secondary">
            <strong className="text-app-text">Your passphrase cannot be recovered.</strong> It is used locally and is never stored or uploaded. The encrypted Telegram message may be visible in Saved Messages. Passwords, API/WebDAV keys, proxy details, supporter activation, crash consent, and file data are always excluded.
          </div>
          <label className="block">
            <span className="text-xs font-medium text-app-text">Sync passphrase</span>
            <input type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} autoComplete="new-password" spellCheck={false} placeholder="At least 12 characters" className="mt-1.5 w-full rounded-control border border-app-border bg-app-surface px-3 py-2.5 text-sm text-app-text outline-none focus:border-app-accent" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!passphraseIsValid || isBusy} onClick={() => void upload()} className="quiet-control flex items-center gap-2 px-3 py-2 text-xs font-medium text-app-text disabled:cursor-not-allowed disabled:opacity-50">{busyAction === 'upload' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}Upload this device</button>
            <button type="button" disabled={!passphraseIsValid || isBusy || status?.available === false} onClick={() => void download()} className="quiet-control flex items-center gap-2 px-3 py-2 text-xs font-medium text-app-text disabled:cursor-not-allowed disabled:opacity-50">{busyAction === 'download' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}Download and apply</button>
            <button type="button" disabled={isBusy} onClick={() => void refreshStatus()} aria-label="Refresh settings sync status" className="quiet-control p-2 text-app-text-secondary disabled:opacity-50">{busyAction === 'status' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
          </div>
          {status && (
            <p className="text-xs leading-5 text-app-text-secondary">
              {status.available && status.updated_at
                ? `Latest backup: ${new Date(status.updated_at * 1_000).toLocaleString()}${status.current_device ? ' · uploaded by this device' : ' · uploaded by another device'}`
                : 'No encrypted settings backup was found in the latest 1,000 Saved Messages.'}
            </p>
          )}
          {statusError && <p role="alert" className="text-xs leading-5 text-app-danger">{statusError}</p>}
        </div>
      )}
    </section>
  );
}

export function SupporterSettingsSection() {
  const { status, latestRecoveryCode, beginCheckout, pollCheckout, activate, refreshEntitlement } = useSupporter();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState('');
  const termsUrl = status.terms_url ?? 'https://github.com/caamer20/Telegram-Drive/blob/main/SUPPORTER_TERMS.md';
  const supportUrl = 'https://github.com/caamer20/Telegram-Drive/issues/new/choose';
  const canPurchase = shouldOfferNewSupporterPurchase(status) && !status.checkout_pending;
  const canRefresh = ['active', 'needs_refresh', 'expired'].includes(status.state);
  const canRestore = !status.ad_free && !status.checkout_pending && !['loading', 'unavailable', 'revoked'].includes(status.state);
  const isReturningSupporter = !status.ad_free && !canPurchase
    && (status.state === 'expired' || status.recovery_code_saved);
  const statusTitle = status.state === 'loading'
    ? 'Checking activation'
    : status.ad_free
      ? 'Lifetime ad-free access is active'
      : status.state === 'revoked'
        ? 'Activation revoked'
        : status.state === 'expired'
          ? 'Activation needs to be refreshed'
          : status.state === 'unavailable'
            ? 'Activation service unavailable'
            : status.recovery_code_saved
              ? 'Previous purchase found on this device'
              : 'No supporter license is active';

  const checkPayment = async (quiet = false) => {
    try {
      const result = await pollCheckout();
      if (result.status === 'completed') {
        setCheckoutPending(false);
        if (result.recovery_code) setNewRecoveryCode(result.recovery_code);
        toast.success('Payment verified. Ad-free supporter access is active.');
      } else if (!quiet) {
        toast.info(result.message);
      }
    } catch (error) {
      if (!quiet) toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    setCheckoutPending(Boolean(status.checkout_pending) && !status.ad_free);
  }, [status.ad_free, status.checkout_pending]);

  const startCheckout = async () => {
    setBusy(true);
    try {
      const checkout = await beginCheckout(status.terms_version);
      await open(checkout.approval_url);
      setCheckoutPending(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const recoverPurchase = async () => {
    if (!recoveryCode.trim()) return;
    setBusy(true);
    try {
      await activate(recoveryCode.trim(), status.terms_version);
      setRecoveryCode('');
      toast.success('Supporter purchase restored on this device.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-app-accent/20 bg-app-accent/5 p-4" aria-labelledby="supporter-settings-title">
      <div className="flex items-start gap-3">
        <Heart className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id="supporter-settings-title" className="text-sm font-semibold text-app-text">Lifetime Ad-Free Supporter License</h3>
          <p className="mt-1 text-xs leading-5 text-app-text-secondary">Every feature stays available in the free version. This optional license only removes sponsor placements on activated supported devices.</p>
          <div className={`mt-3 rounded-lg border p-3 text-xs leading-5 ${status.ad_free ? 'border-app-success/25 bg-app-success/5 text-app-text-secondary' : status.state === 'revoked' ? 'border-app-danger/25 bg-app-danger/5 text-app-text-secondary' : 'border-app-border-subtle bg-app-surface-sunken/25 text-app-text-secondary'}`}>
            <strong className={status.ad_free ? 'text-app-success' : status.state === 'revoked' ? 'text-app-danger' : 'text-app-text'}>{statusTitle}</strong>
            <span className="mt-1 block">{status.message}</span>
            {status.ad_free && <span className="mt-1 block">Normal Telegram Drive updates reuse this device’s secure credential automatically—no reactivation or repeat payment is required.</span>}
            {isReturningSupporter && <span className="mt-1 block font-medium text-app-text">You already have purchase history on this device. Refresh or restore below; do not pay again.</span>}
          </div>
        </div>
      </div>

      {canPurchase && (
        <div className="mt-5 space-y-4">
          <div className="rounded-xl border border-app-accent/30 bg-app-surface p-5 text-center shadow-sm">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-app-accent">Ad-free for life</span>
            <div className="mt-2 text-3xl font-semibold tracking-tight text-app-text">$5 <span className="text-sm font-medium text-app-text-secondary">{i18n.t("supporter_offer.price_suffix")}</span></div>
            <p className="mt-2 text-sm font-medium text-app-text">One payment. No subscription. No sponsor ads.</p>
            <p className="mt-1 text-xs leading-5 text-app-text-secondary">Verified for up to three supported devices total across desktop and Android. Normal app updates are included.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2" aria-label="Free and supporter license comparison">
            <div className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/20 p-4">
              <strong className="text-sm text-app-text">Free forever</strong>
              <ul className="mt-3 space-y-2 text-xs leading-5 text-app-text-secondary">
                <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" />Every app feature</li>
                <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" />No supporter account or subscription</li>
                <li className="flex gap-2"><Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-app-text-tertiary" />Labeled sponsor placements</li>
              </ul>
            </div>
            <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4">
              <strong className="text-sm text-app-text">$5 lifetime supporter</strong>
              <ul className="mt-3 space-y-2 text-xs leading-5 text-app-text-secondary">
                <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" />Every app feature</li>
                <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" />Sponsor placements removed</li>
                <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" />Normal updates stay activated</li>
              </ul>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-app-text-secondary">How activation works</h4>
            <ol className="mt-3 grid gap-3 sm:grid-cols-3">
              {([
                [CreditCard, '1', 'Pay with PayPal', 'Checkout opens securely in your browser.'],
                [CheckCircle2, '2', 'Return to the app', 'Keep Telegram Drive open while payment is verified.'],
                [KeyRound, '3', 'Save your recovery code', 'Use it after a reinstall or on another device.'],
              ] as const).map(([Icon, number, title, description]) => (
                <li key={number} className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/20 p-3">
                  <div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-app-selected text-xs font-semibold text-app-accent">{number}</span><Icon className="h-4 w-4 text-app-accent" /></div>
                  <strong className="mt-2 block text-xs text-app-text">{title}</strong>
                  <p className="mt-1 text-xs leading-5 text-app-text-secondary">{description}</p>
                </li>
              ))}
            </ol>
          </div>

          <p className="rounded-lg border border-app-success/20 bg-app-success/5 p-3 text-xs leading-5 text-app-text-secondary"><strong className="text-app-text">Private and predictable:</strong> PayPal processes the payment. Telegram Drive does not receive or store your card details or PayPal email, and there is no recurring charge.</p>
        </div>
      )}

      {(newRecoveryCode || latestRecoveryCode) && (
        <div className="mt-4 rounded-lg border border-app-warning/30 bg-app-warning/5 p-3 text-xs leading-5 text-app-text-secondary">
          <strong className="text-app-text">Save this recovery code now</strong>
          <code className="mt-2 block select-all break-all rounded bg-app-surface-sunken px-3 py-2 font-mono text-sm text-app-text">{newRecoveryCode || latestRecoveryCode}</code>
          <p className="mt-2">It is stored in this device’s secure credential manager, but you should also keep an offline copy. Telegram Drive does not store your email and cannot reconstruct a lost code.</p>
        </div>
      )}

      {checkoutPending && !status.ad_free && (
        <div role="status" className="mt-4 rounded-lg border border-app-accent/25 bg-app-accent/5 p-3 text-xs leading-5 text-app-text-secondary">
          <strong className="text-app-text">Waiting for PayPal confirmation</strong>
          <p className="mt-1">Keep this app open after approving payment. Verification normally updates automatically; use “Check payment” if it does not.</p>
        </div>
      )}

      {canPurchase && (
        <details className="mt-4 rounded-lg border border-app-warning/25 bg-app-warning/5 p-3 text-xs leading-5 text-app-text-secondary">
          <summary className="cursor-pointer font-medium text-app-text"><span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-app-warning" />Important purchase and refund information</span></summary>
          <p className="mt-2">Refunds are not automatic and are not guaranteed except where required by law. A refund, reversal, chargeback, or upheld dispute revokes ad-free access. Payment and activation depend on PayPal, internet access, and secure credential storage; keep your recovery code.</p>
        </details>
      )}

      {(canPurchase || canRestore) && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-5 text-app-text-secondary">
          <input type="checkbox" checked={acceptedTerms} onChange={event => setAcceptedTerms(event.target.checked)} className="mt-1 accent-[var(--color-app-accent)]" />
          <span>I understand the activation requirements, recovery responsibility, device limit, and refund/reversal policy, and I accept the <button type="button" onClick={event => { event.preventDefault(); void open(termsUrl); }} className="text-app-accent underline underline-offset-2">Supporter Terms</button>.</span>
        </label>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canPurchase && (
          <button type="button" disabled={!acceptedTerms || busy || checkoutPending} onClick={() => void startCheckout()} className="quiet-control bg-app-accent px-5 py-3 text-sm font-semibold text-app-accent-contrast disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Preparing secure checkout…' : checkoutPending ? 'Checkout opened' : 'Get lifetime ad-free · $5'}</button>
        )}
        {checkoutPending && <button type="button" onClick={() => void checkPayment()} className="quiet-control px-4 py-2.5 text-xs font-medium text-app-text">Check payment</button>}
        {canRefresh && <button type="button" onClick={() => void refreshEntitlement().then(() => toast.success('Supporter verification refreshed.')).catch(error => toast.error(String(error)))} className="quiet-control px-4 py-2.5 text-xs font-medium text-app-text">Refresh verification</button>}
        <button type="button" onClick={() => void open(termsUrl)} className="quiet-control px-3 py-2.5 text-xs text-app-text-secondary">Read full terms</button>
        <button type="button" onClick={() => void open(supportUrl)} className="quiet-control px-3 py-2.5 text-xs text-app-text-secondary">Activation help</button>
      </div>

      {canRestore && (
        <details className="mt-4 rounded-lg border border-app-border-subtle bg-app-surface-sunken/20 p-3">
          <summary className="cursor-pointer text-xs font-medium text-app-text">Already supported? Restore with a recovery code</summary>
          <p className="mt-2 text-xs leading-5 text-app-text-secondary">Normal updates do not need this code. Use it after a reinstall or on another device; restoration requires the current terms and counts toward the three-device limit.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-control border border-app-border bg-app-surface px-3 py-2 text-xs text-app-text outline-none focus:border-app-accent" />
            <button type="button" disabled={!acceptedTerms || !recoveryCode.trim() || busy} onClick={() => void recoverPurchase()} className="quiet-control px-4 py-2 text-xs font-medium text-app-text disabled:opacity-50">Restore purchase</button>
          </div>
          <p className="mt-2 text-xs leading-5 text-app-text-tertiary">If activation is delayed, check payment once, then open Activation help. Never post your recovery code or payment identifiers in a public issue, and do not pay a second time.</p>
        </details>
      )}
    </section>
  );
}

export function PrivacySettingsTab({ crashReportingEnabled, onCrashReportingChange, settings, onSettingsChange, onSettingsSyncEnabledChange }: PrivacySettingsTabProps) {
  return (
    <motion.section key="privacy" {...tabMotion} className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-app-accent/20 bg-app-accent/5 p-4">
        <Bug className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" />
        <div><h3 className="text-sm font-semibold text-app-text">Crash-only reporting</h3><p className="mt-1 text-xs leading-5 text-app-text-secondary">Optional reports help diagnose unexpected app crashes. Normal usage, analytics, advertising activity, and file operations are never reported.</p></div>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-app-hover/50 p-4">
        <div className="max-w-[75%]"><p className="text-sm font-medium text-app-text">Send anonymous crash reports</p><p className="mt-1 text-xs leading-5 text-app-text-secondary">Never sends file names, paths, contents, Telegram messages, credentials, or personal identifiers. Turning this off also clears reports waiting to be sent.</p></div>
        <button type="button" role="switch" aria-checked={crashReportingEnabled} aria-label="Send anonymous crash reports" onClick={onCrashReportingChange} className={`relative h-6 w-11 rounded-full transition-colors ${crashReportingEnabled ? 'bg-app-accent' : 'bg-app-border'}`}><span className={`absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${crashReportingEnabled ? 'translate-x-5 rtl:-translate-x-5' : ''}`} /></button>
      </div>
      <section className="space-y-3" aria-labelledby="data-usage-title">
        <div><h3 id="data-usage-title" className="text-sm font-semibold text-app-text">Where your data goes</h3><p className="mt-1 text-xs leading-5 text-app-text-secondary">Telegram Drive has no account server of its own. Each destination below is separated by purpose.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            ['This device', 'Settings, queue state, thumbnails, and encrypted vault material stay local.', Database],
            ['Telegram', 'Folder channels and uploaded file messages go directly to your Telegram account.', Cloud],
            ['Sponsors', 'Sponsor content loads only in labeled ad areas. File activity is never sent to sponsors.', Megaphone],
            ['Crash reports', 'Only after consent: app version, platform, error type, and sanitized function names.', Bug],
          ] as const).map(([title, description, Icon]) => (
            <div key={title} className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/25 p-3"><Icon className="h-4 w-4 text-app-accent" aria-hidden="true" /><strong className="mt-2 block text-xs text-app-text">{title}</strong><p className="mt-1 text-xs leading-5 text-app-text-secondary">{description}</p></div>
          ))}
        </div>
        <p className="rounded-lg border border-app-border-subtle p-3 text-xs leading-5 text-app-text-secondary"><strong className="text-app-text">Privacy policy summary:</strong> Telegram Drive does not sell personal data, inspect file contents for analytics, or operate a cloud account database. Revoking a share or disabling a local server stops that access immediately.</p>
      </section>
      <SettingsSyncSection settings={settings} onSettingsChange={onSettingsChange} onEnabledChange={onSettingsSyncEnabledChange} />
      <SupporterSettingsSection />
    </motion.section>
  );
}

interface AdvancedSettingsTabProps {
  onOpenApi: () => void;
  onOpenWebDav: () => void;
  onOpenProxy: () => void;
  onOpenVpn: () => void;
}

export function AdvancedSettingsTab({ onOpenApi, onOpenWebDav, onOpenProxy, onOpenVpn }: AdvancedSettingsTabProps) {
  return (
    <motion.section key="advanced" {...tabMotion} className="space-y-4">
      <div><h3 className="text-base font-semibold text-app-text">Advanced</h3><p className="mt-1 text-sm text-app-text-secondary">Power-user connections are grouped here so everyday settings stay calm and focused. Use the settings search to find any option by name.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        {([
          ['REST API', 'Local automation endpoint and API key', Globe, onOpenApi],
          ['WebDAV', 'Finder and file-manager access', HardDrive, onOpenWebDav],
          ['Proxy', 'SOCKS5 and HTTP bridge settings', Shield, onOpenProxy],
          ['VPN & network', 'Retries, bandwidth, and data-center tuning', Zap, onOpenVpn],
        ] as const).map(([label, description, Icon, action]) => (
          <button key={label} type="button" onClick={action} className="quiet-surface p-4 text-start hover:border-app-accent/30 hover:bg-app-hover"><Icon className="mb-3 h-5 w-5 text-app-accent" /><strong className="block text-sm text-app-text">{label}</strong><span className="mt-1 block text-xs leading-5 text-app-text-secondary">{description}</span></button>
        ))}
      </div>
    </motion.section>
  );
}

export function EncryptionSettingsTab() {
  return <motion.section key="encryption" {...tabMotion}><EncryptionSettingsSection /></motion.section>;
}

export function ThemeSettingsTab() {
  return <ThemesTab />;
}

interface AboutSettingsTabProps {
  appVersion: string;
  diagnosticsLoading: boolean;
  t: TFunction;
  onCopyDiagnostics: () => void;
}

export function AboutSettingsTab({ appVersion, diagnosticsLoading, t, onCopyDiagnostics }: AboutSettingsTabProps) {
  return (
    <motion.section key="about" {...tabMotion} className="w-full space-y-4">
      <div className="flex flex-col items-center space-y-5 py-6">
        <img src="/logo.svg" className="h-16 w-16 drop-shadow-lg" alt="Telegram Drive Logo" />
        <div className="text-center"><h3 className="text-base font-bold text-telegram-text">{i18n.t("common.app_title")}</h3><p className="mt-0.5 text-xs text-telegram-subtext">v{appVersion}</p></div>
        <div className="h-px w-12 bg-telegram-border" />
        <button onClick={onCopyDiagnostics} disabled={diagnosticsLoading} className="flex items-center gap-1.5 rounded-lg border border-telegram-border bg-telegram-hover px-3 py-1.5 text-xs font-medium text-telegram-subtext transition hover:bg-telegram-border/30 hover:text-telegram-text disabled:opacity-50">
          {diagnosticsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clipboard className="h-3 w-3" />}
          {t('settings.copy_diagnostics')}
        </button>
        <div className="space-y-3 text-center">
          <p className="text-sm font-semibold text-telegram-text">Cameron Amer</p>
          <button onClick={event => { event.preventDefault(); void open('https://www.cameronamer.com'); }} className="flex cursor-pointer items-center justify-center gap-1.5 text-xs text-telegram-primary transition-colors hover:text-telegram-primary/80"><Globe className="h-3.5 w-3.5" />www.cameronamer.com</button>
          <button onClick={event => { event.preventDefault(); void open('https://github.com/caamer20/telegram-drive'); }} className="flex cursor-pointer items-center justify-center gap-1.5 text-xs text-telegram-primary transition-colors hover:text-telegram-primary/80">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
            github.com/caamer20/telegram-drive
          </button>
        </div>
        <p className="max-w-[280px] text-center text-[11px] leading-relaxed text-telegram-subtext/60">{t('settings.tagline')}</p>
      </div>
    </motion.section>
  );
}
