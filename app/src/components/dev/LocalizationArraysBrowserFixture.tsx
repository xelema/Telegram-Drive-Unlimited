import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../context/SettingsContext';
import { getLanguageInfo, type SupportedLanguage } from '../../i18n/languages';
import { resolveLanguagePreference } from '../../i18n/resolveLanguage';
import { ensureLanguageResource } from '../../i18n';
import type { EncryptionState, TelegramFile } from '../../types';
import { EncryptionBadge } from '../shared/EncryptionBadge';
import { PrivacySettingsTab, AdvancedSettingsTab } from '../desktop/dashboard/settings/SettingsTabs';
import { ThemesTab } from '../desktop/dashboard/ThemesTab';
import { TouchFileList } from '../mobile/TouchFileList';
import { Toaster } from 'sonner';

/** Real presentation/state/providers; native storage, Telegram and payments remain controlled. */
export function LocalizationArraysBrowserFixture() {
  const { i18n } = useTranslation();
  const { settings, updateSetting, updateSettings, isLoaded } = useSettings();
  const [view, setView] = useState('privacy');
  const [state, setState] = useState<EncryptionState>('encrypted_key_missing');
  const [lastAction, setLastAction] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const languageQueue = useRef(Promise.resolve());
  const [languageError, setLanguageError] = useState<string | null>(null);
  useEffect(() => {
    if (!isLoaded) return;
    let live = true;
    const language = resolveLanguagePreference(settings.language);
    languageQueue.current = languageQueue.current.then(async () => {
      await ensureLanguageResource(language);
      if (!live) return;
      await i18n.changeLanguage(language);
      document.documentElement.lang = language;
      document.documentElement.dir = getLanguageInfo(language).dir;
    }).catch(error => { if (live) setLanguageError(String(error)); });
    return () => { live = false; };
  }, [settings.language, isLoaded, i18n]);

  const mobile = new URLSearchParams(location.search).has('mobile-array');
  const file: TelegramFile = { id: 81, name: 'Menu fixture.pdf', size: 100, sizeStr: '100 B', folder_id: 9, type: 'file', mime_type: 'application/pdf', offline_available: true };
  if (languageError) return <p role="alert">{languageError}</p>;
  if (!isLoaded) return null;
  return (
    <main data-locale-arrays={i18n.language} className="min-h-screen bg-app-canvas p-4 text-app-text">
      <Toaster />
      <label>Fixture language<select aria-label="Fixture language" value={settings.language} onChange={event => updateSetting('language', event.target.value as SupportedLanguage)}>{['es', 'fr', 'ar'].map(language => <option key={language}>{language}</option>)}</select></label>
      <label>Fixture view<select aria-label="Fixture view" value={view} onChange={event => setView(event.target.value)}>{['privacy', 'themes', 'advanced'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Fixture protection<select aria-label="Fixture protection" value={state} onChange={event => setState(event.target.value as EncryptionState)}>{['encrypted_unlocked', 'encrypted_locked', 'encrypted_key_missing', 'encrypted_unsupported_version', 'encrypted_corrupt', 'encrypted_verifying'].map(value => <option key={value}>{value}</option>)}</select></label>
      <div data-badge><EncryptionBadge state={state} showLabel /></div>
      {mobile ? <div ref={scrollRef} className="h-[650px] overflow-auto"><TouchFileList files={[file]} isLoading={false} disableVirtualization scrollElementRef={scrollRef} selectedIds={[]} folders={[{ id: 9, name: 'Fixture channel', username: 'fixture_channel', is_public: true }]} activeFolderId={9}
        onDownload={value => setLastAction(`download:${value.id}`)} onDelete={value => setLastAction(`delete:${value.id}`)} onPreview={value => setLastAction(`preview:${value.id}`)} onRename={value => setLastAction(`rename:${value.id}`)}
        onToggleSelection={() => undefined} onSelectAll={() => undefined} onClearSelection={() => undefined} onBulkDelete={() => undefined} onBulkDownload={() => undefined} onBulkMove={() => undefined}
        onKeepOffline={value => setLastAction(`keep:${value.id}`)} onRemoveOffline={value => setLastAction(`remove:${value.id}`)} onShare={value => setLastAction(`share:${value.id}`)} onCopyTelegramLink={value => setLastAction(`copy:${value.id}`)} /></div>
        : <section data-copy-view>{view === 'privacy' ? <PrivacySettingsTab crashReportingEnabled={settings.crashReportingEnabled} onCrashReportingChange={() => updateSetting('crashReportingEnabled', !settings.crashReportingEnabled)} settings={settings} onSettingsChange={updateSettings} onSettingsSyncEnabledChange={enabled => updateSetting('telegramSettingsSyncEnabled', enabled)} />
          : view === 'themes' ? <ThemesTab /> : <AdvancedSettingsTab onOpenApi={() => setLastAction('api')} onOpenWebDav={() => setLastAction('webdav')} onOpenProxy={() => setLastAction('proxy')} onOpenVpn={() => setLastAction('vpn')} />}</section>}
      <output data-last-action>{lastAction}</output>
    </main>
  );
}
