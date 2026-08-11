import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Bug, Cloud, Database, Globe, HardDrive, Heart, Megaphone, Shield, Zap, Clipboard, Loader2 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import type { TFunction } from 'i18next';
import { EncryptionSettingsSection } from '../../../shared/EncryptionSettingsSection';
import { ThemesTab } from '../ThemesTab';

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
  supporterMode: boolean;
  onCrashReportingChange: () => void;
  onSupporterModeChange: () => void;
}

export function PrivacySettingsTab({ crashReportingEnabled, supporterMode, onCrashReportingChange, onSupporterModeChange }: PrivacySettingsTabProps) {
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
      <section className="rounded-lg border border-app-accent/20 bg-app-accent/5 p-4">
        <div className="flex items-start gap-3"><Heart className="mt-0.5 h-5 w-5 text-app-accent" aria-hidden="true" /><div><h3 className="text-sm font-semibold text-app-text">Supporter · one-time ad-free</h3><p className="mt-1 text-xs leading-5 text-app-text-secondary">Support development once, then enable the local supporter switch to hide sponsor placements on this device. No recurring account or tracking is required.</p></div></div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void open('https://www.paypal.me/Caamer20')} className="quiet-control bg-app-accent px-4 py-2 text-xs font-semibold text-app-accent-contrast">Support once</button>
          <button type="button" role="switch" aria-checked={supporterMode} onClick={onSupporterModeChange} className="quiet-control flex items-center gap-2 px-3 py-2 text-xs text-app-text"><span className={`h-2.5 w-2.5 rounded-full ${supporterMode ? 'bg-app-success' : 'bg-app-text-tertiary'}`} />{supporterMode ? 'Ad-free supporter mode is on' : "I've supported — hide ads"}</button>
        </div>
      </section>
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
        <div className="text-center"><h3 className="text-base font-bold text-telegram-text">Telegram Drive</h3><p className="mt-0.5 text-xs text-telegram-subtext">v{appVersion}</p></div>
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
