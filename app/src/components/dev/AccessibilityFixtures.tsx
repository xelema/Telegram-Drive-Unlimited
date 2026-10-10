import { LocalizationArraysBrowserFixture } from './LocalizationArraysBrowserFixture';
import {RuntimeCopyBrowserFixture} from './RuntimeCopyBrowserFixture';
import { SupporterBrowserFixture } from './SupporterBrowserFixture';
import { useEffect, useState } from 'react';
import {useTvSpatialNavigation} from '../../hooks/useTvSpatialNavigation';
import { AuthWizard } from '../shared/AuthWizard';
import { FileExplorer } from '../desktop/dashboard/FileExplorer';
import { SettingsModal } from '../desktop/dashboard/SettingsModal';
import { ShareDialog } from '../desktop/dashboard/ShareDialog';
import { BottomNavBar } from '../mobile/BottomNavBar';
import { MobileSupporterCard } from '../mobile/MobileSupporterCard';
import type { TelegramFile, TelegramFolder } from '../../types';

const file: TelegramFile = {
  id: 101,
  name: 'Quarterly report.pdf',
  size: 2_450_000,
  sizeStr: '2.45 MB',
  created_at: '2026-08-29T12:00:00Z',
  folder_id: 10,
  mime_type: 'application/pdf',
  file_ext: 'pdf',
  is_favorite: true,
};

const folder: TelegramFolder = {
  id: 10,
  name: 'Documents',
  username: 'telegram_drive_fixture',
  is_public: true,
};

export default function AccessibilityFixtures() {
  const fixture = new URLSearchParams(window.location.search).get('a11y-fixture') || 'dashboard';
  useTvSpatialNavigation(fixture === 'tv');
  const [settingsOpen, setSettingsOpen] = useState(fixture !== 'tv' && fixture !== 'tv-control');
  const [dialogOpen, setDialogOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<'files' | 'downloads' | 'settings'>('files');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.documentElement.dataset.a11yFixtureReady = fixture;
      window.dispatchEvent(new CustomEvent('telegram-drive-a11y-fixture-ready'));
    }, 350);
    return () => {
      window.clearTimeout(timer);
      delete document.documentElement.dataset.a11yFixtureReady;
    };
  }, [fixture]);

  if (fixture === 'tv' || fixture === 'tv-control') return (
    <main className="h-screen overflow-hidden bg-app-canvas p-6 text-app-text">
      <h1>TV navigation fixture</h1>
      <input aria-label="Edge number" type="number" defaultValue={1} className="quiet-control absolute end-3 top-0 w-28 px-3 py-1" />
      <input aria-label="Fixed edge number" type="number" defaultValue={1} className="quiet-control fixed end-36 top-0 w-28 px-3 py-1" />
      <button type="button" onClick={()=>setSettingsOpen(true)} className="quiet-control my-3 px-3 py-2">Open settings</button>
      <div className="mb-4 flex gap-4">
        <label>Text input<input aria-label="Text input" defaultValue="abc" className="quiet-control block px-3 py-2" /></label>
        <label>Number input<input aria-label="Number input" type="number" defaultValue={1} className="quiet-control block px-3 py-2" /></label>
        <label>Native choice<select aria-label="Native choice" defaultValue="a" className="quiet-control block px-3 py-2"><option value="a">First choice</option><option value="b">Second choice</option></select></label>
      </div>
      <div data-testid="tv-scroll-region" className="h-48 w-72 overflow-y-auto border border-app-border p-3">
        <button type="button" className="quiet-control block px-3 py-2">Top item</button>
        <div className="h-[1100px]" aria-hidden="true" />
        <button type="button" className="quiet-control block px-3 py-2">Below fold</button>
      </div>
      <SettingsModal ownerId="101" isOpen={settingsOpen} onClose={()=>setSettingsOpen(false)} />
    </main>
  );


  if (fixture === 'locale-arrays') return <LocalizationArraysBrowserFixture />;

  if (fixture === 'runtime-copy') return <RuntimeCopyBrowserFixture />;

  if (fixture === 'supporter') return <SupporterBrowserFixture />;

  if (fixture === 'auth') {
    // AuthWizard intentionally shows a browser-only notice outside Tauri. This
    // development fixture marks the page as native so axe exercises the real
    // sign-in form. Its startup probes fail closed here, so native state is not
    // changed by the browser fixture.
    if (!('__TAURI_INTERNALS__' in window)) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    }
    return <main className="min-h-screen bg-app-canvas"><AuthWizard onLogin={() => undefined} /></main>;
  }

  if (fixture === 'settings') {
    return (
      <main className="h-screen bg-app-canvas text-app-text">
        <h1 className="sr-only">Settings accessibility fixture</h1>
        <SettingsModal ownerId={null} isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </main>
    );
  }

  if (fixture === 'dialog') {
    return (
      <main className="h-screen bg-app-canvas text-app-text">
        <h1 className="p-6 text-xl font-semibold">Sharing accessibility fixture</h1>
        {dialogOpen && <ShareDialog ownerId="fixture-owner" file={file} folders={[folder]} activeFolderId={folder.id} onClose={() => setDialogOpen(false)} />}
      </main>
    );
  }

  if (fixture === 'mobile') {
    return (
      <main className="min-h-screen bg-telegram-bg p-4 pb-32 text-telegram-text">
        <h1 className="mb-4 text-lg font-semibold">Mobile settings</h1>
        <MobileSupporterCard />
        <BottomNavBar activeTab={mobileTab} setActiveTab={setMobileTab} isAndroid />
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-app-canvas text-app-text">
      <header className="border-b border-app-border px-5 py-4">
        <h1 className="text-xl font-semibold">Documents</h1>
      </header>
      <FileExplorer
        files={[file]}
        loading={false}
        error={null}
        viewMode="grid"
        selectedIds={[]}
        activeFolderId={folder.id}
        onFileClick={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onPreview={() => undefined}
        onManualUpload={() => undefined}
        onFolderUpload={() => undefined}
        showFolderUpload
        onToggleSelection={() => undefined}
        onShare={() => undefined}
        onRename={() => undefined}
        onFileMove={() => undefined}
        folders={[folder]}
        cardScale={1}
        sortField="date"
        sortDirection="desc"
        onSortChange={() => undefined}
        onToggleFavorite={() => undefined}
        onTogglePinned={() => undefined}
      />
    </main>
  );
}
