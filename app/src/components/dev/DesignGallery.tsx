import { useState } from 'react';
import { ChevronLeft, Database, Download, ExternalLink, Folder, Key, MoreHorizontal, RefreshCw, UploadCloud, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../context/ThemeContext';
import { getLanguageInfo, type SupportedLanguage } from '../../i18n/languages';
import { DesktopAdBanner } from '../desktop/dashboard/DesktopAdBanner';
import {
  Badge,
  Button,
  Divider,
  IconButton,
  Input,
  Progress,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  StatusDot,
  Surface,
  Switch,
} from '../ui';

export default function DesignGallery() {
  const { themePreference, setThemePreference, customThemes, activeCustomThemeId, setActiveCustomTheme } = useTheme();
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [auditLanguage, setAuditLanguage] = useState<SupportedLanguage>('de');
  const query = new URLSearchParams(window.location.search);
  const localeStress = query.has('locale-stress');
  const sponsorPreview = query.has('sponsor-preview');
  const activeDirection = localeStress ? getLanguageInfo(auditLanguage).dir : direction;

  const changeAuditLanguage = (language: SupportedLanguage) => {
    setAuditLanguage(language);
  };

  if (sponsorPreview) {
    return (
      <main className="h-screen overflow-hidden bg-app-canvas p-8 text-app-text">
        <h1 className="text-xl font-semibold">Sponsor placement preview</h1>
        <DesktopAdBanner />
      </main>
    );
  }

  return (
    <main dir={activeDirection} data-density={density} className="h-screen overflow-y-auto bg-app-canvas p-4 text-app-text sm:p-8">
      <div className={`mx-auto max-w-5xl ${density === 'compact' ? 'space-y-4' : 'space-y-8'}`}>
        <header className="flex flex-col items-start justify-between gap-5 sm:flex-row">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-app-accent">Development fixture</p>
            <h1 className="mt-2 text-2xl font-semibold">Quiet Utility gallery</h1>
            <p className="mt-2 max-w-xl text-sm text-app-text-secondary">Primitive states for visual, theme, focus, density, and text-expansion review. This route exists only in development builds.</p>
          </div>
          <div className="flex w-full flex-wrap justify-start gap-2 sm:w-auto sm:justify-end">
            <SegmentedControl
              label="Layout direction"
              value={direction}
              onValueChange={setDirection}
              options={[{ value: 'ltr', label: 'LTR' }, { value: 'rtl', label: 'RTL' }]}
            />
            <SegmentedControl
              label="Theme preference"
              value={themePreference}
              onValueChange={setThemePreference}
              options={[{ value: 'default', label: 'Default' }, { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            />
            <Button
              variant={activeCustomThemeId === 'nord' ? 'primary' : 'secondary'}
              onClick={() => setActiveCustomTheme(activeCustomThemeId === 'nord' ? null : customThemes.find((theme) => theme.id === 'nord')?.id ?? null)}
            >
              Preview custom adapter
            </Button>
          </div>
        </header>

        {localeStress && (
          <Surface className="p-4 sm:p-6" data-testid="locale-stress-fixture">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Localized offline storage fixture</h2>
                <p className="mt-1 max-w-xl text-xs text-app-text-secondary">Narrow-width review for long strings, RTL direction, and CJK line breaking.</p>
              </div>
              <label className="text-xs font-medium text-app-text-secondary">
                Audit language
                <select
                  aria-label="Audit language"
                  className="quiet-control ms-2 h-8 border border-app-border bg-app-surface px-2 text-ui text-app-text"
                  value={auditLanguage}
                  onChange={(event) => changeAuditLanguage(event.target.value as SupportedLanguage)}
                >
                  <option value="de">Deutsch</option>
                  <option value="ar">العربية</option>
                  <option value="zh-CN">简体中文</option>
                  <option value="zh-TW">繁體中文</option>
                  <option value="bn-BD">বাংলা (বাংলাদেশ)</option>
                  <option value="th-TH">ไทย (ประเทศไทย)</option>
                  <option value="fil-PH">Filipino (Pilipinas)</option>
                  <option value="ja">日本語</option>
                  <option value="ko">한국어</option>
                  <option value="vi">Tiếng Việt</option>
                </select>
              </label>
            </div>
            <div className="mt-4 w-full max-w-[22rem] rounded-lg bg-app-surface-sunken/50 p-3" data-testid="localized-offline-card">
              <div className="flex min-w-0 items-start gap-2">
                <Database className="mt-0.5 h-4 w-4 shrink-0 text-app-text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-app-text">{t('settings.offline_cache', { lng: auditLanguage })}</p>
                  <p className="mt-1 text-xs text-app-text-secondary">{t('settings.offline_cache_desc', { lng: auditLanguage })}</p>
                  <p className="mt-1 text-xs font-mono text-app-accent">{t('settings.offline_cache_usage', { lng: auditLanguage, count: 12, used: '84 MB', limit: '256 MB' })}</p>
                </div>
                <button className="quiet-control shrink-0 p-1.5" title={t('settings.refresh_offline_cache', { lng: auditLanguage })} aria-label={t('settings.refresh_offline_cache', { lng: auditLanguage })}><RefreshCw className="h-3.5 w-3.5" /></button>
                <button className="quiet-control shrink-0 px-2.5 py-1.5 text-xs text-red-400">{t('settings.clear', { lng: auditLanguage })}</button>
              </div>
            </div>
          </Surface>
        )}

        <Surface className={`grid p-4 md:grid-cols-2 ${density === 'compact' ? 'gap-3' : 'gap-6 sm:p-6'}`}>
          <section className="space-y-4">
            <h2 className="text-sm font-semibold">Actions</h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" leadingIcon={<UploadCloud className="h-4 w-4" />}>Upload</Button>
              <Button leadingIcon={<Download className="h-4 w-4" />}>Download</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="danger">Delete</Button>
              <Button disabled>Disabled</Button>
              <IconButton label="More actions"><MoreHorizontal className="h-4 w-4" /></IconButton>
            </div>
            <Divider />
            <div className="flex flex-wrap gap-2">
              <Badge>Neutral</Badge><Badge tone="accent">Selected</Badge><Badge tone="success">Complete</Badge><Badge tone="warning">Waiting</Badge><Badge tone="danger">Failed</Badge>
            </div>
            <div className="flex items-center gap-4 text-xs text-app-text-secondary">
              <span className="flex items-center gap-2"><StatusDot tone="success" label="Connected" />Connected</span>
              <span className="flex items-center gap-2"><StatusDot tone="warning" label="Checking" />Checking</span>
              <span className="flex items-center gap-2"><StatusDot tone="danger" label="Offline" />Offline</span>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold">Fields and state</h2>
            <SearchField placeholder="Search files…" />
            <Input placeholder="Folder name" />
            <Select defaultValue="comfortable"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></Select>
            <div className="flex items-center justify-between text-sm"><span>Live connection monitoring</span><Switch checked={enabled} onCheckedChange={setEnabled} label="Live connection monitoring" /></div>
            <SegmentedControl label="Density" value={density} onValueChange={setDensity} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
            <Progress value={68} label="Upload progress" />
          </section>
        </Surface>

        <Surface className="overflow-hidden">
          <div className="grid grid-cols-[2rem_minmax(0,2fr)_6rem_8rem] gap-4 border-b border-app-border-subtle bg-app-surface-sunken/30 px-4 py-3 text-xs text-app-text-secondary"><span>#</span><span>Name</span><span className="text-end">Size</span><span className="text-end">Date</span></div>
          {['Quarterly archive.zip', 'Product walkthrough.mp4', 'Translations.csv'].map((name, index) => (
            <div key={name} className={`grid grid-cols-[2rem_minmax(0,2fr)_6rem_8rem] items-center gap-4 border-b border-app-border-subtle px-4 text-sm last:border-b-0 hover:bg-app-hover ${density === 'compact' ? 'min-h-9' : 'min-h-12'}`}><span className="text-app-accent">{index + 1}</span><span className="truncate">{name}</span><span className="text-end text-xs text-app-text-secondary">24 MB</span><span className="text-end text-xs text-app-text-tertiary">Today</span></div>
          ))}
        </Surface>

        <section>
          <div className="mb-3">
            <h2 className="text-sm font-semibold">Phase 5–7 surfaces</h2>
            <p className="mt-1 text-xs text-app-text-secondary">Authentication, sponsored content, mobile sheets, and viewer controls.</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="auth-glass rounded-overlay p-5">
              <span className="sponsored-label">Secure sign in</span>
              <h3 className="mt-4 text-app-title font-semibold">Connect Telegram</h3>
              <p className="mt-1 text-metadata text-app-text-secondary">Credentials stay on this device.</p>
              <label className="auth-label mt-4">API ID</label>
              <div className="relative">
                <Key className="auth-input-icon" />
                <input className="auth-input font-mono" placeholder="12345678" />
              </div>
              <button className="quiet-control auth-primary-action mt-3">Continue</button>
              <button className="quiet-control auth-secondary-action mt-1 w-full"><ExternalLink className="h-3 w-3" />Setup help</button>
            </div>

            <div className="flex items-end overflow-hidden rounded-overlay border border-app-border bg-app-canvas pt-20">
              <div className="mobile-sheet relative">
                <div className="mb-3 flex justify-center"><div className="mobile-sheet-handle" /></div>
                <h3 className="mb-3 truncate text-ui font-semibold">Quarterly archive.zip</h3>
                <button className="quiet-control flex min-h-11 w-full items-center gap-3 border border-app-border-subtle bg-app-surface px-3 text-ui"><Folder className="h-4 w-4 text-app-accent" />Move to folder</button>
                <button className="quiet-control mt-1 flex min-h-11 w-full items-center gap-3 border border-app-border-subtle bg-app-surface px-3 text-ui"><Download className="h-4 w-4 text-app-accent" />Download</button>
              </div>
            </div>

            <div className="viewer-overlay relative flex min-h-64 items-center justify-center overflow-hidden rounded-overlay border border-app-border">
              <button className="viewer-navigation absolute start-3" aria-label="Previous"><ChevronLeft className="h-5 w-5" /></button>
              <div className="viewer-panel flex h-32 w-4/5 items-center justify-center text-metadata text-white/50">Media preview</div>
              <div className="viewer-toolbar absolute end-3 top-3">
                <button className="viewer-control" aria-label="Close"><X className="h-4 w-4" /></button>
              </div>
              <div className="viewer-toolbar absolute bottom-3 px-3 py-1.5 text-badge">Quarterly archive.zip · 2/8</div>
            </div>
          </div>
        </section>

        <Surface className="grid gap-3 p-5 md:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></Surface>
      </div>
    </main>
  );
}
